-- Recent orders: last 5 boxes with all item barcodes (Item1-16)
-- Unpivoting Item1-16 into a flat barcode list is done in Python after fetch.
-- Params: {email}

SELECT
  ID AS order_id, DatePayment, Amount, Stylist,
  Item1, Item2, Item3, Item4, Item5, Item6, Item7, Item8,
  Item9, Item10, Item11, Item12, Item13, Item14, Item15, Item16
FROM orders
WHERE Email = '{email}'
ORDER BY DatePayment DESC
LIMIT 5;
