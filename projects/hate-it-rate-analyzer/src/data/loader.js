const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { generateMockData } = require('./mock');

const DATA_DIR       = path.join(__dirname, '..', '..', 'data');
const BQ_KEY         = path.join(__dirname, '..', '..', 'threadbeast-warehouse-hate-it-rate-analyzer.json');
const CACHE_FILE     = path.join(DATA_DIR, 'bq_cache.json');
const BOX_CACHE_FILE = path.join(DATA_DIR, 'bq_cache_box.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Cache helpers ---

function readCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  const ageMs = Date.now() - fs.statSync(CACHE_FILE).mtimeMs;
  if (ageMs > CACHE_MAX_AGE_MS) {
    console.log(`  Cache stale (${Math.round(ageMs / 3600000)}h old) — will re-fetch from BigQuery\n`);
    return null;
  }
  console.log(`  Cache hit (${Math.round(ageMs / 60000)}m old) — reading...`);
  return null; // Signal async path below
}

// Async version used by loadData()
async function readCacheAsync() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const ageMs = Date.now() - fs.statSync(CACHE_FILE).mtimeMs;
    if (ageMs > CACHE_MAX_AGE_MS) {
      console.log(`  Cache stale (${Math.round(ageMs / 3600000)}h old) — will re-fetch from BigQuery\n`);
      return null;
    }
    const sizeMB = (fs.statSync(CACHE_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`  Cache hit (${Math.round(ageMs / 60000)}m old, ${sizeMB}MB) — streaming from disk...`);

    // Stream NDJSON line by line — memory efficient for large files
    const readline = require('readline');
    const rl = readline.createInterface({
      input: fs.createReadStream(CACHE_FILE, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    });

    const rows = [];
    let firstLine = true;
    let meta = null;

    await new Promise((resolve, reject) => {
      rl.on('line', (line) => {
        if (!line.trim()) return;
        if (firstLine) {
          meta = JSON.parse(line);
          firstLine = false;
        } else {
          rows.push(JSON.parse(line));
        }
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });

    console.log(`  Cache loaded: ${rows.length} rows (fetched ${new Date(meta.fetchedAt).toLocaleString()})\n`);
    return rows;
  } catch (e) {
    console.log(`  Cache read failed: ${e.message} — will re-fetch\n`);
    return null;
  }
}

function writeCache(rows) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Stream-write as NDJSON to avoid hitting Node's string length limit on large datasets.
    // Format: first line = metadata JSON, remaining lines = one row per line.
    const stream = fs.createWriteStream(CACHE_FILE, { encoding: 'utf-8' });
    stream.write(JSON.stringify({ fetchedAt: new Date().toISOString(), count: rows.length }) + '\n');
    for (const row of rows) {
      stream.write(JSON.stringify(row) + '\n');
    }
    stream.end(() => {
      const sizeMB = (fs.statSync(CACHE_FILE).size / 1024 / 1024).toFixed(1);
      console.log(`  Cache saved: ${rows.length} rows (${sizeMB} MB) → bq_cache.json\n`);
    });
  } catch (e) {
    console.log(`  Cache write failed (non-fatal): ${e.message}\n`);
  }
}

function clearCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) { fs.unlinkSync(CACHE_FILE); console.log('  Cache cleared\n'); }
  } catch (e) { console.log(`  Cache clear failed: ${e.message}\n`); }
}

function getCacheInfo() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return { exists: false };
    const stat = fs.statSync(CACHE_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    return {
      exists: true,
      fetchedAt: new Date(stat.mtime).toISOString(),
      ageMinutes: Math.round(ageMs / 60000),
      stale: ageMs > CACHE_MAX_AGE_MS,
      sizeMB: (stat.size / 1024 / 1024).toFixed(1)
    };
  } catch (e) { return { exists: false }; }
}

/**
 * Load data: cache → BigQuery → CSV → mock data.
 */
