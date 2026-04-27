/**
 * My Next Prediction v3.0 — M4a · RSS fetchers (CORS-friendly)
 * ------------------------------------------------------------
 * Browser-side RSS is blocked by CORS for almost every publisher feed.
 * We bridge through public CORS-enabled services:
 *
 *   1. rss2json.com  — JSON gateway, generous free tier, no API key
 *   2. allorigins.win — generic CORS proxy + raw XML pass-through
 *   3. corsproxy.io   — alt generic proxy (fallback only)
 *
 * The fetcher returns a normalised `{title, link, summary, source,
 * pubDate, guid}` array.  Every step has a fallback so a single proxy
 * outage doesn't kill the news tab.
 *
 * Curated source list (see SOURCES).  Adding a feed is one line.
 *
 * Pure module: no IDB, no events.  Caller (newsManager.js) handles
 * persistence + EventBus emit.
 */

/* ═══════════════════════════ Curated sources ═══════════════════════════ */

/**
 * Each source: { id, name, url, lang, region, focus[] }
 *   focus: which asset universes this feed primarily covers.
 *          ["crypto"] | ["stock"] | ["macro"] | mix
 */
export const SOURCES = Object.freeze([
  // Crypto-native
  { id: "coindesk",       name: "CoinDesk",       url: "https://www.coindesk.com/arc/outboundfeeds/rss/", focus: ["crypto"], region: "US" },
  { id: "cointelegraph",  name: "Cointelegraph",  url: "https://cointelegraph.com/rss",                  focus: ["crypto"], region: "Global" },
  { id: "decrypt",        name: "Decrypt",        url: "https://decrypt.co/feed",                        focus: ["crypto"], region: "US" },
  { id: "theblock",       name: "The Block",      url: "https://www.theblock.co/rss.xml",                focus: ["crypto"], region: "US" },
  { id: "bitcoinist",     name: "Bitcoinist",     url: "https://bitcoinist.com/feed/",                   focus: ["crypto"], region: "Global" },
  { id: "ambcrypto",      name: "AMBCrypto",      url: "https://ambcrypto.com/feed/",                    focus: ["crypto"], region: "Global" },
  { id: "cryptoslate",    name: "CryptoSlate",    url: "https://cryptoslate.com/feed/",                  focus: ["crypto"], region: "Global" },
  // Macro / equities
  { id: "reuters-business", name: "Reuters Business", url: "https://feeds.reuters.com/reuters/businessNews", focus: ["macro","stock"], region: "Global" },
  { id: "bbc-business",   name: "BBC Business",   url: "https://feeds.bbci.co.uk/news/business/rss.xml",   focus: ["macro","stock"], region: "UK" },
  { id: "marketwatch",    name: "MarketWatch",    url: "https://feeds.marketwatch.com/marketwatch/topstories/", focus: ["stock","macro"], region: "US" },
  { id: "yahoo-finance",  name: "Yahoo Finance",  url: "https://finance.yahoo.com/news/rssindex",           focus: ["stock"], region: "US" },
  { id: "cnbc-top",       name: "CNBC Top News",  url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069", focus: ["stock","macro"], region: "US" },
  // Generic / cross-asset
  { id: "ft",             name: "Financial Times",url: "https://www.ft.com/?format=rss",                   focus: ["macro","stock"], region: "Global" },
]);

/* ═══════════════════════════ Proxy backends ═══════════════════════════ */

/** Try rss2json first (returns parsed JSON directly). */
async function fetchViaRss2json(url, signal) {
  const proxied = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}&count=30`;
  const r = await fetch(proxied, { signal, headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error(`rss2json HTTP ${r.status}`);
  const j = await r.json();
  if (j.status && j.status !== "ok") throw new Error(`rss2json ${j.status}: ${j.message || ""}`);
  return Array.isArray(j.items) ? j.items.map(normaliseRss2json) : [];
}

/** Fallback to allorigins (returns raw XML, parse client-side). */
async function fetchViaAllOrigins(url, signal) {
  const proxied = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  const r = await fetch(proxied, { signal, headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error(`allorigins HTTP ${r.status}`);
  const wrap = await r.json();
  if (!wrap?.contents) throw new Error("allorigins: no contents");
  return parseRssXml(wrap.contents);
}

/** corsproxy.io as a third tier — raw passthrough returning XML. */
async function fetchViaCorsProxy(url, signal) {
  const proxied = `https://corsproxy.io/?${encodeURIComponent(url)}`;
  const r = await fetch(proxied, { signal });
  if (!r.ok) throw new Error(`corsproxy HTTP ${r.status}`);
  const text = await r.text();
  return parseRssXml(text);
}

