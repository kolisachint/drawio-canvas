/**
 * The canvas: its declaration, and the six actions the agent drives it with.
 *
 * Separate from `extension.mjs` so the handlers can be exercised directly. The
 * SDK surface arrives as arguments rather than as an import, which means a test
 * can call every action against a real document, a real loopback server and a
 * real workspace without forking a child process or reimplementing the host's
 * side of the wire protocol. `extension.mjs` is then the only file that touches
 * `@github/copilot-sdk/extension`, and it is twenty lines long.
 *
 * Everything an action decides is here. Everything it decides *about* — the
 * document, the file rules, the page — is in the modules this imports, which
 * are the same ones the browser loads.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import {
	readDiagramFile,
	resolveInWorkspace,
	sweepSnapshots,
	takeSnapshot,
	toFileXml,
	writeSnapshot,
	writeWorkspaceFile,
} from "./files.mjs";
import { cellId, DiagramError, summarizePage, validateDocument } from "./model.mjs";
import { renderOptions, renderPageSvg } from "./render.mjs";
import { startInstanceServer } from "./server.mjs";
import { DiagramSession, SOURCE_AGENT } from "./session.mjs";
import { serializeXml, XmlError } from "./xml.mjs";

/** The canvas id. Bound to every open instance, so renaming it drops what is open. */
const ID = "drawio-canvas";
/** The label on the page and in `/canvas list`. Safe to change. */
const NAME = "Draw.io Canvas";

/**
 * How much diagram XML one `get_diagram` will return before switching to an
 * outline.
 *
 * Whatever an action returns lands in the model's context window, and the host
 * caps a result at 8,000 characters with a blunt truncation — which, on XML,
 * means handing the model a half-closed element and letting it edit from that.
 * Below this limit the page's cells come back whole; above it, an outline comes
 * back instead, with the instruction to ask for the cells it actually needs.
 */
const XML_BUDGET = 6_000;

/** Page selector fields, shared by every action that targets one page. */
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

/** The cells of a page as XML, which is the form `edit_diagram` takes back. */
function pageCellsXml(page, ids) {
	const wanted = ids && ids.length > 0 ? new Set(ids.map(String)) : null;
	const cells = page.drawable().filter((entry) => !wanted || wanted.has(cellId(entry)));
	return cells.map((entry) => serializeCell(entry)).join("\n");
}

function serializeCell(entry) {
	// One definition of "how a cell is written": the model module owns the tree,
	// xml.mjs owns the bytes, and the page reads back exactly what is sent here.
	return serializeXml(entry.node);
}

/** A compact line per cell, for a page too big to hand over whole. */
function outlineCell(entry) {
	const label = (entry.node.attrs.label ?? entry.cell.attrs.value ?? "").replace(/<[^>]+>/g, "").trim();
	const kind = entry.cell.attrs.edge === "1" ? "edge" : "shape";
	const link = entry.cell.attrs.edge === "1" ? ` ${entry.cell.attrs.source ?? "?"}->${entry.cell.attrs.target ?? "?"}` : "";
	return `${cellId(entry)} (${kind}${link})${label ? `: ${label.slice(0, 60)}` : ""}`;
}

/** Validation issues worth putting in front of the model, capped so they cannot flood it. */
function issuesFor(session) {
	const issues = validateDocument(session.document);
	return issues.length === 0 ? undefined : issues.slice(0, 10).map((issue) => `${issue.severity}: ${issue.page}: ${issue.message}`);
}

/**
 * Build the canvas.
 *
 * @param {object} sdk The host's SDK surface: `createCanvas` and `CanvasError`.
 * @param {object} options
 * @param {string} options.extensionDir Directory the page's files are served from.
 * @param {(message: string) => void} [options.log] Session log sink.
 */
