import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { installFromArchive, locateDrawio, PINNED } from "../lib/drawio-dist.mjs";
import { readSettings, writeSettings } from "../lib/settings.mjs";
import { searchShapes, shapeOperations, decompressTemplate } from "../lib/shapes.mjs";
import { listZip } from "../lib/zip.mjs";

/** A minimal zip writer, for building test archives. */
function zip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, text] of entries) {
		const data = Buffer.from(text);
		const compressed = deflateRawSync(data);
		const nameBytes = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, compressed);
		centrals.push(central, nameBytes);
		offset += local.length + nameBytes.length + compressed.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

describe("the pinned draw.io", () => {
	it("reads a zip with node:zlib alone", () => {
		const entries = listZip(zip([["index.html", "<html>"], ["js/app.min.js", "x".repeat(1000)]]));
		assert.deepEqual(entries.map((entry) => [entry.name, entry.size]), [["index.html", 6], ["js/app.min.js", 1000]]);
		assert.equal(entries[1].read().toString(), "x".repeat(1000));
		assert.throws(() => listZip(Buffer.from("not a zip")), /Not a zip/);
	});

	it("refuses an archive that is not the pinned release, and installs nothing", async () => {
		const cache = await mkdtemp(path.join(tmpdir(), "drawio-canvas-cache-"));
		try {
			const env = { DRAWIO_CANVAS_CACHE: cache };
			await assert.rejects(installFromArchive(zip([["index.html", "<html>"]]), { env }), /does not match the pinned release 31\.4\.6/);
			assert.equal(await locateDrawio(env), null);
		} finally {
			await rm(cache, { recursive: true, force: true });
		}
	});

	it("takes an unpacked webapp from DRAWIO_CANVAS_DRAWIO_DIR, but only a real one", async () => {
		await assert.rejects(locateDrawio({ DRAWIO_CANVAS_DRAWIO_DIR: tmpdir() }), /is not a draw\.io webapp/);
		assert.equal(PINNED.version, "31.4.6");
		assert.match(PINNED.sha256, /^[0-9a-f]{64}$/);
	});

	it("remembers draw.io's own preference keys, and only those", async () => {
		const cache = await mkdtemp(path.join(tmpdir(), "drawio-canvas-cache-"));
		try {
			const env = { DRAWIO_CANVAS_CACHE: cache };
			await writeSettings({ ".drawio-config": '{"libraries":"general;aws4;gcp2"}', "../evil": "x", ".configuration": 5 }, env);
			assert.deepEqual(await readSettings(env), { ".drawio-config": '{"libraries":"general;aws4;gcp2"}' });
			assert.match(await readFile(path.join(cache, "drawio-settings.json"), "utf8"), /aws4/);
			await writeSettings({ ".drawio-config": null }, env);
			assert.deepEqual(await readSettings(env), {});
		} finally {
			await rm(cache, { recursive: true, force: true });
		}
	});
});

describe("shape libraries", () => {
	it("finds current cloud icons first", () => {
		assert.equal(searchShapes("aws lambda").shapes[0].id, "aws4Compute/lambda");
		assert.equal(searchShapes("azure function").shapes[0].id, "azure2Compute/function-apps");
		assert.match(searchShapes("gcp bigquery").shapes[0].id, /^gcp/);
		assert.match(searchShapes("kubernetes pod").shapes[0].id, /^kubernetes\//);
		assert.ok(searchShapes("router", { library: "cisco" }).shapes.every((shape) => /cisco/i.test(shape.library)));
		assert.throws(() => searchShapes("  "), /needs a query/);
	});

	it("inserts a shape with draw.io's exact style, and expands templates with fresh ids", () => {
		const [lambda] = shapeOperations({ shape_id: "aws4Compute/lambda", cell_id: "fn", x: 10, y: 20, label: "Resize", style: { fillColor: "#000000" } });
		assert.equal(lambda.cell_id, "fn");
		assert.match(lambda.new_xml, /resIcon=mxgraph\.aws4\.lambda/);
		assert.match(lambda.new_xml, /fillColor=#000000/);
		assert.match(lambda.new_xml, /x="10" y="20" width="78" height="78"/);

		const template = searchShapes("cross functional flowchart").shapes.find((shape) => shape.kind === "template");
		const used = new Set(["lanes-2"]);
		const operations = shapeOperations({ shape_id: template.id, cell_id: "lanes", x: 100, y: 100 }, { usedIds: used });
		assert.ok(operations.length > 3);
		assert.equal(operations[0].cell_id, "lanes");
		assert.ok(!operations.some((operation) => operation.cell_id === "lanes-2"), "an id already in use is skipped");
		assert.match(operations[0].new_xml, /parent="1"/);
		assert.throws(() => shapeOperations({ shape_id: "nope", cell_id: "x" }), /search_shapes/);
		assert.match(decompressTemplate("<mxGraphModel/>"), /^<mxGraphModel/);
	});
});