/* ═══════════════════════════ Parsers ═══════════════════════════ */

function normaliseRss2json(it) {
  return {
    title:   String(it.title || "").trim(),
    link:    String(it.link  || "").trim(),
    summary: String(it.description || it.content || "").trim(),
    pubDate: Date.parse(it.pubDate || "") || Date.now(),
    guid:    String(it.guid || it.link || it.title || ""),
    author:  String(it.author || ""),
    enclosure: it.enclosure || null,
  };
}

/**
 * Parse RSS 2.0 / Atom 1.0 from raw XML.  Uses the browser's
 * `DOMParser` so we don't pull in an XML lib.
 *
 * Returns the same normalised shape as `normaliseRss2json`.
 */
export function parseRssXml(xml) {
  if (typeof xml !== "string" || !xml.length) return [];
  let doc;
  try { doc = new DOMParser().parseFromString(xml, "application/xml"); }
  catch { return []; }
  if (!doc) return [];
  // RSS 2.0 → <item>; Atom → <entry>
  const items = doc.querySelectorAll("item, entry");
  const out = [];
  for (const el of items) {
    const titleEl = el.querySelector("title");
    let linkVal = "";
    const linkEl = el.querySelector("link");
    if (linkEl) {
      // Atom: <link href="..."/>; RSS: <link>...</link>
      linkVal = linkEl.getAttribute("href") || linkEl.textContent || "";
    }
    const descEl =
      el.querySelector("description") ||
      el.querySelector("summary") ||
      el.querySelector("content");
    const pubEl =
      el.querySelector("pubDate") ||
      el.querySelector("published") ||
      el.querySelector("updated");
    const guidEl = el.querySelector("guid, id");

    const title   = (titleEl?.textContent || "").trim();
    const summary = (descEl?.textContent  || "").trim();
    const pubStr  = (pubEl?.textContent   || "").trim();
    const guid    = (guidEl?.textContent  || "").trim() || linkVal || title;
    const pubDate = Date.parse(pubStr) || Date.now();
    if (!title) continue;
    out.push({
      title, link: linkVal.trim(), summary,
      pubDate, guid,
      author: el.querySelector("dc\\:creator, creator")?.textContent || "",
      enclosure: null,
    });
  }
  return out;
}

/* ═══════════════════════════ Public API ═══════════════════════════ */

/**
 * Fetch a single RSS feed via the proxy chain.  Returns normalised
 * items (≤ 30) sorted newest-first, or [] on total failure.
 *
 * @param {{id:string,url:string,name?:string}} src
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function fetchFeed(src, { signal } = {}) {
  if (!src?.url) return [];
  const errs = [];
  const tries = [fetchViaRss2json, fetchViaAllOrigins, fetchViaCorsProxy];
  for (const fn of tries) {
    try {
      const items = await fn(src.url, signal);
      if (items?.length) {
        // Stamp the source onto each item.
        for (const it of items) {
          it.source = src.name || src.id;
          it.sourceId = src.id;
          if (Array.isArray(src.focus)) it.focus = src.focus.slice();
          if (src.region) it.region = src.region;
        }
        // Sort newest-first.
        items.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));
        return items;
      }
    } catch (err) { errs.push(`${fn.name}: ${err?.message || err}`); }
  }
  // All fetchers failed — return empty + record reasons on the
  // source so the manager can surface a status pill.
  return [];
}

/**
 * Fetch every source in parallel.  Returns a flat array of all items,
 * deduped by guid, sorted newest-first, capped at `limit`.
 *
 * @param {object} [opts]
 * @param {Array<typeof SOURCES[number]>} [opts.sources=SOURCES]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.limit=120]
 * @returns {Promise<Array<object>>}
 */
export async function fetchAll({ sources = SOURCES, signal, limit = 120 } = {}) {
  const results = await Promise.all(sources.map((s) => fetchFeed(s, { signal }).catch(() => [])));
  const all = [];
  const seen = new Set();
  for (const arr of results) {
    for (const it of arr) {
      const key = it.guid || it.link || it.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      all.push(it);
    }
  }
  all.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));
  return all.slice(0, limit);
}
