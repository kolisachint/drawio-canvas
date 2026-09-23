import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DiagramError } from "../lib/model.mjs";
import { DiagramSession, SOURCE_AGENT, SOURCE_HUMAN } from "../lib/session.mjs";
import { SAMPLE_XML } from "./harness.mjs";

const addBox = (id) => ({
	operation: "add",
	cell_id: id,
	new_xml: `<mxCell value="${id}" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>`,
});

describe("session", () => {
	it("starts blank and bumps a version per change", () => {
		const session = new DiagramSession();
		assert.equal(session.version, 1);
		assert.equal(session.document.page().drawable().length, 0);
		session.apply({}, [addBox("a")], { source: SOURCE_AGENT });
		assert.equal(session.version, 2);
	});

	const update = (id, label) => ({
		operation: "update",
		cell_id: id,
		new_xml: `<mxCell value="${label}" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="140" height="60" as="geometry"/></mxCell>`,
	});

	it("refuses an agent edit before the agent has looked", () => {
		const session = new DiagramSession({ xml: SAMPLE_XML });
		const page = session.document.page();
		assert.deepEqual(session.editGate(page, [addBox("a")]), { ok: false, reason: "no-context" });
		session.markPageSeen(page);
		assert.deepEqual(session.editGate(page, [addBox("a"), update("start", "Go")]), { ok: true });
	});

	it("refuses only the cells the person changed since the agent read them", () => {
		const session = new DiagramSession({ xml: SAMPLE_XML });
		const page = session.document.page();
		session.markPageSeen(page);
		session.apply({}, [update("start", "Begin")], { source: SOURCE_HUMAN });

		// Working elsewhere on the page is not a conflict: the person editing one
		// box does not stop the agent finishing the rest of the diagram.
		assert.deepEqual(session.editGate(page, [addBox("new"), { operation: "delete", cell_id: "check" }]), { ok: true });

		const verdict = session.editGate(page, [update("start", "Go")]);
		assert.equal(verdict.ok, false);
		assert.equal(verdict.reason, "stale");
		assert.deepEqual(verdict.conflicts.map((conflict) => conflict.cell_id), ["start"]);
		assert.match(verdict.conflicts[0].changes[0], /human: .*"Start" → "Begin"/);

		// Reading just that cell is enough.
		session.markCellsSeen(page, ["start"]);
		assert.deepEqual(session.editGate(page, [update("start", "Go")]), { ok: true });
	});

	it("counts the agent's own writes as having been seen", () => {
		// Otherwise every edit would need a read after it, doubling the round trips
		// for a document nobody else touched.
		const session = new DiagramSession({ xml: SAMPLE_XML });
		const page = session.document.page();
		session.markPageSeen(page);
		session.apply({}, [addBox("a")], { source: SOURCE_AGENT });
		assert.deepEqual(session.editGate(page, [update("a", "A2"), update("start", "S")]), { ok: true });
	});

	it("tells the agent what the person did, once", () => {
		const session = new DiagramSession({ xml: SAMPLE_XML });
		session.apply({}, [addBox("mine")], { source: SOURCE_AGENT });
		session.apply({}, [update("start", "Begin"), { operation: "delete", cell_id: "check" }], { source: SOURCE_HUMAN });
		const told = session.tellAgent();
		assert.equal(told.length, 3, told.join("\n"));
		assert.ok(told.some((line) => /relabelled "Start" → "Begin"/.test(line)));
		assert.ok(told.some((line) => /removed .*\[check\]/.test(line)));
		assert.ok(told.every((line) => !/\[mine\]/.test(line)), "the agent's own edit is not reported back to it");
		assert.equal(session.tellAgent(), undefined);
	});

	it("tells subscribers what changed, and survives one that throws", () => {
		const session = new DiagramSession();
		const seen = [];
		session.subscribe(() => {
			throw new Error("this subscriber is gone");
		});
		const unsubscribe = session.subscribe((event) => seen.push(event));
		session.apply({}, [addBox("a")], { source: SOURCE_AGENT });
		assert.deepEqual(seen.map((event) => [event.version, event.source, event.touched]), [[2, "agent", ["a"]]]);
		unsubscribe();
		session.apply({}, [addBox("b")], { source: SOURCE_HUMAN });
		assert.equal(seen.length, 1);
	});

	it("restores a past version as a new version, so the undo can be undone", () => {
		const session = new DiagramSession({ xml: SAMPLE_XML });
		session.markSeen();
		session.apply({}, [addBox("later")], { source: SOURCE_AGENT });
		const withLater = session.version;
		session.restore(withLater - 1);
		assert.equal(session.document.page().find("later"), null);
		session.restore(withLater);
		assert.ok(session.document.page().find("later"));
		assert.throws(() => session.restore(9999), DiagramError);
	});

	it("keeps history bounded and newest first", () => {
		const session = new DiagramSession();
		for (let n = 0; n < 60; n += 1) session.apply({}, [addBox(`c${n}`)], { source: SOURCE_HUMAN });
		const summary = session.historySummary();
		assert.ok(summary.length <= 61);
		assert.ok(summary[0].version > summary[1].version);
	});

	it("manages pages through one verb", () => {
		const session = new DiagramSession({ xml: SAMPLE_XML });
		assert.equal(session.pages({ op: "list" }).pages.length, 1);
		const added = session.pages({ op: "add", name: "Second" });
		assert.equal(added.page.name, "Second");
		session.pages({ op: "rename", page_index: 1, name: "Renamed" });
		assert.equal(session.document.pages()[1].name, "Renamed");
		assert.equal(session.pages({ op: "delete", page_index: 1 }).deleted, "Renamed");
		assert.throws(() => session.pages({ op: "delete", page_index: 0 }), DiagramError);
		assert.throws(() => session.pages({ op: "nonsense" }), DiagramError);
	});
});
