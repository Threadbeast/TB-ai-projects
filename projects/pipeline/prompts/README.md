# RECSYS Pipeline — Prompt Reference

Each prompt file maps 1:1 to a component in the architecture diagram.

## Quick Reference

| Component | Prompt File | Layer | Model Tier | Input | Output |
|---|---|---|---|---|---|
| Quantitative Signals | `layer2/quantitative_signals.md` | 2 | SQL/Python | raw/*.json | aggregated/brand_affinities.json, category_affinities.json, color_profile.json, dod_selectivity.json, satisfaction_trajectory.json |
| Qualitative Extract | `layer2/qualitative_extract.md` | 2 | SQL/Python | raw/*.json | aggregated/qualitative_signals.json |
| Style DNA Synthesis | `layer3/style_dna_synthesis.md` | 3 | Mid (Sonnet) | aggregated/*.json + raw/customer_profile.json | style_profile.md |
| Constraint Assembly | `layer3/constraint_assembly.md` | 3 | Mid (Sonnet) | aggregated/exclusion_list.json, color_profile.json, qualitative_signals.json, customer_profile.json | Constraint set (embedded in style_profile.md) |
| Candidate Pool | `layer3/candidate_pool.md` | 3 | Mid (Sonnet) | aggregated/candidate_inventory.json + style profile | Ranked shortlist of ~50-100 candidates |
| Outfit Builder | `layer4/outfit_builder.md` | 4 | Strong (Opus) | style_profile.md + candidate pool + exclusion_list.json | outfit_recommendations.md |
| Anti-Recommendations | `layer4/anti_recommendations.md` | 4 | Strong (Opus) | style_profile.md + aggregated signals | Anti-rec section of outfit_recommendations.md |

## Layer 2 prompts

These are **reference documentation** for the Python aggregation logic in `aggregate.py`. They're not LLM prompts — they document what each computation does so the pipeline logic is inspectable and auditable.

## Layer 3 prompts

These are **LLM prompts** that Claude Code follows during profile assembly. Read them in order: Style DNA Synthesis first, then Constraint Assembly, then Candidate Pool.

## Layer 4 prompts

These are **LLM prompts** that Claude Code follows during outfit construction. The Outfit Builder is the primary prompt; Anti-Recommendations is a focused sub-task.

## Exemplar

## Inventory

The `pipeline/data/available_inventory.csv` only needs a `barcode` column. The pipeline reads those barcodes, hydrates full product metadata from `odoo_product` via MySQL, then filters to the customer's sizes.

## Exemplar

The gold-standard output to match: `Recsys Replacement Jam/julio-vaquerano-style-profile.md`
