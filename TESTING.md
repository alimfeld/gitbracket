# Testing against a live deployment

Test kiosk behaviour, CDN latency, 304 caching, and polling against a real
deployment — without touching the production live domain. Two recipes: the
branch recipe covers everything except real CDN behaviour; the scratch-domain
recipe covers that.

## Everything else: a branch and a local server

Work on a branch in your own checkout and serve the static site from your
machine. Rendering, the kiosk poll, and the REPL edit → commit → push flow
all work here — it skips only what a real deployment answers: CDN latency,
304 revalidation, HTTPS.

```bash
# ── setup (one time) ──
git checkout -b test
python3 -m http.server 8000 --directory site   # serve the same files surge serves
# open http://localhost:8000
git push -u origin test            # once — the upstream the REPL's push needs

# ── iterate (as many times as needed) ──
node gb.js               # edit scores → commits land on the branch; the
                         # REPL's `push` pushes them to the branch
# reload the tab; the kiosk's poll picks changes up by itself

# ── cleanup (or keep it) ──
git checkout main
git branch -d test
git push origin --delete test
```

The branch is the testing boundary: `gb.js publish` ships whatever checkout
you run it from to the live domain — so never publish from the test branch.
Local serving matches the deployed app — same files, same relative fetches
(`cache: no-cache`, so reloads are fresh).

Use the scratch-domain recipe below for real CDN answers, this one for
everything else.

## CDN behaviour: a scratch clone, its own surge domain

The live domain lives in `site/CNAME`, so a throwaway domain is a one-line
edit in a scratch clone: publish from the probe, hit real CDN cache/304/HTTPS
behaviour there, delete the clone and the domain is gone. Production's
domain is never touched.

```bash
# ── setup (one time) ──
git fetch origin main
git clone "https://github.com/$(gh api user -q .login)/gitbracket.git" /tmp/gitbracket-probe
cd /tmp/gitbracket-probe
echo probe-$(date +%s).surge.sh > site/CNAME   # a fresh throwaway domain

# ── iterate (as many times as needed) ──
node gb.js               # edit scores → committed locally by the REPL
node gb.js publish       # ships only the probe domain (validate gate)
# open https://$(cat site/CNAME) — CDN latency, 304s, HTTPS

# ── cleanup (zero trace) ──
rm -rf /tmp/gitbracket-probe   # deleting the clone retires the domain
```

The probe's origin is the production repo, so never run the REPL's `push`
here — the REPL's commits stay local and die with the clone.

## Prerequisites

- **Branch recipe:** Git, Node.js, any static-file server (`python3 -m http.server` or equivalent)
- **CDN recipe:** the [surge CLI](https://surge.sh) authenticated (one-time `npm install -g surge` + `surge login`), [GitHub CLI](https://cli.github.com/) (`gh`), Git, Node.js
