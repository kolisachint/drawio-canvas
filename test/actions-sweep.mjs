/**
 * Every action, with the inputs a model really sends: right, wrong, and strange.
 *
 * Shared by `test/actions.test.mjs` (no editor) and `test/drawio.test.mjs` (the
 * person's draw.io open). A call may succeed or be refused; what it may not do
 * is break: a raw TypeError, `internal_error`, a refusal without a code or a
 * message the model can act on, a hang, or a document that no longer reads.
 */

/** Codes a refusal may carry. Anything else is a new failure mode and should be looked at. */
export const KNOWN_CODES = new Set([
	"invalid_input",
	"invalid_xml",
	"page_not_found",
	"cell_not_found",
	"layer_not_found",
	"no_context",
	"stale_cells",
	"all_operations_failed",
	"no_editor",
	"editor_error",
	"editor_timeout",
	"unknown_shape",
	"file_not_found",
	"outside_workspace",
	"unsupported_format",
	"no_workspace",
	"invalid_layout",
	"invalid_operation",
	"last_page",
	"duplicate_id",
	"compressed_page",
	"not_a_diagram",
	"unsaved_changes",
	"empty_query",
	"empty_xml",
	"empty_file",
	"unrecognized_xml",
	"missing_name",
	"unknown_page_op",
	"unknown_cell",
	"last_layer",
	"unsupported_extension",
	"no_pages",
	"not_a_file",
	"file_unreadable",
	"stale_diagram",
	"invalid_parent",
	"unknown_ask",
]);

const cell = (id, label = id, x = 40, y = 40) =>
	`<mxCell id="${id}" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="120" height="60" as="geometry"/></mxCell>`;
const add = (id, label, x, y) => ({ operation: "add", cell_id: id, new_xml: cell(id, label, x, y) });

/** Wrong values for a property of this schema type. */
function wrongValuesFor(schema = {}) {
	const values = [null, { nested: true }];
	if (schema.type !== "string") values.push("not-a-number", "");
	if (schema.type !== "integer" && schema.type !== "number") values.push(-1, 1e12);
	if (schema.type === "integer" || schema.type === "number") values.push(-1, 1e12, 1.5, "7");
	if (schema.type !== "array") values.push([1, 2]);
	if (schema.type === "array") values.push([], [null], [{}], "[]");
	if (schema.enum) values.push("definitely_not_an_option");
	if (schema.type === "boolean") values.push("yes");
	return values;
}

