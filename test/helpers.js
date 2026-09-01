'use strict';

// Shared helpers for the test suites: fixture paths + repo loading.
// Auto-discovery runs this file too; it defines no tests, which is fine.

const path = require('path');
const { loadRepo } = require('../src/tools.js');
const { validateRepo } = require('../src/validate.js');
const { makeCat } = require('../site/derive.js');

const FIX = (...parts) => path.join(__dirname, '..', 'fixtures', ...parts);

// Shared between the schedule and sim suites: a spec that generates both
// pools (3+2 teams) and a knockout with pool-rank and match-winner feeders.
const MINI = {
  slug: 'mini',
  name: 'Mini Open',
  location: 'Zurich',
  timezone: 'Europe/Zurich',
  date: '2026-05-02',
  poolSize: 4,
  blocks: { md: '09:00', xd: '13:00' },
  venues: { 'court-1': 'Court 1', 'court-2': 'Court 2' },
  players: { ada: 'Ada', ben: 'Ben', cid: 'Cid', dan: 'Dan', eve: 'Eve', fin: 'Fin', gus: 'Gus', huw: 'Huw', ida: 'Ida', jan: 'Jan', kim: 'Kim' },
  categories: [
    { id: 'md', name: 'Men', bestOf: 1, slotMinutes: 30, final: { bestOf: 3, slotMinutes: 60 } },
    { id: 'xd', name: 'Mixed', bestOf: 1, slotMinutes: 30 },
  ],
  teams: {
    md: [['ada', 'ben'], ['cid', 'dan'], ['eve', 'fin'], ['gus', 'huw'], ['ida', 'jan']],
    xd: [['ada', 'cid'], ['ben', 'eve']],
  },
};

const hasErr = (r, re) => r.errs.some(e => re.test(e));
const hasWarn = (r, re) => r.warns.some(e => re.test(e));

// validator case: run the real validator over a fixture repo root
const validateFixture = name => validateRepo(loadRepo(FIX(name)));

// derive case: build a category context from a fixture repo — loaded through
// the same loadRepo as real checkouts, per AGENTS.md
function catOf(name, catId) {
  const info = loadRepo(FIX(name)).tournaments.get(name);
  return makeCat({ meta: info.tjson.categories.find(c => c.id === catId), matches: (info.tjson.matches || {})[catId] || [] }, info.tjson);
}

// Renderer smoke-check helpers: assert what the page SAYS (text) and its
// behavioral hooks (data-*/aria attrs, link hrefs) — never the tags, classes,
// or separators that carry them. A presentational change (tag, class, middot)
// must not break a test; a missing value, flag, or wiring must. Escapes and
// no-machinery negatives still assert on the raw HTML — that's the contract.
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" };
const decode = s => s.replace(/&(lt|gt|amp|quot|#39);/g, (_, k) => ENT[k]);
// plain page text: tags become spaces (attributes — datetimes, hrefs — drop), entities decode
const text = html => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
// ordered values of one attribute, e.g. every data-status on the page
const vals = (html, attr) => [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))].map(m => m[1]);
// text of every element carrying attr="value" — tag-agnostic via a backreference,
// so the wrapper tag (article/div/li) can change without breaking the association
const cards = (html, attr, value) => [...html.matchAll(
  new RegExp(`<([a-z][a-z0-9]*)[^>]*${attr}="${value}"[^>]*>([\\s\\S]*?)</\\1>`, 'g')
)].map(m => text(m[2]));
const card = (html, attr, value) => cards(html, attr, value)[0];
// real links: the fragment href is the routing contract; wrapper/class/label markup is not
const links = html => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(m => ({
  href: decode(/(?:^|\s)href="([^"]*)"/.exec(m[1])?.[1] ?? null),
  jump: /data-jump="([^"]*)"/.exec(m[1])?.[1] ?? null,
  current: /\baria-current/.test(m[1]),
  text: text(m[2]),
}));

module.exports = { FIX, MINI, hasErr, hasWarn, validateFixture, catOf, text, vals, card, cards, links };
