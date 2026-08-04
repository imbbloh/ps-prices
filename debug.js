// Diagnose *why* a region fails to price. Needs network access to the store.
//
//   node debug.js "Beast of Reincarnation"          # all regions
//   node debug.js "Beast of Reincarnation" SG JP DE # just these
//
// Prints, per region, exactly which of the three tiers was tried and what came
// back — so a 3/20 result tells you whether the concept tier or the per-region
// search tier is the one falling over.

const { getText, grab, productIds, conceptId, parseQuery, acceptLang, LOCALES, EXPECT, BASE } = require('./server.js');

const query = process.argv[2];
if (!query) { console.error('usage: node debug.js "<title | store URL | conceptId>" [REGION...]'); process.exit(1); }
const want = process.argv.slice(3).map(s => s.toUpperCase());
const regions = (want.length ? want : Object.keys(LOCALES)).filter(r => {
  if (LOCALES[r]) return true;
  console.error('unknown region: ' + r);
  return false;
});

// Same as priceAt() but reports why it failed rather than just returning null.
async function probe(path, lang) {
  const h = await getText(BASE + path, 1, lang);
  if (h == null) return { ok: false, why: 'no page (404 / timeout / blocked)' };
  const r = grab(h);
  if (r.price == null) return { ok: false, why: 'page loaded (' + h.length + ' bytes) but no price in it' };
  return { ok: true, price: r.price, cur: r.cur, name: r.name };
}

// A store answering in someone else's currency is usually geo-fallback.
function note(rk, r) {
  if (!r.ok || !r.cur || r.cur === EXPECT[rk]) return '';
  return '  <-- ' + r.cur + ', expected ' + EXPECT[rk];
}

(async () => {
  const q = parseQuery(query);
  let pid = q.productId, cid = q.conceptId, title = q.title;
  console.log('Query: ' + query);

  if (!pid && !cid) {
    const searchHtml = await getText(BASE + '/en-us/search/' + encodeURIComponent(title), 3);
    if (!searchHtml) { console.log('GLOBAL SEARCH FAILED — no network, or the store blocked us.'); process.exit(1); }
    const cands = productIds(searchHtml);
    pid = cands[0] || null;
    cid = conceptId(searchHtml);
    console.log('Global search  : ' + cands.length + ' product id(s)');
    cands.slice(0, 5).forEach(c => console.log('                 ' + c));
    for (const c of cands.slice(0, 2)) {
      if (cid) break;
      const p = await getText(BASE + '/en-us/product/' + c, 1);
      if (p) cid = conceptId(p);
    }
  } else {
    console.log('(given directly — global search skipped)');
  }

  console.log('conceptId      : ' + (cid || 'NOT FOUND  <-- tier 1 is dead without this'));
  console.log('shared pid     : ' + (pid || 'none'));

  if (!title && cid) {
    const p = await getText(BASE + '/en-us/concept/' + cid, 1);
    if (p) title = grab(p).name || null;
    console.log('title          : ' + (title || 'unknown (tier 3 will be skipped)'));
  }
  console.log('');

  const tally = { product: 0, concept: 0, search: 0, none: 0 };

  for (const rk of regions) {
    const loc = LOCALES[rk];
    const lang = acceptLang(loc);
    const line = [];
    let done = null;

    if (cid) {
      const r = await probe('/' + loc + '/concept/' + cid, lang);
      line.push('  1 concept : ' + (r.ok ? 'OK ' + r.price + ' ' + r.cur + note(rk, r) : r.why));
      if (r.ok) done = 'concept';
    } else {
      line.push('  1 concept : skipped (no conceptId)');
    }
    if (!done && pid) {
      const r = await probe('/' + loc + '/product/' + pid, lang);
      line.push('  2 product : ' + (r.ok ? 'OK ' + r.price + ' ' + r.cur + note(rk, r) : r.why));
      if (r.ok) done = 'product';
    }
    if (!done && !title) {
      line.push('  3 search  : skipped (no title to search with)');
    } else if (!done) {
      const h = await getText(BASE + '/' + loc + '/search/' + encodeURIComponent(title), 1, lang);
      if (!h) {
        line.push('  3 search  : region search page did not load');
      } else {
        const local = productIds(h).filter(x => x !== pid);
        line.push('  3 search  : ' + local.length + ' local id(s)' + (local.length ? ' -> ' + local.slice(0, 3).join(', ') : '  <-- search HTML has no product links'));
        for (const lid of local.slice(0, 3)) {
          const r = await probe('/' + loc + '/product/' + lid, lang);
          line.push('              ' + lid + ' : ' + (r.ok ? 'OK ' + r.price + ' ' + r.cur + note(rk, r) : r.why));
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
