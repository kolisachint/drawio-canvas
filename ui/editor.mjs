/**
 * The editing surface: everything that happens between a pointer and the
 * document.
 *
 * It renders with the same `lib/render.mjs` the extension uses and mutates the
 * same `lib/model.mjs` document, then reports what changed as cell operations —
 * the identical `{operation, cell_id, new_xml}` shape the agent sends. Both
 * operators therefore edit through one code path, which is what makes
 * concurrent editing merge per cell instead of per document.
 *
 * Two structural choices worth knowing before changing anything:
 *
 * **Content is a rendered string; chrome is DOM.** The cells are re-rendered
 * wholesale from the model into `#content`, because a diff of SVG would be a
 * second renderer to keep in step with the first. Selection outlines, handles,
 * ports and previews are built as DOM in `#overlay`, so a re-render never
 * disturbs what the person is holding on to.
 *
 * **Every gesture ends in an operation, or in nothing.** A drag mutates the
 * model as it goes so edges stay attached to the box being moved, but nothing
 * is sent until the pointer is released. A cancelled gesture restores the
 * geometry it started from.
 */

import {
	cellGeometry,
	cellId,
	cellLabel,
	DEFAULT_LAYER_ID,
	isEdge,
	isVertex,
	setCellGeometry,
} from "../lib/model.mjs";
import { layoutPage, pageBounds, renderOptions, renderPageBody } from "../lib/render.mjs";
import { parseStyle, withStyleKey } from "../lib/style.mjs";
import { element, serializeXml } from "../lib/xml.mjs";

/** Grid step, in diagram units. draw.io's default, and what its files are drawn on. */
export const GRID = 10;
/** Smallest shape a drag-resize will produce. Below this a shape cannot be grabbed again. */
const MIN_SIZE = 20;

/** The shapes the toolbar can insert, as the style strings draw.io itself writes. */
export const INSERT_STYLES = {
	rounded: { style: "rounded=1;whiteSpace=wrap;html=1;", width: 140, height: 60, label: "Label" },
	rectangle: { style: "rounded=0;whiteSpace=wrap;html=1;", width: 140, height: 60, label: "Label" },
	ellipse: { style: "ellipse;whiteSpace=wrap;html=1;", width: 120, height: 80, label: "Label" },
	rhombus: { style: "rhombus;whiteSpace=wrap;html=1;", width: 120, height: 80, label: "Decision" },
	cylinder: { style: "shape=cylinder;whiteSpace=wrap;html=1;boundedLbl=1;", width: 110, height: 90, label: "Store" },
	note: { style: "shape=note;whiteSpace=wrap;html=1;size=14;", width: 120, height: 80, label: "Note" },
	text: { style: "text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;", width: 160, height: 30, label: "Text" },
};

/** The default connector, matching what draw.io draws when you drag between shapes. */
const EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;";

const snap = (value) => Math.round(value / GRID) * GRID;

export class Editor {
	constructor(options) {
		this.stage = options.stage;
		this.scene = options.scene;
		this.content = options.content;
		this.overlay = options.overlay;
		this.labelEditor = options.labelEditor;
		this.onEdit = options.onEdit ?? (() => {});
		this.onSelectionChange = options.onSelectionChange ?? (() => {});
		this.onViewChange = options.onViewChange ?? (() => {});

		this.doc = null;
		this.pageId = null;
		this.selection = new Set();
		this.view = { x: 0, y: 0, scale: 1 };
		this.gesture = null;
		this.hover = null;
		this.boxes = new Map();
		this.frame = null;

		this.bindEvents();
	}

	/** The page being edited, or null before the first document arrives. */
	get page() {
		if (!this.doc) return null;
		return this.doc.page(this.pageId ? { page_id: this.pageId } : {}) ?? this.doc.page();
	}

	/**
	 * Swap in a new document.
	 *
	 * Selection survives if the cells still exist, because the common reason for
	 * a new document is the agent editing a different part of the page while the
	 * person is working, and clearing their selection for that would be rude.
	 */
	setDocument(doc, { pageId, keepView = true } = {}) {
		this.doc = doc;
		const pages = doc.pages();
		const wanted = pageId ?? this.pageId;
		this.pageId = pages.some((page) => page.id === wanted) ? wanted : (pages[0]?.id ?? null);
		const present = new Set(this.page ? this.page.drawable().map(cellId) : []);
		for (const id of [...this.selection]) if (!present.has(id)) this.selection.delete(id);
		if (!keepView) this.fit();
		this.render();
		this.onSelectionChange([...this.selection]);
	}

