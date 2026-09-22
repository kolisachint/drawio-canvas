/**
 * Draw a page as SVG.
 *
 * A pure function from the document model to an SVG string — no DOM, no
 * measurement, no browser. That is what lets one renderer serve three callers
 * that would otherwise each need their own: the page in the browser injects the
 * string and hangs interaction on it, `save_file` writes the same string to a
 * `.svg`, and the history strip renders thumbnails of versions nobody is
 * looking at.
 *
 * What this is not: draw.io. draw.io ships thousands of stencils, and matching
 * it is not on the table for a file with no dependencies. The bargain here is
 * explicit and worth stating, because it decides what this canvas is safe to
 * point at:
 *
 *   **Rendering degrades; the document does not.** A shape this file has no
 *   drawing for comes out as a labelled rectangle in its own colors, at its own
 *   size and position. Its style string, its custom attributes and its
 *   relationships survive every edit untouched (see `model.mjs`), so the file
 *   still opens in draw.io exactly as its author left it.
 *
 * The shapes below are the ones that actually turn up in diagrams an agent and a
 * person build together — flowcharts, architecture sketches, sequence-ish
 * boxes-and-arrows. That is where the fidelity budget goes.
 */

import { cellGeometry, cellId, cellLabel, isEdge, isVertex } from "./model.mjs";
import { parseStyle, shapeOf, styleColor, styleFlag, styleNumber } from "./style.mjs";

/** Colors used when a cell's style names none. draw.io's own defaults. */
const DEFAULT_FILL = "#ffffff";
const DEFAULT_STROKE = "#000000";
const DEFAULT_FONT_COLOR = "#000000";
const DEFAULT_FONT_SIZE = 12;
const DEFAULT_FONT_FAMILY = "Helvetica, Arial, sans-serif";

/**
 * Average glyph width as a fraction of font size, used to wrap labels.
 *
 * Wrapping needs text metrics and there are none here: this module runs where
 * there is no DOM, and it has to produce the same output on the server and in
 * the page. A measured browser wrap and an estimated server wrap would disagree
 * about line count, which is exactly the kind of "the thumbnail does not match
 * the canvas" bug that erodes trust in what is on screen. So both estimate, and
 * both are wrong in the same direction.
 */
const GLYPH_WIDTH_RATIO = 0.55;

const escapeXml = (value) =>
	String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

/**
 * Turn a cell's label into plain lines.
 *
 * With `html=1` — which draw.io sets on almost everything — the label is a
 * fragment of HTML. Rendering it properly would mean a layout engine; rendering
 * it raw would put `<div>` on the canvas. Block tags become line breaks,
 * everything else is dropped, and the text is what is left.
 */
