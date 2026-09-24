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
});
