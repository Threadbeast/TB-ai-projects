-- Customer profile: demographics, sizing, style preferences, opt-outs, notes
-- Params: {email}

SELECT
  ID, Email, Name, Status, DOB, Gender,
  Height, Weight,
  TopSize, WaistSize, InseamSize, ShoeSize, BottomFit,
  DayStyle, EveningStyle, DesignStyle,
  ShopAt, ShopAtOther,
  LikesNote, OptOutNote, CustNote, Feedback, Notes,
  Instagram, LeadSource, Coupon,
  ShipAddrCity, ShipAddrState, ShipAddrCountry, ShipAddrZipcode,
  DateCreated, DateUpdated
FROM customers
WHERE Email = '{email}';