export function labelLines(raw) {
	const withBreaks = String(raw ?? "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<li[^>]*>/gi, "\n• ")
		// Block tags break the line at both ends: draw.io writes a new line as
		// `<div>text</div>`, so breaking only on the closing tag would run two lines
		// together. Consecutive breaks then collapse, because the markup routinely
		// produces them and nobody typed a blank line.
		.replace(/<\/?(p|div|li|h[1-6])[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/\n{2,}/g, "\n");
	const decoded = withBreaks
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&");
	return decoded.split("\n");
}

/** Wrap `lines` to `width` at `fontSize`, estimating glyph width. */
export function wrapLines(lines, width, fontSize, wrap = true) {
	if (!wrap || width <= 0) return lines;
	const perLine = Math.max(1, Math.floor(width / (fontSize * GLYPH_WIDTH_RATIO)));
	const out = [];
	for (const line of lines) {
		if (line.length <= perLine) {
			out.push(line);
			continue;
		}
		let current = "";
		for (const word of line.split(/\s+/)) {
			if (current.length === 0) {
				current = word;
			} else if (`${current} ${word}`.length <= perLine) {
				current = `${current} ${word}`;
			} else {
				out.push(current);
				current = word;
			}
			// A single word longer than the line still has to break somewhere.
			while (current.length > perLine) {
				out.push(current.slice(0, perLine));
				current = current.slice(perLine);
			}
		}
		if (current.length > 0) out.push(current);
	}
	return out;
}

/**
 * Absolute geometry for every drawable cell on a page.
 *
 * mxGraph stores a child's geometry relative to its parent, so a box inside a
 * swimlane inside a group has to walk the chain to know where it is. Done once
 * here and handed to everything else, because the renderer, hit-testing and
 * edge routing all need the same answer.
 */
export function layoutPage(page) {
	const entries = new Map();
	for (const entry of page.cells()) entries.set(cellId(entry), entry);
	const boxes = new Map();

	const resolve = (id, seen = new Set()) => {
		if (boxes.has(id)) return boxes.get(id);
		const entry = entries.get(id);
		if (!entry || seen.has(id)) return null;
		seen.add(id);
		const geometry = cellGeometry(entry);
		const parentId = entry.cell.attrs.parent;
		let origin = { x: 0, y: 0 };
		if (parentId && parentId !== "0" && parentId !== "1") {
			const parent = resolve(parentId, seen);
			if (parent) origin = { x: parent.x, y: parent.y };
		}
		const box = {
			x: origin.x + geometry.x,
			y: origin.y + geometry.y,
			width: geometry.width,
			height: geometry.height,
			geometry,
			entry,
		};
		boxes.set(id, box);
		return box;
	};

	for (const id of entries.keys()) resolve(id);
	return boxes;
}

/** The bounding box of everything drawable, with a margin. Empty pages get a page-sized box. */
export function pageBounds(page, boxes, margin = 20) {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const include = (x, y) => {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	};
	for (const entry of page.drawable()) {
		const box = boxes.get(cellId(entry));
		if (!box) continue;
		if (isVertex(entry) && box.width > 0 && box.height > 0) {
			include(box.x, box.y);
			include(box.x + box.width, box.y + box.height);
		}
		for (const point of box.geometry.points) include(point.x, point.y);
		for (const point of [box.geometry.sourcePoint, box.geometry.targetPoint]) {
			if (point) include(point.x, point.y);
		}
	}
	if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 850, height: 550 };
	return {
		x: minX - margin,
		y: minY - margin,
		width: Math.max(1, maxX - minX + margin * 2),
		height: Math.max(1, maxY - minY + margin * 2),
	};
}

/** The path data for a vertex shape, in absolute coordinates. */
function shapePath(shape, box, parsed) {
	const { x, y, width: w, height: h } = box;
	const point = (px, py) => `${round(px)},${round(py)}`;
	switch (shape) {
		case "ellipse":
			return null; // drawn as <ellipse>, which is exact where a path would approximate
		case "rhombus":
			return `M ${point(x + w / 2, y)} L ${point(x + w, y + h / 2)} L ${point(x + w / 2, y + h)} L ${point(x, y + h / 2)} Z`;
		case "triangle":
			return `M ${point(x, y)} L ${point(x + w, y + h / 2)} L ${point(x, y + h)} Z`;
		case "hexagon": {
			const inset = Math.min(w * 0.25, h / 2);
			return `M ${point(x + inset, y)} L ${point(x + w - inset, y)} L ${point(x + w, y + h / 2)} L ${point(x + w - inset, y + h)} L ${point(x + inset, y + h)} L ${point(x, y + h / 2)} Z`;
		}
		case "parallelogram": {
			const skew = Math.min(w * 0.2, 30);
			return `M ${point(x + skew, y)} L ${point(x + w, y)} L ${point(x + w - skew, y + h)} L ${point(x, y + h)} Z`;
		}
		case "trapezoid": {
			const skew = Math.min(w * 0.2, 30);
			return `M ${point(x, y + h)} L ${point(x + skew, y)} L ${point(x + w - skew, y)} L ${point(x + w, y + h)} Z`;
		}
		case "step": {
			const notch = Math.min(w * 0.2, 25);
			return `M ${point(x, y)} L ${point(x + w - notch, y)} L ${point(x + w, y + h / 2)} L ${point(x + w - notch, y + h)} L ${point(x, y + h)} L ${point(x + notch, y + h / 2)} Z`;
		}
		case "process": {
			const inset = Math.min(w * 0.15, 20);
			return (
				`M ${point(x, y)} L ${point(x + w, y)} L ${point(x + w, y + h)} L ${point(x, y + h)} Z ` +
				`M ${point(x + inset, y)} L ${point(x + inset, y + h)} M ${point(x + w - inset, y)} L ${point(x + w - inset, y + h)}`
			);
		}
		case "document": {
			const wave = h * 0.2;
			return (
				`M ${point(x, y)} L ${point(x + w, y)} L ${point(x + w, y + h - wave)} ` +
				`C ${point(x + w * 0.75, y + h - wave * 2)} ${point(x + w * 0.25, y + h)} ${point(x, y + h - wave)} Z`
			);
		}
		case "note": {
			const fold = Math.min(w, h) * 0.25;
			return `M ${point(x, y)} L ${point(x + w - fold, y)} L ${point(x + w, y + fold)} L ${point(x + w, y + h)} L ${point(x, y + h)} Z M ${point(x + w - fold, y)} L ${point(x + w - fold, y + fold)} L ${point(x + w, y + fold)}`;
		}
		case "card": {
			const cut = Math.min(w, h) * 0.2;
			return `M ${point(x + cut, y)} L ${point(x + w, y)} L ${point(x + w, y + h)} L ${point(x, y + h)} L ${point(x, y + cut)} Z`;
		}
		case "cylinder": {
			const lip = Math.min(h * 0.18, 20);
			return (
				`M ${point(x, y + lip)} C ${point(x, y)} ${point(x + w, y)} ${point(x + w, y + lip)} ` +
				`L ${point(x + w, y + h - lip)} C ${point(x + w, y + h)} ${point(x, y + h)} ${point(x, y + h - lip)} Z ` +
				`M ${point(x, y + lip)} C ${point(x, y + lip * 2)} ${point(x + w, y + lip * 2)} ${point(x + w, y + lip)}`
			);
		}
		case "cloud":
			return (
				`M ${point(x + w * 0.25, y + h * 0.9)} C ${point(x - w * 0.05, y + h * 0.9)} ${point(x - w * 0.05, y + h * 0.45)} ${point(x + w * 0.2, y + h * 0.42)} ` +
				`C ${point(x + w * 0.2, y + h * 0.05)} ${point(x + w * 0.62, y - h * 0.05)} ${point(x + w * 0.68, y + h * 0.3)} ` +
				`C ${point(x + w * 1.0, y + h * 0.25)} ${point(x + w * 1.05, y + h * 0.8)} ${point(x + w * 0.78, y + h * 0.9)} Z`
			);
		case "actor": {
			const head = Math.min(w, h) * 0.22;
			const cx = x + w / 2;
			return (
				`M ${point(cx, y + head * 2)} L ${point(cx, y + h * 0.65)} ` +
				`M ${point(x + w * 0.15, y + h * 0.4)} L ${point(x + w * 0.85, y + h * 0.4)} ` +
				`M ${point(cx, y + h * 0.65)} L ${point(x + w * 0.2, y + h)} ` +
				`M ${point(cx, y + h * 0.65)} L ${point(x + w * 0.8, y + h)}`
			);
		}
		default:
			return null; // rectangles are drawn as <rect> so rx is exact
	}
}

const round = (value) => Math.round(value * 100) / 100;

/** Where a cell's label sits inside its box, from `align` and `verticalAlign`. */
function labelAnchor(keys, box, shape, lineCount, fontSize) {
	const align = keys.align ?? "center";
	const verticalAlign = keys.verticalAlign ?? "middle";
	const anchor = align === "left" ? "start" : align === "right" ? "end" : "middle";
	const padding = 6;
	const x = align === "left" ? box.x + padding : align === "right" ? box.x + box.width - padding : box.x + box.width / 2;
	const blockHeight = lineCount * fontSize * 1.25;
	// A swimlane's label belongs in its title bar, not floating in the middle of
	// the lane, and `startSize` is where draw.io puts the bar.
	if (shape === "swimlane") {
		const startSize = styleNumber(keys, "startSize", 23);
		return { x, y: box.y + startSize / 2 + fontSize * 0.35, anchor };
	}
	if (verticalAlign === "top") return { x, y: box.y + padding + fontSize, anchor };
	if (verticalAlign === "bottom") return { x, y: box.y + box.height - padding - blockHeight + fontSize, anchor };
	return { x, y: box.y + box.height / 2 - blockHeight / 2 + fontSize * 0.9, anchor };
}

/** The `<text>` block for a label, or "" when there is nothing to draw. */
function renderLabel(raw, keys, box, shape, options) {
	const lines = labelLines(raw).filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1));
	if (lines.length === 0) return "";
	const fontSize = styleNumber(keys, "fontSize", DEFAULT_FONT_SIZE);
	const wrapped = wrapLines(lines, box.width, fontSize, keys.whiteSpace === "wrap" && shape !== "text");
	const anchor = labelAnchor(keys, box, shape, wrapped.length, fontSize);
	const fontStyle = styleNumber(keys, "fontStyle", 0);
	const attrs = [
		`x="${round(anchor.x)}"`,
		`y="${round(anchor.y)}"`,
		`text-anchor="${anchor.anchor}"`,
		`font-family="${escapeXml(keys.fontFamily ?? options.fontFamily)}"`,
		`font-size="${fontSize}"`,
		`fill="${escapeXml(styleColor(keys, "fontColor") ?? options.fontColor)}"`,
	];
	// fontStyle is a bitmask: 1 bold, 2 italic, 4 underline.
	if (fontStyle & 1) attrs.push('font-weight="bold"');
	if (fontStyle & 2) attrs.push('font-style="italic"');
	if (fontStyle & 4) attrs.push('text-decoration="underline"');
	const tspans = wrapped
		.map((line, index) => `<tspan x="${round(anchor.x)}" dy="${index === 0 ? 0 : round(fontSize * 1.25)}">${escapeXml(line)}</tspan>`)
		.join("");
	return `<text ${attrs.join(" ")} style="pointer-events:none;user-select:none">${tspans}</text>`;
}

