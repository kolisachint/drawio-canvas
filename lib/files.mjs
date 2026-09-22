/**
 * Reading and writing `.drawio` files, and the rule about where.
 *
 * Two things live here because they are the same question asked twice: what is
 * on disk, and whether this canvas is allowed to touch it.
 *
 * **Compression.** draw.io writes a page's body one of two ways. Plain XML is
 * one. The other is the historical default and still what the desktop app
 * produces: the `<mxGraphModel>` is URI-encoded, raw-deflated and base64'd into
 * the `<diagram>` element's text. A file in that form looks like line noise, so
 * it is inflated on the way in, and written back plain on the way out — draw.io
 * reads both, and a plain file is one a person can diff and an agent can read.
 *
 * **The workspace.** Every path is resolved inside the session's working
 * directory and refused outside it. The canvas runs as a forked Node process
 * with the person's own privileges and no permission gate in front of it (the
 * host's gate sits in front of the host's tools, not inside an extension), so
 * this containment is the only thing standing between an agent-chosen path and
 * `~/.ssh/config`. It is checked on the resolved, symlink-free path, because
 * `../` and a symlink are the two ways that check is usually got wrong.
 */

import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { childElements, parseXml, serializeXml, textContent } from "./xml.mjs";
import { DiagramError, DrawioDocument, isCompressedPage } from "./model.mjs";

/** Extensions this canvas will write. Anything else is refused by name. */
export const WRITABLE_EXTENSIONS = new Set([".drawio", ".xml", ".svg"]);

/**
 * Resolve `candidate` inside `workspace`, or throw.
 *
 * `realpath` is applied to whichever ancestor of the target already exists, so
 * a symlink halfway up the path cannot land the write outside the workspace
 * while the string still reads as if it were inside.
 */
export function resolveInWorkspace(workspace, candidate) {
	if (!workspace) {
		throw new DiagramError(
			"no_workspace",
			"This canvas was opened without a working directory, so it cannot resolve a file path. Upgrade hoocode, or pass an absolute path.",
		);
	}
	const root = realpathSync(workspace);
	const absolute = path.resolve(root, String(candidate ?? ""));
	let existing = absolute;
	while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
	const realExisting = realpathSync(existing);
	const resolved = path.join(realExisting, path.relative(existing, absolute));
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		throw new DiagramError("outside_workspace", `"${candidate}" resolves outside the workspace (${root}).`);
	}
	return resolved;
}

/**
 * Inflate every compressed page in a document, in place.
 *
 * Returns how many were inflated, so a caller can say so rather than leaving a
 * person wondering why a file that opened fine in draw.io looks different here.
 */
export function inflateDocument(document) {
	let inflated = 0;
	for (const diagram of childElements(document.root, "diagram")) {
		if (!isCompressedPage(diagram)) continue;
		const body = textContent(diagram).trim();
		if (body.length === 0) continue;
		const xml = inflatePageBody(body);
		if (!xml) continue;
		const parsed = parseXml(xml);
		diagram.children = [parsed.root];
		inflated += 1;
	}
	return inflated;
}

/** base64 → raw deflate → URI-decode, draw.io's page encoding, or null if it is not that. */
export function inflatePageBody(body) {
	try {
		const raw = inflateRawSync(Buffer.from(body, "base64")).toString("utf8");
		const xml = decodeURIComponent(raw);
		return xml.includes("<mxGraphModel") ? xml : null;
	} catch {
		return null;
	}
}

/** Read a `.drawio`/`.xml` file and return `{ xml, inflatedPages }`, uncompressed. */
export async function readDiagramFile(absolutePath) {
	const content = await readFile(absolutePath, "utf8");
	const trimmed = content.trim();
	if (trimmed.length === 0) throw new DiagramError("empty_file", `${absolutePath} is empty.`);
	// A `.drawio` whose root is <mxfile> is the normal case; a bare model or a
	// cell fragment is accepted for the same reason the actions accept them.
	const document = DrawioDocument.parse(trimmed);
	const inflatedPages = inflateDocument(document.document);
	return { xml: document.toXml(), inflatedPages };
}

