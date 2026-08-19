import test from 'node:test'
import assert from 'node:assert/strict'
import {
  selectPendingPhaseTaskItems,
  taskMatchesOpenTemplate,
} from './gibTaskPlanning.js'

test('open-template matching ignores completed and secondary paint tasks', () => {
  const template = { title: 'Paint', phase: 'paint', category: 'paint', taskKind: 'primary' }
  assert.equal(taskMatchesOpenTemplate({ title: 'Paint', phase: 'paint', status: 'pending', taskKind: 'primary' }, template), true)
  assert.equal(taskMatchesOpenTemplate({ title: 'Paint', phase: 'paint', status: 'completed', taskKind: 'primary' }, template), false)
  assert.equal(taskMatchesOpenTemplate({ title: 'Paint reminder', phase: 'paint', status: 'pending', taskKind: 'secondary' }, template), false)
})

test('phase completion selects all pending tasks with the exact phase', () => {
  const items = [
    { id: 'primary', data: { phase: 'body', category: 'body', title: 'Repair', status: 'pending' } },
    { id: 'secondary', data: { phase: 'body', category: 'body', title: 'Fitment Check', status: 'in_progress' } },
    { id: 'done', data: { phase: 'body', category: 'body', title: 'Repair', status: 'completed' } },
    { id: 'other', data: { phase: 'paint', category: 'paint', title: 'Paint', status: 'pending' } },
  ]
  assert.deepEqual(selectPendingPhaseTaskItems(items, 'body').map(item => item.id), ['primary', 'secondary'])
})

test('phase completion uses legacy category and title fallback only when no exact phase is pending', () => {
  const items = [
    { id: 'legacy-repair', data: { category: 'body', title: 'Body Work', status: 'pending' } },
    { id: 'legacy-unrelated', data: { category: 'body', title: 'Tire Pressure Check', status: 'pending' } },
    { id: 'completed-phase', data: { phase: 'body', category: 'body', title: 'Repair', status: 'completed' } },
  ]
  assert.deepEqual(selectPendingPhaseTaskItems(items, 'body').map(item => item.id), ['legacy-repair'])
})

test('phase selection honors effective planned task state', () => {
  const items = [
    { id: 'planned-done', data: { phase: 'paint_prep', category: 'paint', title: 'Paint Prep', status: 'pending' } },
    { id: 'still-open', data: { phase: 'paint_prep', category: 'paint', title: 'Prep reminder', status: 'pending' } },
  ]
  const effective = item => item.id === 'planned-done' ? { ...item.data, status: 'completed' } : item.data
  assert.deepEqual(selectPendingPhaseTaskItems(items, 'paint_prep', effective).map(item => item.id), ['still-open'])
})

test('final phase completion is independent of task-versus-completion action order', () => {
  const selectedIds = steps => {
    const items = []
    let completionRequested = false
    steps.forEach(step => {
      if (step === 'task') items.push({ id: 'repair', data: { phase: 'body', category: 'body', title: 'Repair', status: 'pending' } })
      if (step === 'complete') completionRequested = true
    })
    return completionRequested
      ? selectPendingPhaseTaskItems(items, 'body').map(item => item.id)
      : []
  }
  assert.deepEqual(selectedIds(['task', 'complete']), ['repair'])
  assert.deepEqual(selectedIds(['complete', 'task']), ['repair'])
})
