/**
 * The person's edits, arriving from draw.io, applied to the shared document.
 *
 * The page does not send its whole document. draw.io computes a diff between
 * what the page last synced and what it holds now — the same diff draw.io uses
 * for its own real-time collaboration — and the page turns it into the small
 * list of changes below, one per page or cell it touched:
 *
 *   { kind: "page-insert", page_id, xml, after }     a new <diagram>, placed after a page ('' = first)
 *   { kind: "page-remove", page_id }
 *   { kind: "page-update", page_id, name?, after?, model? }   rename, reorder, page settings
 *   { kind: "cell-upsert", page_id, cell_id, xml, after? }    the cell as draw.io encodes it
 *   { kind: "cell-remove", page_id, cell_id }
 *   { kind: "cell-order", page_id, parent, children }         a parent's children, in the editor's order
 *
 * Sending only what was touched is what makes concurrent editing safe. The
 * agent may have changed other cells a moment ago, in a version the page has
 * not merged yet; a whole-document write would silently revert them. A cell the
 * person did not touch is never in the list, so it is never overwritten.
 *
 * `after` is draw.io's `previous`: the id of the sibling this cell now follows
 * inside its parent, or '' when it is the first child. It places a new cell.
 *
 * Z-order is sent whole. When the order of a parent's children changed ("bring
 * to front", grouping, a move to another layer), the page also sends that
 * parent's complete child list, and it is applied as a permutation of the
 * slots those cells occupy: a cell the agent added a moment ago, which the
 * page has not seen yet, keeps its slot. Per-cell "previous sibling" pointers
 * alone are ambiguous once the two sides interleave inserts and reorders — a
 * randomized concurrent-editing test found exactly that — while a list is not.
 */

import { cellId, DiagramError, DEFAULT_LAYER_ID } from "./model.mjs";
import { childElements, findElement, parseXml } from "./xml.mjs";

function innerCell(node) {
	return node.name === "mxCell" ? node : findElement(node, "mxCell");
}

function nodeId(node) {
	return node.attrs.id ?? innerCell(node)?.attrs.id ?? "";
}

/**
 * The index in `root.children` just past `id`'s subtree.
 *
 * draw.io writes a page depth-first — a container, then its children — so a
 * subtree is a contiguous run starting at the container. Placing a cell "after
 * sibling X" therefore means after X *and everything inside X*.
 */
function afterSubtree(root, id) {
	const nodes = root.children;
	const start = nodes.findIndex((child) => child.type === "element" && nodeId(child) === id);
	if (start === -1) return -1;
	const inside = new Set([id]);
	let end = start;
	for (let index = start + 1; index < nodes.length; index += 1) {
		const child = nodes[index];
		if (child.type !== "element") continue;
		const parent = innerCell(child)?.attrs.parent;
		if (!parent || !inside.has(parent)) break;
		inside.add(nodeId(child));
		end = index;
	}
	return end + 1;
}

/** Put `node` into `root` at the position draw.io's `previous` describes. */
function place(root, node, parent, after) {
	const existing = root.children.indexOf(node);
	if (existing !== -1) root.children.splice(existing, 1);
	let index = -1;
	if (after) index = afterSubtree(root, after);
	if (index === -1 && after === "") {
		// First child of its parent: straight after the parent itself.
		const parentIndex = root.children.findIndex((child) => child.type === "element" && nodeId(child) === parent);
		if (parentIndex !== -1) index = parentIndex + 1;
	}
	if (index === -1 && parent) {
		// Unknown sibling: last child of the parent, which is where draw.io puts
		// a cell it cannot place either.
		index = afterSubtree(root, parent);
	}
	if (index === -1) index = root.children.length;
	root.children.splice(index, 0, node);
}

