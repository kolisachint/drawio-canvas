/**
 * The lite editor (`ui/lite/`, the fallback used when draw.io cannot be
 * fetched), in a real browser, with a real agent editing underneath it.
 * `test/drawio.test.mjs` covers the draw.io editor itself.
 *
 * This covers the lite editor's pointer gestures, the live
 * reload over SSE, and the fact that the page's own edits come back as the same
 * cell operations the agent sends. Everything it drives is real: a forked-free
 * but otherwise complete canvas, its loopback server, and Chromium.
 *
 * It is skipped unless `DRAWIO_CANVAS_PLAYWRIGHT` points at a `playwright-core`
 * install, because the extension directory may not contain a `package.json` or
 * `node_modules` (see `test/protocol.test.mjs`) — so the browser driver is
 * installed *outside* the repository and named through the environment. CI does
 * that in `.github/workflows/ci.yml`; locally:
 *
 *   npm install --prefix /tmp/pw playwright-core
 *   DRAWIO_CANVAS_PLAYWRIGHT=/tmp/pw/node_modules/playwright-core \
 *   DRAWIO_CANVAS_CHROMIUM=$(ls -d /path/to/chrome) node --test test/browser.test.mjs
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openCanvas } from "./harness.mjs";

const DRIVER = process.env.DRAWIO_CANVAS_PLAYWRIGHT;
const skip = DRIVER ? false : "set DRAWIO_CANVAS_PLAYWRIGHT to run the browser tests";

let canvas;
let browser;
let page;

/** The shapes currently drawn, by cell id. */
const drawn = () => page.locator("#content [data-cell]");

before(async () => {
	if (skip) return;
	// A directory is not an ES module specifier, so point at the entry file when
	// the variable names the package directory.
	const specifier = DRIVER.endsWith(".js") || DRIVER.endsWith(".mjs") ? DRIVER : `${DRIVER.replace(/\/$/, "")}/index.js`;
	const module = await import(specifier);
	const playwright = module.chromium ? module : module.default;
	canvas = await openCanvas({});
	browser = await playwright.chromium.launch({
		executablePath: process.env.DRAWIO_CANVAS_CHROMIUM || undefined,
		args: ["--no-sandbox"],
	});
	page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
	page.on("pageerror", (error) => {
		throw error;
	});
	await page.goto(`${canvas.url}lite/`, { waitUntil: "load" });
	await page.waitForSelector("#status");
});

after(async () => {
	await browser?.close();
	await canvas?.close();
});

describe("the editor in a browser", { skip }, () => {
	it("loads, connects, and says the page is empty", async () => {
		await page.waitForFunction(() => document.getElementById("status").textContent === "connected");
		assert.equal(await page.locator("#empty-hint").isVisible(), true);
		assert.deepEqual(await page.locator(".tab").allTextContents(), ["Page-1"]);
	});

	it("inserts a shape from the toolbar and tells the extension about it", async () => {
		await page.click('[data-insert="rounded"]');
		await page.waitForFunction(() => document.querySelectorAll("#content [data-cell]").length === 1);
		const result = await canvas.invoke("get_diagram", {});
		assert.equal(result.page.shapes, 1);
		assert.equal(await page.locator("#empty-hint").isVisible(), false);
	});

	it("moves a shape by dragging it, snapped to the grid", async () => {
		const before = await canvas.invoke("get_diagram", {});
		const box = await drawn().first().boundingBox();
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 120, { steps: 10 });
		await page.mouse.up();
		await page.waitForTimeout(300);
		const after = await canvas.invoke("get_diagram", {});
		assert.notEqual(after.cells_xml, before.cells_xml);
		const [, x, y] = after.cells_xml.match(/<mxGeometry x="(-?\d+)" y="(-?\d+)"/);
		assert.equal(Number(x) % 10, 0);
		assert.equal(Number(y) % 10, 0);
	});

	it("connects two shapes by dragging from a port", async () => {
		await page.click('[data-insert="ellipse"]');
		await page.waitForTimeout(200);
		await page.keyboard.press("Escape");
		const source = await drawn().first().boundingBox();
		const target = await drawn().last().boundingBox();
		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.waitForSelector('#overlay [data-port="s"]');
		const port = await page.locator('#overlay [data-port="s"]').boundingBox();
		await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
		await page.mouse.down();
		await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
		await page.mouse.up();
		await page.waitForTimeout(300);
		assert.equal((await canvas.invoke("get_diagram", {})).page.edges, 1);
		assert.match((await canvas.invoke("get_diagram", {})).cells_xml, /edge="1"[^>]*source="s1"/);
	});

	it("edits a label in place", async () => {
		const box = await drawn().first().boundingBox();
		await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
		await page.waitForSelector("#label-editor:not([hidden])");
		await page.keyboard.press("ControlOrMeta+A");
		await page.keyboard.type("Typed by hand");
		await page.keyboard.press("Enter");
		await page.waitForTimeout(300);
		assert.match((await canvas.invoke("get_diagram", { cell_ids: ["s1"] })).cells_xml, /value="Typed by hand"/);
	});

	it("shows the agent's edit without a reload, and marks what changed", async () => {
		const before = await drawn().count();
		await canvas.invoke("edit_diagram", {
			operations: [
				{
					operation: "add",
					cell_id: "from-agent",
					new_xml: '<mxCell value="From the agent" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;" vertex="1" parent="1"><mxGeometry x="400" y="360" width="160" height="60" as="geometry"/></mxCell>',
				},
			],
		});
		await page.waitForFunction((count) => document.querySelectorAll("#content [data-cell]").length === count, before + 1);
		assert.equal(await page.locator('#content [data-cell="from-agent"].touched-agent').count(), 1);
		assert.match(await page.textContent("#status"), /agent/);
	});

	it("deletes with the keyboard, taking attached edges with it", async () => {
		await page.click('#content [data-cell="from-agent"] rect');
		await page.keyboard.press("Delete");
		await page.waitForTimeout(300);
		assert.equal(await page.locator('#content [data-cell="from-agent"]').count(), 0);
		const edgesBefore = (await canvas.invoke("get_diagram", {})).page.edges;
		await page.click("#content [data-cell='s1'] rect");
		await page.keyboard.press("Delete");
		await page.waitForTimeout(300);
		const after = await canvas.invoke("get_diagram", {});
		assert.equal(after.page.edges, edgesBefore - 1);
	});

	it("adds a page and switches between tabs", async () => {
		await page.click("#add-page");
		await page.waitForFunction(() => document.querySelectorAll(".tab").length === 2);
		assert.deepEqual((await canvas.invoke("manage_pages", { op: "list" })).pages.map((item) => item.name), ["Page-1", "Page-2"]);
		await page.click(".tab >> nth=0");
		await page.waitForTimeout(200);
		assert.equal(await page.locator('.tab[aria-selected="true"]').textContent(), "Page-1");
	});

	it("shows version history with a thumbnail of each version", async () => {
		await page.click("#history");
		await page.waitForSelector(".version");
		assert.ok((await page.locator(".version").count()) > 1);
		await page.waitForFunction(() => [...document.querySelectorAll(".version img")].every((image) => image.complete && image.naturalWidth > 0));
		await page.click("#sheet-cancel");
	});

	it("survives the whole session with no console errors", async () => {
		const failures = await page.evaluate(() => window.__errors ?? []);
		assert.deepEqual(failures, []);
	});
});
