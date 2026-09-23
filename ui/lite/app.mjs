/**
 * The page: state sync, chrome, and the keyboard.
 *
 * The editing itself is in `editor.mjs`. This file is what makes the surface
 * *shared*: it holds the version the page has seen, sends the person's
 * operations, and applies the agent's the moment they land.
 *
 * Live updates come over Server-Sent Events. The rule is simple enough to keep
 * in your head, which matters because getting it wrong looks like lost work:
 *
 *   - the page mutates its model first and sends the operation after, so
 *     dragging is never gated on a round trip;
 *   - any change event carrying a newer version than the page has causes a full
 *     reload of the document from the server, which is the authority;
 *   - a reload keeps the viewport and the selection, and flashes whatever the
 *     agent touched, so the person can see what moved and why.
 */

import { DrawioDocument } from "../../lib/model.mjs";
import { renderOptions, renderPageSvg } from "../../lib/render.mjs";
import { Editor } from "./editor.mjs";

/**
 * Every request is made relative to the document's base URL, which carries the
 * capability token as its first path segment (see `lib/server.mjs`). Nothing
 * here needs to know the token exists, and nothing has to remember to attach it.
 */
const api = (route) => new URL(route, document.baseURI);

const $ = (id) => document.getElementById(id);
const stage = $("stage");

const state = {
	version: 0,
	doc: null,
	filePath: null,
	pages: [],
};

const editor = new Editor({
	stage,
	scene: $("scene"),
	content: $("content"),
	overlay: $("overlay"),
	labelEditor: $("label-editor"),
	onEdit: (operations, label) => sendOperations(operations, label),
	onSelectionChange: () => reflectSelection(),
});

// ------------------------------------------------------------------ transport

