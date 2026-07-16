# The Compound Ledger — Money Calculators & Spending Tracker

Two pages, no build step, no backend:
- **`index.html`** — 15 calculators (FD, RD, SIP, Lumpsum, SWP, CAGR, Compound Interest, Loan Payoff, Credit Card Payoff, Budget, Sukanya Samriddhi Yojana, Income Tax, PPF, EPF, EMI).
- **`tracker.html`** + **`tracker.js`** — a private spending tracker with a full net worth & investment ledger, plus an optional Google Drive backup. Data is saved in the browser's local storage on that device by default — nothing is sent anywhere unless you explicitly connect Google Drive.

Supporting files — upload all of these too, same folder structure:
- `manifest.json`, `sw.js` (service worker), `icon-192.png`, `icon-512.png`, `chart.min.js` (self-hosted chart library, used by both pages instead of a CDN)
- `tickers.json` — tickers for the auto price-refresh feature (edit this with your own holdings)
- `.github/workflows/update-prices.yml`, `scripts/fetch_prices.py`, `scripts/requirements.txt` — the GitHub Action that fetches those prices on a schedule (see "Auto price refresh" below)

## Deploy to GitHub Pages (2 minutes)

1. Create a new repository on GitHub (e.g. `money-calculators`).
2. Upload **all the files above** to the repo, **keeping the folder structure** — `.github/workflows/update-prices.yml` and `scripts/fetch_prices.py` need to stay in those subfolders, not the root. GitHub's web upload preserves folders if you drag a whole folder in, or use git (below) which handles this automatically.
3. Go to **Settings → Pages** in the repo.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Pick the `main` branch and `/ (root)` folder, then **Save**.
6. Wait a minute, then your site will be live at:
   `https://<your-username>.github.io/<repo-name>/`
   The tracker will be at the same address plus `/tracker.html`.

## Using git instead (recommended, since it preserves the folder structure automatically)

```bash
git init
git add .
git commit -m "Add money calculators and spending tracker"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

Then follow steps 3–6 above.

## Using the tracker on mobile

Open `tracker.html` on your phone, then:
- **iPhone (Safari):** tap the Share icon → **Add to Home Screen**.
- **Android (Chrome):** tap the **⋮** menu → **Add to Home screen** / **Install app**.

It'll then open full-screen like a normal app, and — once you've loaded it while online at least once — it keeps working even with no signal, since a small service worker (`sw.js`) caches the page for offline use.

## Auto price refresh for holdings (US stocks, Indian stocks, crypto)

A scheduled GitHub Action fetches current prices and publishes them into your repo as `prices.json`, which the tracker reads directly — no API key to manage, no CORS problems, since the fetch happens on GitHub's servers rather than in your browser.

**One required setting before this will work:** GitHub Actions defaults to read-only permissions on newer repos, which would block the workflow from committing `prices.json` back. Go to **Settings → Actions → General**, scroll to **Workflow permissions**, select **Read and write permissions**, click **Save**. Without this, the workflow will run but fail on the final commit/push step.

**Files involved:**
- `tickers.json` — the list of tickers you want tracked. Edit this yourself when you add a new holding.
- `.github/workflows/update-prices.yml` — runs hourly by default (change the `cron` line to adjust; there's a comment showing examples).
- `scripts/fetch_prices.py` + `scripts/requirements.txt` — the actual fetch logic (Python, using the `yfinance` library).
- `prices.json` — generated automatically; you don't edit this.

**Ticker format:**
| Market | Format | Example |
|---|---|---|
| US stocks | plain symbol | `AAPL` |
| Indian NSE | symbol + `.NS` | `RELIANCE.NS` |
| Indian BSE | scrip code + `.BO` | `500325.BO` |
| Crypto | symbol + `-USD` | `BTC-USD` |

**To add a new ticker:**
1. Edit `tickers.json` in your repo, add the ticker, commit.
2. Either wait for the next scheduled run, or go to your repo's **Actions** tab → "Update stock/crypto prices" → **Run workflow** for an immediate update.
3. On the matching holding in the tracker, enter the *exact same* text in its "Ticker / Coin ID" field.
4. Click **Refresh all prices** in the tracker to pull the newly published values in.

**Note on GitHub Actions minutes:** this uses GitHub's free tier of Actions minutes, which is generous (2,000 minutes/month on free personal accounts) and this job runs in well under a minute each time, so an hourly schedule is not a concern.

Savings, FD, RD, EPF, PPF, Mutual Fund, and Gold have no reliable free auto-price source, so keep using **✎ Update price** on those holdings.

## Backing up to Google Drive (optional)

This is opt-in and off by default — nothing is contacted until you set it up. It backs up to a private file in **your own** Drive that only this app can read (it can't see or touch anything else in your Drive).

One-time setup (in the tracker's "Your data" section, under "Back up to Google Drive"):
1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) and create a project (any name).
2. Enable the **Google Drive API** for that project.
3. Configure the **OAuth consent screen** as "External", add your own Gmail as a test user, and leave it in "Testing" mode — no Google review needed for personal use.
4. Create an **OAuth Client ID** → type "Web application" → under "Authorized JavaScript origins" add the exact URL your site is hosted at (e.g. `https://yourusername.github.io`).
5. Copy the Client ID and paste it into the tracker, click Save, then **Connect Google Drive**.

