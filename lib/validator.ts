import type { slides_v1 } from 'googleapis'
import { getComposition } from './compositions'
import type { SlidePlan } from './types'

const _FPX   = 9144000 / 1920  // EMU per Figma px
const _SLIDE_W = 1920
const _SLIDE_H = 1080
const _BOUNDS_TOL = 4           // px — rounding slack

export type CheckResult = {
  check: string
  pass: boolean
  detail?: string
}

export type SlideValidation = {
  slideIndex: number
  composition: string
  checks: CheckResult[]
  pass: boolean
}

export type ValidationReport = {
  pass: boolean
  presentationId: string
  slides: SlideValidation[]
  summary: string
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function rPx(mag: number | null | undefined, scale: number | null | undefined): number {
  return ((mag ?? 0) * (scale ?? 1)) / _FPX
}

function elBounds(el: slides_v1.Schema$PageElement) {
  const t = el.transform!
  const s = el.size!
  const x = (t.translateX ?? 0) / _FPX
  const y = (t.translateY ?? 0) / _FPX
  const w = rPx(s.width?.magnitude, t.scaleX)
  const h = rPx(s.height?.magnitude, t.scaleY)
  return { x, y, w, h, right: x + w, bottom: y + h }
}

function elToken(el: slides_v1.Schema$PageElement): string | null {
  const raw = (el.shape?.text?.textElements ?? [])
    .map(te => te.textRun?.content ?? '').join('')
  return raw.match(/\{\{([^}]+)\}\}/)?.[1] ?? null
}

// ─── individual checks ────────────────────────────────────────────────────────

function checkBounds(slide: slides_v1.Schema$Page): CheckResult {
  const fails: string[] = []
  for (const el of slide.pageElements ?? []) {
    if (!el.transform || !el.size) continue
    const { x, y, right, bottom } = elBounds(el)
    if (
      x < -_BOUNDS_TOL || y < -_BOUNDS_TOL ||
      right > _SLIDE_W + _BOUNDS_TOL || bottom > _SLIDE_H + _BOUNDS_TOL
    ) {
      const tok = elToken(el) ?? el.objectId ?? '?'
      fails.push(`${tok} x=${Math.round(x)} y=${Math.round(y)} r=${Math.round(right)} b=${Math.round(bottom)}`)
    }
  }
  return { check: 'bounds', pass: fails.length === 0, detail: fails.join(' | ') || undefined }
}

function checkAutofit(slide: slides_v1.Schema$Page): CheckResult {
  const fails: string[] = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX') continue
    const aft = el.shape.shapeProperties?.autofit?.autofitType
    if (aft && aft !== 'NONE') {
      fails.push(`${elToken(el) ?? el.objectId}: ${aft}`)
    }
  }
  return { check: 'autofit_none', pass: fails.length === 0, detail: fails.join('; ') || undefined }
}

function checkFont(slide: slides_v1.Schema$Page): CheckResult {
  const fails: string[] = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX') continue
    const tok = elToken(el) ?? el.objectId ?? '?'
    for (const te of el.shape?.text?.textElements ?? []) {
      const style = te.textRun?.style
      if (!style) continue
      const family = style.weightedFontFamily?.fontFamily
      if (family && !family.toLowerCase().startsWith('inter')) {
        fails.push(`${tok}: font="${family}"`)
      }
      if (style.bold === true) {
        fails.push(`${tok}: bold=true`)
      }
    }
  }
  return { check: 'font_inter_medium', pass: fails.length === 0, detail: fails.slice(0, 5).join('; ') || undefined }
}

function checkMaxChars(slots: Record<string, string>, compId: string): CheckResult {
  const comp = getComposition(compId)
  if (!comp) return { check: 'max_chars', pass: true, detail: 'composition not found — skipped' }
  const fails: string[] = []
  for (const def of comp.slots) {
    if (def.type !== 'text' || !def.max_chars) continue
    const val = slots[def.name] ?? ''
    if (val.length > def.max_chars) {
      fails.push(`${def.name}: ${val.length}>${def.max_chars}`)
    }
  }
  return { check: 'max_chars', pass: fails.length === 0, detail: fails.join('; ') || undefined }
}

