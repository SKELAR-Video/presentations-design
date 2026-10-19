import { NextRequest, NextResponse } from 'next/server'
import { logDeckEvent } from '@/lib/deck-stats'

// Правила й асети для Клод Дизайну — через нас, щоб порахувати генерації.
//
// Клод Дизайн за протоколом читає rules.md перед кожним деком. Це єдина його
// дія, яка відбувається САМА, без людини. Тому вона й стає лічильником: він
// читає ту саму адресу, тільки нашу, ми пишемо рядок і віддаємо файл далі.
//
// ПРОКСІ, а не редірект. Редірект клієнт має право закешувати — і наступні
// генерації пройдуть повз нас, непоміченими. Проксі гарантує, що кожне
// читання видно; ціна — один хоп, мілісекунди.
//
// Публічний маршрут без сесії: у Клод Дизайну її нема й бути не може.
// Віддається те саме, що лежить у публічному репозиторії.

const RAW = 'https://raw.githubusercontent.com/SKELAR-Video/presentations-design-dash/main'

// Білий список, а не «що попросять»: інакше маршрут стає відкритим проксі на
// довільний шлях у GitHub і віддає чуже під нашим доменом.
//
// content/*-embed-N.html тут обовʼязково: бінарні картинки генерація не бачить,
// вона вміє тільки текст і data: URI, тому фони й фото приходять саме цими
// файлами. Перша версія списку їх не мала — і нова дизайн-система зібралась би
// без жодного фону, а правило «обкладинка завжди з фото» стало б невиконанним.
const FILES = new Set([
  'rules.md', 'types.md', 'CLAUDE.md', 'rules-delta.md',
  'reference.html', 'reference-basic.html', 'check.js',
])
const EMBED = /^content\/(bg|photo)-embed-\d+\.html$/

const TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const file = (await ctx.params).path.join('/')
  if (!FILES.has(file) && !EMBED.test(file)) {
    return NextResponse.json({ error: `невідомий файл: ${file}` }, { status: 404 })
  }

  const q = req.nextUrl.searchParams
  const upstream = await fetch(`${RAW}/${file.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' })
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
      // Без цього кеш зʼїсть другу й усі наступні генерації, і лічильник
      // показуватиме одну на день замість усіх.
      'Cache-Control': 'no-store, max-age=0',
    },
  })
}
