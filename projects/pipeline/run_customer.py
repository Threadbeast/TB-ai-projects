#!/usr/bin/env python3
"""
RECSYS MVP Pipeline — Entry Point
Runs Layers 1-4 for a single customer.

Usage:
    python run_customer.py <customer_email>           # full pipeline (data + LLM)
    python run_customer.py <customer_email> --no-llm  # data only (Layers 1-2)
"""

import sys
import time
from pathlib import Path

# Ensure pipeline/ is on the path so imports work when run from any directory
sys.path.insert(0, str(Path(__file__).parent))

from extract import extract_customer, save_results, print_summary
from aggregate import aggregate_customer
from generate import generate_style_profile, generate_outfit_recommendations


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print("Usage: python run_customer.py <customer_email> [--no-llm]")
        print()
        print("  --no-llm    Only run Layers 1-2 (data extraction + aggregation)")
        print("              Skip Layers 3-4 (LLM profile + outfit generation)")
        print()
        print("Examples:")
        print("  python run_customer.py julio@example.com")
        print("  python run_customer.py julio@example.com --no-llm")
        sys.exit(1)

    email = sys.argv[1]
    skip_llm = "--no-llm" in sys.argv
    start = time.time()

    print("=" * 60)
    print("RECSYS MVP Pipeline" + (" — Layers 1-2 only" if skip_llm else " — Full (Layers 1-4)"))
    print("=" * 60)

    # Layer 1: Extract
    print("\n[Layer 1] Extracting raw data...")
    slug, results = extract_customer(email)
    save_results(slug, results)
    print_summary(results)

    # Layer 2: Aggregate
    print("\n[Layer 2] Pre-aggregating signals...")
    aggregate_customer(slug)

    if skip_llm:
        elapsed = time.time() - start
        print("\n" + "=" * 60)
        print(f"Layers 1-2 complete in {elapsed:.1f}s")
        print(f"Output directory: output/{slug}/")
        print()
        print("To run LLM layers separately:")
        print(f"  python generate.py {slug}       # both layers")
        print(f"  python generate.py {slug} 3     # style profile only")
        print(f"  python generate.py {slug} 4     # outfits only")
        print("=" * 60)
        return

    # Layer 3: Style Profile (claude -p --model sonnet)
    generate_style_profile(slug)

    # Layer 4: Outfit Recommendations (claude -p --model opus)
    generate_outfit_recommendations(slug)

    elapsed = time.time() - start
    print("\n" + "=" * 60)
    print(f"Full pipeline complete in {elapsed:.1f}s")
    print(f"Output directory: output/{slug}/")
    print(f"  style_profile.md          — Layer 3 output")
    print(f"  outfit_recommendations.md — Layer 4 output")
    print("=" * 60)


if __name__ == "__main__":
    main()
