# DEPLOYMENT.md — Agent Pre-Deploy Runbook

**Purpose:** A checklist for an AI agent (or human) to make a repo safe to deploy.
**Golden rules:** never commit secrets · always have a real `.gitignore` · test in a prod-like environment before shipping.

---

## Agent Operating Rules (read first)

1. **Never print secret _values_.** Report the file/line where a secret lives, never the value itself.
2. **Never commit, force-push, or deploy without explicit human confirmation.**
3. **Never auto-rewrite git history.** If a secret is found in history, STOP and flag it for the human — history scrubbing + key rotation is a human decision.
4. **Fix one category at a time.** After each category, confirm the build still passes before moving on.
5. **Report before you change.** Produce the full PASS/WARN/FAIL list first, then propose fixes, then apply approved ones.
6. Start every run with: `bash deploy-audit.sh`. Treat any **FAIL** as a hard blocker.

---

## Phase 1 — Secrets & Credentials  (hard blockers)

- [ ] Run a secret scan across the whole codebase (keys, tokens, passwords, connection strings, private keys).
- [ ] `.env` and `.env.*` are listed in `.gitignore`.
- [ ] No env file is tracked in git (`git ls-files | grep .env`). `.env.example` is the only exception.
- [ ] No secrets in git **history** (if found -> STOP, flag human, rotate the key).
- [ ] All secrets read from environment variables in code (`process.env.X` / `os.environ["X"]`), not literals.
- [ ] `.env.example` exists listing every required key with **empty** values.
- [ ] Every required env var is set in the deploy target's dashboard/secret store.
- [ ] Dev, staging, and prod use **different** keys.
- [ ] Any key ever committed has been rotated.

## Phase 2 — Repo Cleanliness

- [ ] `.gitignore` exists and covers: `node_modules/`, `.env*` (keep `!.env.example`), `__pycache__/`, `*.pyc`, `dist/`, `build/`, `.next/`, `*.log`, `.DS_Store`, `.venv/`, coverage output.
- [ ] Remove already-tracked junk: `git rm -r --cached node_modules dist build __pycache__`
- [ ] Delete scratch files, useless generated `.md`, and large commented-out blocks.
- [ ] No large binaries/datasets in git (>1 MB flagged) — move to storage instead.

## Phase 3 — Environment Parity

- [ ] Runtime version pinned (`.nvmrc`, `engines` in `package.json`, `.python-version`, or `runtime.txt`).
- [ ] A committed lockfile exists (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` / `poetry.lock`) **or** `requirements.txt` with `==` pinned versions.
- [ ] No hardcoded `localhost` / `127.0.0.1` / ports — use env vars.
- [ ] **Import casing matches filenames exactly** (Linux is case-sensitive; `Header.js` != `header.js`). Verify every import path.
- [ ] Database URL comes from an env var, not a local connection string.

## Phase 4 — Build & Dependencies

- [ ] Clean install from lockfile in a fresh dir succeeds.
- [ ] Build runs from scratch: `rm -rf node_modules && <install> && <build>`.
- [ ] Nothing needed at runtime lives only in devDependencies.
- [ ] `start` / entrypoint command matches what the host expects.

## Phase 5 — Config & Security

- [ ] Debug/development mode is **OFF** for production.
- [ ] CORS is locked to the real frontend origin — **not** `*`.
- [ ] HTTPS enforced; no hardcoded `http://` API calls.
- [ ] Cloud storage buckets are **not** public unless intended.
- [ ] No default/admin credentials; unused ports closed.
- [ ] Stack traces / detailed errors are not exposed to end users.

## Phase 6 — Operational Safety

- [ ] Basic error logging in place (no silent failures).
- [ ] Health check endpoint exists.
- [ ] Deploy to **staging** first and smoke-test.
- [ ] After deploy, test the real production URL end-to-end.
- [ ] Rollback procedure is known and documented.

---

## Recommended `.gitignore` starter

```gitignore
# secrets
.env
.env.*
!.env.example

# deps
node_modules/
.venv/
venv/

# python
__pycache__/
*.pyc

# builds
dist/
build/
.next/
out/

# logs & os
*.log
.DS_Store
coverage/
```

## Definition of Done
`bash deploy-audit.sh` returns **0 FAILs**, every WARN has been reviewed and consciously accepted, and the app has been smoke-tested on staging against the production URL.