async function loadData() {
  // 1. Try cache first (async streaming read)
  const cached = await readCacheAsync();
  if (cached) return cached;

  // 2. Try BigQuery if service account exists
  if (fs.existsSync(BQ_KEY)) {
    try {
      const { loadMasterOrders } = require('./bigquery');
      const rows = await loadMasterOrders('2026-01-01'); // BQ agg queries handle historical context
      if (rows.length > 0) {
        console.log(`  BigQuery: ${rows.length} rows loaded\n`);
        writeCache(rows);
        return rows;
      }
    } catch (e) {
      console.log(`  BigQuery failed: ${e.message}`);
      console.log('  Falling back to CSV...\n');
    }
  }

  const csvFiles = [];

  if (fs.existsSync(DATA_DIR)) {
    const files = fs.readdirSync(DATA_DIR);
    for (const f of files) {
      if (f.toLowerCase().endsWith('.csv')) {
        csvFiles.push(path.join(DATA_DIR, f));
      }
    }
  }

  if (csvFiles.length > 0) {
    console.log(`  Loading ${csvFiles.length} CSV file(s)...`);
    const allRows = [];

    for (const file of csvFiles) {
      const raw = fs.readFileSync(file, 'utf-8');
      const rows = parse(raw, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true
      });

      // Detect schema from first row's columns
      const cols = Object.keys(rows[0] || {});
      const schema = detectSchema(cols);
      console.log(`    ${path.basename(file)}: ${rows.length} rows [schema: ${schema}]`);

      const normalized = rows.map(r => normalizeRow(r, schema)).filter(r => r !== null);
      console.log(`    → ${normalized.length} valid rows after normalization`);
      allRows.push(...normalized);
    }

    console.log(`  Total: ${allRows.length} rows loaded from CSV\n`);

    // Log available dimensions
    const dims = detectAvailableDimensions(allRows);
    console.log(`  Available dimensions: ${dims.join(', ')}\n`);

    return allRows;
  }

  // No CSV found — use mock data
  console.log('  No CSV files found in /data — using mock data');
  console.log('  To use real data, drop a CSV export into the data/ folder and hit /api/reload\n');
  return generateMockData();
}

function detectSchema(cols) {
  const colSet = new Set(cols.map(c => c.toLowerCase()));
  if (colSet.has('itemrating') || colSet.has('product_brand')) return 'master_orders';
  if (colSet.has('styleaccuracy') || colSet.has('daystyle') || colSet.has('package_num')) return 'box_feedback';
  return 'unknown';
}

function normalizeRow(row, schema) {
  if (schema === 'box_feedback') return normalizeBoxFeedback(row);
  if (schema === 'master_orders') return normalizeMasterOrders(row);
  // Unknown — try best effort
  return normalizeMasterOrders(row);
}

/**
 * Normalize the "Box Feedback - All Info" query export.
 * Columns: id, mcID, Email, ItemCnt, PaymentDate, Box, Delivery,
 * StyleAccuracy, Presentation, Value, Quality, Rating, Review,
 * CRMDelivered, CRMGotFB, createdAt, updatedAt, pickup_date,
 * DayStyle, EveningStyle, BottomFit, TopSize, WaistSize, InseamSize,
 * ShoeSize, Height, Weight, DOB, ShopAt, ShipAddrState, Stylist, package_num
 */
