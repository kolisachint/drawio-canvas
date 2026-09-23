/**
 * The page around draw.io: it boots the editor, keeps it in sync with the
 * canvas, and does in the person's editor what the agent asks.
 *
 * draw.io runs unmodified in a same-origin frame, in its embed mode — the mode
 * made for hosting it, where the host owns the file — with `ui/capture.js`
 * handing this page the editor instance. From there, three jobs:
 *
 * **Out: the person's edits.** On every model change, draw.io's own
 * `diffPages` compares what was last synced with what the editor holds now —
 * the same diff draw.io uses for real-time collaboration — and the cells it
 * names are sent to the server. Only touched cells travel, so a cell the agent
 * changed a moment ago is never reverted by a stale copy (see `lib/sync.mjs`).
 *
 * **In: everyone else's.** When the server announces a version, the page diffs
 * the last version it merged against the new one and applies that patch with
 * draw.io's `patch`, which merges into whatever the person has on screen:
 * their selection, their scroll position, their undo history and any edit
 * they are in the middle of all survive, and so do their own changes to other
 * cells. Both directions run synchronously on the one event loop the two
 * frames share, so an edit cannot fall between a diff and a patch.
 *
 * **The agent's hands and eyes.** Screenshots, exports, focusing the person's
 * view and running draw.io's layouts are done here, in the real editor, on the
 * server's request (`rpc` events), because only the real editor draws AWS
 * icons, stencils and HTML labels the way draw.io does.
 */

const api = (route) => new URL(route, document.baseURI);
const $ = (id) => document.getElementById(id);

/** Embed-mode parameters: offline, no draw.io chrome for files, the host owns saving. */
const EDITOR_PARAMS = new URLSearchParams({
	embed: "1",
	proto: "json",
	spin: "1",
	libraries: "1",
	noSaveBtn: "1",
	noExitBtn: "1",
	saveAndExit: "0",
	offline: "1",
	stealth: "1",
	pwa: "0",
	configure: "0",
	lang: navigator.language?.split("-")[0] || "en",
});

