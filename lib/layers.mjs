/**
 * Layers, as the agent drives them.
 *
 * In mxGraph a layer is a cell whose parent is the model root (`0`); every
 * ordinary cell descends from one. draw.io's Layers panel (Ctrl+Shift+L) is a
 * view over exactly that, so everything here is plain cell surgery on the
 * shared document — the person's panel updates the moment it lands, and a layer
 * the person adds is one the agent sees on its next read.
 *
 * Visibility is the cell's `visible="0"`, lock is `locked=1` in its style,
 * order is the order of the layer cells (first is bottom), all as draw.io
 * writes them.
 */

import { cellId, DiagramError, randomId, ROOT_CELL_ID } from "./model.mjs";
import { plainLabel } from "./changes.mjs";
import { withStyleKey, parseStyle } from "./style.mjs";
import { element, findElement } from "./xml.mjs";

function inner(entry) {
	return entry.cell;
}

/** The page's layers, bottom first. */
export function layersOf(page) {
	const cells = page.cells();
	const byParent = new Map();
	for (const entry of cells) {
		const parent = inner(entry).attrs.parent;
		if (parent) byParent.set(parent, (byParent.get(parent) ?? 0) + 1);
	}
	// Count every descendant, not only direct children: a layer holding one group
	// of forty shapes has forty-one cells on it.
	const parentOf = new Map(cells.map((entry) => [cellId(entry), inner(entry).attrs.parent]));
	const layerOf = (id) => {
		let current = id;
		for (let guard = 0; guard < 1000; guard += 1) {
			const parent = parentOf.get(current);
			if (!parent) return null;
			if (parent === ROOT_CELL_ID) return current;
			current = parent;
		}
		return null;
	};
	const counts = new Map();
	for (const entry of cells) {
		const id = cellId(entry);
		if (parentOf.get(id) === ROOT_CELL_ID || id === ROOT_CELL_ID) continue;
		const layer = layerOf(id);
		if (layer) counts.set(layer, (counts.get(layer) ?? 0) + 1);
	}
	return cells
		.filter((entry) => inner(entry).attrs.parent === ROOT_CELL_ID)
		.map((entry, index) => {
			const id = cellId(entry);
			const style = parseStyle(inner(entry).attrs.style);
			return {
				id,
				name: plainLabel(entry.node.attrs.label ?? entry.node.attrs.value ?? inner(entry).attrs.value) || (index === 0 ? "Background" : `Layer ${index}`),
				index,
				visible: inner(entry).attrs.visible !== "0",
				locked: style.keys.locked === "1",
				cells: counts.get(id) ?? 0,
			};
		});
}

function layerEntry(page, selector) {
	const layers = layersOf(page);
	const match = selector.layer_id
		? layers.find((layer) => layer.id === selector.layer_id)
		: selector.layer_name
			? layers.find((layer) => layer.name === selector.layer_name)
			: null;
	if (!match) {
		throw new DiagramError(
			"layer_not_found",
			`No layer matches ${JSON.stringify(selector.layer_id ?? selector.layer_name ?? null)} on "${page.name}". Layers: ${layers.map((layer) => `${layer.id} "${layer.name}"`).join(", ")}.`,
		);
	}
	return { layer: match, entry: page.find(match.id) };
}

function setLabel(entry, name) {
	if (entry.node !== entry.cell) entry.node.attrs.label = name;
	else entry.cell.attrs.value = name;
}

/**
 * Run one layer command against a page. Mutates the document; the caller commits.
 *
 * Commands: list, add, rename, show, hide, lock, unlock, move_cells, reorder, delete.
 */