function normalizeBoxFeedback(row) {
  const rating = parseInt(row.Rating);
  if (!rating || rating === 0) return null; // Skip unrated

  const pickupDate = parseMetabaseDate(row.pickup_date);
  const createdAt = parseMetabaseDate(row.createdAt);
  const paymentDate = parseMetabaseDate(row.PaymentDate);

  // Extract style labels (strip the description after " - ")
  const dayStyle = simplifyStyle(row.DayStyle);
  const eveningStyle = simplifyStyle(row.EveningStyle);
  const bottomFit = simplifyFit(row.BottomFit);

  return {
    id: cleanNumber(row.id),
    mcID: row.mcID || '',
    // Box feedback has one Rating per box — use it for both
    itemRating: rating,
    boxRating: rating,
    product_brand: '',  // Not in this dataset
    product_category: '', // Not in this dataset
    product_subcategory: '',
    product_item_style: dayStyle,
    Stylist: row.Stylist || '',
    plan: '',  // Not in this dataset
    BoxNumber: parseInt(row.package_num) || 0,
    customerType: parseInt(row.package_num) === 1 ? 'New Customer' : parseInt(row.package_num) >= 2 ? 'Recurring Customer' : '',
    product_color_style: eveningStyle,  // Map evening style to color preference
    product_seasonality: row.Box || '',  // "December", "January", etc. — ship month
    product_sourcing: '',
    ShipAddrState: row.ShipAddrState || '',
    shipped_date: pickupDate,
    delivered_date: '',
    FB_rating_date: createdAt,
    FBbox_rating_date: createdAt,
    boxStyleAccuracy: row.StyleAccuracy || '',
    itemQuality: row.Quality || '',
    itemFit: bottomFit,
    itemComment: row.Review || '',
    standard_price: 0,
    boxValue: 0,
    product_front_image_url: '',
    // Extra fields from box feedback
    ItemCnt: parseInt(row.ItemCnt) || 0,
    TopSize: row.TopSize || '',
    WaistSize: row.WaistSize || '',
    DayStyle: dayStyle,
    EveningStyle: eveningStyle,
    BottomFit: bottomFit,
    ShopAt: row.ShopAt || '',
    Presentation: row.Presentation || '',
    Value: row.Value || ''
  };
}

function normalizeMasterOrders(row) {
  return {
    id: row.id || row.ID || null,
    mcID: row.mcID || row.mcid || row.mc_id || null,
    itemRating: parseFloat(row.itemRating || row.itemrating || row.item_rating || row.Rating || 0),
    boxRating: parseFloat(row.boxRating || row.boxrating || row.box_rating || 0),
    product_brand: row.product_brand || row.Brand || row.brand || '',
    product_category: row.product_category || row.Category || row.category || '',
    product_subcategory: row.product_subcategory || row.Subcategory || row.subcategory || '',
    product_item_style: row.product_item_style || row.ItemStyle || row.item_style || '',
    Stylist: row.Stylist || row.stylist || '',
    plan: row.plan || row.Plan || '',
    BoxNumber: parseInt(row.BoxNumber || row.box_number || row.package_num || 0),
    customerType: (() => { const n = parseInt(row.BoxNumber || row.box_number || row.package_num || 0); return n === 1 ? 'New Customer' : n >= 2 ? 'Recurring Customer' : ''; })(),
    product_color_style: row.product_color_style || row.ColorStyle || row.color_style || '',
    product_seasonality: row.product_seasonality || row.Seasonality || row.seasonality || '',
    product_sourcing: row.product_sourcing || row.Sourcing || row.sourcing || '',
    ShipAddrState: row.ShipAddrState || row.ship_addr_state || row.State || row.state || '',
    shipped_date: parseMetabaseDate(row.shipped_date || row.ShippedDate) || null,
    delivered_date: parseMetabaseDate(row.delivered_date || row.DeliveredDate) || null,
    FB_rating_date: parseMetabaseDate(row.FB_rating_date || row.fb_rating_date || row.RatingDate) || null,
    FBbox_rating_date: parseMetabaseDate(row.FBbox_rating_date || row.fbbox_rating_date) || null,
    boxStyleAccuracy: row.boxStyleAccuracy || row.StyleAccuracy || '',
    itemQuality: row.itemQuality || row.Quality || '',
    itemFit: row.itemFit || row.product_fit || row.Fit || '',
    itemComment: row.itemComment || row.Comment || row.comment || row.Review || '',
    standard_price: parseFloat(row.standard_price || row.Price || 0),
    boxValue: parseFloat(row.boxValue || row.BoxValue || 0),
    product_front_image_url: row.product_front_image_url || row.ImageURL || ''
  };
}