async function apiJson(route, options = {}) {
	const response = await fetch(api(route), {
		...options,
		headers: options.body ? { "Content-Type": "application/json" } : undefined,
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
	return body;
}

/**
 * Pull the document and show it.
 *
 * `touched` and `source` come from the change event rather than the state, so a
 * reload triggered by the agent can say what it was and a reload triggered by a
 * page tab switch says nothing at all.
 */
async function reload({ touched = [], source = null, keepView = true } = {}) {
	const payload = await apiJson("api/state");
	state.version = payload.version;
	state.filePath = payload.filePath;
	state.pages = payload.pages;
	state.doc = DrawioDocument.parse(payload.xml);
	editor.setDocument(state.doc, { keepView });
	renderTabs();
	if (source === "agent" && touched.length > 0) editor.flash(touched);
	updateStatus(source === "agent" ? "the agent edited the diagram" : null, source === "agent" ? "agent" : "");
	updateEmptyHint();
}

/** Send the person's operations. On refusal, the server's document wins. */
async function sendOperations(operations, label) {
	const page = editor.page;
	updateStatus("saving…");
	try {
		const result = await apiJson("api/ops", {
			method: "POST",
			body: JSON.stringify({ page: page ? { page_id: page.id } : {}, operations, label }),
		});
		state.version = result.version;
		if (result.errors?.length > 0) {
			toast(result.errors.map((error) => error.message).join("; "), "error");
			await reload();
		}
		updateStatus(label ? `${label} · v${result.version}` : `v${result.version}`);
	} catch (cause) {
		toast(`Could not save: ${cause.message}`, "error");
		await reload();
	}
	updateEmptyHint();
}

/**
 * Listen for the agent's changes.
 *
 * `EventSource` reconnects on its own, and the server sends `retry: 1000`, so a
 * dropped stream heals without the page knowing. The one case worth handling
 * explicitly is a *reconnect after a missed change*: the hello event carries the
 * current version, and any version newer than the page's triggers a reload.
 */
function listen() {
	const stream = new EventSource(api("api/events"));
	stream.addEventListener("hello", (event) => {
		const data = JSON.parse(event.data);
		if (data.version > state.version) void reload();
		updateStatus("connected");
	});
	stream.addEventListener("change", (event) => {
		const data = JSON.parse(event.data);
		if (data.version <= state.version) return;
		void reload({ touched: data.touched ?? [], source: data.source });
	});
	stream.addEventListener("error", () => updateStatus("reconnecting…"));
}

// --------------------------------------------------------------------- chrome

function renderTabs() {
	const tabs = $("tabs");
	tabs.replaceChildren();
	for (const page of state.pages) {
		const button = document.createElement("button");
		button.className = "tab";
		button.type = "button";
		button.textContent = page.name;
		button.setAttribute("aria-selected", String(page.id === editor.pageId));
		button.title = `${page.shapes ?? 0} shapes, ${page.edges ?? 0} connectors — double-click to rename`;
		button.addEventListener("click", () => {
			editor.setDocument(state.doc, { pageId: page.id, keepView: false });
			renderTabs();
			updateEmptyHint();
		});
		button.addEventListener("dblclick", () => renamePage(page));
		tabs.append(button);
	}
}

function reflectSelection() {
	const parsed = editor.selectionStyle();
	if (!parsed) return;
	const fill = parsed.keys.fillColor;
	const stroke = parsed.keys.strokeColor;
	if (fill && fill.startsWith("#")) {
		$("fill-color").value = fill;
		$("fill-face").style.background = fill;
	}
	if (stroke && stroke.startsWith("#")) {
		$("stroke-color").value = stroke;
		$("stroke-face").style.borderColor = stroke;
	}
}

let statusTimer = null;
function updateStatus(message, kind = "") {
	const status = $("status");
	if (message) {
		status.textContent = message;
		status.className = `status ${kind}`;
		clearTimeout(statusTimer);
		statusTimer = setTimeout(() => {
			status.textContent = `v${state.version}${state.filePath ? ` · ${state.filePath}` : ""}`;
			status.className = "status";
		}, 3000);
		return;
	}
	status.textContent = `v${state.version}${state.filePath ? ` · ${state.filePath}` : ""}`;
	status.className = `status ${kind}`;
}

function updateEmptyHint() {
	const page = editor.page;
	$("empty-hint").hidden = !page || page.drawable().length > 0;
}

function toast(message, kind = "") {
	const node = document.createElement("div");
	node.className = `toast ${kind}`;
	node.textContent = message;
	$("toasts").append(node);
	setTimeout(() => node.remove(), 5200);
}

/**
 * A modal for the three things that need one: a filename, a page name, and the
 * history strip.
 *
 * `prompt()` would do two of them in one line, but it is blocked in some
 * embedded browsers and cannot show a thumbnail grid, so one small sheet serves
 * all three rather than a dialog per feature.
 */
function sheet({ title, body, confirmLabel = "OK", onConfirm }) {
	const element = $("sheet");
	$("sheet-title").textContent = title;
	const content = $("sheet-content");
	content.replaceChildren(body);
	$("sheet-confirm").textContent = confirmLabel;
	element.hidden = false;
	const close = () => {
		element.hidden = true;
		$("sheet-confirm").onclick = null;
		$("sheet-cancel").onclick = null;
	};
	$("sheet-cancel").onclick = close;
	$("sheet-confirm").onclick = async () => {
		try {
			await onConfirm();
			close();
		} catch (cause) {
			toast(cause.message, "error");
		}
	};
	content.querySelector("input,select")?.focus();
	return close;
}

function field(labelText, node) {
	const wrap = document.createElement("div");
	wrap.className = "field";
	const label = document.createElement("label");
	label.textContent = labelText;
	wrap.append(label, node);
	return wrap;
}

function textInput(value = "", placeholder = "") {
	const input = document.createElement("input");
	input.type = "text";
	input.value = value;
	input.placeholder = placeholder;
	input.spellcheck = false;
	return input;
}

// ----------------------------------------------------------------- page chrome

function renamePage(page) {
	const input = textInput(page.name);
	sheet({
		title: "Rename page",
		body: field("Name", input),
		confirmLabel: "Rename",
		onConfirm: async () => {
			await apiJson("api/pages", { method: "POST", body: JSON.stringify({ op: "rename", page_id: page.id, name: input.value.trim() }) });
			await reload();
		},
	});
}

async function addPage() {
	const result = await apiJson("api/pages", { method: "POST", body: JSON.stringify({ op: "add", name: `Page-${state.pages.length + 1}` }) });
	await reload();
	editor.setDocument(state.doc, { pageId: result.page.id, keepView: false });
	renderTabs();
	updateEmptyHint();
}

// ---------------------------------------------------------------------- files

function openFileSheet() {
	const input = textInput(state.filePath ?? "", "docs/architecture.drawio");
	sheet({
		title: "Open a diagram from the workspace",
		body: field("Workspace-relative path", input),
		confirmLabel: "Open",
		onConfirm: async () => {
			const result = await apiJson("api/file", { method: "POST", body: JSON.stringify({ op: "open", path: input.value.trim() }) });
			await reload({ keepView: false });
			toast(result.inflatedPages > 0 ? `Opened ${result.opened} (decompressed ${result.inflatedPages} page(s))` : `Opened ${result.opened}`);
		},
	});
}

function saveFileSheet() {
	const input = textInput(state.filePath ?? "diagram.drawio", "docs/architecture.drawio");
	sheet({
		title: "Save into the workspace",
		body: field("Workspace-relative path (.drawio, .xml or .svg)", input),
		confirmLabel: "Save",
		onConfirm: async () => {
			const result = await apiJson("api/file", { method: "POST", body: JSON.stringify({ op: "save", path: input.value.trim() }) });
			state.filePath = result.saved;
			updateStatus(`saved ${result.saved}`);
			toast(`Saved ${result.saved} (${result.bytes} bytes)`);
		},
	});
}

/** Download a copy through the browser, for when the file belongs somewhere else. */
function downloadSheet() {
	const select = document.createElement("select");
	for (const [value, label] of [
		["drawio", "draw.io document (.drawio)"],
		["svg", "Picture of this page (.svg)"],
		["png", "Picture of this page (.png)"],
	]) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = label;
		select.append(option);
	}
	const name = textInput((state.filePath ?? "diagram").replace(/\.[^.]+$/, "").split("/").pop());
	sheet({
		title: "Download a copy",
		body: (() => {
			const wrap = document.createElement("div");
			wrap.append(field("Format", select), field("File name", name));
			return wrap;
		})(),
		confirmLabel: "Download",
		onConfirm: async () => {
			const base = name.value.trim() || "diagram";
			if (select.value === "drawio") {
				download(`${base}.drawio`, new Blob([state.doc.toXml()], { type: "application/xml" }));
				return;
			}
			const svg = renderPageSvg(editor.page, renderOptions());
			if (select.value === "svg") {
				download(`${base}.svg`, new Blob([svg], { type: "image/svg+xml" }));
				return;
			}
			download(`${base}.png`, await svgToPng(svg));
		},
	});
}

function download(filename, blob) {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

/**
 * Rasterize the rendered SVG in the browser.
 *
 * PNG is the one export the extension cannot produce on its own — rasterizing
 * in Node would need a dependency, and this canvas has none — so it is offered
 * here, where a canvas element is already sitting in the platform, and not as an
 * agent action that would have to lie about being available.
 */
function svgToPng(svg, scale = 2) {
	return new Promise((resolve, reject) => {
		const image = new Image();
		const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
		image.onload = () => {
			const canvas = document.createElement("canvas");
			canvas.width = image.width * scale;
			canvas.height = image.height * scale;
			const context = canvas.getContext("2d");
			context.fillStyle = "#ffffff";
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.drawImage(image, 0, 0, canvas.width, canvas.height);
			URL.revokeObjectURL(url);
			canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not rasterize the diagram."))), "image/png");
		};
		image.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Could not rasterize the diagram."));
		};
		image.src = url;
	});
}

// -------------------------------------------------------------------- history

async function historySheet() {
	const { versions } = await apiJson("api/history");
	const grid = document.createElement("div");
	grid.className = "versions";
	let chosen = null;
	if (versions.length === 0) {
		grid.textContent = "No earlier versions yet.";
	}
	for (const version of versions) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "version";
		button.setAttribute("aria-pressed", "false");
		const image = document.createElement("img");
		const thumbnail = api("api/history/svg");
		thumbnail.searchParams.set("version", String(version.version));
		thumbnail.searchParams.set("page", String(state.pages.findIndex((page) => page.id === editor.pageId)));
		image.src = thumbnail.toString();
		image.alt = `Version ${version.version}`;
		const caption = document.createElement("div");
		caption.textContent = `v${version.version} — ${version.label || "change"}`;
		const who = document.createElement("div");
		who.className = `who ${version.source}`;
		who.textContent = `${version.source} · ${new Date(version.at).toLocaleTimeString()}`;
		button.append(image, caption, who);
		button.addEventListener("click", () => {
			chosen = version.version;
			for (const other of grid.querySelectorAll(".version")) other.setAttribute("aria-pressed", "false");
			button.setAttribute("aria-pressed", "true");
		});
		grid.append(button);
	}
	sheet({
		title: "Version history",
		body: grid,
		confirmLabel: "Restore",
		onConfirm: async () => {
			if (chosen === null) throw new Error("Pick a version first.");
			await apiJson("api/restore", { method: "POST", body: JSON.stringify({ version: chosen }) });
			await reload();
			toast(`Restored version ${chosen}`);
		},
	});
}

