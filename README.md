# drawio-canvas

The full draw.io editor, as a hoocode canvas, that a person and an agent edit
**at the same time**.

The person gets draw.io itself in their browser — the same editor as the
desktop app: every shape library (AWS, Azure, GCP, Kubernetes, Cisco, IBM, SAP,
UML, BPMN, …), layers, pages, the format panel, find, layouts, export. The agent
gets actions against the same document: read it, edit cells, insert library
icons by name, lay it out, take screenshots rendered by draw.io, and find out
what the person changed while it was busy. Neither waits for the other, and
neither silently overwrites the other.

```
/canvas open drawio-canvas
```

No desktop app, no service to run, no network: draw.io **31.4.6** ships in this
repository (`assets/drawio-31.4.6.war`, draw.io's own release archive, pinned by
SHA-256) and is served on loopback. Files are ordinary `.drawio`, so anything
made here opens in draw.io, and the other way round.

---

## Install

The canvas is one directory with `extension.mjs` at its root; the directory
must be named `drawio-canvas`, because a canvas's id is its directory name.

```bash
# For one project
git clone https://github.com/kolisachint/drawio-canvas .agents/extensions/drawio-canvas

# For every project on this machine
git clone https://github.com/kolisachint/drawio-canvas ~/.copilot/extensions/drawio-canvas
```

It also carries a plugin manifest, so `/plugin install` works too. Then
`/canvas open drawio-canvas`.

