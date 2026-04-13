-- Signup context: reason for signing up + brand preferences at signup
-- Note: usersextra and usersbrand use tfEmail, not Email
-- Params: {email}

SELECT
  ue.SignupReason, ue.SignupReasonOther,
  ub.Brands, ub.BrandsOther
FROM usersextra ue
LEFT JOIN usersbrand ub ON ue.tfEmail = ub.tfEmail
WHERE ue.tfEmail = '{email}';
