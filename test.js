// Offline unit tests for the price parser + resolver helpers (no network needed).
// Run: node test.js
const { parseNum, grab, pool, productIds, conceptId } = require('./server.js');

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

  console.log('\n' + (fails === 0 ? 'All checks passed.' : fails + ' check(s) FAILED.'));
  process.exit(fails === 0 ? 0 : 1);
})();
