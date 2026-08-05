// Collect the US store's game catalogue via the same GraphQL call the store's
// own browse page makes. Needs network access to web.np.playstation.com.
//
//   node catalog.js            # facets and totals, writes nothing
//   node catalog.js --new      # games released in the last 30 days (~2 requests)
//   node catalog.js --all      # the complete catalogue, price bucket by price bucket
//   node catalog.js --classes  # sample concept pages, report unknown classifications
//   node catalog.js --dates    # fill in missing release dates (resumable)
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
const POOL = Math.min(parseInt(val('--pool', '4'), 10), 8);   // parallel page fetches
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
    if (r.releaseDate) o.releaseDate = r.releaseDate;
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

// Classifications the price extractor already knows how to treat. Anything else
// on a store page is a variant nobody has seen, and if it labels an add-on the
// extractor will let it through as a game -- which is how ITEM and ADD_ON_PACK
// each produced a wrong price. Sampling for unknown values turns that into a
// report before it becomes a bug.
const KNOWN = /^(FULL_GAME|PREMIUM_EDITION|GAME_BUNDLE|GAME_RELATED|ADD_ON_PACK|ADD_?ON|ITEM|VIRTUAL_CURRENCY|SUBSCRIPTION|SEASON_PASS)$/;

async function classCensus(sample) {
  const rows = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (!rows.length) { console.log('no ' + OUT + ' to sample from'); return; }

  // Spread the sample across the file rather than taking the first N, which
  // would only ever look at titles beginning with the same letters.
  const step = Math.max(1, Math.floor(rows.length / sample));
  const picks = [];
  for (let i = 0; i < rows.length && picks.length < sample; i += step) picks.push(rows[i]);

  console.log('sampling ' + picks.length + ' of ' + rows.length + ' concept pages\n');
  const seen = new Map();                       // classification -> example game
  for (const r of picks) {
    const h = await getText('https://store.playstation.com/en-us/concept/' + r.conceptId);
    if (!h) { process.stdout.write('.'); continue; }
    for (const m of h.matchAll(/"storeDisplayClassification":"([A-Z_]+)"/g)) {
      if (!seen.has(m[1])) seen.set(m[1], r.name);
    }
    process.stdout.write('.');
    await sleep(DELAY);
  }

  console.log('\n\nclassifications seen:');
  const unknown = [];
  for (const [cls, example] of [...seen].sort()) {
    const isNew = !KNOWN.test(cls);
    if (isNew) unknown.push(cls);
    console.log('  ' + (isNew ? 'NEW  ' : '     ') + cls.padEnd(24) + 'e.g. ' + example);
  }
  if (unknown.length) {
    console.log('\n' + unknown.length + ' unknown classification(s): ' + unknown.join(', '));
    console.log('If any names an add-on, add it to NOT_A_GAME in server.js.');
    process.exitCode = 1;                        // make the workflow surface it
  } else {
    console.log('\nnothing new.');
  }
}

// Release dates are not on the grid query, but they are on each concept page --
// the same page the price and language parsing already read. One fetch per game
// is unavoidable; what makes it affordable is that it is needed once. The pass
// only touches rows with no date, so it resumes after an interruption and later
// runs cost only the handful of games added since.
async function backfillDates(limit) {
  const { releaseDate } = require('./server.js');
  const rows = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const todo = rows.filter(r => !r.releaseDate).slice(0, limit);
  console.log(rows.length + ' games, ' + rows.filter(r => r.releaseDate).length + ' already dated');
  if (!todo.length) { console.log('nothing to do'); return; }
  console.log('fetching ' + todo.length + ' concept pages at concurrency ' + POOL + '\n');

  let done = 0, found = 0;
  const started = Date.now();
  const workers = Array.from({ length: POOL }, async () => {
    for (;;) {
      const r = todo.shift();
      if (!r) return;
      const h = await getText('https://store.playstation.com/en-us/concept/' + r.conceptId);
      const d = h && releaseDate(h, 'en-us');
      if (d) { r.releaseDate = d; found++; }
      if (++done % 250 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        console.log('  ' + done + ' fetched, ' + found + ' dated, ' +
                    Math.round(rate * 60) + '/min');
      }
      await sleep(DELAY);
    }
  });
  await Promise.all(workers);

  // Write through the same saver so ordering and formatting stay identical.
  const known = new Map(rows.map(r => [r.conceptId, r]));
  const total = save(OUT, known);
  console.log('\ndated ' + found + ' of ' + done + ' fetched');
  console.log(total + ' games in ' + OUT + ', ' +
              rows.filter(r => r.releaseDate).length + ' with a release date');
  const missing = rows.filter(r => !r.releaseDate).length;
  if (missing) console.log(missing + ' still undated — re-run to continue');
}

async function getText(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
                                 signal: AbortSignal.timeout(20000) });
    return r.ok ? await r.text() : null;
  } catch (e) { return null; }
}

