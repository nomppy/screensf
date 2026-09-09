# Screen SF usage guide

A step-by-step walkthrough for running Screen SF day to day. The [README](README.md) is the reference for how each piece works; this guide is about what to type and when.

## 1. First run

```sh
git clone https://github.com/nomppy/screensf.git
cd screensf
npm install
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Required | What to put |
|---|---|---|
| `TMDB_API_KEY` | yes | A free v3 key from https://www.themoviedb.org/settings/api |
| `LETTERBOXD_USER` | no | Your Letterboxd username, for private watchlist alerts |
| `BLOCKBUSTER_POPULARITY` | no | Popularity cutoff for auto-excluding wide releases (default 60) |
| `FIRST_RUN_SHOWTIMES` | no | A film newer than two years with this many showtimes in the window is auto-excluded as a first-run booking (default 20) |
| `NOTIFY_MACOS` | no | `1` to get desktop notifications on watchlist matches |
| `SYNC_WEEKS` | no | How many weeks ahead to fetch and show (default 4) |

Check that Node is 22.18 or newer (`node --version`); the scripts are TypeScript run directly by Node.

To see the site before scraping anything:

```sh
npm run demo     # copies data/sample.json over data/screenings.json
npm run dev      # http://localhost:4321
```

## 2. The daily loop

Three commands cover almost everything.

### Sync

```sh
npm run sync
```

Scrapes every enabled venue, matches titles against TMDB, drops obvious blockbusters, writes `data/screenings.json`, and checks your watchlist. It never stops to ask a question. At the end it prints how many titles need a decision from you.

Useful variants:

```sh
npm run sync -- --venue roxie          # one venue only
npm run sync -- --no-watchlist         # skip the Letterboxd check
npm run sync:prompt                    # answer questions in the terminal instead of the browser
npm run sync -- --reset-decision "Title"   # forget a past decision and ask again
```

### Review

```sh
npm run review     # http://localhost:4400
```

Every undecided title appears as a card with the venue's raw title, TMDB's best guess, artwork, synopsis, why it was flagged, and the showtimes. Nothing is saved until you press a decision button, so you can look around first:

- **Match row**: click TMDB's guess, an alternative, or a search result to preview it. The card's title, credits and description switch to that film. The last option is *Title only* for shorts programs, live events, and anything TMDB will never have.
- **Artwork row**: click the TMDB backdrop, TMDB poster, the venue's own listing image, or paste any image URL. The big image on the left shows exactly what the site card will use. Click it (or press `o`) to see every image at full size.
- **Edit details**: opens a form for title, year, director, runtime, genre and description. Anything you change overrides TMDB on the site; clear a field to hide it. *Reset to TMDB* drops the edits.

Then press **Include** (saves the selected match, artwork and edits), **Exclude**, or use `t` for title only. The card stays where it is with a badge and an Undo button, and a toast at the bottom offers Undo too. Decisions save to `data/decisions.json` and the schedule rebuilds about a second later; if `npm run dev` is running in another terminal, the site updates live. On an already-decided card the Include button becomes **Save changes** whenever your selection differs from what was saved.

Keyboard shortcuts (press `h` `j` `k` `l` with nothing focused to focus the first card):

| Key | Action |
|---|---|
| `h` / `l` | Previous / next card |
| `j` / `k` | Card below / above |
| `m` / `M` | Cycle the match forward / back (`1`–`9` pick directly, `0` is title only) |
| `a` / `A` | Cycle the artwork |
| `o` | View the artwork full size (`h` `l` browse, `esc` closes) |
| `e` | Open or close the details editor |
| `/` | Focus the card's TMDB search box |
| `y` | Include with the current selection |
| `t` | Include, title only |
| `n` | Exclude |
| `u` | Undo the focused card's decision, or the last decision made |

You are never asked about the same title twice. Use the Decided tab and Undo to change your mind.

**Rebuild now** in the header regenerates `data/screenings.json` from the last sync plus your decisions. This already happens automatically after every decision, so you only need it if a rebuild failed (the terminal running `npm run review` prints the error).

### Serve or build

```sh
npm run dev        # live dev server on http://localhost:4321
npm run build      # static site in dist/
npm run preview    # serve dist/ locally
```

## 3. Adding a listing by hand

```sh
npm run add
```

Prompts for venue, title (with TMDB lookup), date, times, format, note and link. The entry is saved to `data/manual.json` and shows up in the schedule immediately. Sync never removes manual entries. To delete one, remove it from that file.

## 4. Watchlist alerts

With `LETTERBOXD_USER` set, every sync compares all films seen at every venue, including ones excluded from the public schedule, against your public Letterboxd watchlist. Matches print to the terminal and, with `NOTIFY_MACOS=1`, arrive as a macOS notification the first time each film and date is seen.

```sh
npm run watchlist    # re-check the current schedule without scraping
```

Nothing about the watchlist is written to `data/` or rendered on the site. Matches live only in the git-ignored `.cache/` directory.

## 5. Festivals

Showtimes whose title, note or URL matches a pattern in `data/festivals.json` skip TMDB and review. A festival's showtimes at one venue collapse into a single dated entry in the "Festivals & series" strip at the top of the schedule. If a venue lists a festival without any of the recognised words, add its name to the patterns list in that file.

## 6. Turning theatres on and off

Edit `data/venues.json` and flip `enabled`. Roxie, Balboa and Castro are on by default. Vogue and 4 Star share the Balboa's site template and can be enabled directly.

To add a new venue, write `scripts/venues/<id>.ts`, register it in the `SCRAPERS` map in `scripts/sync.ts`, and add an entry to `data/venues.json`. See the README for details.

## 7. Hosting and automation

The site runs for the price of the domain. Cloudflare Pages hosts the static build, GitHub Actions runs the sync, and both are free at this size.

### 7a. Cloudflare Pages (one time)

1. In the Cloudflare dashboard go to **Workers & Pages → Create → Pages → Connect to Git** and pick the `nomppy/screensf` repository.
2. Build settings: framework preset **Astro**, build command `npm run build`, output directory `dist`.
3. Under **Environment variables** add `NODE_VERSION` = `22`. Nothing else is needed; the build reads `data/screenings.json` from the repo and never calls TMDB.
4. Save and deploy. The first build gives you a `*.pages.dev` URL.
5. **Custom domains → Set up a custom domain** and enter your domain. Because the domain is registered on Cloudflare the DNS record is created for you. Add the `www` version too if you want it to work; Cloudflare redirects it.
6. Set `site` in `astro.config.mjs` to the real `https://` URL and commit. Astro uses it for canonical links.

