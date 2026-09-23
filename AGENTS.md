# AGENTS.md

Guidance for agents (and people) changing this repository. `README.md` says what
the canvas does; this file says how it is built, what must not break, what
changed recently, and what is still open.

## The shape of it

A hoocode canvas extension: `extension.mjs` is forked by the host and speaks
the canvas JSON-RPC protocol; `lib/canvas.mjs` declares the actions. Each open
canvas gets a loopback server (`lib/server.mjs`) that serves:

- `/` — `ui/index.html` + `ui/host.mjs`: a slim bar and draw.io in a same-origin
  iframe. `host.mjs` is the **sync bridge**.
- `/drawio/` — the pinned draw.io, unpacked from `assets/drawio-<v>.war` into the
  cache by `lib/drawio-dist.mjs`, with `ui/capture.js` injected into its
  `index.html` so the bridge gets the `EditorUi` instance (via `App.main(cb)`).
- `/lite/` — the canvas's own small editor (`ui/lite/`), a fallback only.
- `/api/*` — state, SSE events, the person's edits (`/api/sync`), presence,
  editor RPC answers, files, history, settings.

Data flow:

```
person ── draw.io ── host.mjs ──(cell changes)──▶ POST /api/sync ─▶ session.applyEditor ─▶ sync.mjs
                         ▲                                                   │
                         └── SSE change ◀── session.commit (diff + journal) ◀┘◀── agent actions (canvas.mjs)
agent ── screenshot/focus/layout/export ─▶ server.requestEditor ─▶ SSE rpc ─▶ host.mjs ─▶ POST /api/rpc
```

## Rules that are not style

1. **No `package.json`, no `node_modules`** in this directory. The only
   non-`node:` import is `@github/copilot-sdk/extension`, resolved by the host.
   `test/protocol.test.mjs` fails the build otherwise. Playwright for tests is
   installed outside (`/tmp/pw`) and named by `DRAWIO_CANVAS_PLAYWRIGHT`.
2. **stdout is the JSON-RPC channel.** Log with `session.log` (the `log`
   callback), never `console.log`, in anything the extension process runs.
3. **After editing `extension.mjs` or `lib/`, call `reload_canvas`** and give
   the person the new URL; the running child was forked from the old code.
4. **Nothing leaves the machine.** Keep the draw.io CSP in `lib/server.mjs`
   same-origin; never add `unsafe-eval`. Network is used only by the fallback
   download in `drawio-dist.mjs`, and never at open.
5. **The person's edits travel as touched cells, never whole documents.** A
   whole-document write from the page would revert agent edits it has not
   merged yet. See the header of `lib/sync.mjs`.
6. **The agent gate is per cell** (`session.editGate`). Do not reintroduce a
   document-wide stale check; it blocks the agent whenever the person is busy.
7. **Upgrading draw.io is one reviewed change:** update `PINNED` in
   `lib/drawio-dist.mjs` (version, url, sha256, bytes), replace
   `assets/drawio-<v>.war` with that release's `draw.war`, rebuild
   `data/shapes-<v>.json.gz` with `scripts/build-shape-index.mjs`, bump the
   version asserted in `test/drawio.test.mjs` and `test/dist.test.mjs`, and run
   the draw.io and hoocode end-to-end tests. `ui/capture.js` and `host.mjs` use
   draw.io internals (`App.main` callback, `diffPages`, `patch`,
   `getPagesForXml`, `exportToCanvas`, `executeLayoutSpec`); the e2e tests are
   what catch their drift.

## Testing

```bash
node --test "test/*.test.mjs"                                  # unit + protocol (no browser)
DRAWIO_CANVAS_PLAYWRIGHT=/tmp/pw/node_modules/playwright \
  node --test "test/*.test.mjs"                                # + lite editor + real draw.io
```

`test/harness.mjs` points `DRAWIO_CANVAS_CACHE` at a temp directory so tests
never touch the person's cache or preferences. The concurrency test in
`test/drawio.test.mjs` takes `DRAWIO_CANVAS_SEED` and `DRAWIO_CANVAS_ROUNDS`;
run several seeds after touching `sync.mjs`, `session.mjs` or `host.mjs`.

hoocode end to end: `packages/coding-agent/test/canvas-acceptance-drawio.test.ts`
on hoocode's branch, with `HOOCODE_DRAWIO_CANVAS_DIR` pointing here (see README).

## Recent changes

