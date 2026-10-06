/**
 * The canvas as an MCP server (`mcp.mjs`), as a client sees it: a child process
 * speaking JSON-RPC over stdio.
 *
 * VS Code's Chat view is the client this is for; `scripts/e2e-vscode-chat.mjs`
 * runs it there for real. This file pins the protocol: what a client is
 * offered, what a call returns, how refusals look, that hosts running the
 * canvas extension get nothing twice, and that a restart keeps the person's tab.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLAYBOOK } from "../lib/canvas.mjs";
import { offersTools, PROTOCOL_VERSIONS } from "../lib/mcp.mjs";
import "./harness.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = path.join(ROOT, "mcp.mjs");
const CELL = (id, label = id) => `<mxCell value="${label}" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>`;

/** Start the server and speak to it as a client with `roots` would. */
function startServer({ workspace, clientName = "Visual Studio Code", env = {}, roots = true } = {}) {
	const child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
	const stderr = [];
	const strays = [];
	const waiting = new Map();
	let nextId = 1;
	child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
	createInterface({ input: child.stdout }).on("line", (line) => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			strays.push(line);
			return;
		}
		if (message.method === "roots/list") {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { roots: [{ uri: pathToFileURL(workspace).href, name: "ws" }] } })}\n`);
			return;
		}
		waiting.get(message.id)?.(message);
		waiting.delete(message.id);
	});
	const exited = new Promise((resolve) => child.on("exit", resolve));
	const rpc = (method, params) =>
		new Promise((resolve) => {
			const id = nextId++;
			waiting.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	return {
		child,
		stderr,
		strays,
		rpc,
		notify,
		raw: (line) => child.stdin.write(`${line}\n`),
		async initialize(protocolVersion = "2025-06-18") {
			const response = await rpc("initialize", { protocolVersion, capabilities: roots ? { roots: { listChanged: true } } : {}, clientInfo: { name: clientName, version: "1" } });
			notify("notifications/initialized");
			return response.result;
		},
		/** A tool call: the parsed JSON of its first text part, or the refusal. */
		async call(name, args = {}) {
			const { result } = await rpc("tools/call", { name, arguments: args });
			return { result, error: result.isError ? result.content[0].text : null, data: result.isError ? null : JSON.parse(result.content[0].text) };
		},
		async stop() {
			child.stdin.end();
			await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
			if (child.exitCode === null) child.kill("SIGKILL");
		},
		exited,
	};
}

let workspace;
before(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "drawio-mcp-"));
});
after(async () => {
	await rm(workspace, { recursive: true, force: true });
});

describe("the MCP server", () => {
	it("imports nothing but node: builtins and its own files", async () => {
		for (const relative of ["mcp.mjs", "lib/mcp.mjs"]) {
			const source = await readFile(path.join(ROOT, relative), "utf8");
			for (const [, specifier] of source.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)) {
				assert.ok(specifier.startsWith("node:") || specifier.startsWith("."), `${relative} imports "${specifier}"`);
			}
		}
	});

	it("is declared for plugin hosts, and hoocode (which runs the canvas) is kept off it", async () => {
		const mcp = JSON.parse(await readFile(path.join(ROOT, ".mcp.json"), "utf8"));
		assert.deepEqual(mcp.mcpServers["drawio-canvas"], { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/mcp.mjs"] });
		const agents = JSON.parse(await readFile(path.join(ROOT, ".agents-plugin", "plugin.json"), "utf8"));
		const none = JSON.parse(await readFile(path.join(ROOT, agents.mcpServers), "utf8"));
		assert.deepEqual(none.mcpServers, {});
	});

	it("offers its tools to every client but the hosts that run the canvas extension", () => {
		assert.equal(offersTools({ name: "Visual Studio Code" }, {}), true);
		assert.equal(offersTools({ name: "claude-code" }, {}), true);
		assert.equal(offersTools({}, {}), true);
		assert.equal(offersTools({ name: "copilot-cli" }, {}), false);
		assert.equal(offersTools({ name: "hoocode" }, {}), false);
		assert.equal(offersTools({ name: "copilot-cli" }, { DRAWIO_CANVAS_MCP: "on" }), true);
		assert.equal(offersTools({ name: "Visual Studio Code" }, { DRAWIO_CANVAS_MCP: "off" }), false);
	});

	it("initializes with the client's protocol version and the canvas's playbook", async () => {
		const server = startServer({ workspace });
		try {
			const init = await server.initialize("2025-06-18");
			assert.equal(init.protocolVersion, "2025-06-18");
			assert.equal(init.serverInfo.name, "drawio-canvas");
			const manifest = JSON.parse(await readFile(path.join(ROOT, ".github", "plugin", "plugin.json"), "utf8"));
			assert.equal(init.serverInfo.version, manifest.version);
			assert.ok(init.capabilities.tools && init.capabilities.prompts);
			for (const sentence of [PLAYBOOK.loop, PLAYBOOK.refusals, PLAYBOOK.asks]) assert.ok(init.instructions.includes(sentence));
			assert.match(init.instructions, /open_browser_page/);

			const later = startServer({ workspace });
			assert.equal((await later.initialize("2099-01-01")).protocolVersion, PROTOCOL_VERSIONS[0]);
			await later.stop();
		} finally {
			await server.stop();
		}
	});

	it("lists open_canvas and every canvas action as tools, reads marked read-only", async () => {
		const server = startServer({ workspace });
		try {
			await server.initialize();
			const { tools } = (await server.rpc("tools/list", {})).result;
			assert.deepEqual(
				tools.map((tool) => tool.name),
				["open_canvas", "get_diagram", "get_changes", "edit_diagram", "search_shapes", "insert_shapes", "replace_diagram", "manage_pages", "manage_layers", "screenshot", "focus", "layout", "tidy", "get_asks", "update_ask", "open_file", "save_file"],
			);
			for (const tool of tools) {
				// MCP requires an object schema; the canvas's "or null" is for Copilot only.
				assert.equal(tool.inputSchema.type, "object", tool.name);
				assert.ok(tool.description.length > 20, tool.name);
				assert.equal(tool.annotations.openWorldHint, false, tool.name);
			}
			const readOnly = tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name);
			assert.deepEqual(readOnly, ["get_diagram", "get_changes", "search_shapes", "get_asks"]);
		} finally {
			await server.stop();
		}
	});

	it("opens the canvas in the client's workspace and edits, reads and saves it", async () => {
		const server = startServer({ workspace });
		try {
			await server.initialize();
			const opened = await server.call("open_canvas");
			assert.equal(opened.error, null);
			assert.match(opened.data.url, /^http:\/\/127\.0\.0\.1:\d+\/[\w-]{32,}\/$/);
			assert.equal(opened.data.editor_open, false);
			assert.match(opened.data.next, /open_browser_page/);
			assert.ok(opened.data.status.includes(workspace));
			const page = await fetch(opened.data.url);
			assert.equal(page.status, 200);

			// Again: the same canvas, not a second one.
			assert.equal((await server.call("open_canvas")).data.url, opened.data.url);

			const edit = await server.call("edit_diagram", { operations: [{ operation: "add", cell_id: "a", new_xml: CELL("a", "Hello") }] });
			assert.equal(edit.data.applied, 1);
			assert.match(edit.data.person.editor, /closed/);
			const read = await server.call("get_diagram");
			assert.match(read.data.cells_xml, /value="Hello"/);
			const saved = await server.call("save_file", { path: "out.drawio" });
			assert.equal(saved.data.saved, "out.drawio");
			assert.match(await readFile(path.join(workspace, "out.drawio"), "utf8"), /value="Hello"/);
		} finally {
			await server.stop();
		}
	});

	it("opens the canvas on the first call of any tool, and says so", async () => {
		const own = await mkdtemp(path.join(tmpdir(), "drawio-mcp-first-"));
		const server = startServer({ workspace: own });
		try {
			await server.initialize();
			const first = await server.call("get_diagram");
			assert.match(first.data.canvas.url, /^http:\/\/127\.0\.0\.1:/);
			assert.match(first.data.canvas.note, /open_browser_page/);
			assert.equal((await server.call("get_diagram")).data.canvas, undefined);
		} finally {
			await server.stop();
			await rm(own, { recursive: true, force: true });
		}
	});

	it("returns refusals as tool errors with the canvas's code", async () => {
		const server = startServer({ workspace });
		try {
			await server.initialize();
			const typo = await server.call("get_diagram", { page_nmae: "x" });
			assert.equal(typo.result.isError, true);
			assert.match(typo.error, /^invalid_input: .*did you mean "page_name"/);
			assert.match((await server.call("get_diagram", { page_index: 9 })).error, /^page_not_found: /);
			assert.match((await server.call("save_file", { path: "../escape.drawio" })).error, /^outside_workspace: /);
			assert.match((await server.call("focus", {})).error, /^no_editor: /);
			assert.match((await server.call("no_such_tool")).error, /^unknown_tool: /);
			assert.match((await server.call("open_canvas", { fiel: "x" })).error, /^invalid_input: /);
		} finally {
			await server.stop();
		}
	});

	it("offers the person's prompts: asks, review, draw", async () => {
		const server = startServer({ workspace });
		try {
			await server.initialize();
			const { prompts } = (await server.rpc("prompts/list", {})).result;
			assert.deepEqual(
				prompts.map((prompt) => prompt.name),
				["asks", "review", "draw"],
			);
			const asks = (await server.rpc("prompts/get", { name: "asks" })).result;
			assert.match(asks.messages[0].content.text, /get_asks/);
			const draw = (await server.rpc("prompts/get", { name: "draw", arguments: { what: "a queue" } })).result;
			assert.match(draw.messages[0].content.text, /draw: a queue\./);
			assert.equal((await server.rpc("prompts/get", { name: "draw", arguments: {} })).error.code, -32602);
		} finally {
			await server.stop();
		}
	});

	it("gives GitHub Copilot CLI no tools: it runs the canvas extension from the same plugin", async () => {
		const server = startServer({ workspace, clientName: "copilot-cli" });
		try {
			const init = await server.initialize("2025-11-25");
			assert.equal(init.instructions, undefined);
			assert.deepEqual((await server.rpc("tools/list", {})).result.tools, []);
			assert.match((await server.call("get_diagram")).error, /^not_offered: /);
		} finally {
			await server.stop();
		}
	});

	it("answers unknown methods and bad JSON as JSON-RPC errors, and keeps stdout clean", async () => {
		const server = startServer({ workspace });
		try {
			await server.initialize();
			// Copilot sends this before initialize; any client may send something new.
			assert.equal((await server.rpc("server/discover", {})).error.code, -32601);
			assert.deepEqual((await server.rpc("ping", {})).result, {});
			server.raw("{not json");
			await server.call("get_changes");
			assert.deepEqual(server.strays, []);
		} finally {
			await server.stop();
		}
	});

	it("keeps the person's tab across a restart: same URL, same document", async () => {
		const own = await mkdtemp(path.join(tmpdir(), "drawio-mcp-restart-"));
		try {
			const first = startServer({ workspace: own });
			await first.initialize();
			const { url } = (await first.call("open_canvas")).data;
			await first.call("edit_diagram", { operations: [{ operation: "add", cell_id: "kept", new_xml: CELL("kept", "Kept") }] });
			// Closing stdin is how a client stops a stdio server.
			await first.stop();
			assert.equal(await first.exited, 0);

			const second = startServer({ workspace: own });
			await second.initialize();
			// Taken back at startup, before the agent calls: the tab's server is up again.
			for (let i = 0; i < 50 && !second.stderr.join("").includes("resumed the canvas"); i++) await new Promise((resolve) => setTimeout(resolve, 100));
			assert.match(second.stderr.join(""), new RegExp(`resumed the canvas at ${url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
			assert.equal((await fetch(url)).status, 200);
			assert.equal((await second.call("open_canvas")).data.url, url);
			assert.match((await second.call("get_diagram")).data.cells_xml, /value="Kept"/);
			await second.stop();
		} finally {
			await rm(own, { recursive: true, force: true });
		}
	});
});
