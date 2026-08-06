#!/usr/bin/env node
'use strict';

// GitBracket tests — zero deps, no framework, no generated data.
// Every scenario is a committed fixture under fixtures/: each dir is a
// self-contained mini repo (tournaments.json + tournaments/<slug>/...), loaded
// with the real loadRepo() exactly like a checkout. tests.js only loads and
// asserts. Run: `node tests.js` (pre-commit hook and CI run this).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadRepo, validateRepo } = require('./validate.js');
const { makeCat, winnerIdx, isDone, poolStandings, resolveSide, sameRecord, matchRound, playerMatches, matchSlotMs, slotLabel, roundName, placementLabel, koColumn, scheduleStatus, venueBacklog, kioskBuckets, matchLabel, renderIndex, renderStandings, renderVenue, renderPlayer } = require('./app.js');
const cli = require('./cli.js');

const FIX = (...parts) => path.join(__dirname, 'fixtures', ...parts);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const hasErr = (r, re) => r.errs.some(e => re.test(e));
const hasWarn = (r, re) => r.warns.some(e => re.test(e));

// validator case: run the real validator over a fixture repo root
const validateFixture = name => validateRepo(loadRepo(FIX(name)));

// derive case: build a category context straight from a fixture's JSON
function catOf(name, catId) {
  const base = FIX(name, 'tournaments', name);
  const tjson = require(path.join(base, 'tournament.json'));
  const cjson = require(path.join(base, 'matches', `${catId}.json`));
  return makeCat({ meta: tjson.categories.find(c => c.id === catId), matches: cjson.matches }, tjson);
}

// ---------- derive (app.js) ----------

test('pool A standings: 4 sides, order, leader record', () => {
  const md = catOf('sample', 'md40');
  const st = poolStandings(md, 'A');
  assert(st && st.length === 4, 'pool A has 4 sides');
  assert(st[0].sig === 'p1|p2' && st[1].sig === 'p3|p4' && st[3].sig === 'p7|p8', 'pool A order by wins/gd/pd');
  assert(st[0].wins === 3 && st[0].gd === 6 && st[0].pd === 31, 'leader record');
});

test('standings tiebreak: wins, then game differential, then point differential', () => {
  const ctx = catOf('tiebreak', 't');
  const st = poolStandings(ctx, 'A');
  assert(st && st.length === 4, 'pool A has 4 sides');
  assert(st[0].sig === 'p1' && st[1].sig === 'p2', 'p1 (gd +2) ranks above p2 (gd +1) despite the lower point differential');
  assert(st[0].wins === 2 && st[0].gd === 2 && st[0].pd === 3, 'p1 record');
  assert(st[1].wins === 2 && st[1].gd === 1 && st[1].pd === 5, 'p2 record');
});

test('xd pool order', () => {
  const st = poolStandings(catOf('sample', 'xd'), 'A');
  assert(st && st[0].sig === 'p1|p3' && st[0].wins === 3, 'xd pool order');
});

test('forfeit and partial-match detection', () => {
  const md = catOf('sample', 'md40');
  assert(winnerIdx(md.byId.get('m7'), md) === 0, 'forfeit 1 -> side 0 wins');
  assert(winnerIdx(md.byId.get('m8'), md) === null, 'partial match is not done');
  assert(isDone(md.byId.get('m7'), md) && isDone(md.byId.get('m1'), md), 'done detection');
});

test('slot resolution: forfeit winner vs in-play TBD', () => {
  const md = catOf('sample', 'md40');
  const m9 = md.byId.get('m9');
  const w7 = resolveSide(m9.sides[0], md);
  assert(w7 && w7.has('p1') && w7.has('p2'), 'winner of forfeit m7 resolves to p1/p2');
  assert(resolveSide(m9.sides[1], md) === null, 'winner of in-play m8 -> TBD');
});

test('slot resolution: loser path (bronze/placement)', () => {
  const md = catOf('sample', 'md40');
  const m10 = md.byId.get('m10');
  const l7 = resolveSide(m10.sides[0], md);
  assert(l7 && l7.has('p7') && l7.has('p8'), 'loser of forfeit m7 resolves to p7/p8');
  assert(resolveSide(m10.sides[1], md) === null, 'loser of in-play m8 -> TBD');
});