/** Stroke and fill attributes shared by every vertex shape. */
function paintAttributes(keys, options, filled = true) {
	const stroke = styleColor(keys, "strokeColor") ?? options.stroke;
	const fill = styleColor(keys, "fillColor") ?? (Object.hasOwn(keys, "fillColor") ? "none" : options.fill);
	const attrs = [
		`fill="${filled ? escapeXml(fill ?? "none") : "none"}"`,
		`stroke="${escapeXml(stroke ?? "none")}"`,
		`stroke-width="${styleNumber(keys, "strokeWidth", 1)}"`,
	];
	const opacity = styleNumber(keys, "opacity", 100);
	if (opacity < 100) attrs.push(`opacity="${round(opacity / 100)}"`);
	if (styleFlag(keys, "dashed")) attrs.push(`stroke-dasharray="${escapeXml(keys.dashPattern ?? "3 3")}"`);
	return attrs.join(" ");
}

/** One vertex: its shape, then its label. */
function renderVertex(entry, box, options) {
	if (box.width <= 0 || box.height <= 0) return "";
	const parsed = parseStyle(entry.cell.attrs.style);
	const shape = shapeOf(parsed);
	const keys = parsed.keys;
	const id = escapeXml(cellId(entry));
	const paint = paintAttributes(keys, options, shape !== "actor");
	let body;
	if (shape === "ellipse") {
		body = `<ellipse cx="${round(box.x + box.width / 2)}" cy="${round(box.y + box.height / 2)}" rx="${round(box.width / 2)}" ry="${round(box.height / 2)}" ${paint} />`;
	} else if (shape === "text") {
		body = "";
	} else if (shape === "swimlane") {
		const startSize = styleNumber(keys, "startSize", 23);
		body =
			`<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" height="${round(box.height)}" ${paint} />` +
			`<path d="M ${round(box.x)},${round(box.y + startSize)} L ${round(box.x + box.width)},${round(box.y + startSize)}" fill="none" ${paintAttributes(keys, options, false)} />`;
	} else {
		const path = shapePath(shape, box, parsed);
		if (path) {
			body = `<path d="${path}" ${paint} stroke-linejoin="round" />`;
		} else {
			const radius = styleFlag(keys, "rounded") ? Math.min(styleNumber(keys, "arcSize", 10), box.width / 2, box.height / 2) : 0;
			body = `<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" height="${round(box.height)}" rx="${round(radius)}" ry="${round(radius)}" ${paint} />`;
		}
	}
	const label = renderLabel(cellLabel(entry), keys, box, shape, options);
	return `<g data-cell="${id}" data-kind="vertex" class="cell vertex">${body}${label}</g>`;
}

