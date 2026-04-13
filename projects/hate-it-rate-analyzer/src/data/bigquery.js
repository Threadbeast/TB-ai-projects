const { BigQuery } = require('@google-cloud/bigquery');
const path = require('path');

const KEY_PATH = path.join(__dirname, '..', '..', 'threadbeast-warehouse-hate-it-rate-analyzer.json');

let bqClient = null;

function getClient() {
  if (!bqClient) {
    bqClient = new BigQuery({
      keyFilename: KEY_PATH,
      projectId: 'threadbeast-warehouse'
    });
  }
  return bqClient;
}

/**
 * List all datasets in the project to discover available data.
 */
async function listDatasets() {
  const bq = getClient();
  const [datasets] = await bq.getDatasets();
  return datasets.map(d => d.id);
}

/**
 * List tables in a dataset.
 */
async function listTables(datasetId) {
  const bq = getClient();
  const [tables] = await bq.dataset(datasetId).getTables();
  return tables.map(t => ({ id: t.id, type: t.metadata.type }));
}

/**
 * Get table schema (column names and types).
 */
async function getTableSchema(datasetId, tableId) {
  const bq = getClient();
  const [metadata] = await bq.dataset(datasetId).table(tableId).getMetadata();
  return metadata.schema.fields.map(f => ({
    name: f.name,
    type: f.type,
    mode: f.mode
  }));
}

/**
 * Run a query and return rows.
 */
async function runQuery(sql) {
  const bq = getClient();
  const [rows] = await bq.query({ query: sql, location: 'US' });
  return rows;
}

/**
 * Fetch pre-aggregated rolling baselines directly from BigQuery.
 * Much faster than loading raw rows — runs server-side aggregation.
 * Returns hate rates for: 30d ago, 12mo ago, year-ago same window.
 */
async function fetchRollingBaselines(currentStart, currentEnd, ratingType = 'item') {
  const ratingField = ratingType === 'box' ? 'boxRating' : 'itemRating';
  const dateField = 'FB_rating_date';

  const startDate = currentStart;
  const endDate = currentEnd || new Date().toISOString().split('T')[0];

  // Compute prior period start (same length window before current)
  const spanDays = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000);
  const priorEnd = new Date(new Date(startDate).getTime() - 86400000).toISOString().split('T')[0];
  const priorStart = new Date(new Date(priorEnd).getTime() - spanDays * 86400000).toISOString().split('T')[0];

  // Year-ago window
  const yaStart = new Date(new Date(startDate).getTime() - 365 * 86400000).toISOString().split('T')[0];
  const yaEnd   = new Date(new Date(endDate).getTime()   - 365 * 86400000).toISOString().split('T')[0];

  // 12-month rolling (prior year before current window)
  const y12End   = new Date(new Date(startDate).getTime() - 86400000).toISOString().split('T')[0];
  const y12Start = new Date(new Date(y12End).getTime() - 365 * 86400000).toISOString().split('T')[0];

  // 30-day rolling (prior 30d before current window)
  const m30End   = new Date(new Date(startDate).getTime() - 86400000).toISOString().split('T')[0];
  const m30Start = new Date(new Date(m30End).getTime() - 30 * 86400000).toISOString().split('T')[0];

  const sql = `
    SELECT
      'prior_period' as period,
      COUNTIF(${ratingField} <= 2) as hate,
      COUNTIF(${ratingField} > 0) as total
    FROM \`threadbeast-warehouse.threadbeast_mysql.master_orders\`
    WHERE CAST(${dateField} AS DATE) BETWEEN '${priorStart}' AND '${priorEnd}'
      AND ${ratingField} IS NOT NULL AND ${ratingField} > 0

    UNION ALL SELECT
      'year_ago' as period,
      COUNTIF(${ratingField} <= 2),
      COUNTIF(${ratingField} > 0)
    FROM \`threadbeast-warehouse.threadbeast_mysql.master_orders\`
    WHERE CAST(${dateField} AS DATE) BETWEEN '${yaStart}' AND '${yaEnd}'
      AND ${ratingField} IS NOT NULL AND ${ratingField} > 0

    UNION ALL SELECT
      'rolling_12mo' as period,
      COUNTIF(${ratingField} <= 2),
      COUNTIF(${ratingField} > 0)
    FROM \`threadbeast-warehouse.threadbeast_mysql.master_orders\`
    WHERE CAST(${dateField} AS DATE) BETWEEN '${y12Start}' AND '${y12End}'
      AND ${ratingField} IS NOT NULL AND ${ratingField} > 0

    UNION ALL SELECT
      'rolling_30d' as period,
      COUNTIF(${ratingField} <= 2),
      COUNTIF(${ratingField} > 0)
    FROM \`threadbeast-warehouse.threadbeast_mysql.master_orders\`
    WHERE CAST(${dateField} AS DATE) BETWEEN '${m30Start}' AND '${m30End}'
      AND ${ratingField} IS NOT NULL AND ${ratingField} > 0
  `;

  const rows = await runQuery(sql);
  const result = {};
  for (const row of rows) {
    const rate = row.total > 0 ? row.hate / row.total : 0;
    result[row.period] = { rate, hate: row.hate, total: row.total };
  }
  return result;
}

