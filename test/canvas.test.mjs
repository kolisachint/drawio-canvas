/**
 * The six actions, and the server the page talks to.
 *
 * Driven through the real canvas: a real document, a real loopback server on a
 * real ephemeral port, a real temporary workspace on disk. Only `createCanvas`
 * and `CanvasError` are supplied by the test (see `harness.mjs`), because those
 * are the host's and their behaviour is fully specified by the protocol.
 */

import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { openCanvas, SAMPLE_XML } from "./harness.mjs";

/** Run `body` against a freshly opened canvas, and always close it. */
async function withCanvas(options, body) {
	const canvas = await openCanvas(options);
	try {
		await body(canvas);
	} finally {
		await canvas.close();
	}
}

const addBox = (id, label, x = 0, y = 0) => ({
	operation: "add",
	cell_id: id,
	new_xml: `<mxCell value="${label}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="120" height="60" as="geometry"/></mxCell>`,
});

describe("canvas declaration", () => {
	it("declares the six actions with schemas the model can call", async () => {
		await withCanvas({}, ({ canvas }) => {
			assert.equal(canvas.declaration.id, "drawio-canvas");
			assert.deepEqual(
				canvas.declaration.actions.map((action) => action.name),
				["get_diagram", "edit_diagram", "replace_diagram", "manage_pages", "open_file", "save_file"],
			);
			for (const action of canvas.declaration.actions) {
				assert.ok(action.description?.length > 20, `${action.name} needs a description the model can act on`);
				assert.equal(action.inputSchema.type, "object");
			}
		});
	});
});

describe("opening", () => {
	it("serves a page on loopback behind a token", async () => {
		await withCanvas({}, async ({ url, fetch: get }) => {
			assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{20,}\/$/);
			const page = await get(".");
			assert.equal(page.status, 200);
			assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
			assert.match(await page.text(), /<title>Draw.io Canvas<\/title>/);
			// Without the token, or with the wrong one, nothing is served.
			assert.equal((await fetch(new URL(url).origin)).status, 403);
			assert.equal((await fetch(new URL("../not-the-token/api/state", url))).status, 403);
		});
	});

	it("serves the modules the page imports, and nothing else", async () => {
		await withCanvas({}, async ({ fetch: get }) => {
			assert.equal((await get("ui/app.mjs")).status, 200);
			assert.equal((await get("lib/model.mjs")).status, 200);
			assert.equal((await get("../../etc/passwd")).status, 403);
			assert.equal((await get("lib/../../../package.json")).status, 403);
			assert.equal((await get("extension.mjs")).status, 404);
		});
	});

	it("starts from supplied XML when given some", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke }) => {
			const result = await invoke("get_diagram", {});
			assert.equal(result.page.name, "Flow");
			assert.equal(result.page.shapes, 2);
		});
	});

	it("says so in its status when it has no workspace", async () => {
		const canvas = await openCanvas({ workspace: null });
		try {
			assert.match(canvas.opened.status, /workspace/);
		} finally {
			await canvas.close();
		}
	});
});

describe("get_diagram", () => {
	it("returns the page's cells, its pages, and the version", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke }) => {
			const result = await invoke("get_diagram", {});
			assert.match(result.cells_xml, /id="start"/);
			assert.match(result.cells_xml, /id="link"/);
			assert.equal(result.pages.length, 1);
			assert.ok(result.version >= 1);
		});
	});

	it("returns only the cells asked for", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke }) => {
			const result = await invoke("get_diagram", { cell_ids: ["check"] });
			assert.match(result.cells_xml, /id="check"/);
			assert.equal(result.cells_xml.includes('id="start"'), false);
		});
	});

	it("falls back to an outline when a page is too big to return whole", async () => {
		// The host truncates a result at 8,000 characters mid-element, which would
		// hand the model half an mxCell to edit from. An outline plus cell_ids is
		// the way back to the cells that matter.
		await withCanvas({}, async ({ invoke }) => {
			const operations = Array.from({ length: 60 }, (_, index) => addBox(`n${index}`, `Node number ${index}`, index * 20, index * 10));
			await invoke("edit_diagram", { operations });
			const result = await invoke("get_diagram", {});
			assert.equal(result.cells_xml, undefined);
			assert.equal(result.outline.length, 60);
			assert.match(result.note, /cell_ids/);
			assert.match(result.outline[0], /^n0 \(shape\): Node number 0$/);
		});
	});

	it("names a page selector that matches nothing", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke }) => {
			await assert.rejects(async () => invoke("get_diagram", { page_name: "Nope" }), (error) => error.code === "page_not_found" && /0:Flow/.test(error.message));
		});
	});
});

