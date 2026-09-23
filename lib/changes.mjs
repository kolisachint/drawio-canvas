/**
 * What changed between two versions of a document, said the way a collaborator
 * would say it.
 *
 * Two readers need this. The agent works in turns and cannot watch the person
 * draw, so at the start of every turn it needs to be *told* what happened while
 * it was away — "moved 'API Gateway' to (320, 140)", not a 40 KB XML dump it has
 * to diff in its head. And the edit gate needs to know which cells changed and
 * who changed them, so it can refuse only the agent edits that would overwrite
 * something the agent has not seen, and let every other edit through.
 *
 * The diff is structural, per page and per cell id, on the parsed documents both
 * sides already share. It never looks at bytes: draw.io rewrites attribute order
 * and viewport attributes on every save, and none of that is a change anyone
 * made.
 */

import { cellGeometry, cellId, cellLabel, isEdge, isVertex } from "./model.mjs";
import { parseStyle } from "./style.mjs";
import { serializeXml } from "./xml.mjs";

/** Longest label quoted in a change line; the id is always there to fetch the rest. */
const LABEL_CHARS = 40;

/** A label as plain text: draw.io labels are frequently HTML. */
export function plainLabel(raw) {
	return String(raw ?? "")
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

function quote(label) {
	const text = plainLabel(label);
	if (text.length === 0) return "";
	return JSON.stringify(text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1)}…` : text);
}

/** The shape a style names, in draw.io's own vocabulary (`mxgraph.aws4.lambda`, `ellipse`, …). */
export function shapeName(style) {
	const parsed = parseStyle(style);
	if (parsed.keys.resIcon) return parsed.keys.resIcon;
	if (parsed.keys.prIcon) return parsed.keys.prIcon;
	if (parsed.keys.shape) return parsed.keys.shape;
	if (parsed.keys.image && (parsed.bare.includes("image") || parsed.keys.shape === "image")) {
		return `image:${parsed.keys.image.startsWith("data:") ? "embedded" : parsed.keys.image.split("/").slice(-2).join("/")}`;
	}
	const bare = parsed.bare.find((token) => token !== "html" && token !== "group");
	if (bare) return bare;
	return parsed.keys.rounded === "1" ? "rounded" : "rectangle";
}

/** One cell, summarized for a person or a model to read. */
export function cellInfo(entry) {
	const kind = isEdge(entry) ? "edge" : isVertex(entry) ? "shape" : entry.cell.attrs.parent === "0" ? "layer" : "cell";
	const info = { id: cellId(entry), kind };
	const label = plainLabel(cellLabel(entry));
	if (label) info.label = label.length > 120 ? `${label.slice(0, 119)}…` : label;
	if (kind === "shape" || kind === "edge") info.shape = kind === "edge" ? "edge" : shapeName(entry.cell.attrs.style);
	if (entry.cell.attrs.parent && entry.cell.attrs.parent !== "1") info.parent = entry.cell.attrs.parent;
	if (kind === "shape") {
		const geometry = cellGeometry(entry);
		Object.assign(info, { x: geometry.x, y: geometry.y, w: geometry.width, h: geometry.height });
	}
	if (kind === "edge") {
		if (entry.cell.attrs.source) info.source = entry.cell.attrs.source;
		if (entry.cell.attrs.target) info.target = entry.cell.attrs.target;
	}
	if (entry.cell.attrs.visible === "0") info.hidden = true;
	if (parseStyle(entry.cell.attrs.style).keys.locked === "1") info.locked = true;
	return info;
}

/** Keys that differ between two style strings. */
function styleDelta(before, after) {
	const a = parseStyle(before);
	const b = parseStyle(after);
	const keys = new Set([...Object.keys(a.keys), ...Object.keys(b.keys)]);
	const changed = [...keys].filter((key) => a.keys[key] !== b.keys[key]);
	if (a.bare.join(";") !== b.bare.join(";")) changed.unshift("shape");
	return changed;
}

/** How one cell changed, as short phrases. Empty when only invisible bytes moved. */
export function describeUpdate(before, after) {
	const details = [];
	const a = cellInfo(before);
	const b = cellInfo(after);
	if ((a.label ?? "") !== (b.label ?? "")) details.push(`relabelled ${quote(a.label) || "(empty)"} → ${quote(b.label) || "(empty)"}`);
	if (b.kind === "shape" && (a.x !== b.x || a.y !== b.y)) details.push(`moved to (${b.x}, ${b.y})`);
	if (b.kind === "shape" && (a.w !== b.w || a.h !== b.h)) details.push(`resized to ${b.w}×${b.h}`);
	if (a.source !== b.source || a.target !== b.target) details.push(`reconnected ${b.source ?? "·"} → ${b.target ?? "·"}`);
	if ((a.parent ?? "1") !== (b.parent ?? "1")) details.push(`moved into ${b.parent ?? "layer 1"}`);
	if (Boolean(a.hidden) !== Boolean(b.hidden)) details.push(b.hidden ? "hidden" : "shown");
	const style = styleDelta(before.cell.attrs.style, after.cell.attrs.style).filter((key) => key !== "locked");
	if (style.length > 0) details.push(`restyled ${style.slice(0, 6).join(", ")}${style.length > 6 ? ", …" : ""}`);
	if (Boolean(a.locked) !== Boolean(b.locked)) details.push(b.locked ? "locked" : "unlocked");
	if (b.kind === "edge" && details.length === 0) {
		const geometryChanged = serializeXml(before.cell) !== serializeXml(after.cell);
		if (geometryChanged) details.push("rerouted");
	}
	if (details.length === 0 && serializeXml(before.node) !== serializeXml(after.node)) details.push("edited data");
	return details;
}

function indexCells(page) {
	const cells = new Map();
	if (page.compressed) return cells;
	for (const entry of page.cells()) cells.set(cellId(entry), entry);
	return cells;
}

/**
 * Diff two documents by page id and cell id.
 *
 * Returns `{ pages, cells }`. `pages` lists pages added, removed and renamed;
 * `cells` lists every cell added, removed or changed, each with the page it is
 * on, a summary and — for a change — what changed about it. Sentinel cells
 * (`0`, and a layer's own bookkeeping) are included only when they change,
 * which is how layer renames and visibility show up.
 */
export function diffDocuments(before, after) {
	const pages = { added: [], removed: [], renamed: [] };
	const cells = [];
	const beforePages = new Map(before ? before.pages().map((page) => [page.id, page]) : []);
	for (const page of after.pages()) {
		const old = beforePages.get(page.id);
		beforePages.delete(page.id);
		if (!old) {
			pages.added.push({ id: page.id, name: page.name });
			for (const entry of page.compressed ? [] : page.drawable()) {
				cells.push({ page_id: page.id, page: page.name, id: cellId(entry), change: "added", info: cellInfo(entry) });
			}
			continue;
		}
		if (old.name !== page.name) pages.renamed.push({ id: page.id, from: old.name, to: page.name });
		const was = indexCells(old);
		for (const [id, entry] of indexCells(page)) {
			const previous = was.get(id);
			was.delete(id);
			if (id === "0") continue;
			if (!previous) {
				cells.push({ page_id: page.id, page: page.name, id, change: "added", info: cellInfo(entry) });
				continue;
			}
			if (serializeXml(previous.node) === serializeXml(entry.node)) continue;
			const details = describeUpdate(previous, entry);
			if (details.length > 0) cells.push({ page_id: page.id, page: page.name, id, change: "updated", info: cellInfo(entry), details });
		}
		for (const [id, entry] of was) {
			if (id === "0") continue;
			cells.push({ page_id: page.id, page: page.name, id, change: "removed", info: cellInfo(entry) });
		}
	}
	for (const page of beforePages.values()) pages.removed.push({ id: page.id, name: page.name });
	return { pages, cells };
}

/** One change as one line — what the agent reads. */
export function formatCellChange(change) {
	const what = change.info.kind === "edge" ? "edge" : change.info.kind === "layer" ? "layer" : change.info.shape && change.info.shape !== "rectangle" ? change.info.shape : "shape";
	const label = quote(change.info.label);
	const name = `${what}${label ? ` ${label}` : ""} [${change.id}]`;
	if (change.change === "added") {
		const at = change.info.kind === "shape" ? ` at (${change.info.x}, ${change.info.y})` : change.info.kind === "edge" ? ` ${change.info.source ?? "·"} → ${change.info.target ?? "·"}` : "";
		return `added ${name}${at}`;
	}
	if (change.change === "removed") return `removed ${name}`;
	return `${name}: ${change.details.join("; ")}`;
}

/** Page-level changes as lines. */
export function formatPageChanges(pages) {
	return [
		...pages.added.map((page) => `added page "${page.name}"`),
		...pages.removed.map((page) => `removed page "${page.name}"`),
		...pages.renamed.map((page) => `renamed page "${page.from}" → "${page.to}"`),
	];
}