async function apiJson(route, options = {}) {
	const response = await fetch(api(route), {
		...options,
		headers: options.body ? { "Content-Type": "application/json" } : undefined,
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		const error = new Error(body.error ?? `${response.status} ${response.statusText}`);
		error.code = body.code;
		throw error;
	}
	return body;
}

const post = (route, body) => apiJson(route, { method: "POST", body: JSON.stringify(body) });

function setStatus(text, kind = "") {
	const status = $("status");
	status.textContent = text;
	status.className = `status ${kind}`;
}

function setFile(filePath) {
	$("file").textContent = filePath || "untitled";
}

// ---------------------------------------------------------------- the bridge

/**
 * Two-way sync between one draw.io editor and the canvas server.
 *
 * `shadow` is the editor's pages as of the last sync in either direction;
 * whatever differs from it is the person's and has not been sent yet.
 * `serverXml` is the last server version merged in; the next version is
 * diffed against it.
 */
export class Bridge {
	constructor(win, ui, { xml, version }) {
		this.win = win;
		this.ui = ui;
		this.serverXml = xml;
		this.version = version;
		this.applying = false;
		this.origin = null;
		this.queue = Promise.resolve();
		this.inbound = Promise.resolve();
		/** Edits sent and not yet answered. Reconciliation waits for zero. */
		this.inFlight = 0;
		/** How many times the editor had drifted from the server and was put back. Diagnostics. */
		this.reconciled = 0;
		this.shadow = ui.clonePages(ui.pages);
		this.codec = new win.mxCodec();
		this.presenceTimer = null;

		const model = ui.editor.graph.model;
		const onChange = () => this.flush();
		model.addListener(win.mxEvent.CHANGE, onChange);
		for (const name of ["pageFormatChanged", "pageScaleChanged", "backgroundColorChanged", "backgroundImageChanged", "mathEnabledChanged", "gridEnabledChanged", "foldingEnabledChanged", "shadowVisibleChanged", "adaptiveColorsChanged"]) {
			ui.addListener(name, onChange);
		}
		ui.editor.graph.addListener("gridSizeChanged", onChange);

		const onView = () => this.schedulePresence();
		ui.editor.graph.getSelectionModel().addListener(win.mxEvent.CHANGE, onView);
		ui.editor.graph.view.addListener(win.mxEvent.SCALE, onView);
		ui.editor.graph.view.addListener(win.mxEvent.TRANSLATE, onView);
		ui.editor.addListener("pageSelected", onView);
		ui.editor.graph.container.addEventListener("scroll", onView, { passive: true });
		this.schedulePresence();
	}

	// ------------------------------------------------------------ outbound

	/** Send whatever the person changed since the last sync. Synchronous up to the POST. */
	flush() {
		if (this.applying) return;
		const current = this.ui.clonePages(this.ui.pages);
		const patch = this.ui.diffPages(this.shadow, current);
		if (isEmpty(patch)) return;
		this.shadow = current;
		let changes;
		try {
			changes = this.toChanges(patch);
		} catch (cause) {
			console.error("drawio-canvas: could not encode an edit", cause);
			this.resync("an edit could not be encoded");
			return;
		}
		if (changes.length === 0) return;
		const source = this.origin ?? "human";
		this.inFlight += 1;
		this.queue = this.queue.then(async () => {
			try {
				const result = await post("api/sync", { changes, source });
				if (result.errors?.length) {
					console.warn("drawio-canvas: server refused part of an edit", result.errors);
					await this.resync("the canvas refused part of an edit");
				}
			} catch (cause) {
				setStatus(`could not save an edit: ${cause.message}`, "error");
				await this.resync("an edit failed to reach the canvas");
			} finally {
				this.inFlight -= 1;
				// Once nothing is in flight, check the editor against the server.
				if (this.inFlight === 0) this.inbound = this.inbound.then(() => this.catchUp());
			}
		});
	}

	/** The live cell for an id on a page, current page or not. */
	cellOn(pageId, id) {
		const ui = this.ui;
		if (ui.currentPage?.getId() === pageId) return ui.editor.graph.model.getCell(id);
		const page = ui.getPageById(pageId);
		if (!page?.root) return null;
		const stack = [page.root];
		while (stack.length > 0) {
			const cell = stack.pop();
			if (cell.id === id) return cell;
			for (let i = 0; i < (cell.children?.length ?? 0); i += 1) stack.push(cell.children[i]);
		}
		return null;
	}

	encodeCell(cell) {
		return this.win.mxUtils.getXml(this.codec.encode(cell));
	}

	/** One page as a `<diagram>`, as draw.io would save it. */
	pageXml(pageId) {
		const doc = this.win.mxUtils.parseXml(this.ui.getFileData(true, null, null, null, true, false, null, null, null, true));
		const diagram = [...doc.documentElement.getElementsByTagName("diagram")].find((node) => node.getAttribute("id") === pageId);
		return diagram ? this.win.mxUtils.getXml(diagram) : null;
	}

	/** draw.io's page diff, as the change list `lib/sync.mjs` applies. */
	toChanges(patch) {
		const changes = [];
		for (const inserted of patch.i ?? []) {
			const xml = this.pageXml(inserted.id);
			if (xml) changes.push({ kind: "page-insert", page_id: inserted.id, xml, after: inserted.previous ?? "" });
		}
		for (const [pageId, diff] of Object.entries(patch.u ?? {})) {
			const update = { kind: "page-update", page_id: pageId };
			if (diff.name !== undefined) update.name = diff.name;
			if (diff.previous !== undefined) update.after = diff.previous;
			if (diff.view || diff.viewBox !== undefined) update.model = this.modelAttributes(pageId);
			if (Object.keys(update).length > 2) changes.push(update);
			const cells = diff.cells ?? {};
			// Parents whose child order changed: sent whole, see lib/sync.mjs.
			const reordered = new Set();
			for (const inserted of cells.i ?? []) {
				const cell = this.cellOn(pageId, inserted.id);
				if (cell) changes.push({ kind: "cell-upsert", page_id: pageId, cell_id: inserted.id, xml: this.encodeCell(cell), after: inserted.previous ?? "", inserted: true });
			}
			for (const [id, cellDiff] of Object.entries(cells.u ?? {})) {
				const cell = this.cellOn(pageId, id);
				if (!cell) continue;
				const change = { kind: "cell-upsert", page_id: pageId, cell_id: id, xml: this.encodeCell(cell) };
				if (cellDiff.previous !== undefined) {
					change.after = cellDiff.previous;
					if (cell.parent) reordered.add(cell.parent);
				}
				changes.push(change);
			}
			for (const id of cells.r ?? []) changes.push({ kind: "cell-remove", page_id: pageId, cell_id: id });
			for (const parent of reordered) {
				const children = [];
				for (let i = 0; i < parent.getChildCount(); i += 1) children.push(parent.getChildAt(i).id);
				changes.push({ kind: "cell-order", page_id: pageId, parent: parent.id, children });
			}
		}
		for (const pageId of patch.r ?? []) changes.push({ kind: "page-remove", page_id: pageId });
		return changes;
	}

	/** Page settings (grid, background, paper size, …) as `<mxGraphModel>` attributes. */
	modelAttributes(pageId) {
		const xml = this.pageXml(pageId);
		if (!xml) return {};
		const model = this.win.mxUtils.parseXml(xml).getElementsByTagName("mxGraphModel")[0];
		const attributes = {};
		for (const attribute of model?.attributes ?? []) {
			if (!["dx", "dy"].includes(attribute.name)) attributes[attribute.name] = attribute.value;
		}
		return attributes;
	}

	// ------------------------------------------------------------- inbound

	/** A server version was announced. Merges the latest, in order, never twice. */
	onServerChange(event) {
		this.inbound = this.inbound.then(async () => {
			if (event.version <= this.version) return;
			const state = await apiJson("api/state");
			if (state.version <= this.version) return;
			this.merge(state, event);
		});
		return this.inbound;
	}

	/** Merge whatever the server has, and reconcile if the editor is idle. */
	async catchUp() {
		const state = await apiJson("api/state");
		if (state.version > this.version) this.merge(state, {});
		else if (state.version === this.version) this.reconcile(state.xml);
	}

	/**
	 * Put the editor back on the server's document if the two have drifted.
	 *
	 * Diff-and-patch in both directions keeps the two sides in step while edits
	 * interleave, but it is not a proof: when both sides reorder and delete the
	 * same siblings at once, a "previous sibling" can point at a cell the other
	 * side just removed, and draw.io and the server resolve that differently —
	 * with no later diff ever mentioning those cells again. So whenever nothing
	 * the person did is still in flight, the editor is compared with the server,
	 * which is the authority, and any difference is patched away. Anything the
	 * person did has already been sent at that point, so nothing of theirs is
	 * lost; they may see a shape settle into its agreed position.
	 */
	reconcile(serverXml) {
		if (this.inFlight > 0 || this.applying) return false;
		const ui = this.ui;
		this.flush();
		if (this.inFlight > 0) return false;
		const drift = ui.diffPages(ui.clonePages(ui.pages), ui.getPagesForXml(serverXml));
		if (isEmpty(drift)) return false;
		this.applying = true;
		try {
			ui.getCurrentFile().patch([drift]);
		} finally {
			this.applying = false;
		}
		this.shadow = ui.clonePages(ui.pages);
		this.reconciled += 1;
		return true;
	}

	merge(state, event = {}) {
		// Anything the person did up to now goes out first, so the shadow the
		// patch lands on holds nothing unsent.
		this.flush();
		const ui = this.ui;
		const base = ui.getPagesForXml(this.serverXml);
		const next = ui.getPagesForXml(state.xml);
		const patch = ui.diffPages(base, next);
		this.applying = true;
		try {
			if (!isEmpty(patch)) ui.getCurrentFile().patch([patch]);
		} finally {
			this.applying = false;
		}
		this.shadow = ui.clonePages(ui.pages);
		this.serverXml = state.xml;
		this.version = state.version;
		this.reconcile(state.xml);
		setFile(state.filePath);
		if (event.source === "agent") {
			this.highlight(event.touched ?? []);
			const summary = event.summary ? `agent: ${event.summary}` : "the agent edited the diagram";
			$("peer").textContent = summary;
			$("peer").className = "peer agent";
			setStatus(`v${state.version}`, "");
		} else {
			setStatus(`v${state.version} saved`, "");
		}
	}

	/**
	 * Throw away the editor's view of the document and take the server's.
	 *
	 * The recovery path, for an edit the server could not apply: the two sides
	 * disagree, and the server is the authority. The person's last change may be
	 * lost; the status line says so rather than leaving them wondering.
	 */
	async resync(reason) {
		const state = await apiJson("api/state");
		const ui = this.ui;
		const next = ui.getPagesForXml(state.xml);
		const patch = ui.diffPages(ui.clonePages(ui.pages), next);
		this.applying = true;
		try {
			if (!isEmpty(patch)) ui.getCurrentFile().patch([patch]);
		} finally {
			this.applying = false;
		}
		this.shadow = ui.clonePages(ui.pages);
		this.serverXml = state.xml;
		this.version = state.version;
		setStatus(`re-synced: ${reason}`, "error");
	}

	/** Flash the cells the agent touched, once, so a change never appears unexplained. */
	highlight(ids) {
		const win = this.win;
		const graph = this.ui.editor.graph;
		const cells = ids.slice(0, 60).map((id) => graph.model.getCell(id)).filter(Boolean);
		for (const cell of cells) {
			const state = graph.view.getState(cell);
			if (!state) continue;
			const marker = new win.mxCellHighlight(graph, "#8250df", 3);
			marker.highlight(state);
			win.setTimeout(() => marker.destroy(), 1600);
		}
	}

	// ------------------------------------------------------------ presence

	schedulePresence() {
		clearTimeout(this.presenceTimer);
		this.presenceTimer = setTimeout(() => void post("api/presence", this.presence()).catch(() => {}), 400);
	}

	/** What the person is looking at, in diagram coordinates. */
	presence() {
		const ui = this.ui;
		const graph = ui.editor.graph;
		const view = graph.view;
		const container = graph.container;
		const s = view.scale;
		return {
			page_id: ui.currentPage?.getId() ?? null,
			page: ui.currentPage?.getName() ?? null,
			selection: graph.getSelectionCells().slice(0, 50).map((cell) => cell.id),
			viewport: {
				x: Math.round(container.scrollLeft / s - view.translate.x),
				y: Math.round(container.scrollTop / s - view.translate.y),
				width: Math.round(container.clientWidth / s),
				height: Math.round(container.clientHeight / s),
			},
			zoom: Math.round(s * 100) / 100,
		};
	}

	// ----------------------------------------------------- agent requests

	/** The graph to draw a page with: the live one, or a scratch graph for another page. */
	graphFor(pageId) {
		const ui = this.ui;
		if (!pageId || ui.currentPage?.getId() === pageId) return { graph: ui.editor.graph, dispose: () => {} };
		const page = ui.getPageById(pageId);
		if (!page) throw new Error(`No page "${pageId}" in the editor.`);
		ui.updatePageRoot(page);
		const graph = ui.createTemporaryGraph(ui.editor.graph.getStylesheet());
		graph.model.setRoot(page.root);
		if (page.viewState?.background) graph.background = page.viewState.background;
		return { graph, dispose: () => graph.destroy() };
	}

	cellsFor(graph, scope, ids) {
		if (scope === "selection") return graph === this.ui.editor.graph ? graph.getSelectionCells() : [];
		if (scope === "cells") return (ids ?? []).map((id) => graph.model.getCell(id)).filter(Boolean);
		if (scope === "viewport" && graph === this.ui.editor.graph) {
			const container = graph.container;
			return graph.getCells(container.scrollLeft, container.scrollTop, container.clientWidth, container.clientHeight);
		}
		return null;
	}

	/** A PNG of a page, a selection or some cells, as draw.io itself renders it. */
	screenshot({ page_id, scope = "page", cell_ids, scale = 1, border = 10, max_size = 2000 } = {}) {
		return new Promise((resolve, reject) => {
			const { graph, dispose } = this.graphFor(page_id);
			try {
				const cells = this.cellsFor(graph, scope, cell_ids);
				if (cells !== null && cells.length === 0) throw new Error(`Nothing to capture for scope "${scope}".`);
				const bounds = cells ? graph.getBoundingBoxFromGeometry(cells, true) : graph.getGraphBounds();
				const size = Math.max(bounds?.width ?? 1, bounds?.height ?? 1) / graph.view.scale;
				const fit = Math.min(scale, max_size / Math.max(1, size + 2 * border));
				this.ui.editor.exportToCanvas(
					(canvas) => {
						dispose();
						resolve({ png: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height, cells: cells?.length ?? null });
					},
					null,
					null,
					null,
					(error) => {
						dispose();
						reject(error instanceof Error ? error : new Error(String(error?.message ?? error)));
					},
					false,
					true,
					fit,
					false,
					false,
					null,
					graph,
					border,
					false,
					false,
					null,
					null,
					cells,
				);
			} catch (cause) {
				dispose();
				reject(cause);
			}
		});
	}

	/** An SVG of a page, images inlined and the diagram embedded, so draw.io can reopen it. */
	svg({ page_id, border = 10 } = {}) {
		return new Promise((resolve, reject) => {
			const { graph, dispose } = this.graphFor(page_id);
			try {
				const root = graph.getSvg(graph.background, 1, border, false, null, true);
				root.setAttribute("content", this.ui.getFileData(true, null, null, null, true, false, null, null, null, true));
				this.ui.editor.convertImages(root, (converted) => {
					dispose();
					resolve({ svg: `<?xml version="1.0" encoding="UTF-8"?>\n${this.win.mxUtils.getXml(converted)}` });
				});
			} catch (cause) {
				dispose();
				reject(cause);
			}
		});
	}

	/** Show the person something: switch page, select cells, scroll to them. */
	focus({ page_id, cell_ids = [], message } = {}) {
		const ui = this.ui;
		if (page_id && ui.currentPage?.getId() !== page_id) {
			const page = ui.getPageById(page_id);
			if (!page) throw new Error(`No page "${page_id}" in the editor.`);
			ui.selectPage(page);
		}
		const graph = ui.editor.graph;
		const cells = cell_ids.map((id) => graph.model.getCell(id)).filter(Boolean);
		if (cells.length > 0) {
			graph.setSelectionCells(cells);
			graph.scrollCellToVisible(cells[0], true);
			this.highlight(cell_ids);
		}
		if (message) {
			$("peer").textContent = `agent: ${message}`;
			$("peer").className = "peer agent";
		}
		return { page_id: ui.currentPage?.getId(), selected: cells.map((cell) => cell.id) };
	}

	/** Run one of draw.io's layouts; the moves sync back as the agent's edit. */
	layout({ page_id, layout, cell_ids } = {}) {
		return new Promise((resolve, reject) => {
			const ui = this.ui;
			try {
				if (page_id && ui.currentPage?.getId() !== page_id) this.focus({ page_id });
				const graph = ui.editor.graph;
				if (cell_ids?.length) graph.setSelectionCells(cell_ids.map((id) => graph.model.getCell(id)).filter(Boolean));
				this.origin = "agent";
				const done = () => {
					this.flush();
					this.origin = null;
					// Keep what moved in view: a layout that leaves the person looking at
					// empty canvas reads as the diagram having vanished.
					const cells = graph.getSelectionCount() > 0 ? graph.getSelectionCells() : graph.getChildCells(graph.getDefaultParent());
					const bounds = graph.getBoundingBox(cells);
					if (bounds) graph.scrollRectToVisible(bounds);
					resolve({ page_id: ui.currentPage?.getId(), layout });
				};
				ui.executeLayoutSpec(layout, done);
			} catch (cause) {
				this.origin = null;
				const presets = typeof this.win.ElkLayout !== "undefined" && this.win.ElkLayout.MENU_PRESETS ? Object.keys(this.win.ElkLayout.MENU_PRESETS) : [];
				reject(new Error(`${cause.message}${presets.length ? ` Presets: ${presets.join(", ")}.` : ""}`));
			}
		});
	}

	async handleRpc({ id, method, params }) {
		try {
			let result;
			if (method === "screenshot") result = await this.screenshot(params);
			else if (method === "svg") result = await this.svg(params);
			else if (method === "focus") result = this.focus(params);
			else if (method === "layout") result = await this.layout(params);
			else if (method === "presence") result = this.presence();
			else throw new Error(`Unknown request "${method}".`);
			await post("api/rpc", { id, result });
		} catch (cause) {
			await post("api/rpc", { id, error: cause?.message ?? String(cause) }).catch(() => {});
		}
	}
}

function isEmpty(patch) {
	return !patch || Object.keys(patch).length === 0;
}

// ------------------------------------------------------------------ the page

let bridge = null;
let lastState = null;

async function waitForEditor() {
	for (;;) {
		const status = await apiJson("api/editor").catch((cause) => ({ state: "failed", error: cause.message }));
		if (status.state === "ready") return status;
		const progress = $("loading-progress");
		if (status.state === "downloading") {
			$("loading-text").textContent = `Downloading draw.io ${status.version} (once, then cached)…`;
			progress.hidden = false;
			progress.max = status.total || 1;
			progress.value = status.received || 0;
		} else if (status.state === "failed") {
			$("loading-text").textContent = `draw.io ${status.version ?? ""} could not be prepared: ${status.error}`;
			$("loading-hint").innerHTML = "";
			const hint = document.createElement("span");
			hint.textContent = "Install it with `node scripts/install-drawio.mjs` in the canvas directory, or set DRAWIO_CANVAS_DRAWIO_DIR. Meanwhile the ";
			const link = document.createElement("a");
			link.href = "lite/";
			link.textContent = "built-in lite editor";
			$("loading-hint").append(hint, link, document.createTextNode(" works on the same document."));
			await new Promise((resolve) => setTimeout(resolve, 3000));
			continue;
		} else {
			$("loading-text").textContent = `Preparing draw.io ${status.version ?? ""}…`;
		}
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
}

/**
 * Put the person's draw.io preferences back before draw.io reads them.
 *
 * The frame is same-origin with this page, so they share `localStorage`; see
 * `lib/settings.mjs` for why a fresh port would otherwise mean fresh defaults.
 */
async function restoreSettings() {
	try {
		const saved = await apiJson("api/settings");
		for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
		return Object.keys(saved);
	} catch {
		return [];
	}
}

/** Send draw.io's preferences back whenever they change. */
function persistSettings(win) {
	const keys = [".drawio-config", ".configuration"];
	let last = JSON.stringify(keys.map((key) => localStorage.getItem(key)));
	const push = () => {
		const now = keys.map((key) => localStorage.getItem(key));
		const serialized = JSON.stringify(now);
		if (serialized === last) return;
		last = serialized;
		void fetch(api("api/settings"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(Object.fromEntries(keys.map((key, index) => [key, now[index]]))),
			keepalive: true,
		}).catch(() => {});
	};
	const settings = win.mxSettings;
	if (settings?.save) {
		const save = settings.save.bind(settings);
		settings.save = (...args) => {
			const result = save(...args);
			push();
			return result;
		};
	}
	setInterval(push, 5000);
	window.addEventListener("pagehide", push);
}

function startEditor() {
	const frame = $("editor");
	return new Promise((resolve) => {
		let ui = null;
		const onMessage = async (event) => {
			if (event.source !== frame.contentWindow || typeof event.data !== "string") return;
			let message;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			if (message.event === "init") {
				lastState = await apiJson("api/state");
				setFile(lastState.filePath);
				frame.contentWindow.postMessage(JSON.stringify({ action: "load", xml: lastState.xml, autosave: 0, title: lastState.filePath || "Draw.io Canvas" }), "*");
			} else if (message.event === "load") {
				ui = frame.contentWindow.drawioCanvasUi;
				resolve({ ui, win: frame.contentWindow });
			} else if (message.event === "save") {
				void saveToWorkspace();
			}
		};
		window.addEventListener("message", onMessage);
		frame.src = `drawio/index.html?${EDITOR_PARAMS}`;
		frame.hidden = false;
	});
}

function listen({ onConnected } = {}) {
	const events = new EventSource(api("api/events?role=editor"));
	events.addEventListener("change", (event) => void bridge?.onServerChange(JSON.parse(event.data)));
	events.addEventListener("rpc", (event) => void bridge?.handleRpc(JSON.parse(event.data)));
	events.addEventListener("hello", (event) => {
		// A reconnect after the server restarted (a canvas reload) or the laptop
		// slept: catch up on whatever was missed.
		const hello = JSON.parse(event.data);
		onConnected?.();
		if (bridge && hello.version !== bridge.version) void bridge.onServerChange({ version: hello.version });
		setStatus(bridge ? `v${hello.version}` : "connected");
	});
	events.onerror = () => setStatus("reconnecting…", "error");
}

// ------------------------------------------------------------ files & history

function sheet({ title, content, confirm = "OK" }) {
	return new Promise((resolve) => {
		$("sheet-title").textContent = title;
		const body = $("sheet-content");
		body.replaceChildren(content);
		$("sheet-confirm").textContent = confirm;
		$("sheet-confirm").hidden = confirm === null;
		$("sheet").hidden = false;
		const close = (value) => {
			$("sheet").hidden = true;
			$("sheet-confirm").onclick = null;
			$("sheet-cancel").onclick = null;
			resolve(value);
		};
		$("sheet-confirm").onclick = () => close(true);
		$("sheet-cancel").onclick = () => close(false);
		body.querySelector("input")?.focus();
	});
}

async function askPath(title, value) {
	const input = document.createElement("input");
	input.type = "text";
	input.value = value;
	input.placeholder = "docs/architecture.drawio";
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") $("sheet-confirm").click();
	});
	const ok = await sheet({ title, content: input });
	return ok ? input.value.trim() : null;
}

