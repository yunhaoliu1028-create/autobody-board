// ─── Claude API integration ───────────────────────────────────────────────────
// Calls Anthropic API directly from the client.
// API key is stored in Firestore settings (manager-only) and cached in memory.

import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '../firebase/config'

const CLAUDE_API   = 'https://api.anthropic.com/v1/messages'
const MODEL_FAST   = 'claude-haiku-4-5-20251001'   // lightweight fallback
const MODEL_SMART  = 'claude-sonnet-4-6'            // GIB parsing — fast
const MODEL_OPUS   = 'claude-opus-4-6'              // Assistant — smartest

let _cachedKey       = null
let _cachedOpenAIKey = null

export async function getApiKey() {
  if (_cachedKey) return _cachedKey
  const snap = await getDoc(doc(db, 'settings', 'ai'))
  _cachedKey = snap.data()?.anthropicKey ?? null
  return _cachedKey
}

export async function saveApiKey(key) {
  _cachedKey = key
  await setDoc(doc(db, 'settings', 'ai'), { anthropicKey: key }, { merge: true })
}

export function clearKeyCache() { _cachedKey = null }

export async function getOpenAIKey() {
  if (_cachedOpenAIKey) return _cachedOpenAIKey
  const snap = await getDoc(doc(db, 'settings', 'ai'))
  _cachedOpenAIKey = snap.data()?.openaiKey ?? null
  return _cachedOpenAIKey
}

export async function saveOpenAIKey(key) {
  _cachedOpenAIKey = key
  await setDoc(doc(db, 'settings', 'ai'), { openaiKey: key }, { merge: true })
}

export function clearOpenAIKeyCache() { _cachedOpenAIKey = null }

// ── Persistent Assistant Memory ──────────────────────────────────────────────
// Stores shop-specific facts in Firestore. Injected into every AI prompt so
// the assistant (and GIB) remembers abbreviations, vendors, workflows, etc.
let _cachedMemory = null  // array of fact strings

export async function loadAssistantMemory() {
  if (_cachedMemory) return _cachedMemory
  try {
    const snap = await getDoc(doc(db, 'settings', 'assistantMemory'))
    _cachedMemory = snap.data()?.facts ?? []
  } catch {
    _cachedMemory = []
  }
  return _cachedMemory
}

export async function appendAssistantMemory(fact) {
  const facts = await loadAssistantMemory()
  // Avoid exact duplicates
  if (facts.includes(fact)) return facts
  const updated = [...facts, fact]
  await setDoc(doc(db, 'settings', 'assistantMemory'), { facts: updated, updatedAt: new Date().toISOString() }, { merge: true })
  _cachedMemory = updated
  return updated
}

export async function deleteAssistantMemory(fact) {
  const facts = await loadAssistantMemory()
  const updated = facts.filter(f => f !== fact)
  await setDoc(doc(db, 'settings', 'assistantMemory'), { facts: updated, updatedAt: new Date().toISOString() }, { merge: true })
  _cachedMemory = updated
  return updated
}

export function clearMemoryCache() { _cachedMemory = null }

// ── Whisper transcription ─────────────────────────────────────────────────────
// audioBlob: Blob from MediaRecorder (audio/webm or audio/mp4)
// Returns the transcript string
export async function transcribeWithWhisper(audioBlob) {
  const key = await getOpenAIKey()
  if (!key) throw new Error('NO_OPENAI_KEY')

  const ext = audioBlob.type.includes('mp4') ? 'mp4'
             : audioBlob.type.includes('ogg') ? 'ogg'
             : 'webm'

  const formData = new FormData()
  formData.append('file', audioBlob, `recording.${ext}`)
  formData.append('model', 'whisper-1')
  // No `language` param → Whisper auto-detects Chinese / English / Spanish

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body:    formData,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message ?? `Whisper error ${res.status}`)
  }

  const data = await res.json()
  return data.text ?? ''
}