/** Undo: restore the version before the current one, whoever made it. */
async function undo() {
	const { versions } = await apiJson("api/history");
	const previous = versions[0];
	if (!previous) {
		toast("Nothing to undo yet.");
		return;
	}
	await apiJson("api/restore", { method: "POST", body: JSON.stringify({ version: previous.version }) });
	await reload();
	toast(`Undid "${previous.label || "change"}"`);
}

// --------------------------------------------------------------------- wiring

for (const button of document.querySelectorAll("[data-insert]")) {
	button.addEventListener("click", () => editor.insert(button.getAttribute("data-insert")));
}

$("fill-color").addEventListener("input", (event) => {
	$("fill-face").style.background = event.target.value;
	editor.restyle({ fillColor: event.target.value });
});
$("stroke-color").addEventListener("input", (event) => {
	$("stroke-face").style.borderColor = event.target.value;
	editor.restyle({ strokeColor: event.target.value });
});
$("style-none").addEventListener("click", () => editor.restyle({ fillColor: "none" }));
$("style-bold").addEventListener("click", () => {
	const parsed = editor.selectionStyle();
	const bold = parsed && (Number.parseInt(parsed.keys.fontStyle ?? "0", 10) & 1) === 1;
	editor.restyle({ fontStyle: bold ? "0" : "1" });
});
$("style-dashed").addEventListener("click", () => {
	const parsed = editor.selectionStyle();
	editor.restyle({ dashed: parsed?.keys.dashed === "1" ? "0" : "1" });
});

