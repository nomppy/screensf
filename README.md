# Screen SF

A local, Screen Boston–style schedule of repertory and independent screenings in San Francisco. Astro static site plus a Node sync script that scrapes venue calendars, enriches titles from TMDB, filters out wide-release blockbusters, asks you about anything ambiguous, and privately tells you when something on your Letterboxd watchlist is playing.

See [USAGE.md](USAGE.md) for a step-by-step usage guide.

## Setup

Requirements: Node 22.18 or newer (the scripts are TypeScript run directly by Node, no build step).

```sh
npm install
cp .env.example .env        # add your TMDB_API_KEY (free, v3 auth)
npm run demo                # optional: load sample data to see the layout
npm run dev                 # http://localhost:4321
```

TMDB key: https://www.themoviedb.org/settings/api. The free tier is enough; usage is a few hundred requests per sync and results are cached in `.cache/`.

## Daily use

```sh
npm run sync
```

This scrapes every enabled venue in `data/venues.json`, then for each distinct title:

| Situation | What happens |
|---|---|
| Released more than 2 years ago | included automatically (repertory) |
| Released 90+ days ago, not in TMDB's US now-playing list | included automatically |
| In TMDB's US now-playing list with popularity ≥ `BLOCKBUSTER_POPULARITY` (default 60) | excluded automatically (the "showing everywhere" case) |
| In now-playing but not popular, brand new, no TMDB match, or an uncertain match | **you are asked** |

Sync never blocks on questions. It writes a snapshot of everything it learned to `.cache/resolved.json`, applies the decisions you have already saved, writes the schedule, and tells you how many titles still need a call. Then:

```sh
npm run review
```

opens http://localhost:4400 with every undecided title as a card: the venue's raw title (linked), the TMDB best guess with poster, director, year, genre, popularity, and synopsis, the reason it was flagged, all showtimes, and the alternative matches as poster thumbnails. Click **Include**, **Include, title only** (shorts programs, live events, things TMDB will never have), or **Exclude**; click an alternative thumbnail to include it as that film; or search TMDB from the card if none of them is right. Every click saves to `data/decisions.json` immediately and the schedule rebuilds within a second, so a running `npm run dev` updates live. Tabs switch between Pending, Decided and All; decided cards have an Undo button. Keyboard: focus a card, then `y` include, `t` title only, `n` exclude, `u` undo, `j`/`k` next/previous.

