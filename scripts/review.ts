/**
 * npm run review
 *
 * Local review UI for titles the classifier could not decide. Reads the
 * snapshot sync wrote to .cache/resolved.json, shows every undecided title
 * with its TMDB poster, alternatives and a search box, and saves each decision
 * to data/decisions.json the moment you click. The schedule
 * (data/screenings.json) is rebuilt after each decision, so Astro dev updates
 * live. No dependencies; plain node:http.
 */
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { finalizeSchedule, loadResolved, type ResolvedItem } from './lib/build.ts';
import { loadEnv, option } from './lib/env.ts';
import { loadDecisions, saveDecisions } from './lib/store.ts';
import { searchMovies } from './lib/tmdb.ts';
import type { DecisionRecord, TmdbMovie } from './lib/types.ts';

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

function pickMovie(m: TmdbMovie) {
  return {
    id: m.id,
    title: m.title,
    year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
    popularity: m.popularity ? Math.round(m.popularity) : null,
    poster: m.poster_path ? `${IMG}/w185${m.poster_path}` : null,
    overview: m.overview ?? null,
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
    film: item.film
      ? {
          tmdbId: item.film.tmdbId,
          title: item.film.title,
          year: item.film.year,
          director: item.film.director,
          runtime: item.film.runtime,
          genre: item.film.genre,
          popularity: item.film.popularity ? Math.round(item.film.popularity) : null,
          poster: item.film.poster,
          backdrop: item.film.backdrop,
          nowPlaying: !!item.film.nowPlaying,
          overview: item.overview ?? null,
        }
      : null,
    alternatives: item.alternatives.map(pickMovie),
    decision: decision ? { decision: decision.decision, tmdbId: decision.tmdbId, decidedAt: decision.decidedAt } : null,
  };
}

let rebuildTimer: NodeJS.Timeout | null = null;
let lastBuild: { at: string; screenings: number; films: number } | null = null;
function scheduleRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    const snap = loadResolved();
    if (!snap) return;
    try {
      const r = await finalizeSchedule(snap);
      lastBuild = { at: new Date().toISOString(), screenings: r.data.screenings.length, films: Object.keys(r.data.films).length };
      console.log(`  rebuilt schedule: ${lastBuild.screenings} screenings, ${lastBuild.films} films`);
    } catch (err) {
      console.error('  rebuild failed:', (err as Error).message);
    }
  }, 800);
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
      return json(res, 200, { generatedAt: snap.generatedAt, venues: snap.venues, items, autoIncluded, autoExcluded, lastBuild });
    }
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const q = url.searchParams.get('q')?.trim() ?? '';
      const year = Number(url.searchParams.get('year')) || undefined;
      if (!q) return json(res, 200, { results: [] });
      const results = await searchMovies(q, year);
      return json(res, 200, { results: results.map(pickMovie) });
    }
    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const body = await readBody(req);
      const { key, decision, tmdbId, title } = body as { key: string; decision: 'include' | 'exclude'; tmdbId?: number | null; title?: string };
      if (!key || (decision !== 'include' && decision !== 'exclude')) return json(res, 400, { error: 'bad request' });
      const decisions = loadDecisions();
      decisions[key] = {
        decision,
        title: title ?? decisions[key]?.title ?? key,
        tmdbId: decision === 'include' ? (tmdbId === undefined ? undefined : tmdbId) : undefined,
        decidedAt: new Date().toISOString(),
      };
      saveDecisions(decisions);
      scheduleRebuild();
      return json(res, 200, { ok: true, decision: decisions[key] });
    }
    if (req.method === 'POST' && url.pathname === '/api/undo') {
      const { key } = (await readBody(req)) as { key: string };
      const decisions = loadDecisions();
      delete decisions[key];
      saveDecisions(decisions);
      scheduleRebuild();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/rebuild') {
      const snap = loadResolved();
      if (!snap) return json(res, 400, { error: 'no snapshot' });
      const r = await finalizeSchedule(snap);
      lastBuild = { at: new Date().toISOString(), screenings: r.data.screenings.length, films: Object.keys(r.data.films).length };
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
  console.log('Ctrl+C to stop. Decisions save as you click; the schedule rebuilds automatically.');
  if (platform() === 'darwin' && !process.argv.includes('--no-open')) exec(`open ${addr}`);
});

