import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { google } from 'googleapis'
import Anthropic from '@anthropic-ai/sdk'
import { PHASE0_COMPOSITIONS } from '@/lib/compositions'

const FPX = 9144000 / 1920

// Grid constants (Figma px) — must match create-master and lib/google.ts
const PAD = 100, TH = 100, CY = 300, GAP = 30, INN = 30, UW = 1720, H = 1080

function getOAuth2Client(accessToken: string) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  oauth2.setCredentials({ access_token: accessToken })
  return oauth2
}

// ── Geometry-aware slot identification ────────────────────────────────────────
// Returns the slot name (e.g. 'КОЛОНКА_1') for a text box given its rendered
// position in Figma px and the composition type.
function identifySlot(
  compId: string,
  elX: number, elY: number, elW: number,
  textLen: number,
): string | null {
  switch (compId) {
    case 'cover':
      if (elY < 500 && elW > 1500) return 'ЗАГОЛОВОК'
      if (elY > H / 2 && elW < 700)  return 'ДАТА'
      return null

    case 'title_body':
      if (elY < PAD + TH + 20 && elW > 1500) return 'ЗАГОЛОВОК'
      if (elY >= CY - 20 && elW > 1500) return 'ТЕКСТ'
      if (elY > H - 200)                return 'ПІДПИС'
      return null

    case 'two_columns': {
      if (elY < PAD + TH + 20 && elW > 1500) return 'ЗАГОЛОВОК'
      const midX = PAD + (UW - GAP) / 2 + GAP / 2  // ≈ 545
      if (elY >= CY - 30) return elX < midX ? 'КОЛОНКА_1' : 'КОЛОНКА_2'
      return null
    }

    case 'three_columns': {
      if (elY < PAD + TH + 20 && elW > 1500) return 'ЗАГОЛОВОК'
      const cw = (UW - 2 * GAP) / 3  // ≈ 553
      if (elY >= CY - 30) {
        if (elX < PAD + cw)           return 'КОЛОНКА_1'
        if (elX < PAD + 2 * cw + GAP) return 'КОЛОНКА_2'
        return 'КОЛОНКА_3'
      }
      return null
    }

    case 'kpi_cards': {
      // ЗАГОЛОВОК y≈100 must be strictly below PAD+TH (200) to avoid capturing ТЕКСТ at y=200
      if (elY < PAD + TH && elW > 1500) return 'ЗАГОЛОВОК'
      if (elY >= PAD + TH && elY < CY && elW > 1500) return 'ТЕКСТ'
      // Card elements: y > ~350, w < ~450
      if (elY >= CY && elW < 500) {
        const kw = (UW - 3 * GAP) / 4  // ≈ 407
        const cardIdx = Math.min(3, Math.max(0, Math.round((elX - PAD) / (kw + GAP))))
        const n = cardIdx + 1
        // ЗНАЧЕННЯ (limit 10) vs ПІДПИС (limit 40): identify by text length
        return textLen <= 12 ? `КАРТКА_${n}_ЗНАЧЕННЯ` : `КАРТКА_${n}_ПІДПИС`
      }
      return null
    }

    default:
      return null
  }
}

type TextBoxViolation = {
  objectId: string
  composition: string
  slotName: string
  currentText: string
  limit: number
}

