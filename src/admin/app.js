'use strict';

// Admin page — the browser UI for the local daemon. Every write goes through
// /api/edit, which validates + commits server-side; derive.js's names are page globals.

const $ = id => document.getElementById(id);

// A card's measured height; the scale floors at one card per shortest slot.
// ponytail: re-tune with the card's font/padding.
const CARD_PX = 50;

// Drops land on a 5-minute wall mark; the slot-minute gcd only aligned the generated
// layout. ponytail: raise if 5-minute drops feel too fine.
const STEP = 5;

// ---- tiny state ----
const S = {
  slug: null, day: null, tjson: null, tz: 'UTC',
  pxPerMin: 1.2, dayStart: 0, dayEnd: 0,
  cats: [], venues: [], days: [], dragSource: null, ghost: null, legal: null,
};

// ---- derive wrappers (derive.js globals) ----
const cat = cid => S.cats.find(c => c.id === cid);
const matchOf = (cid, id) => cat(cid)?.byId.get(Number(id));
// The gate's own UI rule: a match needs both sides resolved to hold a score;
// done holds one, so never pending.
const pendingReason = (m, ctx) => {
  if (!m || !Array.isArray(m.sides) || m.sides.length !== 2 || isDone(m)) return null;
  const bad = m.sides.find(s => !resolveSide(s, ctx));
  return bad ? sideLabel(bad, ctx) : null;
};

// wall "HH:MM" from an ISO scheduled string; the grid works in wall minutes.
const wallMin = iso => { const m = /T(\d{2}):(\d{2})/.exec(String(iso || '')); return m ? +m[1] * 60 + +m[2] : null; };
const pad = n => String(n).padStart(2, '0');
const isoOf = (day, wm) => `${day}T${pad(Math.floor(wm / 60))}:${pad(wm % 60)}:00`;
// ms from derive.js; the grid works in wall-clock minutes
const slotMinOf = (m, ctx) => matchSlotMs(m, ctx) / 60000;

// A match's wall-time window on a day, as [startMin, endMin] or null.
function dayWindow(m, ctx) {
  if (m.scheduled == null) return null;
  const wm = wallMin(m.scheduled);
  if (wm == null) return null;
  const slot = slotMinOf(m, ctx);
  return Number.isFinite(slot) ? [wm, wm + slot] : null;
}

