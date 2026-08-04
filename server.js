// PS Store price backend — deploy on Render (or any Node 18+ host).
// Fetches PlayStation Store prices server-side (no browser CORS limits) and
// returns clean JSON. Zero dependencies (uses built-in http + global fetch).

const http = require('http');

const BASE = process.env.PS_BASE || 'https://store.playstation.com';   // overridable for tests
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// region code -> store locale
const LOCALES = {
  US:'en-us', UA:'uk-ua', IN:'en-in', JP:'ja-jp', BR:'pt-br', TR:'tr-tr',
  ID:'en-id', MY:'en-my', TW:'zh-tw', HK:'en-hk', KR:'ko-kr', ZA:'en-za',
  PL:'pl-pl', NO:'en-no', CA:'en-ca', AU:'en-au', MX:'es-mx', GB:'en-gb',
  DE:'de-de', SG:'en-sg'
};
// each region's own currency
const EXPECT = {
  US:'USD', UA:'UAH', IN:'INR', JP:'JPY', BR:'BRL', TR:'TRY', ID:'IDR', MY:'MYR',
  TW:'TWD', HK:'HKD', KR:'KRW', ZA:'ZAR', PL:'PLN', NO:'NOK', CA:'CAD', AU:'AUD',
  MX:'MXN', GB:'GBP', DE:'EUR', SG:'SGD'
};

// Stores that legitimately list in a currency other than their region's own.
// The PS Store Mexico prices plenty of titles in USD; that is a real price a
// Mexican account pays, so it belongs in the ranking rather than set aside.
const ALSO_OK = { MX: ['USD'] };

// Ranked? A price counts if it is in the region's own currency or one of that
// region's accepted alternatives.
function isAccepted(rk, cur) {
  return cur === EXPECT[rk] || (ALSO_OK[rk] || []).includes(cur);
}

// Worth labelling in the UI, so a USD row is not mistaken for a peso one.
function isForeign(rk, cur) {
  return cur != null && cur !== EXPECT[rk];
}

const cache = new Map();               // title(lower) -> { ts, data }
const inflight = new Map();            // title(lower) -> Promise (dedupe concurrent lookups)
const TTL = 10 * 60 * 1000;            // 10 minutes
const MAX_CACHE = 200;                 // bound memory on the free tier
const CONCURRENCY = 6;                 // parallel store requests (avoids rate-limiting)
const TIMEOUT = 12000;                 // per-request timeout, ms

// Run fn over items with at most n in flight at once. Results keep input order.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// 'es-mx' -> 'es-MX,es;q=0.9'. Asking each storefront in its own language makes
// it less likely to fall back to a generic (usually US/English) response.
function acceptLang(loc) {
  const p = ('' + loc).split('-');
  if (p.length !== 2) return 'en-US,en;q=0.9';
  return p[0] + '-' + p[1].toUpperCase() + ',' + p[0] + ';q=0.9';
}

// Fetch with timeout + bounded retries. Retries only transient failures
// (network error, 429, 5xx); a 404 means "not in this store", so return null fast.
async function getText(url, tries = 2, lang = 'en-US,en;q=0.9') {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': lang },
        signal: AbortSignal.timeout(TIMEOUT)
      });
      if (r.status === 404 || r.status === 410) return null;
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) return null;
      return await r.text();
    } catch (e) {
      if (i === tries - 1) return null;
      await new Promise(res => setTimeout(res, 400 * (i + 1)));   // small backoff
    }
  }
  return null;
}

function parseNum(raw) {
  raw = ('' + raw).replace(/[^\d.,\s]/g, '').replace(/\s/g, '');
  if (!raw) return null;
  const d = raw.indexOf('.') >= 0, c = raw.indexOf(',') >= 0;
  if (d && c) {
    raw = raw.lastIndexOf('.') > raw.lastIndexOf(',')
      ? raw.replace(/,/g, '')
      : raw.replace(/\./g, '').replace(',', '.');
  } else if (c) {
    const p = raw.split(',');
    raw = (p.length === 2 && p[1].length <= 2) ? p[0] + '.' + p[1] : raw.replace(/,/g, '');
  } else if (d) {
    const p = raw.split('.');
    if (!(p.length === 2 && p[1].length <= 2)) raw = raw.replace(/\./g, '');
  }
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

// The store's embedded price object carries the sale price separately from the
// original. Keys sit together in one small flat object, so read them from a
// window around the first "basePrice" rather than trying to brace-match JSON.
function priceBlock(h) {
  const i = h.indexOf('"basePrice"');
  if (i < 0) return null;
  const w = h.slice(Math.max(0, i - 200), i + 600);
  const pick = re => (w.match(re) || [])[1];
  return {
    base: pick(/"basePrice":"([^"]*)"/),
    disc: pick(/"discountedPrice":"([^"]*)"/),
    cur:  pick(/"currencyCode":"([A-Z]{3})"/),
    text: pick(/"discountText":"([^"]*)"/)
  };
}