	/** Re-render the page and the overlay. Cheap enough to call on every frame of a drag. */
	render() {
		const page = this.page;
		if (!page) {
			this.content.innerHTML = "";
			this.overlay.innerHTML = "";
			return;
		}
		this.boxes = layoutPage(page);
		this.content.innerHTML = renderPageBody(page, this.boxes, this.themeOptions());
		this.renderOverlay();
	}

	/** Colors for the rendered diagram, following the page's own light/dark theme. */
	themeOptions() {
		const styles = getComputedStyle(document.body);
		const dark = matchMedia("(prefers-color-scheme: dark)").matches;
		return renderOptions({
			// A diagram made in draw.io names its own colors and keeps them; these are
			// only the fallbacks for cells that name none, so an unstyled shape is
			// legible in both schemes instead of black-on-black.
			fill: dark ? "#232a33" : "#ffffff",
			stroke: styles.getPropertyValue("--ink").trim() || "#000000",
			fontColor: styles.getPropertyValue("--ink").trim() || "#000000",
			labelBacking: styles.getPropertyValue("--surface").trim() || "#ffffff",
			background: "transparent",
		});
	}

	/** Mark cells the agent just touched, for one animation. */
	flash(ids) {
		for (const id of ids ?? []) {
			const node = this.content.querySelector(`[data-cell="${cssEscape(id)}"]`);
			if (!node) continue;
			node.classList.remove("touched-agent");
			// Reading offsetWidth restarts the animation when the same cell is touched
			// twice in a row, which is the usual case while an agent iterates.
			void node.getBoundingClientRect();
			node.classList.add("touched-agent");
		}
	}

	// ---------------------------------------------------------------- selection

	select(ids, { additive = false } = {}) {
		if (!additive) this.selection.clear();
		for (const id of ids) this.selection.add(id);
		this.renderOverlay();
		this.onSelectionChange([...this.selection]);
	}

	clearSelection() {
		if (this.selection.size === 0) return;
		this.selection.clear();
		this.renderOverlay();
		this.onSelectionChange([]);
	}

	/** The selected cells, as model entries. */
	selectedEntries() {
		const page = this.page;
		if (!page) return [];
		return [...this.selection].map((id) => page.find(id)).filter(Boolean);
	}

	// ------------------------------------------------------------------ overlay

	renderOverlay() {
		const page = this.page;
		this.overlay.replaceChildren();
		if (!page) return;
		const single = this.selection.size === 1 ? this.boxes.get([...this.selection][0]) : null;
		for (const id of this.selection) {
			const box = this.boxes.get(id);
			if (!box) continue;
			const entry = box.entry;
			if (isVertex(entry) && box.width > 0) {
				this.overlay.append(
					svgNode("rect", {
						class: "sel-outline",
						x: box.x - 2,
						y: box.y - 2,
						width: box.width + 4,
						height: box.height + 4,
					}),
				);
			} else if (isEdge(entry)) {
				const ends = [box.geometry.sourcePoint, box.geometry.targetPoint, ...box.geometry.points].filter(Boolean);
				for (const point of ends) {
					this.overlay.append(svgNode("circle", { class: "handle", cx: point.x, cy: point.y, r: 4 / this.view.scale }));
				}
				// An edge between two shapes has no geometry of its own to outline, so
				// its selection is shown on the shapes it joins.
				for (const end of ["source", "target"]) {
					const other = this.boxes.get(entry.cell.attrs[end] ?? "");
					if (!other) continue;
					this.overlay.append(
						svgNode("rect", { class: "drop-target", x: other.x - 3, y: other.y - 3, width: other.width + 6, height: other.height + 6, rx: 3 }),
					);
				}
			}
		}
		if (single && isVertex(single.entry) && single.width > 0) this.addHandles(single);
		// Ports on the selected shape *and* the one under the pointer. Only on the
		// selection would mean connecting two shapes takes three gestures — select
		// the source, drag, select the next — which is not how anyone draws.
		const portTargets = new Set([single, this.hover ? this.boxes.get(this.hover) : null].filter(Boolean));
		for (const box of portTargets) {
			if (isVertex(box.entry) && box.width > 0) this.addPorts(box);
		}
	}

