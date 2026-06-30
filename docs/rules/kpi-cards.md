# Bento Card Row — Layout Rules

Applies to: `kpi_cards`, `two_columns`, `three_columns`, `bento_right_2/3/2x2`.

## 1. Ширина карток — динамічна

`cw = floor((UW - (n-1) × GAP) / n)` де `n` = кількість активних карток.

| n | cw (px) |
|---|---------|
| 1 | 1720 |
| 2 | 845 |
| 3 | 553 |
| 4 | 407 |

Ряд завжди від лівого поля (x=PAD) до правого (x=PAD+UW).

## 2. Шрифт — єдиний по ряду, від role max вниз

Визначається за НАЙДОВШИМ текстом у ряду. Ціль — НАЙБІЛЬШИЙ кегль, при якому всі активні картки вміщують свій текст.

| Композиція | Role max |
|---|---|
| `two_columns` | 48 pt |
| `three_columns` | 28 pt |
| `bento_right_2` | 36 pt |
| `bento_right_3` | 22 pt |
| `bento_right_2x2` | 22 pt |
| `kpi_cards` ЗНАЧЕННЯ | 48 pt |

## 3. Висота картки — за вмістом

**Правило**: `cardH = contentH + 2 × VERT_PAD`

- `contentH` — оцінена висота тексту при обраному pt
- `VERT_PAD = 40px` для бенто-рядів; `30px` для `kpi_cards`
- Усі картки ряду — ОДНАКОВОЇ висоти (= найвища з них)
- **НЕ розтягувати картку на весь слайд**
- **НЕ розганяти вміст штучно** (`spaceAbove/Below`) — залишки простору лишаються знизу коротшої картки

## 4. Позиція ряду — центр у контент-зоні

Контент-зона: від `CY=300` до `H-PAD=980` (680px по вертикалі).

```
rowY = CY + max(0, (contentZoneH - cardH) / 2)
```

Ряд карток центрується у доступній зоні. Зайвий вертикальний простір — **зовні карток** (зверху і знизу ряду), не всередині.

## 5. Вертикальна структура (kpi_cards)

`кPI_cards` — tight group: цифра безпосередньо над підписом, без пропорційного розподілу.

```
ЗНАЧЕННЯ box:  y = kCY + INN + KPI_VERT_PAD,   h = valH
ПІДПИС box:    y = kCY + INN + KPI_VERT_PAD + valH, h = lblH
cardH          = valH + lblH + 2×INN + 2×KPI_VERT_PAD
```

`kCY = PAD + TH + bodyH + TG` — комфортний відступ від заголовка/тіла.

## 6. Буліти — кожен пункт з нового рядка

**Правило**: якщо вміст картки — список пунктів, кожен пункт рендериться окремим рядком з маркером `•`.

**Виняток**: короткий підзаголовок / цифра+підпис в одну стрічку — залишається без маркерів.

Автоматичне перетворення (функція `preprocessBentoText` у `lib/google.ts`):
- Текст з `·` між пунктами → `• пункт\n• пункт`
- Текст з `\n` між рядками (не value+label) → `• рядок\n• рядок`

## 7. Валідатор

| Перевірка | Критерій |
|---|---|
| `bento_layout` — pt >10pt, текст не переповнює | `validator.ts:checkBentoLayout` |
| `bento_layout` — буліти присутні (якщо є `·`) | FAIL якщо є ` · ` без конвертації в `•` |
| `bento_layout` — висота картки в деталях | detail: `pt=N КОЛОНКА_1:h=Xpx ...` |
| `kpi_row_geometry` — ряд від PAD до PAD+UW, дно ≈ kCY+cardH | `validator.ts:checkKpiCardRowGeometry` |
| `kpi_numeric_values` — ЗНАЧЕННЯ = числовий формат | `validator.ts:checkKpiNumeric` |
| `kpi_gap` — зазор між body і картками ≥ gap_min | `validator.ts:checkKpiGap` |

## 8. Де реалізовано

| Файл | Функція |
|---|---|
| `lib/google.ts` | `preprocessBentoText` — конвертація `·` → bullets |
| `lib/google.ts` | `pickBentoPt` — єдиний pt для бенто-рядів (scale UP→DOWN) |
| `lib/google.ts` | `buildBentoRowLayoutRequests` — висота картки за вмістом + позиція ряду |
| `lib/google.ts` | `computeKpiAdaptive` — ширина/висота/pt для kpi_cards |
| `lib/google.ts` | `buildKpiUpdateRequests` — tight group (ЗНАЧЕННЯ + ПІДПИС) |