After that, on **each device**, you need that same Client ID entered once. Two ways to do it:
- **Fastest:** on the device where you already saved it, click **📋 Copy setup link**, send that link to yourself (your own Notes app, or a message to yourself), and open it on the new device — it auto-fills the Client ID.
- **Manual:** just paste the same Client ID into the box and click Save.

Either way, click **Connect Google Drive** once on that device afterward, and approve the Google popup — this one step can't be skipped, on purpose, since it's what stops anyone else from writing to your Drive with just your Client ID. Once connected on a device, that device behaves like this for the rest of the session:
- **Connecting pulls in the latest data automatically** — anything backed up from another device shows up right away, no extra click needed.
- **Every change you make (add/edit/delete) pushes to Drive automatically** in the background — no need to click "Backup" after every transaction.
- **Switching back to the tab** (e.g. from your phone back to your laptop) automatically checks Drive again for anything new.
- The manual **Backup to Drive** / **Restore from Drive** buttons still exist for a one-off manual sync, or if you want to force it immediately.

You'll need to reconnect roughly every hour of continuous use (Google's access tokens expire) or after closing the browser — this is intentional, so no long-lived credential is ever stored on the device. In practice: open the tracker, click Connect once, and it stays in sync with your other devices for that session.

## Net worth & investment ledger (in the tracker)

Tracks holdings across Savings, FD, RD, Equity, Mutual Fund, Liquid/Short-term MF, Gold/Silver, Crypto, and US Stocks — each with an invested amount, a current (mark-to-market) value, and a running buy/sell log. Like transactions, this follows the same 🇺🇸/🇮🇳 currency toggle at the top, so US stocks naturally live under the USD view.

- **Buy** adds to a holding's invested amount and current value
- **Sell** reduces both, proportionally trimming the cost basis so the remaining gain/loss ratio stays accurate
- **Update value** lets you mark a holding to its latest market price any time, independent of buying or selling
- Real estate, vehicles, and other non-tradeable assets are tracked separately as simple totals (no buy/sell), alongside loans and other liabilities
- Net worth = investment value + other assets − liabilities, computed automatically
- All of this saves locally and syncs to Google Drive automatically, exactly like transactions — no separate setup needed

## A note on the spending tracker's local data

Local storage is tied to one browser on one device. It will:
- **Persist** across visits, browser restarts, and even if you close the tab — it stays until you clear it or clear that browser's site data.
- **Not sync** automatically between your phone and laptop, or between two different browsers on the same device — use Google Drive backup (above) or manual Export/Import for that.

The tracker will also nag you (gently, dismissible) if it's been more than two weeks since your last export or Drive backup.

## Security & privacy notes

- All user-entered text is HTML-escaped before being displayed, to prevent script injection (XSS) through transaction descriptions or categories.
- A strict Content-Security-Policy is set, only allowing scripts from this site itself and `accounts.google.com` (loaded only if/when you use Drive backup) — nothing else can run on the page.
- Chart.js is self-hosted (`chart.min.js`) and Google Fonts have been dropped in favor of system fonts, so the tracker makes **zero third-party network requests** unless you opt into Google Drive backup.
- The service worker never caches Google Sign-In or Drive API traffic — only this site's own static files are cached for offline use.
- The Google Drive integration uses the `drive.file` scope, meaning the app can only see files it created itself — never your existing Drive contents.

## Customizing

- Colors and fonts are set as CSS variables near the top of each file (`:root { ... }`).
- Default categories for the tracker are in `DEFAULT_CATEGORIES` near the top of the `<script>` in `tracker.html` — edit that list, or just use "+ Add new category…" in the app itself.

