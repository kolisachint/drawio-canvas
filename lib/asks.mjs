/**
 * The person's requests to the agent, and when the canvas speaks up.
 *
 * An *ask* is one thing the person wants from the agent: some text, usually
 * anchored to the cells they had selected. Asks are the canvas's task list —
 * the person adds, reorders (that is the priority) and dismisses them; the
 * agent reads them with `get_asks` and marks them with `update_ask`.
 *
 * The rule that keeps the agent's context clean: **only the person's gesture
 * sends anything.** Editing never wakes the agent. The one exception is the idle
 * digest (see {@link digestDue}), and it is bounded to once per idle stretch and
 * can be turned off.
 *
 * Pure data and pure decisions; the canvas does the sending.
 */

/** open: waiting; working: the agent picked it up; done / declined: the agent finished; dismissed: the person withdrew it. */
export const ASK_STATUSES = ["open", "working", "done", "declined", "dismissed"];
/** Statuses the agent may set. */
export const AGENT_ASK_STATUSES = ["working", "done", "declined"];

const ACTIVE = new Set(["open", "working"]);
const MAX_TEXT = 500;
const MAX_REPLY = 300;
const MAX_CELLS = 50;
/** Finished asks kept for the drawer; older ones are dropped. */
const KEEP_FINISHED = 30;

/** Idle digest thresholds, in one place. */
export const DIGEST = {
	/** The agent has been idle at least this long. */
	agentIdleMs: 60_000,
	/** The person has not edited for at least this long. */
	personQuietMs: 20_000,
	/** At least this many unseen changes, unless one of them adds or removes a cell. */
	minChanges: 3,
	/** How often the canvas checks. */
	checkEveryMs: 5_000,
};

export class AskBoard {
	constructor({ now = Date.now } = {}) {
		this.now = now;
		/** In priority order among active asks; finished ones trail. */
		this.asks = [];
		this.nextId = 1;
	}

	/** A new ask from the person. */
	add({ text, page_id = null, page = null, cell_ids = [], urgent = false } = {}) {
		const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
		if (!clean) throw Object.assign(new Error("An ask needs some text."), { code: "invalid_input" });
		const at = this.now();
		const ask = {
			id: this.nextId++,
			text: clean,
			page_id,
			page,
			cell_ids: [...new Set((cell_ids ?? []).map(String))].slice(0, MAX_CELLS),
			status: "open",
			urgent: Boolean(urgent),
			/** Whether the agent has been told about it (a result or get_asks). */
			seen: false,
			reply: null,
			created_at: at,
			updated_at: at,
		};
		// Urgent goes to the top; otherwise after the other active asks.
		const firstFinished = this.asks.findIndex((item) => !ACTIVE.has(item.status));
		const at_index = urgent ? 0 : firstFinished === -1 ? this.asks.length : firstFinished;
		this.asks.splice(at_index, 0, ask);
		return ask;
	}

	/** Put back the asks a reload parked (see `writeSnapshot`). */
	restore(asks) {
		this.asks = asks.filter((ask) => Number.isInteger(ask?.id) && typeof ask.text === "string" && ASK_STATUSES.includes(ask.status)).map((ask) => ({ ...ask, cell_ids: Array.isArray(ask.cell_ids) ? ask.cell_ids.map(String) : [] }));
		this.nextId = Math.max(0, ...this.asks.map((ask) => ask.id)) + 1;
	}

	get(id) {
		return this.asks.find((ask) => ask.id === Number(id));
	}

	/** Change status, text or reply. Returns the ask, or throws `unknown_ask`. */
	update(id, { status, reply, text } = {}) {
		const ask = this.get(id);
		if (!ask) {
			const known = this.active().map((item) => `#${item.id}`).join(", ") || "none open";
			throw Object.assign(new Error(`No ask #${id}. Open asks: ${known}.`), { code: "unknown_ask" });
		}
		if (status !== undefined) {
			if (!ASK_STATUSES.includes(status)) throw Object.assign(new Error(`status must be one of ${ASK_STATUSES.join(", ")}.`), { code: "invalid_input" });
			const wasActive = ACTIVE.has(ask.status);
			ask.status = status;
			// A finished ask leaves the priority order: move it behind the active ones.
			if (wasActive && !ACTIVE.has(status)) {
				this.asks.splice(this.asks.indexOf(ask), 1);
				this.asks.push(ask);
			}
		}
		if (reply !== undefined && reply !== null) ask.reply = String(reply).replace(/\s+/g, " ").trim().slice(0, MAX_REPLY) || null;
		if (text !== undefined && text !== null) {
			const clean = String(text).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
			if (clean) {
				ask.text = clean;
				ask.seen = false;
			}
		}
		ask.updated_at = this.now();
		this.prune();
		return ask;
	}

