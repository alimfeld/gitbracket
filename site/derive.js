'use strict';

// Under node the sibling bundle must land on globalThis as it does in the browser.
if (typeof module !== 'undefined') {
  Object.assign(globalThis, require('./i18n.js'));
}

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A score row renders one placeholder per possible game; the gate rejects larger overrides.
const MAX_BEST_OF = 9;

// Render-facing labels follow this dialect; derivation (day keys, offsets) stays
// locale-independent. The admin page never calls setLocale, so its labels stay English.
let LOCALE = 'en';
const setLocale = l => { LOCALE = l; };

// Per-locale word rules live in the bundle as data; this file only dispatches.
const fmtOf = k => (bundle(LOCALE).fmt || {})[k];
const ordNum = n => (fmtOf('ord') || (n => String(n)))(n);    // '3.' / '3rd' — range form
const cardNum = n => (fmtOf('place') || (n => String(n)))(n); // '3' / '3rd' — pre-word form
const bandShort = l => (fmtOf('bandShort') || (l => l))(l);   // the band a placement label names
// Declined ref word from the bundle's per-key/per-case templates, keyed by the
// round kind the caller holds. The label is only a {label} parameter, never inspected.
const refWord = (key, c, label) => {
  const refs = bundle(LOCALE).refs || {};
  const s = (refs[key] || refs[''] || {})[c] || label;
  return s.replace('{label}', () => label); // function form: a label containing $& or $' is data, never a replacement pattern
};
const artWord = (key, c) => ((bundle(LOCALE).art || {})[key] || {})[c] || ''; // 'Im' / 'In der' per round key
const ROUND_KEYS = ['round-final', 'round-semi', 'round-quart', 'round-16']; // keyed by depth from the final
const roundKeyOf = d => ROUND_KEYS[d] ?? 'round-of';

const pairSig = ids => [...ids].sort().join('|');

// One escaper for both pages.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Per-render cache; toCats rebuilds contexts every render, so a memo can't outlive it.
const ctxMemo = ctx => ctx._memo || (ctx._memo = {});

// id -> display name; a malformed entry renders absent, never throws.
const nameMap = x => new Map((Array.isArray(x) ? x : []).filter(e => e && typeof e === 'object').map(e => [e.id, e.name]));

// Built once per render by toCats; standalone makeCat calls make a fresh map.
function sharedFacts(tjson) {
  return {
    names: nameMap(tjson && tjson.players),
    tz: (tjson && tjson.timezone) || 'UTC',
    venues: nameMap(tjson && tjson.venues),
  };
}

function makeCat(c, tjson, shared, order = 0) {
  // Never throws on broken shape — the validator calls this while reporting it.
  const matches = (c.matches || []).filter(m => m && typeof m === 'object');
  const s = shared || sharedFacts(tjson);
  return {
    matches,
    byId: new Map(matches.map(m => [m.id, m])),
    bestOf: (c.meta && c.meta.bestOf) || {},
    names: s.names,
    tz: s.tz,
    slotMinutes: (c.meta && c.meta.slotMinutes) || {},
    venues: s.venues,
    name: (c.meta && c.meta.name) || '',
    id: (c.meta && c.meta.id) || '',
    order
  };
}

// The one matches-map shape guard; null when malformed.
const matchesOf = tjson => (tjson && tjson.matches && typeof tjson.matches === 'object' && !Array.isArray(tjson.matches)) ? tjson.matches : null;

function toCats(tjson) {
  const byCat = matchesOf(tjson) || {};
  const cats = (tjson && Array.isArray(tjson.categories)) ? tjson.categories : [];
  const shared = sharedFacts(tjson); // once per render — every category shares the one map
  // A non-object entry renders as absent — the gate reports it, the page never throws.
  return cats.filter(c => c && typeof c === 'object').map((c, i) => makeCat({ meta: c, matches: Array.isArray(byCat[c.id]) ? byCat[c.id] : [] }, tjson, shared, i));
}

const stageOf = m => m?.pool !== undefined ? 'groups' : 'knockout';

function matchSlotMs(m, ctx) {
  const cfg = (ctx && ctx.slotMinutes) || {};
  return (m?.slotMinutes ?? cfg[stageOf(m)]) * 60 * 1000;
}


const sideIdx = w => w === 'a' ? 0 : 1;

function gameDiff(games) {
  let gd = 0, pd = 0;
  if (Array.isArray(games)) for (const g of games) {
    if (!g || typeof g !== 'object') continue;
    gd += Math.sign(g.a - g.b);
    pd += g.a - g.b;
  }
  return { gd, pd };
}

function bestOfOf(m, ctx) {
  return m.bestOf ?? ctx.bestOf[stageOf(m)];
}

// A best-of-1 pool's GD just restates W−L; one match overridden to best-of-3 brings it back.
function poolBo1(ctx, pool) {
  return ctx.matches.filter(m => m && m.pool === pool).every(m => bestOfOf(m, ctx) === 1);
}

function winnerIdx(m) {
  return m && m.result && m.result.winner !== undefined ? sideIdx(m.result.winner) : null;
}

function isDone(m) {
  // Any result settles the match — void included (settled, never overdue).
  return !!m && m.result !== undefined;
}

function isDeadTie(std, rank) {
  const rec = std[rank - 1];
  return !!rec && !!rec.tie; // tie cluster id: the ladder exhausted without separating it
}

// A dead-tie cluster shares its first rank (1 1 3 3); the cluster id keeps adjacent ties from merging.
function poolRanks(std) {
  const ranks = [];
  for (let i = 0; i < std.length; i++) {
    ranks.push((!std[i].tie || i === 0 || std[i - 1].tie !== std[i].tie) ? i + 1 : ranks[i - 1]);
  }
  return ranks;
}

// Rank cells stay blank until a pool has a decided match.
const poolDecided = std => !!std && std.some(r => r.wins || r.losses);

function poolStandings(ctx, pool, partial) {
  // partial=true: skip unfinished matches — live standings; strict form TBDs.
  const ms = ctx.matches.filter(m => m && m.pool === pool);
  if (ms.length === 0) return null;
  const recs = new Map();
  const rec = s => {
    if (!(s && s.kind === 'players' && Array.isArray(s.ids))) return null;
    const sig = pairSig(s.ids);
    let r = recs.get(sig);
    if (!r) { r = { sig, ids: new Set(s.ids), wins: 0, losses: 0, gd: 0, pd: 0 }; recs.set(sig, r); }
    return r;
  };
  for (const m of ms) {
    if (!Array.isArray(m.sides)) continue;
    // Map insertion order is the tie display order.
    const s0 = m.sides[0], s1 = m.sides[1];
    const r0 = rec(s0), r1 = rec(s1);
    if (!r0 || !r1) continue;
    const w = winnerIdx(m);
    if (w === null) {
      if (m.result !== undefined) continue; // void: settled, counts nothing
      if (!partial) return null;
      continue;
    }
    (w === 0 ? r0 : r1).wins++;
    (w === 0 ? r1 : r0).losses++;
    if (m.result && m.result.status === 'played') {
      const { gd, pd } = gameDiff(m.games);
      r0.gd += gd; r0.pd += pd;
      r1.gd -= gd; r1.pd -= pd;
    }
  }
  return poolLadder([...recs.values()], ms);
}

