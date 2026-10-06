#!/usr/bin/env node
/**
 * The whole collaboration, end to end, through the real GitHub Copilot runtime.
 *
 * Nothing here is stubbed except the model: a real HTTP server that speaks
 * OpenAI chat completions, reached through Copilot's bring-your-own-key
 * provider, decides each move from what Copilot sent. The person is Chromium,
 * in the real draw.io. Copilot hosts the canvas one of two ways (`--host`):
 *
 *   tui  The Copilot CLI's interactive terminal, in a pseudo-terminal, exactly
 *        as a person starts it (`copilot --experimental`), with this checkout
 *        installed through `copilot plugin marketplace add` / `plugin install`.
 *        The default.
 *   sdk  The way VS Code's Agents window hosts Copilot canvases (and the
 *        GitHub Copilot app): a `CopilotClient` from `@github/copilot-sdk`
 *        with the session flags VS Code's agent host sets — `requestExtensions`,
 *        `requestCanvasRenderer`, `extensionSdkPath`, the plugin passed as a
 *        `pluginDirectories` entry — and extensions launched through an
 *        extension launch provider as VS Code launches them (its own Node, the
 *        runtime's bootstrap, `VSCODE_CANVAS_DATA_DIR`). The URL comes from the
 *        `session.canvas.opened` event, which VS Code shows in a Chromium
 *        BrowserView; here Chromium loads it directly.
 *   vscode  Real VS Code (desktop, under a display): the Copilot CLI started in
 *        VS Code's integrated terminal, and the person Ctrl+clicks the link it
 *        prints, which VS Code opens in its Integrated Browser
 *        (`workbench.browser.openLocalhostLinks`). The person then works in that
 *        VS Code tab, driven over the DevTools protocol. This is how the canvas
 *        is used in VS Code today: VS Code's Chat view does not host canvases.
 *
 *   1. the canvas is installed (tui) or handed over as a plugin directory (sdk)
 *   2. the agent opens the canvas the Copilot way (`open_canvas`, input null)
 *      and draws; the host offers the URL; the person loads it and sees the shapes
 *   3. while the agent works, the person's bar shows it busy (Copilot's
 *      `session.on` events reach the canvas)
 *   4. the person adds a shape; the agent is told, and builds on it
 *   5. the person relabels a cell; the agent's blind edit is refused *with the
 *      current cell*, and its very next call builds on the person's label
 *   6. the person asks from the canvas (Alt+A, typed, Enter): the idle agent is
 *      woken by the canvas's `session.send`, reads the ask with its cells, does
 *      it, and its reply shows in the person's drawer
 *   7. the person selects a shape and types "this": the agent learns the
 *      selection (a pill where the host shows one, else `looking_at` on its
 *      first call)
 *   8. the host restarts the canvas process (`extensions_reload` in the
 *      terminal, `session.extensions.reload` from the SDK): the person's tab
 *      stays on its URL, reconnects by itself, and the diagram and asks survive
 *   9. every action runs once, timed host side
 *  10. the person pauses: the idle digest reaches the agent once (--digest)
 *  11. with a display (--native, tui), the Copilot CLI's own canvas window
 *      loads draw.io and the agent's screenshot is rendered by it
 *
 *   COPILOT_BIN=/path/to/node_modules/.bin/copilot \
 *   DRAWIO_CANVAS_PLAYWRIGHT=/path/to/node_modules/playwright \
 *     node scripts/e2e-copilot.mjs [--out <dir>] [--digest] [--native]
 *
 *   VSCODE_BIN=/path/to/VSCode-linux-x64/code COPILOT_BIN=… DRAWIO_CANVAS_PLAYWRIGHT=… \
 *     xvfb-run -a node scripts/e2e-copilot.mjs --host vscode [--out <dir>] [--digest]
 *
 *   COPILOT_SDK=/path/to/node_modules/@github/copilot-sdk \
 *   DRAWIO_CANVAS_PLAYWRIGHT=/path/to/node_modules/playwright \
 *     node scripts/e2e-copilot.mjs --host sdk [--out <dir>] [--digest]
 *
 * The terminal is bridged through Python's `pty` module (Node has none built in,
 * and the extension directory takes no dependencies), so `--host tui` needs
 * `python3` on a POSIX system. Exits non-zero on the first broken step. `--out`
 * keeps the terminal transcript, Copilot's logs, screenshots and the model's
 * request log.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const option = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const HOST = option("--host") ?? "tui";
const BIN = process.env.COPILOT_BIN && path.resolve(process.env.COPILOT_BIN);
const SDK = process.env.COPILOT_SDK && path.resolve(process.env.COPILOT_SDK);
const VSCODE = process.env.VSCODE_BIN && path.resolve(process.env.VSCODE_BIN);
const DRIVER = process.env.DRAWIO_CANVAS_PLAYWRIGHT;
if (!["tui", "sdk", "vscode"].includes(HOST) || !DRIVER || (HOST !== "sdk" && !BIN) || (HOST === "sdk" && !SDK) || (HOST === "vscode" && !VSCODE)) {
	console.error(
		"Set DRAWIO_CANVAS_PLAYWRIGHT (a playwright package directory), and COPILOT_BIN (the copilot executable) for --host tui, COPILOT_SDK (the @github/copilot-sdk package directory) for --host sdk, or VSCODE_BIN and COPILOT_BIN for --host vscode.",
	);
	process.exit(2);
}
/** The Copilot CLI in a terminal: on its own (tui), or in VS Code's integrated terminal (vscode). */
const TERMINAL = HOST !== "sdk";
const flag = (name) => process.argv.includes(name);
const keep = option("--out") && path.resolve(option("--out"));
const work = keep ?? mkdtempSync(path.join(tmpdir(), "drawio-canvas-copilot-e2e-"));
const HOME = path.join(work, "home");
const WS = path.join(work, "workspace");
const LOGS = path.join(work, "copilot-logs");
for (const dir of [HOME, WS, LOGS]) mkdirSync(dir, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: WS });

const t0 = Date.now();
const say = (...parts) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s`, ...parts);
function check(condition, message) {
	if (!condition) throw new Error(message);
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ the model

const INSTANCE = "drawio-1";
const cell = (id, label, x, y, style = "rounded=1;whiteSpace=wrap;html=1;") =>
	`<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="140" height="60" as="geometry"/></mxCell>`;
const box = (id, label, x, y, style) => ({ operation: "add", cell_id: id, new_xml: cell(id, label, x, y, style) });
const edge = (id, source, target) => ({
	operation: "add",
	cell_id: id,
	new_xml: `<mxCell id="${id}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
});
const textOf = (message) => (typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join(""));
/** An invoke_canvas_action result is `{"result": …}`; a refusal is plain text. */
const resultOf = (text) => {
	try {
		const parsed = JSON.parse(text);
		return parsed?.result ?? parsed;
	} catch {
		return undefined;
	}
};
const failed = (text) => /^Canvas operation failed|^Invalid input|^Error/.test(text);

