const PHASE_CATEGORY = {
  teardown: 'body',
  body: 'body',
  paint_prep: 'paint',
  paint: 'paint',
  reassembly: 'body',
  sublet: 'sublet',
  detail: 'detail',
}

const PHASE_TITLE_PATTERN = {
  teardown: /teardown/i,
  body: /body work|repair/i,
  paint_prep: /paint.?prep|prep/i,
  paint: /paint/i,
  reassembly: /reassembl/i,
  sublet: /sublet/i,
  detail: /detail|qc/i,
}

export function taskMatchesOpenTemplate(task = {}, template = {}) {
  if (!template.phase || task.phase !== template.phase) return false
  const isPaintPrimary = template.category === 'paint' && template.taskKind === 'primary'
  if (isPaintPrimary) {
    return task.taskKind !== 'secondary'
      && (template.statusBackfill || task.status !== 'completed')
  }
  return task.status !== 'completed' && task.title === template.title
}

export function selectPendingPhaseTaskItems(items = [], phase, getTaskData = item => item.data) {
  const phaseMatches = items.filter(item => {
    const task = getTaskData(item)
    return task.phase === phase && task.status !== 'completed'
  })
  if (phaseMatches.length > 0) return phaseMatches

  const category = PHASE_CATEGORY[phase]
  const titlePattern = PHASE_TITLE_PATTERN[phase]
  if (!category) return []
  return items.filter(item => {
    const task = getTaskData(item)
    return task.status !== 'completed'
      && task.category === category
      && (!titlePattern || titlePattern.test(task.title ?? ''))
  })
}
