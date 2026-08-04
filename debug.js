// Diagnose *why* a region fails to price. Needs network access to the store.
//
//   node debug.js "Beast of Reincarnation"           # all regions
//   node debug.js "Beast of Reincarnation" SG JP DE  # just these
//   node debug.js --langs "<url|title>" BR JP        # language spec only
//   node debug.js --prices "<url|title>" US SG       # every priced entry on the page
//
// --langs prints what each store page actually says about languages: the label
// it matched, the list it read, and the resulting english flag. When a region
// comes back unknown it dumps nearby language-ish lines instead, so the real
// wording can be added to SCREEN_LABELS / VOICE_LABELS in server.js.
//
// Prints, per region, exactly which of the three tiers was tried and what came
// back — so a 3/20 result tells you whether the concept tier or the per-region
// search tier is the one falling over.

const { getText, grab, productIds, conceptId, parseQuery, acceptLang, languages, textLines,
        priceBlocks, LOCALES, EXPECT, BASE } = require('./server.js');

const argv = process.argv.slice(2);
const LANGS_ONLY = argv[0] === '--langs';
if (LANGS_ONLY) argv.shift();
const PRICES_ONLY = argv[0] === '--prices';
if (PRICES_ONLY) argv.shift();
process.argv = [process.argv[0], process.argv[1], ...argv];

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
  return { ok: true, price: r.price, cur: r.cur, name: r.name, original: r.original, discount: r.discount };
}

// A store answering in someone else's currency is usually geo-fallback.
function note(rk, r) {
  let s = '';
  if (r.ok && r.original != null) s += '  (was ' + r.original + ' ' + (r.discount || '') + ')';
  if (r.ok && r.cur && r.cur !== EXPECT[rk]) s += '  <-- ' + r.cur + ', expected ' + EXPECT[rk];
  return s;
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

  // --prices: every priced entry a page carries, so a concept page listing the
  // game beside its add-ons is visible rather than guessed at.
  if (PRICES_ONLY) {
    for (const rk of regions) {
      const loc = LOCALES[rk], lang = acceptLang(loc);
      const h = cid ? await getText(BASE + '/' + loc + '/concept/' + cid, 1, lang)
                    : (pid ? await getText(BASE + '/' + loc + '/product/' + pid, 1, lang) : null);
      if (!h) { console.log(rk + ' (' + loc + ')  =>  no page'); continue; }

      const blocks = priceBlocks(h);
      const g = grab(h);
      console.log(rk + ' (' + loc + ')  =>  chosen ' + g.price + ' ' + (g.cur || '') +
        (g.original ? '  (was ' + g.original + ' ' + (g.discount || '') + ')' : '') +
        '   [' + g.editions + ' game entr' + (g.editions === 1 ? 'y' : 'ies') + ' of ' + g.onPage + ' priced]');
      if (!blocks.length) console.log('   no "basePrice" blocks — price came from JSON-LD only');
      blocks.forEach((b, i) => console.log(
        '   ' + String(i + 1).padStart(2) + '  ' + String(b.base).padEnd(12) +
        'sale ' + String(b.disc).padEnd(12) +
        (b.cls || 'NO CLASSIFICATION').padEnd(20) +
        (b.name ? b.name.slice(0, 40) : '')));
      if (!blocks.some(b => b.cls)) {
        console.log('   ^ no storeDisplayClassification anywhere: add-ons cannot be told from');
        console.log('     editions, so only the first entry is used. Paste this output to fix that.');
      }
      console.log('');
    }
    return;
  }

  // --langs: report what each store page says about languages, in its own words.
  if (LANGS_ONLY) {
    for (const rk of regions) {
      const loc = LOCALES[rk], lang = acceptLang(loc);
      let h = cid ? await getText(BASE + '/' + loc + '/concept/' + cid, 1, lang) : null;
      let from = 'concept';
      let L = h ? languages(h) : { english: null };
      if (L.english == null && pid) {                     // concept pages often omit the spec
        const p = await getText(BASE + '/' + loc + '/product/' + pid, 1, lang);
        if (p) { h = p; from = 'product'; L = languages(p); }
      }
      if (!h) { console.log(rk + ' (' + loc + ')  =>  no page'); continue; }

      console.log(rk + ' (' + loc + ')  =>  english=' + L.english + '   [' + from + ' page]');
      if (L.source) console.log('   matched  : ' + L.source);
      if (L.screen) console.log('   screen   : ' + L.screen.join(', '));
      if (L.voice)  console.log('   voice    : ' + L.voice.join(', '));
      if (L.english == null) {
        // Show the page's own wording so the labels can be extended.
        const hits = textLines(h).filter(l => l.length < 60 &&
          /(language|idioma|lingua|langue|sprache|j[ee]zyk|мов|dil|言語|語言|언어|ภาษา|bahasa|voice|voz|audio|ses|音声|음성)/i.test(l));
        console.log('   UNKNOWN — nearest language-ish lines on the page:');
        (hits.length ? hits.slice(0, 12) : ['   (none — the spec is probably not in the server HTML)'])
          .forEach(l => console.log('     | ' + l));
      }
      console.log('');
    }
    return;
  }

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