	/** Put the active asks in this order; ids not named keep their relative order after them. */
	reorder(ids) {
		const wanted = (ids ?? []).map(Number);
		const active = this.active();
		const named = wanted.map((id) => active.find((ask) => ask.id === id)).filter(Boolean);
		const rest = active.filter((ask) => !named.includes(ask));
		this.asks = [...named, ...rest, ...this.asks.filter((ask) => !ACTIVE.has(ask.status))];
	}

	/** Move one active ask to the top. */
	top(id) {
		const ask = this.get(id);
		if (!ask || !ACTIVE.has(ask.status)) return;
		this.reorder([ask.id, ...this.active().filter((item) => item !== ask).map((item) => item.id)]);
	}

	/** Open and working asks, top priority first. */
	active() {
		return this.asks.filter((ask) => ACTIVE.has(ask.status));
	}

	/** Active asks the agent has not been told about. */
	unseen() {
		return this.active().filter((ask) => !ask.seen);
	}

	markSeen(asks) {
		for (const ask of asks) ask.seen = true;
	}

	/**
	 * The agent edited these cells: an open ask anchored to any of them is now
	 * being worked on. Returns the asks that moved.
	 */
	touched(pageId, ids) {
		const set = new Set(ids.map(String));
		const moved = [];
		for (const ask of this.active()) {
			if (ask.status !== "open" || (ask.page_id && ask.page_id !== pageId)) continue;
			if (ask.cell_ids.some((id) => set.has(id))) {
				ask.status = "working";
				ask.updated_at = this.now();
				moved.push(ask);
			}
		}
		return moved;
	}

	prune() {
		const finished = this.asks.filter((ask) => !ACTIVE.has(ask.status));
		if (finished.length <= KEEP_FINISHED) return;
		const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED));
		this.asks = this.asks.filter((ask) => !drop.has(ask));
	}

	/** Everything, for the page. */
	list() {
		return this.asks.map((ask) => ({ ...ask }));
	}
}

/** One line describing an ask, for the agent. */
export function askLine(ask) {
	const where = ask.cell_ids.length > 0 ? ` — cells ${ask.cell_ids.slice(0, 8).join(", ")}${ask.cell_ids.length > 8 ? ` (+${ask.cell_ids.length - 8})` : ""}${ask.page ? ` on "${ask.page}"` : ""}` : ask.page ? ` — page "${ask.page}"` : "";
	return `#${ask.id}${ask.status === "working" ? " (working)" : ""}${ask.urgent ? " (urgent)" : ""} "${ask.text}"${where}`;
}

/**
 * The message that tells the agent about the person's requests.
 *
 * It describes the whole current list, not the latest addition: the host keeps
 * only a canvas's newest message while the agent is busy, so each one must
 * stand on its own.
 */
export function asksMessage(instanceId, asks) {
	const lines = asks.slice(0, 8).map(askLine);
	const more = asks.length > 8 ? `\n… and ${asks.length - 8} more.` : "";
	return [
		`The person asked for help on the draw.io canvas (instanceId ${instanceId}). Open requests, top first:`,
		...lines,
	].join("\n") + `${more}\nCall get_asks on that instance: it returns each request with its cells' XML (counts as read, so you can edit them directly). Do the top one first and keep to the cells named. Mark each with update_ask: working when you start, done or declined with a one-line reply when you finish.`;
}

/** The idle digest: what the person did while the agent sat idle. */
export function digestMessage(instanceId, lines) {
	const shown = lines.slice(0, 10);
	const more = lines.length > shown.length ? `\n… and ${lines.length - shown.length} more.` : "";
	return `The person paused after editing the draw.io canvas (instanceId ${instanceId}) while you were idle. What they changed:\n${shown.join("\n")}${more}\nOnly act if something is clearly broken or unfinished (overlapping shapes, dangling edges, half-written labels); otherwise reply in one line and do nothing. Call get_changes on that instance for details.`;
}

/**
 * Whether the idle digest should go now. Every condition must hold:
 * enabled, the host can take messages, the person's editor is open, the agent
 * idle and the person quiet long enough, enough unseen changes (or any cell
 * added or removed), and no digest already sent in this idle stretch.
 */
export function digestDue({ enabled, canSend, editorOpen, known, agentIdleMs, personQuietMs, unseenChanges, structural, armed }) {
	if (!enabled || !canSend || !editorOpen || !known || !armed) return false;
	if (agentIdleMs < DIGEST.agentIdleMs || personQuietMs < DIGEST.personQuietMs) return false;
	return unseenChanges >= DIGEST.minChanges || (structural && unseenChanges > 0);
}
