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
 *   asks      get_asks, update_ask            (what the person asked the agent for)
 *   write     edit_diagram, insert_shapes, replace_diagram, manage_pages, manage_layers
 *   see/show  screenshot, focus, layout      (done in the person's own editor)
 *   tidy      tidy                           (fit, align, un-overlap: no geometry by hand)
 *   files     open_file, save_file
 *
 * Every result that follows a read or a write carries `person`: what the person
 * changed since the agent was last told, and what they are looking at. The
 * agent learns about parallel work as a side effect of doing its own. The same
 * picture is kept on disk as `.drawio-canvas/<instance>/manifest.json` in the
 * workspace, for tools that read files rather than call actions.
 */

import { randomBytes } from "node:crypto";
import { AgentLink } from "./agent.mjs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { cellInfo } from "./changes.mjs";
import { Collaboration } from "./collab.mjs";
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
import { readPrefs, writePrefs } from "./settings.mjs";
import { DiagramSession, SOURCE_AGENT, SOURCE_HUMAN } from "./session.mjs";
import { searchShapes, shapeOperations } from "./shapes.mjs";
import { describeTidy } from "./tidy.mjs";
import { tidyPage } from "./tidy-page.mjs";
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
/** How much current XML a refusal may carry, so the agent can reapply without a re-read. */
const REFUSAL_XML_BUDGET = 3_000;

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
 * The layouts draw.io 31.4.6 runs: its Arrange > Layout presets, and the layout
 * names its layout JSON accepts. Read from the live editor (ElkLayout.MENU_PRESETS,
 * Graph.layoutNames, LibavoidRouting); test/drawio.test.mjs checks them against
 * it, so a draw.io upgrade that changes them fails loudly.
 *
 * They are checked here because draw.io does not fail an unknown layout: it
 * opens an error dialog in front of the person and never finishes, so the agent
 * waited out the whole 25 s timeout.
 */
export const LAYOUT_PRESETS = ["verticalFlow", "horizontalFlow", "verticalTree", "horizontalTree", "radialTree", "organic", "circle", "parallels", "libavoid"];
export const LAYOUT_NAMES = [
	"mxHierarchicalLayout",
	"mxCircleLayout",
	"mxCompactTreeLayout",
	"mxEdgeLabelLayout",
	"mxFastOrganicLayout",
	"mxParallelEdgeLayout",
	"mxPartitionLayout",
	"mxRadialTreeLayout",
	"mxStackLayout",
	"elkLayered",
	"elkTree",
	"elkRadial",
	"elkOrganic",
	"elkStress",
	"elkDisco",
	"elkBox",
	"orthogonalEdge",
];
/** Names a model reaches for that draw.io spells differently. "circle" was once in this action's own description. */
const LAYOUT_ALIASES = { circle: [{ layout: "mxCircleLayout" }], orthogonalEdge: "libavoid" };

/** A layout the editor will run, or a refusal naming what would have worked. */
export function layoutSpec(layout) {
	const options = `Presets: ${LAYOUT_PRESETS.join(", ")}; or JSON like [{"layout":"mxHierarchicalLayout","config":{"orientation":"west"}}] with layout one of ${LAYOUT_NAMES.join(", ")}.`;
	let spec = typeof layout === "string" ? layout.trim() : layout;
	if (typeof spec === "string" && spec.startsWith("[")) {
		try {
			spec = JSON.parse(spec);
		} catch (cause) {
			throw new DiagramError("invalid_layout", `The layout JSON does not parse (${cause.message}). ${options}`);
		}
	}
	if (typeof spec === "string") {
		if (spec in LAYOUT_ALIASES) return LAYOUT_ALIASES[spec];
		if (LAYOUT_PRESETS.includes(spec)) return spec;
		// A layout name on its own is unambiguous: run it with its defaults.
		if (LAYOUT_NAMES.includes(spec)) return [{ layout: spec }];
		throw new DiagramError("invalid_layout", `${spec ? `"${spec}" is not a draw.io layout` : "No layout given"}. ${options}`);
	}
	if (!Array.isArray(spec) || spec.length === 0) throw new DiagramError("invalid_layout", `Give a preset name or a non-empty layout list. ${options}`);
	for (const [index, step] of spec.entries()) {
		if (!step || typeof step !== "object" || !LAYOUT_NAMES.includes(step.layout)) {
			throw new DiagramError("invalid_layout", `layout[${index}].layout ${step?.layout ? `"${step.layout}" is not a draw.io layout` : "is missing"}. ${options}`);
		}
		if (step.config !== undefined && (step.config === null || typeof step.config !== "object" || Array.isArray(step.config))) {
			throw new DiagramError("invalid_layout", `layout[${index}].config must be an object of that layout's options.`);
		}
	}
	return spec;
}

/**
 * Check a value against the JSON Schema subset the actions declare: type (or a
 * list of types), enum, minimum/maximum, minItems, items, required, anyOf and
 * additionalProperties. It validates the schema each action already shows the
 * model, so it cannot drift from what the model was told.
 *
 * Returns what is wrong, in words a model can act on, or null.
 *
 * `null` for an optional property reads as "not given": models send it for
 * fields they mean to leave out, and refusing that would be pedantry. Unknown
 * properties are refused rather than ignored, because a typo ("page_nmae")
 * silently ignored sends an edit to the wrong page.
 */
export function checkValue(schema, value, where) {
	if (!schema || typeof schema !== "object") return null;
	if (Array.isArray(schema.anyOf)) {
		const failures = schema.anyOf.map((branch) => checkValue(branch, value, where));
		return failures.some((failure) => failure === null) ? null : `${where} ${describeExpected(schema)}, got ${describeValue(value)}.`;
	}
	const types = schema.type === undefined ? [] : [].concat(schema.type);
	if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
		const options = schema.enum ? ` (one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")})` : "";
		return `${where} must be ${types.map(article).join(" or ")}${options}, got ${describeValue(value)}.`;
	}
	if (schema.enum && !schema.enum.includes(value)) {
		return `${where} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}, got ${describeValue(value)}.`;
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) return `${where} must be at least ${schema.minimum}, got ${value}.`;
		if (schema.maximum !== undefined && value > schema.maximum) return `${where} must be at most ${schema.maximum}, got ${value}.`;
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			return `${where} needs at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}.`;
		}
		if (schema.items) {
			for (let index = 0; index < value.length; index++) {
				const problem = checkValue(schema.items, value[index], `${where}[${index}]`);
				if (problem) return problem;
			}
		}
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const properties = schema.properties ?? {};
		for (const key of schema.required ?? []) {
			if (value[key] === undefined || value[key] === null) return `${where}.${key} is required.`;
		}
		for (const [key, child] of Object.entries(value)) {
			if (key in properties) {
				if (child === null && !(schema.required ?? []).includes(key) && !allowsNull(properties[key])) continue;
				const problem = checkValue(properties[key], child, `${where}.${key}`);
				if (problem) return problem;
			} else if (schema.additionalProperties === false) {
				const known = Object.keys(properties);
				const near = closest(key, known);
				return `${where} has no field "${key}"${near ? ` — did you mean "${near}"?` : ""} Fields: ${known.join(", ")}.`;
			} else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
				const problem = checkValue(schema.additionalProperties, child, `${where}.${key}`);
				if (problem) return problem;
			}
		}
	}
	return null;
}

