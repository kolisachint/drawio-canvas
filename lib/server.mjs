/**
 * The loopback server the person's browser talks to.
 *
 * One server per open canvas instance, on an ephemeral port on 127.0.0.1,
 * behind a per-instance capability token. That is the posture the catalog
 * canvases use and the reason is worth keeping in mind while editing this file:
 * a canvas extension is a Node process running with the person's own
 * privileges, and nothing in the host stands between this code and their disk.
 * The token is what stops any other process on the machine — a web page they
 * have open, a script they ran — from driving their diagram.
 *
 * **The token is the first path segment**, not a query parameter, and that is
 * load-bearing rather than stylistic. The page is ES modules: the browser
 * resolves `import "../lib/model.mjs"` against the importing module's URL and
 * drops its query string, so a `?token=` scheme 403s every import the moment
 * the page has more than one file. A path prefix is carried by relative
 * resolution automatically — `/<token>/ui/app.mjs` importing `../lib/model.mjs`
 * asks for `/<token>/lib/model.mjs` — so every request stays authenticated with
 * no cookie (which on 127.0.0.1 is shared across ports and would hand this
 * token to every other local server the person's browser talks to) and no
 * templating of the source files.
 *
 * Two consequences are enforced here rather than trusted to callers:
 *
 *  - **Every route checks the token**, including the static assets. The check
 *    happens once, before routing, so a route added later cannot forget it.
 *  - **Every file path goes through `resolveInWorkspace`.** See `files.mjs`.
 *
 * The page gets live updates over Server-Sent Events rather than polling. A
 * poll is a fixed cost that buys a fixed lag; SSE on loopback costs one idle
 * socket and makes the agent's edit appear while the person is still looking at
 * the sentence that asked for it, which is the entire point of a shared surface.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { DiagramError } from "./model.mjs";
import { renderPageSvg, renderOptions } from "./render.mjs";
import { SOURCE_HUMAN } from "./session.mjs";
import { readDiagramFile, resolveInWorkspace, toFileXml, writeWorkspaceFile } from "./files.mjs";
import { DrawioDocument } from "./model.mjs";

/** Largest request body accepted. A big diagram is ~1 MB; 16 is room to be wrong. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Static files the page may load, by extension. Anything else is 404, not 403. */
const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
};

/**
 * The page's content security policy.
 *
 * `default-src 'self'` with no `script-src` escape hatch: every script this page
 * runs is a file served from this server, so there is no inline script to allow
 * and no CDN to reach. Inline *styles* are allowed because the rendered SVG
 * carries style attributes, and `frame-ancestors 'none'` because nothing should
 * be framing a canvas that can write to the person's repository.
 */
const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"connect-src 'self'",
	"font-src 'self'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
	"form-action 'none'",
].join("; ");

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
 * Resolves once the port is bound, so `open` can return a URL that already
 * works — a canvas that returns a URL the browser cannot reach yet looks broken
 * in the one second anyone is watching.
 */
