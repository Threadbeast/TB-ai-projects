require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { loadData, clearCache, clearBoxCache, getCacheInfo, loadBoxHealthData } = require('./data/loader');
const { computeStats } = require('./stats');
const { listDatasets, listTables, getTableSchema, runQuery, fetchRollingBaselines, fetchWeeklyTrendBQ } = require('./data/bigquery');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

let DATA = null;
let AVAILABLE_DIMS = [];
let loadingPromise = null;

// Box Health datasets — loaded in parallel with master_orders
let BOX_DATA = null;       // { styleAccuracy, valuePerception, fitSignal }
let boxLoadingPromise = null;

async function ensureData() {
  if (DATA) return DATA;
  if (loadingPromise) return loadingPromise;
  loadingPromise = loadData().then(data => {
    DATA = data;
    AVAILABLE_DIMS = detectDimensions(DATA);
    console.log(`  Active dimensions: ${AVAILABLE_DIMS.join(', ')}\n`);
    loadingPromise = null;
    return DATA;
  });
  return loadingPromise;
}

async function ensureBoxData() {
  if (BOX_DATA) return BOX_DATA;
  if (boxLoadingPromise) return boxLoadingPromise;
  boxLoadingPromise = loadBoxHealthData().then(data => {
    BOX_DATA = data;
    boxLoadingPromise = null;
    return BOX_DATA;
  });
  return boxLoadingPromise;
}

function detectDimensions(rows) {
  const allDims = [
    'product_brand', 'product_category', 'product_subcategory',
    'product_item_style', 'Stylist', 'plan', 'customerType', 'BoxNumber',
    'product_color_style', 'product_seasonality', 'product_sourcing',
    'ShipAddrState', 'DayStyle', 'EveningStyle', 'BottomFit',
    'TopSize', 'WaistSize', 'Value', 'Presentation', 'ShopAt'
  ];
  const sample = rows.slice(0, 200);
  return allDims.filter(d =>
    sample.some(r => r[d] && String(r[d]).trim() !== '' && String(r[d]) !== '0')
  );
}

// API: Get summary stats for a date range and rating type
app.get('/api/summary', async (req, res) => {
  if (!DATA && loadingPromise) {
    res.json({ loading: true, baseline: { rate: 0, hateCount: 0, neutralCount: 0, loveCount: 0, total: 0 }, totalRated: 0, weeklyTrend: [], rollingBaselines: null });
    return;
  }
  const data = await ensureData();
  const { start, end, ratingType = 'item', timeView = 'received' } = req.query;
  const stats = computeStats(data, { start, end, ratingType, timeView });
  res.json(stats);
});

// API: Get driver breakdown for a specific dimension
app.get('/api/drivers', async (req, res) => {
  const data = await ensureData();
  const { dimension, start, end, ratingType = 'item', timeView = 'received', drillValue } = req.query;
  const stats = computeStats(data, { start, end, ratingType, timeView, dimension, drillValue });
  res.json(stats);
});

// API: Get all dimensions ranked by impact
app.get('/api/ranked-drivers', async (req, res) => {
  const data = await ensureData();
  const { start, end, ratingType = 'item', timeView = 'received' } = req.query;

  const dimensions = AVAILABLE_DIMS.length > 0 ? AVAILABLE_DIMS : [
    'Stylist', 'ShipAddrState', 'DayStyle', 'EveningStyle', 'BoxNumber'
  ];

  const results = {};
  for (const dim of dimensions) {
    const dimStats = computeStats(data, { start, end, ratingType, timeView, dimension: dim });
    results[dim] = dimStats.drivers;
  }
  res.json({ baseline: computeStats(data, { start, end, ratingType, timeView }).baseline, dimensions: results });
});

// API: Early warning — shipped cohorts
app.get('/api/early-warning', async (req, res) => {
  const data = await ensureData();
  const { weeks = 4, ratingType = 'item' } = req.query;
  const stats = computeStats(data, { ratingType, timeView: 'shipped', earlyWarning: true, weeks: parseInt(weeks) });
  res.json(stats);
});

// API: Generate report
app.get('/api/report', async (req, res) => {
  const data = await ensureData();
  const { start, end, ratingType = 'item' } = req.query;

  const dimensions = AVAILABLE_DIMS.length > 0 ? AVAILABLE_DIMS : [
    'Stylist', 'ShipAddrState', 'DayStyle', 'EveningStyle', 'BoxNumber'
  ];

  const allDrivers = [];
  for (const dim of dimensions) {
    const dimStats = computeStats(data, { start, end, ratingType, timeView: 'received', dimension: dim });
    for (const d of dimStats.drivers) {
      allDrivers.push({ ...d, dimension: dim });
    }
  }

  // Sort all drivers by absolute lift
  allDrivers.sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift));

  const baseline = computeStats(data, { start, end, ratingType, timeView: 'received' }).baseline;
  const earlyWarning = computeStats(data, { ratingType, timeView: 'shipped', earlyWarning: true, weeks: 4 });

  // Stylist variance
  const stylistStats = computeStats(data, { start, end, ratingType, timeView: 'received', dimension: 'Stylist' });

  res.json({
    baseline,
    topDrivers: allDrivers.slice(0, 15),
    stylistVariance: stylistStats.drivers,
    earlyWarning: earlyWarning.cohorts,
    generatedAt: new Date().toISOString()
  });
});

