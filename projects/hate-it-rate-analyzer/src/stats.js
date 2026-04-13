/**
 * Statistical engine for Hate It Rate analysis.
 * Z-tests, lift calculations, and auto-ranking by impact.
 */

/**
 * Deduplicate rows by mcID for box rating analysis.
 * Each package (mcID) has 3-11 item rows that all share the same boxRating.
 * We collapse to one row per mcID — keeping the first row with a valid boxRating.
 * Item-level fields (brand, category, etc.) on that representative row are preserved
 * so dimension breakdowns still work.
 */
function deduplicateByBox(rows) {
  const seen = new Map();
  for (const r of rows) {
    const key = r.mcID || r.id; // mcID is the package identifier
    if (key && !seen.has(key)) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values());
}

function computeStats(data, options = {}) {
  const {
    start, end, ratingType = 'item', timeView = 'received',
    dimension, drillValue, earlyWarning = false, weeks = 4
  } = options;

  const ratingField = ratingType === 'box' ? 'boxRating' : 'itemRating';
  const dateField = timeView === 'shipped' ? 'shipped_date' : 'FB_rating_date';

  // For box rating: deduplicate to one row per package (mcID) so we don't
  // count the same box rating once per item (3-11x inflation).
  const workingData = ratingType === 'box' ? deduplicateByBox(data) : data;

  // Filter to rows with ratings
  let filtered = workingData.filter(r => r[ratingField] > 0 && r[dateField]);

  // Date range filter
  if (start) filtered = filtered.filter(r => r[dateField] >= start);
  if (end) filtered = filtered.filter(r => r[dateField] <= end);

  // Drill-down filter
  if (drillValue && dimension) {
    filtered = filtered.filter(r => String(r[dimension]) === String(drillValue));
  }

  // Early warning mode — shipped cohort analysis
  // Always deduplicate by box for early warning (counts boxes shipped, not items)
  if (earlyWarning) {
    return computeEarlyWarning(deduplicateByBox(data), ratingField, weeks);
  }

  // Baseline
  const baseline = computeHateRate(filtered, ratingField);

  // If no dimension requested, return overall stats
  if (!dimension) {
    return {
      baseline,
      totalRated: filtered.length,
      hateCount: filtered.filter(r => r[ratingField] <= 2).length,
      timeRange: { start: start || 'all', end: end || 'all' },
      weeklyTrend: computeWeeklyTrendWithContext(workingData, ratingField, dateField),
      rollingBaselines: computeRollingBaselines(workingData, start, end, ratingField, dateField)
    };
  }

  // Dimension breakdown
  const groups = groupBy(filtered, dimension);
  const drivers = [];

  for (const [value, rows] of Object.entries(groups)) {
    if (!value || value === 'undefined' || value === '') continue;
    const rate = computeHateRate(rows, ratingField);
    const n = rows.length;
    if (n < 5) continue; // Skip tiny groups

    const lift = baseline.rate > 0 ? ((rate.rate - baseline.rate) / baseline.rate) : 0;
    const z = zTest(rate.rate, baseline.rate, n, filtered.length);
    const pValue = zToPValue(z);

    drivers.push({
      value,
      hateRate: rate.rate,
      hateCount: rate.hateCount,
      total: n,
      lift,
      zScore: z,
      pValue,
      significant: pValue < 0.05,
      direction: rate.rate > baseline.rate ? 'above' : 'below',
      enrichment: computeEnrichment(rows)
    });
  }

  // Sort by absolute z-score (most impactful first)
  drivers.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return { baseline, drivers, totalRated: filtered.length };
}

function computeHateRate(rows, ratingField) {
  const total = rows.length;
  const hateCount = rows.filter(r => r[ratingField] <= 2).length;
  const neutralCount = rows.filter(r => r[ratingField] === 3).length;
  const loveCount = rows.filter(r => r[ratingField] >= 4).length;
  return {
    rate: total > 0 ? hateCount / total : 0,
    hateCount,
    neutralCount,
    loveCount,
    total
  };
}