const SLOT_HINTS: Record<string, string> = {
  ДАТА:  'тільки дата, наприклад «29 червня 2026» — без назви події чи опису',
  ТЕКСТ: 'підпис-субтитул: ТІЛЬКИ ключові слова або 1-2 цифри. Викинь усі пояснення. Фраза, не речення.',
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { presentationId } = await req.json() as { presentationId: string }
  if (!presentationId) {
    return NextResponse.json({ error: 'presentationId required' }, { status: 400 })
  }

  const auth2 = getOAuth2Client(session.accessToken)
  const slidesApi = google.slides({ version: 'v1', auth: auth2 })
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // ── 1. Read presentation ─────────────────────────────────────────────────
  const pres = await slidesApi.presentations.get({ presentationId })
  const slides = pres.data.slides ?? []

  // ── 2. Find violations ───────────────────────────────────────────────────
  const violations: TextBoxViolation[] = []

  for (const slide of slides) {
    // Get composition ID from speaker notes (written there during creation)
    const notes = (slide.slideProperties?.notesPage?.pageElements ?? [])
      .map(el => (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join(''))
      .join('')
    const compId = notes.match(/composition:(\w+)/)?.[1]
    if (!compId) continue

    const comp = PHASE0_COMPOSITIONS.find(c => c.id === compId)
    if (!comp) continue

    for (const el of slide.pageElements ?? []) {
      if (el.shape?.shapeType !== 'TEXT_BOX' || !el.objectId || !el.transform || !el.size) continue

      const text = (el.shape?.text?.textElements ?? [])
        .map(te => te.textRun?.content ?? '').join('').trim()
      if (!text) continue

      const elX = Math.round((el.transform.translateX ?? 0) / FPX)
      const elY = Math.round((el.transform.translateY ?? 0) / FPX)
      const elW = Math.round((el.size.width?.magnitude ?? 0) * (el.transform.scaleX ?? 1) / FPX)

      const slotName = identifySlot(compId, elX, elY, elW, text.length)
      if (!slotName) continue

      const slotDef = comp.slots.find(s => s.name === slotName)
      if (!slotDef?.max_chars) continue

      if (text.length > slotDef.max_chars) {
        violations.push({
          objectId:    el.objectId,
          composition: compId,
          slotName,
          currentText: text,
          limit:       slotDef.max_chars,
        })
      }
    }
  }

  if (violations.length === 0) {
    return NextResponse.json({ message: 'No max_chars violations found — deck is clean', presentationId })
  }

  // ── 3. Ask LLM to shorten each violating text ────────────────────────────
  const items = violations.map(v => {
    const hint = SLOT_HINTS[v.slotName] ? ` (${SLOT_HINTS[v.slotName]})` : ''
    return `- objectId: ${v.objectId}\n  слот: ${v.slotName}${hint}\n  ліміт: ${v.limit} символів\n  текст (${v.currentText.length} символів): "${v.currentText}"`
  }).join('\n\n')

  const fixResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Ці текстові блоки перевищують ліміт символів. Перепиши кожен як короткий заголовок-підпис — ТІЛЬКИ ключові слова або цифри, без пояснень. ОБОВ'ЯЗКОВО вкластися в ліміт символів.\n\n${items}\n\nПоверни ТІЛЬКИ JSON-масив (без markdown):\n[{"objectId":"...","value":"..."}]`,
    }],
  })

  const fixContent = fixResponse.content[0]
  if (fixContent.type !== 'text') {
    return NextResponse.json({ error: 'LLM fix failed' }, { status: 500 })
  }

  const raw = fixContent.text.trim()
  const clean = raw.startsWith('```') ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : raw
  const fixes = JSON.parse(clean) as { objectId: string; value: string }[]

  // ── 4. Validate fixes ────────────────────────────────────────────────────
  const validFixes = fixes.filter(f => {
    const v = violations.find(v => v.objectId === f.objectId)
    if (!v) return false
    if (f.value.length > v.limit) {
      console.warn(`[repair] ${f.objectId} ${v.slotName}: still ${f.value.length}>${v.limit}`)
      return false
    }
    return true
  })

  if (validFixes.length === 0) {
    return NextResponse.json({ error: 'LLM could not produce valid fixes', violations }, { status: 422 })
  }

  // ── 5. Apply fixes via batchUpdate ────────────────────────────────────────
  await slidesApi.presentations.batchUpdate({
    presentationId,
    requestBody: {
      requests: validFixes.flatMap(f => [
        { deleteText: { objectId: f.objectId, textRange: { type: 'ALL' } } },
        { insertText: { objectId: f.objectId, insertionIndex: 0, text: f.value } },
      ]),
    },
  })

  return NextResponse.json({
    fixed:   validFixes.length,
    skipped: fixes.length - validFixes.length,
    changes: validFixes.map(f => ({
      slotName: violations.find(v => v.objectId === f.objectId)?.slotName,
      before:   violations.find(v => v.objectId === f.objectId)?.currentText,
      after:    f.value,
    })),
    url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
  })
}
