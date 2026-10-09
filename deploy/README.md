# Révizator — serveur (daft-lab)

Révizator seul (la page d'apprentissage de l'anglais d'Organizator), hébergé sur le mini-serveur et
utilisé depuis le **téléphone** (application web installée sur l'écran d'accueil) et depuis
l'onglet Révizator d'**Organizator sur le PC**, avec les mêmes données. La file des tâches, les sessions
d'agent et tout le reste d'Organizator **restent sur le PC** : le serveur n'en reçoit rien.

Contrat technique : [`docs/REVIZATOR-SERVER.md`](../docs/REVIZATOR-SERVER.md). Liste de contrôle pour
Claude Code installé sur le serveur : [`FINALISER.md`](FINALISER.md).

```
Téléphone (PWA) ──┐  cookie
                  ├─ https://revizator.daft-lab.fr ─→ NPM (192.168.1.11) ─→ LXC 110 revizator (192.168.1.30:8080)
PC : Organizator ─┘  jeton                                                    └─ conteneur revizator
                                                                                  ├─ claude -p (abonnement Claude)
                                                                                  ├─ voix Kokoro, dictée Parakeet/Whisper
                                                                                  └─ /opt/revizator/data → /data
```

## Accès

| Service | Adresse | Remarque |
|---|---|---|
| Révizator (public) | https://revizator.daft-lab.fr | appareils appairés seulement (jeton) |
| Révizator (LAN) | http://192.168.1.30:8080 | sans HTTPS : pas de micro ni d'installation sur le téléphone |
| Santé | https://revizator.daft-lab.fr/api/health | `{"ok":true,"version":"…"}`, sans jeton |
| SSH | `ssh root@192.168.1.30` | |
| Komodo | http://192.168.1.21:9120 | stack `revizator` sur le serveur `revizator` |
| NPM | http://192.168.1.11:81 | hôte proxy `revizator.daft-lab.fr` |
| Données | `/opt/revizator/data` (LXC) → `/data` (conteneur) | à sauvegarder |
| Sources | `/opt/revizator/src` (LXC) | clone du dépôt Organizator |

## Container LXC

| Paramètre | Valeur |
|---|---|
| CT ID | 110 *(à confirmer)* |
| Hostname | revizator |
| Type | LXC non privilégié |
| OS | Debian 13 (trixie) |
| Disk | 30 Go |
| CPU | 4 cœurs |
| RAM | 6 Go (+ 1 Go de swap) |
| IP | 192.168.1.30/24 *(à confirmer)* |
| Gateway | 192.168.1.254 |
| Nesting | oui (`nesting=1,keyctl=1`, pour Docker) |
| Onboot | oui |

Pourquoi 6 Go : le serveur .NET (~150 Mo), un `claude -p` pendant une génération (~300 à 500 Mo), les
voix Kokoro chargées (~1 Go), Parakeet (~1 Go) et Whisper si utilisé (~0,5 à 1,5 Go). Le disque : image
Docker ~1,2 Go, modèles ~1,5 Go, cache des phrases lues (plafonné par Révizator).

---

## 1. Créer le LXC (sur Proxmox, 192.168.1.10)

```bash
pveam update
pveam available --section system | grep debian-13      # repérer le nom exact du modèle
pveam download local debian-13-standard_13.1-2_amd64.tar.zst   # nom donné par la commande précédente

pct create 110 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst \
  --hostname revizator \
  --unprivileged 1 \
  --features nesting=1,keyctl=1 \
  --cores 4 --memory 6144 --swap 1024 \
  --rootfs local-lvm:30 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.30/24,gw=192.168.1.254 \
  --nameserver 192.168.1.254 \
  --ostype debian --onboot 1 \
  --password
pct start 110
pct enter 110
```

(`local-lvm` et `vmbr0` : à adapter à tes stockages et pont s'ils s'appellent autrement.)

## 2. Préparer le LXC : Docker, git, dossiers

Dans le LXC (`pct enter 110` ou `ssh root@192.168.1.30`) :

```bash
apt update && apt full-upgrade -y
apt install -y curl git ca-certificates
curl -fsSL https://get.docker.com | sh
docker run --rm hello-world                 # Docker fonctionne dans le LXC (imbrication)

mkdir -p /opt/revizator/data
chown -R 1654:1654 /opt/revizator/data     # 1654 = utilisateur « app » du conteneur
```

Puis le **Periphery de Komodo**, comme sur tes autres hôtes Docker (même méthode, même passkey). Par
exemple, en service systemd :

```bash
curl -sSL https://raw.githubusercontent.com/moghtech/komodo/main/scripts/setup-periphery.py | python3
nano /etc/komodo/periphery.config.toml      # passkeys = ["<passkey de Komodo>"], allowed_ips = ["192.168.1.21"]
systemctl enable --now periphery
```

Dans Komodo (http://192.168.1.21:9120) : **Servers › New Server** `revizator`, adresse
`https://192.168.1.30:8120` (port et protocole comme tes autres serveurs Periphery), puis vérifier
qu'il passe « OK ».

## 3. Récupérer les sources

```bash
git clone https://github.com/daftgan/Organizator.git /opt/revizator/src
```

Dépôt privé : utilise un jeton GitHub (fine-grained, lecture seule du dépôt) :
`git clone https://<utilisateur>:<jeton>@github.com/daftgan/Organizator.git /opt/revizator/src`
(ou une clé de déploiement SSH).

L'image est construite **sur le serveur** à partir de `deploy/Dockerfile` (contexte : la racine du
dépôt) : SDK .NET 8 → runtime ASP.NET 8 (Ubuntu 24.04), `ffmpeg`, `libgomp1`, Claude Code (installeur
natif officiel, `~/.local/bin/claude`), bibliothèques natives linux-x64 de Whisper.net et sherpa-onnx,
utilisateur non root `app` (UID 1654), volume `/data`, port 8080, `HEALTHCHECK` sur `/api/health`.

## 4. Jeton Claude Code (`claude setup-token`)

Révizator génère ses cours et exercices avec `claude -p`, sur **ton abonnement Claude** (pas de clé
API). Il faut un jeton longue durée (un an), créé une fois :

- sur le PC, où Claude Code est déjà installé : `claude setup-token` dans un terminal ; le navigateur
  s'ouvre, tu valides, le terminal affiche un jeton `sk-ant-oat01-…` ;
- ou plus tard dans le conteneur : `docker exec -it revizator claude setup-token` (ouvrir l'URL affichée
  sur le PC, coller le code rendu).

Ce jeton donne accès à ton abonnement : il ne va **que** dans l'environnement de la stack (jamais dans
git). Les générations faites depuis le serveur comptent dans les mêmes limites d'utilisation que ton
usage de Claude sur le PC.