/** Every action once, for the timing table. */
const BENCH = [
	["get_diagram", null],
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

/** The cell ids a selection pill carried into the person's message, if the host attached one. */
const pillIds = (task) => task.match(/\\?"cell_ids\\?":\s*\[([^\]]*)\]/)?.[1]?.match(/[A-Za-z0-9_-]+/g) ?? [];
/** Mark the one cell a get_diagram result returned, as the agent's edit. */
const markThis = (result) => {
	const xml = resultOf(result)?.cells_xml ?? "";
	const id = xml.match(/id="([^"]+)"/)?.[1];
	return invoke("edit_diagram", { operations: [{ operation: "update", cell_id: id, new_xml: xml.replace(/value="([^"]*)"/, 'value="$1 (this)"') }] });
};

/** Read the canvas after a restart; re-open it if the host asks for that first. */
const AFTER_RELOAD = [
	() => invoke("get_diagram", null),
	({ results }) => (failed(results.at(-1)) ? { tool: "open_canvas", args: { canvasId: "drawio-canvas", instanceId: INSTANCE, input: null } } : { text: "Reloaded." }),
	() => invoke("get_diagram", null),
	() => ({ text: "Reloaded." }),
];

/** Things a script step waits on, released by the test. */
const gates = new Map();
const gate = (name) => {
	if (!gates.has(name)) {
		let open;
		const promise = new Promise((resolve) => (open = resolve));
		gates.set(name, { promise, open });
	}
	return gates.get(name);
};

/**
 * The agent's scripts, keyed by a word in the message that starts the turn.
 * Each step sees the tool results so far in this turn (text, as Copilot sent
 * them) and the turn's user message.
 */
const invoke = (actionName, input) => ({ tool: "invoke_canvas_action", args: { instanceId: INSTANCE, actionName, input } });
const SCRIPTS = {
	"E2E-DRAW": [
		() => ({ tool: "list_canvas_capabilities", args: { canvasId: "drawio-canvas" } }),
		// null is what Copilot's tool description tells a model to send for "no input".
		() => ({ tool: "open_canvas", args: { canvasId: "drawio-canvas", instanceId: INSTANCE, input: null } }),
		async () => {
			// Hold the turn open until the person's draw.io is up, so the bar can be
			// seen showing the agent at work.
			await gate("person-ready").promise;
			return invoke("get_diagram", null);
		},
		async () => {
			await gate("busy-seen").promise;
			return invoke("edit_diagram", {
				operations: [
					box("web", "Web App", 40, 60),
					box("api", "API Gateway", 260, 60),
					box("db", "Orders DB", 480, 60, "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;"),
					edge("e1", "web", "api"),
					edge("e2", "api", "db"),
				],
			});
		},
		() => ({ text: "Drew Web App → API Gateway → Orders DB." }),
	],
	"E2E-REACT": [
		() => invoke("get_changes", {}),
		({ results }) => {
			const lines = resultOf(results[0])?.changes ?? [];
			const added = lines.flatMap((line) => [...line.matchAll(/added .*?\[([A-Za-z0-9_-]+)\]/g)].map((match) => match[1]));
			return invoke("edit_diagram", { operations: added.map((id, index) => edge(`link${index}`, "api", id)) });
		},
		() => ({ text: "Connected what you added to the API gateway." }),
	],
	"E2E-STALE": [
		() => invoke("edit_diagram", { operations: [{ operation: "update", cell_id: "api", new_xml: cell("api", "API v2", 260, 60) }] }),
		({ results }) => {
			// The refusal carries the cell as it is now: build on the person's label, no re-read.
			const label = results[0].match(/<mxCell id=\\?"api\\?"[^>]*? value=\\?"([^"\\]+)\\?"/)?.[1];
			return invoke("edit_diagram", { operations: [{ operation: "update", cell_id: "api", new_xml: cell("api", `${label} v2`, 260, 60) }] });
		},
		() => ({ text: "Kept your label and versioned it." }),
	],
	// Woken by the canvas: the person asked from the bar.
	"asked for help on the draw.io canvas": [
		() => invoke("get_asks", null),
		({ results }) => {
			const ask = resultOf(results[0])?.asks?.[0];
			const xml = ask?.cells_xml ?? "";
			const id = ask?.cell_ids?.[0];
			const labelled = xml.replace(/value="([^"]*)"/, 'value="$1 (asked)"');
			return invoke("edit_diagram", { operations: [{ operation: "update", cell_id: id, new_xml: labelled }] });
		},
		() => invoke("update_ask", { id: 1, status: "done", reply: "Marked the one you picked." }),
		() => ({ text: "Done what you asked on the canvas." }),
	],
	// Typed in the terminal with shapes selected. A host that shows extension
	// pills attaches the selection to the message; one that does not (Copilot
	// CLI's terminal) leaves the agent to find it in person.looking_at.selected,
	// as the canvas description tells it to.
	"E2E-PILL": [
		({ task }) => (pillIds(task).length ? invoke("get_diagram", { cell_ids: pillIds(task) }) : invoke("get_changes", null)),
		({ task, results }) => (pillIds(task).length ? markThis(results[0]) : invoke("get_diagram", { cell_ids: resultOf(results[0])?.looking_at?.selected ?? [] })),
		({ task, results }) => (pillIds(task).length ? { text: "Changed the one you had selected." } : markThis(results[1])),
		() => ({ text: "Changed the one you had selected." }),
	],
	// After every extension process was restarted: by the agent's own
	// extensions_reload in the terminal, by the host (as VS Code would) otherwise.
	"E2E-RELOAD": [...(TERMINAL ? [() => ({ tool: "extensions_reload", args: {} })] : []), ...AFTER_RELOAD],
	// After the person restarted Copilot: read, re-opening first if asked to.
	"E2E-RESUMED": AFTER_RELOAD,
	"E2E-BENCH": [...BENCH.map(([action, input]) => () => invoke(action, input)), () => ({ text: "Ran every action." })],
	"paused after editing the draw.io canvas": [() => invoke("get_changes", null), () => ({ text: "Looks fine; nothing to fix." })],
	"E2E-NATIVE": [
		() => ({ tool: "open_canvas", args: { canvasId: "drawio-canvas", instanceId: "native-1", input: null } }),
		async () => {
			await gate("native-editor").promise;
			return { tool: "invoke_canvas_action", args: { instanceId: "native-1", actionName: "edit_diagram", input: { operations: [box("hello", "Hello from Copilot", 80, 80)] } } };
		},
		() => ({ tool: "invoke_canvas_action", args: { instanceId: "native-1", actionName: "screenshot", input: { path: "native.png" } } }),
		() => ({ text: "Drew in the native window." }),
	],
};
const KEYS = Object.keys(SCRIPTS);