export function layerCommand(page, command) {
	const op = command.op;
	if (op === "list") return { layers: layersOf(page) };
	if (op === "add") {
		const id = command.layer_id ?? randomId(20);
		if (page.doc.allIds().has(id)) throw new DiagramError("duplicate_id", `Cell "${id}" already exists.`);
		page.root.children.push(element("mxCell", { id, value: command.name ?? `Layer ${layersOf(page).length}`, parent: ROOT_CELL_ID }, []));
		return { layer: layersOf(page).find((layer) => layer.id === id) };
	}
	const { layer, entry } = layerEntry(page, command);
	if (op === "rename") {
		if (!command.name) throw new DiagramError("missing_name", "rename needs a name.");
		setLabel(entry, command.name);
	} else if (op === "show" || op === "hide") {
		if (op === "hide") entry.cell.attrs.visible = "0";
		else delete entry.cell.attrs.visible;
	} else if (op === "lock" || op === "unlock") {
		const style = withStyleKey(entry.cell.attrs.style, "locked", op === "lock" ? "1" : null);
		if (style) entry.cell.attrs.style = style;
		else delete entry.cell.attrs.style;
	} else if (op === "move_cells") {
		const ids = new Set((command.cell_ids ?? []).map(String));
		if (ids.size === 0) throw new DiagramError("missing_cells", "move_cells needs cell_ids.");
		const missing = [...ids].filter((id) => !page.find(id));
		if (missing.length > 0) throw new DiagramError("unknown_cell", `No cells ${missing.join(", ")} on "${page.name}".`);
		// Only top-level cells change parent; a group's children travel with it.
		for (const id of ids) {
			const target = page.find(id);
			const parent = page.find(target.cell.attrs.parent ?? "");
			if (parent && parent.cell.attrs.parent !== ROOT_CELL_ID) continue;
			target.cell.attrs.parent = layer.id;
		}
	} else if (op === "reorder") {
		const layers = layersOf(page);
		const to = Math.max(0, Math.min(layers.length - 1, Number.parseInt(command.index, 10)));
		if (!Number.isFinite(to)) throw new DiagramError("missing_index", "reorder needs an index (0 = bottom).");
		// Layer cells are siblings under the root; the order of their nodes is the
		// stacking order, and each layer's cells follow their own layer node.
		const blocks = layers.map((item) => {
			const nodes = [];
			const inside = new Set([item.id]);
			for (const child of page.root.children) {
				if (child.type !== "element") continue;
				const cell = child.name === "mxCell" ? child : findElement(child, "mxCell");
				const id = child.attrs.id ?? cell?.attrs.id;
				if (id === item.id || (cell && inside.has(cell.attrs.parent))) {
					inside.add(id);
					nodes.push(child);
				}
			}
			return { id: item.id, nodes };
		});
		const moving = blocks.splice(layer.index, 1)[0];
		blocks.splice(to, 0, moving);
		const placed = new Set(blocks.flatMap((block) => block.nodes));
		const rest = page.root.children.filter((child) => !placed.has(child));
		page.root.children = [...rest, ...blocks.flatMap((block) => block.nodes)];
	} else if (op === "delete") {
		const layers = layersOf(page);
		if (layers.length <= 1) throw new DiagramError("last_layer", "A page must keep at least one layer.");
		if (layer.cells > 0 && !command.move_to_layer_id && !command.delete_cells) {
			throw new DiagramError("layer_not_empty", `Layer "${layer.name}" holds ${layer.cells} cell(s). Pass move_to_layer_id to keep them, or delete_cells: true.`);
		}
		const doomed = new Set([layer.id]);
		if (command.move_to_layer_id) {
			const destination = layers.find((item) => item.id === command.move_to_layer_id);
			if (!destination || destination.id === layer.id) throw new DiagramError("layer_not_found", `No other layer "${command.move_to_layer_id}".`);
			for (const child of page.cells()) if (child.cell.attrs.parent === layer.id) child.cell.attrs.parent = destination.id;
		} else {
			for (let grew = true; grew; ) {
				grew = false;
				for (const child of page.cells()) {
					const id = cellId(child);
					if (!doomed.has(id) && doomed.has(child.cell.attrs.parent)) {
						doomed.add(id);
						grew = true;
					}
				}
			}
		}
		page.root.children = page.root.children.filter((child) => {
			if (child.type !== "element") return true;
			const cell = child.name === "mxCell" ? child : findElement(child, "mxCell");
			return !doomed.has(child.attrs.id ?? cell?.attrs.id);
		});
	} else {
		throw new DiagramError("unknown_layer_op", `Unknown layer operation "${op}".`);
	}
	return { layers: layersOf(page) };
}