**Requirements.** Node 20.6 or newer (hoocode's own requirement for canvases).
No install step, no build, no dependencies. On first open the bundled archive is
verified and unpacked into the cache (`~/.cache/drawio-canvas`,
`~/Library/Caches/drawio-canvas`, or `%LOCALAPPDATA%\drawio-canvas`; about two
seconds). `node scripts/install-drawio.mjs` does the same ahead of time.

| Variable | Effect |
|---|---|
| `DRAWIO_CANVAS_WORKSPACE` | Working directory, when the host does not send one. |
| `DRAWIO_CANVAS_CACHE` | Where draw.io is unpacked and preferences are kept. |
| `DRAWIO_CANVAS_DRAWIO_DIR` | Serve an already-unpacked draw.io webapp instead (e.g. a checkout's `src/main/webapp`). |
| `DRAWIO_CANVAS_DRAWIO_WAR` | Install from another copy of the pinned `draw.war`. |
| `DRAWIO_CANVAS_OFFLINE=1` | Never fall back to downloading, even if the bundled archive is missing. |

---

## What each side can do

### The person, in draw.io

Everything draw.io does. The canvas adds a slim bar above it: the file, the
version, what the agent last did (its edits also flash in the editor), and
**Open…**, **Save** (also `Ctrl/Cmd+S`) and **History** — every version by
either side, with a restore. Undo (`Ctrl/Cmd+Z`) undoes the person's own edits,
never the agent's. Preferences — enabled libraries, theme, units — are kept
between canvases, as the desktop app keeps them.

### The agent, through actions

| Action | What it does |
|---|---|
| `get_diagram` | Pages, layers, and one page's cells as XML (an outline plus `cell_ids` for large pages). |
| `get_changes` | What the person changed since the agent was last told, one line per change, and what they are looking at. |
| `edit_diagram` | `add` / `update` / `delete` cells by id, all or nothing. |
| `search_shapes` | Search draw.io's 11,800 library shapes by name — "aws lambda", "gcp bigquery", "azure function". |
| `insert_shapes` | Insert library shapes by id with draw.io's exact style; the long icon styles never enter the model's context. |
| `replace_diagram` | Replace a page or the document. Refused over the person's unseen work unless `force`. |
| `manage_pages` | `list`, `add`, `rename`, `delete`. |
| `manage_layers` | `list`, `add`, `rename`, `show`/`hide`, `lock`/`unlock`, `reorder`, `move_cells`, `delete`. |
| `screenshot` | A PNG rendered by the person's draw.io (page, viewport, selection or cells), written into the workspace for the agent to read. |
| `focus` | Switch the person's view to a page and cells, with a one-line message. |
| `layout` | Run a draw.io layout (`verticalFlow`, `horizontalTree`, `organic`, or layout JSON) in the person's editor. |
| `open_file` / `save_file` | `.drawio`/`.xml`; `.svg` and `.png` rendered by draw.io (the SVG embeds the diagram so it reopens). |

Every result also carries `person`: changes the agent has not been told about
yet, and what the person has selected and in view. The same picture is kept on
disk as `.drawio-canvas/<instance>/manifest.json` in the workspace (git-ignored
by its own `.gitignore`) for tools that read files.

---

## Editing at the same time

**Both sides edit cells, not documents.** draw.io computes what the person
changed with its own collaboration diff; only those cells are sent. The agent
sends cell operations by id. Moving a box while the agent adds another is not a
conflict — both land. Only writes to the same cell race, and the later wins.

**The agent is gated per cell.** An update or delete is refused only if the
person changed *that cell* since the agent last read it, with what they did and
the one call that fixes it (`get_diagram` with those `cell_ids`). Work
elsewhere on the page carries on. The person is never blocked.

**Changes merge into the live editor.** The agent's edits are applied with
draw.io's own patch, so the person keeps their selection, scroll position,
undo history and anything they are in the middle of.

**The server is the authority, and the editor converges to it.** When nothing
the person did is still in flight, the editor is compared with the server and
any drift is patched away. A randomized test of 40 rounds of simultaneous edits
(move, add, rename, restyle, z-order, delete on both sides) checks that both end
identical.

---

## Security

A canvas is a Node process with the person's privileges; the host's permission
gate is not in front of it. So:

- **Loopback only, behind a per-instance capability token** carried as the first
  URL path segment (not a query string, which relative loads drop; not a cookie,
  which on `127.0.0.1` is shared across ports).
- **Nothing leaves the machine.** draw.io's pages are served with a CSP whose
  `connect-src`, `script-src`, `img-src` and `font-src` are `'self'`: a draw.io
  feature that would phone home is stopped by the browser. No `unsafe-eval`.
- **Workspace containment.** Every path is resolved inside the working directory
  on the real path; only `.drawio`, `.xml`, `.svg` and `.png` are written.
- **Pinned editor.** The archive is refused unless its SHA-256 matches, and is
  unpacked atomically.
- **Diagrams are data.** Labels from a repository are drawn, never interpreted,
  by the canvas's own code.

---

## Layout

```
extension.mjs        the host-facing surface
assets/              drawio-31.4.6.war — the pinned draw.io release
data/                shapes-31.4.6.json.gz — every library shape, for search_shapes
lib/
  canvas.mjs         the canvas declaration and the actions
  session.mjs        one document: versions, journal, the per-cell gate
  sync.mjs           the person's draw.io edits applied to the document
  changes.mjs        document diffs, said in words
  layers.mjs         layer operations
  shapes.mjs         shape search and insertion
  drawio-dist.mjs    the pinned draw.io: verify, unpack, locate
  zip.mjs            a zip reader on node:zlib
  settings.mjs       draw.io preferences kept between canvases
  server.mjs         loopback server, token, SSE, editor RPC
  files.mjs          .drawio files and the workspace rule
  model.mjs xml.mjs style.mjs render.mjs   the document model (shared with the lite editor)
ui/
  index.html host.mjs host.css   the page around draw.io and the sync bridge
  capture.js         the one script added to draw.io's page
  lite/              the canvas's own small editor, a fallback at /lite/
scripts/             install-drawio.mjs, build-shape-index.mjs
test/                unit, protocol, lite-browser and draw.io end-to-end tests
```

## Tests

```bash
node --test "test/*.test.mjs"
```

The browser tests need a driver, installed **outside** the repository so the
extension directory stays free of `node_modules`:

```bash
npm install --prefix /tmp/pw playwright
DRAWIO_CANVAS_PLAYWRIGHT=/tmp/pw/node_modules/playwright node --test "test/*.test.mjs"
```

`test/drawio.test.mjs` runs the real draw.io in Chromium with the agent editing
underneath it. hoocode carries an acceptance test that runs this canvas through
its discovery, `/canvas open`, agent tools and `reload_canvas`:

```bash
HOOCODE_DRAWIO_CANVAS_DIR=$PWD HOOCODE_PLAYWRIGHT=/tmp/pw/node_modules/playwright \
  bunx vitest run --root <hoocode>/packages/coding-agent test/canvas-acceptance-drawio.test.ts
```

### Continuous integration

Not committed (the authoring session could not create workflows). Save as
`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: ["**"]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # Outside the checkout: the extension directory may hold no node_modules.
      - name: Install the browser driver
        working-directory: ${{ runner.temp }}
        run: |
          npm init -y >/dev/null
          npm install playwright@1
          npx playwright install --with-deps chromium
      - name: Test
        env:
          DRAWIO_CANVAS_PLAYWRIGHT: ${{ runner.temp }}/node_modules/playwright
        run: node --test "test/*.test.mjs"
```

## Credits

draw.io is [jgraph/drawio](https://github.com/jgraph/drawio) (Apache-2.0); the
bundled archive is its unmodified v31.4.6 release `draw.war`. The agent-facing
surface — id-addressed cell operations, a read-before-write gate, page
selectors — follows [next-ai-draw-io](https://github.com/kolisachint/next-ai-draw-io)'s
MCP server. The canvas protocol and host are hoocode's, after GitHub Copilot's
canvas extensions.

Apache-2.0.