/** Turn bookkeeping: what each task's requests looked like, and who is waiting for its end. */
const turns = [];
const turnWaiters = [];
const requestLog = path.join(work, "model-requests.jsonl");
writeFileSync(requestLog, "");

/** Which script a request belongs to, its task message, and the tool results so far in the turn. */
function parse(body) {
	const messages = body.messages;
	// The turn's task is the latest user message naming a script; Copilot may add
	// its own user-role context after it, so the very last user message is not enough.
	let at = messages.length - 1;
	let key;
	for (; at >= 0; at--) {
		if (messages[at].role !== "user") continue;
		key = KEYS.find((candidate) => textOf(messages[at]).includes(candidate));
		if (key) break;
	}
	return {
		key: key ?? "(none)",
		task: at >= 0 ? textOf(messages[at]) : textOf(messages.at(-1) ?? {}),
		results: messages.slice(at + 1).filter((message) => message.role === "tool").map(textOf),
		tools: (body.tools ?? []).map((tool) => tool.function.name),
	};
}

/** The agent's next move for a parsed request. */
async function decide({ key, task, results, tools }) {
	if (key === "(none)") return { text: "ok" };
	if (!tools.includes("invoke_canvas_action")) return { text: `no canvas tools; offered: ${tools.join(", ")}` };
	const step = SCRIPTS[key][results.length] ?? (() => ({ text: "done" }));
	return step({ task, results });
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
		// Recorded on arrival: a step may hold its answer until the test releases it.
		const turn = { ...parse(body), arrived: Date.now() };
		turns.push(turn);
		const move = await decide(turn);
		Object.assign(turn, { move, answered: Date.now() });
		const { key, results, task } = turn;
		appendFileSync(requestLog, `${JSON.stringify({ at: turn.arrived - t0, key, results: results.length, last: textOf(body.messages.at(-1) ?? {}).slice(0, 2000), move })}\n`);
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
				if (waiter.key === key) {
					turnWaiters.splice(turnWaiters.indexOf(waiter), 1);
					waiter.resolve({ results, task, requests: turns.filter((turn) => turn.key === key && turn.arrived >= waiter.since) });
				}
			}
		}
	});
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));

