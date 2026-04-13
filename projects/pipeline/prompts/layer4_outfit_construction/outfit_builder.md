# Component: Outfit Builder
# Layer: 4 — Outfit Construction + Rationalization
# Model tier: Strong (Opus in production, Claude Code for MVP)
# Input: style_profile.md + candidate pool (ranked) + aggregated/exclusion_list.json
# Output: outfit_recommendations.md — 5-7 complete outfits with rationalization chains

---

## Instructions

You are building outfit recommendations for a ThreadBeast customer. You have their complete style profile and a ranked pool of candidate items. Construct 5-7 coherent outfits, each with a rationalization chain proving why every item was selected.

**This is not random item selection.** Every outfit must be a wearable, coherent look. Every item must be justified by specific data points from the customer's profile.

## Outfit Structure

Each outfit consists of:
- **1 Top** (required): Tee, Polo, Button Down, Crew, Henley, LS Tee, etc.
- **1 Bottom** (required): Denim Jean, Chinos, Joggers, Shorts, Sweatpants, etc.
- **0-1 Layer** (optional): Jacket, Hoodie, Flannel, Cardigan, etc.
- **0-1 Accessory** (optional): Hat, Beanie, etc. — only if the customer rates accessories well

## The 5-Layer Filter

Apply these filters in order:

### Filter 1: Hard Constraints (binary pass/fail)
- Item barcode NOT in exclusion list (recently sent)
- Item NOT in opted-out categories
- Item is_deleted = false (already handled by inventory CSV)
- Product status = ready, qty > 0 (already handled by inventory CSV)
- Size matches customer (already handled by inventory filtering)

### Filter 2: Negative Signals (strong avoidance)
- Skip items from avoided brands (< 3.0 avg, 3+ items rated)
- If customer is color-sensitive (too_loud_ratio > 0.05): skip bold/bright colored items
- Skip items from categories the customer consistently dislikes (< 3.5 avg, "Its not me" pattern)
- If DesignStyle = "Basic": skip heavily graphic/logo-heavy items

### Filter 3: Positive Signal Stacking
- Prioritize items that stack 3+ positive signals (brand match + category match + color match)
- Use the candidate pool ranking from Layer 3

### Filter 4: Outfit Coherence
- **Color harmony**: Colors within an outfit should work together. Don't pair navy + black unless intentional. Earth tones pair well together. Monochrome (same family, different shades) works.
- **Occasion consistency**: All pieces in an outfit should fit the same context. Don't pair a suede trucker jacket with gym shorts.
- **Seasonal awareness**: Check product_seasonality if available. Don't mix heavy winter pieces with summer shorts.
- **Formality gradient**: All pieces should be roughly the same formality level.

### Filter 5: Variety Across the Set
Across all 5-7 outfits:
- **3+ different top types** (don't make all outfits tee-based)
- **2+ different bottom types** (mix jeans, chinos, joggers)
- **Color palette variation** within the customer's safe zone
- **Occasion variation** (date night, casual everyday, weekend errands, layered/cozy, etc.)
- **Brand diversity**: No single brand in more than 3 of the 7 outfits
- **Price variation**: Mix higher and lower MSRP items

## Rationalization Chain (Required for Every Item)

Every item in every outfit must have a "Why This Works" explanation citing **at least 2 specific data points**. Good rationalizations look like:

✅ "Brixton Bowery Flannel in Brown — Brixton is his 6th highest-rated brand (4.58 avg across 12 items). Flannels rated 4.6 avg with zero misses. Brown is firmly in his color comfort zone. Triple-stack pick."

✅ "Benny Gold Pique SS Polo in Black — His #1 tied category (5.0 avg across 8 items). Black is the safest possible color for a man who flagged 'Too Loud' 8 times. Benny Gold is his most-received favorite brand (4.53 avg, 19 items)."

❌ "Nice jacket in a good color" — too vague, no data points

❌ "Brixton jacket rated 4.58" — only one data point, no outfit context

## Outfit Naming

Give each outfit a short, evocative name that frames the occasion:
- "Date Night in Silver Lake"
- "Weekend Errands"
- "LA Cool"
- "Layered & Cozy"
- "The Upgrade"

The name should reflect the customer's lifestyle context (from The Person section of the profile).

## Output Format

For each outfit:

```markdown
### Outfit N: "Name"
*One-line occasion description*

| Piece | Item | Color | Price | Image |
|-------|------|-------|-------|-------|
| Top | Brand Name Product | Color | $XX | [View](product_front_image_url) |
| Bottom | Brand Name Product | Color | $XX | [View](product_front_image_url) |
| Layer | Brand Name Product | Color | $XX | [View](product_front_image_url) |
| Accessory | Brand Name Product | Color | $XX | [View](product_front_image_url) |

**Total MSRP: $XXX**

**Rationalization:**
1. **[Piece]** — [Why this specific item, citing 2+ data points]
2. **[Piece]** — [Why this specific item]
3. ...
N. **Outfit coherence** — [Why these pieces work together as a look]
```

**Important:** Use the `product_front_image_url` from the candidate inventory JSON for each item. Every item MUST have its image link in the table.

## Verification Checklist

Before finalizing, verify all 6 checks pass:

1. ☐ **Duplicate check**: No recommended barcode appears in the exclusion list
2. ☐ **Size check**: Every item's product_size matches the customer's sizes
3. ☐ **Variety check**: 3+ top types, 2+ bottom types across the set
4. ☐ **Brand diversity**: No brand appears in more than 3 outfits
5. ☐ **Rationalization completeness**: Every item has 2+ data-backed reasons
6. ☐ **Opt-out compliance**: No items from opted-out categories
