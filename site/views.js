'use strict';

// Under node the sibling bundles must land on globalThis as they do in the browser.
if (typeof module !== 'undefined') {
  Object.assign(globalThis, require('./i18n.js'));
  Object.assign(globalThis, require('./derive.js'));
}

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
const ROUND_KEYS = ['round-final', 'round-semi', 'round-quart', 'round-16']; // keyed by depth from the final
const roundKeyOf = d => ROUND_KEYS[d] ?? 'round-of';

// One escaper for both pages. The map is a constant, built once.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);

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


// Player-id set -> display name, "Ada & Ben".
const teamLabel = (ids, ctx) => [...ids].map(id => ctx.names.get(id) || id).join(' & ');

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
  return sideIdx(r.winner) === i ? `<span title="${esc(t(LOCALE, 'walkover'))}">W/O</span>` : slot();
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


// A placement match's band, else the round's name (matchLabel keeps the abbr+ordinal form).
function stageLabel(m, ctx) {
  return placementLabel(m, ctx) ?? roundName(koColumn(m, ctx));
}

// One entry per knockout round a player could still reach: the structural facts
// from derive.js, named here, plus a chip naming the ranks/outcomes that get in.
function possibleStages(ctx, pid) {
  const { stages, pool, seats, hasPoolFacts } = possibleStageFacts(ctx, pid);
  // The label rides its structural row (lo/hi/win) so the merge logic below
  // classifies by shape, never by word position in a localized string.
  const present = stages.map(stage => ({ ...stage, label: stage.pl ? placeLabel(stage.pl) : roundName(stage.col) }));
  const merged = mergeTwinStages(present);
  const out = [];
  for (const stage of present) {
    if (merged.has(stage)) continue; // the pair's originals — the merged entry carries them
    out.push({ label: stage.label, col: stage.col, ...slotSet(stage.n, stage.times, stage.courts), chip: stageChip(stage, ctx, pool, hasPoolFacts, seats) });
  }
  // Deepest-first (QF -> SF -> Final); a merged pair keeps its deeper column.
  out.sort((a, b) => (b.col ?? -1) - (a.col ?? -1));
  return out;
}

// The chip names a stage's entry gates: direct slot ranks, then result edges
// ("via the Semifinals" once merged); a stage with no gates reads "any rank".
function stageChip(stage, ctx, pool, hasPoolFacts, seats) {
  const chips = [];
  if (hasPoolFacts && stage.ranks.size) {
    const direct = [...stage.ranks];
    if (direct.length === seats.length && !stage.edges.length) chips.push(t(LOCALE, 'chip-any', { pool }));
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
      times, courts, n: x.n + y.n,
    });
  }
  return merged;
}



// 3rd/5th/7th place or a classification semi, from a placement range. The
// pre-word form, not the range form: "Platz 3", never "Platz 3."
const placeLabel = pr => pr.win
  ? t(LOCALE, 'pl-place', { n: cardNum(pr.lo) })
  : t(LOCALE, 'pl-semi', { a: ordNum(pr.lo), b: ordNum(pr.hi) });

function placementLabel(m, ctx) {
  const r = plRange(m, ctx);
  return r ? placeLabel(r) : null;
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

// Distinct placement labels of one band (order free — stageGroupName dedupes).
// Bands are structural (placementColumn); the words come from placementLabel.
function bandLabels(ctx, col) {
  const out = new Set();
  for (const m of ctx.matches) if (placementColumn(m, ctx) === col) out.add(placementLabel(m, ctx));
  return [...out];
}

// Round name plus its placement companions; several distinct labels fall back to
// "Final / Placement".
function stageGroupName(round, labels) {
  const uniq = [...new Set(labels.map(bandShort))];
  if (!uniq.length) return round;
  return `${round} / ${uniq.length === 1 ? uniq[0] : t(LOCALE, 'placement')}`;
}

// Midnight is 00, never 24: hourCycle pins the day to 0-23 under any dialect.
function fmtTime(t, tz) {
  try {
    return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
  } catch { return ''; }
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

// Human span from ISO day keys; the locale's ordering comes from Intl.
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

// Round name by distance from the final (0 -> Final, 1 -> Semifinals, ...). Which
// round size takes a dedicated word is a per-locale bundle key, no branch here.
function roundName(depthFromEnd) {
  // a negative/non-integer depth is a cycle-corrupted column — no round to name
  if (!Number.isInteger(depthFromEnd) || depthFromEnd < 0) return 'TBD';
  const key = roundKeyOf(depthFromEnd);
  return t(LOCALE, key, key === 'round-of' ? { n: 2 << depthFromEnd } : undefined);
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

// ---- Status words: what a category or player's line says --------------------
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
    if (i < 0 || !poolDecided(std)) return '';
    const rank = ordNum(poolRanks(std)[i]);
    return t(LOCALE, isDeadTie(std, i + 1) ? 'slot-pool-tie' : 'slot-pool', { rank, pool: row.m.pool });
  };
  const band = () => { const b = playerBand(ctx, rows); return b ? rankRange(b) : ''; };
  const undone = rows.filter(r => !isDone(r.m));
  if (undone.length) {
    const koRows = undone.filter(r => r.m.pool === undefined && plRange(r.m, ctx) === null);
    if (!koRows.length) {
      // only placement matches left to play (e.g. a bronze not yet scored) — not a championship round
      return undone.some(r => r.m.pool === undefined)
        ? withRank(t(LOCALE, 'in-placement'), band())
        : withRank(t(LOCALE, 'in-groups'), pool());
    }
    // The apex reads its own word; every deeper round takes the locale's
    // prepositional article (bundle data, never parsed off the rendered name).
    const col = Math.max(...koRows.map(r => koColumn(r.m, ctx)));
    return col === 0
      ? t(LOCALE, 'in-final')
      : t(LOCALE, 'in-round', { art: (bundle(LOCALE).art || {})[roundKeyOf(col)] || '', round: roundName(col) });
  }
  // The podium is decided by its own matches — gating on the last category match
  // would demote finalists to a group label.
  const w = winners(ctx);
  if (w) {
    if (w.first.includes(pid)) return t(LOCALE, 'champion');
    if (w.second.includes(pid)) return t(LOCALE, 'runner-up');
    if (w.third && w.third.includes(pid)) return t(LOCALE, 'rank3');
    if (w.fourth && w.fourth.includes(pid)) return t(LOCALE, 'rank4');
  }
  // Finished: the finish is the whole story — podium words above, else the band
  // playerBand already derives (never a round name, so it can never name one wrong).
  const b = band();
  if (b) return b;
  const poolsDone = ctx.matches.filter(m => m.pool !== undefined).every(isDone);
  // A dead tie seats nobody: if the tie still owns a knockout seat the entry is
  // pending, not lost. A decided rank below the cutoff owns no seat — a real exit.
  const pending = rows.every(r => r.m.pool !== undefined) && possibleStageFacts(ctx, pid).stages.length > 0;
  const word = poolsDone && !pending ? 'out-groups' : 'in-groups';
  return withRank(t(LOCALE, word), pool());
}

if (typeof module !== 'undefined') {
  module.exports = { setLocale, esc, teamLabel, sideLabel, scoreCells, possibleStages, placementLabel, bandLabels, stageGroupName, fmtTime, dayShort, dayLabel, fmtRange, fmtDiff, roundName, matchLabel, playerStatus };
}

