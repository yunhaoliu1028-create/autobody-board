# Codex Handoff — Session Notes

Quick context for picking up where we left off. Read this before making changes.

---

## Stack
React + Vite + Firebase (Firestore + Hosting) + vite-plugin-pwa  
Deployed at: https://bodyshop-board.web.app  
PWA — employees use it as an installed app on iPhone/Android.

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
  - `DOWNSTREAM_TASK_RULES.waiting_parts`: auto-creates "Order parts" task assigned to `assignedEstimator` or role `estimator`
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

## ⚡ NEXT TASK: Parts Manager Dedicated View

**This has been fully designed but NOT implemented yet.** Codex should implement it.

### Goal
Replace the generic TaskBoard with a dedicated parts-tracking interface when `role === 'parts_manager'`.

### Data Model (new Firestore fields on RO docs)

```js
// partsOrders[] — array of order objects
{
  id: nanoid(),           // unique per order record
  vendor: "PT",           // string (e.g. "PT", "LKQ", "OEM")
  description: "Bumper cover, grille", // free text
  quantity: 3,
  status: "ordered",      // "ordered" | "partially_received" | "received" | "returned"
  eta: "2026-05-10",      // ISO date string, optional
  receivedQty: 0,
  orderedAt: serverTimestamp(),
  orderedBy: uid,         // estimator UID
  receivedAt: null,
  notes: "",
}

// partsReturns[] — array of return records
{
  id: nanoid(),
  vendor: "PT",
  description: "Wrong bumper cover",
  quantity: 1,
  returnedAt: serverTimestamp(),
  returnedBy: uid,        // parts_manager UID
  notes: "",
}
```

**`partsStatus`** (existing field on RO) should be **auto-calculated** from `partsOrders[]`:
- No orders → `"not_ordered"`
- All orders `received` → `"all_received"`
- Any order `partially_received` → `"partially_received"`
- Otherwise → `"ordered"`

**Keep existing `partsStatus` manual edit** as fallback for ROs without `partsOrders[]` data.  
**Deprecate `partsNotes`** field from the UI (keep data in Firestore for backward compat, just don't show input).

### New File: `src/pages/PartsManagerView.jsx`

This view replaces `TaskBoard` when `role === 'parts_manager'`. Wire it up in `src/App.jsx` or the router.

**Filter tabs** (top of page):
- All
- Needs Attention (overdue ETA or partially received)
- Pending Delivery (parts received but not yet delivered to tech)
- Returns (has pending returns)

**Sort:** ETA soonest first; overdue highlighted red.

**RO Card layout** (one card per RO that has parts orders or is in a parts-relevant status):

```
┌─────────────────────────────────────────────┐
│ #RO1234  2019 Honda Accord  VIN: 1HGCV…     │
│ Status badge  |  ETA: 05/10  |  Parts: ●●○  │
├─────────────────────────────────────────────┤
│ Vendor: PT   [██████░░] 2/3 received        │
│ Vendor: LKQ  [██░░░░░░] 1/4 received        │
├─────────────────────────────────────────────┤
│ ☐ Verify all parts received                 │
│ ☐ Deliver parts to body tech                │
│ ☐ Process return: PT 1 pc                   │
└─────────────────────────────────────────────┘
```

**Auto-generated subtasks** (shown inline on card, NOT stored in Firestore `tasks` collection):

| Trigger | Subtask |
|---|---|
| Any `partsOrder` added to RO | "Verify all parts received" |
| RO enters `body_work` or `paint_prep` | "Deliver parts to body/painter" |
| RO enters `reassembly` | "Deliver all parts for reassembly" |
| `partsReturn` logged | "Process return: [vendor] N pcs" |

These are derived UI state — compute them from `partsOrders`/`partsReturns` + `ro.status` at render time.

### New GIB Action Types

Add to `src/hooks/useAI.js` and `src/components/AIInputBox.jsx`:

**`update_parts_order`**
```json
{
  "action": "update_parts_order",
  "roId": "...",
  "roNumber": "1234",
  "vendor": "PT",
  "description": "Bumper cover, grille",
  "quantity": 3,
  "eta": "2026-05-10",
  "status": "ordered"
}
```

**`log_parts_received`**
```json
{
  "action": "log_parts_received",
  "roId": "...",
  "roNumber": "1234",
  "vendor": "PT",
  "receivedQty": 2,
  "totalQty": 3,
  "note": "Missing 1 pc, backorder"
}
```

**`log_parts_return`**
```json
{
  "action": "log_parts_return",
  "roId": "...",
  "roNumber": "1234",
  "vendor": "LKQ",
  "description": "Wrong part sent",
  "quantity": 1
}
```

Firestore writes for these actions:
- `update_parts_order`: `arrayUnion` new order object into `partsOrders`, recalculate `partsStatus`
- `log_parts_received`: find matching order in `partsOrders` by vendor, update `receivedQty`/`status`, recalculate `partsStatus`
- `log_parts_return`: `arrayUnion` return object into `partsReturns`, add note to `ro.notes`

**Open design decision already resolved:** Same vendor, multiple orders → **new record per order** (each gets unique `id`). Display merges by vendor for the progress bar.

---

## Previous Session Changes (keep for history)

### RO Date Fields — four distinct fields
| Field | Editable? | Source |
|---|---|---|
| `cccDateIn` | Locked (CCC sync) | Chrome extension |
| `cccDateOut` | Locked (CCC sync) | Chrome extension |
| `dropOffDate` | Editable | GIB/manual |
| `eta` | Editable | Initialized from `cccDateOut` on import, then shop-owned |

- ETA priority chain: `ro.eta || ro.cccDateOut || ro.promisedDate`

### Status cleanup — removed duplicate `qc`
- Removed `qc` from `RO_STATUSES` in `src/constants/roles.js`
- `detail` label remains "QC / Detail"

### GIB drop-off date handling
- Detects drop-off keywords → generates `update_dropoff_date` + `add_note` together
- Duplicate detection: if `roDoc.dropOffDate === action.dropOffDate`, shows amber "Duplicate" badge

### `assign_painter` GIB action
- Mirrors `assign_body_man` — sets `assignedPainter`, auto-creates `"Paint preparation & paint job"` task

### TaskBoard redesign
- **My ROs**: ROs where user is assigned (body/painter/estimator/parts_manager), sorted by ETA
- **Daily Tasks**: tasks assigned to user, manager drag-to-reorder via `sortOrder`

### Critical bug fix — `notes.split is not a function`
- `ROBoard.jsx` `applyPendingToBody` was writing `notes: arrayUnion({...})` — turned string into array. Fixed to string prepend.

### Firestore rules fixes
- `settings/{docId}`: changed to `allow read: if isAuth()` (all employees need API key)
- `taskNotes` added to task assignee allowed fields

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
| `src/constants/roles.js` | All role/status enums — source of truth |
| `src/engine/taskRules.js` | Auto task generation on status transitions |
| `firestore.rules` | Security rules |
| `chrome-extension/popup.js` | CCC → Firestore sync |
