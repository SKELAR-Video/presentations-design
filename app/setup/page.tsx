'use client'

import { useState } from 'react'

export default function SetupPage() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ presentationId: string; url: string } | null>(null)
  const [error, setError] = useState('')

  async function handleCreate() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/create-master', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Помилка сервера')
      setResult(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Невідома помилка')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl space-y-8">
        <div className="space-y-2">
          <p className="text-sm font-medium tracking-widest uppercase text-[#A2A6B1]">SKELAR</p>
          <h1 className="text-2xl font-semibold">Налаштування шаблону</h1>
          <p className="text-[#A2A6B1] text-sm">
            Створює новий Google Slides шаблон із 6 слайдів з правильними мітками і плейсхолдерами.
            Запускається один раз.
          </p>
        </div>

        {!result ? (
          <>
            <div className="bg-[#292D39] border border-[#3B404C] rounded-xl p-5 space-y-3 text-sm">
              <p className="font-medium">Що буде створено:</p>
              <ul className="text-[#A2A6B1] space-y-1 list-disc list-inside">
                <li>Cover — обкладинка</li>
                <li>Title + Body — заголовок і текст</li>
                <li>Two Columns — дві колонки</li>
                <li>Three Columns — три колонки</li>
                <li>KPI Cards — метрики (4 картки)</li>
                <li>Section — перебивочний слайд (темний)</li>
                <li>Section Red — перебивочний слайд (червоний)</li>
                <li>Closing — фінальний слайд</li>
              </ul>
              <p className="text-[#A2A6B1] text-xs pt-2">
                Кожен слайд матиме темний фон SKELAR і токени <code className="text-white">{'{{ЗАГОЛОВОК}}'}</code> тощо.
              </p>
            </div>

            {error && (
              <p className="text-sm text-[#FD3433] bg-[#FD3433]/10 rounded-lg px-4 py-3">{error}</p>
            )}

            <button
              onClick={handleCreate}
              disabled={loading}
              className="w-full py-4 rounded-xl bg-[#FD3433] text-white font-medium hover:bg-[#e02e2d] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Створюю шаблон…' : 'Створити шаблон →'}
            </button>
          </>
        ) : (
          <div className="space-y-6">
            <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-5 space-y-2">
              <p className="text-green-400 font-medium text-sm">✓ Шаблон створено</p>
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white text-sm underline underline-offset-2 break-all"
              >
                Відкрити в Google Slides →
              </a>
            </div>

            <div className="bg-[#FD3433]/10 border border-[#FD3433]/30 rounded-xl p-5 space-y-3 text-sm">
              <p className="font-medium text-[#FD3433]">Крок 1 — виставити скруглення кутів 30px</p>
              <ol className="text-[#A2A6B1] space-y-1 list-decimal list-inside">
                <li>Відкрий шаблон в Google Slides (посилання вище)</li>
                <li>На кожному слайді виділи всі бенто-блоки (темні картки)</li>
                <li>Потягни жовтий ромб у кутку форми — виставив скруглення ~30px</li>
                <li>Повтори для кожного слайду з картками</li>
              </ol>
              <p className="text-[#A2A6B1] text-xs pt-1">
                Це робиться один раз — усі майбутні презентації скопіюють шаблон зі збереженим скругленням.
              </p>
            </div>

            <div className="bg-[#292D39] border border-[#3B404C] rounded-xl p-5 space-y-3 text-sm">
              <p className="font-medium">Крок 2 — оновити .env.local</p>
              <p className="text-[#A2A6B1]">
                Скопіюй цей ID і встав у файл <code className="text-white">.env.local</code> замість старого:
              </p>
              <code className="block bg-[#1a1f2e] rounded-lg px-4 py-3 text-[#FD3433] text-sm break-all select-all">
                MASTER_DECK_ID={result.presentationId}
              </code>
              <p className="text-[#A2A6B1] text-xs">
                Після збереження .env.local — перезапусти сервер (Ctrl+C → npm run dev).
              </p>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
