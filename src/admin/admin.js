'use strict';

// GitBracket admin page — the browser UI for the local daemon. Pure client:
// every write goes through /api/edit, which validates + commits server-side,
// so the browser can never outrun the gate. derive.js (a classic script above)
// is the shared domain model — its top-level names are already page globals.

const $ = id => document.getElementById(id);

// ---- tiny state ----
const S = {
  slug: null, day: null, tjson: null, tz: 'UTC', gcd: 15,
  pxPerMin: 1.2, dayStart: 0, dayEnd: 0,
  cats: [], venues: [], days: [], dragSource: null, ghost: null, legal: null,
};

// ---- derive wrappers (derive.js globals) ----
const cat = cid => S.cats.find(c => c.id === cid);
const matchOf = (cid, id) => cat(cid)?.byId.get(Number(id));

// the day's span a wall "HH:MM" string; the grid works in wall-clock minutes —
// never offsets (the data is wall time; the tz only anchors it for feeder bounds)
const wallMin = iso => { const m = /T(\d{2}):(\d{2})/.exec(String(iso || '')); return m ? +m[1] * 60 + +m[2] : null; };
const pad = n => String(n).padStart(2, '0');
const isoOf = (day, wm) => `${day}T${pad(Math.floor(wm / 60))}:${pad(wm % 60)}:00`;

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; }
function gridGcd(tjson) {
  let g = 0;
  const add = n => { if (Number.isInteger(n) && n > 0) g = gcd(g, n); };
  for (const c of (tjson.categories || [])) { const sm = c.slotMinutes || {}; add(sm.groups); add(sm.knockout); }
  for (const cid of Object.keys(tjson.matches || {}))
    for (const m of tjson.matches[cid] || []) if (m) add(m.slotMinutes);
  return g || 15;
}

