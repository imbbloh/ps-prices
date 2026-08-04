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
const TTL = 10 * 60 * 1000;            // 10 minutes

async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return r.text();
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

async function region(pid, cid, loc) {
  const urls = ['/' + loc + '/product/' + pid];
  if (cid) urls.push('/' + loc + '/concept/' + cid);
  for (const u of urls) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = grab(await getText(BASE + u));
        if (r.price != null) return r;
      } catch (e) {}
    }
  }
  return { price: null, cur: null, name: null };
}

async function lookup(title) {
  const key = title.toLowerCase().trim();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;

  // title -> productId (and conceptId) via store search
  let html = '';
  for (let i = 0; i < 3 && !html; i++) {
    try { html = await getText(BASE + '/en-us/search/' + encodeURIComponent(title)); } catch (e) {}
  }
  const pid = (html.match(/\/product\/([A-Z0-9][\w-]{6,})/i) || [])[1];
  if (!pid) return { error: 'No match for "' + title + '"' };
  let cid = (html.match(/"conceptId":"?(\d+)"?/) || [])[1];
  if (!cid) {
    try {
      const p = await getText(BASE + '/en-us/product/' + pid);
      cid = (p.match(/"conceptId":"?(\d+)"?/) || [])[1];
    } catch (e) {}
  }

  let gameName = null;
  const results = await Promise.all(Object.keys(LOCALES).map(async (rk) => {
    const r = await region(pid, cid, LOCALES[rk]);
    if (r.name && !gameName) gameName = r.name;
    return {
      region: rk,
      currency: r.cur,
      price: r.price,
      redirected: r.cur != null && r.cur !== EXPECT[rk]
    };
  }));

  const data = { title: gameName || title, productId: pid, conceptId: cid || null, results };
  cache.set(key, { ts: Date.now(), data });
  return data;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/prices') {
    const title = (url.searchParams.get('title') || '').trim();
    if (!title) { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'Missing ?title=' })); }
    try {
      const data = await lookup(title);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // health / root
  res.setHeader('Content-Type', 'text/plain');
  res.end('PS-SGD backend is running. Try /prices?title=007%20First%20Light');
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log('PS-SGD backend on :' + PORT));
}

module.exports = { parseNum, grab, region, lookup };
