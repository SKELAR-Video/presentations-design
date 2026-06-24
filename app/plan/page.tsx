'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import type { SlidePlan, Slide, Theme } from '@/lib/types'
import { PHASE0_COMPOSITIONS, getComposition } from '@/lib/compositions'
import SlideCard from '@/components/SlideCard'

export default function PlanPage() {
  const router = useRouter()
  const [plan, setPlan] = useState<SlidePlan | null>(null)
  const [title, setTitle] = useState('SKELAR Presentation')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const raw = sessionStorage.getItem('deck_plan')
    if (!raw) { router.push('/'); return }
    try { setPlan(JSON.parse(raw)) } catch { router.push('/') }
  }, [router])

  function updateSlide(index: number, updated: Slide) {
    if (!plan) return
    const slides = [...plan.slides]
    slides[index] = updated
    setPlan({ ...plan, slides })
  }

  function changeComposition(index: number, newCompId: string) {
    if (!plan) return
    const comp = getComposition(newCompId)
    if (!comp) return
    const slides = [...plan.slides]
    // Keep only slots that exist in the new composition
    const newSlots: Record<string, string> = {}
    for (const slot of comp.slots) {
      newSlots[slot.name] = slides[index].slots[slot.name] ?? ''
    }
    slides[index] = { ...slides[index], composition: newCompId, slots: newSlots, flags: {} }
    setPlan({ ...plan, slides })
  }

  function addSlide() {
    if (!plan) return
    const newSlide: Slide = {
      id: `slide_${Date.now()}`,
      composition: 'title_body',
      slots: { ЗАГОЛОВОК: '', ТЕКСТ: '' },
      flags: {},
    }
    setPlan({ ...plan, slides: [...plan.slides, newSlide] })
  }

  function removeSlide(index: number) {
    if (!plan || plan.slides.length <= 1) return
    const slides = plan.slides.filter((_, i) => i !== index)
    setPlan({ ...plan, slides })
  }

  async function handleGenerate() {
    if (!plan) return
    setError('')
    setGenerating(true)
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, title }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Помилка сервера')
      sessionStorage.setItem('deck_url', data.url)
      router.push('/result')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Невідома помилка')
    } finally {
      setGenerating(false)
    }
  }

  const hasOverflow = plan?.slides.some(
    (s) => s.flags?.overflow && s.flags.overflow.length > 0
  )

  if (!plan) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-[#A2A6B1]">Завантаження…</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen px-4 py-12">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <button
              onClick={() => router.push('/')}
              className="text-sm text-[#A2A6B1] hover:text-white mb-2 transition-colors"
            >
              ← Назад
            </button>
            <h1 className="text-2xl font-semibold">План слайдів</h1>
            <p className="text-[#A2A6B1] text-sm mt-1">
              {plan.slides.length} слайдів · тема{' '}
              <span className={plan.theme === 'red' ? 'text-[#FD3433]' : 'text-white'}>
                {plan.theme}
              </span>
            </p>
          </div>
          <div className="shrink-0 space-y-2 text-right">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="bg-[#292D39] border border-[#3B404C] rounded-lg px-3 py-2 text-sm text-white placeholder-[#A2A6B1] focus:outline-none focus:border-[#A2A6B1] w-56"
              placeholder="Назва презентації"
            />
          </div>
        </div>

        {/* Overflow warning */}
        {hasOverflow && (
          <div className="bg-[#FD3433]/10 border border-[#FD3433]/30 rounded-xl px-4 py-3 text-sm text-[#FD3433]">
            Деякі слоти перевищують ліміт символів. Скоротіть текст або оберіть іншу композицію перед генерацією.
          </div>
        )}

        {/* Slide cards */}
        <div className="space-y-4">
          {plan.slides.map((slide, i) => (
            <SlideCard
              key={slide.id ?? i}
              slide={slide}
              index={i}
              theme={plan.theme as Theme}
              onUpdate={(updated) => updateSlide(i, updated)}
              onChangeComposition={(compId) => changeComposition(i, compId)}
              onRemove={() => removeSlide(i)}
            />
          ))}
        </div>

        {/* Add slide */}
        <button
          onClick={addSlide}
          className="w-full py-3 rounded-xl border border-dashed border-[#3B404C] text-[#A2A6B1] text-sm hover:border-[#A2A6B1] hover:text-white transition-colors"
        >
          + Додати слайд
        </button>

        {/* Error */}
        {error && (
          <p className="text-sm text-[#FD3433] bg-[#FD3433]/10 rounded-lg px-4 py-3">{error}</p>
        )}

        {/* Generate */}
        <button
          onClick={handleGenerate}
          disabled={generating || !!hasOverflow}
          className="w-full py-4 rounded-xl bg-[#FD3433] text-white font-medium hover:bg-[#e02e2d] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {generating ? 'Генерую презентацію…' : 'Згенерувати презентацію →'}
        </button>
      </div>
    </main>
  )
}
