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
      max_tokens: 4096,
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
export async function askShopAssistant({ messages, ros, employees, callerName = null, callerRole = null }) {
  const key = await getApiKey()
  if (!key) throw new Error('NO_API_KEY')

  const today  = new Date().toISOString().split('T')[0]
  const memory = await loadAssistantMemory()

  // ── Strategy 2: Pick model based on query complexity ─────────────────────
  const lastMsg   = messages[messages.length - 1]?.content ?? ''
  const model     = pickModel(lastMsg)
  const maxTokens = 8192  // API max — at Opus pricing ~$0.61/call max, well under $1.50 budget

  // ── Strategy 3: Compress RO context ──────────────────────────────────────
  // Only include active production ROs; truncate notes to 70 chars
  const activeRos = ros.filter(r => !['delivered', 'total_loss'].includes(r.status))
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
      const notesStr  = typeof r.notes === 'string' ? r.notes : ''
      const firstNote = notesStr.split('\n').find(Boolean)?.slice(0, 70)
      if (firstNote) lines.push(`note:${firstNote}`)
    }
    return lines.join(' | ')  // single line per RO saves tokens vs multiline
  }).join('\n')

  const empList  = employees.map(e => `${e.name}(${e.role})`).join(', ')
  const memBlock = memory.length ? `\nSHOP GLOSSARY (shop-specific terms — context reference only; always reason from the full message, don't apply mechanically):\n${memory.map(f => `- ${f}`).join('\n')}` : ''

  // ── Strategy 1: System prompt built as cacheable block ────────────────────
  // The static parts (persona, glossary, format) are at the TOP so Anthropic
  // can cache them across calls. Dynamic parts (RO data) come after.
  const systemText = `You are an elite auto body shop operations manager and insurance claim specialist with 25+ years of experience at CS SCA Collision Walnut. Expertise: collision repair workflow, supplement negotiations, total loss determinations, DRP programs, cycle time management, insurance carrier relationships.

Be the trusted operational right hand — sharp, data-driven, direct. Tailor every response to the person asking (see CALLER below).

${SHOP_GLOSSARY}
${memBlock}

─── RESPONSE FORMAT ─────────────────────────────────────────────
Always return valid JSON:
{"reply":"<your full response text here — never empty, never '...'>","actions":[],"smsText":null,"memoryFacts":[]}

IMPORTANT: "reply" MUST always contain your complete response. Never use "..." or leave it blank.

─── RESPONSE STYLE ──────────────────────────────────────────────
Be concise. Lead with the most critical finding. Rules:
- For status queries: one line per RO → "**RO#** | Vehicle | Status | Issue"
- Bullet lists max 5 items; tables for multi-RO comparisons
- Bold only real warnings (overdue, missing parts, TL risk)
- No filler: skip "I notice that…", "Based on the data…", "It appears…"
- Language: English by default; Chinese only if user's message is clearly Chinese; Spanish if clearly Spanish
- Markdown ok: **bold**, - bullets, | tables

─── ACTIONS (when asked to act on ROs) ──────────────────────────
{"type":"add_note","roNumber":"9448","note":"English text","confidence":"high"}
{"type":"assign_task","roNumber":"9448","assigneeName":"David","title":"English title","description":"","priority":"high","confidence":"high"}
{"type":"assign_body_man","roNumber":"9448","assigneeName":"David","confidence":"high"}
Use assign_body_man (NOT assign_task) when the user asks to set/assign the body technician or body man on an RO. Body Tech assignees must have role body_man. Use assign_task for all other task assignments.
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

─── CALLER ──────────────────────────────────────────────────────
${callerName ? `Name: ${callerName} | Role: ${callerRole ?? 'unknown'}` : 'Role: unknown'}
- manager/production_manager/estimator: full production overview, all ROs, priorities, supplement flags, cycle time; estimator also owns estimate writing and parts ordering responsibility
- parts_manager: parts tracking across all ROs — what's ordered, ETA, partially received, fully received; return parts processing; NOT responsible for ordering (that's estimator)
- body_man/painter/technician: only their assigned ROs/tasks; short and actionable
- unknown: assume manager-level access

Today: ${today} | Team: ${empList}

ACTIVE ROs (${activeRos.length} total, delivered/total loss excluded):
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
  const text      = data.content?.[0]?.text ?? ''
  const truncated = data.stop_reason === 'max_tokens'

  // For truncated responses the closing } is missing; append it so JSON.parse has a chance
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/)
  const rawJson   = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text
  const jsonStr   = truncated ? rawJson.trimEnd().replace(/,?\s*$/, '') + '}}' : rawJson
  try {
    return JSON.parse(jsonStr.trim())
  } catch {
    // Partial recovery: extract reply field via regex so the user sees the text
    // even if the actions array was cut mid-stream.
    const searchIn = rawJson || text
    const m = searchIn.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/)
    if (m) {
      const extracted = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      const suffix = truncated ? '\n\n⚠️ Response was cut short — please retry with a more specific question.' : ''
      return { reply: extracted + suffix, actions: [], smsText: null, memoryFacts: [] }
    }
    // Last resort: if the model returned plain prose instead of JSON, show it directly
    if (text && !text.startsWith('{')) {
      return { reply: text, actions: [], smsText: null, memoryFacts: [] }
    }
    return { reply: '⚠️ Could not parse AI response. Please try again.', actions: [], smsText: null, memoryFacts: [] }
  }
}

// ── General Input Box parser ──────────────────────────────────────────────────
export async function parseShopInput({ text, ros, employees, images = [], sourceRole = null }) {
  const today   = new Date().toISOString().split('T')[0]
  const roList  = ros.map(r => {
    const orders = Array.isArray(r.partsOrders) && r.partsOrders.length
      ? `, partsOrders: ${r.partsOrders.map(o => `${o.vendor || '?'} ${o.qtyReceived ?? o.receivedQty ?? 0}/${o.qty ?? o.quantity ?? '?'} ${o.status || 'ordered'}${o.eta ? ` eta ${o.eta}` : ''}`).join('; ')}`
      : ''
    return `RO${r.roNumber}: ${r.vehicle} (${r.customerName}), status: ${r.status}, partsStatus: ${r.partsStatus || 'not_ordered'}${orders}`
  }).join('\n')
  const empList = employees.map(e => `${e.name} (${e.role})`).join(', ')
  const memory  = await loadAssistantMemory()
  const memBlock = memory.length
    ? `\nSHOP GLOSSARY (shop-specific terms — use as context clues when interpreting input; reason from context, not mechanically):\n${memory.map(f => `- ${f}`).join('\n')}\n`
    : ''

  const sourceContextBlock = sourceRole === 'parts_manager'
    ? `
