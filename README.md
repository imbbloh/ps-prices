# PlayStation Store — Regional Price Finder

Type a game title → see its PlayStation Store price in **every region**, converted to one
currency (SGD by default), cheapest first.

- **Frontend** (`index.html`) — a static page, host it free on **GitHub Pages**.
- **Backend** (`server.js`) — a tiny Node service, host it free on **Render**. It reads the
  PlayStation Store server-side (browsers can't, due to CORS) and returns clean JSON.

```
Browser ──► GitHub Pages (index.html) ──► Render (server.js) ──► store.playstation.com
                     │
                     └─► open.er-api.com  (live FX, called directly)
```

---

## 1. Deploy the backend on Render (~3 min)

1. Push this folder to a GitHub repo.
2. Go to <https://render.com> → **New → Web Service** → connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build Command:** *(leave blank — no dependencies)*
   - **Start Command:** `node server.js`
   - **Instance type:** Free
4. Deploy. You'll get a URL like `https://ps-sgd.onrender.com`.
5. Test it: open `https://YOUR-SERVICE.onrender.com/prices?title=007%20First%20Light` —
   you should see JSON with a `results` array.

Endpoints:

| Path | Purpose |
| --- | --- |
| `/prices?title=...` | All-region prices as JSON. Each result carries a `url` pointing at the exact store page its price came from |
| `/health` | Cheap liveness ping — the frontend calls this on page load to start waking the free-tier host early |

> Render's free tier sleeps after inactivity, so the **first** request after idle can take
> ~30–50 s to wake. Subsequent lookups are fast (and cached for 10 min). The frontend shows a
> spinner with a "waking up the server…" note while this happens.

### How a region gets priced (3-tier fallback)

Product IDs are frequently region-specific — *Beast of Reincarnation* is `…PPSA29343…` in the
US but `…PPSA29344…` in India — so a single product ID resolves only a handful of stores
(typically just the Americas). **Concept IDs are global**, so the same ID works in every
storefront; that tier goes first. Each region is tried in three steps, stopping at the first
page that actually carries a price:

1. **`/{locale}/concept/{conceptId}`** — global, so one ID covers every region. Most reliable.
2. **`/{locale}/product/{productId}`** — the ID found via the global (en-us) search; often region-specific.
3. **`/{locale}/search/{title}`** — search that region's own store and try its local SKU.

### Skipping search with a store URL

A title search has to guess which store entry you meant, and a wrong guess (a DLC, a bundle, a
regional re-listing) costs you most of your regions. `?title=` therefore also accepts a pasted
store URL or a bare concept ID, which bypasses search entirely:

```
/prices?title=https://store.playstation.com/en-in/concept/10014719
/prices?title=10014719
/prices?title=https://store.playstation.com/en-us/product/UB1599-PPSA29343_00-BEAST
```

Any locale works in a pasted URL — only the ID is read from it. The same strings work in the
web UI's search box. This is the most reliable way to price a title that search handles badly.

Requests run through a concurrency pool (6 at a time) so the store doesn't rate-limit us, each
with a 12 s timeout and one retry on transient failures (429/5xx/network). Every result reports
which tier resolved it in its `via` field (`product` / `concept` / `search` / `null`).

## 2. Publish the frontend on GitHub Pages (~2 min)

1. In the same repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick `main` and `/ (root)`, save.
2. Your site appears at `https://YOUR-USER.github.io/YOUR-REPO/`.

## 3. Connect them

1. Open your GitHub Pages site.
2. The Backend URL is pre-filled with `https://ps-prices-api.onrender.com`. To point at a
   different service, click **▸ Backend settings** and paste its URL (saved in your browser).
   Change `DEFAULT_BACKEND` at the top of the `index.html` script to alter the default.
3. Type a title → **Find prices**.

The page also caches FX rates in `localStorage` for 6 h, so if `open.er-api.com` is down it
falls back to the last known rates (flagged in the status line) — and if it has no rates at
all it still shows every store's local price rather than an empty table.

---

## Customising

- **Diagnosing missing regions:** `node debug.js "<title | store URL | conceptId>" [REGION...]`
  prints, per region, which tier was tried and exactly how it failed — a page that never
  loaded, a page that loaded without a price, or a region search with no product links.
- **Diagnosing language detection:** `node debug.js --langs "<title | store URL>" [REGION...]`
  shows what each store page says about languages *in its own words* — the label matched, the
  list read, and the resulting flag. Each storefront localizes both: Brazil says `Voz` /
  `Idiomas da tela` and lists `Inglês`. When a region reports unknown, the tool dumps the
  page's own language-ish lines so the real wording can be added to `SCREEN_LABELS` /
  `VOICE_LABELS` in `server.js`.
- **Game catalogue:** `catalog.json` lists the US "All games" category as
  `{conceptId, name, firstSeen}`, collected by `catalog.js` through the same GraphQL call the
  store's browse page makes. `.github/workflows/catalog.yml` runs it daily and commits only when
  something changed, so the history reads as a log of new releases.

  ```
  node catalog.js          # facets and totals, writes nothing
  node catalog.js --new    # released in the last 30 days (~2 requests)
  node catalog.js --all    # the complete catalogue, price band by price band
  ```

  Filters are `"<facet>:<value>"` strings, verified against the counts the API reports for its
  own facets. Two findings shape the design:

  - **The category reports 12,908 games but refuses offsets past 10,000.** A single unfiltered
    walk therefore silently returns only the first 10,000. `--all` walks one price band at a
    time (the largest holds ~4,000) and unions them, reaching the whole catalogue. Bands come
    from the live facet list, so new ones are picked up automatically.
  - **`conceptReleaseDate:last_thirty_days` is a real release-date filter** (124 games at the
    time of writing), so `--new` is a couple of requests rather than a full walk. The weekly
    `--all` still matters: it catches back-catalogue titles added to the store long after their
    release, which a last-30-days filter cannot see.

  No release date is exposed on this query and a persisted query's fields cannot be changed by
  the caller, so `firstSeen` records when this tool first saw a game instead. Prices are
  deliberately not stored: they change constantly and would rewrite every row daily, burying the
  one useful signal in the diff.

  `--all` is **authoritative**: the file becomes exactly what the storefront listed, so delisted
  titles drop out and the log names them. `--new` only ever sees a 30-day slice, so it adds to
  the file rather than replacing it. `firstSeen` is preserved across rebuilds for games that are
  still listed.

  **The API geolocates by caller IP.** A GitHub runner in the UK returned the GB storefront —
  price bands in pounds and a different game count — while the same call from a browser on the
  en-us site returned the US one. `catalog.js` therefore pins the storefront with
  `x-psn-store-locale-override` (`--locale`, default `en-US`) and prints the currency symbol it
  saw, so a wrong storefront is obvious in the log rather than silently mislabelled.

  The persisted-query `sha256Hash` changes when the store redeploys its front end; on
  `PersistedQueryNotFound`, re-capture it from the browse page (F12 → Network → filter
  `categoryGridRetrieve`) and pass `--hash`. Apollo also rejects the call as possible CSRF
  unless `apollo-require-preflight` is sent. `PS_GQL` overrides the endpoint for testing.

- **Instant search.** With `catalog.json` present, the page loads it once (cached in
  `localStorage` for 24 h) and suggests titles as you type — no backend call, so no cold-start
  wait. Picking a suggestion sends its **concept ID**, and the backend also loads `catalog.json`
  to resolve typed titles exactly, skipping the store-search step that used to guess wrong.
  `keyName()` in `server.js` and `index.html` must stay identical, or a picked suggestion would
  resolve differently server-side. Without the file, both sides fall back to live search.

- **Regions:** edit `LOCALES` (and `EXPECT`) in `server.js`.
- **Flags:** country flags are images from `flagcdn.com` (the page's only third-party asset).
  Each carries its region code as `alt`, so if the CDN is blocked the code shows instead of a
  broken image. Change `FLAG_SRC` in `index.html` to use another source or drop them.
- **Display currency:** the dropdown in `index.html` (add options freely; any ISO code that
  open.er-api.com supports works).
- **Cache time:** `TTL` in `server.js`.

## Notes

- Buying a cheaper region's price requires a PSN account registered to that region plus that
  region's gift-card credit — card payments are geo-checked.
- **Editions.** A concept page lists every edition, so the extractor reads them all and takes
  the one that is **cheapest to actually pay** — comparing effective prices, not list prices, so
  a Deluxe edition on deep discount beats a full-price Standard and is the price shown. The
  strikethrough is always that same edition's own list price. Otherwise: comparing a Deluxe price in one region against a Standard price in
  another is not a comparison. Zero-priced entries are skipped when anything paid exists, so a
  free demo listed beside the game does not win — unless the game really is free. Each result
  reports `editions`, the number of priced entries the page carried. The title comes from
  `catalog.json` when the lookup resolved through it, since the page's own name may be an
  edition's.
- **Sale prices.** When a title is discounted, the price shown and ranked is what a shopper
  pays today; the pre-discount figure comes back as `original` with a `discount` label and is
  struck through in the table. The store's `discountedPrice` is preferred over `basePrice`,
  which is the pre-discount value by definition.
- **English support.** Each result reports `english` (`true` / `false` / `null` = the page said
  nothing) plus the `screenLanguages` and `voiceLanguages` lists. Screen languages decide it —
  Japanese voice with English subtitles is playable — falling back to voice only when no screen
  list is published. The table shows a green **EN** or an amber **NO EN** badge, and nothing at
  all when unknown, so a parse failure never reads as "no English". Concept pages often omit the
  language spec, so a concept-tier win makes one extra product-page read to fill it in.
  Labels and language names are matched per storefront language (`Voz`/`Inglês`,
  `画面表示言語`/`英語`, `화면 언어`/`영어`, …), with an accent-insensitive comparison and a
  generic fallback for wording not yet in the table.
- **Currencies that aren't the region's own.** The PS Store Mexico prices many titles in USD.
  That is a real price a Mexican account pays, so those rows are **ranked normally** and carry a
  grey currency badge. Add more exceptions in `ALSO_OK` in `server.js`:

  ```js
  const ALSO_OK = { MX: ['USD'] };
  ```

  A currency that is in neither `EXPECT[region]` nor `ALSO_OK[region]` is treated as a bad read
  (usually the store served a fallback price), flagged `redirected`, and listed below the
  ranking. Each result carries both flags: `redirected` (excluded) and `foreign` (ranked, but
  not the local currency).
- This project reads publicly displayed store prices for personal comparison. It is not
  affiliated with Sony/PlayStation.
