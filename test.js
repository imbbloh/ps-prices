// Offline unit tests for the price parser + resolver helpers (no network needed).
// Run: node test.js
//
// A fake store on localhost stands in for store.playstation.com, so the 3-tier
// resolver is exercised for real without touching the network.
const PORT = 39217;
process.env.PS_BASE = 'http://localhost:' + PORT;

const { parseNum, grab, pool, productIds, conceptId, conceptIds, parseQuery, acceptLang,
        isAccepted, isForeign, region } = require('./server.js');
const http = require('http');

let fails = 0;
function check(ok, label, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) fails++;
}

const cases = [
  ['Rs 3,999', 3999],      // INR — comma thousands
  ['3.999', 3999],         // dot thousands (the bug we fixed)
  ['¥8,910', 8910],        // JPY
  ['NT$2,090', 2090],      // TWD
  ['R 1,299.00', 1299],    // ZAR — both separators
  ['UAH 2 299,00', 2299],  // space thousands + comma decimal
  ['R$299,90', 299.9],     // BRL comma decimal
  ['$69.99', 69.99],       // USD
  ['RM 304.65', 304.65],   // MYR
  ['₩77,800', 77800],      // KRW
  ['Rp 1.108.890', 1108890], // IDR — dotted thousands
  ['kr 769,00', 769],      // NOK
  ['SGD99.74', 99.74],     // SGD
  ['0', 0],                // free / included title
  ['', null],              // empty string -> null, not NaN
  ['Free', null],          // no digits at all
];

for (const [inp, exp] of cases) {
  const got = parseNum(inp);
  const ok = exp === null ? got === null : (got != null && Math.abs(got - exp) < 0.01);
  check(ok, 'parseNum ' + JSON.stringify(inp).padEnd(16), '-> ' + got + ' (expect ' + exp + ')');
}

// grab() against a store-style JSON-LD block
const sample = '<html><head>' +
  '<script type="application/ld+json">{"@type":"Product","name":"007 First Light","offers":{"@type":"Offer","price":"3,999","priceCurrency":"INR"}}</script>' +
  '</head></html>';
const g = grab(sample);
check(g.price === 3999 && g.cur === 'INR' && g.name === '007 First Light',
  'grab() JSON-LD', '-> ' + JSON.stringify(g));

// grab() falls back to the embedded basePrice blob when JSON-LD carries no offer
const noLd = '<html>{"basePrice":"S$74.90","currencyCode":"SGD"}</html>';
const g2 = grab(noLd);
check(g2.price === 74.9 && g2.cur === 'SGD', 'grab() basePrice fallback', '-> ' + JSON.stringify(g2));

// grab() on a page with no price at all must not invent one
check(grab('<html><body>nothing here</body></html>').price === null, 'grab() no price -> null');

// Sale pricing: a discounted title must report what a shopper pays today,
// keeping the pre-discount figure for the strikethrough.
const onSale = '<html>{"price":{"basePrice":"S$79.90","currencyCode":"SGD",' +
  '"discountText":"-50%","discountedPrice":"S$39.95"}}</html>';
const s1 = grab(onSale);
check(s1.price === 39.95 && s1.original === 79.9 && s1.cur === 'SGD' && s1.discount === '-50%',
  'grab() prefers the sale price', '-> ' + JSON.stringify(s1));

// No discount: discountedPrice mirrors basePrice, so nothing is struck through.
const notOnSale = '<html>{"price":{"basePrice":"S$79.90","currencyCode":"SGD",' +
  '"discountedPrice":"S$79.90"}}</html>';
const s2 = grab(notOnSale);
check(s2.price === 79.9 && s2.original === null && s2.discount === null,
  'grab() no discount -> no original', '-> ' + JSON.stringify(s2));

// The percentage is derived when the store gives no discountText.
const noText = '<html>{"price":{"basePrice":"$59.99","currencyCode":"USD","discountedPrice":"$44.99"}}</html>';
const s3 = grab(noText);
check(s3.price === 44.99 && s3.original === 59.99 && s3.discount === '-25%',
  'grab() derives the discount percent', '-> ' + JSON.stringify(s3));

// JSON-LD already carrying the sale price, with basePrice as the original.
const ldSale = '<html><script type="application/ld+json">' +
  '{"@type":"Product","name":"X","offers":{"price":"39.95","priceCurrency":"SGD"}}</script>' +
  '{"basePrice":"S$79.90","currencyCode":"SGD"}</html>';
