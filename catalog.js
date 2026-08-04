// Collect the US store's game catalogue via the same GraphQL call the store's
// own browse page makes. Needs network access to web.np.playstation.com.
//
//   node catalog.js            # facets and totals, writes nothing
//   node catalog.js --new      # games released in the last 30 days (~2 requests)
//   node catalog.js --all      # the complete catalogue, price bucket by price bucket
//
// Discovered by watching the browse page's own network calls:
//   operationName=categoryGridRetrieve
//   variables={id:<category>, pageArgs:{size,offset}, ...}
//   extensions={persistedQuery:{version:1, sha256Hash:<hash>}}
//
// Two things to know before relying on this:
//
//   1. THE API CAPS AT 10,000. offset 10000 returns "Incorrect offset/limit",
//      and pageInfo.totalCount reports exactly 10000 whatever the real size, so
//      a full walk means "the first 10,000 of the category", never "everything".
//      To go further, partition with filterBy/sortBy into slices under 10k.
//
//   2. THE HASH IS A MOVING TARGET. sha256Hash identifies a persisted query and
//      changes when the store redeploys its front end. On PersistedQueryNotFound,
//      re-capture it: browse page, F12 -> Network, filter "categoryGridRetrieve",
//      copy sha256Hash from the request URL, pass it with --hash.
//
// Filters are strings of the form "<facet>:<value>", verified against the
// facet counts the API itself reports (conceptReleaseDate:last_thirty_days
// returns exactly the 124 the Release Date facet claims).
//
// That solves both awkward parts:
//
//   NEW RELEASES. --new filters to conceptReleaseDate:last_thirty_days, so the
//   daily check is a couple of requests driven by actual release date, rather
//   than paging a category ordered by popularity and hoping new titles are near
//   the front.
//
//   THE 10,000 CAP. The category reports 12,908 games across its price facet
//   but refuses offsets past 10,000. --all therefore walks one price bucket at
//   a time (the largest holds ~4,000) and unions the results, which reaches the
//   whole catalogue instead of the first 10,000. Buckets come from the live
//   facet list, so new bands are picked up automatically.
//
// Saved per game: conceptId, name, firstSeen. The API exposes no release date
// on this query, so firstSeen records when this tool first saw the game --
// stable, and enough to date an addition. Prices are deliberately not saved:
// they change constantly and would rewrite every row daily, burying the one
// useful signal in the diff.

const fs = require('fs');

const GQL = process.env.PS_GQL || 'https://web.np.playstation.com/api/graphql/v1//op';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HARD_CAP = 10000;                 // server refuses offsets at or beyond this

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const CATEGORY = val('--category', '28c9c2b2-cecc-415c-9a08-482a605cb104');  // "All games" (PS5WM_GMA_ALL_GAMES)
const HASH = val('--hash', '4e41660b6732f35c99fc5541926b7502a09557924e8c2cfebd1beb1a5c8c8f81');
const SORT = val('--sort', null);       // e.g. a release-date sort, once its enum value is known
const SIZE = Math.min(parseInt(val('--size', '100'), 10), 100);
const DELAY = parseInt(val('--delay', '400'), 10);
const OUT = val('--out', 'catalog.json');
// Without this the API geolocates by caller IP: a GitHub runner in the UK
// returned the GB storefront (price bands in pounds, a different game count)
// while the same call from a browser on the en-us site returned the US one.
const LOCALE = val('--locale', 'en-US');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function grid(offset, size = SIZE, filterBy = [], facetOptions = []) {
  const variables = {
    id: CATEGORY, pageArgs: { size, offset },
    sortBy: SORT ? JSON.parse(SORT) : null,
    filterBy, facetOptions, maxResults: null
  };
  const extensions = { persistedQuery: { version: 1, sha256Hash: HASH } };
  const url = GQL + '?operationName=categoryGridRetrieve'
    + '&variables=' + encodeURIComponent(JSON.stringify(variables))
    + '&extensions=' + encodeURIComponent(JSON.stringify(extensions));

  const r = await fetch(url, {
    headers: {
      // Apollo rejects requests without one of these as possible CSRF.
      'apollo-require-preflight': 'true',
      'x-apollo-operation-name': 'categoryGridRetrieve',
      'x-psn-store-locale-override': LOCALE,
      'Accept-Language': LOCALE + ',' + LOCALE.split('-')[0] + ';q=0.9',
      'User-Agent': UA
    },
    signal: AbortSignal.timeout(20000)
  });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error('HTTP ' + r.status + ': response was not JSON');
  if (j.errors) throw new Error(j.errors[0] && j.errors[0].message);
  const g = j.data && j.data.categoryGridRetrieve;
  if (!g) throw new Error('unexpected response shape');
  return g;
}

function load(file) {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map(rows.map(r => [r.conceptId, r]));
  } catch (e) { return new Map(); }
}

