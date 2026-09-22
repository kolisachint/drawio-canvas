/**
 * drawio-canvas — a draw.io diagram that a person and an agent edit together.
 *
 * Open it with `/canvas open drawio-canvas`. The person gets an editor in their
 * browser; the agent gets six actions against the same document; each sees the
 * other's changes as they happen.
 *
 * This file is the whole of the host-facing surface, and it is deliberately
 * thin. The contract it has to keep (hoocode's `docs/canvas-extensions-design.md`,
 * and GitHub's `docs/extensions.md` before it):
 *
 *  - The only non-`node:` import is `@github/copilot-sdk/extension`, which the
 *    host resolves when it forks this process. There is no `package.json` here
 *    and no `node_modules`, and adding either is how you break it.
 *  - stdout is the JSON-RPC channel. `session.log`, never `console.log`.
 *
 * Everything else is in `lib/`, which the page in the browser loads too: the
 * same parser, document model and renderer run on both sides, so the two
 * operators cannot disagree about what the document is.
 *
 * The editor is this canvas's own, not an embedded draw.io. A canvas has to be
 * enough on its own — nothing to install, no service to run, no third-party
 * origin in the page, and nothing fetched from the network. What that costs is
 * rendering fidelity, and `lib/render.mjs` says exactly what is drawn and why
 * everything it cannot draw still round-trips untouched.
 */

import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createDrawioCanvas } from "./lib/canvas.mjs";

/**
 * Writes to the session timeline.
 *
 * A binding rather than a direct call on the session: the host may open an
 * instance as soon as the ready message lands, which can be before this module
 * has finished evaluating, and a canvas is not worth crashing over a log line.
 */
let logLine = () => {};

const canvas = createDrawioCanvas(
	{ createCanvas, CanvasError },
	{
		extensionDir: path.dirname(fileURLToPath(import.meta.url)),
		log: (message) => logLine(message),
	},
);

const session = await joinSession({ canvases: [canvas] });
logLine = (message) => void session.log(message);
await session.log("drawio-canvas ready");
