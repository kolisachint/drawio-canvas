/**
 * Every action against the inputs models actually send, with no editor open.
 *
 * The sweep (`actions-sweep.mjs`) throws right, wrong and strange input at all
 * thirteen actions and fails on anything that is not a success or a refusal a
 * model can act on. The cases below pin the specific failures it found, each of
 * which a real model would hit.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { summarize, sweep } from "./actions-sweep.mjs";
import { openCanvas, SAMPLE_XML } from "./harness.mjs";

async function withCanvas(body, input = { xml: SAMPLE_XML }) {
	const canvas = await openCanvas({ input });
	try {
		await mkdir(path.join(canvas.workspace, "out"), { recursive: true });
		await writeFile(path.join(canvas.workspace, "notes.txt"), "just text");
		await body(canvas);
	} finally {
		await canvas.close();
	}
}

const refusal = (code, pattern) => (error) => {
	assert.equal(error.code, code, `${error.code}: ${error.message}`);
	if (pattern) assert.match(error.message, pattern);
	return true;
};

describe("every action, every kind of input", () => {
	it("never breaks: each call succeeds or is refused with a code and a usable message", async () => {
		await withCanvas(async (canvas) => {
			const { problems, timings } = await sweep(canvas);
			assert.deepEqual(problems, []);
			// Everything here is local; none of it should take long.
			for (const row of summarize(timings)) assert.ok(row.p50 < 50, `${row.name} p50 ${row.p50.toFixed(1)} ms`);
		});
	});
});

describe("what the sweep found", () => {
	it("refuses an <mxfile> with no pages instead of emptying the document", async () => {
		await withCanvas(async ({ invoke }) => {
			await invoke("get_diagram", {});
			await assert.rejects(() => invoke("replace_diagram", { xml: "<mxfile></mxfile>" }), refusal("no_pages", /Nothing was replaced/));
			assert.equal((await invoke("get_diagram", {})).page.shapes, 2);
		});
	});

	it("refuses items that are not objects, instead of a TypeError", async () => {
		await withCanvas(async ({ invoke }) => {
			await assert.rejects(() => invoke("edit_diagram", { operations: [null] }), refusal("invalid_input", /operations\[0\] must be an object/));
			await assert.rejects(() => invoke("insert_shapes", { shapes: [{}] }), refusal("invalid_input", /shapes\[0\]\.shape_id is required/));
		});
	});

	it("names the options when an enum value is wrong", async () => {
		await withCanvas(async ({ invoke }) => {
			await assert.rejects(() => invoke("manage_pages", { op: { nested: true } }), refusal("invalid_input", /"list", "add", "rename", "delete"/));
		});
	});

	it("suggests the field a typo meant, rather than ignoring it and editing the wrong page", async () => {
		await withCanvas(async ({ invoke }) => {
			await assert.rejects(
				() => invoke("edit_diagram", { page_nmae: "Flow", operations: [] }),
				refusal("invalid_input", /no field "page_nmae" — did you mean "page_name"\?/),
			);
		});
	});

	it("reads null for an optional field as 'not given'", async () => {
		await withCanvas(async ({ invoke }) => {
			const result = await invoke("get_diagram", { page_id: null, page_name: null, cell_ids: null });
			assert.equal(result.page.name, "Flow");
		});
	});

	it("refuses a cell whose parent is not on the page", async () => {
		await withCanvas(async ({ invoke }) => {
			await invoke("get_diagram", {});
			const orphan = '<mxCell value="x" vertex="1" parent="nope"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>';
			await assert.rejects(
				() => invoke("edit_diagram", { operations: [{ operation: "add", cell_id: "orphan", new_xml: orphan }] }),
				refusal("all_operations_failed", /Parent "nope" is not a cell on page "Flow"/),
			);
			// A layer made in the same batch is a fine parent.
			const layered = await invoke("edit_diagram", {
				operations: [
					{ operation: "add", cell_id: "L2", new_xml: '<mxCell parent="0"/>' },
					{ operation: "add", cell_id: "onL2", new_xml: orphan.replace('parent="nope"', 'parent="L2"') },
				],
			});
			assert.equal(layered.applied, 2);
		});
	});

	it("explains how to escape a label that breaks the XML", async () => {
		await withCanvas(async ({ invoke }) => {
			await invoke("get_diagram", {});
			await assert.rejects(
				() => invoke("edit_diagram", { operations: [{ operation: "add", cell_id: "q", new_xml: '<mxCell value="say "hi"" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell>' }] }),
				refusal("all_operations_failed", /&quot;/),
			);
		});
	});

	it("will not rename or delete a page it was not told", async () => {
		await withCanvas(async ({ invoke }) => {
			await invoke("manage_pages", { op: "add", name: "Second" });
			await assert.rejects(() => invoke("manage_pages", { op: "delete" }), refusal("invalid_input", /Pages: 0:Flow, 1:Second/));
			await assert.rejects(() => invoke("manage_pages", { op: "rename", name: "x" }), refusal("invalid_input"));
			await assert.rejects(() => invoke("manage_pages", { op: "delete", page_name: "Nope" }), refusal("page_not_found", /Pages: 0:Flow, 1:Second\.$/));
			assert.equal((await invoke("manage_pages", { op: "list" })).pages.length, 2);
		});
	});

	it("reports files in workspace terms, not Node's", async () => {
		await withCanvas(async ({ invoke }) => {
			await assert.rejects(() => invoke("open_file", { path: "missing.drawio" }), refusal("file_not_found", /^No file "missing\.drawio" in the workspace\.$/));
			await assert.rejects(() => invoke("open_file", { path: "out" }), refusal("not_a_file"));
			await assert.rejects(() => invoke("open_file", { path: "notes.txt" }), refusal("unrecognized_xml", /"notes\.txt" is not a draw\.io diagram/));
			await assert.rejects(() => invoke("save_file", { path: "" }), refusal("invalid_input", /file path is required/));
		});
	});

	it("says which asked-for cells are not there", async () => {
		await withCanvas(async ({ invoke }) => {
			const result = await invoke("get_diagram", { cell_ids: ["start", "ghost"] });
			assert.match(result.missing, /ghost/);
			assert.doesNotMatch(result.missing, /start/);
		});
	});

	it("explains an empty shape search", async () => {
		await withCanvas(async ({ invoke }) => {
			assert.match((await invoke("search_shapes", { query: "lambda", library: "nope" })).note, /No library matches "nope"/);
			assert.match((await invoke("search_shapes", { query: "zzzzqqqq" })).note, /Try fewer words/);
			assert.equal((await invoke("search_shapes", { query: "aws lambda" })).note, undefined);
		});
	});
});
