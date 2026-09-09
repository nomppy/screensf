import { fetchJson } from '../lib/http.ts';
import { horizonEndLA, todayLA } from '../lib/dates.ts';
import type { RawScreening, Venue } from '../lib/types.ts';

/**
 * drafthouse.com is a single-page app fed by Alamo's "mother" API. One
 * unauthenticated GET returns the whole market's schedule:
 *
 *   https://drafthouse.com/s/mother/v2/schedule/market/<market>   (sf)
 *
 * `data.market[0].cinemas[]` lists the market's theaters (New Mission is id
 * "0801", slug "new-mission"); `data.presentations[]` is one entry per film
 * or event run (show title, poster/hero art, `superTitle` = series such as
 * "Terror Tuesday" / "Weird Wednesday", `event`/`eventType` = "Movie Party",
 * "Live Q&A", ...); `data.sessions[]` is one entry per showtime with
 * `cinemaId`, `presentationSlug`, `showTimeUtc` (no "Z" suffix),
 * `formatSlug` ("35mm", "2d-digital", "hdr", "the-big-show") and
 * `sessionAttributeSlugs` ("35MM", "BD" baby day, "KF" kid friendly).
 *
 * The site's routes are /<market>/show/<presentationSlug> for the film page
 * and the same URL with ?cinemaId=&sessionId= for a specific showtime, which
 * is what we link to. The feed runs months ahead, so we clip to the horizon.
 */
interface DhImage {
  uri?: string | null;
}

interface DhPresentation {
  slug: string;
  isHidden?: boolean;
  formatSlugs?: string[];
  superTitle?: { superTitle?: string | null } | null;
  eventType?: { slug?: string; title?: string | null } | null;
  event?: {
    eventTypeTitleOverride?: string | null;
    headline?: string | null;
    runtimeMinutes?: number | null;
  } | null;
  show: {
    title: string;
    posterImages?: DhImage[] | null;
    landscapeHeroImage?: DhImage | null;
  };
}

interface DhSession {
  cinemaId: string;
  sessionId: string;
  presentationSlug: string;
  status?: string;
  showTimeUtc?: string | null;
  showTimeClt?: string | null;
  formatSlug?: string | null;
  sessionAttributeSlugs?: string[];
  isHidden?: boolean;
}

interface DhSchedule {
  data: {
    market?: { slug: string; cinemas?: { id: string; slug: string; name: string }[] }[];
    presentations?: DhPresentation[];
    sessions?: DhSession[];
  };
}

const API = 'https://drafthouse.com/s/mother/v2/schedule/market';
const DEFAULT_CINEMA_SLUG = 'new-mission';
const WEEKS = 5;

export async function scrapeAlamo(venue: Venue): Promise<RawScreening[]> {
  // venue.url is https://drafthouse.com/<market>; calendarUrl, if set, is the
  // theater page https://drafthouse.com/<market>/theater/<cinema-slug>.
  const market = new URL(venue.url).pathname.split('/').filter(Boolean)[0] ?? 'sf';
  const cinemaSlug = venue.calendarUrl?.match(/\/theater\/([a-z0-9-]+)/i)?.[1] ?? DEFAULT_CINEMA_SLUG;
  const base = `https://drafthouse.com/${market}`;

  const feed = await fetchJson<DhSchedule>(`${API}/${market}`, { headers: { accept: 'application/json' } });
  const cinemas = feed.data.market?.flatMap((m) => m.cinemas ?? []) ?? [];
  const cinema = cinemas.find((c) => c.slug === cinemaSlug);
  if (!cinema) {
    console.warn(`  ${venue.id}: cinema "${cinemaSlug}" not in market ${market} (have ${cinemas.map((c) => c.slug).join(', ')})`);
    return [];
  }

  const presentations = new Map<string, DhPresentation>();
  for (const p of feed.data.presentations ?? []) if (p?.slug) presentations.set(p.slug, p);

  const today = todayLA();
  const horizon = horizonEndLA(WEEKS);
  const out: RawScreening[] = [];

  for (const s of feed.data.sessions ?? []) {
    try {
      if (s.cinemaId !== cinema.id || s.isHidden) continue;
      if (s.status && /cancel/i.test(s.status)) continue;
      const p = presentations.get(s.presentationSlug);
      if (!p || p.isHidden) {
        if (!p) console.warn(`  ${venue.id}: session ${s.sessionId} has unknown presentation ${s.presentationSlug}`);
        continue;
      }

      const when = s.showTimeUtc ? laParts(Date.parse(s.showTimeUtc.replace(/Z?$/, 'Z'))) : fromClt(s.showTimeClt);
      if (!when) {
        console.warn(`  ${venue.id}: session ${s.sessionId} has no usable showtime`);
        continue;
      }
      if (when.date < today || when.date > horizon) continue;

      const rawTitle = stripTags(p.show.title);
      if (!rawTitle) continue;

      out.push({
        venueId: venue.id,
        rawTitle,
        date: when.date,
        time: when.time,
        url: `${base}/show/${p.slug}?cinemaId=${cinema.id}&sessionId=${s.sessionId}`,
        note: noteFor(p, s),
        format: formatFor(p, s),
        image: p.show.posterImages?.find((i) => i?.uri)?.uri ?? p.show.landscapeHeroImage?.uri ?? undefined,
      });
    } catch (err) {
      console.warn(`  ${venue.id}: session ${s?.sessionId} skipped: ${(err as Error).message}`);
    }
  }
  return out;
}