// One game per line, so a diff line is exactly one game and the daily commit
// reads as a list of what appeared.
function save(file, known) {
  const rows = [...known.values()]
    .sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.conceptId.localeCompare(b.conceptId));
  const body = rows.map(r => {
    const o = { conceptId: r.conceptId, name: r.name };
    if (r.firstSeen) o.firstSeen = r.firstSeen;
    return '  ' + JSON.stringify(o);
  }).join(',\n');
  fs.writeFileSync(file, '[\n' + body + '\n]\n');
  return rows.length;
}

// Collect every page of one filtered slice, adding anything not already known.
async function collect(known, added, filterBy, label) {
  const today = new Date().toISOString().slice(0, 10);
  let offset = 0, pages = 0, total = null;
  for (;;) {
    let g;
    try { g = await grid(offset, SIZE, filterBy); }
    catch (e) { console.log('  ' + label + ' @' + offset + ': ' + e.message + ' — stopping slice'); break; }
    pages++;
    const items = g.concepts || [];
    for (const c of items) {
      if (!c || !c.id || known.has(c.id)) continue;
      known.set(c.id, { conceptId: c.id, name: c.name || null, firstSeen: today });
      added.push(c.name || c.id);
    }
    total = g.pageInfo ? g.pageInfo.totalCount : items.length;
    offset += SIZE;
    if ((g.pageInfo && g.pageInfo.isLast) || !items.length || offset >= Math.min(total, HARD_CAP)) break;
    await sleep(DELAY);
  }
  console.log('  ' + String(label).padEnd(34) + String(total).padStart(6) + ' listed, ' + pages + ' page(s)');
  if (total > HARD_CAP) console.log('    NOTE: slice exceeds the ' + HARD_CAP + ' cap; it needs splitting further.');
  return pages;
}

(async () => {
  // One call with facets: totals, and the price bands used to partition.
  const probe = await grid(0, 1, [], []);
  const facets = probe.facetOptions || [];
  const price = (facets.find(f => f.name === 'webBasePrice') || {}).values || [];
  const release = (facets.find(f => f.name === 'conceptReleaseDate') || {}).values || [];
  const realTotal = price.reduce((n, v) => n + v.count, 0);

  const sample = (price.find(v => /[^0-9 .\-]/.test(v.displayName)) || {}).displayName || '';
  const symbol = (sample.match(/[^\w\s.\-]/) || [''])[0];
  console.log('category  : ' + probe.localizedName + '  (' + probe.reportingName + ')');
  console.log('locale    : ' + LOCALE + (symbol ? '   storefront prices in "' + symbol + '"' : ''));
  console.log('reported  : ' + (probe.pageInfo || {}).totalCount + '   <-- capped at ' + HARD_CAP);
  console.log('actual    : ' + realTotal + '   (summed across ' + price.length + ' price bands)');
  release.forEach(v => console.log('  ' + v.key.padEnd(18) + String(v.count).padStart(5) + '  ' + v.displayName));

  if (!has('--all') && !has('--new')) {
    console.log('\n--new for the last 30 days, --all for the complete catalogue.');
    return;
  }

  const previous = load(OUT);
  const known = new Map(previous);         // keep firstSeen for games already recorded
  const added = [];
  let pages = 0;

  if (has('--new')) {
    console.log('\nmode      : new releases (conceptReleaseDate:last_thirty_days)');
    pages += await collect(known, added, ['conceptReleaseDate:last_thirty_days'], 'last_thirty_days');
  } else {
    console.log('\nmode      : full walk, one price band at a time');
    if (!price.length) {
      console.log('  no price facet — falling back to a single unfiltered walk (will cap at ' + HARD_CAP + ')');
      pages += await collect(known, added, [], 'unfiltered');
    } else {
      for (const b of price) {
        pages += await collect(known, added, ['webBasePrice:' + b.key], b.key + '  ' + b.displayName);
        await sleep(DELAY);
      }
    }
  }

  console.log('\npages fetched: ' + pages);
  console.log('new games    : ' + added.length);
  added.slice(0, 25).forEach(n => console.log('  + ' + n));
  if (added.length > 25) console.log('  … and ' + (added.length - 25) + ' more');

  const total = save(OUT, known);
  console.log('catalogue    : ' + total + ' games -> ' + OUT);
  if (has('--all') && realTotal && total < realTotal * 0.95) {
    console.log('NOTE: collected ' + total + ' but the facets claim ' + realTotal + ' — a slice may have failed.');
  }
})().catch(e => {
  console.error('failed: ' + e.message);
  if (/PersistedQueryNotFound/i.test(e.message)) {
    console.error('The persisted-query hash has changed. Re-capture it from the browse page');
    console.error('(F12 -> Network -> filter "categoryGridRetrieve") and pass it with --hash.');
  }
  process.exit(1);
});
