#!/usr/bin/env node
/**
 * Build `data/shapes-<version>.json.gz`: every shape in draw.io's libraries,
 * with the exact style draw.io inserts, for the agent's `search_shapes` and
 * `insert_shapes` actions.
 *
 * Run once per draw.io pin, commit the output:
 *
 *   npm install --prefix /tmp/pw playwright
 *   DRAWIO_CANVAS_PLAYWRIGHT=/tmp/pw/node_modules/playwright node scripts/build-shape-index.mjs
 *
 * Why a browser: the libraries are not data files. They are JavaScript — each
 * palette is a function that builds its entries (`createVertexTemplateEntry(
 * style, w, h, value, title, …, tags)`) — so the only faithful way to list them
 * is to run draw.io and record the calls. The script loads the pinned editor,
 * hooks the entry constructors on the live sidebar, rebuilds every palette
 * (including the lazily built ones: GCP, Azure 2, …) and writes what it saw.
 * Nothing here runs when the canvas does.
 */

import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { DrawioProvider, PINNED } from "../lib/drawio-dist.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const driver = process.env.DRAWIO_CANVAS_PLAYWRIGHT;
if (!driver) {
	process.stderr.write("Set DRAWIO_CANVAS_PLAYWRIGHT to a playwright install, e.g. /tmp/pw/node_modules/playwright\n");
	process.exit(2);
}
const { chromium } = await import(pathToFileURL(path.join(driver, "index.mjs")).href);
const install = await new DrawioProvider().ensure();

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif", ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain" };
const HOST = `<!doctype html><html><body style="margin:0"><iframe id="f" style="border:0;width:100vw;height:100vh" src="index.html?embed=1&proto=json&offline=1&stealth=1&pwa=0&lang=en"></iframe>
<script src="host.js"></script></body></html>`;
const HOST_JS = `window.__loaded = false; addEventListener('message', (e) => { let d; try { d = JSON.parse(e.data) } catch { return }
if (d.event === 'init') document.getElementById('f').contentWindow.postMessage(JSON.stringify({ action: 'load', xml: '<mxfile><diagram id="p" name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>' }), '*');
if (d.event === 'load') window.__loaded = true; });`;
const CAPTURE = `window.checkAllLoaded = function () { if (mxScriptsLoaded && mxWinLoaded) App.main(function (ui) { window.__ui = ui; }); };`;