Every push to `main` now redeploys, including the commits the sync job makes.

**Fonts.** `public/fonts/*.woff2` is gitignored, so the live site falls back to the system sans stack until the Neue Montreal files are in the repo. Pangram Pangram's free license covers personal use; if you are comfortable with that, remove the four font lines from `.gitignore` and commit the files. Courier Prime loads from Google Fonts and needs nothing.

### 7b. GitHub (one time)

1. Repository **Settings → Secrets and variables → Actions → New repository secret**: name `TMDB_API_KEY`, value from your `.env`. Optional **Variables** on the same page: `SYNC_WEEKS`, `BLOCKBUSTER_POPULARITY`.
2. **Actions** tab: both workflows are enabled once pushed. Open **Sync listings → Run workflow** to test it. It should finish in a minute or two and, if listings changed, push a commit called `Sync listings YYYY-MM-DD`.
3. Emails: click **Watch** on the repo and pick **All Activity**, or Custom with Issues ticked. Then check github.com/settings/notifications has email on for issues and for failed Actions ("Send notifications for failed workflows only" is the sensible setting).

### 7c. What runs when

| Workflow | When | What |
|---|---|---|
| Sync listings | daily, 6am PT | Scrapes, applies your decisions, commits `data/screenings.json`. Cloudflare redeploys. Fails (and emails you) only if a scraper or TMDB breaks. |
| Weekly review reminder | Monday 8am PT | Runs a sync, then opens a GitHub issue listing every title held back for review with the steps to clear them. Closes last week's issue. You get an email. |

Titles the classifier is unsure about never publish on their own; they wait for you. Confident matches publish, confident junk is dropped. To be stricter or looser about first-run bookings, set `FIRST_RUN_SHOWTIMES` (and `BLOCKBUSTER_POPULARITY`) in `.env` locally and as repository **Variables** on GitHub.

### 7d. Your weekly review

When the Monday email arrives:

```sh
git pull
npm run sync        # rebuilds the local review snapshot
npm run review      # http://localhost:4400
```

Decide each card, swap artwork where TMDB's is wrong, then:

```sh
git add data/decisions.json data/screenings.json
git commit -m "Review decisions"
git push
```

Cloudflare deploys your push straight away, and the next nightly sync carries the decisions forward. Close the issue. If the email says nothing is pending, a two-minute look at the live site is all it needs.

Decisions are keyed by title and year, so a film you approved once stays approved for the rest of its run and if it comes back next year.

## 8. Troubleshooting

**A venue returns 0 showtimes.** The site's markup probably changed. Every fetched page is saved to `.cache/raw/<host>-<hash>.txt`. Open the file for that venue and compare against the selectors in `scripts/venues/<id>.ts`.

**TMDB errors or empty matches.** Check `TMDB_API_KEY` in `.env`. Responses are cached in `.cache/`, so a bad key from an earlier run does not linger once fixed.

**Letterboxd returns 403.** Letterboxd sometimes blocks non-browser clients. The script already sends a browser user agent. Wait a few minutes and retry, or run with `--no-watchlist` in the meantime.

**A film was wrongly included or excluded.** Undo it in the review UI, or run `npm run sync -- --reset-decision "Title"`, or edit `data/decisions.json` directly.

**A series prefix is polluting titles.** Add it to `SERIES_PREFIXES` in `scripts/lib/titles.ts`.

**Castro's first run is slow.** Event pages are fetched one at a time, 2.5 seconds apart, and cached for a week. Expect two to three minutes the first time.

**Start over.** Delete `.cache/` to clear all fetched pages and TMDB lookups. Your decisions in `data/decisions.json` and manual entries in `data/manual.json` are untouched.

## 9. Syntax check

```sh
npm run check
```

Runs `node --check` over every script. Handy after editing a scraper.
