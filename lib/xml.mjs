/**
 * A small XML parser and serializer, written here rather than installed.
 *
 * A canvas extension may import `@github/copilot-sdk/extension` and `node:`
 * builtins and nothing else — no `package.json`, no `node_modules`. That rules
 * out every XML library, and the browser half of this canvas cannot use
 * `DOMParser` either, because the same document has to be parsed identically on
 * both sides: the server applies the agent's edits, the page applies the
 * person's, and a disagreement about what the document *is* would show up as one
 * of them silently losing work.
 *
 * So this module is the single definition of "the document", and it is
 * deliberately non-destructive: anything it does not understand — a `<Object>`
 * wrapper, a stencil's `<mxRectangle>`, a comment, an attribute nobody here has
 * heard of — is carried through parse and serialize unchanged. draw.io files
 * contain plenty this canvas cannot draw. Losing what we cannot draw would make
 * the canvas unsafe to point at a real file; rendering it plainly is merely a
 * limitation.
 *
 * Not a general XML implementation: no DTDs, no namespace resolution, no
 * external entities (deliberately — parsing a file from the workspace must not
 * be able to read another one). Enough for the mxGraph dialect, which is what a
 * `.drawio` file is.
 */

/** Named entities XML defines. Anything else numeric is decoded; the rest is literal. */
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Raised with a line and column, because a bad diagram is usually hand-edited. */
export class XmlError extends Error {
	constructor(message, source, index) {
		const { line, column } = positionOf(source, index);
		super(`${message} (line ${line}, column ${column})`);
		this.name = "XmlError";
		this.line = line;
		this.column = column;
	}
}

function positionOf(source, index) {
	let line = 1;
	let column = 1;
	for (let i = 0; i < index && i < source.length; i += 1) {
		if (source[i] === "\n") {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	}
	return { line, column };
}

/** Decode the entities an mxGraph document actually uses. */
export function decodeEntities(text) {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
		if (body[0] === "#") {
			const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
			// An out-of-range code point is left alone rather than throwing: the
			// document still round-trips, which matters more than rejecting it.
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
	});
}