	addHandles(box) {
		const size = 4 / this.view.scale;
		for (const [name, x, y] of handlePositions(box)) {
			this.overlay.append(
				svgNode("rect", {
					class: `handle ${name}`,
					x: x - size,
					y: y - size,
					width: size * 2,
					height: size * 2,
					"data-handle": name,
					"data-cell": cellId(box.entry),
				}),
			);
		}
	}

	addPorts(box) {
		const radius = 4.5 / this.view.scale;
		for (const [name, x, y] of portPositions(box)) {
			this.overlay.append(
				svgNode("circle", { class: "port", cx: x, cy: y, r: radius, "data-port": name, "data-cell": cellId(box.entry) }),
			);
		}
	}

	// ------------------------------------------------------------------- events

	bindEvents() {
		this.stage.addEventListener("pointerdown", (event) => this.onPointerDown(event));
		this.stage.addEventListener("pointermove", (event) => this.onPointerMove(event));
		this.stage.addEventListener("pointerup", (event) => this.onPointerUp(event));
		this.stage.addEventListener("pointercancel", () => this.cancelGesture());
		this.stage.addEventListener("dblclick", (event) => this.onDoubleClick(event));
		this.stage.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
		this.stage.addEventListener("contextmenu", (event) => event.preventDefault());
	}

	/** Pointer position in diagram coordinates. */
	toScene(event) {
		const point = this.stage.createSVGPoint();
		point.x = event.clientX;
		point.y = event.clientY;
		return point.matrixTransform(this.scene.getScreenCTM().inverse());
	}

	onPointerDown(event) {
		if (event.button === 2) return;
		this.stage.setPointerCapture(event.pointerId);
		const at = this.toScene(event);
		const port = event.target.closest?.("[data-port]");
		const handle = event.target.closest?.("[data-handle]");
		const cellNode = event.target.closest?.("[data-cell]");

		if (port) {
			const id = port.getAttribute("data-cell");
			this.gesture = { kind: "connect", from: id, at, current: at };
			return;
		}
		if (handle) {
			const id = handle.getAttribute("data-cell");
			const box = this.boxes.get(id);
			if (!box) return;
			this.gesture = {
				kind: "resize",
				id,
				corner: handle.getAttribute("data-handle"),
				start: { x: box.x, y: box.y, width: box.width, height: box.height },
				origin: at,
			};
			return;
		}
		// Middle button, space, or an empty-space drag: pan. Panning from empty
		// space would fight marquee selection, so empty space needs a modifier.
		if (event.button === 1 || event.altKey || (!cellNode && event.shiftKey === false && event.ctrlKey === false && event.metaKey === false && this.spaceDown)) {
			this.gesture = { kind: "pan", origin: { x: event.clientX, y: event.clientY }, view: { ...this.view } };
			return;
		}
		if (!cellNode) {
			if (!event.shiftKey) this.clearSelection();
			this.gesture = { kind: "marquee", origin: at, current: at, additive: event.shiftKey };
			return;
		}

		const id = cellNode.getAttribute("data-cell");
		if (event.shiftKey) {
			if (this.selection.has(id)) this.selection.delete(id);
			else this.selection.add(id);
			this.renderOverlay();
			this.onSelectionChange([...this.selection]);
		} else if (!this.selection.has(id)) {
			this.select([id]);
		}
		const page = this.page;
		const moving = [...this.selection]
			.map((selected) => page.find(selected))
			.filter((entry) => entry && isVertex(entry))
			.map((entry) => ({ entry, start: { ...cellGeometry(entry) } }));
		if (moving.length === 0) return;
		this.gesture = { kind: "move", origin: at, moving, moved: false };
	}