function parseCell(xml, id) {
	const node = parseXml(String(xml ?? "").trim()).root;
	if (!["mxCell", "UserObject", "object"].includes(node.name)) {
		throw new DiagramError("not_a_cell", `Cell "${id}" arrived as <${node.name}>.`);
	}
	const inner = innerCell(node);
	if (!inner) throw new DiagramError("not_a_cell", `Cell "${id}" has no <mxCell>.`);
	if (findElement({ children: inner.children }, "mxCell")) {
		throw new DiagramError("nested_cell", `Cell "${id}" nests another mxCell.`);
	}
	// The id lives on the wrapper when there is one, the way draw.io writes it.
	if (node !== inner) {
		node.attrs = { ...node.attrs, id };
		delete inner.attrs.id;
	} else {
		node.attrs = { id, ...node.attrs };
		node.attrs.id = id;
	}
	return node;
}

function applyPageChange(doc, change) {
	const root = doc.root;
	const diagrams = () => childElements(root, "diagram");
	const find = (id) => diagrams().find((diagram) => diagram.attrs.id === id);
	const placePage = (diagram, after) => {
		const current = root.children.indexOf(diagram);
		if (current !== -1) root.children.splice(current, 1);
		if (after) {
			const previous = find(after);
			if (previous) {
				root.children.splice(root.children.indexOf(previous) + 1, 0, diagram);
				return;
			}
		}
		if (after === "") {
			const first = diagrams()[0];
			root.children.splice(first ? root.children.indexOf(first) : root.children.length, 0, diagram);
			return;
		}
		root.children.push(diagram);
	};

	if (change.kind === "page-insert") {
		const diagram = parseXml(String(change.xml ?? "")).root;
		if (diagram.name !== "diagram") throw new DiagramError("not_a_page", `Page "${change.page_id}" arrived as <${diagram.name}>.`);
		diagram.attrs.id = change.page_id;
		const existing = find(change.page_id);
		if (existing) root.children.splice(root.children.indexOf(existing), 1);
		placePage(diagram, change.after ?? null);
		return;
	}
	const diagram = find(change.page_id);
	if (!diagram) throw new DiagramError("page_not_found", `No page "${change.page_id}".`);
	if (change.kind === "page-remove") {
		if (diagrams().length <= 1) throw new DiagramError("last_page", "A document must keep at least one page.");
		root.children.splice(root.children.indexOf(diagram), 1);
		return;
	}
	if (change.kind === "page-update") {
		if (typeof change.name === "string") diagram.attrs.name = change.name;
		if (change.after !== undefined && change.after !== null) placePage(diagram, change.after);
		if (change.model && typeof change.model === "object") {
			const model = findElement(diagram, "mxGraphModel");
			if (model) {
				for (const [key, value] of Object.entries(change.model)) {
					if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) continue;
					if (value === null || value === undefined) delete model.attrs[key];
					else model.attrs[key] = String(value);
				}
			}
		}
		return;
	}
	throw new DiagramError("unknown_change", `Unknown change kind "${change.kind}".`);
}

/**
 * Reorder `parent`'s children to follow `children`, leaving cells not in the
 * list in their slots. Each child moves with its whole subtree, and the
 * parent's descendants end up contiguous after it, depth-first, the way draw.io
 * writes a page.
 */
function reorderChildren(page, parent, children) {
	const root = page.root;
	const nodes = root.children.filter((child) => child.type === "element");
	const parentOf = new Map(nodes.map((node) => [nodeId(node), innerCell(node)?.attrs.parent]));
	const siblings = nodes.filter((node) => parentOf.get(nodeId(node)) === parent).map(nodeId);
	const wanted = children.map(String).filter((id) => parentOf.get(id) === parent);
	const known = new Set(wanted);
	const queue = [...wanted];
	const order = siblings.map((id) => (known.has(id) ? queue.shift() : id));
	if (order.every((id, index) => id === siblings[index])) return;
	// Which child of `parent` each node belongs under, by walking up its parents.
	const topOf = (id) => {
		let current = id;
		for (let guard = 0; guard < 10_000 && current; guard += 1) {
			const up = parentOf.get(current);
			if (up === parent) return current;
			current = up;
		}
		return null;
	};
	const blocks = new Map(order.map((id) => [id, []]));
	for (const node of nodes) {
		const top = topOf(nodeId(node));
		if (top && blocks.has(top)) blocks.get(top).push(node);
	}
	const moving = new Set([...blocks.values()].flat());
	const kept = root.children.filter((child) => !moving.has(child));
	const anchor = kept.findIndex((child) => child.type === "element" && nodeId(child) === parent);
	const at = anchor === -1 ? kept.length : anchor + 1;
	root.children = [...kept.slice(0, at), ...order.flatMap((id) => blocks.get(id)), ...kept.slice(at)];
}

