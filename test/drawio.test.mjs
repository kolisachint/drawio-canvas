/**
 * The real draw.io, in a real browser, with a real agent editing at the same
 * time.
 *
 * Everything here is the product as it runs: the pinned draw.io release served
 * by the canvas's loopback server, the page's sync bridge, and the agent's
 * actions invoked against the same instance. The person's edits are made
 * through draw.io's own graph API — the calls its mouse and keyboard handlers
 * make — so what is tested is the sync, not a simulation of it.
 *
 * Skipped unless `DRAWIO_CANVAS_PLAYWRIGHT` names a playwright install
 * (outside the repository — see `test/protocol.test.mjs`). draw.io itself comes
 * from the canvas's cache; run `node scripts/install-drawio.mjs` first, or let
 * the first test download it.
 *
 *   npm install --prefix /tmp/pw playwright
 *   DRAWIO_CANVAS_PLAYWRIGHT=/tmp/pw/node_modules/playwright node --test test/drawio.test.mjs
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { cellGeometry, cellId, DrawioDocument } from "../lib/model.mjs";
import { openCanvas, SAMPLE_XML } from "./harness.mjs";

const DRIVER = process.env.DRAWIO_CANVAS_PLAYWRIGHT;
const skip = DRIVER ? false : "set DRAWIO_CANVAS_PLAYWRIGHT to run the draw.io tests";

let playwright;
let browser;

before(async () => {
	if (skip) return;
	const specifier = DRIVER.endsWith(".js") || DRIVER.endsWith(".mjs") ? DRIVER : `${DRIVER.replace(/\/$/, "")}/index.js`;
	const module = await import(specifier);
	playwright = module.chromium ? module : module.default;
	browser = await playwright.chromium.launch({ executablePath: process.env.DRAWIO_CANVAS_CHROMIUM || undefined, args: ["--no-sandbox"] });
});

after(async () => {
	await browser?.close();
});

/** Open a canvas and the person's draw.io on it. */
async function session(input = { xml: SAMPLE_XML }) {
	const canvas = await openCanvas({ input });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	const problems = [];
	page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
	page.on("console", (message) => {
		if (message.type() === "error") problems.push(`console: ${message.text()}`);
	});
	page.on("request", (request) => {
		if (!request.url().startsWith("http://127.0.0.1:")) problems.push(`left the machine: ${request.url()}`);
	});
	await page.goto(canvas.url);
	await page.waitForFunction(() => window.drawioCanvas, null, { timeout: 180_000 });
	const frame = page.frame({ url: /drawio\/index\.html/ });
	/** Run a function in draw.io with the editor instance, as the person's input handlers would. */
	const person = (fn, arg) => frame.evaluate(`(${fn})(window.drawioCanvasUi, ${JSON.stringify(arg ?? null)})`);
	/** Wait until the page has nothing left to send or merge. */
	const settle = async () => {
		await page.waitForTimeout(150);
		await page.evaluate(async () => {
			await window.drawioCanvas.queue;
			await window.drawioCanvas.inbound;
		});
		await page.waitForTimeout(150);
		await page.evaluate(async () => {
			await window.drawioCanvas.queue;
			await window.drawioCanvas.inbound;
		});
	};
	return {
		canvas,
		page,
		frame,
		person,
		settle,
		problems,
		close: async () => {
			await page.close();
			await canvas.close();
		},
	};
}

/**
 * A document reduced to what a person can see and edit, per page and cell:
 * label, style, parent, terminals, geometry, and sibling order. Attribute order,
 * number formatting and viewport attributes are not content.
 */
function canonical(xml) {
	const doc = DrawioDocument.parse(xml);
	const pages = {};
	for (const page of doc.pages()) {
		const cells = {};
		const order = {};
		for (const entry of page.cells()) {
			const id = cellId(entry);
			const attrs = entry.cell.attrs;
			const geometry = cellGeometry(entry);
			const label = entry.node.attrs.label ?? entry.node.attrs.value ?? attrs.value ?? "";
			cells[id] = {
				label,
				style: attrs.style ?? "",
				parent: attrs.parent ?? "",
				source: attrs.source ?? "",
				target: attrs.target ?? "",
				kind: attrs.edge === "1" ? "edge" : attrs.vertex === "1" ? "vertex" : "",
				visible: attrs.visible ?? "1",
				geometry: attrs.edge === "1" ? null : [geometry.x, geometry.y, geometry.width, geometry.height].map((n) => Math.round(n)),
			};
			(order[attrs.parent ?? ""] ??= []).push(id);
		}
		pages[page.id] = { name: page.name, cells, order };
	}
	return pages;
}

