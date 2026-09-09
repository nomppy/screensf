import { fetchJson, JsonCache } from './http.ts';
import { normalizeTitle } from './titles.ts';
import type { VenueHints, Film, TmdbDetails, TmdbMovie } from './types.ts';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

function apiKey(): string {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    console.error('TMDB_API_KEY is not set. Copy .env.example to .env and add your key.');
    process.exit(1);
  }
  return key;
}

const searchCache = new JsonCache<TmdbMovie[]>('.cache/tmdb-search.json');
const detailsCache = new JsonCache<TmdbDetails>('.cache/tmdb-details.json');

export async function searchMovies(query: string, year?: number): Promise<TmdbMovie[]> {
  const cacheKey = `${query.toLowerCase()}|${year ?? ''}`;
  const hit = searchCache.get(cacheKey);
  if (hit) return hit;
  const url = new URL(`${API}/search/movie`);
  url.searchParams.set('api_key', apiKey());
  url.searchParams.set('query', query);
  url.searchParams.set('include_adult', 'false');
  if (year) url.searchParams.set('year', String(year));
  const data = await fetchJson<{ results: TmdbMovie[] }>(url.toString());
  const results = (data.results ?? []).slice(0, 8);
  searchCache.set(cacheKey, results);
  return results;
}

export async function movieDetails(id: number): Promise<TmdbDetails> {
  const hit = detailsCache.get(String(id));
  // Entries cached before release_dates was requested are refetched once.
  if (hit && hit.release_dates) return hit;
  const url = `${API}/movie/${id}?api_key=${apiKey()}&append_to_response=credits,release_dates`;
  const data = await fetchJson<TmdbDetails>(url);
  detailsCache.set(String(id), data);
  return data;
}

/**
 * Films currently in wide US release, per TMDB. Used as the "showing
 * everywhere" signal. Fetched fresh every run (not cached) because it changes
 * weekly.
 */
export async function nowPlayingIds(pages = 3): Promise<Map<number, TmdbMovie>> {
  const out = new Map<number, TmdbMovie>();
  for (let page = 1; page <= pages; page++) {
    try {
      const data = await fetchJson<{ results: TmdbMovie[] }>(
        `${API}/movie/now_playing?api_key=${apiKey()}&region=US&page=${page}`,
      );
      for (const m of data.results ?? []) out.set(m.id, m);
    } catch (err) {
      console.warn(`  now_playing page ${page} failed: ${(err as Error).message}`);
      break;
    }
  }
  return out;
}

export interface MatchResult {
  /** Best pick, or null when nothing plausible came back. */
  best: TmdbMovie | null;
  /** True when the best pick's title matches a candidate exactly. */
  confident: boolean;
  /** Other options to offer the user. */
  alternatives: TmdbMovie[];
}

