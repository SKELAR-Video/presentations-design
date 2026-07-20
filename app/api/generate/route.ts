import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { buildPresentation } from '@/lib/google'
import { getComposition } from '@/lib/compositions'
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

  // Fix common LLM slot errors: find slots not in composition definition and recover.
  const plan: SlidePlan = {
    ...body.plan,
    slides: body.plan.slides.map(slide => {
      let composition = slide.composition
      const slots: Record<string, string> = { ...slide.slots }

      const compDef = getComposition(composition)
      const knownSlots = new Set(compDef?.slots.map(s => s.name) ?? [])
      const extraKeys = Object.keys(slots).filter(k => !knownSlots.has(k) && slots[k])

      if (extraKeys.length > 0) {
        console.warn(`[route-guard] slide "${slide.id}" (${composition}): extra slots ${JSON.stringify(extraKeys)}`)

        // three_columns / three_columns_num with overflow columns → columns_flex
        if (composition === 'three_columns' || composition === 'three_columns_num') {
          composition = 'columns_flex'
          console.warn(`[route-guard] → upgraded to columns_flex`)
        }

        // bento_right_N with КОЛОНКА instead of КАРТКА → rename + pick variant
        if (composition.startsWith('bento_right_')) {
          const allKeys = Object.keys(slots)
          const colKeys = allKeys.filter(k => !knownSlots.has(k) && slots[k])
          for (const k of colKeys) {
            const num = k.replace(/\D/g, '')
            if (num) { slots[`КАРТКА_${num}`] = slots[k]; delete slots[k] }
          }
          const n = Object.keys(slots).filter(k => k.startsWith('КАРТКА_')).length
          composition = n >= 4 ? 'bento_right_2x2' : n === 2 ? 'bento_right_2' : 'bento_right_3'
          console.warn(`[route-guard] → bento renamed, ${n} cards → ${composition}`)
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
