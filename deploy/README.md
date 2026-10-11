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
PC : Organizator ─┘  jeton de session                                         └─ conteneur revizator
                                                                                  ├─ claude -p (abonnement Claude)
                                                                                  ├─ voix Kokoro, dictée Parakeet/Whisper
                                                                                  └─ /opt/revizator/data → /data
```

## Accès

| Service | Adresse | Remarque |
|---|---|---|
| Révizator (public) | https://revizator.daft-lab.fr | identifiant et mot de passe (page `/login`) |
| Révizator (LAN) | http://192.168.1.30:8080 | sans HTTPS : pas de micro ni d'installation sur le téléphone |
| Santé | https://revizator.daft-lab.fr/api/health | `{"ok":true,"version":"…","commit":"…","builtAt":"…","startedAt":"…"}`, sans connexion |
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

**Copier le jeton sur une seule ligne.** Dans un terminal étroit, il s'affiche coupé en deux : recolle
les deux morceaux, sans espace, sans « # » ni guillemets devant. Un jeton mal copié donne « 401 Invalid
bearer token » à chaque génération ; le serveur le signale au démarrage (`docker logs revizator` :
« CLAUDE_CODE_OAUTH_TOKEN ne commence pas par sk-ant- »), et retire de lui-même les blancs d'un jeton
coupé.

Ce jeton donne accès à ton abonnement : il va dans **`/opt/revizator/secrets.env`**, hors du dépôt et
hors de ce que Komodo réécrit (Komodo écrit l'onglet « Environment » dans `deploy/.env`, lisible par
tous, à chaque Deploy) :

```bash
install -m 600 /dev/null /opt/revizator/secrets.env
nano /opt/revizator/secrets.env      # une ligne : CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…
```

Le `docker-compose.yml` le lit par `env_file` ; il n'est jamais dans git ni dans Komodo. Les générations
faites depuis le serveur comptent dans les mêmes limites d'utilisation que ton usage de Claude sur le PC.

### Jeton GitHub (installateur et mises à jour d'Organizator)

Le serveur sert aussi l'installateur Windows d'Organizator : lien sur la page de connexion, carte
« Organizator pour Windows » sur un PC, et c'est là que chaque Organizator vérifie ses mises à jour. Il
le prend dans la dernière Release GitHub du dépôt, relue toutes les heures. Le dépôt étant privé, il lui
faut un jeton en lecture seule :

1. GitHub › Settings › Developer settings › **Fine-grained tokens** › Generate new token : dépôt
   `daftgan/Organizator` seulement, permission **Contents : Read-only**, expiration au choix.
2. Une ligne de plus dans `/opt/revizator/secrets.env` : `REVIZATOR_GITHUB_TOKEN=github_pat_…`
3. Deploy. `docker logs revizator` dit ensuite « Installateur d'Organizator 1.0.0 disponible (62 Mo) ».

Sans jeton, le serveur sert le plus récent des `Organizator-Setup-<version>.exe` déposés à la main dans
`/opt/revizator/data/releases/`. `REVIZATOR_RELEASES_REPO` change le dépôt lu (`none` : dossier seul).

## 5. Stack Komodo

**Stacks › New Stack** `revizator` :

| Champ | Valeur |
|---|---|
| Server | `revizator` |
| Mode | Files on Server |
| Run Directory | `/opt/revizator/src/deploy` |
| File Paths | `docker-compose.yml` |
| Environment | contenu ci-dessous (Komodo l'écrit dans `deploy/.env` : rien de secret) |

```env
REVIZATOR_PUBLIC_URL=https://revizator.daft-lab.fr
REVIZATOR_ALLOWED_ORIGINS=https://app.organizator
REVIZATOR_TRUSTED_PROXIES=192.168.1.11
REVIZATOR_CLAUDE_VERSION=stable
TZ=Europe/Paris
```

Le jeton de Claude Code n'est **pas** ici : il est dans `/opt/revizator/secrets.env` (§ 4).

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
      TZ: ${TZ:-Europe/Paris}
    env_file:                                  # le jeton de Claude Code, hors de .env
      - path: /opt/revizator/secrets.env
        required: false
    volumes:
      - /opt/revizator/data:/data
```

