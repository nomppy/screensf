import { readFileSync } from 'node:fs';
import { normalizeTitle, cleanTitleCandidates } from './titles.ts';
import type { Festival, RawScreening } from './types.ts';

let patterns: RegExp[] | null = null;

function loadPatterns(): RegExp[] {
  if (patterns) return patterns;
  try {
    const cfg = JSON.parse(readFileSync('data/festivals.json', 'utf8')) as { patterns: string[] };
    patterns = cfg.patterns.map((p) => new RegExp(p, 'i'));
  } catch {
    patterns = [/\bfestivals?\b/i, /\bfest\b/i];
  }
  return patterns;
}

/**
 * Co-presentation credits ("Co-presented by Frameline", "Frameline & Another
 * Planet present …") name an organisation without the show being part of its
 * festival. Strip those clauses before pattern matching.
 */
function withoutCredits(s: string): string {
  return s
    .replace(/\b(?:co-?)?presented\s+(?:by|with)\b[^.:|()]*/gi, ' ')
    .replace(/[^.:|()]*\bpresents?(?=[\sA-Z]|$)/g, ' ')
    .replace(/[^.:|()]*\bPRESENTS?(?=\s|$)/g, ' ')
    .replace(/\bin\s+partnership\s+with\b[^.:|()]*/gi, ' ');
}

/** True when a scraped showtime looks like festival programming rather than a single film run. */
export function isFestival(r: RawScreening): boolean {
  const hay = withoutCredits(`${r.rawTitle} ${r.note ?? ''}`) + ` ${r.url}`;
  return loadPatterns().some((re) => re.test(hay));
}

/** Strip Balboa-style embedded showtimes: "Akira 4K ~ 7:30 PM (Subtitled)". */
function withoutShowtime(s: string): string {
  return s.replace(/\s*~\s*\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * "Twin Peaks Fest 2026: Fire Walk With Me ~ 7 PM" -> "Twin Peaks Fest 2026".
 * Takes the segment (split on ":" / " - " / "|") that matches a pattern; if
 * the match came from the URL instead, uses the festival slug; otherwise the
 * whole cleaned title.
 */
export function festivalName(r: RawScreening): string {
  const cleaned = cleanTitleCandidates(r.rawTitle)[0] ?? r.rawTitle;
  const raw = withoutShowtime(r.rawTitle);

  // "El Vampiro (as part of International Vampire Film Fest)" -> the fest.
  const partOf = `${raw} ${r.note ?? ''}`.match(/\b(?:as\s+)?part\s+of\s+(?:the\s+)?([^()|:]+?)\s*(?:[)|:]|$)/i);
  if (partOf && loadPatterns().some((re) => re.test(partOf[1]))) return partOf[1].trim();

  // Otherwise the segment of the raw title that names the festival. The raw
  // title is used because the cleaner strips parentheticals, which is often
  // the only place the festival is mentioned.
  const parts = raw
    .replace(/[()]/g, ' | ')
    .split(/\s*[:|]\s*|\s+[-–—]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const hit = parts.find((p) => loadPatterns().some((re) => re.test(p)));
  if (hit) {
    // Trim trailing words after the festival phrase so "Twin Peaks Fest 2026
    // Opening Party" and "Twin Peaks Fest 2026: Pilot" share one entry.
    let end = -1;
    for (const re of loadPatterns()) {
      const m = re.exec(hit);
      if (m && (end === -1 || m.index + m[0].length > end)) end = m.index + m[0].length;
    }
    if (end > 0) {
      const rest = hit.slice(end);
      const year = rest.match(/^\s*((?:19|20)\d{2}|'\d{2})\b/);
      return (hit.slice(0, end) + (year ? ` ${year[1]}` : '')).trim();
    }
    return hit;
  }
  const slug = r.url.match(/\/([a-z0-9-]*(?:fest|festival)[a-z0-9-]*)\/?/i)?.[1];
  if (slug) return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (r.note && loadPatterns().some((re) => re.test(r.note!))) return r.note;
  return cleaned;
}

export function buildFestivals(raws: RawScreening[]): Festival[] {
  const map = new Map<string, Festival & { titles: Set<string> }>();
  for (const r of raws) {
    const name = festivalName(r);
    const key = `fest:${r.venueId}:${normalizeTitle(name)}`;
    const f = map.get(key) ?? {
      key,
      name,
      venueId: r.venueId,
      startDate: r.date,
      endDate: r.date,
      url: r.url,
      showtimes: 0,
      sample: [],
      titles: new Set<string>(),
    };
    f.showtimes++;
    if (r.date < f.startDate) {
      f.startDate = r.date;
      f.url = r.url;
    }
    if (r.date > f.endDate) f.endDate = r.date;
    const cleaned = cleanTitleCandidates(r.rawTitle)[0] ?? r.rawTitle;
    const title = cleaned.replace(new RegExp(`^${escapeRe(name)}\\s*[:|\\-–—]?\\s*`, 'i'), '').trim();
    if (title && normalizeTitle(title) !== normalizeTitle(name)) f.titles.add(title);
    map.set(key, f);
  }
  return [...map.values()]
    .map(({ titles, ...f }) => ({ ...f, sample: [...titles].slice(0, 4) }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
