/**
 * Working with the agent, in the real draw.io: the person selects shapes, asks
 * from the bar, and sees the agent's status and reply — with draw.io itself
 * untouched.
 *
 * Skipped unless `DRAWIO_CANVAS_PLAYWRIGHT` names a playwright install (see
 * `test/drawio.test.mjs`).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { AgentLink } from "../lib/agent.mjs";
import { openCanvas, SAMPLE_XML } from "./harness.mjs";

const DRIVER = process.env.DRAWIO_CANVAS_PLAYWRIGHT;
const skip = DRIVER ? false : "set DRAWIO_CANVAS_PLAYWRIGHT to run the draw.io tests";

let browser;

before(async () => {
	if (skip) return;
	const specifier = DRIVER.endsWith(".js") || DRIVER.endsWith(".mjs") ? DRIVER : `${DRIVER.replace(/\/$/, "")}/index.js`;
	const module = await import(specifier);
	const playwright = module.chromium ? module : module.default;
	browser = await playwright.chromium.launch({ executablePath: process.env.DRAWIO_CANVAS_CHROMIUM || undefined, args: ["--no-sandbox"] });
});

after(async () => {
	await browser?.close();
});

/** A host session with the SDK's `send` and `on`. */
function fakeHost() {
	const handlers = new Map();
	const sent = [];
	return {
		sent,
		session: {
			send: async (options) => (sent.push(options), `m${sent.length}`),
			on: (type, handler) => (handlers.set(type, [...(handlers.get(type) ?? []), handler]), () => {}),
		},
		emit(type, data = {}) {
			for (const handler of handlers.get(type) ?? []) handler({ id: "e", timestamp: "t", parentId: null, ephemeral: true, type, data });
		},
	};
}

