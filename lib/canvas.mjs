/**
 * The canvas: its declaration, and the actions the agent drives it with.
 *
 * Separate from `extension.mjs` so the handlers can be exercised directly. The
 * SDK surface arrives as arguments rather than as an import, so a test can call
 * every action against a real document, a real loopback server and a real
 * workspace without forking a child process.
 *
 * The person has draw.io — the whole editor, served locally (see
 * `drawio-dist.mjs`). The agent has these actions, grouped by what it needs to
 * work *alongside* someone rather than instead of them:
 *
 *   read      get_diagram, get_changes, search_shapes
 *   write     edit_diagram, insert_shapes, replace_diagram, manage_pages, manage_layers
 *   see/show  screenshot, focus, layout      (done in the person's own editor)
 *   files     open_file, save_file
 *
 * Every result that follows a read or a write carries `person`: what the person
 * changed since the agent was last told, and what they are looking at. The
 * agent learns about parallel work as a side effect of doing its own. The same
 * picture is kept on disk as `.drawio-canvas/<instance>/manifest.json` in the
 * workspace, for tools that read files rather than call actions.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { cellInfo } from "./changes.mjs";
import { DrawioProvider, PINNED } from "./drawio-dist.mjs";
import {
	readDiagramFile,
	resolveInWorkspace,
	sweepSnapshots,
	takeSnapshot,
	toFileXml,
	writeSnapshot,
	writeWorkspaceFile,
} from "./files.mjs";
import { layerCommand, layersOf } from "./layers.mjs";
import { cellId, DiagramError, summarizePage, validateDocument } from "./model.mjs";
import { renderOptions, renderPageSvg } from "./render.mjs";
import { startInstanceServer } from "./server.mjs";
import { DiagramSession, SOURCE_AGENT, SOURCE_HUMAN } from "./session.mjs";
import { searchShapes, shapeOperations } from "./shapes.mjs";
import { serializeXml, XmlError } from "./xml.mjs";

/** The canvas id. Bound to every open instance, so renaming it drops what is open. */
const ID = "drawio-canvas";
/** The label on the page and in `/canvas list`. Safe to change. */
const NAME = "Draw.io Canvas";

/**
 * How much diagram XML one `get_diagram` will return before switching to an
 * outline. The host caps an action result at 8,000 characters with a blunt
 * truncation — on XML, a half-closed element the model would edit from — so
 * the canvas cuts first, on a cell boundary, and says how to get the rest.
 */
const XML_BUDGET = 5_500;

/** Workspace directory for the manifest and screenshots. */
const STATE_DIR = ".drawio-canvas";

const PAGE_SELECTOR_SCHEMA = {
	page_id: { type: "string", description: "Target a page by id (from manage_pages op=list)." },
	page_name: { type: "string", description: "Target a page by name. Used when page_id is absent." },
	page_index: { type: "integer", minimum: 0, description: "Target a page by 0-based tab index. Used when id and name are absent." },
};

function selectorOf(input = {}) {
	const selector = {};
	if (input.page_id) selector.page_id = input.page_id;
	if (input.page_name) selector.page_name = input.page_name;
	if (input.page_index !== undefined && input.page_index !== null) selector.page_index = input.page_index;
	return selector;
}

function hasSelector(input = {}) {
	return Object.keys(selectorOf(input)).length > 0;
}

/** A compact line per cell, for a page too big to hand over whole. */
function outlineCell(entry) {
	const info = cellInfo(entry);
	const where = info.kind === "shape" ? ` @${info.x},${info.y} ${info.w}x${info.h}` : info.kind === "edge" ? ` ${info.source ?? "?"}->${info.target ?? "?"}` : "";
	const shape = info.shape && info.shape !== "rectangle" && info.kind === "shape" ? ` ${info.shape}` : "";
	return `${info.id} (${info.kind}${shape}${where})${info.label ? `: ${info.label.slice(0, 50)}` : ""}${info.parent ? ` in ${info.parent}` : ""}`;
}

/** Validation issues worth putting in front of the model, capped so they cannot flood it. */
function issuesFor(session) {
	const issues = validateDocument(session.document);
	return issues.length === 0 ? undefined : issues.slice(0, 10).map((issue) => `${issue.severity}: ${issue.page}: ${issue.message}`);
}

function safeName(text) {
	return String(text ?? "page").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "page";
}

