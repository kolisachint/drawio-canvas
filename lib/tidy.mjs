/**
 * Tidy: the small fixes a person otherwise waits a whole agent turn for —
 * shapes too small for their label, near-misses on alignment, boxes on top of
 * each other, edges still bending around where a shape used to be.
 *
 * Deterministic and instant: no model involved. The same pass runs in two
 * places — in the person's browser, as their own edit (so Ctrl+Z undoes it),
 * and as the agent's `tidy` action, so the agent never computes geometry by
 * hand. It works on plain boxes and imports nothing, so both can load it.
 *
 * The steps, in order, each one conservative:
 *
 *  1. **fit** — grow a shape whose label does not fit. Never shrinks, and skips
 *     icons and shapes whose label sits outside them.
 *  2. **snap** — sizes up to the grid, positions onto it.
 *  3. **align** — shapes whose centres are within a few pixels of each other,
 *     in a row or a column, get the same centre.
 *  4. **overlap** — a shape overlapping another in the same container is pushed
 *     right or down, whichever is shorter, until there is a gap. A shape that
 *     wholly contains another is left alone: that is a container drawn without
 *     nesting, not a collision.
 *  5. **waypoints** — edges attached to a shape that moved lose their bends,
 *     which were placed around the old position.
 *
 * Only shapes in scope move; the rest of the page is an obstacle.
 */

export const TIDY_DEFAULTS = {
	grid: 10,
	/** Space left between two shapes that were overlapping. */
	gap: 20,
	/** Centres this close are treated as meant to line up. */
	alignTolerance: 12,
	/** Label estimate, when the caller cannot measure text. */
	charWidth: 7,
	lineHeight: 17,
	padding: 16,
	maxLabelWidth: 320,
	steps: { fit: true, snap: true, align: true, overlap: true, waypoints: true },
};

const OVERLAP_PASSES = 30;
/** Align/separate rounds before giving up on a fixed point. */
const SETTLE_ROUNDS = 50;

/** Labels outside the shape, images and stencil icons: never resized to their text. */
const NO_FIT = /(^|;)(verticalLabelPosition=bottom|verticalLabelPosition=top|labelPosition=left|labelPosition=right|shape=image|image=|shape=mxgraph\.|edgeLabel)/;

