// PS Store price backend — deploy on Render (or any Node 18+ host).
// Fetches PlayStation Store prices server-side (no browser CORS limits) and
// returns clean JSON. Zero dependencies (uses built-in http + global fetch).

const http = require('http');

const BASE = 'https://store.playstation.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// region code -> store locale
const LOCALES = {
  US:'en-us', UA:'uk-ua', IN:'en-in', JP:'ja-jp', BR:'pt-br', TR:'tr-tr',
  ID:'en-id', MY:'en-my', TW:'zh-tw', HK:'en-hk', KR:'ko-kr', ZA:'en-za',
  PL:'pl-pl', NO:'en-no', CA:'en-ca', AU:'en-au', MX:'es-mx', GB:'en-gb',
  DE:'de-de', SG:'en-sg'
};
// expected currency per region (to flag stores that list in another currency)
const EXPECT = {
  US:'USD', UA:'UAH', IN:'INR', JP:'JPY', BR:'BRL', TR:'TRY', ID:'IDR', MY:'MYR',
  TW:'TWD', HK:'HKD', KR:'KRW', ZA:'ZAR', PL:'PLN', NO:'NOK', CA:'CAD', AU:'AUD',
  MX:'MXN', GB:'GBP', DE:'EUR', SG:'SGD'
};

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

// Fetch with timeout + bounded retries. Retries only transient failures
// (network error, 429, 5xx); a 404 means "not in this store", so return null fast.
async function getText(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
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

function grab(h) {
  let price = null, cur = null, name = null, m;
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  while ((m = re.exec(h))) {
    try {
      const arr = [].concat(JSON.parse(m[1]));
      for (const o of arr) {
        if (o && o.name && !name) name = o.name;
        const f = o && o.offers && (Array.isArray(o.offers) ? o.offers[0] : o.offers);
        if (f && f.price != null) { price = parseNum(f.price); cur = f.priceCurrency || cur; }
      }
    } catch (e) {}
  }
  if (price == null) {
    const pm = h.match(/"basePrice":"([^"]+)"/), cm = h.match(/"currencyCode":"([A-Z]{3})"/);
    if (pm) { price = parseNum(pm[1]); cur = cm ? cm[1] : cur; }
  }
  return { price, cur, name };
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

function conceptId(h) {
  return (h.match(/"conceptId":"?(\d+)"?/) || [])[1] || null;
}

// A page only counts as a hit if it actually carries a price.
async function priceAt(path) {
  const h = await getText(BASE + path);
  if (!h) return null;
  const r = grab(h);
  return r.price != null ? r : null;
}

// 3-tier resolve for one region:
//   1. the shared productId found via the global (en-us) search
//   2. the conceptId, which is global and often survives region-locked SKUs
//   3. that region's own store search, to find its local SKU
// Region-locked titles (e.g. Beast of Reincarnation) have per-region product
// IDs, so tier 3 is what pulls them in.
async function region(pid, cid, loc, title) {
  if (pid) {
    const r = await priceAt('/' + loc + '/product/' + pid);
    if (r) return { ...r, via: 'product', productId: pid };
  }
  if (cid) {
    const r = await priceAt('/' + loc + '/concept/' + cid);
    if (r) return { ...r, via: 'concept', productId: null };
  }
  if (title) {
    const h = await getText(BASE + '/' + loc + '/search/' + encodeURIComponent(title));
    if (h) {
      for (const lid of productIds(h).slice(0, 3)) {
        if (lid === pid) continue;                      // already tried in tier 1
        const r = await priceAt('/' + loc + '/product/' + lid);
        if (r) return { ...r, via: 'search', productId: lid };
      }
    }
  }
  return { price: null, cur: null, name: null, via: null, productId: null };
}

async function lookup(title) {
  const started = Date.now();

  // title -> productId (and conceptId) via the global store search
  const html = await getText(BASE + '/en-us/search/' + encodeURIComponent(title), 3);
  const candidates = html ? productIds(html) : [];
  const pid = candidates[0] || null;

  // A concept ID is global, so it is worth a couple of extra page loads to find one.
  let cid = html ? conceptId(html) : null;
  for (const c of candidates.slice(0, 2)) {
    if (cid) break;
    const p = await getText(BASE + '/en-us/product/' + c);
    if (p) cid = conceptId(p);
  }

  // With no productId AND no conceptId there is nothing to resolve against,
  // and per-region search alone is too loose to trust.
  if (!pid && !cid) return { error: 'No match for "' + title + '"' };

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
      redirected: r.cur != null && r.cur !== EXPECT[rk],
      via: r.via,                    // 'product' | 'concept' | 'search' | null
      productId: r.productId
    };
  });

  return {
    title: gameName || title,
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

module.exports = { parseNum, grab, region, lookup, pool, productIds, conceptId };