/**
 * Fetch weekly trend from BigQuery with year-ago comparison — aggregated.
 */
async function fetchWeeklyTrendBQ(startDate, endDate, ratingType = 'item') {
  const ratingField = ratingType === 'box' ? 'boxRating' : 'itemRating';

  const yaStartDate = new Date(new Date(startDate).getTime() - 365 * 86400000).toISOString().split('T')[0];
  const yaEndDate   = new Date(new Date(endDate).getTime()   - 365 * 86400000).toISOString().split('T')[0];

  const sql = `
    WITH current_weeks AS (
      SELECT
        DATE_TRUNC(CAST(FB_rating_date AS DATE), WEEK(MONDAY)) as week,
        COUNTIF(${ratingField} <= 2) as hate,
        COUNTIF(${ratingField} > 0) as total
      FROM \`threadbeast-warehouse.threadbeast_mysql.master_orders\`
      WHERE CAST(FB_rating_date AS DATE) BETWEEN '${startDate}' AND '${endDate}'
        AND ${ratingField} IS NOT NULL AND ${ratingField} > 0
      GROUP BY 1
    ),
    year_ago_weeks AS (
      SELECT
        DATE_ADD(DATE_TRUNC(CAST(FB_rating_date AS DATE), WEEK(MONDAY)), INTERVAL 52 WEEK) as week,
        COUNTIF(${ratingField} <= 2) as hate_ya,
        COUNTIF(${ratingField} > 0) as total_ya
      FROM \`threadbeast-warehouse.threadbeast_mysql.master_orders\`
      WHERE CAST(FB_rating_date AS DATE) BETWEEN '${yaStartDate}' AND '${yaEndDate}'
        AND ${ratingField} IS NOT NULL AND ${ratingField} > 0
      GROUP BY 1
    )
    SELECT
      CAST(c.week AS STRING) as week,
      c.hate as hateCount,
      c.total,
      SAFE_DIVIDE(c.hate, c.total) as hateRate,
      y.hate_ya as hateCount_ya,
      y.total_ya as total_ya,
      SAFE_DIVIDE(y.hate_ya, y.total_ya) as hateRate_ya
    FROM current_weeks c
    LEFT JOIN year_ago_weeks y USING(week)
    ORDER BY week
  `;

  const rows = await runQuery(sql);
  return rows.map(r => ({
    week: r.week,
    hateCount: Number(r.hateCount),
    total: Number(r.total),
    hateRate: Number(r.hateRate) || 0,
    yearAgoRate: r.hateRate_ya != null ? Number(r.hateRate_ya) : null,
    yearAgoTotal: r.total_ya ? Number(r.total_ya) : 0
  }));
}

/**
 * Load master_orders from BigQuery with item-level ratings.
 * This is the real deal — every item rated by every customer.
 */
