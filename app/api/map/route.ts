import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { mapToPlan, mapSlides1to1 } from '@/lib/anthropic'
import type { Theme } from '@/lib/types'
import type { SourceSlide } from '@/app/api/fetch-doc/route'

export const maxDuration = 300

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    text?: string
    theme: Theme
    mode?: '1to1'
    slides?: SourceSlide[]
  }

  const theme = body.theme ?? 'dark'

  // Guard: fix LLM overflow errors before returning the plan.
  // Uses value-count (encoding-agnostic) for three_columns; key-pattern for bento.
  function fixPlanSlides<T extends { composition: string; slots: Record<string, string> }>(slides: T[]): T[] {
    return slides.map(slide => {
      let composition = slide.composition
      const slots: Record<string, string> = { ...slide.slots }

      // three_columns / three_columns_num allow max 4 slots (1 header + 3 columns).
      // If LLM stuffed 4 columns in, upgrade to columns_flex (supports 4).
      if (composition === 'three_columns' || composition === 'three_columns_num') {
        const nonEmpty = Object.values(slots).filter(v => v && v.trim()).length
        if (nonEmpty > 4) {
          console.warn(`[map-guard] ${composition} has ${nonEmpty} slots → columns_flex`)
          composition = 'columns_flex'
        }
      }

      // bento_right_* with wrong slot names (КОЛОНКА_N instead of КАРТКА_N):
      // rename any key whose digits can be extracted but isn't a known bento slot.
      if (composition.startsWith('bento_right_')) {
        const renamedKeys: Record<string, string> = {}
        let renamed = false
        for (const k of Object.keys(slots)) {
          const digits = k.replace(/\D/g, '')
          // If key has digits and equals something like КОЛОНКА_N (not КАРТКА_N):
          // We detect "wrong" keys by checking if the same key also has no КАРТКА_ equivalent.
          if (digits && !Object.prototype.hasOwnProperty.call(slots, `КАРТКА_${digits}`)) {
            renamedKeys[`КАРТКА_${digits}`] = slots[k]
            delete slots[k]
            renamed = true
          }
        }
        if (renamed) {
          Object.assign(slots, renamedKeys)
          const n = Object.keys(slots).filter(k => k.includes('_') && /\d/.test(k)).length
          const fixed = n >= 4 ? 'bento_right_2x2' : n === 2 ? 'bento_right_2' : 'bento_right_3'
          console.warn(`[map-guard] bento renamed → ${fixed} (${n} cards)`)
          composition = fixed
        }
      }

      return { ...slide, composition, slots }
    })
  }

  if (body.mode === '1to1' && body.slides?.length) {
    try {
      const rawPlan = await mapSlides1to1(body.slides, theme)
      const plan = { ...rawPlan, slides: fixPlanSlides(rawPlan.slides) }
      return NextResponse.json({ plan })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      console.error('[map/1to1] error:', message)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  if (!body.text?.trim()) {
    return NextResponse.json({ error: 'Текст ТЗ не може бути порожнім' }, { status: 400 })
  }

  try {
    const rawPlan = await mapToPlan(body.text.trim(), theme)
    const plan = { ...rawPlan, slides: fixPlanSlides(rawPlan.slides) }
    return NextResponse.json({ plan })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[map] error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
