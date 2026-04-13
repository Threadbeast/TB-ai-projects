"""
Layer 1: Data Extraction
Runs all SQL queries for a single customer and saves raw JSON to output/{name}/raw/.
Reads barcodes from a static CSV, then hydrates product metadata from odoo_product
and filters to the customer's sizes.
"""

import csv
import json
import os
import re
import sys
from pathlib import Path

from db import get_connection, run_query


PIPELINE_DIR = Path(__file__).parent
QUERIES_DIR = PIPELINE_DIR / "queries"
INVENTORY_CSV = PIPELINE_DIR / "data" / "available_inventory.csv"
OUTPUT_DIR = PIPELINE_DIR.parent / "output"


def slugify(name):
    """Convert a customer name to a filesystem-safe directory name."""
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return slug.strip("-")


def load_sql(filename):
    """Read a .sql file from the queries directory."""
    with open(QUERIES_DIR / filename) as f:
        return f.read()


def extract_customer(email):
    """
    Run all queries for a customer email.
    Returns (customer_name_slug, results_dict).
    """
    results = {}

    with get_connection() as conn:
        # 1. Customer profile (run first to get sizing info)
        sql = load_sql("01_customer_profile.sql").replace("{email}", email)
        rows = run_query(conn, sql)
        if not rows:
            print(f"ERROR: No customer found with email '{email}'")
            sys.exit(1)
        results["customer_profile"] = rows
        customer = rows[0]
        name = customer.get("Name", "unknown")
        print(f"\nCustomer: {name} (ID: {customer.get('ID')})")
        print(f"  Sizes: Top={customer.get('TopSize')}, "
              f"Waist={customer.get('WaistSize')}, "
              f"Inseam={customer.get('InseamSize')}, "
              f"Shoe={customer.get('ShoeSize')}")

        # 1b. Order summary (replaces Intercom total_spend/total_packages)
        sql = load_sql("01b_order_summary.sql").replace("{email}", email)
        results["order_summary"] = run_query(conn, sql)

        # 2. Product ratings
        sql = load_sql("02_product_ratings.sql").replace("{email}", email)
        results["product_ratings"] = run_query(conn, sql)

        # 3. Box ratings
        sql = load_sql("03_box_ratings.sql").replace("{email}", email)
        results["box_ratings"] = run_query(conn, sql)

        # 4. DOD summary (aggregate like/dislike counts)
        sql = load_sql("04_dod_summary.sql").replace("{email}", email)
        results["dod_summary"] = run_query(conn, sql)

        # 4b. DOD detail (swipes joined to product metadata for brand/color/category breakdown)
        sql = load_sql("04b_dod_detail.sql").replace("{email}", email)
        results["dod_detail"] = run_query(conn, sql)

        # 5. CS notes
        sql = load_sql("05_cs_notes.sql").replace("{email}", email)
        results["cs_notes"] = run_query(conn, sql)

        # 6. Recent orders
        sql = load_sql("06_recent_orders.sql").replace("{email}", email)
        results["recent_orders"] = run_query(conn, sql)

        # 7. Signup context
        sql = load_sql("07_signup_context.sql").replace("{email}", email)
        results["signup_context"] = run_query(conn, sql)

        # 8. Caller feedback
        sql = load_sql("08_caller_feedback.sql").replace("{email}", email)
        results["caller_feedback"] = run_query(conn, sql)

        # 9. Inventory: read barcodes from CSV, hydrate from odoo_product, filter to sizes
        results["inventory"] = load_inventory_for_customer(conn, customer)

    slug = slugify(name)
    return slug, results


# Customer TopSize → odoo_product.product_size mapping
# The customers table may store full words ("Small") while odoo uses abbreviations ("S")
SIZE_NORMALIZE = {
    "Small": "S",
    "Medium": "M",
    "Large": "L",
    "X-Large": "XL",
    "XX-Large": "2XL",
    "XXX-Large": "3XL",
    "XXXX-Large": "4XL",
    # Already-abbreviated values pass through
}


def normalize_top_size(raw_size):
    """Normalize customer TopSize to odoo_product.product_size format."""
    return SIZE_NORMALIZE.get(raw_size, raw_size)


