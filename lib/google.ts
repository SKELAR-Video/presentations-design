import { google } from 'googleapis'
import type { slides_v1 } from 'googleapis'
import type { SlidePlan } from './types'
import { PHASE0_COMPOSITIONS, getComposition } from './compositions'

// ─── Bento font-size auto-shrink ─────────────────────────────────────────────
// Layout constants must mirror create-master/route.ts
const _PAD = 100, _UW = 1720, _GAP = 30, _INN = 30, _TH = 100, _TG = 100, _H = 1080
const _CY = _PAD + _TH + _TG
const _CH = _H - _PAD - _CY

function bentoDims(compId: string): { w: number; h: number } | null {
  if (compId === 'two_columns') {
    const cw = Math.floor((_UW - _GAP) / 2)
    return { w: cw - 2 * _INN, h: _CH - 2 * _INN }
  }
  if (compId === 'three_columns') {
    const cw = Math.floor((_UW - 2 * _GAP) / 3)
    return { w: cw - 2 * _INN, h: _CH - 2 * _INN }
  }
  return null
}

const BENTO_TOKENS: Record<string, string[]> = {
  two_columns:   ['КОЛОНКА_1', 'КОЛОНКА_2'],
  three_columns: ['КОЛОНКА_1', 'КОЛОНКА_2', 'КОЛОНКА_3'],
}

const BENTO_DEFAULT_PT: Record<string, number> = {
  two_columns: 18,
  three_columns: 18,
}

const FONT_STEPS = [22, 18, 14] as const

function textFits(text: string, wPx: number, hPx: number, pt: number): boolean {
  if (!text.trim()) return true
  const px = pt * 2.667
  const cpl = Math.max(1, Math.floor(wPx / (px * 0.58)))   // chars per line (Inter Medium, conservative)
  const maxLines = Math.floor(hPx / (px * 1.2))             // conservative line height
  const words = text.split(/\s+/).filter(Boolean)
  let lines = 1, cur = 0
  for (const w of words) {
    if (!cur) { cur = w.length }
    else if (cur + 1 + w.length <= cpl) { cur += 1 + w.length }
    else { lines++; cur = w.length }
  }
  return lines <= maxLines
}

// Returns the largest step (≤ defaultPt) at which every bento card on the slide fits.
function pickBentoPt(compId: string, slots: Record<string, string>): number | null {
  const dims = bentoDims(compId)
  const tokens = BENTO_TOKENS[compId]
  const defPt = BENTO_DEFAULT_PT[compId]
  if (!dims || !tokens || !defPt) return null
  const steps = FONT_STEPS.filter(s => s <= defPt)
  for (const pt of steps) {
    if (tokens.every(t => textFits(slots[t] ?? '', dims.w, dims.h, pt))) return pt
  }
  return steps[steps.length - 1]  // 14 pt — smallest step, use regardless
}

function getOAuth2Client(accessToken: string) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  oauth2.setCredentials({ access_token: accessToken })
  return oauth2
}

function getSlideNotes(slide: slides_v1.Schema$Page): string {
  return (
    slide.slideProperties?.notesPage?.pageElements
      ?.find(
        (el) =>
          el.shape?.placeholder?.type === 'BODY' ||
          el.shape?.shapeType === 'TEXT_BOX',
      )
      ?.shape?.text?.textElements?.map((te) => te.textRun?.content ?? '')
      .join('') ?? ''
  )
}

