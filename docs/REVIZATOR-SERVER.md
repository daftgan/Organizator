# Révizator serveur — contrat d'architecture

Révizator seul, hébergé sur un serveur Linux (le mini-serveur `daft-lab`), utilisable depuis le
téléphone (application web installable, PWA) **et** depuis l'onglet Révizator d'Organizator sur le PC.
La file des tâches, les sessions d'agent, `data.json` et tout le reste d'Organizator **restent sur le
PC** : le serveur n'en reçoit jamais rien et n'expose aucun moyen d'y accéder.

Ce document est le contrat que suivent le serveur, la page et le déploiement. Le modifier d'abord si
une décision change.

## 1. Vue d'ensemble

```
Téléphone (PWA)  ─┐   identifiant + mot de passe → cookie de session rz_token
                  ├─ https://revizator.daft-lab.fr ─→ Nginx Proxy Manager ─→ conteneur revizator-server :8080
PC : Organizator ─┘   identifiant + mot de passe → jeton de session dans l'URL (WebSocket ?token=, médias /t/<jeton>/...)
   onglet Révizator → serveur (si configuré)          revizator-server (.NET 8, Linux, ASP.NET Core)
   tout le reste → hôte WPF local                       ├─ services Révizator partagés avec l'hôte WPF
                                                        ├─ claude -p (Claude Code, abonnement, CLAUDE_CODE_OAUTH_TOKEN)
                                                        ├─ sherpa-onnx (Kokoro, Parakeet), Whisper.net, ffmpeg
                                                        └─ /data (volume) : users/<compte>/{learning.json, learning/}, tts/, modèles…
```

Une seule source de vérité : le dossier de données du serveur. Le PC et le téléphone y lisent et y
écrivent ; il n'y a pas de synchronisation de fichiers. Chaque compte a son espace (§ 6 bis) : ses données
ne sont lues et écrites que par ses propres sessions.

## 2. Code partagé

- Nouveau projet `src/Revizator.Server/Revizator.Server.csproj` (`net8.0`, `Microsoft.NET.Sdk.Web`,
  exécutable `revizator-server`), ajouté à `Organizator.sln`.
- Il **compile les mêmes fichiers source** que l'hôte WPF pour Révizator, par liens
  (`<Compile Include="..\Organizator\Services\LearningAgent.cs" Link="Shared\LearningAgent.cs" />`) :
  pas de copie, pas de bibliothèque intermédiaire. Une correction profite aux deux.
- Ce qui dépend de Windows (recherche de `claude.exe`, DLL natives win-x64 de Whisper et sherpa-onnx,
  décodage Media Foundation de NAudio, voix SAPI, WMI…) est isolé : branche
  `OperatingSystem.IsWindows()` dans le fichier partagé quand c'est court (c'est le cas de tout ce qui a
  été fait, décodage audio par `ffmpeg` compris), sinon une implémentation propre au serveur dans
  `src/Revizator.Server/Platform/`.
- **L'hôte WPF doit se comporter exactement comme avant sous Windows.** Vérification sous Linux :
  `dotnet build src/Organizator/Organizator.csproj -c Release -p:EnableWindowsTargeting=true` doit
  rester sans erreur (le SDK Microsoft.NET.Sdk.WindowsDesktop est installé dans cet environnement).
- Les URL que les services mettent dans leurs réponses restent les hôtes virtuels de WebView2
  (`https://learn.organizator/…`, `https://tts.organizator/…`) : c'est la page qui les traduit (§ 5).
- Mise en œuvre (état actuel) :
  - fichiers liés : `HostLog`, `AgentProvider`, `AgentLauncher`, `AppSettings`, `DataStore`,
    `InheritedEnvironment`, `ModelCatalog`, `TranscriptAccumulator`, `LearningAgent`, `LearningStore`,
    `NewsMenu`, `TextToSpeech`, `SherpaRuntime`, `LiveAsr`, `WhisperTranscriber`, `SpeechAssessment`,
    `AudioDecoder`, `VoiceChat`, `VoiceSentences`. `SpeechVoice` (SAPI) n'est pas lié.
  - `Platform/AgentDraft.cs` et `Platform/BitbucketPullRequests.cs` : copies réduites des seules
    fonctions statiques utilisées (`Clean`/`Explain`, `NormalizeUrl`) ; les classes d'origine tireraient
    les sessions Copilot (SQLite) et les quotas. À garder alignées.
  - branches `OperatingSystem.IsWindows()` dans les fichiers partagés : `AgentLauncher` (hors Windows :
    `REVIZATOR_CLAUDE`, sinon `claude` dans le `PATH`, sinon `~/.local/bin/claude`), `SherpaRuntime`
    (paquet `runtime.linux-x64` et ses deux `.so`, empreintes vérifiées comme pour win-x64 ; copiés d'abord
    depuis `sherpa/linux-x64/` à côté de l'exécutable s'ils y sont, sinon téléchargés depuis nuget.org ;
    `DownloadSize` devient `static readonly`), `WhisperTranscriber` (bibliothèques livrées sous
    `runtimes/linux-x64/` à côté de l'exécutable, rien à extraire), `AudioDecoder.FromFile` (`ffmpeg`
    au lieu de Media Foundation ; inutilisé par le serveur, qui ne reçoit que des WAV). `HostLog.Mirror`
    recopie le journal sur la console (`docker logs`).
  - bibliothèques natives : Whisper.net (`libwhisper.so`, `libggml*.so`) a besoin de `libgomp1` dans
    l'image.
  - le `.csproj` copie aussi `src/Organizator/wwwroot` tel quel sous `wwwroot/` dans la sortie et la
    publication ; les `.so` de Whisper.net vont sous `runtimes/linux-x64/`, ceux de sherpa-onnx sous
    `sherpa/linux-x64/` (aucune autre dépendance). Version du serveur : `<Version>` du
    `.csproj` (1.0.0), rendue par `/api/health` et reprise par `revizator-server.js`.

## 3. Serveur HTTP

Configuration par variables d'environnement :

