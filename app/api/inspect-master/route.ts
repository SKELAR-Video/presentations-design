import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { google } from 'googleapis'
import type { slides_v1 } from 'googleapis'

// 1 Figma px = FPX EMU  (9 144 000 EMU / 1920 px)
const FPX = 9144000 / 1920

// Rendered bounding box: size × scale (Google Slides stores intrinsic size + AffineTransform scale)
function toFpx(emu: number | null | undefined): number {
  return Math.round((emu ?? 0) / FPX)
}
function renderedPx(magnitude: number | null | undefined, scale: number | null | undefined): number {
  return toFpx((magnitude ?? 0) * (scale ?? 1))
}

function getOAuth2Client(accessToken: string) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  oauth2.setCredentials({ access_token: accessToken })
  return oauth2
}

function getSlideComposition(slide: slides_v1.Schema$Page): string {
  const notes = (slide.slideProperties?.notesPage?.pageElements ?? [])
    .map(el => (el.shape?.text?.textElements ?? []).map(te => te.textRun?.content ?? '').join(''))
    .join('')
  const m = notes.match(/composition:(\w+)/)
  return m?.[1] ?? 'unknown'
}

function getTokenFromElement(el: slides_v1.Schema$PageElement): string {
  const raw = (el.shape?.text?.textElements ?? [])
    .map(te => te.textRun?.content ?? '')
    .join('')
  const m = raw.match(/\{\{([^}]+)\}\}/)
  return m?.[1] ?? '(no token)'
}

type BoxInfo = {
  objectId: string
  token: string
  autofitType: string
  contentAlignment: string
  // Rendered Figma-px dimensions (size.magnitude × transform.scale)
  x: number
  y: number
  w: number
  h: number
  bottom: number
  // Raw values from API for debugging
  _raw: {
    sizeW_emu: number
    sizeH_emu: number
    sizeW_unit: string
    sizeH_unit: string
    scaleX: number
    scaleY: number
    translateX_emu: number
    translateY_emu: number
  }
}

export async function GET() {
  const session = await auth()
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const masterDeckId = process.env.MASTER_DECK_ID
  if (!masterDeckId) {
    return NextResponse.json({ error: 'MASTER_DECK_ID not set in environment' }, { status: 500 })
  }

  const auth2 = getOAuth2Client(session.accessToken)
  const slidesApi = google.slides({ version: 'v1', auth: auth2 })

  // ── Step 1: Read master deck ──────────────────────────────────────────────
  const pres = await slidesApi.presentations.get({ presentationId: masterDeckId })
  const slides = pres.data.slides ?? []

  const report: Record<string, BoxInfo[]> = {}
  const toFix: Array<{ objectId: string; compId: string; token: string; wasType: string }> = []

  for (const slide of slides) {
    const compId = getSlideComposition(slide)
    if (!report[compId]) report[compId] = []

    for (const el of slide.pageElements ?? []) {
      if (el.shape?.shapeType !== 'TEXT_BOX') continue
      if (!el.objectId || !el.size || !el.transform) continue

      const autofitType = el.shape?.shapeProperties?.autofit?.autofitType ?? 'AUTOFIT_TYPE_UNSPECIFIED'
      const contentAlignment = el.shape?.shapeProperties?.contentAlignment ?? 'CONTENT_ALIGNMENT_UNSPECIFIED'
      const token = getTokenFromElement(el)

      const sW   = el.size.width?.magnitude ?? 0
      const sH   = el.size.height?.magnitude ?? 0
      const sxS  = el.transform.scaleX ?? 1
      const sxY  = el.transform.scaleY ?? 1
      const txX  = el.transform.translateX ?? 0
      const txY  = el.transform.translateY ?? 0

      // Rendered pixel values (the actual visible bounds)
      const x = toFpx(txX)
      const y = toFpx(txY)
      const w = renderedPx(sW, sxS)
      const h = renderedPx(sH, sxY)

      const info: BoxInfo = {
        objectId: el.objectId,
        token,
        autofitType,
        contentAlignment,
        x, y, w, h,
        bottom: y + h,
        _raw: {
          sizeW_emu: sW,
          sizeH_emu: sH,
          sizeW_unit: el.size.width?.unit ?? '?',
          sizeH_unit: el.size.height?.unit ?? '?',
          scaleX: sxS,
          scaleY: sxY,
          translateX_emu: txX,
          translateY_emu: txY,
        },
      }
      report[compId].push(info)

      if (autofitType !== 'NONE') {
        toFix.push({ objectId: el.objectId, compId, token, wasType: autofitType })
      }
    }
  }

  // ── Step 2: kpi_cards overlap analysis (uses rendered dimensions) ─────────
  const kpiBoxes = report['kpi_cards'] ?? []
  const kpiBody  = kpiBoxes.find(b => b.token === 'ТЕКСТ')
  const kpiCard1 = kpiBoxes.find(b => b.token === 'КАРТКА_1_ЗНАЧЕННЯ')

  let kpiOverlap: Record<string, unknown> = { note: 'kpi_cards not found in deck' }
  if (kpiBody && kpiCard1) {
    const gap = kpiCard1.y - kpiBody.bottom
    kpiOverlap = {
      ТЕКСТ:    { y: kpiBody.y,  h: kpiBody.h,  bottom: kpiBody.bottom },
      CARDS_top: kpiCard1.y,
      gap_px:    gap,
      overlapping: gap < 0,
      verdict:   gap < 0
        ? `⚠️ OVERLAP — boxes intersect by ${Math.abs(gap)}px`
        : `✅ gap = ${gap}px`,
    }
  }

  // ── Step 3: Patch autofitType = NONE where needed ────────────────────────
  let patchResult: Record<string, unknown>
  if (toFix.length > 0) {
    await slidesApi.presentations.batchUpdate({
      presentationId: masterDeckId,
      requestBody: {
        requests: toFix.map(({ objectId }) => ({
          updateShapeProperties: {
            objectId,
            shapeProperties: { autofit: { autofitType: 'NONE' } },
            fields: 'autofit.autofitType',
          },
        })),
      },
    })
    patchResult = {
      patched: toFix.length,
      changes: toFix.map(f => ({ composition: f.compId, token: f.token, was: f.wasType, now: 'NONE' })),
    }
  } else {
    patchResult = { patched: 0, note: 'all text boxes already had autofitType = NONE' }
  }

  // ── Response ─────────────────────────────────────────────────────────────
  return NextResponse.json({
    masterDeckId,
    slidesInDeck: slides.length,
    kpiOverlapCheck: kpiOverlap,
    patch: patchResult,
    report,
  })
}
