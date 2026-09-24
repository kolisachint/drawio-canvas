/**
 * `tidy.mjs` on the canvas's own document, for the agent's `tidy` action.
 *
 * Separate from `tidy.mjs` so the browser can load the pure pass without the
 * document model. Labels are estimated here (the server cannot measure text);
 * the person's Tidy button measures with draw.io instead.
 */

import { cellGeometry, cellId, cellLabel, isEdge, isVertex, setCellGeometry } from "./model.mjs";
import { tidy } from "./tidy.mjs";
import { childElements } from "./xml.mjs";

/** The page's vertices and edges as the plain boxes `tidy` takes. */
export function pageBoxes(page) {
	const shapes = [];
	const edges = [];
	for (const entry of page.drawable()) {
		const geometry = cellGeometry(entry);
		if (isVertex(entry) && !geometry.relative && geometry.width > 0 && geometry.height > 0) {
			shapes.push({ id: cellId(entry), parent: entry.cell.attrs.parent ?? "1", x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height, label: cellLabel(entry), style: entry.cell.attrs.style ?? "" });
		} else if (isEdge(entry)) {
			edges.push({ id: cellId(entry), source: entry.cell.attrs.source, target: entry.cell.attrs.target, points: geometry.points.length });
		}
	}
	return { shapes, edges };
}

/**
 * Tidy a page in place. Returns what `tidy` decided; the caller commits.
 *
 * @param {import("./model.mjs").Page} page
 * @param {object} [options] `scope` (cell ids that may move) and `steps`.
 */
export function tidyPage(page, options = {}) {
	const { shapes, edges } = pageBoxes(page);
	const result = tidy(shapes, edges, options);
	const byId = new Map(page.drawable().map((entry) => [cellId(entry), entry]));
	for (const change of result.changes) {
		const entry = byId.get(change.id);
		if (entry) setCellGeometry(entry, { x: change.x, y: change.y, width: change.width, height: change.height });
	}
	for (const id of result.clearPoints) {
		const entry = byId.get(id);
		const geometry = entry && childElements(entry.cell, "mxGeometry").find((geo) => geo.attrs.as === "geometry");
		if (geometry) geometry.children = geometry.children.filter((child) => !(child.name === "Array" && child.attrs?.as === "points"));
	}
	return result;
}
