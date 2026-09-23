/**
 * The document both operators are editing, and the rules that keep them from
 * overwriting each other.
 *
 * One `DiagramSession` per open canvas instance. It holds the authoritative
 * document; everything else — the agent's actions, the person's edits in
 * draw.io — is a request to change it, and every change comes back out as a
 * version the other side hears about.
 *
 * Four decisions are worth reading before changing anything here.
 *
 * **Edits are cell-addressed, both ways.** The agent sends operations on cells
 * by id; the person's draw.io sends the cells its own diff says they touched
 * (see `sync.mjs`). Moving a box and adding a node are not a conflict — they
 * touch different cells and both land. When the two really do write the same
 * cell, the later write stands; nothing finer is attempted, because co-editing
 * one label is not something people do with an agent.
 *
 * **The agent is gated per cell, not per document.** It may update or delete a
 * cell only if it has seen that cell's latest version. A person working on the
 * left of the page does not block the agent from finishing the right of it —
 * the whole point of editing at the same time. An edit that would overwrite
 * something the agent has not seen is refused with *what* changed and *who*
 * changed it, so the agent can re-read those cells and try again. The person is
 * never gated: they are looking at the diagram.
 *
 * **Every version says what changed.** Each commit diffs the document against
 * the previous version and journals the result (`changes.mjs`). The agent works
 * in turns and cannot watch the person draw; the journal is how it finds out,
 * and every agent-facing result carries the part of it the agent has not been
 * told yet.
 *
 * **History is versions, and a restore is a new one.** Undoing an undo is the
 * second thing anyone does with history.
 */

import { diffDocuments, formatCellChange, formatPageChanges } from "./changes.mjs";
import { applyOperations, cellId, DiagramError, DrawioDocument, summarizePage } from "./model.mjs";
import { applyEditorChanges } from "./sync.mjs";

/** How many past versions to keep. Enough to undo a bad turn, bounded so memory is too. */
export const HISTORY_LIMIT = 60;
/** How many journal entries to keep. The agent is told about changes in batches, not from the dawn of time. */
export const JOURNAL_LIMIT = 400;
/** Most change lines handed to the agent in one result; the rest is summarized as a count. */
export const REPORT_LINES = 25;

/**
 * An edit touching more cells than this is reported as one line rather than
 * one per cell: a pasted template or an opened file is one thing that happened,
 * and forty "added …" lines would crowd out the rest of the agent's context.
 */
export const BULK_CELLS = 12;

/** Who made a change. */
export const SOURCE_AGENT = "agent";
export const SOURCE_HUMAN = "human";