// --------------------------------------------------------------------------
// The page. Vanilla HTML/JS, kept in one string so the tool stays dependency-free.
// --------------------------------------------------------------------------
const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review queue · Screen Bay</title>
<style>
  :root { --bg:#f6f4ee; --ink:#16181d; --muted:#6b6f7a; --line:#dcd8cd; --card:#fff; --accent:#4b5b8a; --chip:#eceae2;
          --ok:#2f7d4f; --no:#b2432f; --warn:#b98a1c; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.4 -apple-system,BlinkMacSystemFont,Inter,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased }
  a { color:inherit }
  header { position:sticky; top:0; z-index:5; background:color-mix(in srgb,var(--bg) 94%,transparent); backdrop-filter:blur(8px); border-bottom:1px solid var(--line) }
  .bar { max-width:1320px; margin:0 auto; padding:10px 20px; display:flex; flex-wrap:wrap; gap:10px 18px; align-items:center }
  .brand { font-weight:800; letter-spacing:-.02em; font-size:1.1rem } .brand span{color:var(--accent)}
  .counts { color:var(--muted); font-size:.9rem }
  .tabs, .venues { display:flex; gap:6px; flex-wrap:wrap }
  .chip { border:1px solid var(--line); background:var(--chip); border-radius:999px; padding:4px 11px; font:inherit; font-size:.82rem; cursor:pointer; color:var(--ink) }
  .chip[aria-pressed=true] { background:var(--accent); color:#fff; border-color:var(--accent) }
  .spacer { flex:1 }
  .status { font-size:.82rem; color:var(--muted) }
  button.primary { border:0; background:var(--ink); color:#fff; border-radius:8px; padding:7px 12px; font:inherit; font-size:.85rem; cursor:pointer }
  main { max-width:1320px; margin:0 auto; padding:18px 20px 80px; display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(400px,1fr)) }
  .item { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; display:grid; grid-template-columns:150px 1fr; outline:none }
  .item:focus-within, .item:focus { box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 35%,transparent) }
  .item.decided { opacity:.62 }
  .item.decided.include { border-color:var(--ok) } .item.decided.exclude { border-color:var(--no) }
  .poster { background:#2a2d36; min-height:225px; position:relative }
  .poster img { width:100%; height:100%; object-fit:cover; display:block; position:absolute; inset:0 }
  .poster .none { position:absolute; inset:0; display:grid; place-items:center; color:#9aa0b0; font-size:.75rem; letter-spacing:.08em; text-transform:uppercase; text-align:center; padding:10px }
  .body { padding:12px 14px 12px; display:flex; flex-direction:column; gap:6px; min-width:0 }
  .venue { font-size:.72rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--accent) }
  .raw { font-weight:700; font-size:1.05rem; line-height:1.2; letter-spacing:-.01em }
  .raw a { text-decoration:none } .raw a:hover { text-decoration:underline }
  .guess { font-size:.9rem } .guess b { font-weight:600 }
  .meta, .reason, .times { font-size:.82rem; color:var(--muted) }
  .reason b { color:var(--warn); font-weight:600 }
  .overview { font-size:.8rem; color:var(--muted); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden }
  .times { line-height:1.5 } .times span { white-space:nowrap }
  .actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:auto; padding-top:6px }
  .actions button { border:1px solid var(--line); background:var(--chip); border-radius:8px; padding:6px 10px; font:inherit; font-size:.83rem; cursor:pointer; color:var(--ink) }
  .actions button.yes { background:var(--ok); color:#fff; border-color:var(--ok) }
  .actions button.no { background:var(--no); color:#fff; border-color:var(--no) }
  .actions button:disabled { opacity:.5; cursor:default }
  .alts { display:flex; gap:6px; flex-wrap:wrap; align-items:flex-start }
  .alt { width:64px; border:0; padding:0; background:none; cursor:pointer; text-align:left; font:inherit; color:inherit }
  .alt img, .alt .ph { width:64px; height:96px; object-fit:cover; border-radius:5px; background:#2a2d36; display:block; border:2px solid transparent }
  .alt:hover img, .alt:hover .ph { border-color:var(--accent) }
  .alt small { display:block; font-size:.68rem; line-height:1.2; color:var(--muted); margin-top:3px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical }
  .search { display:flex; gap:6px } .search input { flex:1; font:inherit; font-size:.83rem; padding:5px 8px; border:1px solid var(--line); border-radius:7px; background:#fff }
  .badge { position:absolute; top:8px; left:8px; font-size:.7rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; padding:3px 7px; border-radius:5px; color:#fff; background:var(--ok) }
  .badge.exclude { background:var(--no) }
  .kbd { font-family:ui-monospace,Menlo,monospace; font-size:.75rem; background:var(--chip); border:1px solid var(--line); border-radius:4px; padding:0 5px; color:var(--muted) }
  .empty { grid-column:1/-1; padding:80px 0; text-align:center; color:var(--muted) }
  .help { font-size:.8rem; color:var(--muted) }
  @media (max-width:520px){ .item{grid-template-columns:110px 1fr} main{grid-template-columns:1fr} }
</style>
</head>
<body>
<header><div class="bar">
  <div class="brand">Screen <span>Bay</span> · review</div>
  <div class="counts" id="counts">loading…</div>
  <div class="tabs" id="tabs">
    <button class="chip" data-tab="pending" aria-pressed="true">Pending</button>
    <button class="chip" data-tab="decided" aria-pressed="false">Decided</button>
    <button class="chip" data-tab="all" aria-pressed="false">All</button>
  </div>
  <div class="venues" id="venues"></div>
  <div class="spacer"></div>
  <span class="help">focus a card, then <span class="kbd">y</span> include · <span class="kbd">t</span> title only · <span class="kbd">n</span> exclude · <span class="kbd">u</span> undo</span>
  <span class="status" id="status"></span>
  <button class="primary" id="rebuild">Rebuild schedule</button>
</div></header>
<main id="grid"></main>
<script>
const state = { items: [], venues: [], tab: 'pending', venue: 'all', autoIncluded: 0, autoExcluded: 0 };
const $ = (s, el=document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate = (d) => { const [y,m,dd]=d.split('-').map(Number); return new Date(Date.UTC(y,m-1,dd)).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}); };
const fmtTime = (t) => { const [h,m]=t.split(':').map(Number); return (h%12||12)+':'+String(m).padStart(2,'0')+(h>=12?' PM':' AM'); };
const venueName = (id) => (state.venues.find(v=>v.id===id)||{}).shortName || id;

async function load() {
  const r = await fetch('/api/state'); const d = await r.json();
  if (d.error) { $('#grid').innerHTML = '<div class="empty">'+esc(d.error)+'</div>'; $('#counts').textContent=''; return; }
  Object.assign(state, { items:d.items, venues:d.venues, autoIncluded:d.autoIncluded, autoExcluded:d.autoExcluded });
  renderVenues(); render();
  if (d.lastBuild) $('#status').textContent = 'schedule: '+d.lastBuild.screenings+' screenings, '+d.lastBuild.films+' films';
}
function renderVenues() {
  const ids = [...new Set(state.items.map(i=>i.venueId))];
  $('#venues').innerHTML = ['all',...ids].map(id => '<button class="chip" data-venue="'+esc(id)+'" aria-pressed="'+(state.venue===id)+'">'+esc(id==='all'?'All venues':venueName(id))+'</button>').join('');
  $('#venues').querySelectorAll('button').forEach(b => b.onclick = () => { state.venue=b.dataset.venue; render(); renderVenues(); });
}
function visible() {
  return state.items.filter(i => (state.venue==='all'||i.venueId===state.venue) && (state.tab==='all' || (state.tab==='pending' ? !i.decision : !!i.decision)));
}
function render() {
  const pending = state.items.filter(i=>!i.decision).length, decided = state.items.length-pending;
  $('#counts').textContent = pending+' pending · '+decided+' decided · '+state.autoIncluded+' auto-included · '+state.autoExcluded+' auto-excluded';
  $('#tabs').querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.tab===state.tab)); b.onclick = () => { state.tab=b.dataset.tab; render(); }; });
  const list = visible();
  const grid = $('#grid');
  grid.innerHTML = list.length ? list.map(card).join('') : '<div class="empty">'+(state.tab==='pending'?'Nothing left to review. Run <b>npm run sync</b> again later.':'Nothing here.')+'</div>';
  list.forEach(i => wire(i, grid.querySelector('[data-key="'+cssEsc(i.key)+'"]')));
}
const cssEsc = (s) => s.replace(/["\\\\]/g, '\\\\$&');
function card(i) {
  const f = i.film, d = i.decision;
  const chosenAlt = d && d.tmdbId && f && d.tmdbId!==f.tmdbId ? i.alternatives.find(a=>a.id===d.tmdbId) : null;
  const poster = chosenAlt ? chosenAlt.poster : (f && f.poster);
  const decidedLabel = d ? (d.decision==='exclude' ? 'excluded' : d.tmdbId===null ? 'title only' : 'included') : '';
  const times = i.showtimes.slice(0,6).map(s=>'<span>'+fmtDate(s.date)+' '+fmtTime(s.time)+'</span>').join(' · ') + (i.showtimes.length>6?' · +'+(i.showtimes.length-6)+' more':'');
  return '<article class="item '+(d?'decided '+d.decision:'')+'" tabindex="0" data-key="'+esc(i.key)+'">'
   + '<div class="poster">'+(poster?'<img src="'+esc(poster)+'" alt="">':'<div class="none">no TMDB match</div>')+(d?'<span class="badge '+d.decision+'">'+decidedLabel+'</span>':'')+'</div>'
   + '<div class="body">'
   + '<div class="venue">'+esc(venueName(i.venueId))+'</div>'
   + '<div class="raw"><a href="'+esc(i.url)+'" target="_blank" rel="noopener">'+esc(i.rawTitle)+'</a></div>'
   + (f ? '<div class="guess">TMDB: <b>'+esc(f.title)+'</b>'+(f.year?' ('+f.year+')':'')+(f.director?', '+esc(f.director):'')+'</div>'
        + '<div class="meta">'+[f.genre, f.runtime?f.runtime+' min':null, f.popularity!=null?'popularity '+f.popularity:null, f.nowPlaying?'in US release':null].filter(Boolean).map(esc).join(' · ')+'</div>'
        + (f.overview?'<div class="overview">'+esc(f.overview)+'</div>':'')
      : '<div class="guess">No TMDB match for “'+esc(i.cleanTitle)+'”</div>')
   + '<div class="reason"><b>Why:</b> '+esc(i.reason)+'</div>'
   + '<div class="times">'+times+'</div>'
   + (i.alternatives.length ? '<div class="alts">'+i.alternatives.map(a=>'<button class="alt" data-alt="'+a.id+'" title="Include as '+esc(a.title)+'">'+(a.poster?'<img src="'+esc(a.poster)+'" alt="">':'<div class="ph"></div>')+'<small>'+esc(a.title)+(a.year?' ('+a.year+')':'')+'</small></button>').join('')+'</div>' : '')
   + '<div class="search"><input type="search" placeholder="Search TMDB for a different match…" value=""><button class="chip">Search</button></div>'
   + '<div class="alts results"></div>'
   + '<div class="actions">'
   + (f?'<button class="yes" data-act="include">✓ Include</button>':'')
   + '<button data-act="title">Include, title only</button>'
   + '<button class="no" data-act="exclude">✕ Exclude</button>'
   + (d?'<button data-act="undo">Undo</button>':'')
   + '</div></div></article>';
}
async function decide(i, decision, tmdbId) {
  const body = { key:i.key, decision, title:i.rawTitle };
  if (decision==='include') body.tmdbId = tmdbId; // number = specific match, null = title only, undefined = best guess
  if (decision==='include' && tmdbId===undefined && i.film) body.tmdbId = i.film.tmdbId;
  const r = await fetch('/api/decide',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const d = await r.json(); if (d.error) return alert(d.error);
  i.decision = d.decision; $('#status').textContent = 'saved · rebuilding schedule…'; render();
  setTimeout(load, 1500);
}
async function undo(i) {
  await fetch('/api/undo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:i.key})});
  i.decision = null; render(); setTimeout(load, 1500);
}
function wire(i, el) {
  if (!el) return;
  el.querySelectorAll('[data-act]').forEach(b => b.onclick = (e) => { e.stopPropagation();
    const a=b.dataset.act; if(a==='include') decide(i,'include'); else if(a==='title') decide(i,'include',null); else if(a==='exclude') decide(i,'exclude'); else if(a==='undo') undo(i); });
  el.querySelectorAll('[data-alt]').forEach(b => b.onclick = () => decide(i,'include',Number(b.dataset.alt)));
  const input = el.querySelector('.search input'), go = el.querySelector('.search button'), out = el.querySelector('.results');
  const run = async () => { const q=input.value.trim(); if(!q) return; out.innerHTML='<small class="meta">searching…</small>';
    const r = await fetch('/api/search?q='+encodeURIComponent(q)); const d = await r.json();
    out.innerHTML = d.results.length ? d.results.slice(0,8).map(a=>'<button class="alt" data-res="'+a.id+'">'+(a.poster?'<img src="'+esc(a.poster)+'" alt="">':'<div class="ph"></div>')+'<small>'+esc(a.title)+(a.year?' ('+a.year+')':'')+'</small></button>').join('') : '<small class="meta">no results</small>';
    out.querySelectorAll('[data-res]').forEach(b => b.onclick = () => decide(i,'include',Number(b.dataset.res))); };
  go.onclick = run; input.onkeydown = (e) => { if(e.key==='Enter') run(); e.stopPropagation(); };
  el.onkeydown = (e) => { if (e.target.tagName==='INPUT') return;
    if(e.key==='y'&&i.film) decide(i,'include'); else if(e.key==='t') decide(i,'include',null); else if(e.key==='n') decide(i,'exclude'); else if(e.key==='u'&&i.decision) undo(i);
    else if(e.key==='j'||e.key==='k'){ const s=[...document.querySelectorAll('.item')]; const idx=s.indexOf(el); const nx=s[idx+(e.key==='j'?1:-1)]; if(nx){nx.focus(); nx.scrollIntoView({block:'center'});} } };
}
$('#rebuild').onclick = async () => { $('#status').textContent='rebuilding…'; const r=await fetch('/api/rebuild',{method:'POST'}); const d=await r.json(); $('#status').textContent = d.lastBuild ? 'schedule: '+d.lastBuild.screenings+' screenings, '+d.lastBuild.films+' films' : (d.error||''); };
load();
</script>
</body>
</html>`;
