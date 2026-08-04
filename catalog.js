// Collect the US store's game catalogue via the same GraphQL call the store's
// own browse page makes. Needs network access to web.np.playstation.com.
//
//   node catalog.js                          # one page: totals and a sample
//   node catalog.js --update                 # add new games to catalog.json
//   node catalog.js --all                    # full walk (~100 requests)
//   node catalog.js --all --out catalog.json # ...and save
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
// Saved per game: conceptId, name (and releaseDate if the API ever returns one).
//
// Release dates are NOT available from this call: the persisted query's product
// selection does not include them, and a persisted query's fields cannot be
// changed by the caller. New games are therefore found by diffing against the
// previous file, not by date. The category is ordered by popularity rather than
// recency, so --update (which stops after a few known pages) can miss a new
// release that is not popular; --all is the reliable mode.
//
// Prices are deliberately not saved -- they change constantly and would rewrite
// every row daily, burying the one useful signal in the diff.

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
// How many consecutive all-known pages end an incremental run. New titles sit
// at the front of the default ordering, so a few clean pages means we are past
// them; this is deliberately generous because the ordering is not guaranteed.
const STOP_AFTER = parseInt(val('--stop-after', '3'), 10);

const SINCE = val('--since', null);     // ISO date; only count games released on/after it

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Release date is not a top-level concept field; it hangs off the concept's
// products (and the store also exposes it as a facet). Look in both places and
// accept nothing rather than guessing.
function releaseDate(c) {
  const cand = c.releaseDate
    || (c.products || []).map(p => p && (p.releaseDate || p.releaseDateTime)).find(Boolean)
    || (c.personalizedMeta && c.personalizedMeta.releaseDate)
    || null;
  if (!cand) return null;
  const d = new Date(cand);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

async function grid(offset, size = SIZE) {
  const variables = {
    id: CATEGORY, pageArgs: { size, offset },
    sortBy: SORT ? JSON.parse(SORT) : null,
    filterBy: [], facetOptions: [], maxResults: null
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
    if (r.releaseDate) o.releaseDate = r.releaseDate;   // omit when the API did not give one
    return '  ' + JSON.stringify(o);
  }).join(',\n');
  fs.writeFileSync(file, '[\n' + body + '\n]\n');
  return rows.length;
}

// Page forward, collecting concepts we do not already have. `stopAfter` ends an
// incremental run once that many consecutive pages bring nothing new.
async function walk(known, stopAfter) {
  const added = [];
  let clean = 0, pages = 0;
  for (let offset = 0; offset < HARD_CAP; offset += SIZE) {
    let g;
    try { g = await grid(offset); }
    catch (e) { console.log('  offset ' + offset + ': ' + e.message + ' — stopping'); break; }
    pages++;

    let fresh = 0;
    for (const c of (g.concepts || [])) {
      if (!c || !c.id || known.has(c.id)) continue;
      const rd = releaseDate(c);
      if (SINCE && rd && rd < SINCE) continue;      // older than the cutoff: not a new game
      known.set(c.id, { conceptId: c.id, name: c.name || null, releaseDate: rd });
      added.push({ name: c.name || c.id, releaseDate: rd });
      fresh++;
    }

    if (fresh === 0) { if (++clean >= stopAfter) break; } else clean = 0;
    if (g.pageInfo && g.pageInfo.isLast) break;
    if (offset && offset % 1000 === 0) console.log('  offset ' + offset + ' … ' + known.size + ' known');
    await sleep(DELAY);
  }
  return { added, pages };
}

(async () => {
  const first = await grid(0);
  const info = first.pageInfo || {};
  console.log('category : ' + first.localizedName + '  (' + first.reportingName + ')');
  console.log('total    : ' + info.totalCount + (info.totalCount === HARD_CAP ? '   <-- API cap, likely not the real total' : ''));
  console.log('per page : ' + (first.concepts || []).length);

  if (!has('--all') && !has('--update')) {
    console.log('sample   : ' + (first.concepts || []).slice(0, 3).map(c => c.name).join(' | '));
    console.log('\n--update to add new games to ' + OUT + ', --all for a full rebuild.');
    return;
  }

  const previous = load(OUT);                       // for reporting what is genuinely new
  const known = has('--all') ? new Map() : new Map(previous);
  const incremental = has('--update') && previous.size > 0;
  console.log('mode     : ' + (incremental
    ? 'incremental (' + previous.size + ' known)'
    : 'full walk' + (previous.size ? ' (' + previous.size + ' known, comparing)' : '')));

  const { pages } = await walk(known, incremental ? STOP_AFTER : Infinity);

  // "New" means absent from the previous file, not merely seen during this run.
  const added = [...known.values()].filter(r => !previous.has(r.conceptId));
  const gone = [...previous.values()].filter(r => !known.has(r.conceptId));

  console.log('\npages fetched: ' + pages);
  console.log('new games    : ' + added.length);
  added.slice(0, 25).forEach(a => console.log('  + ' + a.name));
  if (added.length > 25) console.log('  … and ' + (added.length - 25) + ' more');
  if (gone.length) console.log('dropped      : ' + gone.length + ' (delisted, or pushed past the ' + HARD_CAP + ' cap)');

  const total = save(OUT, known);
  console.log('catalogue    : ' + total + ' games -> ' + OUT);
  if (!incremental && total >= HARD_CAP) {
    console.log('NOTE: hit the ' + HARD_CAP + ' cap — this is the first ' + HARD_CAP + ' of the category, not all of it.');
  }
})().catch(e => {
  console.error('failed: ' + e.message);
  if (/PersistedQueryNotFound/i.test(e.message)) {
    console.error('The persisted-query hash has changed. Re-capture it from the browse page');
    console.error('(F12 -> Network -> filter "categoryGridRetrieve") and pass it with --hash.');
  }
  process.exit(1);
});
