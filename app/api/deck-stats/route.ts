import { NextResponse } from 'next/server'
import { readSummary } from '@/lib/deck-stats'

// Зведення по деках Клод Дизайну — щоб статистику можна було прочитати
// звідки завгодно, а не тільки відкривши сховище очима.
//
// Публічний і без сесії навмисно, тому віддає лише агреговані числа: скільки
// деків, по тімах, версіях і місяцях. Назв деків тут немає — вони лишаються
// у вмісті подій, у приватному сховищі.
export async function GET() {
  try {
    return NextResponse.json(await readSummary(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