// Head-to-head over the set's mutual matches only (walkovers carry no differential).
function mutualKeys(list, ms) {
  const h = new Map(list.map(r => [r.sig, { hw: 0, hg: 0, hp: 0 }]));
  for (const m of ms) {
    if (!Array.isArray(m.sides)) continue;
    const [s0, s1] = m.sides;
    if (!s0 || !s1 || s0.kind !== 'players' || s1.kind !== 'players') continue;
    const a = pairSig(s0.ids), b = pairSig(s1.ids);
    if (!h.has(a) || !h.has(b)) continue;
    const w = winnerIdx(m);
    if (w === null) continue;
    const ka = h.get(a), kb = h.get(b);
    (w === 0 ? ka : kb).hw++;
    if (m.result && m.result.status === 'played') {
      const { gd, pd } = gameDiff(m.games);
      ka.hg += gd; ka.hp += pd; kb.hg -= gd; kb.hp -= pd;
    }
  }
  return h;
}

// Ladder: wins, then per wins-block h2h wins/gd/pd, then overall gd/pd. A rung that
// splits a cluster recurses; a still-tied block is a dead tie (renders TBD).
function poolLadder(list, ms) {
  const out = [];
  let tieCluster = 0; // one id per dead-tie cluster — poolRanks shares a rank only within it
  const order = (set) => {
    if (set.length <= 1) { out.push(...set); return; }
    const h = mutualKeys(set, ms);
    const cmp = (a, b) => {
      const ka = [h.get(a.sig).hw, h.get(a.sig).hg, h.get(a.sig).hp, a.gd, a.pd];
      const kb = [h.get(b.sig).hw, h.get(b.sig).hg, h.get(b.sig).hp, b.gd, b.pd];
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
      return 0;
    };
    set.sort(cmp); // every caller passes a fresh slice
    for (let i = 0; i < set.length;) {
      let j = i + 1;
      while (j < set.length && cmp(set[i], set[j]) === 0) j++;
      const cluster = set.slice(i, j);
      if (cluster.length === 1) out.push(cluster[0]);
      else if (cluster.length === set.length) {
        tieCluster++;
        for (const r of cluster) r.tie = tieCluster; // truthy so isDeadTie keeps working
        out.push(...cluster);
      } else order(cluster);
      i = j;
    }
  };
  const top = [...list].sort((a, b) => b.wins - a.wins);
  for (let i = 0; i < top.length;) {
    let j = i + 1;
    while (j < top.length && top[j].wins === top[i].wins) j++;
    order(top.slice(i, j));
    i = j;
  }
  return out;
}

function resolveSide(side, ctx, memo = new Map()) {
  if (!side || typeof side !== 'object') return null;
  if (side.kind === 'players') return Array.isArray(side.ids) ? new Set(side.ids) : null; // a string ids would char-split in a Set
  if (side.kind === 'match') {
    const m = ctx.byId.get(side.match);
    if (!m || !Array.isArray(m.sides)) return null;
    if (memo.has(m.id)) return memo.get(m.id) || null; // in-progress = cycle guard
    memo.set(m.id, undefined);
    const w = winnerIdx(m);
    if (w === null) return null;
    const child = m.sides[side.result === 'winner' ? w : 1 - w];
    const v = resolveSide(child, ctx, memo);
    memo.set(m.id, v);
    return v;
  }
  if (side.kind === 'pool') {
    const std = poolStandings(ctx, side.pool);
    if (!std) return null;
    const rec = std[side.rank - 1];
    if (!rec || isDeadTie(std, side.rank)) return null; // dead tie -> TBD
    return rec.ids;
  }
  return null;
}

// Placement range or main-bracket column, plus the ref key naming the slot.
function refInfo(m, ctx) {
  const pr = plRange(m, ctx);
  const col = pr === null ? koColumn(m, ctx) : null;
  return { pr, col, key: pr === null ? roundKeyOf(col) : pr.win ? 'pl-place' : 'pl-semi' };
}

// "Winner of SF1", "2nd in Pool A" — words and articles come from the bundle.
function slotLabel(side, ctx) {
  if (!side || typeof side !== 'object') return 'TBD';
  if (side.kind === 'pool') {
    const st = poolStandings(ctx, side.pool);
    const key = st && isDeadTie(st, side.rank) ? 'slot-pool-tie' : 'slot-pool';
    return t(LOCALE, key, { rank: ordNum(side.rank), pool: side.pool });
  }
  if (side.kind !== 'match') return 'TBD';
  const who = t(LOCALE, side.result === 'winner' ? 'slot-winner' : 'slot-loser');
  const ref = ctx.byId.get(side.match);
  if (!ref) return t(LOCALE, 'slot-dangling', { who, id: side.match }); // dangling ref — the id is all there is
  const { pr, col, key } = refInfo(ref, ctx);
  // a numbered card: any main round but the apex, or a classification semi (5-8 SF-1)
  const code = pr === null ? col !== 0 : !pr.win;
  const label = code ? matchLabel(ref, ctx) : stageLabel(ref, ctx);
  return t(LOCALE, 'slot-of', { who, ref: code ? label : refWord(key, 'dat', label) });
}

// Player-id set -> display name, "Ada / Ben".
const teamLabel = (ids, ctx) => [...ids].map(id => ctx.names.get(id) || id).join(' / ');

function sideLabel(side, ctx) {
  const ids = resolveSide(side, ctx);
  if (!ids) return slotLabel(side, ctx);
  return teamLabel(ids, ctx);
}

// Shared by the site's sideRow and the admin's board.
function scoreCells(m, i, ctx) {
  const r = m.result;
  const games = m.games || [];
  const bo = Math.min(bestOfOf(m, ctx) || 1, MAX_BEST_OF); // unset stage config -> one unmarked slot; a malformed override stays finite
  // placeholder dots keep the best-of shape; the winner carries the W/O mark
  const slot = () => Array.from({ length: bo }, (_, g) => {
    const game = games[g];
    // aria-hidden: the placeholder dot is shape-as-label, noise to a screen reader.
    // The gate ships integer scores only — escape anything else.
    const x = game ? (i === 0 ? game.a : game.b) : '·';
    return `<span${game ? '' : ' class="ph" aria-hidden="true"'}>${esc(x)}</span>`;
  }).join('');
  if (!r || r.status === 'played') return slot();
  if (r.status === 'void') return '<span>void</span>';
  return sideIdx(r.winner) === i ? '<span title="Walkover">W/O</span>' : slot();
}

