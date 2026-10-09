# Révizator serveur — contrat d'architecture

Révizator seul, hébergé sur un serveur Linux (le mini-serveur `daft-lab`), utilisable depuis le
téléphone (application web installable, PWA) **et** depuis l'onglet Révizator d'Organizator sur le PC.
La file des tâches, les sessions d'agent, `data.json` et tout le reste d'Organizator **restent sur le
PC** : le serveur n'en reçoit jamais rien et n'expose aucun moyen d'y accéder.

Ce document est le contrat que suivent le serveur, la page et le déploiement. Le modifier d'abord si
une décision change.

## 1. Vue d'ensemble

```
Téléphone (PWA)  ─┐   cookie rz_token
                  ├─ https://revizator.daft-lab.fr ─→ Nginx Proxy Manager ─→ conteneur revizator-server :8080
PC : Organizator ─┘   jeton dans l'URL (WebSocket ?token=, médias /t/<jeton>/...)
   onglet Révizator → serveur (si configuré)          revizator-server (.NET 8, Linux, ASP.NET Core)
   tout le reste → hôte WPF local                       ├─ services Révizator partagés avec l'hôte WPF
                                                        ├─ claude -p (Claude Code, abonnement, CLAUDE_CODE_OAUTH_TOKEN)
                                                        ├─ sherpa-onnx (Kokoro, Parakeet), Whisper.net, ffmpeg
                                                        └─ /data (volume) : learning.json, learning/, tts/, modèles…
```

Une seule source de vérité : le dossier de données du serveur. Le PC et le téléphone y lisent et y
écrivent ; il n'y a pas de synchronisation de fichiers.

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
    `sherpa/linux-x64/` ; QRCoder dessine le QR code d'appairage. Version du serveur : `<Version>` du
    `.csproj` (1.0.0), rendue par `/api/health` et reprise par `revizator-server.js`.

## 3. Serveur HTTP

Configuration par variables d'environnement :