/** The first request matching `test`, once it has arrived. */
async function request(test, what, ms = 60_000) {
	for (const deadline = Date.now() + ms; Date.now() < deadline; await wait(50)) {
		const found = turns.find(test);
		if (found) return found;
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Resolves when the script for `key` has answered with its closing text. */
function turnEnd(key, ms = 120_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for the ${key} turn to end`)), ms);
		turnWaiters.push({ key, since: Date.now(), resolve: (value) => (clearTimeout(timer), resolve(value)), cancel: () => (clearTimeout(timer), resolve(undefined)) });
	});
}

// ------------------------------------------------------------------ copilot

const copilotEnv = (extra = {}) => ({
	...process.env,
	HOME,
	USERPROFILE: HOME,
	COPILOT_HOME: path.join(HOME, ".copilot"),
	COPILOT_OFFLINE: "true",
	COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
	COPILOT_MODEL: "scripted",
	COPILOT_PROVIDER_MAX_PROMPT_TOKENS: "128000",
	COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
	// Trusts the workspace (so its plugins load) and approves tools without asking.
	COPILOT_ALLOW_ALL: "true",
	COPILOT_AUTO_UPDATE: "false",
	TERM: "xterm-256color",
	...extra,
});
const command = (args) => (BIN.endsWith(".js") ? [process.execPath, [BIN, ...args]] : [BIN, args]);

function copilotCli(args) {
	const [program, argv] = command(args);
	const run = spawnSync(program, argv, { cwd: WS, env: copilotEnv(), encoding: "utf8", timeout: 120_000 });
	return `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
}

/**
 * A pseudo-terminal, from Python's standard library. It also sets the window
 * size, which the TUI reads before it draws anything.
 */
const PTY_BRIDGE = `
import os, pty, sys, select, signal, struct, fcntl, termios
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
def stop(*_):
    try: os.kill(pid, signal.SIGTERM)
    except OSError: pass
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
inp = sys.stdin.fileno()
while True:
    ready, _, _ = select.select([fd, inp], [], [])
    if fd in ready:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        os.write(1, data)
    if inp in ready:
        data = os.read(inp, 65536)
        if not data: stop()
        os.write(fd, data)
`;

/**
 * What a terminal emulator would answer. The TUI asks for the colour scheme,
 * the palette, supported modes and the terminal's version before it renders,
 * and waits for the answers.
 */
const TERMINAL_ANSWERS = [
	[/\x1b\[\?996n/g, () => "\x1b[?997;1n"],
	[/\x1b\[\?(\d+)\$p/g, (_, mode) => `\x1b[?${mode};2$y`],
	[/\x1b\]10;\?(?:\x1b\\|\x07)/g, () => "\x1b]10;rgb:dddd/dddd/dddd\x1b\\"],
	[/\x1b\]11;\?(?:\x1b\\|\x07)/g, () => "\x1b]11;rgb:1111/1111/1111\x1b\\"],
	[/\x1b\]4;(\d+);\?(?:\x1b\\|\x07)/g, (_, n) => `\x1b]4;${n};rgb:8080/8080/8080\x1b\\`],
	[/\x1b\[>q/g, () => "\x1bP>|xterm(390)\x1b\\"],
	[/\x1b\[6n/g, () => "\x1b[1;1R"],
	[/\x1b\[c/g, () => "\x1b[?62;22c"],
	[/\x1b\[\?u/g, () => "\x1b[?0u"],
];

/** The TUI's screen output with escape sequences removed: enough to find a line in. */
const plain = (raw) =>
	raw
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1bP[^\x1b]*\x1b\\/g, "")
		.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[()][A-Z0-9]/g, "")
		.replace(/\r/g, "\n");

function startTui({ env = {}, name = "tui", experimental = true } = {}) {
	// Copilot CLI shows canvases only in experimental mode (the flag persists, as `/experimental on` does).
	const [program, argv] = command(["--allow-all", "--no-auto-update", "--log-dir", LOGS, "--log-level", "debug", ...(experimental ? ["--experimental"] : [])]);
	const child = spawn("python3", ["-c", PTY_BRIDGE, program, ...argv], { cwd: WS, env: copilotEnv(env), stdio: ["pipe", "pipe", "pipe"] });
	const tui = { child, raw: "", exited: false };
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		tui.raw += chunk;
		for (const [pattern, answer] of TERMINAL_ANSWERS) for (const match of chunk.matchAll(pattern)) child.stdin.write(answer(...match));
	});
	child.stderr.on("data", (chunk) => (tui.raw += chunk));
	child.on("exit", () => (tui.exited = true));
	tui.screen = () => plain(tui.raw);
	tui.until = async (pattern, what, ms = 60_000) => {
		const deadline = Date.now() + ms;
		while (!pattern.test(tui.screen())) {
			if (tui.exited) throw new Error(`copilot exited while waiting for ${what}`);
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await wait(100);
		}
	};
	/** Type as a person does, then Enter. */
	tui.type = async (text) => {
		for (const char of text) {
			child.stdin.write(char);
			await wait(8);
		}
		await wait(150);
		child.stdin.write("\r");
	};
	tui.prompt = tui.type;
	tui.stop = async () => {
		if (keep) writeFileSync(path.join(work, `${name}.txt`), tui.screen());
		if (tui.exited) return;
		child.kill("SIGTERM");
		for (let i = 0; i < 50 && !tui.exited; i++) await wait(100);
	};
	return tui;
}

/** A person's turn: say it to the host, and wait for the agent to finish it. */
async function agent(host, message, key = message.split(" ")[0]) {
	const done = turnEnd(key);
	await host.prompt(message);
	const turn = await done;
	// Let Copilot settle the turn (idle event, timeline) before the next step.
	await wait(400);
	return turn;
}

/**
 * Copilot as VS Code's Agents window hosts it (microsoft/vscode, the local agent
 * host's session launcher): the SDK's client, the session flags that turn on
 * extensions and canvas rendering, the plugin handed over as a directory, and
 * each extension launched the way VS Code launches it — the host's own Node
 * (Electron as Node there), the runtime's bootstrap, a canvas data directory.
 */
async function startSdkHost() {
	const { CopilotClient, approveAll } = await import(pathToFileURL(path.join(SDK, "dist", "index.js")).href);
	// The SDK's platform half carries the runtime's own extension SDK and bootstrap.
	const runtime = path.join(path.dirname(SDK), `copilot-sdk-${process.platform}-${process.arch}`);
	const bootstrap = path.join(runtime, "preloads", "extension_bootstrap.mjs");
	const host = { events: [], launches: [] };
	host.client = new CopilotClient({
		baseDirectory: path.join(HOME, ".copilot"),
		workingDirectory: WS,
		logLevel: "debug",
		env: copilotEnv(),
		extensionLaunchProvider: {
			resolve: async (request) => {
				host.launches.push(request);
				const env = { EXTENSION_PATH: request.modulePath, VSCODE_CANVAS_DATA_DIR: path.join(work, "canvas-data"), ELECTRON_RUN_AS_NODE: "1" };
				return { launch: { executable: process.execPath, args: [bootstrap], env } };
			},
		},
	});
	await host.client.start();
	host.session = await host.client.createSession({
		model: "scripted",
		provider: { type: "openai", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "e2e" },
		workingDirectory: WS,
		enableConfigDiscovery: true,
		pluginDirectories: [ROOT],
		requestExtensions: true,
		requestCanvasRenderer: true,
		extensionSdkPath: path.join(runtime, "copilot-sdk"),
		onPermissionRequest: approveAll,
		streaming: true,
	});
	host.session.on((event) => host.events.push(event));
	host.prompt = (prompt) => host.session.send({ prompt });
	host.messages = () => host.events.filter((event) => /^session\.(info|warning)$/.test(event.type)).map((event) => String(event.data?.message ?? ""));
	host.until = async (test, what, ms = 60_000) => {
		for (const deadline = Date.now() + ms; !test(host); await wait(50)) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		}
	};
	host.screen = () => host.events.map((event) => `${event.type} ${JSON.stringify(event.data ?? {}).slice(0, 160)}`).join("\n");
	host.stop = async () => {
		if (keep) writeFileSync(path.join(work, "sdk-events.jsonl"), host.events.map((event) => JSON.stringify(event)).join("\n"));
		await host.session?.disconnect().catch(() => {});
		await host.client.stop().catch(() => {});
	};
	return host;
}

/** Processes to kill however the run ends. */
const leftovers = [];

