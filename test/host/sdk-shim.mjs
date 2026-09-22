/**
 * The child half of the canvas wire protocol, for tests.
 *
 * A canvas extension imports `@github/copilot-sdk/extension`, which it never
 * installs: the host resolves that specifier when it forks the child. This file
 * is what `test/host/fork.mjs` resolves it to, so `extension.mjs` can be forked
 * and driven here exactly as a host drives it — same import, same stdio
 * framing, same three provider callbacks — with nothing installed and no host
 * checked out.
 *
 * It implements GitHub's documented surface and hoocode's NDJSON envelope. It is
 * a test double for the *host*, not for this canvas: everything under test is
 * the real extension, running as a real child process. The canvas is also
 * exercised against hoocode's own shim; see the README.
 */

const ENVELOPE = 1;
const PROTOCOL_VERSION = 3;

/** Mirrors the SDK's `CanvasError`: a message plus a machine-readable code. */
export class CanvasError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "CanvasError";
		this.code = code;
	}
}

/** Mirrors the SDK's `createCanvas`: a declaration plus in-process handlers. */
export function createCanvas(options) {
	const actions = (options.actions ?? []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
	return {
		declaration: {
			id: options.id,
			displayName: options.displayName,
			description: options.description,
			inputSchema: options.inputSchema,
			actions: actions.length > 0 ? actions : undefined,
		},
		open: options.open,
		onClose: options.onClose,
		handlers: new Map((options.actions ?? []).map((action) => [action.name, action.handler])),
	};
}

/** Announce the canvases, then serve provider callbacks until stdin ends. */
export async function joinSession(config = {}) {
	const canvases = new Map((config.canvases ?? []).map((canvas) => [canvas.declaration.id, canvas]));
	const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

	send({
		envelope: ENVELOPE,
		type: "ready",
		protocolVersion: PROTOCOL_VERSION,
		extensionId: process.env.HOOCODE_CANVAS_EXTENSION_ID ?? "unknown-extension",
		canvases: [...canvases.values()].map((canvas) => canvas.declaration),
		unsupported: ["tools", "hooks", "factories", "onPermissionRequest"].filter((key) => config[key] !== undefined),
	});

	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (line.length > 0) void dispatch(JSON.parse(line));
		}
	});

	async function dispatch(message) {
		if (message.type !== "request") return;
		try {
			send({ envelope: ENVELOPE, type: "response", id: message.id, result: (await invoke(message)) ?? null });
		} catch (cause) {
			send({
				envelope: ENVELOPE,
				type: "error",
				id: message.id,
				code: cause instanceof CanvasError ? cause.code : "internal_error",
				message: cause?.message ?? String(cause),
			});
		}
	}

	async function invoke({ method, params }) {
		const canvas = canvases.get(params.canvasId);
		if (!canvas) throw new CanvasError("unknown_target", `No canvas "${params.canvasId}".`);
		if (method === "canvas.open") return JSON.parse(JSON.stringify(await canvas.open(params)));
		if (method === "canvas.close") return (await canvas.onClose?.(params)) ?? null;
		if (method === "canvas.action.invoke") {
			const handler = canvas.handlers.get(params.actionName);
			if (!handler) throw new CanvasError("unknown_target", `No action "${params.actionName}".`);
			const result = await handler(params);
			return result === undefined ? null : JSON.parse(JSON.stringify(result));
		}
		throw new CanvasError("unknown_target", `Unsupported method "${method}".`);
	}

	return {
		log: async (message, options) => send({ envelope: ENVELOPE, type: "log", message, level: options?.level }),
	};
}