// ── Core call ─────────────────────────────────────────────────────────────────
// images: optional array of { base64, mimeType } — enables vision
async function callClaude(systemPrompt, userMessage, apiKey, images = [], model = MODEL_SMART) {
  const key = apiKey ?? await getApiKey()
  if (!key) throw new Error('NO_API_KEY')

  // Build message content — multimodal if images provided
  let content
  if (images && images.length > 0) {
    content = [
      ...images.map(img => ({
        type: 'image',
        source: {
          type:       'base64',
          media_type: img.mimeType || 'image/jpeg',
          data:       img.base64,
        },
      })),
      { type: 'text', text: userMessage },
    ]
  } else {
    content = userMessage
  }

  const res = await fetch(CLAUDE_API, {
    method:  'POST',
    headers: {
      'Content-Type':            'application/json',
      'x-api-key':               key,
      'anthropic-version':       '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system:     systemPrompt,
      messages:   [{ role: 'user', content }],
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    if (res.status === 401) throw new Error('INVALID_KEY')
    throw new Error(err.error?.message ?? `API error ${res.status}`)
  }

  const data = await res.json()
  const text = data.content?.[0]?.text ?? ''

  // Extract JSON from response (Claude sometimes wraps in markdown)
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  const jsonStr   = jsonMatch ? jsonMatch[1] || jsonMatch[0] : text
  try {
    return JSON.parse(jsonStr.trim())
  } catch {
    return { raw: text }
  }
}

// ── Shared glossary injected into both prompts ────────────────────────────────
const SHOP_GLOSSARY = `
COLLISION REPAIR GLOSSARY — always interpret these abbreviations correctly:
- w/o = without  (e.g. "w/o rental" = customer declined rental car)
- w/ = with  (e.g. "w/ rental" = customer has a rental car)
- pt / pts / parts trader = Parts Trader (parts vendor)
- LKQ = LKQ (recycled/salvage parts vendor)
- OEM = OEM factory-original parts
- AM = aftermarket parts
- ETA / eta = estimated arrival date (for parts) OR target completion/delivery date (context-dependent)
- due / promise / target = target vehicle completion/delivery date
- r&r = remove and replace
- r&i = remove and install
- o/h = overhaul
- subl / sublet = sent to external specialty vendor (e.g. frame shop, glass, upholstery)
- suppl / supplement = additional supplement claim submitted to insurance
- adj / adjuster = insurance adjuster
- DRP = Direct Repair Program (insurance-preferred shop)
- TL / total loss = vehicle declared total loss
- blend = blend paint on adjacent panel to match
- feather = feather edge for paint prep
- call / called / updated customer = phoned customer to give status update`

// ── Strategy 2: Smart model routing ──────────────────────────────────────────
// Complex analytical queries → Opus; simple lookups → Sonnet
// Saves ~40% by avoiding Opus on questions that don't need it
function pickModel(lastUserMessage) {
  const t = lastUserMessage.toLowerCase()
  const complexSignals = [
    // Reports & analysis
    '简报','briefing','分析','analysi','总结','summary','报告','report','overview','概括',
    // Planning & prioritization
    '建议','recommend','跟进','follow','优先','priority','关注','attention','重点',
    // Generation tasks
    '短信','sms','生成','generate','帮我','请帮','drafts','写','列出所有',
    // Time-sensitive analysis
    '明天','今天','today','tomorrow','超期','overdue','情况','situation','状态总览',
    // Multi-RO questions
    '哪些','which ones','所有','all','几辆','how many',
  ]
  const isComplex = complexSignals.some(k => t.includes(k)) || lastUserMessage.length > 80
  return isComplex ? MODEL_OPUS : MODEL_SMART
}

// ── Strategy 4: Rolling conversation window ───────────────────────────────────
// After 8+ messages, compress old ones to prevent ballooning context
// Keeps last 4 messages verbatim + a summary of earlier exchanges
async function compressHistory(messages, key) {
  if (messages.length <= 8) return messages

  const toCompress = messages.slice(0, -4)
  const recent     = messages.slice(-4)

  // Ask Haiku (cheapest) to summarize the old part
  const summaryRes = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL_FAST,   // Haiku — cheapest, good enough for summarization
      max_tokens: 300,
      messages: [
        ...toCompress,
        { role: 'user', content: 'Summarize this conversation so far in 3-5 bullet points, preserving key facts, decisions, and RO numbers mentioned. Be concise.' },
      ],
    }),
  })
  if (!summaryRes.ok) return messages  // fallback: keep full history

  const summaryData = await summaryRes.json()
  const summary     = summaryData.content?.[0]?.text ?? ''

  return [
    { role: 'user',      content: `[Earlier conversation summary: ${summary}]` },
    { role: 'assistant', content: 'Understood, I have context from our earlier discussion.' },
    ...recent,
  ]
}

