# Codex Handoff — Session Notes

Quick context for picking up where we left off. Read this before making changes.

---

## Stack
React + Vite + Firebase (Firestore + Hosting) + vite-plugin-pwa  
Deployed at: https://bodyshop-board.web.app  
PWA — employees use it as an installed app on iPhone/Android.

---

## Recent Major Changes (this session)

### 1. RO Date Fields — four distinct fields
| Field | Editable? | Source |
|---|---|---|
| `cccDateIn` | Locked (CCC sync) | Chrome extension |
| `cccDateOut` | Locked (CCC sync) | Chrome extension |
| `dropOffDate` | Editable | GIB/manual |
| `eta` | Editable | Initialized from `cccDateOut` on import, then shop-owned |

- `promisedDate` is legacy — replaced by `eta` everywhere.
- ETA priority chain used across the whole app: `ro.eta || ro.cccDateOut || ro.promisedDate`
- Files changed: `chrome-extension/popup.js`, `src/pages/AddEditRO.jsx`, `src/pages/ROBoard.jsx`, `src/pages/RODetail.jsx`, `src/components/AIInputBox.jsx`, `src/components/FloatingAssistant.jsx`, `src/hooks/useAI.js`

### 2. Status cleanup — removed duplicate `qc`
- Removed `qc` from `RO_STATUSES` in `src/constants/roles.js`
- `detail` label remains "QC / Detail" — it covers both
- REASSEMBLY group: `['reassembly', 'calibration', 'detail']`

### 3. GIB (AI assistant) — drop-off date handling
- When GIB detects keywords (放车/dropoff/dropped off/送来/已到/进店), it generates **both** `update_dropoff_date` AND `add_note` actions together.
- Duplicate detection: if `roDoc.dropOffDate === action.dropOffDate`, skips field write, shows amber "Duplicate" badge in action card.
- Files: `src/components/AIInputBox.jsx`, `src/hooks/useAI.js`

### 4. New `assign_painter` GIB action
- Mirrors `assign_body_man` — finds employee by name, sets `assignedPainter`, auto-creates task: `"Paint preparation & paint job"` with `category: 'paint'`.
- Files: `src/components/AIInputBox.jsx`, `src/components/FloatingAssistant.jsx`, `src/hooks/useAI.js`

### 5. TaskBoard redesign — two modules
`src/pages/TaskBoard.jsx` was completely rewritten:
- **Module 1 — My ROs**: Shows ROs where `user.uid` matches any of `assignedBodyMan / assignedPainter / assignedEstimator / assignedPartsManager`. Sorted by ETA priority (high→medium→low). Desktop: horizontal card scroll. Mobile: vertical list.
- **Module 2 — Daily Tasks**: Tasks filtered to `assignedTo === user.uid`. Manager drag-to-reorder via `sortOrder` field + `writeBatch`. Each active task has inline note button → saves to `task.taskNotes[]` (arrayUnion) AND prepends to `ro.notes` string.

### 6. Critical bug fix — `notes.split is not a function`
- **Root cause**: `applyPendingToBody` in `ROBoard.jsx` was writing `notes: arrayUnion({ text, by, at })` which turned the Firestore `notes` string field into an object array. Subsequent `.split('\n')` calls crashed everywhere.
- **Fixes applied**:
  - `ROBoard.jsx` `applyPendingToBody`: changed to string prepend (`[MM/DD HH:mm - Author] text\nprevNotes`)
  - `useAI.js`: added `typeof r.notes === 'string'` guard before `.split()`
  - `RODetail.jsx`: added `typeof ro.notes === 'string'` guard before rendering

### 7. Firestore rules — two fixes
`firestore.rules`:
- **Settings read access**: changed `settings/{docId}` from manager-only read to `allow read: if isAuth()` — all employees need to read `settings/ai` to get the Anthropic API key for the AI assistant.
- **Task notes**: added `taskNotes` to the allowed field list for task assignee updates (was only `status`, `completedAt`, `updatedAt`).

### 8. White screen bug — missing `.env` in worktree
- **Root cause**: `.env` is gitignored and not copied into new worktrees. Building without it embeds `undefined` for all `VITE_FIREBASE_*` vars, causing `auth/invalid-api-key` and a full white screen.
- **Fix**: Manually copy `.env` from the main project root to the worktree root before running `npm run build`.
- **Verify**: After build, the JS bundle hash should change vs the previous build. If the hash is identical, env vars weren't picked up.

---

## ⚠️ Worktree / Build Checklist
Before building or deploying from a worktree, confirm:
1. **`.env` exists** in the worktree root — copy from main project root if missing.
2. **Run `npm run build`** and confirm the JS filename hash changed from the previous build.
3. **Deploy**: `npx firebase deploy --only hosting` (add `firestore:rules` if rules changed).
4. **PWA cache**: After deploy, existing users may need to close + reopen the app (or hard-refresh) to get the new service worker. On desktop Chrome you can run this in the console to force it:
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
Never use Firestore `arrayUnion` for the `ro.notes` field — it's always a plain string.

## Key Files
| File | Purpose |
|---|---|
| `src/hooks/useAI.js` | Claude API integration, system prompt, action parsing |
| `src/components/FloatingAssistant.jsx` | Desktop GIB chat widget |
| `src/components/AIInputBox.jsx` | Action card rendering + Firestore write logic |
| `src/pages/ROBoard.jsx` | Main kanban board, drag-to-status, PendingToBody modal |
| `src/pages/TaskBoard.jsx` | Employee task view (rewritten this session) |
| `src/constants/roles.js` | All role/status enums — source of truth |
| `firestore.rules` | Security rules |
| `chrome-extension/popup.js` | CCC → Firestore sync |
