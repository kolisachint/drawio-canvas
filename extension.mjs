/**
 * drawio-canvas — a draw.io diagram that a person and an agent edit together.
 *
 * Open it with `/canvas open drawio-canvas`. The person gets the full draw.io
 * editor in their browser — the pinned release bundled in `assets/`, served on
 * loopback, every shape library, layers, pages — and the agent gets actions
 * against the same document: read, edit, insert library shapes, lay out,
 * screenshot. Each sees the other's changes as they happen.
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
 * Everything else is in `lib/` (the document, the sync, the actions, the
 * server) and `ui/` (the page around draw.io). `AGENTS.md` is the map.
 */

import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentLink } from "./lib/agent.mjs";
import { createDrawioCanvas } from "./lib/canvas.mjs";

/**
 * Writes to the session timeline.
 *
 * A binding rather than a direct call on the session: the host may open an
 * instance as soon as the ready message lands, which can be before this module
 * has finished evaluating, and a canvas is not worth crashing over a log line.
 */
let logLine = () => {};

/**
 * The agent as the host reports it (`session.on`), and the way to ask it for
 * something (`session.send`). Attached once the session exists; a host without
 * either leaves it inert and the canvas works as before.
 */
const agent = new AgentLink();

const canvas = createDrawioCanvas(
	{ createCanvas, CanvasError },
	{
		extensionDir: path.dirname(fileURLToPath(import.meta.url)),
		log: (message) => logLine(message),
		agent,
	},
);

const session = await joinSession({ canvases: [canvas] });
logLine = (message) => void session.log(message);
agent.attach(session);
await session.log("drawio-canvas ready");
