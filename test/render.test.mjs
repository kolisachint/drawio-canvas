import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DrawioDocument } from "../lib/model.mjs";
import { labelLines, layoutPage, pageBounds, renderPageSvg, wrapLines } from "../lib/render.mjs";
import { SAMPLE_XML } from "./harness.mjs";

const svgOf = (xml) => renderPageSvg(DrawioDocument.parse(xml).page());

describe("renderer", () => {
	it("draws shapes, edges and labels", () => {
		const svg = svgOf(SAMPLE_XML);
		assert.match(svg, /<svg[^>]+viewBox=/);
		assert.match(svg, /data-cell="start"/);
		assert.match(svg, /fill="#dae8fc"/);
		// The rhombus is a path, the edge a polyline with an arrowhead.
		assert.match(svg, /data-cell="check"[^>]*>\s*<path d="M /);
		assert.match(svg, /data-cell="link"/);
		assert.match(svg, />Start</);
		assert.match(svg, />yes</);
	});

	it("draws a shape it does not know as a labelled box in its own colors", () => {
		const svg = svgOf(
			'<mxCell id="q" value="Queue" style="shape=mxgraph.aws4.sqs;fillColor=#FF4F8B;strokeColor=#111111;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="80" as="geometry"/></mxCell>',
		);
		assert.match(svg, /<rect[^>]+fill="#FF4F8B"/);
		assert.match(svg, />Queue</);
	});

	it("escapes label text rather than letting a diagram inject markup", () => {
		const svg = svgOf('<mxCell id="x" value="&lt;script&gt;alert(1)&lt;/script&gt; &amp; more" style="text;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="200" height="40" as="geometry"/></mxCell>');
		assert.equal(svg.includes("<script>"), false);
		assert.match(svg, /alert\(1\)/);
	});

	it("turns an HTML label into lines", () => {
		assert.deepEqual(labelLines("one<br>two<div>three</div>"), ["one", "two", "three", ""]);
		assert.deepEqual(labelLines("<ul><li>a</li><li>b</li></ul>"), ["", "• a", "• b", ""]);
		assert.deepEqual(labelLines("a &amp; b"), ["a & b"]);
	});

	it("wraps a long label to the shape's width", () => {
		const lines = wrapLines(["the quick brown fox jumps over the lazy dog"], 100, 12);
		assert.ok(lines.length > 1);
		assert.ok(lines.every((line) => line.length <= 16));
		// A single unbreakable word still has to break somewhere.
		assert.ok(wrapLines(["supercalifragilisticexpialidocious"], 60, 12).length > 1);
	});

	it("accumulates a child's geometry through its parents", () => {
		const doc = DrawioDocument.parse(
			'<mxfile><diagram name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
				'<mxCell id="lane" value="Lane" style="swimlane;startSize=20;" vertex="1" parent="1"><mxGeometry x="100" y="100" width="200" height="200" as="geometry"/></mxCell>' +
				'<mxCell id="step" value="Step" style="rounded=1;" vertex="1" parent="lane"><mxGeometry x="20" y="40" width="80" height="30" as="geometry"/></mxCell>' +
				"</root></mxGraphModel></diagram></mxfile>",
		);
		const boxes = layoutPage(doc.page());
		assert.deepEqual({ x: boxes.get("step").x, y: boxes.get("step").y }, { x: 120, y: 140 });
	});

	it("bounds the page around its contents, and gives an empty page a page", () => {
		const doc = DrawioDocument.parse(SAMPLE_XML);
		const bounds = pageBounds(doc.page(), layoutPage(doc.page()), 20);
		assert.equal(bounds.x, 20);
		assert.equal(bounds.width, 180);
		const empty = DrawioDocument.blank();
		assert.equal(pageBounds(empty.page(), layoutPage(empty.page())).width, 850);
	});

	it("renders the same page identically twice", () => {
		// The history thumbnails and the live canvas come from this function, so a
		// difference between two calls would show up as a thumbnail that lies.
		assert.equal(svgOf(SAMPLE_XML), svgOf(SAMPLE_XML));
	});
});

describe("label contrast", () => {
	it("colours a label for the shape it sits on, not for the page", async () => {
		const { inkOn } = await import("../lib/render.mjs");
		assert.equal(inkOn("#dae8fc"), "#12161c");
		assert.equal(inkOn("#1f2933"), "#f5f7fa");
		assert.equal(inkOn("#fff"), "#12161c");
		assert.equal(inkOn("none"), null);

		// A pale fill keeps dark text even when the page is dark — the failure this
		// prevents is near-white text on a pastel box, which reads as broken.
		const { renderOptions } = await import("../lib/render.mjs");
		const dark = renderOptions({ fill: "#232a33", stroke: "#e8ebf0", fontColor: "#e8ebf0" });
		const page = DrawioDocument.parse(
			'<mxCell id="p" value="Pale" style="rounded=1;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell>',
		).page();
		assert.match(renderPageSvg(page, dark), /fill="#12161c"[^>]*>.*Pale/s);

		// An unfilled shape still follows the page.
		const unfilled = DrawioDocument.parse(
			'<mxCell id="u" value="Plain" style="rounded=1;fillColor=none;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell>',
		).page();
		assert.match(renderPageSvg(unfilled, dark), /fill="#e8ebf0"[^>]*>.*Plain/s);

		// And an explicit fontColor is never second-guessed.
		const explicit = DrawioDocument.parse(
			'<mxCell id="e" value="Mine" style="rounded=1;fillColor=#dae8fc;fontColor=#b85450;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell>',
		).page();
		assert.match(renderPageSvg(explicit, dark), /fill="#b85450"[^>]*>.*Mine/s);
	});
});