/** Hand-written cases per action: the mistakes models make, and the edges of each action. */
export function specificCases() {
	return {
		get_diagram: [{}, { page_index: 0 }, { page_name: "Nope" }, { page_index: 99 }, { page_id: "zzz" }, { cell_ids: ["ghost"] }, { cell_ids: [] }],
		get_changes: [{}, { since_version: 0 }, { since_version: 10_000 }, { include_agent: true, limit: 1 }, { limit: 0 }],
		edit_diagram: [
			{ operations: [add("s1", "Sweep 1", 40, 40)] },
			{ operations: [add("s1", "Duplicate", 40, 40)] },
			{ operations: [] },
			{ operations: [{ operation: "add", cell_id: "s2" }] },
			{ operations: [{ operation: "add", cell_id: "s3", new_xml: "<<not xml" }] },
			{ operations: [{ operation: "add", cell_id: "s4", new_xml: `<mxCell id="s4" vertex="1" parent="1">${cell("inner")}</mxCell>` }] },
			{ operations: [{ operation: "add", cell_id: "0", new_xml: cell("0") }] },
			{ operations: [{ operation: "add", cell_id: "1", new_xml: cell("1") }] },
			{ operations: [{ operation: "update", cell_id: "ghost", new_xml: cell("ghost") }] },
			{ operations: [{ operation: "delete", cell_id: "ghost" }] },
			{ operations: [{ operation: "explode", cell_id: "s1" }] },
			{ operations: [{ operation: "add", cell_id: "e9", new_xml: '<mxCell id="e9" edge="1" parent="1" source="nowhere" target="s1"><mxGeometry relative="1" as="geometry"/></mxCell>' }] },
			{ operations: [{ operation: "add", cell_id: "s5", new_xml: '<mxCell id="s5" value="no geometry" vertex="1" parent="1"/>' }] },
			{ operations: [{ operation: "add", cell_id: "s6", new_xml: '<mxCell id="s6" value="orphan" vertex="1" parent="nope"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' }] },
			{ operations: Array.from({ length: 300 }, (_, i) => add(`bulk${i}`, `Bulk ${i}`, (i % 20) * 130, 400 + Math.floor(i / 20) * 80)) },
			{ operations: Array.from({ length: 300 }, (_, i) => ({ operation: "delete", cell_id: `bulk${i}` })) },
			{ operations: [add("uni", "Ünïcødé ✓ <b>&amp;</b> \"quotes\"", 40, 200)] },
			{ page_name: "Nope", operations: [add("s7", "x", 0, 0)] },
		],
		search_shapes: [{ query: "aws lambda" }, { query: "" }, { query: "zzzzqqqq" }, { query: "k8s pod", library: "nope" }, { query: "server", limit: 1 }, { query: "a".repeat(5000) }],
		insert_shapes: [
			{ shapes: [{ shape_id: "aws4Compute/lambda", cell_id: "ins1", x: 300, y: 40, label: "Fn" }] },
			{ shapes: [{ shape_id: "aws4Compute/lambda", cell_id: "ins1", x: 300, y: 40 }] },
			{ shapes: [{ shape_id: "no/such/shape", cell_id: "ins2", x: 0, y: 0 }] },
			{ shapes: [{ shape_id: "aws4Compute/lambda", cell_id: "ins3", x: 0, y: 0, style: { fillColor: "#ff0000", strokeColor: null } }] },
			{ shapes: [{ shape_id: "aws4Compute/lambda", cell_id: "ins4", x: 0, y: 0, parent: "nope" }] },
			{ shapes: [] },
		],
		replace_diagram: [
			{ xml: "<<nope", page_index: 0 },
			{ xml: "" },
			{ xml: "<mxfile></mxfile>" },
			{ xml: cell("r1"), page_index: 0, scope: "page" },
			{ xml: cell("r2"), page_name: "Nope" },
		],
		manage_pages: [
			{ op: "list" },
			{ op: "add", name: "Second" },
			{ op: "add", name: "With XML", xml: cell("px") },
			{ op: "add", name: "Bad XML", xml: "<<" },
			{ op: "rename", page_name: "Second", name: "Renamed" },
			{ op: "rename", page_name: "Nope", name: "x" },
			{ op: "rename", page_name: "Renamed" },
			{ op: "delete", page_name: "Nope" },
			{ op: "delete", page_name: "Renamed" },
			{ op: "delete", page_name: "With XML" },
		],
		manage_layers: [
			{ op: "list" },
			{ op: "add", name: "Overlay" },
			{ op: "hide", layer_name: "Overlay" },
			{ op: "show", layer_name: "Overlay" },
			{ op: "lock", layer_name: "Overlay" },
			{ op: "unlock", layer_name: "Overlay" },
			{ op: "reorder", layer_name: "Overlay", index: 0 },
			{ op: "reorder", layer_name: "Overlay", index: 99 },
			{ op: "move_cells", layer_name: "Overlay", cell_ids: ["s1"] },
			{ op: "move_cells", layer_name: "Overlay", cell_ids: ["ghost"] },
			{ op: "rename", layer_name: "Overlay", name: "Top" },
			{ op: "hide", layer_name: "Nope" },
			{ op: "delete", layer_name: "Top", move_to_layer_id: "1" },
			{ op: "delete", layer_id: "1" },
		],
		screenshot: [{}, { scope: "viewport" }, { scope: "selection" }, { scope: "cells", cell_ids: ["s1"] }, { scope: "cells" }, { scope: "cells", cell_ids: ["ghost"] }, { scale: 4 }, { scale: 0.1 }, { path: "shots/a.png" }, { path: "../escape.png" }, { path: "not-an-image.txt" }],
		focus: [{}, { cell_ids: ["s1"], message: "Here" }, { cell_ids: ["ghost"] }, { message: "x".repeat(2000) }, { page_name: "Nope" }],
		layout: [{ layout: "verticalFlow" }, { layout: "horizontalTree" }, { layout: "organic" }, { layout: "no-such-layout" }, { layout: [{ layout: "mxHierarchicalLayout", config: { orientation: "west" } }] }, { layout: [{ nonsense: true }] }, { layout: "" }],
		save_file: [
			{ path: "out/diagram.drawio" },
			{ path: "out/diagram.xml" },
			{ path: "out/diagram.svg" },
			{ path: "out/diagram.png" },
			{ path: "out/diagram.exe" },
			{ path: "../outside.drawio" },
			{ path: "/etc/absolute.drawio" },
			{ path: "" },
		],
		tidy: [{}, { cell_ids: ["s1"] }, { cell_ids: ["ghost"] }, { steps: { fit: false, snap: false } }, { steps: { nope: true } }, { page_name: "Nope" }],
		get_asks: [{}, { include_done: true }],
		update_ask: [{ id: 1, status: "working" }, { id: 1, status: "done", reply: "x".repeat(2000) }, { id: 99, status: "done" }, { id: 1, status: "open" }, { id: 1 }],
		open_file: [{ path: "out/diagram.drawio" }, { path: "missing.drawio" }, { path: "../../etc/passwd" }, { path: "out" }, { path: "notes.txt" }, { path: "" }],
	};
}

