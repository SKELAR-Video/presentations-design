# Теми і бренд

## Кольори SKELAR

| Змінна | HEX | Призначення |
|--------|-----|-------------|
| DARK | `#090D17` | фон слайду (основний) |
| CARD | `#1A1F2E` | фон бенто-карток |
| RED | `#FD3433` | фон акцентних слайдів (section_red) |
| WHITE | `#FFFFFF` | заголовки, значення KPI |
| MUTED | `#A2A6B1` | баді-текст на темному тлі |
| PINK | `#FCCACA` | баді-текст на червоному тлі |

Баді-текст завжди: **MUTED на DARK**, **PINK на RED**.

Кольорування тексту з `:` (усі не-заголовкові слоти): до `:` включно → WHITE; після `:` → MUTED або PINK залежно від теми. Деталі → `docs/rules/typography.md`.

## Теми

- **dark** — фон DARK `#090D17`, текст WHITE/MUTED.
- **red** — фон RED `#FD3433`, текст WHITE/PINK.
- **Одна тема на весь дек** — або `dark`, або `red`; не змішувати. Валідатор: `theme_consistency`.

## Логотип

**Розмір**: 90×90 px  
**Позиція**: правий верхній кут — `x = W - PAD - 90 = 1730, y = PAD = 100`  
**Зарезервована зона**: x∈[1730,1820], y∈[100,190] — жоден TEXT_BOX не перетинає.

Три варіанти:
- `public/assets/SKELAR Symbol.png` — темний/стандартний (більшість слайдів)
- `public/assets/SKELAR Symbol for red.png` — білий (для `section` з червоним фоном)
- `public/assets/SKELAR Logo.png` — повний wordmark (для `cover_title_only`, `closing` title-only)

URL-пріоритет: `LOGO_URL` / `LOGO_RED_URL` / `LOGO_WORDMARK_URL` env → `VERCEL_URL` → GitHub raw  
`LOGO_WORDMARK_URL`: якщо не задано — виводиться з `LOGO_URL` (замінює ім'я файлу).

**Важливо**: файли логотипів мають бути в гіті — Vercel деплоїть тільки те, що є в репо. GitHub raw не працює для приватного репо.

Логотипи додаються двома окремими `batchUpdate` після основного: `symbolRequests` і `wordmarkRequests` — помилка одного не вбиває інший.

## SKELAR badge

Бейдж-логотип присутній **завжди** в кожному слайді, біля `(1730, 100)` ±20px.  
Валідатор: `skelar_badge`. Для `cover_title_only` і `closing` title-only — перевіряється позиція `(1463, 99)` (wordmark).
