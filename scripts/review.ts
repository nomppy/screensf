/**
 * npm run review
 *
 * Local review UI for titles the classifier could not decide. Reads the
 * snapshot sync wrote to .cache/resolved.json and shows every undecided title
 * with its TMDB guess, alternative matches, artwork options and a search box.
 *
 * Clicking a match or an artwork thumbnail only *selects* it and updates the
 * card preview. Nothing is written until you press Include / Title only /
 * Exclude. Each decision saves to data/decisions.json and the schedule
 * (data/screenings.json) is rebuilt shortly after, so Astro dev updates live.
 * No dependencies; plain node:http.
 */
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { finalizeSchedule, loadResolved, type ResolvedItem } from './lib/build.ts';
import { loadEnv, option } from './lib/env.ts';
import { loadDecisions, saveDecisions } from './lib/store.ts';
import { filmFromTmdb, searchMovies } from './lib/tmdb.ts';
import type { DecisionRecord, Film, FilmEdits, TmdbMovie } from './lib/types.ts';

loadEnv();

const PORT = Number(option('port') ?? process.env.REVIEW_PORT ?? 4400);
const IMG = 'https://image.tmdb.org/t/p';

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** A search hit or alternative: enough to show a thumbnail. Details are fetched on selection. */
function pickMovie(m: TmdbMovie) {
  return {
    tmdbId: m.id,
    title: m.title,
    year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
    popularity: m.popularity ? Math.round(m.popularity) : null,
    poster: m.poster_path ? `${IMG}/w500${m.poster_path}` : null,
    overview: m.overview ?? null,
    partial: true,
  };
}

function filmView(f: Film, overview?: string | null) {
  return {
    tmdbId: f.tmdbId,
    title: f.title,
    year: f.year ?? null,
    director: f.director ?? null,
    runtime: f.runtime ?? null,
    genre: f.genre ?? null,
    popularity: f.popularity ? Math.round(f.popularity) : null,
    poster: f.poster ?? null,
    backdrop: f.backdrop ?? null,
    nowPlaying: !!f.nowPlaying,
    overview: overview ?? f.overview ?? null,
    partial: false,
  };
}

function view(item: ResolvedItem, decision?: DecisionRecord) {
  return {
    key: item.key,
    venueId: item.venueId,
    rawTitle: item.raws[0].rawTitle,
    cleanTitle: item.candidates[0],
    candidates: item.candidates,
    showtimes: item.raws.map((r) => ({ date: r.date, time: r.time, url: r.url, note: r.note })).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
    url: item.raws[0].url,
    action: item.action,
    reason: item.reason,
    film: item.film ? filmView(item.film, item.overview) : null,
    alternatives: item.alternatives.map(pickMovie),
    venueImage: item.venueImage ?? null,
    hints: item.hints ?? null,
    decision: decision ? { decision: decision.decision, tmdbId: decision.tmdbId, image: decision.image ?? null, edits: decision.edits ?? null, decidedAt: decision.decidedAt } : null,
  };
}

let rebuildTimer: NodeJS.Timeout | null = null;
let lastBuild: { at: string; screenings: number; films: number } | null = null;
let building = false;
async function rebuild() {
  const snap = loadResolved();
  if (!snap) return;
  building = true;
  try {
    const r = await finalizeSchedule(snap);
    lastBuild = { at: new Date().toISOString(), screenings: r.data.screenings.length, films: Object.keys(r.data.films).length };
    console.log(`  rebuilt schedule: ${lastBuild.screenings} screenings, ${lastBuild.films} films`);
  } catch (err) {
    console.error('  rebuild failed:', (err as Error).message);
  } finally {
    building = false;
  }
}
function scheduleRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 800);
}

