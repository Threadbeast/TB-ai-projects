# Component: Qualitative Extract
# Layer: 2 — Pre-Aggregation
# Model tier: None (SQL + Python extraction)
# Input: raw/product_ratings.json, raw/cs_notes.json, raw/customer_profile.json, raw/signup_context.json, raw/caller_feedback.json
# Output: aggregated/qualitative_signals.json

---

This component pulls all free-text signals into one structured file. No summarization — raw text preserved for the LLM to interpret in Layer 3.

## What Gets Extracted

### Reviews (from product_ratings)
- Only non-empty Review fields
- Includes context: rating, brand, category
- These are the customer's own words — highest-value qualitative signal

### CS Notes (from cslognotes)
- Full CsLogNoteData text
- Includes date and staff name
- Look for behavioral patterns: "Come Back Early", "Loyalty Package", "Upgrade", "Downgrade", "Pause"

### Caller Feedback (from callerFeedback)
- Call notes from retention/cancel calls
- Includes structured cancel reason flags (Money, DidntLikePackage, Shipping, MISC)
- Whether customer was saved

### Customer Profile Fields
- OptOutNote: explicit opt-outs (e.g., "No boxers or socks")
- LikesNote: what they say they like
- CustNote: internal notes
- Feedback: general feedback field
- Notes: additional notes

### Signup Context
- SignupReason: why they signed up (e.g., "Building confidence")
- Brands: brands selected at signup
