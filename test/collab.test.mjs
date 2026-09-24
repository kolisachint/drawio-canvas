/**
 * Working with the agent: the person's asks, when they reach the agent, the idle
 * digest, and the agent's status as the bar shows it.
 *
 * The host session is a small fake with the SDK's `send` and `on`, so these run
 * with no host. The whole loop through a real hoocode is `scripts/e2e-hoocode.mjs`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentLink } from "../lib/agent.mjs";
import { AskBoard, askLine, DIGEST, digestDue } from "../lib/asks.mjs";
import { Collaboration } from "../lib/collab.mjs";
import { DiagramSession } from "../lib/session.mjs";
import { openCanvas, SAMPLE_XML } from "./harness.mjs";

/** A host session with the SDK's `send` and `on`, recording what the canvas sent. */
function fakeHost() {
	const handlers = new Map();
	const sent = [];
	const pushed = [];
	return {
		sent,
		pushed,
		session: {
			rpc: { extensions: { sendAttachmentsToMessage: async (params) => void pushed.push(params) } },
			send: async (options) => {
				sent.push(options);
				return `m${sent.length}`;
			},
			on: (type, handler) => {
				handlers.set(type, [...(handlers.get(type) ?? []), handler]);
				return () => {};
			},
		},
		emit(type, data = {}) {
			for (const handler of handlers.get(type) ?? []) handler({ id: "e", timestamp: "t", parentId: null, ephemeral: true, type, data });
		},
	};
}