## 5. Stack Komodo

**Stacks › New Stack** `revizator` :

| Champ | Valeur |
|---|---|
| Server | `revizator` |
| Mode | Files on Server |
| Run Directory | `/opt/revizator/src/deploy` |
| File Paths | `docker-compose.yml` |
| Environment | contenu ci-dessous (Komodo l'écrit dans `deploy/.env`) |

```env
REVIZATOR_PUBLIC_URL=https://revizator.daft-lab.fr
REVIZATOR_ALLOWED_ORIGINS=https://app.organizator
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
REVIZATOR_CLAUDE_VERSION=stable
TZ=Europe/Paris
```

Puis **Deploy**. Le premier déploiement construit l'image (5 à 10 min : SDK .NET, paquets NuGet,
`ffmpeg`, Claude Code). Les suivants réutilisent le cache.

Le `docker-compose.yml` (dans `deploy/`, extrait) :

```yaml
name: revizator
services:
  revizator:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
      args:
        CLAUDE_CODE_VERSION: ${REVIZATOR_CLAUDE_VERSION:-stable}
    image: revizator-server:local
    pull_policy: build
    container_name: revizator
    restart: unless-stopped
    init: true
    ports:
      - "8080:8080"
    environment:
      REVIZATOR_PUBLIC_URL: ${REVIZATOR_PUBLIC_URL:-https://revizator.daft-lab.fr}
      REVIZATOR_ALLOWED_ORIGINS: ${REVIZATOR_ALLOWED_ORIGINS:-https://app.organizator}
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
      TZ: ${TZ:-Europe/Paris}
    volumes:
      - /opt/revizator/data:/data
```

