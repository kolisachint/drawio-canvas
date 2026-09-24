/**
 * The person's draw.io preferences, kept between canvases.
 *
 * draw.io stores its preferences — which shape libraries are enabled (AWS,
 * GCP, Azure, …), theme, units, recent colours, custom libraries — in the
 * browser's `localStorage`, which belongs to an origin. Every canvas is served
 * on a fresh loopback port, so every canvas would be a new origin and the
 * person would re-enable AWS icons every single time. The desktop app
 * remembers; so does this: the page mirrors draw.io's own settings keys here,
 * and puts them back before draw.io starts.
 *
 * Only draw.io's settings keys are accepted, and the file lives beside the
 * cached editor, not in the workspace: preferences belong to the person, not
 * to the repository.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { cacheRoot } from "./drawio-dist.mjs";

/** draw.io's own localStorage keys for preferences and custom configuration. */
export const SETTINGS_KEYS = [".drawio-config", ".configuration"];

/** Largest value kept per key; draw.io's config is a few KB, a custom library list more. */
const MAX_VALUE_CHARS = 2_000_000;

export function settingsFile(env = process.env) {
	return path.join(cacheRoot(env), "drawio-settings.json");
}

export async function readSettings(env = process.env) {
	try {
		const parsed = JSON.parse(await readFile(settingsFile(env), "utf8"));
		return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => SETTINGS_KEYS.includes(key) && typeof value === "string"));
	} catch {
		return {};
	}
}

/** Merge `values` into the stored settings. `null` removes a key. Unknown keys are ignored. */
export async function writeSettings(values, env = process.env) {
	const current = await readSettings(env);
	for (const [key, value] of Object.entries(values ?? {})) {
		if (!SETTINGS_KEYS.includes(key)) continue;
		if (value === null) delete current[key];
		else if (typeof value === "string" && value.length <= MAX_VALUE_CHARS) current[key] = value;
	}
	const file = settingsFile(env);
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
	await rename(temporary, file);
	return current;
}

/**
 * The canvas's own preferences, as opposed to draw.io's: currently whether the
 * idle digest may nudge the agent. Kept beside draw.io's, for the same reason.
 */
export const CANVAS_PREFS_DEFAULTS = { digest: true };

export function prefsFile(env = process.env) {
	return path.join(cacheRoot(env), "canvas-prefs.json");
}

export async function readPrefs(env = process.env) {
	try {
		const parsed = JSON.parse(await readFile(prefsFile(env), "utf8"));
		return { ...CANVAS_PREFS_DEFAULTS, ...(typeof parsed.digest === "boolean" ? { digest: parsed.digest } : {}) };
	} catch {
		return { ...CANVAS_PREFS_DEFAULTS };
	}
}

/** Merge known boolean preferences. Unknown keys and wrong types are ignored. */
export async function writePrefs(values, env = process.env) {
	const current = await readPrefs(env);
	if (typeof values?.digest === "boolean") current.digest = values.digest;
	const file = prefsFile(env);
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
	await rename(temporary, file);
	return current;
}
