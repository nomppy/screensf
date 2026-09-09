import { fetchJson, fetchTextCached } from '../lib/http.ts';
import { horizonEndLA, todayLA } from '../lib/dates.ts';
import type { RawScreening, Venue } from '../lib/types.ts';

/**
 * landmarktheatres.com is a Gatsby build on Webedia's "Boxoffice" platform;
 * the HTML has no showtimes. The page calls its own JSON proxy instead:
 *
 *   /api/gatsby-source-boxofficeapi/schedule
 *       ?theaters={"id":"X00U8","timeZone":"America/Los_Angeles"}
 *       &from=YYYY-MM-DD&to=YYYY-MM-DD&withoutOffset=true
 *     -> { [theaterId]: { schedule: { [movieId]: { [date]: Showtime[] } } } }
 *        Showtime.startsAt is local wall time ("2026-10-03T13:00:00"),
 *        Showtime.tags carries formats ("Format.Projection.70mm").
 *   /api/gatsby-source-boxofficeapi/movies?ids=1&ids=2   -> Movie[] (title, poster)
 *
 * Theatre codes (X00U8 = Opera Plaza) are the first path segment of the
 * theatre page URL, /theaters/x00u8-landmark-opera-plaza-cinema-san-francisco/,
 * which `venue.calendarUrl` points at; one scraper serves every Landmark
 * venue. Series and Q&A names come from the Gatsby static query `allEvent`
 * (events list their theatres and related movie ids), reached through the
 * theatre's page-data.json. A theatre that no longer exists 404s on its page
 * and yields []. Embarcadero, Shattuck and Albany Twin are gone from the
 * site as of September 2026.
 */
const WEEKS = 5;
const TZ = 'America/Los_Angeles';
const API = '/api/gatsby-source-boxofficeapi';

interface Showtime {
  id: string;
  startsAt: string;
  tags?: string[];
  data?: { ticketing?: { urls?: string[]; provider?: string }[] };
}
type Schedule = Record<string, { schedule?: Record<string, Record<string, Showtime[]>> }>;

interface Movie {
  id: string;
  title?: string;
  poster?: string;
  locale?: { title?: string };
}

interface EventNode {
  title?: string;
  type?: string;
  theaters?: { id: string }[];
  relatedMovies?: { movie?: { id?: string } }[];
}

const NOTE_TYPES = /series|q&a|special|festival|late|sneak|introduction/i;

export async function scrapeLandmark(venue: Venue): Promise<RawScreening[]> {
  const pageUrl = venue.calendarUrl ?? venue.url;
  const origin = new URL(pageUrl).origin;
  const code = theaterCode(pageUrl);
  if (!code) {
    console.warn(`  ${venue.id}: cannot read a Landmark theatre code from ${pageUrl}`);
    return [];
  }

  // The theatre page itself: a 404 means Landmark no longer lists it.
  let pagePath: string;
  try {
    pagePath = new URL(pageUrl).pathname.replace(/\/$/, '');
    await fetchTextCached(pageUrl, 24 * 60 * 60 * 1000);
  } catch (err) {
    console.warn(`  ${venue.id}: theatre page ${pageUrl} failed (${(err as Error).message}); closed?`);
    return [];
  }

  const from = todayLA();
  const to = horizonEndLA(WEEKS);
  const theaters = encodeURIComponent(JSON.stringify({ id: code, timeZone: TZ }));
  const sched = await fetchJson<Schedule>(
    `${origin}${API}/schedule?theaters=${theaters}&from=${from}&to=${to}&withoutOffset=true`,
    { headers: { accept: 'application/json' } },
  );
  const byMovie = sched[code]?.schedule ?? {};
  const movieIds = Object.keys(byMovie);
  if (!movieIds.length) {
    console.warn(`  ${venue.id}: schedule API returned no showtimes for ${code}`);
    return [];
  }

  const movies = await fetchMovies(origin, movieIds);
  const notes = await eventNotes(origin, pagePath, code);

  const out: RawScreening[] = [];
  for (const [movieId, days] of Object.entries(byMovie)) {
    const movie = movies.get(movieId);
    const rawTitle = (movie?.title ?? movie?.locale?.title ?? '').replace(/\s+/g, ' ').trim();
    if (!rawTitle) {
      console.warn(`  ${venue.id}: no title for movie ${movieId}, skipping`);
      continue;
    }
    const url = `${origin}/movies/${movieId}-${slugify(rawTitle)}/`;
    const note = notes.get(movieId);
    for (const shows of Object.values(days)) {
      for (const s of shows) {
        try {
          const when = localParts(s.startsAt);
          if (!when || when.date < from || when.date > to) continue;
          out.push({
            venueId: venue.id,
            rawTitle,
            date: when.date,
            time: when.time,
            url,
            note: note ?? subtitleNote(s.tags ?? []),
            format: formatFrom(s.tags ?? []),
            image: movie?.poster,
          });
        } catch (err) {
          console.warn(`  ${venue.id}: bad showtime ${s.id}: ${(err as Error).message}`);
        }
      }
    }
  }
  return out;
}

