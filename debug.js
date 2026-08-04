// Diagnose *why* a region fails to price. Needs network access to the store.
//
//   node debug.js "Beast of Reincarnation"          # all regions
//   node debug.js "Beast of Reincarnation" SG JP DE # just these
//
// Prints, per region, exactly which of the three tiers was tried and what came
// back — so a 3/20 result tells you whether the concept tier or the per-region
// search tier is the one falling over.

const { getText, grab, productIds, conceptId, LOCALES, BASE } = require('./server.js');

const title = process.argv[2];
if (!title) { console.error('usage: node debug.js "<title>" [REGION...]'); process.exit(1); }
const want = process.argv.slice(3).map(s => s.toUpperCase());
const regions = (want.length ? want : Object.keys(LOCALES)).filter(r => {
  if (LOCALES[r]) return true;
  console.error('unknown region: ' + r);
  return false;
});

// Same as priceAt() but reports why it failed rather than just returning null.
async function probe(path) {
  const h = await getText(BASE + path, 1);
  if (h == null) return { ok: false, why: 'no page (404 / timeout / blocked)' };
  const r = grab(h);
  if (r.price == null) return { ok: false, why: 'page loaded (' + h.length + ' bytes) but no price in it' };
  return { ok: true, price: r.price, cur: r.cur, name: r.name };
}

(async () => {
  console.log('Title: ' + title + '\n');

  const searchHtml = await getText(BASE + '/en-us/search/' + encodeURIComponent(title), 3);
  if (!searchHtml) { console.log('GLOBAL SEARCH FAILED — no network, or the store blocked us.'); process.exit(1); }

  const cands = productIds(searchHtml);
  let cid = conceptId(searchHtml);
  console.log('Global search  : ' + cands.length + ' product id(s)');
  cands.slice(0, 5).forEach(c => console.log('                 ' + c));

  for (const c of cands.slice(0, 2)) {
    if (cid) break;
    const p = await getText(BASE + '/en-us/product/' + c, 1);
    if (p) cid = conceptId(p);
  }
  console.log('conceptId      : ' + (cid || 'NOT FOUND  <-- tier 2 is dead without this'));
  const pid = cands[0] || null;
  console.log('shared pid     : ' + (pid || 'none') + '\n');

  const tally = { product: 0, concept: 0, search: 0, none: 0 };

  for (const rk of regions) {
    const loc = LOCALES[rk];
    const line = [];
    let done = null;

    if (pid) {
      const r = await probe('/' + loc + '/product/' + pid);
      line.push('  1 product : ' + (r.ok ? 'OK ' + r.price + ' ' + r.cur : r.why));
      if (r.ok) done = 'product';
    }
    if (!done && cid) {
      const r = await probe('/' + loc + '/concept/' + cid);
      line.push('  2 concept : ' + (r.ok ? 'OK ' + r.price + ' ' + r.cur : r.why));
      if (r.ok) done = 'concept';
    } else if (!done) {
      line.push('  2 concept : skipped (no conceptId)');
    }
    if (!done) {
      const h = await getText(BASE + '/' + loc + '/search/' + encodeURIComponent(title), 1);
      if (!h) {
        line.push('  3 search  : region search page did not load');
      } else {
        const local = productIds(h).filter(x => x !== pid);
        line.push('  3 search  : ' + local.length + ' local id(s)' + (local.length ? ' -> ' + local.slice(0, 3).join(', ') : '  <-- search HTML has no product links'));
        for (const lid of local.slice(0, 3)) {
          const r = await probe('/' + loc + '/product/' + lid);
          line.push('              ' + lid + ' : ' + (r.ok ? 'OK ' + r.price + ' ' + r.cur : r.why));
          if (r.ok) { done = 'search'; break; }
        }
      }
    }

    tally[done || 'none']++;
    console.log(rk + ' (' + loc + ')  =>  ' + (done ? 'PRICED via ' + done : 'FAILED'));
    line.forEach(l => console.log(l));
    console.log('');
  }

  console.log('---');
  console.log('via product: ' + tally.product + '   via concept: ' + tally.concept +
              '   via search: ' + tally.search + '   failed: ' + tally.none +
              '   (of ' + regions.length + ')');
})();
