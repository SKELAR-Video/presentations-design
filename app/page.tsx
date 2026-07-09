'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function HomePage() {
  const router = useRouter()
  const [docUrl, setDocUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit() {
    if (!docUrl.trim()) { setError('Додайте посилання'); return }
    setError('')
    setLoading(true)
    try {
      // Step 1: fetch content from the link
      const fetchRes = await fetch('/api/fetch-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: docUrl }),
      })
      const fetchData = await fetchRes.json()
      if (!fetchRes.ok) throw new Error(fetchData.error ?? 'Не вдалося завантажити документ')
      // Step 2: map to slide plan
      // gslides → 1:1 mode (text preserved verbatim, one slide per source slide)
      // gdoc    → free-form mode (LLM structures freely from the text)
      const is1to1 = fetchData.type === 'gslides'
      const mapRes = await fetch('/api/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          is1to1
            ? { slides: fetchData.slides, theme: 'dark', mode: '1to1' }
            : { text: fetchData.text, theme: 'dark' }
        ),
      })
      const mapData = await mapRes.json()
      if (!mapRes.ok) throw new Error(mapData.error ?? 'Помилка аналізу')

      const genRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: mapData.plan, title: 'SKELAR Presentation' }),
      })
      const genData = await genRes.json()
      if (!genRes.ok) throw new Error(genData.error ?? 'Помилка генерації деку')

      sessionStorage.setItem('deck_url', genData.url)
      if (genData.validation) sessionStorage.setItem('deck_validation', JSON.stringify(genData.validation))
      if (genData.deckFacts) sessionStorage.setItem('deck_facts', JSON.stringify(genData.deckFacts))
      router.push('/result')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Невідома помилка')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl space-y-8">

        {/* Header */}
        <div className="space-y-2">
          <p className="text-sm font-medium tracking-widest uppercase text-[#A2A6B1]">SKELAR</p>
          <h1 className="text-3xl font-semibold">Presentations Design</h1>
          <p className="text-[#A2A6B1]">
            Додайте матеріал — застосунок розкладе його на слайди відповідно до SKELAR-бренду.
          </p>
        </div>

        {/* Link input */}
        <div className="space-y-3">
          <input
            type="url"
            value={docUrl}
            onChange={(e) => { setDocUrl(e.target.value); setError('') }}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="Додай сюди посилання на Google Slides або Google Doc"
            className="w-full rounded-xl bg-[#292D39] border border-[#3B404C] text-white placeholder-[#A2A6B1] px-4 py-4 text-sm focus:outline-none focus:border-[#A2A6B1] transition-colors"
          />
        </div>

        {/* Error */}
        {error && (
          <p className="text-sm text-[#FD3433] bg-[#FD3433]/10 rounded-lg px-4 py-3">{error}</p>
        )}

        {/* Action */}
        <button
          onClick={handleSubmit}
          disabled={loading || !docUrl.trim()}
          className="w-full py-4 rounded-xl bg-[#FD3433] text-white font-medium hover:bg-[#e02e2d] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Аналізую та генерую презентацію…' : 'Згенерувати презентацію →'}
        </button>

      </div>
    </main>
  )
}
