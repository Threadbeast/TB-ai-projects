# Component: Style DNA Synthesis
# Layer: 3 — Profile Assembly
# Model tier: Mid (Sonnet in production, Claude Code for MVP)
# Input: All aggregated/*.json files + raw/customer_profile.json + raw/order_summary.json
# Output: style_profile.md — full customer style profile

---

## Instructions

You are synthesizing a comprehensive style profile for a ThreadBeast customer. Read all the aggregated data files and the raw customer profile, then generate a markdown document matching the structure below.

**Critical rules:**
1. Every claim must cite specific numbers from the data. Never invent statistics.
2. If a data source has 0 records, note it explicitly and explain what signals are missing.
3. Detect style evolution: compare stated preferences (customer profile DayStyle/EveningStyle/DesignStyle) against behavioral data (what they actually rate highly). If they diverge, call it out.
4. The customer's own words (from reviews, feedback fields) are the highest-value signal. Quote them directly.

## Output Structure

Generate the following sections in this order:

### 1. DATA SOURCES INGESTED
Table showing each source, signal count, and what it told you.

| Source | Signal Count | What It Told Us |
|--------|-------------|-----------------|
| Customer Profile | 1 record | Sizing, style preferences, opt-outs |
| Product Ratings | N ratings | Brand & category affinities, color tolerances |
| Box Ratings | N ratings | Satisfaction trajectory |
| DOD Ratings | N swipes | Taste selectivity |
| CS Log Notes | N notes | Behavioral signals |
| Orders | N orders | Recently sent items, total spend |
| Signup Context | 1 record | Motivation for signing up |
| Caller Feedback | N notes | Retention signals |

### 2. THE PERSON
Who is this customer? Synthesize from:
- Demographics: age (from DOB), location (shipping address), height/weight
- Signup motivation (from qualitative_signals.json → signup_reason)
- Plan level and tenure (from order_summary.json → order_count, total_spend)
- Engagement level: Are they a power user? (Come Back Early frequency from CS notes, order frequency)
- Include a reasoning chain explaining your engagement assessment

### 3. STYLE DNA
- **Stated style**: DayStyle, EveningStyle, DesignStyle from customer profile
- **Behavioral style**: What their ratings actually show (top categories, top brands)
- **Evolution**: Are stated and behavioral styles aligned or diverging?
- **ShopAt**: Where they shop (style context clues)
- Include a reasoning chain connecting stated → behavioral → evolution

### 4. COLOR PROFILE
- Safe colors: Infer from "Just Right" rated items (look at item descriptions/brands for color patterns)
- Dealbreaker colors: From too_loud_items list
- Color tolerance ratio and what it means for this customer
- If too_loud_ratio > 0.05: this is a color-sensitive customer — flag it prominently
- Include a reasoning chain with specific Too Loud examples

### 5. SIZING & FIT
- All sizes from customer profile (Top, Waist, Inseam, Shoe, BottomFit)
- Any fit complaints from reviews (search for size-related review text)
- Any sizing discrepancies or corrections noted in CS notes

### 6. BRAND AFFINITIES
Organize into tiers using brand_affinities.json:
- **LOVE (4.5+ avg, 3+ items)**: List with avg rating and item count
- **LIKE (4.0-4.49 avg)**: List with avg rating and item count
- **AVOID (<3.0 avg or explicit negative feedback)**: List with evidence

### 7. CATEGORY AFFINITIES
Organize into tiers using category_affinities.json:
- **LOVES (4.5+ avg)**: Category, avg rating, item count
- **LIKES (4.0-4.49)**: Category, avg rating, item count
- **NEUTRAL/MIXED (3.5-3.99)**: Category, avg rating, item count — note why it's mixed
- Include the mapped Odoo category name for inventory matching

### 8. EXPLICIT OPT-OUTS
From qualitative_signals.json → opt_outs field. List everything the customer has explicitly said they don't want.

### 9. QUALITATIVE VOICE
Direct quotes from the customer's reviews, organized by sentiment:
- 5-star quotes (what they love and why)
- 1-2 star quotes (what they hate and why)
- Synthesize: what does this customer value? (e.g., versatility, date-readiness, comfort, quality)

### 10. SATISFACTION TRAJECTORY
From satisfaction_trajectory.json:
- Recent trend direction
- Last 3-5 box ratings with value and style accuracy
- Overall avg vs recent avg
- What does the trajectory tell us about whether we're getting it right?

## Formatting

- Use markdown headers (##, ###)
- Include reasoning chains as blockquotes (> **Reasoning chain**: ...)
- Tables for structured data
- Keep it detailed but scannable
- Reference the Julio Vaquerano profile (in Recsys Replacement Jam/julio-vaquerano-style-profile.md) as the structural exemplar