async function loadMasterOrders(startDate = '2026-01-01') {
  console.log(`  Loading master_orders from BigQuery (since ${startDate})...`);

  const sql = `
    SELECT
      id, mcID, itemRating, boxRating,
      product_brand, product_category, product_subcategory,
      product_item_style, Stylist, plan, BoxNumber,
      product_color_style, product_seasonality, product_sourcing,
      ShipAddrState, DayStyle, EveningStyle, BottomFit,
      TopSize, WaistSize, ShoeSize,
      CAST(shipped_date AS STRING) as shipped_date,
      CAST(delivered_date AS STRING) as delivered_date,
      CAST(FB_rating_date AS STRING) as FB_rating_date,
      CAST(FBbox_rating_date AS STRING) as FBbox_rating_date,
      boxStyleAccuracy, itemQuality, itemFit, itemComment,
      standard_price, boxValue, product_front_image_url,
      product_fit, itemSize, itemColor, product_size
    FROM \`threadbeast-warehouse.threadbeast_mysql.master_orders\`
    WHERE FB_rating_date >= '${startDate}'
      AND itemRating IS NOT NULL
      AND itemRating > 0
    ORDER BY FB_rating_date DESC
  `;

  const rows = await runQuery(sql);
  console.log(`  Loaded ${rows.length} rated items from BigQuery`);

  // Normalize dates from BigQuery DATETIME format
  return rows.map(r => {
    const boxNum = parseInt(r.BoxNumber) || 0;
    return {
      ...r,
      shipped_date: r.shipped_date ? r.shipped_date.substring(0, 10) : '',
      delivered_date: r.delivered_date ? r.delivered_date.substring(0, 10) : '',
      FB_rating_date: r.FB_rating_date ? r.FB_rating_date.substring(0, 10) : '',
      FBbox_rating_date: r.FBbox_rating_date ? r.FBbox_rating_date.substring(0, 10) : '',
      standard_price: parseFloat(r.standard_price) || 0,
      boxValue: parseFloat(r.boxValue) || 0,
      customerType: boxNum === 1 ? 'New Customer' : boxNum >= 2 ? 'Recurring Customer' : ''
    };
  });
}

// ============================================================
// BOX HEALTH QUERIES
// All three: Sun-Sat weeks, boxRating IN (1,2,4,5) only,
// deduplicated to one row per mcID before aggregation,
// split by box_sentiment (love/hate) AND customer_type (new/recurring)
// ============================================================

/**
 * Query A — Style Accuracy per week × sentiment × customerType
 * Source field: boxStyleAccuracy (normalized to lowercase)
 * Valid buckets: love it / mostly me / not me / no_answer
 */
async function fetchStyleAccuracy() {
  console.log('  [Box Health] Fetching Style Accuracy...');
  const sql = `
    WITH box_level AS (
      SELECT
        mcID,
        DATE_TRUNC(DATE(ANY_VALUE(FBbox_rating_date)), WEEK(SUNDAY)) AS week_start,
        ANY_VALUE(boxRating)         AS boxRating,
        ANY_VALUE(boxStyleAccuracy)  AS boxStyleAccuracy,
        ANY_VALUE(BoxNumber)         AS BoxNumber
      FROM \`threadbeast-warehouse.threadbeast_mysql.master_orders\`
      WHERE FBbox_rating_date IS NOT NULL
        AND DATE(FBbox_rating_date) >= '2025-01-01'
        AND boxRating IN (1, 2, 4, 5)
      GROUP BY mcID
    ),
    normalized AS (
      SELECT
        week_start,
        CASE WHEN boxRating IN (4, 5) THEN 'love' ELSE 'hate' END AS box_sentiment,
        CASE WHEN BoxNumber = 1     THEN 'new' ELSE 'recurring' END AS customer_type,
        LOWER(TRIM(COALESCE(CAST(boxStyleAccuracy AS STRING), 'no_answer'))) AS style_accuracy
      FROM box_level
    )
    SELECT
      CAST(week_start AS STRING)                                        AS week_start,
      box_sentiment,
      customer_type,
      COUNT(*)                                                          AS total_boxes,
      ROUND(COUNTIF(style_accuracy = 'love it')   / COUNT(*), 4)       AS love_it_pct,
      ROUND(COUNTIF(style_accuracy = 'mostly me') / COUNT(*), 4)       AS mostly_me_pct,
      ROUND(COUNTIF(style_accuracy = 'not me')    / COUNT(*), 4)       AS not_me_pct,
      ROUND(COUNTIF(style_accuracy NOT IN ('love it','mostly me','not me')) / COUNT(*), 4) AS no_answer_pct
    FROM normalized
    GROUP BY week_start, box_sentiment, customer_type
    ORDER BY week_start, box_sentiment, customer_type
  `;
  const rows = await runQuery(sql);
  console.log(`  ✅ Style Accuracy: ${new Set(rows.map(r => r.week_start)).size} weeks loaded`);
  return rows.map(r => ({
    week_start:    r.week_start,
    box_sentiment: r.box_sentiment,
    customer_type: r.customer_type,
    total_boxes:   Number(r.total_boxes),
    love_it_pct:   Number(r.love_it_pct)   || 0,
    mostly_me_pct: Number(r.mostly_me_pct) || 0,
    not_me_pct:    Number(r.not_me_pct)    || 0,
    no_answer_pct: Number(r.no_answer_pct) || 0
  }));
}

