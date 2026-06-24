'use client'

import { useState } from 'react'
import type { Slide, Theme } from '@/lib/types'
import { PHASE0_COMPOSITIONS, getComposition, getTextSlots } from '@/lib/compositions'

type Props = {
  slide: Slide
  index: number
  theme: Theme
  onUpdate: (slide: Slide) => void
  onChangeComposition: (compositionId: string) => void
  onRemove: () => void
}

export default function SlideCard({ slide, index, theme, onUpdate, onChangeComposition, onRemove }: Props) {
  const [expanded, setExpanded] = useState(true)
  const composition = getComposition(slide.composition)
  const textSlots = composition ? getTextSlots(composition) : []

  function updateSlot(name: string, value: string) {
    onUpdate({ ...slide, slots: { ...slide.slots, [name]: value } })
  }

  function isOverflow(slotName: string, value: string): boolean {
    const slotDef = textSlots.find((s) => s.name === slotName)
    if (!slotDef?.max_chars) return false
    return value.length > slotDef.max_chars
  }

  const hasOverflow = textSlots.some((s) => isOverflow(s.name, slide.slots[s.name] ?? ''))

  // Only show compositions compatible with current theme
  const availableCompositions = PHASE0_COMPOSITIONS.filter((c) =>
    c.themes.includes(theme) || c.themes.includes('dark')
  )

  return (
    <div
      className={`rounded-xl border transition-colors ${
        hasOverflow ? 'border-[#FD3433]/50' : 'border-[#292D39]'
      } bg-[#292D39]/30`}
    >
      {/* Card header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="text-xs font-medium text-[#A2A6B1] w-6 shrink-0">{index + 1}</span>

        {/* Composition selector */}
        <select
          value={slide.composition}
          onChange={(e) => onChangeComposition(e.target.value)}
          className="bg-[#3B404C] border border-[#3B404C] rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#A2A6B1] flex-1 max-w-xs"
        >
          {availableCompositions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        {hasOverflow && (
          <span className="text-xs text-[#FD3433] bg-[#FD3433]/10 px-2 py-1 rounded-full shrink-0">
            переповнення
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[#A2A6B1] hover:text-white transition-colors text-sm"
          >
            {expanded ? '▲' : '▼'}
          </button>
          <button
            onClick={onRemove}
            className="text-[#A2A6B1] hover:text-[#FD3433] transition-colors text-sm px-1"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Slots */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-[#3B404C]">
          <p className="text-xs text-[#A2A6B1] pt-3 italic">{composition?.when_to_use}</p>
          {textSlots.map((slotDef) => {
            const value = slide.slots[slotDef.name] ?? ''
            const overflow = isOverflow(slotDef.name, value)
            return (
              <div key={slotDef.name} className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-[#A2A6B1]">
                    {slotDef.name}
                    {slotDef.optional && (
                      <span className="ml-1 text-[#3B404C]">опційно</span>
                    )}
                  </label>
                  <span
                    className={`text-xs tabular-nums ${
                      overflow ? 'text-[#FD3433]' : 'text-[#A2A6B1]'
                    }`}
                  >
                    {value.length}/{slotDef.max_chars}
                  </span>
                </div>
                {slotDef.style === 'body' || (slotDef.max_chars && slotDef.max_chars > 80) ? (
                  <textarea
                    value={value}
                    onChange={(e) => updateSlot(slotDef.name, e.target.value)}
                    rows={3}
                    className={`w-full rounded-lg bg-[#292D39] border px-3 py-2 text-sm text-white placeholder-[#3B404C] focus:outline-none resize-none transition-colors ${
                      overflow ? 'border-[#FD3433]/60 focus:border-[#FD3433]' : 'border-[#3B404C] focus:border-[#A2A6B1]'
                    }`}
                  />
                ) : (
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => updateSlot(slotDef.name, e.target.value)}
                    className={`w-full rounded-lg bg-[#292D39] border px-3 py-2 text-sm text-white placeholder-[#3B404C] focus:outline-none transition-colors ${
                      overflow ? 'border-[#FD3433]/60 focus:border-[#FD3433]' : 'border-[#3B404C] focus:border-[#A2A6B1]'
                    }`}
                  />
                )}
                {overflow && slotDef.max_chars && (
                  <p className="text-xs text-[#FD3433]">
                    Перевищено ліміт на {value.length - slotDef.max_chars} символів. Скоротіть текст або оберіть іншу композицію.
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
