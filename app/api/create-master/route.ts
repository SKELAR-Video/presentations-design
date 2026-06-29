import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { google } from 'googleapis'
import { PHASE0_COMPOSITIONS } from '@/lib/compositions'

function getOAuth2Client(accessToken: string) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  oauth2.setCredentials({ access_token: accessToken })
  return oauth2
}

// ─── Coordinate system ──────────────────────────────────────────────────────
// Google Slides = 9 144 000 × 5 143 500 EMU. Figma reference = 1920 × 1080 px.
// 1 Figma px = 9 144 000 / 1920 = 4 762.5 EMU
const FPX = 9144000 / 1920

const W      = 1920
const H      = 1080
const PAD    =  100   // dead zone all sides, px
const UW     = W - 2 * PAD   // 1720 usable width
const GAP    =   30   // gap between bento cards
const INN    =   30   // inner padding inside cards
const TH     =  100   // title row height
const TG     =  100   // title → cards gap (min free space above bento)
const CY     = PAD + TH + TG   // 300 cards top y
const CH     = H - PAD - CY    // 680 cards height

// Right-bento layout constants (bento column fills full height PAD→PAD)
const RBW      = 860              // right bento column width
const RBH      = H - 2 * PAD     // 880 right bento column height
const LTW      = UW - RBW - GAP  // 830 left text zone width
const RBX      = PAD + LTW + GAP  // 960 right bento x-start (PAD + LTW + GAP)
const LOGO_H   =  90              // logo height, px
const LOGO_GAP =  20              // visual gap between ТЕКСТ bottom and logo top
// ТЕКСТ height in bento_right: leaves space at bottom for logo (RBH-260-GAP-LOGO_H-LOGO_GAP = 480)
const RTEXT_H  = RBH - 260 - GAP - LOGO_H - LOGO_GAP  // 480

// ─── Palette ────────────────────────────────────────────────────────────────
type RGB = { red: number; green: number; blue: number }
const DARK:  RGB = { red: 9/255,   green: 13/255,  blue: 23/255  } // #090D17
const CARD:  RGB = { red: 26/255,  green: 31/255,  blue: 46/255  } // #1A1F2E
const RED:   RGB = { red: 253/255, green: 52/255,  blue: 51/255  } // #FD3433
const WHITE: RGB = { red: 1,       green: 1,        blue: 1       }
const MUTED: RGB = { red: 162/255, green: 166/255, blue: 177/255 } // #A2A6B1
const PINK:  RGB = { red: 252/255, green: 202/255, blue: 202/255 } // #FCCACA
const rgb = (c: RGB) => ({ rgbColor: c })

// ─── Helpers ────────────────────────────────────────────────────────────────
const e = (px: number) => Math.round(px * FPX)

function elProps(slideId: string, x: number, y: number, w: number, h: number) {
  return {
    pageObjectId: slideId,
    size: {
      width:  { magnitude: e(w), unit: 'EMU' },
      height: { magnitude: e(h), unit: 'EMU' },
    },
    transform: {
      scaleX: 1, shearX: 0, translateX: e(x),
      shearY: 0, scaleY: 1, translateY: e(y),
      unit: 'EMU',
    },
  }
}

function shapeProps(objectId: string, fill: RGB): object[] {
  return [{ updateShapeProperties: {
    objectId,
    shapeProperties: {
      shapeBackgroundFill: { solidFill: { color: rgb(fill) } },
      outline: { propertyState: 'NOT_RENDERED' },
    },
    fields: 'shapeBackgroundFill,outline',
  } }]
}

