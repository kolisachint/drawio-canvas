/**
 * The loopback server the person's browser talks to.
 *
 * One server per open canvas instance, on an ephemeral port on 127.0.0.1,
 * behind a per-instance capability token. A canvas extension is a Node process
 * running with the person's own privileges, and nothing in the host stands
 * between this code and their disk; the token is what stops any other process
 * on the machine — a web page they have open, a script they ran — from driving
 * their diagram or reading their workspace through it.
 *
 * **The token is the first path segment**, not a query parameter: the browser
 * resolves relative URLs (ES module imports, draw.io's hundreds of script,
 * stencil and image loads) against the page URL and drops query strings, while
 * a path prefix is carried along automatically. So every request stays
 * authenticated with no cookie (which on 127.0.0.1 is shared across ports) and
 * no rewriting of draw.io's own files. The check happens once, before routing,
 * so a route added later cannot forget it.
 *
 * **What is served.** `/` is the canvas page (`ui/index.html`), which hosts
 * draw.io from `/drawio/` — the pinned release, from the local cache, with one
 * script added (`ui/capture.js`). `/lite/` is the canvas's own small editor,
 * kept as a fallback for when draw.io cannot be fetched.
 *
 * **What leaves the machine: nothing.** draw.io's pages get a CSP whose
 * `connect-src`, `img-src`, `font-src` and `script-src` are `'self'`, so
 * even a draw.io feature that would phone home — a font service, an icon
 * search, an update check — is stopped by the browser, not by trusting
 * draw.io's offline flag.
 *
 * Live updates go out over Server-Sent Events: document versions, the person's
 * presence, and the agent's requests to the editor (`rpc`: screenshot, export,
 * focus, layout), which the page answers on `POST /api/rpc`.
 */

import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import * as path from "node:path";
import { readDiagramFile, resolveInWorkspace, toFileXml, writeWorkspaceFile } from "./files.mjs";
import { DiagramError, DrawioDocument } from "./model.mjs";
import { renderOptions, renderPageSvg } from "./render.mjs";
import { SOURCE_AGENT, SOURCE_HUMAN } from "./session.mjs";
import { readSettings, writeSettings } from "./settings.mjs";

/** Largest request body accepted. A big diagram with embedded images can be tens of MB. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".gif": "image/gif",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".map": "application/json; charset=utf-8",
	".wasm": "application/wasm",
};

/** The canvas's own pages: no inline script, nothing third-party, framing only its own editor. */
const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"connect-src 'self'",
	"font-src 'self' data:",
	"frame-src 'self'",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'none'",
].join("; ");

/**
 * draw.io's pages. Same-origin only, for everything that could carry data
 * out: the offline guarantee is enforced here rather than trusted. Inline
 * styles and data/blob URLs are how draw.io renders; `frame-ancestors 'self'`
 * lets the canvas page, and nothing else, embed it.
 */
const DRAWIO_CSP = [
	"default-src 'self'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"media-src 'self' data: blob:",
	"connect-src 'self' data: blob:",
	"font-src 'self' data:",
	"worker-src 'self' blob:",
	"frame-src 'self' data: blob:",
	"frame-ancestors 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'none'",
].join("; ");

/** How long the agent waits for the person's editor to answer a request. */
export const RPC_TIMEOUT_MS = 20_000;
/** How long an agent request waits for a loading tab to become the editor. */
export const EDITOR_LOAD_WAIT_MS = 15_000;

function constantTimeEquals(a, b) {
	const left = Buffer.from(String(a ?? ""));
	const right = Buffer.from(String(b ?? ""));
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new DiagramError("payload_too_large", "Request body is too large."));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

/**
 * Start the server for one canvas instance.
 *
 * @param {object} options
 * @param {import("./session.mjs").DiagramSession} options.session
 * @param {string} options.token
 * @param {string} options.extensionDir Where `ui/` and `lib/` are.
 * @param {import("./drawio-dist.mjs").DrawioProvider} [options.drawio] The editor install.
 * @param {(message: string) => void} [options.log]
 */
