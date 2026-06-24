import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { mapToPlan } from '@/lib/anthropic'
import type { Theme } from '@/lib/types'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { text, theme } = await req.json() as { text: string; theme: Theme }

  if (!text?.trim()) {
    return NextResponse.json({ error: 'Текст ТЗ не може бути порожнім' }, { status: 400 })
  }

  const plan = await mapToPlan(text.trim(), theme ?? 'dark')
  return NextResponse.json({ plan })
}
