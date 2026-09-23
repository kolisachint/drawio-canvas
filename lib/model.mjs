/**
 * The document model: an `.drawio` file as something two operators can edit.
 *
 * This module is shared, byte for byte, between the extension process and the
 * page in the browser. That is deliberate and it is the main structural
 * decision in this canvas: the agent's edits and the person's edits go through
 * the same parser, the same mutation helpers and the same serializer, so the
 * two halves cannot disagree about what the document is. A canvas where the
 * server understood a slightly different document than the page would lose
 * someone's work, and the loss would look like a rendering bug.
 *
 * Shapes handled here, in mxGraph's own terms:
 *
 *   mxfile > diagram (a page) > mxGraphModel > root > mxCell*
 *
 * Cells `0` and `1` are mxGraph's root sentinels — `0` is the model root and
 * `1` the default layer, and every ordinary cell descends from `1`. They are
 * reserved: the helpers here refuse to delete them and never hand them out as
 * new ids.
 *
 * Nothing here knows about HTTP, the filesystem, or compression. A compressed
 * page is *detected* (see {@link isCompressedPage}) but not inflated, because
 * inflation needs `node:zlib` and this file has to load in a browser too.
 */

import { childElements, element, findElement, parseXml, serializeXml, textContent, XmlError } from "./xml.mjs";

/** mxGraph's model root. Never a drawable cell. */
export const ROOT_CELL_ID = "0";
/** mxGraph's default layer. The parent of an ordinary cell. */
export const DEFAULT_LAYER_ID = "1";

/** An empty single-page document, used when a canvas opens with nothing to show. */
export function blankDocumentXml(pageName = "Page-1") {
	return [
		'<mxfile host="hoocode-drawio-canvas">',
		`  <diagram id="${randomId(20)}" name="${pageName}">`,
		'    <mxGraphModel dx="1422" dy="794" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">',
		"      <root>",
		'        <mxCell id="0" />',
		'        <mxCell id="1" parent="0" />',
		"      </root>",
		"    </mxGraphModel>",
		"  </diagram>",
		"</mxfile>",
	].join("\n");
}

/** Ids in draw.io's own shape: URL-safe, unguessable, and stable once written. */
export function randomId(length = 20) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	let out = "";
	const random =
		typeof globalThis.crypto?.getRandomValues === "function"
			? globalThis.crypto.getRandomValues(new Uint8Array(length))
			: Array.from({ length }, () => Math.floor(Math.random() * 256));
	for (let i = 0; i < length; i += 1) out += alphabet[random[i] % alphabet.length];
	return out;
}

/** Raised for input that parses as XML but is not a diagram we can work with. */
export class DiagramError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "DiagramError";
		this.code = code;
	}
}

/**
 * Wrap looser input into a full `<mxfile>`.
 *
 * Three shapes arrive in practice and all three are accepted, because refusing
 * two of them would only mean the agent learning to wrap by hand:
 *
 *  - a whole `<mxfile>` — a real file, used as is;
 *  - a bare `<mxGraphModel>` — one page's worth, which is what most models emit
 *    when asked for "a diagram";
 *  - bare `<mxCell>` siblings — the fragment style the draw.io XML guides teach,
 *    with the root sentinels left implicit.
 */
export function normalizeToMxfileXml(xml, pageName = "Page-1") {
	const trimmed = String(xml ?? "").trim();
	if (trimmed.length === 0) throw new DiagramError("empty_xml", "The diagram XML is empty.");
	if (/^<\?xml[\s\S]*?\?>\s*<mxfile/i.test(trimmed) || /^<mxfile/i.test(trimmed)) return trimmed;
	if (/^<mxGraphModel/i.test(trimmed)) {
		return `<mxfile host="hoocode-drawio-canvas"><diagram id="${randomId(20)}" name="${pageName}">${trimmed}</diagram></mxfile>`;
	}
	if (/^<(mxCell|UserObject|object)\b/i.test(trimmed)) {
		const hasSentinels = /<mxCell[^>]*\bid="0"/.test(trimmed);
		const sentinels = hasSentinels ? "" : '<mxCell id="0" /><mxCell id="1" parent="0" />';
		return (
			`<mxfile host="hoocode-drawio-canvas"><diagram id="${randomId(20)}" name="${pageName}">` +
			`<mxGraphModel><root>${sentinels}${trimmed}</root></mxGraphModel></diagram></mxfile>`
		);
	}
	throw new DiagramError(
		"unrecognized_xml",
		"Expected <mxfile>, <mxGraphModel>, or a list of <mxCell> elements. " +
			`Received XML starting with ${trimmed.slice(0, 40)}...`,
	);
}