/** Surname-level comparison of director names: "Kom Akkadej" vs "Akkadej Kom", diacritics and initials ignored. */
export function directorsAgree(a?: string, b?: string): boolean | undefined {
  if (!a || !b) return undefined;
  const names = (s: string) =>
    s
      .split(/,|&|\band\b|\//i)
      .map((n) => n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').trim())
      .filter(Boolean);
  const tokens = (n: string) => n.split(/\s+/).filter((t) => t.length > 1);
  for (const x of names(a)) for (const y of names(b)) {
    const tx = tokens(x), ty = tokens(y);
    if (!tx.length || !ty.length) continue;
    if (x === y) return true;
    // Same surname (last token) and the other tokens overlap or one side is a single name.
    if (tx[tx.length - 1] === ty[ty.length - 1] && (tx.length === 1 || ty.length === 1 || tx.some((t) => ty.includes(t) && t !== tx[tx.length - 1]))) return true;
    if (tx.length >= 2 && ty.length >= 2 && tx.every((t) => ty.includes(t))) return true;
  }
  return false;
}

const yearOf = (m: TmdbMovie) => (m.release_date ? Number(m.release_date.slice(0, 4)) : undefined);

/**
 * Try each candidate title in order. An exact normalized-title match wins
 * immediately. Otherwise keep the first non-empty result set and mark it
 * unconfident so the user gets asked.
 *
 * When the venue listed a director (and/or year), the results are checked
 * against TMDB credits: a director match confirms a film even when the
 * title differs, and an exact title whose director and year both disagree
 * is demoted so a same-named film does not slip through.
 */
export async function matchFilm(candidates: string[], yearHint?: number, hints: VenueHints = {}): Promise<MatchResult> {
  let fallback: TmdbMovie[] = [];
  const nearYear = (m: TmdbMovie) => hints.year !== undefined && yearOf(m) !== undefined && Math.abs((yearOf(m) as number) - hints.year) <= 1;
  for (const cand of candidates) {
    const norm = normalizeTitle(cand);
    if (!norm) continue;
    const results = await searchMovies(cand, yearHint);
    if (!results.length) continue;
    const exact = results.filter(
      (r) => normalizeTitle(r.title) === norm || (r.original_title && normalizeTitle(r.original_title) === norm),
    );

    // Director check: look up credits for the handful of plausible results.
    const byDirector = new Map<number, boolean | undefined>();
    if (hints.director) {
      const pool = [...exact, ...results.filter((r) => !exact.includes(r))].slice(0, 6);
      for (const r of pool) {
        try {
          const d = await movieDetails(r.id);
          const dir = d.credits?.crew?.filter((c) => c.job === 'Director').map((c) => c.name).join(', ');
          byDirector.set(r.id, directorsAgree(hints.director, dir));
        } catch {
          byDirector.set(r.id, undefined);
        }
      }
      const confirmed = pool.filter((r) => byDirector.get(r.id) === true);
      if (confirmed.length) {
        confirmed.sort((a, b) => (exact.includes(b) ? 1 : 0) - (exact.includes(a) ? 1 : 0) || (nearYear(b) ? 1 : 0) - (nearYear(a) ? 1 : 0) || (b.popularity ?? 0) - (a.popularity ?? 0));
        return { best: confirmed[0], confident: true, alternatives: results.filter((r) => r.id !== confirmed[0].id).slice(0, 4) };
      }
    }

    if (exact.length) {
      // Prefer the year hint, then the most popular.
      exact.sort((a, b) => {
        const y = yearHint ?? hints.year;
        if (y) {
          const ay = Math.abs((yearOf(a) ?? 0) - y) <= 1 ? 1 : 0;
          const by = Math.abs((yearOf(b) ?? 0) - y) <= 1 ? 1 : 0;
          if (ay !== by) return by - ay;
        }
        return (b.popularity ?? 0) - (a.popularity ?? 0);
      });
      const best = exact[0];
      // Exact title, but the venue's director and year both disagree: probably a different film with the same name.
      const contradicted = byDirector.get(best.id) === false && hints.year !== undefined && yearOf(best) !== undefined && !nearYear(best);
      return { best, confident: !contradicted, alternatives: results.filter((r) => r.id !== best.id).slice(0, 4) };
    }
    if (!fallback.length) fallback = results;
  }
  if (!fallback.length) return { best: null, confident: false, alternatives: [] };
  return { best: fallback[0], confident: false, alternatives: fallback.slice(1, 5) };
}

export async function movieOverview(id: number): Promise<string | undefined> {
  const d = await movieDetails(id);
  return d.overview || undefined;
}

export function describeMovie(m: TmdbMovie): string {
  const year = m.release_date?.slice(0, 4) ?? '????';
  return `${m.title} (${year})${m.popularity ? `  pop ${Math.round(m.popularity)}` : ''}`;
}

/**
 * The earliest date TMDB has for the film in any country, premieres and
 * festival screenings included. This is the date Letterboxd (and IMDb) show,
 * whereas `release_date` on the movie itself is the primary theatrical release
 * and can land a year later for films that toured festivals first.
 */
export function earliestRelease(d: TmdbDetails): string | undefined {
  let best: string | undefined = d.release_date || undefined;
  for (const country of d.release_dates?.results ?? []) {
    for (const r of country.release_dates ?? []) {
      const day = r.release_date?.slice(0, 10);
      if (day && (!best || day < best)) best = day;
    }
  }
  return best;
}

export async function filmFromTmdb(id: number, nowPlaying: boolean): Promise<Film> {
  const d = await movieDetails(id);
  const director = d.credits?.crew?.filter((c) => c.job === 'Director').map((c) => c.name).join(', ');
  const first = earliestRelease(d);
  return {
    key: `tmdb:${d.id}`,
    title: d.title,
    year: first ? Number(first.slice(0, 4)) : undefined,
    director: director || undefined,
    runtime: d.runtime || undefined,
    genre: d.genres?.[0]?.name,
    poster: d.poster_path ? `${IMG}/w500${d.poster_path}` : undefined,
    backdrop: d.backdrop_path ? `${IMG}/w780${d.backdrop_path}` : undefined,
    tmdbId: d.id,
    popularity: d.popularity,
    releaseDate: d.release_date || undefined,
    nowPlaying: nowPlaying || undefined,
    overview: d.overview || undefined,
  };
}