// ── Shop Assistant (Opus + 4 cost-saving strategies) ─────────────────────────
export async function askShopAssistant({ messages, ros, employees }) {
  const key = await getApiKey()
  if (!key) throw new Error('NO_API_KEY')

  const today  = new Date().toISOString().split('T')[0]
  const memory = await loadAssistantMemory()

  // ── Strategy 2: Pick model based on query complexity ─────────────────────
  const lastMsg   = messages[messages.length - 1]?.content ?? ''
  const model     = pickModel(lastMsg)
  const maxTokens = model === MODEL_OPUS ? 1500 : 900  // Strategy 2b: limit output too

  // ── Strategy 3: Compress RO context ──────────────────────────────────────
  // Only include active (non-delivered) ROs; truncate notes to 70 chars
  const activeRos = ros.filter(r => r.status !== 'delivered')
  const roContext  = activeRos.map(r => {
    const lines = [
      `RO${r.roNumber}|${r.vehicle||'?'}|${r.customerName||''}|ins:${r.insurance||'?'}`,
      `status:${r.status||'?'} parts:${r.partsStatus||'?'} car:${r.carStatus||'?'}`,
    ]
    if (r.dropOffDate)  lines.push(`drop-off:${r.dropOffDate}`)
    if (r.promisedDate) {
      const overdue = new Date(r.promisedDate) < new Date(today)
      lines.push(`target:${r.promisedDate}${overdue ? ' ⚠️OVERDUE' : ''}`)
    }
    if (r.hasRental)    lines.push(`rental:yes`)
    if (r.totalAmount)  lines.push(`est:$${r.totalAmount}`)
    if (r.notes) {
      const firstNote = r.notes.split('\n').find(Boolean)?.slice(0, 70)
      if (firstNote) lines.push(`note:${firstNote}`)
    }
    return lines.join(' | ')  // single line per RO saves tokens vs multiline
  }).join('\n')

  const empList  = employees.map(e => `${e.name}(${e.role})`).join(', ')
  const memBlock = memory.length ? `\nMEMORY:\n${memory.map(f => `- ${f}`).join('\n')}` : ''

  // ── Strategy 1: System prompt built as cacheable block ────────────────────
  // The static parts (persona, glossary, format) are at the TOP so Anthropic
  // can cache them across calls. Dynamic parts (RO data) come after.
  const systemText = `You are an elite auto body shop operations manager and insurance claim specialist with 25+ years of experience at CS SCA Collision Walnut. Expertise: collision repair workflow, supplement negotiations, total loss determinations, DRP programs, cycle time management, insurance carrier relationships.

Be the manager's trusted operational right hand — sharp, data-driven, direct. You are a manager talking to another manager.

${SHOP_GLOSSARY}
${memBlock}

─── RESPONSE FORMAT ─────────────────────────────────────────────
Always return valid JSON:
{"reply":"response in SAME language as user (Chinese if Chinese). Markdown ok: **bold**, - bullets, ## headers.","actions":[],"smsText":null,"memoryFacts":[]}

─── ACTIONS (when asked to act on ROs) ──────────────────────────
{"type":"add_note","roNumber":"9448","note":"English text","confidence":"high"}
{"type":"assign_task","roNumber":"9448","assigneeName":"David","title":"English title","description":"","priority":"high","confidence":"high"}
{"type":"assign_body_man","roNumber":"9448","assigneeName":"David","confidence":"high"}
Use assign_body_man (NOT assign_task) when the user asks to set/assign the body technician or body man on an RO. Use assign_task for all other task assignments.
All note/title text MUST be English.

─── MEMORY ──────────────────────────────────────────────────────
If user shares shop-specific knowledge worth remembering (abbreviations, vendors, nicknames, workflow rules), add concise English strings to "memoryFacts" automatically. Do NOT add generic facts already in the glossary.

─── SMS ─────────────────────────────────────────────────────────
If asked for SMS/WeChat summary: populate "smsText" with Chinese text under 280 chars.

─── EXPERTISE RULES ─────────────────────────────────────────────
- ⚠️OVERDUE = past target date, flag prominently
- Cycle time >30 days without delivery = flag
- Missing parts on near-due ROs = flag proactively
- Insurance pressure, supplement flags, potential TL = note
- Prioritize by: overdue > near due > parts issue > otherwise

Today: ${today} | Team: ${empList}

ACTIVE ROs (${activeRos.length} total, delivered excluded):
${roContext || '(none)'}`

  // ── Strategy 4: Rolling window — compress long conversations ──────────────
  const compressedMessages = await compressHistory(messages, key)

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type':            'application/json',
      'x-api-key':               key,
      'anthropic-version':       '2023-06-01',
      'anthropic-betas':         'prompt-caching-2024-07-31',  // Strategy 1: enable caching
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      // Strategy 1: system as array with cache_control on static sections
      system: [
        {
          type:          'text',
          text:          systemText,
          cache_control: { type: 'ephemeral' },  // cache for 5 min — 90% cheaper on re-reads
        },
      ],
      messages: compressedMessages.map(m => ({ role: m.role, content: m.content })),
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    if (res.status === 401) throw new Error('INVALID_KEY')
    throw new Error(err.error?.message ?? `API error ${res.status}`)
  }

  const data = await res.json()
  const text = data.content?.[0]?.text ?? ''

  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/)
  const jsonStr   = jsonMatch ? jsonMatch[1] || jsonMatch[0] : text
  try {
    return JSON.parse(jsonStr.trim())
  } catch {
    return { reply: text, actions: [], smsText: null, memoryFacts: [] }
  }
}

