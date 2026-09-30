'use strict';

// Admin page — the browser UI for the local daemon. Every write goes through
// /api/edit, which validates + commits server-side; derive.js and views.js names are page globals.

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
  cats: [], venues: [], days: [], dragSource: null, ghost: null, conflicts: [],
};

// ---- derive/views wrappers (page globals) ----
const cat = cid => S.cats.find(c => c.id === cid);
const matchOf = (cid, id) => cat(cid)?.byId.get(Number(id));
// A scorable match has exactly two sides; a malformed one renders TBD rows.
const twoSides = m => !!m && Array.isArray(m.sides) && m.sides.length === 2;
// The gate's own UI rule: a match needs both sides resolved to hold a score;
// done holds one, so never pending.
const pendingReason = (m, ctx) => {
  if (!twoSides(m) || isDone(m)) return null;
  const bad = m.sides.find(s => !resolveSide(s, ctx));
  return bad ? sideLabel(bad, ctx) : null;
};

// wall "HH:MM" from an ISO scheduled string; the grid works in wall minutes.
const isoWallMin = iso => { const m = /T(\d{2}):(\d{2})/.exec(String(iso || '')); return m ? +m[1] * 60 + +m[2] : null; };
const pad = n => String(n).padStart(2, '0');
const isoOf = (day, wm) => `${day}T${pad(Math.floor(wm / 60))}:${pad(wm % 60)}:00`;
// ms from derive.js; the grid works in wall-clock minutes
const slotMinOf = (m, ctx) => matchSlotMs(m, ctx) / 60000;

// A match's wall-time window on a day, as [startMin, endMin] or null.
function dayWindow(m, ctx) {
  if (m.scheduled == null) return null;
  const wm = isoWallMin(m.scheduled);
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
  $('modal').onkeydown = null; // a side modal's Enter handler must not outlive it — openResult never sets one
  if (modalTrigger) {
    const el = $('grid').querySelector(`[data-key="${modalTrigger.key}"]`);
    // the card's score button is its focus stop — return the keyboard there, not the article
    ((el && el.querySelector('.score-target')) || el || $('grid')).focus();
    modalTrigger = null;
  }
}
// Escape closes a native <dialog> without calling closeModal — clear the
// keyboard handler and trigger on the one event every dismissal fires.
$('modal').addEventListener('close', closeModal);

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
  const tjson = await get('/api/data?slug=' + slug);
  // a failed fetch must not name a slug the grid isn't showing — put the picker back
  if (!tjson) { $('slug').value = S.slug ?? ''; return; }
  S.slug = slug;
  S.conflicts = []; // a fresh tournament's cards must not inherit the old slug's highlights
  S.tjson = tjson;
  S.tz = S.tjson.timezone || 'UTC';
  S.cats = toCats(S.tjson);
  S.venues = (Array.isArray(S.tjson.venues) ? S.tjson.venues : []).filter(v => v && typeof v === 'object');
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
  const dayMatches = [];
  for (const c of S.cats) for (const m of c.matches) {
    const t = schedTime(m, S.tz);
    if (t !== null && dayKey(t, S.tz) === S.day) dayMatches.push({ c, m, ctx: c });
  }
  const mins = dayMatches.map(({ c, m }) => dayWindow(m, c)).filter(Boolean).flat();
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
  paintConflicts(S.conflicts); // a day change rebuilds the cards — re-light the conflicting ones
}

// time · category · match id · label; the id lets feeder dropdowns map to board cards.
function metaParts(c, m) {
  const t = schedTime(m, S.tz);
  return [t !== null ? fmtTime(t, S.tz) : '—', c.name || c.id, m.id, matchLabel(m, c)];
}
// plain text — modal sub, h2, confirm
const cardMeta = (c, m) => metaParts(c, m).join(' · ');
// the card's meta line — the category wears its wash there, as on the boards,
// so it's the one spot that carries markup
function cardMetaHtml(c, m) {
  const [time, catName, id, label] = metaParts(c, m);
  return `${esc(time)} · <span class="cat" data-cat="${c.order + 1}">${esc(catName)}</span> · ${esc(id)} · ${esc(label)}`;
}

