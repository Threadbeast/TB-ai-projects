-- CS admin log notes: behavioral signals (loyalty, upgrades, come-back-early, stylist notes)
-- Params: {email}

SELECT
  CsLogNoteData, StaffName, DateUpdated
FROM cslognotes
WHERE Email = '{email}'
ORDER BY DateUpdated DESC;
