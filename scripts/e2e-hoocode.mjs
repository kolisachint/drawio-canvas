#!/usr/bin/env node
/**
 * The whole collaboration, end to end, through a real hoocode.
 *
 * Nothing here is stubbed except the model, and the model is a real HTTP server
 * speaking the OpenAI chat-completions protocol, so hoocode takes its ordinary
 * path: provider, tool schemas, argument preparation and validation, the canvas
 * tools, the forked extension. The person is Chromium, in the real draw.io.
 *
 *   1. installs this checkout as a plugin (`/plugin marketplace add`, `/plugin install`)
 *   2. opens it (`/canvas open drawio-canvas`) and loads draw.io in the browser
 *   3. the agent discovers the canvas and draws; the person sees it
 *   4. the person adds a shape; the agent is told, and builds on it
 *   5. the person relabels a cell; the agent's blind edit is refused *with the
 *      current cell*, and its very next call builds on the person's label
 *   6. the person asks from the canvas (Alt+A, typed, Enter): the idle agent is
 *      woken with one labelled message, reads the ask with its cells, does it,
 *      and its reply shows in the person's drawer
 *   7. the person selects a shape and types "this" in the terminal: the
 *      selection travels with the message, and the agent edits that shape
 *   8. reload_canvas keeps the person's tab: same URL, reconnects by itself
 *   9. every action runs once, timed host side
 *
 * The model sends every `input` JSON-encoded as a string, as Qwen through
 * OpenAI-compatible gateways does, so that path is exercised on every call.
 *
 *   HOOCODE_BIN=/path/to/hoocode/packages/coding-agent/bin/hoocode.js \
 *   DRAWIO_CANVAS_PLAYWRIGHT=/path/to/node_modules/playwright \
 *     node scripts/e2e-hoocode.mjs [--out <dir>]
 *
 * Exits non-zero on the first broken step. `--out` keeps screenshots and the
 * model's request log; otherwise everything is written to a temporary directory
 * and removed.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Resolved here: hoocode is spawned in the test workspace, where a relative path means nothing.
const BIN = process.env.HOOCODE_BIN && path.resolve(process.env.HOOCODE_BIN);
const DRIVER = process.env.DRAWIO_CANVAS_PLAYWRIGHT;
if (!BIN || !DRIVER) {
	console.error("Set HOOCODE_BIN (hoocode's bin/hoocode.js) and DRAWIO_CANVAS_PLAYWRIGHT (a playwright package directory).");
	process.exit(2);
}
const outFlag = process.argv.indexOf("--out");
const keep = outFlag > 0 ? path.resolve(process.argv[outFlag + 1]) : undefined;
const work = keep ?? mkdtempSync(path.join(tmpdir(), "drawio-canvas-e2e-"));
const HOME = path.join(work, "home");
const WS = path.join(work, "workspace");
for (const dir of [HOME, WS, path.join(HOME, ".hoocode")]) mkdirSync(dir, { recursive: true });

const t0 = Date.now();
const say = (...parts) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s`, ...parts);
function check(condition, message) {
	if (!condition) throw new Error(message);
}

// ------------------------------------------------------------------ the model

const cell = (id, label, x, y, style = "rounded=1;whiteSpace=wrap;html=1;") =>
	`<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="140" height="60" as="geometry"/></mxCell>`;
const box = (id, label, x, y, style) => ({ operation: "add", cell_id: id, new_xml: cell(id, label, x, y, style) });
const edge = (id, source, target) => ({
	operation: "add",
	cell_id: id,
	new_xml: `<mxCell id="${id}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
});
const textOf = (message) => (typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join(""));

/** Every action once, for the timing table. */
const BENCH = [
	["get_diagram", {}],
	["get_changes", {}],
	["search_shapes", { query: "kubernetes pod" }],
	["insert_shapes", { shapes: [{ shape_id: "aws4Compute/lambda", cell_id: "fn", x: 600, y: 300, label: "Resize" }] }],
	["edit_diagram", { operations: [box("note", "Bench", 40, 400)] }],
	["manage_pages", { op: "list" }],
	["manage_layers", { op: "list" }],
	["focus", { cell_ids: ["note"], message: "Here" }],
	["screenshot", {}],
	["layout", { layout: "horizontalFlow" }],
	["tidy", {}],
	["get_asks", { include_done: true }],
	["save_file", { path: "e2e.svg" }],
	["save_file", { path: "e2e.drawio" }],
];