// A match's wall-time window on a day, as [startMin, endMin] or null.
function dayWindow(m, ctx) {
  if (m.scheduled == null) return null;
  const wm = wallMin(m.scheduled);
  if (wm == null) return null;
  const slot = matchSlotMs(m, ctx) / 60000;
  return Number.isFinite(slot) ? [wm, wm + slot] : null;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- fetch helpers ----
async function get(url) { const r = await fetch(url); return r.ok ? r.json() : null; }
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* no body */ }
  return { ok: r.ok, ...(j || {}) };
}
let flashTimer = null;
function flash(msg) {
  const el = $('flash');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---- data loading ----
function teamText(side, ctx) {
  const ids = resolveSide(side, ctx);
  return ids ? teamLabel([...ids], ctx) : sideLabel(side, ctx);
}
function teamSize(ctx) {
  for (const m of ctx.matches) {
    if (!m || !Array.isArray(m.sides)) continue;
    for (const s of m.sides) if (s && s.kind === 'players' && Array.isArray(s.ids)) return s.ids.length;
  }
  return 1;
}
function pools(ctx) { return [...new Set(ctx.matches.map(m => m && m.pool).filter(Boolean))]; }

async function setSlug(slug) {
  S.slug = slug;
  S.tjson = await get('/api/data?slug=' + slug);
  if (!S.tjson) return;
  S.tz = S.tjson.timezone || 'UTC';
  S.gcd = gridGcd(S.tjson);
  S.cats = toCats(S.tjson);
  S.venues = S.tjson.venues || [];
  S.days = computeDays();
  const daySel = $('day');
  daySel.innerHTML = S.days.map(d => `<option>${d}</option>`).join('');
  S.day = S.days[0] || null;
  renderGrid();
  refreshPending();
}

// keep slug/day/selection, just re-fetch the data after an edit or undo
async function reload() { await setSlug(S.slug); }

function computeDays() {
  const ks = new Set();
  for (const c of S.cats) for (const m of c.matches) { const t = schedTime(m, S.tz); if (t !== null) ks.add(dayKey(t, S.tz)); }
  return [...ks].sort();
}

// Fill the board's height when the day fits; floor the scale so even the smallest
// slot is tall enough for a scored card's three rows — no clipping, no overlap.
function fitScale() {
  const sc = $('board');
  const avail = sc ? sc.clientHeight : 0;
  const total = S.dayEnd - S.dayStart || 1;
  S.pxPerMin = Math.max(1.6, avail / total);
}

// ---- the grid ----
function renderGrid() {
  const grid = $('grid');
  S.legal = null; // a re-render (day switch, edit, undo) invalidates the slots
  const dayMatches = [];
  for (const c of S.cats) for (const m of c.matches) {
    const t = schedTime(m, S.tz);
    if (t !== null && dayKey(t, S.tz) === S.day) dayMatches.push({ c, m, ctx: c });
  }
  let mins = dayMatches.map(({ c, m }) => dayWindow(m, c)).filter(Boolean).flat();
  let dayStart = mins.length ? Math.min(...mins) : 8 * 60;
  let dayEnd = mins.length ? Math.max(...mins) : 20 * 60;
  dayStart = Math.floor((dayStart - 15) / S.gcd) * S.gcd; // pad a couple ticks
  dayEnd = Math.ceil((dayEnd + 15) / S.gcd) * S.gcd;
  if (dayStart < 0) dayStart = 0;
  S.dayStart = dayStart; S.dayEnd = dayEnd;
  fitScale(); // scale to the board's height so short days fill it, long days scroll
  const h = (dayEnd - dayStart) * S.pxPerMin;
  grid.style.height = h + 'px';

  const cols = S.venues.map(v => v.id);
  grid.style.gridTemplateColumns = `4.5rem ${cols.map(() => 'minmax(9rem,1fr)').join(' ')} 13rem`;

  let html = '<div class="ruler">';
  for (let hm = Math.floor(dayStart / 60) * 60; hm <= dayEnd; hm += 60) {
    const y = (hm - dayStart) * S.pxPerMin;
    html += `<div class="hour" style="top:${y}px"></div><div class="hourlabel" style="top:${y}px">${pad(hm / 60)}:00</div>`;
  }
  html += '</div>';
  for (const vid of cols) {
    const v = S.venues.find(x => x.id === vid);
    const name = v ? v.name : vid;
    const here = dayMatches.filter(({ m }) => m.venue === vid);
    html += `<div class="col" data-venue="${esc(vid)}"><div class="colhead">${esc(name)}</div>`;
    for (const { c, m } of here) html += cardHtml(c, m, vid);
    html += '</div>';
  }
  const unsched = [];
  for (const c of S.cats) for (const m of c.matches) if (m.scheduled == null || m.venue == null) unsched.push({ c, m }); // a time without a venue (panel edit) must stay visible — the column is its only home
  html += '<div class="col unsched" data-venue="__none"><div class="colhead">Unscheduled / unplaced</div>';
  for (const { c, m } of unsched) html += cardHtml(c, m, null);
  html += '</div>';

  grid.innerHTML = html;
  wireGrid();
}

// The card's meta line — time · category · match label.
function cardMeta(c, m) {
  const t = schedTime(m, S.tz);
  const time = t !== null ? fmtTime(t, S.tz) : '—';
  return `${time} · ${c.name || c.id} · ${matchLabel(m, c)}`;
}

function cardHtml(c, m, venue) {
  const st = isDone(m) ? m.result.status : 'open';
  const stCls = st === 'open' ? '' : ' done';
  // wall-time placement in the day's px-per-minute scale; unscheduled cards in
  // the unscheduled column are flow-positioned (their .unsched .match rule)
  const wm = (m.scheduled != null && venue) ? wallMin(m.scheduled) : null;
  const slot = matchSlotMs(m, c) / 60000;
  const pos = wm != null && Number.isFinite(slot)
    ? ` style="top:${(wm - S.dayStart) * S.pxPerMin}px;min-height:${slot * S.pxPerMin}px;"` : '';
  const k = keyOf(c, m);
  // one side row per side, meta last; a drag grip leads — only the grip drags,
  // and the whole card (minus grip + pencils) is the score target
  return `<article class="match${stCls}" data-key="${esc(k)}" data-venue="${esc(venue || '')}"${pos}>
    <span class="grip" draggable="true" title="Drag to move"></span>
    ${sideRow(c, m, 0)}${sideRow(c, m, 1)}
    <div class="meta">${esc(cardMeta(c, m))}</div>
  </article>`;
}

// One row per side: the name is inert display text, the pencil is the only
// side-edit surface, and the score rides the row (the card handles score entry).
function sideRow(c, m, i) {
  const sideName = esc(teamText(m.sides[i], c));
  return `<div class="side"${winnerIdx(m) === i ? ' data-win' : ''}><span class="name">${sideName}</span><button type="button" class="edit-side" data-side="${i}" title="edit side ${i === 0 ? 'a' : 'b'}" aria-label="edit side ${i === 0 ? 'a' : 'b'} — ${sideName}">✎</button><span class="score">${scoreCell(c, m, i)}</span></div>`;
}

// placeholder dots keep the best-of shape, the winner carries the W/O mark.
function scoreCell(c, m, i) {
  const r = m.result;
  const games = m.games || [];
  const bo = bestOfOf(m, c) || 1; // unset stage config -> one unmarked slot
  const slots = () => Array.from({ length: bo }, (_, g) => {
    const game = games[g];
    // aria-hidden: the placeholder dot is shape-as-label, noise to a screen reader
    return `<span${game ? '' : ' class="ph" aria-hidden="true"'}>${game ? (i === 0 ? game.a : game.b) : '·'}</span>`;
  }).join('');
  return !r || r.status === 'played' ? slots()
    : r.status === 'void' ? '<span>void</span>'
    : sideIdx(r.winner) === i ? '<span>W/O</span>'
    : slots();
}

const keyOf = (c, m) => `${c.id}:${m.id}`;
const keyParts = k => { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; };

function wireGrid() {
  const grid = $('grid');
  // Board-level listeners bind once — only the .match nodes are recreated per render.
  if (!grid.dataset.wired) {
    grid.dataset.wired = '1';
    grid.addEventListener('dragover', e => { e.preventDefault(); ghost(e); });
    grid.addEventListener('dragleave', e => { if (e.relatedTarget == null) clearGhost(); });
    grid.addEventListener('drop', e => { e.preventDefault(); dropAt(e); });
  }
  grid.querySelectorAll('.match').forEach(el => {
    el.querySelectorAll('.edit-side').forEach(btn => btn.addEventListener('click', e => {
      const [cid, mid] = keyParts(el.dataset.key);
      openSide(cid, matchOf(cid, mid), +btn.dataset.side);
    }));
    // the whole card is the score target; the grip and the per-side pencils are not
    el.addEventListener('click', e => {
      if (e.target.closest('.grip, .edit-side')) return;
      const [cid, mid] = keyParts(el.dataset.key);
      openResult(cid, matchOf(cid, mid));
    });
    el.addEventListener('dragstart', e => {
      S.dragSource = el.dataset.key;
      e.dataTransfer.setData('text/plain', S.dragSource);
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // only the grip is draggable, so the drag image is the little grip by
      // default — anchor the whole card where the grip was grabbed instead
      const r = el.getBoundingClientRect();
      e.dataTransfer.setDragImage(el, e.clientX - r.left, e.clientY - r.top);
      const [cid, mid] = keyParts(S.dragSource);
      loadSlots(cid, mid); // legal starts for the dragged match — the ghost snaps to these
    });
    el.addEventListener('dragend', () => { clearGhost(); S.dragSource = null; renderGrid(); });
  });
}

// The candidate (venue, wallMin) under the pointer, in raw minutes — legal
// snapping happens against the daemon's slot list, not the old gcd-only grid.
function hitTest(e) {
  const grid = $('grid');
  const gr = grid.getBoundingClientRect();
  const x = e.clientX - gr.left, y = e.clientY - gr.top;
  const cols = grid.querySelectorAll('.col');
  let venue = null;
  for (const c of cols) { const cr = c.getBoundingClientRect(); if (x >= cr.left - gr.left && x <= cr.right - gr.left) { venue = c.dataset.venue; break; } }
  if (venue == null) return null;
  const wm = S.dayStart + Math.round(y / S.pxPerMin);
  return { venue, wm };
}

// The nearest legal start-minute in a venue column — null when the column has
// none, so the ghost reads "no legal slot" instead of snapping to a spot the
// write gate would reject.
function legalSnap(venue, wm) {
  const ticks = S.legal && S.legal.byVenue.get(venue);
  if (!ticks || !ticks.length) return null;
  let best = ticks[0];
  for (const t of ticks) if (Math.abs(t - wm) < Math.abs(best - wm)) best = t;
  return best;
}

// Legal start-minutes per venue for one match, from the daemon (the gate's own
// rules — venue/player/feeder), computed once per drag.
async function loadSlots(cid, mid) {
  const r = await get(`/api/slots?slug=${S.slug}&cat=${cid}&id=${mid}&day=${S.day}&gcd=${S.gcd}`);
  S.legal = { byVenue: new Map(Object.entries((r && r.ok) || {})) };
}

// Live ghost preview of the drop target — position by the pointer, legality by
// the daemon's slot list; invalid targets shrink to a red marker.
function ghost(e) {
  const src = S.dragSource;
  if (!src) return;
  const [cid, mid] = keyParts(src);
  const ctx = cat(cid), m = matchOf(cid, mid);
  const ht = hitTest(e);
  clearGhost();
  if (!ht) return;
  const slot = matchSlotMs(m, ctx) / 60000;
  if (!Number.isFinite(slot)) return;
  const col = $('grid').querySelector(`.col[data-venue="${CSS.escape(ht.venue)}"]`);
  if (!col) return;
  if (ht.venue === '__none') { // unscheduled is always legal — the daemon never receives a placement
    const g = document.createElement('div');
    g.className = 'ghost';
    g.style.top = '.5rem'; g.style.height = '2.5rem';
    col.appendChild(g); S.ghost = g; return;
  }
  // the slot list may still be in flight from dragstart — a neutral ghost then
  const wm = S.legal ? legalSnap(ht.venue, ht.wm) : Math.round(ht.wm / S.gcd) * S.gcd;
  const ok = S.legal ? wm !== null : true;
  const g = document.createElement('div');
  g.className = 'ghost' + (ok ? '' : ' invalid');
  g.style.top = (wm - S.dayStart) * S.pxPerMin + 'px';
  g.style.height = (ok ? slot : 2.5) * S.pxPerMin + 'px';
  g.title = ok ? '' : 'no legal slot here';
  col.appendChild(g);
  S.ghost = g;
}
function clearGhost() { if (S.ghost) { S.ghost.remove(); S.ghost = null; } }

async function dropAt(e) {
  const src = S.dragSource;
  if (!src) return;
  const [cid, mid] = keyParts(src);
  const ht = hitTest(e);
  if (!ht) return;
  let time, venue;
  if (ht.venue === '__none') { time = null; venue = null; }
  else {
    if (!S.legal) await loadSlots(cid, mid); // a drop can beat the dragstart fetch
    const wm = legalSnap(ht.venue, ht.wm);
    if (wm === null) { flash('no legal slot here'); return; }
    time = isoOf(S.day, wm); venue = ht.venue;
  }
  await sendEdit('move', cid, mid, { time, venue });
}

// ---- edits ----
async function sendEdit(verb, cid, mid, value) {
  const r = await post('/api/edit', { slug: S.slug, verb, cat: cid, matchId: mid, value });
  if (!r.ok) { flash(r.errors ? r.errors.join('\n') : r.error); return false; }
  await reload(); // setSlug re-renders the grid + editor and refreshes pending
  return true;
}

// ---- the result modal ----
// One result grammar, same as the terminal editor: bare games · wo a/b · void ·
// empty clears. The shape rides the value; validity past shape (target count,
// even best-of…) is the daemon's gate, flashed back on a failed write.
function parseResult(s) {
  const toks = s.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return { value: { shape: 'clear' } }; // empty input is a deliberate clear
  if (toks[0] === 'wo') {
    return toks.length === 2 && (toks[1] === 'a' || toks[1] === 'b')
      ? { value: { shape: 'walkover', winner: toks[1] } }
      : { err: 'expected a or b after wo' };
  }
  if (toks[0] === 'void') return toks.length > 1 ? { err: 'void takes nothing else' } : { value: { shape: 'void' } };
  const games = [];
  for (const t of toks) {
    const mm = /^(\d+)[:-](\d+)$/.exec(t);
    if (!mm) return { err: `bad score ${JSON.stringify(t)} — expected a-b` };
    games.push({ a: +mm[1], b: +mm[2] });
  }
  return { value: { shape: 'score', games } };
}

function openResult(cid, m) {
  const ctx = cat(cid);
  const hasOutcome = !!(m.games || m.result);
  const pre = m.games ? m.games.map(g => `${g.a}-${g.b}`).join(' ') : m.result && m.result.status === 'walkover' ? `wo ${m.result.winner}` : m.result && m.result.status === 'void' ? 'void' : '';
  // a realistic example for this match's best-of: a 2-1 (3 games) won at full length,
  // winners alternating so the shape is legible — games 1,3,5… go A, games 2,4… go B
  const bo = bestOfOf(m, ctx) || 1;
  const ex = Array.from({ length: bo }, (_, g) => g % 2 ? '17-21' : '21-19').join(' ');
  const modal = $('modal');
  modal.hidden = false;
  modal.innerHTML = `<div class="box">
    <p class="kicker">Result</p>
    <h2 class="sides">${esc(teamText(m.sides[0], ctx))} vs ${esc(teamText(m.sides[1], ctx))}</h2>
    <p class="sub">${esc(cardMeta(ctx, m))}</p>
    <input type="text" class="scoreinput" id="scoreinput" value="${esc(pre)}" aria-label="Result" placeholder="${esc(ex)}">
    <div class="fillbtns">
      <button type="button" data-fill="wo a">${esc(teamText(m.sides[0], ctx))} wins by walkover</button>
      <button type="button" data-fill="wo b">${esc(teamText(m.sides[1], ctx))} wins by walkover</button>
      <button type="button" data-fill="void">Match annulled</button>
      <button type="button" data-fill="">No result</button>
    </div>
    <div class="foot"><button data-x="cancel">Cancel</button><button data-x="apply" class="primary">Apply</button></div>
  </div>`;
  const input = modal.querySelector('#scoreinput');
  // the fill buttons set the machine token (or clear); pressed mirrors the field's
  // trimmed content on every key — "No result" presses only when a stored outcome
  // is exposed to removal and disables when clearing would be a no-op
  const btns = [...modal.querySelectorAll('.fillbtns button')];
  const sync = () => {
    const v = input.value.trim();
    for (const b of btns) {
      const fill = b.dataset.fill;
      b.disabled = fill === '' && v === '' && !hasOutcome;
      b.setAttribute('aria-pressed', String(fill === '' ? v === '' && hasOutcome : v === fill));
    }
  };
  for (const b of btns) b.onclick = () => {
    input.value = b.dataset.fill;
    sync();
    input.focus(); // Enter still applies — a button never commits directly
  };
  input.addEventListener('input', sync);
  input.focus(); input.select();
  const submit = async () => {
    const p = parseResult(input.value);
    if (p.err) { flash(p.err); input.focus(); input.select(); return; } // a rejection keeps the draft for fixing
    if (await sendEdit('result', cid, m.id, p.value)) modal.hidden = true;
  };
  modal.querySelector('[data-x="cancel"]').onclick = () => { modal.hidden = true; };
  modal.querySelector('[data-x="apply"]').onclick = submit;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); modal.hidden = true; }
  });
  sync(); // a decided match reopens with its outcome pressed
}

