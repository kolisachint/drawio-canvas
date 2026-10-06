/**
 * drawio-canvas as an MCP server: the same draw.io canvas for hosts that do not
 * render canvases — VS Code's Chat view with a GitHub Copilot subscription above
 * all, and any other MCP client.
 *
 * A plugin install starts it by itself (`.mcp.json`); by hand it is
 * `node /path/to/drawio-canvas/mcp.mjs` over stdio. The agent calls
 * `open_canvas`, opens the URL for the person (in VS Code, the Integrated
 * Browser beside the chat), and works with the canvas's actions as tools.
 *
 * Like `extension.mjs`, deliberately thin: `lib/mcp.mjs` is the protocol, and
 * the canvas is the one `extension.mjs` serves. The same contract holds: only
 * `node:` imports and this directory's own files, and stdout is the protocol
 * channel — diagnostics go to stderr, which MCP clients show as the server's log.
 */

import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createMcpServer } from "./lib/mcp.mjs";

const server = createMcpServer({
	extensionDir: path.dirname(fileURLToPath(import.meta.url)),
	send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
	log: (line) => process.stderr.write(`drawio-canvas: ${line}\n`),
	parkOnExit: true,
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => server.receive(line));
// The client stops a stdio server by closing its stdin. Exiting parks the canvas
// (see `parkOnExit`), and the next start takes it back.
lines.on("close", () => process.exit(0));
