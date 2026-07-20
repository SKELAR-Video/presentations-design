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

  // Guard: fix LLM slot naming errors. Pattern-based — independent of compositions.ts.
  const plan: SlidePlan = {
    ...body.plan,
    slides: body.plan.slides.map(slide => {
      let composition = slide.composition
      const slots: Record<string, string> = { ...slide.slots }

      // three_columns / three_columns_num: КОЛОНКА_4 means 4 items → columns_flex
      if (
        (composition === 'three_columns' || composition === 'three_columns_num') &&
        slots['КОЛОНКА_4']
      ) {
        console.warn(`[guard] ${composition} has КОЛОНКА_4 → columns_flex`)
        composition = 'columns_flex'
      }

      // bento_right_*: slots must be КАРТКА_N, not КОЛОНКА_N — rename any КОЛОНКА_N found
      if (composition.startsWith('bento_right_')) {
        const colKeys = Object.keys(slots).filter(k => /^КОЛОНКА_\d+$/.test(k) && slots[k])
        if (colKeys.length > 0) {
          for (const k of colKeys) {
            const num = k.replace(/\D/g, '')
            slots[`КАРТКА_${num}`] = slots[k]
            delete slots[k]
          }
          const n = Object.keys(slots).filter(k => k.startsWith('КАРТКА_')).length
          composition = n >= 4 ? 'bento_right_2x2' : n === 2 ? 'bento_right_2' : 'bento_right_3'
          console.warn(`[guard] bento: renamed ${colKeys.length} КОЛОНКА→КАРТКА, ${n} cards → ${composition}`)
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
