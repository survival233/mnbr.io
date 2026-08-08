#!/usr/bin/env bash
#
# deploy-audit.sh — Pre-deployment safety audit
# Read-only. Makes NO changes. Reports PASS / WARN / FAIL per check.
#
# Usage:  bash deploy-audit.sh
# Exit:   0 if no FAILs, 1 if any FAIL found.
#
# Safe to run repeatedly. Never prints secret values — only their location.

set -uo pipefail

PASS=0; WARN=0; FAIL=0
GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}  $1"; PASS=$((PASS+1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}  $1"; WARN=$((WARN+1)); }
fail() { echo -e "  ${RED}FAIL${NC}  $1"; FAIL=$((FAIL+1)); }
head() { echo -e "\n${BLUE}== $1 ==${NC}"; }

IS_GIT=false
git rev-parse --is-inside-work-tree >/dev/null 2>&1 && IS_GIT=true

# ---------------------------------------------------------------------------
head "1. Secrets & Credentials"
# ---------------------------------------------------------------------------

# Patterns that look like real secrets (assigned values), not just the word.
SECRET_RE='(api[_-]?key|secret|passwd|password|token|access[_-]?key|private[_-]?key|client[_-]?secret)["'"'"' ]*[:=]["'"'"' ]*[A-Za-z0-9_\-\/+]{12,}'
AWS_RE='AKIA[0-9A-Z]{16}'
PK_RE='-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'

EXCLUDES="--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=.venv --exclude-dir=venv --exclude-dir=__pycache__ --exclude-dir=.next --exclude=*.lock --exclude=package-lock.json --exclude=.env.example --exclude=deploy-audit.sh --exclude=DEPLOYMENT.md"

hits=$(grep -rIEl $EXCLUDES "$SECRET_RE" . 2>/dev/null | grep -vE '\.env(\.[a-z]+)?$' || true)
if [ -n "$hits" ]; then
  fail "Possible hardcoded secrets in tracked source files:"
  echo "$hits" | sed 's/^/          /'
else
  pass "No obvious hardcoded secret assignments in source"
fi

# Well-known secret prefixes (Stripe, GitHub, Slack, OpenAI, Google, etc.)
PREFIX_RE='(sk_live_|sk_test_|pk_live_|rk_live_|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|AIza[0-9A-Za-z_\-]{10}|sk-[A-Za-z0-9]{20}|glpat-)'
prefix_hits=$(grep -rIEl $EXCLUDES "$PREFIX_RE" . 2>/dev/null | grep -vE '\.env\.example$' || true)
[ -n "$prefix_hits" ] && fail "Known secret token prefixes (Stripe/GitHub/etc.) found:" && echo "$prefix_hits" | sed 's/^/          /' || pass "No known secret token prefixes in source"

aws_hits=$(grep -rIEl $EXCLUDES "$AWS_RE" . 2>/dev/null || true)
[ -n "$aws_hits" ] && fail "AWS access key IDs (AKIA...) found:" && echo "$aws_hits" | sed 's/^/          /' || pass "No AWS access key IDs found"

pk_hits=$(grep -rIEl $EXCLUDES "$PK_RE" . 2>/dev/null || true)
[ -n "$pk_hits" ] && fail "Private key blocks found in files:" && echo "$pk_hits" | sed 's/^/          /' || pass "No private key blocks in source"

# .env ignored?
if [ -f .env ] || ls .env.* >/dev/null 2>&1; then
  if [ -f .gitignore ] && grep -qE '(^|/)\.env' .gitignore; then
    pass ".env files present and ignored by .gitignore"
  else
    fail ".env file exists but is NOT in .gitignore"
  fi
fi

# .env tracked in git?
if $IS_GIT; then
  tracked_env=$(git ls-files | grep -E '(^|/)\.env(\.[a-z]+)?$' | grep -v '\.env\.example$' || true)
  [ -n "$tracked_env" ] && fail "Env file is tracked in git: $tracked_env" || pass "No env files tracked in git"

  # secrets in git history
  if git log -p -S 'PRIVATE KEY' --all 2>/dev/null | grep -q 'BEGIN'; then
    fail "Private key found in git HISTORY — rotate + scrub history"
  else
    pass "No private keys detected in git history (quick scan)"
  fi
fi

[ -f .env.example ] && pass ".env.example present (documents required vars)" || warn "No .env.example — add one listing required vars (no values)"

# ---------------------------------------------------------------------------
head "2. Repo Cleanliness"
# ---------------------------------------------------------------------------

