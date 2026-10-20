#!/usr/bin/env bash
# Issue #4 §15 — secrets scan (CI quality-gate + lokalno).
#
# Išče vzorce odkritih/izgubljenih skrivnosti (GitLab PAT, GitHub PAT klasični in
# fine-grained, OpenAI-style sk-, Vercel CLI token, 6-mestni PIN) v kodi IN v
# Markdown dokumentaciji.
#
# Najdba №20 (revizija 2026-10): worklog.md, DEPLOYMENT-STATUS.md in
# docs/OPS11-plan-visual-display-push-cron.md so vsebovali ŽIV admin PIN, scan pa
# je .md namerno izključeval — ista slepa pega kot №15 pri .github/. Dokumentacija
# je javna in ni nič manj občutljiva od kode; zato je od v1.153.0 v scan-u.
# PIN vzorec pokrije `PIN=<6 števk>`, `PIN: <6 števk>` in `PIN <6 števk>`;
# 4-mestni razvojni PIN-i se NE ujamejo. (Primeri so namenoma brez dobesednih
# števk — sicer bi scan ujel sam sebe.)
#
# Izhod: najdbe → izpiše SAMO datoteke (nikoli vrednosti) → exit 1.
set -u

PATTERN='glpat-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|vcp_[A-Za-z0-9]{20,}|\bPIN\s*[:=]?\s*[0-9]{6}\b'

# grep: -r rekurzivno, -l samo imena datotek, -E razširjen regex; manjkajoče poti ignoriraj
#
# .github/ je v scan-u ZARADI najdbe №15 (revizija 2026-10): sync.yml je imel
# GitLab žeton v git URL-u, ta skript pa .github/ nikoli ni pregledal — step
# "Secrets hygiene" v ci.yml bi torej ostal zelen tudi ob razkritem žetonu v
# workflowu. Workflowi so koda in morajo biti pod isto zaporo kot src/ — sicer
# scan pokrije 90 % datotek, v katerih žetonov ni, in 0 % datotek, kjer so.
# docs/ + korenski *.md sta v scan-u ZARADI najdbe №20 (isti razlog, drug tip
# datotek). DB-URL z geslom NE dodajamo: docs/BACKUP-RESTORE.md vsebuje
# placeholder `<vloga>:<geslo>@...`, ki bi bil stalni lažni zadetek.
#
# Poti se filtrirajo na obstoječe: manjkajoča pot je prej pomenila `grep` exit 2,
# ta skript pa je vsak status > 1 obravnaval kot "čisto" — scan bi torej tiho
# ostal zelen, če bi nekdo preimenoval docs/ ali .github/. Zdaj manjkajoča pot
# preprosto ni v seznamu, popolnoma prazen seznam pa je trda napaka.
ROOTS=()
for p in src scripts mini-services .github docs .gitlab-ci.yml; do
  [ -e "$p" ] && ROOTS+=("$p")
done
shopt -s nullglob
for p in ./*.md; do
  [ -f "$p" ] && ROOTS+=("$p")
done
shopt -u nullglob

if [ "${#ROOTS[@]}" -eq 0 ]; then
  echo "FAIL: nobena scan pot ne obstaja — skript se izvaja iz napačne mape?"
  exit 1
fi

matches="$(grep -rlE "$PATTERN" \
  --include='*.ts' --include='*.tsx' --include='*.py' --include='*.sh' \
  --include='*.yml' --include='*.yaml' --include='*.md' \
  "${ROOTS[@]}" 2>/dev/null)"

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

echo "OK: ni najdb skrivnosti (src/, scripts/, mini-services/, .github/, .gitlab-ci.yml, docs/, *.md)."
exit 0
