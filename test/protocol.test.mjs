/**
 * The extension as a host sees it: a forked child, the SDK import resolved for
 * it, and the three provider callbacks over stdio.
 *
 * Everything else in this suite calls the canvas in-process. This is the test
 * that the *file* is a canvas extension at all: that it imports nothing it is
 * not allowed to, that it announces itself, that it keeps stdout clean, and
 * that its results survive being JSON.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { forkExtension } from "./host/fork.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/**
 * Instance ids shaped like the host's: unique per run.
 *
 * Fixed ids would let one run's parked document (see `writeSnapshot`) reach the
 * next one, which is exactly the resurrection the freshness window exists to
 * prevent — and a test that depends on that window's length would be a slow
 * flake.
 */
const RUN = `${process.pid}-${Date.now()}`;
const instance = (name) => `${name}-${RUN}`;
const ENTRY = path.join(ROOT, "extension.mjs");

let workspace;
let canvas;

before(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "drawio-protocol-"));
	canvas = forkExtension({ entry: ENTRY, workspace });
});

after(async () => {
	await canvas?.stop();
	await rm(workspace, { recursive: true, force: true });
});

describe("as a forked canvas extension", () => {
	it("ships no package.json and no node_modules", () => {
		// Both are forbidden in an extension directory: the SDK specifier is
		// host-resolved, and a local install would shadow it.
		assert.equal(existsSync(path.join(ROOT, "package.json")), false);
		assert.equal(existsSync(path.join(ROOT, "node_modules")), false);
	});

	it("imports nothing but node: builtins, the SDK, and its own files", async () => {
		const sources = ["extension.mjs", "lib/canvas.mjs", "lib/server.mjs", "lib/files.mjs", "lib/session.mjs", "lib/model.mjs", "lib/render.mjs", "lib/style.mjs", "lib/xml.mjs", "lib/agent.mjs", "lib/asks.mjs", "lib/collab.mjs", "lib/tidy.mjs", "lib/tidy-page.mjs"];
		for (const relative of sources) {
			const source = await readFile(path.join(ROOT, relative), "utf8");
			for (const [, specifier] of source.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)) {
				const allowed = specifier.startsWith("node:") || specifier.startsWith(".") || specifier === "@github/copilot-sdk/extension";
				assert.ok(allowed, `${relative} imports "${specifier}", which the canvas contract does not allow`);
			}
		}
	});

	it("keeps the shared modules loadable in a browser", async () => {
		// `lib/model.mjs`, `lib/render.mjs`, `lib/style.mjs`, `lib/xml.mjs` and
		// `lib/tidy.mjs` are served to the page. A `node:` import in one of them would load here and
		// fail there, where it would surface as a blank canvas rather than an error
		// anyone can read.
		for (const relative of ["lib/model.mjs", "lib/render.mjs", "lib/style.mjs", "lib/xml.mjs", "lib/tidy.mjs"]) {
			const source = await readFile(path.join(ROOT, relative), "utf8");
			assert.equal(/^\s*import\s[^"']*["']node:/m.test(source), false, `${relative} imports a node: builtin but is served to the browser`);
		}
	});

	it("announces its canvas and its actions", async () => {
		const ready = await canvas.ready;
		assert.equal(ready.protocolVersion, 3);
		assert.equal(ready.canvases.length, 1);
		assert.equal(ready.canvases[0].id, "drawio-canvas");
		assert.equal(ready.canvases[0].displayName, "Draw.io Canvas");
		assert.deepEqual(
			ready.canvases[0].actions.map((action) => action.name),
			["get_diagram", "get_changes", "edit_diagram", "search_shapes", "insert_shapes", "replace_diagram", "manage_pages", "manage_layers", "screenshot", "focus", "layout", "tidy", "get_asks", "update_ask", "open_file", "save_file"],
		);
		// Nothing declared that the host cannot serve.
		assert.deepEqual(ready.unsupported, []);
	});

	it("opens, serves its page, answers actions, and closes", async () => {
		await canvas.ready;
		const opened = await canvas.open(instance("i1"));
		assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\//);
		assert.equal(opened.title, "Draw.io Canvas");
		assert.match(opened.status, new RegExp(workspace));

		const page = await fetch(opened.url);
		assert.equal(page.status, 200);
		assert.match(await page.text(), /Draw.io Canvas/);

		await canvas.invoke(instance("i1"), "edit_diagram", {
			operations: [
				{ operation: "add", cell_id: "a", new_xml: '<mxCell value="A" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>' },
			],
		});
		const saved = await canvas.invoke(instance("i1"), "save_file", { path: "out.drawio" });
		assert.equal(saved.saved, "out.drawio");
		assert.match(await readFile(path.join(workspace, "out.drawio"), "utf8"), /value="A"/);

		await canvas.close(instance("i1"));
		await assert.rejects(() => fetch(opened.url));
	});

	it("returns a CanvasError's code across the process boundary", async () => {
		await canvas.ready;
		await canvas.open(instance("i2"));
		await assert.rejects(
			() => canvas.invoke(instance("i2"), "save_file", { path: "../escape.drawio" }),
			(error) => error.code === "outside_workspace",
		);
		await assert.rejects(
			() => canvas.invoke(instance("i2"), "get_diagram", { page_index: 9 }),
			(error) => error.code === "page_not_found",
		);
		await canvas.close(instance("i2"));
	});

	it("isolates one instance's document from another's", async () => {
		await canvas.ready;
		await canvas.open(instance("i3"));
		await canvas.open(instance("i4"));
		await canvas.invoke(instance("i3"), "edit_diagram", {
			operations: [{ operation: "add", cell_id: "only-here", new_xml: '<mxCell value="X" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>' }],
		});
		assert.equal((await canvas.invoke(instance("i3"), "get_diagram", {})).page.shapes, 1);
		assert.equal((await canvas.invoke(instance("i4"), "get_diagram", {})).page.shapes, 0);
		await canvas.close(instance("i3"));
		await canvas.close(instance("i4"));
	});

	it("writes nothing to stdout but the protocol, and nothing to stderr at all", async () => {
		await canvas.ready;
		// stdout is the JSON-RPC channel: one console.log anywhere in the extension
		// corrupts it, and the symptom is an unrelated protocol error.
		assert.deepEqual(canvas.strays, []);
		assert.equal(canvas.stderr.join(""), "");
		assert.ok(canvas.logs.includes("drawio-canvas ready"));
	});
});
