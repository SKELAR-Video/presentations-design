# Text Layout — Word-Fit Guard + Deterministic Font Selection

## Принцип

**Детермінований підбір кегля + фіксована сітка.**

Slides API v1 не підтримує `TEXT_AUTOFIT` / `SHRINK_TEXT_ON_OVERFLOW` при записі через API (тип `autofitType` може бути лише `NONE`). Тому ніякого autofit у коді немає — весь розмір тексту розраховується на стороні сервера до відправки запиту.

Два рівні захисту:
1. **Word-fit guard** — жодне ціле слово не виходить за межі ширини боксу
2. **Height check** — загальна висота рядків не перевищує висоту боксу

---

## Константи

```
CHAR_W   = 0.65   — коефіцієнт ширини символу (Inter Medium, Cyrillic-safe)
SAFETY   = 1.2    — запас безпеки для word-fit guard
LINE_H   = pt × 2.667 × 1.4  — висота рядка в px
_INSET   = 19px   — внутрішній відступ Google Slides (незнімний)
```

Формули через Figma px → EMU: `1 Figma px = 4762.5 EMU` (= 9144000 / 1920).

---

## Word-fit guard

```
longestWordPx(text, pt) = max(word.length) × pt × 2.667 × CHAR_W
```

Умова проходження: `longestWordPx × 1.2 ≤ inner_width`

де `inner_width = element_width - 2 × _INSET`.

Логування формату:
```
[word-fit] <label>: longest_word_len=N | est_width=NNN | est×1.2=NNN | inner_width=NNN | chosen_font=NN → PASS/FAIL
```

---

## Height check

```
cpl = floor(inner_width / (pt × 2.667 × CHAR_W))   — chars per line
lines = word-wrap simulation over paragraphs
text_height = lines × lineH(pt)
```

Умова проходження: `text_height ≤ inner_height`

де `inner_height = element_height - 2 × _INSET`.

Логування:
```
[bento-height] <label>: lines=N | text_height=NNN | inner_height=NNN | font=NN → PASS/FAIL
```

---

## Кроки підбору кегля

### Заголовки (ЗАГОЛОВОК slot)

Кроки: `[44, 40, 36, 32, 28]`  
Перший крок, при якому `longestWordPx × 1.2 ≤ _LTW` (де `_LTW = 830px`) — обраний кегль.

> `estimateLineCount` з фактором 0.48 використовується **лише** для розрахунку позицій (layout positioning), не для overflow detection.

### Бенто-картки (bento_right_*)

Кроки: `[48, 36, 28, 22, 18, 14, 10]` з обмеженням `maxPt` на компонент.

Один кегль на всі картки групи (`pickBentoPt` повертає один pt, що задовольняє всі картки одночасно). Перевірка для кожної картки: `textFitsParagraphs(text, dims.w, dims.h, pt)` — враховує і word-fit, і висоту.

---

## Grid-driven bento геометрія

Висоти карток визначаються **виключно** константами сітки, незалежно від кегля:

```
_PAD  = 100    — відступ слайда
_H    = 1080   — висота слайда
_RBH  = _H - 2 × _PAD = 880   — висота правого блоку
_CH   = 680    — висота контентної зони (two_columns / three_columns)
_CY   = 300    — Y контентної зони
_GAP  = 30     — відступ між картками
```

| Композиція | Висота картки | Y старт |
|---|---|---|
| `two_columns` | `_CH = 680` | `_CY = 300` |
| `three_columns` | `_CH = 680` | `_CY = 300` |
| `bento_right_2x2` | `floor((_RBH - _GAP) / 2)` | `_PAD = 100` |
| `bento_right_2` | `masterH = floor((_RBH - _GAP) / 2)`; остання: `_RBH - (n-1)×(masterH+_GAP)` | `_PAD = 100` |
| `bento_right_3` | `masterH = floor((_RBH - 2×_GAP) / 3)`; остання: `_RBH - (n-1)×(masterH+_GAP)` | `_PAD = 100` |

**Інваріант**: нижній край останньої картки завжди = `_H - _PAD = 980`. Остання картка поглинає залишок від `floor()`.

---

## INSET компенсація

`_INSET = 19px` — фіксований внутрішній відступ Google Slides (~0.25cm). REST API v1 не може його прибрати.

Всі TEXT_BOX отримують компенсацію через `makeElemTransform`:
```
box_x = text_x − 19,  box_y = text_y − 19
box_w = text_w + 38,  box_h = text_h + 38
```

`inner_width = box_w - 38 = text_w`  
`inner_height = box_h - 38 = text_h`

---

## Типографіка

### Нерозривні пробіли

Короткі слова (1–4 символи: `у`, `і`, `з`, `та`, `на`, `до` тощо) — пробіл після них замінюється на ` `.

**Де**: `lib/google.ts` → `addNbsp(text)`, у циклі `replaceAllText`.

### Крапка наприкінці

| Кінцевий символ | Дія |
|---|---|
| `.` | прибрати |
| `?`, `!`, `…`, `...` | залишити |

Застосовується до ЗАГОЛОВОК та всіх бенто-карток. **Де**: `stripTrailingPeriod()`.

### Шрифт

Inter Medium (вага 500) — **завжди**. Ієрархія тільки через розмір кегля, без bold.

---

## Content integrity (fragmentGroups)

```ts
SlidePlan.fragmentGroups?: string[][]
```

Кожен рядок з вихідного тексту (brief) трекується як фрагмент у `fragmentGroups`. `checkFragmentCoverage` у `validatePlan` перевіряє, що кожен фрагмент присутній verbatim у слотах хоча б одного слайда. При провалі: retry loop у `mapToPlan`, throw при persistent failure.

---

## Фіксовані позиції

```
_H1_FIXED_44 = 260px   — 44pt заголовки (cover, bento_right, section, badges)
_H1_FIXED_36 = 220px   — 36pt заголовки (title_body)
TITLE_GAP    = 60px    — відступ від заголовка до контенту нижче
_TITLE_W     = 1610px  — ширина заголовкових боксів (LOGO_X − LOGO_GAP − PAD)
```

| Композиція | titleH | textY |
|---|---|---|
| `cover` | 260 | 420 |
| `section` / `section_red` | 260 | 420 |
| `title_body` | 220 | 380 |
| `bento_right_*` | 260 | 420 |
| `badges` | 220 | 380 |

---

## Валідатор

| Перевірка | Що перевіряє |
|---|---|
| `no_literal_asterisk` | Жоден слот не містить `*` (маркдаун-залишки) |
| `no_duplicate_title` | Заголовки унікальні у межах плану |
| `badge_item_max_chars` | Кожен пункт ПУНКТИ ≤ max_chars |
| `fragment_coverage` | Кожен вихідний фрагмент присутній у слотах |
| `bounds` | Жоден елемент не виходить за межі слайда |
| `logo_overlap` | TEXT_BOX не перетинається з зоною логотипа |

---

## Fixture-валідатор

```bash
npx ts-node --skip-project scripts/validate-fixture.ts
```

Чотири набори (+ детермінізм-перезапуск):
- **Fixture 1** — коректний badges-слайд, очікується PASS
- **Fixture 2** — asterisks, дублікат заголовка, довгий badge → FAIL
- **Fixture 3** — fragmentGroups, всі фрагменти присутні → PASS
- **Fixture 4** — fragmentGroups, один фрагмент відсутній → FAIL
- **Bento height+width** — math: word-fit + height-check для bento_right_2/3
- **Bento geometry** — math: інваріант `card_bottom = 980` для 5 композицій
- **Word-break** — math: `longestWordPx × 1.2 ≤ innerW` для bento + title кроків
