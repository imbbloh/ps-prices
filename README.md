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

## 4. Telegram bot (optional)

The bot runs inside the same Render service and shares `server.js` outright — the catalogue,
the resolver, the price extractor, the cross-region reconciliation — so a fix to prices is a fix
in both places and there is no second copy to drift.

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`, and copy the token it gives you.
2. Still in BotFather: `/setinline` → pick your bot → send a placeholder like `game title`.
   This is what turns on the live dropdown; without it inline typing does nothing.
3. In Render → your service → **Environment**, add `TELEGRAM_BOT_TOKEN` = the token, then
   redeploy. The log line `telegram: long polling` means it is live.

Without a token the bot simply does not start and the JSON API is unaffected.

**Using it**

| | |
|---|---|
| `@yourbot ghost of` | in **any** chat — Telegram shows a live list of matching titles as you type. This is the website's dropdown; it answers from the in-memory catalogue, so it is instant. |
| a title, sent to the bot | one match is priced straight away; several are offered as buttons |
| a concept ID or store URL | priced directly |
| `/cur USD` | changes the currency it converts into (default SGD) |

Results are the **top 5 regions**, cheapest first, two lines each:

```
🎮 Ghost of Yōtei
Cheapest first, converted to SGD

🏠 🇸🇬 Singapore  ·  S$69.50

1. 🇺🇦 Ukraine  ·  S$47.27
    UAH 1,649  ·  U̶A̶H̶ ̶2̶,̶1̶9̶9̶  ·  2 editions
2. 🇮🇳 India  ·  S$50.38
    ₹3,749  ·  ₹̶4̶,̶9̶9̶9̶  ·  2 editions
```

The **home price comes first**, worked out from the currency being converted into (SGD → SG,
EUR → DE). A list of cheap regions means nothing without knowing what the game costs at home,
and the home store is usually nowhere near the top five. It is the price alone — the list below
already shows what the cheapest region costs.

The converted price closes the first line, since that is the number being compared; the store's
own price sits underneath, struck through when on sale, and links to the page it came from. The
discount percentage is deliberately absent — the strikethrough already says the game is on sale,
and it was a third number on a line that had two.

The edition count is **not** flushed right, and cannot be. Telegram has no text alignment, so a
fixed column means rendering the line as a code span — and Telegram allows no nesting inside one,
which costs both the link and the strikethrough. The strikethrough is worth more than the
alignment: it says "on sale" at a glance, where a right-hand column only looks tidier. Countries are named rather than coded. Local prices print the disambiguated
symbol — `NT$`, `UAH` — because twenty storefronts put several different dollars next to each
other, while the converted column uses a compact unambiguous form (`S$`, `US$`) since the header
already names the currency. A **Show all 20 regions** button expands the list, replaying the
finished lookup from memory rather than pricing again. Regions the store redirected to a foreign
currency stay out of the ranking, exactly as on the website.

Because twenty storefronts take ten to forty seconds — and a cold Render dyno longer still —
every lookup posts a `Looking up…` placeholder immediately and edits that same message when the
prices land, rather than leaving the chat silent.

**Webhook instead of polling.** Long polling is the default: it needs no public URL, and the
open request keeps the free dyno awake, which also spares the next searcher a cold start. To use
a webhook instead, set `TELEGRAM_WEBHOOK_SECRET` to a random string and point Telegram at
`https://<your-service>/tg/<that secret>`:

```
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<service>/tg/<secret>"
```

The secret is in the path so an unsolicited POST cannot feed the bot updates.

---

## Customising

- **Diagnosing missing regions:** `node debug.js "<title | store URL | conceptId>" [REGION...]`
  prints, per region, which tier was tried and exactly how it failed — a page that never
  loaded, a page that loaded without a price, or a region search with no product links.