// Returns the price a shopper actually pays today. When a title is discounted,
// `price` is the sale price and `original` is what it was struck through from.
function grab(h) {
  let ld = null, cur = null, name = null, m;
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  while ((m = re.exec(h))) {
    try {
      const arr = [].concat(JSON.parse(m[1]));
      for (const o of arr) {
        if (o && o.name && !name) name = o.name;
        const f = o && o.offers && (Array.isArray(o.offers) ? o.offers[0] : o.offers);
        if (f && f.price != null) { ld = parseNum(f.price); cur = f.priceCurrency || cur; }
      }
    } catch (e) {}
  }

  const b = priceBlock(h);
  const base = b ? parseNum(b.base) : null;
  const disc = b ? parseNum(b.disc) : null;
  if (b && b.cur) cur = cur || b.cur;

  let price = null, original = null;
  if (disc != null && (base == null || disc < base)) {
    price = disc; original = base;                 // on sale, per the store's own fields
  } else if (ld != null) {
    price = ld;
    if (base != null && base > ld) original = base;  // JSON-LD already carried the sale price
  } else if (base != null) {
    price = base;
  }

  let discount = null;
  if (original != null && price != null && original > 0) {
    discount = (b && b.text) ? b.text : '-' + Math.round((1 - price / original) * 100) + '%';
  }
  return { price, cur, name, original, discount };
}

