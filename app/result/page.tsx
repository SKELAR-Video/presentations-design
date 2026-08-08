'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ValidationReport, SlideValidation, SlideOverload } from '@/lib/validator'
import type { DeckFactReport, SlideDeckFacts, DeckFact, SlidePlan } from '@/lib/types'
import { applySplits } from '@/lib/split'

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
  const overloads = validation?.overloads ?? []
  // The repair needs the plan whose slide numbers match the report. Without it the panel
  // could still describe the problem but could not act on it, and a button that cannot keep
  // its promise is worse than no button.
  const canRepair = Boolean(plan && deckId && overloads.length > 0)

  async function handleFix(chosen: Set<number>) {
    if (!plan || !deckId) return
    setFixing(true)
    setFixError('')
    setFixNotes([])
    try {
      const { slides, notes } = applySplits(plan.slides, overloads, chosen)
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
    } catch (e: unknown) {
      setFixError(e instanceof Error ? e.message : 'Невідома помилка')
    } finally {
      setFixing(false)
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
        {canRepair && (
          <OverloadPanel
            overloads={overloads}
            fixing={fixing}
            error={fixError}
            notes={fixNotes}
            onFix={handleFix}
          />
        )}

        {/* Both panels are development instruments, not something the person who asked for
            a deck needs to read: they speak in element ids, pixel heights and check names.
            Folded away by default so they stay one click from whoever wants them and out of
            everyone else's way. Closed on every visit deliberately — a panel that remembers
            being open would be back to greeting every user with a wall of diagnostics.
            Absent entirely on a clean deck: an always-present "technical details" line is
            still the validator greeting someone who has no question. */}
        {!overallPass && (deckFacts || (validation && !validation.pass)) && (
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
function OverloadPanel({
  overloads, fixing, error, notes, onFix,
}: {
  overloads: SlideOverload[]
  fixing: boolean
  error: string
  notes: string[]
  onFix: (chosen: Set<number>) => void
}) {
  const [split, setSplit] = useState<Set<number>>(
    () => new Set(overloads.map(o => o.slideIndex)),
  )

  // Re-armed whenever a rebuild returns a different set of slides: the previous answers were
  // about slides that no longer exist under those numbers.
  useEffect(() => {
    setSplit(new Set(overloads.map(o => o.slideIndex)))
  }, [overloads])

  function toggle(idx: number, wantSplit: boolean) {
    setSplit(prev => {
      const next = new Set(prev)
      if (wantSplit) next.add(idx); else next.delete(idx)
      return next
    })
  }

  const count = overloads.length
  const word = count === 1 ? 'слайд' : count < 5 ? 'слайди' : 'слайдів'

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
                тексту на {o.slidesNeeded} слайди, або зрізати {Math.max(...o.slots.map(s => s.cutPct))}%
              </p>
            </div>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => toggle(o.slideIndex, true)}
                disabled={fixing}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 ${
                  split.has(o.slideIndex)
                    ? 'border-[#FD3433] text-white'
                    : 'border-[#292D39] text-[#A2A6B1] hover:border-[#A2A6B1]'
                }`}
              >
                Розкласти на {o.slidesNeeded}
              </button>
              <button
                onClick={() => toggle(o.slideIndex, false)}
                disabled={fixing}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 ${
                  !split.has(o.slideIndex)
                    ? 'border-[#FD3433] text-white'
                    : 'border-[#292D39] text-[#A2A6B1] hover:border-[#A2A6B1]'
                }`}
              >
                Лишити
              </button>
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
        onClick={() => onFix(split)}
        disabled={fixing || split.size === 0}
        className="w-full py-3 rounded-xl border border-[#FD3433] text-white text-sm hover:bg-[#FD3433]/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {fixing
          ? 'Перезбираю презентацію…'
          : split.size === 0
            ? 'Нічого не обрано'
            : `Розкласти ${split.size} і перезібрати`}
      </button>
      <p className="text-xs text-[#A2A6B1]">
        Стара версія видаляється тільки після того, як нова успішно зібралась.
      </p>
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
