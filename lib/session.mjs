/**
 * The document both operators are editing, and the rules that keep them from
 * overwriting each other.
 *
 * One `DiagramSession` per open canvas instance. It holds the authoritative
 * document; everything else — the agent's actions, the page's edits — is a
 * request to change it, and every change comes back out as a version bump the
 * other side hears about.
 *
 * Three decisions are worth reading before changing anything here.
 *
 * **Edits are cell-addressed, not document-addressed.** Both sides send
 * operations on cells rather than a whole replacement document, so the person
 * moving a box and the agent adding a node are not a conflict at all — they
 * touch different cells and both land. A document-at-a-time protocol would make
 * every concurrent edit a conflict and force one of them to be discarded, and
 * the one discarded would usually be the person's, because the agent writes
 * faster.
 *
 * **Last write wins per cell.** When the two really do edit the same cell, the
 * later write stands. Anything better needs operational transforms, and the
 * canvas-design guidance is explicit that co-editing one field is the problem
 * the reference canvas declined to solve. Append, move and style are the
 * operations people actually perform together; a shared text buffer is not on
 * offer.
 *
 * **The agent has to look before it writes.** {@link DiagramSession.editGate}
 * refuses an agent edit that would build on a document the person has since
 * changed. Not a lock and not a timeout: a fingerprint comparison, so a slow
 * turn is fine and only a *stale* one is refused. The person is never blocked —
 * they are looking at the document, so they cannot be working from a stale copy
 * of it.
 */

import { applyOperations, DiagramError, DrawioDocument, summarizePage } from "./model.mjs";

/** How many past versions to keep. Enough to undo a bad turn, bounded so memory is too. */
export const HISTORY_LIMIT = 40;

/** Who made a change. Shown in the history strip and used to decide what to highlight. */
export const SOURCE_AGENT = "agent";
export const SOURCE_HUMAN = "human";

export class DiagramSession {
	/**
	 * @param {object} options
	 * @param {string} [options.xml] Initial document; a blank page when omitted.
	 * @param {string} [options.workspace] Session working directory, for file actions.
	 * @param {string} [options.filePath] Workspace-relative path this document came from.
	 */
	constructor(options = {}) {
		this.document = options.xml ? DrawioDocument.parse(options.xml) : DrawioDocument.blank();
		this.workspace = options.workspace;
		this.filePath = options.filePath;
		this.version = 1;
		this.updatedAt = Date.now();
		this.lastSource = SOURCE_AGENT;
		this.lastTouchedCells = [];
		this.history = [];
		/**
		 * The fingerprint the agent last saw.
		 *
		 * Null until it looks. An agent that has never called `get_diagram` and never
		 * written anything has no idea what is on the canvas, and letting it edit
		 * cells by id would be guesswork against a document a person may have spent
		 * ten minutes on.
		 */
		this.agentSawFingerprint = null;
		/**
		 * The document as it stands at {@link version}.
		 *
		 * Kept alongside the live tree because `commit` runs *after* the mutation:
		 * without a snapshot taken before it, the history entry for version N would
		 * hold the content of version N+1 and every restore would be off by one.
		 */
		this.snapshot = this.document.toXml();
		this.listeners = new Set();
	}

	/** A snapshot for the page and for action results. */
	state() {
		return {
			version: this.version,
			updatedAt: this.updatedAt,
			source: this.lastSource,
			touched: this.lastTouchedCells,
			filePath: this.filePath ?? null,
			pages: this.document.pages().map(summarizePage),
			xml: this.document.toXml(),
		};
	}

