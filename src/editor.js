'use strict';

// GitBracket match-day editor — vim-flavored keys over the whole tournament
// buffer: every line is one match, j/k move, / narrows, s/v/t/w/o arm the line
// and Enter commits. Live and sim share the same editor — the mode only swaps
// the clock, the repo target, and whether edits commit. Every edit validates,
// writes, and commits itself, so the process can die at any instant with
// nothing lost.
//
// Interaction contract, no exceptions:
//   browse keys never write; a verb key arms a visible target; the bottom
//   input line is the only place Enter commits; Esc cancels anywhere.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { makeCat, isDone, resolveSide, sideLabel, teamLabel, schedTime, fmtTime, matchLabel, bestOfOf, winTarget, reachedWinner, winnerIdx, dayKey, DATE_RE, catStatus, currentWave } = require('../site/derive.js');
const { loadRepo, writeTournament, catCtx, byMatchOrder } = require('./tools.js');
const { validateRepo } = require('./validate.js');
const { ship } = require('./publish.js');

// ---------- pure logic (tests drive these on fixture repos) ----------

function parseGame(s) {
  const mm = /^(\d+)[:-](\d+)$/.exec(s);
  return mm ? { a: +mm[1], b: +mm[2] } : null;
}

// readline waits its 500ms escapeCodeTimeout on a bare ESC to disambiguate
// arrow sequences — raw bytes deliver a lone ESC and \x1b[A instantly (real
// terminals send arrows as one chunk). ponytail: a split arrow sequence
// misfires an Esc keypress; accept it, the 500ms wait is worse.
function parseKeys(s) {
  // s is the chunk already decoded from UTF-8 — a dead-key umlaut (¨+a) is
  // two bytes on the wire but must be one key, since filter/payload matching
  // runs on real characters
  const keys = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 27) { // CSI arrows are one key; a bare ESC is the escape key
      if (s.charCodeAt(i + 1) === 91 && (s.charCodeAt(i + 2) === 65 || s.charCodeAt(i + 2) === 66)) {
        keys.push({ name: s.charCodeAt(i + 2) === 65 ? 'up' : 'down' });
        i += 2;
      } else keys.push({ name: 'escape' });
    } else if (c === 3) keys.push({ name: 'c', ctrl: true });  // ^C
    else if (c === 13 || c === 10) keys.push({ name: 'return' });
    else if (c === 127 || c === 8) keys.push({ name: 'backspace' });
    else if (c >= 32) keys.push({ ch: String.fromCharCode(c) });
  }
  return keys;
}

// Mutate the category's match list in memory; return an error string or null.
// Never touches disk — the caller rolls back on validation failure.
function findMatch(matches, matchId, fn) {
  const m = (matches || []).find(x => x && x.id === Number(matchId));
  if (!m) return `unknown match ${matchId}`;
  return fn(m) ?? null;
}

// Score a match: games are the evidence, and once they reach the best-of
// target the outcome is recorded as played (winner stored, per the model — the
// validator proves the games agree). A prefix update (games below target)
// stays in play; re-scoring replaces any earlier result.
function applyScore(matches, matchId, games, ctx) {
  return findMatch(matches, matchId, m => {
    m.games = games;
    delete m.result; // a correction replaces a result
    // evidence -> outcome, same rule as the validator (reachedWinner)
    const target = winTarget(bestOfOf(m, ctx));
    const w = reachedWinner(games, target);
    if (w !== null) m.result = { status: 'played', winner: w };
    return null;
  });
}

// Games are cleared so games/result exclusivity stays a round-trip property.
function applyResult(matches, matchId, status, winner) {
  return findMatch(matches, matchId, m => {
    delete m.games;
    m.result = winner === undefined ? { status } : { status, winner };
    return null;
  });
}

function applyVenue(matches, matchId, venueId) {
  return findMatch(matches, matchId, m => {
    if (venueId === undefined) delete m.venue; // `v -` unschedules the court — undefined rides the same apply
    else m.venue = venueId; // unknown venue + court double-booking are caught by validateRepo
  });
}

// The generic side op: rewrite one side to any validator-valid slot — players,
// pool rank, or match edge (winner/loser). All validity is the validator's:
// unknown ids, pair-fixing, same-set, consumed-twice, rank range, acyclicity,
// player double-book — writeEdit validates the whole repo and rolls back. A
// dead-tie break is just `e a players …` over a pool slot that renders TBD.
function applySide(matches, matchId, value) {
  return findMatch(matches, matchId, m => {
    if (!Array.isArray(m.sides) || m.sides.length !== 2) return 'match has no two sides';
    m.sides[value.si] = value.side;
    return null;
  });
}

function buildScheduled(hhmm, tz, date, now) {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':');
  if (+h > 23 || +m > 59) return null;
  if (date !== undefined && !DATE_RE.test(date)) return null;
  // an impossible date (2026-02-30) passes this regex — the validator gate rejects it on write, like applyVenue's unknown venues
  // the default date is "today" — the sim's clock when the sim passes one, the real clock live (sim and live share this editor)
  return `${date || dayKey(now ?? Date.now(), tz)}T${h.padStart(2,'0')}:${m}:00`; // wall time — the tournament tz interprets it
}

function applyTime(matches, matchId, isoString) {
  return findMatch(matches, matchId, m => { m.scheduled = isoString; });
}