export function createDrawioCanvas({ createCanvas, CanvasError }, { extensionDir, log = () => {} }) {
	/** Per-instance state: one document, one loopback server, one token. */
	const instances = new Map();

	function instanceOf(ctx) {
		const entry = instances.get(ctx.instanceId);
		if (!entry) throw new CanvasError("no_instance", `Canvas instance "${ctx.instanceId}" is not open.`);
		return entry;
	}

	/** Resolve a page or fail with the selector named, so the agent can fix it. */
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
		return page;
	}

	/**
	 * Carry the document layer's typed errors across the process boundary.
	 *
	 * `lib/` throws `DiagramError` and `XmlError`, both of which name exactly what
	 * went wrong. The host only preserves a code when the error is the SDK's
	 * `CanvasError`, so without this translation every refusal — a path outside
	 * the workspace, a duplicate cell id, malformed XML — reaches the agent as
	 * `internal_error` and it has nothing to branch on but prose.
	 */
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

	const canvas = {
		id: ID,
		displayName: NAME,
		description:
			"A draw.io diagram you and the person edit together: they drag, connect and label shapes in the browser while you add, update and delete cells by id.",
		inputSchema: {
			type: "object",
			properties: {
				file: { type: "string", description: "Workspace-relative .drawio file to open into the canvas." },
				xml: { type: "string", description: "Diagram XML to start from, instead of a blank page." },
			},
			additionalProperties: false,
		},
		actions: [
			{
				name: "get_diagram",
				description:
					"Read the diagram: its pages, and one page's cells as XML. Call this before your first edit in a session and again whenever edit_diagram says the person has changed something. Pass cell_ids to fetch only the cells you care about on a large page.",
				inputSchema: {
					type: "object",
					properties: {
						...PAGE_SELECTOR_SCHEMA,
						cell_ids: { type: "array", items: { type: "string" }, description: "Only these cells, instead of the whole page." },
					},
					additionalProperties: false,
				},
				handler: (ctx) => {
					const { session } = instanceOf(ctx);
					const page = pageOf(session, ctx.input ?? {});
					if (page.compressed) {
						throw new CanvasError("compressed_page", `Page "${page.name}" is stored in draw.io's compressed form and was not decoded.`);
					}
					session.markSeen();
					const xml = pageCellsXml(page, ctx.input?.cell_ids);
					const common = {
						version: session.version,
						page: summarizePage(page),
						pages: session.document.pages().map(summarizePage),
						file: session.filePath ?? null,
						issues: issuesFor(session),
					};
					if (xml.length <= XML_BUDGET) return { ...common, cells_xml: xml };
					return {
						...common,
						note: `This page is ${xml.length} characters of XML, too much to return whole. Below is one line per cell; call get_diagram again with cell_ids for the ones you need to edit.`,
						outline: page.drawable().map(outlineCell),
					};
				},
			},
			{
				name: "edit_diagram",
				description:
					"Add, update or delete cells on one page by id. Each operation carries the complete <mxCell> XML for that cell. Refused if the person has changed the diagram since your last get_diagram, so their work is never overwritten — call get_diagram and retry.",
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
									cell_id: { type: "string", description: "Unique within the page. Ids 0 and 1 are mxGraph roots and are reserved." },
									new_xml: {
										type: "string",
										description:
											'The complete cell, e.g. \'<mxCell value="Login" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>\'. Required for add and update. Cells must be siblings: never nest one mxCell inside another.',
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
					const { session } = instanceOf(ctx);
					const gate = session.editGate();
					if (!gate.ok) {
						throw new CanvasError(
							gate.reason === "no-context" ? "no_context" : "stale_diagram",
							gate.reason === "no-context"
								? "Call get_diagram first: you have not seen this diagram, and editing cells by id without reading them would overwrite work you cannot see."
								: "The person has changed the diagram since you last read it. Call get_diagram and reapply your edit on top of what is there now.",
						);
					}
					const page = pageOf(session, ctx.input ?? {});
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
					};
				},
			},
			{
				name: "replace_diagram",
				description:
					"Replace a whole page, or the whole document, with new XML. Destructive: everything on the target is discarded, including the person's unsaved work, so prefer edit_diagram unless you are starting from nothing.",
				inputSchema: {
					type: "object",
					properties: {
						...PAGE_SELECTOR_SCHEMA,
						xml: {
							type: "string",
							description:
								"An <mxfile>, an <mxGraphModel>, or a list of sibling <mxCell> elements. With a page selector it replaces that page; without one it replaces the document.",
						},
						scope: { type: "string", enum: ["page", "document"], description: "Defaults to page when a selector is given, document otherwise." },
					},
					required: ["xml"],
					additionalProperties: false,
				},
				handler: (ctx) => {
					const { session } = instanceOf(ctx);
					const selector = selectorOf(ctx.input);
					const scope = ctx.input.scope ?? (Object.keys(selector).length > 0 ? "page" : "document");
					if (scope === "document") {
						session.replace(ctx.input.xml, { source: SOURCE_AGENT, label: "replaced document" });
						return {
							version: session.version,
							pages: session.document.pages().map(summarizePage),
							issues: issuesFor(session),
						};
					}
					const page = pageOf(session, ctx.input);
					const replacement = session.document.addPage(page.name, ctx.input.xml);
					// Put the new page where the old one was, then drop the old one: a page
					// that silently moves to the end of the tab strip looks like data loss to
					// whoever is watching the tabs.
					const children = session.document.root.children;
					children.splice(children.indexOf(replacement.element), 1);
					children.splice(children.indexOf(page.element), 0, replacement.element);
					replacement.element.attrs.id = page.id;
					children.splice(children.indexOf(page.element), 1);
					session.commit(SOURCE_AGENT, [], `replaced page "${page.name}"`);
					return {
						version: session.version,
						page: summarizePage(session.document.page({ page_id: page.id })),
						issues: issuesFor(session),
					};
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
				name: "open_file",
				description:
					"Load a .drawio file from the workspace into the canvas, replacing what is open. draw.io's compressed files are decoded on the way in. Call get_diagram afterwards: you have not seen this file's cell ids yet, and edit_diagram refuses until you have.",
				inputSchema: {
					type: "object",
					properties: { path: { type: "string", description: "Workspace-relative path, e.g. docs/architecture.drawio." } },
					required: ["path"],
					additionalProperties: false,
				},
				handler: async (ctx) => {
					const { session } = instanceOf(ctx);
					const absolute = resolveInWorkspace(session.workspace, ctx.input.path);
					const { xml, inflatedPages } = await readDiagramFile(absolute);
					// Not marked as seen: the agent picked the path, but it has no idea what
					// cell ids are in the file, and editing by id without reading them is
					// exactly what the gate is for.
					session.replace(xml, { source: SOURCE_AGENT, label: `opened ${ctx.input.path}`, seen: false });
					session.filePath = ctx.input.path;
					return {
						opened: ctx.input.path,
						decompressed_pages: inflatedPages,
						version: session.version,
						pages: session.document.pages().map(summarizePage),
					};
				},
			},
			{
				name: "save_file",
				description:
					"Write the diagram to the workspace: .drawio or .xml for the editable document, .svg for a picture of one page. The path must stay inside the session's working directory.",
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
					const { session } = instanceOf(ctx);
					const absolute = resolveInWorkspace(session.workspace, ctx.input.path);
					const svg = path.extname(absolute).toLowerCase() === ".svg";
					const contents = svg ? renderPageSvg(pageOf(session, ctx.input), renderOptions()) : toFileXml(session.document);
					await writeWorkspaceFile(absolute, contents);
					if (!svg) session.filePath = ctx.input.path;
					return { saved: ctx.input.path, bytes: Buffer.byteLength(contents), format: svg ? "svg" : "drawio" };
				},
			},
		],
		open: async (ctx) => {
			// The working directory arrives in the provider context. Without it the
			// canvas still works; only the two file actions cannot, and they say so
			// rather than guessing at a path.
			const workspace = ctx.session?.workingDirectory ?? process.env.DRAWIO_CANVAS_WORKSPACE;
			const token = randomBytes(32).toString("base64url");
			const session = new DiagramSession({ workspace });

			// A reload re-opens this instance in a new process (see `writeSnapshot`).
			// Taking the snapshot back is what makes iterating on this canvas's own
			// code non-destructive for whoever is looking at the diagram.
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
			// without a pointless read of an empty page. A canvas opened *with*
			// content is not: whatever is on it came from a file or from the person,
			// the agent has not read it, and the edit gate exists precisely to stop
			// it editing cells by id in a document it has never looked at.
			if (!parked && !ctx.input?.xml && !ctx.input?.file) session.markSeen();

			const server = await startInstanceServer({
				session,
				token,
				extensionDir,
				log: (message) => log(`${ctx.instanceId}: ${message}`),
			});
			instances.set(ctx.instanceId, { session, server, token });
			return {
				url: server.url,
				title: NAME,
				status: workspace ? `workspace ${workspace}` : "no workspace: file actions are unavailable",
			};
		},
		onClose: async (ctx) => {
			const entry = instances.get(ctx.instanceId);
			// Also called for an open that was abandoned before it finished, so the
			// instance may be unknown — that is the path that releases a port bound by
			// an open the person cancelled.
			if (!entry) return;
			instances.delete(ctx.instanceId);
			// Park the document before letting go: a close is also what a reload sends
			// to the outgoing process, and the incoming one reads this back.
			const worthKeeping = entry.session.document.page()?.drawable().length > 0 || entry.session.filePath;
			if (worthKeeping) {
				await writeSnapshot(ctx.instanceId, { xml: entry.session.document.toXml(), filePath: entry.session.filePath });
			}
			await entry.server.close();
		},
	};

	return createCanvas({ ...canvas, actions: canvas.actions.map(guard) });
}