/**
 * Query B — Value Perception per week × sentiment × customerType
 * Source field: boxValue (normalized to lowercase)
 * Valid buckets: excellent / good / poor / no_answer
 */
async function fetchValuePerception() {
  console.log('  [Box Health] Fetching Value Perception...');
  const sql = `
    WITH box_level AS (
      SELECT
        mcID,
        DATE_TRUNC(DATE(ANY_VALUE(FBbox_rating_date)), WEEK(SUNDAY)) AS week_start,
        ANY_VALUE(boxRating)  AS boxRating,
        ANY_VALUE(boxValue)   AS boxValue,
        ANY_VALUE(BoxNumber)  AS BoxNumber
      FROM \`threadbeast-warehouse.threadbeast_mysql.master_orders\`
      WHERE FBbox_rating_date IS NOT NULL
        AND DATE(FBbox_rating_date) >= '2025-01-01'
        AND boxRating IN (1, 2, 4, 5)
      GROUP BY mcID
    ),
    normalized AS (
      SELECT
        week_start,
        CASE WHEN boxRating IN (4, 5) THEN 'love' ELSE 'hate' END AS box_sentiment,
        CASE WHEN BoxNumber = 1     THEN 'new' ELSE 'recurring' END AS customer_type,
        LOWER(TRIM(COALESCE(CAST(boxValue AS STRING), 'no_answer'))) AS value_perception
      FROM box_level
    )
    SELECT
      CAST(week_start AS STRING)                                           AS week_start,
      box_sentiment,
      customer_type,
      COUNT(*)                                                             AS total_boxes,
      ROUND(COUNTIF(value_perception = 'excellent') / COUNT(*), 4)        AS excellent_pct,
      ROUND(COUNTIF(value_perception = 'good')      / COUNT(*), 4)        AS good_pct,
      ROUND(COUNTIF(value_perception = 'poor')      / COUNT(*), 4)        AS poor_pct,
      ROUND(COUNTIF(value_perception NOT IN ('excellent','good','poor')) / COUNT(*), 4) AS no_answer_pct
    FROM normalized
    GROUP BY week_start, box_sentiment, customer_type
    ORDER BY week_start, box_sentiment, customer_type
  `;
  const rows = await runQuery(sql);
  console.log(`  ✅ Value Perception: ${new Set(rows.map(r => r.week_start)).size} weeks loaded`);
  return rows.map(r => ({
    week_start:    r.week_start,
    box_sentiment: r.box_sentiment,
    customer_type: r.customer_type,
    total_boxes:   Number(r.total_boxes),
    excellent_pct: Number(r.excellent_pct) || 0,
    good_pct:      Number(r.good_pct)      || 0,
    poor_pct:      Number(r.poor_pct)      || 0,
    no_answer_pct: Number(r.no_answer_pct) || 0
  }));
}

/**
 * Query C — Fit Signal per week × sentiment × customerType
 * Works at item level first (bad fit = Loose or Tight), then aggregates to box level.
 * Output: % of boxes with ≥1 bad fit item, avg bad fit items per affected box.
 */