// Text box — Inter Medium 500, left+top, 0.9 line spacing
function tb(
  id: string, slideId: string, token: string,
  x: number, y: number, w: number, h: number,
  pt: number, color: RGB = WHITE,
): object[] {
  return [
    { createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: elProps(slideId, x, y, w, h) } },
    { insertText: { objectId: id, insertionIndex: 0, text: `{{${token}}}` } },
    { updateTextStyle: {
        objectId: id,
        style: {
          weightedFontFamily: { fontFamily: 'Inter', weight: 500 },
          foregroundColor: { opaqueColor: rgb(color) },
          fontSize: { magnitude: pt, unit: 'PT' },
          bold: false,
        },
        fields: 'weightedFontFamily,foregroundColor,fontSize,bold',
        textRange: { type: 'ALL' },
    } },
    { updateParagraphStyle: {
        objectId: id,
        style: {
          lineSpacing: 90,
          alignment: 'START',
          spaceAbove: { magnitude: 0, unit: 'PT' },
          spaceBelow: { magnitude: 0, unit: 'PT' },
        },
        fields: 'lineSpacing,alignment,spaceAbove,spaceBelow',
        textRange: { type: 'ALL' },
    } },
    { updateShapeProperties: {
        objectId: id,
        shapeProperties: {
          contentAlignment: 'TOP',
          autofit: { autofitType: 'NONE' },
        },
        fields: 'contentAlignment,autofit.autofitType',
    } },
  ]
}

// ─── Layouts ────────────────────────────────────────────────────────────────
const R = 30  // fixed corner radius in Figma px

