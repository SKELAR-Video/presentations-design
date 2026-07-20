import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { buildPresentation } from '@/lib/google'
import type { SlidePlan } from '@/lib/types'

export const maxDuration = 300

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accessToken = session.accessToken
  if (!accessToken) return NextResponse.json({ error: 'No Google access token' }, { status: 401 })

  const body = await req.json() as { plan: SlidePlan; title: string }

  if (!body.plan?.slides?.length) {
    return NextResponse.json({ error: 'План слайдів порожній' }, { status: 400 })
  }

  // Guard: encoding-agnostic fix for LLM slot-naming errors.
  // Uses /_\d+$/ (ASCII underscore+digits only) — survives Cyrillic/Latin homoglyphs.
  const plan: SlidePlan = {
    ...body.plan,
    slides: body.plan.slides.map(slide => {
      let composition = slide.composition
      const slots: Record<string, string> = { ...slide.slots }

      // three_columns/three_columns_num: max 3 _N keys allowed
      if (composition === 'three_columns' || composition === 'three_columns_num') {
        const numericKeyCount = Object.keys(slots).filter(k => /_\d+$/.test(k)).length
        if (numericKeyCount > 3) {
          composition = composition === 'three_columns_num' ? 'four_columns_num' : 'four_columns'
        }
      }

      // bento_right_*: rename any _N key that isn't already the Cyrillic КАРТКА_N
      if (composition.startsWith('bento_right_')) {
        const numKeys = Object.keys(slots).filter(k => /_\d+$/.test(k) && slots[k])
        let renamed = false
        for (const k of numKeys) {
          const num = k.match(/_(\d+)$/)?.[1]
          if (!num) continue
          const correct = `КАРТКА_${num}`
          if (k !== correct) {
            slots[correct] = slots[k]
            delete slots[k]
            renamed = true
          }
        }
        if (renamed) {
          const n = Object.keys(slots).filter(k => /_\d+$/.test(k) && slots[k]).length
          composition = n >= 4 ? 'bento_right_2x2' : n === 2 ? 'bento_right_2' : 'bento_right_3'
        }
      }

      return { ...slide, composition, slots }
    }),
  }
  const title = body.title

  // Snapshot slide compositions and slot key counts AFTER guard — for debugging.
  const _planSnapshot = plan.slides.map((s, i) => ({
    n: i + 1,
    comp: s.composition,
    slotKeys: Object.keys(s.slots),
    nonEmpty: Object.values(s.slots).filter(v => v && v.trim()).length,
  }))

  try {
    const { url, presentationId, validation, deckFacts } = await buildPresentation(accessToken, plan, title || 'SKELAR Presentation')
    return NextResponse.json({ url, presentationId, validation, deckFacts, _planSnapshot })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[generate] error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