/**
 * Parse Metabase date formats:
 * "January 1, 2026, 12:37 AM" → "2026-01-01"
 * "December 23, 2025, 9:00 AM" → "2025-12-23"
 * Also handles ISO dates "2026-01-15" as passthrough.
 */
function parseMetabaseDate(str) {
  if (!str || str === 'null' || str === '') return '';

  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.substring(0, 10);

  // Metabase format: "Month Day, Year, Time"
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
  } catch (e) {}

  return '';
}

/**
 * Clean number strings with commas: "2,626,475" → 2626475
 */
function cleanNumber(str) {
  if (!str) return null;
  return parseInt(String(str).replace(/,/g, '')) || null;
}

/**
 * Simplify style strings: "Streetwear - A blend of street..." → "Streetwear"
 */
function simplifyStyle(str) {
  if (!str) return '';
  const dash = str.indexOf(' - ');
  if (dash > 0) return str.substring(0, dash).trim();
  const plus = str.indexOf(' + ');
  if (plus > 0) return str.substring(0, plus).trim();
  return str.trim();
}

/**
 * Simplify fit strings: "Skinny Slim - Snug-fitting..." → "Skinny Slim"
 */
function simplifyFit(str) {
  if (!str) return '';
  const dash = str.indexOf(' - ');
  if (dash > 0) return str.substring(0, dash).trim();
  return str.trim();
}

/**
 * Detect which dimensions have meaningful data (non-empty values).
 */
function detectAvailableDimensions(rows) {
  const sample = rows.slice(0, 100);
  const dims = [
    'product_brand', 'product_category', 'product_subcategory',
    'product_item_style', 'Stylist', 'plan', 'customerType', 'BoxNumber',
    'product_color_style', 'product_seasonality', 'product_sourcing',
    'ShipAddrState', 'DayStyle', 'EveningStyle', 'BottomFit',
    'TopSize', 'Value', 'Presentation'
  ];
  return dims.filter(d => {
    const hasData = sample.some(r => r[d] && String(r[d]).trim() !== '' && String(r[d]) !== '0');
    return hasData;
  });
}

// ============================================================
// BOX HEALTH CACHE — separate NDJSON file (bq_cache_box.json)
// Format: line 1 = metadata, remaining lines = rows tagged with _type
// ============================================================

