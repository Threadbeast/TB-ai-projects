#!/usr/bin/env python3
"""
Generate the style profile viewer HTML.
Scans output/*/ directories, reads structured JSON + markdown,
and embeds everything directly into viewer.html.
"""

import json
import sys
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent.parent / "output"


def read_file(path):
    if path.exists():
        return path.read_text(encoding="utf-8")
    return ""


def read_json_file(path):
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return None


def build_profile(slug_dir):
    slug = slug_dir.name
    raw_dir = slug_dir / "raw"
    agg_dir = slug_dir / "aggregated"

    customer_data = read_json_file(raw_dir / "customer_profile.json")
    customer = customer_data[0] if customer_data else {}

    order_data = read_json_file(raw_dir / "order_summary.json")
    order_summary = order_data[0] if order_data else {}

    product_ratings = read_json_file(raw_dir / "product_ratings.json") or []
    dod_summary = read_json_file(raw_dir / "dod_summary.json") or []
    cs_notes = read_json_file(raw_dir / "cs_notes.json") or []

    brand_aff = read_json_file(agg_dir / "brand_affinities.json") or []
    cat_aff = read_json_file(agg_dir / "category_affinities.json") or []
    color_profile = read_json_file(agg_dir / "color_profile.json") or {}
    dod_sel = read_json_file(agg_dir / "dod_selectivity.json") or {}
    dod_aff = read_json_file(agg_dir / "dod_affinities.json") or {}
    sat = read_json_file(agg_dir / "satisfaction_trajectory.json") or {}
    qual = read_json_file(agg_dir / "qualitative_signals.json") or {}
    exclusion = read_json_file(agg_dir / "exclusion_list.json") or {}

    style_profile_md = read_file(slug_dir / "style_profile.md")
    outfit_recs_md = read_file(slug_dir / "outfit_recommendations.md")

    if not style_profile_md and not outfit_recs_md:
        return None

    name = customer.get("Name", slug.replace("-", " ").title())

    # Compute DOD totals from summary
    dod_total = sum(int(r.get("cnt", 0)) for r in dod_summary)
    dod_likes = sum(int(r.get("cnt", 0)) for r in dod_summary if (r.get("Rating") or "").lower() == "like")

    return {
        "slug": slug,
        "name": name,
        "customer": {
            "id": customer.get("ID"),
            "email": customer.get("Email", ""),
            "dob": str(customer.get("DOB", "")),
            "height": customer.get("Height", ""),
            "weight": customer.get("Weight", ""),
            "top_size": customer.get("TopSize", ""),
            "waist_size": customer.get("WaistSize", ""),
            "inseam_size": customer.get("InseamSize", ""),
            "shoe_size": customer.get("ShoeSize", ""),
            "bottom_fit": customer.get("BottomFit", ""),
            "day_style": customer.get("DayStyle", ""),
            "evening_style": customer.get("EveningStyle", ""),
            "design_style": customer.get("DesignStyle", ""),
            "shop_at": customer.get("ShopAt", ""),
            "location": f"{customer.get('ShipAddrCity', '')}, {customer.get('ShipAddrState', '')}".strip(", "),
            "date_created": str(customer.get("DateCreated", "")),
            "opt_out_note": customer.get("OptOutNote", ""),
            "likes_note": customer.get("LikesNote", ""),
            "feedback": customer.get("Feedback", ""),
        },
        "stats": {
            "total_orders": order_summary.get("order_count", 0),
            "total_spend": float(order_summary.get("total_spend", 0) or 0) / 100,
            "total_ratings": len(product_ratings),
            "total_dod": dod_total,
            "dod_likes": dod_likes,
            "total_boxes_rated": sat.get("total_boxes_rated", 0),
            "total_cs_notes": len(cs_notes),
            "recently_sent": len(exclusion.get("recently_sent_barcodes", [])),
        },
        "brand_affinities": brand_aff[:15],
        "category_affinities": cat_aff,
        "color_profile": color_profile,
        "dod_selectivity": dod_sel,
        "dod_affinities": {
            "colors": (dod_aff.get("color_affinities") or [])[:20],
            "brands": (dod_aff.get("brand_affinities") or [])[:10],
            "design_styles": dod_aff.get("design_style_affinities") or [],
        },
        "satisfaction": sat,
        "qualitative": {
            "opt_outs": qual.get("opt_outs", ""),
            "likes": qual.get("likes", ""),
            "feedback": qual.get("feedback_field", ""),
            "signup_reason": qual.get("signup_reason", ""),
            "reviews": (qual.get("reviews") or [])[:20],
            "cs_notes_sample": (qual.get("cs_notes") or [])[:10],
        },
        "style_profile_md": style_profile_md,
        "outfit_recommendations_md": outfit_recs_md,
    }


