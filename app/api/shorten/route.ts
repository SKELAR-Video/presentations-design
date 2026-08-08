import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { shortenSlot } from '@/lib/anthropic'
import type { Slide } from '@/lib/types'

// Kept apart from /api/generate on purpose. Two calls, one job each: the person sees
// "скорочую" and then "перезбираю", and a failure names which of the two it was. Folding
// this into generate would also mean the model runs before every rebuild, including the
// ones where nothing is being shortened.
export const maxDuration = 300

type Target = { slideIndex: number; slot: string; cutPct: number }

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as { slides: Slide[]; targets: Target[] }
  if (!body.slides?.length) {
    return NextResponse.json({ error: 'План порожній' }, { status: 400 })
  }

  const slides = body.slides.map(s => ({ ...s, slots: { ...s.slots } }))
  const notes: string[] = []
  let inputTokens = 0, outputTokens = 0, calls = 0

  for (const target of body.targets ?? []) {
    const slide = slides[target.slideIndex]
    const original = slide?.slots?.[target.slot]
    if (!original?.trim()) {
      notes.push(`слайд ${target.slideIndex + 1}: слот ${target.slot} порожній, пропущено`)
      continue
    }

    const result = await shortenSlot(original, target.cutPct)
    inputTokens += result.usage.inputTokens
    outputTokens += result.usage.outputTokens
    calls += result.usage.calls

    if (!result.ok) {
      // Refused, and said why. The slide keeps the client's words and the question stays
      // open — a half-accepted rewrite would be the one outcome worse than no rewrite.
      notes.push(`слайд ${target.slideIndex + 1}: не вдалося скоротити — ${result.reason}`)
      continue
    }

    slide.shortenedFrom = { ...(slide.shortenedFrom ?? {}), [target.slot]: original }
    slide.slots[target.slot] = result.text
    notes.push(`слайд ${target.slideIndex + 1}: скорочено на ${result.cutPct}%`)
  }

  console.log(`[shorten] ${calls} calls, in=${inputTokens} out=${outputTokens}`)
  return NextResponse.json({ slides, notes, usage: { inputTokens, outputTokens, calls } })
}