describe("working with the agent in draw.io", { skip }, () => {
	it("asks about the selection from the bar, shows the agent working, and its reply", { timeout: 240_000 }, async () => {
		const host = fakeHost();
		const agent = new AgentLink();
		agent.attach(host.session);
		const canvas = await openCanvas({ agent, input: { xml: SAMPLE_XML } });
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		const problems = [];
		page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
		try {
			await page.goto(canvas.url);
			await page.waitForFunction(() => window.drawioCanvas, null, { timeout: 180_000 });
			const frame = page.frame({ url: /drawio\/index\.html/ });

			// Idle is quiet: a dim dot and one word.
			await page.waitForFunction(() => !document.getElementById("agent").hidden);
			assert.equal(await page.textContent("#agent-hint"), "idle");

			// Select a shape in draw.io, then Alt+A from inside the diagram.
			await frame.evaluate(() => {
				const graph = window.drawioCanvasUi.editor.graph;
				graph.setSelectionCell(graph.model.getCell("check"));
			});
			await frame.evaluate(() => window.drawioCanvasUi.editor.graph.container.focus());
			await page.keyboard.press("Alt+KeyA");
			await page.waitForFunction(() => document.activeElement?.id === "ask");
			await page.keyboard.type("Make this a diamond with a yes/no edge");
			await page.keyboard.press("Enter");

			await page.waitForFunction(() => document.querySelectorAll("#asks-list .ask").length === 1);
			assert.equal(host.sent.length, 1, "an idle agent is asked at once");
			assert.match(host.sent[0].prompt, /#1 "Make this a diamond with a yes\/no edge" — cells check on "Flow"/);
			assert.equal(await page.textContent("#asks-count"), "1");

			// The agent starts: the chip says what it is doing.
			host.emit("assistant.turn_start");
			host.emit("tool.execution_start", { toolCallId: "c1", toolName: "invoke_canvas_action", toolTitle: "canvas: get_asks" });
			await canvas.invoke("get_asks", {});
			await canvas.invoke("update_ask", { id: 1, status: "working" });
			await page.waitForFunction(() => document.getElementById("agent").classList.contains("busy"));
			await page.waitForFunction(() => document.getElementById("agent-hint").textContent.includes("#1"));

			await canvas.invoke("update_ask", { id: 1, status: "done", reply: "It was already a diamond; added the no edge." });
			host.emit("session.idle");
			await page.click("#asks-toggle");
			await page.waitForFunction(() => document.querySelector("#asks-list .reply")?.textContent.includes("added the no edge"));
			await page.waitForFunction(() => document.getElementById("agent-hint").textContent === "idle");
			assert.equal(await page.isHidden("#asks-count"), true);

			// Clicking an ask points the person at its cells.
			await frame.evaluate(() => window.drawioCanvasUi.editor.graph.clearSelection());
			await page.click("#asks-list .ask .text");
			const selected = await frame.evaluate(() => window.drawioCanvasUi.editor.graph.getSelectionCells().map((cell) => cell.id));
			assert.deepEqual(selected, ["check"]);

			assert.deepEqual(problems, []);
		} finally {
			await page.close();
			await canvas.close();
		}
	});

	it("offers the person's unseen edits for review in one click", { timeout: 240_000 }, async () => {
		const host = fakeHost();
		const agent = new AgentLink();
		agent.attach(host.session);
		const canvas = await openCanvas({ agent, input: { xml: SAMPLE_XML } });
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		try {
			await page.goto(canvas.url);
			await page.waitForFunction(() => window.drawioCanvas, null, { timeout: 180_000 });
			await canvas.invoke("get_diagram", {});
			const frame = page.frame({ url: /drawio\/index\.html/ });
			await frame.evaluate(() => {
				const graph = window.drawioCanvasUi.editor.graph;
				graph.model.setValue(graph.model.getCell("start"), "Begin");
			});
			await page.waitForFunction(() => !document.getElementById("unseen").hidden);
			assert.match(await page.textContent("#unseen"), /1 edit since the agent looked/);
			assert.equal(host.sent.length, 0, "editing alone sends nothing");
			await page.click("#unseen");
			await page.waitForFunction(() => document.querySelectorAll("#asks-list .ask").length === 1);
			assert.equal(host.sent.length, 1);
			assert.match(host.sent[0].prompt, /cells start/);
		} finally {
			await page.close();
			await canvas.close();
		}
	});
	it("tidies in the person's editor as their own edit, and Ctrl+Z undoes it", { timeout: 240_000 }, async () => {
		const overlapping = SAMPLE_XML.replace('<mxGeometry x="60" y="180" width="120" height="80" as="geometry" />', '<mxGeometry x="100" y="60" width="120" height="80" as="geometry" />');
		const canvas = await openCanvas({ input: { xml: overlapping } });
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		try {
			await page.goto(canvas.url);
			await page.waitForFunction(() => window.drawioCanvas, null, { timeout: 180_000 });
			const frame = page.frame({ url: /drawio\/index\.html/ });
			const geometry = () =>
				frame.evaluate(() => {
					const model = window.drawioCanvasUi.editor.graph.model;
					return ["start", "check"].map((id) => {
						const g = model.getGeometry(model.getCell(id));
						return [g.x, g.y, g.width, g.height];
					});
				});
			const before = await geometry();
			await page.click("#tidy");
			const after = await geometry();
			const [[ax, ay, aw, ah], [bx, by]] = after;
			assert.ok(bx >= ax + aw || by >= ay + ah, `no longer overlapping: ${JSON.stringify(after)}`);
			assert.match(await page.textContent("#status"), /tidied the page: .*moved off an overlap/);

			// It reached the server as the person's edit.
			await page.waitForTimeout(300);
			const changes = await canvas.invoke("get_changes", {});
			assert.ok(changes.changes.some((line) => / human /.test(line)), JSON.stringify(changes.changes));

			await frame.evaluate(() => window.drawioCanvasUi.actions.get("undo").funct());
			assert.deepEqual(await geometry(), before);
		} finally {
			await page.close();
			await canvas.close();
		}
	});

	it("adds its items to draw.io's right-click menu and badges the cells of open asks", { timeout: 240_000 }, async () => {
		const host = fakeHost();
		const agent = new AgentLink();
		agent.attach(host.session);
		const canvas = await openCanvas({ agent, input: { xml: SAMPLE_XML } });
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		try {
			await page.goto(canvas.url);
			await page.waitForFunction(() => window.drawioCanvas, null, { timeout: 180_000 });
			const frame = page.frame({ url: /drawio\/index\.html/ });

			const labels = await frame.evaluate(() => {
				const ui = window.drawioCanvasUi;
				const graph = ui.editor.graph;
				const menu = new window.mxPopupMenu();
				menu.init();
				const items = [];
				const addItem = menu.addItem;
				menu.addItem = function (label, ...rest) {
					items.push(label);
					return addItem.call(this, label, ...rest);
				};
				graph.setSelectionCell(graph.model.getCell("start"));
				ui.menus.createPopupMenu(menu, graph.model.getCell("start"), null);
				menu.destroy();
				return items;
			});
			assert.ok(labels.includes("Ask the agent about this…"), JSON.stringify(labels));
			assert.ok(labels.includes("Tidy"));

			await canvas.fetch("api/collab", { method: "POST", body: JSON.stringify({ op: "ask", text: "Rename", page_id: "p1", cell_ids: ["start", "check"] }) });
			const overlays = () => frame.evaluate(() => ["start", "check", "link"].map((id) => window.drawioCanvasUi.editor.graph.getCellOverlays(window.drawioCanvasUi.editor.graph.model.getCell(id))?.length ?? 0));
			await page.waitForFunction(() => document.querySelectorAll("#asks-list .ask").length === 1);
			assert.deepEqual(await overlays(), [1, 1, 0]);
			await canvas.invoke("update_ask", { id: 1, status: "done" });
			await page.waitForFunction(() => document.querySelector("#asks-list .pill")?.textContent === "done");
			assert.deepEqual(await overlays(), [0, 0, 0]);
		} finally {
			await page.close();
			await canvas.close();
		}
	});
});
