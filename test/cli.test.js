'use strict';

// CLI (cli.js): scoring eligibility, edits, parse, renderers, disk writes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRepo, validateRepo } = require('../validate.js');
const { makeCat, renderIndex, renderStandings, renderVenue, renderPlayer } = require('../site/app.js');
const cli = require('../cli.js');
const { FIX, hasErr } = require('./helpers.js');

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
  assert(standings.includes('player.html?t=sample') && !standings.includes('player.html?t=sample&p='), 'standings links the player picker, not each name');
  const venue = renderVenue(no(), data);
  assert(venue.includes('k-venue') && venue.includes('Ada Lovelace'), 'venue page renders venue boards with match rows');
  assert(renderPlayer(new URLSearchParams('p=p1'), data).includes('Ada Lovelace'), 'player page finds the player');
  assert(renderPlayer(new URLSearchParams('p=p1'), data).includes('standings.html?t=sample'), 'player page links the tournament name to standings');
  assert(renderIndex(no(), data).includes('standings.html?t=sample'), 'index links the tournament');
  // escaping: a hostile name must reach the DOM entity-encoded
  const evil = JSON.parse(JSON.stringify(data.tjson));
  evil.players[0].name = '<b>Ada</b> & "Co"';
  const out = renderPlayer(new URLSearchParams('p=p1'), { ...data, tjson: evil });
  assert(out.includes('&lt;b&gt;Ada&lt;/b&gt; &amp; &quot;Co&quot;') && !out.includes('<b>Ada</b>'), 'player name is escaped');
  // tied teams share the first rank of their group (standard competition ranking: 1 1 1 4)
  const { data: tdata } = dataOf('tie');
  const tieHtml = renderStandings(no(), tdata);
  assert(!tieHtml.includes('†') && (tieHtml.match(/class="tie"><td>1<\/td>/g) || []).length === 2, 'tied teams share rank 1, no dagger');
});

test('cli writeEdit: rollback on validation failure, write on success (real disk)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbracket-'));
  try {
    const dataRoot = path.join(tmp, 'site');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(FIX('sample'), dataRoot, { recursive: true });
    const repo = loadRepo(dataRoot);
    const file = path.join(dataRoot, 'tournaments', 'sample', 'matches', 'md40.json');
    const before = fs.readFileSync(file, 'utf8');
    const bad = cli.writeEdit(dataRoot, repo, 'sample', 'md40', c => cli.applyScore(c, 'm7', [{ a: 11, b: 5 }, { a: 11, b: 3 }]));
    assert(bad.errs && bad.errs.length > 0 && !bad.file, 'bad edit reports validation errors');
    assert(fs.readFileSync(file, 'utf8') === before, 'rejected edit rolls the file back byte-identical');
    const m7mem = repo.tournaments.get('sample').matches.get('md40').matches.find(m => m.id === 'm7');
    assert(m7mem.forfeit === 1 && m7mem.games === undefined, 'rejected edit restores the in-memory match too');
    const good = cli.writeEdit(dataRoot, repo, 'sample', 'md40', c => cli.applyScore(c, 'm7', [{ a: 11, b: 5 }]));
    assert(!good.errs && good.file, 'good edit writes the file');
    const reread = loadRepo(dataRoot);
    assert(validateRepo(reread).errs.length === 0, 'written repo validates');
    const m7 = reread.tournaments.get('sample').matches.get('md40').matches.find(m => m.id === 'm7');
    assert(m7.games.length === 1 && m7.forfeit === undefined, 'games applied and the forfeit cleared');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
