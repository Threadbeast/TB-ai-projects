# Component: Candidate Pool
# Layer: 3 — Profile Assembly
# Model tier: Mid (Sonnet in production, Claude Code for MVP)
# Input: aggregated/candidate_inventory.json + style profile (from Style DNA Synthesis) + constraint set (from Constraint Assembly)
# Output: Ranked shortlist of ~50-100 top candidates with signal scores

---

## Instructions

From the pre-filtered candidate inventory, rank items by how many positive signals they stack. The goal is to reduce ~200-300 candidates down to ~50-100 top picks that Layer 4 can assemble into outfits.

## Positive Signal Stacking

Score each candidate item by counting how many of these signals it matches:

| Signal | Strength | How to Check |
|---|---|---|
| **Top-rated brand** (LOVE tier, 4.5+ avg) | Strong | item.product_brand in LOVE brands |
| **Liked brand** (LIKE tier, 4.0-4.49) | Moderate | item.product_brand in LIKE brands |
| **Top-rated category** (LOVES tier, 4.5+ avg) | Strong | item.product_category or product_subcategory maps to a LOVES feedback category |
| **Liked category** (LIKES tier, 4.0-4.49) | Moderate | same mapping |
| **Safe color** (in customer's "Just Right" pattern) | Moderate | item.product_color matches known safe colors |
| **Style alignment** (matches evolved style direction) | Moderate | judgment call based on style DNA |
| **Neutral/earth-tone color** (for color-sensitive customers) | Moderate | item.product_color is Black, Navy, Grey, Charcoal, Olive, Brown, Cream, etc. |

### Scoring
- 3+ strong/moderate signals = **top candidate**
- 2 signals = **good candidate**
- 1 signal = **possible filler** (only if needed for variety)
- 0 signals = **skip**

## Category-Odoo Mapping

Use this mapping to match feedback categories (from affinities) to inventory categories:

| Feedback Category | Odoo Category | Odoo product_subcategory (finer match) |
|---|---|---|
| Tee, LS Tee, Polo, Crew, Thermal, Tanks | Shirts | Check product_subcategory for finer match |
| Jacket, Hoodie, Flannel | Outerwear | Check product_subcategory |
| Denim Jean, Shorts, Sweatpants, Joggers, Chinos, Pants | Bottoms | Check product_subcategory |
| Button Down | Wovens | — |
| Hat, Beanie, etc. | Accessories | Check product_subcategory |
| Shoes, Slides | Shoes | — |

## Output Format

Produce a ranked list organized by category (for outfit assembly convenience):

```
TOP CANDIDATES (3+ signals):
  Shirts: [item1, item2, ...]
  Outerwear: [item1, ...]
  Bottoms: [item1, ...]
  ...

GOOD CANDIDATES (2 signals):
  Shirts: [item1, ...]
  ...
```

Each item should include: name, barcode, brand, category/subcategory, color, size, image URL, msrp, and which signals it matched.
