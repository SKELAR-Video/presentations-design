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
