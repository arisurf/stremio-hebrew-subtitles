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
3. On the new repo page, click **uploading an existing file**, drag in all the files from this folder (`server.js`, `package.json`, `render.yaml`, `.gitignore`, `README.md`), and click **Commit changes**. No git commands needed.

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

1. Play anything (e.g., Solo Leveling), open the **subtitles menu**, and pick **Hebrew**.
2. **First time per episode:** you'll briefly see a message that translation is in progress. Wait ~1 minute, then re-open the subtitles menu and pick Hebrew again — the translated subtitles will load. After that, the episode is cached and loads instantly.
3. Note: on Render's free tier the server sleeps after 15 idle minutes, so the *first* request of a viewing session can take ~30 extra seconds to wake it up.

## Sharing with friends

Just send them your add-on page link (`https://YOUR-APP.onrender.com`). They click install — that's it. They'll use *your* Gemini key, so share only with people you trust; the free tier's 250 requests/day is roughly 30–40 episodes/day across everyone.

## Troubleshooting

- **"Translation error" shown as subtitle** — usually means no English subtitles exist for that exact video, or Gemini's daily free quota ran out (it auto-falls back to Google Translate, so this is rare). Try again in a minute.
- **Subtitles out of sync** — timing comes from the original English file; pick a different subtitle variant in Stremio, or use Stremio's subtitle delay adjustment.
- **Better/worse model** — set the `GEMINI_MODEL` env var on Render (default: `gemini-2.5-flash`).

## How it works

Stremio asks the add-on for subtitles → the add-on looks up English subtitles via Stremio's public OpenSubtitles service → downloads the SRT → translates the text in batches with Gemini (timings untouched) → caches and serves the Hebrew SRT.