function cardHtml(c, m, venue) {
  const pend = pendingReason(m, c);
  const stCls = isDone(m) ? ' done' : pend ? ' pending' : '';
  // wall-time placement in the day's scale; unscheduled cards are
  // flow-positioned
  const wm = (m.scheduled != null && venue) ? isoWallMin(m.scheduled) : null;
  const slot = slotMinOf(m, c);
  const pos = wm != null && Number.isFinite(slot)
    ? ` style="top:${(wm - S.dayStart) * S.pxPerMin}px;min-height:${slot * S.pxPerMin}px;"` : '';
  const k = keyOf(c, m);
  // one side row per side, meta last; a drag grip leads — only the grip drags
  const tip = pend ? `waiting on ${pend} — scoring now records a conflict` : '';
  // a real button so the card is keyboard/SR reachable; the grip and pencils z-index above it
  const label = `score: ${sideLabel(m.sides && m.sides[0], c)} vs ${sideLabel(m.sides && m.sides[1], c)} — ${cardMeta(c, m)}`;
  return `<article class="match${stCls}" data-key="${esc(k)}" data-venue="${esc(venue || '')}"${tip ? ` title="${esc(tip)}"` : ''}${pos}>
    <button type="button" class="score-target" aria-label="${esc(label)}"></button>
    <span class="grip" draggable="true" title="Drag to move"></span>
    ${sideRow(c, m, 0)}${sideRow(c, m, 1)}
    <div class="meta">${cardMetaHtml(c, m)}</div>
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
    // macOS Safari keeps buttons out of the Tab order unless the operator turns on
    // "Press Tab to highlight each item", so Tab would skip every card there. Walk the
    // cards' focus stops ourselves — score target, then the two side pencils. The order
    // is the browser's own, so Chrome is unaffected; the ends fall through, keeping Tab
    // able to leave the board.
    grid.addEventListener('keydown', e => {
      if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
      const stops = [...grid.querySelectorAll('.score-target, .edit-side')];
      const at = stops.indexOf(document.activeElement);
      const next = at < 0 ? (e.shiftKey ? stops.length - 1 : 0) : at + (e.shiftKey ? -1 : 1);
      if (next < 0 || next >= stops.length) return;
      e.preventDefault();
      stops[next].focus();
    });
  }
  grid.querySelectorAll('.match').forEach(el => {
    el.querySelectorAll('.edit-side').forEach(btn => btn.addEventListener('click', () => {
      const [cid, mid] = keyParts(el.dataset.key);
      modalTrigger = { key: el.dataset.key };
      openSide(cid, matchOf(cid, mid), +btn.dataset.side);
    }));
    // the whole card is the score target; the grip and the per-side pencils are not
    el.addEventListener('click', e => {
      if (e.target.closest('.grip, .edit-side')) return;
      const [cid, mid] = keyParts(el.dataset.key);
      modalTrigger = { key: el.dataset.key };
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
    });
    el.addEventListener('dragend', () => { clearGhost(); S.dragSource = null; renderGrid(); });
  });
}

// The candidate (venue, wall minute) under the pointer; the placement is free.
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

// The wall minute a drop lands on: the pointer rounded to the STEP grid, clamped so
// the whole slot stays inside the day.
function dropMin(wm, slot) {
  const snapped = Math.round(wm / STEP) * STEP;
  return Math.max(S.dayStart, Math.min(snapped, S.dayEnd - slot));
}

// One ghost element — the drop preview.
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

// The dragged match, or null when no drag is in flight.
function dragSource() {
  if (!S.dragSource) return null;
  const [cid, mid] = keyParts(S.dragSource);
  return { cid, mid, ctx: cat(cid), m: matchOf(cid, mid) };
}

// Live ghost preview: the pointer's wall mark, snapped and clamped — the position
// the drop writes, whatever conflicts it creates.
function ghost(e) {
  const d = dragSource();
  if (!d) return;
  const { ctx, m } = d;
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
  if (!Number.isFinite(slot)) return; // a malformed match has no window to draw
  const wm = dropMin(ht.wm, slot);
  // the wall start the drop writes, padded as the rail pads it
  addGhost(col, { time: `${pad(Math.floor(wm / 60))}:${pad(wm % 60)}`, align: ht.align, top: (wm - S.dayStart) * S.pxPerMin + 'px', height: slot * S.pxPerMin + 'px' });
}
function clearGhost() { if (S.ghost) { S.ghost.remove(); S.ghost = null; } }

async function dropAt(e) {
  const d = dragSource();
  if (!d) return;
  const { cid, mid, m } = d;
  const ht = hitTest(e);
  if (!ht) return;
  let time, venue;
  if (ht.venue === '__none') {
    // a stray drop here unschedules the match — confirm when there is something to lose
    if ((m.scheduled || m.venue) && !confirm("Clear this match's time and court?")) return;
    time = null; venue = null;
  } else {
    const slot = slotMinOf(m, d.ctx);
    if (!Number.isFinite(slot)) { flash('this match has no slot length — set its slotMinutes first'); return; }
    if (!S.day) { flash('no scheduled day yet — schedule the tournament before placing matches'); return; }
    time = isoOf(S.day, dropMin(ht.wm, slot)); venue = ht.venue;
  }
  await sendEdit('move', cid, mid, { time, venue });
}

// ---- edits ----
async function sendEdit(verb, cid, mid, value) {
  const r = await post('/api/edit', { slug: S.slug, verb, cat: cid, matchId: mid, value });
  if (!r.ok) { const msg = r.errors ? r.errors.join('\n') : (r.error || 'edit refused'); flash(msg); return msg; }
  if (r.unchanged) { flash('no change — the same data is already stored'); return true; }
  await reload(); // setSlug re-renders the grid + editor and refreshes pending
  flash({ result: 'result saved', move: 'match moved', side: 'side updated', delete: 'match deleted' }[verb] || 'saved');
  return true;
}

// ---- the result modal ----
// raw entry — bare games · wo a/b · void · empty clears; the daemon parses it and
// the modal keeps a rejected draft for fixing.

function openResult(cid, m) {
  if (!reachable) return; // the offline banner says why
  // a sideless match renders as TBD rows (cardHtml guards it) but has nothing to score
  if (!twoSides(m)) { flash('this match has no two sides — fix it in the file first'); return; }
  const ctx = cat(cid);
  const hasOutcome = !!(m.games || m.result);
  let pre = '';
  if (Array.isArray(m.games)) pre = m.games.filter(g => g && typeof g === 'object').map(g => `${g.a}-${g.b}`).join(' ');
  else if (m.result && m.result.status === 'walkover') pre = `wo ${m.result.winner}`;
  else if (m.result && m.result.status === 'void') pre = 'void';
  // a realistic example for this match's best-of, winners alternating so the
  // shape is legible — games 1,3,5… go A, games 2,4… go B
  const bo = Math.min(bestOfOf(m, ctx) || 1, MAX_BEST_OF); // a malformed override stays a finite hint row
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
    <div class="foot"><button data-x="delete" class="danger">Delete match</button><button data-x="cancel">Cancel</button><button data-x="apply" class="primary">Apply</button></div>
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
  // destructive: the match leaves the data (git keeps the record). The syntactic gate
  // refuses a match other matches still reference — reseat its sides first.
  modal.querySelector('[data-x="delete"]').onclick = async () => {
    if (!confirm(`Delete ${cardMeta(ctx, m)}?`)) return;
    const msg = await sendEdit('delete', cid, m.id, {});
    if (msg === true) closeModal(); else { errEl.textContent = msg; errEl.hidden = false; }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  sync(); // a decided match reopens with its outcome pressed
}

// ---- the side picker (modal) ----
// Editing is unrestricted: any player, pool rank, or feeder is selectable, and an
// edit that contradicts the model rides through as a conflict (publish blocks).
function openSide(cid, m, si) {
  if (!reachable) return; // the offline banner says why
  if (!twoSides(m)) { flash('this match has no two sides — fix it in the file first'); return; }
  const ctx = cat(cid);
  const size = teamSize(ctx);
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
      const names = new Map((Array.isArray(S.tjson.players) ? S.tjson.players : []).filter(p => p && typeof p === 'object' && typeof p.id === 'string').map(p => [p.id, p.name]));
      const roster = [...names.keys()];
      const ids = cur && cur.kind === 'players' && Array.isArray(cur.ids) ? cur.ids : [];
      body.innerHTML = `<p class="hint" id="pickhint"></p><div class="players">` +
        roster.map(id => {
          const isOther = otherIds.includes(id);
          return `<label${isOther ? ' class="illegal"' : ''}><input type="checkbox" value="${esc(id)}"${ids.includes(id) ? ' checked' : ''}${isOther ? ' disabled' : ''} title="${esc(isOther ? 'already on the other side' : '')}"><span>${esc(names.get(id) ?? id)}</span></label>`;
        }).join('') + '</div>';
      // At most teamSize ticks — a third is never offered, and the count says why.
      const boxes = [...body.querySelectorAll('.players input')];
      const hint = body.querySelector('#pickhint');
      const sync = () => {
        const n = boxes.filter(b => b.checked).length;
        for (const b of boxes) b.disabled = otherIds.includes(b.value) || (!b.checked && n >= size);
        hint.textContent = `pick ${size} player${size === 1 ? '' : 's'} · ${n}/${size}`;
      };
      for (const b of boxes) b.addEventListener('change', sync);
      sync();
    } else if (kind === 'pool') {
      const p = pools(ctx);
      body.innerHTML = `<p class="hint">pool slot — pool + rank</p>
        <label class="field">Pool <select id="poolsel">${p.map(x => `<option value="${esc(x)}"${cur && cur.pool === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
        <label class="field">Rank <select id="ranksel"></select></label>`;
      // rank range is the pool's team count — not a hardcoded 6; re-derive when the pool changes
      const fillRanks = () => {
        const pool = body.querySelector('#poolsel').value;
        const n = poolStandings(ctx, pool)?.length || 6; // ponytail: 6 if a pool's teams can't be resolved
        const want = cur && cur.kind === 'pool' && cur.pool === pool ? cur.rank : 1;
        body.querySelector('#ranksel').innerHTML = Array.from({ length: n }, (_, i) => i + 1)
          .map(r => `<option${r === want ? ' selected' : ''}>${r}</option>`).join('');
      };
      fillRanks();
      body.querySelector('#poolsel').addEventListener('change', fillRanks);
    } else {
      // every match is a legal feeder — a decided one still resolves winner/loser, and
      // a cycle or a consumed edge surfaces as a conflict, not a disabled option
      const feeders = ctx.matches.filter(mm => mm && typeof mm === 'object' && (mm.id !== m.id || (cur && cur.kind === 'match' && cur.match === mm.id)));
      body.innerHTML = `<p class="hint">feeder match result</p>
        <label class="field">Match <select id="matchsel">${feeders.map(mm => `<option value="${esc(mm.id)}"${cur && cur.kind === 'match' && cur.match === mm.id ? ' selected' : ''}>${esc(mm.id)} · ${esc(matchLabel(mm, ctx))}</option>`).join('')}</select></label>
        <label class="field">Result <select id="resel"></select></label>`;
      const fillRes = () => {
        const mmId = +body.querySelector('#matchsel').value;
        body.querySelector('#resel').innerHTML = ['winner', 'loser'].map(r => `<option value="${r}"${cur && cur.kind === 'match' && cur.match === mmId && cur.result === r ? ' selected' : ''}>${r}</option>`).join('');
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
    const msg = await sendEdit('side', cid, m.id, { si, side });
    if (msg === true) closeModal();
  };
  modal.querySelector('[data-x="cancel"]').onclick = closeModal;
  modal.querySelector('[data-x="apply"]').onclick = apply;
  // onkeydown, not addEventListener — #modal persists, so listeners would accumulate per open and replay stale applies.
  modal.onkeydown = e => {
    if (e.key === 'Enter' && !e.target.matches('select, input, button')) { e.preventDefault(); apply(); }
  };
  modal.querySelector('.tabs button.active').focus(); // open inside the dialog, not behind it
}

// ---- conflict display ----
// The daemon filters conflicts to this slug, so the file path is always redundant.
// A line leads with the card it names; the symptom shows, the rationale (and the
// rest) rides the title.
const stripPath = s => String(s || '').replace(/site\/tournaments\/[\w.-]+\.json\s*/g, '').trim();
function conflictParts(c) {
  const where = stripPath(c.where);
  const ref = (c.refs && c.refs[0]) || null;
  const catId = ref ? ref.cat : (/matches\.([a-z0-9-]+)/.exec(where) || [])[1];
  const name = catId ? (cat(catId)?.name || catId) : '';
  const label = ref && ref.matchId != null ? `${name} · match ${ref.matchId}` : name || where;
  const short = String(c.message || '').split(' — ')[0];
  return { line: label ? `${label} — ${short}` : short, full: `${where}: ${c.message}` };
}
// Every match a conflict names lights up; category/file-level conflicts name none.
function paintConflicts(conflicts) {
  const keys = new Set();
  for (const c of conflicts || []) for (const r of (c.refs || [])) keys.add(`${r.cat}:${r.matchId}`);
  for (const el of $('grid').querySelectorAll('.match')) el.classList.toggle('conflict', keys.has(el.dataset.key));
}

// ---- pending + publish + undo/redo ----
// set while /api/publish is in flight, so a concurrent pending refresh can't re-enable the button
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
  // Semantic conflicts never block an edit, only the ship.
  const conflicts = p.conflicts || [];
  S.conflicts = conflicts;
  $('issues').hidden = conflicts.length === 0;
  $('issueBadge').textContent = conflicts.length ? `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}` : '';
  $('issueList').innerHTML = conflicts.map(c => { const p = conflictParts(c); return `<li title="${esc(p.full)}">${esc(p.line)}</li>`; }).join('');
  paintConflicts(conflicts);
  // A failed deploy after its push leaves nothing pending, so Publish can't gate on
  // the count; re-deploying is idempotent.
  $('publish').disabled = publishing || p.dirty || conflicts.length > 0;
}
// the pending popover is a native <details> — close it when the pointer lands
// elsewhere
document.addEventListener('click', e => {
  const p = $('pending');
  if (p.open && !p.contains(e.target)) p.open = false;
});
$('undo').onclick = async () => {
  const r = await post('/api/undo', {});
  if (!r.ok) { flash(r.error || 'undo failed — see the daemon output'); return; }
  await reload(); // setSlug refreshes pending
  flash('undone');
};
$('redo').onclick = async () => {
  const r = await post('/api/redo', {});
  if (!r.ok) { flash(r.error || 'redo failed — see the daemon output'); return; }
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
    if (!r.ok) {
      const msg = r.errors && r.errors.length ? r.errors.join('\n')
        : r.conflicts && r.conflicts.length ? 'resolve before publishing:\n' + r.conflicts.map(c => conflictParts(c).line).join('\n')
        : (r.error || 'publish failed — see the daemon output');
      flash(msg);
      return;
    }
    flash('published');
    await reload(); // setSlug refreshes pending
  } finally {
    publishing = false;
    btn.removeAttribute('aria-busy');
    btn.textContent = 'Publish';
    await refreshPending(); // the button was disabled for the whole deploy
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
}
boot();
