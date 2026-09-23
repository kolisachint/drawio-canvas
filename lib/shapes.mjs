/**
 * draw.io's shape libraries, for the agent.
 *
 * The person has the libraries in the sidebar (and "+ More Shapes" for AWS,
 * Azure, GCP, Cisco, Kubernetes and the rest). The agent needs the same shapes,
 * and needs them *exactly*: an AWS icon is a style string like
 * `shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;fillColor=#ED7100;…`
 * that nobody reliably remembers, and a wrong key draws a grey box.
 *
 * `data/shapes-<version>.json.gz` is every library entry of the pinned draw.io,
 * recorded from draw.io itself by `scripts/build-shape-index.mjs`. The agent
 * searches it by name and inserts by id — the long style never has to pass
 * through its context window, which matters when some icons carry a 10 KB
 * embedded SVG.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { PINNED } from "./drawio-dist.mjs";
import { DiagramError } from "./model.mjs";
import { withStyleKey } from "./style.mjs";
import { childElements, encodeAttribute, findElement, parseXml, serializeXml } from "./xml.mjs";

const DATA_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "data");

/** Styles longer than this are left out of search results; insert by id instead. */
const INLINE_STYLE_CHARS = 400;

/**
 * Libraries superseded inside draw.io itself. Still searchable — old diagrams
 * use them — but ranked below the current set, so "lambda" finds the 2019+
 * AWS icon before the 2017 one.
 */
const LEGACY_GROUPS = new Map([
	["aws3", 0.6],
	["aws4b", 0.8],
	["aws4r", 0.5],
	["aws3d", 0.7],
	["azure", 0.6],
	["mscae", 0.8],
	["gcp", 0.6],
	["cisco", 0.7],
	["citrix", 0.7],
	["atlassian", 0.7],
	["archimate", 0.7],
	["uml", 0.8],
	["network", 0.8],
]);

/** Words that name a family of libraries rather than a shape. */
const VENDORS = new Set(["aws", "amazon", "azure", "gcp", "google", "cisco", "ibm", "sap", "kubernetes", "citrix", "salesforce", "atlassian", "veeam", "alibaba", "openstack"]);

let cached = null;

/** The index, loaded once. Throws a sentence when the file is missing. */
export function shapeIndex() {
	if (cached) return cached;
	const file = path.join(DATA_DIR, `shapes-${PINNED.version}.json.gz`);
	let raw;
	try {
		raw = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
	} catch (cause) {
		throw new DiagramError("no_shape_index", `The shape index ${path.basename(file)} could not be read: ${cause.message}`);
	}
	const libraries = raw.libraries;
	const shapes = raw.shapes.map(([id, library, title, kind, w, h, style, value, tags, data]) => {
		const lib = libraries[library];
		return {
			id,
			library: lib.title,
			group: lib.group,
			title,
			kind,
			w,
			h,
			style,
			value,
			data,
			haystack: `${title} ${tags ?? ""} ${lib.title} ${lib.id}`.toLowerCase(),
			titleLower: String(title).toLowerCase(),
		};
	});
	cached = { drawio: raw.drawio, libraries, shapes, byId: new Map(shapes.map((shape) => [shape.id, shape])) };
	return cached;
}

