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

Ряд завжди від лівого поля (x=PAD) до правого (x=PAD+UW). Порожніх зазорів справа або зліва не лишати.

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

Зменшувати лише якщо текст не влазить при role max.

## 3. Вертикальне заповнення картки

**Заборонено:** текст угорі + велика порожнеча знизу.

Алгоритм після вибору `pt`:

1. Обчислити `naturalH = totalLines × lineH(pt)` де `lineH(pt) = pt × 2.667 × 1.4`.
2. Якщо `naturalH ≥ innerH × 0.85` — простору достатньо, нічого не робити.
3. Інакше — розподілити залишок рівномірно:
   ```
   extra = innerH - naturalH
   spaceAbovePt = extra / (2 × nParagraphs × 2.667)
   ```
   Встановити `spaceAbove = spaceBelow = spaceAbovePt` для ВСІХ параграфів (via `updateParagraphStyle` на ALL range).

Це розміщує рівний відступ до та після кожного пункту, поширюючи список на всю висоту картки.

## 4. Висота картки (`kpi_cards`)

```
kCY = PAD + TH + bodyH + TG      ← комфортний відступ від заголовка
cardH = H - PAD - kCY             ← заповнює до нижнього поля
```

При `bodyH=0`: `kCY=300`, `cardH=680`.  
При `bodyH=56`: `kCY=356`, `cardH=624` (= значення старого майстра, зворотна сумісність).

## 5. Внутрішні відступи

`INN = 30px` з усіх боків картки. Текстовий бокс займає `cw - 2×INN` × `cardH - 2×INN`.

## 6. Валідатор

| Перевірка | Де |
|---|---|
| `kpi_row_geometry` — ряд від PAD до PAD+UW, дно = H-PAD, відступ ≥ TG | `validator.ts:checkKpiCardRowGeometry` |
| `bento_layout` — pt > 10pt, текст не переповнює | `validator.ts:checkBentoLayout` |
| `kpi_numeric_values` — ЗНАЧЕННЯ = числовий формат | `validator.ts:checkKpiNumeric` |
| `kpi_gap` — зазор між body і картками ≥ gap_min | `validator.ts:checkKpiGap` |

## 7. Де реалізовано

| Файл | Функція |
|---|---|
| `lib/google.ts` | `computeKpiAdaptive` — ширина/висота/pt для kpi_cards |
| `lib/google.ts` | `buildKpiUpdateRequests` — перепозиціонування карток і кутів |
| `lib/google.ts` | `pickBentoPt` — єдиний pt для бенто-рядів (scale UP→DOWN) |
| `lib/google.ts` | `bentoParagraphSpacingPt` — spaceAbove/Below для вертикального заповнення |
