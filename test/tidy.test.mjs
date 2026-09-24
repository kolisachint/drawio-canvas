/**
 * Tidy: fit, snap, align, un-overlap, and straighten — on plain boxes, and as
 * the agent's action on a real document.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DrawioDocument, cellGeometry } from "../lib/model.mjs";
import { describeTidy, estimateLabelSize, labelLines, tidy } from "../lib/tidy.mjs";
import { tidyPage } from "../lib/tidy-page.mjs";
import { openCanvas } from "./harness.mjs";

const box = (id, x, y, width = 120, height = 60, extra = {}) => ({ id, x, y, width, height, ...extra });
const only = (steps) => ({ steps: { fit: false, snap: false, align: false, overlap: false, waypoints: false, ...steps } });
const byId = (result) => Object.fromEntries(result.changes.map((change) => [change.id, change]));

describe("tidy", () => {
	it("pushes an overlapping shape the shorter way, leaving a gap", () => {
		const result = tidy([box("a", 0, 0), box("b", 100, 10)], [], only({ overlap: true }));
		const b = byId(result).b;
		assert.equal(b.y, 10, "pushed right, not down");
		assert.ok(b.x >= 0 + 120 + 20);
		assert.equal(result.summary.separated, 1);
	});

	it("keeps pushing until nothing overlaps", () => {
		const shapes = [box("a", 0, 0), box("b", 10, 0), box("c", 20, 0), box("d", 30, 0)];
		const result = tidy(shapes, [], only({ overlap: true }));
		const final = shapes.map((shape) => ({ ...shape, ...(byId(result)[shape.id] ?? {}) }));
		for (let i = 0; i < final.length; i += 1) {
			for (let j = i + 1; j < final.length; j += 1) {
				const [p, q] = [final[i], final[j]];
				const overlaps = p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
				assert.equal(overlaps, false, `${p.id} and ${q.id}`);
			}
		}
	});

	it("leaves a container drawn around shapes alone, and shapes in other containers", () => {
		const shapes = [box("zone", 0, 0, 400, 300), box("inside", 40, 40), box("a", 0, 0, 100, 100, { parent: "group1" }), box("b", 50, 50, 100, 100, { parent: "group2" })];
		assert.deepEqual(tidy(shapes, [], only({ overlap: true })).changes, []);
	});

	it("moves only what is in scope; the rest is an obstacle", () => {
		const result = tidy([box("fixed", 0, 0), box("free", 50, 0)], [], { ...only({ overlap: true }), scope: ["fixed"] });
		assert.deepEqual(Object.keys(byId(result)), ["fixed"]);
	});

	it("grows a shape to fit its label and never shrinks one", () => {
		const long = "A service with a rather long name that will not fit";
		const result = tidy([box("small", 100, 100, 60, 40, { label: long }), box("big", 400, 100, 300, 200, { label: "x" })], [], only({ fit: true }));
		const small = byId(result).small;
		assert.ok(small.width > 60 && small.height >= 40);
		assert.equal(small.x + small.width / 2, 130, "grows around its centre");
		assert.equal(byId(result).big, undefined);
	});

	it("uses a measured size when the caller has one, and skips icons and outside labels", () => {
		const result = tidy(
			[
				box("m", 0, 0, 40, 40, { label: "x", preferred: { width: 90, height: 50 } }),
				box("icon", 200, 0, 48, 48, { label: "Amazon Simple Storage Service", style: "shape=mxgraph.aws4.s3;verticalLabelPosition=bottom;" }),
			],
			[],
			only({ fit: true }),
		);
		assert.deepEqual([byId(result).m.width, byId(result).m.height], [90, 50]);
		assert.equal(byId(result).icon, undefined);
	});

	it("lines up centres that nearly match, in rows and columns", () => {
		const result = tidy([box("a", 0, 100), box("b", 200, 106), box("c", 400, 97), box("far", 600, 300)], [], only({ align: true }));
		const changed = byId(result);
		const centreY = (id, y) => (changed[id]?.y ?? y) + 30;
		assert.equal(centreY("a", 100), centreY("b", 106));
		assert.equal(centreY("b", 106), centreY("c", 97));
		assert.equal(changed.far, undefined);
	});

	it("snaps sizes up and positions onto the grid", () => {
		const result = tidy([box("a", 13, 27, 101, 55)], [], only({ snap: true }));
		assert.deepEqual(byId(result).a, { id: "a", x: 10, y: 30, width: 110, height: 60 });
	});

	it("drops the bends of edges whose shapes moved", () => {
		const result = tidy([box("a", 0, 0), box("b", 50, 0), box("c", 500, 500)], [{ id: "e1", source: "a", target: "b", points: 2 }, { id: "e2", source: "c", target: "a", points: 0 }, { id: "e3", source: "c", target: "c", points: 1 }], only({ overlap: true, waypoints: true }));
		assert.deepEqual(result.clearPoints, ["e1"]);
	});

	it("is a no-op on a tidy diagram", () => {
		const result = tidy([box("a", 0, 0, 120, 60, { label: "A" }), box("b", 200, 0, 120, 60, { label: "B" })]);
		assert.deepEqual(result.changes, []);
		assert.equal(describeTidy(result.summary), "already tidy");
	});

	it("settles: a second tidy changes nothing, on random pages", () => {
		let seed = 7;
		const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
		for (let round = 0; round < 200; round += 1) {
			const shapes = Array.from({ length: 2 + Math.floor(random() * 10) }, (_, index) =>
				box(`s${index}`, Math.floor(random() * 500), Math.floor(random() * 400), 40 + Math.floor(random() * 120), 30 + Math.floor(random() * 60), { label: "x".repeat(Math.floor(random() * 40)) }),
			);
			const first = tidy(shapes);
			const after = shapes.map((shape) => ({ ...shape, ...(byId(first)[shape.id] ?? {}) }));
			const second = tidy(after);
			assert.deepEqual(second.changes, [], `round ${round}: ${JSON.stringify(second.summary)}`);
		}
	});

	it("reads HTML labels as text", () => {
		assert.deepEqual(labelLines("<b>API</b><br>gateway &amp; auth"), ["API", "gateway & auth"]);
		assert.equal(estimateLabelSize(""), null);
	});
});

describe("tidy on a document", () => {
	const XML = `<mxfile><diagram id="p1" name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="Alpha" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>
<mxCell id="b" value="Beta" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="100" y="50" width="120" height="60" as="geometry"/></mxCell>
<mxCell id="e" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="300" y="300"/></Array></mxGeometry></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

	it("writes the new geometry and drops stale bends", () => {
		const doc = DrawioDocument.parse(XML);
		const page = doc.page();
		const result = tidyPage(page);
		assert.ok(result.changes.length > 0);
		const a = cellGeometry(page.find("a"));
		const b = cellGeometry(page.find("b"));
		assert.ok(b.x >= a.x + a.width || b.y >= a.y + a.height, "no longer overlapping");
		assert.deepEqual(cellGeometry(page.find("e")).points, []);
	});

	it("runs as the agent's action and reports what it did", async () => {
		const opened = await openCanvas({ input: { xml: XML } });
		try {
			const result = await opened.invoke("tidy", {});
			assert.match(result.done, /moved off an overlap/);
			const again = await opened.invoke("tidy", {});
			assert.equal(again.done, "already tidy");
			assert.equal(again.version, result.version, "a no-op makes no version");
		} finally {
			await opened.close();
		}
	});
});