def load_barcodes_from_csv():
    """Read available barcodes from the static CSV. Only needs a 'barcode' column."""
    if not INVENTORY_CSV.exists():
        return []

    barcodes = []
    with open(INVENTORY_CSV, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            barcode = (row.get("barcode") or row.get("Barcode") or "").strip()
            if barcode:
                barcodes.append(barcode)

    return barcodes


def load_inventory_for_customer(conn, customer):
    """
    1. Read barcodes from the static CSV (just a barcode column)
    2. Query odoo_product for full metadata on those barcodes
    3. Filter results to the customer's sizes
    """
    barcodes = load_barcodes_from_csv()
    if not barcodes:
        print(f"  WARNING: No inventory CSV found at {INVENTORY_CSV}")
        print(f"  Skipping inventory. Place a CSV with a 'barcode' column there and re-run.")
        return []

    print(f"  Hydrating {len(barcodes)} barcodes from odoo_product...")

    # Query in batches to avoid overly long IN clauses
    BATCH_SIZE = 500
    all_products = []
    # Build the query template once (strip comments to avoid pymysql % conflicts)
    raw_sql = load_sql("09_inventory_by_barcodes.sql")
    sql_lines = [l for l in raw_sql.splitlines() if not l.strip().startswith("--")]
    sql_template = "\n".join(sql_lines)

    for i in range(0, len(barcodes), BATCH_SIZE):
        batch = barcodes[i:i + BATCH_SIZE]
        placeholders = ", ".join(["%s"] * len(batch))
        sql = sql_template.replace("{barcodes_list}", placeholders)
        rows = run_query(conn, sql, tuple(batch))
        all_products.extend(rows)

    print(f"  Found {len(all_products)} products in odoo_product (ready + not deleted)")

    # Normalize customer sizes to match odoo_product.product_size format
    top_size_raw = customer.get("TopSize", "")
    top_size = normalize_top_size(top_size_raw)
    waist_size = customer.get("WaistSize", "")
    inseam_size = customer.get("InseamSize", "")
    bottom_size = f"{waist_size}*{inseam_size}" if waist_size and inseam_size else ""

    if top_size != top_size_raw:
        print(f"  Size normalized: '{top_size_raw}' → '{top_size}'")

    matching = []
    for product in all_products:
        size = (product.get("product_size") or "").strip()
        if size in (top_size, bottom_size, "O/S"):
            matching.append(product)

    print(f"  {len(matching)} products match customer sizes "
          f"(Top={top_size}, Bottom={bottom_size}, O/S)")

    return matching


def save_results(slug, results):
    """Save each result set as a JSON file in output/{slug}/raw/."""
    out_dir = OUTPUT_DIR / slug / "raw"
    out_dir.mkdir(parents=True, exist_ok=True)

    for key, data in results.items():
        filepath = out_dir / f"{key}.json"
        with open(filepath, "w") as f:
            json.dump(data, f, indent=2, default=str)

    return out_dir


def print_summary(results):
    """Print a data source summary table."""
    print("\n  Data Sources:")
    print(f"  {'Source':<25} {'Records':>8}  Description")
    print(f"  {'-'*25} {'-'*8}  {'-'*40}")

    sources = [
        ("customer_profile", "Profile, sizing, preferences"),
        ("order_summary", "Order count & total spend"),
        ("product_ratings", "Item ratings, color/style feedback"),
        ("box_ratings", "Box satisfaction, style accuracy"),
        ("dod_summary", "DOD like/dislike aggregate"),
        ("dod_detail", "DOD swipes with brand/color/category detail"),
        ("cs_notes", "CS admin notes, behavioral signals"),
        ("recent_orders", "Last 5 orders with item barcodes"),
        ("signup_context", "Signup reason & brand preferences"),
        ("caller_feedback", "Retention call notes & outcomes"),
        ("inventory", "Available products in customer sizes"),
    ]

    total = 0
    for key, desc in sources:
        count = len(results.get(key, []))
        total += count
        print(f"  {key:<25} {count:>8}  {desc}")

    print(f"  {'-'*25} {'-'*8}")
    print(f"  {'TOTAL':<25} {total:>8}")


def main():
    if len(sys.argv) < 2:
        print("Usage: python extract.py <customer_email>")
        sys.exit(1)

    email = sys.argv[1]
    print(f"Extracting data for: {email}")

    slug, results = extract_customer(email)
    out_dir = save_results(slug, results)
    print_summary(results)
    print(f"\n  Raw data saved to: {out_dir}")
    return slug


if __name__ == "__main__":
    main()
