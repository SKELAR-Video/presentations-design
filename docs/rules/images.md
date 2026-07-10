# Фони і зображення

## Cover — випадковий фотофон

- `cover` і `cover_title_only` отримують випадковий фон з `public/assets/backgrounds/` (Mountain 0–5).
- Встановлюється через `updatePageProperties` → `pageBackgroundFill.stretchedPictureFill`.
- URL-пріоритет: `BG_BASE_URL` env → `VERCEL_URL` → GitHub raw (приватне репо = GitHub не працює).
- Функції: `getBgBaseUrl()` + `randomCoverBg()` у `lib/google.ts`.

## Cover title only — макет

Використовується коли `cover_title_only` або `closing` без підзаголовка і `ЗОБРАЖЕННЯ_1`.

```
SKELAR Logo.png (wordmark)  — праворуч вгорі  (1463, 99, 357×90)
Дата-пілюля                 — ліворуч вгорі   (100, 99, 195×115, #292D39)
ЗАГОЛОВОК                   — по центру кадру (100, 100, 1720×880)
```

- **Дата**: автоматично — поточна дата у форматі `дд.мм.рррр`, генерується `formatCurrentDate()`.
- **Шрифт ЗАГОЛОВОК**: динамічний, кроки `[66, 54, 44, 36, 28, 22]pt`, функція `pickCoverTitleOnlyPt()`, вирівнювання CENTER+MIDDLE.
- **Дата-пілюля**: `ROUND_RECTANGLE`, заливка `#292D39`, Inter 500 18pt MUTED, CENTER+MIDDLE — створюється динамічно, не в майстрі.

## Closing title-only — як cover_title_only

Коли `closing` має лише `ЗАГОЛОВОК` (немає `ПІДЗАГОЛОВОК` і `ЗОБРАЖЕННЯ_1`):

- Рендериться **ідентично** `cover_title_only`.
- Макет: SKELAR Logo.png (wordmark) `(1463, 99)`; дата-пілюля `(100, 99)`; ЗАГОЛОВОК по центру кадру.
- Фон: випадкове фото з `public/assets/backgrounds/`.
- Реалізація: `buildSectionFloatRequests` згортає ПІДЗАГОЛОВОК (h=1), потім `buildCoverTitleOnlyRequests` перезаписує ЗАГОЛОВОК → full-slide center.

## Section — червоний фон

- Всі слайди `composition === 'section'` автоматично отримують фон `#FD3433`.
- Встановлюється через `updatePageProperties` → `pageBackgroundFill.solidFill`.
- Логотип на цих слайдах: `SKELAR Symbol for red.png` (білий варіант).
- `section_red` і `closing` — не зачіпаються цією логікою (вони мають власний рендер).
