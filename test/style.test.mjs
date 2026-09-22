import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatStyle, parseStyle, shapeOf, styleColor, styleFlag, styleNumber, withStyleKey } from "../lib/style.mjs";

describe("style strings", () => {
	it("parses pairs and bare tokens, and puts bare tokens back first", () => {
		const parsed = parseStyle("swimlane;startSize=30;html=1;");
		assert.deepEqual(parsed.bare, ["swimlane"]);
		assert.equal(parsed.keys.startSize, "30");
		assert.equal(formatStyle(parsed), "swimlane;startSize=30;html=1;");
	});

	it("changes one key and leaves the rest of the string alone", () => {
		// The basis for round-tripping: a style may name a stencil this canvas has
		// never heard of, and restyling a fill must not disturb it.
		const style = "shape=mxgraph.aws4.lambda;sketch=0;outlineConnect=0;fillColor=#ED7100;";
		const next = withStyleKey(style, "fillColor", "#00ff00");
		assert.match(next, /shape=mxgraph\.aws4\.lambda/);
		assert.match(next, /outlineConnect=0/);
		assert.match(next, /fillColor=#00ff00/);
		assert.equal(withStyleKey(next, "fillColor", null).includes("fillColor"), false);
	});

	it("reads numbers, flags and colors with draw.io's conventions", () => {
		const { keys } = parseStyle("strokeWidth=2;dashed=1;fillColor=none;fontColor=default;opacity=50;");
		assert.equal(styleNumber(keys, "strokeWidth", 1), 2);
		assert.equal(styleNumber(keys, "missing", 7), 7);
		assert.equal(styleFlag(keys, "dashed"), true);
		assert.equal(styleFlag(keys, "rounded", false), false);
		assert.equal(styleColor(keys, "fillColor"), null);
		assert.equal(styleColor(keys, "fontColor"), null);
		assert.equal(styleNumber(keys, "opacity", 100), 50);
	});

	it("names the shape from any of the three spellings", () => {
		assert.equal(shapeOf(parseStyle("ellipse;whiteSpace=wrap;")), "ellipse");
		assert.equal(shapeOf(parseStyle("shape=cylinder;")), "cylinder");
		assert.equal(shapeOf(parseStyle("rounded=1;whiteSpace=wrap;html=1;")), "rectangle");
		assert.equal(shapeOf(parseStyle("swimlane;startSize=23;")), "swimlane");
		assert.equal(shapeOf(parseStyle("group")), "group");
	});

	it("falls back to a rectangle for a stencil it cannot draw", () => {
		assert.equal(shapeOf(parseStyle("shape=mxgraph.azure.web_app;html=1;")), "rectangle");
		assert.equal(shapeOf(parseStyle("shape=somethingNobodyHasHeardOf;")), "rectangle");
	});
});