| Variable | Défaut | Rôle |
|---|---|---|
| `REVIZATOR_DATA` | `/data` | dossier de données (même disposition que `%LOCALAPPDATA%\Organizator\` pour Révizator) |
| `REVIZATOR_PORT` | `8080` | port HTTP (TLS assuré par le reverse proxy) |
| `REVIZATOR_PUBLIC_URL` | `http://localhost:8080` | adresse publique, pour les liens d'appairage |
| `REVIZATOR_ALLOWED_ORIGINS` | `https://app.organizator` | origines autorisées en CORS (la page d'Organizator dans WebView2) |
| `REVIZATOR_TRUSTED_PROXIES` | `private` | adresses ou réseaux (`192.168.1.11`, `172.16.0.0/12`, séparés par des virgules ; `private` = réseaux privés et locaux, `none` = aucun) dont `X-Forwarded-For` et `X-Forwarded-Proto` font foi ; une valeur illisible empêche le démarrage |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | jeton de `claude setup-token`, lu par Claude Code |
| `REVIZATOR_CLAUDE` | `claude` (dans le `PATH`) | chemin de l'exécutable Claude Code |
| `REVIZATOR_WWWROOT` | `wwwroot/` à côté de l'exécutable | dossier de la page (développement : `src/Organizator/wwwroot`) |

Routes :

| Route | Auth | Rôle |
|---|---|---|
| `GET /api/health` | non | `{ ok, version }` |
| `GET /pair?token=…` | jeton | pose le cookie `rz_token` (HttpOnly, Secure si HTTPS, SameSite=Lax, 400 jours) et redirige vers `/` |
| `GET /` , `/index.html` | cookie | `wwwroot/index.html` avec deux injections (ci-dessous) ; sans cookie valide : petite page « appareil non appairé » (401, ou 429 au-delà de la limite d'essais) |
| `GET /revizator-server.js` | non | généré : `window.REVIZATOR_SERVER = { mode: 'revizator', version, wsUrl: '/api/ws' }` |
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
- Autres réponses : seules `GET` et `HEAD` sont servies (sinon 405, sauf le WebSocket et le `OPTIONS` du
  CORS, qui rend 204) ; tout autre chemin sous `/api/` ou `/pair/` rend 404.
- Les fichiers de `wwwroot` sont ceux de `src/Organizator/wwwroot` (copiés dans la sortie du build du
  serveur, ou embarqués), jamais modifiés à l'exécution.
- Statique : aucun chemin ne sort de son dossier racine (`..`, chemins absolus, liens symboliques,
  segments vides ou cachés — commençant par un point —, `\ : %` et caractères de contrôle refusés) ; `Cache-Control: no-cache` sur `index.html`, `revizator-server.js` et `sw.js`.
- CORS : seulement pour `REVIZATOR_ALLOWED_ORIGINS`, sur `/learn`, `/tts`, `/t/…` et `/api/health`.
- En-têtes de sécurité : sur toute réponse `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
  (une page ou un média sous `/t/<jeton>/` ne transmet jamais son adresse) et `X-Frame-Options: DENY` ; sur
  la page (et la page « non appairé ») un CSP : `default-src 'self'; script-src 'self' blob:` (aucun script
  en ligne ni gestionnaire `on…=` : un texte généré ou un flux RSS injecté ne s'exécute pas ; `blob:` pour
  le module audio de la détection de voix), `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:
  blob:`, `media-src 'self' data: blob: https:` (podcasts lus directement), `connect-src 'self'
  wss://<hôte> ws://<hôte>`, `worker-src 'self' blob:`, `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'`, plus `font-src 'self' data:`, `frame-src 'self'` (lecteur d'artefacts),
  `manifest-src 'self'` et `form-action 'self'`. La page ne doit donc jamais dépendre d'un script en ligne. Fichiers de
  `/learn`, `/tts`, `/t/…` : `Cache-Control: private, no-cache` et `Content-Security-Policy: default-src
  'none'; sandbox`. NPM ne doit pas mettre en cache (« Cache Assets » : non) : son cache ignore
  `Cache-Control` et resservirait ces fichiers sans jeton.
- Jetons : `tokens.json` dans le dossier de données, chaque jeton = 32 octets aléatoires en base64url,
  stocké **haché** (SHA-256) avec un nom d'appareil et sa date de création ; comparaison à temps
  constant ; 10 échecs par minute et par IP au plus (au-delà : 429 ; une adresse IPv6 compte pour son
  /64). En-tête `X-Forwarded-For` pris en compte (le serveur est derrière NPM) : sa **dernière** entrée
  (celle qu'ajoute NPM), et seulement quand la connexion vient d'une adresse de
  `REVIZATOR_TRUSTED_PROXIES` ; de même `X-Forwarded-Proto` (cookie `Secure`, contrôle d'origine du
  WebSocket). Au-delà de la limite, même un bon jeton reçoit 429 jusqu'à la fin de la minute. La table
  des échecs est nettoyée au plus toutes les 10 s et vidée au-delà de 20 000 adresses (pas de croissance
  sans fin, pas de parcours complet à chaque échec). Les jetons refusés ne sont jamais journalisés (le
  chemin `/t/<jeton>/…` est écrit `/t/…/…`). Les jetons passent dans des adresses (`/pair?token=`,
  `?token=` du WebSocket du PC, `/t/<jeton>/`) : le journal d'accès de NPM les contient (limite assumée,
  documentée dans `deploy/README.md`). `tokens.json` est relu dès qu'il change : `token new` et
  `token revoke` valent aussitôt pour le serveur qui tourne. `token new` sur un nom existant remplace
  son jeton.
- Ligne de commande (même exécutable) :
  - `revizator-server token new <appareil>` : crée un jeton, affiche le lien d'appairage
    `${REVIZATOR_PUBLIC_URL}/pair?token=…`, son QR code en caractères dans le terminal, et le jeton seul
    (pour Organizator sur le PC) ;
  - `revizator-server token list` / `token revoke <appareil>` ;
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
  `learnChanged` (§ 6). Les événements sont envoyés à toutes les connexions authentifiées.
- Le serveur envoie `{ event: 'ping' }` toutes les 20 s (les proxys coupent un WebSocket muet) ;
  messages de 32 Mo au plus (un `learnSave` ou un WAV en base64 peuvent être gros).

Types acceptés (tout autre type : erreur « Type de message non disponible sur le serveur Révizator ») :

- Révizator : `learnLoad`, `learnSave`, `learnDoc`, `learnDocSave`, `learnDocDelete`, `learnNews`,
  `learnGenerate`, `learnCancel`, `learnJobs`, `learnWait` ;
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
- le jeton d'une connexion est revérifié à chaque message et à chaque ping : un jeton révoqué (ou
  remplacé par `token new`) ferme aussi les connexions déjà ouvertes (code 1008, au plus 20 s) ;
- `log` : niveau réduit à 12 lettres, message coupé à 4 000 caractères (pas de fausse ligne de journal) ;
  `saveSettings` ne garde jamais `revizatorServerUrl` ni `revizatorServerToken` (réglages du PC) ;
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
3. **Organizator avec un serveur Révizator configuré** — réglages `revizatorServerUrl` et
   `revizatorServerToken` (dans `settings.json` du PC, champs ajoutés à `AppSettings.cs`). Les types de
   la liste du § 4 (sauf `getState`, `saveSettings`, `notify`, `log`, `perf`, qui restent locaux)
   partent par `wss://<serveur>/api/ws?token=<jeton>` ; les événements `learn`, `tts`, `asr`, `voice`,
   `whisper`, `learnChanged` du serveur sont émis dans la page ; ceux de l'hôte local pour ces mêmes
   noms sont ignorés. Serveur injoignable : les appels échouent avec « Serveur Révizator injoignable »
   (jamais de repli silencieux sur les données locales, qui divergeraient).
   **Exceptions** (ce qui n'existe que sur le PC) : un appel avec des fichiers joints
   (`bridge.call(…, files)`) et un `transcribe` qui porte un `path` (enregistrement joint à une tâche),
   ainsi que le `cancelTranscribe` de ce travail, restent sur l'hôte local, et les événements de l'hôte
   dont le `job` est celui d'un tel travail passent. De même pour tout appel dont le `payload` porte
   `local: true` : `app.js` le met sur la dictée des tâches (`transcribe`, `cancelTranscribe`) et sur les
   modèles Whisper de l'onglet Dictée (`whisperStatus`, `whisperDownload`, `whisperRemove`,
   `whisperWarm`) ; les événements `whisper` de ces travaux (même `job`) et de ces téléchargements (même
   `model`, sans `job`) passent. Le texte des tâches ne quitte donc jamais le PC.
   Les réglages ne sont connus qu'après `getState` : `app.js` appelle
   `bridge.configureRemote({ url, token })` juste après, avant le démarrage des pages, et Révizator le
   rappelle quand le réglage change (Réglages › Révizator › Serveur Révizator : adresse, jeton masqué,
   « Tester la connexion » = `bridge.testRemote` : `GET /api/health` puis ouverture du WebSocket avec le
   jeton → `online` / `unreachable` / `refused`, ou `invalid` pour une adresse illisible, affichés
   « Connecté » (avec la version du serveur), « Injoignable », « Jeton refusé » ; et « Enregistrer »).
   « Jeton refusé » veut dire : `/api/health` répond mais le WebSocket refuse ; un proxy qui bloquerait les
   WebSocket donnerait le même message, ou « Injoignable » s'il ne répond pas en 8 s. `configureRemote` émet
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
  démarrage rapide ; **jamais** `/api`, `/learn`, `/tts`, `/t/`, `/pair`). Enregistré par `app.js` en
  mode serveur seulement (`bridge.mode === 'server'`, contexte sécurisé), sous l'adresse
  `sw.js?v=<REVIZATOR_SERVER.version>` : une nouvelle version du serveur installe un nouveau service
  worker, dont le cache (`revizator-shell-<version>`) remplace l'ancien. Page et `revizator-server.js` :
  réseau d'abord (copie hors ligne) ; autres fichiers : copie d'abord, relue en arrière-plan.
- `mobile.css` n'agit que sous `@media (max-width: 600px)` (et `(hover: none)` / `(pointer: coarse)` pour
  les aides au survol et les raccourcis clavier) : en-tête d'une ligne collé en haut, onglets en bas
  d'écran, masqués dans les vues plein écran (séance, série d'exercices, révision des cartes, bilan en
  cours, conversation du tuteur), traductions des mots dans une bulle en bas d'écran, Réglages plein
  écran. Les icônes se régénèrent par `node tools/make-pwa-icons.mjs` (Chromium headless).
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

