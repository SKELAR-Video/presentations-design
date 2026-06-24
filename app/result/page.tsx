'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ResultPage() {
  const router = useRouter()
  const [url, setUrl] = useState('')

  useEffect(() => {
    const stored = sessionStorage.getItem('deck_url')
    if (!stored) { router.push('/'); return }
    setUrl(stored)
  }, [router])

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <div className="space-y-2">
          <div className="text-5xl">🎉</div>
          <h1 className="text-2xl font-semibold">Презентацію створено</h1>
          <p className="text-[#A2A6B1] text-sm">
            Вона вже у вашому Google Drive. Відкрийте за посиланням нижче.
          </p>
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

        <div className="flex gap-3">
          <button
            onClick={() => router.push('/plan')}
            className="flex-1 py-3 rounded-xl border border-[#292D39] text-[#A2A6B1] text-sm hover:border-[#A2A6B1] hover:text-white transition-colors"
          >
            ← Назад до плану
          </button>
          <button
            onClick={() => {
              sessionStorage.clear()
              router.push('/')
            }}
            className="flex-1 py-3 rounded-xl border border-[#292D39] text-[#A2A6B1] text-sm hover:border-[#A2A6B1] hover:text-white transition-colors"
          >
            Нова презентація
          </button>
        </div>
      </div>
    </main>
  )
}
