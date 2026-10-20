#!/usr/bin/env bash
# Issue #4 §15 — secrets scan (CI quality-gate + lokalno).
#
# Išče vzorce odkrite/izgubljene žetone (GitLab PAT, GitHub PAT, OpenAI-style sk-,
# Vercel CLI token) v kodi. Zgodovinski .md dokumenti (worklog/DEPLOYMENT-STATUS/
# RECOVERY-*) so izven scan-a — tam so truncirani žetoni javno razglašeni za
# revocirane in se rešujejo ločeno (rotacija, ne git zgodovina).
#
# Izhod: najdbe → izpiše SAMO datoteke (nikoli vrednosti) → exit 1.
set -u

PATTERN='glpat-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|vcp_[A-Za-z0-9]{20,}'

# grep: -r rekurzivno, -l samo imena datotek, -E razširjen regex; manjkajoče poti ignoriraj
#
# .github/ je v scan-u ZARADI najdbe №15 (revizija 2026-10): sync.yml je imel
# GitLab žeton v git URL-u, ta skript pa .github/ nikoli ni pregledal — step
# "Secrets hygiene" v ci.yml bi torej ostal zelen tudi ob razkritem žetonu v
# workflowu. Workflowi so koda in morajo biti pod isto zaporo kot src/ — sicer
# scan pokrije 90 % datotek, v katerih žetonov ni, in 0 % datotek, kjer so.
matches="$(grep -rlE "$PATTERN" \
  --include='*.ts' --include='*.tsx' --include='*.py' --include='*.sh' \
  --include='*.yml' --include='*.yaml' \
  src/ scripts/ mini-services/ .github/ .gitlab-ci.yml 2>/dev/null)"

status=$?

if [ -n "$matches" ]; then
  echo "FAIL: najdeni potencialni skrivni žetoni v:"
  while IFS= read -r f; do
    echo "  - $f"
  done <<< "$matches"
  echo "Žetoni rotirajte/revocirajte in odstranite iz kode — vrednosti se NE izpisujejo."
  exit 1
fi

if [ "$status" -gt 1 ]; then
  # grep exit 2 = npr. manjkajoča pot — ni najdba, ampak opozorimo
  echo "WARN: grep exit $status (manjkajoča scan pot?) — obravnavano kot čisto."
fi

echo "OK: ni najdb skrivnih žetonov (src/, scripts/, mini-services/, .github/, .gitlab-ci.yml)."
exit 0