/** Whether a `<diagram>` holds draw.io's compressed body rather than plain XML. */
export function isCompressedPage(diagramElement) {
	if (findElement(diagramElement, "mxGraphModel")) return false;
	return textContent(diagramElement).trim().length > 0;
}

/** One page of a document, as the rest of the canvas talks about it. */
class Page {
	constructor(doc, diagramElement, index) {
		this.doc = doc;
		this.element = diagramElement;
		this.index = index;
	}

	get id() {
		return this.element.attrs.id ?? "";
	}

	get name() {
		return this.element.attrs.name ?? `Page-${this.index + 1}`;
	}

	set name(value) {
		this.element.attrs.name = value;
	}

	get compressed() {
		return isCompressedPage(this.element);
	}

	/** The `<mxGraphModel>`, created on demand so an empty page is still editable. */
	get model() {
		let model = findElement(this.element, "mxGraphModel");
		if (!model) {
			model = element("mxGraphModel", {}, [element("root", {}, [])]);
			this.element.children = [model];
		}
		return model;
	}

	/** The `<root>`, with mxGraph's two sentinel cells guaranteed present. */
	get root() {
		const model = this.model;
		let root = findElement(model, "root");
		if (!root) {
			root = element("root", {}, []);
			model.children.push(root);
		}
		const ids = new Set(childElements(root, "mxCell").map((cell) => cell.attrs.id));
		if (!ids.has(ROOT_CELL_ID)) root.children.unshift(element("mxCell", { id: ROOT_CELL_ID }, []));
		if (!ids.has(DEFAULT_LAYER_ID)) {
			root.children.splice(1, 0, element("mxCell", { id: DEFAULT_LAYER_ID, parent: ROOT_CELL_ID }, []));
		}
		return root;
	}

	/**
	 * Every cell on the page, including the ones wrapped in `<UserObject>` or
	 * `<object>`.
	 *
	 * draw.io wraps a cell that carries custom attributes, and the wrapper holds
	 * the id and the label while the inner `<mxCell>` holds the geometry. Callers
	 * want one thing per cell, so each entry names both: `node` is what to remove
	 * or replace, `cell` is what to read geometry from.
	 */
	cells() {
		const found = [];
		for (const child of childElements(this.root)) {
			if (child.name === "mxCell") {
				found.push({ node: child, cell: child });
				continue;
			}
			const inner = findElement(child, "mxCell");
			if (inner) found.push({ node: child, cell: inner });
		}
		return found;
	}

	/** One cell by id, or null. The id lives on the wrapper when there is one. */
	find(id) {
		return this.cells().find((entry) => cellId(entry) === String(id)) ?? null;
	}

	/** Cells a person or the agent can select: everything but the two sentinels. */
	drawable() {
		return this.cells().filter((entry) => {
			const id = cellId(entry);
			return id !== ROOT_CELL_ID && id !== DEFAULT_LAYER_ID;
		});
	}
}

/** The id of a cell entry, read from the wrapper when the cell has one. */
export function cellId(entry) {
	return entry.node.attrs.id ?? entry.cell.attrs.id ?? "";
}

/** The label of a cell entry: `<UserObject label>` wins over `<mxCell value>`. */
export function cellLabel(entry) {
	return entry.node.attrs.label ?? entry.node.attrs.value ?? entry.cell.attrs.value ?? "";
}

