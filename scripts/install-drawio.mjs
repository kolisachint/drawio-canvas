#!/usr/bin/env node
/**
 * Verify and unpack the pinned draw.io release ahead of time.
 *
 *   node scripts/install-drawio.mjs            from the bundled assets/drawio-<version>.war
 *   node scripts/install-drawio.mjs draw.war   from another copy of the same release
 *
 * Optional: the canvas does the same on first open, from the same bundled
 * archive. It downloads only if the archive is missing from the checkout.
 */

import { DrawioProvider, installDir, PINNED } from "../lib/drawio-dist.mjs";

const env = { ...process.env };
if (process.argv[2]) env.DRAWIO_CANVAS_DRAWIO_WAR = process.argv[2];

const provider = new DrawioProvider({ env, log: (line) => process.stderr.write(`${line}\n`) });
const ticker = setInterval(() => {
	const status = provider.status();
	if (status.state === "downloading") {
		process.stderr.write(`  ${(status.received / 1e6).toFixed(1)} / ${(status.total / 1e6).toFixed(1)} MB\r`);
	}
}, 500);
try {
	const install = await provider.ensure();
	process.stdout.write(`draw.io ${install.version} (${install.source}) at ${install.dir}\n`);
} catch (cause) {
	process.stderr.write(`\nFailed to install draw.io ${PINNED.version} into ${installDir(env)}: ${cause.message}\n`);
	process.exitCode = 1;
} finally {
	clearInterval(ticker);
}
