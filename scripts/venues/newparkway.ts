import { fetchJson } from '../lib/http.ts';
import { horizonEndLA, todayLA } from '../lib/dates.ts';
import type { RawScreening, Venue } from '../lib/types.ts';

/**
 * thenewparkway.com is an Indy Cinema Systems single-page app: the HTML is an
 * empty shell and everything comes from a GraphQL endpoint proxied at
 * /graphql on the site's own host. The API multi-tenants by request headers
 * that the JS bundle hard-codes for this site (`site-id: 383`,
 * `circuit-id: 166`, `client-type: consumer`); without them every query
 * answers for no site at all (empty lists, or 403). Introspection is off, but
 * the schema follows the bundle's model definitions: list queries return
 * `{ data [...] count isMore }`.
 *
 * We use two queries:
 *  - `currentAndUpcomingMovies`: every listed title with `urlSlug`,
 *    `posterImage` (an imgix key), `titleClass` ("Film", "Free Events") and
 *    `showingBadges`. Non-film events (trivia, bingo) live here too; they are
 *    kept, with the class in `note`, for the classifier to sort out.
 *  - `showingsForDate(date)`: one call per local day in the horizon, returning
 *    each showing's UTC `time`, `movie`, `screen` and badges. Unpublished and
 *    private showings are dropped.
 *
 * Titles are kept verbatim; series tags the venue appends ("(Noirvember)",
 * "(Pasta at the Parkway)", ", with Filmmaker Q & A") are copied into `note`.
 * Movie pages are /movie/<urlSlug>/ on the apex host (www redirects).
 */
const SITE_HEADERS = { 'site-id': '383', 'circuit-id': '166', 'client-type': 'consumer' };
const IMGIX = 'https://indy-systems.imgix.net';

interface NpMovie {
  id: string;
  name: string;
  urlSlug?: string | null;
  posterImage?: string | null;
  titleClass?: { name?: string | null } | null;
  showingBadges?: { title?: string | null }[] | null;
}

interface NpShowing {
  id: string;
  time: string;
  published?: boolean;
  private?: boolean;
  isPreview?: boolean;
  movie?: NpMovie | null;
  screen?: { name?: string | null } | null;
  showingBadges?: { title?: string | null }[] | null;
}

interface GqlResponse<T> {
  data?: T | null;
  errors?: { message: string }[];
}

const MOVIE_FIELDS = 'id name urlSlug posterImage titleClass { name } showingBadges { title }';

export async function scrapeNewParkway(venue: Venue): Promise<RawScreening[]> {
  const origin = new URL(venue.url).origin.replace('://www.', '://');
  const gql = `${origin}/graphql`;

  // Movie metadata once, keyed by id; showings only carry a thin movie stub.
  const movies = new Map<string, NpMovie>();
  try {
    const res = await query<{ currentAndUpcomingMovies: { data: NpMovie[] } }>(
      gql,
      `{ currentAndUpcomingMovies { data { ${MOVIE_FIELDS} } count } }`,
    );
    for (const m of res.currentAndUpcomingMovies?.data ?? []) movies.set(m.id, m);
    if (!movies.size) console.warn('  newparkway: movie list came back empty (site headers stale?)');
  } catch (err) {
    console.warn(`  newparkway: movie list failed: ${(err as Error).message}`);
  }

  const out: RawScreening[] = [];
  const seen = new Set<string>();
  for (const date of dateRange(todayLA(), horizonEndLA(5))) {
    try {
      const res = await query<{ showingsForDate: { data: NpShowing[] } }>(
        gql,
        `{ showingsForDate(date: "${date}") { data { id time published private isPreview screen { name } showingBadges { title } movie { ${MOVIE_FIELDS} } } count } }`,
      );
      for (const s of res.showingsForDate?.data ?? []) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        try {
          const r = fromShowing(s, movies, origin, venue);
          if (r) out.push(r);
        } catch (err) {
          console.warn(`  newparkway: showing ${s.id} skipped: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.warn(`  newparkway: ${date} failed: ${(err as Error).message}`);
    }
  }
  return out;
}

async function query<T>(url: string, q: string): Promise<T> {
  const res = await fetchJson<GqlResponse<T>>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...SITE_HEADERS },
    body: JSON.stringify({ query: q }),
  });
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; ').slice(0, 300));
  if (!res.data) throw new Error('empty GraphQL response');
  return res.data;
}

function fromShowing(s: NpShowing, movies: Map<string, NpMovie>, origin: string, venue: Venue): RawScreening | null {
  if (s.published === false || s.private) return null;
  const stub = s.movie;
  if (!stub?.name) return null;
  const movie = { ...stub, ...(movies.get(stub.id) ?? {}) };
  const title = movie.name.replace(/\s+/g, ' ').trim();

  const { date, time } = laParts(s.time);
  if (!date || !time) return null;

  const notes: string[] = [];
  const parens = [...title.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].trim());
  for (const p of parens) {
    if (/^(1[89]|20)\d{2}$/.test(p) || FORMAT_RE.test(p) || /^(subtitled|dubbed)$/i.test(p)) continue;
    notes.push(p);
  }
  const suffix = title.match(/,\s+((?:with|co-presented|presented|featuring|plus)\b.*)$/i);
  if (suffix) notes.push(suffix[1].replace(/\s*\([^()]*\)\s*$/, '').trim());
  if (s.isPreview) notes.push('Preview screening');
  const cls = movie.titleClass?.name?.trim();
  if (cls && !/^film$/i.test(cls)) notes.push(cls);
  for (const b of [...(movie.showingBadges ?? []), ...(s.showingBadges ?? [])]) {
    const t = b?.title?.trim();
    if (t && !/^film$/i.test(t) && !notes.includes(t)) notes.push(t);
  }
  const note = notes.length ? notes.join('; ').slice(0, 160) : undefined;

  const fm = title.match(FORMAT_RE);
  const format = fm ? (/mm$/i.test(fm[1]) ? fm[1].toLowerCase() : fm[1].toUpperCase()) : undefined;

  const url = movie.urlSlug ? `${origin}/movie/${movie.urlSlug}/` : `${origin}/now-playing/`;
  const image = movie.posterImage ? `${IMGIX}/${movie.posterImage}?fit=crop&w=1000&h=1500&fm=jpeg&auto=format,compress` : undefined;

  return { venueId: venue.id, rawTitle: title, date, time, url, note, format, image };
}

const FORMAT_RE = /\b(35mm|70mm|16mm|4K|DCP)\b/i;

function laParts(iso: string): { date: string | null; time: string | null } {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { date: null, time: null };
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

/** Every YYYY-MM-DD from `from` to `to` inclusive. */
function dateRange(from: string, to: string): string[] {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const out: string[] = [];
  for (let t = Date.UTC(fy, fm - 1, fd); t <= Date.UTC(ty, tm - 1, td); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