async function fetchFitSignal() {
  console.log('  [Box Health] Fetching Fit Signal...');
  const sql = `
    WITH item_flags AS (
      SELECT
        mcID,
        boxRating,
        FBbox_rating_date,
        BoxNumber,
        CASE WHEN itemFit IN ('Loose', 'Tight') THEN 1 ELSE 0 END AS bad_fit_flag
      FROM \`threadbeast-warehouse.threadbeast_mysql.master_orders\`
      WHERE FBbox_rating_date IS NOT NULL
        AND DATE(FBbox_rating_date) >= '2025-01-01'
        AND boxRating IN (1, 2, 4, 5)
    ),
    box_agg AS (
      SELECT
        mcID,
        DATE_TRUNC(DATE(ANY_VALUE(FBbox_rating_date)), WEEK(SUNDAY)) AS week_start,
        ANY_VALUE(boxRating)                               AS boxRating,
        ANY_VALUE(BoxNumber)                               AS BoxNumber,
        SUM(bad_fit_flag)                                  AS total_bad_fit_count,
        CASE WHEN SUM(bad_fit_flag) > 0 THEN 1 ELSE 0 END AS has_bad_fit
      FROM item_flags
      GROUP BY mcID
    ),
    classified AS (
      SELECT
        week_start,
        CASE WHEN boxRating IN (4, 5) THEN 'love' ELSE 'hate' END AS box_sentiment,
        CASE WHEN BoxNumber = 1     THEN 'new' ELSE 'recurring' END AS customer_type,
        has_bad_fit,
        total_bad_fit_count
      FROM box_agg
    )
    SELECT
      CAST(week_start AS STRING)                                              AS week_start,
      box_sentiment,
      customer_type,
      COUNT(*)                                                                AS total_boxes,
      ROUND(COUNTIF(has_bad_fit = 1) / COUNT(*), 4)                          AS bad_fit_box_pct,
      ROUND(
        SAFE_DIVIDE(
          SUM(CASE WHEN has_bad_fit = 1 THEN total_bad_fit_count END),
          COUNTIF(has_bad_fit = 1)
        ), 2)                                                                 AS avg_bad_fit_per_affected_box
    FROM classified
    GROUP BY week_start, box_sentiment, customer_type
    ORDER BY week_start, box_sentiment, customer_type
  `;
  const rows = await runQuery(sql);
  console.log(`  ✅ Fit Signal: ${new Set(rows.map(r => r.week_start)).size} weeks loaded`);
  return rows.map(r => ({
    week_start:                  r.week_start,
    box_sentiment:               r.box_sentiment,
    customer_type:               r.customer_type,
    total_boxes:                 Number(r.total_boxes),
    bad_fit_box_pct:             Number(r.bad_fit_box_pct)             || 0,
    avg_bad_fit_per_affected_box: Number(r.avg_bad_fit_per_affected_box) || 0
  }));
}

/**
 * Query D — Box Rating Distribution per week × customer_type
 * Source: feedback3userbox (one row per rated box) + orders (for package_num)
 * Date field: feedback3userbox.updatedAt (when feedback was submitted)
 * customer_type: package_num = 1 → 'new', > 1 → 'recurring'
 */
async function fetchBoxTrend() {
  console.log('  [Box Health] Fetching Box Trend (feedback3userbox)...');
  const sql = `
    WITH ranked AS (
      SELECT
        fb.mcID,
        DATE_TRUNC(DATE(fb.updatedAt), WEEK(SUNDAY)) AS week_start,
        fb.Rating,
        RANK() OVER (PARTITION BY o.Email ORDER BY o.DatePayment ASC) AS package_num
      FROM \`threadbeast-warehouse.threadbeast_mysql.feedback3userbox\` fb
      JOIN \`threadbeast-warehouse.threadbeast_mysql.orders\` o
        ON fb.mcID = o.mcID
      WHERE fb.updatedAt IS NOT NULL
        AND fb.Rating != 0
        AND DATE(fb.updatedAt) >= '2025-01-01'
    )
    SELECT
      CAST(week_start AS STRING)                            AS week_start,
      IF(package_num = 1, 'new', 'recurring')              AS customer_type,
      COUNTIF(Rating <= 2)                                  AS hate,
      COUNTIF(Rating = 3)                                   AS neutral,
      COUNTIF(Rating >= 4)                                  AS love,
      COUNT(*)                                              AS total
    FROM ranked
    GROUP BY week_start, customer_type
    ORDER BY week_start, customer_type
  `;
  const rows = await runQuery(sql);
  console.log(`  ✅ Box Trend: ${new Set(rows.map(r => r.week_start)).size} weeks loaded`);
  return rows.map(r => ({
    week_start:    r.week_start,
    customer_type: r.customer_type,
    hate:          Number(r.hate)    || 0,
    neutral:       Number(r.neutral) || 0,
    love:          Number(r.love)    || 0,
    total:         Number(r.total)   || 0,
    hate_rate:     r.total > 0 ? +(Number(r.hate)    / Number(r.total)).toFixed(4) : 0,
    neutral_rate:  r.total > 0 ? +(Number(r.neutral) / Number(r.total)).toFixed(4) : 0,
    love_rate:     r.total > 0 ? +(Number(r.love)    / Number(r.total)).toFixed(4) : 0,
  }));
}