## 7. Déploiement (`deploy/`)

- `deploy/Dockerfile` : construction multi-étapes (SDK .NET 8 → `mcr.microsoft.com/dotnet/aspnet:8.0-noble`),
  `ffmpeg`, Claude Code (installeur natif) dans le `PATH`, DLL natives linux-x64 de sherpa-onnx et de
  Whisper.net, utilisateur non root, volume `/data`, port 8080, `HEALTHCHECK` sur `/api/health`.
- `deploy/docker-compose.yml` : prêt pour une stack Komodo, `restart: unless-stopped`, volume
  `/opt/revizator/data:/data`, variables du § 3 depuis un `.env`.
- `deploy/README.md` (français) : LXC Proxmox dédié (Debian 13, 4 cœurs, 6 Go, 30 Go, imbrication
  activée, IP fixe), Docker, stack Komodo, hôte proxy NPM `revizator.daft-lab.fr` (WebSocket activé,
  Let's Encrypt, « Block Common Exploits »), `claude setup-token`, import des données du PC, appairage
  du téléphone (QR) et du PC (Réglages › Révizator › Serveur), mise à jour, sauvegarde du volume.
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
    `docker exec revizator revizator-server token new …` ; `ASPNETCORE_HTTP_PORTS` vidé (le port vient de
    `REVIZATOR_PORT`) ;
  - compose : `pull_policy: build` (image locale `revizator-server:local`, jamais tirée d'un registre :
    Deploy dans Komodo reconstruit), `init: true` (tini récolte les processus de `claude`), port
    `8080:8080`, journaux `json-file` limités ; `REVIZATOR_PUBLIC_URL`, `REVIZATOR_ALLOWED_ORIGINS`,
    `REVIZATOR_TRUSTED_PROXIES`, `CLAUDE_CODE_OAUTH_TOKEN` et `TZ` interpolés depuis `.env` (écrit par Komodo à partir de
    l'« Environment » de la stack) ; `deploy/.env` est ignoré par git ;
  - `.dockerignore` à la racine : seul `src/` entre dans le contexte ;
  - import : `docker compose stop`, `docker compose run --rm --no-deps revizator import /data/import-pc`,
    `docker compose start`.

## 8. État des vérifications

Construit et vérifié dans le cloud (Linux, sans réseau vers les sites des modèles ni vers claude.ai) :

- builds : `Revizator.Server`, et l'hôte WPF par `dotnet build src/Organizator/Organizator.csproj -c
  Release -p:EnableWindowsTargeting=true`, sans erreur ni avertissement ;
- `node tools/revizator-server-smoke.mjs <url> <jeton>` : santé, CORS, refus sans jeton, appairage et
  cookie, page et injections, `learnLoad` / `learnSave` / `learnChanged` entre deux connexions, types
  refusés, `learnGenerate` (avec un faux `claude` qui imite la sortie stream-json), `/learn` par cookie
  et par `/t/<jeton>/`, traversées de chemin ;
- parcours complet dans Chromium (Playwright) contre le vrai serveur : un « téléphone » 390×844 et un
  « PC » 1400×900 appairés, premier lancement, série d'exercices, cartes révisées des deux côtés,
  fusion d'écritures concurrentes, relecture différée, service worker, serveur coupé puis relancé ;
  cas 3 (Organizator réglé sur le serveur) par le shim avec `window.__shimRemote` ;
- image Docker construite et lancée (`healthy`, UID 1654, script de fumée dans le conteneur, `token new`
  par `docker exec`, import), avec un faux `claude` ;
- revue de sécurité adverse (authentification, traversées, WebSocket, révocation, limiteur, en-têtes) :
  défauts trouvés corrigés et inscrits aux § 3 et 4.

Non vérifié : Claude Code réel, les modèles Kokoro, Parakeet et Whisper (seuls leurs échecs propres
l'ont été) et les flux RSS, `voiceStart` et le micro, WebView2 réel sous Windows (cas 3), Nginx Proxy
Manager et `wss`, Komodo, un vrai téléphone (iOS Safari, installation de la PWA, clavier virtuel). La
liste de contrôle de `deploy/FINALISER.md` reprend ces points sur le serveur.

Points connus :

- **iPhone** : l'application ajoutée à l'écran d'accueil peut ne pas retrouver le cookie posé dans
  Safari, et la page « appareil non appairé » n'a pas de champ pour coller un jeton ; à vérifier sur le
  téléphone (signalé dans `deploy/README.md` et `deploy/FINALISER.md`).
- **Jetons dans les adresses** (§ 3) : présents dans le journal d'accès de NPM ; les éviter demanderait de
  passer le jeton par `Sec-WebSocket-Protocol` dans `bridge.js`.
- **`WebFetch`** (cours, conversation vocale) peut être poussé par un flux RSS vers le réseau local :
  isoler le réseau du conteneur est recommandé.
- Un appareil appairé n'a pas de limite de connexions ni de file d'envoi (32 Mo par message) : acceptable
  tant que seuls les appareils de l'utilisateur sont appairés.
