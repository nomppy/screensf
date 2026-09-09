export interface Venue {
  id: string;
  name: string;
  shortName: string;
  city: string;
  url: string;
  enabled: boolean;
  scraper?: string;
  calendarUrl?: string;
}

/** A single showtime as scraped from a venue, before any TMDB enrichment. */
export interface RawScreening {
  venueId: string;
  /** Title exactly as the venue lists it. */
  rawTitle: string;
  /** Local date, YYYY-MM-DD (America/Los_Angeles). */
  date: string;
  /** Local time, HH:MM 24h. */
  time: string;
  /** Venue's event page or ticket link. */
  url: string;
  /** Free text the venue attached: Q&A, live score, etc. */
  note?: string;
  /** Projection format if the venue states it: 35mm, 70mm, 16mm, 4K, DCP. */
  format?: string;
  /** Artwork from the venue's own listing (Squarespace asset, og:image). */
  image?: string;
  /** Director(s) as the venue lists them, when the listing says. Used to confirm the TMDB match. */
  director?: string;
  /** Release year as the venue lists it. */
  year?: number;
  /** Runtime in minutes as the venue lists it. */
  runtime?: number;
  /** The venue's own programme note / synopsis, plain text with paragraph breaks. */
  synopsis?: string;
}

/** What the venue itself said about the film, pooled across its showtimes. */
export interface VenueHints {
  director?: string;
  year?: number;
  runtime?: number;
  synopsis?: string;
}

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
  popularity?: number;
  releaseDate?: string;
  /** Present when TMDB placed this film in the US "now playing" list at sync time. */
  nowPlaying?: boolean;
  /** TMDB synopsis, shown in the site's detail modal. */
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

export interface Festival {
  key: string;
  name: string;
  venueId: string;
  startDate: string;
  endDate: string;
  url: string;
  /** Number of individual showtimes folded into this entry. */
  showtimes: number;
  /** A few of the film titles listed under the festival, for the card. */
  sample: string[];
  /** Every showtime folded into this entry, for the festivals page. */
  programme?: { date: string; time: string; title: string; url: string; note?: string }[];
}

export interface ScheduleData {
  generatedAt: string | null;
  films: Record<string, Film>;
  screenings: Screening[];
  festivals?: Festival[];
}

export type Decision = 'include' | 'exclude';

export interface DecisionRecord {
  decision: Decision;
  title: string;
  /** Overrides the TMDB pick when the user chose an alternative match. */
  tmdbId?: number | null;
  /** Artwork override chosen in review: a URL (venue image or pasted). Absent = TMDB default. */
  image?: string;
  /** Hand-edited card details from review. Each present field replaces the TMDB value on the site. */
  edits?: FilmEdits;
  decidedAt: string;
}

/** Fields of a film card that can be overridden by hand in the review UI. */
export type FilmEdits = Partial<Pick<Film, 'title' | 'year' | 'director' | 'runtime' | 'genre' | 'overview'>>;

export interface TmdbMovie {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  popularity?: number;
  vote_count?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
  overview?: string;
}

export interface TmdbDetails extends TmdbMovie {
  runtime?: number;
  genres?: { id: number; name: string }[];
  credits?: { crew?: { job: string; name: string }[] };
  /** Every release TMDB knows about, per country: premieres, festivals, theatrical, digital… */
  release_dates?: { results?: { iso_3166_1: string; release_dates: { release_date: string; type: number }[] }[] };
}