/** Read a cell's geometry as numbers, with mxGraph's defaults filled in. */
export function cellGeometry(entry) {
	const geometry = childElements(entry.cell, "mxGeometry").find((geo) => geo.attrs.as === "geometry");
	const read = (name, fallback) => {
		const value = Number.parseFloat(geometry?.attrs[name]);
		return Number.isFinite(value) ? value : fallback;
	};
	const points = [];
	for (const array of childElements(geometry ?? { children: [] }, "Array")) {
		if (array.attrs.as !== "points") continue;
		for (const point of childElements(array, "mxPoint")) {
			points.push({ x: Number.parseFloat(point.attrs.x) || 0, y: Number.parseFloat(point.attrs.y) || 0 });
		}
	}
	const endpoint = (as) => {
		const point = childElements(geometry ?? { children: [] }, "mxPoint").find((item) => item.attrs.as === as);
		return point ? { x: Number.parseFloat(point.attrs.x) || 0, y: Number.parseFloat(point.attrs.y) || 0 } : null;
	};
	return {
		x: read("x", 0),
		y: read("y", 0),
		width: read("width", 0),
		height: read("height", 0),
		relative: geometry?.attrs.relative === "1",
		points,
		sourcePoint: endpoint("sourcePoint"),
		targetPoint: endpoint("targetPoint"),
	};
}

/** The `<mxGeometry as="geometry">` of a cell, created if the cell had none. */
export function ensureGeometry(entry) {
	let geometry = childElements(entry.cell, "mxGeometry").find((geo) => geo.attrs.as === "geometry");
	if (!geometry) {
		geometry = element("mxGeometry", { as: "geometry" }, []);
		entry.cell.children.push(geometry);
	}
	return geometry;
}

/** Write position and size onto a cell, rounding to whole units as draw.io does. */
export function setCellGeometry(entry, box) {
	const geometry = ensureGeometry(entry);
	for (const [key, value] of Object.entries(box)) {
		if (value === undefined) continue;
		geometry.attrs[key] = String(Math.round(value * 100) / 100);
	}
	return geometry;
}

/** Whether a cell is a vertex (a shape) rather than an edge or a layer. */
export function isVertex(entry) {
	return entry.cell.attrs.vertex === "1";
}

/** Whether a cell is an edge (a connector). */
export function isEdge(entry) {
	return entry.cell.attrs.edge === "1";
}

/**
 * A parsed `.drawio` document.
 *
 * Mutation is in place on the parsed tree, so anything the parser did not
 * understand survives every edit: this canvas can open a file full of shapes it
 * cannot draw, let someone move one box, and write the file back with
 * everything else exactly as its author left it.
 */
export class DrawioDocument {
	constructor(document) {
		this.document = document;
	}

	/** Parse XML in any of the three accepted shapes. Throws `XmlError`/`DiagramError`. */
	static parse(xml, pageName = "Page-1") {
		const parsed = parseXml(normalizeToMxfileXml(xml, pageName));
		if (parsed.root.name !== "mxfile") {
			throw new DiagramError("unrecognized_xml", `Expected an <mxfile> root, found <${parsed.root.name}>.`);
		}
		return new DrawioDocument(parsed);
	}

	/** A new, empty document. */
	static blank(pageName = "Page-1") {
		return DrawioDocument.parse(blankDocumentXml(pageName));
	}

	get root() {
		return this.document.root;
	}

	pages() {
		return childElements(this.root, "diagram").map((diagram, index) => new Page(this, diagram, index));
	}

	/**
	 * Resolve a page selector: by id, then name, then index, and the first page
	 * when nothing is given.
	 *
	 * One order, used everywhere, because the agent has to learn it once. Returns
	 * null rather than throwing so callers can say which selector missed.
	 */
	page(selector = {}) {
		const pages = this.pages();
		if (pages.length === 0) return null;
		if (selector.page_id) return pages.find((page) => page.id === selector.page_id) ?? null;
		if (selector.page_name) return pages.find((page) => page.name === selector.page_name) ?? null;
		if (selector.page_index !== undefined && selector.page_index !== null) {
			return pages[selector.page_index] ?? null;
		}
		return pages[0];
	}

