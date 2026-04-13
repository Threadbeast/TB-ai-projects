# RECSYS MVP Pipeline

LLM-powered style profile and outfit recommendation pipeline for ThreadBeast. Uses SQL for data extraction (Layers 1-2) and Claude Code CLI for reasoning (Layers 3-4).

Data is read from BigQuery (`threadbeast-warehouse.threadbeast_mysql`), which
mirrors the production MySQL schema — all table and column names are unchanged.

## Setup

```bash
cd pipeline
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Copy `config.example.py` to `config.py` (the defaults point at the
`threadbeast-warehouse.threadbeast_mysql` dataset — adjust only if needed).

Authenticate once with Application Default Credentials:

```bash
gcloud auth application-default login
# — or —
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

Place a CSV of available product barcodes at `data/available_inventory.csv` (only needs a `barcode` column — product metadata is pulled from `odoo_product`).

## Smoke Test

```bash
source venv/bin/activate
python3 -c "
from db import get_connection, run_query
with get_connection() as conn:
    print('Connected!')
    row = run_query(conn, 'SELECT COUNT(*) as cnt FROM customers WHERE Status = %s', ['Active'])
    print(f'Active customers: {row[0][\"cnt\"]}')
"
```

The `run_query` helper still accepts MySQL-style `%s` placeholders — they're
translated to BigQuery `@p0, @p1, ...` named parameters under the hood so existing
queries continue to work unchanged.

## Usage

### Find high-signal test customers

```bash
python3 -c "
from db import get_connection, run_query
with get_connection() as conn:
    with open('queries/00_find_customers.sql') as f:
        rows = run_query(conn, f.read())
    for r in rows[:10]:
        print(f'{r[\"Name\"]:30s} {r[\"total_signal\"]:>6} signals  ({r[\"Email\"]})')
"
```

### Run the full pipeline (Layers 1-4)

```bash
source venv/bin/activate
python3 run_customer.py "customer@email.com"
```

This runs everything end-to-end:
1. **Layer 1** — SQL extraction (8 queries + inventory hydration from CSV barcodes)
2. **Layer 2** — Pre-aggregation (brand/category/color/DOD affinities, exclusions, qualitative signals)
3. **Layer 3** — Style profile generation (`claude -p --model sonnet`)
4. **Layer 4** — Outfit recommendations (`claude -p --model opus`)

### Run data only (skip LLM)

```bash
python3 run_customer.py "customer@email.com" --no-llm
```

### Run LLM layers separately

```bash
python3 generate.py <customer-slug>       # both Layer 3 + 4
python3 generate.py <customer-slug> 3     # style profile only
python3 generate.py <customer-slug> 4     # outfits only
```

### Run LLM layers manually (if subprocess hangs)

The pipeline saves assembled prompts to `output/<customer-slug>/_prompt_layer3.md` and `_prompt_layer4.md`. You can pipe these directly:

```bash
cat output/<customer-slug>/_prompt_layer3.md | claude -p --model sonnet > output/<customer-slug>/style_profile.md
cat output/<customer-slug>/_prompt_layer4.md | claude -p --model opus > output/<customer-slug>/outfit_recommendations.md
```

### View profiles in the browser

After running the pipeline for one or more customers, generate the interactive viewer:

```bash
python3 generate_viewer_data.py
open ../output/viewer.html
```

This builds a self-contained HTML page with:
- Profile selector dropdown to switch between customers
- **Style Profile** tab — data source cards, sizing/style cards, color palette, key insights with reasoning chains, brand/category affinity bars, satisfaction trend, anti-recommendations, verification checklist
- **Suggested Outfits** tab — horizontal outfit cards with product images, pricing, and rationalization chains

Re-run `generate_viewer_data.py` after adding new customers to update the viewer.

## File Structure

```
pipeline/
├── config.py              # Your credentials (gitignored)
├── db.py                  # SSH tunnel + MySQL connection
├── extract.py             # Layer 1: SQL queries → raw JSON
├── aggregate.py           # Layer 2: pre-aggregation → compact JSON
├── generate.py            # Layers 3-4: prompt assembly + claude -p calls
├── generate_viewer_data.py # Builds the HTML viewer from output data
├── run_customer.py        # Entry point (runs all layers)
├── queries/               # SQL files (one per data source)
├── data/                  # available_inventory.csv goes here
├── prompts/               # LLM prompt templates by layer/component
└── templates/
    └── viewer.html        # HTML template for the profile viewer

output/
├── viewer.html            # Generated viewer (open in browser)
└── {customer-name}/
    ├── raw/               # Raw query results (JSON)
    ├── aggregated/        # Pre-computed signals (JSON)
    ├── _prompt_layer3.md  # Assembled Layer 3 prompt (for debugging/manual runs)
    ├── _prompt_layer4.md  # Assembled Layer 4 prompt (for debugging/manual runs)
    ├── style_profile.md   # Layer 3 output
    └── outfit_recommendations.md  # Layer 4 output
```

See `prompts/README.md` for the full component-to-prompt mapping.

## Docker build

The `Dockerfile` in this directory mirrors the README flow end-to-end:

1. `pip install -r requirements.txt`
2. `cp config.example.py config.py`
3. For each email in `customers.txt`: `python3 run_customer.py <email>`
4. `python3 generate_viewer_data.py`
5. Serve the resulting `viewer.html` via nginx on port 80.

Before building, populate:

- `customers.txt` in this directory — one email per line (comments with `#`).
- `gcloud auth application-default login` — BigQuery auth via your own account
  (compose reads `~/.config/gcloud/application_default_credentials.json`
  automatically).
- `<repo-root>/secrets/anthropic-api-key.txt` — Anthropic API key.

Then from the repo root:

```bash
docker compose build pipeline
docker compose up -d
```

Secrets are mounted into the build via BuildKit `--mount=type=secret` and are
never baked into image layers.