describe("edit_diagram", () => {
	it("adds, updates and deletes cells", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke }) => {
			await invoke("get_diagram", {});
			const result = await invoke("edit_diagram", {
				operations: [
					addBox("end", "Done", 60, 320),
					{ operation: "update", cell_id: "check", new_xml: '<mxCell value="Valid now?" style="rhombus;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="60" y="180" width="140" height="80" as="geometry"/></mxCell>' },
					{ operation: "delete", cell_id: "link" },
				],
			});
			assert.equal(result.applied, 3);
			const after = await invoke("get_diagram", {});
			assert.match(after.cells_xml, /value="Valid now\?"/);
			assert.equal(after.cells_xml.includes('id="link"'), false);
			assert.equal(after.page.shapes, 3);
		});
	});

	it("refuses to edit a diagram the agent has never read", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke }) => {
			await assert.rejects(
				async () => invoke("edit_diagram", { operations: [addBox("x", "x")] }),
				(error) => error.code === "no_context" && /get_diagram/.test(error.message),
			);
		});
	});

	it("refuses to edit over a change the person made, and says how to recover", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke, fetch: post }) => {
			await invoke("get_diagram", {});
			// The page's own edit, over exactly the route the browser uses.
			const response = await post("api/ops", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ operations: [addBox("by-hand", "Drawn by hand", 300, 40)] }),
			});
			assert.equal(response.status, 200);
			await assert.rejects(
				async () => invoke("edit_diagram", { operations: [addBox("x", "x")] }),
				(error) => error.code === "stale_diagram",
			);
			// Reading is the way back, and the person's shape is still there.
			const seen = await invoke("get_diagram", {});
			assert.match(seen.cells_xml, /Drawn by hand/);
			assert.equal((await invoke("edit_diagram", { operations: [addBox("x", "x")] })).applied, 1);
		});
	});

	it("keeps the good operations in a batch and reports the bad ones", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke }) => {
			await invoke("get_diagram", {});
			const result = await invoke("edit_diagram", { operations: [addBox("fine", "Fine"), { operation: "delete", cell_id: "ghost" }] });
			assert.equal(result.applied, 1);
			assert.equal(result.errors.length, 1);
			assert.match(result.errors[0].message, /no cell "ghost"/);
		});
	});

	it("fails loudly when every operation fails", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke }) => {
			await invoke("get_diagram", {});
			await assert.rejects(
				async () => invoke("edit_diagram", { operations: [{ operation: "delete", cell_id: "ghost" }] }),
				(error) => error.code === "all_operations_failed",
			);
		});
	});

	it("reports validation problems alongside a successful edit", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke }) => {
			await invoke("get_diagram", {});
			const result = await invoke("edit_diagram", {
				operations: [{ operation: "add", cell_id: "dangling", new_xml: '<mxCell edge="1" parent="1" source="start" target="nowhere"><mxGeometry relative="1" as="geometry"/></mxCell>' }],
			});
			assert.ok(result.issues.some((issue) => /missing target "nowhere"/.test(issue)));
		});
	});
});

describe("replace_diagram", () => {
	it("replaces the whole document", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke }) => {
			const result = await invoke("replace_diagram", {
				xml: '<mxCell id="only" value="Only" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>',
			});
			assert.equal(result.pages.length, 1);
			assert.equal((await invoke("get_diagram", {})).page.shapes, 1);
		});
	});

	it("replaces one page in place, keeping the others and the tab order", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke }) => {
			await invoke("manage_pages", { op: "add", name: "Second" });
			const before = (await invoke("manage_pages", { op: "list" })).pages;
			await invoke("replace_diagram", {
				page_name: "Flow",
				xml: '<mxCell id="fresh" value="Fresh" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>',
			});
			const after = (await invoke("manage_pages", { op: "list" })).pages;
			assert.deepEqual(after.map((page) => page.name), before.map((page) => page.name));
			assert.equal(after[0].id, before[0].id);
			assert.equal(after[0].shapes, 1);
			assert.equal(after[1].name, "Second");
		});
	});
});