/** The agent's next move, decided from what hoocode actually sent. */
function decide(body) {
	const messages = body.messages;
	let user = messages.length - 1;
	while (user >= 0 && messages[user].role !== "user") user--;
	const task = textOf(messages[user]);
	const results = messages.slice(user + 1).filter((message) => message.role === "tool").map(textOf);
	const tools = (body.tools ?? []).map((tool) => tool.function.name);
	if (!tools.includes("invoke_canvas_action")) return { text: `no canvas tools; offered: ${tools.join(", ")}` };
	let instanceId;
	for (const message of messages) {
		const found = message.role === "tool" && textOf(message).match(/"instanceId":\s*"([^"]+)"/);
		if (found) instanceId = found[1];
	}
	// JSON-encoded on purpose: the Qwen shape.
	const invoke = (action, input) => ({ tool: "invoke_canvas_action", args: { instanceId, action, input: JSON.stringify(input) } });
	const scripts = {
		DRAW: [
			() => ({ tool: "list_canvas_capabilities", args: {} }),
			() => invoke("get_diagram", {}),
			() =>
				invoke("edit_diagram", {
					operations: [
						box("web", "Web App", 40, 60),
						box("api", "API Gateway", 260, 60),
						box("db", "Orders DB", 480, 60, "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;"),
						edge("e1", "web", "api"),
						edge("e2", "api", "db"),
					],
				}),
			() => ({ text: "Drew Web App → API Gateway → Orders DB." }),
		],
		REACT: [
			() => invoke("get_changes", {}),
			() => {
				const added = [...results[0].matchAll(/added [^\n]*?\[([A-Za-z0-9_-]+)\]/g)].map((match) => match[1]);
				return invoke("edit_diagram", { operations: added.map((id, index) => edge(`link${index}`, "api", id)) });
			},
			() => ({ text: "Connected what you added to the API gateway." }),
		],
		STALE: [
			() => invoke("edit_diagram", { operations: [{ operation: "update", cell_id: "api", new_xml: cell("api", "API v2", 260, 60) }] }),
			() => {
				// The refusal carries the cell as it is now: build on the person's label, no re-read.
				const label = results[0].match(/<mxCell id="api"[^>]*? value="([^"]+)"/)?.[1];
				return invoke("edit_diagram", { operations: [{ operation: "update", cell_id: "api", new_xml: cell("api", `${label} v2`, 260, 60) }] });
			},
			() => ({ text: "Kept your label and versioned it." }),
		],
		// Woken by the canvas: the person asked from the bar.
		"[canvas drawio-canvas]": [
			() => invoke("get_asks", {}),
			() => {
				const ask = JSON.parse(results[0]).asks?.[0];
				const xml = ask?.cells_xml ?? "";
				const id = ask?.cell_ids?.[0];
				const labelled = xml.replace(/value="([^"]*)"/, 'value="$1 (asked)"');
				return invoke("edit_diagram", { operations: [{ operation: "update", cell_id: id, new_xml: labelled }] });
			},
			() => invoke("update_ask", { id: 1, status: "done", reply: "Marked the one you picked." }),
			() => ({ text: "Done what you asked on the canvas." }),
		],
		// Typed in the terminal with a canvas selection attached.
		PILL: [
			() => {
				const ids = task.match(/"cell_ids":\[([^\]]*)\]/)?.[1]?.match(/"([^"]+)"/g)?.map((id) => id.slice(1, -1)) ?? [];
				return invoke("get_diagram", { cell_ids: ids });
			},
			() => {
				const xml = JSON.parse(results[0]).cells_xml ?? "";
				const id = xml.match(/id="([^"]+)"/)?.[1];
				return invoke("edit_diagram", { operations: [{ operation: "update", cell_id: id, new_xml: xml.replace(/value="([^"]*)"/, 'value="$1 (this)"') }] });
			},
			() => ({ text: "Changed the one you had selected." }),
		],
		RELOAD: [() => ({ tool: "reload_canvas", args: { extensionId: "drawio-canvas" } }), () => ({ text: "Reloaded." })],
		BENCH: [...BENCH.map(([action, input]) => () => invoke(action, input)), () => ({ text: "Ran every action." })],
	};
	const script = scripts[Object.keys(scripts).find((key) => task.startsWith(key))] ?? [() => ({ text: "ok" })];
	return (script[results.length] ?? (() => ({ text: "done" })))();
}

