"""
Layer 2: Pre-Aggregation
Reads raw JSON from output/{customer}/raw/ and computes aggregated signals.
Saves results to output/{customer}/aggregated/.

This is the primary cost-optimization step: instead of sending Claude 268 raw
product ratings, we send pre-computed affinities as compact JSON.
"""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


OUTPUT_DIR = Path(__file__).parent.parent / "output"

# Feedback category → Odoo category mapping
# Feedback uses fine-grained names, Odoo uses broad categories.
FEEDBACK_TO_ODOO_CATEGORY = {
    "Tee": "Shirts",
    "Long Sleeve Tee": "Shirts",
    "Polo": "Shirts",
    "Crew": "Shirts",
    "Thermal": "Shirts",
    "Tanks": "Shirts",
    "Jersey": "Shirts",
    "Jacket": "Outerwear",
    "Hoodie": "Outerwear",
    "Flannel": "Outerwear",
    "Denim Jean": "Bottoms",
    "Shorts": "Bottoms",
    "Sweatpants": "Bottoms",
    "Joggers": "Bottoms",
    "Chino Pants": "Bottoms",
    "Pants": "Bottoms",
    "Swim": "Bottoms",
    "Button Down": "Wovens",
    "Hat": "Accessories",
    "Beanie": "Accessories",
    "Bag": "Accessories",
    "Backpack": "Accessories",
    "Wallet": "Accessories",
    "Chain": "Accessories",
    "Watch": "Accessories",
    "Socks": "Accessories",
    "Boxers": "Accessories",
    "Shoes": "Shoes",
    "Slides": "Shoes",
}


def load_raw(customer_slug, filename):
    """Load a raw JSON file for a customer."""
    filepath = OUTPUT_DIR / customer_slug / "raw" / filename
    if not filepath.exists():
        return []
    with open(filepath) as f:
        return json.load(f)


def save_aggregated(customer_slug, filename, data):
    """Save an aggregated JSON file."""
    out_dir = OUTPUT_DIR / customer_slug / "aggregated"
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / filename, "w") as f:
        json.dump(data, f, indent=2, default=str)


def compute_brand_affinities(product_ratings):
    """
    Avg rating per brand, minimum 3 items.
    Returns list sorted by avg_rating desc.
    """
    brands = defaultdict(list)
    for r in product_ratings:
        brand = r.get("Brand")
        rating = r.get("Rating")
        if brand and rating is not None:
            brands[brand].append(int(rating))

    affinities = []
    for brand, ratings in brands.items():
        if len(ratings) >= 3:
            affinities.append({
                "brand": brand,
                "avg_rating": round(sum(ratings) / len(ratings), 2),
                "count": len(ratings),
                "rating_distribution": dict(Counter(ratings)),
            })

    return sorted(affinities, key=lambda x: x["avg_rating"], reverse=True)


def compute_category_affinities(product_ratings):
    """
    Avg rating per category (using feedback category names).
    Includes the mapped odoo_category for inventory matching.
    """
    categories = defaultdict(list)
    for r in product_ratings:
        cat = r.get("Category")
        rating = r.get("Rating")
        if cat and rating is not None:
            categories[cat].append(int(rating))

    affinities = []
    for cat, ratings in categories.items():
        affinities.append({
            "feedback_category": cat,
            "odoo_category": FEEDBACK_TO_ODOO_CATEGORY.get(cat, "Unknown"),
            "avg_rating": round(sum(ratings) / len(ratings), 2),
            "count": len(ratings),
            "rating_distribution": dict(Counter(ratings)),
        })

    return sorted(affinities, key=lambda x: x["avg_rating"], reverse=True)


def compute_color_profile(product_ratings):
    """
    Color feedback distribution (Just Right / Too Loud / Too Plain).
    Also extracts detailed info on Too Loud items and Style feedback distribution.
    """
    color_counts = Counter()
    too_loud_items = []
    style_counts = Counter()

    for r in product_ratings:
        color_fb = r.get("Color")
        if color_fb:
            color_counts[color_fb] += 1
            if color_fb == "Too Loud":
                too_loud_items.append({
                    "brand": r.get("Brand"),
                    "category": r.get("Category"),
                    "rating": r.get("Rating"),
                    "image": r.get("Image"),
                    "description": r.get("Description"),
                })

        style_fb = r.get("Style")
        if style_fb:
            style_counts[style_fb] += 1

    total_color = sum(color_counts.values())
    total_style = sum(style_counts.values())

    return {
        "color_feedback": {
            "just_right": color_counts.get("Just Right", 0),
            "too_plain": color_counts.get("Too Plain", 0),
            "too_loud": color_counts.get("Too Loud", 0),
            "total": total_color,
            "too_loud_ratio": round(color_counts.get("Too Loud", 0) / total_color, 3) if total_color else 0,
        },
        "too_loud_items": too_loud_items,
        "style_feedback": {
            "love_it": style_counts.get("Love it", 0),
            "like_it": style_counts.get("Like it", 0),
            "its_not_me": style_counts.get("Its not me", 0),
            "total": total_style,
            "love_ratio": round(style_counts.get("Love it", 0) / total_style, 3) if total_style else 0,
            "not_me_ratio": round(style_counts.get("Its not me", 0) / total_style, 3) if total_style else 0,
        },
    }


