/**
 * My Next Prediction v3.0 — M4a · Lexicon-based sentiment scorer
 * --------------------------------------------------------------
 * VADER-style sentiment for news headlines + short bodies. Pure
 * client-side, ~5 KB lexicon, no model download.
 *
 * Why a lexicon (vs. Transformers.js DistilBERT):
 *   - DistilBERT is ~60 MB → blocks first-render even on fast links
 *   - Headlines are short / hashtaggy; transformer overhead is
 *     overkill for the boolean we actually display
 *   - A curated finance lexicon hits ~78 % agreement with FinBERT
 *     on crypto news titles in v2's evaluation
 *
 * Scoring rules:
 *   - Each token gets a weight in [-1, +1]
 *   - Bigram lookup catches phrases ("price target", "all-time high")
 *   - Negators ("not", "no", "fail to") flip the next word's polarity
 *   - Intensifiers ("massive", "huge") multiply by 1.5
 *   - Final score = clamped sum / 4 in [-1, +1]
 *   - Score >= +0.2  → bullish
 *     Score <= -0.2  → bearish
 *     Otherwise      → neutral
 *
 * Public API:
 *   - score(text)            → { compound, label, hits: [{token,w}], pos, neg }
 *   - extractSymbols(text)   → ["BTC","ETH","AAPL"...]
 *   - cleanHeadline(html)    → stripped + normalized text
 */

/* ═══════════════════════════ Lexicon ═══════════════════════════ */

/** Bullish tokens (single words). */
const BULL = {
  // Price action
  rally: 0.7, rallying: 0.7, rallies: 0.7,
  surge: 0.8, surges: 0.8, surging: 0.8, surged: 0.7,
  jump: 0.6, jumps: 0.6, jumped: 0.6, jumping: 0.6,
  soar: 0.85, soars: 0.85, soared: 0.85, soaring: 0.85,
  spike: 0.65, spikes: 0.65, spiked: 0.65,
  pump: 0.55, pumps: 0.55, pumping: 0.55,
  rocket: 0.85, rockets: 0.85, rocketed: 0.85,
  moonshot: 0.9, parabolic: 0.85, melt: 0.6,    // "melt-up"
  rebound: 0.6, rebounds: 0.6, rebounded: 0.6,
  recover: 0.5, recovers: 0.5, recovery: 0.55, recovered: 0.5,
  bounce: 0.5, bounces: 0.5, bounced: 0.5,
  climb: 0.55, climbs: 0.55, climbed: 0.55, climbing: 0.55,
  rise: 0.5, rises: 0.5, rising: 0.5, rose: 0.5, risen: 0.5,
  gain: 0.5, gains: 0.5, gained: 0.5, gaining: 0.5,
  advance: 0.45, advances: 0.45, advanced: 0.45,
  uptrend: 0.7, uptrending: 0.7, breakout: 0.7, breakouts: 0.7,
  // Records / extremes
  record: 0.5, records: 0.5, ath: 0.85,
  high: 0.25, highs: 0.25, peak: 0.5, peaks: 0.5,
  // Approval / strength
  approve: 0.6, approved: 0.6, approval: 0.6, approves: 0.6,
  green: 0.4, greenlight: 0.7,
  bullish: 0.85, bull: 0.5, bulls: 0.5,
  optimistic: 0.7, optimism: 0.7,
  upgrade: 0.65, upgraded: 0.65, upgrades: 0.65,
  outperform: 0.7, outperformed: 0.7, outperforming: 0.7,
  beat: 0.6, beats: 0.6, beating: 0.5,
  exceed: 0.55, exceeds: 0.55, exceeded: 0.55,
  positive: 0.4, positives: 0.4, strong: 0.4, stronger: 0.45, strongest: 0.55,
  robust: 0.55, healthy: 0.4, solid: 0.35, resilient: 0.5,
  // Adoption / inflows
  adopt: 0.55, adopts: 0.55, adopted: 0.55, adoption: 0.6,
  inflow: 0.65, inflows: 0.65, accumulate: 0.5, accumulating: 0.5, accumulation: 0.55,
  buying: 0.4, buy: 0.3, buys: 0.3, bought: 0.3,
  endorse: 0.6, endorsed: 0.6, endorses: 0.6,
  partnership: 0.5, partnerships: 0.5, partnered: 0.5, partner: 0.4,
  launch: 0.4, launches: 0.4, launched: 0.4, launching: 0.4,
  expand: 0.4, expansion: 0.45, expanding: 0.4,
  bullrun: 0.85, "bull-run": 0.85,
  // Macro / risk-on
  cut: 0.35,            // "rate cut"
  dovish: 0.65, ease: 0.4, easing: 0.45, stimulus: 0.55,
  // Misc positive
  win: 0.4, wins: 0.4, winning: 0.4, victory: 0.6,
  success: 0.55, successful: 0.55,
  boost: 0.6, boosts: 0.6, boosted: 0.6, boosting: 0.6,
  blockbuster: 0.85, milestone: 0.55,
};