Sans Komodo, la même chose à la main :

```bash
cd /opt/revizator/src/deploy
cp .env.example .env && nano .env           # coller CLAUDE_CODE_OAUTH_TOKEN
docker compose up -d --build
```

Vérifier :

```bash
docker ps --filter name=revizator            # STATUS : Up … (healthy)
curl -s http://127.0.0.1:8080/api/health     # {"ok":true,"version":"1.0.0"}
docker logs revizator | tail                 # « Claude Code present »
docker exec revizator claude -p "Réponds seulement OK" --model haiku   # OK (le jeton marche)
```

## 6. Nginx Proxy Manager

**Hosts › Proxy Hosts › Add Proxy Host** :

| Onglet | Champ | Valeur |
|---|---|---|
| Details | Domain Names | `revizator.daft-lab.fr` |
| | Scheme / Forward Hostname / Port | `http` / `192.168.1.30` / `8080` |
| | Cache Assets | **non** |
| | Block Common Exploits | oui |
| | Websockets Support | **oui** (indispensable : tout passe par `/api/ws`) |
| SSL | SSL Certificate | Request a new SSL Certificate (Let's Encrypt), ou ton certificat `*.daft-lab.fr` |
| | Force SSL, HTTP/2 Support | oui |

HTTPS est obligatoire pour le téléphone : micro (`getUserMedia`), installation sur l'écran d'accueil et
cookie sécurisé. Le serveur lit `X-Forwarded-For` / `X-Forwarded-Proto` posés par NPM.

Vérifier depuis n'importe où : `curl -s https://revizator.daft-lab.fr/api/health`, et
`https://revizator.daft-lab.fr/` dans un navigateur → « Appareil non appairé » (normal : pas de jeton).

## 7. Importer les données du PC

À faire **avant** d'appairer les appareils (une page ouverte réécrirait son état).

Sur le PC, Révizator garde tout dans `%LOCALAPPDATA%\Organizator\`
(`C:\Users\<toi>\AppData\Local\Organizator\`). Seuls comptent :

- `learning.json` — profil, progrès, cartes, historique ;
- `learning\` — cours, exercices, bilans, documents.

Le reste (`data.json`, `settings.json`, sessions, modèles de voix…) **ne part pas** sur le serveur.

1. Fermer Organizator sur le PC (ou au moins quitter l'onglet Révizator).
2. Copier les deux éléments vers le LXC, depuis PowerShell :

   ```powershell
   ssh root@192.168.1.30 "mkdir -p /opt/revizator/data/import-pc"
   scp -r "$env:LOCALAPPDATA\Organizator\learning.json" "$env:LOCALAPPDATA\Organizator\learning" root@192.168.1.30:/opt/revizator/data/import-pc/
   ```

   Ou avec Filebrowser, si un de tes Filebrowser voit `/opt/revizator/data` : déposer `learning.json` et
   le dossier `learning` dans `/opt/revizator/data/import-pc/`.
3. Importer, serveur arrêté :

   ```bash
   cd /opt/revizator/src/deploy
   tar -czf /root/revizator-avant-import-$(date +%F).tar.gz -C /opt/revizator data   # sauvegarde
   docker compose stop
   docker compose run --rm --no-deps revizator import /data/import-pc
   chown -R 1654:1654 /opt/revizator/data
   docker compose start
   ```

   La commande affiche « Import termine : N fichier(s) » ; l'ancien contenu éventuel du serveur est
   rangé sous `/opt/revizator/data/import-backup-<date>/`.
4. Quand tout est vérifié (étape 8) : `rm -rf /opt/revizator/data/import-pc`.

## 8. Appairer les appareils

Chaque appareil a son jeton (32 octets aléatoires ; le serveur n'en garde que l'empreinte).

### Téléphone

```bash
docker exec -it revizator revizator-server token new "Téléphone"
```

La commande affiche le lien `https://revizator.daft-lab.fr/pair?token=…` et son **QR code**. Le scanner
avec l'appareil photo du téléphone → Révizator s'ouvre, l'appareil est appairé (cookie de 400 jours).

Puis l'installer :

- **Android (Chrome)** : menu ⋮ › « Ajouter à l'écran d'accueil » / « Installer l'application » ;
- **iPhone (Safari)** : bouton Partager › « Sur l'écran d'accueil ».

Ouvrir Révizator depuis l'icône : il démarre en plein écran, en ligne (pastille de connexion en haut).
Si l'application installée affiche « Appareil non appairé » (iPhone : l'application installée peut ne
pas partager les cookies de Safari), voir **Dépannage**.