| Variable | Défaut | Rôle |
|---|---|---|
| `REVIZATOR_DATA` | `/data` | dossier de données (même disposition que `%LOCALAPPDATA%\Organizator\` pour Révizator) |
| `REVIZATOR_PORT` | `8080` | port HTTP (TLS assuré par le reverse proxy) |
| `REVIZATOR_PUBLIC_URL` | `http://localhost:8080` | adresse publique : origine reconnue comme « ce serveur » (formulaires de connexion, WebSocket), adresse de `/login` affichée par `user set` |
| `REVIZATOR_ALLOWED_ORIGINS` | `https://app.organizator` | origines autorisées en CORS et pour `/api/login` (la page d'Organizator dans WebView2) |
| `REVIZATOR_RELEASES_REPO` | `daftgan/Organizator` | dépôt GitHub dont la dernière Release fournit l'installateur d'Organizator (relue toutes les heures, copiée dans `releases/` du dossier de données) ; `none` : seulement les installateurs déposés dans `releases/` |
| `REVIZATOR_GITHUB_TOKEN` | — | jeton GitHub en lecture seule du dépôt (dépôt privé), dans `secrets.env` |
| `REVIZATOR_TRUSTED_PROXIES` | `private` | adresses ou réseaux (`192.168.1.11`, `172.16.0.0/12`, séparés par des virgules ; `private` = réseaux privés et locaux, `none` = aucun) dont `X-Forwarded-For` et `X-Forwarded-Proto` font foi ; une valeur illisible empêche le démarrage |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | jeton de `claude setup-token`, lu par Claude Code |
| `REVIZATOR_CLAUDE` | `claude` (dans le `PATH`) | chemin de l'exécutable Claude Code |
| `REVIZATOR_WWWROOT` | `wwwroot/` à côté de l'exécutable | dossier de la page (développement : `src/Organizator/wwwroot`) |

Routes :

| Route | Auth | Rôle |
|---|---|---|
| `GET /api/health` | non | `{ ok, version, build, commit }` — `build` : empreinte des fichiers de la page (12 caractères, `ServerConfig.ComputeBuild`), `commit` : `REVIZATOR_COMMIT` de l'image (posé par `deploy/auto-update.sh`, vide sinon) |
| `GET /login` | non | formulaire de connexion (identifiant, mot de passe), **sans script** ; liens vers le manifeste et les icônes (la page s'installe depuis là) ; message selon `?e=` (`bad`, `blocked`, `locked`, `origin`, `out`) ; avec un cookie valide : 302 vers `/` ; sans aucun compte : rappel de `revizator-server user set` |
| `POST /login` | identifiant + mot de passe | formulaire (`login`, `password`, 4 Ko au plus) : session ouverte, cookie `rz_token` (HttpOnly, SameSite=Lax, Secure derrière HTTPS, 400 jours) et 302 vers `/` ; échec : 302 vers `/login?e=bad`, `blocked` (adresse), `locked` (compte) ou `origin` (contrôle d'origine) |
| `POST /logout` | cookie | ferme la session du cookie, retire le cookie, 302 vers `/login?e=out` ; origine refusée : 403 |
| `POST /api/login` | identifiant + mot de passe | JSON `{ login, password, device? }` → `{ token, login, session }` (Organizator sur le PC, scripts) ; échec : 401 `{ error }`, ou 429 avec `Retry-After` (adresse ou compte bloqués) ; origine refusée : 403 |
| `POST /api/logout` | `Authorization: Bearer <jeton>` | ferme cette session → `{ ok }` |
| `GET /api/me` | cookie ou `Authorization: Bearer` | `{ login, version }` ; sinon 401 (ou 429) |
| `GET /api/organizator` | non | l'installateur d'Organizator servi : `{ version, size, sha256, url, published }` ; aucun : 404. Organizator le lit pour se mettre à jour, la page pour proposer le téléchargement |
| `GET /download/organizator` | non | l'installateur, en pièce jointe (`Organizator-Setup-<version>.exe`), avec `Range` ; aucun : 404. La page de connexion y renvoie (« Sur un PC Windows : installer Organizator ») |
| `POST /api/pair` | `Authorization: Bearer <jeton>` | un code d'appairage pour le compte de cette session → `{ code, link, svg, expiresIn }` : `code` affichable (`K7QF-2MXP`), `link` = `<REVIZATOR_PUBLIC_URL>/pair?c=<code>` (adresse de la requête si `REVIZATOR_PUBLIC_URL` n'est pas réglé), `svg` = son QR code, `expiresIn` = 600 ; sans session : 401 ; origine refusée : 403 |
| `GET /pair` | non | page **sans script** : avec `?c=<code>`, le code et un bouton « Connecter cet appareil » (rien n'est consommé : un aperçu de lien ne grille pas le code) ; sans, un champ pour le taper ; message selon `?e=` (`bad`, `blocked`, `origin`) |
| `POST /pair` | code d'appairage | formulaire (`code`, tirets et minuscules tolérés) : le code est consommé, session ouverte pour son compte, cookie `rz_token` et 302 vers `/` ; échec (code inconnu, déjà servi, expiré) : 302 vers `/pair?e=bad`, compté comme un échec de connexion pour l'adresse |
| `GET /` , `/index.html` | cookie | `wwwroot/index.html` avec deux injections (ci-dessous) ; sans session valide : 302 vers `/login` (un cookie périmé est retiré au passage ; 429 au-delà de la limite d'essais) |
| `GET /revizator-server.js` | non | généré : `window.REVIZATOR_SERVER = { mode: 'revizator', version, build, wsUrl: '/api/ws' }` |
| `GET /<fichier de wwwroot>` | non | fichiers statiques de la page (aucune donnée personnelle) |
| `GET /api/ws` | cookie ou `?token=` | WebSocket du pont (§ 4) |
| `GET /learn/…`, `GET /t/<jeton>/learn/…` | cookie / jeton dans le chemin | dossier `learning/` (ce que sert `learn.organizator`) |
| `GET /tts/…`, `GET /t/<jeton>/tts/…` | cookie / jeton dans le chemin | cache des phrases synthétisées (ce que sert `tts.organizator`) |

- Injections dans `index.html` servi par le serveur : avant `<script src="bridge.js">`, la ligne
  `<script src="revizator-server.js"></script>` (fichier **généré** par le serveur :
  `window.REVIZATOR_SERVER = { mode: 'revizator', version: '…', wsUrl: '/api/ws' };`) ; avant
  `</head>` : `<link rel="manifest" href="manifest.webmanifest"><meta name="theme-color" content="#f5ead8">
  <link rel="apple-touch-icon" href="icons/icon-192.png"><link rel="icon" type="image/png"
  href="icons/icon-192.png"><link rel="stylesheet" href="mobile.css">`. L'hôte WPF, lui, sert
  `index.html` tel quel.
- Autres réponses : seules `GET` et `HEAD` sont servies (sinon 405), sauf les quatre `POST` de connexion
  ci-dessus, le WebSocket et le `OPTIONS` du CORS, qui rend 204 ; tout autre chemin sous `/api/` ou
  `/login/` rend 404.
- Les fichiers de `wwwroot` sont ceux de `src/Organizator/wwwroot` (copiés dans la sortie du build du
  serveur, ou embarqués), jamais modifiés à l'exécution.
- Statique : aucun chemin ne sort de son dossier racine (`..`, chemins absolus, liens symboliques,
  segments vides ou cachés — commençant par un point —, `\ : %` et caractères de contrôle refusés) ; `Cache-Control: no-cache` sur `index.html`, `revizator-server.js` et `sw.js`.
- CORS : seulement pour `REVIZATOR_ALLOWED_ORIGINS`, sur `/learn`, `/tts`, `/t/…`, `/api/health` et
  `/api/login`, `/api/logout`, `/api/me`, `/api/pair` (pour ces quatre-là, `OPTIONS` annonce `GET, POST` et les en-têtes
  `Content-Type, Authorization`).
- Contrôle d'origine de la connexion : les formulaires (`POST /login`, `POST /logout`, `POST /pair`) n'acceptent que ce
  serveur (`REVIZATOR_PUBLIC_URL`, ou schéma et `Host` de la requête) ou l'absence d'`Origin` ; l'API
  (`/api/login`, `/api/logout`, `/api/pair`) accepte aussi une origine de `REVIZATOR_ALLOWED_ORIGINS`.
- Codes d'appairage (`PairingCodes.cs`) : 8 caractères tirés de 31 (sans `0 O 1 I L`, ~39 bits), à usage
  unique, valables 10 minutes, 5 au plus en vie par compte, gardés en mémoire seulement (un redémarrage
  les oublie). Un code faux compte dans la limite de 10 échecs par minute et par adresse.
- En-têtes de sécurité : sur toute réponse `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
  (une page ou un média sous `/t/<jeton>/` ne transmet jamais son adresse) et `X-Frame-Options: DENY`, sauf
  sur `/` et `/login`, qui n'ont aucun secret dans leur adresse : `Referrer-Policy: same-origin` (avec
  `no-referrer`, Chrome envoie `Origin: null` pour les formulaires POST, que le contrôle d'origine
  refuserait) ; sur la page et sur `/login` un CSP : `default-src 'self'; script-src 'self' blob:` (aucun script
  en ligne ni gestionnaire `on…=` : un texte généré ou un flux RSS injecté ne s'exécute pas ; `blob:` pour
  le module audio de la détection de voix), `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:
  blob:`, `media-src 'self' data: blob: https:` (podcasts lus directement), `connect-src 'self'
  wss://<hôte> ws://<hôte>`, `worker-src 'self' blob:`, `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'`, plus `font-src 'self' data:`, `frame-src 'self'` (lecteur d'artefacts),
  `manifest-src 'self'` et `form-action 'self'`. La page ne doit donc jamais dépendre d'un script en ligne. Fichiers de
  `/learn`, `/tts`, `/t/…` : `Cache-Control: private, no-cache` et `Content-Security-Policy: default-src
  'none'; sandbox`. NPM ne doit pas mettre en cache (« Cache Assets » : non) : son cache ignore
  `Cache-Control` et resservirait ces fichiers sans session.
- Comptes : `users.json` dans le dossier de données (mode 0600), `{ users: [{ login, hash, created,
  changed }] }`. Identifiant normalisé en minuscules : 1 à 40 caractères, lettres, chiffres, `.`, `_`,
  `-`. Mot de passe libre (non vide, 200 caractères au plus : aucune règle de longueur ni de complexité), haché par PBKDF2-SHA256 (600 000 itérations, sel de 16
  octets, `pbkdf2-sha256$<itérations>$<sel>$<empreinte>`), comparé à temps constant ; un identifiant
  inconnu est vérifié au même coût (contre un hachage factice : la réponse ne dit pas si le compte
  existe) ; deux vérifications PBKDF2 en parallèle au plus. Pas d'inscription ni de « mot de passe
  oublié » : les comptes se gèrent en ligne de commande. Fichier illisible : aucun compte n'est reconnu.
- Sessions : chaque connexion réussie ouvre une session dans `tokens.json` (mode 0600) : un jeton de
  32 octets aléatoires en base64url, rendu une fois (cookie `rz_token` pour un navigateur, réponse de
  `/api/login` pour Organizator) et stocké **haché** (SHA-256), comparé à temps constant ; avec son
  compte, sa date et un nom « compte · appareil · date #xxxx » (appareil : déduit du `User-Agent`,
  « iPhone Safari », « Android Chrome »…, ou le `device` de `/api/login`, « Organizator (PC) »). 50
  sessions par compte au plus : au-delà, les plus anciennes sont fermées. Changer le mot de passe ou
  supprimer le compte ferme toutes ses sessions.
- Anti-essais : 10 échecs par minute et par IP au plus (au-delà : 429, ou `/login?e=blocked` ; une
  adresse IPv6 compte pour son /64) — échecs de connexion comme jetons de session faux. En-tête
  `X-Forwarded-For` pris en compte (le serveur est derrière NPM) : sa **dernière** entrée (celle
  qu'ajoute NPM), et seulement quand la connexion vient d'une adresse de `REVIZATOR_TRUSTED_PROXIES` ;
  de même `X-Forwarded-Proto` (cookie `Secure`, contrôle d'origine). Au-delà de la limite, même un bon
  jeton ou un bon mot de passe est refusé jusqu'à la fin de la minute. La table des échecs est nettoyée
  au plus toutes les 10 s et vidée au-delà de 20 000 adresses. En plus, **verrou par compte** : après 5
  échecs de suite sur un identifiant, il est bloqué 1 minute, puis 2, 4… jusqu'à 15 minutes à chaque
  nouvel échec ; une connexion réussie remet le compteur à zéro (un attaquant qui change d'adresse ne
  devine pas plus vite). Chaque échec de connexion attend 400 ms avant de répondre.
- Journal : `Connexion : <compte> (<appareil>, <IP>)`, `Connexion refusee (<IP>, identifiant de N
  caracteres)` (ni l'identifiant ni le mot de passe), `Deconnexion (<IP>)`. Les jetons refusés ne sont
  jamais journalisés (le chemin `/t/<jeton>/…` est écrit `/t/…/…`). Le mot de passe ne passe jamais
  dans une adresse ; le jeton de session d'Organizator, si (`?token=` du WebSocket, `/t/<jeton>/`) : le
  journal d'accès de NPM le contient (limite assumée, documentée dans `deploy/README.md`).
  `users.json` et `tokens.json` sont relus dès qu'ils changent : la ligne de commande vaut aussitôt pour
  le serveur qui tourne.
- Ligne de commande (même exécutable) :
  - `revizator-server user set <identifiant>` : crée le compte, ou change son mot de passe ; le mot de
    passe est demandé deux fois, sans écho (`docker exec -it`) ; `--password-stdin` (ou une entrée
    redirigée) le lit sur une ligne de l'entrée standard. Un changement ferme toutes les sessions du
    compte, WebSocket ouverts compris ;
  - `revizator-server user list` : comptes, dates, nombre de sessions ;
  - `revizator-server user admin <identifiant> on|off` : donne ou retire le droit d'administrer (§ 6 ter) ;
  - `revizator-server user remove <identifiant>` : supprime le compte et ferme ses sessions (son espace
    `users/<identifiant>/` est gardé : recréer le compte le retrouve) ;
  - `revizator-server session list` : sessions ouvertes (nom et date) ;
  - `revizator-server session revoke <nom ou début du nom>` : ferme une session (le début doit n'en
    désigner qu'une) ; `session revoke --all` : toutes ;
  - `revizator-server import <dossier>` : importe `learning.json` et `learning/` depuis une copie du
    dossier `%LOCALAPPDATA%\Organizator\` du PC (sauvegarde de l'existant avant d'écraser : l'ancien
    `learning.json` et `learning/` sont déplacés sous `import-backup-<date>/` ; à lancer serveur arrêté,
    ou au moins sans page ouverte, qui réécrirait son ancien état) ;
  - sans argument : lance le serveur.

## 4. Pont WebSocket

Même protocole que WebView2, en JSON texte :

- page → serveur : `{ id, type, payload }` ;
- serveur → page : `{ id, ok: true, payload }` ou `{ id, ok: false, error }` (message en français) ;
- serveur → page, événements : `{ event, payload }` — `learn`, `tts`, `asr`, `voice`, `whisper`, et
  `learnChanged` (§ 6). Chaque connexion est attachée au compte de sa session : `learn` et `learnChanged`
  ne vont qu'aux connexions de ce compte ; `tts`, `asr`, `whisper` et `voice` vont au compte qui a lancé le
  travail (son `job`, sa `session` de reconnaissance ou sa conversation), à toutes les connexions quand il
  n'a pas de propriétaire connu (téléchargement d'un modèle).
- Le serveur envoie `{ event: 'ping' }` toutes les 20 s (les proxys coupent un WebSocket muet) ;
  messages de 32 Mo au plus (un `learnSave` ou un WAV en base64 peuvent être gros).

Types acceptés (tout autre type : erreur « Type de message non disponible sur le serveur Révizator ») :

- Révizator : `learnLoad`, `learnSave`, `learnDoc`, `learnDocSave`, `learnDocDelete`, `learnNews`,
  `learnGenerate`, `learnCancel`, `learnJobs`, `learnWait`, `learnBoard` (classement, § 6 bis),
  `learnPolicy` (modèles de l'administrateur, § 6 ter) ;
- administration (§ 6 ter, refusée à qui n'administre pas) : `adminUsers`, `adminUserSet`, `adminUserRemove`,
  `adminUserAdmin`, `adminPolicySave` ;
- voix anglaises : `ttsStatus`, `ttsDownload`, `ttsRemove`, `ttsWarm`, `speak`, `speakScript`,
  `cancelSpeak`, `ttsClearCache` ;
- reconnaissance : `whisperStatus`, `whisperDownload`, `whisperRemove`, `whisperWarm`, `transcribe`,
  `cancelTranscribe`, `asrStatus`, `asrDownload`, `asrRemove`, `asrWarm`, `asrStart`, `asrFeed`,
  `asrEnd`, `asrReset`, `asrStop` ;
- conversation à voix haute : `voiceStart`, `voiceSay`, `voiceInterrupt`, `voiceStop`, `voiceVoices`,
  `voiceSpeak` (voix SAPI absentes sous Linux : `voiceVoices` rend une liste vide, `voiceSpeak` échoue
  proprement, la page retombe sur `speechSynthesis`) ;
- `log`, `perf` (journal du serveur), `notify` (rend `{}` : rien à notifier côté serveur) ;
- page en mode serveur seulement : `getState` (rend `{ data: <état vide valide d'Organizator>,
  settings: <settings.json du serveur>, env: { mode: 'revizator', version, learnUrl, ttsUrl, whisper,
  models, efforts, … } }`) et `saveSettings` (écrit `settings.json` **du serveur** : réglages du
  téléphone). `saveData` est refusé.

Les gestionnaires reprennent ceux de `BridgeHost.cs` (mêmes noms de champs, mêmes réponses). Seuls les
types de la liste sont branchés : il n'existe aucun gestionnaire pour les tâches, sessions, pièces
jointes, articles, quotas, etc.

Précisions de la mise en œuvre :

- le message d'erreur d'un type refusé est « Type de message non disponible sur le serveur Révizator :
  `<type>` » (la page ne doit donc pas appeler `badge`, `getUsage`, `getArticle`, `refreshModels`… en
  mode serveur : ils échouent) ;
- `learnLoad` et `learnSave` rendent en plus `rev` (même compteur que `learnChanged`) ; le compteur
  part de l'heure du démarrage du serveur en millisecondes (et non de 0) : une page ouverte avant un
  redémarrage ne retombe jamais par hasard sur son ancien numéro ;
- `learnSave` accepte `baseRev` (le `rev` que la page a lu ou écrit en dernier) : si un autre appareil a
  écrit depuis, rien n'est écrit et la réponse est `{ conflict: true, rev }` (voir § 6). Sans `baseRev`,
  l'écriture est inconditionnelle (comme sous WebView2). Lecture et écriture de `learning.json` passent
  une à la fois ;
- `transcribe` avec un `path` est refusé (il n'y a pas de pièces jointes sur le serveur) ;
- `perf` est accepté et ignoré ; `log` va au journal ;
- WebSocket ouvert avec le cookie : l'en-tête `Origin`, s'il est présent, doit être ce serveur — égal à
  `REVIZATOR_PUBLIC_URL`, ou au schéma (`https` si la requête l'est, directement ou par `X-Forwarded-Proto`
  d'un proxy de confiance) et à l'en-tête `Host` de la requête (`X-Forwarded-Host` n'est pas lu) — ou une
  origine de `REVIZATOR_ALLOWED_ORIGINS`, sinon 403 ; avec `?token=`, l'origine est libre ;
- la session d'une connexion est revérifiée à chaque message et à chaque ping : une session fermée
  (`session revoke`, déconnexion, mot de passe changé, compte supprimé) ferme aussi les connexions déjà
  ouvertes (code 1008, au plus 20 s) ;
- `log` : niveau réduit à 12 lettres, message coupé à 4 000 caractères (pas de fausse ligne de journal) ;
  `saveSettings` ne garde jamais `revizatorServerUrl`, `revizatorServerToken` ni `revizatorServerLogin`
  (réglages du PC) ;
- un message au-delà de 32 Mo ferme la connexion (code 1009) ; les messages binaires sont ignorés ;
- à l'arrêt du serveur (`docker stop`, SIGTERM), les WebSocket sont fermés tout de suite (code 1001) : sans
  cela Kestrel les garderait jusqu'à 30 s et les pages se croiraient encore connectées ;
- la partie synchrone de chaque gestionnaire s'exécute dans l'ordre de réception (les `asrFeed`
  restent ordonnés), le reste en parallèle, comme sous WebView2.

## 5. La page

### 5.1 Transport (`bridge.js`)

Trois cas, décidés au chargement :

1. **WebView2** (`window.chrome.webview`) — inchangé, sauf le routage distant (cas 3).
2. **Servie par le serveur** (`window.REVIZATOR_SERVER`) — tous les `bridge.call` passent par le
   WebSocket `REVIZATOR_SERVER.wsUrl` (même origine, le cookie authentifie). Le shim n'est pas utilisé.
   À chaque coupure de la liaison, la page demande `GET /api/me` : un 401 (session fermée : déconnexion
   ailleurs, mot de passe changé, `session revoke`) la renvoie à `/login` au lieu de réessayer sans fin.
   Réglages › Révizator montre la carte **Compte** (identifiant lu par `/api/me`, « Se déconnecter » =
   formulaire `POST /logout`).
3. **Organizator avec un serveur Révizator configuré** — réglages `revizatorServerUrl`,
   `revizatorServerToken` (le jeton de **session** rendu par `POST /api/login`) et `revizatorServerLogin`
   (l'identifiant, pour l'affichage), dans `settings.json` du PC (`AppSettings.cs`) ; le mot de passe n'y
   est jamais écrit. Les types de
   la liste du § 4 (sauf `getState`, `saveSettings`, `notify`, `log`, `perf`, qui restent locaux)
   partent par `wss://<serveur>/api/ws?token=<jeton>` ; les événements `learn`, `tts`, `asr`, `voice`,
   `whisper`, `learnChanged` du serveur sont émis dans la page ; ceux de l'hôte local pour ces mêmes
   noms sont ignorés. Serveur injoignable : les appels échouent avec « Serveur Révizator injoignable »
   (jamais de repli silencieux sur les données locales, qui divergeraient).
   **Pas de mode local** : sans serveur réglé (jeton vide), `bridge.needsServer()` est vrai dans WebView2
   et ces mêmes appels échouent tout de suite (erreur `needsServer`, « Révizator passe par son
   serveur… ») au lieu de partir à l'hôte : Révizator ne lit ni n'écrit plus jamais le `learning.json`
   du PC. Sa page montre alors seulement le formulaire de connexion (la carte « Serveur Révizator »).
   Les exceptions ci-dessous (fichiers joints, `local: true`) restent sur l'hôte comme avant. Le shim
   garde son mode local pour les essais, sauf avec `window.__shimServerOnly = true`.
   **Exceptions** (ce qui n'existe que sur le PC) : un appel avec des fichiers joints
   (`bridge.call(…, files)`) et un `transcribe` qui porte un `path` (enregistrement joint à une tâche),
   ainsi que le `cancelTranscribe` de ce travail, restent sur l'hôte local, et les événements de l'hôte
   dont le `job` est celui d'un tel travail passent. De même pour tout appel dont le `payload` porte
   `local: true` : `app.js` le met sur la dictée des tâches (`transcribe`, `cancelTranscribe`) et sur les
   modèles Whisper de l'onglet Dictée (`whisperStatus`, `whisperDownload`, `whisperRemove`,
   `whisperWarm`) ; les événements `whisper` de ces travaux (même `job`) et de ces téléchargements (même
   `model`, sans `job`) passent. Le texte des tâches ne quitte donc jamais le PC.
   Les réglages ne sont connus qu'après `getState` : `app.js` appelle
   `bridge.configureRemote({ url, token })` juste après (seulement si un jeton est enregistré), avant le
   démarrage des pages, et Révizator le rappelle quand le réglage change. Réglages › Révizator › Serveur
   Révizator :
   - sans session : **Adresse**, **Identifiant**, **Mot de passe**, « Se connecter » =
     `bridge.loginRemote({ url, login, password })` (`POST /api/login`, appareil « Organizator (PC) ») ;
     réussite : le jeton et l'identifiant vont dans les réglages, le mot de passe est effacé du
     formulaire, `configureRemote` branche le serveur ; échec : « Refusé » avec le message du serveur
     (mauvais mot de passe, trop d'essais), « Injoignable », ou « À compléter » (adresse illisible,
     champ vide) ;
   - connecté : le serveur et le compte (« connecté en tant que … »), « Tester la connexion » =
     `bridge.testRemote` (`GET /api/health` puis ouverture du WebSocket avec le jeton → `online` /
     `unreachable` / `refused`, affichés « Connecté » avec la version du serveur, « Injoignable »,
     « Refusé »), et « Se déconnecter » = `bridge.logoutRemote` (`POST /api/logout`, jamais en échec),
     jeton vidé, `configureRemote({ url: '' })` : Révizator revient au formulaire de connexion.
   « Refusé » au test veut dire : `/api/health` répond mais le WebSocket refuse la session (fermée sur le
   serveur : se déconnecter puis se reconnecter) ; un proxy qui bloquerait les WebSocket donnerait le même
   message, ou « Injoignable » s'il ne répond pas en 8 s. `configureRemote` émet
   `remoteChanging` (avant la bascule : une sauvegarde en attente part encore à l'ancien destinataire)
   puis `remoteChanged` ; Révizator relit alors tout chez le nouveau. Le réglage n'est montré que dans
   WebView2 (dans le shim, seulement avec `window.__shimRemote = true`, pour les essais).

Commun aux cas 2 et 3 : reconnexion automatique (1 s, 2 s, 5 s, puis toutes les 10 s), appels en
attente rejetés à la coupure, file d'envoi pendant la reconnexion pour les appels de moins de 10 s,
`bridge.on('connection', fn)` (`{ state: 'online'|'offline'|'connecting', url }` ; `'local'` quand le
serveur est retiré dans le cas 3) pour un bandeau discret (`[data-rz-conn]` en tête de la page
Révizator, réécrit sans rendu complet). Chien de garde : sans aucun message pendant 50 s (le serveur
envoie un ping toutes les 20 s), la liaison est tenue pour morte et rouverte. `bridge.mode`
(`'webview'|'server'|'shim'`), `bridge.remote()` (`{ url, state }` ou `null`) et
`bridge.connection()` donnent l'état courant. Dans les cas 2 et 3, si `learnLoad` échoue, Révizator
**ne démarre pas sur des données vides** (que sa prochaine sauvegarde écrirait sur le serveur) : il
affiche l'erreur, un bouton « Réessayer », et relit dès que la liaison revient ; une sauvegarde ratée
parce que le serveur est coupé repart à la reconnexion.

**Traduction des URL** : dans toutes les chaînes des réponses et des événements venus du serveur,
`https://learn.organizator/` devient `<base>/learn/` et `https://tts.organizator/` devient
`<base>/tts/`, où `<base>` vaut l'origine du serveur (cas 2) ou `https://<serveur>/t/<jeton>` (cas 3).
La traduction **inverse** s'applique à tout ce que la page envoie au serveur : `learning.json` et les
documents gardent les hôtes virtuels, et restent portables entre le PC et le serveur. `env.learnUrl` et
`env.ttsUrl` sont traduits de la même façon. Mise en œuvre : sur le texte JSON du message (les URL ne
sont que dans des chaînes, où `/` n'est pas échappé), sans recopier l'objet ; l'inverse reconnaît toute
base du même serveur (`<origine>/learn/` comme `<origine>/t/<n'importe quel jeton>/learn/`).

### 5.2 Mode « Révizator seul » (`app.js`)

Actif quand `window.REVIZATOR_SERVER.mode === 'revizator'` (ou `?mode=revizator` dans le shim, pour les
tests) :

- la page Révizator est la seule : pas d'onglet File, pas de file de tâches, pas de cartes de quotas ni
  d'articles, pas de cloche ni de remarques ; l'en-tête garde le titre (« Révizator », aussi titre de
  l'onglet), l'avancement de la semaine, le niveau et les réglages (l'état de la liaison est le bandeau
  de la page Révizator, § 5.1) ;
- Réglages : seulement l'onglet Révizator (et ce qui concerne la voix et la dictée) ;
- rien de ce qui touche aux tâches n'est appelé (`saveData`, `getSessions`, `getUsage`, …).

Mise en œuvre : constante `RZ_ONLY` en tête d'`app.js`, classe `rz-only` sur `<html>` (règles d'en-tête
dans `app.css`, valables aussi sur grand écran) ; `currentPage()` rend toujours `revizator` ; les
fonctions de la file (`saveDataNow`, `refreshSessions`, la relecture périodique des sessions,
`refreshUsage`, `peekArticles`, `ensureArticle`, `refreshModels`) ne font rien ; les Réglages montrent
l'onglet Révizator puis l'onglet Dictée (sans « Transcrire les enregistrements joints »).

### 5.3 Téléphone

- `mobile.css` (chargé seulement par le serveur) : mise en page pour 360–430 px de large, cibles
  tactiles de 44 px, barre d'onglets de Révizator défilante ou en bas d'écran, séance et exercices en
  plein écran, clavier virtuel pris en compte (`100dvh`, `env(safe-area-inset-*)`), pas de survol
  indispensable (les traductions au survol s'ouvrent au toucher).
- PWA : `wwwroot/manifest.webmanifest` (nom « Révizator », `display: standalone`, `start_url: "/"`),
  `wwwroot/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, et `wwwroot/sw.js` (service
  worker à la racine : met en cache l'enveloppe de la page — HTML, CSS, JS, polices, icônes — pour un
  démarrage rapide ; **jamais** `/api`, `/learn`, `/tts`, `/t/`). Enregistré par `app.js` en
  mode serveur seulement (`bridge.mode === 'server'`, contexte sécurisé), sous l'adresse
  `sw.js?v=<REVIZATOR_SERVER.build>` (empreinte des fichiers de la page ; `version` à défaut) : toute
  page modifiée installe un nouveau service worker, dont le cache (`revizator-shell-<build>`) remplace
  l'ancien. Page et `revizator-server.js` :
  réseau d'abord (copie hors ligne) ; autres fichiers : copie d'abord, relue en arrière-plan.
- `mobile.css` n'agit que sous `@media (max-width: 600px)` (et `(hover: none)` / `(pointer: coarse)` pour
  les aides au survol et les raccourcis clavier) : en-tête d'une ligne collé en haut, onglets en bas
  d'écran, masqués dans les vues plein écran (séance, série d'exercices, révision des cartes, bilan en
  cours, conversation du tuteur), traductions des mots dans une bulle en bas d'écran, Réglages plein
  écran. Les icônes se régénèrent par `node tools/make-pwa-icons.mjs` (Chromium headless).
- Installation : sur l'accueil de Révizator (et dans Réglages › Révizator › Compte), une carte « Installer
  Révizator » tant que la page n'est pas ouverte en appli installée (`display-mode: standalone`,
  `navigator.standalone`). Chrome et Edge : `beforeinstallprompt` est retenu, le bouton « Installer
  l'application » ouvre la fenêtre du système ; iPhone et iPad : les deux gestes de Safari (Partager ›
  Sur l'écran d'accueil) ; Android sans l'événement : le menu ⋮. « Plus tard » la cache une semaine
  (`localStorage`, clé `revizator.installLater`) ; elle reste dans les Réglages.
- Appairage : Organizator (Réglages › Révizator › Serveur Révizator, connecté) a un bouton « Ajouter un
  téléphone » = `bridge.pairRemote({ url, token })` (`POST /api/pair`) : le QR code, le code à taper et
  l'adresse de `/pair`, valables 10 minutes. Le téléphone scanne, touche « Connecter cet appareil »
  (`POST /pair`) et arrive connecté sur la page, qui lui propose l'installation. La page `/login` a un
  lien « J'ai un code d'appairage » (utile dans l'appli installée sur iPhone, qui n'a pas les cookies de
  Safari).
- Micro : `getUserMedia` exige HTTPS (assuré par NPM) ; le PCM et les WAV partent par le WebSocket comme
  dans WebView2.

## 6. Plusieurs appareils en même temps

`learning.json` est écrit en entier par la page (`learnSave`). Après chaque `learnSave` réussi, le
serveur envoie `{ event: 'learnChanged', payload: { rev, at } }` aux **autres** connexions (`rev` :
compteur incrémenté à chaque écriture, § 4).

**Relecture** (`revizator/core.js`) : à la réception de `learnChanged`, si rien n'attend d'être
sauvegardé, la page relit `learnLoad` et se redessine, sans interrompre une séance en cours. « Séance en
cours » = toute vue autre que l'accueil et Progrès (séance, exercices, bilans, cartes, tuteur) : la
relecture attend que l'on revienne à l'une de ces deux vues, et elle est abandonnée si, entre-temps,
une modification attend d'être sauvegardée (c'est alors l'écriture ci-dessous qui réconcilie).

**Écriture conditionnelle et fusion à trois** (cas 2 et 3, c'est-à-dire dès que `bridge.remote()` n'est
pas nul) : la page garde la dernière version lue ou écrite (`base` : son `rev` et son texte) et envoie
`learnSave` avec `baseRev`. Si le serveur répond `{ conflict: true }`, la page relit la version du
serveur et la fusionne avec la sienne (`merge3`) : ce qu'un seul côté a changé est gardé ; quand les
deux ont changé, les objets se fusionnent clé par clé, les listes d'objets à `id` (cartes, cours, séries…)
élément par élément, les autres listes (journaux comme `reviewLog`) gardent les éléments du serveur plus
ceux ajoutés ici ; une même valeur changée des deux côtés : celle de la page qui écrit l'emporte. Puis
elle renvoie (trois essais au plus, ensuite un message « sauvegarde différée » et un nouvel essai à la
modification suivante). La fusion modifie l'objet en place : une vue ouverte (révision de cartes) garde
ses objets. Vérifié : le téléphone modifie le profil pendant que le PC révise des cartes, les deux
modifications sont gardées sur disque.

Limite restante : deux appareils qui changent **la même valeur** (la même carte révisée des deux côtés
au même moment) : la dernière écriture gagne pour cette valeur. Hors serveur (WebView2 seul, shim),
l'écriture reste inconditionnelle, comme avant.

## 6 bis. Un espace par compte, et le classement

**Espaces** (`UserSpaces.cs`). Les données de Révizator d'un compte sont sous `users/<identifiant>/` du
dossier de données, avec la disposition d'avant (`learning.json`, `learning.json.bak`, `learning/` : cours,
séries, bilans, enregistrements, menu RSS) ; chaque espace a son `LearningStore`, son `NewsMenu`, son
`LearningAgent` (dossier de travail de `claude -p` : l'espace) et son compteur `rev`. Les messages
`learn*` et `transcribe` avec `keep` agissent sur l'espace du compte de la connexion ; `/learn/…` (cookie)
et `/t/<jeton>/learn/…` servent le dossier `learning/` du compte du jeton, jamais celui d'un autre (404).
Les voix, la reconnaissance, Whisper, la conversation vocale et `settings.json` (réglages du téléphone)
restent communs.

**Reprise des données d'avant.** `learning.json`, son `.bak` et `learning/` à la racine du dossier de
données (serveur d'avant les comptes séparés, ou `import` sans compte) reviennent au **premier compte
créé** (`created` le plus ancien dans `users.json`) : ils sont **déplacés** dans son espace la première fois
qu'il s'ouvre (`learnLoad`, `learnBoard`…), s'il n'a pas encore de `learning.json`. Journal :
« donnees d'avant les comptes separes rattachees a « … » ». `import <dossier> [<identifiant>]` écrit dans
l'espace du compte nommé ; sans identifiant, dans celui du seul compte, ou à la racine s'il n'y en a aucun
(repris ensuite par le premier compte) ; refus s'il y en a plusieurs.

**Classement** (`Leaderboard.cs`, type `learnBoard { weeks? }`, 12 semaines par défaut, 26 au plus).
Le serveur lit le `learning.json` de chaque compte de `users.json` (relu seulement quand il change :
date et taille) et n'en rend que des agrégats : par semaine (lundi 0 h, heure du serveur `TZ`, de la plus
ancienne à la courante) `points`, `minutes`, `days` (jours de 5 minutes ou plus), `sessions` (séances de
5 minutes ou plus), `goal` (objectif hebdomadaire actuel), `cards` (révisions du `reviewLog`), `theta`
(niveau global estimé à la fin de la semaine, même moyenne que `R.globalTheta`, langue pour moitié) ; par
joueur `name` (`profile.boardName`, 24 caractères, sinon l'identifiant), `me`, `since`, `theta` actuel,
`totalMinutes` et `toeic` (bilans express de l'année : tendance `trend.T.mean`, sinon le score). Jamais
une carte, un texte, une erreur ni un enregistrement. Points : 1 par minute (90 au plus par jour) + 10 par
jour actif + 5 × objectif quand l'objectif de séances est atteint. Un compte avec `profile.boardHidden`
n'apparaît qu'à lui-même (`hidden: true`) ; un compte sans `learning.json` n'apparaît pas.

**Page** (`revizator/board.js`, `board.css`) : vue `board` (onglet **Classement**, seulement avec un
serveur : `bridge.mode === 'server'` ou `bridge.remote()`, et dans le shim avec des données simulées),
carte d'accueil `board`, section de réglages (pseudo, retrait). Le classement est relu à l'ouverture de la
vue, puis au plus une fois par minute ; une sauvegarde (`saved`) le rend périmé. `learnBoard` part au
serveur dans le cas 3 (liste `REMOTE_TYPES` de `bridge.js`).

## 6 ter. Administration

**Qui administre.** Un compte marqué `admin: true` dans `users.json` ; tant qu'aucun ne l'est, le premier
compte créé (`UserStore.IsAdmin`, `Admins`). Désigner un premier administrateur (page ou
`user admin <identifiant> on`) marque d'abord l'administrateur implicite : le propriétaire le reste. Le
droit est vérifié à **chaque** message `admin*` (« Réservé à l'administrateur du serveur Révizator », refus
journalisé) ; l'onglet caché n'est qu'une commodité.

**Messages** (`ServerBridge`) :

| Type | Charge | Réponse |
|---|---|---|
| `learnPolicy` | `{}` | tout compte : `{ models: { lessonModel, lessonEffort, genModel, genEffort, gradeModel, tutorModel, cardModel }, imposed, changed, changedBy, defaults, admin }` |
| `adminUsers` | `{}` | `{ users: [{ login, created, changed, admin, flagged, sessions, devices, name, lastActivity, hasData, me }], policy }` — `name` : pseudo du classement, `lastActivity` : date de la dernière écriture de son `learning.json` ; rien de son contenu |
| `adminUserSet` | `{ login, password }` | crée le compte ou change son mot de passe (ses sessions sont fermées, WebSocket compris) ; comme `adminUsers`, plus `created`, `closed` |
| `adminUserRemove` | `{ login }` | supprime le compte, ferme ses sessions, garde `users/<login>/` ; ni soi-même |
| `adminUserAdmin` | `{ login, admin }` | donne ou retire le droit ; jamais à soi-même |
| `adminPolicySave` | `{ models, imposed }` | enregistre `admin.json` (modèles vérifiés par `AgentProvider.RequireModel`, efforts de Claude Code ; modèle vide = valeur d'origine) ; événement `learnPolicy` à toutes les connexions (sans `admin`) |

**Modèles** (`AdminPolicy.cs`, `admin.json` du dossier de données). `imposed: false` : réglages de départ
d'un compte neuf (la page les recopie dans ses `prefs` avant le premier lancement, `prefs.policySeeded`).
`imposed: true` : le serveur remplace `model` et `effort` de chaque `learnGenerate` selon son genre (mêmes
paires que `GEN_MODEL` de la page) et le `model` de `voiceStart` en mode tuteur ; Réglages › Révizator ›
Agents les affiche sans pouvoir les changer.

**Page** (`revizator/admin.js`, `admin.css`) : vue `admin` (onglet **Admin**, `R.policy.admin`), cartes
Personnes, Ajouter une personne (générateur de mot de passe, affiché une fois à la création), Modèles de
Révizator. `learnPolicy` est relu à chaque `loaded` ; `R.policy` est exposé aux autres modules. `bridge.js`
envoie `learnPolicy` et `admin*` au serveur et en reçoit l'événement `learnPolicy` (cas 3).

## 7. Déploiement (`deploy/`)

- `deploy/Dockerfile` : construction multi-étapes (SDK .NET 8 → `mcr.microsoft.com/dotnet/aspnet:8.0-noble`),
  `ffmpeg`, Claude Code (installeur natif) dans le `PATH`, DLL natives linux-x64 de sherpa-onnx et de
  Whisper.net, utilisateur non root, volume `/data`, port 8080, `HEALTHCHECK` sur `/api/health`.
- `deploy/docker-compose.yml` : prêt pour une stack Komodo, `restart: unless-stopped`, volume
  `/opt/revizator/data:/data`, variables du § 3 depuis un `.env`.
- `deploy/README.md` (français) : LXC Proxmox dédié (Debian 13, 4 cœurs, 6 Go, 30 Go, imbrication
  activée, IP fixe), Docker, stack Komodo, hôte proxy NPM `revizator.daft-lab.fr` (WebSocket activé,
  Let's Encrypt, « Block Common Exploits »), `claude setup-token`, import des données du PC, création
  du compte (`user set`), connexion du téléphone et du PC (Réglages › Révizator › Serveur), mise à jour,
  sauvegarde du volume.
- `deploy/FINALISER.md` : la liste de contrôle que suivra Claude Code installé sur le serveur pour
  terminer l'installation et vérifier chaque point (ce qui n'a pas pu être testé dans le cloud :
  construction de l'image Docker, Claude Code réel, modèles de voix réels, téléphone réel).
- Mise en œuvre (état actuel) :
  - images `sdk:8.0-noble` → `aspnet:8.0-noble` (Ubuntu 24.04, variante essayée ; la variante Debian
    de `aspnet:8.0` conviendrait aussi : glibc ≥ 2.29 suffit aux natives) ; paquets `ffmpeg`, `libgomp1`
    (OpenMP de `libggml-cpu-whisper.so`) et `curl` (installeur, `HEALTHCHECK`) ;
  - utilisateur non root : `app` (UID/GID 1654) fourni par l'image .NET ; `/opt/revizator/data` doit lui
    appartenir (`chown -R 1654:1654`) ;
  - Claude Code : `curl -fsSL https://claude.ai/install.sh | bash -s -- $CLAUDE_CODE_VERSION`, en tant que
    `app`, binaire `~/.local/bin/claude` dans le `PATH` ; `DISABLE_AUTOUPDATER=1` : la version est figée
    dans l'image (argument de construction `CLAUDE_CODE_VERSION`, alimenté dans le compose par
    `REVIZATOR_CLAUDE_VERSION` — pas `CLAUDE_CODE_VERSION`, qu'un shell de Claude Code pose déjà) ;
  - `/usr/local/bin/revizator-server` (script : `exec dotnet /app/revizator-server.dll "$@"`) pour
    `docker exec -it revizator revizator-server user set <identifiant>`, `session list`… ; `ASPNETCORE_HTTP_PORTS` vidé (le port vient de
    `REVIZATOR_PORT`) ;
  - compose : `pull_policy: build` (image locale `revizator-server:local`, jamais tirée d'un registre :
    Deploy dans Komodo reconstruit), `init: true` (tini récolte les processus de `claude`), port
    `8080:8080`, journaux `json-file` limités ; `REVIZATOR_PUBLIC_URL`, `REVIZATOR_ALLOWED_ORIGINS`,
    `REVIZATOR_TRUSTED_PROXIES` et `TZ` interpolés depuis `.env` (écrit par Komodo à partir de
    l'« Environment » de la stack, lisible par tous : rien de secret) ; `CLAUDE_CODE_OAUTH_TOKEN` lu par
    `env_file` dans `/opt/revizator/secrets.env` (0600, hors du dépôt, jamais réécrit par Komodo ;
    facultatif : sans lui le serveur démarre et le signale) ; `deploy/.env` est ignoré par git ;
  - `.dockerignore` à la racine : seul `src/` entre dans le contexte ;
  - import : `docker compose stop`, `docker compose run --rm --no-deps revizator import /data/import-pc`,
    `docker compose start`.

## 8. État des vérifications

Construit et vérifié dans le cloud (Linux, sans réseau vers les sites des modèles ni vers claude.ai) :

- builds : `Revizator.Server`, et l'hôte WPF par `dotnet build src/Organizator/Organizator.csproj -c
  Release -p:EnableWindowsTargeting=true`, sans erreur ni avertissement ;
- `REVIZATOR_PASSWORD=… node tools/revizator-server-smoke.mjs <url> <identifiant>` (sans la variable, le
  mot de passe est lu sur l'entrée standard, jamais sur la ligne de commande) : santé, CORS, refus sans
  session, connexion (formulaire → cookie, API → jeton), mauvais mot de passe refusé, page et injections, `learnLoad` / `learnSave` / `learnChanged` entre deux connexions, types
  refusés, `learnGenerate` (avec un faux `claude` qui imite la sortie stream-json), `/learn` par cookie
  et par `/t/<jeton>/`, traversées de chemin ; il ouvre deux sessions et les ferme à la fin ;
- parcours complet dans Chromium (Playwright) contre le vrai serveur : un « téléphone » 390×844 et un
  « PC » 1400×900 connectés, premier lancement, série d'exercices, cartes révisées des deux côtés,
  fusion d'écritures concurrentes, relecture différée, service worker, serveur coupé puis relancé ;
  cas 3 (Organizator réglé sur le serveur) par le shim avec `window.__shimRemote` ;
- image Docker construite et lancée (`healthy`, UID 1654, script de fumée dans le conteneur, gestion
  des appareils par `docker exec`, import), avec un faux `claude` (étape d'avant les comptes : à refaire
  avec `user set` et la connexion, voir `deploy/FINALISER.md`) ;
- comptes séparés et classement (§ 6 bis) : deux comptes réels sur le serveur, données d'avant reprises
  par le premier, `learnLoad` de l'autre vide, `learnChanged` et `/t/<jeton>/learn/…` limités au compte,
  `learnBoard` (pseudos, points, retrait du classement, aucun contenu privé), `import` avec et sans compte ;
  page Classement dans Chromium (390 et 1300 px de large), par le shim et contre le vrai serveur ;
- administration (§ 6 ter) : droits refusés à un membre, création, mot de passe changé (connexion fermée,
  ancien mot de passe refusé), rôle, suppression, garde-fous (soi-même), modèles invalides refusés, modèles
  imposés appliqués à `learnGenerate` (faux `claude` qui note ses arguments) ; page Admin dans Chromium
  (shim, 390 et 1300 px) ;
- revue de sécurité adverse (authentification, traversées, WebSocket, révocation, limiteur, en-têtes) :
  défauts trouvés corrigés et inscrits aux § 3 et 4.

Non vérifié : Claude Code réel, les modèles Kokoro, Parakeet et Whisper (seuls leurs échecs propres
l'ont été) et les flux RSS, `voiceStart` et le micro, WebView2 réel sous Windows (cas 3), Nginx Proxy
Manager et `wss`, Komodo, un vrai téléphone (iOS Safari, installation de la PWA, clavier virtuel). La
liste de contrôle de `deploy/FINALISER.md` reprend ces points sur le serveur.

Points connus :

- **À vérifier sur un vrai téléphone** : la connexion depuis l'application installée (iPhone : elle ne
  partage pas toujours les cookies de Safari, mais la page `/login` y fonctionne : on s'y connecte une
  fois), que la session y survit à la fermeture de l'application, et le retour à `/login` quand la
  session est fermée ailleurs (`deploy/FINALISER.md`, étape 9).
- **Connexion par compte** (remplace l'ancien jeton par appareil) : vérifiée par l'essai de fumée ;
  pas encore par NPM réel, ni avec Organizator réel sous WebView2 (`/api/login` en CORS depuis
  `https://app.organizator`).
- **Jetons de session dans les adresses** (§ 3, Organizator sur le PC seulement : `?token=` du
  WebSocket, `/t/<jeton>/`) : présents dans le journal d'accès de NPM ; les éviter demanderait de passer
  le jeton par `Sec-WebSocket-Protocol` dans `bridge.js`. Le mot de passe, lui, n'y passe jamais.
- **`WebFetch`** (cours, conversation vocale) peut être poussé par un flux RSS vers le réseau local :
  isoler le réseau du conteneur est recommandé.
- Une session ouverte n'a pas de limite de connexions ni de file d'envoi (32 Mo par message) :
  acceptable tant que seuls les comptes de l'utilisateur existent.
