# Архітектура генерації презентацій

## Два окремі кроки

```
/api/create-master  → створює шаблонний Slides-файл з {{PLACEHOLDER}}-ами
                      результат = MASTER_DECK_ID (зберігається в .env.local)
                      перезапускати тільки при зміні СТРУКТУРИ шаблону

/api/generate       → копіює master (Google Drive file copy)
                      потім запускає buildPresentation (lib/google.ts):
                        replaceAllText → замінює {{слоти}} на реальний текст
                        pickBentoPt / buildBentoRightLayoutRequests → кегль і геометрія
```

## Де живе логіка кегля і геометрії bento

**Вся логіка — в `lib/google.ts` → `buildPresentation()`.**

Це generation-код, не create-master. Зміни в `lib/google.ts` (кегль, word-fit, floor, геометрія карток) **не потребують rebuild master**. Вони вступають в силу з наступної генерації.

`create-master` потрібно перезапускати тільки якщо змінюється:
- кількість слайдів-шаблонів
- позиції/розміри master-елементів в `app/api/create-master/route.ts`
- склад placeholder-ів у майстрі

## Чи доходять зміни коду до згенерованого дека

| Середовище | Зміни доходять? |
|---|---|
| **Local dev** (`npm run dev`) | Так, одразу після збереження файлу. Якщо сервер не запущено — перезапусти. |
| **Vercel (auto-deploy)** | Так, після пушу на main. Чекай ~1-2 хв на завершення білду в Vercel Dashboard. |
| **Vercel (manual deploy)** | Ні, поки не передеплоїти вручну через `vercel --prod` або UI. |

## Маркер-тест для верифікації

Щоб переконатись що зміни коду доходять до дека, додай тимчасовий маркер у generation-код:

```ts
// lib/google.ts, у replaceAllText-циклі
if (compId === 'cover' && slotName === 'ПІДЗАГОЛОВОК' && replaceText.trim()) {
  replaceText = replaceText + ' TEST-A1'
}
```

Генеруй і дивись на обкладинку:
- **`TEST-A1` з'явився** → код живий, всі правки активні
- **`TEST-A1` не з'явився** → стейл-білд або master не перебудовано — лагодити це, а не логіку

Видали маркер одразу після підтвердження.