// Confirmed only: a side must resolve to the player — undecided slots stay off.
function playerMatches(ctx, pid) {
  const rows = [];
  for (const m of ctx.matches) {
    if (!m || !Array.isArray(m.sides)) continue;
    for (let i = 0; i < m.sides.length; i++) {
      const team = resolveSide(m.sides[i], ctx);
      if (team && team.has(pid)) {
        rows.push({ m, i, team });
        break;
      }
    }
  }
  return rows;
}

// Both result edges count — a loss drops the player into the placement tree. Reads parentsOf, never a scan.
function koConsumers(ctx, id) {
  const { winnerParent, loserParent } = parentsOf(ctx);
  const out = [winnerParent.get(id), loserParent.get(id)].filter(X => X && X.pool === undefined);
  return [...new Set(out)]; // one match may consume both edges of id
}

// Per pool: sigs (side count) and slots (rank -> consuming match), from stored sides only.
function poolFacts(ctx) {
  const out = new Map();
  for (const m of ctx.matches) {
    if (!m || !Array.isArray(m.sides)) continue;
    if (m.pool !== undefined) {
      for (const s of m.sides) {
        if (s && s.kind === 'players' && Array.isArray(s.ids)) {
          if (!out.has(m.pool)) out.set(m.pool, { sigs: new Set(), slots: new Map() });
          out.get(m.pool).sigs.add(pairSig(s.ids));
        }
      }
    } else {
      for (const s of m.sides) {
        if (s && s.kind === 'pool' && typeof s.rank === 'number' && s.rank >= 1) {
          if (!out.has(s.pool)) out.set(s.pool, { sigs: new Set(), slots: new Map() });
          out.get(s.pool).slots.set(s.rank, m);
        }
      }
    }
  }
  return out;
}

// Ranks a player could still hold: every rank while any pool match is out, else the dead-tie cluster.
function playerRanks(ctx, pool, pid, roster) {
  const std = poolStandings(ctx, pool);
  if (!std) return Array.from({ length: roster }, (_, i) => i + 1);
  const i = std.findIndex(x => x.ids.has(pid));
  if (i < 0 || !isDeadTie(std, i + 1)) return [];
  const out = [];
  let a = i; while (a > 0 && std[a - 1].tie === std[i].tie) a--;
  let b = i; while (b < std.length - 1 && std[b + 1].tie === std[i].tie) b++;
  for (let r = a + 1; r <= b + 1; r++) out.push(r);
  return out;
}

// '3rd–6th' / '2nd, 7th' — collapsed runs of a sorted rank list, in ordinals.
function rankRange(ranks) {
  const runs = [];
  for (const n of [...ranks].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => a === b ? ordNum(a) : `${ordNum(a)}–${ordNum(b)}`).join(', ');
}

// rankRange collapses runs, so a band must arrive as every rank it spans — [5, 8] would render "5th, 8th".
const rangeRanks = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

const matchEdge = s => s && s.kind === 'match';


// A placement match's band, else the round's name (matchLabel keeps the abbr+ordinal form).
function stageLabel(m, ctx) {
  return placementLabel(m, ctx) ?? roundName(koColumn(m, ctx));
}

// One entry per knockout round a player could still reach: certain bits plus a
// chip naming the ranks/outcomes that get in.
function possibleStages(ctx, pid) {
  const rows = playerMatches(ctx, pid);
  const koRows = rows.filter(r => r.m.pool === undefined);
  const confIds = new Set(koRows.map(r => r.m.id));
  const poolRow = rows.find(r => r.m.pool !== undefined);
  const pool = poolRow === undefined ? null : poolRow.m.pool;
  const facts = (koRows.length || pool === null) ? null : poolFacts(ctx).get(pool);

  // Seats recorded separately from the reach BFS — one match can seat the
  // player via several ranks or edges, and the seen-guard must not drop the
  // second record.
  const poolSeatsOf = new Map(); // match id -> [rank]
  const edgeSeatsOf = new Map(); // match id -> [{ kind, parent }]
  const gate = new Map();        // confirmed seat id -> opened result edges
  const seen = new Set();
  const queue = [];
  const add = m => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    queue.push(m.id);
  };
  if (koRows.length) {
    // A decided seat opens only the branch the player finished on; an undone
    // (or void) one keeps both — the player could still win or lose.
    for (const r of koRows) {
      const w = winnerIdx(r.m);
      gate.set(r.m.id, w === null ? 'either' : w === r.i ? 'winner' : 'loser');
      add(r.m); // confirmed seats render as cards — no stage entry
    }
  } else if (facts) {
    for (const r of playerRanks(ctx, pool, pid, facts.sigs.size)) {
      const m = facts.slots.get(r);
      if (!m) continue;
      if (!poolSeatsOf.has(m.id)) poolSeatsOf.set(m.id, []);
      poolSeatsOf.get(m.id).push(r);
      add(m);
    }
  }
  while (queue.length) {
    const id = queue.shift();
    const g = gate.get(id);
    for (const X of koConsumers(ctx, id)) {
      for (const s of X.sides) {
        if (!s || s.kind !== 'match' || s.match !== id) continue;
        if (g === 'winner' && s.result !== 'winner') continue;
        if (g === 'loser' && s.result !== 'loser') continue;
        if (!edgeSeatsOf.has(X.id)) edgeSeatsOf.set(X.id, []);
        edgeSeatsOf.get(X.id).push({ kind: s.result, parent: id });
        add(X);
      }
    }
  }

  // ---- group reached matches into stages -----------------------------------
  const stages = new Map();
  for (const id of seen) {
    if (confIds.has(id)) continue;
    const m = ctx.byId.get(id);
    if (!m || !Array.isArray(m.sides)) continue;
    const { pr, col } = refInfo(m, ctx);
    // The label rides its structural row (lo/hi/win) so the merge logic below
    // classifies by shape, never by word position in a localized string.
    const label = stageLabel(m, ctx);
    let stage = stages.get(label);
    if (!stage) { stage = { label, col, pl: pr, ranks: new Set(), edges: [], times: [], courts: [], ids: [] }; stages.set(label, stage); }
    stage.ids.push(m);
    for (const rank of poolSeatsOf.get(id) || []) stage.ranks.add(rank);
    for (const e of edgeSeatsOf.get(id) || []) stage.edges.push(e);
    const ts = schedTime(m, ctx.tz);
    if (ts !== null) stage.times.push(ts);
    if (typeof m.venue === 'string') stage.courts.push(m.venue);
  }

  // ---- finalize: slot sets, chips ------------------------------------------
  const present = [...stages.values()];
  const merged = mergeTwinStages(present);
  // The chip names the entry gates: direct slot ranks, then result edges ("via
  // the Semifinals" once merged); a stage with no gates reads "any rank".
  const chipOf = stage => {
    const chips = [];
    if (facts && stage.ranks.size) {
      const universe = playerRanks(ctx, pool, pid, facts.sigs.size);
      const direct = [...stage.ranks];
      if (direct.length === universe.length && !stage.edges.length) chips.push(t(LOCALE, 'chip-any', { pool }));
      else chips.push(t(LOCALE, 'chip-rank', { range: rankRange(direct), pool }));
    }
    if (stage.edges.length) {
      const parts = new Set();
      for (const e of stage.edges) {
        const parent = ctx.byId.get(e.parent);
        if (!parent || !Array.isArray(parent.sides)) continue;
        const { key } = refInfo(parent, ctx);
        const label = stageLabel(parent, ctx);
        parts.add(stage.merged ? t(LOCALE, 'chip-via', { ref: refWord(key, 'acc', label) }) : t(LOCALE, 'chip-as', { kind: t(LOCALE, e.kind === 'winner' ? 'kind-winner' : 'kind-loser'), ref: refWord(key, 'dat', label) }));
      }
      for (const p of [...parts].sort()) chips.push(p);
    }
    return chips.join(t(LOCALE, 'chip-or'));
  };
  const out = [];
  for (const stage of present) {
    if (merged.has(stage)) continue; // the pair's originals — the merged entry carries them
    out.push({ label: stage.label, col: stage.col, ...slotSet(stage.ids.length, stage.times, stage.courts), chip: chipOf(stage) });
  }
  // Deepest-first (QF -> SF -> Final); a merged pair keeps its deeper column.
  out.sort((a, b) => (b.col ?? -1) - (a.col ?? -1));
  return out;
}