/**
 * Where an edge meets a shape.
 *
 * Fixed connection points (`exitX`/`entryX`, which draw.io writes whenever
 * someone drags an edge to a specific side) win; otherwise the edge aims at the
 * shape's centre and stops at its perimeter, which is what mxGraph's default
 * perimeter does and what makes an arrow look attached rather than buried.
 */
function anchorPoint(box, toward, keys, prefix, shape) {
	const fixedX = Number.parseFloat(keys[`${prefix}X`]);
	const fixedY = Number.parseFloat(keys[`${prefix}Y`]);
	if (Number.isFinite(fixedX) && Number.isFinite(fixedY)) {
		return {
			x: box.x + box.width * fixedX + (Number.parseFloat(keys[`${prefix}Dx`]) || 0),
			y: box.y + box.height * fixedY + (Number.parseFloat(keys[`${prefix}Dy`]) || 0),
		};
	}
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const dx = toward.x - cx;
	const dy = toward.y - cy;
	if (dx === 0 && dy === 0) return { x: cx, y: cy };
	if (shape === "ellipse") {
		const angle = Math.atan2(dy, dx);
		return { x: cx + (box.width / 2) * Math.cos(angle), y: cy + (box.height / 2) * Math.sin(angle) };
	}
	// Rectangle perimeter: scale the direction vector until it hits an edge.
	const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : box.width / 2 / Math.abs(dx);
	const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : box.height / 2 / Math.abs(dy);
	const scale = Math.min(scaleX, scaleY);
	return { x: cx + dx * scale, y: cy + dy * scale };
}

