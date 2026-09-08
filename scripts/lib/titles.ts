/**
 * Venue titles carry series names, formats and marketing copy:
 *   "Arthouse 50: Freeway"
 *   "The Hole (Newly Struck 35mm Print)"
 *   "Akira 4K ~ 1:30 PM, 4:30 PM & 7:30 PM (Subtitled)"
 *   "Floating Features: Friday the 13th"
 * This module pulls out a format tag and produces candidate clean titles,
 * most-likely first, for the TMDB search to try in order.
 */

const FORMAT_RE = /\b(70\s?mm|35\s?mm|16\s?mm|8\s?mm|4k(?:\s+restoration)?|2k|dcp|imax|3-?d)\b/i;

/** Series prefixes we know are not part of a film title. Extend freely. */
const SERIES_PREFIXES = [
  'arthouse 50',
  'floating features',
  'roxie kids',
  'roxcine',
  'bay visions',
  'outlook',
  'animation obsession',
  'filikula',
  'staff picks',
  'silver screen club',
  'spoke art presents',
  'wild, weird, wicked',
  'midnites for maniacs',
  'peaches christ presents',
  'frameline',
  'sf indiefest',
];

const NOISE_PARENS =
  /\((?:[^()]*\b(?:print|restoration|subtitled|dubbed|remastered|director'?s cut|extended|anniversary|q&a|in person|sing-?along|35mm|70mm|16mm|4k|dcp|new)\b[^()]*)\)/gi;

export function extractFormat(raw: string): string | undefined {
  const m = raw.match(FORMAT_RE);
  if (!m) return undefined;
  const f = m[1].toLowerCase().replace(/\s+/g, '');
  if (f.startsWith('70')) return '70mm';
  if (f.startsWith('35')) return '35mm';
  if (f.startsWith('16')) return '16mm';
  if (f.startsWith('8')) return '8mm';
  if (f.startsWith('4k')) return '4K';
  if (f === 'imax') return 'IMAX';
  if (f.startsWith('3')) return '3D';
  return f.toUpperCase();
}

/** A year the venue put in the title, e.g. "Suspiria (1977)". */
export function extractYear(raw: string): number | undefined {
  const m = raw.match(/\((19|20)(\d{2})\)/);
  return m ? Number(m[1] + m[2]) : undefined;
}

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim();
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–—:]\s*$/, '')
    .replace(/^\s*[-–—:]\s*/, '')
    .trim();
}

export function cleanTitleCandidates(raw: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = tidy(s);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };

  let base = raw.replace(/\s+/g, ' ').trim();

  // CinemaSF puts showtimes after a tilde: "Akira 4K ~ 1:30 PM & 7:30 PM".
  base = base.split(/\s+~\s+/)[0];
  // Strip trailing showtime lists that survived, e.g. "Title 7 PM & 9:30 PM".
  base = base.replace(/(\s+\d{1,2}(:\d{2})?\s*[ap]m\b[\s,&and]*)+$/i, '');

  // Remove noisy parentheticals and bracketed notes, then bare format tokens.
  const noParens = base.replace(NOISE_PARENS, '').replace(/\[[^\]]*\]/g, '');
  const noFormat = noParens
    .replace(FORMAT_RE, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+(?:in|on|presented in)\s*$/i, '');
  const noYear = noFormat.replace(/\((19|20)\d{2}\)/, '');
  push(noYear);

  // Known series prefix: "Arthouse 50: Freeway" -> "Freeway".
  const lower = noYear.toLowerCase();
  for (const p of SERIES_PREFIXES) {
    if (lower.startsWith(p)) {
      push(noYear.slice(p.length).replace(/^[\s:–—-]+/, ''));
    }
  }

  // Generic "Something: Title" and "Title: Subtitle" splits, both directions.
  if (noYear.includes(':')) {
    const idx = noYear.indexOf(':');
    push(noYear.slice(idx + 1));
    push(noYear.slice(0, idx));
  }
  // "Title + Q&A", "Title with live score", "Title w/ director".
  const cut = noYear.split(/\s+(?:\+|w\/|with|featuring|feat\.|presented by|hosted by)\s+/i)[0];
  push(cut);
  // Everything before a dash used as a separator: "Title - Sing-Along".
  const dash = noYear.split(/\s+[-–—]\s+/)[0];
  push(dash);
  // Last resort: the raw string with parentheticals removed.
  push(base.replace(/\([^)]*\)/g, ''));

  return out;
}

/** Stable key for a film when TMDB gives us nothing. */
export function fallbackKey(title: string, year?: number): string {
  return `t:${normalizeTitle(title)}${year ? `:${year}` : ''}`;
}

/** Extract an "event" note from a raw title, such as "(Q&A with director)". */
export function extractNoteFromTitle(raw: string): string | undefined {
  const notes: string[] = [];
  for (const m of raw.matchAll(/\(([^)]*)\)/g)) {
    const inner = m[1].trim();
    if (/^(19|20)\d{2}$/.test(inner)) continue;
    if (FORMAT_RE.test(inner) && inner.split(/\s+/).length <= 2) continue;
    notes.push(inner);
  }
  return notes.length ? notes.join('; ') : undefined;
}
