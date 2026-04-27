/**
 * My Next Prediction v3.0 — M4a · News category classifier
 * --------------------------------------------------------
 * Tag every news item with one of the v2 macro categories (and an
 * impact level).  Pure keyword matching; transparent and tunable.
 *
 * The 8 categories (from v2 `main.py:277`):
 *   - FED          (FOMC, rate decisions, central banks)
 *   - WAR          (geopolitical conflict, sanctions)
 *   - CRYPTO REG   (SEC, lawsuits, ETF approvals, ban/delist)
 *   - EARNINGS     (Q1/Q2/Q3/Q4 reports, guidance)
 *   - MACRO        (CPI, GDP, jobs report, housing)
 *   - CRYPTO MKT   (general crypto price action / rallies / liquidations)
 *   - STOCK MKT    (S&P / Dow / Nasdaq moves)
 *   - EU MKT       (DAX / CAC / FTSE / ECB local stories)
 *
 * Each item also gets an `impact` score (0..1) and a flag for
 * "high-impact" (>= 0.65) so the NewsPane can highlight a small
 * banner row at the top.  Impact is driven by:
 *   - Source priors (Reuters > coindesk > random blog)
 *   - Keyword strength (war / crash / sec-sues > rallies)
 *   - Multi-category hits (an SEC lawsuit on a major asset in a
 *     CPI week → 0.9)
 */

/** ─── Category keyword lexicons ─── */
const CAT_KEYWORDS = {
  FED: [
    "fomc", "fed ", "federal reserve", "powell",
    "rate hike", "rate cut", "rate hold", "rate decision",
    "interest rate", "tightening", "easing", "dovish", "hawkish",
    "ecb", "lagarde", "boj", "kuroda", "ueda",
    "boe", "bailey", "snb", "rba", "rbi", "central bank",
  ],
  WAR: [
    "war", "wars", "invasion", "invade", "invaded", "conflict",
    "missile", "strike", "airstrike", "drone strike",
    "sanction", "sanctions", "embargo",
    "ceasefire", "armistice", "treaty",
    "russia", "ukraine", "putin", "zelensky",
    "iran", "israel", "gaza", "hamas", "hezbollah", "houthi", "yemen",
    "north korea", "kim jong", "taiwan strait",
    "tariff", "trade war", "geopolitic", "geopolitical",
  ],
  "CRYPTO REG": [
    "sec ", "cftc", "commission", "lawsuit", "subpoena",
    "indictment", "indicted", "charge", "charged",
    "ban ", "banned", "ban on", "regulator", "regulation",
    "etf approval", "etf rejection", "spot etf",
    "delist", "delisted", "delisting",
    "crypto ban", "doj ", "fbi",
    "hack", "exploit", "rug pull",
    "binance", "coinbase", "kraken",  // when paired with regulation tones
    "settle", "settlement", "fine", "fined",
    "wash trading", "insider trading",
  ],
  EARNINGS: [
    "earnings", "eps", "revenue", "profit", "loss",
    "guidance", "outlook", "forecast",
    "q1 ", "q2 ", "q3 ", "q4 ",
    "first quarter", "second quarter", "third quarter", "fourth quarter",
    "beat estimates", "miss estimates", "beat expectations", "miss expectations",
    "10-q", "10-k", "results",
  ],
  MACRO: [
    "cpi", "ppi", "inflation", "deflation",
    "gdp", "gross domestic", "recession", "depression",
    "jobs report", "unemployment", "non-farm", "nonfarm", "nfp",
    "ism ", "pmi ",
    "consumer confidence", "retail sales",
    "housing", "home sales", "mortgage",
    "manufacturing", "industrial production",
  ],
  "CRYPTO MKT": [
    "bitcoin", "ethereum", "btc", "eth",
    "crypto market", "altcoin", "altcoins",
    "memecoin", "meme coin",
    "defi", "tvl", "stablecoin", "stablecoins",
    "halving", "mining", "miner", "miners",
    "liquidation", "liquidations", "long squeeze", "short squeeze",
    "whale", "whales",
    "open interest", "funding rate",
    "all-time high", "all time high", "ath",
  ],
  "STOCK MKT": [
    "s&p", "s & p", "s and p", "sp500",
    "dow ", "dow jones", "djia",
    "nasdaq", "nasdaq composite",
    "wall street", "wall st",
    "russell", "small cap", "small-cap",
    "blue chip", "blue chips",
    "shares", "share price", "stock price", "stocks rally", "stocks fall",
  ],
  "EU MKT": [
    "ftse", "dax", "cac", "ibex", "stoxx", "euro stoxx",
    "european market", "european shares", "european stocks",
    "london stock exchange", "lse ",
    "frankfurt", "paris bourse",
  ],
};

