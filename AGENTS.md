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
  editor RPC answers, files, history, settings, and `/api/collab` (asks, the
  agent's status, the digest switch).

Data flow:

```
person ── draw.io ── host.mjs ──(cell changes)──▶ POST /api/sync ─▶ session.applyEditor ─▶ sync.mjs
                         ▲                                                   │
                         └── SSE change ◀── session.commit (diff + journal) ◀┘◀── agent actions (canvas.mjs)
agent ── screenshot/focus/layout/export ─▶ server.requestEditor ─▶ SSE rpc ─▶ host.mjs ─▶ POST /api/rpc

person ── bar (ask, review, Now, Tidy) ─▶ POST /api/collab ─▶ collab.mjs ─▶ AgentLink.send ─▶ host session.send
host session.on (turn, intent, tool, idle, todos) ─▶ AgentLink ─▶ collab.mjs ─▶ SSE collab ─▶ bar chip + drawer
person's selection (presence) ─▶ collab.mjs ─▶ sendAttachmentsToMessage ─▶ pill in the host's prompt
```

`extension.mjs` attaches one `AgentLink` (`lib/agent.mjs`) to the host session
once `joinSession` resolves; every instance's `Collaboration` (`lib/collab.mjs`)
shares it. A host without `send`/`on` leaves it inert and nothing else changes.

## Rules that are not style

1. **No `package.json`, no `node_modules`** in this directory. The only
   non-`node:` import is `@github/copilot-sdk/extension`, resolved by the host.
   `test/protocol.test.mjs` fails the build otherwise. Playwright for tests is
   installed outside (`/tmp/pw`) and named by `DRAWIO_CANVAS_PLAYWRIGHT`.
2. **stdout is the JSON-RPC channel.** Log with `session.log` (the `log`
   callback), never `console.log`, in anything the extension process runs.
3. **After editing `extension.mjs` or `lib/`, call `reload_canvas`**; the
   running child was forked from the old code. The person's tab reconnects by
   itself (same port and token); only if the port was taken meanwhile is there a
   new URL to give them.
4. **Nothing leaves the machine.** Keep the draw.io CSP in `lib/server.mjs`
   same-origin; never add `unsafe-eval`. Network is used only by the fallback
   download in `drawio-dist.mjs`, and never at open.
5. **The person's edits travel as touched cells, never whole documents.** A
   whole-document write from the page would revert agent edits it has not
   merged yet. See the header of `lib/sync.mjs`.
6. **The agent gate is per cell** (`session.editGate`). Do not reintroduce a
   document-wide stale check; it blocks the agent whenever the person is busy.
7. **Only the person's gesture sends anything to the agent.** Asks, review,
   **Now**, and the idle digest (bounded: once per idle stretch, after a minute
   idle and 20 s of quiet, switchable). Never add a send on edit, on presence, or
   on a timer: a canvas is edited continuously, and every send is a model turn
   the person pays for. The selection pill is not a send; it rides the person's
   own next message.
8. **New UI goes in the page around draw.io, not in draw.io.** `ui/host.mjs` and
   `ui/index.html` own the bar and the drawer. The only reach into draw.io is
   through its runtime API, feature-detected and failing to nothing:
   `menus.createPopupMenu` (right-click items), `mxCellOverlay` (badges),
   `getPreferredSizeForCell` (Tidy's label sizes).
9. **Upgrading draw.io is one reviewed change:** update `PINNED` in
   `lib/drawio-dist.mjs` (version, url, sha256, bytes), replace
   `assets/drawio-<v>.war` with that release's `draw.war`, rebuild
   `data/shapes-<v>.json.gz` with `scripts/build-shape-index.mjs`, bump the
   version asserted in `test/drawio.test.mjs` and `test/dist.test.mjs`, and run
   the draw.io and hoocode end-to-end tests. `ui/capture.js` and `host.mjs` use
   draw.io internals (`App.main` callback, `diffPages`, `patch`,
   `getPagesForXml`, `exportToCanvas`, `executeLayoutSpec`, and the three in
   rule 8); the e2e tests are what catch their drift.

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

hoocode end to end is `scripts/e2e-hoocode.mjs` (hoocode keeps no draw.io test
of its own; its canvas docs are generic): a real `hoocode --mode rpc`, this
checkout installed through `/plugin`, a scripted model that sends JSON-string
inputs (as Qwen does), and Chromium as the person — including an ask that wakes
the agent, the selection pill, and `reload_canvas` keeping the tab. Against an
unbuilt hoocode checkout, `HOOCODE_DIR=<hoocode> HOOCODE_BIN=scripts/hoocode-from-source.mjs`. Run it after changing an
action's contract, the gate, or anything in `server.mjs` / `host.mjs`; update
the "How fast" table in README and the speeds in the canvas description if
its timings move.

## Recent changes

- **Working with the agent, not just beside it.** The person asks from the bar
  (`Alt+A`, Enter; `Ctrl+Enter` interrupts) about what they have selected; asks
  are the canvas's task list (drawer: status, the agent's reply, reorder,
  withdraw; the agent's todos underneath; numbered badges on their cells). An
  ask made while the agent is idle is sent at once; while it is busy it rides
  the agent's next result (`new_asks`) and what is still open is sent at idle.
  "N edits since the agent looked" makes one review ask; the idle digest (on by
  default, switchable) sends one short list per idle stretch. A quiet chip shows
  idle or what the agent is on, from the host's `session.on`. New actions
  `get_asks` (with cells' XML, counted as read) and `update_ask`. The selection
  is offered to the host as a pill for the person's next terminal message.
  (`lib/agent.mjs`, `lib/asks.mjs`, `lib/collab.mjs`; `test/collab*.test.mjs`.)
- **Tidy** (`lib/tidy.mjs`, pure and shared with the page): fit to label, snap,
  align, separate overlaps, drop stale bends. The bar's button and the
  right-click item run it in the person's editor as their own undoable edit
  (labels measured by draw.io); the agent's `tidy` action runs it on the
  document. Idempotent and overlap-free on thousands of random pages.
- **`reload_canvas` keeps the person's tab.** The port, token and asks are
  parked with the document on close and taken back on open; the server's
  `hello` carries an epoch, and a page that sees a new one sends its unsent
  edits and adopts the restarted server's document. The status line names a
  refused edit instead of "part of an edit", and holds a result the person asked
  for (Tidy, an ask) against routine "v3 saved" updates.

- **Every action is swept** (`test/actions-sweep.mjs`): ~700 right, wrong and
  strange inputs across all 13 actions, without an editor
  (`test/actions.test.mjs`) and with the person's draw.io open
  (`test/drawio.test.mjs`, which also checks the editor still matches the
  server). A call must succeed or be refused with a known code and a usable
  message. Add a case there when you add an action or an input.
- **Input is checked against each action's own inputSchema** (`checkValue`):
  types, enums (options listed), bounds, items, required, unknown fields (with a
  "did you mean"). `null` on an optional field means "not given".
- **Fixed from the sweep:** `<mxfile>` with no pages emptied the document
  (`no_pages`); `manage_pages` rename/delete without a page hit page 0; cells
  with a missing parent were accepted (`invalid_parent`); `open_file` leaked
  Node errno codes and absolute paths (`file_not_found`, `not_a_file`);
  unknown layouts, including `"circle"` which the description advertised,
  opened an error dialog in the person's editor and hung 25 s — layouts are now
  checked against draw.io's own lists (`LAYOUT_PRESETS`/`LAYOUT_NAMES`, asserted
  against the live editor) and refused in under 1 ms. `layout` no longer sleeps
  150 ms: the page flushes its moves before answering.
- **Descriptions say what really happens:** `edit_diagram` applies the good
  operations and lists the failed ones in `errors` (it had claimed all or
  nothing); speeds in the canvas description are the measured ones in README
  "How fast". Re-measure and update both if the sync path changes.

- **Refusals carry the fix.** `stale_cells` and `no_context` include the current
  XML of what the agent missed (up to 3,000 characters) and mark it read, so the
  retry needs no `get_diagram`. Larger misses still point at `get_diagram`.
- **Malformed input is `invalid_input`,** not a TypeError. A JSON-string input
  is decoded first (some models send `input` that way).
- **Editor requests wait for a loading tab.** The page holds an
  `/api/events?role=loading` stream from the moment it opens until its editor
  stream is registered; `requestEditor` waits on it (15 s) instead of failing
  with `no_editor`, and `screenshot`/`save_file` use the real render rather than
  the fallback. `window.drawioCanvas` is set only once the editor is reachable.
- **The canvas description is the agent's playbook:** the loop, the
  collaboration rule, and measured speed classes. hoocode now shows it in
  `list_canvas_capabilities`. The open-time `status` no longer freezes a
  transient "installing".

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
- [ ] **A reload loses the tab if its port was taken meanwhile.** The canvas
      then serves on a new port and logs it; hoocode prints the new URL.
- [ ] **Tidy's server-side label sizes are estimated** (characters × 7 px);
      the person's button measures with draw.io. Icons and outside labels are
      never resized.
- [ ] **Asks live in memory** (and across a reload); closing the canvas drops
      them. Persisting them beside the manifest would carry them across sessions.
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