// ---- fetch helpers ----
// A fetch that never rejects: a dead daemon must say so, not silently drop writes.
let reachable = true;
function setReachable(ok) {
  if (ok === reachable) return;
  reachable = ok;
  $('offline').hidden = ok;
}
async function get(url) {
  let r;
  try { r = await fetch(url); } catch { setReachable(false); return null; }
  setReachable(true);
  try { return r.ok ? await r.json() : null; } catch { return null; } // a proxy's HTML error page is not data
}
async function post(url, body) {
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { setReachable(false); return { ok: false, error: 'admin daemon unreachable — nothing was saved' }; }
  setReachable(true);
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
let modalTrigger = null; // { key } — the card that opened the modal; focus returns there
// Focus returns by key: apply reloads rebuild the cards (a captured node would be detached).
function closeModal() {
  $('modal').close();
  if (modalTrigger) {
    const el = $('grid').querySelector(`[data-key="${modalTrigger.key}"]`);
    (el || $('grid')).focus();
    modalTrigger = null;
  }
}

// ---- data loading ----
function teamSize(ctx) {
  for (const m of ctx.matches) {
    if (!m || !Array.isArray(m.sides)) continue;
    for (const s of m.sides) if (s && s.kind === 'players' && Array.isArray(s.ids)) return s.ids.length;
  }
  return 1;
}
function pools(ctx) { return [...new Set(ctx.matches.filter(m => m && m.pool).map(m => m.pool))]; }

async function setSlug(slug, keepDay = false) {
  S.slug = slug;
  S.tjson = await get('/api/data?slug=' + slug);
  if (!S.tjson) return;
  S.tz = S.tjson.timezone || 'UTC';
  S.cats = toCats(S.tjson);
  S.venues = (S.tjson.venues || []).filter(v => v && typeof v === 'object');
  S.days = schedDays(S.cats.flatMap(c => c.matches), S.tz);
  const daySel = $('day');
  daySel.innerHTML = S.days.map(d => `<option value="${esc(d)}">${esc(dayLabel(d))}</option>`).join('');
  S.day = keepDay && S.days.includes(S.day) ? S.day : (S.days[0] || null);
  daySel.value = S.day ?? '';
  renderGrid();
  refreshPending();
}

// keep slug/day/selection, just re-fetch the data after an edit or undo
async function reload() { await setSlug(S.slug, true); }

// Fill the board's height when the day fits; floor the scale so the shortest slot is
// at least one card tall.
function fitScale(sShort) {
  const sc = $('board');
  const avail = sc ? sc.clientHeight : 0;
  const total = S.dayEnd - S.dayStart || 1;
  S.pxPerMin = Math.max(1.6, avail / total, sShort ? CARD_PX / sShort : 0);
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
  const slots = dayMatches.map(({ c, m }) => slotMinOf(m, c)).filter(Number.isFinite);
  const sShort = slots.length ? Math.min(...slots) : 0;
  let dayStart = mins.length ? Math.min(...mins) : 8 * 60;
  let dayEnd = mins.length ? Math.max(...mins) : 20 * 60;
  // one slot of headroom above the first card — it clears the sticky column
  // heading and leaves the preceding slot visible and droppable
  dayStart = Math.floor((dayStart - (sShort || 15)) / STEP) * STEP;
  dayEnd = Math.ceil((dayEnd + 15) / STEP) * STEP;
  if (dayStart < 0) dayStart = 0;
  S.dayStart = dayStart; S.dayEnd = dayEnd;
  fitScale(sShort); // board height fills short days; the shortest slot floors the scale so long days scroll without overlap
  const h = (dayEnd - dayStart) * S.pxPerMin;
  grid.style.height = h + 'px';

  const cols = S.venues.map(v => v.id);
  grid.style.gridTemplateColumns = `4.5rem ${cols.map(() => 'minmax(9rem,1fr)').join(' ')} 13rem`;

  // hour ticks, shared by the label rail and each venue column
  let hourHtml = '', labelHtml = '';
  for (let hm = Math.floor(dayStart / 60) * 60; hm <= dayEnd && hm < 1440; hm += 60) {
    const y = (hm - dayStart) * S.pxPerMin;
    hourHtml += `<div class="hour" style="top:${y}px"></div>`;
    labelHtml += `<div class="hourlabel" style="top:${y}px">${pad(hm / 60)}:00</div>`;
  }
  let html = `<div class="ruler">${hourHtml}${labelHtml}</div>`;
  for (const vid of cols) {
    const v = S.venues.find(x => x.id === vid);
    const name = v ? v.name : vid;
    const here = dayMatches.filter(({ m }) => m.venue === vid);
    html += `<div class="col" data-venue="${esc(vid)}"><div class="colhead">${esc(name)}</div>${hourHtml}`;
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

// time · category · match id · label; the id lets feeder dropdowns map to board cards.
function cardMeta(c, m) {
  const t = schedTime(m, S.tz);
  const time = t !== null ? fmtTime(t, S.tz) : '—';
  return `${time} · ${c.name || c.id} · ${m.id} · ${matchLabel(m, c)}`;
}

function cardHtml(c, m, venue) {
  const pend = pendingReason(m, c);
  const stCls = isDone(m) ? ' done' : pend ? ' pending' : '';
  // wall-time placement in the day's scale; unscheduled cards are
  // flow-positioned
  const wm = (m.scheduled != null && venue) ? wallMin(m.scheduled) : null;
  const slot = slotMinOf(m, c);
  const pos = wm != null && Number.isFinite(slot)
    ? ` style="top:${(wm - S.dayStart) * S.pxPerMin}px;min-height:${slot * S.pxPerMin}px;"` : '';
  const k = keyOf(c, m);
  // one side row per side, meta last; a drag grip leads — only the grip drags
  const tip = pend ? `can't score yet — waiting on ${pend}` : '';
  return `<article class="match${stCls}" data-key="${esc(k)}" data-venue="${esc(venue || '')}"${tip ? ` title="${esc(tip)}"` : ''}${pos}>
    <span class="grip" draggable="true" title="Drag to move"></span>
    ${sideRow(c, m, 0)}${sideRow(c, m, 1)}
    <div class="meta">${esc(cardMeta(c, m))}</div>
  </article>`;
}

// The pencil is the only side-edit surface; the score rides the row.
function sideRow(c, m, i) {
  // the site's sideRow guards the same shape — a malformed match renders TBD rows, never a TypeError
  const side = m.sides && m.sides[i];
  const sideName = esc(sideLabel(side, c));
  const win = winnerIdx(m) === i;
  return `<div class="side"${win ? ' data-win' : ''}><span class="who"><span class="name">${sideName}</span><button type="button" class="edit-side" data-side="${i}" title="edit side ${i === 0 ? 'a' : 'b'}" aria-label="edit side ${i === 0 ? 'a' : 'b'} — ${sideName}">✎</button>${win ? '<span class="winmark" aria-label="won">✓</span>' : ''}</span><span class="score">${scoreCells(m, i, c)}</span></div>`;
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
      modalTrigger = { key: el.dataset.key };
      openSide(cid, matchOf(cid, mid), +btn.dataset.side);
    }));
    // the whole card is the score target; the grip and the per-side pencils are not
    el.addEventListener('click', e => {
      if (e.target.closest('.grip, .edit-side')) return;
      const [cid, mid] = keyParts(el.dataset.key);
      const m = matchOf(cid, mid);
      const why = pendingReason(m, cat(cid));
      if (why) { flash(`can't score yet — waiting on ${why}`); return; }
      modalTrigger = { key: el.dataset.key };
      openResult(cid, m);
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

// The candidate (venue, wallMin) under the pointer; legal snapping happens against
// the daemon's slot list.
function hitTest(e) {
  const grid = $('grid');
  const gr = grid.getBoundingClientRect();
  const x = e.clientX - gr.left, y = e.clientY - gr.top;
  const cols = grid.querySelectorAll('.col');
  let venue = null, rect = null;
  for (const c of cols) { const cr = c.getBoundingClientRect(); if (x >= cr.left - gr.left && x <= cr.right - gr.left) { venue = c.dataset.venue; rect = cr; break; } }
  if (venue == null) return null;
  const wm = S.dayStart + Math.round(y / S.pxPerMin);
  // the ghost's time label rides the half the pointer is NOT in, so the cursor
  // never sits on the words it is trying to read
  return { venue, wm, align: x - (rect.left - gr.left) > rect.width / 2 ? 'left' : 'right' };
}

// The legal start whose own slot covers this minute, else null: no ghost, no drop.
function legalSnap(venue, wm, slot) {
  const ticks = S.legal && S.legal.get(venue);
  if (!ticks || !ticks.length) return null;
  let best = null;
  for (const t of ticks) {
    const start = +t;
    if (start <= wm && wm < start + slot && (best === null || start > best)) best = start;
  }
  return best;
}

// Legal start-minutes per venue from the daemon, computed once per drag.
async function loadSlots(cid, mid) {
  const r = await get(`/api/slots?slug=${S.slug}&cat=${cid}&id=${mid}&day=${S.day}&gcd=${STEP}`);
  // A superseded reply — an earlier drag's fetch landing late.
  if (S.dragSource !== `${cid}:${mid}`) return;
  S.legal = new Map(Object.entries((r && r.ok) || {}));
}

// One ghost element — the drop preview; legal starts only.
function addGhost(col, { time = '', align = '', top, height }) {
  const g = document.createElement('div');
  g.className = 'ghost';
  g.textContent = time;
  g.style.textAlign = align;
  g.setAttribute('aria-hidden', 'true'); // a sight aid for the pointer drag
  g.style.top = top;
  g.style.height = height;
  col.appendChild(g);
  S.ghost = g;
}

// Live ghost preview: position by the pointer, legality by the daemon's slot list.
function ghost(e) {
  const src = S.dragSource;
  if (!src) return;
  const [cid, mid] = keyParts(src);
  const ctx = cat(cid), m = matchOf(cid, mid);
  const ht = hitTest(e);
  clearGhost();
  if (!ht) return;
  const slot = slotMinOf(m, ctx);
  const col = $('grid').querySelector(`.col[data-venue="${CSS.escape(ht.venue)}"]`);
  if (!col) return;
  if (ht.venue === '__none') {
    // A drop here clears time+venue. The one that would empty a published day
    // is the daemon's to refuse (it names the days), so the marker is a plain
    // box: the column has no time axis to place it on.
    addGhost(col, { top: '.5rem', height: '2.5rem' });
    return;
  }
  // The slot list is still in flight from dragstart — no preview beats a wrong one.
  if (!S.legal) return;
  const wm = legalSnap(ht.venue, ht.wm, slot);
  if (wm === null) return;
  // the wall start the drop would write, padded as the rail and the daemon's lattice pad it
  addGhost(col, { time: `${pad(Math.floor(wm / 60))}:${pad(wm % 60)}`, align: ht.align, top: (wm - S.dayStart) * S.pxPerMin + 'px', height: slot * S.pxPerMin + 'px' });
}
function clearGhost() { if (S.ghost) { S.ghost.remove(); S.ghost = null; } }

async function dropAt(e) {
  const src = S.dragSource;
  if (!src) return;
  const [cid, mid] = keyParts(src);
  const ht = hitTest(e);
  if (!ht) return;
  let time, venue;
  if (ht.venue === '__none') {
    // a stray drop here unschedules the match — confirm when there is something to lose
    const m = matchOf(cid, mid);
    if ((m.scheduled || m.venue) && !confirm("Clear this match's time and court?")) return;
    time = null; venue = null;
  } else {
    if (!S.legal) await loadSlots(cid, mid); // a drop can beat the dragstart fetch
    // the same rule the ghost showed: the pointer must sit in the box it drew
    const wm = legalSnap(ht.venue, ht.wm, slotMinOf(matchOf(cid, mid), cat(cid)));
    if (wm === null) { flash('no legal slot here'); return; }
    time = isoOf(S.day, wm); venue = ht.venue;
  }
  await sendEdit('move', cid, mid, { time, venue });
}

// ---- edits ----
async function sendEdit(verb, cid, mid, value) {
  const r = await post('/api/edit', { slug: S.slug, verb, cat: cid, matchId: mid, value });
  if (!r.ok) { const msg = r.errors ? r.errors.join('\n') : (r.error || 'edit refused'); flash(msg); return msg; }
  if (r.unchanged) { flash('no change — the same data is already stored'); return true; }
  await reload(); // setSlug re-renders the grid + editor and refreshes pending
  flash({ result: 'result saved', move: 'match moved', side: 'side updated' }[verb] || 'saved');
  return true;
}

// ---- the result modal ----
// raw entry — bare games · wo a/b · void · empty clears; the daemon parses it and
// the modal keeps a rejected draft for fixing.

function openResult(cid, m) {
  if (!reachable) return; // the offline banner says why
  const ctx = cat(cid);
  const hasOutcome = !!(m.games || m.result);
  let pre = '';
  if (m.games) pre = m.games.map(g => `${g.a}-${g.b}`).join(' ');
  else if (m.result && m.result.status === 'walkover') pre = `wo ${m.result.winner}`;
  else if (m.result && m.result.status === 'void') pre = 'void';
  // a realistic example for this match's best-of, winners alternating so the
  // shape is legible — games 1,3,5… go A, games 2,4… go B
  const bo = bestOfOf(m, ctx) || 1;
  const ex = Array.from({ length: bo }, (_, g) => g % 2 ? '17-21' : '21-19').join(' ');
  const modal = $('modal');
  modal.showModal();
  modal.innerHTML = `<div class="box">
    <p class="kicker">Result</p>
    <h2 class="sides">${esc(sideLabel(m.sides[0], ctx))} vs ${esc(sideLabel(m.sides[1], ctx))}</h2>
    <p class="sub">${esc(cardMeta(ctx, m))}</p>
    <input type="text" class="scoreinput" id="scoreinput" value="${esc(pre)}" aria-label="Result" aria-describedby="resulthint">
    <p class="hint" id="resulthint">Game scores — e.g. ${esc(ex)}</p>
    <div class="fillbtns">
      <button type="button" data-fill="wo a">${esc(sideLabel(m.sides[0], ctx))} wins by walkover</button>
      <button type="button" data-fill="wo b">${esc(sideLabel(m.sides[1], ctx))} wins by walkover</button>
      <button type="button" data-fill="void">Match annulled</button>
      <button type="button" data-fill="">No result</button>
    </div>
    <p class="err" id="resulterr" hidden></p>
    <div class="foot"><button data-x="cancel">Cancel</button><button data-x="apply" class="primary">Apply</button></div>
  </div>`;
  const input = modal.querySelector('#scoreinput');
  // the inline error parks the daemon's words under the input, unlike the fading toast
  const errEl = modal.querySelector('#resulterr');
  // the fill buttons set the machine token; "No result" presses only when an outcome exists
  const btns = [...modal.querySelectorAll('.fillbtns button')];
  const sync = () => {
    errEl.hidden = true; // any edit makes the last rejection stale
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
    // raw text — the daemon parses with the editor's shared grammar; a
    // rejection keeps the draft and parks the daemon's words under the input
    const msg = await sendEdit('result', cid, m.id, input.value);
    if (msg === true) closeModal();
    else { errEl.textContent = msg; errEl.hidden = false; input.focus(); input.select(); }
  };
  modal.querySelector('[data-x="cancel"]').onclick = closeModal;
  modal.querySelector('[data-x="apply"]').onclick = submit;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  sync(); // a decided match reopens with its outcome pressed
}

// ---- the side picker (modal) ----
// Legality comes from /api/sideopts (the daemon's view of the gate, like /api/slots).
// Illegal options that aren't the current value are greyed; the current value stays
// selectable so it can be moved away.
async function openSide(cid, m, si) {
  if (!reachable) return; // the offline banner says why
  const ctx = cat(cid);
  const size = teamSize(ctx);
  const L = (await get(`/api/sideopts?cat=${cid}&id=${m.id}&si=${si}`))?.ok || {};
  const busy = new Set(L.busy || []);
  const consumedRanks = new Set(L.consumedRanks || []);
  const consumedEdges = new Set(L.consumedEdges || []);
  const descendants = new Set(L.descendants || []);
  const other = m.sides[1 - si];
  const otherIds = other && other.kind === 'players' && Array.isArray(other.ids) ? other.ids : [];
  const modal = $('modal');
  modal.showModal();
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
      const names = new Map((S.tjson.players || []).filter(p => p && typeof p === 'object').map(p => [p.id, p.name]));
      // the full roster from /api/sideopts; a registered player in no match yet is
      // still a legal side
      const all = L.roster || [];
      body.innerHTML = `<p class="hint">pick ${size} player${size === 1 ? '' : 's'}</p><div class="players">` +
        [...new Set(all)].map(id => {
          const checked = ids.includes(id);
          const illegal = busy.has(id) || otherIds.includes(id);
          const why = busy.has(id) ? 'plays in an overlapping scheduled match' : otherIds.includes(id) ? 'already on the other side' : '';
          return `<label${illegal ? ' class="illegal"' : ''}><input type="checkbox" value="${esc(id)}"${checked ? ' checked' : ''}${illegal ? ' disabled' : ''} title="${esc(why)}"><span>${esc(names.get(id) ?? id)}</span></label>`;
        }).join('') + '</div>';
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
          .map(r => `<option${r === want ? ' selected' : ''}${consumedRanks.has(`pool:${pool}:${r}`) ? ' disabled' : ''}>${r}</option>`).join('');
      };
      fillRanks();
      body.querySelector('#poolsel').addEventListener('change', fillRanks);
    } else {
      const undone = ctx.matches.filter(mm => !isDone(mm));
      // the current feeder may already be decided — it must stay an option so an
      // untouched modal no-ops rather than re-seating
      const curFeeder = cur && cur.kind === 'match' ? ctx.matches.find(X => X && X.id === cur.match) : null;
      const feeders = curFeeder && !undone.includes(curFeeder) ? [...undone, curFeeder] : undone;
      body.innerHTML = `<p class="hint">feeder match result</p>
        <label class="field">Match <select id="matchsel">${feeders.map(mm => `<option value="${mm.id}"${cur && cur.kind === 'match' && cur.match === mm.id ? ' selected' : ''}${descendants.has(mm.id) || mm.id === m.id ? ' disabled' : ''}>${mm.id} · ${esc(matchLabel(mm, ctx))}</option>`).join('')}</select></label>
        <label class="field">Result <select id="resel"></select></label>`;
      const fillRes = () => {
        const mmId = +body.querySelector('#matchsel').value;
        body.querySelector('#resel').innerHTML = ['winner', 'loser'].map(r => `<option value="${r}"${cur && cur.kind === 'match' && cur.match === mmId && cur.result === r ? ' selected' : ''}${consumedEdges.has(`${mmId}:${r}`) ? ' disabled' : ''}>${r}</option>`).join('');
      };
      fillRes();
      body.querySelector('#matchsel').addEventListener('change', fillRes);
    }
  };
  modal.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setKind(b.dataset.kind));
  setKind(curKind);
  // Enter applies without hijacking a select, checkbox, or foot button; Escape is native.
  const apply = async () => {
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
    closeModal();
    await sendEdit('side', cid, m.id, { si, side });
  };
  modal.querySelector('[data-x="cancel"]').onclick = closeModal;
  modal.querySelector('[data-x="apply"]').onclick = apply;
  // onkeydown, not addEventListener — #modal persists, so listeners would accumulate per open and replay stale applies.
  modal.onkeydown = e => {
    if (e.key === 'Enter' && !e.target.matches('select, input, button')) { e.preventDefault(); apply(); }
  };
  modal.querySelector('.tabs button.active').focus(); // open inside the dialog, not behind it
}