// ── General Input Box parser ──────────────────────────────────────────────────
export async function parseShopInput({ text, ros, employees, images = [] }) {
  const today   = new Date().toISOString().split('T')[0]
  const roList  = ros.map(r => `RO${r.roNumber}: ${r.vehicle} (${r.customerName}), status: ${r.status}`).join('\n')
  const empList = employees.map(e => `${e.name} (${e.role})`).join(', ')
  const memory  = await loadAssistantMemory()
  const memBlock = memory.length
    ? `\nSHOP MEMORY (learned facts — apply these when parsing):\n${memory.map(f => `- ${f}`).join('\n')}\n`
    : ''

  const system = `You are the AI production assistant for CS SCA Collision Walnut, an auto body shop.
You think and respond like an experienced shop manager who knows collision repair workflow deeply.
Parse the user's quick update and return structured JSON actions.

Today's date: ${today}

Active ROs in system:
${roList || '(none yet)'}

Employees: ${empList || '(none listed)'}
${SHOP_GLOSSARY}
${memBlock}

RULES:
- ALL output (notes, task titles, descriptions) MUST be written in English, regardless of the input language. The user may speak/type in Chinese, Spanish, or mixed — always produce English output.
- Match RO numbers flexibly: "9448", "RO9448", "#9448" all work
- For assignees, match partial names (e.g. "David" → the employee named David)
- When a user updates ETA / completion date AND mentions calling the customer, create BOTH update_due_date AND an add_note saying who called and what was communicated
- Write notes in professional, concise third-person shop format (not casual)
- Dates without year: assume current year (${today.split('-')[0]}). Format as YYYY-MM-DD.
- If parts vendor is mentioned, include it in the note
- If truly ambiguous, set needsClarification instead of guessing
- @mention usually means assign_task, but ONLY when @Name matches an employee in the Employees list. Multiple employee @mentions in one message each get their own assign_task. Always pair with the most recently mentioned RO. e.g. "RO9448 @David fix bumper, @Israel blend paint" → two assign_task actions on RO9448
- @mentions are restricted to shop employees and known sublet vendors. NEVER treat vehicle owner/customer names as task assignees. If @Name is a sublet vendor, write an add_note about the vendor/sublet work instead of creating an employee task.
- If an image is attached: identify the vehicle/RO from visual cues (make/model/color, visible paperwork, license plate), describe visible damage in an add_note, and set update_car_status to car_in_shop if the car is clearly in the shop

EXAMPLE:
Input: "RO9448 dropped off 4-25, customer w/o rental, ordered parts thru pt eta 4-29, call and update customer eta is 5-5"
Output:
{
  "translation": null,
  "actions": [
    { "type": "update_dropoff_date", "roNumber": "9448", "dropOffDate": "${today.split('-')[0]}-04-25", "confidence": "high" },
    { "type": "update_car_status",   "roNumber": "9448", "carStatus": "car_in_shop", "confidence": "high" },
    { "type": "update_due_date",     "roNumber": "9448", "dueDate": "${today.split('-')[0]}-05-05", "confidence": "high" },
    { "type": "update_parts_status", "roNumber": "9448", "partsStatus": "ordered", "confidence": "high" },
    { "type": "add_note", "roNumber": "9448", "note": "Customer declined rental. Parts ordered via Parts Trader, ETA 4/29.", "confidence": "high" },
    { "type": "add_note", "roNumber": "9448", "note": "Called customer — updated target completion date to 5/5.", "confidence": "high" }
  ],
  "needsClarification": null
}

Return ONLY valid JSON in this exact format:
{
  "translation": "English version if input was not English, else null",
  "actions": [
    { "type": "add_note",            "roNumber": "9448", "note": "text of note",                                      "confidence": "high" },
    { "type": "update_status",       "roNumber": "9531", "status": "body_work",                                       "confidence": "high" },
    { "type": "update_parts_status", "roNumber": "9448", "partsStatus": "all_received",                               "confidence": "high" },
    { "type": "assign_task",         "roNumber": "9482", "assigneeName": "David", "title": "Start body work on rear quarter panel", "description": "optional details", "priority": "medium", "confidence": "high" },
    { "type": "update_car_status",   "roNumber": "9448", "carStatus": "car_in_shop",                                  "confidence": "high" },
    { "type": "update_dropoff_date", "roNumber": "9448", "dropOffDate": "2026-04-25",                                 "confidence": "high" },
    { "type": "update_due_date",     "roNumber": "9448", "dueDate": "2026-05-05",                                     "confidence": "high" },
    { "type": "update_rental",       "roNumber": "9448", "hasRental": false,                                           "confidence": "high" }
  ],
  "needsClarification": null
}

Valid status: checked_in, teardown, waiting_parts, body_work, body_complete, paint_prep, in_paint, paint_complete, reassembly, detail, qc, ready, delivered
Valid partsStatus: not_ordered, ordered, partially_received, all_received
Valid carStatus: pending_dropoff, car_in_shop
Valid priority: low, medium, high`

  const userMsg = images.length > 0
    ? `${text || 'Analyze the attached image and generate appropriate shop actions.'}`
    : text
  return callClaude(system, userMsg, null, images)
}