### PC (Organizator)

```bash
docker exec -it revizator revizator-server token new "PC"
```

Copier la ligne « Jeton seul ». Dans Organizator : **Réglages › Révizator › Serveur Révizator** :
adresse `https://revizator.daft-lab.fr`, coller le jeton, **Tester la connexion** (→ connecté), puis
**Enregistrer**. L'onglet Révizator lit et écrit alors sur le serveur ; le reste d'Organizator ne change
pas. Vider l'adresse ramène Révizator sur les données locales du PC (qui ne sont plus à jour).

### Gérer les jetons

```bash
docker exec revizator revizator-server token list
docker exec revizator revizator-server token revoke "Téléphone"     # effet immédiat
docker exec -it revizator revizator-server token new "Téléphone"    # remplace l'ancien jeton
```

## 9. Voix et dictée

Les modèles se téléchargent **sur le serveur**, depuis Révizator (téléphone ou PC) : Réglages ›
Révizator (voix anglaises Kokoro, ~330 Mo) et Réglages › Dictée (Parakeet, ~650 Mo ; Whisper, 150 à
575 Mo, en option). Ils arrivent sous `/opt/revizator/data/tts`, `asr/`, `whisper/` et servent ensuite à
tous les appareils. Le tuteur à voix haute utilise Kokoro (voix) et Parakeet (écoute).

## 10. Mise à jour

```bash
cd /opt/revizator/src && git pull
```

Puis Komodo › stack `revizator` › **Deploy** (reconstruit l'image et recrée le conteneur ; les données
restent). Sans Komodo : `cd deploy && docker compose up -d --build`.

Après une mise à jour, le téléphone prend la nouvelle version au prochain lancement (le service worker
porte le numéro de version) ; au besoin, fermer et rouvrir l'application.

**Claude Code** ne se met pas à jour tout seul dans le conteneur : il est figé dans l'image. Pour en
changer, mettre un numéro précis dans `REVIZATOR_CLAUDE_VERSION` (ex. `2.1.42`) puis Deploy, ou
reconstruire sans cache :

```bash
cd /opt/revizator/src/deploy && docker compose build --no-cache && docker compose up -d
docker exec revizator claude --version
```

Le jeton `CLAUDE_CODE_OAUTH_TOKEN` expire au bout d'un an : refaire `claude setup-token`, mettre le
nouveau dans l'environnement de la stack, Deploy.

## 11. Sauvegarde

Tout est dans `/opt/revizator/data` :

| Élément | Rôle | À sauvegarder |
|---|---|---|
| `learning.json`, `learning/` | profil, progrès, cartes, cours, exercices | **oui** |
| `tokens.json`, `settings.json` | appareils appairés, réglages du téléphone | oui |
| `tts/`, `asr/`, `whisper/` | modèles et cache des phrases lues | non (re-téléchargeables) |
| `host.log`, `launch/`, `import-backup-*` | journal, fichiers temporaires, anciens imports | non |

Sauvegarde quotidienne (cron du LXC, 14 jours gardés) :

