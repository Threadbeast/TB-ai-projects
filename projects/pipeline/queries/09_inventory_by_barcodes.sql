-- Hydrate barcode list with full product metadata from odoo_product.
-- This query is built dynamically in extract.py — the {barcodes_list}
-- placeholder is replaced with a comma-separated list of quoted barcodes
-- read from the available_inventory.csv file.
--
-- The CSV only needs a "barcode" column. Everything else comes from here.

SELECT
  barcode, name, product_brand, product_category, product_subcategory,
  product_color, color_family_name, product_size, product_front_image_url,
  product_design_style, product_item_style, product_fit,
  product_seasonality, product_thickness,
  qty_available, msrp, product_waist_size, product_inseam_size
FROM odoo_product
WHERE barcode IN ({barcodes_list})
  AND product_status = 'ready'
  AND is_deleted = false
ORDER BY product_brand, product_subcategory;
