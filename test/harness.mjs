/**
 * Test helpers.
 *
 * The SDK stub is the interesting one. `lib/canvas.mjs` takes `createCanvas`
 * and `CanvasError` as arguments precisely so a test can supply them, and what
 * it supplies here is not a mock of the canvas — the real document, the real
 * loopback server and a real workspace directory are all used. It only stands
 * in for the two functions the host would otherwise resolve from
 * `@github/copilot-sdk/extension`, whose behaviour is fully described by the
 * protocol: `createCanvas` records a declaration and its handlers, and
 * `CanvasError` carries a code.
 *
 * `test/hoocode.test.mjs` then runs the same canvas through hoocode's real
 * runner, so nothing rests on this stub being right.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createDrawioCanvas } from "../lib/canvas.mjs";

export const EXTENSION_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Tests unpack draw.io and write draw.io preferences; neither belongs in the
// person's real cache. One shared directory, so the bundled archive is unpacked
// once per machine rather than once per test.
process.env.DRAWIO_CANVAS_CACHE ??= path.join(tmpdir(), "drawio-canvas-test-cache");

/** The SDK's `CanvasError`: a message plus a machine-readable code. */
export class CanvasError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "CanvasError";
		this.code = code;
	}
}

/** The SDK's `createCanvas`: keeps the declaration and binds the handlers by name. */
export function createCanvas(options) {
	return {
		options,
		declaration: {
			id: options.id,
			displayName: options.displayName,
			description: options.description,
			inputSchema: options.inputSchema,
			actions: (options.actions ?? []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
		},
		handlers: new Map((options.actions ?? []).map((action) => [action.name, action.handler])),
	};
}

/**
 * Open a canvas instance against a fresh temporary workspace.
 *
 * Returns the same three verbs the host has — `invoke`, `close`, plus the URL —
 * so a test reads like the sequence a session actually performs.
 */
export async function openCanvas({ input, workspace, instanceId } = {}) {
	const root = workspace ?? (await mkdtemp(path.join(tmpdir(), "drawio-canvas-test-")));
	const logs = [];
	const canvas = createDrawioCanvas({ createCanvas, CanvasError }, { extensionDir: EXTENSION_DIR, log: (line) => logs.push(line) });
	const id = instanceId ?? `i-${Math.random().toString(36).slice(2)}`;
	const context = {
		sessionId: "test-session",
		extensionId: "drawio-canvas",
		canvasId: "drawio-canvas",
		instanceId: id,
		host: { capabilities: { canvases: true } },
		session: { workingDirectory: root },
	};
	const opened = await canvas.options.open({ ...context, input });
	return {
		canvas,
		instanceId: id,
		workspace: root,
		logs,
		url: opened.url,
		opened,
		invoke: (name, actionInput) => {
			const handler = canvas.handlers.get(name);
			if (!handler) throw new Error(`No action "${name}". Declared: ${[...canvas.handlers.keys()].join(", ")}`);
			return handler({ ...context, actionName: name, input: actionInput });
		},
		fetch: (route, options) => fetch(new URL(route, opened.url), options),
		close: async ({ keepWorkspace = false } = {}) => {
			await canvas.options.onClose(context);
			if (!workspace && !keepWorkspace) await rm(root, { recursive: true, force: true });
		},
	};
}

/** A small two-shape, one-edge diagram, in the form draw.io writes. */
export const SAMPLE_XML = `<mxfile host="test">
  <diagram id="p1" name="Flow">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="start" value="Start" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="140" height="60" as="geometry" />
        </mxCell>
        <mxCell id="check" value="Valid?" style="rhombus;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="60" y="180" width="120" height="80" as="geometry" />
        </mxCell>
        <mxCell id="link" value="yes" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;" edge="1" parent="1" source="start" target="check">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
