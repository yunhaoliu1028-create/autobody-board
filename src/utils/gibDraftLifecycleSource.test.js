import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (await readFile(new URL('../components/AIInputBox.jsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const roBoardSource = (await readFile(new URL('../pages/ROBoard.jsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`)
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`)
  return source.slice(start, end)
}

test('GIB debounce freezes revisions when scheduled and Cancel invalidates it', () => {
  const reparse = between('// ── Auto re-parse', '// ── Voice input')
  const revisionCapture = reparse.indexOf('const requestRevision = ++parseRequestRevision.current')
  const timerStart = reparse.indexOf('reparseTimer.current = setTimeout')
  assert.notEqual(revisionCapture, -1)
  assert.notEqual(timerStart, -1)
  assert.ok(revisionCapture < timerStart)
  assert.match(reparse, /if \(!autoReparseOwner \|\| !autoReparseRequested\) return/)

  const clearDraft = between('const clearDraft = () => {', 'const mentionCandidates =')
  assert.match(clearDraft, /clearTimeout\(reparseTimer\.current\)/)
  assert.match(clearDraft, /parseRequestRevision\.current \+= 1/)
})

test('GIB publishes a shared planning lock before the first Apply await', () => {
  const apply = between('const handleApply = async () => {', 'const planIsStale =')
  const planningLock = apply.indexOf('setSharedAttempt(initialLock, { required: true })')
  const firstAwait = apply.indexOf('await buildGibOperationIdentity')
  assert.notEqual(planningLock, -1)
  assert.notEqual(firstAwait, -1)
  assert.ok(planningLock < firstAwait)
  assert.match(apply, /const applyActions = JSON\.parse\(JSON\.stringify\(actions\)\)/)
})

test('GIB locks every alternate draft mutation path while Apply is unconfirmed', () => {
  const history = between('const useHistoryItem = (value) => {', '// ── Auto re-parse')
  const voice = between('const toggleVoice = async () => {', 'const readImageFile =')
  assert.match(history, /isGibDraftMutationLocked\(operationAttempt\)/)
  assert.match(voice, /isGibDraftMutationLocked\(operationAttemptRef\.current\)/)
  assert.doesNotMatch(source, /if \(result\?\.actions\)/)
})

test('RO Board transfers sticky text edits to the stable full-box reparse owner', () => {
  assert.match(source, /autoReparseRequested/)
  assert.match(source, /if \(!autoReparseOwner \|\| !autoReparseRequested\) return/)
  assert.match(roBoardSource, /autoReparseOwner=\{false\}/)
})

test('GIB persistence waits for the current owner-scoped storage key to hydrate', () => {
  const hydration = between('useEffect(() => {\n    setHydratedStorageKey(null)', 'useEffect(() => {\n    if (')
  const persistenceStart = source.indexOf('useEffect(() => {\n    if (', source.indexOf('setHydratedStorageKey(draftStorageKey)'))
  const persistenceEnd = source.indexOf('  const rememberHistory =', persistenceStart)
  assert.notEqual(persistenceStart, -1)
  assert.notEqual(persistenceEnd, -1)
  const persistence = source.slice(persistenceStart, persistenceEnd)
  assert.match(hydration, /operationAttemptRef\.current = null/)
  assert.match(hydration, /setRecentApplied\(null\)/)
  assert.match(hydration, /setImages\(previous =>/)
  assert.match(hydration, /setHydratedStorageKey\(draftStorageKey\)/)
  assert.match(persistence, /hydratedStorageKey !== draftStorageKey/)
  assert.match(source, /if \(!draftHydratedForOwner\) return/)
  assert.match(source, /if \(!draftHydratedForOwner\) \{\s+return \(/)
  assert.doesNotMatch(source, /\bhydratedDraftKey\b|\bdraftHydrated\b/)
})

test('GIB Undo stays bound to the owner and draft scope that applied it', () => {
  const apply = between('const handleApply = async () => {', 'const planIsStale =')
  const undo = between('const handleUndoRecent = async () => {', 'if (!draftHydratedForOwner) {')
  assert.match(apply, /const undoSurfaceId = await gibUndoSurfaceId\(operationSurface\)/)
  assert.match(apply, /ownerUid: user\.uid,\s+surface: operationSurface,\s+surfaceId: undoSurfaceId/)
  assert.match(apply, /const loadAlreadyAppliedUndo = async operationData =>/)
  assert.match(apply, /getDocFromServer\(undoHeadRef\)/)
  assert.match(apply, /recentUndoRequestRevision\.current !== requestRevision/)
  assert.match(undo, /!draftHydratedForOwner\s*\|\|\s*!recentAppliedForOwner/)
  assert.match(undo, /const undoSnapshot = recentAppliedForOwner/)
  assert.match(undo, /const undoLifecycle = \{ \.\.\.draftLifecycleRef\.current \}/)
  assert.ok(undo.indexOf("undoInvocationRef.current = undoInvocationToken") < undo.indexOf('await gibUndoSurfaceId'))
  assert.match(undo, /if \(!undoUiIsCurrent\(\)\) \{\s+if \(undoInvocationRef\.current === undoInvocationToken\)/)
  assert.match(undo, /undoHeadMatchesOperation\([\s\S]*undoSnapshot\.ownerUid, undoSurfaceId/)
  assert.match(undo, /if \(undoUiIsCurrent\(\)\) \{/)
  assert.doesNotMatch(undo, /recentApplied\.roRestores|recentApplied\.taskRefs/)
})

test('late Apply callbacks cannot mutate a newly hydrated owner or scope', () => {
  const apply = between('const handleApply = async () => {', 'const planIsStale =')
  assert.match(source, /useLayoutEffect\(\(\) => \{[\s\S]*generation: previous\.generation \+ 1/)
  assert.match(apply, /const applyLifecycle = \{ \.\.\.draftLifecycleRef\.current \}/)
  assert.match(apply, /isGibDraftLifecycleCurrent\(draftLifecycleRef\.current, applyLifecycle\)/)
  assert.match(apply, /const completeApplyUi = \([^]*?\) => \{\s+if \(!applyUiIsCurrent\(\)\) return/)
  assert.match(apply, /const setSharedAttempt = \(attempt, options\) => \{\s+if \(applyUiIsCurrent\(\)\)/)
  assert.match(apply, /if \(applyInvocationRef\.current\) \{/)
  assert.match(apply, /applyInvocationRef\.current === applyInvocationToken/)
  assert.match(apply, /setApplyApplying\(false\)/)
})

test('late voice, image, and Submit callbacks are scoped to their draft lifecycle', () => {
  const voice = between('const toggleVoice = async () => {', 'const readImageFile =')
  const directUpload = between('const handleDirectImageUpload = async () => {', '// ── Submit: images')
  const submit = between('const handleSubmit = async (e) => {', '// ── Apply actions')
  assert.match(voice, /isGibDraftLifecycleCurrent\(draftLifecycleRef\.current, voiceLifecycle\)/)
  assert.match(voice, /if \(!voiceUiIsCurrent\(\) \|\| !blob/)
  assert.match(source, /isGibDraftLifecycleCurrent\(draftLifecycleRef\.current, imageLifecycle\)/)
  assert.match(directUpload, /isGibDraftLifecycleCurrent\(draftLifecycleRef\.current, uploadLifecycle\)/)
  assert.match(submit, /isGibDraftLifecycleCurrent\(draftLifecycleRef\.current, submitLifecycle\)/)
})

test('CameraModal stops a getUserMedia stream that resolves after unmount', () => {
  const camera = between('function CameraModal({ onDone, onClose }) {', 'function IconMic')
  assert.match(camera, /let disposed = false/)
  assert.match(camera, /disposed = true/)
  assert.match(camera, /cameraDisposedRef\.current = true/)
  assert.match(camera, /if \(disposed\) \{\s+stopStream\(stream\)/)
  assert.match(camera, /if \(!disposed\) setErr/)
})

test('PhotoSheet delayed actions cannot open camera or library for another draft lifecycle', () => {
  const photoAction = between('const schedulePhotoAction = action => {', 'if (!draftHydratedForOwner) {')
  assert.match(photoAction, /const photoLifecycle = \{ \.\.\.draftLifecycleRef\.current \}/)
  assert.match(photoAction, /isGibDraftLifecycleCurrent\(draftLifecycleRef\.current, photoLifecycle\)/)
  assert.match(source, /clearTimeout\(photoActionTimerRef\.current\)/)
  assert.doesNotMatch(source, /setTimeout\(\(\) => setShowCamera\(true\), 50\)/)
})
