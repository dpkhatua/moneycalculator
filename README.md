# The Compound Ledger — Money Calculators

A single-page site with six calculators: **FD, RD, SIP, Lumpsum, SWP, and CAGR**. Pure HTML/CSS/JS, no build step, no backend — everything runs in the visitor's browser.

## Deploy to GitHub Pages (2 minutes)

1. Create a new repository on GitHub (e.g. `money-calculators`).
2. Upload `index.html` to the repo (drag-and-drop on GitHub's web UI works fine, or use git).
3. Go to **Settings → Pages** in the repo.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Pick the `main` branch and `/ (root)` folder, then **Save**.
6. Wait a minute, then your site will be live at:
   `https://<your-username>.github.io/<repo-name>/`

## Using git instead

```bash
git init
git add index.html README.md
git commit -m "Add money calculators"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

Then follow steps 3–6 above.

## Customizing

- Colors and fonts are set as CSS variables near the top of `index.html` (`:root { ... }`) — change `--green`, `--mustard`, `--brick`, etc.
- Default rates/amounts for each calculator are set on the `<input>` elements — edit the `value=` attributes.
- Chart.js is loaded from a CDN, so no install step is needed.
