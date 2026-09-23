/**
 * The draw.io editor this canvas serves: one pinned release, verified, cached.
 *
 * The person edits in draw.io itself — the same editor as the desktop app, with
 * every shape library, layers, pages, the format panel, find, layout and
 * export — not in an imitation of it. That editor is 150 MB of JavaScript,
 * stencils and icons, which is too much to commit into a canvas that is
 * installed by cloning. So the canvas carries the release *archive* —
 * `assets/drawio-<version>.war`, 54 MB, draw.io's own release artifact — and
 * unpacks it on first use:
 *
 *   - one release, named by version and by the SHA-256 of its `draw.war`;
 *   - unpacked once, on first open (about two seconds), from the bundled
 *     archive — no network, no download, no prefetch;
 *   - refused unless the hash matches, then unpacked into a per-version cache
 *     directory, atomically, so a half-written editor can never be served;
 *   - served from there, on loopback, to nobody but the token holder.
 *
 * Only if the bundled archive is missing (a checkout that dropped it) does the
 * canvas fall back to fetching the same pinned release from GitHub, and only
 * when the page asks for the editor; `DRAWIO_CANVAS_OFFLINE=1` forbids even
 * that.
 *
 * Upgrading draw.io is a deliberate change to {@link PINNED} (and to the shape
 * index built from it, see `scripts/build-shape-index.mjs`), reviewed like any
 * other diff — never something that happens because upstream moved.
 *
 * Two overrides: `DRAWIO_CANVAS_DRAWIO_DIR` names an unpacked draw.io webapp
 * (a checkout's `src/main/webapp` works) to serve as is, and
 * `DRAWIO_CANVAS_DRAWIO_WAR` names another copy of the pinned `draw.war`, which
 * is verified and unpacked exactly as the bundled one is.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, platform } from "node:os";
import * as path from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { listZip } from "./zip.mjs";

/** The draw.io release this canvas is built and tested against. */
export const PINNED = Object.freeze({
	version: "31.4.6",
	url: "https://github.com/jgraph/drawio/releases/download/v31.4.6/draw.war",
	sha256: "f7798104da17d7e9494ab348c3ba9b2a65640096bd54f704d7a0fa2fab283938",
	bytes: 53_762_297,
});

/** The archive shipped in this repository. */
export const BUNDLED_ARCHIVE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "assets", `drawio-${PINNED.version}.war`);

/** Marker written last into a finished install; its content is the archive hash. */
const COMPLETE_MARKER = ".drawio-canvas-complete";

/**
 * Parts of the archive the canvas never serves: the Java servlet side and the
 * service worker, which would try to cache the editor under a loopback origin
 * whose port changes every time a canvas opens.
 */
const SKIPPED = [/^WEB-INF\//, /^META-INF\//, /^service-worker\.js/, /^workbox-/];

export function cacheRoot(env = process.env) {
	if (env.DRAWIO_CANVAS_CACHE) return path.resolve(env.DRAWIO_CANVAS_CACHE);
	if (platform() === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "drawio-canvas");
	if (platform() === "darwin") return path.join(homedir(), "Library", "Caches", "drawio-canvas");
	return path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "drawio-canvas");
}

export function installDir(env = process.env) {
	return path.join(cacheRoot(env), `drawio-${PINNED.version}`);
}

function looksLikeWebapp(dir) {
	return existsSync(path.join(dir, "index.html")) && existsSync(path.join(dir, "js", "app.min.js"));
}

/**
 * Where the editor is, if it is anywhere: `{ dir, version, source }` or null.
 *
 * An override directory is taken as the person's word — it is their checkout —
 * but it still has to look like a draw.io webapp, so a typo fails here with a
 * sentence instead of as a blank page.
 */
