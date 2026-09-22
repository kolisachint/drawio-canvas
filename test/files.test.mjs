import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
	readDiagramFile,
	resolveInWorkspace,
	SNAPSHOT_MAX_AGE_MS,
	takeSnapshot,
	toFileXml,
	writeSnapshot,
	writeWorkspaceFile,
} from "../lib/files.mjs";
import { DiagramError, DrawioDocument } from "../lib/model.mjs";
import { SAMPLE_XML } from "./harness.mjs";

let workspace;
let outside;

before(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "drawio-files-"));
	outside = await mkdtemp(path.join(tmpdir(), "drawio-outside-"));
});

after(async () => {
	await rm(workspace, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

describe("files", () => {
	it("reads a plain .drawio file", async () => {
		const file = path.join(workspace, "plain.drawio");
		await writeFile(file, SAMPLE_XML);
		const { xml, inflatedPages } = await readDiagramFile(file);
		assert.equal(inflatedPages, 0);
		assert.match(xml, /value="Start"/);
	});

	it("inflates draw.io's compressed pages", async () => {
		// The format the desktop app writes by default: URI-encoded, raw-deflated,
		// base64'd. A file in that form is unreadable until this runs.
		const inner = '<mxGraphModel dx="1" dy="1"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="z" value="Zipped" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel>';
		const body = deflateRawSync(Buffer.from(encodeURIComponent(inner))).toString("base64");
		const file = path.join(workspace, "compressed.drawio");
		await writeFile(file, `<mxfile host="Electron"><diagram id="c" name="Zipped">${body}</diagram></mxfile>`);
		const { xml, inflatedPages } = await readDiagramFile(file);
		assert.equal(inflatedPages, 1);
		assert.match(xml, /value="Zipped"/);
		assert.equal(DrawioDocument.parse(xml).page().compressed, false);
	});

	it("keeps every path inside the workspace", async () => {
		assert.equal(resolveInWorkspace(workspace, "docs/a.drawio"), path.join(workspace, "docs/a.drawio"));
		assert.throws(() => resolveInWorkspace(workspace, "../escape.drawio"), (error) => error.code === "outside_workspace");
		assert.throws(() => resolveInWorkspace(workspace, "/etc/passwd"), (error) => error.code === "outside_workspace");
		assert.throws(() => resolveInWorkspace(undefined, "a.drawio"), (error) => error.code === "no_workspace");
	});

	it("resolves symlinks before deciding, not after", async () => {
		// The check is on the real path: a symlink inside the workspace pointing out
		// of it would otherwise read as contained while writing anywhere.
		const link = path.join(workspace, "sneaky");
		await symlink(outside, link).catch(() => {});
		assert.throws(() => resolveInWorkspace(workspace, "sneaky/evil.drawio"), (error) => error.code === "outside_workspace");
	});

	it("writes only the extensions it says it writes", async () => {
		const target = path.join(workspace, "nested", "out.drawio");
		await writeWorkspaceFile(target, toFileXml(DrawioDocument.parse(SAMPLE_XML)));
		assert.match(await readFile(target, "utf8"), /^<\?xml version="1.0" encoding="UTF-8"\?>/);
		await assert.rejects(() => writeWorkspaceFile(path.join(workspace, "out.sh"), "#!/bin/sh"), DiagramError);
	});

	it("round-trips a document through a file unchanged", async () => {
		const file = path.join(workspace, "round.drawio");
		const original = DrawioDocument.parse(SAMPLE_XML);
		await mkdir(path.dirname(file), { recursive: true });
		await writeWorkspaceFile(file, toFileXml(original));
		const { xml } = await readDiagramFile(file);
		assert.equal(DrawioDocument.parse(xml).fingerprint(), original.fingerprint());
	});
});

describe("parked documents", () => {
	it("hands a freshly parked document back exactly once", async () => {
		const id = `park-${process.pid}`;
		assert.equal(await writeSnapshot(id, { xml: SAMPLE_XML, filePath: "docs/a.drawio" }), true);
		const taken = await takeSnapshot(id);
		assert.equal(taken.filePath, "docs/a.drawio");
		assert.match(taken.xml, /value="Start"/);
		assert.equal(await takeSnapshot(id), null);
	});

	it("ignores one parked too long ago to be a reload", async () => {
		// A reload comes back within a second or two. Anything older is a canvas
		// that was closed and never returned, and its document must not reappear
		// under a later instance that happens to share an id.
		const id = `stale-${process.pid}`;
		await writeSnapshot(id, { xml: SAMPLE_XML });
		const parked = path.join(tmpdir(), "drawio-canvas-instances", `${id}.json`);
		const longAgo = new Date(Date.now() - SNAPSHOT_MAX_AGE_MS - 60_000);
		await utimes(parked, longAgo, longAgo);
		assert.equal(await takeSnapshot(id), null);
		// Refused, and cleaned up rather than left to be refused again.
		assert.equal(existsSync(parked), false);
	});

	it("refuses an instance id that is not id-shaped", async () => {
		assert.equal(await writeSnapshot("../../escape", { xml: SAMPLE_XML }), false);
		assert.equal(await takeSnapshot("../../escape"), null);
	});
});
