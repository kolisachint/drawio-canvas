#!/usr/bin/env node
/**
 * The whole collaboration, end to end, in VS Code's Chat view: the Copilot
 * agent a person uses with their own subscription, and the canvas as the MCP
 * server this plugin declares (`.mcp.json` → `mcp.mjs`).
 *
 * Nothing is stubbed but the model. VS Code is real (desktop, under a display),
 * the plugin is installed the way a person installs it ("Chat: Install Plugin
 * from Source", given this checkout's folder: VS Code reads the marketplace in
 * `.github/plugin/`, asks to trust it, installs), and the person is a person:
 * they pick the model in the Chat view,
 * type in it, approve tools in VS Code's own confirmation, and draw in draw.io
 * in VS Code's Integrated Browser. The model is a real HTTP server speaking
 * OpenAI chat completions, added as a custom-endpoint model (Manage Models →
 * Custom Endpoint), that decides each move from what VS Code sent — as a
 * Copilot model would, without an account.
 *
 *   1. VS Code finds the plugin, starts its MCP server, and gives the agent the
 *      canvas's tools and instructions
 *   2. the agent opens the canvas and shows it in the Integrated Browser
 *      (open_browser_page); reads run without asking, the first edit asks once
 *      and the person allows the server's tools for the session
 *   3. the person adds a shape and relabels one; the agent is told of the first,
 *      its blind edit of the second is refused with the cell attached, and its
 *      retry builds on the person's label
 *   4. the person asks from the canvas's bar; the bar tells them how to start
 *      the agent; they send the server's `asks` prompt; the agent does it and
 *      replies in the drawer
 *   5. "this" in the chat means the canvas selection
 *   6. screenshot: the model gets the image itself
 *   7. the MCP server is restarted: the person's tab keeps its URL and
 *      reconnects, and the diagram survives
 *   8. every tool once, timed from the model's call to VS Code's next request
 *
 *   VSCODE_BIN=/path/to/VSCode-linux-x64/code \
 *   DRAWIO_CANVAS_PLAYWRIGHT=/path/to/node_modules/playwright \
 *     xvfb-run -a node scripts/e2e-vscode-chat.mjs [--out <dir>] [--install cli]
 *
 * `--install cli` (with COPILOT_BIN) installs the plugin the way the README's
 * Copilot CLI section does instead — `copilot plugin marketplace add` from a git
 * URL, `copilot plugin install` — and VS Code finds it there by itself: one
 * install for both. The checkout's working tree is served over git's smart HTTP
 * (`git http-backend`) as a stand-in for GitHub.
 *
 * Exits non-zero on the first broken step. `--out` keeps screenshots, VS Code's
 * logs and the model's request log.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const option = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const VSCODE = process.env.VSCODE_BIN && path.resolve(process.env.VSCODE_BIN);
const DRIVER = process.env.DRAWIO_CANVAS_PLAYWRIGHT;
if (!VSCODE || !DRIVER) {
	console.error("Set VSCODE_BIN (the code executable) and DRAWIO_CANVAS_PLAYWRIGHT (a playwright package directory), and run under a display (xvfb-run -a).");
	process.exit(2);
}
const INSTALL = option("--install") ?? "source";
const COPILOT = process.env.COPILOT_BIN && path.resolve(process.env.COPILOT_BIN);
if (!["source", "cli"].includes(INSTALL) || (INSTALL === "cli" && !COPILOT)) {
	console.error("--install is source (default) or cli; cli needs COPILOT_BIN (the copilot executable).");
	process.exit(2);
}
const keep = option("--out") && path.resolve(option("--out"));
const work = keep ?? mkdtempSync(path.join(tmpdir(), "drawio-canvas-vscode-chat-e2e-"));
const HOME = path.join(work, "home");
// Its own path per run: a canvas parked by an earlier run's server in the same
// workspace less than a minute ago would otherwise be taken back (as it should be).
const WS = path.join(work, `workspace-${Date.now().toString(36)}`);
const USER_DATA = path.join(work, "user-data");
for (const dir of [HOME, WS, path.join(USER_DATA, "User")]) mkdirSync(dir, { recursive: true });

const t0 = Date.now();
const say = (...parts) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s`, ...parts);
function check(condition, message) {
	if (!condition) throw new Error(message);
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
/** A tool result: the canvas's JSON, or its refusal ("code: message"). */
const json = (text) => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};
const refused = (text) => /^[a-z_]+: /.test(text) && json(text) === undefined;

