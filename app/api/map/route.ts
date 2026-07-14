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

  if (body.mode === '1to1' && body.slides?.length) {
    try {
      const plan = await mapSlides1to1(body.slides, theme)
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
    const plan = await mapToPlan(body.text.trim(), theme)
    return NextResponse.json({ plan })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[map] error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
