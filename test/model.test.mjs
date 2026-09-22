import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyOperations,
	cellGeometry,
	cellId,
	DiagramError,
	DrawioDocument,
	summarizePage,
	validateDocument,
} from "../lib/model.mjs";
import { SAMPLE_XML } from "./harness.mjs";

const cellIds = (page) => page.drawable().map(cellId);

describe("document model", () => {
	it("accepts all three input shapes", () => {
		const fromFile = DrawioDocument.parse(SAMPLE_XML);
		assert.equal(fromFile.pages().length, 1);
		assert.equal(fromFile.page().name, "Flow");

		const fromModel = DrawioDocument.parse('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>');
		assert.equal(fromModel.pages().length, 1);

		const fromCells = DrawioDocument.parse('<mxCell id="9" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>');
		assert.deepEqual(cellIds(fromCells.page()), ["9"]);
		// The root sentinels are supplied when the fragment left them implicit.
		assert.equal(fromCells.page().cells().length, 3);
	});

	it("refuses input that is not a diagram at all", () => {
		assert.throws(() => DrawioDocument.parse("<html><body/></html>"), DiagramError);
		assert.throws(() => DrawioDocument.parse(""), DiagramError);
	});

	it("resolves a page by id, name and index, first page by default", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		doc.addPage("Second");
		assert.equal(doc.page().name, "Flow");
		assert.equal(doc.page({ page_name: "Second" }).index, 1);
		assert.equal(doc.page({ page_index: 1 }).name, "Second");
		assert.equal(doc.page({ page_id: doc.pages()[1].id }).name, "Second");
		assert.equal(doc.page({ page_name: "nope" }), null);
	});

	it("adds, updates and deletes cells, reporting each failure separately", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		const result = applyOperations(doc, {}, [
			{ operation: "add", cell_id: "end", new_xml: '<mxCell value="End" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="60" y="320" width="120" height="50" as="geometry"/></mxCell>' },
			{ operation: "update", cell_id: "start", new_xml: '<mxCell value="Begin" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="160" height="60" as="geometry"/></mxCell>' },
			{ operation: "delete", cell_id: "ghost" },
			{ operation: "add", cell_id: "start", new_xml: "<mxCell vertex=\"1\" parent=\"1\"/>" },
		]);
		assert.deepEqual(result.applied.map((entry) => entry.cell_id), ["end", "start"]);
		assert.deepEqual(result.errors.map((error) => error.message), [
			'Page "Flow" has no cell "ghost".',
			'Cell "start" already exists.',
		]);
		assert.equal(doc.page().find("start").cell.attrs.value, "Begin");
		assert.equal(cellGeometry(doc.page().find("start")).width, 160);
	});

	it("takes descendants and attached edges with a deleted cell", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		applyOperations(doc, {}, [
			{ operation: "add", cell_id: "child", new_xml: '<mxCell value="in lane" style="rounded=1;" vertex="1" parent="start"><mxGeometry x="10" y="10" width="40" height="20" as="geometry"/></mxCell>' },
		]);
		const [deleted] = applyOperations(doc, {}, [{ operation: "delete", cell_id: "start" }]).applied;
		assert.deepEqual(deleted.also_removed.sort(), ["child", "link"]);
		assert.deepEqual(cellIds(doc.page()), ["check"]);
	});

	it("refuses to delete mxGraph's root sentinels", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		const { errors } = applyOperations(doc, {}, [{ operation: "delete", cell_id: "1" }]);
		assert.match(errors[0].message, /root sentinel/);
	});

	it("rejects a nested mxCell, the mistake that renders as a blank page", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		const { errors } = applyOperations(doc, {}, [
			{ operation: "add", cell_id: "bad", new_xml: '<mxCell vertex="1" parent="1"><mxCell id="inner"/></mxCell>' },
		]);
		assert.match(errors[0].message, /siblings/);
	});

	it("keeps a UserObject wrapper's identity on update", () => {
		const doc = DrawioDocument.parse(
			'<mxfile><diagram name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
				'<UserObject label="Task" owner="ana" id="t1"><mxCell style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></UserObject>' +
				"</root></mxGraphModel></diagram></mxfile>",
		);
		const entry = doc.page().find("t1");
		assert.equal(entry.node.name, "UserObject");
		assert.equal(entry.node.attrs.owner, "ana");
		applyOperations(doc, {}, [
			{ operation: "update", cell_id: "t1", new_xml: '<UserObject label="Task 2" owner="ana"><mxCell style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></UserObject>' },
		]);
		assert.equal(doc.page().find("t1").node.attrs.label, "Task 2");
		assert.match(doc.toXml(), /id="t1"/);
	});

	it("fingerprints content, not formatting", () => {
		const original = DrawioDocument.parse(SAMPLE_XML);
		const reserialized = DrawioDocument.parse(original.toXml());
		assert.equal(reserialized.fingerprint(), original.fingerprint());

		// Viewport attributes are not content: the browser rewrites them constantly.
		const moved = DrawioDocument.parse(SAMPLE_XML.replace('dx="800"', 'dx="1600"'));
		assert.equal(moved.fingerprint(), original.fingerprint());

		const edited = DrawioDocument.parse(SAMPLE_XML.replace('value="Start"', 'value="Begin"'));
		assert.notEqual(edited.fingerprint(), original.fingerprint());
	});

	it("manages pages and refuses to delete the last one", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		const second = doc.addPage("Second", '<mxCell id="x" vertex="1" parent="1"><mxGeometry width="10" height="10" as="geometry"/></mxCell>');
		assert.equal(summarizePage(second).shapes, 1);
		doc.deletePage(second);
		assert.throws(() => doc.deletePage(doc.page()), DiagramError);
	});

	it("mints ids nothing in the document uses, across pages", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		doc.addPage("Second", '<mxCell id="c1" vertex="1" parent="1"><mxGeometry width="10" height="10" as="geometry"/></mxCell>');
		assert.equal(doc.newCellId("c"), "c2");
	});

	it("finds the four mistakes that make a diagram open blank", () => {
		const doc = DrawioDocument.parse(
			'<mxfile><diagram name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
				'<mxCell id="dup" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
				'<mxCell id="dup" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
				'<mxCell id="orphan" vertex="1" parent="missing"><mxGeometry width="10" height="10" as="geometry"/></mxCell>' +
				'<mxCell id="sizeless" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell>' +
				'<mxCell id="dangling" edge="1" parent="1" source="dup" target="nowhere"><mxGeometry relative="1" as="geometry"/></mxCell>' +
				"</root></mxGraphModel></diagram></mxfile>",
		);
		const messages = validateDocument(doc).map((issue) => issue.message);
		assert.ok(messages.some((message) => /Duplicate cell id "dup"/.test(message)));
		assert.ok(messages.some((message) => /parent "missing"/.test(message)));
		assert.ok(messages.some((message) => /missing target "nowhere"/.test(message)));
		assert.ok(messages.some((message) => /"sizeless" has no size/.test(message)));
	});
});
