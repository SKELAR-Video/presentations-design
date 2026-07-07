import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { mapToPlan, mapSlides1to1 } from '@/lib/anthropic'
import type { Theme } from '@/lib/types'
import type { SourceSlide } from '@/app/api/fetch-doc/route'

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
    const plan = await mapSlides1to1(body.slides, theme)
    return NextResponse.json({ plan })
  }

  if (!body.text?.trim()) {
    return NextResponse.json({ error: 'Текст ТЗ не може бути порожнім' }, { status: 400 })
  }

  const rawText = body.text.trim()
  const underscoreCount = (rawText.match(/___/g) ?? []).length
  const newlineCount    = (rawText.match(/\n/g) ?? []).length
  const vtabCount       = (rawText.match(//g) ?? []).length
  console.log(`[map] len=${rawText.length}  ___×${underscoreCount}  \\n×${newlineCount}  \\u000b×${vtabCount}`)
  console.log(`[map] full text: ${JSON.stringify(rawText.slice(0, 800))}`)
  const plan = await mapToPlan(rawText, theme)
  console.log(`[map] sheetCount=${plan.sheetCount ?? 'none'}  slides=${plan.slides.length}`)
  return NextResponse.json({ plan })
}
