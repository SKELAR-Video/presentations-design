'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ValidationReport, SlideValidation, SlideOverload } from '@/lib/validator'
import type { DeckFactReport, SlideDeckFacts, DeckFact, SlidePlan } from '@/lib/types'
import { applySplits, splitSlide, type Decision } from '@/lib/split'

export default function ResultPage() {
  const router = useRouter()
  const [url, setUrl]               = useState('')
  const [deckId, setDeckId]         = useState('')
  const [plan, setPlan]             = useState<SlidePlan | null>(null)
  const [validation, setValidation] = useState<ValidationReport | null>(null)
  const [deckFacts, setDeckFacts]   = useState<DeckFactReport | null>(null)
  const [fixing, setFixing]         = useState(false)
  const [fixError, setFixError]     = useState('')
  const [fixNotes, setFixNotes]     = useState<string[]>([])
  const [fixStage, setFixStage]     = useState('')
  // One repair round, then the deck. The panel used to re-appear on whatever was still
  // overloaded after a rebuild — and a shortening the audit rejects changes nothing, so the
  // same slide came back with the same offer, round after round, with the slide numbers
  // shifting each time because splitting inserts slides. From the person's side that is a
  // loop with no exit. They asked for one step and then the finished presentation; that is
  // also the only shape where "no" is a possible answer.
  const [repairDone, setRepairDone] = useState(false)
  const [leftOver, setLeftOver]     = useState(0)

  useEffect(() => {
    const stored = sessionStorage.getItem('deck_url')
    if (!stored) { router.push('/'); return }
    setUrl(stored)
    setDeckId(sessionStorage.getItem('deck_id') ?? '')
    const pRaw = sessionStorage.getItem('deck_plan')
    if (pRaw) { try { setPlan(JSON.parse(pRaw)) } catch { /* ignore */ } }
    const vRaw = sessionStorage.getItem('deck_validation')
    if (vRaw) { try { setValidation(JSON.parse(vRaw)) } catch { /* ignore */ } }
    const fRaw = sessionStorage.getItem('deck_facts')
    if (fRaw) { try { setDeckFacts(JSON.parse(fRaw)) } catch { /* ignore */ } }
  }, [router])

  const overallPass = deckFacts ? deckFacts.pass : (validation?.pass ?? true)
  const allOverloads = validation?.overloads ?? []
  // Only the still-open questions reach the panel. A slide whose small type was accepted is
  // kept in `allOverloads` — the decision stays visible as a footnote — but it no longer
  // counts toward the headline and no longer reopens on every rebuild.
  const overloads = allOverloads.filter(o => !o.accepted)
  const accepted  = allOverloads.filter(o => o.accepted)

  // Whether splitting can actually do anything for each slide, decided by running the real
  // splitter rather than guessing from the numbers. A sheet written as one unbroken
  // paragraph has nothing to divide, and offering "розкласти" as its default would be an
  // offer that fails the moment it is accepted — there, shortening is the only repair left.
  const splittable = new Set(
    overloads
      .filter(o => plan?.slides[o.slideIndex] && splitSlide(plan.slides[o.slideIndex], o))
      .map(o => o.slideIndex),
  )

  // What the folded diagnostics are for: anything wrong that the panel above does NOT
  // already say in plain words. readable_font is excluded because the panel is that check,
  // restated for a person — repeating it as "readable_font: ТЕКСТ 12pt (floor 18)" adds a
  // wall of jargon and no information.
  //
  // Gating this on overallPass was wrong: that flag is computed from the bento/KPI facts
  // alone and knows nothing about the static checks, so a deck failing validation still
  // counted as passing and hid its own diagnostics.
  const hasOtherFails =
    (deckFacts ? !deckFacts.pass : false) ||
    (validation?.slides ?? []).some(sv =>
      sv.checks.some(c => !c.pass && c.check !== 'readable_font'))
  // A sheet appears once per design variant, and the variants are not the same shape — a
  // three-column layout and a flex one give the same words different widths, so the same
  // text falls short by different amounts on each. The deficit was read off whichever
  // variant happened to be listed, while the shortened wording is applied to all of them:
  // enough for the slide the person saw, not enough for its siblings.
  //
  // Measured on deck 1bOXi…QfSZw: slide 7 was shortened by the 36% its sibling asked for and
  // came back at 11pt — still unreadable, because in columns_flex the columns are narrower.
  //
  // So the target is the worst case across every slide holding this exact text. Matched by
  // text rather than by slot name, because the same words live under КОЛОНКА_1 in one
  // composition and КАРТКА_1 in another — and by exact text, the same rule the shortened
  // wording is echoed back by.
  function worstCutFor(slideIndex: number, slot: string): number {
    const text = plan?.slides[slideIndex]?.slots?.[slot]
    if (!text?.trim()) return 0
    let worst = 0
    for (const o of allOverloads) {
      const slide = plan?.slides[o.slideIndex]
      if (!slide) continue
      for (const os of o.slots) {
        if (slide.slots[os.slot] !== text) continue
        if (os.cutPct > worst) worst = os.cutPct
      }
    }
    return worst
  }

  // The repair needs the plan whose slide numbers match the report. Without it the panel
  // could still describe the problem but could not act on it, and a button that cannot keep
  // its promise is worse than no button.
  const canRepair = Boolean(plan && deckId && overloads.length > 0)

  async function handleFix(decisions: Map<number, Decision>) {
    if (!plan || !deckId) return
    setFixing(true)
    setFixError('')
    setFixNotes([])
    try {
      const allNotes: string[] = []
      let slides = plan.slides

      // Shortening first, and by itself: it rewrites slots in place, so slide numbers still
      // match the report. Splitting changes how many slides there are, so it has to come
      // after — the other order would send the shortener at the wrong slide.
      const targets = [...decisions.entries()]
        .filter(([, d]) => d === 'shorten')
        .map(([slideIndex]) => {
          const o = overloads.find(x => x.slideIndex === slideIndex)!
          const worst = [...o.slots].sort((a, b) => b.cutPct - a.cutPct)[0]
          return { slideIndex, slot: worst.slot, cutPct: worstCutFor(slideIndex, worst.slot) }
        })

      if (targets.length) {
        setFixStage('Скорочую текст…')
        const res = await fetch('/api/shorten', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slides, targets }),
        })
        const text = await res.text()
        const data = text.trim() ? JSON.parse(text) : {}
        if (!res.ok) throw new Error(data.error ?? `Помилка скорочення (${res.status})`)
        slides = data.slides
        allNotes.push(...(data.notes ?? []))
      }

      setFixStage('Перезбираю презентацію…')
      const applied = applySplits(slides, overloads, decisions)
      slides = applied.slides
      allNotes.push(...applied.notes)
      const notes = allNotes
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan: { ...plan, slides },
          title: sessionStorage.getItem('deck_title') || 'SKELAR Presentation',
          replaces: deckId,
        }),
      })
      const text = await res.text()
      const data = text.trim() ? JSON.parse(text) : {}
      if (!res.ok) throw new Error(data.error ?? `Помилка перезбирання (${res.status})`)

      sessionStorage.setItem('deck_url', data.url)
      sessionStorage.setItem('deck_id', data.presentationId)
      if (data.plan) sessionStorage.setItem('deck_plan', JSON.stringify(data.plan))
      if (data.validation) sessionStorage.setItem('deck_validation', JSON.stringify(data.validation))
      if (data.deckFacts) sessionStorage.setItem('deck_facts', JSON.stringify(data.deckFacts))

      setUrl(data.url)
      setDeckId(data.presentationId)
      setPlan(data.plan ?? null)
      setValidation(data.validation ?? null)
      setDeckFacts(data.deckFacts ?? null)
      setFixNotes(notes)
      setLeftOver((data.validation?.overloads ?? []).filter((o: SlideOverload) => !o.accepted).length)
      setRepairDone(true)
    } catch (e: unknown) {
      setFixError(e instanceof Error ? e.message : 'Невідома помилка')
    } finally {
      setFixing(false)
      setFixStage('')
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl space-y-8 text-center">
        <div className="space-y-2">
          <div className="text-5xl">{overallPass ? '✅' : '❌'}</div>
          <h1 className="text-2xl font-semibold">Презентацію створено</h1>
        </div>

        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full py-4 rounded-xl bg-[#FD3433] text-white font-medium hover:bg-[#e02e2d] transition-colors"
          >
            Відкрити презентацію →
          </a>
        )}

        {/* The deck is finished and open above this line. Whatever happens here is an offer,
            never a gate: a person who does not care about the small type on slide 7 already
            has what they came for. */}
        {canRepair && !repairDone && (
          <OverloadPanel
            overloads={overloads}
            acceptedCount={accepted.length}
            fixing={fixing}
            stage={fixStage}
            splittable={splittable}
            worstCut={o => worstCutFor(o.slideIndex, [...o.slots].sort((a, b) => b.cutPct - a.cutPct)[0].slot)}
            error={fixError}
            notes={fixNotes}
            onFix={handleFix}
          />
        )}

        {repairDone && <RepairSummary notes={fixNotes} leftOver={leftOver} />}

        {/* Both panels are development instruments, not something the person who asked for
            a deck needs to read: they speak in element ids, pixel heights and check names.
            Folded away by default so they stay one click from whoever wants them and out of
            everyone else's way. Closed on every visit deliberately — a panel that remembers
            being open would be back to greeting every user with a wall of diagnostics.
            Absent entirely on a clean deck: an always-present "technical details" line is
            still the validator greeting someone who has no question. */}
        {hasOtherFails && (
          <details className="text-left group">
            <summary className="cursor-pointer list-none text-xs text-[#A2A6B1] hover:text-white transition-colors select-none">
              <span className="inline-block transition-transform group-open:rotate-90">›</span>{' '}
              Технічні деталі
              {!overallPass && <span className="ml-2 text-[#FD3433]">є зауваження</span>}
            </summary>
            <div className="mt-4 space-y-6">
              {deckFacts && <DeckFactsPanel report={deckFacts} />}
              {validation && !validation.pass && (
                <ValidationDetails slides={validation.slides} />
              )}
            </div>
          </details>
        )}

        <div className="flex gap-3">
          <button
            onClick={() => router.push('/')}
            className="flex-1 py-3 rounded-xl border border-[#292D39] text-[#A2A6B1] text-sm hover:border-[#A2A6B1] hover:text-white transition-colors"
          >
            ← Назад
          </button>
          <button
            onClick={() => { sessionStorage.clear(); router.push('/') }}
            className="flex-1 py-3 rounded-xl border border-[#292D39] text-[#A2A6B1] text-sm hover:border-[#A2A6B1] hover:text-white transition-colors"
          >
            Нова презентація
          </button>
        </div>
      </div>
    </main>
  )
}