async function editorXml(frame) {
	return frame.evaluate(() => window.drawioCanvasUi.getFileData(true, null, null, null, true, false, null, null, null, true));
}

describe("draw.io in the browser", { skip, timeout: 600_000 }, () => {
	it("boots the pinned draw.io offline, with the canvas's document", async () => {
		const s = await session();
		try {
			const cells = await s.person((ui) => Object.keys(ui.editor.graph.model.cells).sort());
			assert.deepEqual(cells, ["0", "1", "check", "link", "start"]);
			const version = await s.frame.evaluate(() => window.EditorUi.VERSION);
			assert.equal(version, "31.4.6");
			assert.deepEqual(s.problems, []);
		} finally {
			await s.close();
		}
	});

	/**
	 * "I opened it, what do you see?" is when an agent reaches for a screenshot,
	 * and it used to land in the seconds draw.io takes to boot and fail with
	 * no_editor. A tab that is open and loading now holds the request; no tab at
	 * all still fails at once, so nobody waits on a person who is not there.
	 */
	it("holds an editor request while the person's tab is loading, and fails fast with no tab", async () => {
		const canvas = await openCanvas({ input: { xml: SAMPLE_XML } });
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		try {
			const started = Date.now();
			await assert.rejects(() => canvas.invoke("focus", {}), (error) => error.code === "no_editor");
			assert.ok(Date.now() - started < 500, "with no tab open, no_editor should be immediate");
			await page.goto(canvas.url);
			// The page is up but draw.io has not booted yet: ask straight away.
			await page.waitForFunction(() => document.readyState !== "loading");
			assert.equal(await page.evaluate(() => Boolean(window.drawioCanvas)), false);
			const shot = await canvas.invoke("screenshot", {});
			assert.match(shot.note, /Rendered by the person's draw\.io/);
		} finally {
			await page.close();
			await canvas.close();
		}
	});

	it("tells the agent what the person did, in words", async () => {
		const s = await session();
		try {
			await s.canvas.invoke("get_diagram", {});
			await s.person((ui) => {
				const graph = ui.editor.graph;
				graph.model.beginUpdate();
				try {
					const start = graph.model.getCell("start");
					const geometry = start.geometry.clone();
					geometry.x = 400;
					graph.model.setGeometry(start, geometry);
					graph.insertVertex(graph.getDefaultParent(), "cache", "Cache", 40, 400, 120, 60, "shape=cylinder3;");
				} finally {
					graph.model.endUpdate();
				}
			});
			await s.settle();
			const { changes } = await s.canvas.invoke("get_changes", {});
			assert.ok(changes.some((line) => /human .*"Start" \[start\]: moved to \(400, 40\)/.test(line)), changes.join("\n"));
			assert.ok(changes.some((line) => /human .*added cylinder3 "Cache" \[cache\] at \(40, 400\)/.test(line)), changes.join("\n"));
		} finally {
			await s.close();
		}
	});

	it("merges the agent's edit into the editor without touching the person's work or undo", async () => {
		const s = await session();
		try {
			await s.canvas.invoke("get_diagram", {});
			// The person moves a shape; before that reaches the agent, the agent
			// relabels another one and adds a third.
			await s.person((ui) => {
				const graph = ui.editor.graph;
				const start = graph.model.getCell("start");
				const geometry = start.geometry.clone();
				geometry.y = 300;
				graph.model.setGeometry(start, geometry);
			});
			await s.canvas.invoke("edit_diagram", {
				operations: [
					{
						operation: "update",
						cell_id: "check",
						new_xml: '<mxCell value="Valid input?" style="rhombus;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="60" y="180" width="120" height="80" as="geometry"/></mxCell>',
					},
					{ operation: "add", cell_id: "done", new_xml: '<mxCell value="Done" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="300" y="180" width="120" height="60" as="geometry"/></mxCell>' },
				],
			});
			await s.settle();
			const editor = await s.person((ui) => {
				const model = ui.editor.graph.model;
				return { check: model.getCell("check").value, done: Boolean(model.getCell("done")), startY: model.getCell("start").geometry.y, undo: ui.editor.undoManager.history.length };
			});
			assert.deepEqual(editor, { check: "Valid input?", done: true, startY: 300, undo: 1 });
			// Undo is the person's: it takes back their move, not the agent's edit.
			await s.person((ui) => ui.editor.undoManager.undo());
			await s.settle();
			const afterUndo = await s.person((ui) => ({ startY: ui.editor.graph.model.getCell("start").geometry.y, check: ui.editor.graph.model.getCell("check").value }));
			assert.deepEqual(afterUndo, { startY: 40, check: "Valid input?" });
			assert.deepEqual(canonical(await editorXml(s.frame)), canonical(await stateXml(s.canvas)));
		} finally {
			await s.close();
		}
	});

	it("refuses the agent only on the cell the person is changing", async () => {
		const s = await session();
		try {
			await s.canvas.invoke("get_diagram", {});
			await s.person((ui) => ui.editor.graph.model.setValue(ui.editor.graph.model.getCell("check"), "Is it valid?"));
			await s.settle();
			const elsewhere = await s.canvas.invoke("edit_diagram", {
				operations: [{ operation: "add", cell_id: "note", new_xml: '<mxCell value="Note" style="shape=note;" vertex="1" parent="1"><mxGeometry x="400" y="400" width="100" height="60" as="geometry"/></mxCell>' }],
			});
			assert.equal(elsewhere.applied, 1);
			await assert.rejects(
				() =>
					s.canvas.invoke("edit_diagram", {
						operations: [{ operation: "update", cell_id: "check", new_xml: '<mxCell value="Valid?" style="rhombus;" vertex="1" parent="1"><mxGeometry x="60" y="180" width="120" height="80" as="geometry"/></mxCell>' }],
					}),
				(error) => error.code === "stale_cells" && /Is it valid\?/.test(error.message),
			);
		} finally {
			await s.close();
		}
	});

	it("converges when the person and the agent edit at the same time", async (t) => {
		const s = await session();
		try {
			await s.canvas.invoke("get_diagram", {});
			let seed = Number(process.env.DRAWIO_CANVAS_SEED ?? 7);
			const random = () => {
				seed = (seed * 1103515245 + 12345) % 2 ** 31;
				return seed / 2 ** 31;
			};
			const agentIds = [];
			for (let round = 0; round < Number(process.env.DRAWIO_CANVAS_ROUNDS ?? 25); round += 1) {
				const personOp = Math.floor(random() * 6);
				const agentOp = Math.floor(random() * 3);
				const x = Math.round(random() * 600);
				const y = Math.round(random() * 600);
				// The person's edit and the agent's are issued without waiting for
				// each other; whichever lands second must not undo the first.
				const personEdit = s.person(
					(ui, { op, round, x, y }) => {
						const graph = ui.editor.graph;
						const model = graph.model;
						const vertices = graph.getChildVertices(graph.getDefaultParent());
						const pick = vertices[round % Math.max(1, vertices.length)];
						if (op === 0 || !pick) {
							graph.insertVertex(graph.getDefaultParent(), `p${round}`, `Person ${round}`, x, y, 100, 50);
						} else if (op === 1) {
							const geometry = pick.geometry.clone();
							geometry.x = x;
							geometry.y = y;
							model.setGeometry(pick, geometry);
						} else if (op === 2) {
							model.setValue(pick, `Renamed ${round}`);
						} else if (op === 3) {
							graph.setCellStyles("fillColor", "#f8cecc", [pick]);
						} else if (op === 4) {
							graph.orderCells(false, [pick]);
						} else if (vertices.length > 4) {
							graph.removeCells([pick], true);
						}
					},
					{ op: personOp, round, x, y },
				);
				const agentEdit = (async () => {
					try {
						if (agentOp === 0 || agentIds.length === 0) {
							const id = `a${round}`;
							agentIds.push(id);
							await s.canvas.invoke("edit_diagram", {
								operations: [{ operation: "add", cell_id: id, new_xml: `<mxCell value="Agent ${round}" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="${y}" y="${x}" width="90" height="40" as="geometry"/></mxCell>` }],
							});
						} else {
							const id = agentIds[round % agentIds.length];
							await s.canvas.invoke("get_diagram", { cell_ids: [id] });
							await s.canvas.invoke("edit_diagram", {
								operations: [
									agentOp === 1
										? { operation: "update", cell_id: id, new_xml: `<mxCell value="Agent ${round} again" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="90" height="40" as="geometry"/></mxCell>` }
										: { operation: "delete", cell_id: id },
								],
							});
							if (agentOp === 2) agentIds.splice(agentIds.indexOf(id), 1);
						}
					} catch (error) {
						// A refusal (the person touched that cell, or deleted it) is the gate
						// doing its job; anything else is a failure.
						if (!["stale_cells", "all_operations_failed"].includes(error.code)) throw error;
						if (error.code === "all_operations_failed") agentIds.splice(0, agentIds.length);
					}
				})();
				await Promise.all([personEdit, agentEdit]);
				if (process.env.DRAWIO_CANVAS_DEBUG) {
					await s.settle();
					const e = canonical(await editorXml(s.frame));
					const v = canonical(await stateXml(s.canvas));
					if (JSON.stringify(e) !== JSON.stringify(v)) {
						const pid = Object.keys(v)[0];
						console.log(`DIVERGED at round ${round} person op ${personOp} agent op ${agentOp}`);
						console.log(" editor", JSON.stringify(e[pid].order["1"]));
						console.log(" server", JSON.stringify(v[pid].order["1"]));
						const journal = await s.canvas.invoke("get_changes", { since_version: 0, include_agent: true, limit: 200 });
						console.log(journal.changes.slice(-8).join("\n"));
						throw new Error("diverged");
					}
				}
			}
			await s.settle();
			const editor = canonical(await editorXml(s.frame));
			const server = canonical(await stateXml(s.canvas));
			assert.deepEqual(editor, server);
			assert.deepEqual(s.problems, []);
			// How often the idle check had to put the editor back; reported, not
			// asserted, because it depends on how the two sides happened to interleave.
			t.diagnostic(`editor reconciled with the server ${await s.page.evaluate(() => window.drawioCanvas.reconciled)} time(s)`);
		} finally {
			await s.close();
		}
	});

	it("keeps z-order, groups, pages and layers in step both ways", async () => {
		const s = await session();
		try {
			await s.canvas.invoke("get_diagram", {});
			await s.person((ui) => {
				const graph = ui.editor.graph;
				graph.orderCells(true, [graph.model.getCell("link")]);
				const group = graph.groupCells(null, 10, [graph.model.getCell("start"), graph.model.getCell("check")]);
				group.id && graph.setCellStyles("strokeColor", "#ff0000", [group]);
				ui.insertPage(null, 1).setName("Notes");
				ui.selectPage(ui.pages[0]);
			});
			await s.canvas.invoke("manage_layers", { op: "add", name: "Agent notes", layer_id: "agent-layer" });
			await s.canvas.invoke("manage_pages", { op: "add", name: "From agent" });
			await s.settle();
			const editor = canonical(await editorXml(s.frame));
			const server = canonical(await stateXml(s.canvas));
			assert.deepEqual(editor, server);
			const names = Object.values(server).map((page) => page.name);
			assert.deepEqual(names, ["Flow", "Notes", "From agent"]);
			const layers = await s.person((ui) => ui.editor.graph.model.root.children.map((layer) => layer.id));
			assert.ok(layers.includes("agent-layer"));
			const { layers: agentView } = await s.canvas.invoke("get_diagram", {});
			assert.equal(agentView.length, 2);
		} finally {
			await s.close();
		}
	});

	it("gives the agent library icons, screenshots and exports rendered by draw.io", async () => {
		const s = await session();
		try {
			await s.canvas.invoke("get_diagram", {});
			const { shapes } = await s.canvas.invoke("search_shapes", { query: "aws lambda" });
			assert.equal(shapes[0].id, "aws4Compute/lambda");
			await s.canvas.invoke("insert_shapes", { shapes: [{ shape_id: shapes[0].id, cell_id: "fn", x: 400, y: 60, label: "Resize" }] });
			await s.settle();
			const style = await s.person((ui) => ui.editor.graph.model.getCell("fn").style);
			assert.match(style, /resIcon=mxgraph\.aws4\.lambda/);

			const shot = await s.canvas.invoke("screenshot", {});
			const png = await readFile(path.join(s.canvas.workspace, shot.path));
			assert.equal(png.subarray(1, 4).toString(), "PNG");
			assert.ok(shot.width > 100 && shot.height > 50);

			await s.person((ui) => ui.editor.graph.setSelectionCells([ui.editor.graph.model.getCell("fn")]));
			const selection = await s.canvas.invoke("screenshot", { scope: "selection" });
			assert.ok(selection.width < shot.width);

			const svg = await s.canvas.invoke("save_file", { path: "out/flow.svg" });
			assert.equal(svg.rendered, "draw.io");
			const svgText = await readFile(path.join(s.canvas.workspace, "out/flow.svg"), "utf8");
			assert.match(svgText, /<svg[\s\S]*content="/);
			const exported = await s.canvas.invoke("save_file", { path: "out/flow.png" });
			assert.equal(exported.rendered, "draw.io");

			const focus = await s.canvas.invoke("focus", { cell_ids: ["fn"], message: "Here is the Lambda" });
			assert.deepEqual(focus.selected, ["fn"]);
			const laidOut = await s.canvas.invoke("layout", { layout: "verticalFlow" });
			assert.ok(laidOut.changes.length > 0);
			await s.settle();
			assert.deepEqual(canonical(await editorXml(s.frame)), canonical(await stateXml(s.canvas)));
			assert.deepEqual(s.problems, []);
		} finally {
			await s.close();
		}
	});
});

describe("draw.io preferences", { skip, timeout: 120_000 }, () => {
	it("keeps the person's enabled libraries from one canvas to the next", async () => {
		// Every canvas is a new loopback port, so a new browser origin; without the
		// canvas carrying them over, AWS icons would have to be re-enabled each time.
		const first = await session();
		try {
			await first.person((ui) => {
				window.mxSettings.setLibraries("general;uml;aws4;gcp2");
				window.mxSettings.save();
			});
			await first.page.waitForTimeout(300);
		} finally {
			await first.close();
		}
		const second = await session();
		try {
			const libraries = await second.person(() => window.mxSettings.getLibraries());
			assert.equal(libraries, "general;uml;aws4;gcp2");
		} finally {
			await second.person(() => {
				window.mxSettings.setLibraries("general;uml;er;bpmn;flowchart;basic;arrows2");
				window.mxSettings.save();
			});
			await second.page.waitForTimeout(300);
			await second.close();
		}
	});
});

describe("the person's own gestures and files", { skip, timeout: 300_000 }, () => {
	it("syncs real mouse and keyboard edits: drag from the sidebar, move, F2, Delete, Ctrl+Z", async () => {
		const s = await session();
		try {
			await s.canvas.invoke("get_diagram", {});
			const frameBox = await s.page.locator("#editor").boundingBox();
			const before = await s.person((ui) => Object.keys(ui.editor.graph.model.cells).length);
			const item = await s.frame.locator(".geSidebarContainer a.geItem").first().boundingBox();
			const canvasBox = await s.frame.locator(".geDiagramContainer").boundingBox();
			await s.page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
			await s.page.mouse.down();
			await s.page.mouse.move(canvasBox.x + 500, canvasBox.y + 400, { steps: 12 });
			await s.page.mouse.up();
			await s.settle();
			assert.equal(await s.person((ui) => Object.keys(ui.editor.graph.model.cells).length), before + 1);

			const centre = await s.person((ui) => {
				const graph = ui.editor.graph;
				const state = graph.view.getState(graph.model.getCell("check"));
				return { x: state.getCenterX() - graph.container.scrollLeft, y: state.getCenterY() - graph.container.scrollTop, left: graph.container.getBoundingClientRect().left, top: graph.container.getBoundingClientRect().top };
			});
			const x = frameBox.x + centre.left + centre.x;
			const y = frameBox.y + centre.top + centre.y;
			await s.page.mouse.move(x, y);
			await s.page.mouse.down();
			await s.page.mouse.move(x + 100, y + 100, { steps: 10 });
			await s.page.mouse.up();
			await s.page.keyboard.press("F2");
			await s.page.keyboard.press("Control+A");
			await s.page.keyboard.type("Is it valid?");
			await s.page.mouse.click(frameBox.x + 900, frameBox.y + 700);
			await s.settle();
			const { changes } = await s.canvas.invoke("get_changes", {});
			assert.ok(changes.some((line) => /\[check\]: moved/.test(line)), changes.join("\n"));
			assert.ok(changes.some((line) => /\[check\]: relabelled "Valid\?" → "Is it valid\?"/.test(line)), changes.join("\n"));

			await s.person((ui) => ui.editor.graph.setSelectionCells([ui.editor.graph.model.getCell("start")]));
			await s.frame.locator(".geDiagramContainer").focus();
			await s.page.keyboard.press("Delete");
			await s.settle();
			assert.doesNotMatch(await stateXml(s.canvas), /id="start"/);
			await s.page.keyboard.press("Control+z");
			await s.settle();
			assert.match(await stateXml(s.canvas), /id="start"/);
			assert.deepEqual(canonical(await editorXml(s.frame)), canonical(await stateXml(s.canvas)));
			assert.deepEqual(s.problems, []);
		} finally {
			await s.close();
		}
	});

	it("opens a compressed desktop file from the bar, and saves it back plain with Ctrl+S", async () => {
		const compress = (xml) => deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString("base64");
		const first = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><UserObject label="Service A" owner="team-a" id="svc"><mxCell style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></UserObject></root></mxGraphModel>';
		const second = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="p2a" value="On page two" style="ellipse;" vertex="1" parent="1"><mxGeometry x="100" y="100" width="120" height="80" as="geometry"/></mxCell></root></mxGraphModel>';
		const s = await session({});
		try {
			await mkdir(path.join(s.canvas.workspace, "docs"), { recursive: true });
			await writeFile(path.join(s.canvas.workspace, "docs/arch.drawio"), `<mxfile host="Electron"><diagram id="d1" name="Services">${compress(first)}</diagram><diagram id="d2" name="Second">${compress(second)}</diagram></mxfile>`);
			await s.page.click("#open-file");
			await s.page.fill("#sheet-content input", "docs/arch.drawio");
			await s.page.click("#sheet-confirm");
			await s.settle();
			const loaded = await s.person((ui) => ({ pages: ui.pages.map((page) => page.getName()), owner: ui.editor.graph.model.getCell("svc").value.getAttribute("owner") }));
			assert.deepEqual(loaded, { pages: ["Services", "Second"], owner: "team-a" });
			// One line for the whole file, not one per cell.
			const { changes } = await s.canvas.invoke("get_changes", {});
			assert.equal(changes.length, 1, changes.join("\n"));
			assert.match(changes[0], /opened docs\/arch\.drawio .*call get_diagram/);

			// The agent edits the page the person is not on; the person stays put.
			await s.canvas.invoke("get_diagram", { page_name: "Second" });
			await s.canvas.invoke("edit_diagram", {
				page_name: "Second",
				operations: [{ operation: "update", cell_id: "p2a", new_xml: '<mxCell value="Agent on page two" style="ellipse;" vertex="1" parent="1"><mxGeometry x="100" y="100" width="120" height="80" as="geometry"/></mxCell>' }],
			});
			await s.settle();
			const shot = await s.canvas.invoke("screenshot", { page_name: "Second" });
			assert.match(shot.path, /Second/);
			await s.canvas.invoke("save_file", { path: "out/second.svg", page_name: "Second" });
			assert.match(await readFile(path.join(s.canvas.workspace, "out/second.svg"), "utf8"), /Agent on page two/);
			assert.equal(await s.person((ui) => ui.currentPage.getName()), "Services");

			await s.person((ui) => {
				const graph = ui.editor.graph;
				const cell = graph.model.getCell("svc");
				const value = cell.value.cloneNode(true);
				value.setAttribute("owner", "team-b");
				graph.model.setValue(cell, value);
			});
			await s.settle();
			await s.frame.locator(".geDiagramContainer").focus();
			await s.page.keyboard.press("Control+s");
			await s.page.waitForTimeout(800);
			const saved = await readFile(path.join(s.canvas.workspace, "docs/arch.drawio"), "utf8");
			assert.match(saved, /<UserObject[^>]*owner="team-b"/);
			assert.match(saved, /Agent on page two/);
			assert.deepEqual(s.problems, []);
		} finally {
			await s.close();
		}
	});

	it("lets an agent edit land while the person is typing a label", async () => {
		const s = await session();
		try {
			await s.person((ui) => {
				const graph = ui.editor.graph;
				graph.startEditingAtCell(graph.model.getCell("start"));
				graph.cellEditor.textarea.innerHTML = "Half typed";
			});
			await s.canvas.invoke("get_diagram", {});
			await s.canvas.invoke("edit_diagram", {
				operations: [{ operation: "update", cell_id: "check", new_xml: '<mxCell value="Agent" style="rhombus;" vertex="1" parent="1"><mxGeometry x="60" y="180" width="120" height="80" as="geometry"/></mxCell>' }],
			});
			await s.settle();
			const during = await s.person((ui) => ({ editing: ui.editor.graph.isEditing(), text: ui.editor.graph.cellEditor.textarea.innerHTML, check: ui.editor.graph.model.getCell("check").value }));
			assert.deepEqual(during, { editing: true, text: "Half typed", check: "Agent" });
			await s.person((ui) => ui.editor.graph.stopEditing(false));
			await s.settle();
			assert.match((await s.canvas.invoke("get_diagram", { cell_ids: ["start"] })).cells_xml, /Half typed/);
		} finally {
			await s.close();
		}
	});
});

async function stateXml(canvas) {
	const response = await fetch(new URL("api/state", canvas.url));
	return (await response.json()).xml;
}