/** Drop optional properties sent as null, at every level the schema describes. */
function stripNulls(schema, value) {
	if (Array.isArray(value)) return schema?.items ? value.map((item) => stripNulls(schema.items, item)) : value;
	if (!value || typeof value !== "object" || !schema?.properties) return value;
	const out = {};
	for (const [key, child] of Object.entries(value)) {
		if (child === null && key in schema.properties && !allowsNull(schema.properties[key])) continue;
		out[key] = key in schema.properties ? stripNulls(schema.properties[key], child) : child;
	}
	return out;
}

function allowsNull(schema) {
	return [].concat(schema?.type ?? []).includes("null");
}

function matchesType(type, value) {
	if (type === "integer") return Number.isInteger(value);
	if (type === "number") return typeof value === "number" && Number.isFinite(value);
	if (type === "array") return Array.isArray(value);
	if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
	if (type === "null") return value === null;
	return typeof value === type;
}

function article(type) {
	return { integer: "an integer", object: "an object", array: "an array" }[type] ?? `a ${type}`;
}

function describeExpected(schema) {
	const kinds = schema.anyOf.map((branch) => [].concat(branch.type ?? "value").map(article).join(" or "));
	return `must be ${kinds.join(" or ")}`;
}

function describeValue(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "string") return value.length > 40 ? `a string ("${value.slice(0, 40)}…")` : `"${value}"`;
	if (typeof value === "object") return "an object";
	return `${typeof value} ${String(value)}`;
}