export async function locateDrawio(env = process.env) {
	if (env.DRAWIO_CANVAS_DRAWIO_DIR) {
		const dir = path.resolve(env.DRAWIO_CANVAS_DRAWIO_DIR);
		if (!looksLikeWebapp(dir)) {
			throw new Error(`DRAWIO_CANVAS_DRAWIO_DIR=${dir} is not a draw.io webapp (no index.html and js/app.min.js).`);
		}
		let version = "custom";
		try {
			version = (await readFile(path.join(dir, "..", "..", "..", "VERSION"), "utf8")).trim() || version;
		} catch {
			// Not a checkout layout; the version is only informational.
		}
		return { dir, version, source: "override" };
	}
	const dir = installDir(env);
	try {
		const marker = (await readFile(path.join(dir, COMPLETE_MARKER), "utf8")).trim();
		if (marker === PINNED.sha256 && looksLikeWebapp(dir)) return { dir, version: PINNED.version, source: "cache" };
	} catch {
		// Not installed yet.
	}
	return null;
}

function proxyFor(url, env) {
	const proxy = env.HTTPS_PROXY || env.https_proxy;
	if (!proxy) return null;
	const noProxy = (env.NO_PROXY || env.no_proxy || "")
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
	const host = url.hostname.toLowerCase();
	if (noProxy.some((rule) => rule === "*" || host === rule.replace(/^\./, "") || host.endsWith(rule.startsWith(".") ? rule : `.${rule}`))) {
		return null;
	}
	return new URL(proxy);
}

/**
 * GET over HTTPS, through an `HTTPS_PROXY` when one is set.
 *
 * Node's built-in fetch ignores proxy variables, and a corporate network that
 * requires one is exactly where "the canvas works on my laptop" goes to die. A
 * CONNECT tunnel is twenty lines, so it is here rather than a dependency.
 */
function get(url, env) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const proxy = proxyFor(target, env);
		const options = {
			host: target.hostname,
			port: target.port || 443,
			path: `${target.pathname}${target.search}`,
			headers: { "User-Agent": "drawio-canvas", Accept: "application/octet-stream" },
		};
		const send = (extra = {}) => {
			const request = httpsRequest({ ...options, ...extra }, resolve);
			request.on("error", reject);
			request.setTimeout(60_000, () => request.destroy(new Error(`Timed out fetching ${target.host}.`)));
			request.end();
		};
		if (!proxy) return send();
		const tunnel = httpRequest({
			host: proxy.hostname,
			port: proxy.port || 80,
			method: "CONNECT",
			path: `${target.hostname}:${target.port || 443}`,
			headers: proxy.username
				? { "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` }
				: {},
		});
		tunnel.on("connect", (response, socket) => {
			if (response.statusCode !== 200) {
				socket.destroy();
				reject(new Error(`Proxy refused the tunnel to ${target.host}: HTTP ${response.statusCode}.`));
				return;
			}
			send({ createConnection: () => tlsConnect({ socket, servername: target.hostname }) });
		});
		tunnel.on("error", reject);
		tunnel.end();
	});
}

/** Download `url` into memory, following redirects and reporting progress. */
export async function download(url, { env = process.env, onProgress = () => {}, redirects = 5 } = {}) {
	let current = url;
	for (let hop = 0; hop <= redirects; hop += 1) {
		const response = await get(current, env);
		if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
			response.resume();
			current = new URL(response.headers.location, current).toString();
			continue;
		}
		if (response.statusCode !== 200) {
			response.resume();
			throw new Error(`Download of ${url} failed: HTTP ${response.statusCode}.`);
		}
		const total = Number.parseInt(response.headers["content-length"] ?? "0", 10) || PINNED.bytes;
		const chunks = [];
		let received = 0;
		for await (const chunk of response) {
			chunks.push(chunk);
			received += chunk.length;
			onProgress({ received, total });
		}
		return Buffer.concat(chunks);
	}
	throw new Error(`Too many redirects fetching ${url}.`);
}