const s4 = grab(ldSale);
check(s4.price === 39.95 && s4.original === 79.9 && s4.discount === '-50%',
  'grab() JSON-LD sale price keeps basePrice as original', '-> ' + JSON.stringify(s4));

// A free title must stay 0 rather than being read as "no price".
const free = '<html>{"price":{"basePrice":"Free","currencyCode":"SGD","discountedPrice":"Free"}}</html>';
check(grab(free).price === null, 'grab() unparseable "Free" -> null, not 0');

// productIds(): document order, deduped, region-specific SKUs kept distinct
const searchHtml = [
  '<a href="/en-us/product/UB1599-PPSA29343_00-BEASTOFREINCARN">a</a>',
  '<a href="/en-us/product/UB1599-PPSA29343_00-BEASTOFREINCARN">dup</a>',
  '<a href="/en-in/product/UB1599-PPSA29344_00-BEASTOFREINCARN">b</a>'
].join('');
const ids = productIds(searchHtml);
check(ids.length === 2 && ids[0].endsWith('29343_00-BEASTOFREINCARN') && ids[1].endsWith('29344_00-BEASTOFREINCARN'),
  'productIds() order + dedupe', '-> ' + JSON.stringify(ids));
check(productIds('<html>no products</html>').length === 0, 'productIds() empty page -> []');

check(conceptId('{"conceptId":"10010739"}') === '10010739', 'conceptId() quoted');
check(conceptId('{"conceptId":10010739}') === '10010739', 'conceptId() unquoted');
check(conceptId('<html>none</html>') === null, 'conceptId() missing -> null');

// conceptIds() must also pick concepts up from plain /concept/<id> links,
// which is how they appear on search results when the JSON key is absent.
check(conceptId('<a href="/en-in/concept/10014719">Beast of Reincarnation</a>') === '10014719',
  'conceptId() from a /concept/ link');
const cids = conceptIds('<a href="/en-in/concept/10014719">x</a><a href="/en-us/concept/10014719">dup</a><a href="/en-us/concept/10010739">y</a>');
check(cids.length === 2 && cids[0] === '10014719' && cids[1] === '10010739',
  'conceptIds() dedupe across locales', '-> ' + JSON.stringify(cids));
check(conceptIds('<html>none</html>').length === 0, 'conceptIds() none -> []');

// parseQuery(): a pasted store URL or bare ID must skip search entirely.
const pq = [
  ['https://store.playstation.com/en-in/concept/10014719', { conceptId:'10014719', productId:null, title:null }],
  ['https://store.playstation.com/en-us/product/UB1599-PPSA29343_00-BEAST', { conceptId:null, productId:'UB1599-PPSA29343_00-BEAST', title:null }],
  ['10014719',                { conceptId:'10014719', productId:null, title:null }],
  ['Beast of Reincarnation',  { conceptId:null, productId:null, title:'Beast of Reincarnation' }],
  ['007 First Light',         { conceptId:null, productId:null, title:'007 First Light' }],
  ['  Elden Ring  ',          { conceptId:null, productId:null, title:'Elden Ring' }]
];
for (const [inp, exp] of pq) {
  const got = parseQuery(inp);
  check(got.conceptId === exp.conceptId && got.productId === exp.productId && got.title === exp.title,
    'parseQuery ' + JSON.stringify(inp).padEnd(58), '-> ' + JSON.stringify(got));
}

// acceptLang(): each storefront should be asked in its own language, so it is
// less likely to serve a generic US/English (and USD-priced) response.
check(acceptLang('es-mx') === 'es-MX,es;q=0.9', 'acceptLang es-mx', '-> ' + acceptLang('es-mx'));
check(acceptLang('ja-jp') === 'ja-JP,ja;q=0.9', 'acceptLang ja-jp', '-> ' + acceptLang('ja-jp'));
check(acceptLang('pt-br') === 'pt-BR,pt;q=0.9', 'acceptLang pt-br', '-> ' + acceptLang('pt-br'));
check(acceptLang('en-us') === 'en-US,en;q=0.9', 'acceptLang en-us', '-> ' + acceptLang('en-us'));
check(acceptLang('garbage') === 'en-US,en;q=0.9', 'acceptLang malformed -> default');