function linked({ now } = {}) {
	const host = fakeHost();
	const agent = new AgentLink(now ? { now } : {});
	agent.attach(host.session);
	return { host, agent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("agent link", () => {
	it("tracks busy, intent and tool from the host's events", () => {
		const { host, agent } = linked();
		assert.equal(agent.state().known, false);
		host.emit("assistant.turn_start", { turnId: "t" });
		host.emit("tool.execution_start", { toolCallId: "c", toolName: "invoke_canvas_action", toolTitle: "canvas: edit_diagram" });
		assert.deepEqual({ busy: agent.busy, tool: agent.tool, known: agent.known }, { busy: true, tool: "canvas: edit_diagram", known: true });
		host.emit("session.todos_changed", { todos: [{ id: 1, title: "Draw the VPC", status: "in_progress" }] });
		assert.equal(agent.todos[0].title, "Draw the VPC");
		host.emit("session.idle");
		assert.equal(agent.busy, false);
		assert.equal(agent.tool, "");
	});

	it("stays inert with a host that has neither send nor on", async () => {
		const agent = new AgentLink();
		agent.attach({ log: async () => {} });
		assert.equal(agent.canSend, false);
		assert.equal(await agent.send("hello"), false);
	});
});

describe("ask board", () => {
	it("keeps priority order, urgent first, finished last", () => {
		const board = new AskBoard();
		const a = board.add({ text: "first" });
		const b = board.add({ text: "second" });
		const c = board.add({ text: "now please", urgent: true });
		assert.deepEqual(board.active().map((ask) => ask.id), [c.id, a.id, b.id]);
		board.update(c.id, { status: "done", reply: "did it" });
		board.reorder([b.id, a.id]);
		assert.deepEqual(board.list().map((ask) => ask.id), [b.id, a.id, c.id]);
	});

	it("refuses empty text and unknown ids with a code", () => {
		const board = new AskBoard();
		assert.throws(() => board.add({ text: "  " }), (error) => error.code === "invalid_input");
		assert.throws(() => board.update(7, { status: "done" }), (error) => error.code === "unknown_ask");
	});

	it("moves an open ask to working when the agent edits its cells", () => {
		const board = new AskBoard();
		const ask = board.add({ text: "fix", page_id: "p1", cell_ids: ["start"] });
		assert.equal(board.touched("p1", ["other"]).length, 0);
		assert.equal(board.touched("p1", ["start"]).length, 1);
		assert.equal(board.get(ask.id).status, "working");
	});

	it("describes an ask in one line with its cells and page", () => {
		const board = new AskBoard();
		const ask = board.add({ text: "align these", page: "Flow", cell_ids: ["a", "b"] });
		assert.equal(askLine(ask), `#${ask.id} "align these" — cells a, b on "Flow"`);
	});
});

describe("idle digest", () => {
	const base = { enabled: true, canSend: true, editorOpen: true, known: true, agentIdleMs: DIGEST.agentIdleMs, personQuietMs: DIGEST.personQuietMs, unseenChanges: 3, structural: false, armed: true };

	it("is due only when every condition holds", () => {
		assert.equal(digestDue(base), true);
		for (const [key, value] of Object.entries({ enabled: false, canSend: false, editorOpen: false, known: false, armed: false, agentIdleMs: 1000, personQuietMs: 1000, unseenChanges: 2 })) {
			assert.equal(digestDue({ ...base, [key]: value }), false, key);
		}
	});

	it("goes for a single added or removed cell", () => {
		assert.equal(digestDue({ ...base, unseenChanges: 1, structural: true }), true);
	});
});

describe("the selection as context for the person's next message", () => {
	it("offers what is selected, once per change, and withdraws it when nothing is", async () => {
		const { host, agent } = linked();
		const opened = await openCanvas({ agent, input: { xml: SAMPLE_XML } });
		try {
			const presence = (selection) => opened.fetch("api/presence", { method: "POST", body: JSON.stringify({ page_id: "p1", page: "Flow", selection }) });
			await presence(["start", "check"]);
			await presence(["start", "check"]);
			await settle();
			assert.equal(host.pushed.length, 1);
			const [push] = host.pushed;
			assert.equal(push.instanceId, opened.instanceId);
			assert.equal(push.attachments[0].type, "extension_context");
			assert.equal(push.attachments[0].title, '2 selected on "Flow": Start, Valid?');
			assert.deepEqual(push.attachments[0].payload.cell_ids, ["start", "check"]);
			await presence([]);
			await settle();
			assert.deepEqual(host.pushed.at(-1).attachments, []);
			assert.equal(host.sent.length, 0, "a selection never messages the agent");
		} finally {
			await opened.close();
		}
	});
});

describe("asks through the canvas", () => {
	it("sends an ask at once when the agent is idle, and starts nothing on an edit", async () => {
		const { host, agent } = linked();
		const opened = await openCanvas({ agent, input: { xml: SAMPLE_XML } });
		try {
			// The person editing does not reach the agent.
			await opened.fetch("api/sync", {
				method: "POST",
				body: JSON.stringify({ changes: [{ kind: "cell-remove", page_id: "p1", cell_id: "link" }] }),
			});
			assert.equal(host.sent.length, 0);

			const response = await opened.fetch("api/collab", { method: "POST", body: JSON.stringify({ op: "ask", text: "Make the check a diamond", page_id: "p1", cell_ids: ["check"] }) });
			const { ask } = await response.json();
			assert.equal(host.sent.length, 1);
			assert.equal(host.sent[0].mode, "enqueue");
			assert.match(host.sent[0].prompt, new RegExp(`#${ask.id} "Make the check a diamond" — cells check on "Flow"`));
			assert.match(host.sent[0].prompt, new RegExp(`instanceId ${opened.instanceId}`));
		} finally {
			await opened.close();
		}
	});

	it("holds an ask while the agent is busy, shows it in results, and sends what is still open at idle", async () => {
		const { host, agent } = linked();
		const opened = await openCanvas({ agent, input: { xml: SAMPLE_XML } });
		try {
			host.emit("assistant.turn_start");
			const post = (body) => opened.fetch("api/collab", { method: "POST", body: JSON.stringify(body) }).then((response) => response.json());
			const first = (await post({ op: "ask", text: "Label the edge", page_id: "p1", cell_ids: ["link"] })).ask;
			const second = (await post({ op: "ask", text: "Colour the start green", page_id: "p1", cell_ids: ["start"] })).ask;
			assert.equal(host.sent.length, 0);

			// The busy agent's next canvas call carries them.
			const read = await opened.invoke("get_diagram", {});
			assert.equal(read.person.open_asks, 2);
			assert.equal(read.person.new_asks.length, 2);
			// Told once, not on every call.
			assert.equal((await opened.invoke("get_changes", {})).new_asks, undefined);

			// get_asks hands over the cells' XML and counts it as read.
			const { asks } = await opened.invoke("get_asks", {});
			assert.match(asks[0].cells_xml, /id="link"/);
			await opened.invoke("update_ask", { id: first.id, status: "done", reply: "Labelled it yes/no." });

			host.emit("session.idle");
			await settle();
			assert.equal(host.sent.length, 1);
			assert.match(host.sent[0].prompt, new RegExp(`#${second.id}`));
			assert.doesNotMatch(host.sent[0].prompt, new RegExp(`#${first.id} `));
		} finally {
			await opened.close();
		}
	});

	it("steers a busy agent with 'now'", async () => {
		const { host, agent } = linked();
		const opened = await openCanvas({ agent });
		try {
			host.emit("assistant.turn_start");
			const response = await opened.fetch("api/collab", { method: "POST", body: JSON.stringify({ op: "ask", text: "Stop, wrong page", now: true }) });
			assert.equal(response.status, 200);
			assert.equal(host.sent.length, 1);
			assert.equal(host.sent[0].mode, "immediate");
		} finally {
			await opened.close();
		}
	});

	it("marks an anchored ask working when the agent edits its cells, and done on update_ask", async () => {
		const { agent } = linked();
		const opened = await openCanvas({ agent, input: { xml: SAMPLE_XML } });
		try {
			await opened.fetch("api/collab", { method: "POST", body: JSON.stringify({ op: "ask", text: "Rename start", page_id: "p1", cell_ids: ["start"] }) });
			const { asks } = await opened.invoke("get_asks", {});
			await opened.invoke("edit_diagram", {
				operations: [{ operation: "update", cell_id: "start", new_xml: '<mxCell id="start" value="Begin" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="140" height="60" as="geometry"/></mxCell>' }],
			});
			let state = await (await opened.fetch("api/collab")).json();
			assert.equal(state.asks.find((ask) => ask.id === asks[0].id).status, "working");
			await opened.invoke("update_ask", { id: asks[0].id, status: "done", reply: "Renamed to Begin." });
			state = await (await opened.fetch("api/collab")).json();
			assert.deepEqual(
				state.asks.map((ask) => [ask.status, ask.reply]),
				[["done", "Renamed to Begin."]],
			);
		} finally {
			await opened.close();
		}
	});

	it("refuses an agent status that is the person's to set", async () => {
		const { agent } = linked();
		const opened = await openCanvas({ agent });
		try {
			await opened.fetch("api/collab", { method: "POST", body: JSON.stringify({ op: "ask", text: "Something" }) });
			await assert.rejects(async () => opened.invoke("update_ask", { id: 1, status: "dismissed" }), (error) => error.code === "invalid_input");
		} finally {
			await opened.close();
		}
	});

	it("turns unseen edits into one review ask anchored to the changed cells", async () => {
		const { host, agent } = linked();
		const opened = await openCanvas({ agent, input: { xml: SAMPLE_XML } });
		try {
			await opened.invoke("get_diagram", {});
			await opened.fetch("api/sync", {
				method: "POST",
				body: JSON.stringify({
					changes: [{ kind: "cell-upsert", page_id: "p1", cell_id: "check", xml: '<mxCell id="check" value="OK?" style="rhombus;" vertex="1" parent="1"><mxGeometry x="60" y="180" width="120" height="80" as="geometry"/></mxCell>' }],
				}),
			});
			const before = await (await opened.fetch("api/collab")).json();
			assert.equal(before.unseen, 1);
			const { ask } = await (await opened.fetch("api/collab", { method: "POST", body: JSON.stringify({ op: "review" }) })).json();
			assert.deepEqual(ask.cell_ids, ["check"]);
			assert.equal(host.sent.length, 1);
		} finally {
			await opened.close();
		}
	});

	it("keeps asks for the agent's next call when the host cannot take messages", async () => {
		const agent = new AgentLink();
		agent.attach({});
		const opened = await openCanvas({ agent });
		try {
			const state = (await (await opened.fetch("api/collab", { method: "POST", body: JSON.stringify({ op: "ask", text: "Add a cache" }) })).json()).state;
			assert.equal(state.delivery, "next_call");
			const read = await opened.invoke("get_diagram", {});
			assert.equal(read.person.open_asks, 1);
		} finally {
			await opened.close();
		}
	});

	it("sends one idle digest per idle stretch, and only when the person paused", async () => {
		let clock = 1_000_000;
		const now = () => clock;
		const { host, agent } = linked({ now });
		const session = new DiagramSession({ xml: SAMPLE_XML });
		session.markSeen();
		const prefs = { values: { digest: true }, read: async () => prefs.values, write: async (values) => Object.assign(prefs.values, values) };
		const collab = new Collaboration({ instanceId: "i1", session, agent, editorOpen: () => true, prefs, now, timers: false });
		try {
			host.emit("assistant.turn_start");
			host.emit("session.idle");
			for (const id of ["start", "check"]) session.applyEditor([{ kind: "cell-remove", page_id: "p1", cell_id: id }]);
			assert.equal(await collab.checkDigest(), false, "the agent has not been idle long enough");
			clock += DIGEST.agentIdleMs + DIGEST.personQuietMs;
			assert.equal(await collab.checkDigest(), true);
			assert.match(host.sent.at(-1).prompt, /paused after editing/);
			assert.equal(await collab.checkDigest(), false, "one per idle stretch");

			// The agent's next turn re-arms it; the person can turn it off.
			host.emit("assistant.turn_start");
			host.emit("session.idle");
			clock += DIGEST.agentIdleMs + DIGEST.personQuietMs;
			await collab.command({ op: "digest", enabled: false });
			assert.equal(prefs.values.digest, false);
			assert.equal(await collab.checkDigest(), false);
			await collab.command({ op: "digest", enabled: true });
			assert.equal(await collab.checkDigest(), true);
		} finally {
			collab.close();
		}
	});

	it("does not send a digest while the person is still editing", async () => {
		let clock = 1_000_000;
		const now = () => clock;
		const { host, agent } = linked({ now });
		const session = new DiagramSession({ xml: SAMPLE_XML });
		const prefs = { read: async () => ({ digest: true }), write: async (values) => values };
		const collab = new Collaboration({ instanceId: "i1", session, agent, editorOpen: () => true, prefs, now, timers: false });
		try {
			host.emit("session.idle");
			clock += DIGEST.agentIdleMs * 2;
			for (const id of ["start", "check", "link"]) session.applyEditor([{ kind: "cell-remove", page_id: "p1", cell_id: id }]);
			assert.equal(await collab.checkDigest(), false);
			assert.equal(host.sent.length, 0);
		} finally {
			collab.close();
		}
	});
});
