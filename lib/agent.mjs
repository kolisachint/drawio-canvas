/**
 * The agent, as the canvas sees it: busy or idle, on what, and a way to ask it
 * for something.
 *
 * Both halves come from the host session `joinSession` returns — the SDK's
 * `session.on` for what the agent is doing and `session.send` for talking to
 * it. hoocode has both since 0.5.88; an older host, or one that does not
 * implement them, simply leaves this link unattached: the canvas still works,
 * the bar shows no agent status, and the person's requests reach the agent on
 * its next canvas call instead of waking it.
 *
 * One link per extension process, shared by every open instance, because the
 * host session is per process too.
 */

/** The session events the link listens for (GitHub's names). */
export const AGENT_EVENTS = ["assistant.turn_start", "assistant.intent", "tool.execution_start", "tool.execution_complete", "session.idle", "session.todos_changed"];

export class AgentLink {
	/**
	 * @param {object} [options]
	 * @param {() => number} [options.now]
	 */
	constructor({ now = Date.now } = {}) {
		this.now = now;
		/** Whether the host told us anything at all: without events, busy/idle is unknown. */
		this.known = false;
		this.busy = false;
		this.intent = "";
		this.tool = "";
		this.todos = [];
		this.since = now();
		this.canSend = false;
		this.canListen = false;
		this.listeners = new Set();
		this.session = null;
	}

	/** Take the host session. Safe with a host that has neither `send` nor `on`. */
	attach(session) {
		this.session = session;
		this.canSend = typeof session?.send === "function";
		this.canListen = typeof session?.on === "function";
		if (this.canListen) {
			for (const type of AGENT_EVENTS) {
				try {
					session.on(type, (event) => this.observe(event));
				} catch {
					// A host that lists `on` but refuses a type: that signal is just absent.
				}
			}
		}
		this.changed("attach");
	}

	/** Apply one session event. Public so tests can drive the link without a host. */
	observe(event) {
		const data = event?.data ?? {};
		switch (event?.type) {
			case "assistant.turn_start":
				this.setBusy(true);
				this.intent = "";
				this.tool = "";
				break;
			case "assistant.intent":
				this.setBusy(true);
				this.intent = String(data.intent ?? "");
				break;
			case "tool.execution_start":
				this.setBusy(true);
				this.tool = String(data.toolTitle ?? data.toolName ?? "");
				break;
			case "tool.execution_complete":
				break;
			case "session.idle":
				this.setBusy(false);
				this.intent = "";
				this.tool = "";
				break;
			case "session.todos_changed":
				// hoocode carries the list; upstream sends the event empty.
				if (Array.isArray(data.todos)) this.todos = data.todos.slice(0, 30).map((todo) => ({ id: todo.id, title: String(todo.title ?? ""), status: String(todo.status ?? "") }));
				break;
			default:
				return;
		}
		this.known = true;
		this.changed(event.type);
	}

	setBusy(busy) {
		if (busy !== this.busy) this.since = this.now();
		this.busy = busy;
	}

	/** How long the agent has been idle, in ms; 0 while busy. */
	idleFor() {
		return this.busy ? 0 : this.now() - this.since;
	}

	/** Ask the agent for something. Resolves false when the host cannot take messages. */
	async send(prompt, mode = "enqueue") {
		if (!this.canSend) return false;
		await this.session.send({ prompt, mode });
		return true;
	}

	/**
	 * Context for the person's next message in the host — shown there as a pill,
	 * sent with what they type (the SDK's `sendAttachmentsToMessage`). Replaces
	 * what was pushed before; `[]` withdraws it. Resolves false without a host
	 * that supports it.
	 */
	async pushContext(instanceId, attachments) {
		const push = this.session?.rpc?.extensions?.sendAttachmentsToMessage;
		if (typeof push !== "function") return false;
		await push.call(this.session.rpc.extensions, { instanceId, attachments: attachments.map((item) => ({ type: "extension_context", title: item.title, payload: item.payload })) });
		return true;
	}

	/** Listen for changes: `(state, type)`. Returns a function that stops listening. */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	changed(type) {
		const state = this.state();
		for (const listener of this.listeners) {
			try {
				listener(state, type);
			} catch {
				// One instance's broken listener must not silence the others.
			}
		}
	}

	/** What the page shows. */
	state() {
		return {
			known: this.known,
			busy: this.busy,
			intent: this.intent,
			tool: this.tool,
			since: this.since,
			todos: this.todos,
			can_send: this.canSend,
		};
	}
}