/** Encode text content. `>` is escaped too, so `]]>` can never appear by accident. */
export function encodeText(text) {
	return String(text).replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/** Encode an attribute value for double-quoted output. */
export function encodeAttribute(text) {
	return String(text)
		.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"))
		.replace(/[\n\r\t]/g, (c) => (c === "\n" ? "&#10;" : c === "\r" ? "&#13;" : "&#9;"));
}

/** An element node. `attrs` keeps insertion order, which is what makes output stable. */
export function element(name, attrs = {}, children = []) {
	return { type: "element", name, attrs: { ...attrs }, children };
}

/** A text node. */
export function text(value) {
	return { type: "text", value };
}

/**
 * Parse an XML document.
 *
 * Returns `{ prolog, root }` where `prolog` is whatever preceded the root
 * element (declaration, comments) so a file that had one still has one after a
 * round trip.
 */
export function parseXml(source) {
	const parser = new Parser(source);
	return parser.parseDocument();
}

class Parser {
	constructor(source) {
		this.source = source;
		this.index = 0;
	}

	parseDocument() {
		const prolog = [];
		let root;
		while (this.index < this.source.length) {
			this.skipWhitespace();
			if (this.index >= this.source.length) break;
			if (!this.source.startsWith("<", this.index)) {
				// Stray text outside the root element. Ignorable in every real file we
				// have seen; keeping it would mean inventing a place to put it.
				this.index += 1;
				continue;
			}
			if (this.source.startsWith("<?", this.index) || this.source.startsWith("<!", this.index)) {
				const node = this.parseMarkupDeclaration();
				if (root) continue;
				if (node) prolog.push(node);
				continue;
			}
			if (root) {
				// A second root element. Real `.drawio` files never have one; stopping
				// here keeps the first, which is the document.
				break;
			}
			root = this.parseElement();
		}
		if (!root) throw new XmlError("No root element", this.source, this.index);
		return { prolog, root };
	}

	skipWhitespace() {
		while (this.index < this.source.length && /\s/.test(this.source[this.index])) this.index += 1;
	}

	/** `<?...?>`, `<!--...-->`, `<![CDATA[...]]>`, `<!DOCTYPE ...>`. */
	parseMarkupDeclaration() {
		if (this.source.startsWith("<!--", this.index)) {
			const end = this.source.indexOf("-->", this.index + 4);
			if (end === -1) throw new XmlError("Unterminated comment", this.source, this.index);
			const value = this.source.slice(this.index + 4, end);
			this.index = end + 3;
			return { type: "comment", value };
		}
		if (this.source.startsWith("<![CDATA[", this.index)) {
			const end = this.source.indexOf("]]>", this.index + 9);
			if (end === -1) throw new XmlError("Unterminated CDATA section", this.source, this.index);
			const value = this.source.slice(this.index + 9, end);
			this.index = end + 3;
			return { type: "cdata", value };
		}
		if (this.source.startsWith("<?", this.index)) {
			const end = this.source.indexOf("?>", this.index + 2);
			if (end === -1) throw new XmlError("Unterminated processing instruction", this.source, this.index);
			const value = this.source.slice(this.index + 2, end);
			this.index = end + 2;
			return { type: "pi", value };
		}
		// <!DOCTYPE ...> and anything else declaration-shaped: skipped, not kept.
		// A DOCTYPE is the entry point for entity expansion attacks, so refusing to
		// carry one is the point rather than an omission.
		const end = this.source.indexOf(">", this.index);
		if (end === -1) throw new XmlError("Unterminated declaration", this.source, this.index);
		this.index = end + 1;
		return null;
	}

	parseElement() {
		const start = this.index;
		this.index += 1; // "<"
		const name = this.readName();
		if (!name) throw new XmlError("Expected an element name", this.source, start);
		const attrs = {};
		for (;;) {
			this.skipWhitespace();
			if (this.source.startsWith("/>", this.index)) {
				this.index += 2;
				return element(name, attrs, []);
			}
			if (this.source.startsWith(">", this.index)) {
				this.index += 1;
				break;
			}
			const attrName = this.readName();
			if (!attrName) throw new XmlError(`Malformed attribute in <${name}>`, this.source, this.index);
			this.skipWhitespace();
			if (!this.source.startsWith("=", this.index)) {
				// A bare attribute (HTML habit). Treat it as empty rather than failing
				// the whole document over it.
				attrs[attrName] = "";
				continue;
			}
			this.index += 1;
			this.skipWhitespace();
			attrs[attrName] = this.readAttributeValue(name);
		}
		const children = this.parseChildren(name);
		return element(name, attrs, children);
	}

	readName() {
		const match = /^[A-Za-z_:][A-Za-z0-9._:-]*/.exec(this.source.slice(this.index));
		if (!match) return null;
		this.index += match[0].length;
		return match[0];
	}

	readAttributeValue(elementName) {
		const quote = this.source[this.index];
		if (quote !== '"' && quote !== "'") {
			throw new XmlError(`Unquoted attribute value in <${elementName}>`, this.source, this.index);
		}
		const end = this.source.indexOf(quote, this.index + 1);
		if (end === -1) throw new XmlError(`Unterminated attribute value in <${elementName}>`, this.source, this.index);
		const raw = this.source.slice(this.index + 1, end);
		this.index = end + 1;
		return decodeEntities(raw);
	}

	parseChildren(parentName) {
		const children = [];
		for (;;) {
			if (this.index >= this.source.length) {
				throw new XmlError(`Unterminated <${parentName}>`, this.source, this.index);
			}
			if (this.source.startsWith("</", this.index)) {
				const close = this.source.indexOf(">", this.index);
				if (close === -1) throw new XmlError(`Unterminated closing tag for <${parentName}>`, this.source, this.index);
				const closing = this.source.slice(this.index + 2, close).trim();
				if (closing !== parentName) {
					throw new XmlError(`Closing </${closing}> does not match <${parentName}>`, this.source, this.index);
				}
				this.index = close + 1;
				return children;
			}
			if (this.source.startsWith("<!", this.index) || this.source.startsWith("<?", this.index)) {
				const node = this.parseMarkupDeclaration();
				if (node) children.push(node);
				continue;
			}
			if (this.source.startsWith("<", this.index)) {
				children.push(this.parseElement());
				continue;
			}
			const next = this.source.indexOf("<", this.index);
			const raw = this.source.slice(this.index, next === -1 ? this.source.length : next);
			this.index += raw.length;
			children.push(text(decodeEntities(raw)));
		}
	}
}

/** Serialize a node, or a `{ prolog, root }` document, back to XML. */
export function serializeXml(node, options = {}) {
	const indent = options.indent ?? "  ";
	if (node && node.root) {
		const prolog = node.prolog.map((item) => serializeNode(item, indent, 0)).join("\n");
		const body = serializeNode(node.root, indent, 0);
		return prolog ? `${prolog}\n${body}` : body;
	}
	return serializeNode(node, indent, 0);
}

/**
 * Whether an element's children must be written without added whitespace.
 *
 * Indentation inside an element whose text is content — a label, a compressed
 * page body — would change that content. Elements that hold only other elements
 * are indented, because a `.drawio` file nobody can read in an editor is a
 * worse artifact than a slightly larger one.
 */
function hasTextChild(node) {
	return node.children.some((child) => child.type === "text" && child.value.trim().length > 0);
}

function serializeNode(node, indent, depth) {
	const pad = indent.repeat(depth);
	switch (node.type) {
		case "text":
			return encodeText(node.value);
		case "cdata":
			return `<![CDATA[${node.value}]]>`;
		case "comment":
			return `${pad}<!--${node.value}-->`;
		case "pi":
			return `${pad}<?${node.value}?>`;
		default:
			break;
	}
	const attrs = Object.entries(node.attrs)
		.map(([name, value]) => ` ${name}="${encodeAttribute(value)}"`)
		.join("");
	const kids = node.children.filter((child) => !(child.type === "text" && child.value.trim().length === 0));
	if (kids.length === 0) return `${pad}<${node.name}${attrs} />`;
	if (hasTextChild(node)) {
		const inner = node.children.map((child) => serializeNode(child, "", 0)).join("");
		return `${pad}<${node.name}${attrs}>${inner}</${node.name}>`;
	}
	const inner = kids.map((child) => serializeNode(child, indent, depth + 1)).join("\n");
	return `${pad}<${node.name}${attrs}>\n${inner}\n${pad}</${node.name}>`;
}

/** Direct element children named `name`, or all element children when omitted. */
export function childElements(node, name) {
	if (!node || !node.children) return [];
	return node.children.filter((child) => child.type === "element" && (name === undefined || child.name === name));
}

/** The first descendant element named `name`, depth-first. */
export function findElement(node, name) {
	if (!node) return null;
	if (node.type === "element" && node.name === name) return node;
	for (const child of node.children ?? []) {
		const found = findElement(child, name);
		if (found) return found;
	}
	return null;
}

/** Every descendant element named `name`, depth-first. */
export function findElements(node, name, found = []) {
	if (!node) return found;
	if (node.type === "element" && node.name === name) found.push(node);
	for (const child of node.children ?? []) findElements(child, name, found);
	return found;
}

/** Concatenated text of an element, entities already decoded. */
export function textContent(node) {
	if (!node) return "";
	if (node.type === "text" || node.type === "cdata") return node.value;
	return (node.children ?? []).map(textContent).join("");
}
