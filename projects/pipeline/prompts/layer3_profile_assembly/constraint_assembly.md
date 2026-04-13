# Component: Constraint Assembly
# Layer: 3 — Profile Assembly
# Model tier: Mid (Sonnet in production, Claude Code for MVP)
# Input: aggregated/exclusion_list.json, aggregated/color_profile.json, aggregated/qualitative_signals.json, raw/customer_profile.json
# Output: Constraint set (included as a section in style_profile.md or used internally for Layer 4)

---

## Instructions

Compile the hard rules — non-negotiable guardrails for outfit construction. These are binary pass/fail constraints that Layer 4 must respect absolutely.

## Constraint Categories

### 1. Size Constraints
From customer profile:
- TopSize → must match for all tops
- WaistSize * InseamSize → must match for all bottoms (format: "34*30")
- "O/S" → acceptable for accessories
- ShoeSize → must match for shoes

### 2. Recently Sent Exclusions
From exclusion_list.json:
- List all barcodes from last 5 orders
- These are **hard exclusions** — never recommend an item with a barcode in this list
- Count: {N} barcodes excluded

### 3. Explicit Opt-Outs
From qualitative_signals.json → opt_outs:
- Parse the opt-out text into specific categories/items
- Common patterns: "No boxers or socks", "No graphic tees", "No jerseys"
- Map these to product categories/subcategories that must be excluded

### 4. Color Dealbreakers
From color_profile.json:
- If too_loud_ratio > 0.05 AND too_loud count >= 3: customer is color-sensitive
- List the specific Too Loud items to understand what "loud" means for this person
- Generate a "color avoidance rule" (e.g., "avoid bold/bright colors, stick to earth tones and neutrals")

### 5. Low-Rated Brand Exclusions
From brand_affinities.json:
- Any brand with avg_rating < 3.0 AND 3+ items rated
- These brands have been tried and rejected

### 6. Low-Rated Category Cautions
From category_affinities.json:
- Any category with avg_rating < 3.5 AND 3+ items
- These aren't hard exclusions but should be used sparingly and only with strong positive signals (e.g., right brand + right color)

## Output Format

Compile constraints as a structured list that Layer 4 can reference:

```
HARD CONSTRAINTS (must never violate):
- Size: Top={X}, Bottom={X}*{X}, Accessories=O/S
- Excluded barcodes: [list or count]
- Opted-out categories: [list]
- Color rule: [rule based on Too Loud analysis]
- Avoided brands: [list]

SOFT CONSTRAINTS (prefer to respect):
- Cautious categories: [list with reason]
- Design style preference: [Basic/Bold/Mixed]
```
