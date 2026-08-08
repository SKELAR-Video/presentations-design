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
  // Source lines of the brief that belong to this slide. Attached per-slide (not by
  // index) so it survives expandPlanWithVariants reordering/duplication, and read by
  // the deck-level content_coverage check to catch silently dropped content.
  fragments?: string[]
  // How many distinct columns the SOURCE sheet actually had (side-by-side blocks with
  // real content). Structure, not text: content_coverage asks "is this line anywhere in
  // the deck", which stays green when three columns are flattened into one. This is what
  // source_columns_covered compares the rendered slide against.
  sourceColumns?: number
  // Slot names whose SOURCE fragment marked its first line as a heading (bigger/bold in
  // the brief). Undefined for Google Docs briefs, which carry no such formatting — there
  // the old heuristic still decides.
  markerSlots?: string[]
  // The mapping model's read of the same question, used when neither the list markup nor
  // the brief's formatting answers it.
  llmMarkers?: string[]
  // What the list's own markup said, per column index, read BEFORE the bullet characters
  // were stripped from the text. Bullets are a signal, not content — they must not reach
  // the slide, but their answer has to survive them.
  signalMarkers?: Record<string, boolean>
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
  // Slot values captured right after variant expansion, BEFORE the render stage rewrites
  // them (number compaction, ПІДПИС de-duplication, …). content_coverage accepts a source
  // line found in either this snapshot or the final slots, so deliberate rewrites don't
  // read as content loss.
  preRenderSlots?: string[]
  // What the mapping stage cost, summed across every call it made — the first pass, any
  // retry, and the section-count probe. Rides on the plan rather than being returned
  // separately so it survives the trip map → browser → generate without changing any
  // signature; the generator is where the deck (and so the row worth logging) exists.
  usage?: { inputTokens: number; outputTokens: number; calls: number; model?: string }
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

// ─── Deck fact report: verified numbers from the actual generated file ────────

export type DeckFact = {
  slotName: string
  text: string            // actual text truncated to 30 chars
  fontSize?: number       // actual fontSize from file (null = shape missing)
  expectedFontSize?: number
  pass: boolean
  reason?: string
}

export type SlideDeckFacts = {
  slideIndex: number
  composition: string
  pass: boolean
  facts: DeckFact[]
}

export type DeckFactReport = {
  pass: boolean
  slides: SlideDeckFacts[]
  summary: string
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
