'use strict';

// English ordinal suffixes — the only per-locale formatter that needs code;
// every other word rule lives in the maps below as data.
const enOrdRules = new Intl.PluralRules('en', { type: 'ordinal' });
const enOrd = n => n + ({ one: 'st', two: 'nd', few: 'rd' }[enOrdRules.select(n)] || 'th');

// One translation bundle for the public page — every user-facing string ships
// through these maps (completeness is pinned by a test). Repo data (names,
// courts, pools, players) is never translated — proper nouns stay as authored;
// TBD, void, W/O, and the W/L/GD/PD table headers are international scoring
// shorthand and stay too.
// fmt/refs/art carry the per-locale word rules (ordinal styles, declined chip
// refs, prepositional articles) as data — derive.js only dispatches them, so a
// third language is a bundle edit, never a code branch.
const I18N = {
  en: {
    // chrome (app.js)
    views: 'Views',
    categories: 'Categories',
    tournament: 'Tournament',
    schedule: 'Schedule',
    tournaments: 'Tournaments',
    tip: 'Tip: open a tournament and add it to your home screen for easy access to live results and your match schedule.',
    'no-tournaments': 'No tournaments yet.',
    'venue-board': 'Live board',
    missing: 'No tournament data yet — check back soon.',
    'bad-link': 'This link doesn\'t look right.',
    'all-tournaments': 'All tournaments',
    failed: 'Something went wrong displaying this page.',
    reload: 'Reload the page to try again.',
    updated: 'Updated {time}',
    'group-status': 'Group stage: <strong>{played} of {count} played</strong>',
    'ko-remain': 'Knockout stage: <strong>placement matches remain</strong>',
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
    today: 'Today',
    nothing: 'Nothing scheduled.',
    now: 'Now',
    overdue: 'Overdue',
    reconnect: 'reconnecting…',
    more: '+{n} more',
    result: '{where} · {when} · {winner} won',
    'result-void': '{where} · {when} · void',
    'the-match': 'the match',
    'pick-player': 'Pick a player',
    'no-players': 'No players yet.',
    'change-player': 'Change player',
    'time-tbd': 'Time TBD',
    'no-matches': 'No matches.',
    // structural labels (derive.js)
    'in-final': 'In the final',
    'in-round': 'In the {round}',
    'elim-final': 'Eliminated in the final',
    'elim-round': 'Eliminated in the {round}',
    'in-placement': 'In placement',
    'in-groups': 'In groups',
    'out-groups': 'Out in groups',
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
    'slot-dangling': '{who} of match {id}',
    // per-locale word rules (derive.js dispatches by name): bandShort strips the
    // classification word from a band heading; place is the pre-word number
    // ("3rd place"), ord the range form ("3rd–5th").
    fmt: {
      ord: enOrd,
      place: enOrd,
      bandShort: l => l.replace(/ semi$/, ''),
    },
    // declined chip refs per round key and case — the default covers every key
    // without an entry; only the one lowercase quirk ("the final") earns its own.
    refs: {
      'round-final': { acc: 'the final', dat: 'the final' }, // the one lowercase quirk
      '': { acc: 'the {label}', dat: 'the {label}' },
    },
    art: {}, // no articles — parity with de, and the empty entry documents the slot
  },

  de: {
    // chrome (app.js) — informal you, like the venue board itself
    views: 'Ansichten',
    categories: 'Kategorien',
    tournament: 'Turnier',
    schedule: 'Spielplan',
    tournaments: 'Turniere',
    tip: 'Tipp: Öffne ein Turnier und lege es für schnellen Zugriff auf Live-Ergebnisse und deinen Spielplan auf deinem Startbildschirm ab.',
    'no-tournaments': 'Noch keine Turniere.',
    'venue-board': 'Anzeigetafel',
    missing: 'Noch keine Turnierdaten — schau bald wieder vorbei.',
    'bad-link': 'Dieser Link sieht nicht richtig aus.',
    'all-tournaments': 'Alle Turniere',
    failed: 'Beim Anzeigen dieser Seite ist etwas schiefgelaufen.',
    reload: 'Lade die Seite neu und versuche es erneut.',
    updated: 'Aktualisiert {time}',
    'group-status': 'Gruppenphase: <strong>{played} von {count} gespielt</strong>',
    'ko-remain': 'K.o.-Phase: <strong>Platzierungsspiele stehen aus</strong>',
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
    today: 'Heute',
    nothing: 'Nichts geplant.',
    now: 'Jetzt',
    overdue: 'Überfällig',
    reconnect: 'Wird verbunden…',
    more: '+{n} weitere',
    result: '{where} · {when} · Sieg für {winner}',
    'result-void': '{where} · {when} · ungültig',
    'the-match': 'das Spiel',
    'pick-player': 'Spieler wählen',
    'no-players': 'Noch keine Spieler.',
    'change-player': 'Spieler wechseln',
    'time-tbd': 'Zeit offen',
    'no-matches': 'Keine Spiele.',
    // structural labels (derive.js) — {art} carries the German article:
    // "Im Finale" vs "In der Runde der letzten 32" (neuter vs feminine)
    'in-final': 'Im Finale',
    'in-round': '{art} {round}',
    'elim-final': 'Ausgeschieden im Finale',
    'elim-round': 'Ausgeschieden {art} {round}',
    'in-placement': 'In der Platzierungsrunde',
    'in-groups': 'In der Gruppenphase',
    'out-groups': 'Ausgeschieden in der Gruppenphase',
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
    // prepositional article per round kind — "Im Finale" (neuter) vs
    // "In der Runde der letzten 32" (feminine), in/eliminated phrasing.
    art: {
      'round-final': { in: 'Im', elim: 'im' },
      'round-semi': { in: 'Im', elim: 'im' },
      'round-quart': { in: 'Im', elim: 'im' },
      'round-16': { in: 'Im', elim: 'im' },
      'round-of': { in: 'In der', elim: 'in der' },
    },
  },
};

// {param} substitution, nothing else — values are pre-scaped/rendered by the
// caller, so HTML passes through untouched. A missing key or param renders its
// placeholder visibly — never blank, never a throw.
const t = (lang, key, params) => {
  const s = (I18N[lang] || I18N.en)[key];
  if (s === undefined) return `{${key}}`;
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m)) : s;
};

if (typeof module !== 'undefined') module.exports = { I18N, t };
