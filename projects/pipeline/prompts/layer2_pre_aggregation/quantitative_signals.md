# Component: Quantitative Signals
# Layer: 2 — Pre-Aggregation
# Model tier: None (SQL + Python computation)
# Input: raw/product_ratings.json, raw/box_ratings.json, raw/dod_summary.json
# Output: aggregated/brand_affinities.json, category_affinities.json, color_profile.json, dod_selectivity.json, satisfaction_trajectory.json

---

This component computes all numerical/structured signals from the raw data. It runs as Python code in `aggregate.py`, not as an LLM call.

## Computations

### Brand Affinities (`brand_affinities.json`)
- Group product ratings by Brand
- Compute average rating per brand
- **Minimum 3 items** to qualify (avoids noisy single-item brands)
- Sort by avg_rating descending
- Include rating distribution (count of 1s, 2s, 3s, 4s, 5s)

### Category Affinities (`category_affinities.json`)
- Group product ratings by Category (feedback category name)
- Include the mapped Odoo category for inventory matching
- No minimum threshold (all categories included)
- Sort by avg_rating descending

### Color Profile (`color_profile.json`)
- Count Color feedback values: "Just Right", "Too Plain", "Too Loud"
- Extract detailed list of Too Loud items (brand, category, rating, image)
- Count Style feedback values: "Love it", "Like it", "Its not me"
- Compute ratios: too_loud_ratio, love_ratio, not_me_ratio

### DOD Selectivity (`dod_selectivity.json`)
- Sum likes and dislikes from DOD swipe data
- Compute like_ratio
- Classify selectivity: <30% = extremely_selective, <40% = very_selective, <50% = selective, 50%+ = moderate

### Satisfaction Trajectory (`satisfaction_trajectory.json`)
- Last 10 box ratings in chronological order
- Compute trend by comparing first-half avg to second-half avg
- Overall avg, recent-5 avg, total boxes rated