(async () => {
  if (has('--classes')) return classCensus(parseInt(val('--classes-sample', '40'), 10));
  if (has('--dates')) return backfillDates(parseInt(val('--limit', '999999'), 10));

  // One call with facets: totals, and the price bands used to partition.
  const probe = await grid(0, 1, [], []);
  const facets = probe.facetOptions || [];
  const price = (facets.find(f => f.name === 'webBasePrice') || {}).values || [];
  const release = (facets.find(f => f.name === 'conceptReleaseDate') || {}).values || [];
  const realTotal = price.reduce((n, v) => n + v.count, 0);

  // Find a band label carrying a currency symbol ("Under $1.99"), not one that
  // is only a word ("Free") -- the point is to make the storefront visible.
  const symbol = price.map(v => (String(v.displayName).match(/[^\w\s.,\-]/) || [])[0])
                      .find(Boolean) || '';
  console.log('category  : ' + probe.localizedName + '  (' + probe.reportingName + ')');
  console.log('locale    : ' + LOCALE + (symbol ? '   storefront prices in "' + symbol + '"' : ''));
  console.log('reported  : ' + (probe.pageInfo || {}).totalCount + '   <-- capped at ' + HARD_CAP);
  // Bands can nest -- "Free" (0-0) sits inside "Under $1.99" (0-199) -- so the
  // sum over-counts. It is an upper bound; the deduplicated walk is the truth.
  console.log('facet sum : ' + realTotal + '   (upper bound over ' + price.length + ' bands; they can overlap)');
  release.forEach(v => console.log('  ' + v.key.padEnd(18) + String(v.count).padStart(5) + '  ' + v.displayName));

  if (!has('--all') && !has('--new')) {
    console.log('\n--new for the last 30 days, --all for the complete catalogue.');
    return;
  }

  const previous = load(OUT);
  // Collect into a fresh map so a full walk knows exactly what the storefront
  // listed this run, rather than inheriting whatever was in the file.
  const seen = new Map();
  const added = [];
  let pages = 0;

  if (has('--new')) {
    console.log('\nmode      : new releases (conceptReleaseDate:last_thirty_days)');
    pages += await collect(seen, added, ['conceptReleaseDate:last_thirty_days'], 'last_thirty_days');
  } else {
    console.log('\nmode      : full walk, one price band at a time');
    if (!price.length) {
      console.log('  no price facet — falling back to a single unfiltered walk (will cap at ' + HARD_CAP + ')');
      pages += await collect(seen, added, [], 'unfiltered');
    } else {
      for (const b of price) {
        pages += await collect(seen, added, ['webBasePrice:' + b.key], b.key + '  ' + b.displayName);
        await sleep(DELAY);
      }
    }
  }

  // A full walk is authoritative: the file becomes exactly what the storefront
  // listed, so titles that were delisted -- or that came from a different
  // storefront before the locale was pinned -- drop out. --new only ever sees a
  // 30-day slice, so it must add to the file rather than replace it.
  const known = has('--all') ? new Map() : new Map(previous);
  for (const [id, row] of seen) {
    const before = previous.get(id);
    known.set(id, { ...row, firstSeen: (before && before.firstSeen) || row.firstSeen });
  }

  const fresh = [...seen.keys()].filter(id => !previous.has(id));
  const dropped = has('--all') ? [...previous.values()].filter(r => !seen.has(r.conceptId)) : [];

  console.log('\npages fetched: ' + pages);
  console.log('new games    : ' + fresh.length);
  added.filter(n => true).slice(0, 25).forEach(n => console.log('  + ' + n));
  if (added.length > 25) console.log('  … and ' + (added.length - 25) + ' more');
  if (dropped.length) {
    console.log('removed      : ' + dropped.length + ' no longer listed');
    dropped.slice(0, 10).forEach(r => console.log('  - ' + r.name));
    if (dropped.length > 10) console.log('  … and ' + (dropped.length - 10) + ' more');
  }

  const total = save(OUT, known);
  console.log('catalogue    : ' + total + ' games -> ' + OUT);
  if (has('--all') && realTotal > seen.size) {
    console.log('             (' + (realTotal - seen.size) + ' fewer than the facet sum, which double-counts nested bands)');
  }
  if (has('--all') && realTotal && seen.size < realTotal * 0.9) {
    console.log('NOTE: this run saw ' + seen.size + ' but the facets claim ' + realTotal + ' — a slice may have failed.');
  }
})().catch(e => {
  console.error('failed: ' + e.message);
  if (/PersistedQueryNotFound/i.test(e.message)) {
    console.error('The persisted-query hash has changed. Re-capture it from the browse page');
    console.error('(F12 -> Network -> filter "categoryGridRetrieve") and pass it with --hash.');
  }
  process.exit(1);
});