/** Every tool once, for the timing table. */
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
	["save_file", { path: "e2e.png" }],
	["save_file", { path: "e2e.drawio" }],
];

const gates = new Map();
const gate = (name) => {
	if (!gates.has(name)) {
		let open;
		const promise = new Promise((resolve) => (open = resolve));
		gates.set(name, { promise, open });
	}
	return gates.get(name);
};

/** A call of one of the canvas's tools, by its short name (VS Code prefixes it). */
const use = (name, args = {}) => ({ tool: name, args });
let canvasUrl;
const SCRIPTS = {
	"E2E-DRAW": [
		() => use("open_canvas"),
		({ results }) => {
			canvasUrl = json(results[0])?.url;
			return { tool: "open_browser_page", args: { url: canvasUrl } };
		},
		async () => {
			await gate("person-ready").promise;
			return use("get_diagram");
		},
		() =>
			use("edit_diagram", {
				operations: [box("web", "Web App", 40, 60), box("api", "API Gateway", 260, 60), box("db", "Orders DB", 480, 60, "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;"), edge("e1", "web", "api"), edge("e2", "api", "db")],
			}),
		() => ({ text: "Drew Web App → API Gateway → Orders DB." }),
	],
	"E2E-STALE": [
		() => use("edit_diagram", { operations: [{ operation: "update", cell_id: "api", new_xml: cell("api", "API v2", 260, 60) }] }),
		({ results }) => {
			// The refusal carries the cell as it is now: build on the person's label, no re-read.
			const label = results[0].match(/<mxCell id="api"[^>]*? value="([^"]+)"/)?.[1];
			return use("edit_diagram", { operations: [{ operation: "update", cell_id: "api", new_xml: cell("api", `${label} v2`, 260, 60) }] });
		},
		({ results }) => {
			// That result also says what else the person did meanwhile: connect it.
			const added = (json(results[1])?.person?.changes ?? []).flatMap((line) => [...line.matchAll(/added .*?\[([A-Za-z0-9_-]+)\]/g)].map((match) => match[1]));
			return use("edit_diagram", { operations: added.map((id, index) => edge(`link${index}`, "api", id)) });
		},
		() => ({ text: "Kept your label and connected what you added." }),
	],
	// The person's `asks` prompt from the server, sent from the Chat input.
	"Check my asks on the draw.io canvas": [
		() => use("get_asks"),
		({ results }) => {
			const ask = json(results[0])?.asks?.[0];
			const labelled = (ask?.cells_xml ?? "").replace(/value="([^"]*)"/, 'value="$1 (asked)"');
			return use("edit_diagram", { operations: [{ operation: "update", cell_id: ask?.cell_ids?.[0], new_xml: labelled }] });
		},
		() => use("update_ask", { id: 1, status: "done", reply: "Marked the one you picked." }),
		() => ({ text: "Done what you asked on the canvas." }),
	],
	"E2E-THIS": [
		() => use("get_changes"),
		({ results }) => use("get_diagram", { cell_ids: json(results[0])?.looking_at?.selected ?? [] }),
		({ results }) => {
			const xml = json(results[1])?.cells_xml ?? "";
			const id = xml.match(/id="([^"]+)"/)?.[1];
			return use("edit_diagram", { operations: [{ operation: "update", cell_id: id, new_xml: xml.replace(/value="([^"]*)"/, 'value="$1 (this)"') }] });
		},
		() => ({ text: "Changed the one you had selected." }),
	],
	"E2E-SHOT": [() => use("screenshot"), () => ({ text: "Looked at it." })],
	"E2E-RESUMED": [() => use("get_diagram"), () => ({ text: "Still here." })],
	"E2E-BENCH": [...BENCH.map(([name, args]) => () => use(name, args)), () => ({ text: "Ran every tool." })],
};
const KEYS = Object.keys(SCRIPTS);

const turns = [];
const turnWaiters = [];
const requestLog = path.join(work, "model-requests.jsonl");
writeFileSync(requestLog, "");

/** Which script a request belongs to, its task, the tool results so far, and what VS Code offered. */
function parse(body) {
	const messages = body.messages;
	let at = messages.length - 1;
	let key;
	for (; at >= 0; at--) {
		if (messages[at].role !== "user") continue;
		key = KEYS.find((candidate) => textOf(messages[at]).includes(candidate));
		if (key) break;
	}
	const after = at >= 0 ? messages.slice(at + 1) : [];
	return {
		key: key ?? "(none)",
		task: at >= 0 ? textOf(messages[at]) : "",
		// A tool's own text is its first part; VS Code adds images and a reference after it.
		results: after.filter((message) => message.role === "tool").map((message) => (Array.isArray(message.content) ? (message.content.find((part) => part.type === "text")?.text ?? "") : textOf(message))),
		// Images VS Code sent with this request (a tool's image comes as a user part after the result).
		images: after.flatMap((message) => (Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_url") : [])).length,
		tools: (body.tools ?? []).map((tool) => tool.function.name),
		system: textOf(messages.find((message) => message.role === "system") ?? {}),
	};
}

/** VS Code's name for one of the canvas's tools: mcp_<server>_<tool>. */
const fullName = (tools, short) => tools.find((name) => name.startsWith("mcp_") && name.endsWith(`_${short}`)) ?? tools.find((name) => name === short);

async function decide(turn) {
	if (turn.key === "(none)") return { text: "ok" };
	const step = SCRIPTS[turn.key][turn.results.length] ?? (() => ({ text: "done" }));
	const move = await step(turn);
	if (move.tool) {
		const name = fullName(turn.tools, move.tool);
		if (!name) return { text: `no ${move.tool} tool; offered: ${turn.tools.join(", ")}` };
		return { tool: name, args: move.args };
	}
	return move;
}

const model = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", async () => {
		if (!req.url.endsWith("/chat/completions")) {
			res.writeHead(200, { "content-type": "application/json" });
			return void res.end(JSON.stringify({ object: "list", data: [{ id: "scripted", object: "model" }] }));
		}
		const body = JSON.parse(raw);
		if (keep) appendFileSync(path.join(work, "model-requests-full.jsonl"), `${raw}\n`);
		const turn = { ...parse(body), arrived: Date.now() };
		turns.push(turn);
		const move = await decide(turn);
		Object.assign(turn, { move, answered: Date.now() });
		appendFileSync(requestLog, `${JSON.stringify({ at: turn.arrived - t0, key: turn.key, results: turn.results.length, images: turn.images, last: turn.results.at(-1)?.slice(0, 1500), move })}\n`);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id: "e2e", object: "chat.completion.chunk", created: 0, model: "scripted", choices, ...extra })}\n\n`);
		if (move.text) {
			send([{ index: 0, delta: { role: "assistant", content: move.text }, finish_reason: null }]);
			send([{ index: 0, delta: {}, finish_reason: "stop" }]);
		} else {
			const call = { index: 0, id: `call_${turns.length}`, type: "function", function: { name: move.tool, arguments: JSON.stringify(move.args) } };
			send([{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }]);
			send([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
		}
		send([], { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
		res.end("data: [DONE]\n\n");
		if (move.text) {
			for (const waiter of [...turnWaiters]) {
				if (waiter.key !== turn.key) continue;
				turnWaiters.splice(turnWaiters.indexOf(waiter), 1);
				waiter.resolve({ ...turn, requests: turns.filter((item) => item.key === turn.key && item.arrived >= waiter.since) });
			}
		}
	});
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));

/** Resolves with the turn's last request once the script for `key` has answered with its closing text. */
function turnEnd(key, ms = 120_000) {
	const ended = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for the ${key} turn to end`)), ms);
		turnWaiters.push({ key, since: Date.now(), resolve: (value) => (clearTimeout(timer), resolve(value)) });
	});
	// Awaited later, maybe after another step failed: never an unhandled rejection that skips the cleanup.
	ended.catch(() => {});
	return ended;
}