describe("manage_pages", () => {
	it("lists, adds, renames and deletes", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke }) => {
			assert.equal((await invoke("manage_pages", { op: "list" })).pages.length, 1);
			const added = await invoke("manage_pages", { op: "add", name: "Detail" });
			assert.equal(added.page.index, 1);
			await invoke("manage_pages", { op: "rename", page_index: 1, name: "Details" });
			assert.equal((await invoke("manage_pages", { op: "list" })).pages[1].name, "Details");
			assert.equal((await invoke("manage_pages", { op: "delete", page_name: "Details" })).deleted, "Details");
			await assert.rejects(async () => invoke("manage_pages", { op: "delete", page_index: 0 }), (error) => error.code === "last_page");
		});
	});
});

describe("files", () => {
	it("saves the document and a picture of one page, inside the workspace only", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ invoke, workspace }) => {
			const saved = await invoke("save_file", { path: "docs/flow.drawio" });
			assert.equal(saved.format, "drawio");
			const contents = await readFile(path.join(workspace, "docs/flow.drawio"), "utf8");
			assert.match(contents, /value="Start"/);

			await invoke("save_file", { path: "docs/flow.svg" });
			const svg = await readFile(path.join(workspace, "docs/flow.svg"), "utf8");
			assert.match(svg, /^<svg xmlns/);
			assert.match(svg, />Start</);

			await assert.rejects(async () => invoke("save_file", { path: "../escaped.drawio" }), (error) => error.code === "outside_workspace");
			await assert.rejects(async () => invoke("save_file", { path: "hook.sh" }), (error) => error.code === "unsupported_extension");
		});
	});

	it("opens a file from the workspace, decompressing draw.io's own format", async () => {
		await withCanvas({}, async ({ invoke, workspace }) => {
			const inner = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="z" value="From disk" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel>';
			const body = deflateRawSync(Buffer.from(encodeURIComponent(inner))).toString("base64");
			await mkdir(path.join(workspace, "docs"), { recursive: true });
			await writeFile(path.join(workspace, "docs/compressed.drawio"), `<mxfile><diagram id="c" name="Packed">${body}</diagram></mxfile>`);

			const opened = await invoke("open_file", { path: "docs/compressed.drawio" });
			assert.equal(opened.decompressed_pages, 1);
			assert.match((await invoke("get_diagram", {})).cells_xml, /From disk/);
			// The file it came from is remembered, so a later save has a default.
			assert.equal((await invoke("get_diagram", {})).file, "docs/compressed.drawio");
		});
	});

	it("round-trips a file it opened without disturbing what it cannot draw", async () => {
		await withCanvas({}, async ({ invoke, workspace }) => {
			const exotic =
				'<mxfile host="app.diagrams.net"><diagram id="d" name="Cloud"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
				'<UserObject label="Lambda" owner="platform" id="fn"><mxCell style="sketch=0;points=[[0,0,0]];shape=mxgraph.aws4.resourceIcon;fillColor=#ED7100;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="78" height="78" as="geometry"/></mxCell></UserObject>' +
				"</root></mxGraphModel></diagram></mxfile>";
			await writeFile(path.join(workspace, "aws.drawio"), exotic);
			await invoke("open_file", { path: "aws.drawio" });
			await invoke("get_diagram", {});
			await invoke("edit_diagram", { operations: [addBox("note", "Added here", 200, 40)] });
			await invoke("save_file", { path: "aws.drawio" });
			const saved = await readFile(path.join(workspace, "aws.drawio"), "utf8");
			assert.match(saved, /mxgraph\.aws4\.resourceIcon/);
			assert.match(saved, /owner="platform"/);
			assert.match(saved, /points=\[\[0,0,0\]\]/);
			assert.match(saved, /Added here/);
		});
	});
});