// Times list every distinct start (a staggered round), ascending; a court stays
// a single value only when the whole stage agrees, else empty (TBD). An
// incomplete stage keeps both empty.
const slotSet = (n, times, courts) => {
  const whole = arr => n > 0 && arr.length === n;
  const tset = whole(times) ? [...new Set(times)].sort((a, b) => a - b) : [];
  const cset = whole(courts) && courts.every(c => c === courts[0]) ? [courts[0]] : [];
  return { times: tset, courts: cset };
};

// Sibling classification semis name their full band ("5th–12th semi"); " place"
// would mangle a semi label.
const bandSemiLabel = ps => { // ps: the pair's structural rows — min/max over their ranges
  return t(LOCALE, 'pl-semi', { a: ordNum(Math.min(...ps.map(p => p.lo))), b: ordNum(Math.max(...ps.map(p => p.hi))) });
};

// Winner- and loser-fed entries of one seat merge into one stage; rank-fed and
// ambiguous gates stay separate.
function mergeTwinStages(present) {
  const merged = new Set();
  const byGate = new Map();
  for (const stage of present) {
    const parentSig = [...new Set(stage.edges.map(e => e.parent))].sort().join('|');
    if (!parentSig) continue;
    const kind = stage.edges.every(e => e.kind === 'winner') ? 'w' : stage.edges.every(e => e.kind === 'loser') ? 'l' : null;
    if (!kind) continue;
    const key = `${parentSig}|${kind}`;
    if (!byGate.has(key)) byGate.set(key, []);
    byGate.get(key).push(stage);
  }
  const twin = key => byGate.get(key.replace(/\|w$/, '|l'));
  for (const [key, list] of byGate) {
    if (key.endsWith('|l') || list.length !== 1) continue;
    const other = twin(key);
    if (!other || other.length !== 1 || merged.has(list[0]) || merged.has(other[0])) continue;
    const [x, y] = [list[0], other[0]];
    // Classification vs round is a structural flag (pl), never a label sniff;
    // the pair's numbers come from the pl ranks too, so no locale's label
    // string is ever parsed back.
    const placeL = [x, y].filter(s => s.pl !== null);
    const roundL = [x, y].filter(s => s.pl === null);
    // "5th / 7th place" joins a decider pair's labels; a round with its
    // placement companion names the band like the bracket headings do.
    const label = roundL.length ? stageGroupName(roundL[0].label, placeL.map(s => s.label))
      : placeL.every(s => !s.pl.win) ? bandSemiLabel(placeL.map(s => s.pl))
      : t(LOCALE, 'pl-pair', { a: cardNum(x.pl.lo), b: cardNum(y.pl.lo) });
    merged.add(x); merged.add(y);
    const times = [...x.times, ...y.times];
    const courts = [...x.courts, ...y.courts];
    present.push({
      label, col: Math.max(x.col ?? -1, y.col ?? -1), merged: true,
      ranks: new Set([...x.ranks, ...y.ranks]), edges: [...x.edges, ...y.edges],
      times, courts, ids: [...x.ids, ...y.ids],
    });
  }
  return merged;
}


// 3rd/5th/7th place or a classification semi; null for main-bracket matches.
function placementLabel(m, ctx) {
  const r = plRange(m, ctx);
  if (!r) return null;
  // the pre-word form, not the range form: "Platz 3", never "Platz 3."
  return r.win ? t(LOCALE, 'pl-place', { n: cardNum(r.lo) }) : t(LOCALE, 'pl-semi', { a: ordNum(r.lo), b: ordNum(r.hi) });
}

// Knockout round name by field size: 4 -> SF, 8 -> QF, n -> R{n}. Shared by the
// main-tree card label and the classification band code.
const roundAbbr = n => n === 4 ? 'SF' : n === 8 ? 'QF' : `R${n}`;

// Compact code for a classification semi: "5-8 SF-1" — band span + entry-round
// name + ordinal, so a slot can name a visible card. Deciders keep their place
// label (they are unique per band).
function plCode(m, ctx) {
  const r = plRange(m, ctx);
  if (!r || r.win) return null;
  const size = r.hi - r.lo + 1;
  const abbr = roundAbbr(size);
  const ord = plOrdinal(m, ctx);
  return `${r.lo}-${r.hi} ${abbr}${ord ? `-${ord}` : ''}`;
}