$("zoom-in").addEventListener("click", () => editor.zoomBy(1.2));
$("zoom-out").addEventListener("click", () => editor.zoomBy(1 / 1.2));
$("zoom-fit").addEventListener("click", () => editor.fit());
$("add-page").addEventListener("click", () => void addPage());
$("open-file").addEventListener("click", openFileSheet);
$("save-file").addEventListener("click", saveFileSheet);
$("download").addEventListener("click", downloadSheet);
$("history").addEventListener("click", () => void historySheet());

/**
 * Keyboard shortcuts.
 *
 * Deliberately the ones draw.io itself uses, because anyone opening this has
 * muscle memory from there and a canvas that rebinds Delete is worse than one
 * with no shortcuts at all.
 */
addEventListener("keydown", (event) => {
	if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
	if (!$("sheet").hidden) {
		if (event.key === "Escape") $("sheet-cancel").click();
		return;
	}
	const modifier = event.ctrlKey || event.metaKey;
	if (modifier && event.key.toLowerCase() === "z") {
		event.preventDefault();
		void undo();
		return;
	}
	if (modifier && event.key.toLowerCase() === "d") {
		event.preventDefault();
		editor.duplicateSelection();
		return;
	}
	if (modifier) return;
	switch (event.key) {
		case "Delete":
		case "Backspace":
			event.preventDefault();
			editor.deleteSelection();
			break;
		case "Escape":
			editor.clearSelection();
			break;
		case "ArrowUp":
		case "ArrowDown":
		case "ArrowLeft":
		case "ArrowRight": {
			event.preventDefault();
			const step = event.shiftKey ? 10 : 1;
			const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
			const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
			editor.nudge(dx, dy);
			break;
		}
		case " ":
			editor.spaceDown = true;
			break;
		case "r":
			editor.insert("rounded");
			break;
		case "b":
			editor.insert("rectangle");
			break;
		case "e":
			editor.insert("ellipse");
			break;
		case "d":
			editor.insert("rhombus");
			break;
		case "t":
			editor.insert("text");
			break;
		case "f":
			editor.fit();
			break;
		case "F2": {
			const [first] = [...editor.selection];
			if (first) editor.editLabel(first);
			break;
		}
		default:
			break;
	}
});

addEventListener("keyup", (event) => {
	if (event.key === " ") editor.spaceDown = false;
});

addEventListener("resize", () => editor.renderOverlay());
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => editor.render());

reload({ keepView: false })
	.then(() => {
		listen();
		editor.fit();
	})
	.catch((cause) => {
		updateStatus(`could not load: ${cause.message}`);
		toast(`Could not load the diagram: ${cause.message}`, "error");
	});