function laParts(ms: number): { date: string; time: string } | null {
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
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

/** "2026-12-15T18:00:00" cinema-local time, used only when the UTC stamp is missing. */
function fromClt(clt?: string | null): { date: string; time: string } | null {
  const m = clt?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? { date: m[1], time: m[2] } : null;
}

/** Series name, event type ("Movie Party", "Live Q&A") and per-show flags. */
function noteFor(p: DhPresentation, s: DhSession): string | undefined {
  const parts: string[] = [];
  const series = p.superTitle?.superTitle?.trim();
  if (series) parts.push(series);

  const label = (p.event?.eventTypeTitleOverride ?? p.eventType?.title ?? '').replace(/^\s*(w\/|with)\s+/i, '').trim();
  // "Special Event" says nothing; "on 35mm" is a format; "September 2026" is a date.
  if (
    label &&
    !/^special event$/i.test(label) &&
    !/^(on\s+)?\d+\s*mm$/i.test(label) &&
    !/^[a-z]+\s+\d{4}$/i.test(label) &&
    !parts.some((x) => singular(x).includes(singular(label)))
  ) {
    parts.push(label);
  }

  const headline = p.event?.headline?.replace(/\s+/g, ' ').trim();
  if (headline && headline.length <= 120 && !parts.includes(headline)) parts.push(headline);

  const attrs = s.sessionAttributeSlugs ?? [];
  if (attrs.includes('BD')) parts.push('Baby Day');
  if (attrs.includes('KF')) parts.push('Kid Friendly');

  return parts.length ? parts.join(' · ') : undefined;
}

/** "Movie Parties" vs "Movie Party": compare series and event type loosely. */
function singular(s: string): string {
  return s.toLowerCase().replace(/ies\b/g, 'y').replace(/s\b/g, '');
}

/** Only real projection formats; "2d-digital", "hdr" and "the-big-show" are screen branding. */
function formatFor(p: DhPresentation, s: DhSession): string | undefined {
  const film = /^(35|70|16)mm$/i;
  const fromSession = [s.formatSlug ?? '', ...(s.sessionAttributeSlugs ?? [])].find((f) => film.test(f));
  if (fromSession) return fromSession.toLowerCase();
  const fromPresentation = (p.formatSlugs ?? []).filter((f) => film.test(f));
  if (fromPresentation.length === 1 && (p.formatSlugs ?? []).length === 1) return fromPresentation[0].toLowerCase();
  const text = `${p.show.title} ${p.event?.eventTypeTitleOverride ?? ''}`;
  if (/\b(35|70|16)\s*mm\b/i.test(text)) return text.match(/\b(35|70|16)\s*mm\b/i)![1] + 'mm';
  if (/\b4k\b/i.test(text)) return '4K';
  return undefined;
}

/** Titles occasionally carry the site's own markup ("<show-title>…</show-title>"). */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