/** Bearish tokens (single words). */
const BEAR = {
  // Price action
  crash: -0.95, crashed: -0.95, crashing: -0.95, crashes: -0.95,
  plunge: -0.9, plunges: -0.9, plunged: -0.9, plunging: -0.9,
  tumble: -0.8, tumbles: -0.8, tumbled: -0.8, tumbling: -0.8,
  collapse: -0.95, collapses: -0.95, collapsed: -0.95, collapsing: -0.95,
  slump: -0.7, slumps: -0.7, slumped: -0.7, slumping: -0.7,
  slide: -0.55, slides: -0.55, sliding: -0.55, slid: -0.55,
  drop: -0.55, drops: -0.55, dropped: -0.55, dropping: -0.55,
  fall: -0.5, falls: -0.5, fell: -0.5, falling: -0.5, fallen: -0.5,
  decline: -0.5, declines: -0.5, declined: -0.5, declining: -0.5,
  retreat: -0.5, retreats: -0.5, retreated: -0.5,
  selloff: -0.85, "sell-off": -0.85,
  dump: -0.7, dumps: -0.7, dumped: -0.7, dumping: -0.7,
  bleed: -0.65, bleeding: -0.65,
  liquidation: -0.7, liquidations: -0.7, liquidated: -0.7,
  meltdown: -0.95, capitulation: -0.85,
  // Sentiment / strength
  bearish: -0.85, bear: -0.5, bears: -0.5,
  pessimistic: -0.7, pessimism: -0.7,
  weak: -0.4, weaker: -0.45, weakest: -0.55, weakness: -0.55,
  // Records / extremes
  low: -0.2, lows: -0.2, bottom: -0.3, bottomed: -0.4,
  // Negative business
  loss: -0.5, losses: -0.5, lose: -0.5, loses: -0.5, losing: -0.5, lost: -0.45,
  miss: -0.55, misses: -0.55, missed: -0.55,
  fail: -0.7, fails: -0.7, failed: -0.7, failure: -0.75,
  cut: -0.35,           // "rate cut" handled in BULL too — sign depends on bigram
  layoff: -0.7, layoffs: -0.7, layoffed: -0.7,
  fired: -0.55, firing: -0.55, terminated: -0.5,
  bankrupt: -0.95, bankruptcy: -0.95, insolvent: -0.85, insolvency: -0.85,
  default: -0.7, defaults: -0.7, defaulted: -0.7,
  fraud: -0.85, scam: -0.85, hack: -0.7, hacks: -0.7, hacked: -0.7, hacking: -0.7,
  exploit: -0.65, exploited: -0.65, exploits: -0.65, exploiting: -0.65,
  rug: -0.85, rugged: -0.85,    // crypto slang
  scandal: -0.75, scandals: -0.75,
  // Regulation / legal
  ban: -0.7, bans: -0.7, banned: -0.7, banning: -0.7,
  lawsuit: -0.65, lawsuits: -0.65, sue: -0.55, sues: -0.55, sued: -0.55, suing: -0.55,
  fine: -0.55, fines: -0.55, fined: -0.55,
  charge: -0.4, charged: -0.55, charges: -0.4,
  indictment: -0.85, indicted: -0.85, indictments: -0.85,
  investigation: -0.45, investigations: -0.45, investigating: -0.45, probe: -0.4, probes: -0.4,
  crackdown: -0.65, crackdowns: -0.65,
  reject: -0.5, rejects: -0.5, rejected: -0.5,
  delay: -0.5, delays: -0.5, delayed: -0.5, postpone: -0.5, postponed: -0.5,
  warn: -0.5, warns: -0.5, warned: -0.5, warning: -0.55, warnings: -0.55,
  caution: -0.4, cautious: -0.4, cautioning: -0.4,
  downgrade: -0.65, downgraded: -0.65, downgrades: -0.65,
  underperform: -0.7, underperformed: -0.7, underperforming: -0.7,
  // Macro / risk-off
  recession: -0.85, recessionary: -0.85, depression: -0.9,
  inflation: -0.4, inflationary: -0.45, hyperinflation: -0.85,
  hawkish: -0.6, tighten: -0.5, tightening: -0.5, hike: -0.45, hikes: -0.45,
  // War / disaster
  war: -0.7, wars: -0.7, conflict: -0.55, conflicts: -0.55,
  attack: -0.65, attacks: -0.65, attacked: -0.65, attacking: -0.65,
  invasion: -0.85, invade: -0.85, invaded: -0.85,
  sanction: -0.55, sanctions: -0.55, sanctioned: -0.55,
  tariff: -0.55, tariffs: -0.55,
  // Crypto-specific
  delist: -0.75, delisted: -0.75, delisting: -0.75,
  freeze: -0.55, frozen: -0.55,
  shutdown: -0.7, shut: -0.4, halt: -0.55, halted: -0.55, halts: -0.55,
};