if [ -f .gitignore ]; then
  pass ".gitignore exists"
  for pat in node_modules __pycache__ '\.env' '\.DS_Store' 'dist' 'build' '\.log' '\.venv'; do
    grep -qE "$pat" .gitignore || warn ".gitignore missing pattern: ${pat//\\/}"
  done
else
  fail "No .gitignore file"
fi

if $IS_GIT; then
  for junk in node_modules .venv venv __pycache__ dist build .next; do
    if git ls-files | grep -qE "(^|/)$junk/"; then
      fail "Junk directory tracked in git: $junk/  (git rm -r --cached $junk)"
    fi
  done
  git ls-files | grep -qE '\.DS_Store$' && warn ".DS_Store files tracked in git" || true
  git ls-files | grep -qE '\.log$'     && warn "Log files tracked in git" || true

  # large tracked files (>1MB)
  large=$(git ls-files -z 2>/dev/null | xargs -0 -I{} sh -c '[ -f "{}" ] && s=$(wc -c <"{}") && [ "$s" -gt 1048576 ] && echo "$((s/1024))KB  {}"' 2>/dev/null || true)
  [ -n "$large" ] && warn "Large tracked files (>1MB):" && echo "$large" | sed 's/^/          /' || pass "No oversized tracked files"
fi

# ---------------------------------------------------------------------------
head "3. Environment Parity"
# ---------------------------------------------------------------------------

# runtime pinning
if [ -f .nvmrc ] || grep -q '"engines"' package.json 2>/dev/null || [ -f runtime.txt ] || [ -f .python-version ] || [ -f .tool-versions ]; then
  pass "Runtime version is pinned"
else
  warn "No runtime version pin (.nvmrc / engines / .python-version / runtime.txt)"
fi

# lockfile
LOCK_FOUND=false
for lf in package-lock.json yarn.lock pnpm-lock.yaml poetry.lock Pipfile.lock; do
  [ -f "$lf" ] && LOCK_FOUND=true
done
if $LOCK_FOUND; then
  pass "Dependency lockfile present"
elif [ -f requirements.txt ]; then
  grep -qE '==[0-9]' requirements.txt && pass "requirements.txt has pinned versions" || warn "requirements.txt exists but versions not pinned (use ==)"
else
  warn "No lockfile found — deploys may install different versions"
fi

# hardcoded localhost / ports
lh=$(grep -rIEl $EXCLUDES 'https?://(localhost|127\.0\.0\.1)' . 2>/dev/null | grep -vE '\.(md|txt|example)$' || true)
[ -n "$lh" ] && warn "Hardcoded localhost/127.0.0.1 URLs (should be env vars):" && echo "$lh" | sed 's/^/          /' || pass "No hardcoded localhost URLs in source"

# ---------------------------------------------------------------------------
head "4. Build & Config"
# ---------------------------------------------------------------------------

if [ -f package.json ]; then
  grep -q '"build"' package.json && pass "build script defined" || warn "No build script in package.json"
  grep -q '"start"' package.json && pass "start script defined" || warn "No start script in package.json"
fi

# CORS wildcard
cors=$(grep -rIEl $EXCLUDES 'Access-Control-Allow-Origin["'"'"' :,]*\*|origin["'"'"' :,]*["'"'"']\*["'"'"']|cors\(\)' . 2>/dev/null | grep -vE '\.(md|txt|example)$' || true)
[ -n "$cors" ] && warn "Wildcard CORS (*) — lock to your frontend origin:" && echo "$cors" | sed 's/^/          /' || pass "No wildcard CORS detected"

# debug flags
dbg=$(grep -rIEl $EXCLUDES 'DEBUG *= *True|debug: *true|NODE_ENV.*development' . 2>/dev/null | grep -vE '\.(md|example)$' || true)
[ -n "$dbg" ] && warn "Debug/development mode flags found — ensure off in prod:" && echo "$dbg" | sed 's/^/          /' || pass "No obvious debug-mode flags left on"

# ---------------------------------------------------------------------------
head "Summary"
# ---------------------------------------------------------------------------
echo -e "  ${GREEN}$PASS pass${NC}   ${YELLOW}$WARN warn${NC}   ${RED}$FAIL fail${NC}"
if [ "$FAIL" -gt 0 ]; then
  echo -e "  ${RED}Not deploy-ready — resolve FAILs first.${NC}"; exit 1
elif [ "$WARN" -gt 0 ]; then
  echo -e "  ${YELLOW}Review WARNs before deploying.${NC}"; exit 0
else
  echo -e "  ${GREEN}All checks passed.${NC}"; exit 0
fi