/** Keep only known fields; strings trimmed, numbers as numbers, '' means "clear this field". */
function cleanEdits(raw: unknown): FilmEdits | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: FilmEdits = {};
  const r = raw as Record<string, unknown>;
  for (const k of ['title', 'director', 'genre', 'overview'] as const) {
    if (!(k in r)) continue;
    const v = r[k];
    if (v === null || v === '') out[k] = '' as never;
    else if (typeof v === 'string') out[k] = v.trim() as never;
  }
  for (const k of ['year', 'runtime'] as const) {
    if (!(k in r)) continue;
    const v = r[k];
    if (v === null || v === '') out[k] = '' as never;
    else if (Number.isFinite(Number(v)) && Number(v) > 0) out[k] = Math.round(Number(v));
  }
  return Object.keys(out).length ? out : undefined;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const snap = loadResolved();
      if (!snap) return json(res, 200, { error: 'No snapshot yet. Run `npm run sync` first.' });
      const decisions = loadDecisions();
      const items = snap.items
        .filter((i) => i.action === 'ask' || decisions[i.key])
        .map((i) => view(i, decisions[i.key]));
      const autoIncluded = snap.items.filter((i) => i.action === 'include' && !decisions[i.key]).length;
      const autoExcluded = snap.items.filter((i) => i.action === 'exclude' && !decisions[i.key]).length;
      return json(res, 200, { generatedAt: snap.generatedAt, venues: snap.venues, items, autoIncluded, autoExcluded, lastBuild, building });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, { lastBuild, building, pendingRebuild: !!rebuildTimer && !building && !lastBuild });
    }
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const q = url.searchParams.get('q')?.trim() ?? '';
      const year = Number(url.searchParams.get('year')) || undefined;
      if (!q) return json(res, 200, { results: [] });
      const results = await searchMovies(q, year);
      return json(res, 200, { results: results.map(pickMovie) });
    }
    if (req.method === 'GET' && url.pathname === '/api/film') {
      // Full details (backdrop, director, runtime, synopsis) for a match the
      // reviewer selected. Used to preview alternatives and search hits.
      const id = Number(url.searchParams.get('id'));
      if (!id) return json(res, 400, { error: 'id required' });
      const nowPlaying = new Set(loadResolved()?.nowPlaying ?? []);
      const film = await filmFromTmdb(id, nowPlaying.has(id));
      return json(res, 200, { film: filmView(film) });
    }
    if (req.method === 'POST' && url.pathname === '/api/decide') {
      // tmdbId: number = specific match, null = title only, undefined = keep prior / best guess.
      // image: string = artwork override URL, null = TMDB default, undefined = keep prior.
      // edits: object = hand-edited card fields, null = clear them, undefined = keep prior.
      const body = await readBody(req);
      const { key, decision, tmdbId, title, image, edits } = body as { key: string; decision: 'include' | 'exclude'; tmdbId?: number | null; title?: string; image?: string | null; edits?: FilmEdits | null };
      if (!key || (decision !== 'include' && decision !== 'exclude')) return json(res, 400, { error: 'bad request' });
      if (image != null && !/^https?:\/\//i.test(String(image))) return json(res, 400, { error: 'image must be an http(s) URL' });
      const decisions = loadDecisions();
      const keepImage = image === undefined ? decisions[key]?.image : image ?? undefined;
      const keepEdits = edits === undefined ? decisions[key]?.edits : cleanEdits(edits);
      decisions[key] = {
        decision,
        title: title ?? decisions[key]?.title ?? key,
        tmdbId: decision === 'include' ? (tmdbId === undefined ? decisions[key]?.tmdbId : tmdbId) : undefined,
        ...(decision === 'include' && keepImage ? { image: keepImage } : {}),
        ...(decision === 'include' && keepEdits ? { edits: keepEdits } : {}),
        decidedAt: new Date().toISOString(),
      };
      saveDecisions(decisions);
      scheduleRebuild();
      return json(res, 200, { ok: true, decision: decisions[key] });
    }
    if (req.method === 'POST' && url.pathname === '/api/undo') {
      const { key } = (await readBody(req)) as { key: string };
      const decisions = loadDecisions();
      const had = !!decisions[key];
      delete decisions[key];
      saveDecisions(decisions);
      scheduleRebuild();
      return json(res, 200, { ok: true, had });
    }
    if (req.method === 'POST' && url.pathname === '/api/rebuild') {
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = null;
      await rebuild();
      return json(res, 200, { ok: true, lastBuild });
    }
    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    console.error(err);
    json(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, () => {
  const addr = `http://localhost:${PORT}`;
  const snap = loadResolved();
  const pending = snap ? snap.items.filter((i) => i.action === 'ask' && !loadDecisions()[i.key]).length : 0;
  console.log(`Review UI at ${addr}  (${snap ? `${pending} titles waiting` : 'no snapshot yet; run npm run sync'})`);
  console.log('Ctrl+C to stop. Decisions save when you press Include/Exclude; the schedule rebuilds automatically.');
  if (platform() === 'darwin' && !process.argv.includes('--no-open')) exec(`open ${addr}`);
});

// --------------------------------------------------------------------------
// The page. Vanilla HTML/JS, kept in one string so the tool stays dependency-free.
// No backticks or ${ } inside; strings are concatenated.
// --------------------------------------------------------------------------
const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review queue · Screen SF</title>
<style>
  :root { --bg:#f6f4ee; --ink:#16181d; --muted:#6b6f7a; --line:#dcd8cd; --card:#fff; --accent:#4b5b8a; --chip:#eceae2;
          --ok:#2f7d4f; --no:#b2432f; --warn:#b98a1c; --dark:#1d1f25; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.45 -apple-system,BlinkMacSystemFont,Inter,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased }
  a { color:inherit }
  header { position:sticky; top:0; z-index:5; background:color-mix(in srgb,var(--bg) 94%,transparent); backdrop-filter:blur(8px); border-bottom:1px solid var(--line) }
  .bar { max-width:1600px; margin:0 auto; padding:10px 20px; display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center }
  .brand { font-weight:800; letter-spacing:-.02em; font-size:1.05rem } .brand span{color:var(--accent)}
  .counts { color:var(--muted); font-size:.85rem }
  .tabs, .venues { display:flex; gap:6px; flex-wrap:wrap }
  .chip { border:1px solid var(--line); background:var(--chip); border-radius:999px; padding:4px 11px; font:inherit; font-size:.8rem; cursor:pointer; color:var(--ink) }
  .chip[aria-pressed=true] { background:var(--accent); color:#fff; border-color:var(--accent) }
  .chip:disabled { opacity:.5; cursor:default }
  .spacer { flex:1 }
  .status { font-size:.8rem; color:var(--muted) }
  .help { font-size:.78rem; color:var(--muted); line-height:1.7 }
  .kbd { font-family:ui-monospace,Menlo,monospace; font-size:.72rem; background:var(--chip); border:1px solid var(--line); border-radius:4px; padding:0 5px; color:var(--ink) }
  main { max-width:1800px; margin:0 auto; padding:18px 20px 120px; display:grid; gap:12px; grid-template-columns:repeat(auto-fill,minmax(400px,1fr)) }
  /* Grid layout: compact browse cards. Options live in Focus (press f or Enter on a card). */
  body.grid .item { grid-template-columns:120px 1fr }
  body.grid .item .opts, body.grid .item .overview, body.grid .item .links, body.grid .item .editor, body.grid .item .sidecap, body.grid .item .zoom { display:none }
  body.grid .item .body { padding:12px 14px; gap:5px; font-size:.9rem }
  body.grid .raw { font-size:1.05rem } body.grid .guess { font-size:.92rem } body.grid .meta, body.grid .reason, body.grid .times { font-size:.82rem }
  body.grid .times { display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; overflow:hidden }
  body.grid .poster { min-height:180px } body.grid .poster img { padding:0; object-fit:cover }
  body.grid .actions { gap:4px } body.grid .actions button { padding:6px 10px; font-size:.82rem } body.grid .actions .saved { display:none }
  .item { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; display:grid; grid-template-columns:250px 1fr; grid-template-rows:auto auto; outline:none; position:relative; scroll-margin-top:var(--head,140px) }
  .item .side { grid-row:1/-1 }
  .item .opts { grid-column:2; padding:0 18px 16px; display:flex; flex-direction:column; gap:12px; min-width:0 }
  /* Focus layout: one film at a time, full width, everything visible at once */
  body.focus main { grid-template-columns:1fr; max-width:1800px; gap:22px }
  body.focus .item { grid-template-columns:minmax(260px,320px) minmax(0,1fr) minmax(0,1.15fr); grid-template-rows:1fr; min-height:calc(100vh - var(--headpx,140px) - 30px) }
  body.focus .item .body { grid-column:2; padding:22px 24px; border-right:1px solid var(--line) }
  body.focus .item .opts { grid-column:3; padding:22px 24px; gap:18px }
  body.focus .raw { font-size:1.6rem }
  body.focus .overview { display:block; -webkit-line-clamp:unset; font-size:1rem; color:var(--ink) }
  body.focus .opt { width:104px } body.focus .opt img, body.focus .opt .ph { width:104px; height:156px } body.focus .opt.wide { width:160px } body.focus .opt.wide img, body.focus .opt.wide .ph { width:160px; height:90px }
  @media (max-width:1100px){ body.focus .item { grid-template-columns:220px 1fr } body.focus .item .body { border-right:0 } body.focus .item .opts { grid-column:2 } body.focus .item .side { grid-row:1/-1 } }
  .item:focus { box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 45%,transparent); border-color:var(--accent) }
  .item.decided.include { border-color:var(--ok) } .item.decided.exclude { border-color:var(--no); opacity:.75 }
  .side { background:var(--dark); display:flex; flex-direction:column }
  .poster { flex:1; min-height:340px; position:relative; cursor:zoom-in; display:grid; place-items:center; background:var(--dark) }
  .poster img { padding:6px }
  .poster img { width:100%; height:100%; object-fit:contain; display:block; position:absolute; inset:0 }
  .poster .none { color:#9aa0b0; font-size:.75rem; letter-spacing:.08em; text-transform:uppercase; text-align:center; padding:10px }
  .poster .zoom { position:absolute; right:8px; bottom:8px; font-size:.7rem; letter-spacing:.06em; text-transform:uppercase; background:rgba(0,0,0,.55); color:#fff; padding:3px 7px; border-radius:5px; opacity:0; transition:opacity .15s }
  .poster:hover .zoom { opacity:1 }
  .sidecap { color:#9aa0b0; font-size:.72rem; padding:8px 10px; line-height:1.4 }
  .sidecap b { color:#dfe2ea; font-weight:600 }
  .badge { position:absolute; top:8px; left:8px; font-size:.7rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; padding:3px 7px; border-radius:5px; color:#fff; background:var(--ok); z-index:1 }
  .badge.exclude { background:var(--no) }
  .body { padding:16px 18px 16px; display:flex; flex-direction:column; gap:9px; min-width:0 }
  .venue { font-size:.78rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--accent) }
  .raw { font-weight:700; font-size:1.3rem; line-height:1.2; letter-spacing:-.01em }
  .raw a { text-decoration:none } .raw a:hover { text-decoration:underline }
  .guess { font-size:1.02rem } .guess b { font-weight:600 }
  .guess .tag { font-size:.72rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin-right:6px }
  .meta, .reason, .times { font-size:.92rem; color:var(--muted) }
  .reason b { color:var(--warn); font-weight:600 }
  .overview { font-size:.92rem; line-height:1.45; color:var(--muted); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; cursor:pointer }
  .overview.open { display:block; -webkit-line-clamp:unset }
  .times { line-height:1.5 } .times span { white-space:nowrap }
  .sect { display:flex; gap:8px; flex-wrap:wrap; align-items:flex-start }
  .sect .label { width:100%; font-size:.75rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); display:flex; gap:10px; align-items:baseline }
  .sect .label .hint { font-weight:400; letter-spacing:0; text-transform:none; font-size:.75rem }
  .opt { width:88px; border:0; padding:0; background:none; cursor:pointer; text-align:left; font:inherit; color:inherit; position:relative }
  .opt img, .opt .ph { width:88px; height:132px; object-fit:cover; border-radius:6px; background:var(--dark); display:block; border:2px solid transparent; box-shadow:0 0 0 1px var(--line) }
  .opt.wide img, .opt.wide .ph { width:132px; height:74px } .opt.wide { width:132px }
  .opt .ph { display:grid; place-items:center; color:#9aa0b0; font-size:.68rem; text-align:center; padding:6px; line-height:1.3 }
  .opt:hover img, .opt:hover .ph { border-color:color-mix(in srgb,var(--accent) 60%,transparent) }
  .opt.on img, .opt.on .ph { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent) }
  .opt small { display:block; font-size:.74rem; line-height:1.2; color:var(--muted); margin-top:4px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical }
  .opt.on small { color:var(--ink); font-weight:600 }
  .opt .n { position:absolute; top:4px; left:4px; font-family:ui-monospace,Menlo,monospace; font-size:.68rem; background:rgba(0,0,0,.6); color:#fff; border-radius:4px; padding:0 5px }
  .opt .zm { position:absolute; top:4px; right:4px; font-size:.7rem; background:rgba(0,0,0,.6); color:#fff; border-radius:4px; padding:1px 5px; opacity:0; cursor:zoom-in }
  .opt:hover .zm { opacity:1 }
  .editor { width:100%; display:grid; grid-template-columns:1fr 1fr; gap:8px 10px; background:var(--bg); border:1px solid var(--line); border-radius:9px; padding:10px 12px }
  .editor label { display:flex; flex-direction:column; gap:3px; font-size:.72rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted) }
  .editor input, .editor textarea { font:inherit; font-size:.9rem; font-weight:400; letter-spacing:0; text-transform:none; color:var(--ink); padding:6px 9px; border:1px solid var(--line); border-radius:7px; background:#fff; min-width:0 }
  .editor textarea { resize:vertical; min-height:80px; line-height:1.4 }
  .editor .full { grid-column:1/-1 }
  .editor .row { grid-column:1/-1; display:flex; gap:8px; align-items:center; font-size:.8rem; color:var(--muted) }
  .editor input.changed, .editor textarea.changed { border-color:var(--warn); background:#fffaf0 }
  .tag.edited { color:var(--warn) }
  .says { font-size:.9rem; color:var(--muted) } .says b { color:var(--ink); font-weight:600 }
  .agree { font-size:.75rem; font-weight:700; letter-spacing:.04em; padding:1px 7px; border-radius:999px; margin-left:8px; vertical-align:middle }
  .agree.ok { background:color-mix(in srgb,var(--ok) 15%,transparent); color:var(--ok) } .agree.bad { background:color-mix(in srgb,var(--no) 12%,transparent); color:var(--no) }
  .links { display:flex; gap:6px; flex-wrap:wrap }
  .links a { font-size:.8rem; font-weight:600; text-decoration:none; border:1px solid var(--line); background:var(--chip); border-radius:999px; padding:3px 10px; color:var(--ink) }
  .links a:hover { border-color:var(--accent); color:var(--accent) }
  .links a.lbx { background:#202830; color:#fff; border-color:#202830 } .links a.lbx:hover { background:#00e054; border-color:#00e054; color:#14181c }
  .inline { display:flex; gap:6px; width:100% }
  .inline input { flex:1; font:inherit; font-size:.9rem; padding:6px 10px; border:1px solid var(--line); border-radius:7px; background:#fff; min-width:0 }
  .actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:auto; padding-top:6px; align-items:center }
  .actions button { border:1px solid var(--line); background:var(--chip); border-radius:8px; padding:9px 14px; font:inherit; font-size:.92rem; font-weight:600; cursor:pointer; color:var(--ink) }
  .actions button.yes { background:var(--ok); color:#fff; border-color:var(--ok) }
  .actions button.no { background:var(--no); color:#fff; border-color:var(--no) }
  .actions button.dirty { background:var(--warn); border-color:var(--warn); color:#fff }
  .actions button:disabled { opacity:.45; cursor:default }
  .actions .saved { font-size:.82rem; color:var(--muted); margin-left:auto }
  .empty { grid-column:1/-1; padding:80px 0; text-align:center; color:var(--muted) }
  .toast { position:fixed; left:50%; bottom:22px; transform:translateX(-50%); background:var(--ink); color:#fff; padding:10px 14px; border-radius:10px; font-size:.9rem; display:flex; gap:12px; align-items:center; z-index:20; box-shadow:0 8px 30px rgba(0,0,0,.25); max-width:min(90vw,640px) }
  .toast button { border:1px solid rgba(255,255,255,.35); background:transparent; color:#fff; border-radius:6px; padding:4px 10px; font:inherit; font-size:.85rem; cursor:pointer }
  .toast[hidden] { display:none }
  .lb { position:fixed; inset:0; background:rgba(10,11,14,.94); z-index:30; display:grid; grid-template-rows:1fr auto; place-items:center; cursor:zoom-out }
  .lb[hidden] { display:none }
  .lb img { max-width:96vw; max-height:88vh; object-fit:contain; box-shadow:0 20px 60px rgba(0,0,0,.6) }
  .lb .cap { color:#dfe2ea; font-size:.85rem; padding:10px 20px 18px; text-align:center }
  .lb .cap .kbd { background:rgba(255,255,255,.12); border-color:rgba(255,255,255,.2); color:#fff }
  @media (max-width:760px){ .item, body.focus .item{grid-template-columns:150px 1fr} main{grid-template-columns:1fr} .help{display:none} }
</style>
</head>
<body>
<header><div class="bar">
  <div class="brand">Screen <span>SF</span> · review</div>
  <div class="counts" id="counts">loading…</div>
  <div class="tabs" id="tabs">
    <button class="chip" data-tab="pending" aria-pressed="true">Pending</button>
    <button class="chip" data-tab="included" aria-pressed="false">Included</button>
    <button class="chip" data-tab="titleonly" aria-pressed="false">Title only</button>
    <button class="chip" data-tab="excluded" aria-pressed="false">Excluded</button>
    <button class="chip" data-tab="edited" aria-pressed="false">Edited</button>
    <button class="chip" data-tab="all" aria-pressed="false">All</button>
  </div>
  <div class="venues" id="venues"></div>
  <div class="venues" id="reasons" title="Why the classifier held these titles back"></div>
  <div class="tabs" id="layout" title="Focus shows one film at a time with everything visible; Grid shows many compact cards. Press f to toggle, or Enter on a grid card to focus it">
    <button class="chip" data-layout="focus" aria-pressed="true">Focus</button>
    <button class="chip" data-layout="grid" aria-pressed="false">Grid</button>
  </div>
  <div class="spacer"></div>
  <span class="help"><span class="kbd">h</span><span class="kbd">j</span><span class="kbd">k</span><span class="kbd">l</span> move · <span class="kbd">f</span> layout ·
    <span class="kbd">m</span> movie · <span class="kbd">M</span> artwork · <span class="kbd">o</span> full size · <span class="kbd">/</span> search ·
    <span class="kbd">d</span> edit details · <span class="kbd">b</span> letterboxd · <span class="kbd">O</span> theatre page · <span class="kbd">y</span> include · <span class="kbd">t</span> title only · <span class="kbd">n</span> exclude · <span class="kbd">u</span> undo</span>
  <span class="status" id="status"></span>
  <button class="chip" id="rebuild" title="Regenerate data/screenings.json from the last sync snapshot plus your decisions. This already happens automatically about a second after every decision; the button is only for forcing it (for example after a failed build).">Rebuild now</button>
</div></header>
<main id="grid"></main>
<div class="toast" id="toast" hidden><span id="toastText"></span><button id="toastUndo">Undo <span class="kbd">u</span></button></div>
<div class="lb" id="lb" hidden><img id="lbImg" alt=""><div class="cap" id="lbCap"></div></div>
<script>
const state = { items: [], venues: [], tab: 'pending', venue: 'all', reason: 'all', autoIncluded: 0, autoExcluded: 0, recent: new Set(), last: null, lastBuild: null, layout: 'focus' };
try { state.layout = localStorage.getItem('review.layout') || 'focus'; } catch {}
function setLayout(l) {
  state.layout = l; try { localStorage.setItem('review.layout', l); } catch {}
  document.body.classList.toggle('focus', l==='focus'); document.body.classList.toggle('grid', l!=='focus');
  document.querySelectorAll('#layout button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.layout===l)));
  const el = focusedCard(); if (el) el.scrollIntoView({block: l==='focus' ? 'start' : 'center'});
}
document.querySelectorAll('#layout button').forEach(b => b.onclick = () => setLayout(b.dataset.layout));
const ui = new Map(); // per-card selection state, survives re-renders
const $ = (s, el=document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cssEsc = (s) => s.replace(/["\\\\]/g, '\\\\$&');
const hi = (u) => u ? u.replace(/(image.tmdb.org.t.p.)w[0-9]+(.)/, '$1original$2') : u; // full-resolution TMDB image
const fmtDate = (d) => { const [y,m,dd]=d.split('-').map(Number); return new Date(Date.UTC(y,m-1,dd)).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}); };
const fmtTime = (t) => { const [h,m]=t.split(':').map(Number); return (h%12||12)+':'+String(m).padStart(2,'0')+(h>=12?' PM':' AM'); };
const fmtWhen = (iso) => new Date(iso).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
const venueName = (id) => (state.venues.find(v=>v.id===id)||{}).shortName || id;
const post = async (path, body) => { const r = await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); return r.json(); };

// ---- per-card selection state -------------------------------------------
function U(i) {
  let u = ui.get(i.key);
  if (u) return u;
  const films = {};
  if (i.film) films[i.film.tmdbId] = i.film;
  for (const a of i.alternatives) if (!films[a.tmdbId]) films[a.tmdbId] = a;
  const d = i.decision;
  u = {
    films,                                   // tmdbId -> film view (partial until selected)
    order: [i.film && i.film.tmdbId, ...i.alternatives.map(a=>a.tmdbId)].filter(x=>x!=null), // match options in display order
    results: [],                             // search hits (tmdbIds), appended to order when searched
    match: d ? (d.tmdbId === undefined ? (i.film ? i.film.tmdbId : null) : d.tmdbId) : (i.film ? i.film.tmdbId : null), // number or null (title only)
    art: d && d.image ? d.image : null,      // artwork override URL or null for the site default
    edits: d && d.edits ? {...d.edits} : {}, // hand-edited fields; '' clears a field on the site
    editing: false,
    q: '', open: false, custom: '',
  };
  if (typeof u.match === 'number' && !u.films[u.match]) { u.films[u.match] = { tmdbId:u.match, title:d && d.title || 'TMDB #'+u.match, partial:true }; u.order.push(u.match); }
  ui.set(i.key, u);
  return u;
}
const curFilm = (i) => { const u=U(i); return typeof u.match==='number' ? u.films[u.match] : null; };
/** What the site would show with no override: backdrop, else poster, else venue image. */
function defaultArt(i) { const f=curFilm(i); if (f && f.backdrop) return { src:f.backdrop, label:'TMDB backdrop' }; if (f && f.poster) return { src:f.poster, label:'TMDB poster' }; if (i.venueImage) return { src:i.venueImage, label:venueName(i.venueId)+' listing image' }; return null; }
function artOptions(i) {
  const f = curFilm(i), def = defaultArt(i), opts = [];
  if (def) opts.push({ id:null, src:def.src, label:'Default · '+def.label, wide: def.src===(f&&f.backdrop) });
  if (f && f.poster && def && def.src!==f.poster) opts.push({ id:f.poster, src:f.poster, label:'TMDB poster' });
  if (f && f.backdrop && def && def.src!==f.backdrop) opts.push({ id:f.backdrop, src:f.backdrop, label:'TMDB backdrop', wide:true });
  if (i.venueImage && (!def || def.src!==i.venueImage)) opts.push({ id:i.venueImage, src:i.venueImage, label:venueName(i.venueId)+' listing image', wide:true });
  const u = U(i);
  if (u.art && !opts.some(o=>o.id===u.art)) opts.push({ id:u.art, src:u.art, label:'Custom URL', wide:true });
  return opts;
}
const previewArt = (i) => { const u=U(i); if (u.art) return { src:u.art, label:(artOptions(i).find(o=>o.id===u.art)||{}).label||'Custom' }; const d=defaultArt(i); return d ? { src:d.src, label:d.label+' (default)' } : null; };
const EDIT_FIELDS = ['title','year','director','runtime','genre','overview'];
/** Compare the venue's director/year with the selected TMDB film: surname match, year within one. */
function agreement(h, f) {
  const surname = (n) => n.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z ]+/g,' ').trim().split(/\s+/).pop();
  const names = (s) => String(s).split(/,|&|\band\b|\//i).map(x=>x.trim()).filter(Boolean);
  const out = [];
  if (h.director && f.director) { const ok = names(h.director).some(a => names(f.director).some(b => surname(a)===surname(b))); out.push(ok ? '<span class="agree ok" title="Venue and TMDB name the same director">✓ director</span>' : '<span class="agree bad" title="Venue lists a different director">✗ director</span>'); }
  if (h.year && f.year) { const ok = Math.abs(h.year-f.year)<=1; out.push(ok ? '<span class="agree ok" title="Year matches the venue listing">✓ year</span>' : '<span class="agree bad" title="Venue lists '+h.year+'">✗ year</span>'); }
  return out.join('');
}
/** Card details as TMDB (or the venue title) supplies them, before hand edits. */
function baseDetails(i) { const f=curFilm(i); return f ? { title:f.title||'', year:f.year||'', director:f.director||'', runtime:f.runtime||'', genre:f.genre||'', overview:f.overview||'' } : { title:i.cleanTitle, year:'', director:'', runtime:'', genre:'', overview:'' }; }
/** What the site will show: base details with edits applied. */
function shownDetails(i) { const b=baseDetails(i), e=U(i).edits, out={...b}; for (const k of EDIT_FIELDS) if (k in e) out[k] = e[k]===''||e[k]==null ? '' : e[k]; return out; }
const hasEdits = (i) => Object.keys(U(i).edits).length>0;
/** Letterboxd page for the selected match, or a title search when there is no TMDB id. */
function letterboxdUrl(i) { const f=curFilm(i); return f ? 'https://letterboxd.com/tmdb/'+f.tmdbId+'/' : 'https://letterboxd.com/search/films/'+encodeURIComponent(shownDetails(i).title)+'/'; }
const normEdits = (e) => { const o={}; for (const k of EDIT_FIELDS) if (e && k in e) o[k]=String(e[k]??''); return JSON.stringify(o); };
function dirty(i) { const d=i.decision, u=U(i); if (!d || d.decision!=='include') return false; const savedMatch = d.tmdbId===undefined ? (i.film?i.film.tmdbId:null) : d.tmdbId; return savedMatch!==u.match || (d.image||null)!==u.art || normEdits(d.edits)!==normEdits(u.edits); }

// ---- data loading ----------------------------------------------------------
async function load() {
  const r = await fetch('/api/state'); const d = await r.json();
  if (d.error) { $('#grid').innerHTML = '<div class="empty">'+esc(d.error)+'</div>'; $('#counts').textContent=''; return; }
  Object.assign(state, { items:d.items, venues:d.venues, autoIncluded:d.autoIncluded, autoExcluded:d.autoExcluded, lastBuild:d.lastBuild });
  ui.clear();
  renderVenues(); render(); showStatus();
}
function showStatus(extra) {
  const b = state.lastBuild;
  $('#status').textContent = extra || (b ? 'schedule: '+b.screenings+' screenings, '+b.films+' films · built '+fmtWhen(b.at) : 'schedule not rebuilt yet this session');
}
let statusTimer = null;
function pollStatus() { // after a save: wait for the debounced rebuild, then refresh the status line only (no re-render)
  if (statusTimer) clearTimeout(statusTimer);
  showStatus('saved · rebuilding schedule…');
  const tick = async (n) => { const d = await (await fetch('/api/status')).json(); if (d.lastBuild && !d.building && (!state.lastBuild || d.lastBuild.at!==state.lastBuild.at)) { state.lastBuild=d.lastBuild; showStatus(); } else if (n<10) statusTimer=setTimeout(()=>tick(n+1), 700); else showStatus(); };
  statusTimer = setTimeout(()=>tick(0), 1200);
}
/** Collapse a reason like "new release (19 days), popularity 3" to its family. */
function reasonGroup(r) {
  r = String(r||'');
  if (/^no TMDB match/.test(r)) return 'No TMDB match';
  if (/^uncertain/.test(r)) return 'Uncertain match';
  if (/^in US now-playing/.test(r)) return 'Now playing';
  if (/^new release/.test(r)) return 'New release';
  if (/^unreleased/.test(r)) return 'Unreleased';
  if (/^no release date/.test(r)) return 'No release date';
  if (/^first-run/.test(r)) return 'First-run booking';
  if (/^repertory/.test(r)) return 'Repertory';
  return r.replace(/[0-9]+/g,'N');
}
function renderReasons() {
  const pool = state.items.filter(i => (state.venue==='all'||i.venueId===state.venue) && inTab(i));
  const counts = {}; for (const i of pool) { const g=reasonGroup(i.reason); counts[g]=(counts[g]||0)+1; }
  const groups = Object.keys(counts).sort((a,b)=>counts[b]-counts[a]);
  if (state.reason!=='all' && !counts[state.reason]) state.reason='all';
  $('#reasons').innerHTML = groups.length>1 ? ['all',...groups].map(g => '<button class="chip" data-reason="'+esc(g)+'" aria-pressed="'+(state.reason===g)+'">'+esc(g==='all'?'Any reason':g)+(g==='all'?'':' '+counts[g])+'</button>').join('') : '';
  $('#reasons').querySelectorAll('button').forEach(b => b.onclick = () => { state.reason=b.dataset.reason; render(); });
}
function renderVenues() {
  const ids = [...new Set(state.items.map(i=>i.venueId))];
  $('#venues').innerHTML = ['all',...ids].map(id => '<button class="chip" data-venue="'+esc(id)+'" aria-pressed="'+(state.venue===id)+'">'+esc(id==='all'?'All venues':venueName(id))+'</button>').join('');
  $('#venues').querySelectorAll('button').forEach(b => b.onclick = () => { state.venue=b.dataset.venue; state.recent.clear(); render(); renderVenues(); });
}
/** Decision status of an item: pending, included, titleonly or excluded. */
function statusOf(i) { const d=i.decision; if (!d) return 'pending'; if (d.decision==='exclude') return 'excluded'; return d.tmdbId===null ? 'titleonly' : 'included'; }
function inTab(i) {
  const t = state.tab, st = statusOf(i);
  if (t==='all') return true;
  if (t==='pending') return st==='pending' || state.recent.has(i.key);
  if (t==='edited') return !!(i.decision && (i.decision.edits || i.decision.image));
  return st===t;
}
function visible() { return state.items.filter(i => (state.venue==='all'||i.venueId===state.venue) && inTab(i) && (state.reason==='all' || reasonGroup(i.reason)===state.reason)); }
function render() {
  updateCounts();
  $('#tabs').querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.tab===state.tab)); b.onclick = () => { state.tab=b.dataset.tab; state.recent.clear(); render(); }; });
  renderReasons();
  const list = visible();
  const grid = $('#grid');
  grid.innerHTML = list.length ? list.map(card).join('') : '<div class="empty">'+(state.tab==='pending'?'Nothing left to review. Run <b>npm run sync</b> again later.':'Nothing here.')+'</div>';
  list.forEach(i => wire(i, cardEl(i)));
}
const cardEl = (i) => $('#grid').querySelector('[data-key="'+cssEsc(i.key)+'"]');
function rerender(i) { // swap one card in place, keeping focus and the rest of the grid untouched
  const old = cardEl(i); if (!old) return render();
  const had = old===document.activeElement || old.contains(document.activeElement);
  const tmp = document.createElement('div'); tmp.innerHTML = card(i); const el = tmp.firstElementChild;
  old.replaceWith(el); wire(i, el);
  if (had) el.focus({preventScroll:true});
}

// ---- card markup -----------------------------------------------------------
function thumb(src, label, cls, on, n, wide) {
  return '<button class="opt'+(wide?' wide':'')+(on?' on':'')+'" '+cls+' title="'+esc(label)+'">'
    + (src ? '<img src="'+esc(src)+'" alt="" loading="lazy">' : '<div class="ph">'+esc(label)+'</div>')
    + (n!=null ? '<span class="n">'+n+'</span>' : '') + (src ? '<span class="zm" data-zoom="'+esc(src)+'" title="View full size">⤢</span>' : '')
    + '<small>'+esc(label)+'</small></button>';
}
function card(i) {
  const u = U(i), f = curFilm(i), d = i.decision, art = previewArt(i), h = i.hints;
  const agree = f && h && !f.partial ? agreement(h, f) : '';
  const matchOpts = [...u.order, ...u.results.filter(id=>!u.order.includes(id))];
  const matches = '<div class="sect matches"><span class="label">Movie <span class="hint">click or <span class="kbd">m</span> to preview · saved when you press Include</span></span>'
    + matchOpts.map((id, n) => { const m=u.films[id]; return thumb(m.poster, m.title+(m.year?' ('+m.year+')':'')+(n===0&&i.film&&id===i.film.tmdbId?' · best guess':''), 'data-match="'+id+'"', u.match===id, n+1<10?n+1:null); }).join('')
    + thumb(null, 'Title only (no TMDB)', 'data-match="none"', u.match===null, 0)
    + '<div class="inline"><input type="search" placeholder="Search TMDB for a different film…" value="'+esc(u.q)+'"><button class="chip">Search</button><span class="meta results-note"></span></div></div>';
  const aopts = artOptions(i);
  const arts = '<div class="sect arts"><span class="label">Artwork on the site <span class="hint">click or <span class="kbd">M</span> · shown on the schedule card</span></span>'
    + aopts.map(o => thumb(o.src, o.label, 'data-art="'+(o.id===null?'':esc(o.id))+'"', (u.art||null)===o.id, null, o.wide)).join('')
    + '<div class="inline"><input type="url" placeholder="…or paste an image URL" value="'+esc(u.custom)+'"><button class="chip">Preview</button></div></div>';
  const decidedLabel = d ? (d.decision==='exclude' ? 'excluded' : d.tmdbId===null ? 'included, title only' : 'included') : '';
  const times = i.showtimes.slice(0,6).map(s=>'<span>'+fmtDate(s.date)+' '+fmtTime(s.time)+'</span>').join(' · ') + (i.showtimes.length>6?' · +'+(i.showtimes.length-6)+' more':'');
  const isDirty = dirty(i), s = shownDetails(i), edited = hasEdits(i);
  const incLabel = f ? (isDirty ? 'Save changes' : '✓ Include as “'+esc(s.title)+'”') : (isDirty ? 'Save changes' : '✓ Include, title only');
  const meta = [s.genre, s.runtime?s.runtime+' min':null, f&&f.popularity!=null?'popularity '+f.popularity:null, f&&f.nowPlaying?'in US release':null, f&&f.partial?'loading details…':null].filter(Boolean).map(esc).join(' · ');
  const editor = u.editing ? '<div class="editor">'
    + '<label class="full">Title<input data-edit="title" value="'+esc(s.title)+'"'+(('title' in u.edits)?' class="changed"':'')+'></label>'
    + '<label>Year<input data-edit="year" inputmode="numeric" value="'+esc(s.year)+'"'+(('year' in u.edits)?' class="changed"':'')+'></label>'
    + '<label>Runtime (min)<input data-edit="runtime" inputmode="numeric" value="'+esc(s.runtime)+'"'+(('runtime' in u.edits)?' class="changed"':'')+'></label>'
    + '<label>Director<input data-edit="director" value="'+esc(s.director)+'"'+(('director' in u.edits)?' class="changed"':'')+'></label>'
    + '<label>Genre<input data-edit="genre" value="'+esc(s.genre)+'"'+(('genre' in u.edits)?' class="changed"':'')+'></label>'
    + '<label class="full">Description<textarea data-edit="overview"'+(('overview' in u.edits)?' class="changed"':'')+'>'+esc(s.overview)+'</textarea></label>'
    + '<div class="row"><span>Edits apply on the site once you press Include. Clear a field to hide it.</span><span class="spacer"></span><button class="chip" data-reset-edits'+(edited?'':' disabled')+'>Reset to TMDB</button><button class="chip" data-close-editor>Done</button></div>'
    + '</div>' : '';
  return '<article class="item '+(d?'decided '+d.decision:'')+'" tabindex="0" data-key="'+esc(i.key)+'">'
   + '<div class="side"><div class="poster" title="View full size (o)">'+(art?'<img src="'+esc(art.src)+'" alt="">':'<div class="none">no artwork</div>')+(d?'<span class="badge '+d.decision+'">'+decidedLabel+'</span>':'')+(art?'<span class="zoom">⤢ full size</span>':'')+'</div>'
   + '<div class="sidecap">'+(art?'Preview: <b>'+esc(art.label)+'</b>':'Nothing to show on the site card')+(f&&f.poster&&art&&art.src!==f.poster?'<br>Click the poster to view all images at full size.':'')+'</div></div>'
   + '<div class="body">'
   + '<div class="venue">'+esc(venueName(i.venueId))+'</div>'
   + '<div class="raw"><a href="'+esc(i.url)+'" target="_blank" rel="noopener" title="Open the theatre listing (O)">'+esc(i.rawTitle)+'</a></div>'
   + (h ? '<div class="says">'+esc(venueName(i.venueId))+' lists: '+[h.director?'<b>'+esc(h.director)+'</b>':null, h.year?'<b>'+h.year+'</b>':null, h.runtime?h.runtime+' min':null].filter(Boolean).join(' · ')+'</div>' : '')
   + '<div class="guess"><span class="tag'+(edited?' edited':'')+'">'+(edited?'Edited':f?(u.match===(i.film&&i.film.tmdbId)?'TMDB guess':'Selected'):'Title only')+'</span><b data-show="title">'+esc(s.title)+'</b><span data-show="yeardir">'+(s.year?' ('+s.year+')':'')+(s.director?', '+esc(s.director):'')+'</span>'+agree
        + (f ? '' : ' <span class="meta">— listed with no TMDB data'+(i.film?'':' (no match found)')+'</span>')+'</div>'
   + '<div class="meta" data-show="meta"'+(meta?'':' hidden')+'>'+meta+'</div>'
   + '<div class="links"><a class="lbx" data-lbx href="'+esc(letterboxdUrl(i))+'" target="_blank" rel="noopener" title="Open on Letterboxd (b)">Letterboxd ↗</a>'
   + (f ? '<a href="https://www.themoviedb.org/movie/'+f.tmdbId+'" target="_blank" rel="noopener">TMDB ↗</a>' : '') + '</div>'
   + '<div class="overview'+(u.open?' open':'')+'" data-show="overview" title="Click to expand"'+(s.overview?'':' hidden')+'>'+esc(s.overview)+'</div>'
   + editor
   + '<div class="reason"><b>Why it was flagged:</b> '+esc(i.reason)+'</div>'
   + '<div class="times">'+times+'</div>'
   + '<div class="actions">'
   + '<button class="yes'+(isDirty?' dirty':'')+'" data-act="include"'+(d&&d.decision==='include'&&!isDirty?' disabled':'')+'>'+incLabel+'</button>'
   + '<button class="no" data-act="exclude"'+(d&&d.decision==='exclude'?' disabled':'')+'>✕ Exclude</button>'
   + (d?'<button data-act="undo">↩ Undo</button>':'')
   + '<button data-act="edit" title="Edit title, year, director, runtime, genre or description (d)">'+(u.editing?'Close editor':(edited?'✎ Edited':'✎ Edit details'))+'</button>'
   + (d?'<span class="saved">saved '+fmtWhen(d.decidedAt)+(isDirty?' · unsaved changes':'')+'</span>':'')
   + '</div></div>'
   + '<div class="opts">' + matches + arts + '</div></article>';
}

// ---- actions ---------------------------------------------------------------
async function selectMatch(i, id) {
  const u = U(i); u.match = id; rerender(i);
  if (typeof id==='number' && u.films[id] && u.films[id].partial) {
    const d = await (await fetch('/api/film?id='+id)).json();
    if (d.film) { u.films[id] = d.film; if (ui.get(i.key)===u) rerender(i); }
  }
}
function selectArt(i, id) { U(i).art = id || null; rerender(i); }
async function commit(i, decision) {
  const u = U(i);
  const body = { key:i.key, decision, title:i.rawTitle };
  if (decision==='include') { body.tmdbId = u.match; body.image = u.art; body.edits = Object.keys(u.edits).length ? u.edits : null; }
  const d = await post('/api/decide', body); if (d.error) return alert(d.error);
  i.decision = { decision:d.decision.decision, tmdbId:d.decision.tmdbId===undefined?null:d.decision.tmdbId, image:d.decision.image||null, edits:d.decision.edits||null, decidedAt:d.decision.decidedAt };
  if (d.decision.edits) u.edits = {...d.decision.edits}; else u.edits = {};
  if (d.decision.tmdbId===undefined && decision==='include') i.decision.tmdbId = u.match;
  state.recent.add(i.key); state.last = i;
  rerender(i); pollStatus(); advanceFrom(i);
  const f = curFilm(i), s = shownDetails(i);
  toast(decision==='exclude' ? 'Excluded “'+i.rawTitle+'”' : f ? 'Included “'+i.rawTitle+'” as '+s.title+(s.year?' ('+s.year+')':'') : 'Included “'+s.title+'”, title only');
  updateCounts();
}
async function undo(i) {
  await post('/api/undo', {key:i.key});
  i.decision = null; if (state.last===i) state.last = null;
  rerender(i); pollStatus(); hideToast(); updateCounts();
  if (state.tab!=='pending' && state.tab!=='all') { const el=cardEl(i); if (el) el.style.opacity='.4'; }
}
function updateCounts() {
  const n = { pending:0, included:0, titleonly:0, excluded:0, edited:0 };
  for (const i of state.items) { n[statusOf(i)]++; if (i.decision && (i.decision.edits || i.decision.image)) n.edited++; }
  $('#counts').textContent = n.pending+' pending · '+(n.included+n.titleonly+n.excluded)+' decided · '+state.autoIncluded+' auto-included · '+state.autoExcluded+' auto-excluded by the classifier';
  const labels = { pending:'Pending', included:'Included', titleonly:'Title only', excluded:'Excluded', edited:'Edited' };
  $('#tabs').querySelectorAll('button').forEach(b => { const t=b.dataset.tab; if (labels[t]) b.textContent = labels[t]+' '+n[t]; });
}
let toastTimer = null;
function toast(text) { $('#toastText').textContent = text; $('#toast').hidden = false; if (toastTimer) clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, 7000); }
function hideToast() { $('#toast').hidden = true; }
$('#toastUndo').onclick = () => { if (state.last) undo(state.last); };

/** After a decision, move focus to the next card that still needs one (or the nearest earlier one). */
function advanceFrom(i) {
  const all = cards(), el = cardEl(i), idx = all.indexOf(el);
  const nx = all.slice(idx+1).find(c => !c.classList.contains('decided')) || all.slice(0, Math.max(idx,0)).reverse().find(c => !c.classList.contains('decided'));
  if (nx) { nx.focus({preventScroll:true}); nx.scrollIntoView({block: state.layout==='focus' ? 'start' : 'center', behavior:'smooth'}); }
}
function toggleEditor(i) { const u=U(i); u.editing=!u.editing; rerender(i); if (u.editing) { const f=cardEl(i).querySelector('[data-edit="title"]'); if (f) { f.focus(); f.select(); } } }
/** Update the title/meta/description lines while typing, without re-rendering (which would drop focus). */
function livePreview(i, el) {
  const s = shownDetails(i), f = curFilm(i);
  const t = el.querySelector('[data-show="title"]'); if (t) t.textContent = s.title;
  const yd = el.querySelector('[data-show="yeardir"]'); if (yd) yd.textContent = (s.year?' ('+s.year+')':'')+(s.director?', '+s.director:'');
  const meta = [s.genre, s.runtime?s.runtime+' min':null, f&&f.popularity!=null?'popularity '+f.popularity:null, f&&f.nowPlaying?'in US release':null].filter(Boolean).join(' · ');
  const m = el.querySelector('[data-show="meta"]'); if (m) { m.textContent = meta; m.hidden = !meta; }
  const o = el.querySelector('[data-show="overview"]'); if (o) { o.textContent = s.overview; o.hidden = !s.overview; }
  const tag = el.querySelector('.guess .tag'); if (tag) { const ed=hasEdits(i); tag.classList.toggle('edited', ed); tag.textContent = ed ? 'Edited' : f ? (U(i).match===(i.film&&i.film.tmdbId)?'TMDB guess':'Selected') : 'Title only'; }
  const inc = el.querySelector('[data-act="include"]'); if (inc) { const dr=dirty(i); inc.classList.toggle('dirty', dr); inc.disabled = !!(i.decision && i.decision.decision==='include' && !dr); if (dr) inc.textContent='Save changes'; }
}

// ---- lightbox --------------------------------------------------------------
const lb = { imgs: [], idx: 0 };
function cardImages(i) {
  const u = U(i), out = [], seen = new Set();
  const add = (src, label) => { if (src && !seen.has(src)) { seen.add(src); out.push({src, label}); } };
  const p = previewArt(i); if (p) add(p.src, 'Site card preview · '+p.label);
  const f = curFilm(i); if (f) { add(f.poster, f.title+' · TMDB poster'); add(f.backdrop, f.title+' · TMDB backdrop'); }
  add(i.venueImage, venueName(i.venueId)+' listing image');
  for (const id of [...u.order, ...u.results]) { const m=u.films[id]; if (m && m!==f) add(m.poster, m.title+(m.year?' ('+m.year+')':'')+' · poster'); }
  return out;
}
function openLightbox(i, startSrc) {
  lb.imgs = cardImages(i); if (!lb.imgs.length) return;
  lb.idx = Math.max(0, lb.imgs.findIndex(x=>x.src===startSrc)); showLb();
  $('#lb').hidden = false;
}
function showLb() { const x = lb.imgs[lb.idx]; $('#lbImg').src = hi(x.src); $('#lbCap').innerHTML = esc(x.label)+' · '+(lb.idx+1)+'/'+lb.imgs.length+' &nbsp; <span class="kbd">←</span><span class="kbd">→</span> or <span class="kbd">h</span><span class="kbd">l</span> browse · <span class="kbd">esc</span> close'; }
function closeLightbox() { $('#lb').hidden = true; $('#lbImg').src=''; }
$('#lb').onclick = (e) => { if (e.target.id==='lbImg') { lb.idx=(lb.idx+1)%lb.imgs.length; showLb(); } else closeLightbox(); };

// ---- wiring ------------------------------------------------------------------
function wire(i, el) {
  if (!el) return;
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
  el.querySelectorAll('[data-act]').forEach(b => b.onclick = stop(() => { const a=b.dataset.act; if(a==='include') commit(i,'include'); else if(a==='exclude') commit(i,'exclude'); else if(a==='undo') undo(i); else if(a==='edit') toggleEditor(i); }));
  el.querySelectorAll('[data-edit]').forEach(inp => {
    const k = inp.dataset.edit;
    inp.oninput = () => { const u=U(i), b=baseDetails(i); let v = inp.value; if (k==='year'||k==='runtime') v = v.trim()===''?'':Number(v); if (String(v)===String(b[k])) delete u.edits[k]; else u.edits[k]=v; inp.classList.toggle('changed', k in u.edits); livePreview(i, el); };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key==='Escape') { U(i).editing=false; rerender(i); } if (e.key==='Enter' && inp.tagName==='INPUT') { U(i).editing=false; rerender(i); } };
  });
  const rst = el.querySelector('[data-reset-edits]'); if (rst) rst.onclick = stop(() => { U(i).edits={}; rerender(i); });
  const cls = el.querySelector('[data-close-editor]'); if (cls) cls.onclick = stop(() => { U(i).editing=false; rerender(i); });
  el.querySelectorAll('[data-match]').forEach(b => b.onclick = stop((e) => { if (e.target.dataset.zoom) return openLightbox(i, e.target.dataset.zoom); const v=b.dataset.match; selectMatch(i, v==='none'?null:Number(v)); }));
  el.querySelectorAll('[data-art]').forEach(b => b.onclick = stop((e) => { if (e.target.dataset.zoom) return openLightbox(i, e.target.dataset.zoom); selectArt(i, b.dataset.art || null); }));
  const poster = el.querySelector('.poster'); poster.onclick = stop(() => { const p=previewArt(i); if (p) openLightbox(i, p.src); });
  const ov = el.querySelector('.overview'); if (ov) ov.onclick = stop(() => { U(i).open=!U(i).open; ov.classList.toggle('open'); });
  const artIn = el.querySelector('.arts input'), artGo = el.querySelector('.arts .inline button');
  const useUrl = () => { const v=artIn.value.trim(); U(i).custom=v; if (!/^https?:[/][/]/i.test(v)) return; selectArt(i, v); };
  artGo.onclick = stop(useUrl); artIn.onkeydown = (e) => { e.stopPropagation(); if (e.key==='Enter') useUrl(); if (e.key==='Escape') el.focus(); }; artIn.oninput = () => { U(i).custom = artIn.value; };
  const q = el.querySelector('.matches input'), go = el.querySelector('.matches .inline button'), note = el.querySelector('.results-note');
  const search = async () => { const s=q.value.trim(); U(i).q=s; if(!s) return; note.textContent='searching…';
    const d = await (await fetch('/api/search?q='+encodeURIComponent(s))).json();
    const u = U(i); for (const m of d.results.slice(0,8)) { if (!u.films[m.tmdbId]) u.films[m.tmdbId]=m; } u.results = d.results.slice(0,8).map(m=>m.tmdbId);
    rerender(i); const n = cardEl(i).querySelector('.results-note'); if (n) n.textContent = d.results.length ? d.results.length+' results added above' : 'no results';
    if (d.results.length) { const first = cardEl(i).querySelector('[data-match="'+d.results[0].tmdbId+'"]'); if (first) first.scrollIntoView({block:'nearest'}); } };
  go.onclick = stop(search); q.onkeydown = (e) => { e.stopPropagation(); if (e.key==='Enter') search(); if (e.key==='Escape') el.focus(); }; q.oninput = () => { U(i).q = q.value; };
}

// ---- keyboard: spatial hjkl across the grid, selection keys within a card --
function cards() { return [...document.querySelectorAll('#grid .item')]; }
function focusedCard() { const a=document.activeElement; return a && a.closest ? a.closest('.item') : null; }
function itemOf(el) { return el ? state.items.find(x=>x.key===el.dataset.key) : null; }
function move(dir) {
  const all = cards(); if (!all.length) return;
  const el = focusedCard();
  if (!el) { all[0].focus({preventScroll:true}); all[0].scrollIntoView({block:'center'}); return; }
  const idx = all.indexOf(el); let nx = null;
  if (dir==='l') nx = all[idx+1]; else if (dir==='h') nx = all[idx-1];
  else { // j/k: nearest card in the next/previous row, by horizontal centre
    const r = el.getBoundingClientRect(), cx = (r.left+r.right)/2; let bd = Infinity;
    for (const c of all) { if (c===el) continue; const q=c.getBoundingClientRect(); const dy = dir==='j' ? q.top-r.top : r.top-q.top; if (dy<=4) continue; const s = dy*10000 + Math.abs((q.left+q.right)/2-cx); if (s<bd) { bd=s; nx=c; } }
  }
  if (nx) { nx.focus({preventScroll:true}); nx.scrollIntoView({block: state.layout==='focus' ? 'start' : 'center', behavior:'smooth'}); }
}
function cycle(i, what, step) {
  const u = U(i);
  if (what==='match') { const opts = [...u.order, ...u.results.filter(id=>!u.order.includes(id)), null]; const at = opts.indexOf(u.match); selectMatch(i, opts[(at+step+opts.length)%opts.length]); }
  else { const opts = artOptions(i).map(o=>o.id); if (!opts.length) return; const at = opts.indexOf(u.art||null); selectArt(i, opts[(at+step+opts.length)%opts.length]); }
}
document.addEventListener('keydown', (e) => {
  if (!$('#lb').hidden) { if (e.key==='Escape'||e.key==='o') closeLightbox(); else if (e.key==='ArrowRight'||e.key==='l'||e.key==='j'||e.key===' ') { lb.idx=(lb.idx+1)%lb.imgs.length; showLb(); } else if (e.key==='ArrowLeft'||e.key==='h'||e.key==='k') { lb.idx=(lb.idx-1+lb.imgs.length)%lb.imgs.length; showLb(); } else return; e.preventDefault(); return; }
  if (e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if ('hjkl'.includes(k) && k.length===1) { move(k); e.preventDefault(); return; }
  if (k==='f') { setLayout(state.layout==='focus' ? 'grid' : 'focus'); e.preventDefault(); return; }
  if (k==='Enter' && state.layout!=='focus' && focusedCard()) { setLayout('focus'); e.preventDefault(); return; }
  const el = focusedCard(), i = itemOf(el);
  if (k==='u') { const t = (i && i.decision) ? i : state.last; if (t) { undo(t); const te=cardEl(t); if (te) { te.focus({preventScroll:true}); te.scrollIntoView({block:'nearest'}); } } e.preventDefault(); return; }
  if (!i) return;
  if (k==='y') { if (!(i.decision && i.decision.decision==='include' && !dirty(i))) commit(i,'include'); }
  else if (k==='t') { if (U(i).match!==null) { U(i).match=null; rerender(i); } commit(i,'include'); }
  else if (k==='n') { if (!(i.decision && i.decision.decision==='exclude')) commit(i,'exclude'); }
  else if (k==='m') cycle(i,'match',1); else if (k==='M') cycle(i,'art',1);
  else if (k==='o') { const p=previewArt(i); if (p) openLightbox(i, p.src); }
  else if (k==='/') { const q=el.querySelector('.matches input'); if (q) { q.focus(); q.select(); } }
  else if (k==='d') toggleEditor(i);
  else if (k==='b') window.open(letterboxdUrl(i), '_blank', 'noopener');
  else if (k==='O') window.open(i.url, '_blank', 'noopener');
  else if (k>='0' && k<='9') { const u=U(i); if (k==='0') selectMatch(i,null); else { const opts=[...u.order, ...u.results.filter(id=>!u.order.includes(id))]; const id=opts[Number(k)-1]; if (id!=null) selectMatch(i,id); } }
  else return;
  e.preventDefault();
});
$('#rebuild').onclick = async () => { const b=$('#rebuild'); b.disabled=true; showStatus('rebuilding…'); const d=await post('/api/rebuild',{}); b.disabled=false; if (d.lastBuild) { state.lastBuild=d.lastBuild; showStatus(); } else showStatus(d.error||''); };
setLayout(state.layout);
// The sticky header changes height as chip rows render, so keep the scroll margin in step with it.
const fitHead = () => { const h = document.querySelector('header').offsetHeight + 14; document.documentElement.style.setProperty('--head', h+'px'); document.documentElement.style.setProperty('--headpx', h+'px'); };
fitHead(); window.addEventListener('resize', fitHead); new ResizeObserver(fitHead).observe(document.querySelector('header'));
load();
</script>
</body>
</html>`;
