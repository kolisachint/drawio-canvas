/**
 * A reload (the host closes the instance in the old process and opens it in the
 * new one) keeps the person's tab: same port and token, the document and the
 * asks. The parked token is owner-only on disk, and a port that was taken in
 * the meantime falls back to a fresh one instead of failing the open.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { openCanvas, SAMPLE_XML } from "./harness.mjs";

const SNAPSHOT_DIR = path.join(tmpdir(), "drawio-canvas-instances");

describe("reload", () => {
	it("reopens on the same URL with the document and the asks, and parks the token owner-only", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "drawio-canvas-reload-"));
		const instanceId = `reload-${Math.random().toString(36).slice(2)}`;
		const first = await openCanvas({ instanceId, workspace, input: { xml: SAMPLE_XML } });
		let second;
		try {
			await first.fetch("api/collab", { method: "POST", body: JSON.stringify({ op: "ask", text: "Keep me" }) });
			await first.close();

			const parked = (await readdir(SNAPSHOT_DIR)).find((name) => name.includes(instanceId.replace(/[^A-Za-z0-9_-]/g, "")));
			assert.ok(parked, "the instance is parked");
			if (process.platform !== "win32") assert.equal((await stat(path.join(SNAPSHOT_DIR, parked))).mode & 0o777, 0o600);

			second = await openCanvas({ instanceId, workspace });
			assert.equal(second.url, first.url);
			const state = await (await second.fetch("api/collab")).json();
			assert.deepEqual(
				state.asks.map((ask) => ask.text),
				["Keep me"],
			);
			assert.ok((await second.invoke("get_diagram", {})).cells_xml.includes('id="start"'));
			assert.equal((await readdir(SNAPSHOT_DIR)).includes(parked), false, "taken back and removed");
		} finally {
			await second?.close();
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("serves on a new port when the old one was taken meanwhile", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "drawio-canvas-reload-"));
		const instanceId = `reload-${Math.random().toString(36).slice(2)}`;
		const first = await openCanvas({ instanceId, workspace });
		const port = Number(new URL(first.url).port);
		await first.close();
		const squatter = createServer();
		await new Promise((resolve) => squatter.listen(port, "127.0.0.1", resolve));
		let second;
		try {
			second = await openCanvas({ instanceId, workspace });
			assert.notEqual(Number(new URL(second.url).port), port);
			assert.equal((await second.fetch("api/state")).status, 200);
			assert.ok(second.logs.some((line) => /is taken/.test(line)), "says why the URL changed");
		} finally {
			squatter.close();
			await second?.close();
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