Sans Komodo, la même chose à la main :

```bash
cd /opt/revizator/src/deploy
cp .env.example .env                        # réglages (rien de secret)
install -m 600 /dev/null /opt/revizator/secrets.env && nano /opt/revizator/secrets.env   # le jeton (§ 4)
docker compose up -d --build
```

Vérifier :

```bash
docker ps --filter name=revizator            # STATUS : Up … (healthy)
curl -s http://127.0.0.1:8080/api/health     # {"ok":true,"version":"1.0.0","commit":"…",…}
docker logs revizator | tail                 # « Claude Code present »
docker exec revizator claude -p "Réponds seulement OK" --model haiku   # OK (le jeton marche)
```

## 6. Nginx Proxy Manager

**Hosts › Proxy Hosts › Add Proxy Host** :

| Onglet | Champ | Valeur |
|---|---|---|
| Details | Domain Names | `revizator.daft-lab.fr` |
| | Scheme / Forward Hostname / Port | `http` / `192.168.1.30` / `8080` |
| | Cache Assets | **non** (sinon NPM garde et ressert les fichiers privés `/learn`, `/t/…` sans session) |
| | Block Common Exploits | oui |
| | Websockets Support | **oui** (indispensable : tout passe par `/api/ws`) |
| SSL | SSL Certificate | Request a new SSL Certificate (Let's Encrypt), ou ton certificat `*.daft-lab.fr` |
| | Force SSL, HTTP/2 Support | oui |

HTTPS est obligatoire pour le téléphone : micro (`getUserMedia`), installation sur l'écran d'accueil et
cookie sécurisé. Le serveur lit `X-Forwarded-For` / `X-Forwarded-Proto` posés par NPM, et seulement
quand la connexion vient d'une adresse de `REVIZATOR_TRUSTED_PROXIES` (défaut `private` : tout le réseau
privé). Pour durcir : `REVIZATOR_TRUSTED_PROXIES=192.168.1.11` (NPM seul), puis vérifier dans
`docker logs revizator` qu'une connexion depuis la 4G affiche l'adresse publique du téléphone
(`Connexion : <identifiant> (iPhone Safari, <IP publique>)`) ; s'il affiche `192.168.1.11` ou `172.x`,
revenir à `private` (Docker ne voit pas NPM sous sa propre adresse).

**Depuis la maison, tous les appareils ont la même adresse.** Un téléphone ou le PC sur le Wi-Fi qui
ouvre `https://revizator.daft-lab.fr` sort par la Freebox et revient par la redirection de port (NAT en
boucle) : le serveur les voit tous sous `192.168.1.254`. Sans gravité (le verrou par compte reste par
compte), mais la limite de 10 échecs par minute est alors commune à toute la maison. Pour que chacun
garde son adresse, ajouter dans Pi-hole un enregistrement local **Local DNS › DNS Records** :
`revizator.daft-lab.fr` → `192.168.1.11` (NPM). Les appareils de la maison parlent alors directement à NPM,
avec le même certificat ; dehors, rien ne change.

Le mot de passe ne passe jamais dans une adresse (formulaire POST, ou JSON pour le PC). Le **jeton de
session** d'Organizator sur le PC, lui, y passe (`/api/ws?token=`, médias `/t/<jeton>/`) : le journal
d'accès de NPM (`/data/logs/proxy-host-*_access.log`) le contient. Garder NPM et ses journaux fermés au
reste du réseau ; en cas de doute, fermer la session (`revizator-server session revoke …`, ou « Se
déconnecter » dans Organizator) et se reconnecter.

Vérifier depuis n'importe où : `curl -s https://revizator.daft-lab.fr/api/health`, et
`https://revizator.daft-lab.fr/` dans un navigateur → renvoi vers la page de connexion `/login`
(normal : pas encore de session).

## 7. Importer les données du PC

