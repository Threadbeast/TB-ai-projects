-- High-signal customer finder
-- Returns top 20 active customers ranked by total data points across all signal sources.
-- Use this to pick test customers with rich data for the MVP.

SELECT
  c.ID,
  c.Name,
  c.Email,
  c.DayStyle,
  c.TopSize,
  c.WaistSize,
  c.InseamSize,
  IFNULL(pr.cnt, 0) AS product_ratings,
  IFNULL(br.cnt, 0) AS box_ratings,
  IFNULL(dod.cnt, 0) AS dod_swipes,
  IFNULL(cs.cnt, 0) AS cs_notes,
  (IFNULL(pr.cnt, 0) + IFNULL(br.cnt, 0) + IFNULL(dod.cnt, 0) + IFNULL(cs.cnt, 0)) AS total_signal
FROM customers c
LEFT JOIN (SELECT Email, COUNT(*) cnt FROM feedback3userprod GROUP BY Email) pr ON c.Email = pr.Email
LEFT JOIN (SELECT Email, COUNT(*) cnt FROM feedback3userbox GROUP BY Email) br ON c.Email = br.Email
LEFT JOIN (SELECT Email, COUNT(*) cnt FROM DODRating GROUP BY Email) dod ON c.Email = dod.Email
LEFT JOIN (SELECT Email, COUNT(*) cnt FROM cslognotes GROUP BY Email) cs ON c.Email = cs.Email
WHERE c.Status = 'Active'
ORDER BY total_signal DESC
LIMIT 20;