	/** Append a page, returning it. */
	addPage(name, xml) {
		const diagram = element("diagram", { id: randomId(20), name: name ?? `Page-${this.pages().length + 1}` }, []);
		if (xml) {
			const inner = parseXml(/^<mxGraphModel/i.test(xml.trim()) ? xml : `<mxGraphModel><root>${xml}</root></mxGraphModel>`);
			diagram.children.push(inner.root);
		} else {
			diagram.children.push(
				element("mxGraphModel", {}, [
					element("root", {}, [element("mxCell", { id: ROOT_CELL_ID }, []), element("mxCell", { id: DEFAULT_LAYER_ID, parent: ROOT_CELL_ID }, [])]),
				]),
			);
		}
		this.root.children.push(diagram);
		const pages = this.pages();
		return pages[pages.length - 1];
	}

	/** Remove a page. The last page is never removed: a document needs one. */
	deletePage(page) {
		if (this.pages().length <= 1) {
			throw new DiagramError("last_page", "A document must keep at least one page.");
		}
		this.root.children = this.root.children.filter((child) => child !== page.element);
	}

	/** Every cell id in the document, so a new one can be made unique across pages. */
	allIds() {
		const ids = new Set();
		for (const page of this.pages()) {
			if (page.compressed) continue;
			for (const entry of page.cells()) ids.add(cellId(entry));
		}
		return ids;
	}

	/** An id no cell in the document uses, prefixed so it reads as this canvas's. */
	newCellId(prefix = "c") {
		const ids = this.allIds();
		for (let n = 1; ; n += 1) {
			const candidate = `${prefix}${n}`;
			if (!ids.has(candidate)) return candidate;
		}
	}

	toXml() {
		return serializeXml(this.document);
	}

	/**
	 * A fingerprint of what a person can actually change.
	 *
	 * Used by the edit gate. Byte comparison is useless here: every save rewrites
	 * attribute order and whitespace, and the browser rewrites viewport
	 * attributes (`dx`, `dy`, `pageWidth`) that are not content. So the
	 * fingerprint keeps page names and each page's cell tree — tag, sorted
	 * attributes, text — and nothing else.
	 */
	fingerprint() {
		return this.pages()
			.map((page) => `${page.name}=${page.compressed ? textContent(page.element).trim() : canonicalize(page.root)}`)
			.join("\n");
	}
}

function canonicalize(node) {
	if (node.type === "text" || node.type === "cdata") {
		const value = node.value.trim();
		return value.length > 0 ? JSON.stringify(value) : "";
	}
	if (node.type !== "element") return "";
	const attrs = Object.entries(node.attrs)
		.map(([name, value]) => `${name}=${JSON.stringify(value)}`)
		.sort()
		.join(" ");
	return `<${node.name} ${attrs}>${(node.children ?? []).map(canonicalize).join("")}</${node.name}>`;
}

/**
 * Apply the agent's id-addressed operations to one page.
 *
 * Each operation is reported on individually and the rest still run: a batch
 * where one cell id was wrong should not silently drop the other nine edits,
 * and the agent needs to be told which one missed so it can fix that one.
 *
 * `delete` takes the cell's descendants and its attached edges with it, which is
 * what draw.io does and what anyone watching expects — an edge left hanging off
 * a deleted box is a worse surprise than the edge disappearing.
 */
export function applyOperations(doc, selector, operations) {
	const page = doc.page(selector);
	if (!page) throw new DiagramError("page_not_found", `No page matches ${JSON.stringify(selector)}.`);
	if (page.compressed) {
		throw new DiagramError("compressed_page", `Page "${page.name}" is stored compressed and was not decoded.`);
	}
	const applied = [];
	const errors = [];
	for (const operation of operations) {
		const id = String(operation.cell_id ?? "");
		try {
			switch (operation.operation) {
				case "add":
					applied.push(addCell(page, id, operation.new_xml));
					break;
				case "update":
					applied.push(updateCell(page, id, operation.new_xml));
					break;
				case "delete":
					applied.push(deleteCell(page, id));
					break;
				default:
					throw new DiagramError("unknown_operation", `Unknown operation "${operation.operation}".`);
			}
		} catch (cause) {
			errors.push({ operation: operation.operation, cell_id: id, message: cause.message });
		}
	}
	return { page, applied, errors };
}

