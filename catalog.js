// Probe whether the US store's full catalogue can be enumerated, and if so,
// collect it. Needs network access to the store.
//
//   node catalog.js                        # probe only: what works, how big
//   node catalog.js --pages 5              # crawl 5 browse pages
//   node catalog.js --pages 200 --out us.json
//
// Three routes are tried, cheapest and most reliable first:
//   1. robots.txt -> sitemap(s). If the store publishes product sitemaps this
//      is the whole catalogue with no pagination and no scraping.
//   2. /en-us/pages/browse/{n} HTML. Works only if the grid is server-rendered;
//      the product pages this project already reads are, but the browse grid
//      may be filled in by JavaScript, in which case the HTML has no links.
//   3. The GraphQL endpoint the site itself calls. Not called here — it needs a
//      persisted-query hash that changes across deploys — but the probe reports
//      whether the hash is discoverable in the page, which says whether route 3
//      is worth building.

const fs = require('fs');
const { getText, productIds, conceptIds, grab, BASE } = require('./server.js');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PAGES = parseInt(flag('--pages', '0'), 10);
const OUT = flag('--out', null);
const DELAY = parseInt(flag('--delay', '400'), 10);   // be polite between requests
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function probeSitemaps() {
  console.log('== 1. sitemaps ==');
  const robots = await getText(BASE + '/robots.txt', 2);
  if (!robots) { console.log('   robots.txt unreachable'); return []; }

  const maps = [...robots.matchAll(/sitemap:\s*(\S+)/gi)].map(m => m[1]);
  console.log('   robots.txt lists ' + maps.length + ' sitemap(s)');
  maps.slice(0, 10).forEach(m => console.log('     ' + m));
  if (!maps.length) { console.log('   -> no sitemap route'); return []; }

  // Follow the first sitemap one level; an index points at child sitemaps.
  const first = await getText(maps[0], 2);
  if (!first) { console.log('   first sitemap unreachable'); return maps; }
  const locs = [...first.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const isIndex = /<sitemapindex/i.test(first);
  console.log('   ' + maps[0] + ' -> ' + locs.length + ' <loc> entries (' + (isIndex ? 'index of sitemaps' : 'urls') + ')');

  const products = locs.filter(u => /\/(product|concept)\//.test(u));
  if (products.length) {
    console.log('   ' + products.length + ' product/concept urls on this one sitemap');
    products.slice(0, 3).forEach(u => console.log('     ' + u));
    console.log('   -> SITEMAP ROUTE WORKS. This is the cleanest full enumeration.');
  } else if (isIndex) {
    console.log('   child sitemaps, e.g.:');
    locs.slice(0, 5).forEach(u => console.log('     ' + u));
    console.log('   -> fetch a child to see whether it lists products');
  }
  return locs;
}

async function probeBrowse() {
  console.log('\n== 2. browse page HTML ==');
  const h = await getText(BASE + '/en-us/pages/browse', 2);
  if (!h) { console.log('   browse page unreachable'); return false; }

  const pids = productIds(h), cids = conceptIds(h);
  console.log('   page size: ' + h.length + ' bytes');
  console.log('   product links: ' + pids.length + '   concept links: ' + cids.length);
  if (!pids.length && !cids.length) {
    console.log('   -> grid is CLIENT-RENDERED: no product links in the server HTML,');
    console.log('      so scraping browse pages will not work. Use route 1 or 3.');
    return false;
  }
  console.log('   -> server-rendered. Sample:');
  [...pids.slice(0, 3), ...cids.slice(0, 3)].forEach(x => console.log('     ' + x));

  // How is it paginated, and does it cap?
  const p2 = await getText(BASE + '/en-us/pages/browse/2', 2);
  const p2ids = p2 ? productIds(p2) : [];
  console.log('   page 2: ' + (p2 ? p2ids.length + ' product links' : 'unreachable') +
    (p2ids.length && p2ids[0] === pids[0] ? '   <-- SAME as page 1: pagination not working this way' : ''));
  return pids.length > 0;
}

async function probeGraphql() {
  console.log('\n== 3. GraphQL (what the site itself calls) ==');
  const h = await getText(BASE + '/en-us/pages/browse', 2);
  if (!h) return;
  const hashes = [...new Set([...h.matchAll(/"sha256Hash":"([a-f0-9]{64})"/g)].map(m => m[1]))];
  const ops = [...new Set([...h.matchAll(/"operationName":"(\w+)"/g)].map(m => m[1]))];
  const apiHosts = [...new Set([...h.matchAll(/https:\/\/([\w.-]*np\.playstation\.com)/g)].map(m => m[1]))];
  console.log('   persisted-query hashes in page: ' + hashes.length);
  hashes.slice(0, 3).forEach(x => console.log('     ' + x));
  console.log('   operation names: ' + (ops.slice(0, 8).join(', ') || 'none'));
  console.log('   api hosts: ' + (apiHosts.join(', ') || 'none'));
  console.log(hashes.length
    ? '   -> route 3 is buildable, but hashes change on each store deploy.'
    : '   -> no hashes in the HTML; they are inside the JS bundle.');
}

async function crawlBrowse(pages) {
  console.log('\n== crawling ' + pages + ' browse pages ==');
  const seen = new Map();
  for (let n = 1; n <= pages; n++) {
    const h = await getText(BASE + '/en-us/pages/browse/' + n, 2);
    if (!h) { console.log('   page ' + n + ': unreachable, stopping'); break; }
    const before = seen.size;
    for (const id of productIds(h)) if (!seen.has(id)) seen.set(id, { productId: id });
    for (const id of conceptIds(h)) if (!seen.has('c' + id)) seen.set('c' + id, { conceptId: id });
    const added = seen.size - before;
    console.log('   page ' + n + ': +' + added + ' new (total ' + seen.size + ')');
    if (added === 0) { console.log('   no new items — pagination exhausted or capped'); break; }
    await sleep(DELAY);
  }
  const rows = [...seen.values()];
  console.log('   collected ' + rows.length + ' unique ids');
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(rows, null, 2)); console.log('   wrote ' + OUT); }
  return rows;
}

(async () => {
  console.log('Store: ' + BASE + '\n');
  await probeSitemaps();
  const browseWorks = await probeBrowse();
  await probeGraphql();

  if (PAGES > 0) {
    if (!browseWorks) console.log('\n(browse HTML had no links; crawling anyway so you can see the output)');
    await crawlBrowse(PAGES);
  } else {
    console.log('\nProbe only. Re-run with --pages N to crawl, --out file.json to save.');
  }
})();