function checkBadge(slide: slides_v1.Schema$Page): CheckResult {
  const BADGE_X = 1730, BADGE_Y = 100, BADGE_TOL = 25
  for (const el of slide.pageElements ?? []) {
    if (!el.transform) continue
    const x = Math.round((el.transform.translateX ?? 0) / _FPX)
    const y = Math.round((el.transform.translateY ?? 0) / _FPX)
    if (Math.abs(x - BADGE_X) <= BADGE_TOL && Math.abs(y - BADGE_Y) <= BADGE_TOL) {
      return { check: 'skelar_badge', pass: true }
    }
  }
  return { check: 'skelar_badge', pass: false, detail: 'badge not found near (1730, 100)' }
}

// kpi_cards: КАРТКА_N_ЗНАЧЕННЯ must be numeric (digits / ± / % / math prefixes / units)
const KPI_NUMERIC_RE = /^[\d\s+\-±×x.,/%$€£<>≤≥~≈MKBmkb]+$/i

function checkKpiNumeric(slots: Record<string, string>): CheckResult {
  const fails: string[] = []
  for (let n = 1; n <= 4; n++) {
    const val = (slots[`КАРТКА_${n}_ЗНАЧЕННЯ`] ?? '').trim()
    if (!val) continue
    if (!KPI_NUMERIC_RE.test(val)) {
      fails.push(`КАРТКА_${n}_ЗНАЧЕННЯ: "${val.slice(0, 30)}"`)
    }
  }
  return { check: 'kpi_numeric_values', pass: fails.length === 0, detail: fails.join('; ') || undefined }
}

function checkKpiGap(slide: slides_v1.Schema$Page, gapMin: number): CheckResult {
  // After replaceAllText, tokens are gone. Identify elements by geometry:
  //   body (ТЕКСТ): TEXT_BOX with x≈PAD(100), w≈UW(1720), y in [150, 500]
  //   card text: TEXT_BOX with x>120, w<600, y>300 (card inner zone)
  let bodyBottom = -1
  let cardTop    = Infinity
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.transform || !el.size) continue
    const { x, y, w, bottom } = elBounds(el)
    if (Math.abs(x - 100) <= 20 && w > 1500 && y > 150 && y < 500) {
      bodyBottom = Math.max(bodyBottom, bottom)
    }
    if (x > 120 && w < 600 && y > 300) {
      cardTop = Math.min(cardTop, y)
    }
  }
  if (bodyBottom < 0 || cardTop === Infinity) {
    return { check: 'kpi_gap', pass: true, detail: 'layout elements not identifiable — skipped' }
  }
  const gap = Math.round(cardTop - bodyBottom)
  return {
    check: 'kpi_gap',
    pass: gap >= gapMin - _BOUNDS_TOL,
    detail: `gap=${gap}px (min=${gapMin})`,
  }
}

// kpi_cards: card row must span full content width (PAD→PAD+UW), fill to bottom,
// and maintain a comfortable gap from the title area.
function checkKpiCardRowGeometry(slide: slides_v1.Schema$Page): CheckResult {
  const PAD = 100, UW = 1720, H = 1080, TG = 100, TH = 100
  const TOL = 20

  // Card backgrounds: RECTANGLE, left-anchored (x≈PAD), wider than 350px, taller than 150px
  const cardBgs: { x: number; w: number; y: number; h: number }[] = []
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'RECTANGLE' || !el.transform || !el.size) continue
    const b = elBounds(el)
    if (b.x >= PAD - TOL && b.w > 350 && b.h > 150) {
      cardBgs.push({ x: Math.round(b.x), w: Math.round(b.w), y: Math.round(b.y), h: Math.round(b.h) })
    }
  }
  if (cardBgs.length === 0) {
    return { check: 'kpi_row_geometry', pass: true, detail: 'no card backgrounds — skipped' }
  }

  const fails: string[] = []

  // Row must span PAD → PAD+UW (left-to-right, no gaps at edges)
  const minX     = Math.min(...cardBgs.map(c => c.x))
  const maxRight = Math.max(...cardBgs.map(c => c.x + c.w))
  if (Math.abs(minX - PAD) > TOL) {
    fails.push(`left edge x=${minX} ≠ PAD(${PAD})`)
  }
  if (Math.abs(maxRight - (PAD + UW)) > TOL) {
    fails.push(`right edge x=${maxRight} ≠ PAD+UW(${PAD + UW})`)
  }

  // Cards must reach the bottom margin
  const maxBottom = Math.max(...cardBgs.map(c => c.y + c.h))
  if (maxBottom < H - PAD - TOL) {
    fails.push(`bottom=${maxBottom} < H-PAD(${H - PAD})`)
  }

  // Comfortable gap (TG) between title area and card row
  const cardTopY = Math.min(...cardBgs.map(c => c.y))
  if (cardTopY < PAD + TH + TG - TOL) {
    fails.push(`card top=${cardTopY} < PAD+TH+TG(${PAD + TH + TG})`)
  }

  return { check: 'kpi_row_geometry', pass: fails.length === 0, detail: fails.join('; ') || undefined }
}