async function readBoxCacheAsync() {
  try {
    if (!fs.existsSync(BOX_CACHE_FILE)) return null;
    const ageMs = Date.now() - fs.statSync(BOX_CACHE_FILE).mtimeMs;
    if (ageMs > CACHE_MAX_AGE_MS) {
      console.log(`  Box cache stale (${Math.round(ageMs / 3600000)}h old) — will re-fetch\n`);
      return null;
    }
    const sizeMB = (fs.statSync(BOX_CACHE_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`  Box cache hit (${Math.round(ageMs / 60000)}m old, ${sizeMB}MB) — streaming...`);

    const readline = require('readline');
    const rl = readline.createInterface({
      input: fs.createReadStream(BOX_CACHE_FILE, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    });

    const styleAccuracy   = [];
    const valuePerception = [];
    const fitSignal       = [];
    const boxTrend        = [];
    let boxDrivers        = {};
    let firstLine = true;
    let meta = null;

    await new Promise((resolve, reject) => {
      rl.on('line', (line) => {
        if (!line.trim()) return;
        if (firstLine) { meta = JSON.parse(line); firstLine = false; return; }
        const row = JSON.parse(line);
        if (row._type === 'style')   { const { _type, ...r } = row; styleAccuracy.push(r); }
        else if (row._type === 'value')   { const { _type, ...r } = row; valuePerception.push(r); }
        else if (row._type === 'fit')     { const { _type, ...r } = row; fitSignal.push(r); }
        else if (row._type === 'trend')   { const { _type, ...r } = row; boxTrend.push(r); }
        else if (row._type === 'drivers') { boxDrivers = row.data; }
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });

    const driverCount = Object.values(boxDrivers).reduce((s,a) => s + (a?.length||0), 0);
    console.log(`  Box cache loaded: ${styleAccuracy.length} style / ${valuePerception.length} value / ${fitSignal.length} fit / ${boxTrend.length} trend / ${driverCount} driver rows\n`);
    return { styleAccuracy, valuePerception, fitSignal, boxTrend, boxDrivers };
  } catch (e) {
    console.log(`  Box cache read failed: ${e.message} — will re-fetch\n`);
    return null;
  }
}

function writeBoxCache({ styleAccuracy, valuePerception, fitSignal, boxTrend, boxDrivers }) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const bd = boxDrivers || {};
    const driverCount = Object.values(bd).reduce((s,a) => s + (a?.length||0), 0);
    const total = styleAccuracy.length + valuePerception.length + fitSignal.length + (boxTrend||[]).length + driverCount;
    const stream = fs.createWriteStream(BOX_CACHE_FILE, { encoding: 'utf-8' });
    stream.write(JSON.stringify({
      fetchedAt:    new Date().toISOString(),
      styleCount:   styleAccuracy.length,
      valueCount:   valuePerception.length,
      fitCount:     fitSignal.length,
      trendCount:   (boxTrend || []).length,
      driverCount
    }) + '\n');
    for (const r of styleAccuracy)        stream.write(JSON.stringify({ _type: 'style',  ...r }) + '\n');
    for (const r of valuePerception)      stream.write(JSON.stringify({ _type: 'value',  ...r }) + '\n');
    for (const r of fitSignal)            stream.write(JSON.stringify({ _type: 'fit',    ...r }) + '\n');
    for (const r of (boxTrend || []))     stream.write(JSON.stringify({ _type: 'trend',  ...r }) + '\n');
    stream.write(JSON.stringify({ _type: 'drivers', data: bd }) + '\n');
    stream.end(() => {
      const sizeMB = (fs.statSync(BOX_CACHE_FILE).size / 1024 / 1024).toFixed(1);
      console.log(`  Box cache saved: ${total} rows (${sizeMB} MB) → bq_cache_box.json\n`);
    });
  } catch (e) {
    console.log(`  Box cache write failed (non-fatal): ${e.message}\n`);
  }
}

function clearBoxCache() {
  try {
    if (fs.existsSync(BOX_CACHE_FILE)) {
      fs.unlinkSync(BOX_CACHE_FILE);
      console.log('  Box cache cleared\n');
    }
  } catch (e) { console.log(`  Box cache clear failed: ${e.message}\n`); }
}

/**
 * Load box health datasets: box cache → BigQuery → empty fallback.
 * Returns { styleAccuracy, valuePerception, fitSignal }.
 */
async function loadBoxHealthData() {
  // 1. Try box cache
  const cached = await readBoxCacheAsync();
  if (cached) return cached;

  // 2. Try BigQuery
  if (fs.existsSync(BQ_KEY)) {
    try {
      const { fetchStyleAccuracy, fetchValuePerception, fetchFitSignal, fetchBoxTrend, fetchBoxDrivers } = require('./bigquery');
      const [styleAccuracy, valuePerception, fitSignal, boxTrend, boxDrivers] = await Promise.all([
        fetchStyleAccuracy(),
        fetchValuePerception(),
        fetchFitSignal(),
        fetchBoxTrend(),
        fetchBoxDrivers()
      ]);
      const result = { styleAccuracy, valuePerception, fitSignal, boxTrend, boxDrivers };
      writeBoxCache(result);
      return result;
    } catch (e) {
      console.log(`  Box Health BQ fetch failed: ${e.message}\n`);
    }
  }

  // 3. Empty fallback (no CSV source for box health aggregates)
  console.log('  Box Health: no cache and no BQ key — returning empty datasets\n');
  return { styleAccuracy: [], valuePerception: [], fitSignal: [], boxTrend: [], boxDrivers: {} };
}

module.exports = { loadData, clearCache, clearBoxCache, getCacheInfo, loadBoxHealthData, CACHE_FILE, BOX_CACHE_FILE };