/** "/theaters/x00u8-landmark-opera-plaza…" or "/our-locations/x00u8-…" -> "X00U8". */
function theaterCode(url: string): string | null {
  const m = new URL(url).pathname.match(/\/([a-z][0-9a-z]{4})(?:-[a-z0-9-]*)?\/?$/i);
  return m ? m[1].toUpperCase() : null;
}

async function fetchMovies(origin: string, ids: string[]): Promise<Map<string, Movie>> {
  const movies = new Map<string, Movie>();
  for (let i = 0; i < ids.length; i += 50) {
    const q = ids
      .slice(i, i + 50)
      .map((id) => `ids=${encodeURIComponent(id)}`)
      .join('&');
    try {
      const list = await fetchJson<Movie[]>(`${origin}${API}/movies?${q}`, { headers: { accept: 'application/json' } });
      for (const m of list) if (m?.id) movies.set(String(m.id), m);
    } catch (err) {
      console.warn(`  landmark: movies lookup failed: ${(err as Error).message}`);
    }
  }
  return movies;
}

/**
 * movieId -> event title for events (film series, Q&As, festivals…) that
 * name this theatre. Gatsby's static queries are content-addressed, so the
 * theatre's page-data.json is read for the hash list and each query fetched
 * (cached) until the one holding `allEvent` turns up. Best effort.
 */
async function eventNotes(origin: string, pagePath: string, code: string): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  const DAY = 24 * 60 * 60 * 1000;
  try {
    const pd = JSON.parse(await fetchTextCached(`${origin}/page-data${pagePath}/page-data.json`, DAY)) as {
      staticQueryHashes?: string[];
    };
    let nodes: EventNode[] | undefined;
    for (const hash of pd.staticQueryHashes ?? []) {
      try {
        const text = await fetchTextCached(`${origin}/page-data/sq/d/${hash}.json`, DAY);
        if (!text.includes('"allEvent"')) continue;
        const data = JSON.parse(text) as { data?: { allEvent?: { nodes?: EventNode[] } } };
        const found = data.data?.allEvent?.nodes;
        if (found?.length) {
          nodes = found;
          break;
        }
      } catch {
        /* try the next hash */
      }
    }
    for (const ev of nodes ?? []) {
      const title = (ev.title ?? '').replace(/\s+/g, ' ').trim();
      if (!title || title.length > 160) continue;
      if (!ev.theaters?.some((t) => t.id === code)) continue;
      if (!NOTE_TYPES.test(ev.type ?? '')) continue;
      for (const rm of ev.relatedMovies ?? []) {
        const id = rm.movie?.id;
        if (id && !notes.has(String(id))) notes.set(String(id), title);
      }
    }
  } catch (err) {
    console.warn(`  landmark: events lookup failed: ${(err as Error).message}`);
  }
  return notes;
}

/**
 * With withoutOffset=true the API gives theatre-local wall time without a
 * zone; if an offset or Z is ever present, convert through Intl instead.
 */
function localParts(iso: string): { date: string; time: string } | null {
  const plain = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (plain) return { date: plain[1], time: plain[2] };
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` };
}

function formatFrom(tags: string[]): string | undefined {
  const t = tags.join(' ').toLowerCase();
  if (t.includes('format.projection.70mm')) return '70mm';
  if (t.includes('format.projection.35mm')) return '35mm';
  if (t.includes('format.projection.16mm')) return '16mm';
  if (t.includes('format.projection.imax')) return 'IMAX';
  if (t.includes('format.projection.3d')) return '3D';
  if (t.includes('format.projection.4k')) return '4K';
  return undefined;
}

function subtitleNote(tags: string[]): string | undefined {
  return tags.some((t) => /Accessibility\.Subtitled|Localization\.Language\./.test(t)) ? 'Subtitled' : undefined;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