export async function buildPresentation(
  accessToken: string,
  plan: SlidePlan,
  title: string,
): Promise<string> {
  const auth = getOAuth2Client(accessToken)
  const drive = google.drive({ version: 'v3', auth })
  const slidesApi = google.slides({ version: 'v1', auth })
  const masterDeckId = process.env.MASTER_DECK_ID
  if (!masterDeckId) throw new Error('MASTER_DECK_ID не заданий у .env.local — оновіть його і перезапустіть сервер')

  // Step 1: Copy master deck
  const copyRes = await drive.files.copy({
    fileId: masterDeckId,
    supportsAllDrives: true,
    requestBody: { name: title },
  })
  const presentationId = copyRes.data.id!

  // Step 2: Read slides, build composition → pageId map
  const presentation = await slidesApi.presentations.get({ presentationId })
  const allSlides = presentation.data.slides ?? []

  // Build composition → slide ID map.
  // Primary: speaker notes "composition:<id>".
  // Fallback: slide position matches PHASE0_COMPOSITIONS order.
  const templateCompIds = PHASE0_COMPOSITIONS.map(c => c.id)
  const compMap: Record<string, string[]> = {}
  for (let i = 0; i < allSlides.length; i++) {
    const slide = allSlides[i]
    const notes = getSlideNotes(slide)
    const match = notes.match(/composition:(\w+)/)
    const compId = match?.[1] ?? templateCompIds[i]
    if (compId) {
      if (!compMap[compId]) compMap[compId] = []
      compMap[compId].push(slide.objectId!)
    }
  }

  // Step 3: Assign one real pageId to each plan slide; track what needs duplication
  const planPageIds: string[] = []
  const compUsage: Record<string, number> = {}
  const toDuplicate: Array<{ sourceId: string; planIndex: number }> = []

  for (let i = 0; i < plan.slides.length; i++) {
    const compId = plan.slides[i].composition
    const available = compMap[compId] ?? []
    const useIdx = compUsage[compId] ?? 0
    compUsage[compId] = useIdx + 1

    if (available[useIdx]) {
      planPageIds.push(available[useIdx])
    } else if (available[0]) {
      toDuplicate.push({ sourceId: available[0], planIndex: i })
      planPageIds.push(`__dup_${i}`)
    } else {
      planPageIds.push('')
    }
  }

  // Step 4: Duplicate slides that need it
  if (toDuplicate.length > 0) {
    const dupRes = await slidesApi.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: toDuplicate.map(({ sourceId }) => ({
          duplicateObject: { objectId: sourceId },
        })),
      },
    })
    const newIds = (dupRes.data.replies ?? []).map(
      (r) => r.duplicateObject?.objectId ?? '',
    )
    for (let i = 0; i < toDuplicate.length; i++) {
      planPageIds[toDuplicate[i].planIndex] = newIds[i]
    }
  }

  // Step 5: Build batchUpdate — delete unused slides + replace tokens
  const updatedPres = await slidesApi.presentations.get({ presentationId })
  const updatedSlides = updatedPres.data.slides ?? []

  const keepSet = new Set(planPageIds.filter(Boolean))

  const requests: object[] = []

  // Delete slides not needed by the plan
  for (const slide of updatedSlides) {
    if (!keepSet.has(slide.objectId!)) {
      requests.push({ deleteObject: { objectId: slide.objectId } })
    }
  }

  // Token replacement per slide (scoped to its pageObjectId)
  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const slideSlots = plan.slides[i].slots
    const compId = plan.slides[i].composition

    // Replace filled slots
    for (const [slotName, slotValue] of Object.entries(slideSlots)) {
      if (!slotValue || slotName.startsWith('ЗОБРАЖЕННЯ')) continue
      requests.push({
        replaceAllText: {
          containsText: { text: `{{${slotName}}}`, matchCase: true },
          replaceText: slotValue,
          pageObjectIds: [pageId],
        },
      })
    }

    // Clear any tokens the LLM didn't fill — avoids visible {{PLACEHOLDER}} in output
    const comp = getComposition(compId)
    if (comp) {
      for (const slot of comp.slots) {
        if (slot.type !== 'text') continue
        const hasValue = !!slideSlots[slot.name]
        if (!hasValue) {
          requests.push({
            replaceAllText: {
              containsText: { text: `{{${slot.name}}}`, matchCase: true },
              replaceText: '',
              pageObjectIds: [pageId],
            },
          })
        }
      }
    }
  }

  // Font-size auto-shrink + colon-split colouring.
  // Runs AFTER replaceAllText — object IDs stay valid, text is already real content.
  const _WHITE = { red: 1, green: 1, blue: 1 }
  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const compId = plan.slides[i].composition
    const slots  = plan.slides[i].slots
    const pt     = pickBentoPt(compId, slots)
    if (pt === null) continue

    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue

    const bentoTokens = BENTO_TOKENS[compId] ?? []
    for (const el of slide.pageElements ?? []) {
      if (!el.objectId) continue
      const elText = (el.shape?.text?.textElements ?? [])
        .map(te => te.textRun?.content ?? '').join('')

      const matchedToken = bentoTokens.find(t => elText.includes(`{{${t}}}`))
      if (!matchedToken) continue

      // 1. Font size (applied to all text in the box)
      requests.push({
        updateTextStyle: {
          objectId: el.objectId,
          style: { fontSize: { magnitude: pt, unit: 'PT' }, bold: false },
          fields: 'fontSize,bold',
          textRange: { type: 'ALL' },
        },
      })

      // 2. Colon-split: everything up to and including ":" → WHITE
      const slotValue = slots[matchedToken] ?? ''
      const colonIdx  = slotValue.indexOf(':')
      if (colonIdx >= 0) {
        requests.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { foregroundColor: { opaqueColor: { rgbColor: _WHITE } } },
            fields: 'foregroundColor',
            textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: colonIdx + 1 },
          },
        })
      }
    }
  }

  // General colon-split for all non-title, non-bento text slots.
  // Rule: prefix up to and including ':' → WHITE (same rule as bento above).
  for (let i = 0; i < plan.slides.length; i++) {
    const pageId = planPageIds[i]
    if (!pageId) continue
    const compId = plan.slides[i].composition
    const slots  = plan.slides[i].slots
    const comp   = getComposition(compId)
    if (!comp) continue

    const slide = updatedSlides.find(s => s.objectId === pageId)
    if (!slide) continue

    for (const slot of comp.slots) {
      if (slot.type !== 'text') continue
      if (slot.name === 'ЗАГОЛОВОК') continue
      if (BENTO_TOKENS[compId]?.includes(slot.name)) continue  // already handled above

      const slotValue = slots[slot.name] ?? ''
      const colonIdx  = slotValue.indexOf(':')
      if (colonIdx < 0) continue

      for (const el of slide.pageElements ?? []) {
        if (!el.objectId) continue
        const elText = (el.shape?.text?.textElements ?? [])
          .map(te => te.textRun?.content ?? '').join('')
        if (!elText.includes(`{{${slot.name}}}`)) continue

        requests.push({
          updateTextStyle: {
            objectId: el.objectId,
            style: { foregroundColor: { opaqueColor: { rgbColor: _WHITE } } },
            fields: 'foregroundColor',
            textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: colonIdx + 1 },
          },
        })
      }
    }
  }

  if (requests.length > 0) {
    await slidesApi.presentations.batchUpdate({
      presentationId,
      requestBody: { requests },
    })
  }

  // Step 6: Reorder slides to match plan order
  const desiredOrder = planPageIds.filter(Boolean)
  if (desiredOrder.length > 1) {
    const moveRequests = desiredOrder.map((slideId, idx) => ({
      updateSlidesPosition: {
        slideObjectIds: [slideId],
        insertionIndex: idx,
      },
    }))
    await slidesApi.presentations.batchUpdate({
      presentationId,
      requestBody: { requests: moveRequests },
    })
  }

  return `https://docs.google.com/presentation/d/${presentationId}/edit`
}
