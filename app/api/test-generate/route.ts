import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { buildPresentation } from '@/lib/google'
import type { SlidePlan } from '@/lib/types'

// Навмисно проблемний план — відтворює всі відомі дефекти:
// 1. cover: ЗАГОЛОВОК > 60 chars
// 2. kpi_cards: ТЕКСТ > 70 chars, КАРТКА_3_ЗНАЧЕННЯ — нечислове
// 3. three_columns: КОЛОНКА_1 > 140 chars
const PROBLEM_PLAN: SlidePlan = {
  theme: 'dark',
  slides: [
    {
      id: 'slide_1',
      composition: 'cover',
      slots: {
        ЗАГОЛОВОК: 'Дуже довгий заголовок що явно перевищує ліміт шістдесят символів і виходить за краї',
        ДАТА: '29 червня 2026',
      },
      flags: {},
    },
    {
      id: 'slide_2',
      composition: 'kpi_cards',
      slots: {
        ЗАГОЛОВОК: 'Ключові метрики Q2 2026',
        ТЕКСТ: 'Цей текст навмисно довший за сімдесят символів щоб перевірити чи валідатор зловить переповнення тіла',
        КАРТКА_1_ЗНАЧЕННЯ: '+42%',
        КАРТКА_1_ПІДПИС: 'Зростання виручки',
        КАРТКА_2_ЗНАЧЕННЯ: '$5M',
        КАРТКА_2_ПІДПИС: 'ARR за квартал',
        КАРТКА_3_ЗНАЧЕННЯ: 'Список пунктів — FAIL',
        КАРТКА_3_ПІДПИС: 'Не метрика',
        КАРТКА_4_ЗНАЧЕННЯ: '×2',
        КАРТКА_4_ПІДПИС: 'Клієнти',
      },
      flags: {},
    },
    {
      id: 'slide_3',
      composition: 'three_columns',
      slots: {
        ЗАГОЛОВОК: 'Три кроки',
        КОЛОНКА_1: 'Перший крок: дуже довгий текст у першій колонці що явно перевищує ліміт max_chars сто сорок символів — це навмисно щоб перевірити валідатор і авто-трункейт',
        КОЛОНКА_2: 'Другий крок: нормальний текст',
        КОЛОНКА_3: 'Третій крок: нормальний текст',
      },
      flags: {},
    },
    {
      id: 'slide_4',
      composition: 'closing',
      slots: { ЗАГОЛОВОК: 'Дякуємо!' },
      flags: {},
    },
  ],
}

export async function GET() {
  const session = await auth()
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized — відкрийте / у браузері та увійдіть' }, { status: 401 })
  }
  try {
    const { url, validation } = await buildPresentation(
      session.accessToken,
      PROBLEM_PLAN,
      'TEST — Проблемний дек',
    )
    return NextResponse.json({ url, validation }, { status: 200 })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
