# Testing with a throwaway GitHub Pages repo

Test kiosk behaviour, CDN latency, 304 caching, and polling on a real GitHub
Pages deployment — without touching the production repo's history or workflow.

## How it works

Create a public test repo, push the latest main from the production remote
(not your local branch), enable Pages, clone it somewhere isolated, edit scores
via the REPL, push from inside the REPL, and check the live URL. Delete
everything when done.

The clone's `origin` is always and only the test repo — you can't
accidentally push to production. No remotes are added to the original repo.

Uses HTTPS (not SSH) — `gh` handles authentication via its own token and
sets up the git credential helper transparently.

## Recipe

```bash
# ── setup (one time) ──
gh repo create gitbracket-test --public
gh api "repos/:owner/gitbracket-test/pages" -X POST -f build_type=workflow 2>/dev/null || true
git fetch origin main
git push "https://github.com/$(gh api user -q .login)/gitbracket-test.git" FETCH_HEAD:refs/heads/main
gh repo clone gitbracket-test /tmp/gitbracket-test

# ── iterate (as many times as needed) ──
cd /tmp/gitbracket-test
node gb.js               # edit scores → push from inside the REPL
# check https://<user>.github.io/gitbracket-test/

# ── cleanup (zero trace) ──
rm -rf /tmp/gitbracket-test
gh repo delete gitbracket-test --yes
```

## Notes

- `git fetch origin main` then `FETCH_HEAD:main` pushes the exact commit the
  production remote's main currently points to — not your potentially stale
  local branch.
- `gh repo create` with `--public` is required — GitHub Pages on free
  accounts needs a public repo. No remotes are added to your original checkout.
- `gh repo clone` uses your existing `gh` auth token — no SSH keys needed.
- All work happens in `/tmp/gitbracket-test` where `origin` is the test repo.
  The REPL's built-in `push` command pushes there safely.
- To pull in changes from the production repo (e.g. rendering fixes, new
  tools), add it as an upstream remote and merge:

  ```bash
  cd /tmp/gitbracket-test
  git remote add upstream "https://github.com/$(gh api user -q .login)/gitbracket.git"
  git fetch upstream
  git merge upstream/main
  git push     # redeploys with the latest code
  ```

## Leaner alternative: a branch and a local server

When you only need to see the app — rendering, the kiosk poll, the REPL
edit → commit → push flow — skip the throwaway repo. Work on a branch in
your own checkout and serve the static site from your machine.

```bash
# ── setup (one time) ──
git checkout -b test
python3 -m http.server 8000 --directory site   # serve the same files Pages serves
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

The branch replaces the throwaway repo as the isolation boundary: the
REPL's `push` goes to `origin/test`, and Pages deploys `main` only — nothing
ships. No `gh`, no repo create/delete, no `/tmp` clone — `python3 -m http.server`
is the whole server.

Local serving matches the deployed app — same files, same relative fetches
(`cache: no-cache`, so reloads are fresh). It skips only what a real
deployment answers: CDN latency, 304 revalidation, HTTPS, `?v=` stamping.
Use the Pages recipe for those, this one for everything else.

## Prerequisites

- **Throwaway-repo recipe:** [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated; Git, Node.js; permissions to create public repos
- **Branch recipe:** Git, Node.js, and any static-file server (`python3 -m http.server` or equivalent)
