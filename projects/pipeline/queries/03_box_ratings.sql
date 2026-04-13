-- Per-box overall ratings: satisfaction trajectory over time
-- Params: {email}

SELECT
  Rating, Value, StyleAccuracy, Review,
  PaymentDate, ItemCnt
FROM feedback3userbox
WHERE Email = '{email}'
ORDER BY PaymentDate DESC;
