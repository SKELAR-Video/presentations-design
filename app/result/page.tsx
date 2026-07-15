'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ValidationReport, SlideValidation } from '@/lib/validator'
import type { DeckFactReport, SlideDeckFacts, DeckFact } from '@/lib/types'

export default function ResultPage() {
  const router = useRouter()
  const [url, setUrl]               = useState('')
  const [validation, setValidation] = useState<ValidationReport | null>(null)
  const [deckFacts, setDeckFacts]   = useState<DeckFactReport | null>(null)

  useEffect(() => {
    const stored = sessionStorage.getItem('deck_url')
    if (!stored) { router.push('/'); return }
    setUrl(stored)
    const vRaw = sessionStorage.getItem('deck_validation')
    if (vRaw) { try { setValidation(JSON.parse(vRaw)) } catch { /* ignore */ } }
    const fRaw = sessionStorage.getItem('deck_facts')
    if (fRaw) { try { setDeckFacts(JSON.parse(fRaw)) } catch { /* ignore */ } }
  }, [router])

  const overallPass = deckFacts ? deckFacts.pass : (validation?.pass ?? true)

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

        {/* Deck facts: real numbers from the file */}
        {deckFacts && <DeckFactsPanel report={deckFacts} />}

        {/* Static validator results (shown only when there are failures) */}
        {validation && !validation.pass && (
          <ValidationDetails slides={validation.slides} />
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
