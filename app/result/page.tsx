'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ValidationReport, SlideValidation } from '@/lib/validator'

export default function ResultPage() {
  const router = useRouter()
  const [url, setUrl]             = useState('')
  const [validation, setValidation] = useState<ValidationReport | null>(null)

  useEffect(() => {
    const stored = sessionStorage.getItem('deck_url')
    if (!stored) { router.push('/'); return }
    setUrl(stored)
    const vRaw = sessionStorage.getItem('deck_validation')
    if (vRaw) { try { setValidation(JSON.parse(vRaw)) } catch { /* ignore */ } }
  }, [router])

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg space-y-8 text-center">
        <div className="space-y-2">
          <div className="text-5xl">{validation ? (validation.pass ? '✅' : '⚠️') : '🎉'}</div>
          <h1 className="text-2xl font-semibold">Презентацію створено</h1>
          {validation && (
            <p className={`text-sm font-medium ${validation.pass ? 'text-green-400' : 'text-yellow-400'}`}>
              {validation.summary}
            </p>
          )}
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

        {validation && !validation.pass && (
          <ValidationDetails slides={validation.slides} />
        )}

        <div className="flex gap-3">
          <button
            onClick={() => router.push('/plan')}
            className="flex-1 py-3 rounded-xl border border-[#292D39] text-[#A2A6B1] text-sm hover:border-[#A2A6B1] hover:text-white transition-colors"
          >
            ← Назад до плану
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

function ValidationDetails({ slides }: { slides: SlideValidation[] }) {
  return (
    <div className="text-left space-y-2 text-xs font-mono border border-[#292D39] rounded-xl p-4">
      <p className="text-[#A2A6B1] mb-3">Звіт валідатора:</p>
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