function computeWeeklyTrend(rows, ratingField, dateField) {
  const weeks = {};
  for (const r of rows) {
    const d = new Date(r[dateField]);
    // Get Monday of that week
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((day + 6) % 7));
    const weekKey = monday.toISOString().split('T')[0];

    if (!weeks[weekKey]) weeks[weekKey] = { total: 0, hate: 0 };
    weeks[weekKey].total++;
    if (r[ratingField] <= 2) weeks[weekKey].hate++;
  }

  return Object.entries(weeks)
    .map(([week, counts]) => ({
      week,
      hateRate: counts.total > 0 ? counts.hate / counts.total : 0,
      hateCount: counts.hate,
      total: counts.total
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

/**
 * Compute rolling baselines for the summary cards and chart reference lines.
 * Returns hate rates for: prior week, prior 30d, rolling 12mo, year-ago same period.
 */
function computeRollingBaselines(data, start, end, ratingField, dateField) {
  const rated = data.filter(r => r[ratingField] > 0 && r[dateField]);

  const endDate = end ? new Date(end) : new Date();
  const startDate = start ? new Date(start) : new Date(endDate.getTime() - 14 * 86400000);
  const spanMs = endDate - startDate;

  // Prior same-length period (immediately before current window)
  const priorEnd = new Date(startDate.getTime() - 86400000);
  const priorStart = new Date(priorEnd.getTime() - spanMs);
  const priorKey = { start: priorStart.toISOString().split('T')[0], end: priorEnd.toISOString().split('T')[0] };
  const priorRows = rated.filter(r => r[dateField] >= priorKey.start && r[dateField] <= priorKey.end);
  const prior = computeHateRate(priorRows, ratingField);

  // Prior 7 days (week-over-week) — regardless of current window
  const w1End = new Date(endDate.getTime() - 7 * 86400000);
  const w1Start = new Date(w1End.getTime() - 7 * 86400000);
  const wowRows = rated.filter(r => {
    const d = r[dateField];
    return d >= w1Start.toISOString().split('T')[0] && d <= w1End.toISOString().split('T')[0];
  });
  const wow = computeHateRate(wowRows, ratingField);

  // Rolling 30 days ending at start of current window
  const m30End = new Date(startDate.getTime() - 86400000);
  const m30Start = new Date(m30End.getTime() - 30 * 86400000);
  const m30Rows = rated.filter(r => {
    const d = r[dateField];
    return d >= m30Start.toISOString().split('T')[0] && d <= m30End.toISOString().split('T')[0];
  });
  const rolling30d = computeHateRate(m30Rows, ratingField);

  // Rolling 12 months — all available data in the prior 365 days before current window
  const y1End = new Date(startDate.getTime() - 86400000);
  const y1Start = new Date(y1End.getTime() - 365 * 86400000);
  const y1Rows = rated.filter(r => {
    const d = r[dateField];
    return d >= y1Start.toISOString().split('T')[0] && d <= y1End.toISOString().split('T')[0];
  });
  const rolling12mo = computeHateRate(y1Rows, ratingField);

  // Year-ago: same date window but 365 days back
  const yaStart = new Date(startDate.getTime() - 365 * 86400000).toISOString().split('T')[0];
  const yaEnd = new Date(endDate.getTime() - 365 * 86400000).toISOString().split('T')[0];
  const yaRows = rated.filter(r => r[dateField] >= yaStart && r[dateField] <= yaEnd);
  const yearAgo = computeHateRate(yaRows, ratingField);

  // Current window for delta calculations
  const current = computeHateRate(
    rated.filter(r => r[dateField] >= startDate.toISOString().split('T')[0] && r[dateField] <= endDate.toISOString().split('T')[0]),
    ratingField
  );

  function delta(ref) {
    if (!ref || ref.total < 5) return null;
    return {
      rate: ref.rate,
      total: ref.total,
      pp: parseFloat(((current.rate - ref.rate) * 100).toFixed(2)),   // percentage points difference
      pct: ref.rate > 0 ? parseFloat(((current.rate - ref.rate) / ref.rate * 100).toFixed(1)) : null
    };
  }

  return {
    priorPeriod: delta(prior),
    wow: delta(wow),
    rolling30d: delta(rolling30d),
    rolling12mo: delta(rolling12mo),
    yearAgo: delta(yearAgo),
    // Raw rates for chart reference lines
    refs: {
      rolling30d: rolling30d.rate,
      rolling12mo: rolling12mo.rate,
      yearAgo: yearAgo.total >= 5 ? yearAgo.rate : null,
      wow: wow.rate
    }
  };
}

/**
 * Compute weekly trend WITH rolling context per week:
 * each data point also carries the 4-week trailing avg ending that week.
 */
function computeWeeklyTrendWithContext(data, ratingField, dateField) {
  // Build a map of all weeks in the data
  const weeks = {};
  const rated = data.filter(r => r[ratingField] > 0 && r[dateField]);

  for (const r of rated) {
    const d = new Date(r[dateField]);
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((day + 6) % 7));
    const weekKey = monday.toISOString().split('T')[0];
    if (!weeks[weekKey]) weeks[weekKey] = { total: 0, hate: 0 };
    weeks[weekKey].total++;
    if (r[ratingField] <= 2) weeks[weekKey].hate++;
  }

  const sorted = Object.entries(weeks)
    .map(([week, c]) => ({ week, hateRate: c.total > 0 ? c.hate / c.total : 0, hateCount: c.hate, total: c.total }))
    .sort((a, b) => a.week.localeCompare(b.week));

  // Add 4-week trailing average for each data point (rolling reference line)
  return sorted.map((point, i) => {
    const window4 = sorted.slice(Math.max(0, i - 3), i); // prior 4 weeks (not including current)
    const avg4 = window4.length > 0
      ? window4.reduce((sum, w) => sum + w.hateRate, 0) / window4.length
      : null;

    // Year-ago: find week 52 weeks back
    const thisWeek = new Date(point.week);
    const yearAgoWeek = new Date(thisWeek.getTime() - 52 * 7 * 86400000);
    const yearAgoKey = yearAgoWeek.toISOString().split('T')[0];
    const yearAgoPoint = weeks[yearAgoKey];

    return {
      ...point,
      trailing4wAvg: avg4,
      yearAgoRate: yearAgoPoint && yearAgoPoint.total >= 5
        ? yearAgoPoint.hate / yearAgoPoint.total
        : null
    };
  });
}

function computeEarlyWarning(data, ratingField, weeks) {
  const now = new Date();
  const cohorts = [];

  for (let w = 0; w < weeks; w++) {
    const weekStart = new Date(now.getTime() - (w + 1) * 7 * 86400000);
    const weekEnd = new Date(now.getTime() - w * 7 * 86400000);
    const weekLabel = weekStart.toISOString().split('T')[0];

    // All items shipped that week
    const shipped = data.filter(r => {
      if (!r.shipped_date) return false;
      return r.shipped_date >= weekLabel && r.shipped_date < weekEnd.toISOString().split('T')[0];
    });

    // Of those, which have ratings?
    const rated = shipped.filter(r => r[ratingField] > 0);
    const completionRate = shipped.length > 0 ? rated.length / shipped.length : 0;
    const hateRate = rated.length > 0 ? rated.filter(r => r[ratingField] <= 2).length / rated.length : 0;

    cohorts.push({
      weekOf: weekLabel,
      shipped: shipped.length,
      rated: rated.length,
      completionRate,
      hateRate,
      hateCount: rated.filter(r => r[ratingField] <= 2).length,
      isEarlyWarning: completionRate < 0.5 && hateRate > 0.15
    });
  }

  return { cohorts };
}

function computeEnrichment(rows) {
  const rated = rows.filter(r => r.itemRating > 0);
  const hateRows = rated.filter(r => r.itemRating <= 2);

  // Style accuracy breakdown for hate items (backward-compat)
  const styleAcc = {};
  const qualityBreak = {};
  const fitBreak = {};

  for (const r of hateRows) {
    if (r.boxStyleAccuracy) styleAcc[r.boxStyleAccuracy] = (styleAcc[r.boxStyleAccuracy] || 0) + 1;
    if (r.itemQuality) qualityBreak[r.itemQuality] = (qualityBreak[r.itemQuality] || 0) + 1;
    if (r.itemFit) fitBreak[r.itemFit] = (fitBreak[r.itemFit] || 0) + 1;
  }

  // Style accuracy breakdown over ALL rated items (for sentiment breakdown bar)
  // Normalized to canonical buckets: love_it / mostly_me / not_me / no_answer
  const STYLE_BUCKETS = ['love_it', 'mostly_me', 'not_me', 'no_answer'];
  const styleAccAllRaw = {};
  for (const r of rated) {
    if (r.boxStyleAccuracy) {
      // Normalize key: lowercase, spaces→underscores
      const key = String(r.boxStyleAccuracy).toLowerCase().replace(/\s+/g, '_');
      styleAccAllRaw[key] = (styleAccAllRaw[key] || 0) + 1;
    }
  }
  // Build ordered result with all 4 buckets (0 if missing), plus pct
  const styleAccAllTotal = Object.values(styleAccAllRaw).reduce((s, v) => s + v, 0);
  const styleAccuracyAll = STYLE_BUCKETS.map(bucket => ({
    bucket,
    count: styleAccAllRaw[bucket] || 0,
    pct: styleAccAllTotal > 0 ? ((styleAccAllRaw[bucket] || 0) / styleAccAllTotal) : 0
  }));

  // Comments with week labels (for hate items, sorted by most recent, up to 5)
  function toRatingWeek(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d)) return null;
    // Snap to Sunday start of the week
    const day = d.getDay();
    const sun = new Date(d.getTime() - day * 86400000);
    return sun.toISOString().split('T')[0];
  }

  const commentsWithDates = hateRows
    .filter(r => r.itemComment && r.itemComment.trim())
    .map(r => ({
      text: r.itemComment.trim(),
      week: toRatingWeek(r.FB_rating_date || r.itemRatingDate || null),
      date: r.FB_rating_date || r.itemRatingDate || null
    }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))  // most recent first
    .slice(0, 5)
    .map(({ text, week }) => ({ text, week }));  // drop internal `date` field

  // Top comments (backward-compat)
  const comments = hateRows.filter(r => r.itemComment).map(r => r.itemComment);

  return {
    styleAccuracy: styleAcc,
    quality: qualityBreak,
    fit: fitBreak,
    sampleComments: comments.slice(0, 5),
    styleAccuracyAll,         // NEW: all-rated breakdown for sentiment bar
    commentsWithDates         // NEW: [{text, week}] for drill-down display
  };
}

function groupBy(arr, key) {
  const groups = {};
  for (const item of arr) {
    const val = String(item[key] || '');
    if (!groups[val]) groups[val] = [];
    groups[val].push(item);
  }
  return groups;
}

function zTest(p1, p0, n1, n0) {
  if (n1 === 0 || n0 === 0) return 0;
  const pPool = (p1 * n1 + p0 * n0) / (n1 + n0);
  if (pPool === 0 || pPool === 1) return 0;
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n0));
  if (se === 0) return 0;
  return (p1 - p0) / se;
}

function zToPValue(z) {
  // Approximate two-tailed p-value from z-score
  const absZ = Math.abs(z);
  // Using approximation
  const t = 1 / (1 + 0.2316419 * absZ);
  const d = 0.3989422804014327;
  const p = d * Math.exp(-absZ * absZ / 2) *
    (t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.8212560 + t * 1.3302744)))));
  return 2 * p; // Two-tailed
}

module.exports = { computeStats };