/**
 * Query E — Box hate/love rates broken down by a single dimension
 * Uses the full join (feedback3userbox + orders + customers + package_num)
 * Valid dimension values: Stylist, ShipAddrState, package_num, DayStyle,
 *   EveningStyle, BottomFit, TopSize, WaistSize
 */
const BOX_DRIVER_DIMENSIONS = {
  Stylist:       { table: 'o',  col: 'Stylist' },
  ShipAddrState: { table: 'c',  col: 'ShipAddrState' },
  package_num:   { table: 'tb1', col: 'package_num' },
  DayStyle:      { table: 'c',  col: 'DayStyle' },
  EveningStyle:  { table: 'c',  col: 'EveningStyle' },
  BottomFit:     { table: 'c',  col: 'BottomFit' },
  TopSize:       { table: 'c',  col: 'TopSize' },
  WaistSize:     { table: 'c',  col: 'WaistSize' },
};

async function fetchBoxDrivers() {
  console.log('  [Box Health] Fetching Box Drivers...');
  const results = {};

  for (const [dimName, { table, col }] of Object.entries(BOX_DRIVER_DIMENSIONS)) {
    const sql = `
      WITH base AS (
        SELECT
          ${table}.${col}                                     AS dim_value,
          COUNTIF(fb.Rating <= 2)                             AS hate,
          COUNTIF(fb.Rating = 3)                              AS neutral,
          COUNTIF(fb.Rating >= 4)                             AS love,
          COUNT(*)                                            AS total
        FROM \`threadbeast-warehouse.threadbeast_mysql.feedback3userbox\` fb
        JOIN \`threadbeast-warehouse.threadbeast_mysql.orders\` o
          ON fb.mcID = o.mcID
        JOIN \`threadbeast-warehouse.threadbeast_mysql.customers\` c
          ON fb.Email = c.Email
        JOIN (
          SELECT Email, mcID,
            RANK() OVER (PARTITION BY Email ORDER BY DatePayment ASC) AS package_num
          FROM \`threadbeast-warehouse.threadbeast_mysql.orders\`
        ) AS tb1 ON fb.mcID = tb1.mcID
        WHERE fb.updatedAt IS NOT NULL
          AND fb.Rating != 0
          AND DATE(fb.updatedAt) >= '2025-01-01'
          AND ${table}.${col} IS NOT NULL
          AND CAST(${table}.${col} AS STRING) != ''
        GROUP BY dim_value
      ),
      overall AS (
        SELECT
          COUNTIF(Rating <= 2) / COUNT(*) AS avg_hate_rate
        FROM \`threadbeast-warehouse.threadbeast_mysql.feedback3userbox\`
        WHERE Rating != 0 AND DATE(updatedAt) >= '2025-01-01'
      )
      SELECT
        CAST(b.dim_value AS STRING) AS dim_value,
        b.hate, b.neutral, b.love, b.total,
        ROUND(b.hate / b.total, 4)         AS hate_rate,
        ROUND(b.love / b.total, 4)         AS love_rate,
        ROUND((b.hate / b.total) / o.avg_hate_rate - 1, 4) AS lift
      FROM base b, overall o
      WHERE b.total >= 30
      ORDER BY hate_rate DESC
    `;
    try {
      const rows = await runQuery(sql);
      results[dimName] = rows.map(r => ({
        dim_value: r.dim_value,
        hate:      Number(r.hate),
        neutral:   Number(r.neutral),
        love:      Number(r.love),
        total:     Number(r.total),
        hate_rate: Number(r.hate_rate) || 0,
        love_rate: Number(r.love_rate) || 0,
        lift:      Number(r.lift)      || 0,
      }));
    } catch (e) {
      console.log(`    Box Drivers [${dimName}] failed: ${e.message}`);
      results[dimName] = [];
    }
  }

  const totalRows = Object.values(results).reduce((s, a) => s + a.length, 0);
  console.log(`  ✅ Box Drivers: ${totalRows} rows across ${Object.keys(results).length} dimensions`);
  return results;
}

module.exports = {
  listDatasets, listTables, getTableSchema, runQuery,
  loadMasterOrders, fetchRollingBaselines, fetchWeeklyTrendBQ,
  fetchStyleAccuracy, fetchValuePerception, fetchFitSignal, fetchBoxTrend,
  fetchBoxDrivers
};
