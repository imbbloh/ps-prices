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
| `/prices?title=...` | All-region prices as JSON |
| `/health` | Cheap liveness ping — the frontend calls this on page load to start waking the free-tier host early |

> Render's free tier sleeps after inactivity, so the **first** request after idle can take
> ~30–50 s to wake. Subsequent lookups are fast (and cached for 10 min). The frontend shows a
> spinner with a "waking up the server…" note while this happens.

### How a region gets priced (3-tier fallback)

Product IDs are frequently region-specific — *Beast of Reincarnation* is `…PPSA29343…` in the
US but `…PPSA29344…` in India — so a single ID resolves only a handful of stores. Each region
is therefore tried in three steps, stopping at the first page that actually carries a price:

1. **`/{locale}/product/{productId}`** — the ID found via the global (en-us) search.
2. **`/{locale}/concept/{conceptId}`** — concept IDs are global and often survive region-locked SKUs.
3. **`/{locale}/search/{title}`** — search that region's own store and try its local SKU.

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

- **Regions:** edit `LOCALES` (and `EXPECT`) in `server.js`.
- **Display currency:** the dropdown in `index.html` (add options freely; any ISO code that
  open.er-api.com supports works).
- **Cache time:** `TTL` in `server.js`.

## Notes

- Buying a cheaper region's price requires a PSN account registered to that region plus that
  region's gift-card credit — card payments are geo-checked.
- A `⚠` next to a region means its store lists the game in a currency other than the region's
  usual one (e.g. Mexico sometimes prices in USD).
- This project reads publicly displayed store prices for personal comparison. It is not
  affiliated with Sony/PlayStation.
