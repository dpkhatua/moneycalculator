# The Compound Ledger — Money Calculators & Spending Tracker

Two pages, no build step, no backend:
- **`index.html`** — 16 calculators (FD, RD, SIP, Lumpsum, SWP, CAGR, Compound Interest, Loan Payoff, Credit Card Payoff, Budget, Net Worth, Sukanya Samriddhi Yojana, Income Tax, PPF, EPF, EMI).
- **`tracker.html`** + **`tracker.js`** — a private spending tracker, with an optional Google Drive backup. Data is saved in the browser's local storage on that device by default — nothing is sent anywhere unless you explicitly connect Google Drive.

Supporting files — upload all of these too, same folder:
- `manifest.json`, `sw.js` (service worker), `icon-192.png`, `icon-512.png`, `chart.min.js` (self-hosted chart library, used by both pages instead of a CDN)

## Deploy to GitHub Pages (2 minutes)

1. Create a new repository on GitHub (e.g. `money-calculators`).
2. Upload **all the files above** to the repo, all in the same folder (drag-and-drop on GitHub's web UI works fine — select them all at once).
3. Go to **Settings → Pages** in the repo.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Pick the `main` branch and `/ (root)` folder, then **Save**.
6. Wait a minute, then your site will be live at:
   `https://<your-username>.github.io/<repo-name>/`
   The tracker will be at the same address plus `/tracker.html`.

## Using git instead

```bash
git init
git add index.html tracker.html tracker.js manifest.json sw.js icon-192.png icon-512.png chart.min.js README.md
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

## Backing up to Google Drive (optional)

This is opt-in and off by default — nothing is contacted until you set it up. It backs up to a private file in **your own** Drive that only this app can read (it can't see or touch anything else in your Drive).

One-time setup (in the tracker's "Your data" section, under "Back up to Google Drive"):
1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) and create a project (any name).
2. Enable the **Google Drive API** for that project.
3. Configure the **OAuth consent screen** as "External", add your own Gmail as a test user, and leave it in "Testing" mode — no Google review needed for personal use.
4. Create an **OAuth Client ID** → type "Web application" → under "Authorized JavaScript origins" add the exact URL your site is hosted at (e.g. `https://yourusername.github.io`).
5. Copy the Client ID and paste it into the tracker, click Save, then **Connect Google Drive**.

After that, on **each device**, paste the same Client ID and click **Connect Google Drive** once. Once connected on a device, that device behaves like this for the rest of the session:
- **Connecting pulls in the latest data automatically** — anything backed up from another device shows up right away, no extra click needed.
- **Every change you make (add/edit/delete) pushes to Drive automatically** in the background — no need to click "Backup" after every transaction.
- **Switching back to the tab** (e.g. from your phone back to your laptop) automatically checks Drive again for anything new.
- The manual **Backup to Drive** / **Restore from Drive** buttons still exist for a one-off manual sync, or if you want to force it immediately.

You'll need to reconnect roughly every hour of continuous use (Google's access tokens expire) or after closing the browser — this is intentional, so no long-lived credential is ever stored on the device. In practice: open the tracker, click Connect once, and it stays in sync with your other devices for that session.

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