INPUT CONTEXT:
- Current surface: Parts Manager page.
- Default speaker intent: the Parts Manager is updating vendor/parts information, not customer completion promises.
- For short inputs containing an RO number plus a vendor, dealer, part name, quantity, received count, ETA, backorder, return, exchange, or wrong-part detail, prefer parts actions.
- If the input contains RO + part/vendor text + ETA/date, emit update_parts_order with eta. Do NOT emit update_due_date.
- Only emit update_due_date from this page when the text explicitly mentions vehicle/shop/customer completion ETA, target completion, delivery/pickup date, promised date, or customer update.
- Part names such as bumper, fender, headlight, lamp, grille, hood, door, mirror, sensor, bracket, cover, reinforcement, absorber, molding, condenser, radiator, wheel, and blend should be treated as parts descriptions. If no vendor is clear, leave vendor blank and keep the part text in description.
`
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
${sourceContextBlock}

FIELD NOTES:
- "ETA" (shop's target completion date) is separate from "CCC Date-Out" (a locked CCC formula date). "Shop ETA", "repair ETA", "shop repair ETA", "repair due", and "due date" all mean update_due_date. update_due_date sets the shop ETA — it does NOT touch CCC Date-Out.
- "Drop-Off Date" (shown as "In:" on the board) tracks the planned or actual vehicle drop-off date. Car Status separately records whether the vehicle is physically in the shop.

RULES:
- ALL output (notes, task titles, descriptions) MUST be written in English, regardless of the input language. The user may speak/type in Chinese, Spanish, or mixed — always produce English output.
- Match RO numbers flexibly: "9448", "RO9448", "#9448" all work
- In multi-RO input, bind each fact only to the nearest explicitly named RO clause. Never copy rental, date, status, parts, authorization, assignee, or task details from one RO to another. Share a fact only when the user explicitly groups the RO numbers before that shared fact (for example, "RO9448 and RO9531 both have no rental").
- For assignees, match partial names (e.g. "David" → the employee named David)
- When a user updates the vehicle/shop ETA or completion date AND mentions calling the customer, create BOTH update_due_date AND an add_note saying who called and what was communicated.
- When a user updates a parts vendor ETA (examples: "dealer eta change to 5-14", "K&P eta 5/15", "Puente Hills Hyundai ETA changed"), emit update_parts_order with that vendor/dealer and eta. Do NOT emit update_due_date for vendor ETA changes.
- In Parts Manager context, bare "ETA" defaults to parts/vendor ETA. Use update_due_date only when the input clearly refers to vehicle/shop/customer completion timing.
- When input contains drop-off keywords (dropped off, drop off, 放车, 送来, 已到, 进店), ALWAYS generate BOTH update_dropoff_date AND an add_note describing the drop-off event. Never emit update_dropoff_date without a paired add_note.
- Distinguish scheduled drop-off from physical arrival. If the date is in the future or the user says 预计/计划/会来/expected/scheduled/will drop off, use update_car_status "pending_dropoff" and write "scheduled to drop off" in the note. Use "car_in_shop" and past-tense "dropped off" only after explicit arrival confirmation.
- Write notes in professional, concise third-person shop format (not casual)
- Dates without year: assume current year (${today.split('-')[0]}). Format as YYYY-MM-DD.
- Parts workflow: ESTIMATOR is responsible for ordering parts. PARTS MANAGER tracks ETA, confirms receipt, and handles return parts.
- In Parts Manager context, assume short natural-language updates are about parts unless the user clearly says vehicle/customer/shop completion date. Safe vendor alias: "SM Toyota" or "SMT" means "Santa Margarita Toyota". Do not treat "Santa Margarita" alone or "Puente" alone as a confirmed vendor alias.
- If the user says "ordered parts", "下单", "订零件", or otherwise mentions a parts order/update, emit update_parts_order even when vendor, qty, or ETA is missing. Leave missing vendor blank, missing qty null, and missing eta null so the Parts Manager can fill it later. Use qty, qtyReceived, vendorFull when known, and status ordered/partial/received.
- Preserve explicit vendor names from the user's input. Do not invent or substitute vendor abbreviations. Example: "Parts Authority" must stay "Parts Authority"; never turn it into "PAC" unless the user actually said PAC.
- For compact batch parts orders like "1 from Keystone, 1 from Parts Authority, 1 from Amazon all ETA 5/21, 3 labels ordered from Auto Datalabel ETA 5/22", emit one update_parts_order per vendor. Apply a shared "all ETA" to the vendor clauses immediately before it, and keep later clauses with their own ETA separate.
- If the user says parts arrived/received, emit log_parts_received with vendor, qtyReceived, and totalQty when known. For received parts, prefer the existing vendor name already listed in that RO's partsOrders over creating a new spelling; treat labels like "(Dealer)", "OEM", or "Parts" as descriptive, not different vendors.
- Chinese future wording such as "预计收到", "预计全部收", "会到", or "大概会到" means an ordered shipment with an ETA. Emit update_parts_order with qtyReceived 0; never emit log_parts_received until the user confirms 已收到/已收齐/received/arrived.
- If the user says an RO needs no replacement parts / no parts are needed, do NOT create a 0-qty parts order. Emit update_parts_status with partsStatus "all_received" and a concise add_note that no replacement parts are needed.
- Treat "received 1 from Keystone" as an incremental receipt of 1 additional usable part, not a final cumulative received count. Only treat a count as final when the user writes a fraction like "received 9/9" or says "received all".
- For "received all parts except N from VENDOR" or multiple exceptions like "except 1 from VENDOR A and 2 from VENDOR B", interpret every other existing vendor on that RO as fully received and each exception vendor as ordered qty minus short qty. Write one concise summary note for the RO instead of separate notes per vendor.
- If the user says wrong part/return/credit, emit log_parts_return with qty, reason (surplus/defective/wrong_part/exchange when clear), needsReplacement true when a replacement is needed, and status pending.
- Rejected, wrong, or exchange-needed parts are NOT usable received parts. Do not count rejected qty in log_parts_received. Example: if Keystone is 8/9 and the user says "Keystone received 1 part, reject, need exchange", emit log_parts_return only for 1 pc with reason exchange and needsReplacement true, plus a note. The usable received count stays 8/9.
- If the user gives a mixed count like "received 10, 1 wrong/exchange", log only the accepted usable quantity as received (9), and log the rejected quantity (1) as log_parts_return.
- If parts vendor is mentioned, include it in the note
- For "got/received all parts from VENDOR A and VENDOR B", emit one log_parts_received action per listed vendor using each vendor's existing ordered quantity when known.
- If truly ambiguous, set needsClarification instead of guessing
- @mention usually means assign_task, but ONLY when @Name matches an employee in the Employees list. Multiple employee @mentions in one message each get their own assign_task. If a recent RO is mentioned, attach the task to that RO. If no RO is mentioned, still create assign_task without roNumber as a standalone reminder/task. Users may @ themselves to create their own reminder.
- For standalone @mention tasks, make the title the requested work/reminder, not the person's name. Example: "@Aaron call State Farm tomorrow" → assign_task with assigneeName "Aaron", title "Call State Farm tomorrow", no roNumber.
- @mentions are restricted to shop employees and known sublet vendors. NEVER treat vehicle owner/customer names as task assignees. If @Name is a sublet vendor, write an add_note about the vendor/sublet work instead of creating an employee task.
- If the user says "Aaron" in a body/bodyman/teardown/repair context and multiple Aarons exist, choose the employee whose role is body_man, not the manager/owner Aaron. If no matching body_man exists, ask for clarification instead of assigning a non-body role.
- Use assign_body_man when setting the body technician. Body Tech assignees must have role body_man. The app will create the simple body task "Teardown & process repair" automatically.
- Use assign_painter when setting the painter for an RO. Painter assignees must have role painter — auto-creates paint tasks. Use assign_task (NOT assign_painter) when adding a reminder or note FOR a painter/paint_helper, e.g. "@painter blend if needed", "@Israel check color match" — this creates a paint subtask visible on their mobile view.
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
    { "type": "update_parts_order",  "roNumber": "9448", "vendor": "PT", "vendorFull": "Parts Trader", "description": "Parts order", "qty": 1, "qtyReceived": 0, "eta": "${today.split('-')[0]}-04-29", "status": "ordered", "confidence": "high" },
    { "type": "add_note", "roNumber": "9448", "note": "Vehicle dropped off on 4/25. Customer declined rental. Parts ordered via Parts Trader, ETA 4/29.", "confidence": "high" },
    { "type": "add_note", "roNumber": "9448", "note": "Called customer — updated shop ETA to 5/5.", "confidence": "high" }
  ],
  "needsClarification": null
}

Return ONLY valid JSON in this exact format:
{
  "translation": "English version if input was not English, else null",
  "actions": [
    { "type": "add_note",            "roNumber": "9448", "note": "text of note",                                      "confidence": "high" },
    { "type": "update_status",       "roNumber": "9531", "status": "body_work",                                       "confidence": "high" },
    { "type": "update_parts_order",  "roNumber": "9448", "vendor": "PT", "vendorFull": "Parts Trader", "description": "Bumper cover, grille", "qty": 3, "qtyReceived": 0, "eta": "2026-05-10", "status": "ordered", "confidence": "high" },
    { "type": "log_parts_received",  "roNumber": "9448", "vendor": "PT", "qtyReceived": 2, "totalQty": 3, "note": "Missing 1 pc, backorder", "confidence": "high" },
    { "type": "log_parts_return",    "roNumber": "9448", "vendor": "LKQ", "qty": 1, "reason": "wrong_part", "needsReplacement": true, "status": "pending", "notes": "Wrong part sent", "confidence": "high" },
    { "type": "assign_task",         "roNumber": "9482", "assigneeName": "David", "title": "Start body work on rear quarter panel", "description": "optional details", "priority": "medium", "confidence": "high" },
    { "type": "assign_task",         "assigneeName": "Aaron", "title": "Call State Farm tomorrow", "description": "", "priority": "medium", "confidence": "high" },
    { "type": "assign_body_man",     "roNumber": "9448", "assigneeName": "Aaron",                                     "confidence": "high" },
    { "type": "assign_painter",      "roNumber": "9448", "assigneeName": "Israel",                                    "confidence": "high" },
    { "type": "update_car_status",   "roNumber": "9448", "carStatus": "car_in_shop",                                  "confidence": "high" },
    { "type": "update_dropoff_date", "roNumber": "9448", "dropOffDate": "2026-04-25",                                 "confidence": "high" },
    { "type": "update_due_date",     "roNumber": "9448", "dueDate": "2026-05-05",                                     "confidence": "high" },
    { "type": "update_rental",       "roNumber": "9448", "hasRental": false,                                           "confidence": "high" },
    { "type": "complete_phase",      "roNumber": "9448", "phase": "body",                                              "confidence": "high" }
  ],
  "needsClarification": null
}

- Use assign_body_man when setting the body technician; assignee must have role body_man — auto-creates "Teardown & process repair" task.
- Use assign_painter when setting the painter; assignee must have role painter — auto-creates paint tasks.
- Use assign_task (NOT assign_painter) when adding a reminder or subtask FOR a painter/paint_helper: "@painter blend if needed" → assign_task assigneeName=painter, title="Blend if needed". System attaches it as a paint subtask on their mobile view.
- Use complete_phase when a worker reports a repair stage is DONE (e.g. "body work complete", "paint done", "teardown done", "reassembly done"). This marks all tasks for that phase as completed AND advances the RO status automatically. Do NOT also emit update_status when using complete_phase — the system handles the transition.
  Phase values: checkin | teardown | body | paint_prep | paint | reassembly | sublet | detail
  Examples:
    "RO9448 body work complete" → complete_phase phase:body + add_note
    "RO9531 paint done" → complete_phase phase:paint + add_note
    "teardown complete" → complete_phase phase:teardown + add_note
    "paint prep done / ready for paint" → complete_phase phase:paint_prep + add_note
    "reassembly done" → complete_phase phase:reassembly + add_note
    "sublet complete / cal done" → complete_phase phase:sublet + add_note
    "QC done / detail complete / vehicle ready" → complete_phase phase:detail + add_note
    "total loss / declared TL" → update_status status:total_loss + add_note
Valid status: checked_in, teardown, waiting_parts, body_work, body_complete, paint_prep, in_paint, paint_complete, reassembly, sublet, detail, ready, total_loss, delivered
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

// ── Daily note summarizer ─────────────────────────────────────────────────────
// Called once per past day per RO when first viewed after midnight.
// Stores concise bullets so the Notes Log can collapse old days cleanly.
export async function summarizeDayNotes({ vehicle, dateLabel, noteLines }) {
  const key = await getApiKey()
  if (!key) throw new Error('NO_API_KEY')

  const system = `You are a concise auto body shop daily-note summarizer.