export async function startInstanceServer({ session, token, extensionDir, log }) {
	const server = createServer((request, response) => {
		handle(request, response).catch((cause) => {
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

	async function serveAsset(response, relative) {
		const extension = path.extname(relative).toLowerCase();
		const type = CONTENT_TYPES[extension];
		// A path that is not one of ours is a 404 rather than a traversal attempt to
		// argue about: the allowed set is two directories of known file types.
		if (!type || relative.includes("..")) {
			response.writeHead(404, { "Content-Type": "text/plain" });
			response.end("not found");
			return;
		}
		const absolute = path.join(extensionDir, relative);
		let contents;
		try {
			contents = await readFile(absolute, "utf8");
		} catch {
			response.writeHead(404, { "Content-Type": "text/plain" });
			response.end("not found");
			return;
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

	async function handle(request, response) {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		// The browser asks for this on its own, outside the token prefix, and a 403
		// in the console reads like a broken page to whoever opens the dev tools.
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

		if (request.method === "GET" && (route === "/" || route === "/index.html")) {
			await serveAsset(response, path.join("ui", "index.html"));
			return;
		}
		if (request.method === "GET" && (route.startsWith("/ui/") || route.startsWith("/lib/"))) {
			await serveAsset(response, route.slice(1));
			return;
		}

		if (request.method === "GET" && route === "/api/state") {
			sendJson(response, 200, session.state());
			return;
		}

		if (request.method === "GET" && route === "/api/events") {
			streamEvents(request, response);
			return;
		}

		if (request.method === "POST" && route === "/api/ops") {
			const body = JSON.parse((await readBody(request)) || "{}");
			const result = session.apply(body.page ?? {}, body.operations ?? [], {
				source: SOURCE_HUMAN,
				label: body.label,
			});
			sendJson(response, 200, { version: result.version, errors: result.errors, applied: result.applied });
			return;
		}

		if (request.method === "POST" && route === "/api/document") {
			const body = JSON.parse((await readBody(request)) || "{}");
			const version = session.replace(body.xml, { source: SOURCE_HUMAN, label: body.label ?? "replaced document" });
			sendJson(response, 200, { version });
			return;
		}

		if (request.method === "POST" && route === "/api/pages") {
			const body = JSON.parse((await readBody(request)) || "{}");
			sendJson(response, 200, session.pages({ ...body, source: SOURCE_HUMAN }));
			return;
		}

		if (request.method === "GET" && route === "/api/history") {
			sendJson(response, 200, { versions: session.historySummary() });
			return;
		}

		if (request.method === "GET" && route === "/api/history/svg") {
			const version = Number.parseInt(url.searchParams.get("version") ?? "", 10);
			const xml = session.versionXml(version);
			if (!xml) {
				sendJson(response, 404, { error: `No version ${version} in history.` });
				return;
			}
			const page = DrawioDocument.parse(xml).page({ page_index: Number.parseInt(url.searchParams.get("page") ?? "0", 10) });
			response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store", "Content-Security-Policy": CSP });
			response.end(page ? renderPageSvg(page, renderOptions()) : "<svg xmlns='http://www.w3.org/2000/svg'/>");
			return;
		}

		if (request.method === "POST" && route === "/api/restore") {
			const body = JSON.parse((await readBody(request)) || "{}");
			const version = session.restore(Number.parseInt(body.version, 10), { source: SOURCE_HUMAN });
			sendJson(response, 200, { version });
			return;
		}

		if (request.method === "POST" && route === "/api/file") {
			sendJson(response, 200, await handleFile(JSON.parse((await readBody(request)) || "{}")));
			return;
		}

		response.writeHead(404, { "Content-Type": "text/plain" });
		response.end("not found");
	}

	/** Open or save a workspace file on the person's behalf. */
	async function handleFile(body) {
		const relative = String(body.path ?? "").trim();
		if (relative.length === 0) throw new DiagramError("missing_path", "A file path is required.");
		const absolute = resolveInWorkspace(session.workspace, relative);
		if (body.op === "open") {
			const { xml, inflatedPages } = await readDiagramFile(absolute);
			session.replace(xml, { source: SOURCE_HUMAN, label: `opened ${relative}` });
			session.filePath = relative;
			return { opened: relative, inflatedPages, version: session.version };
		}
		if (body.op === "save") {
			const format = (body.format ?? path.extname(absolute).slice(1) ?? "drawio").toLowerCase();
			const contents =
				format === "svg"
					? renderPageSvg(session.document.page(body.page ?? {}) ?? session.document.page(), renderOptions())
					: toFileXml(session.document);
			await writeWorkspaceFile(absolute, contents);
			if (format !== "svg") session.filePath = relative;
			return { saved: relative, bytes: Buffer.byteLength(contents), format };
		}
		throw new DiagramError("unknown_file_op", `Unknown file operation "${body.op}".`);
	}

	/**
	 * One SSE stream per open tab.
	 *
	 * The heartbeat is not decoration: an idle socket through any proxy or a
	 * sleeping laptop dies silently, and a dead event stream looks exactly like a
	 * canvas the agent has stopped touching. A comment line every 25 seconds keeps
	 * it honest, and the page reconnects on its own if it ever does drop.
	 */
	function streamEvents(request, response) {
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store",
			Connection: "keep-alive",
			"Content-Security-Policy": CSP,
		});
		response.write(`retry: 1000\n\n`);
		response.write(`event: hello\ndata: ${JSON.stringify({ version: session.version })}\n\n`);
		const unsubscribe = session.subscribe((event) => {
			response.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
		});
		const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
		const stop = () => {
			clearInterval(heartbeat);
			unsubscribe();
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
		close: () =>
			new Promise((resolve) => {
				// closeAllConnections, or an open SSE stream keeps the port alive well
				// past the close and the next open fails on a port that is still bound.
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}