**Artwork.** Cards use TMDB's backdrop or poster. When TMDB has nothing (shorts programs, live events, obscure titles) sync fetches the venue's own listing image (Squarespace asset or the page's `og:image`) and uses that instead, so cards are never blank. Every review card has an Artwork row where you can switch between the TMDB image, the venue's image, or any pasted image URL; the choice is stored on the decision in `data/decisions.json`.

You are never asked twice about a title. To reopen one: Undo in the review UI, `npm run sync -- --reset-decision "Title"`, or edit `data/decisions.json`. `npm run sync:prompt` (or `--prompt`) decides in the terminal instead, if you prefer.

`npm run sync` is safe to run from cron or launchd since it never prompts; check the review UI when it reports pending titles.

Other flags: `--venue roxie` (one venue), `--no-watchlist`. Sync only keeps showtimes within the next `SYNC_WEEKS` weeks (default 4); Castro event pages beyond that window are not fetched at all. Festivals are exempt and are listed however far ahead they are.

### Festivals

Festival programming is handled separately: a showtime whose title, note or URL matches a pattern in `data/festivals.json` (the words festival/fest, known Bay Area festival names, "Shorts Program", and so on) skips TMDB and prompting entirely. All of a festival's showtimes at one venue fold into a single entry with a date range, a link and a few sample titles, shown in a "Festivals & series" strip at the top of the schedule. When a venue lists a festival without any of those words, add its name to the patterns list.

### Manual listings

```sh
npm run add
```

Walks you through venue, title (with TMDB lookup), date, times, format, note, link. Saved to `data/manual.json` and merged into the schedule immediately; sync never removes them. Delete a manual entry by removing it from that file.

### Watchlist notifications (private)

Set `LETTERBOXD_USER` in `.env` (default `sunkht`). At the end of every sync, every film seen at any venue, **including films excluded from the public schedule**, is compared against the public watchlist. Matches print to the terminal and, on macOS, arrive as a desktop notification the first time each film/date is seen. `npm run watchlist` re-checks the current schedule without scraping.

Nothing about the watchlist is written to `data/` or rendered by the site. Matches live only in `.cache/watchlist-matches.json`, which is git-ignored. This keeps the site publishable later without leaking your personal data.

Letterboxd has no public API for watchlists; this reads the public HTML pages (about 4 for the grid plus one per film the first time, then cached). Letterboxd occasionally returns 403 to non-browser clients; the script sends a browser user agent, but if it fails, wait and retry.

## Venues and scrapers

`data/venues.json` controls what runs; flip `enabled` to turn a theatre on or off. Fifteen are on, covering San Francisco, the East Bay, the Peninsula and Marin.

| Venue | Source | Method |
|---|---|---|
| Roxie | roxie.com/calendar/ (WordPress, Theater plugin) | HTML list view: day headings, `/film/` title links, `#showtimes` time links |
| Balboa, Vogue, 4 Star | Squarespace events collection | `?format=json`; one event per showtime, trusting the event's own start date |
| Castro | thecastro.com (WordPress, Another Planet) | Listing pages → each event page (cached a week), kept only if categorised as film |
| Alamo New Mission | drafthouse.com market schedule JSON | One feed for the whole SF market, filtered to cinema 0801; series and event type into `note` |
| BAMPFA | bampfa.org/visit/calendar/YYYY-MM (Drupal month grid) | Film-tagged rows plus the event page for print format; honours the site's 10 s crawl delay |
| Rafael | cinema.cafilm.org schedule + film pages | Schedule page for film URLs, film pages for AM/PM times, `RAF*` screens only |
| Stanford | stanfordtheatre.org season page (hand-edited HTML) | Calendar table: date cell, one paragraph per film with year and times; returns nothing when dark |
| New Parkway | thenewparkway.com GraphQL (Indy Cinema Systems) | `showingsForDate` per day with the site/circuit headers from the JS bundle |
| SFMOMA | sfmoma.org/events/ inline JSON | Film Screening term only; detail page for description and location |
| ATA | atasite.org WP REST (The Events Calendar) | Screening category; skips workshops and open mics |
| Grand Lake | RTS ticketing (formovietickets.com, plain HTTP) | Day schedule pages; poster and cased titles from renaissancerialto.com |
| Opera Plaza, Piedmont | landmarktheatres.com Boxoffice API | Theatre id from `calendarUrl`; formats from projection tags. Embarcadero, Shattuck and Albany Twin have closed. |

Every response is saved to `.cache/raw/<host>-<hash>.txt`, so when a venue returns 0 showtimes, open that file and compare against the selectors in `scripts/venues/*.ts`. Several of these feeds (Drafthouse, New Parkway, Landmark) are undocumented internals and can change without notice; the scraper warns and returns nothing rather than failing the run.

Adding a venue: write `scripts/venues/<id>.ts` exporting `(venue) => Promise<RawScreening[]>`, register it in the `SCRAPERS` map in `scripts/sync.ts`, add an entry to `data/venues.json`.

## Layout

```
data/
  venues.json        venues + scraper config
  screenings.json    generated schedule (films + screenings); the site reads this
  manual.json        hand-entered listings
  decisions.json     your include/exclude answers
  sample.json        demo data
scripts/
  sync.ts            scrape → festivals → TMDB → classify → snapshot → write → watchlist
  review.ts          browser review queue (localhost:4400), rebuilds the schedule on each decision
  add.ts             manual listing
  watchlist.ts       watchlist check only
  lib/               http, tmdb, titles, dates, classify, festivals, build (snapshot → schedule), letterboxd, notify
  venues/            one file per site template
src/
  pages/index.astro  the schedule (days → cards, venue filter chips)
  pages/about.astro
  components/        Layout, ScreeningCard
  lib/schedule.ts    groups screenings.json into day → card
.cache/              resolved.json snapshot, TMDB and page caches, raw responses, watchlist matches (git-ignored)
```

## Hosting and automation

Cloudflare Pages builds and hosts `dist/` on every push (connect the repo, preset Astro, `NODE_VERSION=22`). Two GitHub Actions workflows in `.github/workflows/` do the rest: `sync.yml` runs `npm run sync` daily and commits `data/screenings.json`; `review-reminder.yml` opens a weekly issue listing the titles held back for review. The only secret is `TMDB_API_KEY`. Full walkthrough in [USAGE.md](USAGE.md#7-hosting-and-automation).

Undecided titles never publish unattended. Run `npm run review` locally, commit `data/decisions.json`, and the next sync includes them.

## Keyboard

The schedule page has vim-style keys: `h`/`j`/`k`/`l` move between films by position on screen, `J`/`K` between days, `gg`/`G` to the ends, `o` or Enter opens details, `t` opens tickets, `1`…`5` filter by region, `?` shows the list. With details open, `c` adds to Google Calendar and `l` opens Letterboxd.

## Known limits

- Roxie's calendar marks some showtimes with `*` (meaning is not stated on the page); those get a generic "See venue listing" note.
- Castro event pages are fetched individually (2.5 s apart, backing off on HTTP 429) and cached for a week; the first run takes two to three minutes.
- Title cleaning strips known series prefixes (`Arthouse 50:`, `Floating Features:` …). Add new ones to `SERIES_PREFIXES` in `scripts/lib/titles.ts` when a venue starts a new series.
- The blockbuster rule depends on TMDB's `now_playing` list for region US, which lags real theatrical release by a few days.
- Design is inspired by Screen Boston's structure, not copied from it. The name is a placeholder; change `SITE_NAME` in `src/lib/schedule.ts` and the brand in `Layout.astro`.
