# AGENTS.md

Guidance for agents (and people) changing this repository. `README.md` says what
the canvas does; this file says how it is built, what must not break, what
changed recently, and what is still open.

## The shape of it

A canvas extension for GitHub Copilot (CLI 1.0.89+, experimental mode; in VS
Code through the CLI in its terminal) and for hoocode: `extension.mjs` is
forked by the host and speaks the canvas JSON-RPC protocol through
`@github/copilot-sdk/extension`; `lib/canvas.mjs` declares the actions. Copilot
loads it from `extensions/drawio-canvas/extension.mjs` (a one-line import of the
root), the only place it looks in an installed plugin; hoocode and a hand clone
load the root. The two plugin manifests are `.github/plugin/` (Copilot) and
`.agents-plugin/` (hoocode, which wins precedence when both are present).

The same canvas is also an **MCP server** for hosts with no canvases — VS
Code's Chat view above all: `mcp.mjs` (declared in `.mcp.json`, which VS Code,
the Copilot CLI and hoocode all read from a plugin) runs `lib/mcp.mjs`, which
speaks MCP over stdio in front of `createDrawioCanvas` with its own
`createCanvas`/`CanvasError`. One canvas per server, no instance ids;
`open_canvas` returns the URL and the agent opens it (`open_browser_page` in
VS Code). It offers no tools to `copilot-cli` or hoocode (`offersTools`), which
run the extension, and `.agents-plugin/plugin.json` points hoocode at an empty
`mcp.json` so hoocode never starts it. Each open
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

The hosts differ in ways that matter here (all verified against the real
thing by `scripts/e2e-copilot.mjs`, `scripts/e2e-vscode-chat.mjs` and
`scripts/e2e-hoocode.mjs`):