/** The two ends of an edge, resolving cell references and falling back to fixed points. */
function edgeEndpoints(entry, boxes) {
	const parsed = parseStyle(entry.cell.attrs.style);
	const geometry = cellGeometry(entry);
	const sourceBox = boxes.get(entry.cell.attrs.source ?? "");
	const targetBox = boxes.get(entry.cell.attrs.target ?? "");
	const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
	const waypoints = geometry.points;

	let source = geometry.sourcePoint;
	let target = geometry.targetPoint;
	const towardTarget = waypoints[0] ?? (targetBox ? centre(targetBox) : target) ?? { x: 0, y: 0 };
	const towardSource = waypoints[waypoints.length - 1] ?? (sourceBox ? centre(sourceBox) : source) ?? { x: 0, y: 0 };
	if (sourceBox) source = anchorPoint(sourceBox, towardTarget, parsed.keys, "exit", shapeOf(parseStyle(sourceBox.entry.cell.attrs.style)));
	if (targetBox) target = anchorPoint(targetBox, towardSource, parsed.keys, "entry", shapeOf(parseStyle(targetBox.entry.cell.attrs.style)));
	// An edge attached at neither end and given no points has nowhere to be.
	if (!source || !target) return null;
	return { source, target, waypoints, parsed };
}

/**
 * Route an orthogonal edge.
 *
 * mxGraph's real router is a constraint solver over the whole graph. This is the
 * two-segment elbow it produces in the common case: leave along whichever axis
 * has more distance to cover, then turn once. Where an author has placed
 * waypoints, those win outright — a hand-routed edge is a decision, and
 * re-routing it would silently undo someone's work.
 */
function orthogonalRoute(source, target, waypoints) {
	if (waypoints.length > 0) return [source, ...waypoints, target];
	const dx = Math.abs(target.x - source.x);
	const dy = Math.abs(target.y - source.y);
	if (dx < 1 || dy < 1) return [source, target];
	return dx > dy
		? [source, { x: (source.x + target.x) / 2, y: source.y }, { x: (source.x + target.x) / 2, y: target.y }, target]
		: [source, { x: source.x, y: (source.y + target.y) / 2 }, { x: target.x, y: (source.y + target.y) / 2 }, target];
}

/** A path through `points`, with rounded corners or a curve when the style asks. */
function pathThrough(points, { rounded, curved }) {
	if (points.length < 2) return "";
	if (curved && points.length > 2) {
		let d = `M ${round(points[0].x)},${round(points[0].y)}`;
		for (let i = 1; i < points.length - 1; i += 1) {
			const next = points[i + 1];
			const mid = { x: (points[i].x + next.x) / 2, y: (points[i].y + next.y) / 2 };
			d += ` Q ${round(points[i].x)},${round(points[i].y)} ${round(mid.x)},${round(mid.y)}`;
		}
		const last = points[points.length - 1];
		return `${d} L ${round(last.x)},${round(last.y)}`;
	}
	if (!rounded || points.length < 3) {
		return points.map((point, index) => `${index === 0 ? "M" : "L"} ${round(point.x)},${round(point.y)}`).join(" ");
	}
	const radius = 10;
	let d = `M ${round(points[0].x)},${round(points[0].y)}`;
	for (let i = 1; i < points.length - 1; i += 1) {
		const previous = points[i - 1];
		const corner = points[i];
		const next = points[i + 1];
		const before = shorten(corner, previous, radius);
		const after = shorten(corner, next, radius);
		d += ` L ${round(before.x)},${round(before.y)} Q ${round(corner.x)},${round(corner.y)} ${round(after.x)},${round(after.y)}`;
	}
	const last = points[points.length - 1];
	return `${d} L ${round(last.x)},${round(last.y)}`;
}