	onPointerMove(event) {
		const at = this.toScene(event);
		if (!this.gesture) {
			// The pointer moving onto a port or a handle must not change what is
			// hovered: those *are* the hover's chrome, and recomputing would delete
			// the port the moment someone reaches for it.
			if (this.overlay.contains(event.target)) return;
			const cellNode = event.target.closest?.("[data-cell][data-kind='vertex']");
			const id = cellNode?.getAttribute("data-cell") ?? null;
			if (id !== this.hover) {
				this.hover = id;
				this.renderOverlay();
			}
			return;
		}
		switch (this.gesture.kind) {
			case "pan": {
				this.view.x = this.gesture.view.x + (event.clientX - this.gesture.origin.x);
				this.view.y = this.gesture.view.y + (event.clientY - this.gesture.origin.y);
				this.applyView();
				break;
			}
			case "move": {
				const dx = snap(at.x - this.gesture.origin.x);
				const dy = snap(at.y - this.gesture.origin.y);
				if (dx === 0 && dy === 0 && !this.gesture.moved) break;
				this.gesture.moved = true;
				for (const item of this.gesture.moving) {
					setCellGeometry(item.entry, { x: item.start.x + dx, y: item.start.y + dy });
				}
				this.scheduleRender();
				break;
			}
			case "resize": {
				const page = this.page;
				const entry = page.find(this.gesture.id);
				if (!entry) break;
				const next = resizeBox(this.gesture.start, this.gesture.corner, {
					x: snap(at.x - this.gesture.origin.x),
					y: snap(at.y - this.gesture.origin.y),
				});
				// The stored geometry is relative to the parent; the handles work in
				// absolute space, so only the delta is applied to what was stored.
				const stored = cellGeometry(entry);
				const box = this.boxes.get(this.gesture.id);
				setCellGeometry(entry, {
					x: stored.x + (next.x - box.x),
					y: stored.y + (next.y - box.y),
					width: next.width,
					height: next.height,
				});
				this.scheduleRender();
				break;
			}
			case "marquee": {
				this.gesture.current = at;
				this.drawMarquee();
				break;
			}
			case "connect": {
				this.gesture.current = at;
				this.gesture.over = this.vertexAt(event) ?? null;
				this.drawEdgePreview();
				break;
			}
			default:
				break;
		}
	}

	onPointerUp(event) {
		if (this.stage.hasPointerCapture?.(event.pointerId)) this.stage.releasePointerCapture(event.pointerId);
		const gesture = this.gesture;
		this.gesture = null;
		if (!gesture) return;
		switch (gesture.kind) {
			case "move": {
				if (!gesture.moved) break;
				this.emit(
					gesture.moving.map((item) => updateOp(item.entry)),
					`moved ${gesture.moving.length} shape(s)`,
				);
				break;
			}
			case "resize": {
				const entry = this.page.find(gesture.id);
				if (entry) this.emit([updateOp(entry)], "resized a shape");
				break;
			}
			case "marquee": {
				const selected = this.cellsWithin(gesture.origin, gesture.current);
				this.select(selected, { additive: gesture.additive });
				this.renderOverlay();
				break;
			}
			case "connect": {
				const target = this.vertexAt(event);
				this.createEdge(gesture.from, target, gesture.current);
				break;
			}
			default:
				break;
		}
		this.renderOverlay();
	}

	cancelGesture() {
		if (this.gesture?.kind === "move") {
			for (const item of this.gesture.moving) setCellGeometry(item.entry, item.start);
			this.render();
		}
		this.gesture = null;
		this.renderOverlay();
	}

	onWheel(event) {
		event.preventDefault();
		if (event.ctrlKey || event.metaKey || !event.shiftKey) {
			// Wheel zooms around the pointer, which is what every canvas tool does and
			// what makes zooming into a corner of a large diagram bearable.
			const factor = Math.exp(-event.deltaY / 400);
			this.zoomAround(event, factor);
			return;
		}
		this.view.x -= event.deltaX;
		this.view.y -= event.deltaY;
		this.applyView();
	}

