/**
 * npm run sync
 *
 * 1. Scrape every enabled venue in data/venues.json.
 * 2. Fold festival programming into festival entries (data/festivals.json).
 * 3. Match each distinct title against TMDB and classify it: repertory in,
 *    wide-release blockbusters out, everything in between queued for review.
 * 4. Write the snapshot to .cache/resolved.json, apply saved decisions, write
 *    data/screenings.json.
 * 5. Compare everything seen (including excluded films) against your
 *    Letterboxd watchlist and notify you privately.
 *
 * Titles needing a decision are reviewed in the browser: `npm run review`.
 *
 * Flags: --prompt (decide in the terminal instead)   --venue <id>
 *        --no-watchlist   --reset-decision "<title>"
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { finalizeSchedule, saveResolved, type ResolvedItem } from './lib/build.ts';
import { classify } from './lib/classify.ts';
import { formatDateHeading, formatTime12, horizonEndLA, syncWeeks, todayLA } from './lib/dates.ts';
import { venueImageFor } from './lib/artwork.ts';
import { flag, loadEnv, option } from './lib/env.ts';
import { buildFestivals, isFestival, resolveFestivalLinks } from './lib/festivals.ts';
import { JsonCache } from './lib/http.ts';
import { fetchWatchlist, matchWatchlist } from './lib/letterboxd.ts';
import { notifyDesktop } from './lib/notify.ts';
import { ask, closePrompt, color } from './lib/prompt.ts';
import { loadDecisions, loadVenues, saveDecisions } from './lib/store.ts';
import { describeMovie, filmFromTmdb, matchFilm, movieOverview, nowPlayingIds } from './lib/tmdb.ts';
import { cleanTitleCandidates, extractYear, normalizeTitle } from './lib/titles.ts';
import type { DecisionRecord, Film, RawScreening, Venue } from './lib/types.ts';
import { scrapeAlamo } from './venues/alamo.ts';
import { scrapeAta } from './venues/ata.ts';
import { scrapeBampfa } from './venues/bampfa.ts';
import { scrapeCastro } from './venues/castro.ts';
import { scrapeCinemaSF } from './venues/cinemasf.ts';
import { scrapeGrandLake } from './venues/grandlake.ts';
import { scrapeLandmark } from './venues/landmark.ts';
import { scrapeNewParkway } from './venues/newparkway.ts';
import { scrapeRafael } from './venues/rafael.ts';
import { scrapeRoxie } from './venues/roxie.ts';
import { scrapeSfmoma } from './venues/sfmoma.ts';
import { scrapeStanford } from './venues/stanford.ts';

loadEnv();

const SCRAPERS: Record<string, (v: Venue) => Promise<RawScreening[]>> = {
  roxie: scrapeRoxie,
  cinemasf: scrapeCinemaSF,
  castro: scrapeCastro,
  alamo: scrapeAlamo,
  bampfa: scrapeBampfa,
  rafael: scrapeRafael,
  stanford: scrapeStanford,
  newparkway: scrapeNewParkway,
  sfmoma: scrapeSfmoma,
  ata: scrapeAta,
  grandlake: scrapeGrandLake,
  landmark: scrapeLandmark,
};

const terminalPrompt = flag('prompt');
const onlyVenue = option('venue');
const skipWatchlist = flag('no-watchlist');

async function main() {
  const venues = loadVenues().filter((v) => v.enabled && (!onlyVenue || v.id === onlyVenue));
  const decisions = loadDecisions();

  const reset = option('reset-decision');
  if (reset) {
    const k = normalizeTitle(reset);
    for (const key of Object.keys(decisions)) {
      if (key === k || decisions[key].title.toLowerCase() === reset.toLowerCase()) delete decisions[key];
    }
    saveDecisions(decisions);
    console.log(`Cleared decision for "${reset}".`);
  }

  // ---- 1. scrape ----------------------------------------------------------
  const raws: RawScreening[] = [];
  for (const v of venues) {
    const scraper = SCRAPERS[v.scraper ?? v.id];
    if (!scraper) {
      console.warn(`No scraper for venue ${v.id}`);
      continue;
    }
    process.stdout.write(`Scraping ${v.name}... `);
    try {
      const list = await scraper(v);
      console.log(`${list.length} showtimes`);
      if (!list.length) console.warn(color.yellow(`  ${v.id} returned nothing. The site may have changed; see .cache/raw/`));
      raws.push(...list);
    } catch (err) {
      console.log(color.red(`failed: ${(err as Error).message}`));
    }
  }
  const today = todayLA();
  const horizon = horizonEndLA();
  const future = raws.filter((r) => r.date >= today);

  // ---- 2. festivals -------------------------------------------------------
  // Festivals are kept however far out they are (they are announced early and
  // worth planning for); ordinary screenings stop at the horizon.
  const festivalRaws = future.filter(isFestival);
  const upcoming = future.filter((r) => !isFestival(r) && r.date <= horizon);
  const allUpcoming = [...festivalRaws, ...upcoming];
  const festivals = await resolveFestivalLinks(buildFestivals(festivalRaws));
  console.log(`\n${allUpcoming.length} upcoming showtimes across ${venues.length} venues in the next ${syncWeeks()} weeks (through ${formatDateHeading(horizon)}).`);
  if (festivals.length) {
    console.log(`${festivalRaws.length} are festival programming, folded into ${festivals.length} festival entr${festivals.length === 1 ? 'y' : 'ies'}:`);
    for (const f of festivals) {
      const v = venues.find((x) => x.id === f.venueId)?.shortName ?? f.venueId;
      const range = f.endDate !== f.startDate ? ` to ${formatDateHeading(f.endDate)}` : '';
      console.log(`  ${color.cyan('◆')} ${f.name}  ${color.dim(`${v}, ${formatDateHeading(f.startDate)}${range}, ${f.showtimes} showtimes`)}`);
    }
  }
  console.log('');

  // ---- 3. match + classify ------------------------------------------------
  console.log('Checking TMDB now-playing list...');
  const nowPlaying = await nowPlayingIds();

  const groups = new Map<string, { raws: RawScreening[]; candidates: string[]; year?: number }>();
  for (const r of upcoming) {
    const candidates = cleanTitleCandidates(r.rawTitle);
    const key = normalizeTitle(candidates[0] ?? r.rawTitle);
    const g = groups.get(key) ?? { raws: [], candidates, year: extractYear(r.rawTitle) };
    g.raws.push(r);
    groups.set(key, g);
  }

  const items: ResolvedItem[] = [];
  let n = 0;
  for (const [key, g] of groups) {
    n++;
    process.stdout.write(`\r${progressBar(n, groups.size)} matching ${n}/${groups.size} titles   `);
    const sample = g.raws[0];
    const prior: DecisionRecord | undefined = decisions[key];

    let film: Film | null = null;
    let confident = false;
    let alternatives: ResolvedItem['alternatives'] = [];
    if (prior?.tmdbId) {
      film = await filmFromTmdb(prior.tmdbId, nowPlaying.has(prior.tmdbId));
      confident = true;
    } else if (prior?.tmdbId === null) {
      film = null;
    } else {
      const m = await matchFilm(g.candidates, g.year);
      alternatives = m.alternatives;
      confident = m.confident;
      if (m.best) film = await filmFromTmdb(m.best.id, nowPlaying.has(m.best.id));
    }
    const verdict = classify(film, confident);
    const overview = film?.tmdbId && verdict.action === 'ask' ? await movieOverview(film.tmdbId) : undefined;
    items.push({
      key,
      venueId: sample.venueId,
      raws: g.raws,
      candidates: g.candidates,
      year: g.year,
      film,
      overview,
      alternatives,
      action: verdict.action,
      reason: verdict.reason,
    });
  }
  process.stdout.write('\n');

  // ---- 3a. venue artwork ------------------------------------------------------
  // For anything TMDB could not illustrate, and anything you will be asked
  // about, grab the venue's own image so the card is never blank and review
  // can offer it as an alternative. Listing pages are cached for a week.
  const wantArt = items.filter((i) => i.action === 'ask' || !(i.film?.poster || i.film?.backdrop));
  let a = 0;
  for (const it of wantArt) {
    a++;
    process.stdout.write(`\r${progressBar(a, wantArt.length)} venue artwork ${a}/${wantArt.length}   `);
    it.venueImage = await venueImageFor(it.raws);
  }
  if (wantArt.length) process.stdout.write('\n');

  const snapshot = {
    generatedAt: new Date().toISOString(),
    venues,
    festivals,
    nowPlaying: [...nowPlaying.keys()],
    items,
  };
  saveResolved(snapshot);

  // ---- 3b. optional terminal prompting ------------------------------------
  const undecided = items.filter((i) => i.action === 'ask' && !decisions[i.key]);
  if (terminalPrompt && undecided.length) {
    for (let i = 0; i < undecided.length; i++) {
      const it = undecided[i];
      const venue = venues.find((v) => v.id === it.venueId)!;
      const answer = await promptUser(venue, it.raws, it.film, it.alternatives, it.reason, `[${i + 1}/${undecided.length}]`);
      if (answer.kind === 'skip') continue;
      decisions[it.key] = {
        decision: answer.kind,
        title: it.raws[0].rawTitle,
        tmdbId: answer.kind === 'include' ? (answer.titleOnly ? null : (answer.tmdbId ?? it.film?.tmdbId)) : undefined,
        decidedAt: new Date().toISOString(),
      };
      saveDecisions(decisions);
    }
  }

  // ---- 4. finalize --------------------------------------------------------
  const result = await finalizeSchedule(snapshot, decisions);
  console.log('');
  for (const it of items) {
    const d = decisions[it.key];
    const action = d ? d.decision : it.action;
    const venue = venues.find((v) => v.id === it.venueId)?.shortName ?? it.venueId;
    const film = result.seenFilms[result.rawFilmKey.get(it.raws[0]) ?? ''] ?? it.film;
    const label = `${color.dim(venue.padEnd(7))} ${film?.title ?? it.candidates[0]}${film?.year ? ` (${film.year})` : ''}`;
    const reason = d ? 'your decision' : it.reason;
    if (action === 'include') console.log(`${color.green('+')} ${label}  ${color.dim(reason)}`);
    else if (action === 'exclude') console.log(`${color.red('-')} ${label}  ${color.dim(reason)}`);
    else console.log(`${color.yellow('?')} ${label}  ${color.dim(reason)}`);
  }

  console.log(
    `\nWrote data/screenings.json: ${result.data.screenings.length} screenings, ${Object.keys(result.data.films).length} films, ` +
      `${festivals.length} festivals (${result.included} titles included, ${result.excluded} excluded).`,
  );
  // Always written (empty when nothing is pending) so a stale copy restored
  // from a CI cache cannot report titles that were already decided.
  mkdirSync('.cache', { recursive: true });
  writeFileSync(
    '.cache/pending.json',
    JSON.stringify(result.pending.map((p) => `${p.venueId}: ${p.raws[0].rawTitle} (${p.reason})`), null, 2),
  );
  if (result.pending.length) {
    const how = terminalPrompt ? '' : ', or `npm run sync -- --prompt` for the terminal';
    console.log(
      color.yellow(`\n${result.pending.length} title${result.pending.length === 1 ? '' : 's'} need your decision. `) +
        `Run ${color.bold('npm run review')} to go through them in the browser${how}.`,
    );
  }

  // ---- 5. watchlist (private) --------------------------------------------
  const user = process.env.LETTERBOXD_USER;
  if (user && !skipWatchlist) {
    console.log(`\nChecking Letterboxd watchlist for ${user}...`);
    try {
      const wl = await fetchWatchlist(user);
      const matches = matchWatchlist(wl, result.seenFilms);
      const notified = new JsonCache<string>('.cache/notified.json');
      const lines: string[] = [];
      const fresh: string[] = [];
      for (const m of matches) {
        const film = result.seenFilms[m.filmKey];
        const shows = upcoming.filter((r) => result.rawFilmKey.get(r) === m.filmKey);
        const where = shows.length
          ? shows
              .slice(0, 4)
              .map((s) => `${venues.find((v) => v.id === s.venueId)?.shortName} ${formatDateHeading(s.date)} ${formatTime12(s.time)}`)
              .join('; ') + (shows.length > 4 ? `; +${shows.length - 4} more` : '')
          : 'see schedule';
        const onSchedule = result.data.films[m.filmKey] ? '' : color.dim(' (not on the public schedule)');
        lines.push(`${color.cyan('★')} ${film.title}${film.year ? ` (${film.year})` : ''}: ${where}${onSchedule}`);
        const stamp = `${m.filmKey}|${shows[0]?.date ?? ''}`;
        if (!notified.has(stamp)) {
          notified.set(stamp, new Date().toISOString());
          fresh.push(`${film.title}: ${where}`);
        }
      }
      if (!lines.length) console.log('  No watchlist titles are screening.');
      else lines.forEach((l) => console.log('  ' + l));
      if (fresh.length) {
        notifyDesktop(`${fresh.length} watchlist film${fresh.length > 1 ? 's' : ''} screening`, fresh.slice(0, 3).join(' • ').slice(0, 240));
      }
      writeFileSync('.cache/watchlist-matches.json', JSON.stringify(matches, null, 2));
    } catch (err) {
      console.warn(color.yellow(`  watchlist check failed: ${(err as Error).message}`));
    }
  }

  closePrompt();
}

function progressBar(done: number, total: number, width = 24): string {
  const filled = total ? Math.round((done / total) * width) : width;
  return color.dim('[') + '█'.repeat(filled) + '░'.repeat(width - filled) + color.dim(']');
}

type Answer = { kind: 'include'; tmdbId?: number; titleOnly?: boolean } | { kind: 'exclude' } | { kind: 'skip' };

async function promptUser(
  venue: Venue,
  raws: RawScreening[],
  film: Film | null,
  alternatives: { id: number; title: string; release_date?: string; popularity?: number }[],
  reason: string,
  counter = '',
): Promise<Answer> {
  const first = raws[0];
  const more = raws.length > 1 ? ` +${raws.length - 1} more` : '';
  console.log('');
  console.log(`${color.bold(counter || '?')} ${color.bold(venue.shortName)} — "${first.rawTitle}"  ${color.dim(`${formatDateHeading(first.date)} ${formatTime12(first.time)}${more}`)}`);
  console.log(`  ${color.dim('Why asking:')} ${reason}`);
  if (film) {
    console.log(`  ${color.dim('Best guess:')} ${film.title} (${film.year ?? '????'})${film.director ? `, ${film.director}` : ''}${film.popularity ? color.dim(`  pop ${Math.round(film.popularity)}`) : ''}`);
  } else {
    console.log(`  ${color.dim('Best guess:')} none`);
  }
  alternatives.forEach((a, i) => console.log(`    ${i + 1}. ${describeMovie(a)}`));
  const opts = [
    film ? '[y] include' : null,
    alternatives.length ? `[1-${alternatives.length}] include as alternative` : null,
    '[t] include, title only',
    '[n] exclude',
    '[s] skip for now',
  ]
    .filter(Boolean)
    .join('  ');

  for (;;) {
    const a = (await ask(`  ${opts} > `)).toLowerCase();
    if (a === 'y' && film) return { kind: 'include' };
    if (a === 't') return { kind: 'include', titleOnly: true };
    if (a === 'n') return { kind: 'exclude' };
    if (a === 's' || a === '') return { kind: 'skip' };
    const k = Number(a);
    if (Number.isInteger(k) && k >= 1 && k <= alternatives.length) return { kind: 'include', tmdbId: alternatives[k - 1].id };
    console.log('  Not understood.');
  }
}

main().catch((err) => {
  console.error(err);
  closePrompt();
  process.exit(1);
});