/** Write text to a path inside the workspace, creating the directory if needed. */
export async function writeWorkspaceFile(absolutePath, contents) {
	const extension = path.extname(absolutePath).toLowerCase();
	if (!WRITABLE_EXTENSIONS.has(extension)) {
		throw new DiagramError(
			"unsupported_extension",
			`This canvas writes ${[...WRITABLE_EXTENSIONS].join(", ")} files; "${extension || "no extension"}" is not one of them.`,
		);
	}
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, contents, "utf8");
	return absolutePath;
}

/** Serialize a document the way a `.drawio` file wants it: declaration first. */
export function toFileXml(document) {
	const hasDeclaration = document.document.prolog.some((node) => node.type === "pi" && node.value.startsWith("xml"));
	const body = serializeXml(document.document);
	return hasDeclaration ? `${body}\n` : `<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`;
}

/**
 * Where an instance's document is parked while its process is replaced.
 *
 * `reload_canvas` forks a new child from the edited source and re-opens the
 * instances the old one held — which means the document lives and dies with a
 * process the agent restarts on purpose, every time it changes a line of this
 * canvas's code. Without a snapshot, iterating on the canvas would silently
 * throw away the diagram the person is looking at, and they would watch it
 * happen.
 *
 * The host replays the *input* an instance was opened with, so this is the only
 * channel available: the outgoing process writes, the incoming one reads by the
 * same instance id. Instance ids are UUIDs and never reused, so a snapshot is
 * read exactly once.
 */
const SNAPSHOT_DIR = path.join(tmpdir(), "drawio-canvas-instances");

/**
 * How recently a document must have been parked to be taken back.
 *
 * A reload re-opens the instance within a second or two, so anything older than
 * this is not a reload: it is a canvas that was closed and never came back, and
 * its document must not reappear underneath an unrelated instance that happens
 * to carry the same id. Instance ids are host-generated UUIDs in practice, but
 * a canvas should not depend on that to avoid resurrecting someone's diagram in
 * the wrong place.
 */
export const SNAPSHOT_MAX_AGE_MS = 60_000;

function snapshotPath(instanceId) {
	// Instance ids come from the host and are UUIDs, but this builds a filesystem
	// path out of one, so anything not id-shaped is refused outright.
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(String(instanceId ?? ""))) return null;
	return path.join(SNAPSHOT_DIR, `${instanceId}.json`);
}

/**
 * Park a document, and the file it is bound to, for the instance's next
 * process. Best effort: a canvas must close cleanly even when the disk says no.
 */
export async function writeSnapshot(instanceId, { xml, filePath }) {
	const target = snapshotPath(instanceId);
	if (!target) return false;
	try {
		await mkdir(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
		await writeFile(target, JSON.stringify({ xml, filePath: filePath ?? null }), { encoding: "utf8", mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}

/** Take a parked document back, removing it. Returns null when there is none. */
export async function takeSnapshot(instanceId) {
	const target = snapshotPath(instanceId);
	if (!target) return null;
	try {
		const age = Date.now() - (await stat(target)).mtimeMs;
		const parsed = JSON.parse(await readFile(target, "utf8"));
		await rm(target, { force: true });
		if (age > SNAPSHOT_MAX_AGE_MS) return null;
		return typeof parsed?.xml === "string" ? parsed : null;
	} catch {
		return null;
	}
}

/** Remove snapshots nobody came back for. Best effort, and never throws. */
export async function sweepSnapshots(now = Date.now()) {
	try {
		for (const name of await readdir(SNAPSHOT_DIR)) {
			const file = path.join(SNAPSHOT_DIR, name);
			const info = await stat(file);
			if (now - info.mtimeMs > SNAPSHOT_MAX_AGE_MS) await rm(file, { force: true });
		}
	} catch {
		// No directory yet, or no permission to read it: nothing to sweep.
	}
}
