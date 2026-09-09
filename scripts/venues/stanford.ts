import * as cheerio from 'cheerio';
import { fetchText } from '../lib/http.ts';
import { horizonEndLA, todayLA, ymd } from '../lib/dates.ts';
import type { RawScreening, Venue } from '../lib/types.ts';

/**
 * stanfordtheatre.org is hand-written static HTML. The home page links to the
 * current season's schedule as `calendars/<Season Name> <Year>.html` (the
 * "Current Calendar" button); `calendars/index.html` lists past seasons. When
 * the theatre is dark the button is missing or the page holds no playdates,
 * and we return [].
 *
 * A schedule page is one <table class="calendar">. Each <td class="playdate">
 * is a run of days: a <p class="date"> ("September 11-13", "April 30-May 1",
 * "February 28 - March 1", "July 10") followed by one <p> per film:
 *
 *   <p><a href="imdb…">Tin Pan Alley</a> (1940) 5:45, 9:30</p>
 *   <p><a href="imdb…">Alexander's Ragtime Band</a> (1938) 7:30 (plus 3:45 Sat/Sun)</p>
 *
 * Times are 12-hour with no am/pm (the theatre never opens before noon), and
 * "(plus 3:45 Sat/Sun)" adds a matinee on just those weekdays. Older pages
 * put the year inside the link text, the times in a following <p>, or write
 * "(sound, 1930)" and "9:15 (approximately)". Other short <p>s are programme
 * notes ("Silent film with Dennis James on the Wurlitzer organ", "Print
 * courtesy of the Academy Film Archive"). The year comes from the banner
 * ("September 11 - 27, 2026") or the page's file name.
 *
 * The two films in a cell are one admission, so each gets
 * "Double feature with <other>" in its note.
 */
export async function scrapeStanford(venue: Venue): Promise<RawScreening[]> {
  const base = venue.url.replace(/\/$/, '');
  const home = await fetchText(`${base}/`);
  const $ = cheerio.load(home);

  const pages = new Set<string>();
  $('a[href*="calendars/"]').each((_, a) => {
    const href = ($(a).attr('href') ?? '').trim();
    if (!href || /index\.html$/i.test(href)) return;
    pages.add(new URL(href, `${base}/`).toString());
  });
  if (!pages.size) {
    console.warn('  stanford: no current calendar linked from the home page (theatre dark?)');
    return [];
  }

  const today = todayLA();
  const horizon = horizonEndLA(5);
  const out: RawScreening[] = [];
  for (const url of pages) {
    try {
      const html = await fetchText(url);
      out.push(...parseCalendar(html, url, venue).filter((s) => s.date >= today && s.date <= horizon));
    } catch (err) {
      console.warn(`  stanford: ${url} failed: ${(err as Error).message}`);
    }
  }
  return dedupe(out);
}

interface FilmEntry {
  kind: 'film';
  title: string;
  /** Screening times per weekday (0 = Sunday); `all` applies every day. */
  times: string[];
  extra: { times: string[]; days: number[] }[];
  notes: string[];
}
interface NoteEntry {
  kind: 'note';
  text: string;
}

const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const BOILERPLATE = /subject to change|^closed$|^(mon|tues|wednes|thurs|fri|satur|sun)day(\s*-\s*\w+day)?$|^silent films? this week$|^&nbsp;$/i;

function parseCalendar(html: string, url: string, venue: Venue): RawScreening[] {
  const $ = cheerio.load(html);
  const banner = $('.banner').text().replace(/\s+/g, ' ');
  const yearMatch = banner.match(/\b(20\d{2})\b/) ?? decodeURIComponent(url).match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
  const hintMonth = monthOf(banner) ?? 1;

  const out: RawScreening[] = [];
  $('td.playdate').each((_, td) => {
    try {
      const $td = $(td);
      const dateText = $td.find('p.date').first().text().replace(/ /g, ' ').trim();
      const days = dateText ? expandDates(dateText, year, hintMonth) : [];
      if (!days.length) return;

      const entries: (FilmEntry | NoteEntry)[] = [];
      $td.find('p').each((_, p) => {
        const $p = $(p);
        if ($p.hasClass('date')) return;
        const text = $p.text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
        if (!text || BOILERPLATE.test(text)) return;

        const film = parseFilmLine($p, text);
        if (film) {
          entries.push(film);
          return;
        }
        // A bare times line belongs to the film just above it.
        const last = entries[entries.length - 1];
        if (last?.kind === 'film' && !last.times.length && !last.extra.length && /^\d{1,2}:\d{2}/.test(text)) {
          Object.assign(last, parseTimes(text));
          return;
        }
        if (text.length <= 160) entries.push({ kind: 'note', text });
      });

      const films = entries.filter((e): e is FilmEntry => e.kind === 'film');
      if (!films.length) return;
      attachNotes(entries, films);

      for (const film of films) {
        const partner = films.length === 2 ? films.find((f) => f !== film) : undefined;
        const noteParts = [partner ? `Double feature with ${stripYear(partner.title)}` : '', ...film.notes].filter(Boolean);
        const note = noteParts.length ? noteParts.join('; ').slice(0, 160) : undefined;
        for (const date of days) {
          const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
          const times = new Set(film.times);
          for (const ex of film.extra) if (!ex.days.length || ex.days.includes(dow)) ex.times.forEach((t) => times.add(t));
          for (const time of times) out.push({ venueId: venue.id, rawTitle: film.title, date, time, url, note });
        }
      }
    } catch (err) {
      console.warn(`  stanford: skipped a playdate cell: ${(err as Error).message}`);
    }
  });
  return out;
}