// Currency policy: Mexico lists many titles in USD, which is a real price a
// Mexican account pays, so it is ranked — but still labelled as USD.
check(isAccepted('MX', 'USD') === true,  'MX in USD is ranked');
check(isForeign('MX', 'USD') === true,   'MX in USD is labelled foreign');
check(isAccepted('MX', 'MXN') === true,  'MX in MXN is ranked');
check(isForeign('MX', 'MXN') === false,  'MX in MXN is not labelled');
check(isAccepted('MX', 'EUR') === false, 'MX in EUR is still set aside');
// no other region gets the exemption
check(isAccepted('DE', 'USD') === false, 'DE in USD is set aside');
check(isAccepted('SG', 'SGD') === true,  'SG in SGD is ranked');
check(isForeign('SG', 'SGD') === false,  'SG in SGD is not labelled');
check(isForeign('US', null) === false,   'missing currency is not labelled foreign');

// pool(): preserves input order and never exceeds the concurrency cap
(async () => {
  let live = 0, peak = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const out = await pool(items, 3, async (x) => {
    live++; peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, 5 + (x % 3) * 5));
    live--;
    return x * 2;
  });
  check(JSON.stringify(out) === JSON.stringify(items.map(x => x * 2)), 'pool() preserves order', '-> ' + JSON.stringify(out));
  check(peak <= 3, 'pool() respects concurrency cap', '-> peak ' + peak);
  check(JSON.stringify(await pool([], 3, async x => x)) === '[]', 'pool() empty input -> []');

  // --- 3-tier resolver against a fake store -------------------------------
  // Each locale below is wired to fall through to a different tier, so the
  // chosen tier and the reported URL are both checked end to end.
  const CID = '10014719', PID = 'UB1599-PPSA29343_00-BEAST', LOCAL = 'UB1599-PPSA29344_00-BEAST';
  const page = (price, cur) => '<html><script type="application/ld+json">' +
    JSON.stringify({ '@type':'Product', name:'Beast of Reincarnation', offers:{ price, priceCurrency:cur } }) +
    '</script></html>';

  const routes = {
    // SG resolves on tier 1
    ['/en-sg/concept/' + CID]: page('S$70.00', 'SGD'),
    // IN has no concept page, so it must fall through to tier 2
    ['/en-in/product/' + PID]: page('Rs 4,578', 'INR'),
    // JP has neither, and must find its own SKU via tier 3
    ['/ja-jp/search/Beast%20of%20Reincarnation']: '<a href="/ja-jp/product/' + LOCAL + '">x</a>',
    ['/ja-jp/product/' + LOCAL]: page('¥7,982', 'JPY')
    // DE is absent entirely -> no price
  };

  const srv = http.createServer((rq, rs) => {
    const body = routes[rq.url];
    if (body == null) { rs.statusCode = 404; return rs.end('nope'); }
    rs.end(body);
  });
  await new Promise(r => srv.listen(PORT, r));

  const base = 'http://localhost:' + PORT;
  const sg = await region(PID, CID, 'en-sg', 'Beast of Reincarnation');
  check(sg.via === 'concept' && sg.price === 70 && sg.cur === 'SGD' && sg.url === base + '/en-sg/concept/' + CID,
    'resolver: concept tier wins when available', '-> ' + sg.via + ' ' + sg.url);

  const inr = await region(PID, CID, 'en-in', 'Beast of Reincarnation');
  check(inr.via === 'product' && inr.price === 4578 && inr.url === base + '/en-in/product/' + PID,
    'resolver: falls back to product', '-> ' + inr.via + ' ' + inr.url);

  const jp = await region(PID, CID, 'ja-jp', 'Beast of Reincarnation');
  check(jp.via === 'search' && jp.price === 7982 && jp.url === base + '/ja-jp/product/' + LOCAL,
    'resolver: finds the local SKU via region search', '-> ' + jp.via + ' ' + jp.url);

  const de = await region(PID, CID, 'de-de', 'Beast of Reincarnation');
  check(de.via === null && de.price === null && de.url === null,
    'resolver: unavailable region yields no price or url', '-> ' + JSON.stringify(de));

  srv.close();

  console.log('\n' + (fails === 0 ? 'All checks passed.' : fails + ' check(s) FAILED.'));
  process.exit(fails === 0 ? 0 : 1);
})();