À faire **avant** de connecter les appareils (une page ouverte réécrirait son état).

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
   rangé sous `/opt/revizator/data/import-backup-<date>/`. Sans compte encore, les données attendent à
   la racine de `/opt/revizator/data` et vont au **premier compte créé** (étape 8), dans
   `users/<identifiant>/`, à sa première connexion. Une fois des comptes créés, nommer celui qui reçoit
   l'import : `… revizator import /data/import-pc <identifiant>` (facultatif s'il n'y en a qu'un).
4. Quand tout est vérifié (étape 8) : `rm -rf /opt/revizator/data/import-pc`.

## 8. Créer le compte et connecter les appareils

### Créer le compte

Le premier compte créé est le vôtre : il reprend les données importées (étape 7) et **administre** le
serveur. Les autres comptes — un par personne, chacun avec ses données, tous dans l'onglet **Classement** —
se créent ensuite plus simplement depuis l'onglet **Admin** de Révizator (liste des personnes, mots de
passe, droits, modèles de Claude Code) ; la commande ci-dessous reste utile pour le premier compte ou en
dépannage. `docker exec -it revizator revizator-server user admin <identifiant> on` donne le droit
d'administrer à un autre compte.

Un compte = un identifiant et un mot de passe. Sur le LXC (`<conteneur>` = `revizator`) :

```bash
docker exec -it revizator revizator-server user set <identifiant>
```

La commande demande le mot de passe **deux fois**, sans l'afficher (n'importe lequel, non vide). L'identifiant
est mis en minuscules : lettres, chiffres, `.`, `_`, `-`, 40 caractères au plus. Le serveur n'en garde
qu'une empreinte (PBKDF2-SHA256, 600 000 itérations, sel de 16 octets) dans
`/opt/revizator/data/users.json` (lisible par le seul utilisateur du conteneur). Il n'y a ni page
d'inscription ni « mot de passe oublié » : tout se fait par cette commande.

La même commande, sur un compte existant, **change le mot de passe** et ferme toutes ses sessions (les
appareils ouverts reviennent à la page de connexion). Pour un script : `--password-stdin` lit le mot de
passe sur l'entrée standard (`printf '%s\n' "$MDP" | docker exec -i revizator revizator-server user set
<identifiant> --password-stdin`) ; ne jamais le mettre sur la ligne de commande ni dans un fichier.

### Téléphone

Le plus simple, depuis Organizator déjà connecté (§ PC ci-dessous) :

1. Organizator › **Réglages › Révizator › Ajouter un téléphone** : un QR code s'affiche (valable
   10 minutes, pour un seul appareil).
2. Le scanner avec l'appareil photo du téléphone, ouvrir le lien, toucher **Connecter cet appareil** →
   Révizator s'ouvre, connecté (session de 400 jours, cookie `HttpOnly`), sans identifiant ni mot de passe.
3. Sur l'accueil, la carte **Installer Révizator** :
   - **Android (Chrome)** : bouton **Installer l'application** (ou, à défaut, menu ⋮ › « Installer
     l'application ») ;
   - **iPhone (Safari)** : bouton Partager › « Sur l'écran d'accueil », comme indiqué sur la carte.

Sans QR code : ouvrir **https://revizator.daft-lab.fr**, se connecter par identifiant et mot de passe, ou
par **J'ai un code d'appairage** en tapant le code affiché sous le QR code.

Ouvrir Révizator depuis l'icône : il démarre en plein écran, en ligne (pastille de connexion en haut).
Si l'application installée affiche la page de connexion (iPhone : elle ne partage pas toujours les
cookies de Safari), s'y connecter une fois de plus : **J'ai un code d'appairage** et un nouveau code
d'Organizator, ou le mot de passe.

Réglages › Révizator › **Compte** : l'identifiant connecté et **Se déconnecter** (ferme la session de
ce téléphone seulement ; les autres appareils restent connectés).

### PC (Organizator)

Dans Organizator : **Réglages › Révizator › Serveur Révizator** : adresse
`https://revizator.daft-lab.fr`, identifiant, mot de passe, **Se connecter**. Organizator n'enregistre
que le jeton de session rendu par le serveur (`revizatorServerToken` dans son `settings.json`, avec
l'identifiant pour l'affichage) ; le mot de passe n'est **jamais** enregistré. L'onglet Révizator lit et
écrit alors sur le serveur ; le reste d'Organizator ne change pas.

