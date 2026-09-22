# drawio-canvas

A draw.io diagram that a person and an agent edit **at the same time**, as a
hoocode canvas.

The person drags, connects, labels and styles shapes in their browser. The agent
adds, updates and deletes cells by id through six actions. Neither waits for the
other, and neither can silently overwrite the other's work.

```
/canvas open drawio-canvas
```

The editor is the canvas's own — there is no draw.io to install, no service to
run, no third-party origin in the page and nothing fetched from the network. The
file it reads and writes is an ordinary `.drawio`, so anything made here opens in
draw.io, and anything made in draw.io opens here.

---

## Install

The canvas is one directory with `extension.mjs` at its root, which is all
hoocode's discovery needs. Three places work; the directory must be named
`drawio-canvas`, because a canvas extension's id is its directory name.

```bash
# For one project
git clone https://github.com/kolisachint/drawio-canvas .agents/extensions/drawio-canvas

# For every project on this machine
git clone https://github.com/kolisachint/drawio-canvas ~/.copilot/extensions/drawio-canvas
```

It also carries a plugin manifest, so `/plugin install` works and the canvas
arrives with it.

Then:

```
/canvas list          # drawio-canvas  Draw.io Canvas  (user)
/canvas open drawio-canvas
```

**Requirements.** Node 20.6 or newer, which is hoocode's own requirement for
canvases. Nothing else — there is no install step, no build, and no dependency
of any kind.

**Working directory.** `open_file` and `save_file` resolve paths inside the
session's working directory, which hoocode passes in the canvas session context.
On a hoocode that does not send it, the canvas still opens and the two file
actions say so instead of guessing; set `DRAWIO_CANVAS_WORKSPACE` to name the
directory yourself.

---

## What each side can do

### The person, in the browser

| | |
|---|---|
| Insert | toolbar, or `R` `B` `E` `D` `T` for rounded box, box, ellipse, decision, text |
| Move | drag; snaps to the 10-unit grid draw.io files are drawn on |
| Resize | drag a handle on the selected shape |
| Connect | hover a shape, drag from one of its four ports onto another shape |
| Label | double-click, or `F2`; `Enter` commits, `Shift+Enter` adds a line |
| Select | click, `Shift`-click to add, drag on empty space for a marquee |
| Delete | `Delete` or `Backspace` — attached connectors go too |
| Duplicate | `Ctrl/Cmd+D` |
| Nudge | arrow keys, `Shift` for ten units |
| Undo | `Ctrl/Cmd+Z` — restores the previous version, whoever made it |
| Style | fill and line colour, no-fill, bold, dashed |
| Navigate | wheel to zoom, `Alt`-drag or middle-drag to pan, `F` to fit |
| Pages | tabs along the bottom; double-click a tab to rename |
| Files | **Open** and **Save** inside the workspace; **Download** a `.drawio`, `.svg` or `.png` copy |
| History | every version, with a thumbnail, and a restore |

### The agent, through actions

| Action | What it does |
|---|---|
| `get_diagram` | The pages, and one page's cells as XML. Large pages come back as an outline plus `cell_ids` to fetch what matters. |
| `edit_diagram` | `add` / `update` / `delete` cells by id. Refused if the person has changed the diagram since the last read. |
| `replace_diagram` | Replace one page, or the whole document. Destructive, and says so. |
| `manage_pages` | `list`, `add`, `rename`, `delete`. |
| `open_file` | Load a `.drawio` from the workspace, decompressing draw.io's own format. |
| `save_file` | Write `.drawio`/`.xml` (the document) or `.svg` (a picture of one page). |

Validation runs on every edit, and the three mistakes that make a diagram open
blank in draw.io itself — a duplicate id, a cell nested inside another cell, an
edge pointing at nothing — come back with the result rather than as a silent
empty page.

---

## How the two of you stay out of each other's way

**Edits are cell-addressed, both ways.** The page sends the same
`{operation, cell_id, new_xml}` operations the agent does. Moving a box and
adding a node are not a conflict — they touch different cells, and both land.
Only edits to the *same* cell race, and there the later one wins.

**The agent has to look before it writes.** `edit_diagram` is refused if the
document has changed since the agent last read it, and the refusal says to call
`get_diagram` and retry. Not a lock and not a timeout — a comparison of content,
so a slow turn is fine and only a *stale* one is stopped. The person is never
blocked: they are looking at the diagram, so they cannot be working from a stale
copy of it.

**Changes appear immediately, and say who made them.** The page listens over
Server-Sent Events. When the agent changes something, the affected shapes flash
once and the status line says so. State that moves under someone's hands without
explanation is the thing that makes a shared surface feel haunted.

**Nothing is lost to an undo.** Every version is kept, with a thumbnail, and a
restore is itself a new version — so undoing an undo works.

---

## What it draws, and what it does not

The renderer is about 400 lines with no dependencies. draw.io ships thousands of
stencils. The bargain is explicit:

> **Rendering degrades. The document does not.**

Drawn properly: rectangles and rounded rectangles, ellipses, rhombus, triangle,
hexagon, parallelogram, trapezoid, cylinder, cloud, note, document, process,
step, card, actor, swimlane and text; fills, strokes, dashes, opacity, gradients'
base colour, font size, weight, style and alignment; edges with waypoints,
orthogonal routing, rounded and curved lines, six arrowhead styles at either end,
fixed connection points, and edge labels.

