import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { buildPresentation } from '@/lib/google'
import type { SlidePlan } from '@/lib/types'

export const maxDuration = 300

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { plan, title } = await req.json() as { plan: SlidePlan; title: string }

  if (!plan?.slides?.length) {
    return NextResponse.json({ error: 'План слайдів порожній' }, { status: 400 })
  }

  try {
    const { url, presentationId, validation, deckFacts } = await buildPresentation(session.user?.email ?? '', plan, title || 'SKELAR Presentation')
    return NextResponse.json({ url, presentationId, validation, deckFacts })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[generate] error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
