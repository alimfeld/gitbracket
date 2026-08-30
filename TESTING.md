# Testing against a live deployment

Test kiosk behaviour, CDN latency, 304 caching, and polling against a real
deployment — without touching the production live domain.

Two recipes:
- **Branch + local server** — everything except real CDN answers (latency, 304s, HTTPS).
- **Scratch clone + throwaway surge domain** — real CDN behaviour.

Both are push-proof by construction: `gb.js publish` only ships from `main`;
the probe has no git remote; and its scratch domain is committed, so git ops
can't restore the production CNAME.

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