/**
 * Build the canvas.
 *
 * @param {object} sdk The host's SDK surface: `createCanvas` and `CanvasError`.
 * @param {object} options
 * @param {string} options.extensionDir Directory the page's files are served from.
 * @param {(message: string) => void} [options.log] Session log sink.
 * @param {DrawioProvider} [options.drawio] Where the draw.io editor comes from; shared by instances.
 * @param {boolean} [options.prepare] Unpack the bundled draw.io as soon as a canvas opens, so the
 *   page finds it ready. Local only — opening never touches the network. Default true.
 */
export function createDrawioCanvas({ createCanvas, CanvasError }, { extensionDir, log = () => {}, drawio, prepare = true }) {
	const instances = new Map();
	const provider = drawio ?? new DrawioProvider({ log });

	function instanceOf(ctx) {
		const entry = instances.get(ctx.instanceId);
		if (!entry) throw new CanvasError("no_instance", `Canvas instance "${ctx.instanceId}" is not open.`);
		return entry;
	}

	function pageOf(session, input) {
		const selector = selectorOf(input);
		const page = session.document.page(selector);
		if (!page) {
			const known = session.document
				.pages()
				.map((item) => `${item.index}:${item.name}`)
				.join(", ");
			throw new CanvasError("page_not_found", `No page matches ${JSON.stringify(selector)}. Pages: ${known}.`);
		}
		if (page.compressed) throw new CanvasError("compressed_page", `Page "${page.name}" is stored in draw.io's compressed form and was not decoded.`);
		return page;
	}

	/** What the person did since the agent was last told, and where they are now. */
	function personReport(entry) {
		const { session, server } = entry;
		const report = {};
		const changes = session.tellAgent();
		if (changes) report.changes = changes;
		if (server.editorsConnected() === 0) report.editor = "closed — the person has no draw.io tab open on this canvas";
		const presence = session.presence;
		if (presence) {
			report.looking_at = {
				page: presence.page,
				...(presence.selection?.length ? { selected: presence.selection.slice(0, 20) } : {}),
				viewport: presence.viewport,
			};
		}
		return Object.keys(report).length > 0 ? report : undefined;
	}

	/** Refuse an agent edit that would overwrite what it has not seen, saying exactly what. */
	function gate(session, page, operations) {
		const verdict = session.editGate(page, operations);
		if (verdict.ok) return;
		if (verdict.reason === "no-context") {
			throw new CanvasError(
				"no_context",
				`Call get_diagram for page "${page.name}" first: you have not read it, and editing by id without reading would overwrite work you cannot see.`,
			);
		}
		const lines = verdict.conflicts.flatMap((conflict) => conflict.changes.slice(-3)).slice(0, 12);
		const ids = verdict.conflicts.map((conflict) => conflict.cell_id);
		throw new CanvasError(
			"stale_cells",
			`Not applied: the person changed ${ids.length === 1 ? "a cell" : `${ids.length} cells`} you are editing since you last read ${ids.length === 1 ? "it" : "them"}:\n${lines.join("\n")}\nCall get_diagram with cell_ids ${JSON.stringify(ids)} and reapply your edit on top of what is there now. Nothing in this batch was applied.`,
		);
	}

	/** Whether the person changed anything on these pages that the agent has not seen. */
	function unseenHumanWork(session, pages) {
		for (const page of pages) {
			for (const [key, change] of session.cellChanges) {
				const [pageId, id] = key.split("\u0000");
				if (pageId !== page.id || change.source !== SOURCE_HUMAN) continue;
				if (change.version > session.seenVersion(pageId, id)) return true;
			}
		}
		return false;
	}

	/** The manifest: the whole document as a summary, plus who changed what. */
	function manifestOf(entry, instanceId) {
		const { session, server } = entry;
		let budget = 2000;
		return {
			canvas: ID,
			drawio: provider.status().version ?? PINNED.version,
			instance: instanceId,
			file: session.filePath ?? null,
			version: session.version,
			updated_at: new Date(session.updatedAt).toISOString(),
			last_change: { version: session.version, source: session.lastSource, summary: session.journal.at(-1) ? session.summaryOf(session.journal.at(-1)) : session.lastLabel },
			editor_open: server.editorsConnected() > 0,
			person: session.presence ?? null,
			pages: session.document.pages().map((page) => {
				if (page.compressed) return { ...summarizePage(page) };
				const cells = page.drawable().filter((cell) => cell.cell.attrs.parent !== "0");
				const listed = cells.slice(0, Math.max(0, budget));
				budget -= listed.length;
				return {
					id: page.id,
					name: page.name,
					index: page.index,
					layers: layersOf(page),
					cells: listed.map(cellInfo),
					...(listed.length < cells.length ? { cells_omitted: cells.length - listed.length } : {}),
				};
			}),
			recent_changes: session.changesSince(0, { sources: [SOURCE_HUMAN, SOURCE_AGENT], limit: 1000 }).lines.slice(-60),
		};
	}

	function scheduleManifest(entry, instanceId) {
		if (!entry.stateDir || entry.closed) return;
		clearTimeout(entry.manifestTimer);
		entry.manifestTimer = setTimeout(async () => {
			if (entry.closed) return;
			try {
				await mkdir(entry.stateDir, { recursive: true });
				await writeFile(path.join(path.dirname(entry.stateDir), ".gitignore"), "# drawio-canvas working state: manifests and screenshots\n*\n");
				await writeFile(path.join(entry.stateDir, "manifest.json"), `${JSON.stringify(manifestOf(entry, instanceId), null, 1)}\n`);
			} catch (cause) {
				log(`${instanceId}: manifest not written: ${cause.message}`);
			}
		}, 300);
	}

	/** Where to write a screenshot the agent did not name. */
	function screenshotPath(entry, page, extension) {
		entry.shots = (entry.shots ?? 0) + 1;
		const name = `v${entry.session.version}-${safeName(page.name)}-${entry.shots}.${extension}`;
		return entry.stateDir ? path.join(entry.stateDir, "screenshots", name) : null;
	}

	function relativeToWorkspace(session, absolute) {
		return session.workspace ? path.relative(session.workspace, absolute).split(path.sep).join("/") : absolute;
	}

	const guard = (action) => ({
		...action,
		handler: async (ctx) => {
			try {
				return await action.handler(ctx);
			} catch (cause) {
				if (cause instanceof CanvasError) throw cause;
				if (cause instanceof DiagramError) throw new CanvasError(cause.code, cause.message);
				if (cause instanceof XmlError) throw new CanvasError("invalid_xml", cause.message);
				throw cause;
			}
		},
	});

	const actions = [
		{
			name: "get_diagram",
			description:
				"Read the diagram: its pages, layers and one page's cells as XML. Also reports what the person changed since you last looked and what they are looking at. Pass cell_ids to fetch only some cells (large pages return an outline first).",
			inputSchema: {
				type: "object",
				properties: {
					...PAGE_SELECTOR_SCHEMA,
					cell_ids: { type: "array", items: { type: "string" }, description: "Only these cells, instead of the whole page." },
				},
				additionalProperties: false,
			},
			handler: (ctx) => {
				const entry = instanceOf(ctx);
				const { session } = entry;
				const page = pageOf(session, ctx.input ?? {});
				const ids = ctx.input?.cell_ids?.length ? new Set(ctx.input.cell_ids.map(String)) : null;
				const cells = page.drawable().filter((cell) => !ids || ids.has(cellId(cell)));
				const xml = cells.map((cell) => serializeXml(cell.node)).join("\n");
				const common = {
					version: session.version,
					page: summarizePage(page),
					pages: session.document.pages().map(summarizePage),
					layers: layersOf(page),
					file: session.filePath ?? null,
					issues: issuesFor(session),
				};
				if (xml.length <= XML_BUDGET) {
					if (ids) session.markCellsSeen(page, [...ids]);
					else session.markPageSeen(page);
					return { ...common, cells_xml: xml, person: personReport(entry) };
				}
				// Too big to return whole: only the outline is seen, which is enough
				// to add next to it but not to overwrite any of it.
				const outline = cells.map(outlineCell);
				let used = 0;
				const shown = outline.filter((line) => (used += line.length + 4) <= XML_BUDGET);
				return {
					...common,
					note: `This ${ids ? "selection" : "page"} is ${xml.length} characters of XML, too much to return whole. Below is one line per cell${shown.length < outline.length ? ` (first ${shown.length} of ${outline.length})` : ""}; call get_diagram with cell_ids for the ones you need to edit.`,
					outline: shown,
					person: personReport(entry),
				};
			},
		},
		{
			name: "get_changes",
			description:
				"What changed since a version — by default, what the person did since you were last told — as one line per change, plus what the person is looking at. Cheap: call it at the start of a turn instead of re-reading the whole diagram.",
			inputSchema: {
				type: "object",
				properties: {
					since_version: { type: "integer", minimum: 0, description: "Report changes after this version. Default: since you were last told." },
					include_agent: { type: "boolean", description: "Include your own changes too. Default false." },
					limit: { type: "integer", minimum: 1, maximum: 200, description: "Most lines to return. Default 40." },
				},
				additionalProperties: false,
			},
			handler: (ctx) => {
				const entry = instanceOf(ctx);
				const { session } = entry;
				const since = ctx.input?.since_version ?? session.agentToldVersion;
				const report = session.changesSince(since, {
					sources: ctx.input?.include_agent ? [SOURCE_HUMAN, SOURCE_AGENT] : [SOURCE_HUMAN],
					limit: ctx.input?.limit ?? 40,
				});
				session.agentToldVersion = session.version;
				const presence = personReport(entry);
				return {
					version: session.version,
					since_version: since,
					changes: report.lines,
					...(report.truncated ? { more: report.total - report.lines.length } : {}),
					...(presence?.looking_at ? { looking_at: presence.looking_at } : {}),
					...(presence?.editor ? { editor: presence.editor } : {}),
					manifest: entry.stateDir ? relativeToWorkspace(session, path.join(entry.stateDir, "manifest.json")) : undefined,
				};
			},
		},
		{
			name: "edit_diagram",
			description:
				"Add, update or delete cells on one page by id. Each operation carries the complete <mxCell> for that cell. Works while the person edits: refused only if the person changed a cell you are updating or deleting since you read it (then re-read those cell_ids). The whole batch applies or none of it does.",
			inputSchema: {
				type: "object",
				properties: {
					...PAGE_SELECTOR_SCHEMA,
					operations: {
						type: "array",
						minItems: 1,
						description: "Operations, applied in order.",
						items: {
							type: "object",
							properties: {
								operation: { type: "string", enum: ["add", "update", "delete"] },
								cell_id: { type: "string", description: "Unique within the document. Ids 0 and 1 are mxGraph roots and are reserved." },
								new_xml: {
									type: "string",
									description:
										'The complete cell, e.g. \'<mxCell value="Login" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>\'. Required for add and update. Never nest one mxCell inside another. For library icons (AWS, Azure, GCP, …) prefer insert_shapes.',
								},
							},
							required: ["operation", "cell_id"],
							additionalProperties: false,
						},
					},
				},
				required: ["operations"],
				additionalProperties: false,
			},
			handler: (ctx) => {
				const entry = instanceOf(ctx);
				const { session } = entry;
				const page = pageOf(session, ctx.input ?? {});
				gate(session, page, ctx.input.operations);
				const result = session.apply({ page_id: page.id }, ctx.input.operations, { source: SOURCE_AGENT });
				if (result.applied.length === 0 && result.errors.length > 0) {
					throw new CanvasError("all_operations_failed", result.errors.map((error) => `${error.cell_id}: ${error.message}`).join("; "));
				}
				return {
					version: result.version,
					page: summarizePage(page),
					applied: result.applied.length,
					errors: result.errors.length > 0 ? result.errors : undefined,
					issues: issuesFor(session),
					person: personReport(entry),
				};
			},
		},
		{
			name: "search_shapes",
			description:
				"Search draw.io's shape libraries — AWS, Azure, GCP, Kubernetes, Cisco, IBM, SAP, UML, BPMN, network, flowchart and 400 more — by name. Returns shape ids for insert_shapes, with library and default size.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: 'Words to match, e.g. "aws lambda", "gcp cloud run", "azure function", "k8s pod".' },
					library: { type: "string", description: 'Only libraries whose name contains this, e.g. "AWS / Compute" or "gcp".' },
					limit: { type: "integer", minimum: 1, maximum: 50 },
				},
				required: ["query"],
				additionalProperties: false,
			},
			handler: (ctx) => {
				const query = String(ctx.input.query ?? "").replace(/\bk8s\b/gi, "kubernetes");
				return searchShapes(query, { library: ctx.input.library, limit: ctx.input.limit ?? 12 });
			},
		},
		{
			name: "insert_shapes",
			description:
				"Insert library shapes by the ids search_shapes returns, with draw.io's exact icon style. Give each a new cell_id and a position; size, label, parent (a container or layer id) and style overrides are optional. Connect them afterwards with edit_diagram edges.",
			inputSchema: {
				type: "object",
				properties: {
					...PAGE_SELECTOR_SCHEMA,
					shapes: {
						type: "array",
						minItems: 1,
						items: {
							type: "object",
							properties: {
								shape_id: { type: "string" },
								cell_id: { type: "string", description: "Id for the new cell. Multi-cell templates use it as a prefix." },
								x: { type: "number" },
								y: { type: "number" },
								width: { type: "number" },
								height: { type: "number" },
								label: { type: "string" },
								parent: { type: "string", description: "Container or layer id. Default: layer 1." },
								style: { type: "object", additionalProperties: { type: ["string", "number", "null"] }, description: 'Style keys to override, e.g. {"fillColor": "#dae8fc"}.' },
							},
							required: ["shape_id", "cell_id", "x", "y"],
							additionalProperties: false,
						},
					},
				},
				required: ["shapes"],
				additionalProperties: false,
			},
			handler: (ctx) => {
				const entry = instanceOf(ctx);
				const { session } = entry;
				const page = pageOf(session, ctx.input ?? {});
				const used = session.document.allIds();
				const operations = ctx.input.shapes.flatMap((item) => shapeOperations(item, { usedIds: used }));
				gate(session, page, operations);
				const result = session.apply({ page_id: page.id }, operations, { source: SOURCE_AGENT, label: `inserted ${ctx.input.shapes.length} shape(s)` });
				if (result.applied.length === 0 && result.errors.length > 0) {
					throw new CanvasError("all_operations_failed", result.errors.map((error) => `${error.cell_id}: ${error.message}`).join("; "));
				}
				return {
					version: result.version,
					inserted: result.applied.map((applied) => applied.cell_id),
					errors: result.errors.length > 0 ? result.errors : undefined,
					person: personReport(entry),
				};
			},
		},
		{
			name: "replace_diagram",
			description:
				"Replace a whole page, or the whole document, with new XML. Destructive: refused if the person has changed that page since you read it, unless force is true. Prefer edit_diagram unless starting from nothing.",
			inputSchema: {
				type: "object",
				properties: {
					...PAGE_SELECTOR_SCHEMA,
					xml: { type: "string", description: "An <mxfile>, an <mxGraphModel>, or sibling <mxCell> elements. With a page selector it replaces that page; without one, the document." },
					scope: { type: "string", enum: ["page", "document"], description: "Defaults to page when a selector is given, document otherwise." },
					force: { type: "boolean", description: "Replace even if the person has unseen changes there. Their work on it is discarded (it stays in history)." },
				},
				required: ["xml"],
				additionalProperties: false,
			},
			handler: (ctx) => {
				const entry = instanceOf(ctx);
				const { session } = entry;
				const scope = ctx.input.scope ?? (hasSelector(ctx.input) ? "page" : "document");
				const targets = scope === "document" ? session.document.pages().filter((page) => !page.compressed) : [pageOf(session, ctx.input)];
				if (!ctx.input.force && unseenHumanWork(session, targets)) {
					throw new CanvasError(
						"stale_diagram",
						"The person has changed this since you last read it, and replacing it would discard their work. Call get_diagram (or get_changes) first, or pass force: true if discarding it is intended.",
					);
				}
				if (scope === "document") {
					session.replace(ctx.input.xml, { source: SOURCE_AGENT, label: "replaced document" });
					return { version: session.version, pages: session.document.pages().map(summarizePage), issues: issuesFor(session), person: personReport(entry) };
				}
				const page = targets[0];
				const replacement = session.document.addPage(page.name, ctx.input.xml);
				// Put the new page where the old one was, keeping its id, then drop the
				// old one: a page that silently moves to the end of the tab strip looks
				// like data loss to whoever is watching the tabs.
				const children = session.document.root.children;
				children.splice(children.indexOf(replacement.element), 1);
				children.splice(children.indexOf(page.element), 0, replacement.element);
				replacement.element.attrs.id = page.id;
				children.splice(children.indexOf(page.element), 1);
				session.commit(SOURCE_AGENT, [], `replaced page "${page.name}"`);
				session.markPageSeen(session.document.page({ page_id: page.id }));
				return { version: session.version, page: summarizePage(session.document.page({ page_id: page.id })), issues: issuesFor(session), person: personReport(entry) };
			},
		},
		{
			name: "manage_pages",
			description: "List, add, rename or delete the diagram's pages (the tabs along the bottom of the editor).",
			inputSchema: {
				type: "object",
				properties: {
					op: { type: "string", enum: ["list", "add", "rename", "delete"] },
					name: { type: "string", description: "The new page's name, or the new name when renaming." },
					xml: { type: "string", description: "Optional starting content for op=add, as <mxCell> siblings or an <mxGraphModel>." },
					...PAGE_SELECTOR_SCHEMA,
				},
				required: ["op"],
				additionalProperties: false,
			},
			handler: (ctx) => {
				const { session } = instanceOf(ctx);
				return session.pages({ ...ctx.input, ...selectorOf(ctx.input), source: SOURCE_AGENT });
			},
		},
		{
			name: "manage_layers",
			description:
				"Layers of one page (draw.io's Layers panel): list, add, rename, show, hide, lock, unlock, reorder (index 0 = bottom), move_cells onto a layer, or delete (moving or deleting its cells).",
			inputSchema: {
				type: "object",
				properties: {
					...PAGE_SELECTOR_SCHEMA,
					op: { type: "string", enum: ["list", "add", "rename", "show", "hide", "lock", "unlock", "reorder", "move_cells", "delete"] },
					layer_id: { type: "string" },
					layer_name: { type: "string", description: "Select the layer by name when layer_id is absent." },
					name: { type: "string", description: "Name for add or rename." },
					index: { type: "integer", minimum: 0, description: "New position for reorder." },
					cell_ids: { type: "array", items: { type: "string" }, description: "Cells for move_cells." },
					move_to_layer_id: { type: "string", description: "For delete: keep the layer's cells by moving them here." },
					delete_cells: { type: "boolean", description: "For delete: delete the layer's cells too." },
				},
				required: ["op"],
				additionalProperties: false,
			},
			handler: (ctx) => {
				const entry = instanceOf(ctx);
				const { session } = entry;
				const page = pageOf(session, ctx.input ?? {});
				if (ctx.input.op === "move_cells") gate(session, page, (ctx.input.cell_ids ?? []).map((id) => ({ operation: "update", cell_id: id })));
				const result = layerCommand(page, ctx.input);
				if (ctx.input.op !== "list") session.commit(SOURCE_AGENT, [], `layers: ${ctx.input.op}`);
				return { version: session.version, ...result, person: personReport(entry) };
			},
		},
		{
			name: "screenshot",
			description:
				"See the diagram as draw.io renders it (real AWS/Azure/GCP icons, stencils, labels): writes a PNG into the workspace and returns its path — read that file to look at it. scope: page (default), viewport (what the person sees), selection (what they selected) or cells.",
			inputSchema: {
				type: "object",
				properties: {
					...PAGE_SELECTOR_SCHEMA,
					scope: { type: "string", enum: ["page", "viewport", "selection", "cells"] },
					cell_ids: { type: "array", items: { type: "string" }, description: "For scope=cells." },
					scale: { type: "number", minimum: 0.1, maximum: 4, description: "Default 1." },
					path: { type: "string", description: "Workspace-relative .png to write. Default: under .drawio-canvas/." },
				},
				additionalProperties: false,
			},
			handler: async (ctx) => {
				const entry = instanceOf(ctx);
				const { session, server } = entry;
				const input = ctx.input ?? {};
				const scope = input.scope ?? "page";
				const page = scope === "viewport" || scope === "selection" ? null : pageOf(session, input);
				const targetPage = page ?? session.document.page({ page_id: session.presence?.page_id }) ?? session.document.page();
				let absolute = input.path ? resolveInWorkspace(session.workspace, input.path) : screenshotPath(entry, targetPage, "png");
				if (server.editorsConnected() > 0) {
					const shot = await server.requestEditor("screenshot", { page_id: page?.id, scope, cell_ids: input.cell_ids, scale: input.scale ?? 1 });
					const png = Buffer.from(String(shot.png).replace(/^data:image\/png;base64,/, ""), "base64");
					if (!absolute) absolute = path.join((await import("node:os")).tmpdir(), `drawio-canvas-${randomBytes(4).toString("hex")}.png`);
					await writeWorkspaceFile(absolute, png);
					return {
						path: relativeToWorkspace(session, absolute),
						width: shot.width,
						height: shot.height,
						version: session.version,
						page: targetPage?.name,
						note: "Rendered by the person's draw.io. Read the file to see it.",
						person: personReport(entry),
					};
				}
				// No editor to ask: the canvas's own renderer, which draws the common
				// shapes and a labelled box for everything else. Honest about it.
				const svgPath = absolute ? absolute.replace(/\.png$/i, ".svg") : null;
				const svg = renderPageSvg(targetPage, renderOptions());
				if (svgPath) await writeWorkspaceFile(svgPath, svg);
				return {
					path: svgPath ? relativeToWorkspace(session, svgPath) : null,
					format: "svg",
					version: session.version,
					note: "No draw.io tab is open, so this is the canvas's approximate SVG (library icons are drawn as labelled boxes). Ask the person to open the canvas for a real screenshot.",
					person: personReport(entry),
				};
			},
		},
		{
			name: "focus",
			description: "Point the person at something: switch their editor to a page, select and scroll to cells, and show a short message in the canvas bar.",
			inputSchema: {
				type: "object",
				properties: {
					...PAGE_SELECTOR_SCHEMA,
					cell_ids: { type: "array", items: { type: "string" } },
					message: { type: "string", description: "One line, e.g. \"Is this the right VPC?\"" },
				},
				additionalProperties: false,
			},
			handler: async (ctx) => {
				const entry = instanceOf(ctx);
				const page = pageOf(entry.session, ctx.input ?? {});
				const result = await entry.server.requestEditor("focus", { page_id: page.id, cell_ids: ctx.input?.cell_ids ?? [], message: ctx.input?.message });
				return { ...result, person: personReport(entry) };
			},
		},
		{
			name: "layout",
			description:
				"Run one of draw.io's automatic layouts in the person's editor, as Arrange > Layout does: a preset name (e.g. \"verticalFlow\", \"horizontalFlow\", \"verticalTree\", \"horizontalTree\", \"organic\", \"circle\") or draw.io's layout JSON, e.g. [{\"layout\":\"mxHierarchicalLayout\",\"config\":{\"orientation\":\"west\"}}]. Moved cells come back as your edit; re-read them before editing them.",
			inputSchema: {
				type: "object",
				properties: {
					...PAGE_SELECTOR_SCHEMA,
					layout: { description: "Preset name or layout JSON array.", anyOf: [{ type: "string" }, { type: "array", items: { type: "object" } }] },
					cell_ids: { type: "array", items: { type: "string" }, description: "Lay out only these (selected) cells." },
				},
				required: ["layout"],
				additionalProperties: false,
			},
			handler: async (ctx) => {
				const entry = instanceOf(ctx);
				const { session, server } = entry;
				const page = pageOf(session, ctx.input ?? {});
				const before = session.version;
				await server.requestEditor("layout", { page_id: page.id, layout: ctx.input.layout, cell_ids: ctx.input.cell_ids }, { timeoutMs: 25_000 });
				// The moves arrive over the sync channel just before the answer does.
				await new Promise((resolve) => setTimeout(resolve, 150));
				const moved = session.changesSince(before, { sources: [SOURCE_AGENT], limit: 30 });
				return { version: session.version, changes: moved.lines, ...(moved.truncated ? { more: moved.total - moved.lines.length } : {}), person: personReport(entry) };
			},
		},
		{
			name: "open_file",
			description:
				"Load a .drawio file from the workspace into the canvas, replacing what is open. draw.io's compressed files are decoded on the way in. Call get_diagram afterwards: edits by id are refused until you have read it.",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string", description: "Workspace-relative path, e.g. docs/architecture.drawio." } },
				required: ["path"],
				additionalProperties: false,
			},
			handler: async (ctx) => {
				const entry = instanceOf(ctx);
				const { session } = entry;
				const absolute = resolveInWorkspace(session.workspace, ctx.input.path);
				const { xml, inflatedPages } = await readDiagramFile(absolute);
				session.replace(xml, { source: SOURCE_AGENT, label: `opened ${ctx.input.path}`, seen: false });
				session.seenPages.clear();
				session.seenCells.clear();
				session.filePath = ctx.input.path;
				return { opened: ctx.input.path, decompressed_pages: inflatedPages, version: session.version, pages: session.document.pages().map(summarizePage) };
			},
		},
		{
			name: "save_file",
			description:
				"Write the diagram into the workspace: .drawio or .xml for the editable document, .svg or .png for a picture of one page (rendered by the person's draw.io when it is open; the .svg embeds the diagram so draw.io can reopen it).",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "Workspace-relative path. The extension decides the format." },
					...PAGE_SELECTOR_SCHEMA,
				},
				required: ["path"],
				additionalProperties: false,
			},
			handler: async (ctx) => {
				const entry = instanceOf(ctx);
				const { session, server } = entry;
				const absolute = resolveInWorkspace(session.workspace, ctx.input.path);
				const extension = path.extname(absolute).toLowerCase();
				const editor = server.editorsConnected() > 0;
				let contents;
				let rendered = "document";
				if (extension === ".svg") {
					const page = pageOf(session, ctx.input);
					if (editor) {
						contents = (await server.requestEditor("svg", { page_id: page.id })).svg;
						rendered = "draw.io";
					} else {
						contents = renderPageSvg(page, renderOptions());
						rendered = "approximate (no editor open)";
					}
				} else if (extension === ".png") {
					const page = pageOf(session, ctx.input);
					if (!editor) throw new CanvasError("no_editor", "PNG export needs the person's draw.io open on this canvas. Save .svg instead, or ask them to open it.");
					const shot = await server.requestEditor("screenshot", { page_id: page.id, scope: "page", scale: 2, max_size: 4000 });
					contents = Buffer.from(String(shot.png).replace(/^data:image\/png;base64,/, ""), "base64");
					rendered = "draw.io";
				} else {
					contents = toFileXml(session.document);
				}
				await writeWorkspaceFile(absolute, contents);
				if (extension === ".drawio" || extension === ".xml") session.filePath = ctx.input.path;
				return { saved: ctx.input.path, bytes: Buffer.byteLength(contents), format: extension.slice(1), rendered };
			},
		},
	];

	const canvas = {
		id: ID,
		displayName: NAME,
		description:
			"A draw.io diagram you and the person edit at the same time: they use the full draw.io editor (every shape library, layers, pages) in their browser while you read, edit, search shapes, lay out and take screenshots through actions.",
		inputSchema: {
			type: "object",
			properties: {
				file: { type: "string", description: "Workspace-relative .drawio file to open into the canvas." },
				xml: { type: "string", description: "Diagram XML to start from, instead of a blank page." },
			},
			additionalProperties: false,
		},
		actions,
		open: async (ctx) => {
			// The working directory arrives in the provider context. Without it the
			// canvas still works; only the file actions and the manifest cannot.
			const workspace = ctx.session?.workingDirectory ?? process.env.DRAWIO_CANVAS_WORKSPACE;
			const token = randomBytes(32).toString("base64url");
			const session = new DiagramSession({ workspace });
			if (prepare) provider.ensure({ network: false }).catch(() => {});

			// A reload re-opens this instance in a new process (see `writeSnapshot`).
			const parked = await takeSnapshot(ctx.instanceId);
			void sweepSnapshots();

			if (parked) {
				session.replace(parked.xml, { source: SOURCE_AGENT, label: "restored after a reload", seen: false });
				session.filePath = parked.filePath ?? undefined;
			} else if (ctx.input?.xml) {
				session.replace(ctx.input.xml, { source: SOURCE_AGENT, label: "opened with supplied XML", seen: false });
			} else if (ctx.input?.file) {
				const absolute = resolveInWorkspace(workspace, ctx.input.file);
				const { xml } = await readDiagramFile(absolute);
				session.replace(xml, { source: SOURCE_AGENT, label: `opened ${ctx.input.file}`, seen: false });
				session.filePath = ctx.input.file;
			}
			// A blank canvas is marked seen so the agent can draw the first shape
			// without a pointless read of an empty page; one opened *with* content is
			// not, because the agent has not read it.
			if (!parked && !ctx.input?.xml && !ctx.input?.file) session.markSeen();
			session.agentToldVersion = session.version;

			const server = await startInstanceServer({
				session,
				token,
				extensionDir,
				drawio: provider,
				log: (message) => log(`${ctx.instanceId}: ${message}`),
			});
			const safeId = String(ctx.instanceId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "instance";
			const entry = { session, server, token, stateDir: workspace ? path.join(workspace, STATE_DIR, safeId) : null };
			instances.set(ctx.instanceId, entry);
			entry.unsubscribe = session.subscribe((event) => {
				if (event.type === "change" || event.type === "presence") scheduleManifest(entry, ctx.instanceId);
			});
			scheduleManifest(entry, ctx.instanceId);
			const status = provider.status();
			return {
				url: server.url,
				title: session.filePath ? `${NAME}: ${path.basename(session.filePath)}` : NAME,
				status: [
					status.state === "ready" ? `draw.io ${status.version}` : `draw.io ${PINNED.version}: ${status.state}`,
					workspace ? `workspace ${workspace}` : "no workspace: file actions are unavailable",
				].join(" · "),
			};
		},
		onClose: async (ctx) => {
			const entry = instances.get(ctx.instanceId);
			// Also called for an open that was abandoned before it finished.
			if (!entry) return;
			instances.delete(ctx.instanceId);
			entry.closed = true;
			clearTimeout(entry.manifestTimer);
			entry.unsubscribe?.();
			// Park the document before letting go: a close is also what a reload sends
			// to the outgoing process, and the incoming one reads this back.
			const worthKeeping = entry.session.document.pages().some((page) => !page.compressed && page.drawable().length > 0) || entry.session.filePath;
			if (worthKeeping) {
				await writeSnapshot(ctx.instanceId, { xml: entry.session.document.toXml(), filePath: entry.session.filePath });
			}
			if (entry.stateDir) await rm(entry.stateDir, { recursive: true, force: true }).catch(() => {});
			await entry.server.close();
		},
	};

	return createCanvas({ ...canvas, actions: canvas.actions.map(guard) });
}

