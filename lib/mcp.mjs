/**
 * The canvas as an MCP server, for hosts with no canvas surface: VS Code's Chat
 * view (the Copilot agent, with the person's own subscription), and any other
 * MCP client.
 *
 * Same document, same sync, same actions, same page: this file only speaks MCP
 * (JSON-RPC 2.0 over stdio, one message per line) in front of the canvas that
 * `createDrawioCanvas` builds, the way `extension.mjs` speaks the canvas
 * protocol in front of it. What differs is what a canvas host did for us:
 *
 *  - Nothing shows the page. `open_canvas` returns its URL and the agent opens
 *    it for the person — in VS Code with `open_browser_page`, the Integrated
 *    Browser beside the chat.
 *  - One canvas per server (per VS Code window), so no instance ids: every
 *    tool opens it first if it is not open yet.
 *  - The person's asks cannot wake the agent (MCP has no way to start a chat
 *    turn). They ride the agent's next result as `new_asks`, as in a host
 *    without `session.send`, and the person starts the agent with a prompt
 *    this server offers (`asks`, `review`, `draw`) — their gesture, rule 7.
 *  - The workspace comes from the client's roots.
 *  - Restarts: VS Code restarts MCP servers on a window reload or a config
 *    change. The canvas is parked on exit, as in the extension, and taken back
 *    at startup, so the person's tab keeps its URL.
 *
 * GitHub Copilot CLI and hoocode start a plugin's MCP servers too, and they
 * run this plugin's canvas extension already. There this server offers no
 * tools: two sets would give the agent two documents.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentLink } from "./agent.mjs";
import { checkValue, createDrawioCanvas, PLAYBOOK } from "./canvas.mjs";
import { hasSnapshot } from "./files.mjs";

/** Newest first; a client asking for one of these gets it back. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** The one canvas this server keeps. */
const INSTANCE = "drawio";

/** Screenshots larger than this go back as a path only. */
const IMAGE_BUDGET = 4 * 1024 * 1024;

/** JSON-RPC error codes. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const PARSE_ERROR = -32700;

/** What the canvas throws for a refusal the agent can act on: a code and a message. */
export class CanvasError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/** The agent's instructions, sent once in `initialize`. */
export const INSTRUCTIONS = [
	"drawio-canvas: a draw.io diagram you and the person edit at the same time. They use the full draw.io editor in a browser tab; you use these tools on the same document.",
	"Start with open_canvas. It returns the editor's url; when editor_open is false, open it for the person (in VS Code: open_browser_page, the integrated browser beside the chat; elsewhere give them the link).",
	"Do not operate draw.io through browser tools: these tools are exact and fast, and screenshot shows you the result.",
	PLAYBOOK.loop,
	PLAYBOOK.pages,
	PLAYBOOK.speed,
	PLAYBOOK.refusals,
	"The person can also ask you for things from the canvas's bar; they arrive as new_asks in any result, or when they tell you to look.",
	PLAYBOOK.asks,
].join(" ");

/** What the page's bar says about getting the agent going: this host cannot be woken. */
const NUDGE = "The agent sees your asks on its next step on this canvas. To start it, send /mcp.drawio-canvas.asks in VS Code's Chat, or tell it to check your asks.";

