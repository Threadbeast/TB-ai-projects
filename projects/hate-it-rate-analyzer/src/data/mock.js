/**
 * Generate realistic mock data matching the master_orders schema.
 * ~5000 rows spanning 6 months, with realistic distributions.
 */
function generateMockData() {
  const brands = [
    { name: 'AVVA', weight: 0.15, hateRate: 0.18 },
    { name: 'Cuts', weight: 0.12, hateRate: 0.08 },
    { name: 'BYLT', weight: 0.10, hateRate: 0.10 },
    { name: 'True Classic', weight: 0.10, hateRate: 0.12 },
    { name: 'Redvanly', weight: 0.08, hateRate: 0.22 },
    { name: 'Psycho Bunny', weight: 0.08, hateRate: 0.07 },
    { name: 'Good Man Brand', weight: 0.07, hateRate: 0.15 },
    { name: 'Western Rise', weight: 0.06, hateRate: 0.09 },
    { name: 'Faherty', weight: 0.06, hateRate: 0.06 },
    { name: 'Rhone', weight: 0.05, hateRate: 0.11 },
    { name: 'Vuori', weight: 0.05, hateRate: 0.05 },
    { name: 'Chubbies', weight: 0.04, hateRate: 0.20 },
    { name: 'Marine Layer', weight: 0.04, hateRate: 0.13 }
  ];

  const categories = [
    { name: 'Tops', weight: 0.35, subcategories: ['T-Shirts', 'Polos', 'Button-Downs', 'Henleys', 'Sweaters'] },
    { name: 'Bottoms', weight: 0.30, subcategories: ['Joggers', 'Chinos', 'Jeans', 'Shorts', 'Sweatpants'] },
    { name: 'Outerwear', weight: 0.15, subcategories: ['Jackets', 'Hoodies', 'Vests', 'Pullovers'] },
    { name: 'Accessories', weight: 0.10, subcategories: ['Socks', 'Belts', 'Hats', 'Sunglasses'] },
    { name: 'Shoes', weight: 0.10, subcategories: ['Sneakers', 'Loafers', 'Boots'] }
  ];

  const stylists = [
    { name: 'Sarah M.', hateRate: 0.10 },
    { name: 'Jake R.', hateRate: 0.12 },
    { name: 'Maria G.', hateRate: 0.09 },
    { name: 'Tyler K.', hateRate: 0.18 },
    { name: 'Aisha P.', hateRate: 0.08 },
    { name: 'Brandon L.', hateRate: 0.14 },
    { name: 'Jen W.', hateRate: 0.11 },
    { name: 'Carlos D.', hateRate: 0.21 },
    { name: 'Emily T.', hateRate: 0.07 },
    { name: 'Marcus H.', hateRate: 0.16 }
  ];

  const plans = ['Essential', 'Premium', 'Baller'];
  const colorStyles = ['Neutral', 'Bold', 'Earthy', 'Dark', 'Bright', 'Pastel'];
  const seasonality = ['Spring', 'Summer', 'Fall', 'Winter', 'Year-Round'];
  const sourcing = ['Direct', 'Wholesale', 'Closeout', 'Consignment'];
  const states = ['CA', 'TX', 'FL', 'NY', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI', 'NJ', 'VA', 'WA', 'AZ', 'MA', 'CO', 'TN', 'IN', 'MO', 'MD'];
  const styleAccuracy = ['Love it', 'Mostly me', 'Not me'];
  const quality = ['Excellent', 'Good', 'Poor'];
  const fit = ['Perfect', 'Slightly small', 'Slightly large', 'Too small', 'Too large'];

  const negativeComments = [
    'Not my style at all', 'Quality feels cheap', 'Color looks different than expected',
    'Too tight around the chest', 'Material is scratchy', 'Would never wear this',
    'Looks like something my dad would wear', 'Way too loud for me',
    'Doesn\'t match my profile at all', 'Fabric pilled after one wash',
    'Sizing is way off', 'Not worth the price', 'Already have something similar',
    'The fit is terrible', 'Color faded quickly'
  ];

  const positiveComments = [
    'Love this!', 'Perfect fit', 'Great quality', 'Exactly my style',
    'Wearing this every week', 'Best item in the box', 'Exceeded expectations',
    'Super comfortable', 'Great color', 'Would buy more from this brand'
  ];

  const rows = [];
  const now = new Date('2026-03-28');
  const sixMonthsAgo = new Date('2025-09-28');

  // Generate ~5000 item ratings
  for (let i = 0; i < 5000; i++) {
    const brand = weightedPick(brands);
    const category = weightedPick(categories);
    const subcategory = pick(category.subcategories);
    const stylist = pick(stylists);
    const boxNumber = weightedBoxNumber();

    // Compute hate probability based on brand + stylist + box number
    let hateProb = (brand.hateRate + stylist.hateRate) / 2;
    if (boxNumber === 1) hateProb *= 1.3; // Box 1 has higher hate rate
    if (boxNumber > 6) hateProb *= 0.8; // Loyal customers are happier

    const itemRating = generateRating(hateProb);
    const isHate = itemRating <= 2;

    // Ship date random within range
    const shipDate = randomDate(sixMonthsAgo, now);
    const deliverDate = new Date(shipDate.getTime() + randomInt(2, 8) * 86400000);
    const ratingDate = new Date(deliverDate.getTime() + randomInt(1, 21) * 86400000);

    // Some recent shipments won't have ratings yet
    const hasRating = ratingDate <= now;
    if (!hasRating && Math.random() > 0.3) continue; // 70% of future ratings not yet submitted

    const mcID = `MC${100000 + Math.floor(i / 4)}`;
    const boxRating = generateRating(hateProb * 0.9); // Box ratings slightly better

    rows.push({
      id: i + 1,
      mcID,
      itemRating: hasRating ? itemRating : 0,
      boxRating: hasRating ? boxRating : 0,
      product_brand: brand.name,
      product_category: category.name,
      product_subcategory: subcategory,
      product_item_style: pick(['Casual', 'Athletic', 'Dressy', 'Streetwear', 'Classic']),
      Stylist: stylist.name,
      plan: pick(plans),
      BoxNumber: boxNumber,
      product_color_style: pick(colorStyles),
      product_seasonality: pick(seasonality),
      product_sourcing: pick(sourcing),
      ShipAddrState: pick(states),
      shipped_date: formatDate(shipDate),
      delivered_date: formatDate(deliverDate),
      FB_rating_date: hasRating ? formatDate(ratingDate) : '',
      FBbox_rating_date: hasRating ? formatDate(ratingDate) : '',
      boxStyleAccuracy: hasRating ? (isHate ? weightedPick2(['Not me', 'Mostly me', 'Love it'], [0.5, 0.35, 0.15]) : weightedPick2(['Love it', 'Mostly me', 'Not me'], [0.5, 0.35, 0.15])) : '',
      itemQuality: hasRating ? (isHate ? weightedPick2(['Poor', 'Good', 'Excellent'], [0.4, 0.4, 0.2]) : weightedPick2(['Excellent', 'Good', 'Poor'], [0.5, 0.4, 0.1])) : '',
      itemFit: hasRating ? pick(fit) : '',
      itemComment: hasRating ? (Math.random() < 0.4 ? (isHate ? pick(negativeComments) : pick(positiveComments)) : '') : '',
      standard_price: randomInt(25, 120),
      boxValue: randomInt(150, 400),
      product_front_image_url: ''
    });
  }

  // Inject a spike — brand "Redvanly" gets extra bad ratings in the last 2 weeks
  const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);
  for (let i = 0; i < 80; i++) {
    const shipDate = randomDate(twoWeeksAgo, now);
    const deliverDate = new Date(shipDate.getTime() + 3 * 86400000);
    const ratingDate = new Date(deliverDate.getTime() + randomInt(1, 7) * 86400000);
    if (ratingDate > now) continue;

    rows.push({
      id: 10000 + i,
      mcID: `MC${200000 + i}`,
      itemRating: Math.random() < 0.6 ? pick([1, 2]) : pick([3, 4, 5]),
      boxRating: Math.random() < 0.5 ? pick([1, 2]) : pick([3, 4, 5]),
      product_brand: 'Redvanly',
      product_category: pick(['Tops', 'Bottoms']),
      product_subcategory: pick(['Polos', 'Chinos']),
      product_item_style: 'Classic',
      Stylist: pick(stylists).name,
      plan: pick(plans),
      BoxNumber: weightedBoxNumber(),
      product_color_style: pick(colorStyles),
      product_seasonality: 'Spring',
      product_sourcing: 'Direct',
      ShipAddrState: pick(states),
      shipped_date: formatDate(shipDate),
      delivered_date: formatDate(deliverDate),
      FB_rating_date: formatDate(ratingDate),
      FBbox_rating_date: formatDate(ratingDate),
      boxStyleAccuracy: weightedPick2(['Not me', 'Mostly me', 'Love it'], [0.5, 0.3, 0.2]),
      itemQuality: weightedPick2(['Poor', 'Good', 'Excellent'], [0.45, 0.35, 0.2]),
      itemFit: pick(fit),
      itemComment: Math.random() < 0.5 ? pick(negativeComments) : '',
      standard_price: randomInt(60, 110),
      boxValue: randomInt(200, 350),
      product_front_image_url: ''
    });
  }

  console.log(`  Generated ${rows.length} mock rows\n`);
  return rows;
}

// Helpers
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function weightedPick(arr) {
  const r = Math.random();
  let sum = 0;
  for (const item of arr) {
    sum += item.weight;
    if (r <= sum) return item;
  }
  return arr[arr.length - 1];
}

function weightedPick2(items, weights) {
  const r = Math.random();
  let sum = 0;
  for (let i = 0; i < items.length; i++) {
    sum += weights[i];
    if (r <= sum) return items[i];
  }
  return items[items.length - 1];
}

function weightedBoxNumber() {
  const r = Math.random();
  if (r < 0.25) return 1;
  if (r < 0.45) return 2;
  if (r < 0.60) return 3;
  if (r < 0.72) return randomInt(4, 6);
  return randomInt(7, 20);
}

function generateRating(hateProb) {
  const r = Math.random();
  if (r < hateProb) return Math.random() < 0.5 ? 1 : 2;
  if (r < hateProb + 0.15) return 3;
  return Math.random() < 0.5 ? 4 : 5;
}

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function randomDate(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

module.exports = { generateMockData };
