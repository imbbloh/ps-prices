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

> Render's free tier sleeps after inactivity, so the **first** request after idle can take
> ~30–50 s to wake. Subsequent lookups are fast (and cached for 10 min).

## 2. Publish the frontend on GitHub Pages (~2 min)

1. In the same repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick `main` and `/ (root)`, save.
2. Your site appears at `https://YOUR-USER.github.io/YOUR-REPO/`.

## 3. Connect them

1. Open your GitHub Pages site.
2. Click **▸ Backend settings**, paste your Render URL (e.g. `https://ps-sgd.onrender.com`), done.
   (It's saved in your browser.)
3. Type a title → **Find prices**.

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