Une fois connecté, la carte montre le serveur et le compte, **Tester la connexion** (→ « Connecté ») et
**Se déconnecter** : la session est fermée sur le serveur et Révizator revient aux données locales du PC
(qui ne sont plus à jour).

### Gérer les comptes et les sessions

Chaque connexion ouvre une **session**, nommée « compte · appareil · date #xxxx » (par exemple
`moi · iPhone Safari · 2026-10-11 08:12 #3fa2`, ou `… · Organizator (PC) · …`) ; 50 sessions par
compte au plus (les plus anciennes partent).

```bash
docker exec revizator revizator-server user list                     # comptes et nombre de sessions
docker exec revizator revizator-server session list                  # sessions ouvertes
docker exec revizator revizator-server session revoke "moi · iPhone"   # par son nom ou son début (une seule)
docker exec revizator revizator-server session revoke --all          # toutes : chaque appareil se reconnecte
docker exec -it revizator revizator-server user set <identifiant>    # nouveau mot de passe (ferme ses sessions)
docker exec revizator revizator-server user remove <identifiant>     # supprime le compte et ses sessions
```

Tout prend effet aussitôt, WebSocket déjà ouverts compris (fermés en 20 s au plus).

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

Pour vérifier que la mise à jour est en ligne : **Réglages › Révizator › Compte › Serveur** sur le téléphone
(ou **Tester la connexion** dans Organizator) affiche la version, le commit construit (les 7 premiers caractères,
comme sur GitHub), l'heure de construction de l'image et celle du démarrage du serveur ; `curl -s
https://revizator.daft-lab.fr/api/health` donne la même chose. Le commit est lu dans le `.git` du dossier
construit : un `git pull` oublié se voit tout de suite.

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
nouveau dans `/opt/revizator/secrets.env` (une seule ligne), Deploy.

**Organizator**, lui, n'a rien à redéployer : une nouvelle Release GitHub arrive sur le serveur dans
l'heure, puis sur chaque PC (vérification au démarrage et toutes les six heures, installation à la
fermeture d'Organizator).

## 11. Sauvegarde

Tout est dans `/opt/revizator/data` :

| Élément | Rôle | À sauvegarder |
|---|---|---|
| `users/<compte>/` (`learning.json`, `learning/`) | profil, progrès, cartes, cours, exercices de chaque compte | **oui** |
| `users.json`, `tokens.json`, `settings.json`, `admin.json` | comptes (mots de passe hachés, administrateurs), sessions ouvertes, réglages du téléphone, modèles fixés par l'administrateur | oui |
| `tts/`, `asr/`, `whisper/` | modèles et cache des phrases lues | non (re-téléchargeables) |
| `host.log`, `launch/`, `import-backup-*` | journal, fichiers temporaires, anciens imports | non |

Sauvegarde quotidienne (cron du LXC, 14 jours gardés) :

```bash
mkdir -p /root/backups
cat > /etc/cron.d/revizator-backup <<'EOF'
30 3 * * * root tar -czf /root/backups/revizator-$(date +\%F).tar.gz -C /opt/revizator/data learning.json learning users.json tokens.json settings.json 2>/dev/null; find /root/backups -name 'revizator-*.tar.gz' -mtime +14 -delete
EOF
```

En plus : sauvegarde Proxmox du CT 110 (vzdump / PBS) comme les autres LXC.

Restauration : `docker compose stop`, extraire l'archive dans `/opt/revizator/data`,
`chown -R 1654:1654 /opt/revizator/data`, `docker compose start`.

## 12. Commandes utiles

