/**
 * npm run add
 *
 * Interactively add a listing that no scraper covers. Saved to
 * data/manual.json (survives every sync) and merged straight into
 * data/screenings.json so the site updates without a re-scrape.
 */
import { loadEnv } from './lib/env.ts';
import { parseLongDate, parseTime, formatDateHeading, formatTime12 } from './lib/dates.ts';
import { ask, closePrompt, color } from './lib/prompt.ts';
import { loadManual, loadSchedule, loadVenues, saveManual, saveSchedule, screeningId, type ManualEntry } from './lib/store.ts';
import { describeMovie, filmFromTmdb, searchMovies } from './lib/tmdb.ts';
import { extractFormat, fallbackKey } from './lib/titles.ts';
import type { Film } from './lib/types.ts';

loadEnv();

async function required(q: string): Promise<string> {
  for (;;) {
    const a = await ask(q);
    if (a) return a;
  }
}

async function main() {
  const venues = loadVenues();
  console.log(color.bold('Add a listing\n'));

  venues.forEach((v, i) => console.log(`  ${i + 1}. ${v.name}${v.enabled ? '' : color.dim(' (scraper disabled)')}`));
  console.log(`  ${venues.length + 1}. Other (one-off venue)`);
  let venueId: string;
  for (;;) {
    const n = Number(await required('Venue number: '));
    if (n >= 1 && n <= venues.length) {
      venueId = venues[n - 1].id;
      break;
    }
    if (n === venues.length + 1) {
      const name = await required('Venue name: ');
      venueId = `other:${name}`;
      break;
    }
  }

  const rawTitle = await required('Film title (as you want it shown): ');
  const yearIn = await ask('Year (optional, helps TMDB): ');
  const year = yearIn ? Number(yearIn) : undefined;

  let film: Film;
  const results = process.env.TMDB_API_KEY ? await searchMovies(rawTitle, year) : [];
  if (results.length) {
    results.slice(0, 5).forEach((r, i) => console.log(`  ${i + 1}. ${describeMovie(r)}`));
    const pick = await ask('TMDB match number, or Enter for title only: ');
    const n = Number(pick);
    if (n >= 1 && n <= Math.min(5, results.length)) {
      film = await filmFromTmdb(results[n - 1].id, false);
    } else {
      film = { key: fallbackKey(rawTitle, year), title: rawTitle, year };
    }
  } else {
    if (!process.env.TMDB_API_KEY) console.log(color.dim('  (no TMDB_API_KEY; saving title only)'));
    film = { key: fallbackKey(rawTitle, year), title: rawTitle, year };
  }

  let date: string | null = null;
  while (!date) {
    const d = await required('Date (YYYY-MM-DD or "Sep 21"): ');
    date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : parseLongDate(d, { year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
    if (!date) console.log('  Could not parse that date.');
  }

  let times: string[] = [];
  while (!times.length) {
    const t = await required('Showtime(s), comma separated ("7:30 PM, 9:45 PM"): ');
    times = t.split(/[,;]/).map((x) => parseTime(x.trim())).filter((x): x is string => !!x);
    if (!times.length) console.log('  Could not parse any time.');
  }

  const format = (await ask('Format (35mm, 70mm, 4K...; optional): ')) || extractFormat(rawTitle);
  const note = await ask('Note (Q&A, live score...; optional): ');
  const url = (await ask('Link to venue listing (optional): ')) || venues.find((v) => v.id === venueId)?.url || '';

  const manual = loadManual();
  const schedule = loadSchedule();
  for (const time of times) {
    const base = { venueId, filmKey: film.key, date, time, url, format: format || undefined, note: note || undefined, source: 'manual' };
    const screening = { id: screeningId(base), ...base };
    const entry: ManualEntry = { screening, film, addedAt: new Date().toISOString() };
    manual.push(entry);
    schedule.films[film.key] = film;
    if (!schedule.screenings.some((s) => s.id === screening.id)) schedule.screenings.push(screening);
  }
  schedule.screenings.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  saveManual(manual);
  saveSchedule(schedule);

  console.log(
    color.green(`\nAdded ${film.title}${film.year ? ` (${film.year})` : ''} at ${venueId} on ${formatDateHeading(date)}: ${times.map(formatTime12).join(', ')}`),
  );
  console.log(color.dim('Edit or remove entries in data/manual.json; sync will respect them.'));
  closePrompt();
}

main().catch((err) => {
  console.error(err);
  closePrompt();
  process.exit(1);
});