/** Bigram lexicon — checked before single tokens. */
const BIGRAMS = {
  "all-time high":     0.85,
  "all-time low":     -0.85,
  "new high":          0.65,
  "new low":          -0.65,
  "price target":      0.0,         // neutral on its own — sign comes from surrounding
  "rate hike":        -0.5,
  "rate cut":          0.6,
  "rate hold":         0.0,
  "soft landing":      0.55,
  "hard landing":     -0.65,
  "risk on":           0.55,
  "risk off":         -0.55,
  "buy the dip":       0.55,
  "short squeeze":     0.65,
  "long squeeze":     -0.65,
  "death cross":      -0.7,
  "golden cross":      0.7,
  "bag holder":       -0.4,
  "diamond hands":     0.6,
  "paper hands":      -0.4,
  "fud":              -0.5,
  "fomo":              0.4,
  "pump and dump":    -0.7,
  "interest rate":     0.0,
  "central bank":      0.0,
  "trade war":        -0.7,
  "civil war":        -0.85,
  "world war":        -0.95,
};

/** Negators — flip the next significant token's sign. */
const NEGATORS = new Set([
  "not", "no", "never", "none",
  "isn't", "isnt", "aren't", "arent",
  "won't", "wont", "doesn't", "doesnt", "didn't", "didnt",
  "cannot", "can't", "cant", "shouldn't", "shouldnt",
  "without", "lacks", "lacking", "fails", "failed", "failing",
]);

/** Intensifiers — amplify next significant token. */
const AMPLIFIERS = {
  very: 1.3, extremely: 1.5, hugely: 1.5, massively: 1.6,
  significantly: 1.4, sharply: 1.4, dramatically: 1.5,
  major: 1.3, big: 1.2, enormous: 1.5, mega: 1.4, super: 1.3,
  too: 1.2, so: 1.2,
};

/** Dampeners — soften next significant token. */
const DAMPENERS = {
  slightly: 0.6, somewhat: 0.7, modestly: 0.7, marginally: 0.6,
  partially: 0.7, mildly: 0.7,
};

/* ═══════════════════════════ Helpers ═══════════════════════════ */