- **Trials and subscription upsells are not editions.** Not everything priced on a game's own
  page is a way to buy that game. The Ghost of Tsushima DIRECTOR'S CUT page carries five entries
  the store classifies as games — the PS4 edition at $59.99, the PS5 edition at $69.99, two
  $19.99 trials and an "Included with PS Plus" upsell — and the trials, being cheapest, won.
  No classification separates them: a trial is labelled `FULL_GAME` exactly like the real thing.
  The offer does. A real edition is an outright purchase (`upSellService":"NONE"`, no
  `displayUpsellText`); a trial carries `displayUpsellText":"Trial"`, and a subscription entry
  carries `upSellService":"PS_PLUS"` and prices itself `"Included"`. Only presence is tested,
  never the wording, so a storefront that localizes the label ("Essai", "体験版") behaves the
  same. The filter only ever narrows — a page whose every entry looks like an upsell keeps them
  all rather than reporting no price.

  The Japanese page for the same game needed a second rule. Its trial does announce itself
  (`試用版`, caught by the presence test above), but the page also ends with two entries 90,000
  characters after the real ones: classification `OTHER`, a bare price, and none of
  `discountedPrice`, `upSellService` or upsell text, where every genuine entry carries all three.
  That stray `¥2,200` outsold the `¥7,590` edition. **A priced entry with no offer machinery is
  not an offer**, so `discountedPrice` is now required. That is structural rather than another
  vocabulary check — `OTHER` is too vague to blanket-exclude, and the classification list has
  surprised us four times already.

