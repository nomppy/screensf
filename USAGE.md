# Screen Bay usage guide

A step-by-step walkthrough for running Screen Bay day to day. The [README](README.md) is the reference for how each piece works; this guide is about what to type and when.

## 1. First run

```sh
git clone https://github.com/nomppy/screenbay.git
cd screenbay
npm install
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Required | What to put |
|---|---|---|
| `TMDB_API_KEY` | yes | A free v3 key from https://www.themoviedb.org/settings/api |
| `LETTERBOXD_USER` | no | Your Letterboxd username, for private watchlist alerts |
| `BLOCKBUSTER_POPULARITY` | no | Popularity cutoff for auto-excluding wide releases (default 60) |
| `NOTIFY_MACOS` | no | `1` to get desktop notifications on watchlist matches |

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

Every undecided title appears as a card with the venue's raw title, TMDB's best guess, poster, synopsis, why it was flagged, and the showtimes. For each card pick one of:

- **Include**: add it to the schedule as the matched film.
- **Include, title only**: add it without a TMDB match. Use this for shorts programs, live events, and anything TMDB will never have.
- **Exclude**: keep it off the schedule.
- Click an alternative poster to include it as that film, or use the search box if none of the guesses is right.

Decisions save instantly to `data/decisions.json` and the schedule rebuilds within a second. If `npm run dev` is running in another terminal, the site updates live.

Keyboard shortcuts once a card is focused:

| Key | Action |
|---|---|
| `y` | Include |
| `t` | Include, title only |
| `n` | Exclude |
| `u` | Undo |
| `j` / `k` | Next / previous card |

You are never asked about the same title twice. Use the Decided tab and Undo to change your mind.

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

## 6. Turning venues on and off

Edit `data/venues.json` and flip `enabled`. Roxie, Balboa and Castro are on by default. Vogue and 4 Star share the Balboa's site template and can be enabled directly.

To add a new venue, write `scripts/venues/<id>.ts`, register it in the `SCRAPERS` map in `scripts/sync.ts`, and add an entry to `data/venues.json`. See the README for details.

## 7. Automating

Schedule `npm run sync` once a morning with cron or launchd. It never prompts, so it is safe to run unattended. Example crontab line:

```
0 7 * * * cd /path/to/screenbay && /usr/local/bin/npm run sync >> .cache/sync.log 2>&1
```

Open `npm run review` whenever a run reports pending titles.

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
