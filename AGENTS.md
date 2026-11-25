# dsh-aecpt

Student client of AeCpt, delivered as an independently installable
DeepSeek Harness (DSH) plugin. Supervisors use the separately installable
workbench under `../dsh-aecpt-supervisor/`. Both workbenches share the
AeCpt server. Student devices need DSH installed. The product name
comes from Aesthetic Computing (AE + COMPUTE).

## Contributing to the student client

Use a branch in this repository for a focused change. Run `npm ci`,
`npm test`, and `npm run build` before proposing a pull request. Describe
which student workflow changed and how it was verified. Use only
fictional accounts, fixtures, and screenshots. The server and supervisor
bundle have separate review scopes. Repository hosting and access must
be chosen before contributors can open remote pull requests.

## Status

v0.1.0 (2026-11-25, initial public release baseline + GitHub Actions): Reset all package versions to `0.1.0` for initial public release and added GitHub Actions workflows: `.github/workflows/ci.yml` (syntax check, build, unit tests, `npm pack --dry-run` on `main` push/PR) and `.github/workflows/publish-npm.yml` (tag/version guard, automatic `repository` metadata injection for `--provenance` on public repos, prerelease `next` tag handling, dual OIDC Trusted Publishing / `NPM_TOKEN` npm publish, and automatic GitHub Release creation).

v0.26.0 (2026-11-25, npm publish ready): Renamed package from `@local/dsh-aecpt` to public npm name `dsh-aecpt` (removed `"private": true`, synced `cordis.patch.yml`, `build-client.js`, `client.js` config slot key, added `keywords` and `prepublishOnly`). Removed all hardcoded server IPs (`DEFAULT_SERVER_URL = ''`, no `serverUrl` in `cordis.patch.yml`): students paste their supervisor's invitation link (or server URL) in the connect modal, DSH auth flow, or `aecpt_authorize` tool, and `parseServerInput`/`resolveServerBase` automatically extracts the HTTP(S) origin while offering a direct link to open the invitation for first-time registration.

v0.25.0 (2026-11-25, open-source student release ready): Prepared `dsh-aecpt` for MIT open-source distribution to students: (1) added `README.md`, `LICENSE` (MIT), `docs/SERVER_API.md` (student server API + Host proxy reference), refreshed `docs/DETAIL.md` & `locale/*.json`, and updated `.gitignore`; (2) extracted AI prompts into standalone `prompts.js` with multi-week (>7d) span awareness, incremental fusion that passes only existing body + uncompiled fragments (preventing resurrection of student-deleted text), and no-code override via `~/.aecpt/dsh/prompts.json`; (3) expanded student programmatic surface: Host proxy now forwards `GET /meta/`, `aecpt_me` includes `student_number`, `current_period` and `projects`, added `aecpt_plan` tool (`list`/`create`/`update`/`projects`, keeping supervisor sharing as a manual UI action), and upgraded `aecpt_report` (`periods`/`summaries`/`add_summary`, removing supervisor-only `feedback`).

v0.24.3 (2026-11-25, local only, awaiting desktop verification): Added the inline geometric AeCpt brand mark to the main header title (`aecpt-wb-title`) and aligned header line-height/subtitle spacing with `dsh-aecpt-supervisor` v0.5.3.

v0.24.2 (2026-11-25, local only, awaiting desktop verification): Redesigned the student workbench logo (`icon.svg` + `AeCptIcon` in `client.js` for the sidebar and topbar 进展总结 button) as a pure geometric Aesthetic ∩ Computing interlocking dual-ring + central spark mark paired with `dsh-aecpt-supervisor`'s tri-ring logo family.

v0.24.1 (2026-11-25, local only, awaiting desktop verification): Simplified the **进展总结** session popover (`session-popover.js`, `workbench.css`, `index.js`, `store.js`): removed the manual "归属教学周" selector (Host now auto-resolves the current teaching week from `/academic-periods/` with local cache fallback, shown quietly in the header status line); replaced the confusing two-tab "当前会话 / 工作区过往" switcher with one flat, relevance-ordered checklist (`relation`: `session` → `workspace` matched via `session.header.cwd` → collapsible `other` recent records) so all checked items are visible together; flattened nested borders into clean hairline sections. Tests: 40/40 pass (`npm test`).