// ── Parse name/vendor mapping text from Settings ──────────────────────────────
function parseMappingText(raw = '') {
  const map = {}
  raw.split('\n').forEach(line => {
    const idx = line.indexOf('=')
    if (idx < 0) return
    const key = line.slice(0, idx).trim().toLowerCase()
    const val = line.slice(idx + 1).trim()
    if (key && val) map[key] = val
  })
  return map
}

// ── DingTalk / Meeting notes parser ──────────────────────────────────────────
export async function parseMeetingNotes({ text, ros, employees, images = [], nameMap = '', vendorMap = '' }) {
  const today  = new Date().toISOString().split('T')[0]
  const roList = ros.map(r =>
    `RO${r.roNumber}: ${r.vehicle} (${r.customerName}), status: ${r.status}`
  ).join('\n')

  const empList = employees.map(e => `${e.name} (${e.role})`).join('\n')

  const nameMappings = parseMappingText(nameMap)
  const nameMappingStr = Object.entries(nameMappings)
    .map(([k, v]) => `  "${k}" → ${v}`)
    .join('\n')

  const vendorMappings = parseMappingText(vendorMap)
  const vendorStr = Object.entries(vendorMappings)
    .map(([k, v]) => `  "${k}" → ${v}`)
    .join('\n')

  const system = `You are the AI production assistant for CS SCA Collision Walnut, an auto body shop.
You think like an experienced shop manager parsing a morning production meeting transcript.
Extract all actionable information and return structured JSON.

Today's date: ${today}

Active ROs in system:
${roList || '(none yet)'}

Employees (name + role):
${empList || '(none listed)'}

${nameMappingStr ? `NAME ALIASES — resolve these to full names:
${nameMappingStr}

IMPORTANT: In meeting context, "Aaron" almost always means Aaron Cruz (body_man).
Only resolve to Aaron Liu (shop_manager) when context is clearly managerial
(e.g. "Aaron approved the estimate", "Aaron needs to call the adjuster").
When in doubt, default to Aaron Cruz.
` : ''}${vendorStr ? `VENDOR ALIASES:
${vendorStr}
` : ''}${SHOP_GLOSSARY}

RULES:
- Match RO numbers: "9448", "#9448", "RO9448" all work — also handle spoken/approximate numbers
- Always use the FULL name (from aliases above) in task assigneeName
- Mark confidence "low" if you can't clearly match an RO number
- Include everything you find — the human will review before applying
- Dates without year: assume ${today.split('-')[0]}. Use YYYY-MM-DD format.
- Write notes in concise professional third-person shop format
- If content is in Chinese or Spanish, translate it first

Return ONLY valid JSON (no extra text):
{
  "summary": "1-2 sentence summary of today's meeting",
  "roActions": [
    {
      "roNumber": "9531",
      "vehicleHint": "Tesla Model Y",
      "changes": {
        "status": "body_work",
        "notes": "note text to append",
        "partsStatus": "ordered",
        "carStatus": "car_in_shop",
        "dueDate": "2026-05-05"
      },
      "tasks": [
        {
          "assigneeName": "Israel Ramirez",
          "title": "Start body work on rear panel",
          "description": "optional details",
          "priority": "high"
        }
      ],
      "confidence": "high"
    }
  ],
  "generalNotes": "anything not tied to a specific RO",
  "unrecognized": ["phrases that mentioned vehicles/tasks but couldn't be matched to an RO"]
}

Valid status: checked_in, teardown, waiting_parts, body_work, body_complete, paint_prep, in_paint, paint_complete, reassembly, detail, qc, ready, delivered
Valid partsStatus: not_ordered, ordered, partially_received, all_received
Valid carStatus: pending_dropoff, car_in_shop
Valid priority: low, medium, high`

  const userMsg = images.length > 0
    ? `Meeting notes below. ${images.length} image(s) from the DingTalk 图文纪要 are attached — read both text and images.\n\nMeeting transcript:\n\n${text}`
    : `Meeting transcript:\n\n${text}`

  return callClaude(system, userMsg, null, images)
}