- **Resolving the right concept.** Taking the first concept ID in a page is wrong, and quietly
  so: a search page leads with a promoted tile and a product page carries a recommendation strip,
  so the first `/concept/` link belongs to some other game. A lookup for Ghost of Tsushima
  resolved that way to `10015299` — *Tyrion Cuthbert: Attorney of the Arcane* — and then priced
  that game in every region resolved concept-first. Two changes:

  - **Rank by frequency, not position.** The page's own concept is referenced many times over
    (canonical URL, embedded state, telemetry); a neighbour's appears once or twice.
  - **Verify by name.** The winner's concept page has to name the same game as was searched for,
    compared by `keyName` with containment either way, so `Ghost of Tsushima` and
    `Ghost of Tsushima DIRECTOR'S CUT` match but Tyrion Cuthbert does not. If nothing verifies,
    the lookup returns *no* concept rather than a confident wrong one, and the product tier still
    prices every region carrying that SKU.

  The catalogue also stops missing these. It holds concepts, so it lists `Ghost of Tsushima`
  while the store's own title is `Ghost of Tsushima DIRECTOR'S CUT`; an exact-key miss used to
  fall through to the live search that mis-resolved. A catalogue name that is a prefix of what
  was typed is the same game with an edition suffix, so the longest such name wins. Only that
  direction is safe — typing more than the catalogue knows narrows the answer, whereas typing
  less (`Horizon`) would be a guess between games.

- **The regions check each other.** Every rule above is structural, but a storefront nobody has
  looked at can still publish a shape nobody has seen. So after all twenty regions resolve, they
  are reconciled against each other — twenty independent reads of the same game.

  Absolute prices cannot be compared (India and Turkey are legitimately a fraction of the US, and
  converting through FX only moves the problem). What compares is the shape of each region's own
  edition list: **the ratio of the chosen price to the top edition on the same page**. Both terms
  come from one storefront in one currency, so the ratio is free of FX and of regional pricing,
  and every region should agree on it — a standard edition is ~0.86 of the deluxe everywhere. A
  region that picked up something that is not an edition lands far below that: the Japanese
  ¥2,200 sat at 0.25 while every other region agreed on ~0.86.

  Such a region is re-picked from its own published editions, and the response reports
  `adjusted: true` for it and `priceAdjusted` overall. Two guards stop it inventing answers: a
  **discounted** pick is never overridden (a region-only sale is a real reason to sit low, and the
  strikethrough says so), and a replacement must already exist in that region's edition list — it
  only ever re-picks among prices the page actually published. Fewer than four regions with
  editions means no consensus and no adjustment.

- **Finding new store classifications:** `node catalog.js --classes` samples concept pages from
  `catalog.json` and reports any `storeDisplayClassification` the extractor does not know. The
  matching **fails open** — an unrecognised label counts as a game, and being cheap it wins, which
  is how `ITEM` and `ADD_ON_PACK` each produced a wrong price. The weekly workflow runs this so a
  new variant surfaces as a report rather than as a wrong price. A price sitting far below the
  page's other entries is also flagged `suspect` and marked ⚠ in the table, since that is what an
  add-on looks like — the number is still shown, because it may be a genuine deep discount.
- **Diagnosing a wrong price:** `node debug.js --prices "<title | store URL>" [REGION...]`
  lists every priced entry on the page with its classification, and marks which one was chosen.
  It says explicitly when a page carries no classification, which is the case where an add-on
  or the wrong edition can win.
- **Diagnosing language detection:** `node debug.js --langs "<title | store URL>" [REGION...]`
  shows what each store page says about languages *in its own words* — the label matched, the
  list read, and the resulting flag. Each storefront localizes both: Brazil says `Voz` /
  `Idiomas da tela` and lists `Inglês`. When a region reports unknown, the tool dumps the
  page's own language-ish lines so the real wording can be added to `SCREEN_LABELS` /
  `VOICE_LABELS` in `server.js`.
- **Game catalogue:** `catalog.json` lists the US "All games" category as
  `{conceptId, name, releaseDate, firstSeen}`, collected by `catalog.js` through the same GraphQL
  call the store's browse page makes. `.github/workflows/catalog.yml` runs it daily and commits
  only when something changed, so the history reads as a log of new releases.

  ```
  node catalog.js          # facets and totals, writes nothing
  node catalog.js --new    # released in the last 30 days (~2 requests)
  node catalog.js --all    # the complete catalogue, price band by price band
  node catalog.js --csv    # rebuild catalog.csv from catalog.json, no network
  ```

  **`catalog.csv` is the same data as a spreadsheet**, written automatically whenever the
  catalogue is saved and committed alongside the JSON, so it is always current and can be
  downloaded straight from the repo:

  ```
  https://raw.githubusercontent.com/imbbloh/ps-prices/main/catalog.csv
  ```

  Columns are `conceptId, name, releaseDate, firstSeen, url` — the last a ready-made link to the
  game's US store page. Every field is quoted RFC 4180 style, since titles carry commas and
  quotes (`"Buy The Game, I Have a Gun" -Sheesh-Man`), and the file leads with a UTF-8 BOM so
  Excel renders `™` and `「」` rather than mojibake. The JSON stays the source of truth: the app
  reads it, and `--csv` re-derives the CSV from it at any time.

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

  **Release dates** are not on the grid query, and no GraphQL operation a concept page issues
  carries one either — all seven were replayed and none returned a date, so there is nothing to
  batch. Every concept page does carry one as an ISO timestamp
  (`"releaseDate":"2025-10-02T04:00:00Z"`), so `node catalog.js --dates` fills them in, one page
  per game. What makes that cheap is not reading the page: the field sits near the top of the
  server-rendered payload, so the fetch streams the body and hangs up the moment it matches —
  tens of kB instead of the ~1.2 MB document, roughly a 20× cut in bytes. There is no sleep
  between fetches either (that 400 ms is politeness towards the GraphQL API, not the CDN), the
  pool defaults to 8, and progress is checkpointed every 500 pages so a run cut short keeps what
  it found. `--date-delay` puts a pause back if the store ever pushes back. Only rows without a
  date are touched, so it resumes after an interruption and `--limit` chunks it; the workflow
  runs 8,000 a day. Being ISO, the storefront's date format never enters into it.
  `firstSeen` still records when this tool first saw a game, which is a different thing from when
  the game came out. Prices are
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
- **Editions and add-ons.** A concept page lists the game's editions *and its add-ons*, and an
  add-on is always cheaper — so picking the cheapest entry outright returns a piece of DLC.
  Taken from a real page (MLB The Show 26): the game and its editions come first, then an add-on
  carousel of Stubs packs. Labels **cannot** be matched to prices by proximity — `FULL_GAME` sat
  14,000 characters from its price and `PREMIUM_EDITION` came *after* its price — while each
  carousel entry's label sits ~250 characters before its own. What is reliable is position:
  every game price appears before the first add-on label and every add-on price after it. So the
  cut is a **character offset**, needing no per-entry attribution, and it also discards add-on
  labels not yet in the exclusion list — which matters, since that list only grows by being
  surprised (`ITEM` was the surprise). If a page carries no classification anywhere, only its
  first entry is used, since editions and add-ons cannot then be told apart. Among the
  remaining game entries the table shows the one that is **cheapest to actually pay**, with a grey
  line beneath giving the spread (`3 editions, up to $99.99`) and the full list, each with its
  own strikethrough, on hover. A range rather than a list of prices: the other editions cannot
  be compared across regions anyway, since which edition a given price belongs to is unknown. Editions are returned per region as an
  `editions` array, cheapest first. They are **not named**: a label can sit 14,000 characters
  from its price, so calling one of them "Deluxe" would be a guess — the prices are reliable,
  the mapping to edition names is not. Selection is — comparing effective prices, not list prices, so
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
