/**
 * The host half: fork `extension.mjs` and speak the wire protocol to it.
 *
 * The SDK specifier is made resolvable with a module-resolution hook delivered
 * through `--import` data: URLs, which is how hoocode does it and is the only
 * way to keep the extension directory free of `node_modules` — the constraint
 * the whole canvas format rests on. Nothing is written to disk.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_URL = pathToFileURL(path.join(HERE, "sdk-shim.mjs")).href;

const HOOKS = `
let shimUrl;
export function initialize(data) { shimUrl = data.shimUrl; }
export async function resolve(specifier, context, next) {
	if (specifier === "@github/copilot-sdk" || specifier.startsWith("@github/copilot-sdk/")) {
		return { url: shimUrl, shortCircuit: true };
	}
	return next(specifier, context);
}
`;

const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

function resolverArg() {
	const hooks = dataModule(HOOKS);
	return dataModule(`
import { register } from "node:module";
register(${JSON.stringify(hooks)}, { parentURL: import.meta.url, data: ${JSON.stringify({ shimUrl: SHIM_URL })} });
`);
}

/** Fork the extension and return a small client for the three provider calls. */
export function forkExtension({ entry, extensionId = "drawio-canvas", workspace } = {}) {
	const child = spawn(process.execPath, ["--import", resolverArg(), entry], {
		cwd: path.dirname(path.dirname(entry)),
		env: { ...process.env, HOOCODE_CANVAS_EXTENSION_ID: extensionId, SESSION_ID: "protocol-test" },
		stdio: ["pipe", "pipe", "pipe"],
	});

	const pending = new Map();
	const logs = [];
	/** Non-protocol stdout: a stray `console.log` corrupts the channel, so it is an error. */
	const strays = [];
	const stderr = [];
	let nextId = 1;
	let onReady;
	let onReadyFailed;
	const ready = new Promise((resolve, reject) => {
		onReady = resolve;
		onReadyFailed = reject;
	});

	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (line.length === 0) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				strays.push(line);
				continue;
			}
			if (message.type === "ready") onReady(message);
			else if (message.type === "log") logs.push(message.message);
			else if (message.type === "response") pending.get(message.id)?.resolve(message.result);
			else if (message.type === "error") {
				const error = new Error(message.message);
				error.code = message.code;
				pending.get(message.id)?.reject(error);
			} else strays.push(line);
			pending.delete(message.id);
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	child.on("exit", (code, signal) => onReadyFailed(new Error(`extension exited (code ${code}, signal ${signal})`)));

	const call = (method, params) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			child.stdin.write(`${JSON.stringify({ envelope: 1, type: "request", id, method, params })}\n`);
		});

	const context = (instanceId) => ({
		sessionId: "protocol-test",
		extensionId,
		canvasId: "drawio-canvas",
		instanceId,
		host: { capabilities: { canvases: true } },
		session: workspace ? { workingDirectory: workspace } : undefined,
	});

	return {
		ready,
		logs,
		strays,
		stderr,
		open: (instanceId, input) => call("canvas.open", { ...context(instanceId), input }),
		invoke: (instanceId, actionName, input) => call("canvas.action.invoke", { ...context(instanceId), actionName, input }),
		close: (instanceId) => call("canvas.close", context(instanceId)),
		stop: () =>
			new Promise((resolve) => {
				child.once("exit", () => resolve());
				child.stdin.end();
				child.kill();
			}),
	};
}