/** The known name a typo most likely meant, if any is close. */
function closest(name, known) {
	let best = null;
	let bestDistance = Math.max(2, Math.floor(name.length / 3)) + 1;
	for (const candidate of known) {
		const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best;
}

function editDistance(a, b) {
	const row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const current = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
			previous = current;
		}
	}
	return row[b.length];
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
 * @param {AgentLink} [options.agent] The agent as the host session reports it; attached by
 *   `extension.mjs` once `joinSession` resolves. Unattached, asks wait for the agent's next call.
 * @param {boolean} [options.timers] Run the idle-digest check on a timer. Default true.
 */
export function createDrawioCanvas({ createCanvas, CanvasError }, { extensionDir, log = () => {}, drawio, prepare = true, agent = new AgentLink(), timers = true }) {
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
		if (server.editorsConnected() === 0) {
			report.editor = server.editorReachable()
				? "loading — the person has the canvas open and draw.io is starting"
				: "closed — the person has no draw.io tab open on this canvas";
		}
		const asks = entry.collab?.personReport();
		if (asks) Object.assign(report, asks);
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

	/** The current XML of these cells on a page, and which of them no longer exist. */
	function currentXml(page, ids) {
		const wanted = new Set(ids);
		const cells = page.drawable().filter((cell) => wanted.has(cellId(cell)));
		const found = new Set(cells.map(cellId));
		return { xml: cells.map((cell) => serializeXml(cell.node)).join("\n"), gone: ids.filter((id) => !found.has(id)) };
	}

	/**
	 * Refuse an agent edit that would overwrite what it has not seen, saying exactly what.
	 *
	 * When what it missed is small, the refusal carries it: the current XML goes in
	 * the message and counts as read, so the agent reapplies in its next call instead
	 * of spending a model turn on get_diagram. A model turn costs seconds; this
	 * costs a few hundred characters.
	 */
	function gate(session, page, operations) {
		const verdict = session.editGate(page, operations);
		if (verdict.ok) return;
		if (verdict.reason === "no-context") {
			const xml = page.drawable().map((cell) => serializeXml(cell.node)).join("\n");
			if (xml.length <= REFUSAL_XML_BUDGET) {
				session.markPageSeen(page);
				throw new CanvasError(
					"no_context",
					`Not applied: you had not read page "${page.name}", and editing by id without reading would overwrite work you cannot see. Here it is now; it counts as read, so resend your edit adjusted to it:\n${xml}`,
				);
			}
			throw new CanvasError(
				"no_context",
				`Call get_diagram for page "${page.name}" first: you have not read it, and editing by id without reading would overwrite work you cannot see.`,
			);
		}
		const lines = verdict.conflicts.flatMap((conflict) => conflict.changes.slice(-3)).slice(0, 12);
		const ids = verdict.conflicts.map((conflict) => conflict.cell_id);
		const lead = `Not applied: the person changed ${ids.length === 1 ? "a cell" : `${ids.length} cells`} you are editing since you last read ${ids.length === 1 ? "it" : "them"}:\n${lines.join("\n")}`;
		const now = currentXml(page, ids);
		if (now.xml.length <= REFUSAL_XML_BUDGET) {
			session.markCellsSeen(page, ids);
			const gone = now.gone.length ? `\nDeleted by the person: ${now.gone.join(", ")}.` : "";
			throw new CanvasError(
				"stale_cells",
				`${lead}\nWhat is there now (counts as read; build on it rather than over it, then resend):\n${now.xml}${gone}\nNothing in this batch was applied.`,
			);
		}
		throw new CanvasError(
			"stale_cells",
			`${lead}\nCall get_diagram with cell_ids ${JSON.stringify(ids)} and reapply your edit on top of what is there now. Nothing in this batch was applied.`,
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

	/**
	 * Every action takes an object. Some models, shown an untyped `input`, send it
	 * JSON-encoded as a string; decode that here so it does not reach a handler as
	 * a string and surface as "operations is not iterable".
	 */
	function inputOf(action, input) {
		if (typeof input === "string") {
			const text = input.trim();
			if (text.startsWith("{") || text.startsWith("[")) {
				try {
					input = JSON.parse(text);
				} catch (cause) {
					throw new CanvasError("invalid_input", `${action.name}: input is a string that is not valid JSON (${cause.message}). Pass input as an object.`);
				}
			}
		}
		if (input === undefined || input === null) input = {};
		const problem = checkValue(action.inputSchema ?? { type: "object" }, input, "input");
		if (problem) throw new CanvasError("invalid_input", `${action.name}: ${problem}`);
		return stripNulls(action.inputSchema ?? {}, input);
	}

	const guard = (action) => ({
		...action,
		handler: async (ctx) => {
			try {
				const input = inputOf(action, ctx.input);
				return await action.handler(input === ctx.input ? ctx : { ...ctx, input });
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
				// Asked-for ids that are not there, said out loud: an empty result would
				// otherwise read as "that cell is empty".
				const found = new Set(cells.map(cellId));
				const missing = ids ? [...ids].filter((id) => !found.has(id)) : [];
				const xml = cells.map((cell) => serializeXml(cell.node)).join("\n");
				const common = {
					version: session.version,
					page: summarizePage(page),
					pages: session.document.pages().map(summarizePage),
					layers: layersOf(page),
					file: session.filePath ?? null,
					issues: issuesFor(session),
					...(missing.length ? { missing: `Not on page "${page.name}": ${missing.join(", ")}. They may have been deleted, or be on another page.` } : {}),
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
				"Add, update or delete cells on one page by id, in order; each operation carries the complete <mxCell> for its cell. An operation that fails (unknown id, bad XML, missing parent) is listed in errors and the others still apply, so do not resend the ones that worked. The whole batch is refused only if the person changed a cell you update or delete since you read it; that refusal includes the cell as it is now and counts as reading it, so build on it and resend.",
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
				entry.collab.touched(page.id, result.applied.map((applied) => applied.cell_id));
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
				entry.collab.touched(page.id, result.applied.map((applied) => applied.cell_id));
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
				"See the diagram as draw.io renders it (real AWS/Azure/GCP icons, stencils, labels): writes a PNG into the workspace and returns its path — read that file to look at it. scope: page (default), viewport (what the person sees), selection (what they selected) or cells. With no draw.io tab open it writes an approximate SVG instead, and says so.",
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
				// A tab still booting draw.io is worth waiting for: its render is the real one.
				if (server.editorReachable()) {
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
				`Run one of draw.io's automatic layouts in the person's editor, as Arrange > Layout does, animated so they see what moved (about 0.2 s): a preset (${LAYOUT_PRESETS.map((name) => `"${name}"`).join(", ")}) or draw.io's layout JSON, e.g. [{"layout":"mxHierarchicalLayout","config":{"orientation":"west"}}] with layout one of ${LAYOUT_NAMES.join(", ")}. Moved cells come back as your edit; re-read them before editing them.`,
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
				const layout = layoutSpec(ctx.input.layout);
				const before = session.version;
				// The page sends the moves before it answers, so they are here already.
				await server.requestEditor("layout", { page_id: page.id, layout, cell_ids: ctx.input.cell_ids }, { timeoutMs: 25_000 });
				const moved = session.changesSince(before, { sources: [SOURCE_AGENT], limit: 30 });
				return { version: session.version, changes: moved.lines, ...(moved.truncated ? { more: moved.total - moved.lines.length } : {}), person: personReport(entry) };
			},
		},
		{
			name: "tidy",
			description:
				"Tidy shapes without computing geometry yourself: grow shapes to fit their labels, snap to the grid, line up near-aligned centres, push overlapping shapes apart, and drop stale bends from edges whose shapes moved. Instant and deterministic. cell_ids limits what may move (the rest of the page stays put); steps turns parts off. Prefer this to hand-placing after adding shapes.",
			inputSchema: {
				type: "object",
				properties: {
					...PAGE_SELECTOR_SCHEMA,
					cell_ids: { type: "array", items: { type: "string" }, description: "Only these may move. Default: every shape on the page." },
					steps: {
						type: "object",
						properties: {
							fit: { type: "boolean" },
							snap: { type: "boolean" },
							align: { type: "boolean" },
							overlap: { type: "boolean" },
							waypoints: { type: "boolean" },
						},
						additionalProperties: false,
						description: "All true by default.",
					},
				},
				additionalProperties: false,
			},
			handler: (ctx) => {
				const entry = instanceOf(ctx);
				const { session } = entry;
				const page = pageOf(session, ctx.input ?? {});
				const result = tidyPage(page, { scope: ctx.input?.cell_ids, steps: ctx.input?.steps });
				const touched = [...result.changes.map((change) => change.id), ...result.clearPoints];
				if (touched.length > 0) {
					session.commit(SOURCE_AGENT, [], `tidied: ${describeTidy(result.summary)}`);
					entry.collab.touched(page.id, touched);
				}
				return { version: session.version, done: describeTidy(result.summary), changed: touched.length, ...result.summary, person: personReport(entry) };
			},
		},
		{
			name: "get_asks",
			description:
				"What the person asked you for from the canvas, top priority first: each ask's text, status and the cells it is about, with their current XML (counts as read, so edit them directly). Do the top one first and keep to its cells.",
			inputSchema: {
				type: "object",
				properties: { include_done: { type: "boolean", description: "Also list finished and dismissed asks. Default false." } },
				additionalProperties: false,
			},
			handler: (ctx) => {
				const entry = instanceOf(ctx);
				const asks = entry.collab.getAsks({ include_done: ctx.input?.include_done });
				return { asks, ...(asks.length === 0 ? { note: "No open asks." } : {}), person: personReport(entry) };
			},
		},
		{
			name: "update_ask",
			description: "Mark one of the person's asks: working when you start it, done or declined when you finish, with a one-line reply they read in the canvas.",
			inputSchema: {
				type: "object",
				properties: {
					id: { type: "integer", minimum: 1, description: "The ask's number, from get_asks." },
					status: { type: "string", enum: ["working", "done", "declined"] },
					reply: { type: "string", description: "One line for the person, e.g. \"Moved the cache next to the API and rerouted both edges.\"" },
				},
				required: ["id"],
				additionalProperties: false,
			},
			handler: (ctx) => {
				const entry = instanceOf(ctx);
				try {
					const ask = entry.collab.updateAsk(ctx.input);
					return { id: ask.id, status: ask.status, reply: ask.reply, open_asks: entry.collab.board.active().length };
				} catch (cause) {
					throw new CanvasError(cause.code ?? "invalid_input", cause.message);
				}
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
				const { xml, inflatedPages } = await readDiagramFile(absolute, { shown: ctx.input.path });
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
				const editor = server.editorReachable();
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
			"A draw.io diagram you and the person edit at the same time: they use the full draw.io editor in their browser, you use these actions. " +
			"Loop: get_diagram, then edit_diagram by cell id (whole <mxCell> per cell; many operations in one call). Every result reports what the person changed meanwhile and where they are looking; build on their work, never over it. " +
			"Speed (measured): reads and edits take about 1 ms (a 300-cell batch about 50 ms) and show in their editor within about 30 ms; their edits reach get_changes within about 20 ms. search_shapes under 10 ms (the first about 80 ms). screenshot, focus and .png/.svg export go through their open draw.io tab in 10-60 ms, layout about 0.2 s; with no tab open, focus, layout and .png fail with no_editor. So prefer one call with many operations over many calls, and do not wait between them. " +
			"A stale_cells or no_context refusal includes the current XML and counts as a read: adjust and resend, no get_diagram needed. " +
			"The person can ask you for things from the canvas; they arrive as a [canvas drawio-canvas] message or as new_asks in a result. Call get_asks, do the top ask first within its cells, and mark it with update_ask (working, then done with a one-line reply). \"This\" or \"these\" in their message means the cells in person.looking_at.selected.",
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
			const session = new DiagramSession({ workspace });
			if (prepare) provider.ensure({ network: false }).catch(() => {});

			// A reload re-opens this instance in a new process (see `writeSnapshot`).
			const parked = await takeSnapshot(ctx.instanceId);
			void sweepSnapshots();
			// A reload keeps the token (and, below, the port), so the person's tab
			// stays on a working URL.
			const token = typeof parked?.token === "string" && parked.token.length >= 32 ? parked.token : randomBytes(32).toString("base64url");

			if (parked?.xml) {
				session.replace(parked.xml, { source: SOURCE_AGENT, label: "restored after a reload", seen: false });
				session.filePath = parked.filePath ?? undefined;
			} else if (ctx.input?.xml) {
				session.replace(ctx.input.xml, { source: SOURCE_AGENT, label: "opened with supplied XML", seen: false });
			} else if (ctx.input?.file) {
				const absolute = resolveInWorkspace(workspace, ctx.input.file);
				const { xml } = await readDiagramFile(absolute, { shown: ctx.input.file });
				session.replace(xml, { source: SOURCE_AGENT, label: `opened ${ctx.input.file}`, seen: false });
				session.filePath = ctx.input.file;
			}
			// A blank canvas is marked seen so the agent can draw the first shape
			// without a pointless read of an empty page; one opened *with* content is
			// not, because the agent has not read it.
			if (!parked?.xml && !ctx.input?.xml && !ctx.input?.file) session.markSeen();
			session.agentToldVersion = session.version;

			const server = await startInstanceServer({
				session,
				token,
				extensionDir,
				drawio: provider,
				log: (message) => log(`${ctx.instanceId}: ${message}`),
				port: Number.isInteger(parked?.port) ? parked.port : 0,
			});
			const safeId = String(ctx.instanceId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "instance";
			const entry = { session, server, token, stateDir: workspace ? path.join(workspace, STATE_DIR, safeId) : null };
			entry.collab = new Collaboration({
				instanceId: ctx.instanceId,
				session,
				agent,
				editorOpen: () => server.editorsConnected() > 0,
				prefs: { read: () => readPrefs(provider.env), write: (values) => writePrefs(values, provider.env) },
				log: (message) => log(`${ctx.instanceId}: ${message}`),
				timers,
			});
			if (Array.isArray(parked?.asks)) entry.collab.board.restore(parked.asks);
			server.setCollab(entry.collab);
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
					// This line is fixed at open and shown to the agent for the life of the
					// instance, so a transient state ("installing") would read as permanent.
					// Only a failure is worth freezing here; get_diagram reports the editor live.
					status.state === "failed" ? `draw.io ${PINNED.version}: failed to prepare (${status.error})` : `draw.io ${status.version ?? PINNED.version}`,
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
			entry.collab?.close();
			clearTimeout(entry.manifestTimer);
			entry.unsubscribe?.();
			// Park the document before letting go: a close is also what a reload sends
			// to the outgoing process, and the incoming one reads this back.
			// Always parked, even a blank page: the port, token and asks are what keep
			// the person's tab and their requests across a reload.
			const hasContent = entry.session.document.pages().some((page) => !page.compressed && page.drawable().length > 0) || entry.session.filePath;
			await writeSnapshot(ctx.instanceId, {
				xml: hasContent ? entry.session.document.toXml() : null,
				filePath: entry.session.filePath,
				port: entry.server.port,
				token: entry.token,
				asks: entry.collab?.board.list(),
			});
			if (entry.stateDir) await rm(entry.stateDir, { recursive: true, force: true }).catch(() => {});
			await entry.server.close();
		},
	};

	return createCanvas({ ...canvas, actions: canvas.actions.map(guard) });
}