/** A point `distance` along the way from `from` toward `to`, clamped to half the span. */
function shorten(from, to, distance) {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy);
	if (length === 0) return { ...from };
	const step = Math.min(distance, length / 2);
	return { x: from.x + (dx / length) * step, y: from.y + (dy / length) * step };
}

/** One arrowhead, drawn at `tip` pointing away from `from`. */
function arrowHead(kind, tip, from, color, filled, size = 10) {
	if (!kind || kind === "none") return "";
	const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
	const point = (distance, spread) => ({
		x: tip.x - distance * Math.cos(angle) + spread * Math.sin(angle),
		y: tip.y - distance * Math.sin(angle) - spread * Math.cos(angle),
	});
	const paint = `fill="${filled ? escapeXml(color) : "#ffffff"}" stroke="${escapeXml(color)}" stroke-width="1"`;
	switch (kind) {
		case "open":
		case "openThin": {
			const a = point(size, size * 0.5);
			const b = point(size, -size * 0.5);
			return `<path d="M ${round(a.x)},${round(a.y)} L ${round(tip.x)},${round(tip.y)} L ${round(b.x)},${round(b.y)}" fill="none" stroke="${escapeXml(color)}" stroke-width="1.5" />`;
		}
		case "oval": {
			const centre = point(size / 2, 0);
			return `<circle cx="${round(centre.x)}" cy="${round(centre.y)}" r="${round(size / 2)}" ${paint} />`;
		}
		case "diamond":
		case "diamondThin": {
			const back = point(size * 1.4, 0);
			const left = point(size * 0.7, size * 0.45);
			const right = point(size * 0.7, -size * 0.45);
			return `<path d="M ${round(tip.x)},${round(tip.y)} L ${round(left.x)},${round(left.y)} L ${round(back.x)},${round(back.y)} L ${round(right.x)},${round(right.y)} Z" ${paint} />`;
		}
		case "block":
		case "blockThin": {
			const a = point(size, size * 0.4);
			const b = point(size, -size * 0.4);
			return `<path d="M ${round(tip.x)},${round(tip.y)} L ${round(a.x)},${round(a.y)} L ${round(b.x)},${round(b.y)} Z" ${paint} />`;
		}
		default: {
			// `classic`: the notched arrow draw.io uses by default.
			const a = point(size, size * 0.45);
			const b = point(size * 0.7, 0);
			const c = point(size, -size * 0.45);
			return `<path d="M ${round(tip.x)},${round(tip.y)} L ${round(a.x)},${round(a.y)} L ${round(b.x)},${round(b.y)} L ${round(c.x)},${round(c.y)} Z" ${paint} />`;
		}
	}
}

function renderEdge(entry, boxes, options) {
	const ends = edgeEndpoints(entry, boxes);
	if (!ends) return "";
	const { source, target, waypoints, parsed } = ends;
	const keys = parsed.keys;
	const orthogonal = (keys.edgeStyle ?? "").toLowerCase().includes("orthogonal");
	const points = orthogonal ? orthogonalRoute(source, target, waypoints) : [source, ...waypoints, target];
	const d = pathThrough(points, { rounded: styleFlag(keys, "rounded", orthogonal), curved: styleFlag(keys, "curved") });
	const color = styleColor(keys, "strokeColor") ?? options.stroke;
	const width = styleNumber(keys, "strokeWidth", 1);
	const dash = styleFlag(keys, "dashed") ? ` stroke-dasharray="${escapeXml(keys.dashPattern ?? "3 3")}"` : "";
	const id = escapeXml(cellId(entry));
	const endArrow = keys.endArrow ?? "classic";
	const startArrow = keys.startArrow ?? "none";
	const head = arrowHead(endArrow, points[points.length - 1], points[points.length - 2], color, !Object.hasOwn(keys, "endFill") || keys.endFill === "1");
	const tail = arrowHead(startArrow, points[0], points[1], color, keys.startFill !== "0");
	// A wide transparent path under the visible one: an edge is a few pixels of
	// ink and would otherwise be almost impossible to click.
	const hit = `<path d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(12, width * 6)}" class="edge-hit" />`;
	const line = `<path d="${d}" fill="none" stroke="${escapeXml(color)}" stroke-width="${width}"${dash} stroke-linejoin="round" />`;
	const label = renderEdgeLabel(entry, points, keys, options);
	return `<g data-cell="${id}" data-kind="edge" class="cell edge">${hit}${line}${head}${tail}${label}</g>`;
}

