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
  // Original input text, stored for verbatim content-integrity validation.
  // Each non-empty slot value must be a line-by-line substring of this text.
  sourceText?: string
  // Number of sheets (аркушів) detected by ___-delimiter parsing.
  // When set, slide count must equal this value (1 sheet = 1 slide invariant).
  sheetCount?: number
  // Per-slide source fragments (lines from the original brief that belong to that slide).
  // Set when hasSheets=true. Used by validatePlan to detect silent content loss.
  fragmentGroups?: string[][]
}

export type CompositionSlot = {
  name: string
  type: 'text' | 'image'
  // ── Content limits ──────────────────────────────────────────────────────────
  max_chars?: number    // hard char limit — enforced by LLM prompt + validator
  // ── Anchored grow-to-fit model ──────────────────────────────────────────────
  // Each free text box has a fixed anchor (top-left) and grows right+down.
  // Truncation (max_chars) is the last resort, not the default.
  anchor?: { x: number; y: number }  // fixed top-left corner, Figma px
  max_w?: number        // max grow width from anchor (Figma px)
  max_h?: number        // max grow height from anchor (Figma px)
  float_after?: string  // name of slot whose bottom-edge this box anchors below
  float_gap?: number    // gap (Figma px) between float target's bottom and this box top
  // ── Presentation style / meta ───────────────────────────────────────────────
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
