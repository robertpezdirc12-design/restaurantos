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
matches="$(grep -rlE "$PATTERN" \
  --include='*.ts' --include='*.tsx' --include='*.py' --include='*.sh' \
  --include='*.yml' --include='*.yaml' \
  src/ scripts/ mini-services/ .gitlab-ci.yml 2>/dev/null)"

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

echo "OK: ni najdb skrivnih žetonov (src/, scripts/, mini-services/, .gitlab-ci.yml)."
exit 0
