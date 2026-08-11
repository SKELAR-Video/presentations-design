'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react'
import { pickBriefFile } from '@/lib/picker'

export default function HomePage() {
  const router = useRouter()
  // Which account the tool is acting as. Worth showing: the browser can be signed into
  // several Google accounts at once, and only this one's access matters here — a deck the
  // browser opens fine can still be invisible to the tool. Without it on screen there is
  // no way to tell the two apart.
  const { data: session } = useSession()
  // Not restored from localStorage any more. Re-arming last session's URL made sense beside
  // a visible input the person could see and edit; with only the picker left it would leave
  // a file silently selected while the button still reads "choose a brief" — and the name
  // on screen would not be the file about to be generated.
  const [docUrl, setDocUrl] = useState('')
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
    // fetch() rejects only when the request never completed at all — the connection was
    // dropped, not answered with an error. The browser's own wording for that names
    // neither the step nor the cause ("Load failed" in Safari, "Failed to fetch" in
    // Chrome), and this flow makes three calls in a row, so the message that reached the
    // person told them nothing about which one died or what to do next.
    async function post(url: string, body: unknown, label: string): Promise<Response> {
      try {
        return await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (e: unknown) {
        const raw = e instanceof Error ? e.message : String(e)
        throw new Error(
          `${label}: зʼєднання обірвалось (${raw}). ` +
          'Найчастіше це деплой під час запиту або сон комп’ютера — спробуйте ще раз',
        )
      }
    }

    async function safeJson(res: Response, label: string) {
      const text = await res.text()
      if (!text.trim()) throw new Error(`${label}: порожня відповідь сервера (status ${res.status})`)
      try { return JSON.parse(text) } catch {
        throw new Error(`${label}: некоректний JSON (status ${res.status}): ${text.slice(0, 300)}`)
      }
    }

    try {
      // Step 1: fetch content from the link
      const fetchRes = await post('/api/fetch-doc', { url: docUrl }, 'fetch-doc')
      const fetchData = await safeJson(fetchRes, 'fetch-doc')
      if (!fetchRes.ok) throw new Error(fetchData.error ?? 'Не вдалося завантажити документ')
      // Step 2: map to slide plan
      // gslides → 1:1 mode (text preserved verbatim, one slide per source slide)
      // gdoc    → free-form mode (LLM structures freely from the text)
      const is1to1 = fetchData.type === 'gslides'
      const mapRes = await post(
        '/api/map',
        is1to1
          ? { slides: fetchData.slides, theme: 'dark', mode: '1to1' }
          : { text: fetchData.text, theme: 'dark' },
        'map',
      )
      const mapData = await safeJson(mapRes, 'map')
      if (!mapRes.ok) throw new Error(mapData.error ?? 'Помилка аналізу')

      const genRes = await post(
        '/api/generate',
        { plan: mapData.plan, title: 'SKELAR Presentation', briefName: pickedName },
        'generate',
      )
      const genData = await safeJson(genRes, 'generate')
      if (!genRes.ok) throw new Error(genData.error ?? 'Помилка генерації деку')

      sessionStorage.setItem('deck_url', genData.url)
      sessionStorage.setItem('deck_id', genData.presentationId)
      // The plan the generator actually built, not the one sent — it rewrites compositions
      // and adds variant slides, so this is the only version whose slide numbers match the
      // report the result page reads.
      if (genData.plan) sessionStorage.setItem('deck_plan', JSON.stringify(genData.plan))
      sessionStorage.setItem('deck_title', pickedName || 'SKELAR Presentation')
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

        {/* The picker is the only way in now. Pasting a link cannot work under drive.file:
            the app may only open a file the user handed it through Google's own chooser, so
            an arbitrary link resolves to a permission error the person has no way to make
            sense of. The input stayed while the broad scopes did; it goes with them. */}
        <div className="space-y-3">
          <button
            onClick={handlePick}
            disabled={picking || loading}
            className="w-full py-4 rounded-xl border border-[#3B404C] text-white text-sm hover:border-[#A2A6B1] disabled:opacity-50 transition-colors"
          >
            {picking ? 'Відкриваю…' : (pickedName || 'Обрати бриф з Google Drive')}
          </button>
          {pickedName && (
            <p className="text-xs text-[#A2A6B1] text-center">
              натисніть ще раз, щоб обрати інший файл
            </p>
          )}
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
