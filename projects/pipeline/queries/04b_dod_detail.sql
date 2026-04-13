-- DOD swipe ratings joined to odoo_product for brand/color/category/design breakdown.
-- This gives us taste preferences at much higher volume than product ratings alone.
-- Params: {email}

SELECT
  d.Rating,
  p.product_brand,
  p.product_category,
  p.product_subcategory,
  p.product_color,
  p.color_family_name,
  p.product_design_style,
  p.product_item_style,
  COUNT(*) AS cnt
FROM DODRating d
JOIN odoo_product p ON d.barcode = p.barcode
WHERE d.Email = '{email}'
GROUP BY
  d.Rating,
  p.product_brand,
  p.product_category,
  p.product_subcategory,
  p.product_color,
  p.color_family_name,
  p.product_design_style,
  p.product_item_style;
