// Offline unit tests for the price parser (no network needed).
// Run: node test.js
const { parseNum, grab } = require('./server.js');

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
];

let pass = 0;
for (const [inp, exp] of cases) {
  const got = parseNum(inp);
  const ok = got != null && Math.abs(got - exp) < 0.01;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + JSON.stringify(inp).padEnd(16) + ' -> ' + got + '  (expect ' + exp + ')');
  if (ok) pass++;
}

// grab() against a store-style JSON-LD block
const sample = '<html><head>' +
  '<script type="application/ld+json">{"@type":"Product","name":"007 First Light","offers":{"@type":"Offer","price":"3,999","priceCurrency":"INR"}}</script>' +
  '</head></html>';
const g = grab(sample);
const gok = g.price === 3999 && g.cur === 'INR' && g.name === '007 First Light';
console.log((gok ? 'PASS' : 'FAIL') + '  grab() JSON-LD -> ' + JSON.stringify(g));

console.log('\n' + (pass) + '/' + cases.length + ' parse cases passed' + (gok ? ', grab OK' : ', grab FAILED'));
process.exit(pass === cases.length && gok ? 0 : 1);