def compute_dod_selectivity(dod_summary):
    """Like/dislike counts, ratio, and selectivity label."""
    likes = 0
    dislikes = 0
    for row in dod_summary:
        rating = row.get("Rating", "").lower()
        cnt = int(row.get("cnt", 0))
        if rating == "like":
            likes = cnt
        elif rating == "dislike":
            dislikes = cnt

    total = likes + dislikes
    like_ratio = round(likes / total, 3) if total else 0

    if like_ratio < 0.3:
        selectivity = "extremely_selective"
    elif like_ratio < 0.4:
        selectivity = "very_selective"
    elif like_ratio < 0.5:
        selectivity = "selective"
    else:
        selectivity = "moderate"

    return {
        "likes": likes,
        "dislikes": dislikes,
        "total": total,
        "like_ratio": like_ratio,
        "selectivity": selectivity,
    }


def compute_satisfaction_trajectory(box_ratings):
    """
    Last 10 box ratings chronologically, plus trend direction.
    box_ratings come in DESC order from SQL, so we reverse for chronological.
    """
    # Take last 10 and reverse to chronological
    recent = list(reversed(box_ratings[:10]))

    trajectory = []
    for br in recent:
        trajectory.append({
            "date": br.get("PaymentDate"),
            "rating": br.get("Rating"),
            "value": br.get("Value"),
            "style_accuracy": br.get("StyleAccuracy"),
            "review": br.get("Review"),
        })

    # Compute trend
    ratings = [int(t["rating"]) for t in trajectory if t["rating"] is not None]
    if len(ratings) >= 4:
        first_half = sum(ratings[:len(ratings)//2]) / (len(ratings)//2)
        second_half = sum(ratings[len(ratings)//2:]) / (len(ratings) - len(ratings)//2)
        if second_half > first_half + 0.2:
            trend = "improving"
        elif second_half < first_half - 0.2:
            trend = "declining"
        else:
            trend = "stable"
    else:
        trend = "insufficient_data"

    all_ratings = [int(br.get("Rating", 0)) for br in box_ratings if br.get("Rating")]
    recent_5 = [int(br.get("Rating", 0)) for br in box_ratings[:5] if br.get("Rating")]

    return {
        "trajectory": trajectory,
        "trend": trend,
        "avg_all": round(sum(all_ratings) / len(all_ratings), 2) if all_ratings else None,
        "avg_recent_5": round(sum(recent_5) / len(recent_5), 2) if recent_5 else None,
        "total_boxes_rated": len(all_ratings),
    }


def compute_dod_affinities(dod_detail):
    """
    Compute brand, category, color, and design style affinities from DOD swipe data.
    Much higher volume than product ratings (1000+ swipes vs ~200 ratings).

    Each row in dod_detail has: Rating (like/dislike), product_brand, product_category,
    product_subcategory, product_color, color_family_name, product_design_style,
    product_item_style, cnt.
    """
    # Accumulate likes and total per dimension
    brand_likes = defaultdict(int)
    brand_total = defaultdict(int)
    category_likes = defaultdict(int)
    category_total = defaultdict(int)
    color_likes = defaultdict(int)
    color_total = defaultdict(int)
    color_family_likes = defaultdict(int)
    color_family_total = defaultdict(int)
    design_likes = defaultdict(int)
    design_total = defaultdict(int)

    for row in dod_detail:
        rating = (row.get("Rating") or "").lower()
        cnt = int(row.get("cnt", 0))
        is_like = rating == "like"

        brand = row.get("product_brand")
        if brand:
            brand_total[brand] += cnt
            if is_like:
                brand_likes[brand] += cnt

        cat = row.get("product_category")
        if cat:
            category_total[cat] += cnt
            if is_like:
                category_likes[cat] += cnt

        color = row.get("product_color")
        if color:
            color_total[color] += cnt
            if is_like:
                color_likes[color] += cnt

        color_fam = row.get("color_family_name")
        if color_fam:
            color_family_total[color_fam] += cnt
            if is_like:
                color_family_likes[color_fam] += cnt

        design = row.get("product_design_style")
        if design:
            design_total[design] += cnt
            if is_like:
                design_likes[design] += cnt

    def build_ranking(likes_dict, total_dict, min_swipes=10):
        ranking = []
        for key in total_dict:
            total = total_dict[key]
            if total < min_swipes:
                continue
            liked = likes_dict.get(key, 0)
            ranking.append({
                "name": key,
                "likes": liked,
                "dislikes": total - liked,
                "total": total,
                "like_ratio": round(liked / total, 3),
            })
        return sorted(ranking, key=lambda x: x["like_ratio"], reverse=True)

    return {
        "brand_affinities": build_ranking(brand_likes, brand_total, min_swipes=10),
        "category_affinities": build_ranking(category_likes, category_total, min_swipes=10),
        "color_affinities": build_ranking(color_likes, color_total, min_swipes=5),
        "color_family_affinities": build_ranking(color_family_likes, color_family_total, min_swipes=10),
        "design_style_affinities": build_ranking(design_likes, design_total, min_swipes=10),
    }


def compute_exclusion_list(recent_orders):
    """
    Extract all non-null barcodes from Item1-16 across recent orders.
    These are hard exclusions for recommendations.
    """
    barcodes = set()
    for order in recent_orders:
        for i in range(1, 17):
            item = order.get(f"Item{i}")
            if item and item.strip():
                barcodes.add(item.strip())

    return {
        "recently_sent_barcodes": sorted(barcodes),
        "order_count": len(recent_orders),
    }


def extract_qualitative_signals(customer_slug):
    """
    Pull together all free-text signals from multiple sources.
    """
    customer = load_raw(customer_slug, "customer_profile.json")
    customer = customer[0] if customer else {}
    product_ratings = load_raw(customer_slug, "product_ratings.json")
    cs_notes = load_raw(customer_slug, "cs_notes.json")
    signup = load_raw(customer_slug, "signup_context.json")
    caller = load_raw(customer_slug, "caller_feedback.json")

    # Reviews with context (only non-empty reviews)
    reviews = []
    for r in product_ratings:
        review_text = r.get("Review")
        if review_text and review_text.strip():
            reviews.append({
                "text": review_text.strip(),
                "rating": r.get("Rating"),
                "brand": r.get("Brand"),
                "category": r.get("Category"),
            })

    # CS notes
    cs_entries = []
    for n in cs_notes:
        note_text = n.get("CsLogNoteData")
        if note_text and note_text.strip():
            cs_entries.append({
                "text": note_text.strip(),
                "date": n.get("DateUpdated"),
                "staff": n.get("StaffName"),
            })

    # Caller feedback notes
    caller_entries = []
    for c in caller:
        notes_text = c.get("Notes")
        if notes_text and notes_text.strip():
            caller_entries.append({
                "text": notes_text.strip(),
                "date": c.get("DateCreated"),
                "saved": c.get("Saved"),
                "cancel_reasons": {
                    "money": c.get("Money"),
                    "didnt_like_package": c.get("DidntLikePackage"),
                    "shipping": c.get("Shipping"),
                    "misc": c.get("MISC"),
                },
            })

    # Signup context
    signup_data = signup[0] if signup else {}

    return {
        "reviews": reviews,
        "cs_notes": cs_entries,
        "caller_feedback": caller_entries,
        "opt_outs": customer.get("OptOutNote", ""),
        "likes": customer.get("LikesNote", ""),
        "customer_note": customer.get("CustNote", ""),
        "feedback_field": customer.get("Feedback", ""),
        "notes_field": customer.get("Notes", ""),
        "signup_reason": signup_data.get("SignupReason", ""),
        "signup_reason_other": signup_data.get("SignupReasonOther", ""),
        "signup_brands": signup_data.get("Brands", ""),
        "signup_brands_other": signup_data.get("BrandsOther", ""),
    }


def build_candidate_inventory(customer_slug, brand_affinities, category_affinities):
    """
    Pre-filter inventory: remove opted-out categories and low-rated brands.
    This keeps the candidate pool to a manageable size for Claude Code context.
    """
    inventory = load_raw(customer_slug, "inventory.json")
    customer = load_raw(customer_slug, "customer_profile.json")
    customer = customer[0] if customer else {}

    # Build sets of brands to avoid (< 3.0 avg with 3+ items)
    avoid_brands = {
        b["brand"] for b in brand_affinities if b["avg_rating"] < 3.0
    }

    # Parse opt-outs into a set of keywords (lowercase)
    opt_out_text = (customer.get("OptOutNote", "") or "").lower()
    opt_out_keywords = set()
    # Common opt-out items
    for kw in ["sunglasses", "watches", "jerseys", "wallets", "socks",
               "boxers", "bucket hats", "no-show socks", "ankle socks",
               "crew socks"]:
        if kw in opt_out_text:
            opt_out_keywords.add(kw)

    candidates = []
    for item in inventory:
        brand = item.get("product_brand", "")
        subcategory = (item.get("product_subcategory", "") or "").lower()
        name = (item.get("name", "") or "").lower()

        # Skip avoided brands
        if brand in avoid_brands:
            continue

        # Skip opted-out items (check subcategory and name against keywords)
        skip = False
        for kw in opt_out_keywords:
            if kw in subcategory or kw in name:
                skip = True
                break
        if skip:
            continue

        candidates.append(item)

    return candidates


def aggregate_customer(customer_slug):
    """Run all pre-aggregation computations for a customer."""
    print(f"\nAggregating data for: {customer_slug}")

    product_ratings = load_raw(customer_slug, "product_ratings.json")
    box_ratings = load_raw(customer_slug, "box_ratings.json")
    dod_summary = load_raw(customer_slug, "dod_summary.json")
    recent_orders = load_raw(customer_slug, "recent_orders.json")

    # Compute aggregations
    brand_aff = compute_brand_affinities(product_ratings)
    save_aggregated(customer_slug, "brand_affinities.json", brand_aff)
    print(f"  brand_affinities: {len(brand_aff)} brands (3+ items each)")

    cat_aff = compute_category_affinities(product_ratings)
    save_aggregated(customer_slug, "category_affinities.json", cat_aff)
    print(f"  category_affinities: {len(cat_aff)} categories")

    color = compute_color_profile(product_ratings)
    save_aggregated(customer_slug, "color_profile.json", color)
    print(f"  color_profile: {color['color_feedback']['total']} color ratings, "
          f"{color['color_feedback']['too_loud']} Too Loud flags")

    dod = compute_dod_selectivity(dod_summary)
    save_aggregated(customer_slug, "dod_selectivity.json", dod)
    print(f"  dod_selectivity: {dod['total']} swipes, "
          f"{dod['like_ratio']:.1%} like ratio ({dod['selectivity']})")

    dod_detail = load_raw(customer_slug, "dod_detail.json")
    dod_aff = compute_dod_affinities(dod_detail)
    save_aggregated(customer_slug, "dod_affinities.json", dod_aff)
    print(f"  dod_affinities: {len(dod_aff['brand_affinities'])} brands, "
          f"{len(dod_aff['color_affinities'])} colors, "
          f"{len(dod_aff['category_affinities'])} categories, "
          f"{len(dod_aff['design_style_affinities'])} design styles")

    sat = compute_satisfaction_trajectory(box_ratings)
    save_aggregated(customer_slug, "satisfaction_trajectory.json", sat)
    print(f"  satisfaction_trajectory: {sat['total_boxes_rated']} boxes, "
          f"trend={sat['trend']}")

    excl = compute_exclusion_list(recent_orders)
    save_aggregated(customer_slug, "exclusion_list.json", excl)
    print(f"  exclusion_list: {len(excl['recently_sent_barcodes'])} barcodes "
          f"from {excl['order_count']} orders")

    qual = extract_qualitative_signals(customer_slug)
    save_aggregated(customer_slug, "qualitative_signals.json", qual)
    print(f"  qualitative_signals: {len(qual['reviews'])} reviews, "
          f"{len(qual['cs_notes'])} CS notes, "
          f"{len(qual['caller_feedback'])} caller notes")

    candidates = build_candidate_inventory(customer_slug, brand_aff, cat_aff)
    save_aggregated(customer_slug, "candidate_inventory.json", candidates)
    inventory = load_raw(customer_slug, "inventory.json")
    print(f"  candidate_inventory: {len(candidates)} items "
          f"(from {len(inventory)} size-matched)")

    out_dir = OUTPUT_DIR / customer_slug / "aggregated"
    print(f"\n  Aggregated data saved to: {out_dir}")


def main():
    if len(sys.argv) < 2:
        print("Usage: python aggregate.py <customer_slug>")
        print("  (customer_slug is the directory name under output/)")
        sys.exit(1)

    customer_slug = sys.argv[1]
    raw_dir = OUTPUT_DIR / customer_slug / "raw"
    if not raw_dir.exists():
        print(f"ERROR: No raw data found at {raw_dir}")
        print(f"  Run extract.py first.")
        sys.exit(1)

    aggregate_customer(customer_slug)


if __name__ == "__main__":
    main()