```bash
docker logs -f revizator                                   # journal (aussi dans /opt/revizator/data/host.log)
docker ps --filter name=revizator                          # état et santé
docker exec revizator revizator-server user list           # comptes
docker exec revizator revizator-server session list        # sessions ouvertes (compte, appareil, date)
docker exec revizator revizator-server session revoke "X"  # fermer une session (nom ou début)
docker exec -it revizator revizator-server user set <id>   # créer un compte / changer son mot de passe
docker exec revizator claude --version                     # version de Claude Code
docker exec revizator claude -p "OK ?" --model haiku       # le jeton Claude marche
docker stats revizator                                     # RAM / CPU
cd /opt/revizator/src/deploy && docker compose restart     # redémarrer
```

Essai complet du serveur (depuis le PC ou le LXC, Node 22), avec un compte existant (le mot de passe
est demandé ; il peut aussi venir de `REVIZATOR_PASSWORD`, jamais de la ligne de commande) :

```bash
node tools/revizator-server-smoke.mjs https://revizator.daft-lab.fr <identifiant>
```

L'essai ouvre deux sessions et les ferme à la fin ; il ne laisse rien derrière lui.

## 13. Dépannage

| Symptôme | Cause probable | Remède |
|---|---|---|
| La page reste sur « connexion… » / hors ligne | WebSocket non transmis par NPM | NPM › hôte › **Websockets Support** coché ; tester : `curl -i -m 5 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "https://revizator.daft-lab.fr/api/ws"` → `401` (le WebSocket arrive bien au serveur, qui demande une session) ; `400` ou une page de NPM : WebSocket non transmis |
| La page de connexion revient sans cesse | session fermée (déconnexion, mot de passe changé, `session revoke`), ou cookies bloqués | se reconnecter ; autoriser les cookies pour le site |
| Page de connexion dans l'appli installée (iPhone) | cookies de Safari non partagés avec l'appli | se connecter dans l'application elle-même |
| « Identifiant ou mot de passe incorrect » | faute de frappe ; l'identifiant est en minuscules | réessayer ; au besoin `docker exec -it revizator revizator-server user set <identifiant>` |
| « Trop d'essais » | 10 échecs en une minute depuis cette adresse (attendre une minute), ou 5 échecs de suite sur ce compte (verrou de 1 min, puis 2, 4… jusqu'à 15 min) | attendre ; une connexion réussie remet le compteur du compte à zéro |
| « Requête refusée : rouvrez cette page » | formulaire envoyé depuis une autre origine, ou page trop ancienne | rouvrir `https://revizator.daft-lab.fr/login` |
| « Aucun compte n'existe encore » sur la page de connexion | `users.json` vide | `docker exec -it revizator revizator-server user set <identifiant>` |
| Organizator : « Serveur Révizator injoignable » | serveur arrêté, DNS, NPM | `curl https://revizator.daft-lab.fr/api/health` ; `docker ps` |
| Organizator : « Refusé » | mauvais mot de passe, ou session fermée sur le serveur | « Se déconnecter » si besoin, puis se reconnecter |
| Générations en échec, journal « Claude Code introuvable » | image sans `claude` | `docker exec revizator claude --version` ; reconstruire |
| Générations en échec, « Not logged in » / 401 | `CLAUDE_CODE_OAUTH_TOKEN` absent, mal copié (coupé, « # » devant) ou expiré | `docker logs revizator` (avertissement au démarrage) ; `claude setup-token`, jeton sur une seule ligne dans `/opt/revizator/secrets.env`, Deploy |
| Générations en échec, « usage limit » / limite atteinte | quota de l'abonnement Claude (partagé avec le PC) | attendre la remise à zéro indiquée ; `docker logs revizator` donne l'heure |
| Pas de micro sur le téléphone | page en HTTP, ou permission refusée | passer par `https://revizator.daft-lab.fr` ; autoriser le micro pour le site |
| Conteneur `unhealthy` ou redémarre | crash, manque de RAM | `docker logs revizator` ; `dmesg \| grep -i oom` ; augmenter la RAM du CT 110 |
| `Permission denied` sur `/data` | dossier pas à l'UID 1654 | `chown -R 1654:1654 /opt/revizator/data` |
| Voix ou dictée : téléchargement en échec | Hugging Face / nuget.org injoignables depuis le LXC | `docker exec revizator curl -sI https://huggingface.co` ; DNS du LXC |
