-- Order summary: total order count and spend (replaces Intercom total_spend / total_packages_sent)
-- Params: {email}
-- Note: Amount is STRING in the orders table, needs casting. Empty strings handled with NULLIF.

SELECT
  COUNT(*) AS order_count,
  SUM(SAFE_CAST(NULLIF(Amount, '') AS NUMERIC)) AS total_spend
FROM orders
WHERE Email = '{email}';