function buildLayout(compId: string, slideId: string, bgColor: RGB, idx: number): object[] {
  const out: object[] = []
  let n = 0
  // idx (slide position) guarantees unique IDs across all slides in the presentation.
  // Minimum length 5 required by Google Slides API — prefix "sh_" keeps it safe.
  const mk = (p = 'sh') => `${p}_${idx}_${n++}`
  const push = (...items: object[][]) => items.forEach(arr => out.push(...arr))

  // Simulated rounded corners: RECTANGLE + 4 × (bg-coloured square + card-coloured ellipse).
  // ROUND_RECTANGLE in Google Slides API cannot have a fixed radius — it always scales
  // proportionally with the shape size, giving different corners on different-width cards.
  // This simulation produces a fixed R-px radius on every card regardless of dimensions.
  function roundedCard(x: number, y: number, w: number, h: number) {
    const mainId = mk('b')
    push(
      [{ createShape: { objectId: mainId, shapeType: 'RECTANGLE', elementProperties: elProps(slideId, x, y, w, h) } }],
      shapeProps(mainId, CARD),
    )
    // Each corner: bg square covers the sharp corner, ellipse restores the arc
    const corners = [
      { bx: x,       by: y,       ex: x,         ey: y         },  // top-left
      { bx: x+w-R,   by: y,       ex: x+w-2*R,   ey: y         },  // top-right
      { bx: x,       by: y+h-R,   ex: x,         ey: y+h-2*R   },  // bottom-left
      { bx: x+w-R,   by: y+h-R,   ex: x+w-2*R,   ey: y+h-2*R   },  // bottom-right
    ]
    for (const { bx, by, ex, ey } of corners) {
      const sqId = mk('q')
      const elId = mk('f')
      push(
        [{ createShape: { objectId: sqId, shapeType: 'RECTANGLE', elementProperties: elProps(slideId, bx, by, R, R) } }],
        shapeProps(sqId, bgColor),
        [{ createShape: { objectId: elId, shapeType: 'ELLIPSE', elementProperties: elProps(slideId, ex, ey, 2*R, 2*R) } }],
        shapeProps(elId, CARD),
      )
    }
  }

  switch (compId) {

    case 'cover': {
      push(
        tb(mk(), slideId, 'ЗАГОЛОВОК', PAD, PAD, UW, 320, 44),
        tb(mk(), slideId, 'ДАТА', PAD, H - PAD - 52, 500, 52, 18, MUTED),
      )
      break
    }

    case 'title_body': {
      push(
        tb(mk(), slideId, 'ЗАГОЛОВОК', PAD, PAD, UW, TH, 36),
        tb(mk(), slideId, 'ТЕКСТ',     PAD, CY,  UW, CH - 60, 22, MUTED),
        tb(mk(), slideId, 'ПІДПИС',    PAD, H - PAD - 52, UW, 52, 14, MUTED),
      )
      break
    }

    case 'two_columns': {
      const cw = Math.floor((UW - GAP) / 2)
      push(tb(mk(), slideId, 'ЗАГОЛОВОК', PAD, PAD, UW, TH, 32))
      for (let k = 0; k < 2; k++) {
        const cx = PAD + k * (cw + GAP)
        roundedCard(cx, CY, cw, CH)
        push(tb(mk(), slideId, `КОЛОНКА_${k + 1}`, cx + INN, CY + INN, cw - 2 * INN, CH - 2 * INN, 18, MUTED))
      }
      break
    }

    case 'three_columns': {
      const cw = Math.floor((UW - 2 * GAP) / 3)
      push(tb(mk(), slideId, 'ЗАГОЛОВОК', PAD, PAD, UW, TH, 28))
      for (let k = 0; k < 3; k++) {
        const cx = PAD + k * (cw + GAP)
        roundedCard(cx, CY, cw, CH)
        push(tb(mk(), slideId, `КОЛОНКА_${k + 1}`, cx + INN, CY + INN, cw - 2 * INN, CH - 2 * INN, 18, MUTED))
      }
      break
    }

    case 'kpi_cards': {
      const subH  = 56
      const kCY   = PAD + TH + subH + TG
      const kCH   = H - PAD - kCY
      const kw    = Math.floor((UW - 3 * GAP) / 4)
      const inner = kCH - 2 * INN          // content zone height (INN top + bottom)
      const valH  = Math.round(inner * 0.55)
      const lblH  = inner - valH
      push(
        tb(mk(), slideId, 'ЗАГОЛОВОК', PAD, PAD, UW, TH, 32),
        tb(mk(), slideId, 'ТЕКСТ',     PAD, PAD + TH, UW, subH, 18, MUTED),
      )
      for (let k = 0; k < 4; k++) {
        const cx = PAD + k * (kw + GAP)
        roundedCard(cx, kCY, kw, kCH)
        push(
          tb(mk(), slideId, `КАРТКА_${k + 1}_ЗНАЧЕННЯ`, cx + INN, kCY + INN,          kw - 2 * INN, valH, 48),
          tb(mk(), slideId, `КАРТКА_${k + 1}_ПІДПИС`,   cx + INN, kCY + INN + valH,   kw - 2 * INN, lblH, 14, MUTED),
        )
      }
      break
    }

    case 'section': {
      push(
        tb(mk(), slideId, 'ЗАГОЛОВОК',    PAD, PAD, UW, 260, 44),
        tb(mk(), slideId, 'ПІДЗАГОЛОВОК', PAD, PAD + 260 + GAP, UW, 160, 22, MUTED),
      )
      break
    }

    case 'section_red': {
      push(
        tb(mk(), slideId, 'ЗАГОЛОВОК',    PAD, PAD, UW, 260, 44),
        tb(mk(), slideId, 'ПІДЗАГОЛОВОК', PAD, PAD + 260 + GAP, UW, 160, 22, PINK),
      )
      break
    }

    case 'closing': {
      push(tb(mk(), slideId, 'ЗАГОЛОВОК', PAD, PAD, UW, 320, 44))
      break
    }

    // ── Right Bento layouts ─────────────────────────────────────────────────
    // Left zone: title (top) + body text (below). Right zone: bento cards.
    // Bento column: x=RBX(960), y=PAD(100), w=RBW(860), h=RBH(880)

    case 'bento_right_2': {
      const cardH = Math.floor((RBH - GAP) / 2)       // 425
      push(
        tb(mk(), slideId, 'ЗАГОЛОВОК', PAD, PAD, LTW, 260, 44),
        tb(mk(), slideId, 'ТЕКСТ', PAD, PAD + 260 + GAP, LTW, RTEXT_H, 22, MUTED),
      )
      for (let k = 0; k < 2; k++) {
        const cy = PAD + k * (cardH + GAP)
        roundedCard(RBX, cy, RBW, cardH)
        push(tb(mk(), slideId, `КАРТКА_${k + 1}`, RBX + INN, cy + INN, RBW - 2 * INN, cardH - 2 * INN, 18, MUTED))
      }
      break
    }

    case 'bento_right_3': {
      const cardH = Math.floor((RBH - 2 * GAP) / 3)   // 273
      push(
        tb(mk(), slideId, 'ЗАГОЛОВОК', PAD, PAD, LTW, 260, 44),
        tb(mk(), slideId, 'ТЕКСТ', PAD, PAD + 260 + GAP, LTW, RTEXT_H, 22, MUTED),
      )
      for (let k = 0; k < 3; k++) {
        const cy = PAD + k * (cardH + GAP)
        const h  = k === 2 ? RBH - 2 * (cardH + GAP) : cardH   // last fills remaining
        roundedCard(RBX, cy, RBW, h)
        push(tb(mk(), slideId, `КАРТКА_${k + 1}`, RBX + INN, cy + INN, RBW - 2 * INN, h - 2 * INN, 18, MUTED))
      }
      break
    }

    case 'bento_right_2x2': {
      const cellW = Math.floor((RBW - GAP) / 2)        // 415
      const cellH = Math.floor((RBH - GAP) / 2)        // 425
      push(
        tb(mk(), slideId, 'ЗАГОЛОВОК', PAD, PAD, LTW, 260, 44),
        tb(mk(), slideId, 'ТЕКСТ', PAD, PAD + 260 + GAP, LTW, RTEXT_H, 22, MUTED),
      )
      let k = 0
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) {
          const cx = RBX + col * (cellW + GAP)
          const cy = PAD + row * (cellH + GAP)
          roundedCard(cx, cy, cellW, cellH)
          push(tb(mk(), slideId, `КАРТКА_${k + 1}`, cx + INN, cy + INN, cellW - 2 * INN, cellH - 2 * INN, 18, MUTED))
          k++
        }
      }
      break
    }
  }

  return out
}

