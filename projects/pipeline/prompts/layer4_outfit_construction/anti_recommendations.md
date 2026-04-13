# Component: Anti-Recommendations
# Layer: 4 — Outfit Construction
# Model tier: Strong (Opus in production, Claude Code for MVP)
# Input: style_profile.md + aggregated/brand_affinities.json + aggregated/color_profile.json + aggregated/category_affinities.json + aggregated/candidate_inventory.json
# Output: Anti-recommendations section of outfit_recommendations.md

---

## Instructions

Generate an explicit **avoid list**: items currently in stock (in the customer's sizes) that should NOT be sent, even though they technically pass the size filter. This is the "negative profile" — as valuable as the positive one.

Anti-recommendations prevent bad picks and give stylists clear guardrails.

## What to Flag

### Category Avoidance
- Categories with avg_rating < 3.5 (from category_affinities.json)
- Categories in the opt-out list
- Evidence: cite the avg rating, item count, and any negative quotes

### Brand Avoidance
- Brands with avg_rating < 3.0 (from brand_affinities.json) with 3+ items
- Brands the customer has explicitly called out negatively
- Evidence: cite the avg rating, item count

### Color Avoidance
- If customer is color-sensitive (too_loud_ratio > 0.05):
  - List specific color families/styles to avoid
  - Name actual products in inventory that would trigger "Too Loud"
- Evidence: cite Too Loud count and specific examples

### Design Pattern Avoidance
- If DesignStyle = "Basic": flag heavily graphic items
- If customer has "Its not me" on specific design types, note the pattern
- Evidence: cite specific Style feedback data

### Specific Items to Avoid
Scan the candidate inventory for items that are technically available but would be wrong for this customer. For each:
- Name the specific item (brand + product name)
- Explain why it's wrong (which negative signal it triggers)

## Output Format

```markdown
## ANTI-RECOMMENDATIONS
*Items in stock that we should NOT send this customer*

| Item | Why Not |
|------|---------|
| [Specific product name] | [Specific reason with data citation] |
| [Specific product name] | [Specific reason] |
| Any [category] | [Reason, e.g., "avg 3.2 across 8 items, 3 'Its not me' ratings"] |
| Any [color] items | [Reason, e.g., "8 Too Loud flags over 2 years"] |
| [Brand] products | [Reason, e.g., "3.0 avg, commented 'Not my style'"] |
```

Be specific. "Any bold-colored tee" is better than "avoid loud things." Name actual products from the inventory when possible.