/** A port nobody is listening on, for VS Code's DevTools endpoint. */
function freePort() {
	return new Promise((resolve) => {
		const probe = http.createServer().listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

/**
 * Real VS Code, as a person uses the canvas with it today: the Copilot CLI in
 * the integrated terminal, and the canvas in VS Code's Integrated Browser, which
 * is where VS Code opens a localhost link from the terminal
 * (`workbench.browser.openLocalhostLinks`). Driven over the DevTools protocol:
 * the workbench window types into the terminal, and the Integrated Browser's
 * page is the person's draw.io.
 */
async function startVscodeHost(playwright) {
	check(process.env.DISPLAY || process.env.WAYLAND_DISPLAY, "--host vscode needs a display (e.g. xvfb-run)");
	const userData = path.join(work, "vscode", "user-data");
	mkdirSync(path.join(userData, "User"), { recursive: true });
	writeFileSync(
		path.join(userData, "User", "settings.json"),
		JSON.stringify({
			"workbench.browser.openLocalhostLinks": true,
			// The DOM renderer, so the terminal's text can be read back.
			"terminal.integrated.gpuAcceleration": "off",
			"terminal.integrated.defaultProfile.linux": "bash",
			"security.workspace.trust.enabled": false,
			"workbench.startupEditor": "none",
			"update.mode": "none",
			"telemetry.telemetryLevel": "off",
			"extensions.autoCheckUpdates": false,
		}),
	);
	const port = await freePort();
	const env = copilotEnv({ COPILOT_CANVAS_NATIVE_WINDOW: "false", PATH: `${path.dirname(BIN)}${path.delimiter}${process.env.PATH}` });
	const args = [
		"--no-sandbox",
		"--disable-gpu",
		`--user-data-dir=${userData}`,
		`--extensions-dir=${path.join(work, "vscode", "extensions")}`,
		`--remote-debugging-port=${port}`,
		"--skip-release-notes",
		"--disable-workspace-trust",
		WS,
	];
	const child = spawn(VSCODE, args, { cwd: WS, env, stdio: ["ignore", "pipe", "pipe"] });
	// Killed at the end even if starting fails before `host` is returned.
	leftovers.push(child);
	const host = { child, exited: false, lastScreen: "" };
	const trace = (...parts) => process.env.E2E_VERBOSE && say("vscode:", ...parts);
	child.on("exit", () => (host.exited = true));
	for (let attempt = 0; !host.cdp; attempt++) {
		try {
			host.cdp = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		} catch (cause) {
			check(attempt < 120 && !host.exited, `VS Code did not come up: ${cause.message}`);
			await wait(500);
		}
	}
	trace("DevTools connected");
	host.pages = () => host.cdp.contexts().flatMap((context) => context.pages());
	for (let attempt = 0; !host.win; attempt++) {
		host.win = host.pages().find((page) => page.url().includes("workbench.html"));
		check(attempt < 120, "VS Code's workbench window never appeared");
		if (!host.win) await wait(250);
	}
	trace("workbench page", host.win.url().slice(0, 80));
	await host.win.waitForSelector(".monaco-workbench", { timeout: 60_000 });
	trace("workbench rendered");
	// A fresh profile greets the person with a two-page welcome: they carry on
	// without signing in (nothing here needs a GitHub account), then get started.
	const welcome = [
		host.win.getByRole("button", { name: "Continue without Signing In" }),
		host.win.getByRole("button", { name: "Get Started" }),
	];
	const dismissWelcome = async () => {
		for (const button of welcome) {
			if ((await button.count()) === 0) continue;
			await button.first().click({ timeout: 5000 }).catch(() => {});
			trace("welcome dialog dismissed");
			await wait(500);
		}
	};
	// Keybindings are live a little after the workbench renders: ask until a terminal is there.
	for (let attempt = 0; (await host.win.locator(".xterm-screen").count()) === 0; attempt++) {
		check(attempt < 30, "VS Code never opened an integrated terminal");
		await dismissWelcome();
		await host.win.keyboard.press("Control+Shift+Backquote", { timeout: 5000 }).catch(() => {});
		await wait(2000);
	}
	await host.win.waitForSelector(".xterm-screen", { state: "visible", timeout: 30_000 });
	trace("terminal open");
	// xterm's DOM renderer writes spaces as no-break spaces.
	host.screen = async () =>
		(host.lastScreen = await host.win
			.evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].map((row) => row.textContent.replace(/ /g, " ")).join("\n"))
			.catch(() => host.lastScreen));
	host.until = async (pattern, what, ms = 60_000) => {
		for (const deadline = Date.now() + ms; !pattern.test(await host.screen()); await wait(150)) {
			if (host.exited) throw new Error(`VS Code exited while waiting for ${what}`);
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		}
	};
	host.prompt = async (text) => {
		// The welcome dialog can arrive after the terminal did; it has to go first.
		for (let attempt = 0; ; attempt++) {
			await dismissWelcome();
			try {
				await host.win.click(".xterm-screen", { timeout: 3000 });
				break;
			} catch (cause) {
				check(attempt < 10, `could not reach VS Code's terminal: ${cause.message.split("\n")[0]}`);
			}
		}
		await host.win.keyboard.type(text, { delay: 5 });
		await host.win.keyboard.press("Enter");
	};
	/** Ctrl+click a link the terminal shows, as a person does. */
	host.click = async (label) => {
		for (let attempt = 0; attempt < 40; attempt++) {
			const box = await host.win.evaluate((wanted) => {
				for (const row of document.querySelectorAll(".xterm-rows > div")) {
					const at = row.textContent.replace(/ /g, " ").indexOf(wanted);
					if (at < 0) continue;
					const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
					for (let node = walker.nextNode(), offset = 0; node; offset += node.textContent.length, node = walker.nextNode()) {
						if (at + 1 < offset || at + 1 >= offset + node.textContent.length) continue;
						const range = document.createRange();
						range.setStart(node, at + 1 - offset);
						range.setEnd(node, at + 2 - offset);
						const rect = range.getBoundingClientRect();
						return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
					}
				}
				return null;
			}, label);
			if (box) {
				await host.win.mouse.move(box.x, box.y);
				await wait(400);
				await host.win.keyboard.down("Control");
				await host.win.mouse.click(box.x, box.y);
				await host.win.keyboard.up("Control");
				return;
			}
			await wait(250);
		}
		throw new Error(`the terminal shows no "${label}" link`);
	};
	/** Nothing in cleanup may hang the run: each step gets a few seconds. */
	const briefly = (promise) => Promise.race([Promise.resolve(promise).catch(() => {}), wait(5000)]);
	host.stop = async () => {
		if (keep) {
			writeFileSync(path.join(work, "vscode-terminal.txt"), (await briefly(host.screen())) ?? host.lastScreen);
			await briefly(host.win?.screenshot({ path: path.join(work, "vscode-window.png") }));
		}
		await briefly(host.cdp?.close());
		if (!host.exited) child.kill("SIGTERM");
		for (let i = 0; i < 50 && !host.exited; i++) await wait(100);
		if (!host.exited) child.kill("SIGKILL");
	};
	await host.prompt(`${BIN.endsWith(".js") ? `node ${JSON.stringify(BIN)}` : JSON.stringify(BIN)} --experimental --allow-all --no-auto-update`);
	return host;
}

let browser;
let host;
let nativeTui;
const timings = [];
try {
	let started = Date.now();
	const entry = DRIVER.endsWith(".js") || DRIVER.endsWith(".mjs") ? DRIVER : `${DRIVER.replace(/\/$/, "")}/index.js`;
	const playwright = await import(entry).then((module) => (module.chromium ? module : module.default));
	if (TERMINAL) {
		// 1. Install, the way a person does.
		const added = copilotCli(["plugin", "marketplace", "add", ROOT]);
		check(/added successfully|already/i.test(added), `marketplace add: ${added}`);
		const installed = copilotCli(["plugin", "install", "drawio-canvas@drawio-canvas"]);
		check(/installed successfully/i.test(installed), `plugin install: ${installed}`);
		const listed = copilotCli(["plugin", "list"]);
		check(/drawio-canvas@drawio-canvas \(v[\d.]+\) \(enabled\)/.test(listed), `plugin list: ${listed}`);
		say("installed through Copilot's plugin system:", listed.match(/drawio-canvas@drawio-canvas \(v[\d.]+\)/)[0]);

		// Without experimental mode Copilot loads the canvas but gives the agent no
		// canvas tools; the person is told how to turn them on, not left guessing.
		const plainTui = startTui({ experimental: false, name: "tui-not-experimental" });
		await plainTui.until(/does not show canvases[\s\S]*experimental/, "the hint that canvases need experimental mode", 90_000);
		await plainTui.stop();
		say("without experimental mode, the person is told to turn it on");

		// Then as a person who did. Native canvas windows are for step 11; here the
		// person follows the URL Copilot prints: in Chromium, or in VS Code.
		started = Date.now();
		host = HOST === "vscode" ? await startVscodeHost(playwright) : startTui({ env: { COPILOT_CANVAS_NATIVE_WINDOW: "false" } });
		await host.until(/drawio-canvas ready/, "the canvas extension to load", 90_000);
		say(HOST === "vscode" ? "VS Code started; copilot runs in its integrated terminal and the canvas extension joined" : "copilot started; the canvas extension joined the session");
	} else {
		// 1. The host hands the plugin over as a directory, as VS Code does with
		//    the agent plugins it manages; the runtime finds the canvas in it.
		host = await startSdkHost();
		await host.until((host) => host.messages().some((line) => /drawio-canvas ready|does not show canvases/.test(line)), "the canvas extension to load", 90_000);
		const launched = host.launches.find((request) => request.source === "plugin" && /extensions[\\/]drawio-canvas[\\/]extension\.mjs$/.test(request.modulePath));
		check(launched, `the runtime should launch the plugin's canvas through the host: ${JSON.stringify(host.launches)}`);
		check(host.messages().some((line) => line === "drawio-canvas ready"), `a host that renders canvases should get no hint: ${host.messages().join(" | ")}`);
		say(`SDK host (VS Code's configuration) launched ${launched.id} itself; canvases on, no hint`);
	}
	timings.push(["copilot start → canvas extension ready", Date.now() - started]);

	if (HOST !== "vscode") browser = await playwright.chromium.launch({ executablePath: process.env.DRAWIO_CANVAS_CHROMIUM || undefined, args: ["--no-sandbox"] });
	/** The person's draw.io: a Chromium tab, or (vscode) VS Code's Integrated Browser tab, once opened. */
	let page = HOST === "vscode" ? undefined : await browser.newPage({ viewport: { width: 1400, height: 860 } });
	const problems = [];
	page?.on("pageerror", (error) => problems.push(error.message));
	const frame = () => page.frame({ url: /drawio\/index\.html/ });
	const graph = (body) => frame().evaluate(`(() => { const g = window.drawioCanvasUi.editor.graph; ${body} })()`);
	const seen = (id) =>
		page.waitForFunction(
			(cellId) => [...document.querySelectorAll("iframe")].map((f) => f.contentWindow).find((w) => w?.drawioCanvasUi)?.drawioCanvasUi.editor.graph.model.getCell(cellId),
			id,
			{ timeout: 30_000 },
		);

	// 3. The agent opens the canvas and draws; the person follows the URL.
	started = Date.now();
	const drawing = agent(host, "E2E-DRAW a three-tier architecture", "E2E-DRAW");
	const opened = await request((turn) => turn.key === "E2E-DRAW" && turn.results.length === 2, "the open_canvas result");
	let url = opened.results[1].match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)?.[0];
	check(url, `open_canvas: ${opened.results[1]}`);
	check(!failed(opened.results[0]) && /"edit_diagram"/.test(opened.results[0]), `list_canvas_capabilities should list the actions inline: ${opened.results[0].slice(0, 300)}`);
	// The plugin's MCP server (for VS Code's Chat view) runs here too, and must
	// offer Copilot none of its tools: the canvas is already here.
	check(!opened.tools.some((name) => /drawio-canvas|get_diagram|edit_diagram/.test(name)), `Copilot should get the canvas once, not the MCP tools too: ${opened.tools.join(", ")}`);
	if (TERMINAL) {
		// VS Code's terminal panel is a dozen rows: the earlier line may have scrolled by.
		if (HOST === "tui") await host.until(/Canvas opened: Draw\.io Canvas/, "the TUI to report the canvas", 60_000);
		await host.until(/Open Draw\.io Canvas using the provided URL/, "the TUI to offer the URL", 60_000);
	} else {
		// What VS Code puts in its BrowserView: the http(s) URL of the opened event.
		await host.until((host) => host.events.some((event) => event.type === "session.canvas.opened" && event.data?.url), "the session.canvas.opened event");
		url = host.events.find((event) => event.type === "session.canvas.opened").data.url;
		check(/^https?:/.test(url), `VS Code shows only http(s) canvas sources: ${url}`);
	}
	timings.push(["prompt → open_canvas answered (2 model turns)", Date.now() - started]);
	say(`agent opened the canvas with input null; the host offers ${TERMINAL ? "its URL in the terminal" : "its URL in session.canvas.opened"}`);

	started = Date.now();
	if (HOST === "vscode") {
		// The person Ctrl+clicks Copilot's link in VS Code's terminal; VS Code opens
		// it in an Integrated Browser tab, whose page is theirs from here on.
		await host.click("Open in browser");
		for (let attempt = 0; !page; attempt++) {
			page = host.pages().find((candidate) => candidate.url().startsWith(url));
			check(attempt < 120, `VS Code did not open ${url} in its Integrated Browser`);
			if (!page) await wait(250);
		}
		page.on("pageerror", (error) => problems.push(error.message));
	} else {
		await page.goto(url);
	}
	await page.waitForFunction(() => globalThis.drawioCanvas, null, { timeout: 120_000 });
	timings.push([HOST === "vscode" ? "link clicked → draw.io ready in VS Code's Integrated Browser" : "draw.io ready in the browser", Date.now() - started]);
	gate("person-ready").open();
	// The agent is mid-turn (its model is holding the next step): the bar says so.
	await page.waitForFunction(() => document.getElementById("agent").classList.contains("busy") || /working|canvas|invoke/i.test(document.getElementById("agent").textContent), null, { timeout: 15_000 });
	const busyText = (await page.textContent("#agent")).trim();
	gate("busy-seen").open();
	const drew = await drawing;
	await seen("db");
	check(drew.results.every((result) => !failed(result)), `draw: ${drew.results.filter(failed).join("\n")}`);
	check(/"version"/.test(drew.results[2]), `get_diagram with input null should succeed: ${drew.results[2].slice(0, 200)}`);
	await page.waitForFunction(() => !document.getElementById("agent").classList.contains("busy"), null, { timeout: 15_000 });
	const idleText = (await page.textContent("#agent")).trim();
	if (keep) await (HOST === "vscode" ? host.win : page).screenshot({ path: path.join(work, "1-agent-drew.png") });
	say(`agent drew; the person sees it. The bar showed "${busyText}" while it worked, "${idleText}" after`);

	// 4. The person adds a shape; the agent is told, and builds on it.
	await graph(`g.insertVertex(g.getDefaultParent(), "cache", "Redis Cache", 260, 220, 140, 60, "shape=cylinder3;whiteSpace=wrap;html=1;");`);
	await page.waitForTimeout(500);
	const reacted = await agent(host, "E2E-REACT to what I added");
	check(/Redis Cache/.test(reacted.results[0]), `get_changes should report the person's shape: ${reacted.results[0].slice(0, 300)}`);
	await seen("link0");
	if (keep) await page.screenshot({ path: path.join(work, "2-agent-built-on-it.png") });
	say("person added a cache; agent connected it");

	// 5. The person relabels a cell; the agent's blind edit is refused with the
	//    cell as it is now, and the next call builds on it without a re-read.
	await graph(`g.model.setValue(g.model.getCell("api"), "Public API");`);
	await page.waitForTimeout(500);
	const stale = await agent(host, "E2E-STALE edit the api label");
	check(failed(stale.results[0]) && /stale_cells|Not applied/.test(stale.results[0]), `the blind edit should be refused: ${stale.results[0].slice(0, 300)}`);
	check(/Public API/.test(stale.results[0]), "the refusal should carry the person's label");
	check(!failed(stale.results[1]), `the retry should apply: ${stale.results[1]}`);
	const label = await graph(`return g.model.getCell("api").value;`);
	check(label === "Public API v2", `the person's label should survive: got "${label}"`);
	say(`blind edit refused with the cell attached; retry built on the person's label → "${label}"`);

	// 6. The person asks from the canvas; the idle agent is woken, does it, replies.
	await graph(`g.setSelectionCell(g.model.getCell("db"));`);
	await frame().evaluate(() => window.drawioCanvasUi.editor.graph.container.focus());
	started = Date.now();
	const woken = turnEnd("asked for help on the draw.io canvas");
	await page.keyboard.press("Alt+KeyA");
	await page.keyboard.type("Mark this one");
	await page.keyboard.press("Enter");
	const asked = await woken;
	timings.push(["ask from the canvas → agent done (4 model turns)", Date.now() - started]);
	check(/Mark this one/.test(asked.task), `the agent should be told the ask: ${asked.task.slice(0, 300)}`);
	await page.click("#asks-toggle");
	await page.waitForFunction(() => document.querySelector("#asks-list .reply")?.textContent.includes("Marked the one you picked"), null, { timeout: 10_000 });
	const marked = await graph(`return g.model.getCell("db").value;`);
	check(marked === "Orders DB (asked)", `the ask's cell should be changed: got "${marked}"`);
	if (keep) await (HOST === "vscode" ? host.win : page).screenshot({ path: path.join(work, "3-ask-done.png") });
	await page.click("#asks-toggle");
	await wait(400);
	say("person asked from the canvas; Copilot's agent woke, did it, replied in the drawer");

	// 7. "this" in the terminal means the canvas selection.
	await graph(`g.setSelectionCell(g.model.getCell("web"));`);
	await page.waitForTimeout(800);
	const pill = await agent(host, "E2E-PILL make this stand out");
	const viaPill = pillIds(pill.task).length > 0;
	if (!viaPill) {
		const selected = resultOf(pill.results[0])?.looking_at?.selected;
		check(JSON.stringify(selected) === '["web"]', `without a pill, the agent's first call should say what is selected: ${pill.results[0].slice(0, 400)}`);
	}
	check(pill.results.every((result) => !failed(result)), `pill: ${pill.results.join("\n").slice(0, 400)}`);
	const thisLabel = await graph(`return g.model.getCell("web").value;`);
	check(thisLabel === "Web App (this)", `"this" should be the selected cell: got "${thisLabel}"`);
	const pushed = HOST === "sdk" && host.events.some((event) => event.type === "session.extensions.attachments_pushed");
	say(
		`typed "this"; the agent changed the selected shape (${viaPill ? "the selection rode along as a pill" : "no pill in this host: its first call named the selection"}${pushed ? "; the runtime did hand the host the selection to show as a pill" : ""})`,
	);

	// 8. Copilot restarts the extension; the person's tab stays and reconnects.
	if (HOST === "sdk") await host.session.rpc.extensions.reload();
	const reload = await agent(host, "E2E-RELOAD the canvas extension");
	await page.waitForFunction(() => /restarted|reconnected/i.test(document.getElementById("status").textContent), null, { timeout: 30_000 });
	check(page.url().startsWith(url), "the tab stays on the same URL");
	const afterReload = reload.results.at(-1);
	check(!failed(afterReload) && /"shapes": ?[1-9]/.test(afterReload), `the diagram should survive the reload: ${afterReload.slice(0, 300)}`);
	await graph(`g.insertVertex(g.getDefaultParent(), "after", "After reload", 40, 520, 140, 60, "rounded=1;");`);
	await page.waitForTimeout(500);
	const reopened = reload.results.some((result) => /"canvasId"/.test(result) && /"url"/.test(result));
	say(`${TERMINAL ? "extensions_reload" : "session.extensions.reload"}: ${reopened ? "the agent re-opened the instance" : "the instance carried on"}; the person's tab reconnected by itself`);

	// 8b. The person restarts Copilot itself (`/restart`): a new CLI process
	//     resumes the session, and with it the canvas, on the same URL.
	if (HOST === "tui") {
		const readies = () => (host.screen().match(/drawio-canvas ready/g) ?? []).length;
		const before = readies();
		await page.evaluate(() => (document.getElementById("status").textContent = ""));
		await host.prompt("/restart");
		for (const deadline = Date.now() + 90_000; readies() <= before; await wait(200)) check(Date.now() < deadline, "Copilot did not come back from /restart");
		// The restarted terminal takes a moment to accept input; say it again if it was not heard.
		const done = turnEnd("E2E-RESUMED");
		for (let attempt = 0; !turns.some((turn) => turn.key === "E2E-RESUMED"); attempt++) {
			check(attempt < 6, "the restarted Copilot never took the person's message");
			await wait(2000);
			if (!turns.some((turn) => turn.key === "E2E-RESUMED")) await host.prompt("E2E-RESUMED look at the diagram");
			for (let i = 0; i < 25 && !turns.some((turn) => turn.key === "E2E-RESUMED"); i++) await wait(200);
		}
		const resumed = await done;
		await wait(400);
		await page.waitForFunction(() => /restarted|reconnected/i.test(document.getElementById("status").textContent), null, { timeout: 30_000 });
		check(page.url().startsWith(url), "the tab stays on the same URL");
		check(!failed(resumed.results.at(-1)) && /After reload/.test(resumed.results.at(-1)), `the diagram should survive /restart: ${resumed.results.at(-1).slice(0, 300)}`);
		const again = resumed.results.some((result) => /"canvasId"/.test(result) && /"url"/.test(result));
		say(`/restart: Copilot came back, ${again ? "the agent re-opened the instance" : "the instance was resumed"}, the diagram survived and the person's tab reconnected by itself`);
	}

	// 9. Every action once, timed: from the model's call to Copilot's next request.
	const bench = await agent(host, "E2E-BENCH every action");
	const benchTurns = bench.requests;
	for (let index = 0; index < BENCH.length; index++) {
		const [action, input] = BENCH[index];
		const result = benchTurns[index + 1]?.results[index] ?? "";
		check(!failed(result), `${action}: ${result.slice(0, 300)}`);
		timings.push([`  ${action}${action === "save_file" ? ` ${input.path}` : ""}`, benchTurns[index + 1].arrived - benchTurns[index].answered]);
	}
	check(/After reload/.test(bench.results[0]), "the person's edit after the reload should reach the agent");
	check(/"looking_at"/.test(bench.results[0]), "after a reload the page should tell the new process where the person is");
	check(problems.length === 0, `browser errors: ${problems.join("; ")}`);
	say("every action ran through Copilot");

	// 10. The person edits, then pauses: one short digest reaches the idle agent.
	if (flag("--digest")) {
		for (const [index, name] of ["Queue", "Worker", "Cache 2"].entries()) {
			await graph(`g.insertVertex(g.getDefaultParent(), "d${index}", "${name}", ${40 + index * 180}, 640, 140, 60, "rounded=1;");`);
		}
		started = Date.now();
		const digest = await turnEnd("paused after editing the draw.io canvas", 180_000);
		timings.push(["person pauses → idle digest reaches the agent", Date.now() - started]);
		check(/Queue|Worker/.test(digest.task), `the digest should say what changed: ${digest.task.slice(0, 300)}`);
		say("the person paused; one digest reached the agent");
	}

	// 11. Copilot's own window: with a display, the canvas opens natively.
	if (flag("--native")) {
		check(HOST === "tui", "--native is the terminal's own canvas window: use it with --host tui");
		check(process.env.DISPLAY || process.env.WAYLAND_DISPLAY, "--native needs a display (e.g. xvfb-run)");
		await host.stop();
		await browser.close();
		browser = undefined;
		nativeTui = startTui({ env: { COPILOT_CANVAS_NATIVE_WINDOW: "true" }, name: "tui-native" });
		await nativeTui.until(/drawio-canvas ready/, "the canvas extension to load", 90_000);
		const native = turnEnd("E2E-NATIVE");
		await nativeTui.type("E2E-NATIVE open it in Copilot's window");
		const nativeOpen = await request((turn) => turn.key === "E2E-NATIVE" && turn.results.length === 1, "the native open_canvas result");
		const nativeUrl = nativeOpen.results[0].match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)?.[0];
		check(nativeUrl, "open_canvas should give a URL");
		started = Date.now();
		// The workspace manifest says when a draw.io editor is connected to the instance.
		const manifest = path.join(WS, ".drawio-canvas", "native-1", "manifest.json");
		for (let i = 0; ; i++) {
			let state = {};
			try {
				state = JSON.parse(readFileSync(manifest, "utf8"));
			} catch {}
			if (state.editor_open) break;
			check(i < 600, `Copilot's canvas window never loaded draw.io:\n${nativeTui.screen().split("\n").filter((line) => /canvas|window/i.test(line)).slice(-5).join("\n")}`);
			await wait(100);
		}
		timings.push(["draw.io ready in Copilot's canvas window", Date.now() - started]);
		gate("native-editor").open();
		const shot = await native;
		check(shot.results.every((result) => !failed(result)), `native: ${shot.results.join("\n").slice(0, 400)}`);
		check(/"rendered":|"path":|native\.png/.test(shot.results[2]) && !/approximate/.test(shot.results[2]), `the screenshot should be draw.io's own render: ${shot.results[2].slice(0, 300)}`);
		const png = readFileSync(path.join(WS, "native.png"));
		check(png.length > 1_000 && png.subarray(1, 4).toString() === "PNG", "the native window's screenshot should be a real PNG");
		say(`Copilot's own canvas window loaded draw.io; the agent's screenshot was rendered there (${png.length} bytes)`);
	}

	const persons = turns.filter((turn) => turn.key === "(none)");
	check(persons.length === 0, `every model turn should have a reason; unexpected: ${persons.map((turn) => turn.task.slice(0, 120)).join(" | ")}`);

	console.log("\nTimings (host side, real processes, real browser):");
	for (const [what, ms] of timings) console.log(`  ${String(ms).padStart(6)} ms  ${what}`);
	console.log("\nPASS");
} catch (error) {
	say("FAIL:", error.message);
	const screen = await Promise.race([Promise.resolve((nativeTui ?? host)?.screen?.()).catch(() => ""), wait(5000)]);
	if (screen) console.error(screen.split("\n").filter((line) => line.trim()).slice(-25).join("\n"));
	process.exitCode = 1;
} finally {
	for (const waiter of turnWaiters.splice(0)) waiter.cancel();
	for (const { open } of gates.values()) open();
	await browser?.close();
	await host?.stop();
	await nativeTui?.stop();
	for (const child of leftovers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	model.close();
	if (!keep) rmSync(work, { recursive: true, force: true });
	// A host's stray handle (a pipe, a socket) must not keep a finished run alive.
	process.exit();
}
