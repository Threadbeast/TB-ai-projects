-- Caller/retention feedback: cancel reasons, save attempts, outcomes
-- Params: {email}

SELECT
  Notes, Plan,
  Money, DidntLikePackage, Shipping, MISC,
  Saved, Downgraded, HowLikelyToTryAgain,
  DateCreated
FROM callerFeedback
WHERE Email = '{email}'
ORDER BY DateCreated DESC;