function parseCellFragment(xml, id) {
	if (!xml || String(xml).trim().length === 0) {
		throw new DiagramError("missing_xml", `Operation on "${id}" needs new_xml.`);
	}
	let parsed;
	try {
		parsed = parseXml(String(xml).trim());
	} catch (cause) {
		// Almost always a label with raw markup or quotes in it: say how to write one.
		if (cause instanceof XmlError && /attribute|quote|&|entity/i.test(cause.message)) {
			throw new DiagramError(
				"invalid_xml",
				`${cause.message}. Inside attribute values write < > & " as &lt; &gt; &amp; &quot; (an HTML label like <b>x</b> is value="&lt;b&gt;x&lt;/b&gt;" with html=1 in the style).`,
			);
		}
		throw cause;
	}
	const node = parsed.root;
	if (node.name !== "mxCell" && node.name !== "UserObject" && node.name !== "object") {
		throw new DiagramError("not_a_cell", `new_xml must be one <mxCell>, <UserObject> or <object>, found <${node.name}>.`);
	}
	if (node.name === "mxCell" && findElement({ children: node.children }, "mxCell")) {
		// Nesting is the single most common malformed-diagram shape a model emits,
		// and mxGraph renders the result as an empty page rather than complaining.
		throw new DiagramError("nested_cell", "mxCell elements must be siblings; do not nest one inside another.");
	}
	return node;
}

function withoutId(attrs) {
	const { id: _ignored, ...rest } = attrs;
	return rest;
}

/**
 * A cell's parent must be a cell on the same page (a layer, a container or a
 * group), and not the cell itself. mxGraph cannot place a cell under a parent it
 * does not have: the cell vanishes from the person's editor, or the merge fails.
 */
function checkParent(page, id, parent) {
	if (parent === id) throw new DiagramError("invalid_parent", `Cell "${id}" cannot be its own parent.`);
	if (!page.find(parent)) {
		const layers = page.cells().filter((entry) => entry.cell.attrs.parent === ROOT_CELL_ID).map(cellId);
		throw new DiagramError(
			"invalid_parent",
			`Parent "${parent}" is not a cell on page "${page.name}". Use a layer (${layers.map((layer) => `"${layer}"`).join(", ") || `"${DEFAULT_LAYER_ID}"`}), or a container or group already on the page; omit parent for the default layer.`,
		);
	}
}

function addCell(page, id, xml) {
	const node = parseCellFragment(xml, id);
	const wanted = id || node.attrs.id;
	if (!wanted) throw new DiagramError("missing_id", "An added cell needs a cell_id.");
	if (page.doc.allIds().has(wanted)) throw new DiagramError("duplicate_id", `Cell "${wanted}" already exists.`);
	// id first, the way draw.io writes it: the file is read by people too.
	node.attrs = { id: wanted, ...withoutId(node.attrs) };
	const inner = node.name === "mxCell" ? node : findElement(node, "mxCell");
	if (!inner) throw new DiagramError("not_a_cell", `<${node.name}> for "${wanted}" contains no <mxCell>.`);
	if (node !== inner) delete inner.attrs.id;
	if (!inner.attrs.parent) inner.attrs.parent = DEFAULT_LAYER_ID;
	checkParent(page, wanted, inner.attrs.parent);
	page.root.children.push(node);
	return { operation: "add", cell_id: wanted };
}

function updateCell(page, id, xml) {
	const entry = page.find(id);
	if (!entry) throw new DiagramError("unknown_cell", `Page "${page.name}" has no cell "${id}".`);
	const node = parseCellFragment(xml, id);
	node.attrs = { id, ...withoutId(node.attrs) };
	const inner = node.name === "mxCell" ? node : findElement(node, "mxCell");
	if (!inner) throw new DiagramError("not_a_cell", `<${node.name}> for "${id}" contains no <mxCell>.`);
	if (node !== inner) delete inner.attrs.id;
	if (!inner.attrs.parent) inner.attrs.parent = entry.cell.attrs.parent ?? DEFAULT_LAYER_ID;
	checkParent(page, id, inner.attrs.parent);
	page.root.children = page.root.children.map((child) => (child === entry.node ? node : child));
	return { operation: "update", cell_id: id };
}