	onDoubleClick(event) {
		// Not `event.target`: a pointer capture taken on the stage during the first
		// click of the double-click retargets the compatibility mouse events to the
		// stage itself, so the cell under the pointer has to be found by position.
		const cellNode = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-cell]");
		if (!cellNode) return;
		event.preventDefault();
		this.editLabel(cellNode.getAttribute("data-cell"));
	}

	// -------------------------------------------------------------- operations

	/** Send operations upward and re-render from the (already mutated) model. */
	emit(operations, label) {
		const usable = operations.filter(Boolean);
		if (usable.length === 0) return;
		this.render();
		this.onEdit(usable, label);
	}

	/** Insert a shape, centred on the viewport unless a position is given. */
	insert(kind, at) {
		const page = this.page;
		if (!page) return;
		const spec = INSERT_STYLES[kind] ?? INSERT_STYLES.rounded;
		const centre = at ?? this.viewportCentre();
		const id = this.doc.newCellId("s");
		const cell = element(
			"mxCell",
			{ id, value: spec.label, style: spec.style, vertex: "1", parent: DEFAULT_LAYER_ID },
			[
				element(
					"mxGeometry",
					{
						x: String(snap(centre.x - spec.width / 2)),
						y: String(snap(centre.y - spec.height / 2)),
						width: String(spec.width),
						height: String(spec.height),
						as: "geometry",
					},
					[],
				),
			],
		);
		page.root.children.push(cell);
		this.select([id]);
		this.emit([{ operation: "add", cell_id: id, new_xml: serializeXml(cell) }], `added a ${kind}`);
		return id;
	}

	/** Connect two shapes, or drop an edge's loose end at a point. */
	createEdge(sourceId, targetId, at) {
		const page = this.page;
		if (!page || !sourceId) return;
		if (targetId === sourceId) return;
		const id = this.doc.newCellId("e");
		const attrs = { id, value: "", style: EDGE_STYLE, edge: "1", parent: DEFAULT_LAYER_ID, source: sourceId };
		const geometry = element("mxGeometry", { relative: "1", as: "geometry" }, []);
		if (targetId) {
			attrs.target = targetId;
		} else {
			geometry.children.push(element("mxPoint", { x: String(snap(at.x)), y: String(snap(at.y)), as: "targetPoint" }, []));
		}
		const cell = element("mxCell", attrs, [geometry]);
		page.root.children.push(cell);
		this.select([id]);
		this.emit([{ operation: "add", cell_id: id, new_xml: serializeXml(cell) }], "connected two shapes");
	}

	/** Delete the selection. The server takes descendants and attached edges too. */
	deleteSelection() {
		const ids = [...this.selection];
		if (ids.length === 0) return;
		const page = this.page;
		const doomed = new Set(ids);
		for (const entry of page.cells()) {
			if (!isEdge(entry)) continue;
			const { source, target } = entry.cell.attrs;
			if ((source && doomed.has(source)) || (target && doomed.has(target))) doomed.add(cellId(entry));
		}
		page.root.children = page.root.children.filter((child) => {
			const id = child.attrs?.id;
			return !(id && doomed.has(id));
		});
		this.selection.clear();
		this.emit(ids.map((id) => ({ operation: "delete", cell_id: id })), `deleted ${ids.length} cell(s)`);
		this.onSelectionChange([]);
	}

	/** Duplicate the selection, offset so the copy is visible. */
	duplicateSelection() {
		const page = this.page;
		const operations = [];
		const added = [];
		for (const entry of this.selectedEntries()) {
			if (!isVertex(entry)) continue;
			const id = this.doc.newCellId("s");
			const clone = structuredClone(entry.node);
			clone.attrs.id = id;
			const geometry = cellGeometry(entry);
			const copy = { node: clone, cell: clone.name === "mxCell" ? clone : clone.children.find((child) => child.name === "mxCell") };
			setCellGeometry(copy, { x: geometry.x + GRID * 2, y: geometry.y + GRID * 2 });
			page.root.children.push(clone);
			operations.push({ operation: "add", cell_id: id, new_xml: serializeXml(clone) });
			added.push(id);
		}
		if (operations.length === 0) return;
		this.select(added);
		this.emit(operations, `duplicated ${operations.length} shape(s)`);
	}

	/** Nudge the selection by whole grid steps. */
	nudge(dx, dy) {
		const entries = this.selectedEntries().filter(isVertex);
		if (entries.length === 0) return;
		for (const entry of entries) {
			const geometry = cellGeometry(entry);
			setCellGeometry(entry, { x: geometry.x + dx, y: geometry.y + dy });
		}
		this.emit(entries.map(updateOp), "nudged");
	}

	/** Apply a style change to every selected cell. */
	restyle(changes) {
		const entries = this.selectedEntries();
		if (entries.length === 0) return false;
		for (const entry of entries) {
			let style = entry.cell.attrs.style ?? "";
			for (const [key, value] of Object.entries(changes)) style = withStyleKey(style, key, value);
			entry.cell.attrs.style = style;
		}
		this.emit(entries.map(updateOp), "restyled");
		return true;
	}

	/** The style of the single selected cell, for the toolbar to reflect. */
	selectionStyle() {
		const entries = this.selectedEntries();
		if (entries.length !== 1) return null;
		return parseStyle(entries[0].cell.attrs.style);
	}

	// ------------------------------------------------------------ label editing

	/**
	 * Edit a label in place.
	 *
	 * A textarea over the shape rather than SVG text editing: `contenteditable`
	 * on a `<text>` node gives no wrapping, no caret in Firefox, and no way to
	 * type a newline. The label is round-tripped as plain text, and re-encoded
	 * with `<br>` when the cell is an HTML label, which is what draw.io reads.
	 */
	editLabel(id) {
		const page = this.page;
		const entry = page?.find(id);
		const box = this.boxes.get(id);
		if (!entry || !box) return;
		const area = this.labelEditor.querySelector("textarea");
		const rect = this.stage.getBoundingClientRect();
		const point = (x, y) => {
			const svgPoint = this.stage.createSVGPoint();
			svgPoint.x = x;
			svgPoint.y = y;
			return svgPoint.matrixTransform(this.scene.getScreenCTM());
		};
		const isEdgeLabel = isEdge(entry);
		const topLeft = isEdgeLabel ? point(box.geometry.x || 0, box.geometry.y || 0) : point(box.x, box.y);
		const size = isEdgeLabel ? { width: 160, height: 40 } : { width: box.width * this.view.scale, height: box.height * this.view.scale };
		const centre = isEdgeLabel ? edgeLabelAnchor(entry, this.boxes, point) : null;

		this.labelEditor.hidden = false;
		this.labelEditor.style.left = `${(centre?.x ?? topLeft.x) - rect.left - (centre ? size.width / 2 : 0)}px`;
		this.labelEditor.style.top = `${(centre?.y ?? topLeft.y) - rect.top - (centre ? size.height / 2 : 0)}px`;
		area.style.width = `${Math.max(80, size.width)}px`;
		area.style.height = `${Math.max(28, size.height)}px`;
		area.value = plainLabel(cellLabel(entry));
		area.focus();
		area.select();

		const finish = (commit) => {
			area.onblur = null;
			area.onkeydown = null;
			this.labelEditor.hidden = true;
			if (!commit) return;
			const next = area.value;
			const html = (entry.cell.attrs.style ?? "").includes("html=1");
			const encoded = html ? escapeHtml(next).replaceAll("\n", "<br>") : next;
			if (entry.node !== entry.cell && entry.node.attrs.label !== undefined) entry.node.attrs.label = encoded;
			else entry.cell.attrs.value = encoded;
			this.emit([updateOp(entry)], "edited a label");
		};
		area.onblur = () => finish(true);
		area.onkeydown = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				finish(false);
			} else if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				finish(true);
			}
		};
	}

	// -------------------------------------------------------------------- view

	applyView() {
		this.scene.setAttribute("transform", `translate(${this.view.x},${this.view.y}) scale(${this.view.scale})`);
		this.onViewChange(this.view);
	}

	zoomAround(event, factor) {
		const before = this.toScene(event);
		this.view.scale = Math.min(4, Math.max(0.1, this.view.scale * factor));
		this.applyView();
		const after = this.toScene(event);
		this.view.x += (after.x - before.x) * this.view.scale;
		this.view.y += (after.y - before.y) * this.view.scale;
		this.applyView();
		this.renderOverlay();
	}

	zoomBy(factor) {
		const rect = this.stage.getBoundingClientRect();
		this.zoomAround({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }, factor);
	}

	/** Frame the page's contents, or sit at origin when there are none. */
	fit() {
		const page = this.page;
		if (!page) return;
		this.boxes = layoutPage(page);
		const bounds = pageBounds(page, this.boxes, 40);
		const rect = this.stage.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		const scale = Math.min(2, Math.max(0.1, Math.min(rect.width / bounds.width, rect.height / bounds.height)));
		this.view.scale = scale;
		this.view.x = rect.width / 2 - (bounds.x + bounds.width / 2) * scale;
		this.view.y = rect.height / 2 - (bounds.y + bounds.height / 2) * scale;
		this.applyView();
		this.renderOverlay();
	}

	viewportCentre() {
		const rect = this.stage.getBoundingClientRect();
		return this.toScene({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
	}

	// ----------------------------------------------------------------- helpers

	scheduleRender() {
		if (this.frame) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = null;
			this.render();
		});
	}

	drawMarquee() {
		const { origin, current } = this.gesture;
		this.renderOverlay();
		this.overlay.append(
			svgNode("rect", {
				class: "marquee",
				x: Math.min(origin.x, current.x),
				y: Math.min(origin.y, current.y),
				width: Math.abs(current.x - origin.x),
				height: Math.abs(current.y - origin.y),
			}),
		);
	}

	drawEdgePreview() {
		const from = this.boxes.get(this.gesture.from);
		if (!from) return;
		this.renderOverlay();
		const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
		this.overlay.append(
			svgNode("path", { class: "edge-preview", d: `M ${start.x},${start.y} L ${this.gesture.current.x},${this.gesture.current.y}` }),
		);
		const over = this.gesture.over ? this.boxes.get(this.gesture.over) : null;
		if (over) {
			this.overlay.append(
				svgNode("rect", { class: "drop-target", x: over.x - 3, y: over.y - 3, width: over.width + 6, height: over.height + 6, rx: 3 }),
			);
		}
	}

	/** The vertex under the pointer, ignoring the overlay that sits above it. */
	vertexAt(event) {
		const previous = this.overlay.style.pointerEvents;
		this.overlay.style.pointerEvents = "none";
		const target = document.elementFromPoint(event.clientX, event.clientY);
		this.overlay.style.pointerEvents = previous;
		const cellNode = target?.closest?.("[data-cell][data-kind='vertex']");
		return cellNode?.getAttribute("data-cell") ?? null;
	}

	cellsWithin(a, b) {
		const left = Math.min(a.x, b.x);
		const right = Math.max(a.x, b.x);
		const top = Math.min(a.y, b.y);
		const bottom = Math.max(a.y, b.y);
		const found = [];
		for (const entry of this.page.drawable()) {
			const box = this.boxes.get(cellId(entry));
			if (!box) continue;
			if (isVertex(entry) && box.x >= left && box.y >= top && box.x + box.width <= right && box.y + box.height <= bottom) {
				found.push(cellId(entry));
			}
		}
		return found;
	}
}