// ─── Overloaded slides: the one screen a non-technical person is meant to read ──
// Everything here is a number measured from the finished file, restated in the terms the
// decision is actually about — how many slides, or how much text would have to go. No check
// names, no slot names, no pixels: those live one fold below, for whoever wants them.
//
// "Розкласти" is preselected because it is the only option that loses nothing (see
// docs/rules/typography.md) — but it is a default, not a verdict, and the deck above is
// already usable if the person closes the tab instead.
// What the repair actually did, once and for good. Shown instead of the panel rather than
// beside it: re-offering the slides that are still tight is what produced the loop, and a
// person who has already answered should be looking at their deck, not at the same question.
function RepairSummary({ notes, leftOver }: { notes: string[]; leftOver: number }) {
  return (
    <div className="text-left border border-[#292D39] rounded-xl p-5 space-y-3">
      <p className="text-white font-medium">Виправлено</p>
      {notes.length > 0 && (
        <div className="text-sm text-[#A2A6B1] space-y-1">
          {notes.map(n => <p key={n}>{n}</p>)}
        </div>
      )}
      {leftOver > 0 && (
        <p className="text-sm text-[#A2A6B1] border-t border-[#292D39] pt-3">
          {leftOver} {leftOver === 1 ? 'слайд лишився' : 'слайдів лишилось'} із дрібним шрифтом —
          виправити автоматично не вдалося. Це видно в самій презентації; якщо заважає,
          найнадійніше правити текст у ТЗ.
        </p>
      )}
    </div>
  )
}