Given raw shop notes for ONE repair order on ONE day, return ultra-compact bullet summaries.
Rules:
- 1-3 bullets only; add a bullet only for a truly distinct event
- NO vehicle make/model/name — the reader already knows the car
- Format: [keyword] date if relevant — very short description
  Keywords to use: paint | body | teardown | parts | reassembly | sublet | delivery | customer | supplement | status | task
  Examples: "paint 05/06 — entered booth" | "parts — ordered via PT, ETA 05/10" | "customer — called, ETA updated 05/15" | "reassembly — Israel assigned 05/07"
- Omit timestamps, author names, RO numbers
- English only, terse fragments (not full sentences)
Return ONLY valid JSON: {"bullets":["bullet 1","bullet 2"]}`

  const text = `${dateLabel}:\n\n${noteLines.join('\n')}`
  const result = await callClaude(system, text, key, [], MODEL_FAST)
  if (Array.isArray(result?.bullets) && result.bullets.length) return result
  throw new Error('unexpected response')
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

Valid status: checked_in, teardown, waiting_parts, body_work, body_complete, paint_prep, in_paint, paint_complete, reassembly, sublet, detail, ready, total_loss, delivered
Valid partsStatus: not_ordered, ordered, partially_received, all_received
Valid carStatus: pending_dropoff, car_in_shop
Valid priority: low, medium, high`

  const userMsg = images.length > 0
    ? `Meeting notes below. ${images.length} image(s) from the DingTalk 图文纪要 are attached — read both text and images.\n\nMeeting transcript:\n\n${text}`
    : `Meeting transcript:\n\n${text}`

  return callClaude(system, userMsg, null, images)
}