// Possible-rank range of every classification match: a slot reaches the range of
// whichever match consumes that edge (winner edges climb, loser edges drop); an
// edge nothing consumes holds a fixed rank stepped out from the pool champion.
function plBuild(ctx) {
  const pl = new Map(); // id -> { lo, hi, win } (win: winner edge unconsumed)
  const byId = ctx.byId;
  const { winnerParent, loserParent } = parentsOf(ctx); // same edge classification the bracket consumers read — no drift
  const adj = new Map(); // undirected match-edge links for the reachability walk
  const addLink = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const m of ctx.matches) {
    if (!Array.isArray(m.sides)) continue;
    for (const s of m.sides) {
      if (!s || s.kind !== 'match' || !byId.has(s.match)) continue; // dangling refs stay off the walk
      addLink(m.id, s.match);
      addLink(s.match, m.id);
    }
  }
  // Classification match: a loser edge as a slot (main-bracket matches carry
  // only winner and player sides), or a slot from a classified match.
  const memMemo = new Map();
  const member = (m) => {
    if (!m || !Array.isArray(m.sides)) return false; // dangling ref or malformed sides — the gate reports it, the walk skips it
    if (memMemo.has(m.id)) return memMemo.get(m.id);
    memMemo.set(m.id, false);
    let yes = false;
    for (const s of m.sides) {
      if (!s || s.kind !== 'match') continue;
      if (s.result === 'loser') { yes = true; break; }
      const X = byId.get(s.match);
      if (X && member(X)) { yes = true; break; }
    }
    memMemo.set(m.id, yes);
    return yes;
  };
  // Pool champion: a match nothing winner-consumes whose all-winner chain bottoms
  // out at a main-round loser edge. Returns the anchor round's winner depth d.
  const champAnchor = (m, seen) => {
    if (!m || !Array.isArray(m.sides) || seen.has(m.id)) return null; // a dangling feeder is the gate's finding, never a throw
    seen.add(m.id);
    for (const s of m.sides) {
      if (!s || s.kind !== 'match' || s.result !== 'loser') continue;
      const X = byId.get(s.match);
      if (X && !member(X)) return wdOf(ctx, X.id); // the anchor: a main-round loser edge
      return null; // a sub-bracket final's chain passes through the classification — not the champion
    }
    for (const s of m.sides) {
      if (!s || s.kind !== 'match' || s.result !== 'winner') continue;
      const r = champAnchor(byId.get(s.match), seen);
      if (r !== null) return r;
    }
    return null;
  };
  const pools = []; // [champion, anchor depth]
  for (const m of ctx.matches) {
    if (!Array.isArray(m.sides) || winnerParent.has(m.id)) continue;
    if (!m.sides.some(s => s && s.kind === 'match')) continue;
    const d = champAnchor(m, new Set());
    if (d !== null) pools.push([m, d]);
  }
  // A band whose deciders were never played holds several terminal matches at the
  // same anchor depth — that shared lo is the signal the band is entered, not
  // resolved.
  const termCount = new Map();
  for (const [, d] of pools) { const a = 2 ** d + 1; termCount.set(a, (termCount.get(a) ?? 0) + 1); }
  for (const [champ, d] of pools) {
    const A = 2 ** d + 1; // the pool's best rank
    const k = termCount.get(A); // >1: the band played its entry round only
    let next = A + 2;
    // Reachability from the champion over classification matches only — main-
    // bracket neighbors fail member() and stay out; winner-edge links before
    // loser- links so tied terminals rank in winner order.
    const seen = new Set([champ.id]);
    const queue = [champ];
    const candsOf = (N) => {
      const wp = winnerParent.get(N.id); // the winner-parent neighbor sorts first
      return (adj.get(N.id) || [])
        .filter(x => !seen.has(x) && member(byId.get(x)))
        .sort((a, b) => (byId.get(b) === wp) - (byId.get(a) === wp));
    };
    const spec = new Map(); // id -> [winner edge, loser edge]: a rank, or the consuming match's id
    for (let qi = 0; qi < queue.length; qi++) {
      const N = queue[qi];
      const pw = winnerParent.get(N.id), lp = loserParent.get(N.id);
      const w = pw ? ['r', pw.id] : N === champ ? ['n', A] : ['n', next++];
      const l = lp ? ['r', lp.id] : N === champ ? ['n', A + 1] : ['n', next++];
      spec.set(N.id, [w, l]);
      for (const x of candsOf(N)) { seen.add(x); queue.push(byId.get(x)); }
    }
    const resolve = (id) => {
      if (pl.has(id)) return pl.get(id);
      pl.set(id, null);
      const [w, l] = spec.get(id) || [];
      const val = (x) => x && (x[0] === 'n' ? { lo: x[1], hi: x[1] } : resolve(x[1])) || null;
      const wv = val(w), lv = val(l);
      let out = wv && lv
        ? { lo: Math.min(wv.lo, lv.lo), hi: Math.max(wv.hi, lv.hi), win: !winnerParent.has(id) }
        : null;
      // an entered-but-unresolved band spans its full range and ties (5 5 7 7),
      // never stepping through 5 6 7 8
      if (out && k > 1 && id === champ.id) out = { lo: A, hi: A + 2 * k - 1, win: false };
      pl.set(id, out);
      return out;
    };
    for (const m of queue) resolve(m.id);
  }
  return pl;
}

// Range of a classification match; null for main-bracket matches. winners reads lo.
function plRange(m, ctx) {
  const memo = ctxMemo(ctx);
  if (!memo.pl) memo.pl = plBuild(ctx);
  return memo.pl.get(m.id) ?? null;
}

// Depth band of every classification match, one below its anchor's column minus
// further loser-chain edges; records each band's distinct placement labels.
function plBands(ctx) {
  const memo = ctxMemo(ctx);
  if (!memo.plBand) {
    const col = new Map();    // placement match id -> band column
    const labels = new Map(); // band column -> placement labels
    const bandOf = (m) => {
      const got = col.get(m.id);
      if (got !== undefined) return got;
      col.set(m.id, null);
      let cur = m;
      let hops = 0; // placement-tree edges between the anchor's loser slot and m
      const seen = new Set();
      for (;;) {
        seen.add(cur.id);
        const feed = (cur.sides || []).find(s => s && s.kind === 'match' && ctx.byId.has(s.match));
        if (!feed) { cur = null; break; }
        cur = ctx.byId.get(feed.match);
        if (seen.has(cur.id)) { cur = null; break; }
        if (placementLabel(cur, ctx) === null) break; // the anchor: a main match
        hops++;
      }
      const c = cur === null ? null : Math.max(0, koColumn(cur, ctx) - 1 - hops);
      col.set(m.id, c);
      if (c !== null) {
        if (!labels.has(c)) labels.set(c, new Set());
        labels.get(c).add(placementLabel(m, ctx));
      }
      return c;
    };
    for (const m of ctx.matches) {
      if (!m || m.pool !== undefined || placementLabel(m, ctx) === null) continue;
      bandOf(m);
    }
    memo.plBand = { col, labels };
  }
  return memo.plBand;
}

// Band column of a classification match; null elsewhere.
function placementColumn(m, ctx) {
  return plBands(ctx).col.get(m && m.id) ?? null;
}