- **Full draw.io editor** replaces the canvas's own editor as the person's
  surface. draw.io 31.4.6 is bundled (`assets/drawio-31.4.6.war`, SHA-256
  pinned), unpacked on first open, served offline under a same-origin CSP. The
  old editor stays at `/lite/`.
- **Sync bridge** (`ui/host.mjs`): outbound via draw.io's `diffPages` → cell
  changes (`lib/sync.mjs`, incl. whole-list z-order); inbound via draw.io's
  `patch`, preserving selection and undo; idle reconciliation against the
  server so the editor always converges.
- **Per-cell agent gate** and a **change journal**: every version is diffed and
  described (`lib/changes.mjs`); results carry `person.changes`; new
  `get_changes` action; stale refusals name exactly what the person did.
- **New actions:** `search_shapes`, `insert_shapes` (11,813 library shapes from
  `data/shapes-31.4.6.json.gz`), `manage_layers`, `screenshot`, `focus`,
  `layout`; `save_file` writes draw.io-rendered `.svg`/`.png`.
- **Manifest file** `.drawio-canvas/<instance>/manifest.json` in the workspace,
  with pages, layers, cells, the person's presence and recent changes.
- **Preferences** (enabled libraries, theme, …) persist across canvases
  (`lib/settings.mjs`) despite each canvas being a new origin.
- Editor RPCs go to the most recently opened tab only.
- Whole-document events (a file opened, a version restored) and edits touching
  more than 12 cells are reported to the agent as **one line** with a pointer to
  `get_diagram`, instead of a line per cell; each line names its own page.
- Verified end to end (and now in `test/drawio.test.mjs`): real mouse drags from
  the sidebar and on the canvas, F2 relabel, Delete, Ctrl+Z, Ctrl+S to the open
  file; a compressed desktop `.drawio` with UserObjects opened from the bar;
  agent edits, screenshots and SVGs of a page the person is not on; an agent
  edit landing while the person is mid-way through typing a label.
- Audited: `/drawio/` needs the token and refuses raw and URL-encoded `../`;
  the servlet side of the war is never unpacked; the page CSP blocks string
  eval (only `'wasm-unsafe-eval'` for draw.io's WebAssembly edge router).

## Pending

Open work, roughly by value. Each is a place to pick up.

- [ ] **CI workflow not committed.** The YAML is in README; committing it needs a
      token with `workflows` scope. Include the draw.io e2e and several seeds.
- [ ] **Screenshots, focus, layout and `.png` export need an open editor tab.**
      With none, `screenshot` falls back to the approximate SVG renderer and the
      others refuse with `no_editor`. A headless draw.io (Playwright, when
      available) would give the agent eyes with no tab open.
- [ ] **`reload_canvas` kills the person's tab** (new port, new URL). The
      document survives via the snapshot; the tab does not. A stable port per
      instance, or the page reconnecting to a successor, would fix it.
- [ ] **The scratchpad is not carried between canvases.** draw.io keeps it in
      IndexedDB, not `localStorage`; `lib/settings.mjs` only carries the latter.
- [ ] **Same-cell concurrent edits are last-write-wins at cell granularity.**
      The agent is protected by the gate; the person is not (by design). A
      property-level merge (draw.io's patch already has one) would let a
      person's move and an agent's relabel of the same cell both survive.
- [ ] **`search_shapes` ranking** is a heuristic: e.g. "aws s3" ranks the AWS 3D
      icon above AWS 2019+ "Simple Storage Service". Tag-based aliases (s3,
      gke, aks, …) would help.
- [ ] **`layout` switches the person's page** when the target page is not the
      one they are on, because draw.io lays out the current graph.
- [ ] **Repository weight.** The 54 MB archive is a plain file (no Git LFS here).
      Moving it to a GitHub release asset, fetched and verified by
      `drawio-dist.mjs`, would slim clones; the fallback download path already
      exists.
- [ ] **Idle reconciliation is a safety net.** It fires about once per 40 fully
      concurrent rounds, on z-order interleavings. Understanding and removing
      the remaining ordering drift would be cleaner than correcting it.
- [ ] **Merging into very large diagrams costs about a second.** At 2,000 cells:
      load 2.9 s, person → server 0.2 s, agent edit visible 1.2 s. Each inbound
      version re-parses the whole document twice (`getPagesForXml`) and diffs
      it; sending the server's cell changes with the SSE event and patching
      only those would make it proportional to the edit.
- [ ] **Multiple tabs** each sync edits (fine) but only the newest answers agent
      requests; presence reflects whichever tab reported last.