/** "Title (1940) 5:45, 9:30" / "<a>Title (1964)</a>" + times elsewhere / "Title (sound, 1930) 7:30". */
function parseFilmLine($p: cheerio.Cheerio<any>, text: string): FilmEntry | null {
  const m = text.match(/^(.*?)\s*\(([^()]*?\b(1[89]\d{2}|20\d{2}))\)\s*(.*)$/);
  if (!m) return null;
  let title = m[1].trim();
  if (!title) title = $p.find('a').first().text().replace(/\s+/g, ' ').trim();
  if (!title || /^(plus|note)\b/i.test(title)) return null;
  const rest = m[4].trim();
  return { kind: 'film', title: `${title} (${m[3]})`, ...parseTimes(rest), notes: [] };
}

/** "7:30 (plus 3:45 Sat/Sun)" -> base times plus weekday-restricted extras. */
function parseTimes(text: string): { times: string[]; extra: FilmEntry['extra'] } {
  const extra: FilmEntry['extra'] = [];
  let rest = text.replace(/\((?:approx\w*\.?)\)/gi, '');
  rest = rest.replace(/\(?\bplus\b([^()]*)\)?/gi, (_, clause: string) => {
    const times = timesIn(clause);
    const days = [...clause.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/gi)].map((d) => DAY_INDEX[d[1].toLowerCase()]);
    if (times.length) extra.push({ times, days });
    return '';
  });
  return { times: timesIn(rest), extra };
}

/** Clock times with no am/pm: the theatre has no morning shows, so 1-11 are PM. */
function timesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/gi)) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 12 || min > 59) continue;
    const ap = m[3]?.toLowerCase();
    if (ap?.startsWith('a')) {
      if (h === 12) h = 0;
    } else if (h < 12) {
      h += 12;
    }
    out.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Programme notes sit above or below the film they describe. One naming a
 * film in the cell goes to it; "Plus rare co-feature" introduces the next
 * film; anything else describes the film just above it, or the first film
 * when it opens the cell.
 */
function attachNotes(entries: (FilmEntry | NoteEntry)[], films: FilmEntry[]) {
  entries.forEach((e, i) => {
    if (e.kind !== 'note') return;
    const named = films.find((f) => e.text.toLowerCase().includes(stripYear(f.title).toLowerCase()));
    const before = entries.slice(0, i).reverse().find((x): x is FilmEntry => x.kind === 'film');
    const after = entries.slice(i + 1).find((x): x is FilmEntry => x.kind === 'film');
    const target = named ?? (/^plus\b/i.test(e.text) ? after : before) ?? after ?? before;
    if (target && !target.notes.includes(e.text)) target.notes.push(e.text);
  });
}

/** "September 11-13", "April 30-May 1", "February 28 - March 1", "July 10" -> every date in the run. */
function expandDates(text: string, year: number, hintMonth: number): string[] {
  const m = text.match(/^([a-z]+)\.?\s+(\d{1,2})(?:\s*[-–—]\s*(?:([a-z]+)\.?\s+)?(\d{1,2}))?/i);
  if (!m) return [];
  const m1 = monthOf(m[1]);
  if (!m1) return [];
  const m2 = (m[3] && monthOf(m[3])) || m1;
  const d1 = Number(m[2]);
  const d2 = m[4] ? Number(m[4]) : d1;
  // A season that started in autumn spills into the next calendar year.
  const y1 = m1 < hintMonth - 6 ? year + 1 : year;
  const y2 = m2 < m1 ? y1 + 1 : y1;
  const start = Date.UTC(y1, m1 - 1, d1);
  const end = Date.UTC(y2, m2 - 1, d2);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 31 * 86_400_000) return [];
  const out: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    const d = new Date(t);
    out.push(ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
  }
  return out;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function monthOf(text: string): number | null {
  const m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
  return m ? MONTHS[m[1].toLowerCase()] : null;
}

function stripYear(title: string): string {
  return title.replace(/\s*\((1[89]|20)\d{2}\)$/, '');
}

function dedupe(list: RawScreening[]): RawScreening[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = `${s.rawTitle}|${s.date}|${s.time}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