| | hoocode | GitHub Copilot (CLI, SDK) | VS Code Chat view (MCP) |
|---|---|---|---|
| Who opens it | the person, `/canvas open` | the agent, `open_canvas` (it asks `list_canvas_capabilities` first) | the agent, `open_canvas`, then `open_browser_page` shows it in the Integrated Browser |
| Canvas tools offered | always | only where the session renders canvases: the CLI in experimental mode, or an SDK host that sets `requestCanvasRenderer` (VS Code's Agents window, in progress). `canvasSupportNote` tells the person otherwise | always, as `mcp_drawio-canvas_<action>`, with the server's instructions in the system prompt |
| `input` | JSON-decoded if a string | validated against the declared schema *before* it reaches the canvas; `null` is what the model is told to send for "no input" | an object (MCP requires `type: object`); the canvas validates it |
| Large results | cut at 8,000 characters | over 20 KiB, only a file path reaches the model | passed whole; a screenshot goes as an image |
| Messages from the canvas | `session.send`, labelled `[canvas <id>]`, rate-limited | `session.send`, unlabelled and unlimited; `displayPrompt` is the timeline's line | none: MCP cannot start a turn. The person sends the server's prompts (`/mcp.drawio-canvas.asks`, `.review`, `.draw`); the bar says so (`AgentLink.nudge`) |
| Agent status (chip, digest) | `session.on` | `session.on` | none |
| Selection pill | shown | accepted, not shown (the agent reads `looking_at`) | none (the agent reads `looking_at`) |
| Confirmation | none | none (`--allow-all` or per tool) | before the first tool that is not `readOnlyHint`; the person allows the server's tools for the session |
| Reload | `canvas.close`, then a new process | a signal, then `canvas.open` of the same instance in a new process | stdin closed or a signal; the new server takes the parked canvas back at startup (`resume`) |

## Rules that are not style

1. **No `package.json`, no `node_modules`** in this directory. The only
   non-`node:` import is `@github/copilot-sdk/extension`, resolved by the host.
   `test/protocol.test.mjs` fails the build otherwise. Playwright for tests is
   installed outside (`/tmp/pw`) and named by `DRAWIO_CANVAS_PLAYWRIGHT`.
2. **stdout is the JSON-RPC channel** — in the extension and in the MCP server
   alike. Log with the `log` callback (`session.log` in the extension, stderr in
   `mcp.mjs`), never `console.log`, in anything either process runs.
3. **After editing `extension.mjs` or `lib/`, reload the extension**
   (`reload_canvas` in hoocode, `extensions_reload` or `/restart` in Copilot);
   the running child was forked from the old code. The person's tab reconnects by
   itself (same port and token) because every open instance is parked on close
   *and* on exit (`parkOnExit`); only if the port was taken meanwhile is there a
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
   own next message. Over MCP nothing can send; the person's gesture is
   one of the server's prompts, typed in the chat.
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
   the draw.io, hoocode and Copilot end-to-end tests. `ui/capture.js` and `host.mjs` use
   draw.io internals (`App.main` callback, `diffPages`, `patch`,
   `getPagesForXml`, `exportToCanvas`, `executeLayoutSpec`, and the three in
   rule 8); the e2e tests are what catch their drift.

10. **The capability listing stays under 19 KiB** as Copilot pretty-prints it
    (`test/canvas.test.mjs`). Past 20 KiB Copilot hands the model a file path
    instead of the schemas, and the agent spends a turn reading it before it can
    draw anything. A new action or field pays for itself by trimming words
    elsewhere; a rule that applies to many actions goes in the canvas
    description once (as the page selector's does).
11. **Keep the entry points and the manifests.** `extensions/drawio-canvas/`
    must stay a one-line import of the root `extension.mjs` (Copilot finds a
    plugin's canvas nowhere else; a symlink would loop); `mcp.mjs` and
    `.mcp.json` are how VS Code's Chat view gets the canvas; the versions in
    `.github/plugin/` and `.agents-plugin/` move together (the MCP server reports
    the former's). **Never let a host get the canvas twice**: the MCP server
    offers no tools to a client that runs the extension (`offersTools`; add a
    host there when one starts plugin MCP servers *and* canvases), and
    `.agents-plugin/plugin.json` keeps hoocode off `.mcp.json`.

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

GitHub Copilot end to end is `scripts/e2e-copilot.mjs`, the same collaboration
through the real Copilot runtime (bring-your-own-key provider pointed at a
scripted model; no GitHub account), in three hosts: `--host tui` (the CLI's
terminal in a Python pty; installs with `copilot plugin …`; `--native` adds
Copilot's own WebKit window under a display), `--host sdk` (`CopilotClient`
configured exactly as VS Code's Agents window configures it) and `--host vscode`
(real VS Code under `xvfb-run`: the CLI in the integrated terminal, the person in
the Integrated Browser after Ctrl+clicking the link). Needs `@github/copilot` and
`@github/copilot-sdk` installed outside the checkout, like Playwright. Run it
after the same kinds of change as the hoocode one, and after anything touching
schemas, `extension.mjs`, parking, or `session.send`. It also checks that the Copilot
agent is never offered the MCP server's tools next to the canvas's.

VS Code's Chat view end to end is `scripts/e2e-vscode-chat.mjs`: real VS Code
under `xvfb-run`, the plugin installed with *Chat: Install Plugin from Source*
(default) or by the Copilot CLI (`--install cli`, which VS Code discovers), the
scripted model as a custom-endpoint model picked in the Chat view, the person
answering VS Code's tool confirmations and working in the Integrated Browser.
Run it after changing `lib/mcp.mjs`, `mcp.mjs`, `.mcp.json`, a tool's contract or
the page's nudge. Two things it learned the hard way: VS Code needs
`--password-store=basic` without a keyring (MCP startup waits on secret storage),
and a fresh profile starts Copilot Chat's model providers only once the person
opens Manage Models.

## Recent changes

- **VS Code's Chat view, with the person's Copilot subscription.** The plugin
  now also carries the canvas as an MCP server (`.mcp.json` → `mcp.mjs` →
  `lib/mcp.mjs`): `open_canvas` plus the 16 actions as tools, the playbook as
  server instructions (`PLAYBOOK` in `lib/canvas.mjs`, shared with the canvas
  description), reads marked `readOnlyHint` so VS Code runs them without asking,
  the screenshot returned as an image, and three prompts (`asks`, `review`,
  `draw`) that are how the person starts the agent, since MCP cannot. The page's
  "cannot wake the agent" note comes from the host (`AgentLink.nudge`) and names
  `/mcp.drawio-canvas.asks`. The workspace comes from MCP roots; a restarted
  server takes the parked canvas back at startup, so the tab keeps its URL. The
  Copilot CLI and hoocode start plugin MCP servers too: the server offers
  `copilot-cli` no tools, and hoocode's manifest points it at an empty
  `mcp.json`. Verified in VS Code 1.139.1 installed both ways, and the Copilot
  (terminal, SDK) and hoocode runs re-checked with the server in the plugin.

- **GitHub Copilot, and VS Code through it.** Loads as a Copilot plugin
  (`.github/plugin/`, `extensions/drawio-canvas/extension.mjs`) and was run end
  to end in Copilot CLI 1.0.89, the SDK in VS Code's configuration, and real
  VS Code 1.139. What that needed: action and open schemas accept `null` when
  nothing is required (Copilot validates first and tells the model to send it);
  the capability listing cut from 23.9 KB to 19 KB (Copilot inlines 20 KiB);
  instances parked on exit and on signals, not only on close, and parked
  snapshots scoped by host session (Copilot's instance ids are model-chosen, so
  "drawio-1" is everywhere); the page re-sends presence after a restart; a
  timeline line of the person's own words (`displayPrompt`) for messages the
  canvas sends; a warning in the timeline when the session does not render
  canvases (Copilot without experimental mode) instead of silence.

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

- [ ] **CI workflow not committed.** The YAML is in README (tests on every
      push; the hoocode and Copilot end-to-end runs, all three hosts, on pull
      requests); committing it needs a token with the `workflow` scope. See it
      through its first green run, and add several concurrency seeds.
- [ ] **VS Code's Agents window canvases.** When microsoft/vscode#337780
      (`sessions.experimental.canvases.enabled`) ships, run the canvas in it for
      real; `--host sdk` already mirrors its configuration. It ignores canvases
      restored on resume, so the agent re-opens, and parking brings the document
      back within a minute. Check then that its sessions do not also get the MCP
      tools (its runtime is the Copilot CLI's, so `offersTools` should hold).
- [ ] **VS Code Chat cannot be woken by the canvas, and shows no agent status.**
      MCP has no way to start a chat turn or observe the agent; asks wait for the
      agent's next tool call or the person's `/mcp.drawio-canvas.asks`. If VS
      Code grows either (or MCP Apps can post to the chat), wire it into
      `AgentLink` in `lib/mcp.mjs` and drop the nudge.
- [ ] **VS Code adds ~1 s per tool call** in the Chat view (measured under xvfb,
      no GPU): prefer many operations per call even more there. Re-measure on a
      real desktop.
- [ ] **This checkout as a workspace.** A client that reads a project's
      `.mcp.json` (Claude Code, VS Code's discovery) opened *on this repository*
      starts `${PLUGIN_ROOT}/mcp.mjs` with the token unexpanded and it fails.
      Harmless for installs (hosts expand it for plugins); a form every host
      expands would fix it for contributors.
- [ ] **No selection pill in Copilot's terminal or VS Code** (nor over MCP). The runtime
      accepts `sendAttachmentsToMessage` (`session.extensions.attachments_pushed`)
      but neither host shows it yet; "this" costs the agent one call to read
      `looking_at`. Nothing to change here when they do.
- [ ] **Copilot needs experimental mode** for canvases (1.0.89). Drop the
      warning's wording about it when Copilot turns canvases on by default.
- [ ] **The GitHub Copilot app** hosts canvases through the same SDK contract as
      `--host sdk` but was not run here.
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
