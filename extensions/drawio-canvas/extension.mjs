/**
 * The canvas, where GitHub Copilot CLI looks for a plugin's extensions.
 *
 * Copilot loads an installed plugin's extensions from
 * `extensions/<name>/extension.mjs`; hoocode (and a hand clone into an
 * extensions directory) loads the one at the repository root. This file is the
 * first pointing at the second, so there is one canvas and one place to change
 * it. hoocode sees both and keeps one: it keys canvas extensions by id, and this
 * directory's name is the root's id.
 */

import "../../extension.mjs";
