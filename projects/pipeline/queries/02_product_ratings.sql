-- Per-item product ratings: the richest signal source for style preferences
-- Params: {email}

SELECT
  Brand, Category, Rating, Color, Style, Fit,
  Review, Image, WHitem, Size, Description,
  createdAt
FROM feedback3userprod
WHERE Email = '{email}'
ORDER BY createdAt DESC;