/** Plain text of a label: HTML stripped, lines kept. */
export function labelLines(label) {
	const text = String(label ?? "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(div|p|li)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1));
}

/** The size a label needs, estimated from its characters. */
export function estimateLabelSize(label, options = TIDY_DEFAULTS) {
	const lines = labelLines(label);
	if (lines.length === 0) return null;
	const longest = Math.max(...lines.map((line) => line.length)) * options.charWidth;
	const width = Math.min(options.maxLabelWidth, longest + options.padding);
	const wrapped = lines.reduce((count, line) => count + Math.max(1, Math.ceil((line.length * options.charWidth) / Math.max(1, width - options.padding))), 0);
	return { width, height: wrapped * options.lineHeight + options.padding };
}

const ceilTo = (value, grid) => (grid > 0 ? Math.ceil(value / grid - 1e-9) * grid : value);
const roundTo = (value, grid) => (grid > 0 ? Math.round(value / grid) * grid : value);

function contains(outer, inner) {
	return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}

function overlapping(a, b, gap) {
	return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

/**
 * Tidy a set of shapes.
 *
 * @param {Array<{id: string, parent?: string, x: number, y: number, width: number, height: number, label?: string, style?: string, preferred?: {width: number, height: number}}>} shapes
 *   Every vertex on the page (relative-geometry children such as edge labels excluded).
 *   `preferred` is the label's measured size when the caller can measure text.
 * @param {Array<{id: string, source?: string, target?: string, points?: number}>} edges
 * @param {object} [options]
 * @param {string[]} [options.scope] Ids that may move. Default: all shapes.
 * @returns {{ changes: Array<{id: string, x: number, y: number, width: number, height: number}>, clearPoints: string[], summary: {fitted: number, snapped: number, aligned: number, separated: number, rerouted: number} }}
 */
export function tidy(shapes, edges = [], options = {}) {
	const settings = { ...TIDY_DEFAULTS, ...options, steps: { ...TIDY_DEFAULTS.steps, ...options.steps } };
	const { grid, gap } = settings;
	const boxes = shapes.map((shape) => ({ ...shape, parent: shape.parent ?? "1", original: { x: shape.x, y: shape.y, width: shape.width, height: shape.height } }));
	const scope = new Set(options.scope?.length ? options.scope.map(String) : boxes.map((box) => box.id));
	const movable = boxes.filter((box) => scope.has(box.id));
	const summary = { fitted: 0, snapped: 0, aligned: 0, separated: 0, rerouted: 0 };

	if (settings.steps.fit) {
		for (const box of movable) {
			if (NO_FIT.test(box.style ?? "")) continue;
			const needed = box.preferred ?? estimateLabelSize(box.label, settings);
			if (!needed) continue;
			const width = Math.max(box.width, needed.width);
			const height = Math.max(box.height, needed.height);
			if (width > box.width + 0.5 || height > box.height + 0.5) {
				// Grow around the centre, so the shape stays where the person put it.
				box.x -= (width - box.width) / 2;
				box.y -= (height - box.height) / 2;
				box.width = width;
				box.height = height;
				summary.fitted += 1;
			}
		}
	}

	if (settings.steps.snap && grid > 0) {
		for (const box of movable) {
			const before = `${box.x},${box.y},${box.width},${box.height}`;
			box.width = Math.max(grid, ceilTo(box.width, grid));
			box.height = Math.max(grid, ceilTo(box.height, grid));
			box.x = roundTo(box.x, grid);
			box.y = roundTo(box.y, grid);
			if (`${box.x},${box.y},${box.width},${box.height}` !== before) summary.snapped += 1;
		}
	}

	/**
	 * Line up near-aligned centres. Returns how many shapes moved.
	 *
	 * A shape whose centre matches another's already lines up with it and stays —
	 * "matches" meaning within half a grid step when snapping, since positions on
	 * the grid cannot always put two different widths on one exact centre. Otherwise it moves onto the nearest centre within the
	 * tolerance. The two are then aligned with each other, so neither moves on a
	 * later pass: one pass reaches a fixed point, and tidying twice changes nothing.
	 */
	const align = () => {
		let count = 0;
		const aligned = settings.steps.snap ? grid / 2 + 0.5 : 0.5;
		for (const axis of ["x", "y"]) {
			const size = axis === "x" ? "width" : "height";
			const center = (box) => box[axis] + box[size] / 2;
			for (const box of [...movable].sort((a, b) => center(a) - center(b) || a.id.localeCompare(b.id))) {
				const others = boxes.filter((other) => other !== box && other.parent === box.parent);
				const distances = others.map((other) => ({ other, distance: Math.abs(center(other) - center(box)) }));
				if (distances.some(({ distance }) => distance <= aligned)) continue;
				const nearest = distances.filter(({ distance }) => distance <= settings.alignTolerance).sort((a, b) => a.distance - b.distance || a.other.id.localeCompare(b.other.id))[0];
				if (!nearest) continue;
				const target = center(nearest.other);
				box[axis] = settings.steps.snap ? roundTo(target - box[size] / 2, grid) : target - box[size] / 2;
				count += 1;
			}
		}
		return count;
	};

	/** Push overlapping shapes apart. Returns the ids that moved. */
	const separate = () => {
		const separated = new Set();
		for (let pass = 0; pass < OVERLAP_PASSES; pass += 1) {
			let moved = false;
			const ordered = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
			for (let i = 0; i < ordered.length; i += 1) {
				for (let j = i + 1; j < ordered.length; j += 1) {
					const a = ordered[i];
					const b = ordered[j];
					if (a.parent !== b.parent || !overlapping(a, b, 0) || contains(a, b) || contains(b, a)) continue;
					// Push the one that may move; the later one when both may.
					const [still, mover] = scope.has(b.id) ? [a, b] : scope.has(a.id) ? [b, a] : [null, null];
					if (!mover) continue;
					const right = still.x + still.width + gap - mover.x;
					const down = still.y + still.height + gap - mover.y;
					if (right <= down) mover.x = ceilTo(mover.x + right, grid);
					else mover.y = ceilTo(mover.y + down, grid);
					separated.add(mover.id);
					moved = true;
				}
			}
			if (!moved) break;
		}
		return separated;
	};

	// Separating can create a new near-alignment and aligning a new overlap, so
	// the two run until neither has anything left to do: a second tidy is a no-op.
	const separatedIds = new Set();
	for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
		const aligned = settings.steps.align ? align() : 0;
		const separated = settings.steps.overlap ? separate() : new Set();
		summary.aligned += aligned;
		for (const id of separated) separatedIds.add(id);
		if (aligned === 0 && separated.size === 0) break;
	}
	summary.separated = separatedIds.size;

	const changes = [];
	const moved = new Set();
	for (const box of movable) {
		const { original } = box;
		if (Math.abs(box.x - original.x) < 0.01 && Math.abs(box.y - original.y) < 0.01 && Math.abs(box.width - original.width) < 0.01 && Math.abs(box.height - original.height) < 0.01) continue;
		changes.push({ id: box.id, x: box.x, y: box.y, width: box.width, height: box.height });
		if (Math.abs(box.x - original.x) >= 0.01 || Math.abs(box.y - original.y) >= 0.01) moved.add(box.id);
	}

	const clearPoints = settings.steps.waypoints ? edges.filter((edge) => (edge.points ?? 0) > 0 && (moved.has(edge.source) || moved.has(edge.target))).map((edge) => edge.id) : [];
	summary.rerouted = clearPoints.length;
	return { changes, clearPoints, summary };
}

/** One line saying what a tidy did. */
export function describeTidy(summary) {
	const parts = [];
	if (summary.fitted) parts.push(`${summary.fitted} fitted to label`);
	if (summary.aligned) parts.push(`${summary.aligned} aligned`);
	if (summary.separated) parts.push(`${summary.separated} moved off an overlap`);
	if (summary.snapped) parts.push(`${summary.snapped} snapped to grid`);
	if (summary.rerouted) parts.push(`${summary.rerouted} edge(s) straightened`);
	return parts.length ? parts.join(", ") : "already tidy";
}
