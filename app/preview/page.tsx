'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

type ThumbnailItem = {
  index: number
  pageId: string
  imageUrl: string
}

export default function PreviewPage() {
  const router = useRouter()
  const carouselRef = useRef<HTMLDivElement>(null)

  const [deckId, setDeckId]           = useState('')
  const [deckUrl, setDeckUrl]         = useState('')
  const [thumbnails, setThumbnails]   = useState<ThumbnailItem[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    const id  = sessionStorage.getItem('draft_deck_id')
    const url = sessionStorage.getItem('deck_url')
    if (!id || !url) { router.push('/'); return }
    setDeckId(id)
    setDeckUrl(url)
    fetchThumbnails(id)
  }, [router])

  async function fetchThumbnails(id: string) {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/thumbnails?deckId=${encodeURIComponent(id)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не вдалося отримати мініатюри')
      setThumbnails(data.thumbnails)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Невідома помилка')
    } finally {
      setLoading(false)
    }
  }

  function scrollTo(index: number) {
    setActiveIndex(index)
    const el = carouselRef.current?.children[index] as HTMLElement | undefined
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }

  function handleDone() {
    router.push('/result')
  }

  return (
    <main className="min-h-screen flex flex-col px-4 py-8 gap-6">
      {/* Header */}
      <div className="flex items-center justify-between max-w-7xl mx-auto w-full">
        <div>
          <p className="text-sm font-medium tracking-widest uppercase text-[#A2A6B1]">SKELAR</p>
          <h1 className="text-2xl font-semibold mt-0.5">Перегляд презентації</h1>
          {!loading && thumbnails.length > 0 && (
            <p className="text-[#A2A6B1] text-sm mt-1">
              {thumbnails.length} {slideWord(thumbnails.length)} · слайд {activeIndex + 1}
            </p>
          )}
        </div>
        <div className="flex gap-3 items-center">
          {deckUrl && (
            <a
              href={deckUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 rounded-xl border border-[#3B404C] text-[#A2A6B1] text-sm hover:border-[#A2A6B1] hover:text-white transition-colors"
            >
              Відкрити в Drive ↗
            </a>
          )}
          <button
            onClick={handleDone}
            className="px-6 py-2 rounded-xl bg-[#FD3433] text-white font-medium hover:bg-[#e02e2d] transition-colors"
          >
            Готово →
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="max-w-7xl mx-auto w-full">
          <p className="text-sm text-[#FD3433] bg-[#FD3433]/10 rounded-lg px-4 py-3">{error}</p>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="flex gap-4 overflow-x-auto pb-4 max-w-7xl mx-auto w-full">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="shrink-0 w-[320px] aspect-video rounded-xl bg-[#1A1F2E] animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Carousel */}
      {!loading && thumbnails.length > 0 && (
        <>
          {/* Main carousel */}
          <div
            ref={carouselRef}
            className="flex gap-4 overflow-x-auto pb-4 max-w-7xl mx-auto w-full snap-x snap-mandatory scroll-smooth"
            style={{ scrollbarWidth: 'thin', scrollbarColor: '#3B404C transparent' }}
          >
            {thumbnails.map((thumb, i) => (
              <button
                key={thumb.pageId}
                onClick={() => scrollTo(i)}
                className={`shrink-0 snap-center relative rounded-xl overflow-hidden ring-2 transition-all ${
                  activeIndex === i ? 'ring-[#FD3433]' : 'ring-transparent hover:ring-[#3B404C]'
                }`}
                style={{ width: 'min(560px, 80vw)', aspectRatio: '16/9' }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={thumb.imageUrl}
                  alt={`Слайд ${i + 1}`}
                  className="w-full h-full object-cover"
                  draggable={false}
                />
                <span className="absolute bottom-2 left-2 bg-black/50 text-white text-xs px-2 py-0.5 rounded-md">
                  {i + 1}
                </span>
              </button>
            ))}
          </div>

          {/* Strip thumbnails (dot-nav) */}
          <div className="flex gap-2 overflow-x-auto pb-2 max-w-7xl mx-auto w-full justify-center">
            {thumbnails.map((thumb, i) => (
              <button
                key={thumb.pageId}
                onClick={() => scrollTo(i)}
                className={`shrink-0 rounded-lg overflow-hidden ring-1 transition-all ${
                  activeIndex === i ? 'ring-[#FD3433] opacity-100' : 'ring-[#3B404C] opacity-50 hover:opacity-80'
                }`}
                style={{ width: 80, aspectRatio: '16/9' }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={thumb.imageUrl}
                  alt={`Слайд ${i + 1}`}
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              </button>
            ))}
          </div>
        </>
      )}

      {/* No slides */}
      {!loading && thumbnails.length === 0 && !error && (
        <p className="text-[#A2A6B1] text-center py-8">Слайдів не знайдено.</p>
      )}
    </main>
  )
}

function slideWord(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return 'слайд'
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'слайди'
  return 'слайдів'
}