function applyCellChange(doc, change) {
	const page = doc.page({ page_id: change.page_id });
	if (!page) throw new DiagramError("page_not_found", `No page "${change.page_id}".`);
	if (page.compressed) throw new DiagramError("compressed_page", `Page "${page.name}" is compressed.`);
	const root = page.root;
	const id = String(change.cell_id ?? "");
	if (!id && change.kind !== "cell-order") throw new DiagramError("missing_id", "A cell change needs a cell_id.");
	if (change.kind === "cell-order") {
		reorderChildren(page, String(change.parent ?? ""), Array.isArray(change.children) ? change.children : []);
		return true;
	}
	const existing = page.find(id);

	if (change.kind === "cell-remove") {
		if (!existing) return false;
		// draw.io lists every removed descendant itself, so this removes exactly
		// one node. Edges left attached are the editor's business: if it kept
		// them, their own update is in the same batch.
		root.children.splice(root.children.indexOf(existing.node), 1);
		return true;
	}
	if (change.kind !== "cell-upsert") throw new DiagramError("unknown_change", `Unknown change kind "${change.kind}".`);
	const node = parseCell(change.xml, id);
	const parent = innerCell(node).attrs.parent ?? (id === "0" ? undefined : DEFAULT_LAYER_ID);
	if (existing) {
		root.children[root.children.indexOf(existing.node)] = node;
		if (change.after !== undefined && change.after !== null) place(root, node, parent, change.after);
	} else {
		place(root, node, parent, change.after ?? null);
	}
	return true;
}

/**
 * Apply the page's changes, in order, reporting failures per change.
 *
 * Inserts are applied before updates so that a group created in the same edit
 * exists before its new children are moved into it — draw.io emits a grouping
 * as "insert the group, reparent the children", and the order it lists them in
 * is not guaranteed to match.
 */
export function applyEditorChanges(doc, changes) {
	const errors = [];
	let applied = 0;
	const rank = (change) =>
		({ "page-insert": 0, "page-update": 1, "cell-upsert": 2, "cell-remove": 3, "cell-order": 4, "page-remove": 5 })[change.kind] ?? 6;
	const ordered = [...(Array.isArray(changes) ? changes : [])]
		.map((change, index) => ({ change, index }))
		.sort((a, b) => rank(a.change) - rank(b.change) || a.index - b.index)
		.map((item) => item.change);
	// New cells first in the order draw.io listed them (parents before children),
	// then updates; within cell-upserts, draw.io's own order is kept.
	const inserts = ordered.filter((change) => change.kind === "cell-upsert" && change.inserted);
	const rest = ordered.filter((change) => !(change.kind === "cell-upsert" && change.inserted));
	const sequence = [...rest.filter((change) => rank(change) < 2), ...inserts, ...rest.filter((change) => rank(change) >= 2)];
	for (const change of sequence) {
		try {
			if (change.kind.startsWith("page-")) applyPageChange(doc, change);
			else applyCellChange(doc, change);
			applied += 1;
		} catch (cause) {
			errors.push({ kind: change.kind, page_id: change.page_id, cell_id: change.cell_id, message: cause.message });
		}
	}
	return { applied, errors };
}

export { cellId };
