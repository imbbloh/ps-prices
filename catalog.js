// Collect the US store's game catalogue via the same GraphQL call the store's
// own browse page makes. Needs network access to web.np.playstation.com.
//
//   node catalog.js                       # one page: totals and a sample
//   node catalog.js --all                 # walk the category (~100 requests)
//   node catalog.js --all --out us.json   # ...and save {conceptId, name, price}
//
// Discovered by watching the browse page's own network calls:
//   operationName=categoryGridRetrieve
//   variables={id:<category>, pageArgs:{size,offset}, ...}
//   extensions={persistedQuery:{version:1, sha256Hash:<hash>}}
//
// Two things to know before relying on this:
//
//   1. THE API CAPS AT 10,000. offset 10000 returns "Incorrect offset/limit",
//      and pageInfo.totalCount reports exactly 10000 — that is the cap, not the
//      catalogue size. The real total may be larger, so treat a result of
//      exactly 10000 as "the first 10,000", never as "everything". To get past
//      it, partition with filterBy/sortBy into slices under 10k and merge.
//
//   2. THE HASH IS A MOVING TARGET. sha256Hash identifies a persisted query and
//      changes when the store redeploys its front end. When this starts
//      returning PersistedQueryNotFound, re-capture it: open the browse page,
//      F12 -> Network, filter "categoryGridRetrieve", copy sha256Hash from the
//      request URL, and pass it with --hash.

const fs = require('fs');

const GQL = 'https://web.np.playstation.com/api/graphql/v1//op';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HARD_CAP = 10000;                 // server refuses offsets at or beyond this

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const CATEGORY = val('--category', '28c9c2b2-cecc-415c-9a08-482a605cb104');  // "All games" (PS5WM_GMA_ALL_GAMES)
const HASH = val('--hash', '4e41660b6732f35c99fc5541926b7502a09557924e8c2cfebd1beb1a5c8c8f81');
const SIZE = Math.min(parseInt(val('--size', '100'), 10), 100);
const DELAY = parseInt(val('--delay', '400'), 10);
const OUT = val('--out', null);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function grid(offset, size = SIZE) {
  const variables = { id: CATEGORY, pageArgs: { size, offset }, sortBy: null, filterBy: [], facetOptions: [], maxResults: null };
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

// Keep the fields worth having; the media arrays are most of the payload.
const slim = c => ({
  conceptId: c.id,
  name: c.name,
  price: c.price && (c.price.discountedPrice || c.price.basePrice) || null,
  basePrice: c.price && c.price.basePrice || null
});

(async () => {
  console.log('category : ' + CATEGORY);
  const first = await grid(0);
  const info = first.pageInfo || {};
  console.log('name     : ' + first.localizedName + '  (' + first.reportingName + ')');
  console.log('total    : ' + info.totalCount + (info.totalCount === HARD_CAP ? '   <-- the API cap, likely not the real total' : ''));
  console.log('per page : ' + (first.concepts || []).length);
  console.log('sample   : ' + (first.concepts || []).slice(0, 3).map(c => c.name).join(' | '));

  if (!has('--all')) { console.log('\nRe-run with --all to walk the category, --out file.json to save.'); return; }

  const seen = new Map();
  (first.concepts || []).forEach(c => seen.set(c.id, slim(c)));

  for (let offset = SIZE; offset < Math.min(info.totalCount || 0, HARD_CAP); offset += SIZE) {
    await sleep(DELAY);
    let g;
    try {
      g = await grid(offset);
    } catch (e) {
      console.log('  offset ' + offset + ': ' + e.message + ' — stopping');
      break;
    }
    (g.concepts || []).forEach(c => seen.set(c.id, slim(c)));
    if (offset % 1000 === 0) console.log('  offset ' + offset + ' … ' + seen.size + ' unique');
    if (g.pageInfo && g.pageInfo.isLast) break;
  }

  console.log('\ncollected: ' + seen.size + ' concepts');
  if (seen.size >= HARD_CAP) {
    console.log('NOTE: hit the ' + HARD_CAP + ' cap. This is the first ' + HARD_CAP +
                ' of the category, not necessarily all of it.');
  }
  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify([...seen.values()], null, 2));
    console.log('wrote ' + OUT);
  } else {
    console.log('(pass --out file.json to save)');
  }
})().catch(e => {
  console.error('failed: ' + e.message);
  if (/PersistedQueryNotFound/i.test(e.message)) {
    console.error('The persisted-query hash has changed. Re-capture it from the browse page');
    console.error('(F12 -> Network -> filter "categoryGridRetrieve") and pass it with --hash.');
  }
  process.exit(1);
});