function deleteCell(page, id) {
	if (id === ROOT_CELL_ID || id === DEFAULT_LAYER_ID) {
		throw new DiagramError("reserved_cell", `Cell "${id}" is an mxGraph root sentinel and cannot be deleted.`);
	}
	const entry = page.find(id);
	if (!entry) throw new DiagramError("unknown_cell", `Page "${page.name}" has no cell "${id}".`);
	const doomed = new Set([id]);
	// Descendants first, transitively: a swimlane takes its contents with it.
	for (let grew = true; grew; ) {
		grew = false;
		for (const candidate of page.cells()) {
			const parent = candidate.cell.attrs.parent;
			if (parent && doomed.has(parent) && !doomed.has(cellId(candidate))) {
				doomed.add(cellId(candidate));
				grew = true;
			}
		}
	}
	const removedEdges = [];
	for (const candidate of page.cells()) {
		if (!isEdge(candidate)) continue;
		const { source, target } = candidate.cell.attrs;
		if ((source && doomed.has(source)) || (target && doomed.has(target))) {
			doomed.add(cellId(candidate));
			removedEdges.push(cellId(candidate));
		}
	}
	page.root.children = page.root.children.filter((child) => {
		if (child.type !== "element") return true;
		const inner = child.name === "mxCell" ? child : findElement(child, "mxCell");
		if (!inner) return true;
		return !doomed.has(child.attrs.id ?? inner.attrs.id ?? "");
	});
	return { operation: "delete", cell_id: id, also_removed: [...doomed].filter((other) => other !== id) };
}

/**
 * Problems worth telling someone about, found without rendering.
 *
 * Not a schema check. These are the four mistakes that make a diagram open
 * blank or half-drawn in draw.io itself, which is the failure that wastes the
 * most time because the file looks fine in a text editor.
 */
export function validateDocument(doc) {
	const issues = [];
	for (const page of doc.pages()) {
		if (page.compressed) continue;
		const ids = new Map();
		for (const entry of page.cells()) {
			const id = cellId(entry);
			if (id.length === 0) {
				issues.push({ page: page.name, severity: "error", message: "A cell has no id." });
				continue;
			}
			if (ids.has(id)) issues.push({ page: page.name, severity: "error", message: `Duplicate cell id "${id}".` });
			ids.set(id, entry);
			if (findElement({ children: entry.cell.children }, "mxCell")) {
				issues.push({ page: page.name, severity: "error", message: `Cell "${id}" nests another mxCell; cells must be siblings.` });
			}
		}
		for (const entry of page.cells()) {
			const id = cellId(entry);
			const { parent, source, target } = entry.cell.attrs;
			if (parent && !ids.has(parent)) {
				issues.push({ page: page.name, severity: "error", message: `Cell "${id}" has parent "${parent}", which does not exist.` });
			}
			if (source && !ids.has(source)) {
				issues.push({ page: page.name, severity: "warning", message: `Edge "${id}" points at missing source "${source}".` });
			}
			if (target && !ids.has(target)) {
				issues.push({ page: page.name, severity: "warning", message: `Edge "${id}" points at missing target "${target}".` });
			}
			if (isVertex(entry)) {
				const geometry = cellGeometry(entry);
				if (geometry.width <= 0 || geometry.height <= 0) {
					issues.push({ page: page.name, severity: "warning", message: `Shape "${id}" has no size and will not be visible.` });
				}
			}
		}
	}
	return issues;
}

/** A one-line summary of a page, for an action result the model has to read. */
export function summarizePage(page) {
	if (page.compressed) return { id: page.id, name: page.name, index: page.index, compressed: true };
	const cells = page.drawable();
	return {
		id: page.id,
		name: page.name,
		index: page.index,
		shapes: cells.filter(isVertex).length,
		edges: cells.filter(isEdge).length,
	};
}

export { Page };