const modelLog = path.join(work, "model-requests.jsonl");
writeFileSync(modelLog, "");
const model = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		if (!req.url.endsWith("/chat/completions")) return void res.writeHead(404).end();
		const body = JSON.parse(raw);
		const move = decide(body);
		appendFileSync(modelLog, `${JSON.stringify({ last: textOf(body.messages.at(-1) ?? {}), move })}\n`);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id: "e2e", object: "chat.completion.chunk", created: 0, model: "e2e", choices, ...extra })}\n\n`);
		if (move.text) {
			send([{ index: 0, delta: { role: "assistant", content: move.text }, finish_reason: null }]);
			send([{ index: 0, delta: {}, finish_reason: "stop" }]);
		} else {
			const call = { index: 0, id: `call_${Date.now()}`, type: "function", function: { name: move.tool, arguments: JSON.stringify(move.args) } };
			send([{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }]);
			send([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
		}
		send([], { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
writeFileSync(
	path.join(HOME, ".hoocode", "models.json"),
	JSON.stringify({
		providers: {
			e2e: {
				baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
				api: "openai-completions",
				apiKey: "e2e",
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
				models: [{ id: "scripted", name: "Scripted model", contextWindow: 128000, maxTokens: 4096 }],
			},
		},
	}),
);

// ------------------------------------------------------------------ hoocode

const hoocode = spawn(process.execPath, [BIN, "--mode", "rpc", "--model", "e2e/scripted", "--no-session"], {
	cwd: WS,
	env: { ...process.env, HOME, USERPROFILE: HOME },
	stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
hoocode.stderr.on("data", (chunk) => (stderr += chunk));
const events = [];
const waiters = [];
readline.createInterface({ input: hoocode.stdout }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	events.push({ at: Date.now(), message });
	if (process.env.E2E_VERBOSE && message.type !== "message_update") say("rpc:", line.slice(0, 300));
	if (message.type === "extension_ui_request" && message.method === "confirm") {
		hoocode.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, confirmed: true })}\n`);
	}
	for (const waiter of [...waiters]) {
		if (waiter.test(message)) {
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(message);
		}
	}
});
function until(test, what, ms = 60_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
		waiters.push({ test, resolve: (message) => (clearTimeout(timer), resolve(message)) });
	});
}
const send = (command) => hoocode.stdin.write(`${JSON.stringify(command)}\n`);
const notified = (pattern) => (message) => message.type === "extension_ui_request" && message.method === "notify" && pattern.test(message.message);
async function command(line, pattern, what) {
	const done = until(notified(pattern), what, 120_000);
	send({ type: "prompt", message: line });
	return (await done).message;
}
async function agent(message) {
	const from = events.length;
	const done = until((event) => event.type === "agent_end", `agent turn "${message}"`, 120_000);
	send({ type: "prompt", message });
	await done;
	return events.slice(from).map((event) => event.message).filter((event) => event.type === "tool_execution_end");
}