/** Sources with elevated impact priors (0..1 multiplier). */
const SOURCE_PRIOR = {
  reuters:        1.10,
  bloomberg:      1.10,
  ft:             1.05,
  wsj:            1.10,
  "associated press": 1.05,
  ap:             1.05,
  cnbc:           1.00,
  marketwatch:    0.95,
  coindesk:       0.95,
  cointelegraph:  0.85,
  decrypt:        0.85,
  theblock:       0.95,
  "the block":    0.95,
  bbc:            1.00,
  cnn:            0.95,
  nytimes:        1.05,
  "new york times": 1.05,
  guardian:       0.95,
};

/** Keywords that bump impact independently of category. */
const HIGH_IMPACT_TERMS = [
  "breaking", "exclusive", "urgent",
  "war", "invasion", "missile", "strike",
  "crash", "plunge", "collapse", "meltdown", "capitulation",
  "all-time high", "all time high", "ath",
  "sec sues", "sec sue", "sec charges", "sec charge",
  "etf approval", "etf approved",
  "rate hike", "rate cut", "rate decision",
  "fomc", "cpi", "nfp", "jobs report",
  "halt", "halts", "halted", "halting",
  "delist", "delisted", "delisting",
  "ban ", "banned ", "ban on",
  "bankrupt", "bankruptcy", "insolvent",
];

/** Cheap source-prior lookup. */
function priorForSource(source) {
  if (!source) return 1.0;
  const k = source.toLowerCase();
  for (const [name, mul] of Object.entries(SOURCE_PRIOR)) {
    if (k.includes(name)) return mul;
  }
  return 1.0;
}

/* ═══════════════════════════ Public API ═══════════════════════════ */

/**
 * Classify a news item into 1–N categories with a primary pick + impact.
 *
 * @param {{title:string, summary?:string, source?:string}} item
 * @returns {{
 *   primary:  string,            // one of CAT_KEYWORDS keys; "GENERAL" if none match
 *   matched:  string[],          // every category that matched
 *   hits:     {cat:string, word:string}[],
 *   impact:   number,            // 0..1
 *   highImpact: boolean,         // impact >= 0.65
 * }}
 */
export function classify(item) {
  const title  = (item?.title || "").toLowerCase();
  const sum    = (item?.summary || "").toLowerCase();
  const haystack = `${title} ${sum}`;
  const matched = new Set();
  const hits = [];

  // 1. Walk every category lexicon.
  for (const [cat, words] of Object.entries(CAT_KEYWORDS)) {
    for (const w of words) {
      if (haystack.includes(w)) {
        matched.add(cat);
        hits.push({ cat, word: w.trim() });
        break;   // 1 hit per category is enough to flag it
      }
    }
  }

  // 2. Pick the primary in this priority order (matches v2's bias).
  const PRIORITY = ["FED", "WAR", "CRYPTO REG", "MACRO", "EARNINGS", "CRYPTO MKT", "STOCK MKT", "EU MKT"];
  const primary  = PRIORITY.find((c) => matched.has(c)) || "GENERAL";

  // 3. Impact: keyword strength + category bonus + multi-category bonus + source prior.
  let impactRaw = 0;
  for (const term of HIGH_IMPACT_TERMS) {
    if (haystack.includes(term)) impactRaw += 0.18;
  }
  // Per-category bonus — wars, regulation actions, and Fed prints are
  // inherently market-moving even on a single hit.
  const CATEGORY_BONUS = {
    WAR:          0.35,
    "CRYPTO REG": 0.20,
    FED:          0.20,
    MACRO:        0.10,
    EARNINGS:     0.05,
  };
  if (CATEGORY_BONUS[primary]) impactRaw += CATEGORY_BONUS[primary];
  // Multi-category hits scale impact up to +0.2.
  if (matched.size >= 2) impactRaw += 0.12;
  if (matched.size >= 3) impactRaw += 0.08;
  // Title-only hits weigh more (people skim headlines).
  for (const term of HIGH_IMPACT_TERMS) {
    if (title.includes(term)) impactRaw += 0.07;
  }
  const sourcePrior = priorForSource(item?.source);
  const impact = Math.max(0, Math.min(1, impactRaw * sourcePrior));

  return {
    primary,
    matched: Array.from(matched),
    hits,
    impact,
    highImpact: impact >= 0.65,
  };
}

/** Aggregate categorization counts across a list of items. */
export function tally(items) {
  const out = { total: 0, byCat: {}, highImpact: 0 };
  for (const it of items || []) {
    out.total++;
    const c = it.classification || classify(it);
    out.byCat[c.primary] = (out.byCat[c.primary] || 0) + 1;
    if (c.highImpact) out.highImpact++;
  }
  return out;
}

/** Exported for tests / debugging. */
export const _internals = { CAT_KEYWORDS, HIGH_IMPACT_TERMS, SOURCE_PRIOR };