async function saveToWorkspace() {
	const state = await apiJson("api/state");
	let target = state.filePath;
	if (!target) target = await askPath("Save to the workspace", "diagram.drawio");
	if (!target) return;
	try {
		const result = await post("api/file", { op: "save", path: target });
		setFile(result.saved);
		setStatus(`saved ${result.saved}`);
	} catch (cause) {
		setStatus(cause.message, "error");
	}
}

async function openFromWorkspace() {
	const target = await askPath("Open from the workspace", "");
	if (!target) return;
	try {
		const result = await post("api/file", { op: "open", path: target });
		setStatus(`opened ${result.opened}`);
	} catch (cause) {
		setStatus(cause.message, "error");
	}
}

async function showHistory() {
	const { versions } = await apiJson("api/history");
	const list = document.createElement("div");
	for (const entry of versions) {
		const row = document.createElement("div");
		row.className = "history-row";
		const version = document.createElement("span");
		version.textContent = `v${entry.version}`;
		const who = document.createElement("span");
		who.className = `who ${entry.source}`;
		who.textContent = entry.source;
		const what = document.createElement("span");
		what.className = "what";
		what.textContent = entry.label || "";
		what.title = entry.label || "";
		const action = document.createElement("span");
		if (!entry.current) {
			const restore = document.createElement("button");
			restore.textContent = "Restore";
			restore.onclick = async () => {
				await post("api/restore", { version: entry.version });
				$("sheet-cancel").click();
				setStatus(`restored v${entry.version}`);
			};
			action.append(restore);
		} else {
			action.textContent = "current";
			action.className = "muted";
		}
		row.append(version, who, what, action);
		list.append(row);
	}
	await sheet({ title: "History", content: list, confirm: null });
}