const OPEN_TOOL = {
	name: "open_canvas",
	description:
		"Start here. Opens the draw.io canvas you and the person edit together, or returns it if it is open: file (a workspace .drawio) or xml to start from. Returns url (the person's draw.io editor, on this machine) and editor_open. When editor_open is false, show it to them: in VS Code open url with open_browser_page; elsewhere give them the link. The other tools need no id.",
	annotations: { title: "Open the draw.io canvas", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

/**
 * How each action looks to a client. VS Code runs a tool marked read-only
 * without asking; everything else asks the person once (they can allow it for
 * the session or always). Reads mark cells as read, which is the canvas's own
 * bookkeeping, not a change to anything of theirs.
 */
const ANNOTATIONS = {
	get_diagram: { title: "Read the diagram", readOnlyHint: true },
	get_changes: { title: "What the person changed", readOnlyHint: true },
	search_shapes: { title: "Search draw.io shapes", readOnlyHint: true },
	get_asks: { title: "The person's asks", readOnlyHint: true },
	edit_diagram: { title: "Edit cells" },
	insert_shapes: { title: "Insert library shapes" },
	replace_diagram: { title: "Replace a page or the diagram", destructiveHint: true },
	manage_pages: { title: "Pages", destructiveHint: true },
	manage_layers: { title: "Layers", destructiveHint: true },
	screenshot: { title: "Screenshot the diagram" },
	focus: { title: "Point the person at cells" },
	layout: { title: "Run a draw.io layout" },
	tidy: { title: "Tidy shapes" },
	update_ask: { title: "Mark an ask" },
	open_file: { title: "Open a .drawio file", destructiveHint: true },
	save_file: { title: "Save to the workspace" },
};

/**
 * Prompts: how the person starts the agent on the canvas from the chat, since
 * the canvas cannot. VS Code lists them under "/" in the Chat input.
 */
const PROMPTS = [
	{
		name: "asks",
		title: "Do my canvas asks",
		description: "Have the agent read what you asked for on the draw.io canvas and do it, top first.",
		arguments: [],
		text: () => "Check my asks on the draw.io canvas (get_asks) and do them, top first, keeping to their cells. Mark each with update_ask: working when you start, done or declined with a one-line reply.",
	},
	{
		name: "review",
		title: "Look over my canvas edits",
		description: "Have the agent look at what you changed on the draw.io canvas and fix what is broken or unfinished.",
		arguments: [],
		text: () =>
			"Look at what I changed on the draw.io canvas since you last looked (get_changes). Fix only what is clearly broken or unfinished (overlapping shapes, dangling edges, half-written labels) and tell me in one line what you did, or that it looks fine.",
	},
	{
		name: "draw",
		title: "Draw on the canvas",
		description: "Open the draw.io canvas beside the chat and have the agent draw something on it.",
		arguments: [{ name: "what", description: "What to draw, e.g. \"a three-tier web app on AWS\".", required: true }],
		text: ({ what }) => `Open the draw.io canvas (open_canvas; show it to me if my tab is not open) and draw: ${what}. Build on what is already there.`,
	},
];

/**
 * Hosts that run this plugin's canvas extension, and so must not get the tools
 * twice. `DRAWIO_CANVAS_MCP=on` offers them anyway (a Copilot CLI session
 * without experimental mode, say), `off` never.
 */
export function offersTools(clientInfo, env = process.env) {
	if (env.DRAWIO_CANVAS_MCP === "on") return true;
	if (env.DRAWIO_CANVAS_MCP === "off") return false;
	return !/copilot-cli|hoocode/i.test(String(clientInfo?.name ?? ""));
}

/** An MCP tool's input must be an object schema; the canvas also lets "no input" be null. */
function objectSchema(schema) {
	return Array.isArray(schema?.type) ? { ...schema, type: "object" } : (schema ?? { type: "object" });
}

function versionOf(extensionDir) {
	try {
		return JSON.parse(readFileSync(path.join(extensionDir, ".github", "plugin", "plugin.json"), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/**
 * Build the server.
 *
 * @param {object} options
 * @param {string} options.extensionDir The canvas's own directory (pages, draw.io, manifests).
 * @param {(message: object) => void} options.send Writes one JSON-RPC message to the client.
 * @param {(line: string) => void} [options.log] Diagnostics (stderr in `mcp.mjs`; never stdout).
 * @param {object} [options.env] Environment, for the workspace and the tool switch.
 * @param {string} [options.cwd] Where the client started us: the workspace, if it has no roots.
 * @param {boolean} [options.parkOnExit] Park the canvas when the process exits (the entry point only).
 * @param {object} [options.canvas] More options for `createDrawioCanvas` (tests).
 */
export function createMcpServer({ extensionDir, send, log = () => {}, env = process.env, cwd = process.cwd(), parkOnExit = false, canvas: canvasOptions = {} }) {
	const agent = new AgentLink();
	agent.nudge = NUDGE;
	let scope = null;
	const canvas = createDrawioCanvas({ createCanvas: (definition) => definition, CanvasError }, { extensionDir, log, agent, parkOnExit, snapshotScope: () => scope, ...canvasOptions });
	const actions = new Map(canvas.actions.map((action) => [action.name, action]));
	const openSchema = objectSchema(canvas.inputSchema);
	const tools = [
		{ ...OPEN_TOOL, inputSchema: openSchema },
		...canvas.actions.map((action) => ({
			name: action.name,
			description: action.description,
			inputSchema: objectSchema(action.inputSchema),
			annotations: { ...ANNOTATIONS[action.name], openWorldHint: false },
		})),
	];

	let client = null;
	let offered = true;
	let workspace;
	let opened = null;
	let opening = null;
	let nextRequest = 1;
	const pending = new Map();

	/** A request to the client (roots/list). */
	function request(method, params, timeoutMs = 5_000) {
		const id = `drawio-${nextRequest++}`;
		send({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			pending.set(id, {
				resolve: (value) => (clearTimeout(timer), resolve(value)),
				reject: (error) => (clearTimeout(timer), reject(error)),
			});
		});
	}

	/** The person's project: the client's first file root, else the environment, else where we were started. */
	async function workspaceDir() {
		if (workspace !== undefined) return workspace;
		let found = null;
		if (env.DRAWIO_CANVAS_WORKSPACE) found = path.resolve(env.DRAWIO_CANVAS_WORKSPACE);
		else if (client?.capabilities?.roots) {
			try {
				const { roots } = await request("roots/list", {});
				const root = (roots ?? []).find((item) => String(item?.uri ?? "").startsWith("file:"));
				if (root) found = fileURLToPath(root.uri);
			} catch (cause) {
				log(`roots/list: ${cause.message}`);
			}
		}
		// A client without roots usually starts its servers in the project. Not in
		// this plugin's own directory, though: that is where Copilot starts them.
		if (!found && path.resolve(cwd) !== path.resolve(extensionDir)) found = path.resolve(cwd);
		workspace = found;
		scope = `mcp-${createHash("sha256").update(workspace ?? "none").digest("hex").slice(0, 16)}`;
		return workspace;
	}

	/**
	 * Open the canvas once; later calls get the same one. Only the call that
	 * opened it is `fresh`: one that waited on another's open (the startup resume,
	 * say) still has its own file or xml to apply.
	 */
	async function ensureOpen(input) {
		if (opened) return { ...opened, fresh: false };
		if (opening) {
			await opening;
			return { ...opened, fresh: false };
		}
		opening = (async () => {
			const dir = await workspaceDir();
			const result = await canvas.open({ instanceId: INSTANCE, input: input ?? null, session: { workingDirectory: dir ?? undefined } });
			opened = result;
			return result;
		})().finally(() => {
			opening = null;
		});
		return { ...(await opening), fresh: true };
	}

	const text = (value) => ({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) });
	const refusal = (code, message) => ({ content: [text(`${code}: ${message}`)], isError: true });

	async function openTool(input) {
		const problem = checkValue(openSchema, input, "input");
		if (problem) return refusal("invalid_input", `open_canvas: ${problem}`);
		const state = await ensureOpen(input);
		const result = { url: state.url, title: state.title, status: state.status, editor_open: canvas.editorState(INSTANCE) !== "closed" };
		// Already open: a file or xml asked for now replaces what is there, through
		// the actions that guard the person's unseen work.
		if (!state.fresh && input?.file) Object.assign(result, { opened_file: await actions.get("open_file").handler({ instanceId: INSTANCE, input: { path: input.file } }) });
		else if (!state.fresh && input?.xml) Object.assign(result, { replaced: await actions.get("replace_diagram").handler({ instanceId: INSTANCE, input: { xml: input.xml } }) });
		result.next = result.editor_open
			? "The person has the editor open; work with the other tools."
			: "Show the person the editor: in VS Code call open_browser_page with url; elsewhere give them the link. Then work with the other tools.";
		return { content: [text(result)] };
	}

	async function callTool(name, input) {
		if (!offered) return refusal("not_offered", "drawio-canvas runs as a canvas in this host; use its canvas tools.");
		try {
			if (name === OPEN_TOOL.name) return await openTool(input ?? {});
			const action = actions.get(name);
			if (!action) return refusal("unknown_tool", `No tool "${name}". Tools: ${tools.map((tool) => tool.name).join(", ")}.`);
			const state = await ensureOpen(null);
			let result = await action.handler({ instanceId: INSTANCE, input: input ?? {} });
			if (state.fresh) result = { canvas: { url: state.url, note: "This call opened the canvas. Show the person the editor: in VS Code call open_browser_page with url." }, ...result };
			// The screenshot itself goes with the result, so the model sees it without reading the file.
			const image = name === "screenshot" ? await imageOf(result.path) : null;
			if (image) result = { ...result, note: "Rendered by the person's draw.io; the image is attached." };
			return { content: image ? [text(result), image] : [text(result)] };
		} catch (cause) {
			if (cause instanceof CanvasError) return refusal(cause.code, cause.message);
			log(`${name}: ${cause.stack ?? cause.message}`);
			return refusal("internal_error", cause.message);
		}
	}

	/** The screenshot itself, so a model with vision sees it without reading a file. */
	async function imageOf(relative) {
		if (typeof relative !== "string" || !/\.png$/i.test(relative)) return null;
		try {
			const absolute = path.isAbsolute(relative) || !workspace ? relative : path.join(workspace, relative);
			const png = await readFile(absolute);
			return png.length <= IMAGE_BUDGET ? { type: "image", data: png.toString("base64"), mimeType: "image/png" } : null;
		} catch {
			return null;
		}
	}

	/** After a restart (window reload, config change): take the parked canvas back, so the person's tab reconnects. */
	async function resume() {
		await workspaceDir();
		if (opened || opening || !(await hasSnapshot(INSTANCE, { scope }))) return;
		const state = await ensureOpen(null);
		log(`resumed the canvas at ${state.url}`);
	}

	const methods = {
		initialize: (params) => {
			client = { info: params?.clientInfo ?? {}, capabilities: params?.capabilities ?? {} };
			offered = offersTools(client.info, env);
			const asked = params?.protocolVersion;
			return {
				protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
				capabilities: offered ? { tools: { listChanged: false }, prompts: { listChanged: false } } : { tools: { listChanged: false } },
				// No title: VS Code names the tools after it when there is one
				// (mcp_<title>_get_diagram, cut to 18 characters before the tool).
				serverInfo: { name: "drawio-canvas", version: versionOf(extensionDir) },
				...(offered ? { instructions: INSTRUCTIONS } : {}),
			};
		},
		ping: () => ({}),
		"tools/list": () => ({ tools: offered ? tools : [] }),
		"tools/call": (params) => callTool(params?.name, params?.arguments),
		"prompts/list": () => ({ prompts: offered ? PROMPTS.map(({ text: _, ...prompt }) => prompt) : [] }),
		"prompts/get": (params) => {
			const prompt = offered && PROMPTS.find((item) => item.name === params?.name);
			if (!prompt) throw Object.assign(new Error(`No prompt "${params?.name}".`), { rpc: INVALID_PARAMS });
			const args = params?.arguments ?? {};
			for (const argument of prompt.arguments) {
				if (argument.required && !String(args[argument.name] ?? "").trim()) throw Object.assign(new Error(`Prompt "${prompt.name}" needs "${argument.name}".`), { rpc: INVALID_PARAMS });
			}
			return { description: prompt.description, messages: [{ role: "user", content: { type: "text", text: prompt.text(args) } }] };
		},
	};

	const notifications = {
		"notifications/initialized": () => {
			if (offered) resume().catch((cause) => log(`resume: ${cause.message}`));
		},
		"notifications/roots/list_changed": () => {
			// The canvas keeps the workspace it opened with; a later open would see the new one.
			if (!opened && !opening) workspace = undefined;
		},
	};

	/** One message from the client. */
	async function handle(message) {
		if (!message || typeof message !== "object") return;
		if (message.method === undefined) {
			// A response to one of our requests.
			const waiter = pending.get(message.id);
			if (!waiter) return;
			pending.delete(message.id);
			if (message.error) waiter.reject(new Error(message.error.message ?? "error"));
			else waiter.resolve(message.result);
			return;
		}
		if (message.id === undefined || message.id === null) {
			notifications[message.method]?.(message.params);
			return;
		}
		const method = methods[message.method];
		if (!method) {
			send({ jsonrpc: "2.0", id: message.id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${message.method}` } });
			return;
		}
		try {
			send({ jsonrpc: "2.0", id: message.id, result: await method(message.params) });
		} catch (cause) {
			send({ jsonrpc: "2.0", id: message.id, error: { code: cause.rpc ?? -32603, message: cause.message } });
		}
	}

	return {
		handle,
		/** One line from stdin. */
		receive(line) {
			if (!line.trim()) return;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
				return;
			}
			void handle(message);
		},
		/** For tests: close the canvas and its server. */
		async close() {
			if (opening) await opening.catch(() => {});
			if (opened) await canvas.onClose({ instanceId: INSTANCE });
			opened = null;
		},
	};
}