/** Verify and unpack a `draw.war` into the cache, atomically. Returns the install. */
export async function installFromArchive(archive, { env = process.env } = {}) {
	const digest = createHash("sha256").update(archive).digest("hex");
	if (digest !== PINNED.sha256) {
		throw new Error(
			`draw.war does not match the pinned release ${PINNED.version}: expected sha256 ${PINNED.sha256}, got ${digest}. Refusing to serve it.`,
		);
	}
	const finalDir = installDir(env);
	const staging = `${finalDir}.partial-${randomBytes(4).toString("hex")}`;
	await mkdir(staging, { recursive: true });
	try {
		for (const entry of listZip(archive)) {
			if (entry.directory || SKIPPED.some((pattern) => pattern.test(entry.name))) continue;
			// Archive names are relative, forward-slashed and never climb; anything
			// else is not a draw.war and is not written anywhere.
			if (entry.name.startsWith("/") || entry.name.split("/").includes("..") || entry.name.includes("\\")) {
				throw new Error(`Refusing archive entry "${entry.name}".`);
			}
			const target = path.join(staging, ...entry.name.split("/"));
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, entry.read());
		}
		await writeFile(path.join(staging, COMPLETE_MARKER), `${PINNED.sha256}\n`);
		await rm(finalDir, { recursive: true, force: true });
		await rename(staging, finalDir);
	} catch (cause) {
		await rm(staging, { recursive: true, force: true });
		throw cause;
	}
	return { dir: finalDir, version: PINNED.version, source: "cache" };
}

/**
 * Tracks and performs the one-time install, shared by every open instance.
 *
 * Opening a canvas must not wait on a 54 MB download — the host gives `open`
 * two minutes and a slow link needs more — so `open` returns at once and the
 * page shows progress from {@link DrawioProvider.status} until the editor is
 * there. Concurrent opens share the one download.
 */
export class DrawioProvider {
	constructor({ env = process.env, log = () => {} } = {}) {
		this.env = env;
		this.log = log;
		this.installed = null;
		this.pending = null;
		this.progress = { received: 0, total: PINNED.bytes };
		this.error = null;
	}

	status() {
		if (this.installed) return { state: "ready", version: this.installed.version, source: this.installed.source };
		if (this.pending) return { state: this.downloading ? "downloading" : "installing", version: PINNED.version, ...this.progress };
		if (this.error) return { state: "failed", version: PINNED.version, error: this.error };
		return { state: "missing", version: PINNED.version };
	}

	/**
	 * The install, unpacking it if needed. Resolves to `{ dir, version, source }`.
	 *
	 * With `network: false` (what opening a canvas uses) only local sources are
	 * tried and a missing archive is an error rather than a download.
	 */
	ensure({ network = true } = {}) {
		if (this.installed) return Promise.resolve(this.installed);
		if (this.pending) return this.pending;
		this.error = null;
		this.pending = (async () => {
			const found = await locateDrawio(this.env);
			if (found) return found;
			let archive;
			const local = this.env.DRAWIO_CANVAS_DRAWIO_WAR || (existsSync(BUNDLED_ARCHIVE) ? BUNDLED_ARCHIVE : null);
			if (local) {
				this.log(`installing draw.io ${PINNED.version} from ${local}`);
				archive = await readFile(local);
			} else if (!network || this.env.DRAWIO_CANVAS_OFFLINE === "1") {
				throw new Error(`The bundled draw.io archive ${BUNDLED_ARCHIVE} is missing and downloading is off.`);
			} else {
				this.log(`bundled archive missing; downloading draw.io ${PINNED.version} from ${PINNED.url}`);
				this.downloading = true;
				archive = await download(PINNED.url, {
					env: this.env,
					onProgress: (progress) => {
						this.progress = progress;
					},
				});
			}
			return installFromArchive(archive, { env: this.env });
		})()
			.then((install) => {
				this.installed = install;
				this.log(`draw.io ${install.version} ready (${install.source})`);
				return install;
			})
			.catch((cause) => {
				this.error = cause?.message ?? String(cause);
				this.log(`draw.io unavailable: ${this.error}`);
				throw cause;
			})
			.finally(() => {
				this.pending = null;
				this.downloading = false;
			});
		return this.pending;
	}
}