$("save-file").addEventListener("click", () => void saveToWorkspace());
$("open-file").addEventListener("click", () => void openFromWorkspace());
$("history").addEventListener("click", () => void showHistory());

// ------------------------------------------------------------------ boot

/**
 * Tell the canvas a person is here and draw.io is on its way.
 *
 * The agent's editor requests (screenshot, focus, layout) used to fail with
 * no_editor for the seconds draw.io takes to start, which is exactly when an
 * agent reacting to "I opened it" asks for a screenshot. While this stream is
 * open the server holds such requests instead; it closes once the editor
 * stream is registered, or with the tab.
 */
const loadingStream = new EventSource(api("api/events?role=loading"));

async function boot() {
	await waitForEditor();
	$("loading").hidden = true;
	setStatus("loading draw.io…");
	await restoreSettings();
	const { ui, win } = await startEditor();
	persistSettings(win);
	bridge = new Bridge(win, ui, { xml: lastState.xml, version: lastState.version });
	setStatus(`v${lastState.version}`);
	// Ready means the server can reach this editor, not just that draw.io drew:
	// announce it once the editor stream is registered.
	await new Promise((resolve) =>
		listen({
			onConnected: () => {
				loadingStream.close();
				window.drawioCanvas = bridge;
				resolve();
			},
		}),
	);
	// Catch a version that landed between the state read and the stream opening.
	const state = await apiJson("api/state");
	if (state.version !== bridge.version) void bridge.onServerChange({ version: state.version });
}

boot().catch((cause) => {
	loadingStream.close();
	console.error(cause);
	setStatus(`failed to start: ${cause.message}`, "error");
});