const key = (pageId, id) => `${pageId}\u0000${id}`;

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
		this.lastLabel = "opened";
		this.lastTouchedCells = [];
		this.history = [];
		this.journal = [];
		/** The document as it stands at {@link version}, as XML and parsed, for history and diffing. */
		this.snapshot = this.document.toXml();
		this.previous = DrawioDocument.parse(this.snapshot);
		/** page/cell → the version and source of its last change. */
		this.cellChanges = new Map();
		/** What the agent has read: per cell, and whole pages. Versions, 0 = never. */
		this.seenCells = new Map();
		this.seenPages = new Map();
		/** The last version whose changes the agent has been told about. */
		this.agentToldVersion = this.version;
		/** What the person is looking at, as their editor last reported it. */
		this.presence = null;
		this.listeners = new Set();
		for (const page of this.document.pages()) {
			if (page.compressed) continue;
			for (const entry of page.cells()) this.cellChanges.set(key(page.id, cellId(entry)), { version: this.version, source: SOURCE_AGENT });
		}
	}

	/** A snapshot for the page. */
	state() {
		return {
			version: this.version,
			updatedAt: this.updatedAt,
			source: this.lastSource,
			label: this.lastLabel,
			touched: this.lastTouchedCells,
			filePath: this.filePath ?? null,
			pages: this.document.pages().map(summarizePage),
			xml: this.snapshot,
		};
	}

	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event) {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A broken subscriber (a closed SSE socket mid-write) must not take the
				// edit down with it; the socket cleans itself up on its own error path.
			}
		}
	}

	/**
	 * Record a new version, journal what changed, and tell everyone watching.
	 *
	 * `seen` says whether the agent is assumed to know the result. It defaults to
	 * "the agent has seen what the agent wrote", which is what keeps an edit from
	 * needing a read after it. It is `false` when the agent *caused* a document it
	 * has not read — loading a file: it chose the path, not the cell ids inside.
	 */
	commit(source, _touched, label, { seen } = {}) {
		const diff = diffDocuments(this.previous, this.document);
		this.history.push({ version: this.version, source: this.lastSource, label: this.lastLabel ?? "", at: this.updatedAt, xml: this.snapshot });
		while (this.history.length > HISTORY_LIMIT) this.history.shift();
		this.version += 1;
		this.updatedAt = Date.now();
		this.lastSource = source;
		this.lastLabel = label ?? "";
		this.snapshot = this.document.toXml();
		this.previous = DrawioDocument.parse(this.snapshot);

		const agentKnows = seen ?? source === SOURCE_AGENT;
		for (const change of diff.cells) {
			const id = key(change.page_id, change.id);
			if (change.change === "removed") this.cellChanges.delete(id);
			else this.cellChanges.set(id, { version: this.version, source });
			if (agentKnows) this.seenCells.set(id, this.version);
		}
		if (agentKnows && diff.pages.added.length > 0) {
			for (const page of diff.pages.added) this.seenPages.set(page.id, this.version);
		}
		for (const page of diff.pages.removed) this.seenPages.delete(page.id);

		const entry = { version: this.version, source, label: this.lastLabel, at: this.updatedAt, pages: diff.pages, cells: diff.cells };
		this.journal.push(entry);
		while (this.journal.length > JOURNAL_LIMIT) this.journal.shift();
		if (agentKnows && this.agentToldVersion === this.version - 1) this.agentToldVersion = this.version;

		this.lastTouchedCells = diff.cells.filter((change) => change.change !== "removed").map((change) => change.id).slice(0, 500);
		this.emit({
			type: "change",
			version: this.version,
			source,
			label: this.lastLabel,
			touched: this.lastTouchedCells,
			summary: this.summaryOf(entry),
		});
		return this.version;
	}

	/**
	 * What one version did, as lines. Whole-document events (opening a file,
	 * restoring a version) and edits touching many cells come back as a single
	 * line that says so and how to catch up.
	 */
	linesOf(entry) {
		const pageLines = formatPageChanges(entry.pages);
		const wholeDocument = /^(opened|restored|replaced document)/.test(entry.label ?? "");
		if (wholeDocument || entry.cells.length > BULK_CELLS) {
			const pages = [...new Set(entry.cells.map((change) => change.page))];
			const what = wholeDocument ? entry.label : `edited ${entry.cells.length} cells`;
			const where = pages.length > 0 ? ` on ${pages.map((name) => `"${name}"`).join(", ")}` : "";
			return [`${what}${where}: ${entry.cells.length} cell change(s)${pageLines.length ? `, ${pageLines.join(", ")}` : ""} — call get_diagram to re-read`];
		}
		return [...pageLines, ...entry.cells.map((change) => `on "${change.page}": ${formatCellChange(change)}`)];
	}

	/** One line saying what a version did, for the status bar and history. */
	summaryOf(entry) {
		const lines = this.linesOf(entry).map((line) => line.replace(/^on "[^"]*": /, ""));
		if (lines.length === 0) return entry.label || "no visible change";
		return lines.length === 1 ? lines[0] : `${lines[0]} (+${lines.length - 1} more)`;
	}

	// ------------------------------------------------------------------ what the agent knows

	/** The agent has read a whole page: every cell on it is known at this version. */
	markPageSeen(page) {
		this.seenPages.set(page.id, this.version);
	}

	/** The agent has read these cells. */
	markCellsSeen(page, ids) {
		for (const id of ids) this.seenCells.set(key(page.id, id), this.version);
	}

	/** Every page, as when a blank canvas opens: there is nothing the agent could have missed. */
	markSeen() {
		for (const page of this.document.pages()) this.markPageSeen(page);
	}

	hasSeenPage(page) {
		return this.seenPages.has(page.id) || [...this.seenCells.keys()].some((id) => id.startsWith(`${page.id}\u0000`));
	}

	/** The version at which the agent last saw a cell, 0 if never. */
	seenVersion(pageId, id) {
		return Math.max(this.seenCells.get(key(pageId, id)) ?? 0, this.seenPages.get(pageId) ?? 0);
	}

	/**
	 * Which of the agent's operations would overwrite something it has not seen.
	 *
	 * Returns `{ ok: true }`, or the reason and — for a stale edit — each
	 * conflicting cell with what happened to it since the agent looked. `add` is
	 * never a conflict (a fresh id overwrites nothing), but adding to a page the
	 * agent has never read is refused: the new shapes would land on top of work
	 * it cannot see.
	 */
	editGate(page, operations) {
		if (!this.hasSeenPage(page) && page.drawable().length > 0) return { ok: false, reason: "no-context" };
		const conflicts = [];
		for (const operation of operations ?? []) {
			if (operation.operation !== "update" && operation.operation !== "delete") continue;
			const id = String(operation.cell_id ?? "");
			const changed = this.cellChanges.get(key(page.id, id));
			if (!changed) continue;
			if (changed.version > this.seenVersion(page.id, id)) conflicts.push({ cell_id: id, version: changed.version, source: changed.source, changes: this.changesTo(page.id, id) });
		}
		return conflicts.length === 0 ? { ok: true } : { ok: false, reason: "stale", conflicts };
	}

	/** What happened to one cell after the agent last saw it, as lines. */
	changesTo(pageId, id) {
		const since = this.seenVersion(pageId, id);
		return this.journal
			.filter((entry) => entry.version > since)
			.flatMap((entry) =>
				entry.cells.filter((change) => change.page_id === pageId && change.id === id).map((change) => `v${entry.version} ${entry.source}: ${formatCellChange(change)}`),
			);
	}

	/**
	 * Changes since `since`, as lines, oldest first.
	 *
	 * `sources` filters by who made them — by default everyone but the agent,
	 * which already knows what it did.
	 */
	changesSince(since, { sources = [SOURCE_HUMAN], limit = REPORT_LINES } = {}) {
		const lines = [];
		let total = 0;
		for (const entry of this.journal) {
			if (entry.version <= since || !sources.includes(entry.source)) continue;
			const entryLines = this.linesOf(entry);
			if (entryLines.length === 0 && entry.label) entryLines.push(entry.label);
			for (const line of entryLines) {
				total += 1;
				if (lines.length < limit) lines.push(`v${entry.version} ${entry.source} ${line}`);
			}
		}
		return { lines, total, truncated: total > lines.length };
	}

	/**
	 * What the person did that the agent has not been told yet — and now has.
	 *
	 * Attached to agent-facing results so the agent learns about parallel work
	 * as a side effect of doing its own, without a separate poll.
	 */
	tellAgent() {
		const report = this.changesSince(this.agentToldVersion);
		this.agentToldVersion = this.version;
		if (report.total === 0) return undefined;
		return report.truncated ? [...report.lines, `… and ${report.total - report.lines.length} more; call get_changes for all of them.`] : report.lines;
	}

	// ------------------------------------------------------------------ mutations

	/** Replace the whole document. Destructive, and every page goes with it. */
	replace(xml, { source = SOURCE_AGENT, label = "replaced document", seen } = {}) {
		const next = DrawioDocument.parse(xml);
		// An <mxfile> with no <diagram> parses, and replacing with it leaves a
		// document every page selector fails on, with nothing to undo it from.
		if (next.pages().length === 0) {
			throw new DiagramError("no_pages", "That XML has no pages (no <diagram>), so it would leave an empty document. Nothing was replaced. Send an <mxfile> with at least one <diagram>, or <mxCell> elements to replace one page.");
		}
		this.document = next;
		const version = this.commit(source, [], label, { seen });
		if (seen ?? source === SOURCE_AGENT) this.markSeen();
		return version;
	}

	/** Apply the agent's cell operations to one page. */
	apply(selector, operations, { source = SOURCE_AGENT, label } = {}) {
		const result = applyOperations(this.document, selector, operations);
		const version = result.applied.length > 0 ? this.commit(source, [], label ?? `${result.applied.length} cell edit(s)`) : this.version;
		return { ...result, version };
	}

	/** Apply the person's edits, as their draw.io reported them (see `sync.mjs`). */
	applyEditor(changes, { source = SOURCE_HUMAN, label, seen } = {}) {
		const result = applyEditorChanges(this.document, changes);
		const version = result.applied > 0 ? this.commit(source, [], label ?? "edited in draw.io", { seen }) : this.version;
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
		const selector = Object.fromEntries(["page_id", "page_name", "page_index"].filter((key) => command[key] !== undefined && command[key] !== null).map((key) => [key, command[key]]));
		const known = this.document
			.pages()
			.map((item) => `${item.index}:${item.name}`)
			.join(", ");
		// With no selector a lookup falls back to the first page, which is right for
		// reading and wrong for renaming or deleting: say which page, always.
		if (Object.keys(selector).length === 0) {
			throw new DiagramError("invalid_input", `${op} needs page_id, page_name or page_index to say which page. Pages: ${known}.`);
		}
		const page = this.document.page(selector);
		if (!page) throw new DiagramError("page_not_found", `No page matches ${JSON.stringify(selector)}. Pages: ${known}.`);
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
	 * restored from is still there afterwards.
	 */
	restore(version, { source = SOURCE_HUMAN } = {}) {
		const entry = this.history.find((item) => item.version === version);
		if (!entry) throw new DiagramError("unknown_version", `No version ${version} in history.`);
		this.document = DrawioDocument.parse(entry.xml);
		return this.commit(source, [], `restored version ${version}`);
	}

	/** Record what the person is looking at. Not a version: nothing in the document changed. */
	setPresence(presence) {
		this.presence = { ...presence, at: Date.now() };
		this.emit({ type: "presence", presence: this.presence });
	}

	/** History newest first, without the XML payloads. */
	historySummary() {
		const summaries = new Map(this.journal.map((entry) => [entry.version, this.summaryOf(entry)]));
		return [...this.history, { version: this.version, source: this.lastSource, label: this.lastLabel, at: this.updatedAt }]
			.reverse()
			.map((entry) => ({ version: entry.version, source: entry.source, label: summaries.get(entry.version) ?? entry.label, at: entry.at, current: entry.version === this.version }));
	}

	/** The document as it was at `version`, or null. */
	versionXml(version) {
		if (version === this.version) return this.snapshot;
		return this.history.find((entry) => entry.version === version)?.xml ?? null;
	}
}