def main():
    dirs = sorted([d for d in OUTPUT_DIR.iterdir() if d.is_dir() and d.name != "__pycache__"])

    all_profiles = []
    for d in dirs:
        profile = build_profile(d)
        if profile:
            all_profiles.append(profile)

    # Order: pinned internal accounts first, then other @threadbeast.com, then customers by signal
    PINNED_ORDER = ["michael-chang", "joshua-gau", "justin-lucas"]
    pinned = []
    other_internal = []
    customers = []
    for p in all_profiles:
        email = p["customer"].get("email", "")
        if p["slug"] in PINNED_ORDER:
            pinned.append(p)
        elif email.endswith("@threadbeast.com"):
            other_internal.append(p)
        else:
            customers.append(p)

    pinned.sort(key=lambda p: PINNED_ORDER.index(p["slug"]))
    other_internal.sort(key=lambda p: p["name"])
    customers.sort(key=lambda p: p["stats"]["total_ratings"] + p["stats"]["total_dod"], reverse=True)
    profiles = pinned + other_internal + customers

    INTERNAL_SLUGS = set(p["slug"] for p in pinned + other_internal)
    for p in profiles:
        tag = "(internal)" if p["slug"] in INTERNAL_SLUGS else ""
        print(f"  Added: {p['name']} ({p['slug']}) {tag}")

    # Write summary file
    summary_path = OUTPUT_DIR / "profiles_summary.txt"
    with open(summary_path, "w") as f:
        f.write("RECSYS MVP — Profile Summary\n")
        f.write("=" * 70 + "\n\n")
        f.write(f"{'Customer':<25s} {'Type':<25s} {'Ratings':>8s} {'DOD':>8s} {'Boxes':>6s}  Style\n")
        f.write("-" * 100 + "\n")
        for p in profiles:
            s = p["stats"]
            ptype = "Internal" if p["slug"] in INTERNAL_SLUGS else (
                "Power user" if s["total_ratings"] > 250 else
                "Mid-tenure" if s["total_ratings"] > 80 else
                "Cold start"
            )
            style = p["customer"].get("day_style", "").split(" - ")[0]
            f.write(f"{p['name']:<25s} {ptype:<25s} {s['total_ratings']:>8d} {s['total_dod']:>8d} {s['total_boxes_rated']:>6d}  {style}\n")
    print(f"\n  Summary written to: {summary_path}")

    # Read template from pipeline/templates/, NOT the output file (avoids corruption loops)
    template_path = Path(__file__).parent / "templates" / "viewer.html"
    if not template_path.exists():
        print(f"ERROR: Template not found at {template_path}")
        sys.exit(1)

    html = template_path.read_text(encoding="utf-8")
    profiles_json = json.dumps({"profiles": profiles}, default=str)
    # Escape </script> inside JSON so it doesn't break the HTML script block
    profiles_json = profiles_json.replace("</script>", "<\\/script>")
    placeholder = "/*__PROFILES_DATA__*/"

    html = html.replace(placeholder, f"const EMBEDDED_DATA = {profiles_json};", 1)

    viewer_path = OUTPUT_DIR / "viewer.html"

    viewer_path.write_text(html, encoding="utf-8")
    print(f"\nEmbedded {len(profiles)} profiles into {viewer_path}")
    print(f"Open output/viewer.html in a browser.")


if __name__ == "__main__":
    main()
