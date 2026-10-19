import { NextRequest, NextResponse } from 'next/server'
import { logDeckEvent } from '@/lib/deck-stats'

// Правила для Клод Дизайну — через нас, щоб порахувати генерації.
//
// Клод Дизайн за протоколом читає rules.md перед кожним деком. Це єдина його
// дія, яка відбувається САМА, без людини. Тому вона й стає лічильником: він
// читає ту саму адресу, тільки нашу, ми пишемо рядок і віддаємо файл далі.
//
// ПРОКСІ, а не редірект. Редірект браузер і будь-який клієнт має право
// закешувати — і наступні генерації пройдуть повз нас, непоміченими. Проксі
// гарантує, що кожне читання видно; ціна — один зайвий хоп, мілісекунди.
//
// Публічний маршрут без сесії: у Клод Дизайну її нема й бути не може.
// Віддається те саме, що лежить у публічному репозиторії, тож нічого нового
// назовні не відкривається.

const RAW = 'https://raw.githubusercontent.com/SKELAR-Video/presentations-design-dash/main'

// Білий список, а не «що попросять»: інакше маршрут стає відкритим проксі на
// довільний шлях у GitHub і може віддавати чуже під нашим доменом.
const ALLOWED = new Set([
  'rules.md', 'types.md', 'CLAUDE.md', 'rules-delta.md',
  'reference.html', 'reference-basic.html', 'check.js',
])

const TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params
  if (!ALLOWED.has(file)) {
    return NextResponse.json({ error: `невідомий файл: ${file}` }, { status: 404 })
  }

  const q = req.nextUrl.searchParams
  const upstream = await fetch(`${RAW}/${file}`, { cache: 'no-store' })
  if (!upstream.ok) {
    return NextResponse.json({ error: `GitHub віддав ${upstream.status}` }, { status: 502 })
  }
  const body = await upstream.text()

  // Версію беремо з самого файлу, а не з параметра: параметр каже, що Клод
  // Дизайн ДУМАЄ про свою версію, а заголовок — що він щойно отримав. Для
  // статистики цінніше друге, бо саме на цьому дек і збереться.
  const vFromBody = body.match(/·\s*(v\d+)\s*·/)?.[1]

  // Не await: рядок у таблиці не має затримувати віддачу правил. Помилку
  // logDeckEvent ковтає сам.
  void logDeckEvent({
    event: q.get('e') ?? 'read',
    team: q.get('team') ?? undefined,
    rulesVersion: vFromBody ?? q.get('v') ?? undefined,
    deck: q.get('deck') ?? undefined,
    file,
    source: req.headers.get('user-agent')?.slice(0, 120) ?? undefined,
  })

  return new NextResponse(body, {
    headers: {
      'Content-Type': TYPES[file.split('.').pop() ?? ''] ?? 'text/plain; charset=utf-8',
      // Без цього кеш з'їсть другу й усі наступні генерації, і лічильник
      // показуватиме одну на день замість усіх.
      'Cache-Control': 'no-store, max-age=0',
    },
  })
}
