import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffDocuments, formatCellChange, plainLabel, shapeName } from "../lib/changes.mjs";
import { layerCommand, layersOf } from "../lib/layers.mjs";
import { cellId, DrawioDocument } from "../lib/model.mjs";
import { applyEditorChanges } from "../lib/sync.mjs";
import { SAMPLE_XML } from "./harness.mjs";

const order = (doc, parent = "1") =>
	doc
		.page()
		.cells()
		.filter((entry) => entry.cell.attrs.parent === parent)
		.map(cellId);

const box = (id, { parent = "1", label = id, x = 0 } = {}) =>
	`<mxCell id="${id}" value="${label}" style="rounded=1;" vertex="1" parent="${parent}"><mxGeometry x="${x}" y="0" width="80" height="40" as="geometry"/></mxCell>`;

describe("applying the person's draw.io edits", () => {
	it("inserts a cell where draw.io put it and updates one in place", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		const result = applyEditorChanges(doc, [
			{ kind: "cell-upsert", page_id: "p1", cell_id: "first", xml: box("first"), after: "", inserted: true },
			{ kind: "cell-upsert", page_id: "p1", cell_id: "start", xml: box("start", { label: "Begin", x: 300 }) },
		]);
		assert.deepEqual(result, { applied: 2, errors: [] });
		assert.deepEqual(order(doc), ["first", "start", "check", "link"]);
		assert.match(doc.page().find("start").cell.attrs.value, /Begin/);
	});

	it("applies a z-order change as the editor's list, keeping cells it has not seen in their slots", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		// The agent added "agent" a moment ago; the page, which has not merged it,
		// brings "start" to the front.
		applyEditorChanges(doc, [{ kind: "cell-upsert", page_id: "p1", cell_id: "agent", xml: box("agent"), inserted: true }]);
		assert.deepEqual(order(doc), ["start", "check", "link", "agent"]);
		applyEditorChanges(doc, [
			{ kind: "cell-upsert", page_id: "p1", cell_id: "start", xml: box("start"), after: "link" },
			{ kind: "cell-order", page_id: "p1", parent: "1", children: ["check", "link", "start"] },
		]);
		assert.deepEqual(order(doc), ["check", "link", "start", "agent"]);
	});

	it("moves a group's children with it and keeps the page depth-first", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		applyEditorChanges(doc, [
			{ kind: "cell-upsert", page_id: "p1", cell_id: "g", xml: '<mxCell id="g" value="" style="group" vertex="1" connectable="0" parent="1"><mxGeometry x="0" y="0" width="200" height="200" as="geometry"/></mxCell>', after: "link", inserted: true },
			{ kind: "cell-upsert", page_id: "p1", cell_id: "start", xml: box("start", { parent: "g" }), after: "" },
			{ kind: "cell-upsert", page_id: "p1", cell_id: "check", xml: box("check", { parent: "g" }), after: "start" },
			{ kind: "cell-order", page_id: "p1", parent: "1", children: ["link", "g"] },
			{ kind: "cell-order", page_id: "p1", parent: "g", children: ["start", "check"] },
		]);
		const ids = doc.page().cells().map(cellId);
		assert.deepEqual(ids, ["0", "1", "link", "g", "start", "check"]);
		applyEditorChanges(doc, [{ kind: "cell-order", page_id: "p1", parent: "1", children: ["g", "link"] }]);
		assert.deepEqual(doc.page().cells().map(cellId), ["0", "1", "g", "start", "check", "link"]);
	});

	it("keeps a UserObject's id on the wrapper, as draw.io writes it", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		applyEditorChanges(doc, [
			{
				kind: "cell-upsert",
				page_id: "p1",
				cell_id: "obj",
				xml: '<UserObject label="Service" owner="team-a" id="obj"><mxCell style="rounded=1;" vertex="1" parent="1"><mxGeometry width="80" height="40" as="geometry"/></mxCell></UserObject>',
				inserted: true,
			},
		]);
		const entry = doc.page().find("obj");
		assert.equal(entry.node.name, "UserObject");
		assert.equal(entry.node.attrs.owner, "team-a");
		assert.equal(entry.cell.attrs.id, undefined);
	});

	it("adds, renames, reorders and removes pages", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		applyEditorChanges(doc, [
			{ kind: "page-insert", page_id: "p2", after: "p1", xml: '<diagram id="p2" name="Page-2"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>' },
			{ kind: "page-update", page_id: "p2", name: "Notes", after: "", model: { grid: "0", background: "#ffffff" } },
		]);
		assert.deepEqual(doc.pages().map((page) => page.name), ["Notes", "Flow"]);
		assert.equal(doc.page({ page_id: "p2" }).model.attrs.background, "#ffffff");
		const result = applyEditorChanges(doc, [{ kind: "page-remove", page_id: "p2" }, { kind: "page-remove", page_id: "p1" }]);
		assert.equal(result.applied, 1);
		assert.match(result.errors[0].message, /at least one page/);
	});

	it("reports what it could not apply instead of throwing", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		const result = applyEditorChanges(doc, [
			{ kind: "cell-upsert", page_id: "nope", cell_id: "x", xml: box("x") },
			{ kind: "cell-upsert", page_id: "p1", cell_id: "x", xml: "<diagram/>" },
			{ kind: "cell-remove", page_id: "p1", cell_id: "check" },
		]);
		assert.equal(result.applied, 1);
		assert.equal(result.errors.length, 2);
		assert.equal(doc.page().find("check"), null);
	});
});