// API: Chat — TB-3PO powered by Claude
// Accepts: { message, history, context }
// history: [{role:'user'|'assistant', content:string}] — last N turns
// context: small snapshot of current dashboard state from the frontend
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_key_here') {
    return res.json({
      reply: 'TB-3PO is offline — no API key detected. Add your ANTHROPIC_API_KEY to the .env file and restart the server.',
      needsApiKey: true
    });
  }

  const { message, history = [], context = {} } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Build a compact data snapshot from in-memory DATA
  let dataSnapshot = null;
  try {
    const data = await ensureData();
    if (data && data.length > 0) {
      const now = new Date();
      const ago = (days) => {
        const d = new Date(now); d.setDate(d.getDate() - days);
        return d.toISOString().split('T')[0];
      };
      const thirtyDaysAgo = ago(30);

      // Overall item and box stats (last 30 days)
      const overall  = computeStats(data, { start: thirtyDaysAgo, ratingType: 'item' });
      const boxStats = computeStats(data, { start: thirtyDaysAgo, ratingType: 'box' });

      // Helper: compact driver row
      const compact = (d, dim) => ({
        dimension: dim,
        value:    d.value,
        hateRate: Math.round(d.hateRate * 1000) / 10,  // percent, e.g. 18.4
        lift:     Math.round(d.lift     * 1000) / 10,  // percent lift vs baseline
        zScore:   Math.round(d.zScore   * 100)  / 100,
        total:    d.total,
        direction: d.direction
      });

      // Per-dimension top-10 (min 25 items, last 30 days)
      const MIN_VOL = 25;
      const byDim = {};
      for (const dim of ['product_brand', 'product_category', 'product_subcategory', 'Stylist', 'plan']) {
        const s = computeStats(data, { start: thirtyDaysAgo, ratingType: 'item', dimension: dim });
        if (s.drivers) {
          const eligible = s.drivers.filter(d => d.total >= MIN_VOL);
          byDim[dim] = {
            worst: eligible.filter(d => d.direction === 'above')
                           .sort((a, b) => b.hateRate - a.hateRate)
                           .slice(0, 10).map(d => compact(d, dim)),
            best:  eligible.filter(d => d.direction === 'below')
                           .sort((a, b) => a.hateRate - b.hateRate)
                           .slice(0, 5).map(d => compact(d, dim))
          };
        }
      }

      // Weekly trend — last 8 complete Sun-Sat weeks
      const weeklyMap = {};
      for (const r of data) {
        if (!r.itemRating || r.itemRating === 0 || !r.FB_rating_date) continue;
        const d   = new Date(r.FB_rating_date + 'T00:00:00');
        const sun = new Date(d.getTime() - d.getDay() * 86400000);
        const wk  = sun.toISOString().split('T')[0];
        if (!weeklyMap[wk]) weeklyMap[wk] = { hate: 0, total: 0 };
        weeklyMap[wk].total++;
        if (r.itemRating <= 2) weeklyMap[wk].hate++;
      }
      const thisSun = new Date(now.getTime() - now.getDay() * 86400000).toISOString().split('T')[0];
      const weeklyTrend = Object.entries(weeklyMap)
        .filter(([wk]) => wk < thisSun)           // exclude current incomplete week
        .sort((a, b) => b[0].localeCompare(a[0])) // newest first
        .slice(0, 8)
        .map(([wk, c]) => ({
          week:     wk,
          hateRate: Math.round(c.hate / c.total * 1000) / 10,
          total:    c.total
        }))
        .reverse();                                // chronological for readability

      dataSnapshot = {
        dataAsOf:        now.toISOString().split('T')[0],
        totalDataRows:   data.length,
        periodDays:      30,
        periodStart:     thirtyDaysAgo,
        overallHateRate: Math.round(overall.baseline.rate  * 1000) / 10,
        totalRatedItems: overall.totalRated,
        boxHateRate:     Math.round(boxStats.baseline.rate * 1000) / 10,
        byDimension:     byDim,
        weeklyTrend
      };
    }
  } catch (e) {
    console.error('TB-3PO data context build failed:', e.message);
  }

  // System prompt
  const systemPrompt = `You are TB-3PO, ThreadBeast's data analyst protocol droid. You speak with quiet confidence — direct, efficient, a hint of Star Wars droid personality, but never over-the-top.

ThreadBeast is a subscription clothing box service. Customers receive a box of clothing items and rate each item 1–5 stars.
- "Hate It" = 1 or 2 stars. "Love It" = 4 or 5 stars.
- "Hate It Rate" = % of items rated 1 or 2 stars. Lower is better. Typical range: 10–25%.
- "Lift" = how much higher/lower than the overall average (e.g. +40% lift means 40% worse than baseline)
- "Z-Score" = statistical significance. |z| > 1.96 = significant. Higher = more certain the signal is real, not noise.
- Dimensions: product_brand, product_category, product_subcategory, Stylist, plan
- New customer = BoxNumber 1 (first box). Recurring = BoxNumber 2+.
- hateRate values in the data are already percentages (e.g. 18.4 means 18.4%)

Data covers the last 30 days unless the weekly trend is referenced.
The byDimension object has "worst" (highest hate rate) and "best" (lowest hate rate) for each dimension, minimum 25 rated items, top 10 each.
The weeklyTrend array shows the last 8 complete weeks, chronological, with hateRate as a percentage.

${dataSnapshot ? `LIVE DATA SNAPSHOT:\n${JSON.stringify(dataSnapshot, null, 2)}` : 'Note: Live data is still loading — answer based on general ThreadBeast context.'}

${context && Object.keys(context).length > 0 ? `Current dashboard state: ${JSON.stringify(context)}` : ''}

Rules:
- Answer using real numbers from the snapshot. Be specific — name the brand/category/value and its hate rate.
- If the user asks for a weekly breakdown you don't have (e.g. a specific named week), explain you have the last 8 weeks of weekly totals but not per-dimension weekly splits.
- Keep responses under 300 words. No jargon. Plain English.
- If you genuinely don't have the data, say so clearly and tell them what you DO have.`;

  try {
    const client = new Anthropic({ apiKey });

    // Build message list: trim history to last 10 turns to manage token budget
    const trimmedHistory = history.slice(-10);
    const messages = [
      ...trimmedHistory,
      { role: 'user', content: message }
    ];

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: systemPrompt,
      messages
    });

    const reply = response.content[0]?.text || 'I encountered an issue processing that. Please try again.';
    res.json({ reply });
  } catch (e) {
    console.error('TB-3PO Claude API error:', e.message);
    res.json({
      reply: `I sense a disturbance in the Force... API error: ${e.message}`,
      error: true
    });
  }
});