/** An edge's label, centred on the middle segment with a backing so it stays readable. */
function renderEdgeLabel(entry, points, keys, options) {
	const raw = cellLabel(entry);
	const lines = labelLines(raw).filter((line) => line.length > 0);
	if (lines.length === 0) return "";
	const middle = points[Math.floor(points.length / 2)] ?? points[0];
	const previous = points[Math.max(0, Math.floor(points.length / 2) - 1)];
	const at = { x: (middle.x + previous.x) / 2, y: (middle.y + previous.y) / 2 };
	const fontSize = styleNumber(keys, "fontSize", 11);
	const widest = Math.max(...lines.map((line) => line.length));
	const boxWidth = widest * fontSize * GLYPH_WIDTH_RATIO + 8;
	const boxHeight = lines.length * fontSize * 1.25 + 4;
	const backing = `<rect x="${round(at.x - boxWidth / 2)}" y="${round(at.y - boxHeight / 2)}" width="${round(boxWidth)}" height="${round(boxHeight)}" fill="${escapeXml(options.labelBacking)}" stroke="none" rx="2" />`;
	const tspans = lines
		.map((line, index) => `<tspan x="${round(at.x)}" dy="${index === 0 ? 0 : round(fontSize * 1.25)}">${escapeXml(line)}</tspan>`)
		.join("");
	return `${backing}<text x="${round(at.x)}" y="${round(at.y - boxHeight / 2 + fontSize)}" text-anchor="middle" font-family="${escapeXml(options.fontFamily)}" font-size="${fontSize}" fill="${escapeXml(styleColor(keys, "fontColor") ?? options.fontColor)}" style="pointer-events:none;user-select:none">${tspans}</text>`;
}

/** Defaults a caller can override to render for a dark page or an exported file. */
export function renderOptions(overrides = {}) {
	return {
		fill: DEFAULT_FILL,
		stroke: DEFAULT_STROKE,
		fontColor: DEFAULT_FONT_COLOR,
		fontFamily: DEFAULT_FONT_FAMILY,
		labelBacking: "#ffffff",
		background: "#ffffff",
		...overrides,
	};
}

/**
 * Render a page's contents, without the `<svg>` wrapper.
 *
 * Vertices first, then edges, so an arrowhead is never hidden under the box it
 * points at. Within each pass, document order — which is what draw.io treats as
 * z-order.
 */
export function renderPageBody(page, boxes, options = renderOptions()) {
	const drawable = page.drawable();
	const vertices = drawable.filter(isVertex);
	const edges = drawable.filter(isEdge);
	const parts = [];
	for (const entry of vertices) {
		const box = boxes.get(cellId(entry));
		if (box) parts.push(renderVertex(entry, box, options));
	}
	for (const entry of edges) parts.push(renderEdge(entry, boxes, options));
	return parts.join("\n");
}

/** A complete standalone SVG document for a page — what `save_file` writes. */
export function renderPageSvg(page, options = renderOptions()) {
	if (page.compressed) {
		return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80"><text x="10" y="45" font-family="${escapeXml(options.fontFamily)}" font-size="13">Page "${escapeXml(page.name)}" is stored compressed.</text></svg>`;
	}
	const boxes = layoutPage(page);
	const bounds = pageBounds(page, boxes);
	const body = renderPageBody(page, boxes, options);
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(bounds.width)}" height="${Math.round(bounds.height)}" viewBox="${round(bounds.x)} ${round(bounds.y)} ${round(bounds.width)} ${round(bounds.height)}">`,
		`<rect x="${round(bounds.x)}" y="${round(bounds.y)}" width="${round(bounds.width)}" height="${round(bounds.height)}" fill="${escapeXml(options.background)}" />`,
		body,
		"</svg>",
	].join("\n");
}