/** An `update` operation carrying a cell's current XML. */
function updateOp(entry) {
	return { operation: "update", cell_id: cellId(entry), new_xml: serializeXml(entry.node) };
}

function handlePositions(box) {
	const { x, y, width: w, height: h } = box;
	return [
		["nw", x, y],
		["n", x + w / 2, y],
		["ne", x + w, y],
		["e", x + w, y + h / 2],
		["se", x + w, y + h],
		["s", x + w / 2, y + h],
		["sw", x, y + h],
		["w", x, y + h / 2],
	];
}

function portPositions(box) {
	const { x, y, width: w, height: h } = box;
	const out = 0;
	return [
		["n", x + w / 2, y - out],
		["e", x + w + out, y + h / 2],
		["s", x + w / 2, y + h + out],
		["w", x - out, y + h / 2],
	];
}

/** Apply a resize delta to the grabbed corner, keeping the opposite one fixed. */
function resizeBox(start, corner, delta) {
	let { x, y, width, height } = start;
	if (corner.includes("n")) {
		y += delta.y;
		height -= delta.y;
	}
	if (corner.includes("s")) height += delta.y;
	if (corner.includes("w")) {
		x += delta.x;
		width -= delta.x;
	}
	if (corner.includes("e")) width += delta.x;
	if (width < MIN_SIZE) {
		if (corner.includes("w")) x = start.x + start.width - MIN_SIZE;
		width = MIN_SIZE;
	}
	if (height < MIN_SIZE) {
		if (corner.includes("n")) y = start.y + start.height - MIN_SIZE;
		height = MIN_SIZE;
	}
	return { x, y, width, height };
}

/** Where to float the editor for an edge's label: the middle of the edge. */
function edgeLabelAnchor(entry, boxes, toScreen) {
	const source = boxes.get(entry.cell.attrs.source ?? "");
	const target = boxes.get(entry.cell.attrs.target ?? "");
	const geometry = cellGeometry(entry);
	const a = source ? { x: source.x + source.width / 2, y: source.y + source.height / 2 } : geometry.sourcePoint;
	const b = target ? { x: target.x + target.width / 2, y: target.y + target.height / 2 } : geometry.targetPoint;
	if (!a || !b) return null;
	return toScreen((a.x + b.x) / 2, (a.y + b.y) / 2);
}

/** An HTML label as editable plain text. */
function plainLabel(value) {
	return String(value ?? "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function escapeHtml(value) {
	return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function svgNode(name, attrs) {
	const node = document.createElementNS("http://www.w3.org/2000/svg", name);
	for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
	return node;
}

/** CSS.escape, with a fallback for the attribute-selector lookups above. */
function cssEscape(value) {
	return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
}