// ─── Handler ────────────────────────────────────────────────────────────────
export async function POST() {
  const session = await auth()
  if (!session?.accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const auth2     = getOAuth2Client(session.accessToken)
    const slidesApi = google.slides({ version: 'v1', auth: auth2 })
    const comps     = PHASE0_COMPOSITIONS

    const { data: created } = await slidesApi.presentations.create({
      requestBody: { title: 'SKELAR Template Deck — Phase 0' },
    })
    const presentationId = created.presentationId!

    if (comps.length > 1) {
      await slidesApi.presentations.batchUpdate({
        presentationId,
        requestBody: {
          requests: comps.slice(1).map((c, i) => ({
            createSlide: { objectId: `sl_${c.id}`, insertionIndex: i + 1 },
          })),
        },
      })
    }

    const { data: full } = await slidesApi.presentations.get({ presentationId })
    const slides = full.slides ?? []
    const reqs: object[] = []

    for (let i = 0; i < comps.length && i < slides.length; i++) {
      const comp    = comps[i]
      const slide   = slides[i]
      const slideId = slide.objectId!
      const bg      = comp.id === 'section_red' ? RED : DARK

      reqs.push({
        updatePageProperties: {
          objectId: slideId,
          pageProperties: { pageBackgroundFill: { solidFill: { color: rgb(bg) } } },
          fields: 'pageBackgroundFill',
        },
      })

      for (const el of slide.pageElements ?? []) {
        reqs.push({ deleteObject: { objectId: el.objectId } })
      }

      const notesBox = slide.slideProperties?.notesPage?.pageElements?.find(
        el => el.shape?.placeholder?.type === 'BODY' || el.shape?.shapeType === 'TEXT_BOX',
      )
      if (notesBox?.objectId) {
        const existing = notesBox.shape?.text?.textElements
          ?.map(te => te.textRun?.content ?? '').join('') ?? ''
        if (existing.trim()) {
          reqs.push({ deleteText: { objectId: notesBox.objectId, textRange: { type: 'ALL' } } })
        }
        reqs.push({ insertText: { objectId: notesBox.objectId, insertionIndex: 0, text: `composition:${comp.id}` } })
      }

      reqs.push(...buildLayout(comp.id, slideId, bg, i))
    }

    await slidesApi.presentations.batchUpdate({ presentationId, requestBody: { requests: reqs } })

    return NextResponse.json({
      presentationId,
      url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[create-master]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