// All product IDs on a page, in document order, deduped.
function productIds(h) {
  const out = [], seen = new Set(), re = /\/product\/([A-Z0-9][\w-]{6,})/gi;
  let m;
  while ((m = re.exec(h))) {
    const id = m[1];
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

// Concept IDs, in document order, deduped. Read from both the embedded JSON
// key and any /concept/<id> link on the page — search results often link
// straight to the concept even when the JSON key is absent or renamed.
function conceptIds(h) {
  const out = [], seen = new Set();
  for (const re of [/"conceptId":"?(\d+)"?/g, /\/concept\/(\d+)/g]) {
    let m;
    while ((m = re.exec(h))) {
      if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
    }
  }
  return out;
}

function conceptId(h) {
  return conceptIds(h)[0] || null;
}

// Accept a pasted store URL or a bare concept ID instead of a title, so a
// known-good concept (e.g. .../en-in/concept/10014719) skips search entirely.
function parseQuery(q) {
  const s = ('' + q).trim();
  const cm = s.match(/\/concept\/(\d+)/);
  if (cm) return { conceptId: cm[1], productId: null, title: null };
  const pm = s.match(/\/product\/([A-Z0-9][\w-]{6,})/i);
  if (pm) return { conceptId: null, productId: pm[1], title: null };
  if (/^\d{5,}$/.test(s)) return { conceptId: s, productId: null, title: null };
  return { conceptId: null, productId: null, title: s };
}

// A page only counts as a hit if it actually carries a price.
async function priceAt(path, lang) {
  const h = await getText(BASE + path, 2, lang);
  if (!h) return null;
  const r = grab(h);
  return r.price != null ? r : null;
}

// 3-tier resolve for one region, cheapest-and-most-reliable first:
//   1. the conceptId — global, so the same ID works in every storefront
//   2. the productId found via the global (en-us) search — often region-specific
//   3. that region's own store search, to find its local SKU
// Product IDs vary per region on region-locked titles (Beast of Reincarnation
// is ...PPSA29343... in the US but ...PPSA29344... in India), which is why the
// concept goes first and per-region search is the last resort.
async function region(pid, cid, loc, title) {
  const lang = acceptLang(loc);
  if (cid) {
    const p = '/' + loc + '/concept/' + cid;
    const r = await priceAt(p, lang);
    if (r) return { ...r, via: 'concept', productId: null, url: BASE + p };
  }
  if (pid) {
    const p = '/' + loc + '/product/' + pid;
    const r = await priceAt(p, lang);
    if (r) return { ...r, via: 'product', productId: pid, url: BASE + p };
  }
  if (title) {
    const h = await getText(BASE + '/' + loc + '/search/' + encodeURIComponent(title), 2, lang);
    if (h) {
      for (const lid of productIds(h).slice(0, 3)) {
        if (lid === pid) continue;                      // already tried in tier 2
        const p = '/' + loc + '/product/' + lid;
        const r = await priceAt(p, lang);
        if (r) return { ...r, via: 'search', productId: lid, url: BASE + p };
      }
    }
  }
  return { price: null, cur: null, name: null, original: null, discount: null, via: null, productId: null, url: null };
}

async function lookup(query) {
  const started = Date.now();
  const q = parseQuery(query);
  let pid = q.productId, cid = q.conceptId, title = q.title;

  if (!pid && !cid) {
    // title -> conceptId / productId via the global store search
    const html = await getText(BASE + '/en-us/search/' + encodeURIComponent(title), 3);
    const candidates = html ? productIds(html) : [];
    pid = candidates[0] || null;
    cid = html ? conceptId(html) : null;

    // A concept ID resolves every region at once, so it is worth a couple of
    // extra page loads to find one.
    for (const c of candidates.slice(0, 2)) {
      if (cid) break;
      const p = await getText(BASE + '/en-us/product/' + c);
      if (p) cid = conceptId(p);
    }
  } else if (pid && !cid) {
    const p = await getText(BASE + '/en-us/product/' + pid);
    if (p) cid = conceptId(p);
  }

  // With no productId AND no conceptId there is nothing to resolve against,
  // and per-region search alone is too loose to trust.
  if (!pid && !cid) return { error: 'No match for "' + query + '"' };

  // Given a bare URL/ID we have no title yet; recover one from the concept
  // page so the per-region search tier still has something to search for.
  if (!title && cid) {
    const p = await getText(BASE + '/en-us/concept/' + cid);
    if (p) title = grab(p).name || null;
  }

  const keys = Object.keys(LOCALES);
  const found = await pool(keys, CONCURRENCY, rk => region(pid, cid, LOCALES[rk], title));

  let gameName = null;
  const results = keys.map((rk, i) => {
    const r = found[i];
    if (r.name && !gameName) gameName = r.name;
    return {
      region: rk,
      currency: r.cur,
      price: r.price,
      original: r.original || null,   // pre-discount price, when on sale
      discount: r.discount || null,   // e.g. '-50%'
      redirected: r.cur != null && !isAccepted(rk, r.cur),   // excluded from ranking
      foreign: isForeign(rk, r.cur),                         // ranked, but not the local currency
      via: r.via,                    // 'concept' | 'product' | 'search' | null
      productId: r.productId,
      url: r.url || null             // the exact store page this price came from
    };
  });

  return {
    title: gameName || title || query,
    productId: pid,
    conceptId: cid || null,
    priced: results.filter(r => r.price != null).length,
    total: results.length,
    elapsedMs: Date.now() - started,
    results
  };
}

// Cached + de-duplicated wrapper: two users searching the same title while a
// lookup is in flight share one set of store requests.
function lookupCached(title) {
  const key = title.toLowerCase().trim();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return Promise.resolve({ ...hit.data, cached: true });
  if (inflight.has(key)) return inflight.get(key);

  const p = lookup(title)
    .then(data => {
      if (!data.error && data.priced > 0) {
        cache.set(key, { ts: Date.now(), data });
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      }
      return data;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const url = new URL(req.url, 'http://localhost');

  // Cheap endpoint the frontend pings on page load to wake the free-tier dyno.
  if (url.pathname === '/health') return json(res, 200, { ok: true, uptime: Math.round(process.uptime()) });

  if (url.pathname === '/prices') {
    const title = (url.searchParams.get('title') || '').trim();
    if (!title) return json(res, 400, { error: 'Missing ?title=' });
    if (title.length > 120) return json(res, 400, { error: 'Title too long' });
    try {
      json(res, 200, await lookupCached(title));
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  res.setHeader('Content-Type', 'text/plain');
  res.end('PS-SGD backend is running. Try /prices?title=007%20First%20Light');
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log('PS-SGD backend on :' + PORT));
}

module.exports = {
  parseNum, grab, region, lookup, pool, productIds, conceptId, conceptIds,
  parseQuery, acceptLang, getText, priceAt, isAccepted, isForeign, LOCALES, EXPECT, ALSO_OK, BASE
};