// ---- the side picker (modal) ----
function openSide(cid, m, si) {
  const ctx = cat(cid);
  const size = teamSize(ctx);
  const modal = $('modal');
  modal.hidden = false;
  const cur = m.sides[si];
  // open on the kind the current side actually is — editing starts pre-filled, not on Players
  const curKind = cur && (cur.kind === 'pool' || cur.kind === 'match') ? cur.kind : 'players';
  modal.innerHTML = `<div class="box">
    <p class="kicker">Side ${si === 0 ? 'A' : 'B'}</p>
    <h2>${esc(cardMeta(ctx, m))}</h2>
    <div class="tabs">
      <button data-kind="players">Players</button>
      <button data-kind="pool">Pool</button>
      <button data-kind="match">Match</button>
    </div>
    <div id="sidebody"></div>
    <div class="foot"><button data-x="cancel">Cancel</button><button data-x="apply" class="primary">Apply</button></div>
  </div>`;
  const body = modal.querySelector('#sidebody');
  const setKind = kind => {
    modal.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.kind === kind));
    if (kind === 'players') {
      const ids = cur && cur.kind === 'players' ? cur.ids : [];
      const names = new Map((S.tjson.players || []).map(p => [p.id, p.name]));
      const all = ctx.matches.flatMap(mm => (mm.sides || []).flatMap(s => (s.kind === 'players' ? s.ids : [])));
      body.innerHTML = `<p class="hint">pick ${size} player${size === 1 ? '' : 's'}</p><div class="players">` +
        [...new Set(all)].map(id => `<label><input type="checkbox" value="${esc(id)}"${ids.includes(id) ? ' checked' : ''}><span>${esc(names.get(id) ?? id)}</span></label>`).join('') + '</div>';
    } else if (kind === 'pool') {
      const p = pools(ctx);
      body.innerHTML = `<p class="hint">pool slot — pool + rank</p>
        <label class="field">Pool <select id="poolsel">${p.map(x => `<option value="${esc(x)}"${cur && cur.pool === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
        <label class="field">Rank <select id="ranksel"></select></label>`;
      // rank range is the pool's team count — not a hardcoded 6; re-derive when the pool changes
      const fillRanks = () => {
        const pool = body.querySelector('#poolsel').value;
        const n = poolFacts(ctx).get(pool)?.sigs.size || 6; // ponytail: 6 if a pool's teams can't be resolved
        const want = cur && cur.kind === 'pool' && cur.pool === pool ? cur.rank : 1;
        body.querySelector('#ranksel').innerHTML = Array.from({ length: n }, (_, i) => i + 1)
          .map(r => `<option${r === want ? ' selected' : ''}>${r}</option>`).join('');
      };
      fillRanks();
      body.querySelector('#poolsel').addEventListener('change', fillRanks);
    } else {
      const undone = ctx.matches.filter(mm => !isDone(mm));
      body.innerHTML = `<p class="hint">feeder match result</p>
        <label class="field">Match <select id="matchsel">${undone.map(mm => `<option value="${mm.id}"${cur && cur.kind === 'match' && cur.match === mm.id ? ' selected' : ''}>${mm.id} · ${esc(matchLabel(mm, ctx))}</option>`).join('')}</select></label>
        <label class="field">Result <select id="resel"><option value="winner"${cur && cur.result === 'winner' ? ' selected' : ''}>winner</option><option value="loser"${cur && cur.result === 'loser' ? ' selected' : ''}>loser</option></select></label>`;
    }
  };
  modal.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setKind(b.dataset.kind));
  setKind(curKind);
  modal.querySelector('[data-x="cancel"]').onclick = () => { modal.hidden = true; };
  modal.querySelector('[data-x="apply"]').onclick = async () => {
    const kind = modal.querySelector('.tabs button.active').dataset.kind;
    let side;
    if (kind === 'players') {
      const ids = [...modal.querySelectorAll('#sidebody input:checked')].map(i => i.value);
      if (ids.length !== size) { flash(`pick exactly ${size} player${size === 1 ? '' : 's'}`); return; }
      side = { kind: 'players', ids };
    } else if (kind === 'pool') {
      side = { kind: 'pool', pool: modal.querySelector('#poolsel').value, rank: +modal.querySelector('#ranksel').value };
    } else {
      side = { kind: 'match', match: +modal.querySelector('#matchsel').value, result: modal.querySelector('#resel').value };
    }
    modal.hidden = true;
    await sendEdit(si === 0 ? 'side-a' : 'side-b', cid, m.id, { si, side });
  };
}

// ---- pending + publish + undo ----
async function refreshPending() {
  const p = await get('/api/pending');
  if (!p) return;
  $('pendingBadge').textContent = p.commits.length ? `${p.commits.length} pending` : 'clean';
  $('pendingList').innerHTML = p.commits.length
    ? p.commits.map(c => `<li>${esc(c.sha)} ${esc(c.msg)}</li>`).join('')
    : '<li class="hint">nothing pending</li>';
  $('undo').disabled = p.commits.length === 0 || p.dirty;
  $('publish').disabled = p.commits.length === 0 || p.dirty;
  $('publish').title = p.dirty ? 'site/ is dirty — commit or stash first' : '';
}
// the pending popover is a native <details> — close it when the pointer lands elsewhere
// (the summary toggles it, so clicking it again is always an escape hatch)
document.addEventListener('click', e => {
  const p = $('pending');
  if (p.open && !p.contains(e.target)) p.open = false;
});
$('undo').onclick = async () => {
  const r = await post('/api/undo', {});
  if (!r.ok) { flash(r.error); return; }
  await reload(); // setSlug refreshes pending
};
$('publish').onclick = async () => {
  const r = await post('/api/publish', {});
  if (!r.ok) { flash(r.errors ? r.errors.join('\n') : r.error); return; }
  flash('published');
  await reload(); // setSlug refreshes pending
};

// ---- boot ----
$('slug').addEventListener('change', e => { setSlug(e.target.value); });
$('day').addEventListener('change', e => { S.day = e.target.value; renderGrid(); });
async function boot() {
  const slugs = await get('/api/tournaments') || [];
  $('slug').innerHTML = slugs.map(t => `<option value="${esc(t.slug)}">${esc(t.name)}</option>`).join('');
  if (slugs.length) await setSlug(slugs[0].slug);
  window.addEventListener('resize', () => { if (S.tjson) renderGrid(); });
  setInterval(refreshPending, 4000);
}
boot();
