import { fetchJson, JsonCache } from './http.ts';
import { normalizeTitle } from './titles.ts';
import type { Film, TmdbDetails, TmdbMovie } from './types.ts';

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

/**
 * Try each candidate title in order. An exact normalized-title match wins
 * immediately. Otherwise keep the first non-empty result set and mark it
 * unconfident so the user gets asked.
 */
export async function matchFilm(candidates: string[], yearHint?: number): Promise<MatchResult> {
  let fallback: TmdbMovie[] = [];
  for (const cand of candidates) {
    const norm = normalizeTitle(cand);
    if (!norm) continue;
    const results = await searchMovies(cand, yearHint);
    if (!results.length) continue;
    const exact = results.filter(
      (r) => normalizeTitle(r.title) === norm || (r.original_title && normalizeTitle(r.original_title) === norm),
    );
    if (exact.length) {
      // Prefer the year hint, then the most popular.
      exact.sort((a, b) => {
        if (yearHint) {
          const ay = a.release_date?.slice(0, 4) === String(yearHint) ? 1 : 0;
          const by = b.release_date?.slice(0, 4) === String(yearHint) ? 1 : 0;
          if (ay !== by) return by - ay;
        }
        return (b.popularity ?? 0) - (a.popularity ?? 0);
      });
      return { best: exact[0], confident: true, alternatives: results.filter((r) => r.id !== exact[0].id).slice(0, 4) };
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