// cover: ДАТА must be full-width (≈ UW) and NOT stuck in the bottom corner.
// Catches old-master decks where ДАТА was at y≈928, w=500.
function checkCoverLayout(slide: slides_v1.Schema$Page): CheckResult {
  const MIN_DATE_W = 1400  // ДАТА width must be close to UW (1720), not 500
  const MAX_DATE_Y = 800   // ДАТА must not be near the bottom of the slide

  let narrowOrLow = false
  for (const el of slide.pageElements ?? []) {
    if (el.shape?.shapeType !== 'TEXT_BOX' || !el.transform || !el.size) continue
    const x = Math.round((el.transform.translateX ?? 0) / _FPX)
    const y = Math.round((el.transform.translateY ?? 0) / _FPX)
    const w = Math.round((el.size.width?.magnitude ?? 0) * (el.transform.scaleX ?? 1) / _FPX)
    const h = Math.round((el.size.height?.magnitude ?? 0) * (el.transform.scaleY ?? 1) / _FPX)
    // Match ДАТА: left-anchored, below the title area (y > PAD+some gap), small height
    if (Math.abs(x - 100) < 20 && y > 150 && h < 150) {
      if (w < MIN_DATE_W || y > MAX_DATE_Y) {
        narrowOrLow = true
        break
      }
    }
  }

  return {
    check: 'cover_layout',
    pass: !narrowOrLow,
    detail: narrowOrLow
      ? `ДАТА box is narrow or in the bottom corner — regenerate from updated master`
      : undefined,
  }
}

function checkTheme(plan: SlidePlan): CheckResult {
  const themes = new Set(plan.slides.map(s => s.theme ?? plan.theme))
  const pass   = themes.size <= 1
  return {
    check: 'theme_consistency',
    pass,
    detail: pass ? undefined : `mixed themes: ${[...themes].join(', ')}`,
  }
}

// ─── main export ─────────────────────────────────────────────────────────────

export async function validateDeck(
  slidesApi: slides_v1.Slides,
  presentationId: string,
  plan: SlidePlan,
  planPageIds: string[],
): Promise<ValidationReport> {
  const pres      = await slidesApi.presentations.get({ presentationId })
  const allSlides = pres.data.slides ?? []
  const themeCheck = checkTheme(plan)
  const results: SlideValidation[] = []

  for (let i = 0; i < plan.slides.length; i++) {
    const pageId    = planPageIds[i]
    const planSlide = plan.slides[i]
    const compId    = planSlide.composition
    const slide     = allSlides.find(s => s.objectId === pageId)
    const checks: CheckResult[] = []

    if (!slide) {
      checks.push({ check: 'slide_found', pass: false, detail: `pageId ${pageId} missing` })
      results.push({ slideIndex: i, composition: compId, checks, pass: false })
      continue
    }

    checks.push(checkBounds(slide))
    checks.push(checkAutofit(slide))
    checks.push(checkFont(slide))
    checks.push(checkMaxChars(planSlide.slots, compId))
    checks.push(checkBadge(slide))

    if (compId === 'kpi_cards') {
      const comp = getComposition('kpi_cards')
      checks.push(checkKpiNumeric(planSlide.slots))
      checks.push(checkKpiGap(slide, comp?.gap_min ?? 30))
      checks.push(checkKpiCardRowGeometry(slide))
    }

    if (compId === 'cover') {
      checks.push(checkCoverLayout(slide))
    }

    // theme_consistency is deck-level; attach to slide 0
    if (i === 0) checks.push(themeCheck)

    const pass = checks.every(c => c.pass)
    results.push({ slideIndex: i, composition: compId, checks, pass })
  }

  const failCount = results.filter(r => !r.pass).length
  const pass      = failCount === 0
  const summary   = pass
    ? `✅ PASS — all ${results.length} slides valid`
    : `❌ FAIL — ${failCount}/${results.length} slides have issues`

  return { pass, presentationId, slides: results, summary }
}
