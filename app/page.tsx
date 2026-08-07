'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react'
import { pickBriefFile, pickerConfigured } from '@/lib/picker'

export default function HomePage() {
  const router = useRouter()
  // Which account the tool is acting as. Worth showing: the browser can be signed into
  // several Google accounts at once, and only this one's access matters here — a deck the
  // browser opens fine can still be invisible to the tool. Without it on screen there is
  // no way to tell the two apart.
  const { data: session } = useSession()
  const [docUrl, setDocUrl] = useState('')

  useEffect(() => {
    const saved = localStorage.getItem('last_doc_url')
    if (saved) setDocUrl(saved)
  }, [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)
  const [pickedName, setPickedName] = useState('')

  async function handlePick() {
    const token = (session as { accessToken?: string } | null)?.accessToken
    if (!token) { setError('Сесія застаріла — вийдіть і зайдіть знову'); return }
    setPicking(true)
    setError('')
    try {
      const file = await pickBriefFile(token)
      if (!file) return                       // closed without choosing
      setDocUrl(file.url)
      setPickedName(file.name)
      localStorage.setItem('last_doc_url', file.url)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Не вдалося відкрити вибір файлу')
    } finally {
      setPicking(false)
    }
  }

  async function handleSubmit() {
    if (!docUrl.trim()) { setError('Додайте посилання'); return }
    setError('')
    setLoading(true)
    async function safeJson(res: Response, label: string) {
      const text = await res.text()
      if (!text.trim()) throw new Error(`${label}: порожня відповідь сервера (status ${res.status})`)
      try { return JSON.parse(text) } catch {
        throw new Error(`${label}: некоректний JSON (status ${res.status}): ${text.slice(0, 300)}`)
      }
    }

    try {
      // Step 1: fetch content from the link
      const fetchRes = await fetch('/api/fetch-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: docUrl }),
      })
      const fetchData = await safeJson(fetchRes, 'fetch-doc')
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
      const mapData = await safeJson(mapRes, 'map')
      if (!mapRes.ok) throw new Error(mapData.error ?? 'Помилка аналізу')

      const genRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: mapData.plan, title: 'SKELAR Presentation' }),
      })
      const genData = await safeJson(genRes, 'generate')
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

        {/* Choosing the brief. The picker is the path that lets this app hold only
            drive.file: picking a file there grants access to that one file. Pasting a link
            cannot work that way — the app would have to be allowed to read everything to
            resolve an arbitrary link. Both are offered while the broad scopes are still in
            place; the input goes when they do. */}
        <div className="space-y-3">
          {pickerConfigured() && (
            <button
              onClick={handlePick}
              disabled={picking || loading}
              className="w-full py-4 rounded-xl border border-[#3B404C] text-white text-sm hover:border-[#A2A6B1] disabled:opacity-50 transition-colors"
            >
              {picking ? 'Відкриваю…' : (pickedName ? `Обрано: ${pickedName}` : 'Обрати бриф з Google Drive')}
            </button>
          )}
          <input
            type="url"
            value={docUrl}
            onChange={(e) => { setDocUrl(e.target.value); setPickedName(''); localStorage.setItem('last_doc_url', e.target.value); setError('') }}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder={pickerConfigured() ? 'або встав посилання вручну' : 'Додай сюди посилання на Google Slides або Google Doc'}
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

        <div className="flex justify-end items-center gap-3">
          {session?.user?.email && (
            <span className="text-xs text-[#A2A6B1] truncate max-w-[60%]" title={session.user.email}>
              {session.user.email}
            </span>
          )}
          <button
            onClick={() => signOut({ callbackUrl: '/auth/signin' })}
            className="text-xs text-[#A2A6B1] hover:text-white transition-colors shrink-0"
          >
            Вийти з акаунту
          </button>
        </div>

      </div>
    </main>
  )
}