```bash
mkdir -p /root/backups
cat > /etc/cron.d/revizator-backup <<'EOF'
30 3 * * * root tar -czf /root/backups/revizator-$(date +\%F).tar.gz -C /opt/revizator/data learning.json learning tokens.json settings.json 2>/dev/null; find /root/backups -name 'revizator-*.tar.gz' -mtime +14 -delete
EOF
```

En plus : sauvegarde Proxmox du CT 110 (vzdump / PBS) comme les autres LXC.

Restauration : `docker compose stop`, extraire l'archive dans `/opt/revizator/data`,
`chown -R 1654:1654 /opt/revizator/data`, `docker compose start`.

## 12. Commandes utiles

```bash
docker logs -f revizator                                   # journal (aussi dans /opt/revizator/data/host.log)
docker ps --filter name=revizator                          # état et santé
docker exec revizator revizator-server token list          # appareils appairés
docker exec -it revizator revizator-server token new "X"   # nouvel appareil (QR code)
docker exec revizator revizator-server token revoke "X"    # retirer un appareil
docker exec revizator claude --version                     # version de Claude Code
docker exec revizator claude -p "OK ?" --model haiku       # le jeton Claude marche
docker stats revizator                                     # RAM / CPU
cd /opt/revizator/src/deploy && docker compose restart     # redémarrer
```

Essai complet du serveur (depuis le PC ou le LXC, Node 22) : créer un jeton `smoke`, puis

```bash
node tools/revizator-server-smoke.mjs https://revizator.daft-lab.fr <jeton>
docker exec revizator revizator-server token revoke smoke
```

## 13. Dépannage

| Symptôme | Cause probable | Remède |
|---|---|---|
| La page reste sur « connexion… » / hors ligne | WebSocket non transmis par NPM | NPM › hôte › **Websockets Support** coché ; tester : `curl -i -m 5 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "https://revizator.daft-lab.fr/api/ws?token=<jeton>"` → `101` |
| « Appareil non appairé » | pas de cookie, ou jeton révoqué | rouvrir le lien d'appairage (nouveau `token new` au besoin) |
| « Appareil non appairé » dans l'appli installée (iPhone) | cookies de Safari non partagés avec l'appli | rouvrir le lien d'appairage dans Safari puis réinstaller l'icône depuis la page appairée ; si l'appli installée ne garde toujours pas l'appairage, utiliser Révizator dans Safari |
| « Trop d'essais » (429) | 10 jetons faux en une minute depuis cette IP | attendre une minute |
| Organizator : « Serveur Révizator injoignable » | serveur arrêté, DNS, NPM | `curl https://revizator.daft-lab.fr/api/health` ; `docker ps` |
| Organizator : « jeton refusé » | jeton mal collé ou révoqué | nouveau `token new "PC"` |
| Générations en échec, journal « Claude Code introuvable » | image sans `claude` | `docker exec revizator claude --version` ; reconstruire |
| Générations en échec, « Not logged in » / 401 | `CLAUDE_CODE_OAUTH_TOKEN` absent ou expiré | `claude setup-token`, mettre le jeton dans la stack, Deploy |
| Générations en échec, « usage limit » / limite atteinte | quota de l'abonnement Claude (partagé avec le PC) | attendre la remise à zéro indiquée ; `docker logs revizator` donne l'heure |
| Pas de micro sur le téléphone | page en HTTP, ou permission refusée | passer par `https://revizator.daft-lab.fr` ; autoriser le micro pour le site |
| Conteneur `unhealthy` ou redémarre | crash, manque de RAM | `docker logs revizator` ; `dmesg \| grep -i oom` ; augmenter la RAM du CT 110 |
| `Permission denied` sur `/data` | dossier pas à l'UID 1654 | `chown -R 1654:1654 /opt/revizator/data` |
| Voix ou dictée : téléchargement en échec | Hugging Face / nuget.org injoignables depuis le LXC | `docker exec revizator curl -sI https://huggingface.co` ; DNS du LXC |