function tokens(text) {
	return String(text ?? "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/**
 * Search by words. Every word must appear somewhere (title, tags, library);
 * matches in the title rank highest, an exact title highest of all.
 */
export function searchShapes(query, { library, limit = 12 } = {}) {
	const index = shapeIndex();
	const words = tokens(query);
	if (words.length === 0) throw new DiagramError("empty_query", "search_shapes needs a query, e.g. \"aws lambda\" or \"gcp cloud run\".");
	const libraryFilter = library ? String(library).toLowerCase() : null;
	const scored = [];
	for (const shape of index.shapes) {
		if (libraryFilter && !shape.library.toLowerCase().includes(libraryFilter) && !String(shape.group ?? "").toLowerCase().includes(libraryFilter)) continue;
		if (!words.every((word) => shape.haystack.includes(word))) continue;
		const titleWords = tokens(shape.titleLower);
		// A word naming the library family ("aws", "gcp", "azure", "cisco") says
		// which of several same-named icons is meant; it is matched against the
		// library, not the title, and shapes from other families rank lower.
		const group = String(shape.group ?? "");
		const vendor = words.filter((word) => word.length >= 3 && group.startsWith(word));
		const rest = words.filter((word) => !vendor.includes(word));
		let score = 1;
		for (const word of rest) {
			if (titleWords.includes(word)) score += 4;
			else if (shape.titleLower.includes(word)) score += 2;
		}
		if (vendor.length > 0) score += 8;
		else if (words.some((word) => VENDORS.has(word))) score *= 0.5;
		if (rest.length > 0 && titleWords.join(" ") === rest.join(" ")) score += 10;
		// Fewer extra title words means a more specific match: "Lambda" beats
		// "Lambda Function" for the query "lambda".
		score -= Math.max(0, titleWords.length - rest.length) * 0.5;
		if (shape.kind === "template") score -= 1;
		score *= LEGACY_GROUPS.get(shape.group) ?? 1;
		scored.push({ shape, score });
	}
	scored.sort((a, b) => b.score - a.score || a.shape.titleLower.localeCompare(b.shape.titleLower));
	// An empty answer should say why: a library filter that names no library reads
	// to a model exactly like "no such shape", and it would give up on the shape.
	let note;
	if (scored.length === 0 && libraryFilter) {
		const libraries = new Set(index.shapes.filter((shape) => shape.library.toLowerCase().includes(libraryFilter) || String(shape.group ?? "").toLowerCase().includes(libraryFilter)).map((shape) => shape.library));
		note =
			libraries.size === 0
				? `No library matches "${library}". Leave library out, or use part of a library name such as "AWS / Compute", "gcp", "azure" or "kubernetes".`
				: `Nothing matched "${query}" in ${libraries.size} matching librar${libraries.size === 1 ? "y" : "ies"}; try fewer or other words, or leave library out.`;
	} else if (scored.length === 0) {
		note = `Nothing matched every word of "${query}". Try fewer words, or a vendor plus a service, e.g. "aws s3", "gcp bigquery".`;
	}
	return {
		...(note ? { note } : {}),
		drawio: index.drawio,
		total: scored.length,
		shapes: scored.slice(0, Math.max(1, Math.min(50, limit))).map(({ shape }) => ({
			id: shape.id,
			title: shape.title,
			library: shape.library,
			kind: shape.kind,
			width: shape.w,
			height: shape.h,
			...(shape.style && shape.style.length <= INLINE_STYLE_CHARS ? { style: shape.style } : {}),
		})),
	};
}

/** draw.io's `Graph.decompress`: base64 → raw deflate → URI-decode, or plain XML as is. */
export function decompressTemplate(data) {
	const text = String(data ?? "").trim();
	if (text.startsWith("<")) return text;
	const inflated = inflateRawSync(Buffer.from(text, "base64")).toString("utf8");
	try {
		return decodeURIComponent(inflated);
	} catch {
		return inflated;
	}
}

function geometryOf(cell) {
	return childElements(cell, "mxGeometry").find((geometry) => geometry.attrs.as === "geometry");
}

function innerOf(node) {
	return node.name === "mxCell" ? node : findElement(node, "mxCell");
}

/**
 * The cells to add for one library shape, as `{ cell_id, new_xml }` operations.
 *
 * A plain shape becomes one cell with the library's style and size (both
 * overridable). A template — draw.io's multi-cell entries, like a titled AWS
 * group or a UML class — becomes its cells with fresh ids derived from
 * `cell_id` (`<id>`, `<id>-2`, …), moved so its top-left sits at (x, y).
 */
export function shapeOperations(item, { usedIds = new Set(), parent = "1" } = {}) {
	const shape = shapeIndex().byId.get(String(item.shape_id ?? ""));
	if (!shape) throw new DiagramError("unknown_shape", `No shape "${item.shape_id}". Use search_shapes to find an id.`);
	const id = String(item.cell_id ?? "");
	if (!id) throw new DiagramError("missing_id", `insert_shapes needs a cell_id for "${item.shape_id}".`);
	const x = Number(item.x ?? 0);
	const y = Number(item.y ?? 0);
	const target = item.parent ?? parent;

	if (shape.kind !== "template") {
		let style = shape.style ?? "";
		for (const [key, value] of Object.entries(item.style ?? {})) style = withStyleKey(style, key, value);
		const width = Number(item.width ?? shape.w) || shape.w;
		const height = Number(item.height ?? shape.h) || shape.h;
		const label = item.label ?? shape.value ?? "";
		const edge = shape.kind === "edge";
		const geometry = edge
			? `<mxGeometry width="${width}" height="${height}" relative="1" as="geometry"><mxPoint x="${x}" y="${y + height}" as="sourcePoint"/><mxPoint x="${x + width}" y="${y}" as="targetPoint"/></mxGeometry>`
			: `<mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/>`;
		const terminals = edge ? `${item.source ? ` source="${encodeAttribute(item.source)}"` : ""}${item.target ? ` target="${encodeAttribute(item.target)}"` : ""}` : "";
		return [
			{
				operation: "add",
				cell_id: id,
				new_xml: `<mxCell id="${encodeAttribute(id)}" value="${encodeAttribute(label)}" style="${encodeAttribute(style)}" ${edge ? 'edge="1"' : 'vertex="1"'} parent="${encodeAttribute(target)}"${terminals}>${geometry}</mxCell>`,
			},
		];
	}

	const model = parseXml(decompressTemplate(shape.data)).root;
	const root = findElement(model, "root") ?? model;
	const nodes = childElements(root).filter((node) => {
		const cell = innerOf(node);
		const nodeId = node.attrs.id ?? cell?.attrs.id;
		return cell && nodeId !== "0" && !(nodeId === "1" && cell.attrs.parent === "0");
	});
	const rename = new Map();
	let n = 1;
	for (const node of nodes) {
		const old = node.attrs.id ?? innerOf(node).attrs.id;
		let fresh = n === 1 ? id : `${id}-${n}`;
		while (usedIds.has(fresh)) fresh = `${id}-${++n}`;
		rename.set(old, fresh);
		usedIds.add(fresh);
		n += 1;
	}
	const tops = nodes.filter((node) => !rename.has(innerOf(node).attrs.parent));
	const left = Math.min(...tops.map((node) => Number(geometryOf(innerOf(node))?.attrs.x ?? 0)));
	const top = Math.min(...tops.map((node) => Number(geometryOf(innerOf(node))?.attrs.y ?? 0)));
	return nodes.map((node) => {
		const cell = innerOf(node);
		const oldId = node.attrs.id ?? cell.attrs.id;
		const fresh = rename.get(oldId);
		if (node.attrs.id !== undefined) node.attrs.id = fresh;
		else cell.attrs.id = fresh;
		for (const attribute of ["parent", "source", "target"]) {
			if (cell.attrs[attribute] && rename.has(cell.attrs[attribute])) cell.attrs[attribute] = rename.get(cell.attrs[attribute]);
		}
		if (!rename.has(cell.attrs.parent)) {
			cell.attrs.parent = target;
			const geometry = geometryOf(cell);
			if (geometry && geometry.attrs.relative !== "1") {
				geometry.attrs.x = String(Number(geometry.attrs.x ?? 0) - left + x);
				geometry.attrs.y = String(Number(geometry.attrs.y ?? 0) - top + y);
			}
		}
		if (tops[0] === node && item.label !== undefined) {
			if (node !== cell) node.attrs.label = String(item.label);
			else cell.attrs.value = String(item.label);
		}
		return { operation: "add", cell_id: fresh, new_xml: serializeXml(node) };
	});
}
