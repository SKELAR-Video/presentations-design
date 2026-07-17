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

  // Fix common LLM slot errors before passing to buildPresentation or validator.
  const plan: SlidePlan = {
    ...body.plan,
    slides: body.plan.slides.map(slide => {
      let composition = slide.composition
      const slots: Record<string, string> = { ...slide.slots }
      if ((composition === 'three_columns' || composition === 'three_columns_num') && slots['КОЛОНКА_4']) {
        composition = 'columns_flex'
        console.warn(`[route-guard] slide "${slide.id}": ${slide.composition} + КОЛОНКА_4 → columns_flex`)
      }
      if (composition.startsWith('bento_right_') && slots['КОЛОНКА_1'] !== undefined) {
        const n = [1,2,3,4].filter(k => slots[`КОЛОНКА_${k}`] !== undefined).length
        for (let k = 1; k <= 4; k++) {
          if (slots[`КОЛОНКА_${k}`] !== undefined) { slots[`КАРТКА_${k}`] = slots[`КОЛОНКА_${k}`]; delete slots[`КОЛОНКА_${k}`] }
        }
        composition = n === 4 ? 'bento_right_2x2' : n === 2 ? 'bento_right_2' : 'bento_right_3'
        console.warn(`[route-guard] slide "${slide.id}": bento КОЛОНКА→КАРТКА, ${n} items → ${composition}`)
      }
      return { ...slide, composition, slots }
    }),
  }
  const title = body.title

  try {
    const { url, presentationId, validation, deckFacts } = await buildPresentation(accessToken, plan, title || 'SKELAR Presentation')
    return NextResponse.json({ url, presentationId, validation, deckFacts })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[generate] error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
