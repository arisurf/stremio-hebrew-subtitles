# 🇮🇱 Hebrew AI Subtitles — Stremio Add-on

A Stremio add-on that fetches **English subtitles** for any movie or series episode, translates them to **Hebrew with AI (Google Gemini)**, and serves them back to Stremio — with **every timestamp preserved exactly**. Works on any device logged into your Stremio account, and shareable with friends via a simple link.

Everything runs on **free tiers**: Render.com free hosting + Gemini API free tier. If Gemini is ever unavailable or rate-limited, the add-on automatically falls back to free Google Translate so you're never left without subtitles.

---

## Setup (one time, ~15 minutes)

### Step 1 — Get a free Gemini API key

1. Go to **https://aistudio.google.com** and sign in with your Google account.
2. Click **Get API key** → **Create API key**.
3. Copy the key somewhere safe. No credit card needed — the free tier (250 requests/day) covers many episodes per day.

### Step 2 — Put the code on GitHub

1. Create a free account at **https://github.com** (skip if you have one).
2. Click **+** (top right) → **New repository**. Name it `stremio-hebrew-subtitles`, keep it **Public** (or Private — both work), click **Create repository**.
3. On the new repo page, click **uploading an existing file**, drag in all the files from this folder (`server.js`, `sync.js`, `package.json`, `render.yaml`, `.gitignore`, `README.md`), and click **Commit changes**. No git commands needed.

### Step 3 — Deploy on Render (free)

1. Create a free account at **https://render.com** — sign up **with GitHub** so it can see your repo.
2. Click **New +** → **Web Service** → select your `stremio-hebrew-subtitles` repo.
3. Render auto-detects Node. Confirm:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Instance type:** `Free`
4. Under **Environment Variables**, add:
   - `GEMINI_API_KEY` = the key from Step 1
5. Click **Create Web Service** and wait for the first deploy (~2 minutes).
6. Copy your service URL, e.g. `https://hebrew-ai-subtitles.onrender.com`.

### Step 4 — Install in Stremio

1. Open your Render URL in a browser — you'll see the add-on's install page.
2. Click **התקנה ב-Stremio**, or copy the manifest URL (`https://YOUR-APP.onrender.com/manifest.json`) and paste it into Stremio's add-on search box (puzzle-piece icon → paste URL → **Install**).
3. Because add-ons are tied to your **Stremio account**, it's now available on your smart TV, phone, and every other device you're logged into. Nothing to install on the TV itself.

---

## Using it

1. Play anything (e.g., Solo Leveling), open the **subtitles menu**, pick **עברית**, and choose the option marked **⭐ מומלץ** (recommended).
2. Each option's name says what it is and whether it's ready:
   - **מסונכרן לקובץ שלך** — verified against your exact video file (only shown when actually verified).
   - **✓ מוכן** — already translated, loads instantly. **⏳ …שנ׳** — being translated; just select it and it appears on its own when ready.
   - **חלופה 2/3 · תזמון שונה** — alternatives with a genuinely different timing, in case the recommended one doesn't fit your file.
3. Translation of the recommended option starts as soon as you press play, and while you watch an episode the **next episode is translated in the background**, so it's usually ready instantly.
4. Older Stremio versions don't show option names; there the first option is always the recommended one, and the first seconds of the video show which option you picked.

## Sharing with friends

Just send them your add-on page link (`https://YOUR-APP.onrender.com`). They click install — that's it. They'll use *your* Gemini key, so share only with people you trust; the free tier's 250 requests/day is roughly 30–40 episodes/day across everyone.

## Troubleshooting

- **"Translation error" shown as subtitle** — usually means no English subtitles exist for that exact video, or Gemini's daily free quota ran out (it auto-falls back to Google Translate, so this is rare). Try again in a minute.
- **Subtitles out of sync** — pick a **חלופה** (alternative) option: each one uses a different timing. If none fits, use Stremio's subtitle delay adjustment. To see why an option was chosen, open `https://YOUR-APP.onrender.com/debug/plan/series/<imdb id>:<season>:<episode>.json`.
- **Better/worse model** — set the `GEMINI_MODEL` env var on Render (default: `gemini-2.5-flash`).

## How it works

Stremio asks the add-on for subtitles (including a fingerprint of your video file) → the add-on looks up English subtitles via Stremio's public OpenSubtitles service → picks the one whose timing matches your file (`sync.js`) → translates the text in batches with Gemini → caches and serves the Hebrew SRT.

Picking the right timing:
- If OpenSubtitles knows a subtitle (in **any** language) made for your exact file, its timing is used as a reference clock: every English candidate is measured against it, the best match wins, and a fixed shift, frame-rate difference, or different cut is corrected automatically.
- Otherwise, for series, sources from the same release family that were verified on another episode win; failing that, the timing shared by the most independent releases wins. Dub transcripts, hearing-impaired versions, fragments, and single CD parts are avoided.
- Every cached translation is checked against its English source before it's served, so a mismatched file is re-translated instead of shown.