// Band-local ordinal of a classification semi: the pairing's first side is the
// better seed, so the semi holding the best loser reads 1. Structural — a
// reschedule never renumbers a card.
function plOrdinal(m, ctx) {
  const memo = ctxMemo(ctx);
  if (!memo.plOrd) {
    // Keyed by full span: a band of 8 (9-16) and its sub-band (9-12) share lo,
    // so keying by lo alone would number the 9-16 entries 3-6.
    const bands = new Map(); // band span -> [{ id, key }]
    for (const X of ctx.matches) {
      const r = X && X.pool === undefined ? plRange(X, ctx) : null;
      if (!r || r.win) continue; // band semis only; deciders are already unique
      const first = Array.isArray(X.sides) ? X.sides[0] : null;
      const anchor = first && first.kind === 'match' ? ctx.byId.get(first.match) : null;
      const span = `${r.lo}-${r.hi}`;
      if (!bands.has(span)) bands.set(span, []);
      bands.get(span).push({ id: X.id, key: anchor ? koOrdinal(anchor, ctx) : Infinity });
    }
    const ord = memo.plOrd = new Map();
    for (const list of bands.values()) {
      list.sort((a, b) => a.key - b.key); // stable: ties keep build order
      list.forEach((e, i) => ord.set(e.id, i + 1));
    }
  }
  return memo.plOrd.get(m && m.id) || 0;
}

// Distinct placement labels of one band (order free — stageGroupName dedupes).
function bandLabels(ctx, col) {
  return [...(plBands(ctx).labels.get(col) || [])];
}

// Round name plus its placement companions; several distinct labels fall back to
// "Final / Placement".
function stageGroupName(round, labels) {
  const uniq = [...new Set(labels.map(bandShort))];
  return uniq.length === 1 ? `${round} / ${uniq[0]}` : uniq.length > 1 ? `${round} / ${t(LOCALE, 'placement')}` : round;
}

// The deepest band with a playable card — nextKoWave's counterpart for placement.
function placeWave(ctx) {
  let best = null;
  for (const X of ctx.matches) {
    if (!X || X.pool !== undefined || isDone(X) || placementLabel(X, ctx) === null) continue;
    if (!Array.isArray(X.sides) || X.sides.length !== 2) continue;
    if (!resolveSide(X.sides[0], ctx) || !resolveSide(X.sides[1], ctx)) continue;
    const c = placementColumn(X, ctx);
    if (c !== null) best = best === null ? c : Math.min(best, c);
  }
  return best;
}

// Winner-edge distance to the final (0 = the final). Its own memo, not koColumn's
// — this can be read while koColumn's build is mid-flight.
function wdOf(ctx, id) {
  const memo = ctxMemo(ctx);
  if (!memo.wd) {
    const { winnerParent } = parentsOf(ctx);
    const wdMap = memo.wd = new Map();
    const d = (X) => {
      if (wdMap.has(X.id)) return wdMap.get(X.id);
      wdMap.set(X.id, 0); // in-progress: a malformed cycle reads 0, never recurses
      const p = winnerParent.get(X.id);
      const r = p ? 1 + d(p) : 0;
      wdMap.set(X.id, r);
      return r;
    };
    for (const m of ctx.matches) d(m);
  }
  return memo.wd.get(id);
}

// "+02:00" offset for a date via a noon-UTC anchor.
// ponytail: wall times before a same-day DST shift get the post-transition
// offset, off by one hour — exact only if a tournament opens on a changeover day.
function tzOffset(tz, date) {
  // Intl throws on a bad timezone — a guarded null keeps a malformed file from
  // crashing a render.
  let parts;
  try {
    // Pinned to en, never LOCALE: this reads the machine offset off the
    // rendering, and some dialects spell it "UTC+02:00" (or worse) — which
    // Date.parse can't read, silently nulling every scheduled time.
    parts = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(new Date(date + 'T12:00:00Z'));
  } catch {
    return null;
  }
  const p = parts.find((x) => x.type === 'timeZoneName');
  return p && p.value !== 'GMT' ? p.value.replace('GMT', '') : '+00:00';
}

// Midnight is 00, never 24: hourCycle pins the day to 0-23 under any dialect.
function fmtTime(t, tz) {
  try {
    return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
  } catch { return ''; }
}

// Y-M-D from typed parts, calendar pinned to gregory/Latn — a non-Gregorian or
// native-digit locale would key days by a foreign year or digits.
function dayKey(t, tz) {
  let p = null;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat(LOCALE, { timeZone: tz, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(t).map(x => [x.type, x.value]));
  } catch { return null; } // bad tz: no day key — callers' null paths render empty
  return `${p.year}-${p.month}-${p.day}`;
}

// Anchor local wall time to an instant — the single derivation point.
function schedTime(m, tz) {
  const s = (m && m.scheduled) || '';
  if (!ISO_RE.test(s)) return null;
  const off = tzOffset(tz, s.slice(0, 10));
  if (off === null) return null;
  const t = Date.parse(s + off);
  return Number.isNaN(t) ? null : t;
}

const dayShort = (t, tz) => {
  try {
    return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(t);
  } catch { return ''; }
};

// Calendar-day label; a Y-M-D key needs no timezone. Format built once per dialect.
const locFmts = new Map();
const L = loc => {
  let f = locFmts.get(loc);
  if (!f) locFmts.set(loc, f = new Intl.DateTimeFormat(loc, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }));
  return f;
};
const dayLabel = k => L(LOCALE).format(new Date(k + 'T00:00:00Z'));

// Distinct scheduled days as sorted ISO date keys — the index's stored form.
function schedDays(ms, tz) {
  const ks = new Set();
  for (const m of ms) {
    const t = schedTime(m, tz);
    if (t !== null) ks.add(dayKey(t, tz));
  }
  return [...ks].sort();
}

// Human span from ISO day keys; the locale's own ordering rules ("Jul 11–12" vs
// "11.–12. Juli") come from Intl.
function fmtRange(keys) {
  const ks = (Array.isArray(keys) ? keys : []).filter(k => DATE_RE.test(k));
  if (!ks.length) return null;
  if (ks.length === 1) return dayLabel(ks[0]);
  const out = ks.map(dayLabel).join(' – ');
  return ks[0].slice(0, 4) !== ks.at(-1).slice(0, 4) ? `${out}, ${ks.at(-1).slice(0, 4)}` : out;
}

function fmtDiff(n) {
  return (n > 0 ? '+' : '') + n;
}

function kioskStatus(r, now) {
  const t = r.t;
  if (isDone(r.m)) return 'done';
  if (now >= t + matchSlotMs(r.m, r.ctx)) return 'overdue';
  if (now >= t) return 'now';
  return 'upcoming';
}