// ------------------------------------------------------------------ VS Code

const freePort = () =>
	new Promise((resolve) => {
		const server = net.createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

writeFileSync(
	path.join(USER_DATA, "User", "settings.json"),
	JSON.stringify(
		{
			"workbench.browser.openLocalhostLinks": true,
			// No account in this test: the model is the person's own endpoint.
			"chat.allowAnonymousAccess": true,
			"workbench.welcomePage.experimentalOnboarding": false,
			"workbench.startupEditor": "none",
			"security.workspace.trust.enabled": false,
			"update.mode": "none",
			"telemetry.telemetryLevel": "off",
			"extensions.autoCheckUpdates": false,
		},
		null,
		1,
	),
);
// Manage Models → Add Models → Custom Endpoint, as a person adds their own model.
writeFileSync(
	path.join(USER_DATA, "User", "chatLanguageModels.json"),
	JSON.stringify([
		{
			name: "E2E",
			vendor: "customendpoint",
			models: [{ id: "scripted", name: "Scripted", url: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, toolCalling: true, vision: true, maxInputTokens: 128000, maxOutputTokens: 4096 }],
		},
	]),
);

const leftovers = [];
let cdp;
let win;
let page;
const problems = [];
const confirmations = [];
const timings = [];
let started;

async function launch() {
	const port = await freePort();
	const child = spawn(
		VSCODE,
		[
			"--no-sandbox",
			"--disable-gpu",
			`--user-data-dir=${USER_DATA}`,
			`--extensions-dir=${path.join(work, "extensions")}`,
			`--remote-debugging-port=${port}`,
			"--skip-release-notes",
			"--disable-workspace-trust",
			// No keyring under a bare display: VS Code's secret storage would wait on one.
			"--password-store=basic",
			WS,
		],
		{ cwd: WS, env: { ...process.env, HOME }, stdio: ["ignore", "pipe", "pipe"] },
	);
	leftovers.push(child);
	const playwright = await import(entryOf(DRIVER)).then((module) => (module.chromium ? module : module.default));
	for (let attempt = 0; !cdp; attempt++) {
		try {
			cdp = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		} catch (cause) {
			check(attempt < 120 && child.exitCode === null, `VS Code did not come up: ${cause.message}`);
			await wait(500);
		}
	}
	for (let attempt = 0; !win; attempt++) {
		win = pages().find((candidate) => candidate.url().includes("workbench.html"));
		check(attempt < 120, "VS Code's workbench window never appeared");
		if (!win) await wait(250);
	}
	await win.waitForSelector(".monaco-workbench", { timeout: 60_000 });
}
const entryOf = (driver) => (driver.endsWith(".js") || driver.endsWith(".mjs") ? driver : `${driver.replace(/\/$/, "")}/index.js`);
const pages = () => cdp.contexts().flatMap((context) => context.pages());

/**
 * "Chat: Install Plugin from Source" with this checkout's folder, as a person
 * with a clone does (with GitHub, they type kolisachint/drawio-canvas instead).
 * VS Code finds the marketplace in `.github/plugin/`, asks to trust it, and
 * installs its one plugin.
 */
async function installFromSource() {
	await win.keyboard.press("F1");
	await win.waitForSelector(".quick-input-widget", { state: "visible", timeout: 10_000 });
	await win.keyboard.type("Chat: Install Plugin from Source", { delay: 5 });
	await win.locator(".quick-input-list .monaco-list-row").filter({ hasText: "Install Plugin from Source" }).first().waitFor({ timeout: 10_000 });
	await win.keyboard.press("Enter");
	await win.waitForFunction(() => /GitHub repository, git URL, or local folder/.test(document.querySelector(".quick-input-widget")?.textContent ?? ""), null, { timeout: 10_000 });
	await win.keyboard.type(ROOT, { delay: 2 });
	await win.keyboard.press("Enter");
	await win.getByRole("button", { name: "Trust" }).click({ timeout: 30_000 });
	// Installed: the next prompt checks that its tools reach the model.
	await wait(2000);
	await win.keyboard.press("Escape");
}

/** The Chat view's input. */
const chatInput = () => win.locator(".interactive-input-part .monaco-editor").first();

/** Pick the person's model in the Chat view's model picker (it appears once Copilot Chat has started). */
async function pickModel(name) {
	for (let attempt = 0; ; attempt++) {
		check(attempt < 40, `the model picker never offered "${name}"`);
		const current = win.locator(".interactive-input-part").getByText(/^(Auto|Scripted)$/).first();
		if ((await current.textContent().catch(() => "")) === name) return;
		await current.click({ timeout: 5000 }).catch(() => {});
		await wait(1000);
		const option = win.locator(".action-widget").getByText(name, { exact: true }).first();
		if (await option.count()) {
			await option.click();
			await wait(500);
			return;
		}
		// A fresh profile has not started Copilot Chat's model providers yet; the
		// person's way to their own model, Manage Models, does.
		const manage = win.locator(".action-widget").getByText("Manage Models...").first();
		if (attempt % 5 === 0 && (await manage.count())) {
			await manage.click().catch(() => {});
			await wait(4000);
		}
		await win.keyboard.press("Escape");
		await wait(2000);
	}
}

/** Type into the Chat view and send, as the person does. */
async function chat(text) {
	await chatInput().click({ timeout: 10_000 });
	await win.keyboard.type(text, { delay: 5 });
	await wait(300);
	if (text.startsWith("/")) {
		// An MCP prompt: accepted from the suggestion list, VS Code asks the server
		// for it and puts its text in the input, which the person then sends.
		for (let attempt = 0; (await chatText()).includes(text); attempt++) {
			check(attempt < 40, `VS Code did not expand ${text}: ${await chatText()}`);
			if (attempt % 10 === 0) await win.keyboard.press("Tab");
			await wait(250);
		}
		await wait(300);
	}
	await win.keyboard.press("Enter");
}
const chatText = () => win.locator(".interactive-input-part .view-lines").first().textContent().then((value) => value.replace(/\u00a0/g, " "));

/** Send a message and wait for its script to finish. */
async function agent(text, key = text.split(" ")[0]) {
	const done = turnEnd(key);
	await chat(text);
	return done;
}

/**
 * The person answers VS Code's tool confirmations. The first one from the
 * canvas's server is allowed for all its tools for the session, from the Allow
 * dropdown, as a person who does not want to be asked again does; anything else
 * (VS Code's own browser tool) with the primary button.
 */
async function approveLoop() {
	while (!approveLoop.stop) {
		try {
			const widget = win.locator(".chat-confirmation-widget2, .chat-confirmation-widget").filter({ has: win.locator(".chat-confirmation-widget-buttons") }).last();
			if (await widget.count()) {
				const title = ((await widget.locator(".chat-confirmation-widget-title").first().textContent()) ?? "").replace(/\s+/g, " ").trim();
				confirmations.push({ at: Date.now(), title });
				let done = false;
				if (/drawio-canvas/.test(title)) {
					await widget.locator(".monaco-dropdown-button").first().click({ timeout: 3000 });
					await wait(300);
					const item = win.locator(".action-label").filter({ hasText: /^Allow Tools from drawio-canvas in this Session$/ }).first();
					if (await item.count()) {
						await item.click({ timeout: 3000 });
						done = true;
					} else await win.keyboard.press("Escape");
				}
				if (!done) await widget.locator(".chat-confirmation-widget-buttons .monaco-button").filter({ hasText: /^Allow/ }).first().click({ timeout: 3000 });
				await wait(500);
			}
		} catch {
			// The widget went away mid-click: look again.
		}
		await wait(150);
	}
}

/** The person's draw.io: the Integrated Browser tab once the agent opened it. */
const frame = () => page.frame({ url: /drawio\/index\.html/ });
const graph = (body) => frame().evaluate(`(() => { const g = window.drawioCanvasUi.editor.graph; ${body} })()`);
const seen = (id) =>
	page.waitForFunction((cellId) => [...document.querySelectorAll("iframe")].map((f) => f.contentWindow).find((w) => w?.drawioCanvasUi)?.drawioCanvasUi.editor.graph.model.getCell(cellId), id, { timeout: 30_000 });
const shot = async (name) => keep && (await win.screenshot({ path: path.join(work, name) }).catch(() => {}));

try {
	// 1. VS Code, the plugin, the model.
	if (INSTALL === "cli") say(`installed with the Copilot CLI: ${await installWithCopilot()}`);
	started = Date.now();
	await launch();
	// Keybindings are live a little after the workbench renders: ask until the Chat view is there.
	for (let attempt = 0; !(await win.locator(".interactive-input-part").isVisible().catch(() => false)); attempt++) {
		check(attempt < 30, "VS Code never opened the Chat view");
		await win.keyboard.press("Control+Alt+KeyI").catch(() => {});
		await wait(2000);
	}
	await pickModel("Scripted");
	timings.push(["VS Code start → Chat ready with the person's model", Date.now() - started]);
	say("VS Code is up; the Chat view has the person's model");
	if (INSTALL === "source") {
		started = Date.now();
		await installFromSource();
		timings.push(["Install Plugin from Source → installed", Date.now() - started]);
		say("installed with Chat: Install Plugin from Source (this folder), after trusting it");
	}
	void approveLoop();

	// 2. The agent opens the canvas and shows it beside the chat.
	started = Date.now();
	const drawing = turnEnd("E2E-DRAW");
	await chat("E2E-DRAW a three-tier architecture on the canvas");
	const first = await (async () => {
		for (const deadline = Date.now() + 120_000; Date.now() < deadline; await wait(100)) {
			const found = turns.find((turn) => turn.key === "E2E-DRAW");
			if (found) return found;
		}
		throw new Error("the model was never asked");
	})();
	const canvasTools = first.tools.filter((name) => /^mcp_drawio-canvas_/.test(name)).map((name) => name.replace(/^mcp_drawio-canvas_/, ""));
	check(canvasTools.length === 17 && canvasTools.includes("open_canvas") && canvasTools.includes("edit_diagram"), `VS Code should offer the canvas's 17 tools: ${first.tools.join(", ")}`);
	check(first.system.includes("Start with open_canvas"), "the server's instructions should reach the model");
	check(first.tools.includes("open_browser_page"), "VS Code's browser tool should be there to show the canvas");
	timings.push(["prompt → model asked, MCP server started and listed", first.arrived - started]);
	say(`VS Code started the plugin's MCP server: ${canvasTools.length} tools (mcp_drawio-canvas_*), and its instructions`);

	for (let attempt = 0; !page; attempt++) {
		page = canvasUrl && pages().find((candidate) => candidate.url().startsWith(canvasUrl));
		check(attempt < 480, `VS Code did not open the canvas in its Integrated Browser (${canvasUrl ?? "no url yet"})`);
		if (!page) await wait(250);
	}
	page.on("pageerror", (error) => problems.push(error.message));
	await page.waitForFunction(() => globalThis.drawioCanvas, null, { timeout: 120_000 });
	timings.push(["prompt → draw.io ready in the Integrated Browser", Date.now() - started]);
	gate("person-ready").open();
	const drew = await drawing;
	await seen("db");
	check(drew.results.every((result) => !refused(result)), `draw: ${drew.results.join("\n").slice(0, 600)}`);
	const browserResult = drew.results[1];
	timings.push(["prompt → the agent's shapes in the person's draw.io", Date.now() - started]);
	await shot("1-agent-drew.png");
	const canvasPrompts = confirmations.filter((item) => /drawio-canvas/.test(item.title));
	check(canvasPrompts.length === 1 && /Open the draw\.io canvas/.test(canvasPrompts[0].title), `one confirmation for the canvas's tools, then none: ${JSON.stringify(confirmations)}`);
	check(!confirmations.some((item) => /Read the diagram/.test(item.title)), "a read-only tool should run without asking");
	say(`the agent opened the canvas in VS Code's Integrated Browser and drew; VS Code asked once ("${canvasPrompts[0].title.slice(0, 60)}…"), allowed for the session; open_browser_page returned ${browserResult.length} characters`);

	// 3. The person adds a shape and relabels one.
	await graph(`g.insertVertex(g.getDefaultParent(), "cache", "Redis Cache", 260, 220, 140, 60, "shape=cylinder3;whiteSpace=wrap;html=1;");`);
	await graph(`g.model.setValue(g.model.getCell("api"), "Public API");`);
	await page.waitForTimeout(500);
	const stale = await agent("E2E-STALE edit the api label");
	check(refused(stale.results[0]) && /^stale_cells: /.test(stale.results[0]) && /Public API/.test(stale.results[0]), `the blind edit should be refused with the cell attached: ${stale.results[0].slice(0, 300)}`);
	check(!refused(stale.results[1]), `the retry should apply: ${stale.results[1]}`);
	check(/Redis Cache/.test(stale.results[1]), `the retry's result should report the person's new shape: ${stale.results[1].slice(0, 400)}`);
	check(!refused(stale.results[2]), `connecting it should apply: ${stale.results[2]}`);
	await seen("link0");
	const label = await graph(`return g.model.getCell("api").value;`);
	check(label === "Public API v2", `the person's label should survive: got "${label}"`);
	say(`person added a cache and relabelled the API; the agent's blind edit was refused with the cell, its retry kept the label ("${label}") and connected the cache`);

	// 4. The person asks from the bar; the bar says how to start the agent; they do.
	await graph(`g.setSelectionCell(g.model.getCell("db"));`);
	await frame().evaluate(() => window.drawioCanvasUi.editor.graph.container.focus());
	await page.keyboard.press("Alt+KeyA");
	await page.keyboard.type("Mark this one");
	await page.keyboard.press("Enter");
	await page.click("#asks-toggle");
	await page.waitForFunction(() => /\/mcp\.drawio-canvas\.asks/.test(document.getElementById("delivery-note").textContent), null, { timeout: 10_000 });
	const note = (await page.textContent("#delivery-note")).trim();
	started = Date.now();
	const asked = await agent("/mcp.drawio-canvas.asks", "Check my asks on the draw.io canvas");
	timings.push(["asks prompt sent → the agent's reply in the drawer (4 model turns)", Date.now() - started]);
	check(!refused(asked.results[0]) && /Mark this one/.test(asked.results[0]), `get_asks should return the ask: ${asked.results[0].slice(0, 300)}`);
	await page.waitForFunction(() => document.querySelector("#asks-list .reply")?.textContent.includes("Marked the one you picked"), null, { timeout: 10_000 });
	const marked = await graph(`return g.model.getCell("db").value;`);
	check(marked === "Orders DB (asked)", `the ask's cell should be changed: got "${marked}"`);
	await shot("2-ask-done.png");
	await page.click("#asks-toggle");
	say(`person asked from the bar ("${note.slice(0, 70)}…"), sent /mcp.drawio-canvas.asks; the agent did it and replied in the drawer`);

	// 5. "this" means the canvas selection.
	await graph(`g.setSelectionCell(g.model.getCell("web"));`);
	await page.waitForTimeout(800);
	const that = await agent("E2E-THIS make this stand out");
	check(JSON.stringify(json(that.results[0])?.looking_at?.selected) === '["web"]', `get_changes should say what is selected: ${that.results[0].slice(0, 300)}`);
	check((await graph(`return g.model.getCell("web").value;`)) === "Web App (this)", '"this" should be the selected cell');
	say('"this" in the chat: the agent found the selection in looking_at and changed it');

	// 6. The screenshot reaches the model as an image.
	const looked = await agent("E2E-SHOT look at it");
	const shotResult = json(looked.results[0]);
	check(shotResult?.path?.endsWith(".png") && /person's draw\.io.*attached/.test(shotResult.note), `screenshot should be draw.io's render, attached: ${looked.results[0].slice(0, 300)}`);
	check(looked.images > 0, "VS Code should hand the screenshot to the model as an image");
	say(`screenshot: rendered by the person's draw.io, and the model got the image (${looked.images})`);

	// 7. The MCP server is restarted (VS Code does on a reload or a config change).
	const server = mcpServerPids();
	check(server.length === 1, `one MCP server process: ${server.join(", ")}`);
	await page.evaluate(() => (document.getElementById("status").textContent = ""));
	process.kill(server[0], "SIGTERM");
	await wait(1000);
	started = Date.now();
	const resumed = await agent("E2E-RESUMED look at the diagram");
	await page.waitForFunction(() => /restarted|reconnected/i.test(document.getElementById("status").textContent), null, { timeout: 30_000 });
	check(page.url().startsWith(canvasUrl), "the tab stays on the same URL");
	check(/Web App \(this\)/.test(resumed.results[0]), `the diagram should survive the restart: ${resumed.results[0].slice(0, 300)}`);
	timings.push(["MCP server killed → next prompt answered, tab reconnected", Date.now() - started]);
	say("MCP server restarted: VS Code started it again, it took the canvas back, and the person's tab reconnected on its URL");

	// 8. Every tool once.
	const bench = await agent("E2E-BENCH every tool");
	for (let index = 0; index < BENCH.length; index++) {
		const [name, args] = BENCH[index];
		const result = bench.requests[index + 1]?.results[index] ?? "";
		check(!refused(result), `${name}: ${result.slice(0, 300)}`);
		timings.push([`  ${name}${name === "save_file" ? ` ${args.path}` : ""}`, bench.requests[index + 1].arrived - bench.requests[index].answered]);
	}
	check(problems.length === 0, `browser errors: ${problems.join("; ")}`);
	check(confirmations.filter((item) => /drawio-canvas/.test(item.title)).length === 1, `VS Code should not ask again for the canvas's tools: ${JSON.stringify(confirmations)}`);
	await shot("3-bench.png");
	say("every tool ran through VS Code's Chat");

	console.log("\nTimings (VS Code Chat, MCP):");
	for (const [what, ms] of timings) console.log(`  ${what.padEnd(62)} ${String(ms).padStart(6)} ms`);
	console.log("\nPASS");
} catch (error) {
	console.error(`\nFAIL: ${error.message}`);
	await shot("failure.png");
	process.exitCode = 1;
} finally {
	approveLoop.stop = true;
	await Promise.race([cdp?.close().catch(() => {}), wait(5000)]);
	for (const child of leftovers) child.kill("SIGTERM");
	await wait(1500);
	for (const child of leftovers) child.kill("SIGKILL");
	model.close();
	if (keep) say(`kept ${work}`);
	process.exit();
}

/** The canvas's MCP server processes (Linux: read from /proc). */
function mcpServerPids() {
	const pids = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			if (readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").some((arg) => arg.endsWith(`${path.sep}mcp.mjs`) && (arg.startsWith(ROOT) || arg.startsWith(HOME)))) pids.push(Number(name));
		} catch {
			// Gone meanwhile.
		}
	}
	return pids;
}

/**
 * Install the plugin as a Copilot CLI user does, from a git URL: this working
 * tree, committed into a scratch repository and served by `git http-backend`.
 */
async function installWithCopilot() {
	const repo = path.join(work, "drawio-canvas.git");
	const git = (args, cwd) => {
		const run = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@localhost", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@localhost" } });
		check(run.status === 0, `git ${args.join(" ")}: ${run.stderr}`);
		return run.stdout;
	};
	git(["init", "-q", "-b", "main", repo]);
	for (const file of git(["ls-files", "-co", "--exclude-standard", "-z"], ROOT).split("\0").filter(Boolean)) {
		if (!existsSync(path.join(ROOT, file))) continue;
		mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
		cpSync(path.join(ROOT, file), path.join(repo, file));
	}
	git(["add", "-A"], repo);
	git(["commit", "-qm", "e2e snapshot"], repo);
	git(["config", "http.receivepack", "false"], repo);
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://localhost");
		const cgi = spawn("git", ["http-backend"], {
			env: { ...process.env, GIT_PROJECT_ROOT: work, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"] ?? "", GIT_PROTOCOL: req.headers["git-protocol"] ?? "" },
		});
		req.pipe(cgi.stdin);
		let head = Buffer.alloc(0);
		let started = false;
		cgi.stdout.on("data", (chunk) => {
			if (started) return void res.write(chunk);
			head = Buffer.concat([head, chunk]);
			const at = head.indexOf("\r\n\r\n");
			if (at < 0) return;
			started = true;
			let status = 200;
			const headers = {};
			for (const line of head.subarray(0, at).toString().split("\r\n")) {
				const [key, ...value] = line.split(": ");
				if (key.toLowerCase() === "status") status = Number.parseInt(value.join(": "), 10);
				else headers[key] = value.join(": ");
			}
			res.writeHead(status, headers);
			res.write(head.subarray(at + 4));
		});
		cgi.stdout.on("end", () => res.end());
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	leftovers.push({ kill: () => server.close() });
	// Not spawnSync: the git server above runs on this process's event loop.
	const copilot = (args) =>
		new Promise((resolve) => {
			const child = spawn(COPILOT, args, { cwd: WS, env: { ...process.env, HOME, COPILOT_AUTO_UPDATE: "false" } });
			let out = "";
			child.stdout.on("data", (chunk) => (out += chunk));
			child.stderr.on("data", (chunk) => (out += chunk));
			const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
			child.on("close", () => (clearTimeout(timer), resolve(out.trim())));
		});
	const added = await copilot(["plugin", "marketplace", "add", `http://127.0.0.1:${server.address().port}/drawio-canvas.git`]);
	check(/added successfully|already/i.test(added), `marketplace add: ${added}`);
	const installed = await copilot(["plugin", "install", "drawio-canvas@drawio-canvas"]);
	check(/installed successfully/i.test(installed), `plugin install: ${installed}`);
	const config = readFileSync(path.join(HOME, ".copilot", "config.json"), "utf8");
	const record = config.match(/"cache_path":\s*"([^"]+)"/)?.[1];
	check(record?.startsWith(path.join(HOME, ".copilot", "installed-plugins")), `the CLI should record a copy under ~/.copilot/installed-plugins: ${config}`);
	return path.relative(HOME, record);
}