	/** Subscribe to changes. Returns the unsubscribe function. */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Record a new version and tell everyone watching.
	 *
	 * `seen` overrides who is assumed to have read the result. It defaults to
	 * "the agent has seen what the agent wrote", which is what keeps an edit from
	 * needing a read after it. It is passed explicitly as `false` when the agent
	 * *caused* a document it has not read — loading a file is the case: the agent
	 * chose the path but has no idea what cell ids are inside it.
	 */
	commit(source, touched, label, { seen } = {}) {
		this.history.push({ version: this.version, source: this.lastSource, label: this.lastLabel ?? "", at: this.updatedAt, xml: this.snapshot });
		while (this.history.length > HISTORY_LIMIT) this.history.shift();
		this.version += 1;
		this.updatedAt = Date.now();
		this.lastSource = source;
		this.lastTouchedCells = touched ?? [];
		this.lastLabel = label ?? "";
		this.snapshot = this.document.toXml();
		// The agent's own writes count as having seen the result: requiring a
		// get_diagram after every edit would double every turn's round trips for
		// nothing, since nobody else changed anything in between.
		if (seen ?? source === SOURCE_AGENT) this.agentSawFingerprint = this.document.fingerprint();
		const event = { version: this.version, source, touched: this.lastTouchedCells, label: this.lastLabel };
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A broken subscriber (a closed SSE socket mid-write) must not take the
				// edit down with it; the socket cleans itself up on its own error path.
			}
		}
		return this.version;
	}

	/** Mark the current document as seen by the agent. */
	markSeen() {
		this.agentSawFingerprint = this.document.fingerprint();
	}

	/**
	 * Whether an agent edit may proceed.
	 *
	 * `no-context`: it has never looked. `stale`: someone changed the document
	 * since it did. Both are answered with an instruction rather than a refusal
	 * the agent has to guess its way out of.
	 */
	editGate() {
		if (this.agentSawFingerprint === null) return { ok: false, reason: "no-context" };
		if (this.agentSawFingerprint !== this.document.fingerprint()) return { ok: false, reason: "stale" };
		return { ok: true };
	}

	/** Replace the whole document. Destructive, and every page goes with it. */
	replace(xml, { source = SOURCE_AGENT, label = "replaced document", seen } = {}) {
		const next = DrawioDocument.parse(xml);
		this.document = next;
		return this.commit(source, [], label, { seen });
	}

	/** Apply cell operations to one page. */
	apply(selector, operations, { source = SOURCE_AGENT, label } = {}) {
		const result = applyOperations(this.document, selector, operations);
		const touched = result.applied.map((entry) => entry.cell_id);
		const version = this.commit(source, touched, label ?? `${result.applied.length} cell edit(s)`);
		return { ...result, version };
	}

	/** Add, rename or delete a page. */
	pages(command) {
		const { op } = command;
		if (op === "list") return { pages: this.document.pages().map(summarizePage) };
		if (op === "add") {
			const page = this.document.addPage(command.name, command.xml);
			this.commit(command.source ?? SOURCE_AGENT, [], `added page "${page.name}"`);
			return { page: summarizePage(page) };
		}
		const page = this.document.page(command);
		if (!page) throw new DiagramError("page_not_found", `No page matches ${JSON.stringify(command)}.`);
		if (op === "rename") {
			if (!command.name) throw new DiagramError("missing_name", "rename needs a name.");
			const before = page.name;
			page.name = command.name;
			this.commit(command.source ?? SOURCE_AGENT, [], `renamed "${before}" to "${page.name}"`);
			return { page: summarizePage(page) };
		}
		if (op === "delete") {
			const name = page.name;
			this.document.deletePage(page);
			this.commit(command.source ?? SOURCE_AGENT, [], `deleted page "${name}"`);
			return { deleted: name, pages: this.document.pages().map(summarizePage) };
		}
		throw new DiagramError("unknown_page_op", `Unknown page operation "${op}".`);
	}

	/**
	 * Put a past version back.
	 *
	 * A restore is itself a new version rather than a rewind, so the thing being
	 * restored from is still there afterwards. Undoing an undo is the second
	 * thing anyone does with history.
	 */
	restore(version, { source = SOURCE_HUMAN } = {}) {
		const entry = this.history.find((item) => item.version === version);
		if (!entry) throw new DiagramError("unknown_version", `No version ${version} in history.`);
		this.document = DrawioDocument.parse(entry.xml);
		return this.commit(source, [], `restored version ${version}`);
	}

	/** History newest first, without the XML payloads. */
	historySummary() {
		return [...this.history]
			.reverse()
			.map((entry) => ({ version: entry.version, source: entry.source, label: entry.label, at: entry.at }));
	}

	/** The document as it was at `version`, or null. */
	versionXml(version) {
		return this.history.find((entry) => entry.version === version)?.xml ?? null;
	}
}