// Round name by distance from the final (0 -> Final, 1 -> Semifinals, ...). Which
// round size takes a dedicated word is a per-locale bundle key, no branch here.
function roundName(depthFromEnd) {
  const key = roundKeyOf(depthFromEnd);
  return t(LOCALE, key, key === 'round-of' ? { n: 2 << depthFromEnd } : undefined);
}

// The championship final, shared with koOrdinal: a knockout match no winner
// feeds, outside the classification tree.
const mainFinal = (ctx, parented) =>
  ctx.matches.find(X => X.pool === undefined && !parented.has(X.id) && placementLabel(X, ctx) === null);

// Bracket parent-adjacency in one scan: winnerParent (fed id -> parent), kids
// (parent -> feeder ids, side order), loserFed, loserParent. Every bracket
// consumer reads this one map.
function parentsOf(ctx) {
  const memo = ctxMemo(ctx);
  if (!memo.parents) {
    const winnerParent = new Map();
    const kids = new Map();
    const loserFed = new Set();
    const loserParent = new Map();
    for (const X of ctx.matches) {
      if (!Array.isArray(X.sides)) continue; // malformed: report, never throw
      for (const s of X.sides) {
        if (!matchEdge(s)) continue;
        if (s.result === 'winner') {
          winnerParent.set(s.match, X);
          if (!kids.has(X.id)) kids.set(X.id, []);
          kids.get(X.id).push(s.match);
        } else {
          loserFed.add(s.match);
          loserParent.set(s.match, X);
        }
      }
    }
    memo.parents = { winnerParent, kids, loserFed, loserParent };
  }
  return memo.parents;
}

// Column: 0 is the final, one back per winner edge; depth-from-leaves can't place
// a bye'd semi. Main-tree columns read wd (built before this).
function koColumn(m, ctx) {
  const memo = ctxMemo(ctx);
  if (!memo.koCol) {
    const koColMap = memo.koCol = new Map();
    const { winnerParent } = parentsOf(ctx);
    const final = mainFinal(ctx, winnerParent);
    const col = (X) => {
      const got = koColMap.get(X.id);
      if (got !== undefined) return got;
      koColMap.set(X.id, -1);
      const p = winnerParent.get(X.id);
      let r;
      if (p && placementLabel(p, ctx) === null) r = wdOf(ctx, X.id);
      else if (X === final) r = 0;
      else {
        const feeders = Array.isArray(X.sides) ? X.sides.filter(s => s && s.kind === 'match' && ctx.byId.has(s.match)).map(s => col(ctx.byId.get(s.match))) : [];
        r = feeders.length ? Math.max(...feeders) - 1 : 0;
      }
      koColMap.set(X.id, r);
      return r;
    };
    for (const X of ctx.matches) col(X);
  }
  return memo.koCol.get(m.id);
}

// Ordinal within a round, from who each winner feeds. Reads bracket structure,
// never `scheduled`, so editing times can't renumber anything. 0 = off the tree.
function koOrdinal(m, ctx) {
  const memo = ctxMemo(ctx);
  if (!memo.koOrd) {
    const { kids, winnerParent } = parentsOf(ctx);
    const ord = memo.koOrd = new Map();
    const final = mainFinal(ctx, winnerParent);
    if (final) {
      ord.set(final.id, 1);
      for (const stack = [final.id]; stack.length;) {
        const p = stack.pop();
        const o = ord.get(p);
        for (const [k, id] of (kids.get(p) || []).entries()) {
          if (!ord.has(id)) { ord.set(id, o * 2 - 1 + k); stack.push(id); }
        }
      }
    }
  }
  return memo.koOrd.get(m.id) || 0;
}

function matchLabel(m, ctx) {
  if (m.pool !== undefined) return `Pool ${m.pool}`;
  const pl = placementLabel(m, ctx);
  if (pl) return plCode(m, ctx) || pl;
  const col = koColumn(m, ctx);
  const n = 2 << col;
  if (n === 2) return roundName(col); // the apex reads its localized name
  // Every round carries its bracket ordinal so a slot reference names a visible card.
  const abbr = roundAbbr(n);
  const ord = koOrdinal(m, ctx);
  return ord ? `${abbr}-${ord}` : abbr;
}

// ---- Status derivation: what a category or player's line says ----------------

// The lowest column whose undone matches are playable — a scheduled final
// doesn't claim the status while its semifinals still decide it.
function nextKoWave(ctx) {
  // Placement matches resolve as a consequence of the bracket and are never the wave in play.
  const undone = ctx.matches.filter(m => m.pool === undefined && !m.result && placementLabel(m, ctx) === null);
  if (!undone.length) return null;
  const playable = undone.filter(m => !Array.isArray(m.sides) || m.sides.every(s => resolveSide(s, ctx)));
  // ponytail: an unsettled dead tie falls back to the lowest column ("Final"),
  // which reads wrong — brief, since the organizer settles the flagged tie;
  // gate the fallback on pool resolution if a format ever needs this accurate.
  return Math.min(...(playable.length ? playable : undone).map(m => koColumn(m, ctx)));
}

// Podium from played results; null when nothing is decided. Final and bronze are
// found structurally, never by rendered label.
function winners(ctx) {
  const { winnerParent, loserFed } = parentsOf(ctx);
  const m = mainFinal(ctx, winnerParent); // the one knockout match nothing winner-feeds
  if (!m || !m.result || winnerIdx(m) === null || !Array.isArray(m.sides)) return null;
  const a = resolveSide(m.sides[0], ctx), b = resolveSide(m.sides[1], ctx);
  if (!a || !b) return null;
  const w = winnerIdx(m);
  const out = { first: [...a], second: [...b], third: null, fourth: null };
  if (w === 1) { out.first = [...b]; out.second = [...a]; }
  // the bronze is the terminal match whose possible range starts at 3rd —
  // loserFed keeps a mid-bracket '3rd–4th semi' from being read as the decider itself
  let bronze = null;
  for (const X of ctx.matches) {
    if (!X || X.pool !== undefined || loserFed.has(X.id)) continue;
    const r = plRange(X, ctx);
    if (r && r.lo === 3) { bronze = X; break; }
  }
  if (bronze && bronze.result && winnerIdx(bronze) !== null && Array.isArray(bronze.sides)) {
    const x = resolveSide(bronze.sides[winnerIdx(bronze)], ctx), y = resolveSide(bronze.sides[1 - winnerIdx(bronze)], ctx);
    if (x) out.third = [...x];
    if (y) out.fourth = [...y];
  }
  return out;
}