v0.24.0 (2026-11-25, local only, awaiting desktop verification): Replaced the top-right session header popover with a focused **进展总结** popover (`session-popover.js`, removing unrelated overview/plan/feeds/library tabs from the popover; those stay in the sidebar workbench). Added `GET /summarize/context?sessionId=...` returning unsummarized message/turn counts, multi-day span, current-session prior fragments (`sessionFragments`), and workspace prior fragments (`workspaceFragments`), and upgraded `POST /summarize` to accept explicit `referenceIds` (checked fragments from current session or workspace, up to 10, sorted chronologically) and prompt the model to preface follow-up fragments with a 1-sentence `> 承接前序：…` bridge of earlier progress and open issues while keeping new bullets non-repetitive. Unchecking all references produces a standalone summary; deleting the newly created fragment inside the popover rolls back the session checkpoint for instant re-summarization. Tests: 40/40 pass (`npm test`).

v0.23.1 (2026-11-25, local only, awaiting desktop verification): Refined the Session progress-fragment prompt and context extraction (`index.js` + `store.js`, `POST /summarize`): extracts DSH event timestamps (`event.time`) to annotate messages and detect multi-day / >7-day multi-week sessions; replaces naive `.slice(-60000)` with message-boundary head+tail truncation; injects the previous summary for the same `sessionId` (`latestSessionSummary`) on incremental follow-ups with explicit non-repeat and `已修正 / 已解决 / 已完成` markers; rolls back the session checkpoint when the latest fragment for that session is deleted so users can cleanly re-summarize. Tests: 40/40 pass (`npm test`).

v0.23.0 (2026-11-25, local only, awaiting desktop verification): Two-layer weekly progress workflow separating fragment collection from full report synthesis. Clicking **记入本周汇总** in a DSH session (`POST /summarize`) now stores a concise progress fragment (`### <headline>` + bullets) in the teaching week's `summary_records` pool instead of concatenating repetitive Markdown into `content`; drafts sync `summary_records` to the server on `POST`/`PATCH /api/v1/reports/` (with legacy-server fallback at submit time). The **科研进展** reader (`report-fragments.js` + `client.js`) switches between **完整周报** and **本周汇总 (N)** via a segmented control (drafts with fragments and no compiled body default to **本周汇总**; submitted weeks default to **完整周报**), with collapsible fragment cards, manual snippet entry (`POST /reports/summaries/`), two-step deletion (`DELETE /reports/:id/summaries/:recordId/`), one-click AI synthesis/fusion (`POST /reports/:id/compile/`, supporting both fresh synthesis and fusing existing report text with newly added fragments, usable from both sidebar and popover), and 1-step undo (`POST /reports/:id/undo-compile/`). Verified locally: `npm run build`, 39/39 tests (`npm test`), `npm pack --dry-run`, zero literal colors, and co-load check with `dsh-aecpt-supervisor` passed.

v0.22.0 (2026-11-25, local only, awaiting desktop verification): Removed the legacy `aecpt_login` password-login tool and its `/api/v1/auth/csrf|login|tokens` helper now that the server accepts browser OAuth PKCE only; `aecpt_report` `edit` now requires integer `revision` to match the server's concurrency guard.

v0.21.0 (2026-11-25, local only, awaiting desktop verification): New **论文库** tab (`library-panel.js`) and `aecpt_library` tool for the group's shared paper library on the server (`/api/v1/library/…`). Sub-views 公用库 (search, tag chips, expandable rows, PDF download via blob, single/multi BibTeX copy + `.bib` download), 我的投稿 (status filters, supervisor note on rejection, edit tags/note while pending, two-step withdraw) and 提交论文 (DOI/arXiv resolve, editable form, manual entry, local PDF as base64 or arXiv auto-download, 409 duplicate notice). Host module `library.js`: metadata resolution runs on the Host (Crossref `api.crossref.org/works/<doi>`, arXiv `export.arxiv.org/api/query`) through the feeds public-host guard with 15 s timeouts and size caps; the panel posts JSON (≤75 MiB body cap) and the Host rebuilds multipart (native FormData/Blob) for `POST /library/papers/`, relaying status and body (409 `paper_duplicate` with `existing`); `GET /library/papers/<id>/pdf` is streamed. The JSON forwarder allowlists only `GET /library/papers/`, `/library/submissions/`, `/library/export/` and `GET|PATCH|DELETE /library/papers/<id>/`; review routes stay closed. Tool downloads land in `~/.aecpt/library/<account key>/` (removed by the shared-device cache wipe); tool BibTeX files may only be written inside the home directory.

