#!/usr/bin/env node
/**
 * Run a hoocode checkout from source, the way its own `hoocode-test.sh` does,
 * for `scripts/e2e-hoocode.mjs` (which runs `node $HOOCODE_BIN`) without
 * building hoocode first:
 *
 *   HOOCODE_DIR=/path/to/hoocode HOOCODE_BIN=scripts/hoocode-from-source.mjs \
 *   DRAWIO_CANVAS_PLAYWRIGHT=/tmp/pw/node_modules/playwright node scripts/e2e-hoocode.mjs
 *
 * tsx comes from the hoocode checkout, and hoocode's tsconfig is named
 * explicitly: tsx would otherwise look for one in the working directory, which
 * is the test workspace, and resolve hoocode's packages to their unbuilt dist.
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.HOOCODE_DIR;
if (!root) {
	console.error("Set HOOCODE_DIR to a hoocode checkout (with its dependencies installed).");
	process.exit(2);
}
const { register } = await import(pathToFileURL(path.join(root, "node_modules", "tsx", "dist", "esm", "api", "index.mjs")).href);
register({ tsconfig: path.join(root, "tsconfig.json") });
await import(pathToFileURL(path.join(root, "packages", "coding-agent", "src", "cli.ts")).href);