export async function startInstanceServer({ session, token, extensionDir, drawio, log }) {
	/** Open event streams, with the role each page declared. */
	const clients = new Set();
	/** Agent requests waiting on the editor: id → { resolve, reject, timer }. */
	const pending = new Map();
	/** Requests holding for an editor that is still loading. */
	const awaitingEditor = new Set();
	/** Let every held request look again: an editor arrived, or the last loading tab left. */
	const wakeAwaiting = () => {
		for (const waiter of awaitingEditor) {
			clearTimeout(waiter.timer);
			waiter.resolve();
		}
		awaitingEditor.clear();
	};

	const server = createServer((request, response) => {
		handle(request, response).catch((cause) => {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			sendJson(response, cause instanceof DiagramError ? 400 : 500, {
				error: cause?.message ?? String(cause),
				code: cause?.code ?? "internal_error",
			});
		});
	});

	function sendJson(response, status, body) {
		const payload = JSON.stringify(body);
		response.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": Buffer.byteLength(payload),
			"Cache-Control": "no-store",
		});
		response.end(payload);
	}

	function notFound(response) {
		response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
		response.end("not found");
	}

	/** A file from the extension's own `ui/` or `lib/`. */
	async function serveAsset(response, relative) {
		const type = CONTENT_TYPES[path.extname(relative).toLowerCase()];
		if (!type || relative.split(/[\\/]/).includes("..")) return notFound(response);
		let contents;
		try {
			contents = await readFile(path.join(extensionDir, relative));
		} catch {
			return notFound(response);
		}
		response.writeHead(200, {
			"Content-Type": type,
			"Content-Security-Policy": CSP,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		});
		response.end(contents);
	}

	/** A file from the draw.io install, confined to it. */
	async function serveDrawio(response, relative) {
		const install = drawio?.installed;
		if (!install) {
			response.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
			response.end("draw.io is not installed yet");
			return;
		}
		const name = decodeURIComponent(relative || "index.html");
		const type = CONTENT_TYPES[path.extname(name).toLowerCase()];
		if (!type || name.split(/[\\/]/).includes("..") || name.includes("\0")) return notFound(response);
		const root = await realpath(install.dir);
		let absolute;
		try {
			absolute = await realpath(path.join(root, name));
		} catch {
			return notFound(response);
		}
		if (!absolute.startsWith(root + path.sep)) return notFound(response);
		let contents = await readFile(absolute);
		const headers = {
			"Content-Type": type,
			"Content-Security-Policy": DRAWIO_CSP,
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			// The editor is a pinned release, so its files never change under a
			// given URL; only the page itself is re-read every time.
			"Cache-Control": name === "index.html" ? "no-store" : "private, max-age=86400",
		};
		if (name === "index.html") {
			const page = contents.toString("utf8");
			const hook = '<script src="js/main.js"></script>';
			// Without the capture script the editor opens but never syncs, which would
			// look like a working canvas that silently drops every edit. Say so.
			if (!page.includes(hook)) log?.(`draw.io's index.html has no ${hook}; the canvas cannot attach to this draw.io build`);
			contents = Buffer.from(page.replace(hook, `<script src="../ui/capture.js"></script>${hook}`));
		}
		response.writeHead(200, headers);
		response.end(contents);
	}

	/**
	 * Ask the person's editor to do something, and wait for the answer.
	 *
	 * Goes to one tab — the most recently opened, which is the one the person is
	 * most likely looking at. Sending it to every tab would run a layout once per
	 * tab, each on top of the last. With no tab open there is no editor to ask,
	 * and that is said plainly.
	 */
	/**
	 * The newest editor, waiting for one only while a tab is visibly loading.
	 *
	 * Without a tab this fails at once, so the agent is not kept waiting on a
	 * person who is not there. With one mid-load it holds on: the agent's first
	 * screenshot right after the person opened the link used to fail with
	 * no_editor during the second or two draw.io takes to start.
	 */
	async function editorClient() {
		const newest = () => [...clients].filter((client) => client.role === "editor").at(-1);
		const loading = () => [...clients].some((client) => client.role === "loading");
		if (newest()) return newest();
		// A "loading" stream is a tab that is open right now and booting draw.io;
		// it closes with the tab, so this never waits on someone who has left.
		if (loading()) {
			await new Promise((resolve) => {
				const waiter = { resolve, timer: setTimeout(() => (awaitingEditor.delete(waiter), resolve()), EDITOR_LOAD_WAIT_MS) };
				awaitingEditor.add(waiter);
			});
			if (newest()) return newest();
			if (loading()) throw new DiagramError("no_editor", `The person's draw.io tab is still loading after ${EDITOR_LOAD_WAIT_MS / 1000}s. Try again shortly.`);
		}
		throw new DiagramError("no_editor", "No draw.io editor is open for this canvas. Ask the person to open the canvas URL, then try again.");
	}

	async function requestEditor(method, params = {}, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
		const editor = await editorClient();
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new DiagramError("editor_timeout", `The person's editor did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s.`));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			editor.response.write(`event: rpc\ndata: ${JSON.stringify({ id, method, params })}\n\n`);
		});
	}

	async function handle(request, response) {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname === "/favicon.ico") {
			response.writeHead(204, { "Cache-Control": "no-store" });
			response.end();
			return;
		}
		const [, presented, ...segments] = url.pathname.split("/");
		if (!constantTimeEquals(presented, token)) {
			response.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
			response.end("forbidden");
			return;
		}
		// Without the trailing slash the browser resolves every relative URL in the
		// page against the token segment's *parent*, which 403s the whole page.
		if (segments.length === 0) {
			response.writeHead(301, { Location: `/${token}/`, "Cache-Control": "no-store" });
			response.end();
			return;
		}
		const route = `/${segments.join("/")}`;
		const get = request.method === "GET";
		const postTo = (target) => request.method === "POST" && route === target;
		const body = async () => JSON.parse((await readBody(request)) || "{}");

		if (get && (route === "/" || route === "/index.html")) return serveAsset(response, path.join("ui", "index.html"));
		if (get && (route === "/lite" || route === "/lite/")) return serveAsset(response, path.join("ui", "lite", "index.html"));
		if (get && (route.startsWith("/ui/") || route.startsWith("/lib/"))) return serveAsset(response, route.slice(1));
		if (get && route.startsWith("/drawio/")) return serveDrawio(response, route.slice("/drawio/".length));

		if (get && route === "/api/editor") {
			if (drawio && !drawio.installed) drawio.ensure().catch(() => {});
			return sendJson(response, 200, drawio ? drawio.status() : { state: "failed", error: "no draw.io provider" });
		}
		if (get && route === "/api/state") return sendJson(response, 200, session.state());
		if (get && route === "/api/settings") return sendJson(response, 200, await readSettings(drawio?.env));
		if (postTo("/api/settings")) {
			await writeSettings(await body(), drawio?.env);
			return sendJson(response, 200, { ok: true });
		}
		if (get && route === "/api/events") return streamEvents(request, response, url.searchParams.get("role") ?? "viewer");

		if (postTo("/api/sync")) {
			const { changes, source } = await body();
			const result = session.applyEditor(changes ?? [], {
				source: source === SOURCE_AGENT ? SOURCE_AGENT : SOURCE_HUMAN,
				// A layout the agent asked for is the agent's edit, but it moved cells
				// the agent has not seen at their new positions.
				...(source === SOURCE_AGENT ? { seen: false } : {}),
			});
			return sendJson(response, 200, { version: result.version, applied: result.applied, errors: result.errors });
		}
		if (postTo("/api/presence")) {
			session.setPresence(await body());
			return sendJson(response, 200, { ok: true });
		}
		if (postTo("/api/rpc")) {
			const { id, result, error } = await body();
			const waiting = pending.get(id);
			if (waiting) {
				pending.delete(id);
				clearTimeout(waiting.timer);
				if (error) waiting.reject(new DiagramError("editor_error", String(error)));
				else waiting.resolve(result);
			}
			return sendJson(response, 200, { ok: Boolean(waiting) });
		}

		// The lite editor's endpoints, and the canvas page's file and history ones.
		if (postTo("/api/ops")) {
			const input = await body();
			const result = session.apply(input.page ?? {}, input.operations ?? [], { source: SOURCE_HUMAN, label: input.label });
			return sendJson(response, 200, { version: result.version, errors: result.errors, applied: result.applied });
		}
		if (postTo("/api/document")) {
			const input = await body();
			return sendJson(response, 200, { version: session.replace(input.xml, { source: SOURCE_HUMAN, label: input.label ?? "replaced document" }) });
		}
		if (postTo("/api/pages")) return sendJson(response, 200, session.pages({ ...(await body()), source: SOURCE_HUMAN }));
		if (get && route === "/api/history") return sendJson(response, 200, { versions: session.historySummary() });
		if (get && route === "/api/history/svg") {
			const version = Number.parseInt(url.searchParams.get("version") ?? "", 10);
			const xml = session.versionXml(version);
			if (!xml) return sendJson(response, 404, { error: `No version ${version} in history.` });
			const page = DrawioDocument.parse(xml).page({ page_index: Number.parseInt(url.searchParams.get("page") ?? "0", 10) });
			response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store", "Content-Security-Policy": CSP });
			response.end(page ? renderPageSvg(page, renderOptions()) : "<svg xmlns='http://www.w3.org/2000/svg'/>");
			return;
		}
		if (postTo("/api/restore")) {
			const input = await body();
			return sendJson(response, 200, { version: session.restore(Number.parseInt(input.version, 10), { source: SOURCE_HUMAN }) });
		}
		if (postTo("/api/file")) return sendJson(response, 200, await handleFile(await body()));

		return notFound(response);
	}

	/** Open or save a workspace file on the person's behalf. */
	async function handleFile(input) {
		const relative = String(input.path ?? "").trim();
		if (relative.length === 0) throw new DiagramError("missing_path", "A file path is required.");
		const absolute = resolveInWorkspace(session.workspace, relative);
		if (input.op === "open") {
			const { xml, inflatedPages } = await readDiagramFile(absolute);
			session.replace(xml, { source: SOURCE_HUMAN, label: `opened ${relative}` });
			session.filePath = relative;
			return { opened: relative, inflatedPages, version: session.version };
		}
		if (input.op === "save") {
			const format = (input.format ?? path.extname(absolute).slice(1) ?? "drawio").toLowerCase();
			const contents =
				format === "svg"
					? renderPageSvg(session.document.page(input.page ?? {}) ?? session.document.page(), renderOptions())
					: toFileXml(session.document);
			await writeWorkspaceFile(absolute, contents);
			if (format !== "svg") session.filePath = relative;
			return { saved: relative, bytes: Buffer.byteLength(contents), format };
		}
		throw new DiagramError("unknown_file_op", `Unknown file operation "${input.op}".`);
	}

	/**
	 * One SSE stream per open tab.
	 *
	 * The heartbeat is not decoration: an idle socket through a sleeping laptop
	 * dies silently, and a dead event stream looks exactly like a canvas the
	 * agent has stopped touching.
	 */
	function streamEvents(request, response, role) {
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store",
			Connection: "keep-alive",
			"Content-Security-Policy": CSP,
		});
		response.write("retry: 1000\n\n");
		response.write(`event: hello\ndata: ${JSON.stringify({ version: session.version })}\n\n`);
		const client = { role, response };
		clients.add(client);
		if (role === "editor") wakeAwaiting();
		const unsubscribe = session.subscribe((event) => {
			response.write(`event: ${event.type ?? "change"}\ndata: ${JSON.stringify(event)}\n\n`);
		});
		const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
		const stop = () => {
			clearInterval(heartbeat);
			unsubscribe();
			clients.delete(client);
			if (client.role === "loading" && ![...clients].some((other) => other.role === "loading" || other.role === "editor")) wakeAwaiting();
		};
		request.on("close", stop);
		response.on("error", stop);
	}

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const { port } = server.address();
	log?.(`serving on 127.0.0.1:${port}`);
	return {
		port,
		url: `http://127.0.0.1:${port}/${token}/`,
		requestEditor,
		editorsConnected: () => [...clients].filter((client) => client.role === "editor").length,
		/** An editor is connected, or a tab is open and booting one; requestEditor will wait for it. */
		editorReachable: () => [...clients].some((client) => client.role === "editor" || client.role === "loading"),
		close: () =>
			new Promise((resolve) => {
				for (const waiting of pending.values()) {
					clearTimeout(waiting.timer);
					waiting.reject(new DiagramError("closed", "The canvas closed."));
				}
				pending.clear();
				wakeAwaiting();
				// closeAllConnections, or an open SSE stream keeps the port alive well
				// past the close and the next open fails on a port that is still bound.
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}
