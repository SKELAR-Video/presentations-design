# Верифікація і валідатор

## Повна таблиця перевірок

`validateDeck(slidesApi, presentationId, plan, planPageIds)` читає фінальний дек через Slides API.

| # | ID перевірки | Що перевіряємо |
|---|---|---|
| 1 | `bounds` | Кожен елемент повністю в межах 0–1920×0–1080 Figma px |
| 2 | `autofit_none` | autofitType усіх TEXT_BOX = NONE |
| 3 | `font_inter_medium` | Шрифт Inter, bold=false у всіх textRun |
| 4 | `max_chars` | Довжина тексту кожного слоту ≤ max_chars зі `compositions.ts` |
| 5 | `skelar_badge` | Елемент-логотип присутній біля (1730, 100) ±20px |
| 6 | `kpi_numeric_values` | Слоти КАРТКА_N_ЗНАЧЕННЯ — тільки числові значення |
| 7 | `kpi_gap` | body-текст не перетинає ряд карток: gap ≥ gap_min (30px) |
| 8 | `theme_consistency` | Тема одна на весь дек (dark або red) |
| 9 | `logo_overlap` | Жоден TEXT_BOX не перетинається із зоною логотипа |
| 10 | `bento_left_overlap` | ЗАГОЛОВОК і ТЕКСТ в лівій колонці bento_right_* не перекриваються |
| 11 | `bento_trailing_period` | Текст бенто-картки не закінчується одиничною крапкою (після auto-strip) |
| 12 | `bento_layout` | pt ≥ 10pt (10pt — навмисна нижня межа, контент ніколи не скорочується); текст не переповнює; буліти присутні якщо є `·` |
| 13 | `kpi_row_geometry` | Ряд від PAD до PAD+UW; дно ≈ kCY+cardH |
| 14 | `content_integrity` | Кожен слот є точним підрядком вхідного ТЗ (з урахуванням виключень) |
| 15 | `fragment_coverage` | Кожен вхідний фрагмент присутній у слотах плану |
| 16 | `no_literal_asterisk` | Жоден слот не містить `*` |
| 17 | `no_duplicate_title` | ЗАГОЛОВОК не дублюється між сусідніми слайдами (виключення: variant siblings `_v1`/`_v2`) |
| 18 | `badge_item_max_chars` | Кожна мітка в ПУНКТИ ≤ 20 символів |
| 19 | `slide_count_matches_sheets` | Кількість слайдів ≥ кількість аркушів (може бути більше через variant expansion) |

## Жорстке правило: не «готово» поки FAIL

НЕ оголошувати «готово», поки `validation.pass === true`.  
Якщо хоч один FAIL — аналізуй причину, правь **сам**, без перекидання на користувача.  
Макс 2 спроби → після 2 невдач СТОП, звіт числами.

Коли все PASS — дати лінк + вивести звіт (PASS/FAIL по слайдах).

## Панель фактів (inspect-deck)

`buildPresentation` повертає `{ url, validation, deckFacts }`.

Факти з реального файлу (через `DeckFactReport`) відображаються на `/result` у панелі «Факти з файлу». Перевіряє fontSize, геометрію, наявність контенту — на основі того, що реально записалось у Slides.

## Авто-пуш (`lib/auto-push.ts`)

- **Пуш тільки після PASS**. `autoPushIfPass(validation, msg)` — нічого не пушить якщо `pass === false`.
- **`.env.local` захищений**: `.gitignore` має `.env*` — перевірка вбудована у функцію; без неї пуш блокується.
- **Пуш у поточну гілку** (`git branch --show-current`).
- На Vercel (`process.env.VERCEL`) — завжди skip.

## Fixture-валідатор

```bash
npx ts-node --skip-project scripts/validate-fixture.ts
```

Набори тестів:
- **Fixture 1** — коректний badges-слайд → очікується PASS
- **Fixture 2** — asterisks, дублікат заголовка, довгий badge → очікується FAIL
- **Fixture 3** — fragmentGroups, всі фрагменти присутні → PASS
- **Fixture 4** — fragmentGroups, один фрагмент відсутній → FAIL
- **Bento height+width** — math: word-fit + height-check для bento_right_2/3
- **Bento geometry** — math: інваріант `card_bottom = 980` для 5 композицій
- **Word-break** — math: `longestWordPx × 1.1 ≤ innerW` для bento + title кроків

## Маркер-тест для верифікації деплою

Щоб переконатись що зміни коду доходять до дека, додай тимчасовий маркер:

```ts
// lib/google.ts, у replaceAllText-циклі
if (compId === 'cover' && slotName === 'ПІДЗАГОЛОВОК' && replaceText.trim()) {
  replaceText = replaceText + ' TEST-A1'
}
```

Генеруй → `TEST-A1` з'явився = код живий; не з'явився = стейл-білд або master не перебудовано.  
Видали маркер одразу після підтвердження.