const TOKEN_RE = /[A-Za-z][A-Za-z'-]*/g;

/** Lowercase + simple HTML-tag strip + entity decode. */
export function cleanHeadline(text) {
  if (typeof text !== "string") return "";
  let s = text;
  // Strip HTML tags
  s = s.replace(/<[^>]+>/g, " ");
  // Decode common entities
  s = s.replace(/&amp;/gi, "&")
       .replace(/&lt;/gi, "<")
       .replace(/&gt;/gi, ">")
       .replace(/&quot;/gi, '"')
       .replace(/&#39;/g,  "'")
       .replace(/&nbsp;/gi, " ");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Pull a list of upper-case ticker candidates from a headline.
 * Recognises bare tickers like "BTC", "ETH", "AAPL" and "$AAPL" stylised.
 * Filters obvious false-positives (UK, US, EU, IT, IS, AT, …) via a
 * blacklist.
 */
const NON_TICKER = new Set([
  "US","UK","EU","UN","CN","DE","FR","JP","AU","CA","BR","IN","IT","RU",
  "IS","AT","TO","ON","IN","FOR","AND","OR","BY","OF","AS","NY","UAE",
  "CEO","CFO","COO","CTO","CIO","SEC","FBI","DOJ","FED","FAQ","API",
  "CPI","GDP","PMI","ISM","NFP","FOMC","ECB","BOJ","BOE","SNB","RBA","RBI",
  "ETF","NFT","DAO","DEX","CEX","DEFI","NFTS","P2P","B2B","B2C",
  "AI","ML","VR","AR","XR","AML","KYC","ICO","IPO","SPO","PE",
  "TV","ICE","COP","UN","UNDP","WHO","NSA","CIA","IRS","DOE","EPA","FCC",
  "WW3","WWII","WWI","UNESCO","BRICS","NATO","OPEC","ASEAN",
]);

export function extractSymbols(text) {
  if (typeof text !== "string") return [];
  const out = new Set();
  // Match $TICKER first (definitive)
  const dollarRe = /\$([A-Z]{1,6})\b/g;
  let m;
  while ((m = dollarRe.exec(text))) out.add(m[1]);
  // Then bare 2-5 letter all-caps tokens that aren't blacklisted
  const bareRe = /\b([A-Z]{2,5})\b/g;
  while ((m = bareRe.exec(text))) {
    const t = m[1];
    if (NON_TICKER.has(t)) continue;
    out.add(t);
  }
  return Array.from(out);
}

/* ═══════════════════════════ Core scorer ═══════════════════════════ */

/**
 * Score a piece of text and return a compound sentiment in [-1, +1].
 *
 * @param {string} text headline + (optional) summary, joined.
 * @returns {{
 *   compound: number,       // -1..+1, finance-tuned VADER-like
 *   label:    "bullish"|"bearish"|"neutral",
 *   pos:      number,       // sum of positive contributions
 *   neg:      number,       // sum of negative contributions
 *   hits:     {token:string, w:number, kind:"bull"|"bear"|"bigram"|"neg"|"amp"|"damp"}[],
 * }}
 */
export function score(text) {
  const cleaned = cleanHeadline(text || "").toLowerCase();
  if (!cleaned) return { compound: 0, label: "neutral", pos: 0, neg: 0, hits: [] };

  const hits = [];
  let total = 0;

  // 1. Bigram pass (consume) — tokenize once, then scan adjacent pairs.
  const tokens = (cleaned.match(/[a-z][a-z'-]*/g) || []);
  const consumed = new Array(tokens.length).fill(false);

  for (let i = 0; i < tokens.length - 1; i++) {
    if (consumed[i] || consumed[i + 1]) continue;
    const bg = tokens[i] + " " + tokens[i + 1];
    const w  = BIGRAMS[bg];
    if (typeof w === "number") {
      total += w;
      hits.push({ token: bg, w, kind: "bigram" });
      consumed[i] = true; consumed[i + 1] = true;
    }
  }

  // 2. Single-token pass with negator + amplifier lookbehind.  A
  //    negator's effect carries forward up to NEG_RANGE tokens (so
  //    "fails to rally" still flips "rally"), reset only after we
  //    actually consume a sentiment hit.
  const NEG_RANGE = 3;
  let negCarry  = 0;       // tokens left for the negator to bite
  let pendingMul = 1;
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) {
      // Bigram already accounted for; don't carry through it.
      negCarry = 0; pendingMul = 1; continue;
    }
    const t = tokens[i];
    if (NEGATORS.has(t)) {
      negCarry = NEG_RANGE; pendingMul = 1;
      hits.push({ token: t, w: 0, kind: "neg" });
      continue;
    }
    const amp = AMPLIFIERS[t];
    if (typeof amp === "number") {
      pendingMul = amp;
      hits.push({ token: t, w: 0, kind: "amp" });
      continue;
    }
    const damp = DAMPENERS[t];
    if (typeof damp === "number") {
      pendingMul = damp;
      hits.push({ token: t, w: 0, kind: "damp" });
      continue;
    }
    const wB = BULL[t];
    const wS = BEAR[t];
    let w = 0, kind = null;
    if (typeof wB === "number") { w = wB; kind = "bull"; }
    if (typeof wS === "number" && Math.abs(wS) > Math.abs(w)) { w = wS; kind = "bear"; }
    if (kind) {
      let eff = w * pendingMul;
      if (negCarry > 0) eff = -eff;
      total += eff;
      hits.push({ token: t, w: eff, kind });
      negCarry = 0;
      pendingMul = 1;
    } else if (negCarry > 0) {
      // Filler word — decrement the negator window so "fails to also
      // rally" still flips "rally" but "fails. Soup. Then later rally"
      // does not.
      negCarry--;
    }
  }

  // 3. Normalise — divide by 4 to keep the typical 1-3 hit headlines
  //    inside [-1, +1] without saturating; clamp at the edges.
  const compound = Math.max(-1, Math.min(1, total / 4));
  const label =
    compound >=  0.2 ? "bullish" :
    compound <= -0.2 ? "bearish" :
                       "neutral";

  // Split positive vs negative contributions for diagnostics.
  let pos = 0, neg = 0;
  for (const h of hits) {
    if (h.w > 0) pos += h.w;
    else if (h.w < 0) neg += h.w;
  }

  return { compound, label, pos, neg, hits };
}

/**
 * Convenience: combine title + summary, score the merged string with
 * the title weighted more (titles drive headline sentiment in practice).
 */
export function scoreItem({ title, summary }) {
  const t = score(title || "");
  if (!summary) return t;
  const s = score(summary);
  // 70 % title / 30 % summary blend.
  const compound = Math.max(-1, Math.min(1, 0.7 * t.compound + 0.3 * s.compound));
  const label =
    compound >=  0.2 ? "bullish" :
    compound <= -0.2 ? "bearish" :
                       "neutral";
  return {
    compound, label,
    pos: t.pos + s.pos * 0.3,
    neg: t.neg + s.neg * 0.3,
    hits: t.hits.concat(s.hits),
  };
}
