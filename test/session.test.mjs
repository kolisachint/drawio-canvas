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

	it("refuses an agent edit before the agent has looked", () => {
		const session = new DiagramSession({ xml: SAMPLE_XML });
		assert.deepEqual(session.editGate(), { ok: false, reason: "no-context" });
		session.markSeen();
		assert.deepEqual(session.editGate(), { ok: true });
	});

	it("refuses an agent edit built on a document the person has changed", () => {
		const session = new DiagramSession({ xml: SAMPLE_XML });
		session.markSeen();
		session.apply({}, [addBox("human")], { source: SOURCE_HUMAN });
		assert.deepEqual(session.editGate(), { ok: false, reason: "stale" });
		session.markSeen();
		assert.deepEqual(session.editGate(), { ok: true });
	});

	it("counts the agent's own writes as having been seen", () => {
		// Otherwise every edit would need a read after it, doubling the round trips
		// for a document nobody else touched.
		const session = new DiagramSession({ xml: SAMPLE_XML });
		session.markSeen();
		session.apply({}, [addBox("a")], { source: SOURCE_AGENT });
		assert.deepEqual(session.editGate(), { ok: true });
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
		assert.ok(summary.length <= 40);
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