// API: Rolling baselines from BQ (aggregated — fast, no memory load)
app.get('/api/baselines', async (req, res) => {
  try {
    const { start, end, ratingType = 'item' } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });
    const baselines = await fetchRollingBaselines(start, end, ratingType);
    res.json(baselines);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Full-history weekly trend from BQ (with year-ago overlay)
app.get('/api/trend', async (req, res) => {
  try {
    const { start, end, ratingType = 'item' } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });
    const trend = await fetchWeeklyTrendBQ(start, end, ratingType);
    res.json({ trend });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- BigQuery Discovery APIs ---
app.get('/api/bq/datasets', async (req, res) => {
  try {
    const datasets = await listDatasets();
    res.json({ datasets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bq/tables/:dataset', async (req, res) => {
  try {
    const tables = await listTables(req.params.dataset);
    res.json({ tables });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bq/schema/:dataset/:table', async (req, res) => {
  try {
    const schema = await getTableSchema(req.params.dataset, req.params.table);
    res.json({ schema });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bq/query', async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql) return res.status(400).json({ error: 'sql required' });
    // Safety: only allow SELECT
    if (!/^\s*SELECT/i.test(sql)) return res.status(400).json({ error: 'Only SELECT queries allowed' });
    const rows = await runQuery(sql);
    res.json({ rows: rows.slice(0, 1000), totalRows: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Force reload from BigQuery
app.post('/api/bq/reload', async (req, res) => {
  try {
    const { loadMasterOrders } = require('./data/bigquery');
    const startDate = req.body.startDate || '2026-01-01';
    const rows = await loadMasterOrders(startDate);
    DATA = rows;
    AVAILABLE_DIMS = detectDimensions(DATA);
    res.json({ rows: rows.length, dimensions: AVAILABLE_DIMS, source: 'bigquery' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// API: Box Health
// Returns style accuracy, value perception, fit signal (from BQ cache),
// plus boxTrend computed live from in-memory DATA (deduplicated by mcID).
// ============================================================
app.get('/api/box-health', async (req, res) => {
  const { start, end } = req.query;

  // Load box health datasets (cache or BQ)
  const boxData = await ensureBoxData();

  // Filter helper — apply date range to week_start field
  function filterByDate(rows) {
    if (!start && !end) return rows;
    return rows.filter(r => {
      return (!start || r.week_start >= start) && (!end || r.week_start <= end);
    });
  }

  // boxTrend now comes from BQ (feedback3userbox) — full year, clean source
  const boxTrend = filterByDate(boxData.boxTrend || []);

  res.json({
    styleAccuracy:   filterByDate(boxData.styleAccuracy),
    valuePerception: filterByDate(boxData.valuePerception),
    fitSignal:       filterByDate(boxData.fitSignal),
    boxTrend,
    boxDrivers:      boxData.boxDrivers || {}
  });
});

// API: Customer Profiles — plan breakdown computed from in-memory DATA
// boxDrivers (package_num, DayStyle, etc.) comes from BQ cache via /api/box-health.
// This endpoint only needs to cover the dimensions NOT in boxDrivers — primarily "plan".
app.get('/api/customer-profiles', async (req, res) => {
  const data = await ensureData();
  const { start, end } = req.query;
  const MIN_VOL = 30;

  // Compute plan breakdown using box-level dedup (one row per mcID)
  const seen = new Set();
  const planMap = {};
  let totalHate = 0, totalBoxes = 0;

  for (const r of data) {
    if (!r.boxRating || r.boxRating === 0) continue;
    if (start && r.FB_rating_date < start) continue;
    if (end   && r.FB_rating_date > end)   continue;
    if (!r.mcID || seen.has(r.mcID)) continue;
    seen.add(r.mcID);

    const planVal = r.plan || '(unknown)';
    if (!planMap[planVal]) planMap[planVal] = { hate: 0, love: 0, total: 0 };
    const rating = Number(r.boxRating);
    planMap[planVal].total++;
    if (rating <= 2) { planMap[planVal].hate++; totalHate++; }
    if (rating >= 4)   planMap[planVal].love++;
    totalBoxes++;
  }

  const baseline = totalBoxes > 0 ? totalHate / totalBoxes : 0;

  const byPlan = Object.entries(planMap)
    .filter(([, c]) => c.total >= MIN_VOL)
    .map(([value, c]) => ({
      value,
      hateRate: c.hate / c.total,
      loveRate: c.love / c.total,
      total:    c.total,
      lift:     baseline > 0 ? (c.hate / c.total - baseline) / baseline : 0
    }))
    .sort((a, b) => a.hateRate - b.hateRate);

  res.json({ byPlan, baseline });
});

// API: Box Lag Analysis — computed entirely from in-memory master_orders DATA
// Uses shipped_date (ship week) and FBbox_rating_date (rating week), deduped by mcID.
app.get('/api/lag-analysis', async (req, res) => {
  const data = await ensureData();
  const { weeks: weeksParam, lagWindow = '14', customerType = 'all' } = req.query;
  const lagWin = Math.min(Math.max(parseInt(lagWindow) || 14, 7), 30);

  // Snap a date string to its Sunday-start week boundary
  function toSunWeek(dateStr) {
    if (!dateStr || dateStr.length < 10) return null;
    const d = new Date(dateStr.substring(0, 10) + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    const day = d.getDay(); // 0 = Sun
    d.setDate(d.getDate() - day);
    return d.toISOString().split('T')[0];
  }

  // Deduplicate by mcID — one row per box, keep first occurrence
  const boxMap = new Map();
  for (const row of data) {
    if (!row.mcID || !row.shipped_date || !row.FBbox_rating_date) continue;
    if (!row.boxRating || Number(row.boxRating) === 0) continue;
    if (!boxMap.has(row.mcID)) boxMap.set(row.mcID, row);
  }

  // Enrich each box with computed lag fields
  const boxes = [];
  for (const r of boxMap.values()) {
    const shipWeek   = toSunWeek(r.shipped_date);
    const ratingWeek = toSunWeek(r.FBbox_rating_date);
    if (!shipWeek || !ratingWeek) continue;
    const shipMs   = new Date(r.shipped_date.substring(0, 10) + 'T00:00:00').getTime();
    const rateMs   = new Date(r.FBbox_rating_date.substring(0, 10) + 'T00:00:00').getTime();
    const daysToRate = Math.round((rateMs - shipMs) / 86400000);
    if (daysToRate < 0 || daysToRate > 365) continue; // sanity filter
    const boxNum   = parseInt(r.BoxNumber) || 0;
    const custType = boxNum === 1 ? 'new' : 'recurring';
    boxes.push({
      shipWeek, ratingWeek, daysToRate,
      isHate: Number(r.boxRating) <= 2,
      isLove: Number(r.boxRating) >= 4,
      custType
    });
  }

  // Apply customer type filter
  const filtered = customerType === 'new'      ? boxes.filter(b => b.custType === 'new') :
                   customerType === 'recurring' ? boxes.filter(b => b.custType === 'recurring') : boxes;

  // Available ship weeks sorted desc
  const shipWeeksSet = new Set(filtered.map(b => b.shipWeek));
  const availableWeeks = [...shipWeeksSet].sort().reverse();

  // Median days to rate (full filtered dataset)
  const allDays = filtered.map(b => b.daysToRate).sort((a, b) => a - b);
  const medianDaysToRate = allDays.length > 0 ? allDays[Math.floor(allDays.length / 2)] : 14;

  // Selected weeks (up to 4, validated against available)
  const selectedWeeks = weeksParam
    ? weeksParam.split(',').map(w => w.trim()).filter(w => shipWeeksSet.has(w)).slice(0, 4)
    : availableWeeks.slice(0, 1);

  // Build per-ship-week lookup (single pass) for lag curve + table
  const byShipWeek = {};
  for (const b of filtered) {
    if (!byShipWeek[b.shipWeek]) byShipWeek[b.shipWeek] = [];
    byShipWeek[b.shipWeek].push(b);
  }

  // Lag Curve: per selected week × per day-since-ship bucket
  const lagCurve = {};
  for (const wk of selectedWeeks) {
    const wkBoxes = byShipWeek[wk] || [];
    const byDay = {};
    for (const b of wkBoxes) {
      if (b.daysToRate < 1 || b.daysToRate > lagWin) continue;
      if (!byDay[b.daysToRate]) byDay[b.daysToRate] = { hate: 0, total: 0 };
      byDay[b.daysToRate].hate  += b.isHate ? 1 : 0;
      byDay[b.daysToRate].total += 1;
    }
    lagCurve[wk] = byDay;
  }

  // Heatmap: last 12 ship weeks × last 12 rating weeks — single pass build
  const last12Ship   = availableWeeks.slice(0, 12);
  const ratingWeeksSet = new Set(filtered.map(b => b.ratingWeek));
  const last12Rating = [...ratingWeeksSet].sort().reverse().slice(0, 12).reverse(); // asc for display

  const heatmapRaw = {};
  for (const b of filtered) {
    const sw = b.shipWeek, rw = b.ratingWeek;
    if (!heatmapRaw[sw]) heatmapRaw[sw] = {};
    if (!heatmapRaw[sw][rw]) heatmapRaw[sw][rw] = { hate: 0, total: 0 };
    heatmapRaw[sw][rw].hate  += b.isHate ? 1 : 0;
    heatmapRaw[sw][rw].total += 1;
  }
  const heatmap = {};
  for (const sw of last12Ship) {
    heatmap[sw] = {};
    for (const rw of last12Rating) {
      const cell = heatmapRaw[sw]?.[rw];
      if (cell) heatmap[sw][rw] = { ...cell, rate: cell.hate / cell.total };
    }
  }

  // Summary table — one row per selected ship week
  const table = selectedWeeks.map(wk => {
    const wkBoxes = byShipWeek[wk] || [];
    const hate  = wkBoxes.filter(b => b.isHate).length;
    const love  = wkBoxes.filter(b => b.isLove).length;
    const total = wkBoxes.length;
    const newB  = wkBoxes.filter(b => b.custType === 'new');
    const recB  = wkBoxes.filter(b => b.custType === 'recurring');
    const days  = wkBoxes.map(b => b.daysToRate).filter(d => d >= 0).sort((a, b) => a - b);
    const avgDays = days.length ? Math.round(days.reduce((s, d) => s + d, 0) / days.length) : null;
    return {
      shipWeek: wk, total,
      hateRate:          total > 0 ? hate / total : 0,
      loveRate:          total > 0 ? love / total : 0,
      avgDaysToRate:     avgDays,
      newHateRate:       newB.length ? newB.filter(b => b.isHate).length / newB.length : null,
      recurringHateRate: recB.length ? recB.filter(b => b.isHate).length / recB.length : null,
      newTotal: newB.length,
      recTotal: recB.length
    };
  });

  res.json({
    lagCurve, heatmap, table,
    availableWeeks, selectedWeeks,
    medianDaysToRate, lagWindow: lagWin,
    shipWeeks: last12Ship,
    ratingWeeks: last12Rating
  });
});

// API: Brand × Category Heatmap for Item Health
// Returns top 20 brands by volume × all categories, with hate rate per cell.
app.get('/api/brand-category-heatmap', async (req, res) => {
  const data = await ensureData();
  const { start, end, ratingType = 'item' } = req.query;
  const ratingField = ratingType === 'box' ? 'boxRating' : 'itemRating';
  const dateField   = 'FB_rating_date';

  // Filter to rated rows with date
  let rows = data.filter(r => r[ratingField] > 0 && r[dateField]);
  if (start) rows = rows.filter(r => r[dateField] >= start);
  if (end)   rows = rows.filter(r => r[dateField] <= end);

  // Build brand × category matrix
  const matrix = {};   // matrix[brand][category] = {hate, total}
  const brandTotals = {};
  const categorySet = new Set();

  for (const r of rows) {
    const brand = r.product_brand || 'Unknown';
    const cat   = r.product_category || 'Unknown';
    if (!matrix[brand]) matrix[brand] = {};
    if (!matrix[brand][cat]) matrix[brand][cat] = { hate: 0, total: 0 };
    matrix[brand][cat].total++;
    if (r[ratingField] <= 2) matrix[brand][cat].hate++;
    brandTotals[brand] = (brandTotals[brand] || 0) + 1;
    categorySet.add(cat);
  }

  // Top 20 brands by volume
  const brands = Object.entries(brandTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([b]) => b);

  const categories = [...categorySet].sort();

  // Build cells array
  const cells = [];
  for (const brand of brands) {
    for (const cat of categories) {
      const cell = matrix[brand]?.[cat];
      if (cell && cell.total >= 3) {
        cells.push({
          brand, category: cat,
          hateRate: cell.hate / cell.total,
          hateCount: cell.hate,
          total: cell.total
        });
      }
    }
  }

  res.json({ cells, brands, categories, totalRows: rows.length });
});

// API: Item Lag Analysis — item-level (no mcID dedup)
// Uses shipped_date (ship week) and FB_rating_date (rating week), itemRating.
// Optional ?dimension=product_brand returns breakdown table for the selected ship week(s).
app.get('/api/item-lag-analysis', async (req, res) => {
  const data = await ensureData();
  const {
    weeks: weeksParam,
    lagWindow = '14',
    customerType = 'all',
    dimension = ''
  } = req.query;

  const lagWin = Math.min(Math.max(parseInt(lagWindow) || 14, 7), 30);

  function toSunWeek(dateStr) {
    if (!dateStr || dateStr.length < 10) return null;
    const d = new Date(dateStr.substring(0, 10) + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    const day = d.getDay();
    d.setDate(d.getDate() - day);
    return d.toISOString().split('T')[0];
  }

  // Enrich each rated item with lag fields (item-level, no dedup)
  const items = [];
  for (const r of data) {
    if (!r.itemRating || Number(r.itemRating) === 0) continue;
    if (!r.shipped_date || !r.FB_rating_date) continue;
    const shipWeek   = toSunWeek(r.shipped_date);
    const ratingWeek = toSunWeek(r.FB_rating_date);
    if (!shipWeek || !ratingWeek) continue;
    const shipMs   = new Date(r.shipped_date.substring(0, 10) + 'T00:00:00').getTime();
    const rateMs   = new Date(r.FB_rating_date.substring(0, 10) + 'T00:00:00').getTime();
    const daysToRate = Math.round((rateMs - shipMs) / 86400000);
    if (daysToRate < 0 || daysToRate > 365) continue;
    const boxNum   = parseInt(r.BoxNumber) || 0;
    const custType = boxNum === 1 ? 'new' : 'recurring';
    items.push({
      shipWeek, ratingWeek, daysToRate,
      isHate: Number(r.itemRating) <= 2,
      isLove: Number(r.itemRating) >= 4,
      custType,
      dimValue: dimension ? (r[dimension] || '') : ''
    });
  }

  // Customer type filter
  const filtered = customerType === 'new'      ? items.filter(i => i.custType === 'new') :
                   customerType === 'recurring' ? items.filter(i => i.custType === 'recurring') : items;

  const shipWeeksSet = new Set(filtered.map(i => i.shipWeek));
  const availableWeeks = [...shipWeeksSet].sort().reverse();

  const allDays = filtered.map(i => i.daysToRate).sort((a, b) => a - b);
  const medianDaysToRate = allDays.length > 0 ? allDays[Math.floor(allDays.length / 2)] : 14;

  const selectedWeeks = weeksParam
    ? weeksParam.split(',').map(w => w.trim()).filter(w => shipWeeksSet.has(w)).slice(0, 4)
    : availableWeeks.slice(0, 1);

  const byShipWeek = {};
  for (const i of filtered) {
    if (!byShipWeek[i.shipWeek]) byShipWeek[i.shipWeek] = [];
    byShipWeek[i.shipWeek].push(i);
  }

  // Lag Curve per selected week × per day bucket
  const lagCurve = {};
  for (const wk of selectedWeeks) {
    const wkItems = byShipWeek[wk] || [];
    const byDay = {};
    for (const i of wkItems) {
      if (i.daysToRate < 1 || i.daysToRate > lagWin) continue;
      if (!byDay[i.daysToRate]) byDay[i.daysToRate] = { hate: 0, total: 0 };
      byDay[i.daysToRate].hate  += i.isHate ? 1 : 0;
      byDay[i.daysToRate].total += 1;
    }
    lagCurve[wk] = byDay;
  }

  // Heatmap: last 12 ship weeks × last 12 rating weeks
  const last12Ship    = availableWeeks.slice(0, 12);
  const ratingWeeksSet = new Set(filtered.map(i => i.ratingWeek));
  const last12Rating  = [...ratingWeeksSet].sort().reverse().slice(0, 12).reverse();

  const heatmapRaw = {};
  for (const i of filtered) {
    const sw = i.shipWeek, rw = i.ratingWeek;
    if (!heatmapRaw[sw]) heatmapRaw[sw] = {};
    if (!heatmapRaw[sw][rw]) heatmapRaw[sw][rw] = { hate: 0, total: 0 };
    heatmapRaw[sw][rw].hate  += i.isHate ? 1 : 0;
    heatmapRaw[sw][rw].total += 1;
  }
  const heatmap = {};
  for (const sw of last12Ship) {
    heatmap[sw] = {};
    for (const rw of last12Rating) {
      const cell = heatmapRaw[sw]?.[rw];
      if (cell) heatmap[sw][rw] = { ...cell, rate: cell.hate / cell.total };
    }
  }

  // Summary table — one row per selected ship week
  const table = selectedWeeks.map(wk => {
    const wkItems = byShipWeek[wk] || [];
    const hate  = wkItems.filter(i => i.isHate).length;
    const love  = wkItems.filter(i => i.isLove).length;
    const total = wkItems.length;
    const newI  = wkItems.filter(i => i.custType === 'new');
    const recI  = wkItems.filter(i => i.custType === 'recurring');
    const days  = wkItems.map(i => i.daysToRate).filter(d => d >= 0).sort((a, b) => a - b);
    const avgDays = days.length ? Math.round(days.reduce((s, d) => s + d, 0) / days.length) : null;
    return {
      shipWeek: wk, total,
      hateRate:          total > 0 ? hate / total : 0,
      loveRate:          total > 0 ? love / total : 0,
      avgDaysToRate:     avgDays,
      newHateRate:       newI.length ? newI.filter(i => i.isHate).length / newI.length : null,
      recurringHateRate: recI.length ? recI.filter(i => i.isHate).length / recI.length : null,
      newTotal: newI.length,
      recTotal: recI.length
    };
  });

  // Overall baseline: hate rate across all filtered items (for lift / z-score)
  const filtTotalHate  = filtered.filter(i => i.isHate).length;
  const filtBaselineRate = filtered.length > 0 ? filtTotalHate / filtered.length : 0;

  // Dimension breakdown — for each selected week, rank dim values by hate rate (min 5 items)
  // Includes lift vs baseline, z-score, significance, new/recurring hate rates
  const dimensionBreakdown = {};
  if (dimension) {
    for (const wk of selectedWeeks) {
      const wkItems = byShipWeek[wk] || [];
      const dimMap = {};
      for (const i of wkItems) {
        const val = i.dimValue || '(blank)';
        if (!dimMap[val]) dimMap[val] = { hate: 0, total: 0, newHate: 0, newTotal: 0, recHate: 0, recTotal: 0 };
        dimMap[val].hate  += i.isHate ? 1 : 0;
        dimMap[val].total += 1;
        if (i.custType === 'new')       { dimMap[val].newHate += i.isHate ? 1 : 0; dimMap[val].newTotal++; }
        if (i.custType === 'recurring') { dimMap[val].recHate += i.isHate ? 1 : 0; dimMap[val].recTotal++; }
      }

      // Ship week totals for the z-score calculation (value vs rest of week)
      const wkHate  = wkItems.filter(i => i.isHate).length;
      const wkTotal = wkItems.length;

      dimensionBreakdown[wk] = Object.entries(dimMap)
        .filter(([, c]) => c.total >= 5)
        .map(([val, c]) => {
          const hateRate = c.hate / c.total;
          const lift     = filtBaselineRate > 0 ? (hateRate - filtBaselineRate) / filtBaselineRate : 0;
          // Z-test: this dim value vs the rest of the week's items
          const otherTotal = wkTotal - c.total;
          const otherHate  = wkHate  - c.hate;
          const otherRate  = otherTotal > 0 ? otherHate / otherTotal : 0;
          const pPool = wkTotal > 0 ? wkHate / wkTotal : 0;
          let zScore = 0;
          if (pPool > 0 && pPool < 1 && c.total > 0 && otherTotal > 0) {
            const se = Math.sqrt(pPool * (1 - pPool) * (1 / c.total + 1 / otherTotal));
            zScore   = se > 0 ? (hateRate - otherRate) / se : 0;
          }
          const significant = Math.abs(zScore) >= 1.96;
          return {
            value:             val,
            total:             c.total,
            hateRate,
            hateCount:         c.hate,
            lift,
            zScore,
            significant,
            newHateRate:       c.newTotal >= 3 ? c.newHate / c.newTotal : null,
            recurringHateRate: c.recTotal >= 3 ? c.recHate / c.recTotal : null
          };
        })
        .sort((a, b) => b.hateRate - a.hateRate)
        .slice(0, 15);
    }
  }

  res.json({
    lagCurve, heatmap, table,
    availableWeeks, selectedWeeks,
    medianDaysToRate, lagWindow: lagWin,
    shipWeeks: last12Ship,
    ratingWeeks: last12Rating,
    dimensionBreakdown,
    baselineRate: filtBaselineRate
  });
});

// API: Action Signals — auto-classified alerts for the Intel Report panel
// Evaluates all dimension values against 3 signal rules; returns up to 10 signals ranked by impact.
app.get('/api/action-signals', async (req, res) => {
  const data = await ensureData();
  const { start, end, ratingType = 'item' } = req.query;
  const ratingField = ratingType === 'box' ? 'boxRating' : 'itemRating';
  const dateField   = 'FB_rating_date';

  // Overall baseline for the period
  const overallStats = computeStats(data, { start, end, ratingType });
  const baselineRate = overallStats.baseline.rate;

  // Helper: consecutive weeks that dimension value's hate rate > baseline (most recent complete weeks first)
  function consecutiveWeeks(dimValue, dimension) {
    const rows = data.filter(r =>
      String(r[dimension]) === String(dimValue) && r[ratingField] > 0 && r[dateField]
    );
    if (!rows.length) return 0;

    const weeks = {};
    for (const r of rows) {
      const d   = new Date(r[dateField] + 'T00:00:00');
      const sun = new Date(d.getTime() - d.getDay() * 86400000);
      const wk  = sun.toISOString().split('T')[0];
      if (!weeks[wk]) weeks[wk] = { hate: 0, total: 0 };
      weeks[wk].total++;
      if (r[ratingField] <= 2) weeks[wk].hate++;
    }

    const sorted   = Object.keys(weeks).sort().reverse();
    const now      = new Date();
    const thisSun  = new Date(now.getTime() - now.getDay() * 86400000).toISOString().split('T')[0];
    const startIdx = sorted[0] === thisSun ? 1 : 0; // skip current incomplete week

    let count = 0;
    for (let i = startIdx; i < sorted.length; i++) {
      const w = weeks[sorted[i]];
      if (w.total < 10) break; // low-vol week — stop the streak
      if (w.hate / w.total > baselineRate) count++;
      else break;
    }
    return count;
  }

  const DIMS = ['product_brand', 'product_category', 'product_subcategory',
                'Stylist', 'plan', 'BoxNumber', 'product_item_style'];
  const raw = [];

  for (const dim of DIMS) {
    const stats = computeStats(data, { start, end, ratingType, dimension: dim });
    for (const d of (stats.drivers || [])) {
      if (d.total < 30)            continue;
      if (d.direction !== 'above') continue;

      const notMeBucket = (d.enrichment?.styleAccuracyAll || []).find(b => b.bucket === 'not_me');
      const notMePct    = notMeBucket?.pct || 0;
      const wksElevated = consecutiveWeeks(d.value, dim);

      // Rule evaluation — priority: Cut > Fix Targeting > Watch
      let signalType = null;
      if (d.zScore > 2.0 && d.hateRate > 0.20 && d.significant && wksElevated >= 3) {
        signalType = 'cut';
      } else if (d.hateRate > baselineRate && notMePct > 0.40) {
        signalType = 'fix_targeting';
      } else if (d.zScore > 1.5 && d.hateRate > baselineRate && (wksElevated <= 2 || !d.significant)) {
        signalType = 'watch';
      }

      if (signalType) {
        raw.push({
          signalType, dimension: dim, value: d.value,
          hateRate: d.hateRate, lift: d.lift, zScore: d.zScore,
          pValue: d.pValue, significant: d.significant,
          total: d.total, weeksElevated: wksElevated, notMePct
        });
      }
    }
  }

  // Deduplicate by entity name (case-insensitive) — keep highest z-score entry
  const seen = new Map();
  for (const s of raw) {
    const key = String(s.value).toLowerCase().trim();
    if (!seen.has(key) || seen.get(key).zScore < s.zScore) seen.set(key, s);
  }

  const PRIO = { cut: 0, fix_targeting: 1, watch: 2 };
  const signals = [...seen.values()]
    .sort((a, b) => {
      const pd = PRIO[a.signalType] - PRIO[b.signalType];
      return pd !== 0 ? pd : b.zScore - a.zScore;
    })
    .slice(0, 10);

  res.json({ signals, baselineRate });
});

// API: Weekly Intel Report — drivers per week for the selected period
// Returns: baseline, weeklyDrivers (per-week top drivers), boxCount, topDriversOverall
app.get('/api/weekly-report', async (req, res) => {
  const data = await ensureData();
  const { start, end, ratingType = 'item' } = req.query;
  const ratingField = ratingType === 'box' ? 'boxRating' : 'itemRating';
  const dateField   = 'FB_rating_date';

  // Core dimensions to scan for drivers
  const DRIVER_DIMS = ['product_brand', 'product_category', 'Stylist', 'plan', 'BoxNumber'];

  // --- Overall baseline for the period ---
  const baseline = computeStats(data, { start, end, ratingType, timeView: 'received' }).baseline;

  // --- Box count (deduped by mcID) ---
  const boxMap = new Map();
  for (const r of data) {
    if (!r.mcID || !r.boxRating || Number(r.boxRating) === 0) continue;
    if (start && (r[dateField] || '') < start) continue;
    if (end   && (r[dateField] || '') > end)   continue;
    boxMap.set(r.mcID, true);
  }
  const boxCount = boxMap.size;

  // --- Top drivers overall (all dims, ranked by z-score) ---
  const allDrivers = [];
  for (const dim of DRIVER_DIMS) {
    const s = computeStats(data, { start, end, ratingType, timeView: 'received', dimension: dim });
    for (const d of (s.drivers || [])) {
      if (d.direction === 'above' && d.significant) {
        allDrivers.push({ ...d, dimension: dim });
      }
    }
  }
  allDrivers.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  const topDriversOverall = allDrivers.slice(0, 10);

  // --- Weekly breakdown ---
  // Group rated rows by week
  let filtered = data.filter(r => r[ratingField] > 0 && r[dateField]);
  if (start) filtered = filtered.filter(r => r[dateField] >= start);
  if (end)   filtered = filtered.filter(r => r[dateField] <= end);

  // Build week groups (Monday-aligned)
  const weekGroups = {};
  for (const r of filtered) {
    const d = new Date(r[dateField] + 'T00:00:00');
    const day = d.getDay();
    const monday = new Date(d.getTime() - ((day + 6) % 7) * 86400000);
    const wk = monday.toISOString().split('T')[0];
    if (!weekGroups[wk]) weekGroups[wk] = [];
    weekGroups[wk].push(r);
  }

  const weeklyDrivers = [];
  for (const [week, rows] of Object.entries(weekGroups)) {
    const { rate, hateCount, total } = computeStats(rows, { ratingType }).baseline;
    // Find top driver for this week across key dimensions
    const weekDrivers = [];
    for (const dim of DRIVER_DIMS) {
      const s = computeStats(rows, { ratingType, dimension: dim });
      for (const d of (s.drivers || [])) {
        if (d.direction === 'above' && d.pValue < 0.1 && d.total >= 5) {
          weekDrivers.push({ ...d, dimension: dim });
        }
      }
    }
    weekDrivers.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

    weeklyDrivers.push({
      week,
      hateRate: rate,
      hateCount,
      total,
      topDriver: weekDrivers[0] || null,
      drivers: weekDrivers.slice(0, 3)
    });
  }

  weeklyDrivers.sort((a, b) => b.week.localeCompare(a.week)); // newest first

  res.json({ baseline, boxCount, topDriversOverall, weeklyDrivers, period: { start, end } });
});

// API: Cache status
app.get('/api/cache/status', (req, res) => {
  res.json(getCacheInfo());
});

// API: Force refresh — clear both caches and reload everything from BigQuery
app.post('/api/cache/clear', async (req, res) => {
  clearCache();
  clearBoxCache();
  DATA = null;
  BOX_DATA = null;
  AVAILABLE_DIMS = [];
  // Kick off both reloads in background; return immediately
  res.json({ cleared: true, message: 'Cache cleared — re-fetching from BigQuery in background' });
  Promise.all([
    ensureData(),
    ensureBoxData()
  ]).catch(e => console.error('  Force refresh failed:', e.message));
});

// API: Get available dimensions (responds immediately if still loading)
app.get('/api/dimensions', async (req, res) => {
  if (DATA) {
    res.json({ dimensions: AVAILABLE_DIMS });
  } else {
    // Return defaults while BQ is loading
    res.json({ dimensions: [
      'product_brand', 'product_category', 'product_subcategory',
      'product_item_style', 'Stylist', 'plan', 'BoxNumber',
      'product_color_style', 'product_seasonality', 'product_sourcing',
      'ShipAddrState', 'DayStyle', 'EveningStyle', 'BottomFit', 'TopSize', 'WaistSize'
    ], loading: true });
  }
});

// API: Reload data (after adding new CSV)
app.post('/api/reload', async (req, res) => {
  DATA = null;
  AVAILABLE_DIMS = [];
  const data = await ensureData();
  res.json({ rows: data.length, dimensions: AVAILABLE_DIMS, message: 'Data reloaded' });
});

app.listen(PORT, () => {
  console.log(`\n  🔍 Hate It Rate Analyzer running at http://localhost:${PORT}\n`);
  // Kick off both loads in parallel on startup
  ensureData().catch(e => console.error('  Background master_orders load failed:', e.message));
  ensureBoxData().catch(e => console.error('  Background box health load failed:', e.message));
});