describe("saying what changed", () => {
	it("describes moves, relabels, restyles and reconnections", () => {
		const before = DrawioDocument.parse(SAMPLE_XML);
		const after = DrawioDocument.parse(
			SAMPLE_XML.replace('value="Start"', 'value="Begin"')
				.replace('<mxGeometry x="60" y="180"', '<mxGeometry x="200" y="180"')
				.replace("rhombus;whiteSpace=wrap;html=1;", "rhombus;whiteSpace=wrap;html=1;fillColor=#f8cecc;")
				.replace('target="check"', 'target="start"'),
		);
		const lines = diffDocuments(before, after).cells.map(formatCellChange);
		assert.deepEqual(lines, [
			'rounded "Begin" [start]: relabelled "Start" → "Begin"',
			'rhombus "Valid?" [check]: moved to (200, 180); restyled fillColor',
			'edge "yes" [link]: reconnected start → start',
		]);
	});

	it("names library icons by their draw.io shape", () => {
		assert.equal(shapeName("sketch=0;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;"), "mxgraph.aws4.lambda");
		assert.equal(shapeName("image;html=1;image=img/lib/azure2/compute/Function_Apps.svg;"), "image:compute/Function_Apps.svg");
		assert.equal(shapeName("ellipse;whiteSpace=wrap;"), "ellipse");
		assert.equal(plainLabel("<b>Hello</b>&nbsp;<br>world"), "Hello world");
	});
});

describe("layers", () => {
	it("adds, hides, locks, moves cells onto and deletes a layer", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		const page = doc.page();
		layerCommand(page, { op: "add", name: "Notes", layer_id: "notes" });
		layerCommand(page, { op: "move_cells", layer_id: "notes", cell_ids: ["check"] });
		layerCommand(page, { op: "hide", layer_name: "Notes" });
		layerCommand(page, { op: "lock", layer_id: "notes" });
		let layers = layersOf(page);
		assert.deepEqual(
			layers.map(({ id, name, visible, locked, cells }) => ({ id, name, visible, locked, cells })),
			[
				{ id: "1", name: "Background", visible: true, locked: false, cells: 2 },
				{ id: "notes", name: "Notes", visible: false, locked: true, cells: 1 },
			],
		);
		layerCommand(page, { op: "reorder", layer_id: "notes", index: 0 });
		assert.deepEqual(layersOf(page).map((layer) => layer.id), ["notes", "1"]);
		assert.throws(() => layerCommand(page, { op: "delete", layer_id: "notes" }), /holds 1 cell/);
		layerCommand(page, { op: "delete", layer_id: "notes", move_to_layer_id: "1" });
		layers = layersOf(page);
		assert.deepEqual(layers.map((layer) => [layer.id, layer.cells]), [["1", 3]]);
		assert.throws(() => layerCommand(page, { op: "delete", layer_id: "1" }), /at least one layer/);
	});
});