v0.20.0 (2026-11-25, local only, awaiting desktop re-verification): The overview **近期计划** card is now a Monday–Sunday week strip (per-day open-item counts, past-day overdue marks, a separate "本周之前逾期" chip) with today selected and the selected day's items listed below. Removed the literature **引用到进展** feature at the user's request (unclear purpose; progress drafts are AI-imported): no `/feeds/cite` route, no `aecpt_feeds` `cite` action, no `appendCitation`/`citationLine`; subscriptions are browse/read-state only and never modify drafts.

v0.19.3 (2026-11-25, local only): Merged the overview's separate 本周进展 and 导师反馈 cards into one full-width **科研进展** card (this week + recent feedback), because supervisor feedback is attached to weekly progress entries; the overview now has three cards.

v0.19.2 (2026-11-25, local only): Switched **科研进展** to a reading-first master-detail layout (period list + rendered Markdown reader) since progress drafts are normally imported via AI summary; the Markdown editor now opens only on demand when clicking **编辑** on an existing draft or **手动新建草稿**.

v0.19.1 (2026-11-24, local only, awaiting desktop re-verification): Redesigned student workbench UI with a 4-panel **概览** landing tab (this week's progress, supervisor feedback, upcoming plans, unread literature) alongside **科研进展 / 计划 / 文献订阅**, unified DSH theme-token styling (`workbench.css`, verified against DSH `0.2.3-alpha.2` light/dark tokens and `AppFrame` flex/scroll container rules), accessible tablist/tabpanel and dialog focus/Escape handling, and personal local-only RSS/Atom/arXiv literature subscriptions (`feeds.js`, `feeds-panel.js`, `aecpt_feeds` tool) with SSRF public-host checks, per-account storage under `~/.aecpt/dsh/feeds-<key>.json` (cleared on shared-device cache wipe), expandable plain-text summaries, and one-click Markdown citation into the target teaching week's draft under `### 文献阅读`. Fixed v0.19.0 layout issues (flex + `container-type: inline-size` width collapse, `[hidden]` overridden by `display: grid`, modals trapped inside `container-type` ancestor, and light-theme token contrast/elevation).

v0.18.1 (2026-11-24): The forwarder allowlist now includes `GET /projects/`, which the plan form needs; v0.18.0 rejected it ("无此工作台接口").

v0.18.0 (2026-11-24, local only, not installed or desktop-verified): Disconnect keeps the local cache by default; Settings can also clear it, with an extra confirmation when unsynced work exists. Reconnects compare the server instance and server user id with the cached account: the same account resumes its cache, a different one needs an explicit switch in the panel (agent tools and the settings flow refuse to switch). Every authorization writes a random `bindingId`; all panel requests send `X-Aecpt-Client: 1`, and requests past authorization also send `X-Aecpt-Binding`. Auth and binding helpers live in `binding.js`. The forwarder is an allowlist. Requires server `/api/v1/auth/tokens/current/revoke/` and `server_instance` in `/api/v1/me/` for full behavior; older servers fall back to address-keyed caches.

v0.17.1 (2026-11-24): Successful AI summaries are saved with their draft and checkpoint in the account's local report store. The report detail shows the history. Submission sends the history with the report and requires server migration `reports.0005` when there are local summary records.

v0.17.0 (2026-11-24): The product display name is AeCpt. The AI progress summary button in the Session workbench popover reads the current conversation, calls the Session-selected model, and creates or appends a draft. A persisted per-Session turn/sequence checkpoint makes later summaries incremental. Settings can pin a fixed summary model instead of following the Session model. Entries use FNU teaching-week codes such as 26FA13W, selected from the server academic calendar; legacy ISO periods remain readable.

v0.14.1 (2026-11-24): Connection status indicator in the panel header and a Settings dialog that contains disconnect. The disconnect route is Host-only and does not remove server data.

v0.14.0 (2026-11-24): The student panel shows the connected user's own
weekly reports and feedback. Saved plans can be shared with one current
supervisor at a time and separately updated or revoked. Existing agent
report tool calls keep their prior server-side permission checks.

v0.13.0 (2026-11-24): The existing workbench has a personal Plans tab.
The grouped list and month calendar use the same online plan API through
its Host proxy. Tasks belong to the signed-in user. The deployed server
also needs the plans migration and API before the tab can load tasks.

v0.12.0 (2026-11-23): KaTeX rendering in the weekly-report panel.

- **Weekly-report Markdown**: uses `@uiw/react-md-editor` 4.2.4 with edit,
  preview, and live split modes. The original Markdown goes through the
  existing draft API. Other authors' drafts and submitted reports use the
  same renderer in read-only mode. Inline `$…$` and display `$$` math
  render through KaTeX after Markdown sanitization. KaTeX runs with trust
  disabled and formula limits. Run `npm ci && npm run build` before
  installing from source. The client artifact embeds the editor assets
  and KaTeX WOFF2 fonts and uses the host React runtime.

- **All plugin data lives under `~/.aecpt/`** (user directive):
  `dsh/<binding-hash>.json` sync store, `dsh/feeds-<binding-hash>.json`
  personal literature subscriptions, `library/<binding-hash>/` shared-library
  PDFs downloaded by the agent tool, `backups/` database dumps,
  `exports/` Markdown exports (Host-written, panel shows the path).
  Login credentials stay in the DSH credential store. Do not create
  data directories elsewhere.
- Acceptance runs must leave the user's binding intact (do not log out
  as cleanup); test with a separate account and restore afterwards.