test('matchSlotMs: match override > per-stage category config > default', () => {
  assert(matchSlotMs({}, { slotMinutes: { groups: 60 } }) === 45 * 60000, 'groups config does not leak into knockout');
  assert(matchSlotMs({ pool: 'A' }, { slotMinutes: { groups: 60 } }) === 60 * 60000, 'pool match takes the groups slot');
  assert(matchSlotMs({}, { slotMinutes: { knockout: 60 } }) === 60 * 60000, 'knockout match takes the knockout slot');
  assert(matchSlotMs({ slotMinutes: 90 }, { slotMinutes: { knockout: 60 } }) === 90 * 60000, 'match override wins');
  assert(matchSlotMs({}, {}) === 45 * 60000, 'default is 45 minutes');
});

test('scheduleStatus: gated on start; a slot fully elapsed without a result is overdue', () => {
  const ctx = makeCat({ meta: { bestOf: { knockout: 3 } }, matches: [
    { id: 'm1', scheduled: '2025-07-14T09:00:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm2', scheduled: '2025-07-14T10:00:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }], games: [{ a: 11, b: 5 }, { a: 11, b: 4 }] },
  ] }, { timezone: 'UTC', players: [] });
  const at = ms => scheduleStatus([ctx], ms);
  assert(at(Date.parse('2025-07-14T08:00:00Z')) === null, 'before the first scheduled match: no status');
  assert(at(Date.parse('2025-07-14T09:20:00Z')).overdue.length === 0, 'unfinished but inside its slot: on schedule');
  assert(at(Date.parse('2025-07-14T09:46:00Z')).overdue.length === 1 && at(Date.parse('2025-07-14T09:46:00Z')).overdue[0].m.id === 'm1', 'slot elapsed without a result: behind');
  assert(at(Date.parse('2025-07-14T10:46:00Z')).overdue.length === 1 && at(Date.parse('2025-07-14T10:46:00Z')).overdue[0].m.id === 'm1', 'finished m2 is not overdue; only m1 still is');
});

test('venueBacklog: per-venue delay from the most overdue unfinished match', () => {
  const ctx = makeCat({ meta: { bestOf: { knockout: 3 } }, matches: [
    { id: 'm1', scheduled: '2025-07-14T09:00:00Z', venue: 'c1', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm2', scheduled: '2025-07-14T09:10:00Z', venue: 'c1', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }], games: [{ a: 11, b: 5 }, { a: 11, b: 4 }] },
    { id: 'm3', scheduled: '2025-07-14T09:30:00Z', venue: 'c2', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
  ] }, { timezone: 'UTC', players: [] });
  const now = Date.parse('2025-07-14T09:50:00Z');
  assert(venueBacklog([ctx], Date.parse('2025-07-14T08:00:00Z')).size === 0, 'before start: no backlog');
  const bg = venueBacklog([ctx], now);
  assert(bg.get('c1') === 5 * 60000, 'c1: 09:00 slot ended 09:45, 5 min overdue (done m2 never counts)');
  assert((bg.get('c2') || 0) === 0, 'c2: 09:30 match still inside its slot, no delay');
});

test('kioskBuckets: status picks the board, the clock never hides an overdue match', () => {
  const ctx = makeCat({ meta: { bestOf: { knockout: 3 } }, matches: [
    { id: 'm1', scheduled: '2025-07-14T09:00:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }], games: [{ a: 11, b: 5 }, { a: 11, b: 4 }] },
    { id: 'm2', scheduled: '2025-07-14T08:30:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm3', scheduled: '2025-07-14T09:45:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm4', scheduled: '2025-07-14T10:30:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm5', scheduled: '2025-07-14T11:15:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
    { id: 'm6', scheduled: '2025-07-14T10:00:00Z', sides: [{ kind: 'players', ids: ['a'] }, { kind: 'players', ids: ['b'] }] },
  ] }, { timezone: 'UTC', players: [] });
  const now = Date.parse('2025-07-14T10:00:00Z'); // m2's slot ended 09:15 — long overdue
  const rows = ctx.matches.map(m => ({ m, t: Date.parse(m.scheduled), ctx }));
  const ids = a => a.map(r => r.m.id);
  const { live, next } = kioskBuckets(rows, now);
  assert(ids(live).includes('m2') && ids(live).includes('m3') && ids(live).includes('m6'), 'started-and-unfinished stays on the board, overdue m2 included');
  assert(!ids(live).includes('m1'), 'a done match leaves the board');
  assert(JSON.stringify(ids(next)) === '["m4","m5"]', 'next = the two future starts');
  assert(!ids(next).includes('m6'), 'the boundary instant (now === t) belongs to Now, not Next');
});

test('matchLabel: pool, placement, and round names on one card label', () => {
  const full = catOf('full', 't');
  assert(matchLabel(full.byId.get('m1'), full) === 'Pool A', 'pool match labels its pool');
  assert(matchLabel(full.byId.get('m7'), full) === 'SF', 'semifinal');
  assert(matchLabel(full.byId.get('m10'), full) === 'Final', 'final');
  assert(matchLabel(full.byId.get('m9'), full) === '3rd place', 'bronze via placementLabel');
  const md = catOf('sample', 'md40');
  assert(matchLabel(md.byId.get('m9'), md) === 'Final' && matchLabel(md.byId.get('m10'), md) === '3rd place', 'sample: m9 final, m10 bronze');
});

test('playerMatches: only matches the player is actually in, not potential slots', () => {
  const md = catOf('sample', 'md40');
  const ids = pid => playerMatches(md, pid).map(r => r.m.id).sort();
  assert(ids('p1').join() === 'm1,m3,m5,m7,m9', 'p1: pool + semifinal + final, not bronze m10 (won m7)');
  assert(ids('p7').join() === 'm10,m2,m4,m5,m7', 'p7: pool + m7 + bronze m10, not final m9 (lost m7)');
  assert(ids('p5').join() === 'm2,m3,m6,m8', 'p5: pool + m8; m9/m10 stay off until m8 is decided');
});

test('full bracket: every slot resolves end to end (winner and loser paths)', () => {
  const full = catOf('full', 't');
  const f = full.byId.get('m10'), b = full.byId.get('m9');
  const w0 = resolveSide(f.sides[0], full), w1 = resolveSide(f.sides[1], full);
  assert(w0 && w0.has('p1') && w1 && w1.has('p5'), 'final resolves to p1 vs p5');
  assert(winnerIdx(f, full) === 0, 'final winner is p1');
  const l0 = resolveSide(b.sides[0], full), l1 = resolveSide(b.sides[1], full);
  assert(l0 && l0.has('p6') && l1 && l1.has('p2'), 'bronze resolves to p6 vs p2');
});

test('forfeit inside a pool: counts a win, no gd/pd', () => {
  const full = catOf('full', 't');
  const st = poolStandings(full, 'A');
  const p1 = st.find(r => r.sig === 'p1');
  assert(p1 && p1.wins === 2 && p1.gd === 2 && p1.pd === 11, 'p1: forfeit win + 2-0 win; gd/pd only from the played match');
  assert(st[0].sig === 'p1' && st[1].sig === 'p2' && st[2].sig === 'p3', 'pool A order');
});

test('bracket depth', () => {
  const md = catOf('sample', 'md40');
  assert(matchRound(md.byId.get('m7'), md) === 0 && matchRound(md.byId.get('m9'), md) === 1 && matchRound(md.byId.get('m10'), md) === 1, 'bracket depth');
});

test('koColumn: a bye\'d semi sits in the semifinal column, not with round 1', () => {
  // XD 2026 shape: 5 teams from uneven pools — sf2 is pool-vs-pool (a bye
  // into the semis) while sf1 plays a round-1 survivor. Depth says sf2 is
  // round 1; koColumn must say semifinal.
  const ko = makeCat({ meta: {}, matches: [
    { id: 'r1', sides: [{ kind: 'pool', pool: 'B', rank: 2 }, { kind: 'pool', pool: 'A', rank: 3 }] },
    { id: 'sf1', sides: [{ kind: 'pool', pool: 'A', rank: 1 }, { kind: 'match', match: 'r1', result: 'winner' }] },
    { id: 'sf2', sides: [{ kind: 'pool', pool: 'B', rank: 1 }, { kind: 'pool', pool: 'A', rank: 2 }] },
    { id: 'f', sides: [{ kind: 'match', match: 'sf1', result: 'winner' }, { kind: 'match', match: 'sf2', result: 'winner' }] },
    { id: 'b', sides: [{ kind: 'match', match: 'sf1', result: 'loser' }, { kind: 'match', match: 'sf2', result: 'loser' }] },
  ] }, { timezone: 'UTC', players: [] });
  const col = id => koColumn(ko.byId.get(id), ko);
  assert(col('f') === 0 && col('sf1') === 1 && col('sf2') === 1 && col('r1') === 2 && col('b') === 0,
    'unbalanced bracket: final 0, both semis 1 (incl. bye\'d sf2), round 1 at 2, bronze with the final');
  const full = catOf('full', 't');
  assert(koColumn(full.byId.get('m10'), full) === 0 && koColumn(full.byId.get('m7'), full) === 1 && koColumn(full.byId.get('m9'), full) === 0,
    'balanced bracket unchanged: final 0, semis 1, bronze with the final');
});

test('dead tie: standings tie + pool slot TBD', () => {
  const tie = catOf('tie', 't');
  const st = poolStandings(tie, 'A');
  assert(st && st.length === 2 && sameRecord(st[0], st[1]), 'tie detected in standings');
  assert(resolveSide(tie.byId.get('m3').sides[0], tie) === null, 'dead-tied pool slot -> TBD');
});

test('3-way dead tie: standings tie + pool slot TBD', () => {
  const tie3 = catOf('tie3', 't');
  const st = poolStandings(tie3, 'A');
  assert(st && st.length === 3 && sameRecord(st[0], st[1]) && sameRecord(st[1], st[2]), '3-way tie detected');
  assert(resolveSide(tie3.byId.get('m4').sides[0], tie3) === null, '3-way dead-tied pool slot -> TBD');
});

test('slotLabel: unresolved slots describe the slot, not bare TBD', () => {
  const md = catOf('sample', 'md40');
  const m9 = md.byId.get('m9');
  assert(slotLabel(m9.sides[0], md) === 'Winner of m7', 'winner slot labels the feeder match');
  assert(slotLabel(m9.sides[1], md) === 'Winner of m8', 'unresolved match slot still labels the feeder');
  assert(slotLabel(md.byId.get('m10').sides[0], md) === 'Loser of m7', 'loser slot labels the feeder');
  const st = md.byId.get('m7').sides[0];
  assert(slotLabel(st, md) === '1st in Pool A', 'pool slot labels rank');
  assert(slotLabel(md.byId.get('m8').sides[1], md) === '3rd in Pool A', 'rank 3 ordinal');
});

test('poolStandings partial: unfinished pool still yields a live table', () => {
  const tjson = require(FIX('sample', 'tournaments', 'sample', 'tournament.json'));
  const md = catOf('sample', 'md40');
  const unfinished = makeCat({ meta: tjson.categories[0], matches: md.matches.map(m => m.id === 'm6' ? { ...m, games: [] } : m) }, tjson);
  assert(poolStandings(unfinished, 'A') === null, 'strict form still TBDs an unfinished pool');
  const live = poolStandings(unfinished, 'A', true);
  assert(live && live.length === 4, 'partial form lists all sides');
  assert(live.reduce((n, r) => n + r.wins, 0) === 5, 'only finished matches count');
});

test('roundName: structural knockout names by depth from the final', () => {
  assert(roundName(0) === 'Final', 'depth 0 is the Final');
  assert(roundName(1) === 'Semifinals' && roundName(2) === 'Quarterfinals', 'small-bracket names');
  assert(roundName(3) === 'Round of 16' && roundName(4) === 'Round of 32' && roundName(5) === 'Round of 64', 'big-bracket names');
});

test('placementLabel: 3rd/5th/7th place and classification semis', () => {
  const pl = catOf('place', 'pl');
  const L = id => placementLabel(pl.byId.get(id), pl);
  assert(L('m7') === null && L('m5') === null && L('m1') === null, 'final/semis/quarters are not placement matches');
  assert(L('m8') === '3rd place', 'losers of semis -> 3rd place');
  assert(L('m9') === '5th–8th semi', 'losers of quarters -> classification semi');
  assert(L('m11') === '5th place', 'winners of classification semis -> 5th place');
  assert(L('m12') === '7th place', 'losers of classification semis -> 7th place');
});

// ---------- cli (cli.js) ----------

// scorable = both sides resolve to players; the validator's rule, exposed so
// `list` and the guard on scored matches share one definition.
test('cli isScorable: resolved sides only', () => {
  const repo = loadRepo(FIX('sample'));
  const ctx = makeCat({ meta: repo.tournaments.get('sample').tjson.categories.find(c => c.id === 'md40'), matches: repo.tournaments.get('sample').matches.get('md40').matches }, repo.tournaments.get('sample').tjson);
  assert(cli.isScorable(ctx.byId.get('m1'), ctx), 'm1: two players sides — scorable');
  assert(cli.isScorable(ctx.byId.get('m7'), ctx), 'm7: forfeit, two resolved pool slots — scorable');
  assert(cli.isScorable(ctx.byId.get('m8'), ctx), 'm8: two resolved pool slots, in play — scorable');
  assert(!cli.isScorable(ctx.byId.get('m9'), ctx), 'm9: winner of in-play m8 — not scorable');
  assert(!cli.isScorable(ctx.byId.get('m10'), ctx), 'm10: loser of in-play m8 — not scorable');
});

test('cli listEligible: pools + resolved slots, never match-slot feeders', () => {
  const repo = loadRepo(FIX('sample'));
  const rows = cli.listEligible(repo, 'sample').filter(r => r.cat === 'md40');
  assert(rows.length === 8, `expected 8 scorable in sample md40 (got ${rows.length})`);
  const ids = rows.map(r => r.m.id);
  assert(!ids.includes('m9') && !ids.includes('m10'), 'feeder matches stay unlisted until their slots resolve');
});

test('cli applyScore: sets games, clears a forfeit, repo still validates', () => {
  const repo = loadRepo(FIX('sample'));
  const cjson = repo.tournaments.get('sample').matches.get('md40');
  assert(cli.applyScore(cjson, 'm7', [{ a: 11, b: 5 }]) === null, 'applyScore reports no error');
  const m7 = cjson.matches.find(m => m.id === 'm7');
  assert(m7.forfeit === undefined && m7.games.length === 1, 'forfeit replaced by games');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
});

test('cli applyForfeit: sets forfeit, clears games, repo still validates', () => {
  const repo = loadRepo(FIX('sample'));
  const cjson = repo.tournaments.get('sample').matches.get('md40');
  assert(cli.applyForfeit(cjson, 'm2', 1) === null, 'applyForfeit reports no error');
  const m2 = cjson.matches.find(m => m.id === 'm2');
  assert(m2.forfeit === 1 && m2.games === undefined, 'games replaced by forfeit');
  const { errs } = validateRepo(repo);
  assert(errs.length === 0, 'edited repo still validates: ' + errs.join('; '));
});

test('cli rejects edits the validator would refuse', () => {
  const repo = loadRepo(FIX('sample'));
  const cjson = repo.tournaments.get('sample').matches.get('md40');
  cli.applyScore(cjson, 'm7', [{ a: 11, b: 5 }, { a: 11, b: 3 }]); // knockout target is 1 game
  const { errs } = validateRepo(repo);
  assert(hasErr({ errs }, /after a side already reached the target/), 'game past the target is rejected');
  const repo2 = loadRepo(FIX('sample'));
  cli.applyForfeit(repo2.tournaments.get('sample').matches.get('md40'), 'm9', 1); // m8 unresolved
  const r2 = validateRepo(repo2);
  assert(hasErr(r2, /scored match must have both sides resolved/), 'scoring a match with an unresolved side is rejected');
});

test('cli parseGame', () => {
  assert(JSON.stringify(cli.parseGame('11-9')) === JSON.stringify({ a: 11, b: 9 }), 'a-b parses');
  assert(cli.parseGame('11x9') === null, 'bad shape is null');
});

test('renderers: all four render from a repo and escape repo-sourced strings', () => {
  const dataOf = name => {
    const repo = loadRepo(FIX(name));
    const info = repo.tournaments.get(name);
    return {
      repo,
      data: {
        index: repo.index,
        t: repo.index[0],
        tjson: info.tjson,
        cats: info.tjson.categories.map(c => ({ meta: c, matches: (info.matches.get(c.id) || {}).matches || [] })),
      },
    };
  };
  const { data } = dataOf('sample');
  const no = () => new URLSearchParams('');
  const standings = renderStandings(no(), data);
  assert(standings.includes('Pool A') && standings.includes('Final') && standings.includes('Winner of m8'), 'standings renders pools, bracket, and slot labels');
  assert(standings.includes('Ada Lovelace'), 'standings renders player names');
  const venue = renderVenue(no(), data);
  assert(venue.includes('k-venue') && venue.includes('Ada Lovelace'), 'venue page renders venue boards with match rows');
  assert(renderPlayer(new URLSearchParams('p=p1'), data).includes('Ada Lovelace'), 'player page finds the player');
  assert(renderIndex(no(), data).includes('standings.html?t=sample'), 'index links the tournament');
  // escaping: a hostile name must reach the DOM entity-encoded
  const evil = JSON.parse(JSON.stringify(data.tjson));
  evil.players[0].name = '<b>Ada</b> & "Co"';
  const out = renderPlayer(new URLSearchParams('p=p1'), { ...data, tjson: evil });
  assert(out.includes('&lt;b&gt;Ada&lt;/b&gt; &amp; &quot;Co&quot;') && !out.includes('<b>Ada</b>'), 'player name is escaped');
  // dead ties are flagged in the standings table, not just by background color
  const { data: tdata } = dataOf('tie');
  assert(renderStandings(no(), tdata).includes('†'), 'tied rows carry a rank marker');
});

test('cli writeEdit: rollback on validation failure, write on success (real disk)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    fs.cpSync(FIX('sample'), tmp, { recursive: true });
    const repo = loadRepo(tmp);
    const file = path.join(tmp, 'tournaments', 'sample', 'matches', 'md40.json');
    const before = fs.readFileSync(file, 'utf8');
    const bad = cli.writeEdit(tmp, repo, 'sample', 'md40', c => cli.applyScore(c, 'm7', [{ a: 11, b: 5 }, { a: 11, b: 3 }]));
    assert(bad.errs && bad.errs.length > 0 && !bad.file, 'bad edit reports validation errors');
    assert(fs.readFileSync(file, 'utf8') === before, 'rejected edit rolls the file back byte-identical');
    const m7mem = repo.tournaments.get('sample').matches.get('md40').matches.find(m => m.id === 'm7');
    assert(m7mem.forfeit === 1 && m7mem.games === undefined, 'rejected edit restores the in-memory match too');
    const good = cli.writeEdit(tmp, repo, 'sample', 'md40', c => cli.applyScore(c, 'm7', [{ a: 11, b: 5 }]));
    assert(!good.errs && good.file, 'good edit writes the file');
    const reread = loadRepo(tmp);
    assert(validateRepo(reread).errs.length === 0, 'written repo validates');
    const m7 = reread.tournaments.get('sample').matches.get('md40').matches.find(m => m.id === 'm7');
    assert(m7.games.length === 1 && m7.forfeit === undefined, 'games applied and the forfeit cleared');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- validate (validate.js) ----------

const V = [ // [name, fixture dir, ok, expected message regex]
  ['clean fixture validates', 'sample', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['placement bracket validates', 'place', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['fully played bracket validates', 'full', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['uppercase match id', 'bad-uppercase-id', r => r.errs.length > 0, /must match/],
  ['same player set on both sides', 'bad-same-pair', r => r.errs.length > 0, /same player set/],
  ['slot source consumed twice', 'bad-consumed-twice', r => r.errs.length > 0, /consumed twice/],
  ['slot cycle', 'cycle', r => r.errs.length > 0, /cycle/],
  ['games after a side reached the target', 'bad-games-after-target', r => r.errs.length > 0, /already reached/],
  ['games and forfeit together', 'bad-games-forfeit', r => r.errs.length > 0, /mutually exclusive/],
  ['scored match fed by an unfinished pool', 'bad-unfinished-feed', r => r.errs.length > 0, /resolved/],
  ['even bestOf override', 'bad-even-bestof', r => r.errs.length > 0, /odd/],
  ['bad scheduled string', 'bad-scheduled', r => r.errs.length > 0, /ISO-8601/],
  ['venue overlap', 'bad-venue-overlap', r => r.errs.length > 0, /overlap/],
  ['long-slot venue overlap', 'bad-slot-overlap', r => r.errs.length > 0, /60-minute and 60-minute slots/],
  ['pool slot names an unknown pool', 'bad-unknown-pool', r => r.errs.length > 0, /unknown pool/],
  ['bad venue id', 'bad-venue-id', r => r.errs.length > 0, /must match/],
  ['null match entry', 'bad-null-match', r => r.errs.length > 0, /must be an object/],
  ['null player entry', 'bad-null-player', r => r.errs.length > 0, /must be an object/],
  ['player with two partners', 'bad-two-partners', r => r.errs.length > 0, /has two partners/],
  ['duplicate slug in index', 'bad-duplicate-slug', r => r.errs.length > 0, /duplicate slug/],
  ['pool slot rank out of range', 'bad-rank-range', r => r.errs.length > 0, /out of range/],
  ['dead-tie pool slot warns only', 'tie', r => r.errs.length === 0 && r.warns.length > 0, /dead tie/],
  ['3-way dead tie warns at rank 1', 'tie3', r => r.errs.length === 0 && r.warns.length > 0, /dead tie/],
  ['tiebreak fixture validates', 'tiebreak', r => r.errs.length === 0 && r.warns.length === 0, null],
  ['cross-category venue overlap', 'bad-cross-overlap', r => r.errs.length > 0, /also schedules/],
  ['undeclared category matches file', 'bad-undeclared-cat', r => r.errs.length > 0, /undeclared category/],
  ['unknown venue reference', 'bad-unknown-venue', r => r.errs.length > 0, /unknown venue/],
  ['null tournament.json', 'bad-null-tjson', r => r.errs.length > 0, /must be an object/],
  ['scheduled hour 24 rejected', 'bad-scheduled-hour', r => r.errs.length > 0, /hour/],
  ['impossible calendar date rejected', 'bad-scheduled-date', r => r.errs.length > 0, /not a real calendar date/],
  ['offset outside ISO-8601 range', 'bad-scheduled-offset', r => r.errs.length > 0, /outside ISO-8601/],
  ['even groups bestOf rejected', 'bad-even-groups-bestof', r => r.errs.length > 0, /groups stage in use/],
  ['duplicate venue id', 'bad-duplicate-venue', r => r.errs.length > 0, /duplicate venue/],
  ['unknown side kind', 'bad-unknown-kind', r => r.errs.length > 0, /unknown side kind/],
  ['mixed singles and doubles', 'bad-mixed-sizes', r => r.errs.length > 0, /mixes singles and doubles/],
  ['game with no winner (a equals b)', 'bad-tie-game', r => r.errs.length > 0, /no winner/],
  ['invalid timezone', 'bad-invalid-tz', r => r.errs.length > 0, /not a valid IANA timezone/]
];
for (const [name, dir, ok, re] of V) {
  test(name, () => {
    const r = validateFixture(dir);
    assert(ok(r), `unexpected result: errs=${r.errs.length} warns=${r.warns.length}`);
    if (re) {
      // strict channel: the message must be an error for error fixtures, a warning for warn fixtures
      const got = r.errs.length ? hasErr(r, re) : hasWarn(r, re);
      assert(got, `expected a ${r.errs.length ? 'error' : 'warning'} matching /${re}/, got none\n` + [...r.errs, ...r.warns].slice(0, 3).join('\n'));
    }
    assert(!r.errs.some(e => e.endsWith(': undefined')), 'no error message may end in ": undefined" (err(f, m) called with one arg?)');
  });
}

// ---------- runner ----------

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL - ${name}\n  ${e.message}`);
  }
}
if (failed) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
console.log(`\nAll ${tests.length} tests passed.`);
