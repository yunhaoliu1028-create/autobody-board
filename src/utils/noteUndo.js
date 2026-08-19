import { arrayRemove, deleteField, serverTimestamp } from 'firebase/firestore'
import { parseISO } from 'date-fns'
import { parseNoteLines } from '../components/DailyNotesLog'

const CHANGE_FIELD = {
  update_status: 'status',
  update_parts_status: 'partsStatus',
  update_car_status: 'carStatus',
  update_due_date: 'eta',
  update_dropoff_date: 'dropOffDate',
  update_rental: 'hasRental',
  assign_body_man: 'assignedBodyMan',
  assign_painter: 'assignedPainter',
  assign_parts_manager: 'assignedPartsManager',
}

function normalize(value = '') {
  return String(value).trim().toLowerCase()
}

function parseNoteMeta(line = '') {
  const match = String(line).match(/^\[(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s+-\s+([^\]]+)\]/)
  if (!match) return null
  const [, month, day, hour, minute, author] = match
  const now = new Date()
  const year = Number(month) > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear()
  return {
    author: author.trim(),
    at: new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute)),
  }
}

function changeDate(entry) {
  if (!entry?.at) return null
  try {
    return parseISO(entry.at)
  } catch {
    return null
  }
}

function linkedChangeLogs(ro, line) {
  const meta = parseNoteMeta(line)
  if (!meta) return []

  return (ro.changeLog || [])
    .filter(entry => CHANGE_FIELD[entry.type])
    .filter(entry => !entry.source || entry.source === 'gib' || entry.source === 'auto')
    .filter(entry => normalize(entry.by) === normalize(meta.author))
    .map(entry => ({ entry, at: changeDate(entry) }))
    .filter(item => item.at && Math.abs(item.at.getTime() - meta.at.getTime()) <= 2 * 60 * 1000)
    .sort((a, b) => b.at - a.at)
    .map(item => item.entry)
}

function previousChangeValue(ro, target) {
  const targetAt = changeDate(target)
  if (!targetAt) return undefined

  const previous = (ro.changeLog || [])
    .filter(entry => entry !== target && entry.type === target.type)
    .map(entry => ({ entry, at: changeDate(entry) }))
    .filter(item => item.at && item.at < targetAt)
    .sort((a, b) => b.at - a.at)[0]?.entry

  return previous?.value
}

export function buildUndoNoteUpdate(ro, line) {
  const nextNotes = parseNoteLines(ro.notes || '')
    .filter(item => item !== line)
    .join('\n')

  const updates = {
    notes: nextNotes,
    noteSummaries: [],
    updatedAt: serverTimestamp(),
  }

  const linked = linkedChangeLogs(ro, line)
  if (!linked.length) return { updates, linked: [], revertedFields: [] }

  const revertedFields = []
  linked.forEach(entry => {
    const field = CHANGE_FIELD[entry.type]
    if (!field || Object.prototype.hasOwnProperty.call(updates, field)) return
    const previousValue = previousChangeValue(ro, entry)
    updates[field] = previousValue !== undefined
      ? entry.type === 'update_rental' ? previousValue === 'true' : previousValue
      : deleteField()
    revertedFields.push(field)
  })

  if (linked.length) {
    updates.changeLog = arrayRemove(...linked)
  }

  return { updates, linked, revertedFields }
}

export function buildClearNotesUpdate() {
  return {
    notes: '',
    noteSummaries: [],
    updatedAt: serverTimestamp(),
  }
}
