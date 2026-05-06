# Claude Code Handoff

Use this file before continuing work. The source of truth is GitHub `main`.

## Current State

- Project: `autobody-board`
- Local path: `C:\Users\Owner\Desktop\CAR PHOTO\YUNHAO LIU\autobody-board`
- GitHub: `yunhaoliu1028-create/autobody-board`
- Branch: `main`
- Latest functional app commit before this handoff: `c429855 Drag task groups as manager`
- This handoff file may exist in a newer commit. Always pull the latest `main`.
- Deployed site: `https://bodyshop-board.web.app`
- Current working tree was clean when this handoff was generated.

## Important Workflow Rule

Codex and Claude Code are both working on this project. To avoid split-brain work:

1. Start by syncing from GitHub `main`.
2. Read `CODEX_HANDOFF.md` and this file.
3. Make changes in the main project folder, not a hidden worktree unless explicitly needed.
4. Run `npm.cmd run build` before saying work is done.
5. If deploying UI changes, deploy Firebase Hosting.
6. Commit and push finished work to `main`.

Do not leave important changes only inside `.claude/worktrees/...`.

## Recent TaskBoard Work

Primary file: `src/pages/TaskBoard.jsx`

The Tasks page now has two modules:

1. `My ROs`
   - Shows ROs assigned to the selected employee by `assignedBodyMan`, `assignedPainter`, `assignedEstimator`, or `assignedPartsManager`.
   - Uses ETA priority chain: `ro.eta || ro.cccDateOut || ro.promisedDate`.
   - Shows priority, parts status, current status, rental, due date, and paint due.
   - `Paint due` is due date minus one day.

2. `Daily Tasks`
   - Shows tasks assigned to the selected employee.
   - Groups tasks by RO.
   - Dedupes obvious duplicated teardown/body assignments into one visible `Teardown`.
   - Hides auto-generated task descriptions by default.
   - Shows manual `taskNotes` if present.

Manager features:

- Managers see a `Manager View` employee selector at the top.
- Selecting an employee switches both `My ROs` and `Daily Tasks` to that employee.
- Managers can drag the whole RO task group card up/down.
- Dragging writes `sortOrder` back to all active tasks in the reordered groups.
- Completed groups are not draggable.

## Firestore Notes and Rules

- `ro.notes` must stay a plain string, newest first.
- Never write `arrayUnion` directly to `ro.notes`.
- Task-specific notes use `task.taskNotes[]`.
- Firestore rules currently allow managers to update tasks and assignees to update status/task notes.

## Build and Deploy

Build:

```powershell
npm.cmd run build
```

Deploy Hosting:

```powershell
npx.cmd -y firebase-tools@latest deploy --only hosting
```

Deploy Hosting plus Firestore rules if rules changed:

```powershell
npx.cmd -y firebase-tools@latest deploy --only hosting,firestore:rules
```

Verify deployed site:

```powershell
Invoke-WebRequest -UseBasicParsing https://bodyshop-board.web.app/ | Select-Object -ExpandProperty StatusCode
```

## Environment Warning

If working from a new worktree, `.env` may be missing because it is gitignored. Copy `.env` from the main project root before building. A missing `.env` can produce a white screen due to invalid Firebase config.

## Prompt To Paste Into Claude Code

```text
You are continuing work on my autobody-board project.

Before making changes:
1. Work from this folder: C:\Users\Owner\Desktop\CAR PHOTO\YUNHAO LIU\autobody-board
2. Pull/sync latest GitHub main first. It should include CLAUDE_NEXT_PROMPT.md.
3. Read CODEX_HANDOFF.md and CLAUDE_NEXT_PROMPT.md.
4. Do not work only inside .claude/worktrees unless you will merge/commit/push the result back to main.

Current app:
- React + Vite + Firebase.
- Deployed at https://bodyshop-board.web.app.
- Tasks page is in src/pages/TaskBoard.jsx.
- TaskBoard has My ROs + Daily Tasks modules.
- Managers can choose an employee, view that employee's task board, and drag whole RO task-group cards to reorder priority.
- Dragging updates sortOrder on active tasks.
- ro.notes must remain a string; never arrayUnion into ro.notes.
- taskNotes belongs on task documents.

When you finish:
1. Run npm.cmd run build.
2. If UI changed, deploy with npx.cmd -y firebase-tools@latest deploy --only hosting.
3. Commit and push to GitHub main so Codex can continue from the same state.
4. Briefly summarize changed files and verification.

Please continue from this exact state and avoid rebuilding existing behavior unless necessary.
```