function OverloadPanel({
  overloads, acceptedCount, fixing, stage, error, notes, splittable, worstCut, onFix,
}: {
  overloads: SlideOverload[]
  acceptedCount: number
  fixing: boolean
  stage: string
  error: string
  notes: string[]
  splittable: Set<number>
  worstCut: (o: SlideOverload) => number
  onFix: (decisions: Map<number, Decision>) => void
}) {
  // Splitting loses nothing at all, so it is the default wherever it can work. Where it
  // cannot, the default falls to shortening rather than to an option that would fail the
  // moment it is accepted.
  const initial = () => new Map<number, Decision>(
    overloads.map(o => [o.slideIndex, splittable.has(o.slideIndex) ? 'split' : 'shorten']),
  )
  const [decisions, setDecisions] = useState<Map<number, Decision>>(initial)

  // Re-armed whenever a rebuild returns a different set of slides: the previous answers were
  // about slides that no longer exist under those numbers.
  useEffect(() => {
    setDecisions(initial())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overloads])

  function choose(idx: number, decision: Decision) {
    setDecisions(prev => new Map(prev).set(idx, decision))
  }

  const count = overloads.length
  const word = count === 1 ? 'слайд' : count < 5 ? 'слайди' : 'слайдів'
  const toDo = [...decisions.values()].filter(d => d !== 'keep').length

  return (
    <div className="text-left border border-[#3B404C] rounded-xl p-5 space-y-4">
      <div className="space-y-1">
        <p className="text-white font-medium">
          {count} {word} не вміщує текст читабельним розміром
        </p>
        <p className="text-sm text-[#A2A6B1]">
          Щоб текст влазив, шрифт довелося зменшити нижче за розмір, який читається з екрана.
          Презентація вже готова — це можна виправити, а можна лишити.
        </p>
      </div>

      <div className="space-y-2">
        {overloads.map(o => (
          <div key={o.slideIndex} className="flex items-center justify-between gap-4 py-2 border-t border-[#292D39]">
            <div className="min-w-0">
              <p className="text-sm text-white">Слайд {o.slideIndex + 1}</p>
              <p className="text-xs text-[#A2A6B1]">
                тексту на {o.slidesNeeded} слайди, або зрізати {worstCut(o)}%
              </p>
            </div>
            <div className="flex gap-1 shrink-0">
              {([
                ['split',   `Розкласти на ${o.slidesNeeded}`],
                ['shorten', `Скоротити на ${worstCut(o)}%`],
                ['keep',    'Лишити'],
              ] as [Decision, string][]).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => choose(o.slideIndex, value)}
                  disabled={fixing || (value === 'split' && !splittable.has(o.slideIndex))}
                  title={value === 'split' && !splittable.has(o.slideIndex)
                    ? 'Суцільний текст без переносів — ділити нема на чому'
                    : undefined}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 ${
                    decisions.get(o.slideIndex) === value
                      ? 'border-[#FD3433] text-white'
                      : 'border-[#292D39] text-[#A2A6B1] hover:border-[#A2A6B1]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-[#FD3433]">{error}</p>}

      {notes.length > 0 && (
        <div className="text-xs text-[#A2A6B1] space-y-0.5">
          {notes.map(n => <p key={n}>{n}</p>)}
        </div>
      )}

      <button
        onClick={() => onFix(decisions)}
        disabled={fixing || toDo === 0}
        className="w-full py-3 rounded-xl border border-[#FD3433] text-white text-sm hover:bg-[#FD3433]/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {fixing
          ? (stage || 'Перезбираю презентацію…')
          : toDo === 0
            ? 'Усе лишається як є'
            : `Виправити ${toDo} і перезібрати`}
      </button>
      <p className="text-xs text-[#A2A6B1]">
        Стара версія видаляється тільки після того, як нова успішно зібралась.
        Скорочений текст переписує модель — оригінал із ТЗ лишається в нотатках слайда.
      </p>
      {acceptedCount > 0 && (
        <p className="text-xs text-[#A2A6B1] border-t border-[#292D39] pt-3">
          Ще {acceptedCount} {acceptedCount === 1 ? 'слайд лишено' : 'слайдів лишено'} дрібним
          шрифтом за твоїм рішенням — більше не питаю.
        </p>
      )}
    </div>
  )
}

function formatDeckFacts(report: DeckFactReport): string {
  const lines: string[] = [`Факти з файлу\n${report.pass ? 'PASS' : 'FAIL'}`]
  for (const sf of report.slides.filter(s => s.facts.length > 0)) {
    lines.push(`\n${sf.pass ? '✓' : '✗'} Slide ${sf.slideIndex + 1} [${sf.composition}]`)
    for (const f of sf.facts) {
      if (f.expectedFontSize !== undefined) {
        const match = f.fontSize === f.expectedFontSize
        lines.push(`${match ? '✓' : '✗'} ${f.slotName}: "${f.text}" — ${f.fontSize ?? '?'}pt${!match ? ` (expected ${f.expectedFontSize}pt)` : ''}`)
      } else {
        lines.push(`${f.pass ? '✓' : '✗'} ${f.slotName}: ${f.pass ? `"${f.text}"` : (f.reason ?? 'FAIL')}`)
      }
    }
  }
  return lines.join('\n')
}

function DeckFactsPanel({ report }: { report: DeckFactReport }) {
  const slidesWithFacts = report.slides.filter(s => s.facts.length > 0)
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(formatDeckFacts(report)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="text-left space-y-3 text-xs font-mono border border-[#292D39] rounded-xl p-4">
      <div className="flex items-center justify-between mb-1">
        <p className="text-[#A2A6B1] font-sans text-sm font-medium">Факти з файлу</p>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="text-xs text-[#A2A6B1] hover:text-white transition-colors px-2 py-0.5 rounded border border-[#3B404C] hover:border-[#A2A6B1]"
          >
            {copied ? '✓ скопійовано' : 'copy'}
          </button>
          <span className={`text-xs font-bold ${report.pass ? 'text-green-400' : 'text-red-400'}`}>
            {report.pass ? 'PASS' : 'FAIL'}
          </span>
        </div>
      </div>

      {slidesWithFacts.length === 0 && (
        <p className="text-[#A2A6B1]">Немає бенто або KPI-слайдів для перевірки.</p>
      )}

      {slidesWithFacts.map(sf => (
        <SlideFactRow key={sf.slideIndex} sf={sf} />
      ))}
    </div>
  )
}

function SlideFactRow({ sf }: { sf: SlideDeckFacts }) {
  return (
    <div className="space-y-1">
      <p className={`font-semibold ${sf.pass ? 'text-green-400' : 'text-red-400'}`}>
        {sf.pass ? '✓' : '✗'} Slide {sf.slideIndex + 1} [{sf.composition}]
      </p>
      {sf.facts.map(f => <FactLine key={f.slotName} f={f} />)}
    </div>
  )
}

function FactLine({ f }: { f: DeckFact }) {
  if (f.expectedFontSize !== undefined) {
    // bento font check
    const match = f.fontSize === f.expectedFontSize
    return (
      <p className={`pl-4 ${match ? 'text-[#A2A6B1]' : 'text-red-400'}`}>
        {match ? '✓' : '✗'} {f.slotName}: &quot;{f.text}&quot; — {f.fontSize ?? '?'}pt
        {!match && f.expectedFontSize !== undefined && ` (expected ${f.expectedFontSize}pt)`}
      </p>
    )
  }

  // kpi or content check
  return (
    <p className={`pl-4 ${f.pass ? 'text-[#A2A6B1]' : 'text-red-400'}`}>
      {f.pass ? '✓' : '✗'} {f.slotName}: {f.pass ? `"${f.text}"` : (f.reason ?? 'FAIL')}
    </p>
  )
}

function formatValidation(slides: SlideValidation[]): string {
  const lines: string[] = ['Статичний валідатор (FAILs):']
  for (const sv of slides) {
    lines.push(`\n${sv.pass ? '✅' : '❌'} Slide ${sv.slideIndex + 1} — ${sv.composition}`)
    for (const c of sv.checks.filter(ch => !ch.pass)) {
      lines.push(`  ${c.check}: ${c.detail ?? 'FAIL'}`)
    }
  }
  return lines.join('\n')
}

function ValidationDetails({ slides }: { slides: SlideValidation[] }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(formatValidation(slides)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="text-left space-y-2 text-xs font-mono border border-[#292D39] rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[#A2A6B1]">Статичний валідатор (FAILs):</p>
        <button
          onClick={handleCopy}
          className="text-xs text-[#A2A6B1] hover:text-white transition-colors px-2 py-0.5 rounded border border-[#3B404C] hover:border-[#A2A6B1]"
        >
          {copied ? '✓ скопійовано' : 'copy'}
        </button>
      </div>
      {slides.map(sv => (
        <div key={sv.slideIndex} className="space-y-0.5">
          <p className={`font-semibold ${sv.pass ? 'text-green-400' : 'text-yellow-400'}`}>
            {sv.pass ? '✅' : '❌'} Slide {sv.slideIndex + 1} — {sv.composition}
          </p>
          {sv.checks.filter(c => !c.pass).map(c => (
            <p key={c.check} className="text-red-400 pl-4">
              {c.check}: {c.detail ?? 'FAIL'}
            </p>
          ))}
        </div>
      ))}
    </div>
  )
}
