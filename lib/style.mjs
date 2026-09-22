/**
 * draw.io style strings.
 *
 * A cell's `style` attribute is a semicolon-separated list of `key=value` pairs
 * with an occasional bare token: `rounded=1;whiteSpace=wrap;html=1;` but also
 * `shape=cylinder` and the bare `group`, and the first token of a shape style is
 * frequently a bare name (`swimlane;startSize=30`). All three forms appear in
 * files draw.io writes, so all three round-trip here.
 *
 * Round-tripping is the whole job. This canvas draws the properties it knows;
 * everything else — a stencil reference, a perimeter function, a gradient
 * direction it does not implement — stays in the string untouched, so a file
 * edited here and reopened in draw.io still looks the way its author made it.
 */

/** Parse a style string into `{ keys, bare }`: known pairs, and bare tokens in order. */
export function parseStyle(style) {
	const keys = {};
	const bare = [];
	for (const token of String(style ?? "").split(";")) {
		const trimmed = token.trim();
		if (trimmed.length === 0) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) {
			bare.push(trimmed);
			continue;
		}
		keys[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
	}
	return { keys, bare };
}

/**
 * Format a parsed style back to a string, bare tokens first.
 *
 * Bare-first is how draw.io writes them (`swimlane;startSize=30;`) and the
 * leading bare token is shape-significant, so the order is not cosmetic.
 */
export function formatStyle(parsed) {
	const parts = [...parsed.bare];
	for (const [key, value] of Object.entries(parsed.keys)) parts.push(`${key}=${value}`);
	return parts.length > 0 ? `${parts.join(";")};` : "";
}

/** Set one key in a style string, leaving everything else as it was. */
export function withStyleKey(style, key, value) {
	const parsed = parseStyle(style);
	if (value === undefined || value === null) delete parsed.keys[key];
	else parsed.keys[key] = String(value);
	return formatStyle(parsed);
}

/** A style value as a number, or `fallback` when absent or unparseable. */
export function styleNumber(keys, name, fallback) {
	const value = Number.parseFloat(keys[name]);
	return Number.isFinite(value) ? value : fallback;
}

/** A style value as a boolean: draw.io writes `1`/`0`. */
export function styleFlag(keys, name, fallback = false) {
	if (!Object.hasOwn(keys, name)) return fallback;
	return keys[name] === "1" || keys[name] === "true";
}

/**
 * A color, or null for "none".
 *
 * draw.io writes `none` for no fill and `default` for "whatever the theme says".
 * Both mean "do not paint a color of my choosing", so both become null and the
 * caller supplies its own default.
 */
export function styleColor(keys, name) {
	const value = keys[name];
	if (value === undefined || value === "none" || value === "default") return null;
	return value;
}

/**
 * The shape a style asks for, normalized to the names {@link ../ui/render.mjs}
 * draws.
 *
 * Three spellings reach here: `shape=cylinder`, a bare leading token
 * (`swimlane`), and the rounded-rectangle pair (`rounded=1`) that names no shape
 * at all. Anything unrecognized comes back as `rectangle` — a shape this canvas
 * cannot draw is still a box with the right size, position, label and colors,
 * which keeps an unfamiliar diagram usable instead of blank.
 */
export function shapeOf(parsed) {
	const named = parsed.keys.shape ?? parsed.bare.find((token) => token !== "html" && token !== "group");
	const shape = String(named ?? "").toLowerCase();
	if (shape.startsWith("mxgraph.")) return "rectangle";
	switch (shape) {
		case "ellipse":
		case "circle":
			return "ellipse";
		case "rhombus":
			return "rhombus";
		case "triangle":
			return "triangle";
		case "hexagon":
			return "hexagon";
		case "parallelogram":
			return "parallelogram";
		case "trapezoid":
			return "trapezoid";
		case "cylinder":
		case "cylinder3":
		case "datastore":
			return "cylinder";
		case "cloud":
			return "cloud";
		case "note":
			return "note";
		case "document":
			return "document";
		case "process":
			return "process";
		case "step":
			return "step";
		case "card":
			return "card";
		case "actor":
		case "umlactor":
			return "actor";
		case "swimlane":
			return "swimlane";
		case "text":
			return "text";
		case "internalstorage":
		case "":
			return parsed.bare.includes("group") ? "group" : "rectangle";
		default:
			return "rectangle";
	}
}