/** Generic hostile inputs from each action's own schema. */
export function schemaCases(action) {
	const schema = action.inputSchema ?? {};
	const cases = [undefined, null, {}, "garbage", "[1,2]", 42, [], { not_a_field: 1 }];
	for (const [key, property] of Object.entries(schema.properties ?? {})) {
		for (const value of wrongValuesFor(property)) cases.push({ ...requiredStub(action), [key]: value });
	}
	return cases;
}

/** The smallest input that satisfies an action's required fields, so one bad property is tested at a time. */
function requiredStub(action) {
	const stubs = { operations: [add("stub", "Stub", 600, 600)], query: "aws", shapes: [{ shape_id: "aws4Compute/lambda", cell_id: "stubshape", x: 0, y: 0 }], xml: cell("stubx"), op: "list", layout: "verticalFlow", path: "out/stub.drawio" };
	return Object.fromEntries((action.inputSchema?.required ?? []).map((key) => [key, stubs[key]]));
}

/**
 * Run every case against one open canvas. Returns what went wrong, and timings.
 *
 * @param {{ invoke(name: string, input: unknown): Promise<unknown>, canvas: { declaration: { actions: object[] } } }} opened
 * @param {{ perCallMs?: number, skip?: Set<string> }} [options]
 */
export async function sweep(opened, { perCallMs = 30_000, skip = new Set() } = {}) {
	const problems = [];
	const timings = new Map();
	const outcomes = new Map();
	const actions = opened.canvas.declaration.actions;
	const specific = specificCases();

	async function call(name, input) {
		const started = performance.now();
		let timer;
		const hang = new Promise((_, reject) => {
			timer = setTimeout(() => reject(Object.assign(new Error(`hung for ${perCallMs} ms`), { hang: true })), perCallMs);
		});
		try {
			await Promise.race([opened.invoke(name, input), hang]);
			return { ok: true, ms: performance.now() - started };
		} catch (error) {
			return { ok: false, error, ms: performance.now() - started };
		} finally {
			clearTimeout(timer);
		}
	}

	await opened.invoke("get_diagram", {});
	for (const action of actions) {
		if (skip.has(action.name)) continue;
		const cases = [...(specific[action.name] ?? []), ...schemaCases(action)];
		for (const input of cases) {
			const label = `${action.name} ${JSON.stringify(input)?.slice(0, 140)}`;
			const result = await call(action.name, input);
			const list = timings.get(action.name) ?? [];
			list.push(result.ms);
			timings.set(action.name, list);
			const key = result.ok ? "ok" : (result.error?.code ?? "no-code");
			outcomes.set(action.name, { ...(outcomes.get(action.name) ?? {}), [key]: ((outcomes.get(action.name) ?? {})[key] ?? 0) + 1 });
			if (result.ok) continue;
			const { error } = result;
			if (error.hang) problems.push(`${label}: ${error.message}`);
			else if (!error.code) problems.push(`${label}: threw without a code (${error.name}: ${error.message})`);
			else if (error.code === "internal_error") problems.push(`${label}: internal_error: ${error.message}`);
			else if (!KNOWN_CODES.has(error.code)) problems.push(`${label}: unfamiliar code ${error.code}: ${error.message}`);
			else if (!error.message || error.message.length < 12) problems.push(`${label}: ${error.code} with no usable message`);
			else if (/undefined|\[object Object\]|NaN/.test(error.message)) problems.push(`${label}: ${error.code} message leaks internals: ${error.message}`);
			// Every call leaves a readable document behind.
			const after = await call("get_diagram", {});
			if (!after.ok) problems.push(`${label}: get_diagram broke afterwards: ${after.error?.code} ${after.error?.message}`);
		}
	}
	return { problems, timings, outcomes };
}

/** Median and worst of each action's calls, for a table. */
export function summarize(timings) {
	return [...timings].map(([name, list]) => {
		const sorted = [...list].sort((a, b) => a - b);
		return { name, calls: list.length, p50: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
	});
}
