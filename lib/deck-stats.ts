import { put, list } from '@vercel/blob'

// ─── Лічильник деків Клод Дизайну ─────────────────────────────────────────────
// Клод Дизайн не вміє писати нікуди — GitHub у нього read-only. Єдина його дія
// перед кожним деком, яка відбувається САМА, — читання правил із мережі. Тому
// лічильником стало саме воно: правила віддає наш ендпоінт, і кожна генерація
// лишає по собі слід без жодної дії людини.
//
// Попередній облік просив людину перенести рядок-слід із нотаток дека в журнал
// руками. За два місяці — жодного запису при десятках реальних деків.
//
// Чому Blob, а не таблиця: політика Workspace забороняє шерити файли на
// сервіс-акаунти поза доменом, тому Google Sheets для робота закритий — туди
// не доходили ні записи, ні читання. Blob — сховище самого Vercel у тому ж
// акаунті: ні нового вендора, ні нових умов, ні доступу через чужий домен.
//
// ОДНА ПОДІЯ — ОДИН ФАЙЛ, а не один файл із лічильниками. Інакше кожен запис
// був би «прочитати, додати, записати», і дві генерації в одну секунду затерли
// б одна одну. Тут паралельні записи не конфліктують узагалі.
//
// Усе, що потрібно для підрахунку, лежить у ІМЕНІ файла — тож зведення
// будується самим переліком, без завантаження вмісту.

const PREFIX = 'events'

export type DeckEvent = {
  event: string        // deck | sync | read
  team?: string
  rulesVersion?: string
  deck?: string
  file: string
  source?: string
}

// У шлях ідуть лише короткі технічні поля. Назва дека та user-agent — у вміст:
// сховище приватне, але зведення читається публічно за переліком імен, і
// внутрішні назви не мають з'являтись там навіть випадково.
const safe = (v: string | undefined, fallback: string) =>
  (v ?? '').replace(/[^0-9A-Za-zА-Яа-яІіЇїЄєҐґ_-]+/g, '-').slice(0, 40) || fallback

// Ніколи не кидає. Правила мають доїхати до генерації навіть тоді, коли
// бухгалтерія лягла: дек дорожчий за рядок обліку.
export async function logDeckEvent(ev: DeckEvent): Promise<void> {
  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) return
  try {
    const now = new Date()
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const name = [
      safe(ev.event, 'read'),
      safe(ev.team, 'none'),
      safe(ev.rulesVersion, 'none'),
      now.toISOString().replace(/[:.]/g, '-'),
    ].join('__')

    await put(`${PREFIX}/${month}/${name}.json`, JSON.stringify({
      at: now.toISOString(),
      ...ev,
    }), {
      access: 'private',
      contentType: 'application/json',
      // Імена містять мітку часу з мілісекундами, але два запити в одну
      // мілісекунду можливі; суфікс гарантує, що другий не перезапише перший.
      addRandomSuffix: true,
    })
  } catch (e) {
    console.warn(`[deck-stats] не вдалося записати подію: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export type Summary = {
  деків: number
  поТімах: Record<string, number>
  поВерсіях: Record<string, number>
  поМісяцях: Record<string, number>
  іншіПодії: Record<string, number>
  подійУсього: number
}

// Рахує самим переліком: усе потрібне в іменах, вміст не завантажується.
export async function readSummary(): Promise<Summary> {
  const rows: { month: string; event: string; team: string; version: string }[] = []
  let cursor: string | undefined
  do {
    const page = await list({ prefix: `${PREFIX}/`, cursor, limit: 1000 })
    for (const b of page.blobs) {
      const m = b.pathname.match(/^events\/([^/]+)\/([^_]+)__([^_]+)__([^_]+)__/)
      if (m) rows.push({ month: m[1], event: m[2], team: m[3], version: m[4] })
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)

  const tally = (src: typeof rows, key: (r: typeof rows[number]) => string) => {
    const out: Record<string, number> = {}
    src.forEach(r => { const k = key(r) || '—'; out[k] = (out[k] ?? 0) + 1 })
    return out
  }
  // Генерація — це подія 'deck'. Синк читає ті самі файли, і змішати їх
  // означало б показати вдесятеро більше деків, ніж було насправді.
  const decks = rows.filter(r => r.event === 'deck')

  return {
    деків: decks.length,
    поТімах: tally(decks, r => r.team),
    поВерсіях: tally(decks, r => r.version),
    поМісяцях: tally(decks, r => r.month),
    іншіПодії: tally(rows.filter(r => r.event !== 'deck'), r => r.event),
    подійУсього: rows.length,
  }
}