describe("the page's own routes", () => {
	it("hands the page the document, and takes its edits", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ fetch: call, invoke }) => {
			const state = await (await call("api/state")).json();
			assert.equal(state.pages[0].name, "Flow");
			assert.match(state.xml, /value="Start"/);

			const result = await (
				await call("api/ops", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ operations: [addBox("p1", "From the page", 300, 300)] }),
				})
			).json();
			assert.equal(result.version, state.version + 1);
			assert.match((await invoke("get_diagram", {})).cells_xml, /From the page/);
		});
	});

	it("streams the agent's changes to the page", async () => {
		await withCanvas({}, async ({ fetch: call, invoke, url }) => {
			const controller = new AbortController();
			const response = await fetch(new URL("api/events", url), { signal: controller.signal });
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			const read = async () => decoder.decode((await reader.read()).value ?? new Uint8Array());
			assert.match(await read(), /retry: 1000/);

			await invoke("edit_diagram", { operations: [addBox("live", "Live", 10, 10)] });
			let received = "";
			while (!received.includes("event: change")) received += await read();
			const data = JSON.parse(received.slice(received.indexOf("data: ") + 6).split("\n")[0]);
			assert.equal(data.source, "agent");
			assert.deepEqual(data.touched, ["live"]);
			controller.abort();
			// The stream's own routes still answer afterwards: aborting a reader must
			// not take the server down with it.
			assert.equal((await call("api/state")).status, 200);
		});
	});

	it("serves history, thumbnails and a restore", async () => {
		await withCanvas({ input: { xml: SAMPLE_XML } }, async ({ fetch: call, invoke }) => {
			await invoke("get_diagram", {});
			await invoke("edit_diagram", { operations: [addBox("temp", "Temporary", 300, 40)] });
			const { versions } = await (await call("api/history")).json();
			assert.ok(versions.length >= 1);
			const thumbnail = await call(`api/history/svg?version=${versions[0].version}`);
			assert.equal(thumbnail.headers.get("content-type"), "image/svg+xml");
			assert.match(await thumbnail.text(), /^<svg/);
			assert.equal((await call("api/history/svg?version=9999")).status, 404);

			await call("api/restore", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ version: versions[0].version }),
			});
			assert.equal((await invoke("get_diagram", {})).cells_xml.includes("Temporary"), false);
		});
	});

	it("answers a bad request with the reason rather than a stack trace", async () => {
		await withCanvas({}, async ({ fetch: call }) => {
			const response = await call("api/file", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ op: "open", path: "../../etc/passwd" }),
			});
			assert.equal(response.status, 400);
			assert.equal((await response.json()).code, "outside_workspace");
			assert.equal((await call("api/nothing-here")).status, 404);
		});
	});
});

describe("closing", () => {
	it("releases the port, and tolerates a close for an instance it never opened", async () => {
		const canvas = await openCanvas({});
		await canvas.close();
		await assert.rejects(() => fetch(canvas.url));
		await canvas.canvas.options.onClose({ instanceId: "never-opened" });
	});
});

describe("surviving a reload", () => {
	it("hands the document to the instance's next process", async () => {
		// `reload_canvas` forks a new child from the edited source and re-opens this
		// instance in it. Without this the agent would throw away the person's
		// diagram every time it changed a line of the canvas's own code.
		const first = await openCanvas({});
		await first.invoke("edit_diagram", { operations: [addBox("kept", "Still here", 20, 20)] });
		await first.invoke("save_file", { path: "bound.drawio" });
		await first.close({ keepWorkspace: true });

		const second = await openCanvas({ workspace: first.workspace, instanceId: first.instanceId });
		try {
			// Restored, not authored: the new process has not read this document, so
			// the gate still stands between it and an edit by id.
			await assert.rejects(
				async () => second.invoke("edit_diagram", { operations: [addBox("x", "x")] }),
				(error) => error.code === "no_context",
			);
			const result = await second.invoke("get_diagram", {});
			assert.match(result.cells_xml, /Still here/);
			assert.equal(result.file, "bound.drawio");
		} finally {
			await second.close();
		}
	});

	it("starts blank when nothing was parked for this instance", async () => {
		await withCanvas({}, async ({ invoke }) => {
			assert.equal((await invoke("get_diagram", {})).page.shapes, 0);
		});
	});
});
