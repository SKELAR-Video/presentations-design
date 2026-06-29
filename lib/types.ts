export type Theme = 'dark' | 'red'

export type SlotFlag = {
  overflow?: string[]
  raw?: Record<string, string>
  needs_image?: boolean
  needs_review?: boolean
}

export type SlideSlots = Record<string, string>

export type Slide = {
  id: string
  composition: string
  theme?: Theme
  slots: SlideSlots
  flags: SlotFlag
}

export type SlidePlan = {
  theme: Theme
  slides: Slide[]
}

export type CompositionSlot = {
  name: string
  type: 'text' | 'image'
  max_chars?: number
  style?: string
  optional?: boolean
  ratio?: string
  role?: string
}

export type Composition = {
  id: string
  name: string
  when_to_use: string
  themes: string[]
  slots: CompositionSlot[]
  variants?: string[]
  // Adaptive layout constraints (kpi_cards only)
  card_min_h?: number  // px — minimum card height
  card_max_h?: number  // px — maximum card height
  gap_min?: number     // px — minimum gap between body text bottom and cards top
}
