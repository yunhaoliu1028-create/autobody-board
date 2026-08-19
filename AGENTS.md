# AGENTS.md — Read this first

This file is auto-loaded into context by both **Codex CLI** (via `AGENTS.md`) and **Claude Code** (via `CLAUDE.md`, which redirects here). It is the single source of truth for project state across sessions.

---

## Working Rules (for Claude / Codex / any AI agent)

1. **Before touching code**: read the **Change Log** section below. The codebase may not look like it did last session — assume something changed.
2. **After making code changes**: append **one line** to the top of the Change Log with:
   - ISO date — tool name (Claude / Codex) — one-sentence summary
   - If the change is non-trivial, add a session section further down and link to it
3. **When uncertain about recent state**: also run `git log --oneline -20`. This doc can lag git by one session.
4. **Do not delete entries from the Change Log without asking.** Old entries get trimmed only on user request.
5. **Session sections rot fast.** Anything that's been re-implemented or superseded should be removed when noticed — don't archive stale design docs.

---

## Stack
React + Vite + Firebase (Firestore + Hosting) + vite-plugin-pwa
Deployed at: https://bodyshop-board.web.app
PWA — employees use it as an installed app on iPhone/Android.

---

## Change Log
*Newest first. One line per change. Append every session.*

- **2026-08-19 - Codex** Made GIB Apply and Undo validate-first atomic Firestore batches so failures cannot leave partial RO or task changes. → [session below](#session-august-19-2026-codex--gib-atomic-apply-and-undo)
- **2026-08-19 - Codex** Made visible GIB action RO and assignee fields authoritative so stale hidden IDs cannot redirect writes or assignments. → [session below](#session-august-19-2026-codex--gib-action-identity-safety)
- **2026-08-19 - Codex** Added strict, vendor-scoped GIB calendar validation and blocked invalid target, drop-off, and parts dates before Apply. → [session below](#session-august-19-2026-codex--gib-strict-date-validation)
- **2026-08-19 - Codex** Isolated GIB inference, workflow normalization, and parts fallback parsing by RO scope to prevent multi-RO context leakage. → [session below](#session-august-19-2026-codex--gib-per-ro-scope-isolation)
- **2026-08-18 - Codex** Hardened GIB parts-order parsing against received-order false positives, vendor/date contamination, and weaker duplicate actions, then deployed it to Firebase Hosting. → [session below](#session-august-18-2026-codex--gib-parts-order-parser-hardening)
- **2026-07-01 - Codex** Simplified the Production Board revenue card controls with a single month title dropdown and a three-dot actions menu.
- **2026-07-01 - Codex** Added Production Board month-selectable revenue and CCC delivered report reconciliation for stable delivered dates and final report amounts.
- **2026-06-24 - Codex** Preserved explicit Parts GIB vendor names so Parts Authority no longer gets rewritten to PAC.
- **2026-06-04 - Codex** Kept Parts inline vendor rows visible during received-quantity editing until the user saves changes.
- **2026-06-04 - Codex** Softened the Production Board delivered revenue segment in dark mode while keeping solid light-mode progress styling.
- **2026-06-04 - Codex** Switched the Production Board active-estimate revenue segment to a muted violet projected layer with uppercase labels.
- **2026-06-04 - Codex** Refined the Production Board revenue strip with uppercase title styling and a warmer active-estimate progress color.
- **2026-06-04 - Codex** Updated the Production Board monthly revenue strip with delivered and active-estimate stacked progress segments.
- **2026-06-04 - Codex** Compacted the Production Board monthly revenue progress card to better match the dashboard density.
- **2026-06-04 - Codex** Added a Production Board monthly repair revenue progress bar using delivered-date TotalAmount totals and a Settings monthly goal.
- **2026-06-04 - Codex** Made Parts Update mode prioritize unreceived vendor rows and keep fully received vendors collapsed until expanded.
- **2026-06-04 - Codex** Refined Parts inline update typography, lighter edit layout, compact footer actions, and dark-mode date input icon color.
- **2026-06-04 - Codex** Unified Parts page role access and edit permissions through a shared parts-page role list for managers, estimators, and parts managers.
- **2026-06-04 - Codex** Tightened Parts Manager inline update rows with optional vendor rename controls and compact Save/Cancel actions.
- **2026-06-04 - Codex** Changed Parts Manager Update mode to inline batch editing for vendor ETA, ordered quantity, and received quantity.
- **2026-06-04 - Codex** Simplified Parts Manager manual updates with an Update mode, Add vendor action, delete support, and card-level status feedback.
- **2026-06-04 - Codex** Persisted Parts Manager sort preference so Parts ETA sorting survives refreshes and parts-status updates.
- **2026-06-03 - Codex** Fixed batch parts-order parsing so misspelled Kaystone dedupes to Keystone and keeps per-vendor ETA.
- **2026-06-02 - Codex** Made order-and-wait GIB parts actions append new 0-received vendor orders instead of merging into completed vendor lines.
- **2026-06-02 - Codex** Normalized order-and-wait parts GIB actions as ordered 0-received vendor orders instead of backorders.
- **2026-06-02 - Codex** Tightened note-derived parts received inference so waiting or short vendor notes no longer generate received actions.
- **2026-05-29 - Codex** Prevented shared full/mini GIB draft updates from echoing between instances and causing mini action preview flicker.
- **2026-05-29 - Codex** Fixed final action deduping so multiple received-parts vendors on the same RO are preserved.
- **2026-05-29 - Codex** Covered bare vendor fraction notes like Walnut Auto Parts 2/2 and verified GIB produces both received actions for the multi-RO shorthand case.
- **2026-05-29 - Codex** Added note-based received quantity recovery using the nearest vendor fraction when GIB notes contain vendor 2/2 confirmations.
- **2026-05-29 - Codex** Parsed received-all vendor updates per double-slash segment so multi-RO GIB input applies each vendor to the correct RO.
- **2026-05-29 - Codex** Split received-all vendor parsing on shop shorthand separators like ampersands and double slashes.
- **2026-05-29 - Codex** Suppressed parts-order suggestions when the same RO/vendor already has a received-parts action from GIB parsing.
- **2026-05-28 - Codex** Reworked RO Board GIB so the full box stays in page flow and a separate fixed mini bar appears after scrolling.
- **2026-05-28 - Codex** Kept RO Board Status list sorting aligned with Kanban priority order and stabilized sticky GIB scroll behavior.
- **2026-05-28 - Codex** Made RO Board List and Print default to the current manually ordered Kanban sequence.
- **2026-05-27 - Codex** Nested Total Loss cards under the Pending column on the RO Board to keep the kanban compact.
- **2026-05-27 - Codex** Added manager drag-reordering within RO Board kanban columns with saved priority positions.
- **2026-05-27 - Codex** Added partial received counts to RO Board parts badges and made the board GIB morph into a sticky mini bar while scrolling.
- **2026-05-27 - Codex** Fixed Parts ETA sorting and summaries to use only active unreceived vendor ETAs.
- **2026-05-27 - Codex** Added no-replacement-parts handling so GIB and AI Assistant mark eligible ROs all received without creating a 0-qty missing-vendor order.
- **2026-05-26 - Codex** Added a Parts GIB fallback that turns confirmed vendor quantities in generated notes into missing received actions.
- **2026-05-26 - Codex** Added deterministic parsing for "all parts from vendor A and vendor B" so each listed vendor is marked received.
- **2026-05-26 - Codex** Fixed all-parts-except parsing for multiple short vendors and PH Chevy alias matching in Parts GIB.
- **2026-05-26 - Codex** Changed the Parts GIB to one sticky morphing instance so full and mini states transition smoothly without losing draft/actions.
- **2026-05-26 - Codex** Shared Parts full and mini GIB draft state so text and parsed actions survive scrolling between them.
- **2026-05-26 - Codex** Fixed the Parts sticky GIB input width so it stretches to the microphone controls.
- **2026-05-26 - Codex** Reshaped the Parts sticky GIB into a one-line bar with a wider input and compact right-side controls.
- **2026-05-26 - Codex** Relaxed the Parts sticky GIB into a taller mini panel with a two-line input and clearer controls.
- **2026-05-26 - Codex** Added a compact sticky GIB on the Parts page so parts updates stay available while scrolling ETA cards.
- **2026-05-26 - Codex** Added deterministic action inference so GIB and floating AI split rental and target-date notes into structured RO card updates.
- **2026-05-26 - Codex** Brought floating AI Assistant action application closer to GIB by adding status, drop-off, complete-phase, changeLog, and downstream-task handling.
- **2026-05-26 - Codex** Fixed the floating AI Assistant so rental and target due-date actions update RO card fields instead of only writing notes.
- **2026-05-22 - Codex** Increased print sheet typography with stronger RO numbers and status group headers.
- **2026-05-22 - Codex** Tuned the RO Board print sheet with shaded status headers, wider notes, and shorter parts labels.
- **2026-05-22 - Codex** Made print status group headers uppercase and heavier for meeting readability.
- **2026-05-22 - Codex** Softened print status group styling with lighter dividers and more balanced header type.
- **2026-05-22 - Codex** Shortened Estimator and Body Tech names to first names on the print sheet.
- **2026-05-22 - Codex** Centered and enlarged print status group headers and moved Body Tech before Status.
- **2026-05-21 - Codex** Fixed duplicate parts-order action suggestions when vendor spacing differs, such as Tire Rack vs tirerack.
- **2026-05-21 - Codex** Emphasized current-week Due dates on the RO Board print sheet.
- **2026-05-21 - Codex** Changed missing Due values in print output to a plain hyphen to avoid encoding artifacts.
- **2026-05-21 - Codex** Added weekday labels to Due dates on the RO Board print sheet while leaving Drop-off date-only.
- **2026-05-21 - Codex** Replaced the print Concern column with a compact blank Note column for meeting hand notes.
- **2026-05-21 - Codex** Added Rental and concise Concern columns to the RO Board morning meeting print sheet.
- **2026-05-21 - Codex** Tightened the print meeting sheet layout with lighter text labels, shorter parts counts, and smarter insurer abbreviations.
- **2026-05-21 - Codex** Optimized RO Board print output as a black-and-white morning meeting sheet with parts ordered/received counts.
- **2026-05-21 - Codex** Shortened insurance company names in RO Board list rows and print output.
- **2026-05-21 - Codex** Added Total Loss as a formal RO status and AI-recognized status update.
- **2026-05-21 - Codex** Enforced Body Tech role validation on RO saves, AI task assignment, and cleaned invalid board assignments.
- **2026-05-21 - Codex** Added sortable RO Board list headers and status-grouped print output.
- **2026-05-21 - Claude** Fixed GIB "Applying…" permanent hang on status updates. Root cause: `taskRules.js` templates are inconsistent — only `paintPrimaryTasks()` carries `category`/`taskKind`; teardown/reassembly/detail/sublet/body_work don't, so `taskFieldsFromTemplate` wrote `category: undefined` and Firestore `addDoc` threw synchronously. `AIInputBox.jsx`: `addTask` + `taskFieldsFromTemplate` now strip undefined fields before writing; `handleApply` wrapped in an outer try/catch so a throw during Step 1/2 action-bucketing can no longer leave the button stuck (the inner try only covered Step 3).
- **2026-05-21 - Codex** Added an apply timeout so GIB action submission cannot leave the page stuck forever.
- **2026-05-21 - Codex** Added parts status/order/receipt/return apply support to the floating AI assistant.
- **2026-05-21 - Codex** Added the full AI Quick Update action box to the manager Tasks page.
- **2026-05-21 - Codex** Kept worker RO cards visible in manager mobile preview even when no active task exists yet.
- **2026-05-21 - Codex** Hid worker task delete behind an edit control in manager task views.
- **2026-05-21 - Codex** Showed manager-added task notes inside worker mobile task hints.
- **2026-05-21 - Codex** Replaced manager worker-task viewing with a mobile-style worker preview that keeps vertical RO drag ordering.
- **2026-05-20 - Codex** Preserved distinct multi-vendor Parts Order actions through action-card deduping.
- **2026-05-20 - Codex** Added deterministic multi-vendor parts-order parsing for compact Parts Manager updates.
- **2026-05-20 - Codex** Enforced strict role matching for AI Body Tech and Painter assignments.
- **2026-05-20 - Codex** Prevented shop repair ETA updates from being misrouted into vendor parts ETA updates.
- **2026-05-20 - Codex** Collapsed completed mobile My Work tasks behind a compact Completed summary row.
- **2026-05-20 - Codex** Added mobile paint-team self-healing for Paint Prep/In Paint ROs that were already missing primary paint tasks.
- **2026-05-19 - Codex** Added mobile bodyman status-task backfill for Teardown, Body Work, and Reassembly ROs.
- **2026-05-19 - Codex** Added paint task backfill when an RO enters Paint Prep or In Paint.
- **2026-05-19 - Codex** Changed bodyman mobile Done filtering to require Teardown, Repair, and Reassembly main tasks all completed.
- **2026-05-19 - Codex** Added mobile paint-task status promotion and kept the Upcoming section visible even when empty.
- **2026-05-19 - Codex** Tuned the mobile camera shutter feedback into a very quiet two-tick sound.
- **2026-05-19 - Codex** Replaced the mobile camera shutter tone with a softer two-click sound.
- **2026-05-18 - Codex** Reused the desktop daily notes summary display inside the mobile RO quick sheet.
- **2026-05-18 - Codex** Added mobile camera shutter sound and tap-to-enlarge queued photo thumbnails without vibration.
- **2026-05-18 - Codex** Limited mobile My Work RO quick-sheet opening to the RO number link instead of the whole card.
- **2026-05-18 - Codex** Unified attachment image compression across GIB, mobile, and RO Detail uploads with a 300KB target cap.
- **2026-05-18 - Codex** Requested higher-resolution live camera streams for GIB and mobile photo capture so realtime photos are not saved from low-res previews.
- **2026-05-18 - Codex** Increased uploaded attached-photo quality to 2560px JPEG 0.9 for larger, more readable downloads.
- **2026-05-18 - Codex** Added reusable Firebase Storage CORS config for reliable attached-photo downloads from the app origin.
- **2026-05-18 - Codex** Fixed RO detail white screen by removing misplaced attachment preview code from the task list component.
- **2026-05-15 - Codex** Changed Parts Manager RO card header clicks to open the existing right-side RO drawer for notes/photos instead of navigating to full RO detail.
- **2026-05-15 - Codex** Added read-only mobile RO quick sheet with notes/photos and Phase A Spanish translations for mobile worker My Work/navigation/settings.

- **2026-05-15 — Codex** Refined GIB paint mentions: assigning secondary work to painter/helper now creates team-visible non-blocking paint tasks, routes prep-like work to `paint_prep`, and ensures primary paint tasks exist without duplicates.
- **2026-05-15 — Codex** Normalized paint primary tasks: prep/paint generate as two team-visible primary tasks, paint-primary dedupe ignores title drift, GIB paint-ready/status changes complete implied upstream tasks, and painter views sort prep before paint.
- **2026-05-15 — Codex** Tightened paint-team release flow: body-work moves auto-assign fixed painter/helper team, GIB blocks repair release without body tech, painter mobile visibility requires paint/refinish work, and added a read-only paint-team data audit.
- **2026-05-15 — Codex** Granted estimator accounts manager-level UI access, Firestore manager permissions, and manager-level AI assistant context.
- **2026-05-15 — Claude** Investigating reported divergence between painter and paint_helper "My Work" task views. Wrote backfill util + split AddEditRO dropdowns (not yet deployed). Root cause not identified. → [open thread below](#open-thread-painter-vs-helper-view-divergence-2026-05-15)
- **2026-05-15 — Claude** Restructured handoff doc → `AGENTS.md` + `CLAUDE.md` pointer; added Working Rules and Change Log convention.
- **2026-05-14/15 — Claude** Painter workflow refactor: `needsPaint` gate from CCC Paint Hrs, painter/helper "My Work" split into Active + Upcoming, removed Order parts auto-task, Detail task split into QC + delivery prep, RO assignment changes now sync pending tasks. → [session below](#session-may-1415-2026-claude-code--painter-workflow-refactor)
- **2026-05-06/07 — Claude** Parts workflow role split (estimator orders / parts_manager tracks), AI token + role personalization fixes, new `DailyNotesLog` component with summarized past-day notes. → [session below](#session-may-67-2026-claude-code--parts-workflow--notes-overhaul)

---

## Session: August 19, 2026 (Codex) — GIB Atomic Apply and Undo

**Status:** Implemented and independently reviewed on the isolated Draft PR branch. Not deployed to production.

Database checked:
- The project has one Firestore database: `(default)`, `STANDARD`, `FIRESTORE_NATIVE`, region `us-west2`.

Changed:
- Replaced eager `addDoc` / `updateDoc` task writes with a read-only task catalog and an in-memory mutation plan.
- Delayed every RO update, new task, and existing task completion until all actions, assignees, releases, queries, and write-count checks pass.
- Committed the complete plan with one Firestore `writeBatch`, capped at 450 writes; a permission or write failure now leaves the full batch unchanged.
- Finalized phase-completion intents after all task creation planning so opposite action orders produce the same task state.
- Replaced the cancel-unsafe 20-second rejection race with a slow-commit warning that keeps Apply locked until the real commit resolves or rejects.
- Made Undo one atomic batch and added restoration of existing tasks changed by `complete_phase`, in addition to RO restoration and new-task deletion.
- Added source-contract tests plus task-selection and opposite-action-order regressions.

Verification:
- `npm.cmd run test:gib-scope` — 47/47 passing.
- `npm.cmd run test:parts-parser` — 24/24 passing.
- `npm.cmd run build` — production build succeeded; only the existing large-chunk warning remains.
- Local Vite preview — `/` and `/assets/index-DPB5g5lN.js` both returned HTTP 200.
- Two independent sub-agent reviews — PASS for Step 5, with no in-scope P0/P1 findings.

Deferred to the next isolated step:
- Concurrent stale-snapshot protection, cross-client duplicate prevention, refresh/retry idempotency, an operation ledger, and Undo revision/authorization checks.

Deployment:
- No Firebase deploy was run; the live site remained unchanged while staff were using it.

---

## Session: August 19, 2026 (Codex) — GIB Action Identity Safety

**Status:** Implemented and independently reviewed on the isolated Draft PR branch. Not deployed to production.

Changed:
- Added one shared action identity resolver so a visible RO number always overrides a conflicting hidden `roId` across normalization, preview, release checks, and Apply.
- Made an explicitly blank or unknown visible RO/assignee block hidden-ID fallback; legacy actions that entirely lack the visible field retain ID-only compatibility.
- Cleared stale `roId` and `assigneeUid` values when action cards are edited, including when the visible value is cleared.
- Unified body-tech, painter, and task assignment resolution; unmatched or wrong-role assignments now stop Apply instead of silently succeeding.
- Added regression coverage for conflicting, unknown, blank-visible, and legacy ID-only action identities.

Verification:
- `npm.cmd run test:gib-scope` — 40/40 passing.
- `npm.cmd run test:parts-parser` — 24/24 passing.
- `npm.cmd run build` — production build succeeded; only the existing large-chunk warning remains.
- Independent sub-agent review — PASS, with no P0/P1/P2 findings after the UID-only Apply correction.

Deployment:
- No Firebase deploy was run; the live site remained unchanged while staff were using it.

---

## Session: August 19, 2026 (Codex) — GIB Strict Date Validation

**Status:** Implemented, repeatedly red-teamed by independent sub-agents, and verified on an isolated branch. Not yet deployed.

Changed:
- Added one strict calendar parser for ISO, US numeric, English-month, and Chinese dates, including leap-year and impossible-date rejection without JavaScript rollover.
- Preserved the user's invalid source token on target-date, drop-off, parts-order, and parts-received actions so the preview can explain and edit the problem.
- Blocked Apply before any write when an action contains an invalid date; choosing a valid date in the action editor clears the block.
- Scoped parts ETA evidence by RO, vendor, and receipt-versus-order intent, including compact `and`, `/`, `&`, and `+` vendor separators and overlapping vendor names.
- Kept dates local to each English or Chinese vendor clause; shared ETAs apply only when the input explicitly says `all ETA`.
- Preserved invalid ETA evidence through deterministic parts fallbacks, duplicate/translation merges, Parts Manager conversion, and the post-inference received-except/waiting-order parsers.
- Added Chinese target, drop-off, and parts date context plus bilingual and multi-vendor regression coverage.

Verification:
- `npm.cmd run test:gib-scope` — 30/30 passing.
- `npm.cmd run test:parts-parser` — 24/24 passing.
- `npm.cmd run build` — production build succeeded; only the existing large-chunk warning remains.
- Independent sub-agent release-gate review — final PASS, with no reproducible date-domain P0/P1 findings.
- No Firebase deployment was performed in this step; the live site remained unchanged.

---

## Session: August 19, 2026 (Codex) — GIB Per-RO Scope Isolation

**Status:** Implemented, independently reviewed, and verified on an isolated branch. Not yet deployed.

Changed:
- Added explicit per-RO input scopes, including intentional grouped-RO clauses, repeated clauses, bare RO numbers, and Chinese input.
- Prevented rental, paint-ready, authorization, assignee, body-task, and parts context from being reused across unrelated ROs.
- Made raw RO-scoped input override conflicting model-generated rental text and fill explicitly grouped ROs even if the model omitted one member.
- Scoped deterministic parts-order recovery and removed model orders whose vendor is explicitly tied to another RO, while preserving legitimate vendor ETA updates.
- Bound Apply-time workflow inference to the submitted input snapshot instead of later textarea edits.
- Added a model instruction that multi-RO facts must remain within their nearest explicit RO clause.

Verification:
- `npm.cmd run test:gib-scope` — 12/12 passing.
- `npm.cmd run test:parts-parser` — 18/18 passing.
- `npm.cmd run build` — production build succeeded; only the existing large-chunk warning remains.
- Independent sub-agent review — final PASS, with no remaining P0/P1 findings for this step.

Deferred intentionally:
- Strict date parsing and calendar validation remain the next isolated change; no production deployment was performed in this step.

---

## Session: August 18, 2026 (Codex) — GIB Parts-Order Parser Hardening

**Status:** Implemented, verified, and deployed to `https://bodyshop-board.web.app`.

The reported bilingual RO9725 update produced two extra Parts Order actions because local fallback parsing treated a completed Sepaplus order as new and captured `today` as part of the Keystone vendor. The model-output safety passes also could leave those noisy actions in place when their vendor strings no longer exactly matched the receipt or correct order.

Changed:
- Added `src/utils/partsOrderParsing.js` as the shared pure parser for explicit vendor preservation and missing-order recovery.
- Excluded historical orders that are already received, removed temporal/receipt suffixes from vendor matching, and supported numeric, English-month, and Chinese dates.
- Prevented receipt quantities from being inferred as orders in mixed updates, kept shared ETAs scoped to one clause/RO, rejected impossible calendar dates, and normalized the common `Keyston` typo.
- Reconciled noisy model vendor strings against deterministic candidates, removed receipt-covered orders with parser metadata suffixes, and made duplicate merging keep the more complete action's quantity and received count.
- Added `npm.cmd run test:parts-parser` with regression coverage for the reported input and related edge cases.

Verification:
- `npm.cmd run test:parts-parser` — 12/12 passing.
- `npm.cmd run build` — production build succeeded; only the existing large-chunk warning remains.
- `npx.cmd -y firebase-tools@latest deploy --only hosting` — release completed successfully.
- Live verification — homepage and `/assets/index-Cxap89NM.js` returned HTTP 200; served HTML references `index-Cxap89NM.js`.

---

## Open Thread: Painter vs Helper view divergence (2026-05-15)

**Status: unresolved, handed off to Codex.**

### Symptom
User reports that the painter (Gustavo Montes) and the paint_helper (Fernando Marino) see different task lists in their respective "My Work" mobile views (`src/pages/MobilePainterTaskView.jsx`). Design intent is that they share one paint-team view.

### What was tried
1. **Hypothesis A — data asymmetry on RO assignment fields.** Suspected that some ROs had only `assignedPainter` set, or had helper.uid stored in `assignedPainter` due to the legacy AddEditRO dropdown accepting both roles.

2. **Backfill script written** — `src/utils/_backfillPaintAssignments.js`. Loads on demand via `await import('/src/utils/_backfillPaintAssignments.js')`. Finds the unique painter + paint_helper users, then for every `needsPaint=true` RO normalizes `assignedPainter` → painter.uid and `assignedPaintHelper` → helper.uid. Supports `{ dryRun: true }`.

3. **Result**: dry-run + apply both reported **`0 of 7 ROs need normalization`**. All 7 `needsPaint=true` ROs already have correct assignments. So data asymmetry on that field set is NOT the cause.

### Where to investigate next
- Filter logic in [`MobilePainterTaskView.jsx`](src/pages/MobilePainterTaskView.jsx) lines ~837–863: `paintTeamRoIds`, `paintTeamUids`, `assignedTasks`. Specifically check what happens when `task.assignedTo` is one specific uid (set at auto-creation time) vs the paint-team-share rule.
- Possible causes still on the table:
  - A task has `assignedTo === helper.uid` but `task.phase` is not in `{paint_prep, paint}` (e.g. manually-added task), so the paint-team-share rule doesn't kick in.
  - An RO with `needsPaint != true` where one of painter/helper is assigned — backfill script only scanned `needsPaint=true`.
  - Tasks created before the recent rules-engine changes may have stale `assignedTo`.
- Ask the user for a specific example: one RO# where painter and helper see different things, plus what each sees. That'll narrow it down fast.

### Uncommitted UI change waiting on root-cause decision
`src/pages/AddEditRO.jsx` was modified to split the "Painter" dropdown into two:
- **Painter** — only `role === 'painter'` users
- **Paint Helper** — only `role === 'paint_helper'` users

Also added `assignedPaintHelper: ''` to the `EMPTY` form default. **Not yet built/deployed.** Safe to ship as-is once root cause is decided; it's a defensive UI improvement either way.

### Loose ends to clean up
- **Delete** `src/utils/_backfillPaintAssignments.js` after handoff confirms it's no longer needed (data is already clean).
- **Firestore index error** seen once in browser console while user was on Parts page: `FirebaseError: [code=failed-precondition]: The query requires an index.` Source not identified. Probably unrelated to the backfill (which uses single-field `where`). Possibly from `TaskList` in `RODetail.jsx` (where + orderBy on different fields). Investigate if it recurs.

---

## Session: May 14–15, 2026 (Claude Code) — Painter Workflow Refactor

**Deployed:** https://bodyshop-board.web.app

Goal: fix logic gaps between painter/helper "My Work" view and auto-task assignment rules.

### 1. `needsPaint` field — CCC-driven paint flow gate
New RO boolean field. CCC `Paint Hrs > 0` → `needsPaint = true` + auto-assigns the unique painter and paint_helper from the user pool. `--` or `0` → `false`. Only displayed on RO Detail (low-importance info).

**Sync behavior:** upgrade-only — `false → true` on subsequent sync if Paint Hrs appears; no auto-downgrade.

Changed:
- `chrome-extension/background.js` + `chrome-extension/popup.js` (mirrored): added `parsePaintHrs()` + `findUniqueUserByRole()` helpers; `loadExistingROs` mask expanded with `paintHrs`/`needsPaint`/`assignedPainter`/`assignedPaintHelper`; `writeRO` CREATE branch initializes the field, UPDATE branch upgrades it.
- `src/pages/RODetail.jsx`: shows "Needs Paint: Yes/No".

### 2. Rules engine — conditional paint flow
`src/engine/taskRules.js`:
- `PHASE_NEXT_STATUS.body`: when `ro.needsPaint === false`, jumps directly to `reassembly` (skips `body_complete` / `paint_prep` / `in_paint` chain).
- `DOWNSTREAM_TASK_RULES.body_complete`: returns `[]` when `!needsPaint` (defensive — shouldn't normally trigger since body skips it).
- Painter fallback role changed from `production_manager` → `painter` (single-painter shop; tasks no longer pollute the manager's queue).
- Added `DOWNSTREAM_TASK_RULES.reassembly` to create the Reassembly task on the !needsPaint shortcut path. The legacy `paint_complete` entry still creates it on the normal paint path; dedup at the call site prevents duplicates if both paths run.

### 3. `createDownstreamTasks` dedup
`src/pages/ROBoard.jsx` + `src/pages/TaskBoard.jsx`: before inserting a templated task, check Firestore (ROBoard) or local `tasks` state (TaskBoard) for an existing non-completed task with the same `roId + phase + title`. Title is part of the key so multiple distinct tasks within one phase (QC inspection + Final delivery prep) coexist.

### 4. Painter / Paint Helper "My Work" view — Active + Upcoming split
`src/pages/MobilePainterTaskView.jsx`:
- New status sets: `PAINTER_ACTIVE_STATUSES = {body_work, body_complete, paint_prep, in_paint}`, `PAINTER_UPCOMING_STATUSES = {checked_in, teardown, waiting_parts}`.
- `workerRos` filtered to visible statuses ∪ `needsPaint !== false`. RO at `paint_complete` and beyond no longer appears.
- New `activeRos` (derived from `filteredRos`) and `upcomingRos` (independent of filter chips).
- Render splits into two sections: **My ROs** (active) + **Upcoming** (collapsible, badge with count, tasks not displayed since none exist yet). Upcoming section hidden entirely if empty.
- Painter and paint_helper still share the same view (one team).

### 5. Removed "Order parts" auto-task
`src/engine/taskRules.js`: deleted `DOWNSTREAM_TASK_RULES.waiting_parts`. Parts ordering is now tracked solely in `PartsManagerView` (which already has its own `partsSubtasks` workflow). Estimator no longer gets a duplicate task on the task board.

Existing pending `phase: 'waiting_parts'` tasks were checked and cleaned up in the live DB (one-time `src/utils/_cleanupOrderParts.js` script, since deleted).

### 6. Detail task split — QC + delivery prep
`src/engine/taskRules.js` `DOWNSTREAM_TASK_RULES.detail`:
- **"QC inspection"** → `production_manager` (role pool)
- **"Final delivery prep"** → `assignedEstimator`, fallback `estimator` role pool

Both keep `phase: 'detail'` so `STATUS_PHASE_TRIGGER.detail` still works — both must complete to promote RO → `ready`.

### 7. Sync pending-task assignees when RO assignments change
`src/pages/AddEditRO.jsx`: new `syncPendingTaskAssignees()` helper, called after RO update. When `assignedBodyMan` / `assignedPainter` / `assignedPaintHelper` change on save:
- `assignedBodyMan` → updates pending tasks in phases `[teardown, body, reassembly]`
- `assignedPainter` → updates pending tasks in phase `paint`
- `assignedPaintHelper` → updates pending tasks in phase `paint_prep`

`in_progress` and `completed` tasks are deliberately untouched — work already started shouldn't be silently reassigned.

### Files touched
`src/engine/taskRules.js`, `src/pages/ROBoard.jsx`, `src/pages/TaskBoard.jsx`, `src/pages/RODetail.jsx`, `src/pages/MobilePainterTaskView.jsx`, `src/pages/AddEditRO.jsx`, `chrome-extension/background.js`, `chrome-extension/popup.js`.

### Known follow-ups
- Painter view verification (Active/Upcoming) requires logging in as painter/paint_helper — not tested in this session.
- Manual `paint_complete → reassembly` drag now correctly skips duplicate Reassembly creation (via dedup); existing duplicates from before this change are not cleaned up.
- The legacy `assignedPaintHelper` field has no direct UI in AddEditRO; it's set only by CCC sync or by the `setRoField` flag on Paint Prep task creation in `createDownstreamTasks`.

---

## Session: May 6–7, 2026 (Claude Code) — Parts Workflow + Notes Overhaul

**Last commit:** `fadb0fe` — "Parts workflow, daily notes overhaul, AI fixes"
9 files changed, 353 insertions, 302 deletions. Create `src/components/DailyNotesLog.jsx`.

### 1. AI Token Limit Fix
- `maxTokens` raised to **8192** (API hard cap) for `askShopAssistant` in `src/hooks/useAI.js`
- `maxTokens` = **4096** for GIB `callClaude`
- At $15/MTok Opus input+output, 8192 tokens ≈ $0.61/call — under $1.50 manager budget
- Truncation recovery: appends `}}` before parse attempt; regex uses `((?:[^"\\]|\\.)*)` to handle escaped chars

### 2. AI Role Personalization
`askShopAssistant` now accepts `{ messages, ros, employees, callerName, callerRole }`.
`FloatingAssistant.jsx` passes:
```js
const caller = employees.find(e => e.uid === user?.uid)
callerName: caller?.name, callerRole: caller?.role
```
System prompt injects a CALLER section:
- `manager/production_manager`: full overview, all ROs, priorities, supplement flags
- `estimator`: their assigned ROs, estimate writing, supplement status, parts ordering
- `parts_manager`: parts tracking across all ROs — ETA, receipt, returns; NOT ordering
- `body_man/painter/technician`: only their assigned ROs/tasks
- `unknown`: manager-level access

### 3. Parts Workflow Role Split
**Estimator** = orders parts (places the order after teardown reveals damage)
**Parts Manager** = tracks ETA, confirms receipt, processes returns — does NOT order

Changes:
- `src/constants/roles.js`: `parts_manager` role now sees statuses `['checked_in', 'teardown', 'waiting_parts', 'body_work', 'body_complete', 'reassembly']`
- `src/engine/taskRules.js`:
  - `PHASE_NEXT_STATUS.teardown`: branches on `partsStatus` — if `all_received` → `body_work`; otherwise → `waiting_parts`
  - `PHASE_NEXT_STATUS.waiting_parts` → `body_work`
  - `STATUS_PHASE_TRIGGER.waiting_parts`: `'waiting_parts'`
  - ~~`DOWNSTREAM_TASK_RULES.waiting_parts`~~ removed 2026-05-14 (see session above)
- `src/hooks/useAI.js` GIB prompt: parts ordering rule added
- `src/pages/Settings.jsx` `PRESET_GLOSSARY`: added 4 new EST/parts terms

### 4. AI "..." Response Fix
Model was copying the format example `{"reply":"..."}` literally.
- Format example changed to: `{"reply":"<your full response text here — never empty, never '...'>","actions":[],...}`
- Added `IMPORTANT: "reply" MUST always contain your complete response.`
- `FloatingAssistant.jsx` guard: `const replyText = result.reply && result.reply !== '...' ? result.reply : '⚠️ No response text returned.'`

### 5. Notes Display Overhaul — New `DailyNotesLog` Component

**New file:** `src/components/DailyNotesLog.jsx`
Exports:
- `parseNoteLines(raw)` — parses `ro.notes` string into `[{ date, text, author }]` array
- Default export `DailyNotesLog` — used in both `RODetail` and `RODrawer`

Display logic:
- Groups notes by `MM/dd` date
- **Today**: raw notes shown directly
- **Past days**: if summary exists → collapsed bullets (highlighted with `HighlightedNote`) + "↓ Show N original notes" toggle; if no summary → raw notes shown
- **All days open by default** (`useState(true)`)

`summarizeDayNotes` prompt updated:
- NO vehicle make/model/name
- Format: `[keyword] date if relevant — very short description`
- Keywords: `paint | body | teardown | parts | reassembly | sublet | delivery | customer | supplement | status | task`
- Examples: `"paint 05/06 — entered booth"` | `"parts — ordered via PT, ETA 05/10"`

`RODrawer.jsx` cleaned up — removed all inline note helpers, now uses `<DailyNotesLog />`.

### 6. Regenerate All Summaries (Settings)
Manager-only button "🔄 Regenerate Note Summaries" in `src/pages/Settings.jsx`.
- Fetches all ROs, re-runs `summarizeDayNotes` for each past day group
- Progress bar: `{ done, total, current, errors }`
- Uses imported `parseNoteLines` from `DailyNotesLog.jsx` and `summarizeDayNotes` from `useAI.js`

---

## ⚠️ Worktree / Build Checklist
1. **`.env` exists** in the worktree root — copy from main project root if missing.
2. **Run `npm run build`** and confirm the JS filename hash changed.
3. **Deploy**: `npx firebase deploy --only hosting` (add `firestore:rules` if rules changed).
4. **PWA cache**: After deploy, users may need to close + reopen. Force-refresh console snippet:
   ```js
   const regs = await navigator.serviceWorker.getRegistrations()
   for (const r of regs) await r.unregister()
   const keys = await caches.keys()
   for (const k of keys) await caches.delete(k)
   location.reload(true)
   ```

---

## Notes Format Convention
All notes written as a single string, newest first:
```
[MM/DD HH:mm - AuthorName] note text
[MM/DD HH:mm - AuthorName] older note
```
Never use Firestore `arrayUnion` for `ro.notes` — always a plain string.

---

## Key Files
| File | Purpose |
|---|---|
| `src/hooks/useAI.js` | Claude API integration, system prompt, action parsing |
| `src/components/FloatingAssistant.jsx` | Desktop GIB chat widget |
| `src/components/AIInputBox.jsx` | Action card rendering + Firestore write logic |
| `src/components/DailyNotesLog.jsx` | Shared notes display (RODetail + RODrawer) |
| `src/components/HighlightedNote.jsx` | Keyword highlighting in note text |
| `src/pages/ROBoard.jsx` | Main kanban board |
| `src/pages/TaskBoard.jsx` | Employee task view |
| `src/pages/RODetail.jsx` | Full RO detail + notes + parts |
| `src/pages/MobilePainterTaskView.jsx` | Painter/paint_helper mobile My Work view |
| `src/pages/PartsManagerView.jsx` | Parts manager dedicated view (orders + returns + subtasks) |
| `src/pages/AddEditRO.jsx` | RO create/edit form; syncs pending-task assignees on save |
| `src/constants/roles.js` | All role/status enums — source of truth |
| `src/engine/taskRules.js` | Auto task generation on status transitions |
| `firestore.rules` | Security rules |
| `chrome-extension/popup.js` + `background.js` | CCC → Firestore sync |