// Apply an edit to one match, validate the whole repo, write — or roll the file
// back and report the validator's errors. (writeTournament's byte-identical
// formatting keeps the commit diff to the one edited match.) apply receives
// the category context so score can read the best-of target.
function writeEdit(siteRoot, repo, slug, catId, apply) {
  const info = repo.tournaments.get(slug);
  if (!info || !info.tjson) return { err: `unknown tournament ${slug}` };
  const tjson = info.tjson;
  const cats = (tjson.categories || []).map(c => c.id);
  if (!cats.includes(catId)) return { err: `unknown category ${catId} — have: ${cats.join(', ')}` };
  const ms = tjson.matches && typeof tjson.matches === 'object' && !Array.isArray(tjson.matches) ? tjson.matches[catId] : undefined;
  if (!ms) return { err: `no matches for category ${catId}` };
  const meta = tjson.categories.find(c => c.id === catId);
  const ctx = makeCat({ meta, matches: ms }, tjson);
  const file = path.join(siteRoot, 'tournaments', `${slug}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const aerr = apply(ms, ctx);
  if (aerr) return { err: aerr };
  // tjson is the single view of the data, so the validator sees exactly what
  // writeTournament will write — the dates-vs-index and pass-B checks agree.
  const { errs } = validateRepo(repo);
  if (errs.length) {
    ms.splice(0, ms.length, ...((JSON.parse(before).matches || {})[catId] || [])); // undo the in-memory edit too — a same-process retry must start from the original
    fs.writeFileSync(file, before);
    return { errs };
  }
  writeTournament(siteRoot, slug, tjson);
  return { file };
}

// A side's listing name: unresolved slots keep the long form — "Winner of
// 8", "1st in Pool A" — and a resolved slot appends the compact seed in
// parens, so the team reads first with its origin beside it: Ada / Grace (7W).
function listingSide(side, ctx) {
  const ids = resolveSide(side, ctx);
  if (!ids) return sideLabel(side, ctx); // includes the TBD fallback
  const seed = side.kind === 'match' ? `${side.match}${side.result === 'winner' ? 'W' : 'L'}`
    : side.kind === 'pool' ? `${side.pool}${side.rank}` : null;
  const name = teamLabel(ids, ctx);
  return seed === null ? name : `${name} (${seed})`;
}

function formatMatchLine(cid, m, ctx, tz, stage, g) {
  const t = schedTime(m, tz);
  const time = t === null ? C.yellow('TBD'.padStart(8)) : C.dim(fmtTime(t, tz).padStart(8));
  const v = m.venue || 'TBD';
  const venue = (m.venue ? C.magenta : C.yellow)(v.padEnd(g.venuew || v.length));
  // slot shape = best-of, same as the cards: real games render, the rest are ·
  const parts = (m.games || []).map(g => `${g.a}-${g.b}`);
  while (parts.length < (bestOfOf(m, ctx) || 1)) parts.push('·');
  const r = m.result;
  const score = !r || r.status === 'played' ? C.green(parts.join(' '))
    : C.yellow(r.status === 'void' ? 'void' : `W/O side ${r.winner}`);
  const s0 = listingSide(m.sides[0], ctx);
  const s1 = listingSide(m.sides[1], ctx);
  // decided matches color the winner green — the played score column already
  // reads green, so a green winner name and its score are one win signal;
  // void has no winner, nothing colored. Padding is plain-text arithmetic
  // pasted after the colored label — ANSI codes never count into widths.
  const w = winnerIdx(m);
  const sides = (w === 0 ? C.green(s0) : s0) + ' '.repeat(Math.max(0, g.leftw - s0.length))
    + C.dim(' vs ') + (w === 1 ? C.green(s1) : s1) + ' '.repeat(Math.max(0, g.rightw - s1.length));
  const stagePad = ' '.repeat(Math.max(0, g.stagew - stage.length));
  // the ref is "<category> <id>" — the row's identity, echoed back on the arm line
  const ref = `${cid} ${m.id}`;
  return `${C.bold(ref.padEnd(g.idw))}  ${C.dim(stage)}${stagePad}  ${sides}  ${time}  ${venue}  ${score}`;
}

// Column widths for the shared match-line format — one bag, any row source.
const widthBag = () => {
  const g = { idw: 0, stagew: 0, leftw: 0, rightw: 0, venuew: 0 };
  const add = e => {
    g.idw = Math.max(g.idw, `${e.cat} ${e.m.id}`.length);
    g.stagew = Math.max(g.stagew, e.stage.length);
    g.leftw = Math.max(g.leftw, listingSide(e.m.sides[0], e.ctx).length);
    g.rightw = Math.max(g.rightw, listingSide(e.m.sides[1], e.ctx).length);
    g.venuew = Math.max(g.venuew, (e.m.venue || 'TBD').length);
  };
  return { g, add };
};

// ---------- shallow ANSI paint (TTY only — piped output stays plain) ----------

const C = (() => {
  const tty = process.stdout.isTTY; // colors are no-ops when piped — callers need no guard
  const w = (code, s) => tty ? `\x1b[${code}m${s}\x1b[0m` : s;
  return { bold: s => w(1, s), dim: s => w(2, s), red: s => w(31, s), yellow: s => w(33, s), green: s => w(32, s), cyan: s => w(36, s), magenta: s => w(35, s) };
})();

// the cursor row's whole-line invert, re-asserted after every inner reset:
// segment colors and dims fight the uniform row and read illegible, so they
// drop — the bold ref stays — and the invert holds to the line end.
const rowAttr = (code, s) => s.includes('\x1b[')
  ? `\x1b[${code}m${s.replace(/\x1b\[2m|\x1b\[3[0-9]m/g, '').replace(/\x1b\[0m/g, `\x1b[0m\x1b[${code}m`)}\x1b[0m`
  : s;

// ---------- the editor buffer ----------

const rowKey = (cat, m) => `${cat} ${m.id}`;

// The current scoreable wave as entries — the one readiness predicate live
// and sim share, so sim's clock only drives the browser display and sim n/x
// behave exactly like live. Computed fresh every render, per derive.js's
// memoization law — a corrected score surfaces on the next poll.
const waveEntries = tjson => {
  const out = [];
  for (const cid of Object.keys(tjson.matches || {})) {
    const ctx = catCtx(tjson, cid);
    for (const m of currentWave(ctx, catStatus(ctx))) out.push({ cat: cid, m, ctx });
  }
  return out;
};

// The playable set as row keys, for the board's ▶ flag and n/N movement.
function livePlayable(tjson) {
  return new Set(waveEntries(tjson).map(e => rowKey(e.cat, e.m)));
}

// One flat, time-ordered buffer of the whole tournament — the day's running
// order; unscheduled matches go last, still editable.
function buildRows(tjson, playable) {
  const tz = tjson.timezone || 'UTC';
  const rows = [];
  for (const cid of Object.keys(tjson.matches || {})) {
    const ctx = catCtx(tjson, cid);
    for (const m of tjson.matches[cid] || []) {
      if (!m) continue;
      const t = schedTime(m, tz);
      rows.push({ cat: cid, m, ctx, stage: matchLabel(m, ctx), t: t === null ? Infinity : t, playable: playable.has(rowKey(cid, m)) });
    }
  }
  rows.sort(byMatchOrder);
  return rows;
}

// Render every row once — the display lines and the filter corpus in the
// same pass, so a filter can never match text the board doesn't show. The
// corpus is the plain text: ANSI codes are formatting, not content, and a
// search for "m" must not match every line via its reset sequence.
const strip = l => l.replace(/\x1b\[[0-9;]*m/g, '');

function renderLines(rows, tz) {
  const { g, add } = widthBag();
  for (const r of rows) add(r);
  return rows.map(r => formatMatchLine(r.cat, r.m, r.ctx, tz, r.stage, g));
}

// The view: rows + rendered lines + the filtered subset. The filter is a
// case-insensitive substring over the plain rendered line — no field corpus,
// so it covers refs, names, venues, stages, and times with one rule.
function makeView(tjson, playable, query) {
  const rows = buildRows(tjson, playable);
  const lines = renderLines(rows, tjson.timezone || 'UTC');
  const plain = lines.map(strip);
  const q = query ? query.toLowerCase() : null;
  const filtered = q
    ? rows.map((r, i) => ({ r, i })).filter(({ i }) => plain[i].toLowerCase().includes(q))
    : rows.map((r, i) => ({ r, i }));
  return { rows, lines, filtered, query: q, tz: tjson.timezone || 'UTC' };
}

// ---------- editor grammar (pure — the shell executes actions) ----------

// The cursor is an identity (cat + match id), never an index: a time edit
// reorders the buffer, a filter narrows it, but the selected match survives.
function cursorIndex(view, state) {
  if (state.cursorId === null) return view.filtered.length ? 0 : -1;
  const i = view.filtered.findIndex(e => rowKey(e.r.cat, e.r.m) === state.cursorId);
  return i === -1 && view.filtered.length ? 0 : i;
}

// Payload grammar per verb — one grammar for the arm line and the sim.
// Grammar errors are caught here, before any I/O; data errors (unknown venue,
// impossible date) belong to the validator.
function parsePayload(kind, tokens, tz, now) {
  if (kind === 'score') {
    // the display speaks dashes; parseGame accepts both, so colon muscle memory still works
    if (!tokens.length) return { err: 'expected a score, e.g. 21-19' };
    const games = tokens.map(parseGame);
    const bad = tokens.findIndex((t, i) => !games[i]);
    if (bad !== -1) return { err: `bad score ${JSON.stringify(tokens[bad])} — expected a-b` };
    return { value: games };
  }
  if (kind === 'walkover') {
    const side = tokens[0];
    if (side === undefined) return { err: 'expected a or b' };
    if (side !== 'a' && side !== 'b') return { err: 'side must be a or b' };
    return { value: side };
  }
  if (kind === 'void') {
    if (tokens.length) return { err: 'void takes no payload — Enter confirms' };
    return { value: undefined };
  }
  if (kind === 'venue') {
    if (tokens.length === 1 && tokens[0] === '-') return { value: undefined }; // - unschedules the court
    if (!tokens.length) return { err: 'expected a venue, e.g. court-2' };
    return { value: tokens[0] };
  }
  if (kind === 'side') {
    // the generic side op: players <ids> | pool <pool> <rank> | match <id> winner|loser —
    // validity is the validator's (unknown ids, consumed-twice, range, cycles, double-books)
    const si = tokens[0];
    if (si !== 'a' && si !== 'b') return { err: 'expected side a or b' };
    const shape = tokens[1];
    const rest = tokens.slice(2);
    if (shape === 'players') {
      if (!rest.length) return { err: 'expected player ids after players' };
      return { value: { si: si === 'b' ? 1 : 0, side: { kind: 'players', ids: rest } } };
    }
    if (shape === 'pool') {
      if (rest[0] === undefined || rest[1] === undefined) return { err: 'expected pool and rank, e.g. pool A 2' };
      if (!/^\d+$/.test(rest[1]) || +rest[1] < 1) return { err: `bad rank ${JSON.stringify(rest[1])} — expected a positive integer` };
      return { value: { si: si === 'b' ? 1 : 0, side: { kind: 'pool', pool: rest[0], rank: +rest[1] } } };
    }
    if (shape === 'match') {
      if (rest[0] === undefined || rest[1] === undefined) return { err: 'expected match id and result, e.g. match 7 winner' };
      if (!/^\d+$/.test(rest[0])) return { err: `bad match id ${JSON.stringify(rest[0])} — expected a number` };
      if (rest[1] !== 'winner' && rest[1] !== 'loser') return { err: `result must be winner or loser, got ${JSON.stringify(rest[1])}` };
      return { value: { si: si === 'b' ? 1 : 0, side: { kind: 'match', match: +rest[0], result: rest[1] } } };
    }
    return { err: `expected players, pool, or match — got ${JSON.stringify(shape)}` };
  }
  // time: [YYYY-MM-DD] hh:mm, or - to unschedule
  if (tokens.length === 1 && tokens[0] === '-') return { value: undefined };
  const a = tokens[0], b = tokens[1];
  const date = b !== undefined && DATE_RE.test(a) ? a : undefined;
  const hhmm = date !== undefined ? b : a;
  if (!hhmm) return { err: 'expected hh:mm (optionally preceded by a date), or - to unschedule' };
  const iso = buildScheduled(hhmm, tz, date, now);
  if (iso === null) return { err: `bad time ${JSON.stringify(hhmm)} — expected hh:mm` };
  return { value: iso };
}

// The five verbs each map to one apply function.
function applyFor(verb, matchId, value) {
  return verb === 'score' ? (ms, ctx) => applyScore(ms, matchId, value, ctx)
    : verb === 'walkover' ? c => applyResult(c, matchId, 'walkover', value)
    : verb === 'void' ? c => applyResult(c, matchId, 'void')
    : verb === 'side' ? c => applySide(c, matchId, value)
    : verb === 'venue' ? c => applyVenue(c, matchId, value)
    : c => applyTime(c, matchId, value); // time — undefined unschedules
}

const VERB_KEYS = { s: 'score', v: 'venue', t: 'time', w: 'walkover', o: 'void', e: 'side' };

// Conventional-commit messages per edit kind — grep-able match-day history:
//   git log --grep='^score('
function commitMessage(kind, slug, cat, matchId, detail) {
  return `${kind}(${slug}): ${cat}/${matchId} ${detail}`;
}

// One-line summary of what changed — mirror it in the commit message and the
// echo. Keyed off the edit kind, never the match state, so a venue or time
// edit on an already-decided match reports the move, not the result. side
// carries value+ctx: the applied side's label, e.g. "side a → Winner of 8".
function editDetail(kind, m, value, ctx) {
  const r = m.result;
  return kind === 'score' ? (m.games || []).map(gg => `${gg.a}-${gg.b}`).join(' · ') // dashes — the echo mirrors the board's score column
    : kind === 'time' ? (m.scheduled === undefined ? '→ TBD' : `→ ${m.scheduled}`)
    : kind === 'venue' ? `→ ${m.venue === undefined ? 'TBD' : m.venue}`
    : kind === 'side' ? `side ${value.si === 0 ? 'a' : 'b'} → ${sideLabel(value.side, ctx)}`
    : r.status === 'void' ? 'void' : `side ${r.winner} wins by walkover`;
}

// The post-edit confirmation: sides first (so you see you touched the right
// match), then the detail, then the short sha as a dimmed receipt. The git
// commit message stays machine-facing and unchanged — only the echo is for eyes.
function echoLine(kind, m, ctx, sha, value) {
  const d = editDetail(kind, m, value, ctx);
  const sum = `${listingSide(m.sides[0], ctx)} vs ${listingSide(m.sides[1], ctx)} → ${d}${kind === 'score' && isDone(m) ? ' — done' : ''}`;
  return `${sum}  ${C.dim(`[${sha}]`)}`;
}

// The : grammar keeps only what the single keys can't: publish, use, status.
// step() always prefixes '/', so parseCmd never sees a bare word.
const CMDS = ['publish', 'use', 'status'];
function parseCmd(line) {
  const [raw, ...args] = line.trim().split(/\s+/);
  const head = raw.startsWith('/') ? raw.slice(1) : raw;
  return { kind: CMDS.includes(head) ? head : 'unknown', args };
}

// ---------- the editor state machine ----------

function helpText(sim) {
  const k = s => s.padEnd(12);
  const lines = [
    C.bold('GitBracket — the match-day editor. Every line is one match.'), '',
    C.bold('move'),
    `  ${k('j / ↓')} down`,
    `  ${k('k / ↑')} up`,
    `  ${k('n / N')} next / previous playable (▶)`,
    `  ${k('g / G')} top / bottom`, '',
    C.bold('find'),
    `  ${k('/')} narrow to matching lines — Enter keeps, Esc clears it`, '',
    `${C.bold('act')} — the line under the cursor is the target`,
    `  ${k('s')} score → 21-19 [11-9 …]`,
    `  ${k('t')} time → 10:30 [date 10:30], or - to unschedule`,
    `  ${k('v')} venue → court-2, or - to clear`,
    `  ${k('w')} walkover → a or b`,
    `  ${k('o')} void → Enter confirms`,
    `  ${k('e')} side → a|b players <ids> · pool <pool> <rank> · match <id> winner|loser`, '',
    C.bold('commit'),
    `  ${k('Enter')} commits the armed edit — the only key that ever writes`,
    `  ${k('Esc')} cancels anywhere`, '',
    C.bold('commands'),
    ...(sim ? [] : [`  ${k(':publish')} ship site/ to the domain`]),
    `  ${k(':status')} validator + git status`,
    `  ${k(':use <slug>')} switch tournament`,
  ];
  if (sim) lines.push('', C.bold('sim'),
    `  ${k(']')} +30 min`,
    `  ${k('[')} −30 min`,
    `  ${k('x')} score the highlighted matches`);
  lines.push('', C.dim('q quits — every edit validates, writes, and commits itself'));
  return lines.join('\n');
}

const PROMPT_HINT = {
  browse: '? help · q quit',
  // expected entries first — the what — enter/esc trail as the how
  arm: { score: '21-19 11-9 … (or one game per commit) · enter commits · esc cancels', venue: 'a venue id, e.g. court-2, or - to clear · enter commits · esc cancels', time: 'hh:mm · [date] hh:mm · - unschedules · enter commits · esc cancels', walkover: 'a or b · enter commits · esc cancels', void: 'enter confirms the void · esc cancels', side: 'a or b, then: players <ids> · pool <pool> <rank> · match <id> winner|loser · enter commits · esc cancels' },
  filter: 'type to narrow · enter keeps · esc clears',
  cmd: 'enter runs · esc cancels',
  report: 'esc back',
};

// One keypress in. Pure: returns the next state and, when the key completes
// an edit or a command, the action the shell must execute. The view is fresh
// (rebuilt before each keypress), so the playable set reflects every edit.
function step(state, key, view, now) {
  const ch = key.ch;
  const name = key.name;
  const ns = { ...state, msg: null };
  if (key.ctrl && name === 'c') return { state: { ...ns, quit: true }, action: null };

  const cur = cursorIndex(view, ns);
  const rowAt = i => view.filtered[i] ? view.rows[view.filtered[i].i] : null;

  if (ns.mode === 'report') {
    if (ch === 'q' || name === 'escape') return { state: { ...ns, mode: 'browse', report: null }, action: null };
    return { state: ns, action: null };
  }

  if (ns.mode === 'filter') {
    if (name === 'escape') return { state: { ...ns, mode: 'browse', query: null }, action: null };
    if (name === 'backspace') return { state: { ...ns, query: ns.query ? ns.query.slice(0, -1) : '' }, action: null };
    if (name === 'return') return { state: { ...ns, mode: 'browse' }, action: null };
    if (ch && ch.length === 1) return { state: { ...ns, query: (ns.query || '') + ch }, action: null };
    return { state: ns, action: null };
  }

  if (ns.mode === 'cmd') {
    if (name === 'escape') return { state: { ...ns, mode: 'browse', cmdline: '' }, action: null };
    if (name === 'backspace') return { state: { ...ns, cmdline: ns.cmdline.slice(0, -1) }, action: null };
    if (name === 'return') {
      const cmd = parseCmd('/' + ns.cmdline);
      const args = cmd.args;
      if (cmd.kind === 'unknown') return { state: { ...ns, mode: 'browse', cmdline: '', msg: { text: `unknown command ${ns.cmdline.split(/\s+/)[0]} — ? for help`, color: 'red' } }, action: null };
      if (cmd.kind === 'publish') return { state: { ...ns, mode: 'browse', cmdline: '' }, action: { kind: 'publish' } };
      if (cmd.kind === 'use') return { state: { ...ns, mode: 'browse', cmdline: '', cursorId: null }, action: { kind: 'use', slug: args[0] } };
      if (cmd.kind === 'status') return { state: { ...ns, mode: 'browse', cmdline: '' }, action: { kind: 'status' } };
    }
    if (ch && ch.length === 1) return { state: { ...ns, cmdline: (ns.cmdline + ch).slice(0, 60) }, action: null };
    return { state: ns, action: null };
  }

  if (ns.mode === 'arm') {
    if (name === 'escape') return { state: { ...ns, mode: 'browse', verb: null, payload: '' }, action: null };
    if (name === 'backspace') return { state: { ...ns, payload: ns.payload.slice(0, -1) }, action: null };
    if (name === 'return') {
      if (cur === -1) return { state: { ...ns, msg: { text: 'no match under the cursor', color: 'red' } }, action: null };
      const row = rowAt(cur);
      const p = parsePayload(ns.verb, ns.payload.trim().split(/\s+/).filter(Boolean), view.tz, now);
      if (p.err) return { state: { ...ns, msg: { text: p.err, color: 'yellow' } }, action: null };
      return { state: { ...ns, mode: 'browse', verb: null, payload: '' }, action: { kind: 'edit', verb: ns.verb, cat: row.cat, matchId: String(row.m.id), value: p.value } };
    }
    if (ch && ch.length === 1) return { state: { ...ns, payload: (ns.payload + ch).slice(0, 40) }, action: null };
    return { state: ns, action: null };
  }

  // browse — Esc clears the filter (the universal cancel key)
  if (name === 'escape') return { state: { ...ns, query: null }, action: null };
  if (name === 'return') return { state: ns, action: null };
  if (name === 'down' || ch === 'j') return { state: { ...ns, cursorId: nextRow(view, ns, +1, () => true) }, action: null };
  if (name === 'up' || ch === 'k') return { state: { ...ns, cursorId: nextRow(view, ns, -1, () => true) }, action: null };
  if (ch === 'g') return { state: { ...ns, cursorId: view.filtered.length ? rowKey(view.rows[view.filtered[0].i].cat, view.rows[view.filtered[0].i].m) : null }, action: null };
  if (ch === 'G') return { state: { ...ns, cursorId: view.filtered.length ? rowKey(view.rows[view.filtered[view.filtered.length - 1].i].cat, view.rows[view.filtered[view.filtered.length - 1].i].m) : null }, action: null };
  if (ch === 'n') return { state: { ...ns, cursorId: nextRow(view, ns, +1, r => r.playable) }, action: null };
  if (ch === 'N') return { state: { ...ns, cursorId: nextRow(view, ns, -1, r => r.playable) }, action: null };
  if (ch === '/') return { state: { ...ns, mode: 'filter', query: '' }, action: null };
  if (ch === ':') return { state: { ...ns, mode: 'cmd', cmdline: '' }, action: null };
  if (ch === '?') return { state: { ...ns, mode: 'report', report: helpText(ns.sim), msg: null }, action: null };
  if (ch === 'q') return { state: { ...ns, quit: true }, action: null };
  if (VERB_KEYS[ch]) {
    if (cur === -1) return { state: { ...ns, msg: { text: 'no match under the cursor', color: 'red' } }, action: null };
    return { state: { ...ns, mode: 'arm', verb: VERB_KEYS[ch], payload: '' }, action: null };
  }
  return { state: ns, action: null };
}

// Movement in one loop: j/k walk every row, n/N stop only on a playable one —
// the same scan, the stop predicate is the only difference.
function nextRow(view, state, dir, stop) {
  const n = view.filtered.length;
  for (let k = cursorIndex(view, state) + dir; dir > 0 ? k < n : k >= 0; k += dir) {
    const r = view.rows[view.filtered[k].i];
    if (stop(r)) return rowKey(r.cat, r.m);
  }
  return state.cursorId;
}

// ---------- the board (rendering) ----------

// The whole screen as text — pure, so a test can pin layout. The match list
// is windowed to fit `rows` (the terminal pane height) so the header is never
// cut; the chrome (header, blanks, msg, input, hint) is counted here where it
// lives, and the input row is always reserved — drawn blank when idle — so
// arming a verb, filter, or command never shifts the match window; msg stays
// dynamic (multi-line error text is worth the reflow). No trailing newline
// would scroll a full pane. The window is sized in *physical* rows (what the
// terminal really renders after auto-wrap), so a narrow pane that wraps the
// wide match lines still keeps the header on screen.
function boardText(state, view, info, rows, cols) {
  const input = inputLine(state, view);
  // an active filter is a view state, so it lives on the status line — the
  // filter input slot already echoes it while typing, so skip that mode
  const filterNote = state.mode !== 'filter' && state.query
    ? ` · ${C.dim('/' + state.query + ' — ' + view.filtered.length + (view.filtered.length === 1 ? ' match' : ' matches'))}`
    : '';
  const header = `${C.bold(C.cyan(info.title))} · ${info.mode} ${C.cyan(info.clock)} · ${info.played}/${info.total} played${info.note || ''}${filterNote}`;
  const msg = state.msg ? C[state.msg.color](state.msg.text) : '';
  // an armed action owns the bottom of the screen — the hint brightens and the
  // input line goes bold
  const hint = state.mode === 'arm' ? hintLine(state) : C.dim(hintLine(state));
  // physical rows a rendered line occupies after auto-wrap — ANSI is stripped
  // (formatting, not width) and this board's glyphs are single-width, so plain
  // length / cols; over-reporting wide glyphs only shrinks the window, never
  // overflows it.
  const phys = s => Math.max(1, Math.ceil(strip(s).length / (cols || 80)));

  const lines = [header];
  if (state.mode === 'report') {
    lines.push('', ...(state.report || '').split('\n'));
  } else {
    lines.push('');
    const cur = cursorIndex(view, state);
    const n = view.filtered.length;
    // physical rows each match line occupies, slot included
    const mw = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const r = view.rows[view.filtered[i].i];
      mw[i] = phys((r.playable ? '▶' : ' ') + ' ' + view.lines[view.filtered[i].i]);
      total += mw[i];
    }
    // chrome physical rows: header + two blanks + msg + input + hint — the
    // input row is always reserved (drawn blank when idle), so arming a verb
    // pushes no match off the window; msg stays dynamic, multi-line error
    // text is worth the reflow
    const chrome = phys(header) + 2 + (msg ? phys(msg) : 0) + 1 + phys(hint);
    const budget = rows ? rows - chrome : 0; // physical rows the list may occupy
    let start = 0, end = n;
    if (rows && total > budget) {
      // largest window around the cursor that fits the physical budget, extend
      // down then up; if even the cursor match alone doesn't fit (a pane too
      // small for one wrapped line + chrome), show chrome only rather than cut
      // the header
      let used = mw[cur], win = mw[cur] <= budget;
      if (win) {
        start = cur; end = cur + 1;
        while (end < n && used + mw[end] <= budget) { used += mw[end]; end++; }
        while (start > 0 && used + mw[start - 1] <= budget) { start--; used += mw[start]; }
      } else start = end = 0;
    }
    for (let i = start; i < end; i++) {
      const e = view.filtered[i];
      const r = view.rows[e.i];
      const here = i === cur;
      // the one-char slot: the playable flag — the cursor line inverts
      // whole, colors and dims dropped under the attribute so the row reads
      // uniform and legible, the bold ref stays; played lines render as-is
      let line = (r.playable ? '▶' : ' ') + ' ' + view.lines[e.i];
      if (here) line = rowAttr(7, line);
      lines.push(line);
    }
  }
  lines.push('');
  if (msg) lines.push(msg);
  // the input row is always drawn — idle it reads as the reserved blank, so a
  // filled-in field appears in place and the hint never moves
  lines.push(input ? (state.mode === 'arm' ? `\x1b[1m${input}\x1b[0m` : input) : ''); // bold marks the fill-in field — the ref is bold too, so it reads as one system, not two
  lines.push(hint);
  return lines.join('\n');
}

function inputLine(state, view) {
  // the block caret marks the input position — end of the typed text, before
  // any trailing note; the board hides the real terminal cursor, so the caret
  // is drawn, not moved
  if (state.mode === 'arm') {
    const cur = cursorIndex(view, state);
    const row = cur !== -1 ? view.rows[view.filtered[cur].i] : null;
    const target = row ? `${state.verb} ${rowKey(row.cat, row.m)} — ${listingSide(row.m.sides[0], row.ctx)} vs ${listingSide(row.m.sides[1], row.ctx)}` : `${state.verb} (no match)`;
    return `${target} → ${state.payload}▌`;
  }
  if (state.mode === 'filter') {
    const count = view.filtered.length;
    return count === 0 ? `/ ${state.query || ''}▌ — no match` : `/ ${state.query || ''}▌ — ${count} match${count === 1 ? '' : 'es'}`;
  }
  if (state.mode === 'cmd') return `: ${state.cmdline}▌`;
  return '';
}

function hintLine(state) {
  // sim keys live only in the help screen — the status line stays sparse
  const base = PROMPT_HINT[state.mode];
  if (typeof base === 'string') return base;
  return base[state.verb];
}

// ---------- git + repo I/O (thin shell, not unit-tested) ----------

function git(root, args) {
  // spawnSync, not execSync: execSync has no argv array — args must be baked
  // into the command string, which breaks ids with spaces and quotes.
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { code: r.status === 0 ? 0 : 1, out: r.stdout || '', err: r.stderr || '' };
}

function validateText(repo) {
  const { errs, warns } = validateRepo(repo);
  const lines = [...warns.map(w => C.yellow(`warn: ${w}`)), ...errs.map(e => C.red(`error: ${e}`))];
  if (!lines.length) return C.green('validate: ok');
  return lines.join('\n') + (errs.length ? C.red(`\n${errs.length} error(s)`) : C.yellow(` (${warns.length} warning(s))`));
}

function gitStatus(root) {
  const lines = [];
  const s = git(root, ['status', '-sb']);
  if (s.code === 0 && s.out.trim()) lines.push(s.out.trim());
  // Unpushed commits, one per line; a missing origin/main (clone, offline)
  // silences the section the same way the prompt indicators used to.
  const unpushed = git(root, ['log', '--oneline', 'origin/main..HEAD']);
  if (unpushed.code === 0) for (const l of unpushed.out.trim().split('\n')) if (l) lines.push(`  ${l}`);
  return lines.join('\n') || '(clean)';
}

// Compare the one file this session edits — tournaments/<slug>.json — with
// what the live domain serves, so :status answers "is what I have what's
// live?" without assuming how it got there. The file is a few KB, so a GET +
// text compare is the whole check. Offline is "unknown", never "stale".
async function liveText(siteRoot, slug) {
  if (slug === null) return '';
  let domain;
  try { domain = fs.readFileSync(path.join(siteRoot, 'CNAME'), 'utf8').trim(); }
  catch { return 'live: no site/CNAME — unknown'; }
  const rel = `tournaments/${slug}.json`;
  let body;
  try {
    const res = await fetch(`https://${domain}/${rel}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return `live: HTTP ${res.status} for /${rel}`;
    body = await res.text();
  } catch {
    return `live: can't reach ${domain} (offline — unknown)`;
  }
  if (body === fs.readFileSync(path.join(siteRoot, rel), 'utf8')) return `live: ${slug} is current`;
  return `live: ${rel} differs — publish to converge`;
}

// ---------- action execution (the shell; edits commit per AGENTS.md) ----------

// The edit funnel's only exit: validate, write, and (live) commit — the echo
// or the rolled-back error becomes the board's message line.
function execEdit(state, verb, cat, matchId, value) {
  const { root, siteRoot, repo, slug } = state;
  const res = writeEdit(siteRoot, repo, slug, cat, applyFor(verb, matchId, value));
  if (res.err) return { text: res.err, color: 'red' };
  if (res.errs) return { text: res.errs.join('\n') + '\nnot written — validation error(s), file rolled back', color: 'red' };
  const info = repo.tournaments.get(slug);
  const ctx = catCtx(info.tjson, cat);
  const m = ctx.byId.get(Number(matchId));
  if (state.commit) {
    const file = res.file; // writeEdit's own byte-identical write target
    const detail = editDetail(verb, m, value, ctx);
    const msg = commitMessage(verb, slug, cat, matchId, detail);
    git(root, ['add', path.relative(root, file)]);
    const c = git(root, ['commit', '-m', msg]);
    if (c.code !== 0) return { text: `${path.relative(root, file)} written but the commit failed:\n${c.err}\n(file staged — commit it manually)`, color: 'red' };
    const sha = git(root, ['rev-parse', '--short', 'HEAD']).out.trim();
    return { text: echoLine(verb, m, ctx, sha, value), color: 'green' };
  }
  return { text: echoLine(verb, m, ctx, 'sim', value), color: 'green' }; // sim: written to the scratch copy, never committed
}

// Non-rendering command execution — exported so tests can drive :use and
// edits the same way the loop does. Render-facing state (mode, report) is
// returned, and the loop applies it after (a keypress must never leave the
// report state inconsistent with an in-flight async live check).
function execAction(state, action) {
  if (action.kind === 'edit') return { msg: execEdit(state, action.verb, action.cat, action.matchId, action.value) };
  if (action.kind === 'use') {
    if (!action.slug) return { msg: { text: `tournaments: ${[...state.repo.tournaments.keys()].join(', ')}`, color: 'yellow' } };
    const info = state.repo.tournaments.get(action.slug);
    if (!info) return { msg: { text: `unknown tournament ${action.slug} — have: ${[...state.repo.tournaments.keys()].join(', ')}`, color: 'red' } };
    if (!info.tjson) return { msg: { text: `tournament ${action.slug} has no readable data`, color: 'red' } };
    return { slug: action.slug };
  }
  if (action.kind === 'publish') {
    if (!state.commit) return { msg: { text: 'sim: no publish — the scratch never ships, only site/ does (and only on main)', color: 'yellow' } };
    const { errs } = validateRepo(loadRepo(state.siteRoot)); // gate on disk, not memory — publish ships disk
    return errs.length
      ? { msg: { text: errs.join('\n') + '\nnot published — validation error(s)', color: 'red' } }
      : ship(state.root) === 0 ? { msg: { text: 'published', color: 'green' } } : { msg: { text: 'not published — see the output above', color: 'red' } };
  }
  if (action.kind === 'status') return { report: validateText(state.repo) + '\n' + gitStatus(state.root) };
  return {};
}

// a null file would crash every command, so skip it.
function defaultSlug(repo) {
  if (!repo.index.length) return null;
  const last = repo.index[repo.index.length - 1];
  const info = last && repo.tournaments.get(last.slug);
  return info && info.tjson ? last.slug : null;
}

// ---------- the editor loop (shared by live and sim) ----------

// opts: { sim, slug, clock, simKey, onQuit } — sim swaps the clock and the
// commit policy, and adds ]/[x; the playable set is the same wave either way.
function editorMain(root, siteRoot, repo, opts) {
  const state = {
    root, siteRoot, repo,
    slug: opts.slug || defaultSlug(repo),
    mode: 'browse', cursorId: null, verb: null, payload: '', query: null, cmdline: '',
    report: null, msg: null, quit: false,
    commit: !opts.sim, sim: !!opts.sim,
  };
  const clock = opts.clock;
  const playable = opts.playable || livePlayable;

  const tjson = () => {
    const info = state.slug && state.repo.tournaments.get(state.slug);
    return info && info.tjson ? info.tjson : null;
  };
  const tz = () => (tjson() ? tjson().timezone || 'UTC' : 'UTC');

  const getView = () => {
    const t = tjson();
    if (!t) return null;
    return makeView(t, playable(t), state.query);
  };

  const render = () => {
    const view = getView();
    const t = tjson();
    if (!t) {
      process.stdout.write('\x1b[?25l\x1b[2J\x1b[H' + (state.msg ? C.yellow(state.msg.text) : 'no tournament selected') + '\n\n' + C.dim(':use <slug> — ' + [...state.repo.tournaments.keys()].join(', ')) + '\n\n' + C.dim('q quit') + '\n');
      return;
    }
    const played = Object.values(t.matches || {}).flat().filter(m => m && isDone(m)).length;
    const total = Object.values(t.matches || {}).flat().filter(Boolean).length;
    const header = {
      title: t.name,
      mode: state.sim ? C.yellow('SIM') : C.green('LIVE'),
      clock: fmtTime(clock(), tz()),
      played, total,
      note: state.sim ? ' · scratch — never committed' : '',
      sim: state.sim,
    };
    process.stdout.write('\x1b[?25l\x1b[2J\x1b[H' + boardText(state, view, header, process.stdout.rows || 40, process.stdout.columns || 80));
  };

  const exec = action => {
    if (!action) return;
    const r = execAction(state, action);
    if (r.msg) state.msg = r.msg;
    if (r.slug) state.slug = r.slug;
    if (r.report) {
      state.mode = 'report';
      state.report = r.report;
      // the live-vs-domain comparison is a network read — refresh the report
      // when it lands, if the operator is still looking at it
      liveText(state.siteRoot, state.slug).then(live => {
        if (state.mode === 'report' && live) { state.report += '\n' + live; render(); }
      });
    }
  };

  const quit = () => {
    process.stdout.write('\x1b[?25h\n'); // restore the cursor for the shell on a fresh line — the board ends without one
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    state.quit = true;
    if (opts.onQuit) opts.onQuit();
    // the keypress listener has no natural end — and the sim's server may
    // hold the browser's idle keep-alive connections, so close() alone can
    // hang — quit is the hard kind, exit now
    process.exit(0);
  };

  if (!process.stdin.isTTY) {
    console.error('editor: needs a terminal for keypresses');
    process.exit(1);
  }
  process.stdin.setRawMode(true);
  process.stdout.on('resize', render);
  // one stateful decoder — a multibyte char split across chunk writes must
  // still come out as a single key
  const decoder = new StringDecoder('utf8');
  process.stdin.on('data', chunk => {
    for (const k of parseKeys(decoder.write(chunk))) {
      if (opts.simKey && k.ch) {
        const r = opts.simKey(k.ch);
        if (r) { if (typeof r === 'string') state.msg = { text: r, color: 'red' }; render(); return; }
      }
      const view = getView();
      const { state: ns, action } = step(state, k, view || { rows: [], lines: [], filtered: [], query: null, tz: tz() }, clock());
      Object.assign(state, ns);
      if (state.quit) { quit(); return; }
      exec(action);
      render();
    }
  });
  render();
}

// CLI entry (dispatched from gb.js): root is the repo root.
function main(root) {
  const siteRoot = path.join(root, 'site');
  const repo = loadRepo(siteRoot);
  if (repo.readErrs.length) { console.error(repo.readErrs.join('\n')); process.exit(1); }
  editorMain(root, siteRoot, repo, { sim: false, clock: () => Date.now() });
}

module.exports = { parseGame, parseKeys, buildScheduled, applyScore, applyResult, applyVenue, applySide, applyTime, writeEdit, commitMessage, editDetail, echoLine, parseCmd, formatMatchLine, listingSide, widthBag, rowKey, waveEntries, livePlayable, buildRows, renderLines, makeView, cursorIndex, parsePayload, applyFor, step, boardText, helpText, execEdit, execAction, defaultSlug, editorMain, main, C, rowAttr };