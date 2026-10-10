# FINALISER — liste de contrôle pour Claude Code sur le serveur

Ce fichier s'adresse à **toi, Claude Code**, lancé par l'utilisateur sur son mini-serveur pour terminer
l'installation du serveur Révizator. Suis les étapes **dans l'ordre**. Chaque étape a des commandes, un
résultat attendu (**Vérifier**) et une conduite en cas d'échec. Ne passe à l'étape suivante que si la
vérification est bonne ; sinon diagnostique, corrige, et dis-le à l'utilisateur.

## 0. Contexte

- Dépôt : Organizator (application Windows WPF + WebView2). **Révizator** est sa page d'apprentissage
  de l'anglais. Le serveur Révizator (`src/Revizator.Server`, .NET 8, ASP.NET Core) sert cette page seule
  au téléphone (PWA) et à l'onglet Révizator d'Organizator sur le PC, avec un seul dossier de données.
  Les données de la file des tâches **restent sur le PC** : le serveur ne doit jamais en recevoir.
- Contrat à respecter : `docs/REVIZATOR-SERVER.md` (lis-le, surtout §§ 3, 4 et 7). Guide humain :
  `deploy/README.md` (mêmes étapes, numérotées de 1 à 13 ; ce fichier y renvoie).
- Infrastructure (dossier daft-lab de l'utilisateur) : Proxmox VE 192.168.1.10 ; LXC Debian 13 non
  privilégiés avec imbrication pour Docker ; réseau 192.168.1.0/24, passerelle 192.168.1.254 ; Komodo
  core 192.168.1.21:9120 ; Nginx Proxy Manager 192.168.1.11 (Let's Encrypt) ; domaine `daft-lab.fr`
  (wildcard `*.daft-lab.fr` vers l'IP publique, 80/443 vers NPM). Machine : Ryzen 7 255, 32 Go dont
  ~8 Go libres.
- Cible proposée (**à confirmer avec l'utilisateur avant de créer quoi que ce soit**) : CT 110,
  hostname `revizator`, IP 192.168.1.30, 4 cœurs, 6 Go de RAM, 30 Go de disque ; sources dans
  `/opt/revizator/src`, données dans `/opt/revizator/data` (propriétaire UID/GID 1654), stack Komodo
  `revizator`, hôte NPM `revizator.daft-lab.fr` → `192.168.1.30:8080`.
- Ce qui **a été vérifié dans le cloud** (sans accès à claude.ai, Hugging Face, ni aux flux RSS) :
  - `dotnet publish` du serveur, démarrage, `/api/health`, essai de fumée complet (51 contrôles depuis la connexion par compte) ;
  - l'image construite depuis une **copie** de `deploy/Dockerfile` où seuls deux points changeaient :
    le certificat du proxy du cloud, et un **faux** `claude` à la place de l'installeur. Avec cette
    image :
    - `docker compose up` (pull ignoré, construction, état `healthy`) ;
    - essai de fumée dans le conteneur (génération avec le faux `claude`) ;
    - comptes et sessions par `docker exec`, import par `docker compose run` ;
    - en-têtes de NPM simulés : cookie `secure`, WebSocket 101 pour la bonne origine, 403 sinon ;
    - page sur un écran de téléphone dans Chromium : mode serveur, en ligne, aucune erreur ;
    - chargement des bibliothèques natives dans l'image, sans réseau : sherpa-onnx 1.13.8, Whisper
      (CPU), `ffmpeg`.
- Ce qui **n'a pas pu être testé** et que tu dois vérifier ici :
  1. la construction de l'image avec le **vrai** installeur de Claude Code
     (`curl -fsSL https://claude.ai/install.sh | bash`) ;
  2. Claude Code **réel** dans le conteneur (jeton `claude setup-token`, vraies générations) ;
  3. le téléchargement et l'usage des **modèles** : voix Kokoro, Parakeet, Whisper (Hugging Face) ;
  4. les flux RSS du menu des cours ;
  5. NPM réel (WebSocket, certificat) ;
  6. un **vrai téléphone** : connexion par identifiant et mot de passe, installation (et connexion
     dans l'application installée sur iPhone), micro, tuteur à voix haute ;
  7. Organizator sur le PC branché au serveur ;
  8. la détection de langue de Whisper sous Linux (elle demande un modèle).

## Règles

- **Ne jamais exposer le serveur sans authentification.** Ne modifie pas l'authentification. Ne crée pas d'hôte
  NPM vers autre chose que le port 8080 du conteneur. N'ouvre aucun port sur la box.
- **Sauvegarde avant tout import** ou toute manipulation de `/opt/revizator/data` (étape 7).
- Les secrets (`CLAUDE_CODE_OAUTH_TOKEN`, jetons de session, jeton GitHub) ne vont **jamais** dans git
  ni dans un fichier versionné. `deploy/.env` est ignoré par git ; vérifie-le avec
  `git check-ignore deploy/.env`. N'affiche pas le jeton Claude en entier dans tes réponses.
- **Le mot de passe du compte Révizator ne passe jamais par toi.** C'est l'utilisateur qui crée son
  compte, dans **son** terminal (`docker exec -it revizator revizator-server user set <identifiant>`,
  saisie masquée). Ne lui demande pas son mot de passe, ne le tape pas, ne l'écris dans aucun fichier
  (ni `.env`, ni script, ni historique du shell), ne le passe pas en argument. Pour l'essai de fumée,
  c'est lui qui lance la commande et tape le mot de passe quand elle le demande.
- Ton propre environnement peut contenir `CLAUDE_CODE_OAUTH_TOKEN` ou d'autres variables `CLAUDE_*` :
  `docker compose` prend les variables du shell **avant** celles de `.env`. Avant chaque
  `docker compose`, vérifie `env | grep -E '^(CLAUDE_CODE_OAUTH_TOKEN|REVIZATOR_|TZ)='`. Si l'une d'elles
  est posée dans ton shell, lance compose avec `env -u CLAUDE_CODE_OAUTH_TOKEN …` (ou l'équivalent),
  sauf si c'est voulu.
- Ne fais pas de `git commit`/`git push` sans l'accord de l'utilisateur. Si tu dois corriger le code ou
  le Dockerfile, fais une modification minimale, explique-la, et mets à jour `docs/REVIZATOR-SERVER.md`
  si le contrat change. L'hôte Windows doit garder le même comportement (les fichiers de
  `src/Organizator/Services` sont partagés : toute branche Linux passe par `OperatingSystem.IsWindows()`).
- Ce qui demande l'utilisateur (interfaces web de Proxmox, Komodo ou NPM, navigateur pour
  `claude setup-token`, téléphone, PC) : donne-lui les instructions exactes, attends sa réponse, puis
  **vérifie toi-même** par une commande quand c'est possible.
- La mémoire est comptée : le LXC a 6 Go. Ne lance pas plusieurs modèles lourds en parallèle pour
  « tester vite ».

## 1. Situer la machine

Tu peux être lancé sur l'hôte Proxmox ou déjà dans le LXC.

```bash
hostname; cat /etc/os-release | head -2; id
command -v pct && pct list          # présent : tu es sur l'hôte Proxmox
command -v docker && docker version --format '{{.Server.Version}}'
free -m; nproc; df -h /
```

**Vérifier** : tu sais où tu es. Sur l'hôte Proxmox : confirme le CT ID et l'IP avec l'utilisateur
(`pct list`, et `ping -c1 192.168.1.30` doit **échouer** avant création), puis fais l'étape 1 du README
(`pct create …`, nom du modèle Debian 13 relu dans `pveam available`), démarre le CT, et continue
**dans** le LXC (`pct exec 110 -- bash` pour les commandes). Dans le LXC : vérifie 4 cœurs, ~6 Go,
30 Go (`pct config 110` depuis l'hôte : `features: keyctl=1,nesting=1`, `onboot: 1`).

## 2. Docker, dossiers, Komodo Periphery

Suivre README § 2.

**Vérifier** :

```bash
docker run --rm hello-world | grep -q "Hello from Docker" && echo DOCKER-OK
docker compose version
stat -c '%u:%g' /opt/revizator/data          # 1654:1654
```

Periphery : demande à l'utilisateur d'ajouter le serveur dans Komodo ; vérifie
`systemctl is-active periphery` (ou le conteneur Periphery, selon sa méthode habituelle : demande-lui).

## 3. Sources

README § 3.

```bash
cd /opt/revizator/src && git log -1 --oneline && git status --short | head
ls deploy/Dockerfile deploy/docker-compose.yml src/Revizator.Server/Revizator.Server.csproj
git check-ignore deploy/.env                 # doit afficher deploy/.env
```

**Vérifier** : les fichiers existent, l'arbre est propre.

## 4. Construire l'image (non testé dans le cloud avec le vrai installeur)

```bash
cd /opt/revizator/src/deploy
cp -n .env.example .env                       # CLAUDE_CODE_OAUTH_TOKEN encore vide : normal ici
docker compose build 2>&1 | tee /tmp/revizator-build.log
```

**Vérifier** :

```bash
grep -iE "error|failed" /tmp/revizator-build.log | head     # rien de bloquant
docker run --rm --entrypoint claude revizator-server:local --version            # une version de Claude Code
docker run --rm --entrypoint sh revizator-server:local -c 'id; command -v claude ffmpeg curl; ls /app/runtimes/linux-x64 /app/sherpa/linux-x64'
#   uid=1654(app) ; /home/app/.local/bin/claude ; /usr/bin/ffmpeg ; libwhisper.so … ; libsherpa-onnx-c-api.so …
docker images revizator-server:local --format '{{.Size}}'   # ~1,2 Go
```

En cas d'échec :
- installeur de Claude Code : lis la sortie (réseau, glibc, `HOME` non inscriptible). L'installeur
  officiel s'appelle par `curl -fsSL https://claude.ai/install.sh | bash -s -- <version>` (redirection
  vers `downloads.claude.ai`). S'il a changé de forme, adapte la ligne `RUN curl …` du Dockerfile au
  minimum, en gardant : utilisateur non root, binaire dans `~/.local/bin` (dans le `PATH` de l'image),
  `DISABLE_AUTOUPDATER=1`.
- `dotnet restore` : accès à nuget.org depuis le LXC.

## 5. Premier lancement, sans jeton Claude

```bash
cd /opt/revizator/src/deploy && docker compose up -d
sleep 20; docker ps --filter name=revizator --format '{{.Status}}'      # Up … (healthy)
curl -s http://127.0.0.1:8080/api/health                                # {"ok":true,"version":"1.0.0"}
docker logs revizator 2>&1 | tail -5                                    # « claude detecte : /home/app/.local/bin/claude », « Claude Code present »
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:8080/   # 302 …/login (pas de session)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/login    # 200 (page de connexion)
docker logs revizator 2>&1 | grep "Aucun compte"                        # normal tant que le compte n'est pas créé
ls -la /opt/revizator/data                                              # fichiers à 1654
```

**Vérifier** : tout ce qui précède. Ensuite, demande à l'utilisateur s'il gère la stack par Komodo
(README § 5, mode « Files on Server », run directory `/opt/revizator/src/deploy`) : dans ce cas, fais
`docker compose down` et laisse-le créer la stack et cliquer Deploy, puis revérifie les mêmes points.
Le `.env` écrit par Komodo remplace le tien : vérifie qu'il contient les bonnes valeurs
(`grep -c CLAUDE_CODE_OAUTH_TOKEN deploy/.env`, sans afficher la valeur).

## 6. Jeton Claude Code, compte Révizator et vraie génération (non testé dans le cloud)

1. Demande à l'utilisateur de lancer `claude setup-token`, sur le PC ou dans le conteneur
   (`docker exec -it revizator claude setup-token` : il ouvre l'URL dans son navigateur et colle le code).
   Il obtient un jeton `sk-ant-oat01-…`.
2. Il le met dans l'environnement de la stack Komodo (ou toi dans `deploy/.env`, `chmod 600`), puis
   Deploy (ou `docker compose up -d`).
3. **Vérifier** :

   ```bash
   docker exec revizator sh -c 'test -n "$CLAUDE_CODE_OAUTH_TOKEN" && echo TOKEN-SET'
   docker exec revizator claude -p "Réponds seulement OK" --model haiku     # OK
   ```

   « Invalid API key » / « Not logged in » : jeton mal copié ou variable masquée par ton shell (Règles).
4. **Créer le compte (action de l'utilisateur).** Demande-lui de choisir un identifiant (minuscules,
   chiffres, `.`, `_`, `-`) et de lancer lui-même, dans un terminal sur le LXC :

   ```bash
   docker exec -it revizator revizator-server user set <identifiant>
   ```

   La commande demande le mot de passe deux fois, sans l'afficher (10 caractères au moins). Rappelle-lui
   de ne pas te le donner (Règles). **Vérifier** :

   ```bash
   docker exec revizator revizator-server user list     # <identifiant>  cree le …, 0 session(s)
   stat -c '%a %u' /opt/revizator/data/users.json         # 600 1654
   ```

5. Essai de fumée complet, **avec** la génération (Node 22 sur le LXC, ou depuis le PC). L'essai
   réécrit `learning.json` tel quel. Pour ne rien risquer, fais-le avant l'import (étape 7), sur un
   dossier de données encore vide, avec `--allow-empty-save`. Il demande le mot de passe du compte :
   c'est donc l'**utilisateur** qui le lance dans son terminal (tu lui donnes la commande) :

   ```bash
   cd /opt/revizator/src
   node tools/revizator-server-smoke.mjs http://127.0.0.1:8080 <identifiant> --allow-empty-save
   ```

   Il ouvre deux sessions et les ferme à la fin. **Vérifier** (il te recopie la fin de la sortie) :
   « Tout est bon. » et code de sortie 0 ; les sections « Connexion », « WebSocket » et « Génération
   (Claude Code) » passent (cardcheck, modèle haiku). `docker logs revizator | grep "Revizator cardcheck"`
   montre la durée ; `docker exec revizator revizator-server session list` ne garde aucune session de
   l'essai.
   Pas de Node 22 : `apt install -y nodejs` donne souvent une version trop ancienne ; utilise plutôt
   `docker run --rm -it --network host -v /opt/revizator/src/tools:/t:ro node:22-slim node /t/revizator-server-smoke.mjs …`
   (`-it` : pour que le mot de passe puisse être tapé).

## 7. Import des données du PC (sauvegarde d'abord)

README § 7. L'utilisateur copie `learning.json` et `learning\` de `%LOCALAPPDATA%\Organizator\` vers
`/opt/revizator/data/import-pc/` (scp ou Filebrowser), **Organizator fermé**.

```bash
ls -la /opt/revizator/data/import-pc/ && python3 -m json.tool /opt/revizator/data/import-pc/learning.json > /dev/null && echo JSON-OK
tar -czf /root/revizator-avant-import-$(date +%F-%H%M).tar.gz -C /opt/revizator data && ls -la /root/revizator-avant-import-*
cd /opt/revizator/src/deploy
docker compose stop
docker compose run --rm --no-deps revizator import /data/import-pc
chown -R 1654:1654 /opt/revizator/data
docker compose start
```

**Vérifier** : « Import termine : N fichier(s) » (N ≈ nombre de fichiers sous `import-pc/learning`) ;
`cmp /opt/revizator/data/learning.json /opt/revizator/data/import-pc/learning.json` ; conteneur
`healthy`. Ne supprime `import-pc/` qu'après la vérification sur le téléphone (étape 9).

## 8. Nginx Proxy Manager (action de l'utilisateur)

Donne-lui le tableau du README § 6 (Websockets Support **coché**, Cache Assets **décoché**, Block Common
Exploits, Let's Encrypt, Force SSL). Puis **vérifie** :

```bash
curl -s https://revizator.daft-lab.fr/api/health                                  # {"ok":true,…}
curl -s -o /dev/null -w '%{http_code}\n' https://revizator.daft-lab.fr/           # 302 (vers /login)
curl -sI https://revizator.daft-lab.fr/login | grep -iE '^(HTTP|referrer-policy|content-security)'   # 200, same-origin, CSP
curl -s -o /dev/null -w '%{http_code}\n' https://revizator.daft-lab.fr/learning.json   # 404 : jamais servi
curl -s -o /dev/null -w '%{http_code}\n' https://revizator.daft-lab.fr/tokens.json     # 404
curl -s -o /dev/null -w '%{http_code}\n' https://revizator.daft-lab.fr/users.json      # 404
curl -s -o /dev/null -w '%{http_code}\n' https://revizator.daft-lab.fr/learn/x.json    # 401 sans session
```

Puis l'essai de fumée **par l'adresse publique**, lancé par l'utilisateur avec son compte
(`node tools/revizator-server-smoke.mjs https://revizator.daft-lab.fr <identifiant>`) : il doit dire
« Tout est bon. » — il passe par NPM, WebSocket et cookie `Secure` compris. Le journal doit montrer les
vraies IP des clients (`docker logs revizator | grep -E "Connexion (:|refusee)"` : l'IP d'où l'essai a
été lancé, pas celle de NPM).

## 9. Téléphone (action de l'utilisateur)

Demande-lui de vérifier, dans l'ordre :

1. `https://revizator.daft-lab.fr` dans le navigateur du téléphone affiche la page de connexion ; avec
   son identifiant et son mot de passe, **Se connecter** ouvre Révizator, avec ses données importées
   (profil, progrès). Côté serveur : `docker logs revizator | grep "Connexion :"` (son identifiant,
   l'appareil, son IP publique en 4G) et `docker exec revizator revizator-server session list` ;
2. installation sur l'écran d'accueil (README § 8), puis ouverture par l'icône : plein écran, en ligne ;
   **iPhone** : si l'appli installée affiche la page de connexion, il s'y connecte une fois (la page
   fonctionne dans l'appli) ; vérifie qu'il reste connecté après avoir fermé puis rouvert l'appli, et
   note le résultat dans le compte rendu ;
3. Réglages › Révizator › **Compte** : son identifiant s'affiche ; **Se déconnecter** ramène à la page de
   connexion (« Vous êtes déconnecté »), puis il se reconnecte ;
4. Réglages › Révizator : **télécharger les voix** (Kokoro, ~330 Mo) ; Réglages › Dictée : **Parakeet**
   (~650 Mo). Suis-le côté serveur :

   ```bash
   docker logs -f revizator | grep -E "TTS|ASR|Sherpa|Whisper"
   #   « Sherpa : runtime 1.13.8 copie depuis /app/sherpa/linux-x64 », « TTS : telechargement des voix … »,
   #   « ASR : modele … telecharge en … s », puis « … charge en … ms »
   du -sh /opt/revizator/data/tts /opt/revizator/data/asr
   docker stats --no-stream revizator          # RAM après chargement : doit rester nettement sous 6 Go
   ```

5. une phrase lue à voix haute (bouton d'écoute) : le son arrive ;
6. le **tuteur** à voix haute (micro autorisé) : il entend, répond, parle ; une interruption fonctionne ;
7. **générer un exercice** et **un cours du jour** (cours : utilise le menu RSS ; journal :
   `Revizator lesson : …` sans « menu RSS indisponible », sinon vérifier l'accès aux flux depuis le
   LXC) ; `docker logs revizator | grep -E "Revizator (lesson|exercise|toeic|sw|grade|tutor|cardcheck|cardfix) :"` montre les durées ;
   aucune ligne « echec apres » ;
8. une dictée (Parakeet) reconnue correctement.

Whisper (optionnel) : s'il le télécharge, vérifie qu'une transcription d'un enregistrement fonctionne
et que la langue détectée est juste (non testé sous Linux).

## 10. PC (action de l'utilisateur)

Dans Organizator › Réglages › Révizator › Serveur Révizator, il saisit l'adresse
`https://revizator.daft-lab.fr`, son identifiant et son mot de passe, puis **Se connecter** (la carte
affiche ensuite « connecté en tant que <identifiant> ») ; **Tester la connexion** → « Connecté ».
**Vérifier** : `docker logs revizator | grep -E "Connexion : .*Organizator \(PC\)"` puis
`grep "WebSocket ouvert (.*Organizator (PC)"` ; le mot de passe n'est pas gardé sur le PC (il peut
vérifier que `%LOCALAPPDATA%\Organizator\settings.json` ne contient que `revizatorServerToken` et
`revizatorServerLogin`) ; une réponse faite sur le PC apparaît sur le
téléphone après retour à l'accueil (événement `learnChanged`), et inversement ; l'onglet File
d'Organizator fonctionne comme avant (rien de la file ne doit apparaître dans `/opt/revizator/data` :
`ls /opt/revizator/data` ne contient ni `data.json` ni `sessions`).

## 11. Sauvegarde et finitions

- Crée la sauvegarde quotidienne du README § 11, lance-la une fois à la main et vérifie l'archive
  (`tar -tzf … | head`).
- Propose à l'utilisateur d'ajouter le CT 110 à ses sauvegardes Proxmox.
- `rm -rf /opt/revizator/data/import-pc` (après accord).
- `docker exec revizator revizator-server session list` : seules les sessions du téléphone et du PC
  (aucune de l'essai de fumée) ; `user list` : le seul compte de l'utilisateur.
- Vérifie le redémarrage : `pct reboot 110` depuis l'hôte (ou `reboot` du LXC, avec accord), puis
  conteneur `healthy` et page joignable sans action.

## 12. Compte rendu final

Donne à l'utilisateur : ce qui marche (avec la preuve : commande et sortie), ce qui a échoué ou reste
douteux, toute modification faite au dépôt (fichiers, raison ; mise à jour du contrat le cas échéant),
la RAM observée avec les modèles chargés, et les tâches qui restent pour lui.
