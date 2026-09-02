# Testing and rehearsing a tournament day

## Rehearse a whole day first: the sim (no deployment, no branch)

`node gb.js sim [slug]` copies `site/` to the gitignored `.sim/`, serves it
over HTTP with `Date.now` faked to a sim clock, and opens the match-day editor
against it — every view (tournament, schedule, kiosk) tracks the rehearsal:
`]`/`[` move the kiosk clock 30 sim-minutes (display only — it never changes
what's scoreable), `x` scores the highlighted wave with random games through
the real validation path, and the normal slash verbs edit manually. The
scoreable set is the same wave the live editor highlights, so `n`/`N` and `x`
behave exactly as they do live. Nothing is ever committed — `.sim/` is not a
repo, and `site/` is untouched. Prereqs: Node, a browser, and a terminal (the editor needs
keypresses).

For the deployment surface the sim deliberately skips — real commits and a
real clock, then real CDN answers — there are two recipes, both push-proof by
construction: `gb.js publish` only ships from `main`; the probe has no git
remote; and its scratch domain is committed, so git ops can't restore the
production CNAME.

- **Branch + local server** — real commits and clock, everything except real CDN answers (latency, 304s, HTTPS).
- **Scratch clone + throwaway surge domain** — real CDN behaviour.

## Everything except CDN: a branch and a local server

Serve `site/` locally on a branch. Nothing here pushes, and publish refuses
off `main`.

```bash
# ── setup (one time) ──
git checkout -b test
python3 -m http.server 8000 --directory site   # same files surge serves
# open http://localhost:8000

# ── iterate ──
node gb.js               # edits commit locally; nothing ships off main
# no reload — a visible view polls the change up by itself

# ── cleanup ──
git checkout main && git branch -d test
```

To get test-branch changes out, merge to `main` first; the director
publishes. Local serving matches the deployed app — same files, same relative
fetches (`cache: no-cache`, so reloads are fresh).

## Real CDN: a scratch clone on its own surge domain

Clone, swap `site/CNAME` for a throwaway domain, publish from the probe,
teardown, delete.

```bash
# ── setup (one time) ──
git clone "https://github.com/$(gh api user -q .login)/gitbracket.git" /tmp/gitbracket-probe
cd /tmp/gitbracket-probe
git remote remove origin              # no remote → no push can leave
echo probe-$(date +%s).surge.sh > site/CNAME   # throwaway domain
git commit -am "probe: scratch surge domain"   # committed → git ops can't restore the live one

# ── iterate ──
node gb.js         # edit scores → committed locally
node gb.js publish # ships only the probe domain (main branch, validate gate)
# open https://$(cat site/CNAME) — CDN latency, 304s, HTTPS

# ── cleanup (zero trace) ──
surge teardown "$(cat site/CNAME)"   # stays hosted until torn down — rm -rf alone leaks it
rm -rf /tmp/gitbracket-probe
```

## Prerequisites

- **Branch recipe:** Git, Node.js, any static-file server (`python3 -m http.server` or equivalent)
- **CDN recipe:** the [surge CLI](https://surge.sh) authenticated (one-time `npm install -g surge` + `surge login`), [GitHub CLI](https://cli.github.com/) (`gh`), Git, Node.js
