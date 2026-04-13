-- DOD (Deal of the Day) swipe ratings: binary like/dislike aggregate
-- Params: {email}

SELECT
  Rating,
  COUNT(*) AS cnt
FROM DODRating
WHERE Email = '{email}'
GROUP BY Rating;
