/**
 * npm run watchlist
 *
 * Check the current data/screenings.json against your Letterboxd watchlist
 * without re-scraping. Note that sync compares against *everything* it saw,
 * including films it excluded as blockbusters; this command only sees what
 * made it onto the schedule.
 */
import { loadEnv } from './lib/env.ts';
import { formatDateHeading, formatTime12 } from './lib/dates.ts';
import { fetchWatchlist, matchWatchlist } from './lib/letterboxd.ts';
import { color } from './lib/prompt.ts';
import { loadSchedule, loadVenues } from './lib/store.ts';

loadEnv();

const user = process.env.LETTERBOXD_USER;
if (!user) {
  console.error('Set LETTERBOXD_USER in .env');
  process.exit(1);
}

const schedule = loadSchedule();
const venues = loadVenues();
const wl = await fetchWatchlist(user);
console.log(`${wl.length} films on ${user}'s watchlist (${wl.filter((w) => w.tmdbId).length} with TMDB ids).`);
const matches = matchWatchlist(wl, schedule.films);
if (!matches.length) {
  console.log('Nothing on your watchlist is on the schedule.');
} else {
  for (const m of matches) {
    const film = schedule.films[m.filmKey];
    const shows = schedule.screenings.filter((s) => s.filmKey === m.filmKey);
    console.log(`${color.cyan('★')} ${film.title}${film.year ? ` (${film.year})` : ''}`);
    for (const s of shows) {
      const v = venues.find((x) => x.id === s.venueId)?.shortName ?? s.venueId;
      console.log(`    ${v.padEnd(8)} ${formatDateHeading(s.date)}  ${formatTime12(s.time)}${s.format ? `  ${s.format}` : ''}`);
    }
  }
}
