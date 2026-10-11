#!/usr/bin/env bash
# Revizator serveur : mise a jour automatique depuis GitHub (deploy/README.md, § 10).
#
# Lance toutes les minutes par revizator-auto-update.timer (systemd, en root sur le LXC). A chaque passage :
#   1. git fetch de la branche suivie (main) ; rien de nouveau : fin, en silence ;
#   2. si les nouveaux commits ne touchent pas le serveur (src/Revizator.Server, src/Organizator/Services,
#      src/Organizator/wwwroot, deploy/Dockerfile, deploy/docker-compose.yml, .dockerignore) : la copie est
#      avancee, rien d'autre ;
#   3. sinon : sauvegarde de /opt/revizator/data (sans les modeles de voix et de transcription, ni les
#      installateurs : re-telechargeables), git merge --ff-only, « docker compose up -d --build » (la meme
#      stack que Komodo : projet « revizator »), puis attente de /api/health avec le nouveau commit ;
#   4. echec (construction ratee, serveur qui ne repond pas en 4 minutes) : retour au commit precedent,
#      reconstruit et relance ; le commit fautif est note et n'est plus essaye tant que main n'a pas avance.
#
# Rien n'est jamais pousse ni ecrit sur GitHub. Journal : journalctl -u revizator-auto-update.
# Reglages (variables d'environnement, voir revizator-auto-update.service) : REVIZATOR_SRC, REVIZATOR_BRANCH,
# REVIZATOR_DATA_DIR, REVIZATOR_BACKUPS, REVIZATOR_KEEP_BACKUPS, REVIZATOR_HEALTH_URL.
set -euo pipefail

# Le script est lui-meme dans le depot : git merge pourrait le reecrire pendant qu'il tourne. On execute
# donc une copie.
if [ -z "${REVIZATOR_AUTO_COPY:-}" ]; then
  copy=$(mktemp /tmp/revizator-auto-update.XXXXXX)
  cp "$0" "$copy"
  REVIZATOR_AUTO_COPY="$copy" exec bash "$copy" "$@"
fi
trap 'rm -f "$REVIZATOR_AUTO_COPY"' EXIT

SRC=${REVIZATOR_SRC:-/opt/revizator/src}
BRANCH=${REVIZATOR_BRANCH:-main}
DATA=${REVIZATOR_DATA_DIR:-/opt/revizator/data}
BACKUPS=${REVIZATOR_BACKUPS:-/root/revizator-backups}
KEEP=${REVIZATOR_KEEP_BACKUPS:-10}
HEALTH_URL=${REVIZATOR_HEALTH_URL:-http://127.0.0.1:8080/api/health}
STATE=${REVIZATOR_STATE:-/var/lib/revizator-auto-update}
LOCK=${REVIZATOR_LOCK:-/run/revizator-auto-update.lock}
HEALTH_WAIT=${REVIZATOR_HEALTH_WAIT:-240}

# Chemins qui changent l'image du serveur.
SERVER_PATHS='^(src/Revizator\.Server/|src/Organizator/Services/|src/Organizator/wwwroot/|deploy/Dockerfile$|deploy/docker-compose\.yml$|\.dockerignore$)'

log() { echo "[auto-update] $*"; }

# Un seul passage a la fois (une construction dure plus d'une minute).
mkdir -p "$(dirname "$LOCK")" "$STATE"
exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$SRC"
if ! git fetch --quiet origin "$BRANCH"; then
  log "GitHub injoignable (git fetch) : nouvel essai a la minute suivante."
  exit 0
fi

head=$(git rev-parse HEAD)
target=$(git rev-parse "origin/$BRANCH")
[ "$head" = "$target" ] && exit 0

if [ "$(cat "$STATE/failed" 2>/dev/null || true)" = "$target" ]; then
  exit 0
fi

if ! git merge-base --is-ancestor "$head" "$target"; then
  log "La copie locale ($head) n'est pas un ancetre de origin/$BRANCH : rien n'est fait (a regler a la main)."
  echo "$target" > "$STATE/failed"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  log "Fichiers suivis modifies a la main dans $SRC : rien n'est fait (git status, puis git checkout -- . ou commit)."
  echo "$target" > "$STATE/failed"
  exit 1
fi

short=$(git rev-parse --short=12 "$target")
if ! git diff --name-only "$head" "$target" | grep -qE "$SERVER_PATHS"; then
  git merge --ff-only --quiet "$target"
  log "$short : rien qui touche le serveur, copie avancee sans reconstruire."
  exit 0
fi

log "Nouvelle version du serveur : ${head:0:12} -> $short"
git log --oneline "$head..$target" | sed 's/^/[auto-update]   /'

# 1. Sauvegarde des donnees (comptes, progres, cours…) avant de toucher a quoi que ce soit.
mkdir -p "$BACKUPS"
archive="$BACKUPS/auto-$(date +%Y%m%d-%H%M%S)-${head:0:7}.tar.gz"
tar -czf "$archive" -C "$(dirname "$DATA")" \
  --exclude="$(basename "$DATA")/tts" --exclude="$(basename "$DATA")/asr" --exclude="$(basename "$DATA")/whisper" \
  --exclude="$(basename "$DATA")/sherpa" --exclude="$(basename "$DATA")/releases" --exclude="$(basename "$DATA")/launch" \
  "$(basename "$DATA")"
log "Sauvegarde : $archive ($(du -h "$archive" | cut -f1))"
ls -1t "$BACKUPS"/auto-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

# Construit et relance le conteneur sur le commit courant ; vrai si /api/health rend ce commit.
deploy() {
  local commit
  commit=$(git rev-parse --short=12 HEAD)
  if ! (cd "$SRC/deploy" && REVIZATOR_COMMIT="$commit" docker compose up -d --build --remove-orphans); then
    log "Construction ou demarrage en echec ($commit)."
    return 1
  fi

  local waited=0 body=""
  while [ "$waited" -lt "$HEALTH_WAIT" ]; do
    body=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)
    if printf '%s' "$body" | grep -q "\"commit\":\"$commit\""; then
      log "Serveur en ligne sur $commit : $body"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done

  log "Le serveur ne repond pas sur $commit apres ${HEALTH_WAIT} s (dernier /api/health : ${body:-rien})."
  return 1
}

# 2. Mise a jour et deploiement ; en cas d'echec, retour a la version qui marchait.
git merge --ff-only --quiet "$target"
if deploy; then
  rm -f "$STATE/failed"
  log "Mise a jour terminee : $short."
  exit 0
fi

log "Retour a la version precedente (${head:0:12})."
echo "$target" > "$STATE/failed"
git reset --hard --quiet "$head"
if deploy; then
  log "Version precedente relancee. $short ne sera plus essaye tant que $BRANCH n'avance pas."
else
  log "ATTENTION : la version precedente ne redemarre pas non plus. Voir docker logs revizator ; donnees sauvegardees dans $archive."
fi
exit 1
