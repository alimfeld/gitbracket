'use strict';

// The only per-locale formatter that needs code; every other word rule is data.
const enOrdRules = new Intl.PluralRules('en', { type: 'ordinal' });
const enOrd = n => n + ({ one: 'st', two: 'nd', few: 'rd' }[enOrdRules.select(n)] || 'th');

// Every user-facing string ships through these maps (completeness pinned by a
// test). Repo data (names, courts, pools, players) and scoring shorthand (TBD,
// void, W/O, W/L/GD/PD) stay as authored. fmt/refs/art carry the word rules as
// data; derive.js only dispatches them.
const I18N = {
  en: {
    // chrome (app.js)
    views: 'Views',
    categories: 'Categories',
    tournament: 'Tournament',
    schedule: 'Schedule',
    tournaments: 'Tournaments',
    'no-tournaments': 'No tournaments yet.',
    'venue-board': 'Live board',
    missing: 'No tournament data yet — check back soon.',
    'bad-link': 'This link doesn\'t look right.',
    'all-tournaments': 'All tournaments',
    failed: 'Something went wrong displaying this page.',
    reload: 'Reload the page to try again.',
    updated: 'Last updated: {time}',
    'group-status': 'Group stage: <strong>{played} of {count} played</strong>',
    'ko-remain': 'Knockout stage: <strong>placement matches remain</strong>',
    'ko-blocked': 'Knockout stage: <strong>blocked by unresolved slots</strong>',
    'ko-round': 'Knockout stage: <strong>{round}</strong>',
    finished: 'Finished',
    champion: 'Champion',
    'runner-up': 'Runner-up',
    rank3: '3rd',
    rank4: '4th',
    next: 'Next: {body}',
    'group-stage': 'Group stage',
    'group-matches': 'Group matches',
    'ko-stage': 'Knockout stage',
    won: 'won',
    nothing: 'Nothing scheduled.',
    now: 'Now',
    overdue: 'Overdue',
    reconnect: 'reconnecting…',
    'sim-hint': 'sim · j/k move the line · Esc exits',
    'pick-player': 'Pick a player',
    'no-players': 'No players yet.',
    'change-player': 'Change player',
    'time-tbd': 'Time TBD',
    'no-matches': 'No matches.',
    // structural labels (derive.js)
    'in-final': 'In the final',
    'in-round': 'In the {round}',
    'in-placement': 'In placement',
    'in-groups': 'In groups',
    'out-groups': 'Out in groups',
    'rank-append': '{status} — {rank}',
    'round-final': 'Final',
    'round-semi': 'Semifinals',
    'round-quart': 'Quarterfinals',
    'round-16': 'Round of 16',
    'round-of': 'Round of {n}',
    'pl-place': '{n} place',
    'pl-semi': '{a}–{b} semi',
    'pl-pair': '{a} / {b} place',
    placement: 'Placement',
    'chip-any': 'any rank in Pool {pool}',
    'chip-rank': 'as {range} in Pool {pool}',
    'chip-via': 'via {ref}',
    'chip-as': 'as {kind} of {ref}',
    'kind-winner': 'winner',
    'kind-loser': 'loser',
    'chip-or': ' or ',
    // unresolved-slot phrasing (derive.js slotLabel)
    'slot-winner': 'Winner',
    'slot-loser': 'Loser',
    'slot-of': '{who} of {ref}',
    'slot-pool': '{rank} in Pool {pool}',
    'slot-pool-tie': '{rank} in Pool {pool} — tie not broken',
    'slot-dangling': '{who} of match {id}',
    // per-locale word rules (derive.js dispatches by name): bandShort strips the
    // classification word, place is the pre-word number, ord the range form.
    fmt: {
      ord: enOrd,
      place: enOrd,
      bandShort: l => l.replace(/ semi$/, ''),
    },
    // declined chip refs per round key and case — the default covers every key
    // without an entry.
    refs: {
      'round-final': { acc: 'the final', dat: 'the final' }, // the one lowercase quirk
      '': { acc: 'the {label}', dat: 'the {label}' },
    },
  },

  de: {
    // chrome (app.js) — informal you, like the venue board itself
    views: 'Ansichten',
    categories: 'Kategorien',
    tournament: 'Turnier',
    schedule: 'Spielplan',
    tournaments: 'Turniere',
    'no-tournaments': 'Noch keine Turniere.',
    'venue-board': 'Anzeigetafel',
    missing: 'Noch keine Turnierdaten — schau bald wieder vorbei.',
    'bad-link': 'Dieser Link sieht nicht richtig aus.',
    'all-tournaments': 'Alle Turniere',
    failed: 'Beim Anzeigen dieser Seite ist etwas schiefgelaufen.',
    reload: 'Lade die Seite neu und versuche es erneut.',
    updated: 'Zuletzt aktualisiert: {time}',
    'group-status': 'Gruppenphase: <strong>{played} von {count} gespielt</strong>',
    'ko-remain': 'K.o.-Phase: <strong>Platzierungsspiele stehen aus</strong>',
    'ko-blocked': 'K.o.-Phase: <strong>durch offene Plätze blockiert</strong>',
    'ko-round': 'K.o.-Phase: <strong>{round}</strong>',
    finished: 'Beendet',
    champion: 'Sieger',
    'runner-up': '2. Platz',
    rank3: '3. Platz',
    rank4: '4. Platz',
    next: 'Als Nächstes: {body}',
    'group-stage': 'Gruppenphase',
    'group-matches': 'Gruppenspiele',
    'ko-stage': 'K.o.-Phase',
    won: 'gewonnen',
    nothing: 'Nichts geplant.',
    now: 'Jetzt',
    overdue: 'Überfällig',
    reconnect: 'Wird verbunden…',
    'sim-hint': 'Sim · j/k verschiebt die Linie · Esc beendet',
    'pick-player': 'Spieler wählen',
    'no-players': 'Noch keine Spieler.',
    'change-player': 'Spieler wechseln',
    'time-tbd': 'Zeit offen',
    'no-matches': 'Keine Spiele.',
    // structural labels (derive.js) — {art} carries the German article ("Im" vs "In der")
    'in-final': 'Im Finale',
    'in-round': '{art} {round}',
    'in-placement': 'In der Platzierungsrunde',
    'in-groups': 'In der Gruppenphase',
    'out-groups': 'Ausgeschieden in der Gruppenphase',
    'rank-append': '{status} — {rank}',
    'round-final': 'Finale',
    'round-semi': 'Halbfinale',
    'round-quart': 'Viertelfinale',
    'round-16': 'Achtelfinale',
    'round-of': 'Runde der letzten {n}',
    'pl-place': '{n}. Platz',
    'pl-semi': '{a}–{b} Halbfinale',
    'pl-pair': '{a}. Platz / {b}. Platz',
    placement: 'Platzierung',
    'chip-any': 'jede Platzierung in Pool {pool}',
    'chip-rank': 'als {range} in Pool {pool}',
    'chip-via': 'über {ref}',
    'chip-as': 'als {kind} {ref}',
    'kind-winner': 'Sieger',
    'kind-loser': 'Verlierer',
    'chip-or': ' oder ',
    // unresolved-slot phrasing (derive.js slotLabel)
    'slot-winner': 'Sieger',
    'slot-loser': 'Verlierer',
    'slot-of': '{who} {ref}',
    'slot-pool': '{rank} in Pool {pool}',
    'slot-pool-tie': '{rank} in Pool {pool} — Gleichstand',
    'slot-dangling': '{who} von Spiel {id}',
    fmt: {
      ord: n => `${n}.`,
      place: n => String(n),
      bandShort: l => l.replace(/ Halbfinale$/, ''),
    },
    refs: {
      'round-of': { acc: 'die {label}', dat: 'von der {label}' }, // "die Runde der letzten 32" — feminine
      'pl-place': { acc: 'den {label}', dat: 'vom {label}' },     // "den 3. Platz" — masculine
      '': { acc: 'das {label}', dat: 'vom {label}' },             // the default: neuter "das/vom"
    },
    // prepositional article per round key.
    art: {
      'round-final': 'Im',
      'round-semi': 'Im',
      'round-quart': 'Im',
      'round-16': 'Im',
      'round-of': 'In der',
    },
  },
};

// A missing bundle renders English — t() and derive's dispatchers share this.
const bundle = lang => I18N[lang] || I18N.en;

// {param} substitution only; values are pre-escaped, and a missing key renders its placeholder.
const t = (lang, key, params) => {
  const s = bundle(lang)[key];
  if (s === undefined) return `{${key}}`;
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m)) : s;
};

if (typeof module !== 'undefined') module.exports = { I18N, t, bundle };