let browser;
const timings = [];
try {
	// 1. Install, the way a person does.
	await command(`/plugin marketplace add ${ROOT}`, /Added marketplace|already/i, "marketplace add");
	const installed = await command("/plugin install drawio-canvas --scope user", /Installed "drawio-canvas"|install failed|not found/i, "plugin install");
	check(/Installed/.test(installed), `install: ${installed}`);
	say("installed as a plugin");

	// 2. Open it, and load draw.io as the person.
	let started = Date.now();
	const opened = await command("/canvas open drawio-canvas", /Opened drawio-canvas|failed|cancelled|No canvas/i, "canvas open");
	const url = opened.match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)?.[0];
	check(url, `open: ${opened}`);
	timings.push(["/canvas open", Date.now() - started]);

	const entry = DRIVER.endsWith(".js") || DRIVER.endsWith(".mjs") ? DRIVER : `${DRIVER.replace(/\/$/, "")}/index.js`;
	const playwright = await import(entry).then((module) => (module.chromium ? module : module.default));
	browser = await playwright.chromium.launch({ executablePath: process.env.DRAWIO_CANVAS_CHROMIUM || undefined, args: ["--no-sandbox"] });
	const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
	const problems = [];
	page.on("pageerror", (error) => problems.push(error.message));
	started = Date.now();
	await page.goto(url);
	await page.waitForFunction(() => globalThis.drawioCanvas, null, { timeout: 120_000 });
	timings.push(["draw.io ready in the browser", Date.now() - started]);
	const graph = (body) => page.frame({ url: /drawio\/index\.html/ }).evaluate(`(() => { const g = window.drawioCanvasUi.editor.graph; ${body} })()`);
	const seen = (id) =>
		page.waitForFunction(
			(cellId) => [...document.querySelectorAll("iframe")].map((frame) => frame.contentWindow).find((w) => w?.drawioCanvasUi)?.drawioCanvasUi.editor.graph.model.getCell(cellId),
			id,
			{ timeout: 30_000 },
		);

	// 3. The agent discovers the canvas and draws; the person sees it.
	started = Date.now();
	const drawing = agent("DRAW a three-tier architecture");
	await seen("db");
	timings.push(["prompt → agent's shapes on the person's screen (3 model turns)", Date.now() - started]);
	const drew = await drawing;
	check(drew.every((call) => !call.isError), `draw: ${JSON.stringify(drew.filter((call) => call.isError))}`);
	const listing = drew[0].result.content[0].text;
	check(/"description":"A draw.io diagram/.test(listing), "the capability listing should carry the canvas description");
	check(/Speed \(measured\)/.test(listing), "the description should tell the model how fast actions are");
	if (keep) await page.screenshot({ path: path.join(work, "1-agent-drew.png") });
	say("agent drew; the person sees it");

	// 4. The person adds a shape; the agent is told, and builds on it.
	await graph(`g.insertVertex(g.getDefaultParent(), "cache", "Redis Cache", 260, 220, 140, 60, "shape=cylinder3;whiteSpace=wrap;html=1;");`);
	await page.waitForTimeout(500);
	const reacted = await agent("REACT to what I added");
	check(/Redis Cache/.test(reacted[0].result.content[0].text), "get_changes should report the person's shape");
	await seen("link0");
	if (keep) await page.screenshot({ path: path.join(work, "2-agent-built-on-it.png") });
	say("person added a cache; agent connected it");

	// 5. The person relabels a cell; the agent's blind edit is refused with the
	//    cell as it is now, and the next call builds on it without a re-read.
	await graph(`g.model.setValue(g.model.getCell("api"), "Public API");`);
	await page.waitForTimeout(500);
	const stale = await agent("STALE edit the api label");
	check(stale[0].isError && /stale_cells/.test(stale[0].result.content[0].text), "the blind edit should be refused");
	check(!stale[1].isError, `the retry should apply: ${stale[1].result.content[0].text}`);
	const label = await graph(`return g.model.getCell("api").value;`);
	check(label === "Public API v2", `the person's label should survive: got "${label}"`);
	say(`blind edit refused; retry built on the person's label → "${label}"`);

	// 6. The person asks from the canvas; the idle agent is woken, does it, replies.
	const frame = () => page.frame({ url: /drawio\/index\.html/ });
	await graph(`g.setSelectionCell(g.model.getCell("db"));`);
	await frame().evaluate(() => window.drawioCanvasUi.editor.graph.container.focus());
	started = Date.now();
	const woken = until((event) => event.type === "agent_end", "the agent woken by the canvas", 120_000);
	await page.keyboard.press("Alt+KeyA");
	await page.keyboard.type("Mark this one");
	await page.keyboard.press("Enter");
	await woken;
	timings.push(["ask from the canvas → agent done (4 model turns)", Date.now() - started]);
	await page.click("#asks-toggle");
	await page.waitForFunction(() => document.querySelector("#asks-list .reply")?.textContent.includes("Marked the one you picked"), null, { timeout: 10_000 });
	const marked = await graph(`return g.model.getCell("db").value;`);
	check(marked === "Orders DB (asked)", `the ask's cell should be changed: got "${marked}"`);
	if (keep) await page.screenshot({ path: path.join(work, "3-ask-done.png") });
	await page.click("#asks-toggle");
	say("person asked from the canvas; agent woke, did it, replied in the drawer");

	// 7. "this" in the terminal means the canvas selection.
	await graph(`g.setSelectionCell(g.model.getCell("web"));`);
	await page.waitForTimeout(800);
	const pill = await agent("PILL make this stand out");
	check(pill.every((call) => !call.isError), `pill: ${JSON.stringify(pill.map((call) => call.result?.content?.[0]?.text))}`);
	const thisLabel = await graph(`return g.model.getCell("web").value;`);
	check(thisLabel === "Web App (this)", `"this" should be the selected cell: got "${thisLabel}"`);
	say('typed "this" in the terminal; the agent changed the selected shape');

	// 8. reload_canvas keeps the person's tab.
	await agent("RELOAD the canvas");
	await page.waitForFunction(() => document.getElementById("status").textContent.includes("restarted"), null, { timeout: 30_000 });
	check(page.url().startsWith(url), "the tab stays on the same URL");
	say("reload_canvas: the person's tab reconnected by itself");

	// 9. Every action once, timed.
	const starts = new Map();
	const from = events.length;
	await agent("BENCH every action");
	for (const { at, message } of events.slice(from)) {
		if (message.type === "tool_execution_start") starts.set(message.toolCallId, { at, action: message.args?.action, input: message.args?.input });
		if (message.type === "tool_execution_end") {
			const start = starts.get(message.toolCallId);
			check(!message.isError, `${start.action}: ${message.result?.content?.[0]?.text}`);
			timings.push([`  ${start.action}${start.action === "save_file" ? ` ${JSON.parse(start.input).path}` : ""}`, at - start.at]);
		}
	}
	check(problems.length === 0, `browser errors: ${problems.join("; ")}`);

	console.log("\nTimings (host side, real processes, real browser):");
	for (const [what, ms] of timings) console.log(`  ${String(ms).padStart(6)} ms  ${what}`);
	console.log("\nPASS");
} catch (error) {
	say("FAIL:", error.message);
	if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-15).join("\n"));
	process.exitCode = 1;
} finally {
	await browser?.close();
	hoocode.kill();
	model.close();
	if (!keep) rmSync(work, { recursive: true, force: true });
}
