/**
 * One canvas instance's side of working *with* the agent: the person's asks,
 * when they reach the agent, the idle digest, and what the bar shows about the
 * agent.
 *
 * Delivery rules (see also `asks.mjs`):
 *
 *  - An ask made while the agent is **idle** is sent at once, and starts a turn.
 *  - An ask made while the agent is **busy** is not sent yet. Every result the
 *    agent gets from this canvas carries the asks it has not seen, so a working
 *    agent can pick one up between steps. What is still open when the agent goes
 *    idle is sent then, as one message — so an ask handled mid-turn never starts
 *    a second turn about itself.
 *  - **Do it now** sends at once with `immediate`, which steers a busy agent.
 *  - With a host that cannot take messages (no `session.send`), asks wait for
 *    the agent's next canvas call, and the bar says so.
 */

import { askLine, AGENT_ASK_STATUSES, AskBoard, asksMessage, DIGEST, digestDue, digestMessage } from "./asks.mjs";
import { cellId } from "./model.mjs";
import { SOURCE_HUMAN } from "./session.mjs";
import { serializeXml } from "./xml.mjs";

/** How much cell XML one get_asks returns in all. */
const ASK_XML_BUDGET = 4_000;

export class Collaboration {
	/**
	 * @param {object} options
	 * @param {string} options.instanceId
	 * @param {import("./session.mjs").DiagramSession} options.session
	 * @param {import("./agent.mjs").AgentLink} options.agent
	 * @param {() => boolean} options.editorOpen Whether the person has the editor open.
	 * @param {{ read: () => Promise<{digest: boolean}>, write: (values: object) => Promise<{digest: boolean}> }} options.prefs
	 * @param {(message: string) => void} [options.log]
	 * @param {() => number} [options.now]
	 * @param {boolean} [options.timers] Run the digest check on a timer. Default true.
	 */
	constructor({ instanceId, session, agent, editorOpen, prefs, log = () => {}, now = Date.now, timers = true }) {
		this.instanceId = instanceId;
		this.session = session;
		this.agent = agent;
		this.editorOpen = editorOpen;
		this.prefs = prefs;
		this.log = log;
		this.now = now;
		this.board = new AskBoard({ now });
		/** Asks made while the agent was busy, to send when it goes idle. */
		this.pendingSend = false;
		this.digestEnabled = true;
		/** One digest per idle stretch: disarmed when sent, re-armed by the agent's next turn. */
		this.digestArmed = true;
		this.digestSentAt = null;
		this.lastHumanEditAt = 0;
		this.publishTimer = null;
		this.closed = false;

		void prefs
			.read()
			.then((values) => {
				this.digestEnabled = values.digest !== false;
				this.publish();
			})
			.catch(() => {});

		this.unsubscribeSession = session.subscribe((event) => {
			if (event.type !== "change") return;
			if (event.source === SOURCE_HUMAN) this.lastHumanEditAt = this.now();
			this.publish();
		});
		this.unsubscribeAgent = agent.subscribe((_state, type) => this.onAgent(type));
		this.timer = timers ? setInterval(() => void this.checkDigest(), DIGEST.checkEveryMs) : null;
		this.timer?.unref?.();
	}

	close() {
		this.closed = true;
		clearInterval(this.timer);
		clearTimeout(this.publishTimer);
		this.unsubscribeSession();
		this.unsubscribeAgent();
	}

	// ------------------------------------------------------------ the page

	/** Tell the page, coalesced: one SSE event per burst. */
	publish() {
		if (this.closed || this.publishTimer) return;
		this.publishTimer = setTimeout(() => {
			this.publishTimer = null;
			if (!this.closed) this.session.emit({ type: "collab", ...this.state() });
		}, 50);
	}

	/** Everything the bar and the drawer show. */
	state() {
		const agent = this.agent.state();
		const working = this.board.active().find((ask) => ask.status === "working");
		const doing = agent.tool || agent.intent;
		const hint = agent.busy ? [working ? `#${working.id}` : "", doing].filter(Boolean).join(" · ") || "working" : "";
		const unseen = this.session.changesSince(this.session.agentToldVersion, { limit: 0 }).total;
		return {
			agent: { ...agent, hint },
			asks: this.board.list(),
			unseen,
			digest: { enabled: this.digestEnabled, available: agent.can_send && this.agent.canListen, sent_at: this.digestSentAt },
			delivery: agent.can_send ? "send" : "next_call",
		};
	}

	/** A command from the page. */
	async command(input = {}) {
		const op = input.op;
		let result = {};
		if (op === "ask") {
			const ask = this.board.add({ text: input.text, page_id: input.page_id ?? null, page: this.pageName(input.page_id), cell_ids: input.cell_ids ?? [], urgent: Boolean(input.now) });
			await this.deliver(input.now ? "immediate" : "enqueue");
			result = { ask };
		} else if (op === "review") {
			const { ids, pageId } = this.unseenCells();
			const ask = this.board.add({ text: input.text || "Review what I just changed and fix anything that looks broken or unfinished.", page_id: pageId, page: this.pageName(pageId), cell_ids: ids });
			await this.deliver("enqueue");
			result = { ask };
		} else if (op === "now") {
			const ask = this.board.update(input.id, {});
			ask.urgent = true;
			this.board.top(ask.id);
			await this.deliver("immediate");
			result = { ask };
		} else if (op === "update") {
			// The person may edit an ask's text or dismiss it; the agent's statuses are the agent's.
			const status = input.status === "dismissed" || input.status === "open" ? input.status : undefined;
			result = { ask: this.board.update(input.id, { status, text: input.text }) };
		} else if (op === "reorder") {
			this.board.reorder(input.ids);
		} else if (op === "digest") {
			this.digestEnabled = Boolean(input.enabled);
			await this.prefs.write({ digest: this.digestEnabled }).catch(() => {});
		} else {
			throw Object.assign(new Error(`Unknown collaboration op "${op}".`), { code: "invalid_input" });
		}
		this.publish();
		return { ...result, state: this.state() };
	}

