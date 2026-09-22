import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childElements, findElement, findElements, parseXml, serializeXml, textContent, XmlError } from "../lib/xml.mjs";

describe("xml", () => {
	it("round-trips a document through parse and serialize", () => {
		const source = '<?xml version="1.0"?><mxfile host="a"><diagram id="x" name="P">' + "<mxGraphModel><root><mxCell id=\"0\" /></root></mxGraphModel></diagram></mxfile>";
		const once = serializeXml(parseXml(source));
		const twice = serializeXml(parseXml(once));
		assert.equal(once, twice);
		assert.match(once, /<\?xml version="1.0"\?>/);
	});

	it("decodes and re-encodes entities without doubling them", () => {
		const document = parseXml('<a label="R&amp;D &lt;b&gt; &#65;" />');
		assert.equal(document.root.attrs.label, "R&D <b> A");
		assert.equal(serializeXml(document), '<a label="R&amp;D &lt;b&gt; A" />');
	});

	it("keeps elements and attributes it knows nothing about", () => {
		// The whole basis for pointing this canvas at a real file: what it cannot
		// draw, it must not lose.
		const source = '<mxCell id="1"><UserObject custom="keep"><mxRectangle as="alternateBounds" x="1" /></UserObject></mxCell>';
		const output = serializeXml(parseXml(source));
		assert.match(output, /custom="keep"/);
		assert.match(output, /alternateBounds/);
	});

	it("preserves CDATA and comments", () => {
		const output = serializeXml(parseXml("<a><!-- note --><b><![CDATA[ <raw> ]]></b></a>"));
		assert.match(output, /<!-- note -->/);
		assert.match(output, /<!\[CDATA\[ <raw> \]\]>/);
	});

	it("does not indent an element whose children include text", () => {
		// Indentation inside a label or a compressed page body would change it.
		const output = serializeXml(parseXml("<diagram>abc123</diagram>"));
		assert.equal(output, "<diagram>abc123</diagram>");
	});

	it("reports where a malformed document went wrong", () => {
		assert.throws(() => parseXml("<a><b></a>"), (error) => error instanceof XmlError && /line \d+, column \d+/.test(error.message));
		assert.throws(() => parseXml("   "), XmlError);
	});

	it("drops a DOCTYPE rather than carrying it", () => {
		// A DOCTYPE is where entity-expansion attacks live; refusing to keep one is
		// the point rather than an omission.
		const output = serializeXml(parseXml('<!DOCTYPE foo [<!ENTITY x "y">]><a />'));
		assert.equal(output, "<a />");
	});

	it("finds elements and reads text", () => {
		const document = parseXml("<a><b><c>1</c></b><c>2</c></a>");
		assert.equal(findElement(document.root, "c").name, "c");
		assert.equal(findElements(document.root, "c").length, 2);
		assert.equal(childElements(document.root, "c").length, 1);
		assert.equal(textContent(document.root), "12");
	});
});