// Category status facts: kind groups | ko | finished | winners.
function catStatus(ctx) {
  const ms = ctx.matches;
  if (!ms.length) return null;
  if (ms.every(isDone)) {
    const w = winners(ctx);
    return w ? { kind: 'winners', ...w } : { kind: 'finished' };
  }
  // Nothing played is not a state of its own: it is the first stage at zero
  // progress — groups at 0/N, or the front KO wave.
  const grp = ms.filter(m => m.pool !== undefined);
  if (grp.some(m => !isDone(m))) return { kind: 'groups', played: grp.filter(isDone).length, count: grp.length };
  const col = nextKoWave(ctx);
  const place = placeWave(ctx);
  // place: the classification wave — the main wave may be spent while a bronze
  // still reads ready. wave: the deeper of the two.
  return { kind: 'ko', wave: col ?? place };
}

// Unplayed matches with both sides resolved, at the earliest scheduled time —
// starts included.
function currentWave(ctx, status) {
  if (!status || status.kind === 'finished' || status.kind === 'winners') return [];
  const ready = ctx.matches.filter(m => !isDone(m) &&
    Array.isArray(m.sides) && m.sides.length === 2 &&
    !!resolveSide(m.sides[0], ctx) && !!resolveSide(m.sides[1], ctx));
  const ts = ready.map(m => schedTime(m, ctx.tz)).filter(Number.isFinite);
  if (!ts.length) return [];
  const t = Math.min(...ts);
  return ready.filter(m => schedTime(m, ctx.tz) === t);
}

// The apex reads its own word; every deeper round takes the locale's prepositional
// article (bundle data, never parsed off the rendered name).
const roundWord = (col, kind) => col === 0
  ? t(LOCALE, `${kind}-final`)
  : t(LOCALE, `${kind}-round`, { art: artWord(roundKeyOf(col), kind), round: roundName(col) });
const inWord = col => roundWord(col, 'in');
const elimWord = col => roundWord(col, 'elim');

// KO entries: consumed pool ranks + direct players — byes are absent matches, never 2^depth.
function koField(ctx) {
  let slots = 0;
  const players = new Set();
  for (const m of ctx.matches) {
    if (!m || m.pool !== undefined || !Array.isArray(m.sides)) continue;
    for (const s of m.sides) {
      if (!s) continue;
      if (s.kind === 'pool' && typeof s.rank === 'number') slots++;
      else if (s.kind === 'players' && Array.isArray(s.ids)) for (const id of s.ids) players.add(id);
    }
  }
  return slots + players.size;
}

// A finish band: the tightest placement range, a decided two-rank decider's exact
// place (winner lo, loser hi), else the deepest KO loss (a bye'd round clamps the top).
function playerBand(ctx, rows) {
  let best = null, bestR = null;
  for (const r of rows) {
    if (r.m.pool !== undefined) continue;
    const pr = plRange(r.m, ctx);
    if (pr && (!best || pr.hi - pr.lo < best.hi - best.lo)) { best = pr; bestR = r; }
  }
  if (best) {
    const w = best.win && best.hi === best.lo + 1 ? winnerIdx(bestR.m) : null;
    return w !== null ? [bestR.i === w ? best.lo : best.hi] : rangeRanks(best.lo, best.hi);
  }
  const koLost = rows.filter(r => {
    const w = winnerIdx(r.m);
    return w !== null && w !== r.i && r.m.pool === undefined && placementLabel(r.m, ctx) === null;
  });
  if (!koLost.length) return null;
  const d = Math.max(...koLost.map(r => koColumn(r.m, ctx)));
  const lo = 2 ** d + 1, hi = Math.min(2 ** (d + 1), koField(ctx));
  return lo <= hi ? rangeRanks(lo, hi) : null;
}

// A player's standing in one category: a plain word, plus the pool rank or finish
// band behind it where the data supports one.
function playerStatus(ctx, pid) {
  const rows = playerMatches(ctx, pid);
  if (!rows.length) return null;
  const withRank = (word, text) => text ? t(LOCALE, 'rank-append', { status: word, rank: text }) : word;
  const pool = () => {
    const row = rows.find(r => r.m.pool !== undefined);
    const std = row && poolStandings(ctx, row.m.pool, true);
    const i = std ? std.findIndex(x => x.ids.has(pid)) : -1;
    if (i < 0 || !poolDecided(std) || isDeadTie(std, i + 1)) return '';
    return t(LOCALE, 'slot-pool', { rank: ordNum(poolRanks(std)[i]), pool: row.m.pool });
  };
  const band = () => { const b = playerBand(ctx, rows); return b ? rankRange(b) : ''; };
  const undone = rows.filter(r => !isDone(r.m));
  if (undone.length) {
    const koRows = undone.filter(r => r.m.pool === undefined && placementLabel(r.m, ctx) === null);
    if (!koRows.length) {
      // only placement matches left to play (e.g. a bronze not yet scored) — not a championship round
      return undone.some(r => r.m.pool === undefined)
        ? withRank(t(LOCALE, 'in-placement'), band())
        : withRank(t(LOCALE, 'in-groups'), pool());
    }
    return inWord(Math.max(...koRows.map(r => koColumn(r.m, ctx))));
  }
  // The podium is decided by its own matches — gating on the last category match
  // would demote finalists to "Out in groups"/"Eliminated in the final".
  const w = winners(ctx);
  if (w) {
    if (w.first.includes(pid)) return t(LOCALE, 'champion');
    if (w.second.includes(pid)) return t(LOCALE, 'runner-up');
    if (w.third && w.third.includes(pid)) return t(LOCALE, 'rank3');
    if (w.fourth && w.fourth.includes(pid)) return t(LOCALE, 'rank4');
  }
  const lost = rows.filter(r => { const w = winnerIdx(r.m); return w !== null && w !== r.i; }); // void settles, counts nothing
  const koLost = lost.filter(r => r.m.pool === undefined && placementLabel(r.m, ctx) === null);
  if (koLost.length) return withRank(elimWord(Math.max(...koLost.map(r => koColumn(r.m, ctx)))), band());
  const poolsDone = ctx.matches.filter(m => m.pool !== undefined).every(isDone);
  return poolsDone ? withRank(t(LOCALE, 'out-groups'), pool()) : withRank(t(LOCALE, 'in-groups'), pool());
}

if (typeof module !== 'undefined') {
  module.exports = { LOCALE, setLocale, DATE_RE, ID_RE, ISO_RE, MAX_BEST_OF, pairSig, esc, makeCat, matchesOf, toCats, matchSlotMs, bestOfOf, poolBo1, winnerIdx, isDone, isDeadTie, poolStandings, poolRanks, poolDecided, poolFacts, resolveSide, teamLabel, sideLabel, scoreCells, playerMatches, possibleStages, placementLabel, plRange, placementColumn, bandLabels, stageGroupName, parentsOf, fmtTime, dayKey, tzOffset, schedTime, schedDays, fmtRange, dayShort, dayLabel, fmtDiff, kioskStatus, roundName, koColumn, koOrdinal, matchLabel, winners, catStatus, currentWave, playerStatus };
}