	pageName(pageId) {
		return pageId ? (this.session.document.page({ page_id: pageId })?.name ?? null) : null;
	}

	/** Cells the person changed that the agent has not been told about, on one page. */
	unseenCells() {
		const ids = [];
		let pageId = null;
		for (const entry of this.session.journal) {
			if (entry.version <= this.session.agentToldVersion || entry.source !== SOURCE_HUMAN) continue;
			for (const change of entry.cells) {
				if (change.change === "removed") continue;
				pageId ??= change.page_id;
				if (change.page_id === pageId && !ids.includes(change.id)) ids.push(change.id);
			}
		}
		return { ids: ids.slice(0, 50), pageId };
	}

	// ------------------------------------------------------------ delivery

	/**
	 * Send the open asks now, or hold them for the agent's idle — see the module
	 * header. `immediate` always sends.
	 */
	async deliver(mode) {
		const open = this.board.active().filter((ask) => ask.status === "open");
		if (open.length === 0) return;
		if (!this.agent.canSend) return;
		if (mode !== "immediate" && this.agent.busy) {
			this.pendingSend = true;
			return;
		}
		this.pendingSend = false;
		try {
			await this.agent.send(asksMessage(this.instanceId, this.board.active()), mode);
			for (const ask of open) ask.sent = true;
		} catch (cause) {
			this.log(`could not send the person's request to the agent: ${cause?.message ?? cause}`);
		}
	}

	onAgent(type) {
		if (type === "assistant.turn_start") this.digestArmed = true;
		if (type === "session.idle" && this.pendingSend) void this.deliver("enqueue").then(() => this.publish());
		this.publish();
	}

	async checkDigest() {
		if (this.closed) return false;
		const report = this.session.changesSince(this.session.agentToldVersion, { limit: 10 });
		const due = digestDue({
			enabled: this.digestEnabled,
			canSend: this.agent.canSend,
			editorOpen: this.editorOpen(),
			known: this.agent.known,
			agentIdleMs: this.agent.idleFor(),
			personQuietMs: this.now() - this.lastHumanEditAt,
			unseenChanges: report.total,
			structural: this.structuralSinceTold(),
			armed: this.digestArmed,
		});
		if (!due) return false;
		this.digestArmed = false;
		this.digestSentAt = this.now();
		try {
			await this.agent.send(digestMessage(this.instanceId, report.lines), "enqueue");
		} catch (cause) {
			this.log(`could not send the idle digest: ${cause?.message ?? cause}`);
		}
		this.publish();
		return true;
	}

	/** Whether the person added or removed a cell since the agent was last told. */
	structuralSinceTold() {
		return this.session.journal.some(
			(entry) => entry.version > this.session.agentToldVersion && entry.source === SOURCE_HUMAN && entry.cells.some((change) => change.change !== "updated"),
		);
	}

	// ------------------------------------------------------------ the agent

	/** What goes into every result's `person` block. */
	personReport() {
		const active = this.board.active();
		if (active.length === 0) return undefined;
		const fresh = this.board.unseen();
		this.board.markSeen(fresh);
		if (fresh.length > 0) this.publish();
		return {
			open_asks: active.length,
			...(fresh.length > 0 ? { new_asks: fresh.slice(0, 5).map(askLine), asks_hint: "The person asked for these. Call get_asks for their cells' XML, top first; mark each with update_ask." } : {}),
		};
	}

	/** get_asks: the active asks, top first, with their cells' XML (counted as read). */
	getAsks({ include_done = false } = {}) {
		const asks = include_done ? this.board.list() : this.board.active();
		let budget = ASK_XML_BUDGET;
		const out = asks.map((ask) => {
			const item = { id: ask.id, text: ask.text, status: ask.status, urgent: ask.urgent || undefined, page: ask.page ?? undefined, page_id: ask.page_id ?? undefined, cell_ids: ask.cell_ids.length ? ask.cell_ids : undefined, reply: ask.reply ?? undefined };
			const page = ask.page_id ? this.session.document.page({ page_id: ask.page_id }) : null;
			if (page && !page.compressed && ask.cell_ids.length > 0 && (ask.status === "open" || ask.status === "working")) {
				const wanted = new Set(ask.cell_ids);
				const cells = page.drawable().filter((cell) => wanted.has(cellId(cell)));
				const xml = cells.map((cell) => serializeXml(cell.node)).join("\n");
				const gone = ask.cell_ids.filter((id) => !cells.some((cell) => cellId(cell) === id));
				if (xml.length <= budget) {
					budget -= xml.length;
					item.cells_xml = xml;
					this.session.markCellsSeen(page, cells.map(cellId));
				} else {
					item.note = "Cells too large to include; call get_diagram with these cell_ids.";
				}
				if (gone.length > 0) item.gone = gone;
			}
			return item;
		});
		this.board.markSeen(this.board.active());
		this.publish();
		return out;
	}

	/** update_ask from the agent. */
	updateAsk({ id, status, reply }) {
		if (status !== undefined && !AGENT_ASK_STATUSES.includes(status)) {
			throw Object.assign(new Error(`status must be one of ${AGENT_ASK_STATUSES.join(", ")}.`), { code: "invalid_input" });
		}
		const ask = this.board.update(id, { status, reply });
		ask.seen = true;
		this.publish();
		return ask;
	}

	/** The agent edited cells: asks anchored to them are being worked on. */
	touched(pageId, ids) {
		if (this.board.touched(pageId, ids).length > 0) this.publish();
	}
}