A shape outside that list is drawn as a labelled rectangle in its own colours, at
its own size and position — an AWS icon, a UML stencil, a BPMN gateway. What it
is *not* is lost: its style string, its custom attributes, its children and its
relationships survive every edit untouched, so the file still opens in draw.io
exactly as its author left it. The canvas is safe to point at a real diagram; it
just will not draw all of it.

Also not implemented: concurrent editing of one label (the two of you appending
to the same text buffer), draw.io's shape libraries and search, layers as a
first-class surface, and PNG export from the agent — PNG needs a rasterizer,
which would need a dependency, so it is offered in the browser where one already
exists, and `save_file` is honest about producing `.drawio` and `.svg` only.

---

## Security

A canvas extension is a Node process running with the person's own privileges,
and the host's permission gate sits in front of the host's tools, not inside a
forked extension. So the boundaries that matter are in here:

- **The page is served on 127.0.0.1 behind a per-instance capability token**,
  carried as the first path segment of every URL. A query parameter cannot work:
  the browser drops it when resolving an ES module import, which would leave the
  page's own modules unauthenticated. A cookie cannot work either — on
  `127.0.0.1` cookies are shared across ports, which would hand the token to
  every other local server the browser talks to.
- **Every file path is resolved inside the session's working directory** and
  refused outside it, on the real path, so neither `../` nor a symlink can reach
  out. Only `.drawio`, `.xml` and `.svg` are written.
- **The page's CSP is `default-src 'self'`** with no inline script, no CDN and
  nothing to frame it.
- **Labels are escaped as text.** A diagram from a repository is untrusted input,
  and it is drawn, not interpreted.
- **No network.** Nothing here makes an outbound request, ever.

---

## The canvas contract

Three rules come from the format itself. They are not style:

1. The only non-`node:` import is `@github/copilot-sdk/extension`, which the host
   resolves when it forks the process. **No `package.json`, no `node_modules`** —
   a local install shadows the host's resolution and the canvas stops working.
   `test/protocol.test.mjs` fails the build if either appears.
2. **stdout is the JSON-RPC channel.** `session.log`, never `console.log`.
3. After editing `extension.mjs` or anything in `lib/`, the agent must call
   `reload_canvas` — the running child was forked from the old code — and hand
   the person the **new** URL, because their tab dies with the old process.

## Layout

```
extension.mjs     the host-facing surface, and nothing else
lib/
  canvas.mjs      the canvas declaration and the six action handlers
  xml.mjs         XML parser and serializer, non-destructive by design    ← also served to the page
  model.mjs       the .drawio document: pages, cells, operations          ← also served to the page
  style.mjs       draw.io style strings                                   ← also served to the page
  render.mjs      the document as SVG, as a pure function                 ← also served to the page
  session.mjs     one open document: versions, history, the edit gate
  files.mjs       reading and writing .drawio, and the workspace rule
  server.mjs      the loopback server, the token, and the event stream
ui/               the editor: index.html, app.css, app.mjs, editor.mjs
test/             97 tests (87 of them need no browser), no dependencies
```

The four modules marked above are loaded **by both halves** — the extension
process and the page — from the same files. That is the main structural decision
here: the agent's edits and the person's edits go through one parser, one
document model and one renderer, so the two sides cannot disagree about what the
document is. A canvas whose server understood a slightly different document than
its page would lose someone's work, and the loss would look like a rendering bug.

## Tests

```bash
node --test "test/*.test.mjs"
```

No installation, because there is nothing to install. `test/protocol.test.mjs`
forks `extension.mjs` as a real child process and speaks the canvas wire protocol
to it, resolving the SDK import the way a host does — so the thing under test is
the extension as a host sees it.

The browser tests need a driver, which is installed **outside** the repository so
the extension directory stays free of `node_modules`:

```bash
npm install --prefix /tmp/pw playwright
DRAWIO_CANVAS_PLAYWRIGHT=/tmp/pw/node_modules/playwright node --test test/browser.test.mjs
```

The canvas is also exercised end to end through hoocode's own canvas runner —
discovery, the workspace-trust gate, `/canvas open`, `list_canvas_capabilities`,
`invoke_canvas_action`, `reload_canvas` and `canvas.close` — against a checkout
of hoocode.

### Continuous integration

Not committed, because the session that wrote this repository had no permission
to create workflows. Save it as `.github/workflows/ci.yml`:

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

      # The browser driver is installed OUTSIDE the checkout on purpose: a canvas
      # extension directory may contain no package.json and no node_modules, and
      # test/protocol.test.mjs fails the build if either appears. One install of
      # `playwright` (not `playwright-core`) keeps the driver and the browser at
      # matching versions.
      - name: Install the browser driver outside the repository
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

The `.drawio` format is mxGraph's, from [draw.io](https://github.com/jgraph/drawio)
(Apache-2.0). The shape of the agent-facing surface — id-addressed cell
operations, the read-before-write gate, page selectors, an embedded server with a
live browser preview — follows
[next-ai-draw-io](https://github.com/kolisachint/next-ai-draw-io)'s MCP server,
ported to the canvas protocol and to a dependency-free renderer. The canvas
protocol and its host are hoocode's, after GitHub Copilot's canvas extensions.

Apache-2.0.
