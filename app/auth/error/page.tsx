'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

function ErrorContent() {
  const params = useSearchParams()
  const error = params.get('error')

  const messages: Record<string, string> = {
    AccessDenied: 'Доступ заборонено. Цей інструмент лише для @skelar.tech акаунтів.',
    Configuration: 'Помилка конфігурації сервера.',
    Default: 'Помилка авторизації.',
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6 text-center">
        <h1 className="text-2xl font-semibold text-[#FD3433]">Помилка входу</h1>
        <p className="text-[#A2A6B1] text-sm">
          {messages[error ?? 'Default'] ?? messages.Default}
        </p>
        <a
          href="/auth/signin"
          className="block w-full py-3 rounded-xl border border-[#292D39] text-[#A2A6B1] text-sm hover:border-[#A2A6B1] hover:text-white transition-colors"
        >
          Спробувати знову
        </a>
      </div>
    </main>
  )
}

export default function ErrorPage() {
  return (
    <Suspense>
      <ErrorContent />
    </Suspense>
  )
}