- **Local-server sync layer** (manifest-diff, adapted from
  obsidian-fast-note-sync semantics, independent implementation):
  Host local store per binding under `~/.aecpt/dsh`; reads always
  local (offline-capable, watermark banner); draft writes local-first
  with online push / offline queue + reconnect flush; submit/feedback
  online-only (503 gate). diff3.js auto-merges disjoint edits; overlapping
  regions open a manual resolution UI. 60s background sync.
- Markdown export of visible reports from the panel.
- Tests: `npm test` — 39 (12 diff3, 8 store engine, 4 literature feeds, 2 shared library, 5 math rendering, 3 plan/calendar, 2 plan proxy/connection, 1 account switch/reconnect, 1 AI summary, 1 credential migration).

- **Global panel bar entry** (`sidebar.panellist` icon + keyed `main`
  slot, beside Continuity/dsh-conflux) — this is the "plugin bar" users
  see; the header utility button and Plugins→Installed→configure page
  are two additional entries to the same panel.
- Guide modal auto-pops when unconfigured; the two-step browser
  authorization completes inside the panel via Host proxy
  `/authorize/start|complete` (verified end-to-end: login tab →
  one-time code → connected view with the user's own reports).

- Tools: `aecpt_authorize` / `aecpt_authorize_complete` (browser OAuth
  PKCE flow), `aecpt_logout`, `aecpt_me`, `aecpt_report`, `aecpt_feeds`,
  `aecpt_library`. Legacy `aecpt_login` was removed in v0.22.0.
- Browser authorization flow registered via `ctx.authorization.registerFlow`
  (public OAuth client `aecpt-dsh-plugin`, S256 PKCE, fixed workbench
  callback page + one-time code paste). Verified end-to-end against the
  public staging entry; the password never passes through DSH.
- Client panel in `plugins.row.config` (Plugins -> Installed -> AeCpt
  -> configure): connection state, report list/detail, create/submit/
  feedback. Data flows through the Host same-origin proxy
  `/aecpt-api/*` (bearer token stays in the Host credential store;
  no CORS). Visual rendering and the full guide flow verified in a real
  browser against the live GUI (2026-11-23).
- UI strings are zh literals in v1; locale routing is deferred.

Mechanism constraints learned here: a linked local bundle cannot use bare
`@deepseek-ai/*` imports (plain object tool registrations instead); tool
output schemas are raw JSON Schema (single types, `required` arrays);
reinstalling the same version does not refresh the loaded module
generation — bump the version. Install via `plugin_manager install_bundle`
with this directory as target.

Next increments: panel visual confirmation and locale routing; HTTPS
(domain) before any real account; student device distribution
(installing DSH + this bundle).

## Boundaries

- This repository is published publicly under MIT at `https://github.com/yhong91/dsh-aecpt` and distributed on npm as `dsh-aecpt`.
- Never hardcode any real server IP, domain, student personal information, or credentials anywhere in code, fixtures, or documentation; server URLs are resolved from the supervisor's invitation link or optional user configuration.
- Keep `dist/client.js` and `dist/THIRD-PARTY-NOTICES.txt` reproducible via `npm run build` and verified by `npm test` (`43` unit tests) and `npm pack --dry-run`.
- UI strings are Simplified Chinese; code, comments, and this file are English.