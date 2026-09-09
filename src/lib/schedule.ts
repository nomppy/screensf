import schedule from '../../data/screenings.json';
import venuesJson from '../../data/venues.json';

export interface Film {
  key: string;
  title: string;
  year?: number;
  director?: string;
  runtime?: number;
  genre?: string;
  poster?: string;
  backdrop?: string;
  tmdbId?: number;
  overview?: string;
}

export interface Screening {
  id: string;
  venueId: string;
  filmKey: string;
  date: string;
  time: string;
  url: string;
  note?: string;
  format?: string;
  source: string;
}

export interface Venue {
  id: string;
  name: string;
  shortName: string;
  city: string;
  url: string;
  enabled: boolean;
}

export interface Festival {
  key: string;
  name: string;
  venueId: string;
  startDate: string;
  endDate: string;
  url: string;
  showtimes: number;
  sample: string[];
  programme?: { date: string; time: string; title: string; url: string; note?: string }[];
}

/** One venue's showings of a film on one day. */
export interface Showing {
  venue: Venue;
  times: { time: string; url: string }[];
  format?: string;
  note?: string;
}

/** One card: a film on one day, with every venue showing it that day. */
export interface Card {
  film: Film;
  date: string;
  showings: Showing[];
  /** Convenience: the first showing's venue (cards used to be one venue each). */
  venue: Venue;
  /** All times across venues, earliest first. */
  times: { time: string; url: string; venueId: string }[];
  /** Format / note when every showing agrees, else undefined (shown per venue instead). */
  format?: string;
  note?: string;
}

export const SITE_NAME = 'Screen SF';
export const SITE_TAGLINE =
  'Repertory and independent film screenings around the San Francisco Bay Area.';

const films = schedule.films as Record<string, Film>;
const screenings = schedule.screenings as Screening[];
const venues = venuesJson as Venue[];
const festivals = ((schedule as { festivals?: Festival[] }).festivals ?? []) as Festival[];

export const generatedAt = schedule.generatedAt as string | null;

export function venueFor(id: string): Venue {
  const v = venues.find((x) => x.id === id);
  if (v) return v;
  const name = id.startsWith('other:') ? id.slice(6) : id;
  return { id, name, shortName: name, city: '', url: '', enabled: false };
}

export function todayLA(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

export function buildDays(): { date: string; cards: Card[] }[] {
  const today = todayLA();
  // date -> filmKey -> venueId -> showing
  const byDay = new Map<string, Map<string, Map<string, Showing>>>();
  for (const s of screenings) {
    if (s.date < today) continue;
    if (!films[s.filmKey]) continue;
    const day = byDay.get(s.date) ?? new Map<string, Map<string, Showing>>();
    const perFilm = day.get(s.filmKey) ?? new Map<string, Showing>();
    const showing = perFilm.get(s.venueId) ?? ({ venue: venueFor(s.venueId), times: [], format: s.format, note: s.note } satisfies Showing);
    showing.times.push({ time: s.time, url: s.url });
    showing.format ??= s.format;
    showing.note ??= s.note;
    perFilm.set(s.venueId, showing);
    day.set(s.filmKey, perFilm);
    byDay.set(s.date, day);
  }
  const same = <T>(xs: (T | undefined)[]) => (xs.every((x) => x === xs[0]) ? xs[0] : undefined);
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, perFilm]) => ({
      date,
      cards: [...perFilm.entries()]
        .map(([filmKey, venues]): Card => {
          const showings = [...venues.values()]
            .map((sh) => ({ ...sh, times: sh.times.sort((x, y) => x.time.localeCompare(y.time)) }))
            .sort((a, b) => a.times[0].time.localeCompare(b.times[0].time) || a.venue.shortName.localeCompare(b.venue.shortName));
          const times = showings
            .flatMap((sh) => sh.times.map((t) => ({ ...t, venueId: sh.venue.id })))
            .sort((x, y) => x.time.localeCompare(y.time));
          return { film: films[filmKey], date, showings, venue: showings[0].venue, times, format: same(showings.map((s) => s.format)), note: same(showings.map((s) => s.note)) };
        })
        .sort((x, y) => x.times[0].time.localeCompare(y.times[0].time)),
    }));
}

/** Festivals still running or upcoming, soonest first. */
export function upcomingFestivals(): Festival[] {
  const today = todayLA();
  return festivals.filter((f) => f.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate));
}

export function dateRange(start: string, end: string): string {
  const fmt = (d: string, opts: Intl.DateTimeFormatOptions) => {
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
  };
  if (start === end) return fmt(start, { weekday: 'short', month: 'short', day: 'numeric' });
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return `${fmt(start, { month: 'short', day: 'numeric' })} – ${fmt(end, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}`;
}

export function activeVenues(): Venue[] {
  const ids = new Set(screenings.filter((s) => s.date >= todayLA()).map((s) => s.venueId));
  return [...ids].map(venueFor).sort((a, b) => a.shortName.localeCompare(b.shortName));
}

export function headingFor(date: string, today = todayLA()): string {
  const [y, m, d] = date.split('-').map(Number);
  const label = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return date === today ? `Today · ${label}` : label;
}

export function time12(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

export function runtime(min?: number): string | null {
  if (!min) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}