const server = createServer(async (request, response) => {
	const url = new URL(request.url, "http://127.0.0.1");
	const name = decodeURIComponent(url.pathname);
	if (name === "/host.html") return response.end(HOST);
	if (name === "/host.js") return response.end(HOST_JS);
	if (name === "/capture.js") return response.end(CAPTURE);
	try {
		let body = await readFile(path.join(install.dir, path.normalize(name).replace(/^[/\\]+/, "")));
		if (name === "/index.html") body = body.toString().replace('<script src="js/main.js">', '<script src="capture.js"></script><script src="js/main.js">');
		response.writeHead(200, { "Content-Type": types[path.extname(name)] ?? "application/octet-stream" });
		response.end(body);
	} catch {
		response.writeHead(404);
		response.end();
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(process.env.DRAWIO_CANVAS_CHROMIUM ? { executablePath: process.env.DRAWIO_CANVAS_CHROMIUM } : {});
const page = await browser.newPage();
await page.goto(`${base}/host.html`);
await page.waitForFunction(() => window.__loaded, null, { timeout: 120_000 });
const frame = page.frame({ url: /index\.html/ });

const raw = await frame.evaluate(async () => {
	const sb = window.__ui.sidebar;
	const proto = Object.getPrototypeOf(sb);
	const entries = [];
	let pending = [];
	let current = null;
	let group = null;
	const inits = [];
	const record = (entry) => {
		entry.group = group;
		if (current) entries.push({ ...entry, palette: current.id, library: current.title });
		else pending.push(entry);
	};
	const flush = (id, title) => {
		for (const entry of pending) entries.push({ ...entry, palette: id, library: title });
		pending = [];
	};
	const wrap = (name, fn) => {
		const original = proto[name];
		sb[name] = function (...args) {
			return fn.call(this, original, args);
		};
	};
	const text = (value) => (typeof value === "string" ? value : null);
	wrap("createVertexTemplateEntry", function (original, a) {
		record({ kind: "vertex", style: a[0], w: a[1], h: a[2], value: text(a[3]), title: a[4], tags: a[7] });
		return original.apply(this, a);
	});
	wrap("createEdgeTemplateEntry", function (original, a) {
		record({ kind: "edge", style: a[0], w: a[1], h: a[2], value: text(a[3]), title: a[4], tags: a[6] });
		return original.apply(this, a);
	});
	wrap("addDataEntry", function (original, a) {
		record({ kind: "template", tags: a[0], w: a[1], h: a[2], title: a[3], data: a[4] });
		return original.apply(this, a);
	});
	wrap("setCurrentSearchEntryLibrary", function (original, a) {
		group = a[0] || null;
		return original.apply(this, a);
	});
	wrap("addPaletteFunctions", function (original, a) {
		flush(a[0], a[1]);
		return original.apply(this, a);
	});
	wrap("addPalette", function (original, a) {
		const [id, title, , onInit] = a;
		if (!current) flush(id, title);
		if (typeof onInit === "function") {
			inits.push(() => {
				current = { id, title };
				try {
					onInit.call(sb, document.createElement("div"), document.createElement("div"));
				} catch {
					// A palette that needs a real DOM to build itself is skipped.
				}
				current = null;
			});
		}
		return original.apply(this, a);
	});
	sb.initPalettes();
	// Lazily built palettes create their entries in onInit; eager ones already
	// have theirs, and re-running their onInit would list them twice.
	const eager = new Set(entries.map((entry) => entry.palette));
	const before = entries.length;
	for (const init of inits) init();
	// Stencil palettes load their XML asynchronously.
	await new Promise((resolve) => setTimeout(resolve, 8000));
	return entries.filter((entry, index) => index < before || !eager.has(entry.palette));
});
await browser.close();
server.close();

const slug = (text) =>
	String(text ?? "")
		.toLowerCase()
		.replace(/<[^>]+>/g, " ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "") || "shape";

const libraries = [];
const libraryIndex = new Map();
const shapes = [];
const seen = new Set();
const ids = new Set();
for (const entry of raw) {
	if (!entry.palette || entry.palette === "search" || entry.palette.startsWith(".")) continue;
	const dedupe = `${entry.palette}\u0000${entry.title}\u0000${entry.style ?? ""}\u0000${entry.data ?? ""}`;
	if (seen.has(dedupe)) continue;
	seen.add(dedupe);
	if (!libraryIndex.has(entry.palette)) {
		libraryIndex.set(entry.palette, libraries.length);
		libraries.push({ id: entry.palette, title: entry.library ?? entry.palette, group: entry.group ?? null });
	}
	let id = `${entry.palette}/${slug(entry.title ?? entry.value)}`;
	for (let n = 2; ids.has(id); n += 1) id = `${entry.palette}/${slug(entry.title ?? entry.value)}-${n}`;
	ids.add(id);
	shapes.push([
		id,
		libraryIndex.get(entry.palette),
		entry.title ?? "",
		entry.kind,
		Math.round((entry.w ?? 0) * 100) / 100,
		Math.round((entry.h ?? 0) * 100) / 100,
		entry.style ?? null,
		entry.value || null,
		(entry.tags ?? "").trim() || null,
		entry.data ?? null,
	]);
}

const index = {
	format: 1,
	drawio: PINNED.version,
	columns: ["id", "library", "title", "kind", "w", "h", "style", "value", "tags", "data"],
	libraries,
	shapes,
};
const target = path.join(ROOT, "data", `shapes-${PINNED.version}.json.gz`);
await mkdir(path.dirname(target), { recursive: true });
const body = gzipSync(JSON.stringify(index), { level: 9 });
await writeFile(target, body);
process.stdout.write(`${shapes.length} shapes in ${libraries.length} libraries → ${path.relative(ROOT, target)} (${(body.length / 1e6).toFixed(2)} MB)\n`);