// ---- pending + publish + undo/redo ----
// set while /api/publish is in flight, so the pending poll can't re-enable the button
let publishing = false;
async function refreshPending() {
  const p = await get('/api/pending');
  if (!p) return;
  const live = !!(p.domain && S.slug);
  $('publishedGroup').hidden = !live; // the CNAME is where the last publish went — without it there is nothing live to link to
  $('siteLink').href = `https://${p.domain}/#${S.slug}`;
  $('kioskLink').href = `https://${p.domain}/#${S.slug}/venues`;
  $('previewLink').href = `/preview/#${S.slug}`; // the working tree, always — publish alone ships
  $('previewKiosk').href = `/preview/#${S.slug}/venues`;
  $('links').hidden = !S.slug;
  $('pendingBadge').textContent = p.dirty ? 'dirty' : p.commits.length ? `${p.commits.length} pending` : p.deployFailed ? 'not live' : 'clean';
  $('pendingList').innerHTML = (p.commits.length
    ? p.commits.map(c => `<li>${esc(c.msg)}</li>`).join('')
    : `<li class="hint">${p.deployFailed ? 'nothing pending — the last deploy did not ship; Publish retries' : 'nothing pending'}</li>`)
    + (p.dirty ? '<li class="hint">site/ is dirty — commit or stash before publishing</li>' : '');
  $('undo').disabled = p.commits.length === 0 || p.dirty;
  $('redo').disabled = !p.redo || p.dirty;
  $('redo').title = p.redo ? `Redo ${p.redo.msg}` : '';
  // A failed deploy after its push leaves nothing pending, so Publish can't gate on
  // the count; re-deploying is idempotent.
  $('publish').disabled = publishing || p.dirty;
}
// the pending popover is a native <details> — close it when the pointer lands
// elsewhere
document.addEventListener('click', e => {
  const p = $('pending');
  if (p.open && !p.contains(e.target)) p.open = false;
});
$('undo').onclick = async () => {
  const r = await post('/api/undo', {});
  if (!r.ok) { flash(r.error); return; }
  await reload(); // setSlug refreshes pending
  flash('undone');
};
$('redo').onclick = async () => {
  const r = await post('/api/redo', {});
  if (!r.ok) { flash(r.error); return; }
  await reload(); // setSlug refreshes pending
  flash('redone');
};
$('publish').onclick = async () => {
  if (publishing) return;
  publishing = true;
  const btn = $('publish');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = 'Publishing…';
  try {
    const r = await post('/api/publish', {});
    if (!r.ok) { flash(r.errors ? r.errors.join('\n') : r.error); return; }
    flash('published');
    await reload(); // setSlug refreshes pending
  } finally {
    publishing = false;
    btn.removeAttribute('aria-busy');
    btn.textContent = 'Publish';
    await refreshPending(); // the poll was blocked for the whole deploy
  }
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
