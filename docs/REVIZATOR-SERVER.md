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
  `OperatingSystem.IsWindows()` dans le fichier partagé quand c'est court, sinon une implémentation
  propre au serveur dans `src/Revizator.Server/Platform/` (par exemple le décodage audio par `ffmpeg`).
- **L'hôte WPF doit se comporter exactement comme avant sous Windows.** Vérification sous Linux :
  `dotnet build src/Organizator/Organizator.csproj -c Release -p:EnableWindowsTargeting=true` doit
  rester sans erreur (le SDK Microsoft.NET.Sdk.WindowsDesktop est installé dans cet environnement).
- Les URL que les services mettent dans leurs réponses restent les hôtes virtuels de WebView2
  (`https://learn.organizator/…`, `https://tts.organizator/…`) : c'est la page qui les traduit (§ 5).

## 3. Serveur HTTP

Configuration par variables d'environnement :

| Variable | Défaut | Rôle |
|---|---|---|
| `REVIZATOR_DATA` | `/data` | dossier de données (même disposition que `%LOCALAPPDATA%\Organizator\` pour Révizator) |
| `REVIZATOR_PORT` | `8080` | port HTTP (TLS assuré par le reverse proxy) |
| `REVIZATOR_PUBLIC_URL` | `http://localhost:8080` | adresse publique, pour les liens d'appairage |
| `REVIZATOR_ALLOWED_ORIGINS` | `https://app.organizator` | origines autorisées en CORS (la page d'Organizator dans WebView2) |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | jeton de `claude setup-token`, lu par Claude Code |
| `REVIZATOR_CLAUDE` | `claude` (dans le `PATH`) | chemin de l'exécutable Claude Code |

Routes :

| Route | Auth | Rôle |
|---|---|---|
| `GET /api/health` | non | `{ ok, version }` |
| `GET /pair?token=…` | jeton | pose le cookie `rz_token` (HttpOnly, Secure si HTTPS, SameSite=Lax, 400 jours) et redirige vers `/` |
| `GET /` , `/index.html` | cookie | `wwwroot/index.html` avec deux injections (ci-dessous) ; sans cookie valide : petite page « appareil non appairé » |
| `GET /<fichier de wwwroot>` | non | fichiers statiques de la page (aucune donnée personnelle) |
| `GET /api/ws` | cookie ou `?token=` | WebSocket du pont (§ 4) |
| `GET /learn/…`, `GET /t/<jeton>/learn/…` | cookie / jeton dans le chemin | dossier `learning/` (ce que sert `learn.organizator`) |
| `GET /tts/…`, `GET /t/<jeton>/tts/…` | cookie / jeton dans le chemin | cache des phrases synthétisées (ce que sert `tts.organizator`) |

- Injections dans `index.html` servi par le serveur : avant `<script src="bridge.js">`, la ligne
  `<script src="revizator-server.js"></script>` (fichier **généré** par le serveur :
  `window.REVIZATOR_SERVER = { mode: 'revizator', version: '…', wsUrl: '/api/ws' };`) ; avant
  `</head>` : `<link rel="manifest" href="manifest.webmanifest"><meta name="theme-color" content="…">
  <link rel="apple-touch-icon" href="icons/icon-192.png"><link rel="stylesheet" href="mobile.css">`.
  L'hôte WPF, lui, sert `index.html` tel quel.
- Les fichiers de `wwwroot` sont ceux de `src/Organizator/wwwroot` (copiés dans la sortie du build du
  serveur, ou embarqués), jamais modifiés à l'exécution.
- Statique : aucun chemin ne sort de son dossier racine (`..`, chemins absolus, liens symboliques
  refusés) ; `Cache-Control: no-cache` sur `index.html`, `revizator-server.js` et `sw.js`.
- CORS : seulement pour `REVIZATOR_ALLOWED_ORIGINS`, sur `/learn`, `/tts`, `/t/…` et `/api/health`.
- Jetons : `tokens.json` dans le dossier de données, chaque jeton = 32 octets aléatoires en base64url,
  stocké **haché** (SHA-256) avec un nom d'appareil et sa date de création ; comparaison à temps
  constant ; 10 échecs par minute et par IP au plus (au-delà : 429). En-tête `X-Forwarded-For` pris en
  compte (le serveur est derrière NPM).
- Ligne de commande (même exécutable) :
  - `revizator-server token new <appareil>` : crée un jeton, affiche le lien d'appairage
    `${REVIZATOR_PUBLIC_URL}/pair?token=…`, son QR code en caractères dans le terminal, et le jeton seul
    (pour Organizator sur le PC) ;
  - `revizator-server token list` / `token revoke <appareil>` ;
  - `revizator-server import <dossier>` : importe `learning.json` et `learning/` depuis une copie du
    dossier `%LOCALAPPDATA%\Organizator\` du PC (sauvegarde de l'existant avant d'écraser).
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

Commun aux cas 2 et 3 : reconnexion automatique (1 s, 2 s, 5 s, puis toutes les 10 s), appels en
attente rejetés à la coupure, file d'envoi pendant la reconnexion pour les appels de moins de 10 s,
`bridge.on('connection', fn)` (`{ state: 'online'|'offline'|'connecting' }`) pour un bandeau discret.

**Traduction des URL** : dans toutes les chaînes des réponses et des événements venus du serveur,
`https://learn.organizator/` devient `<base>/learn/` et `https://tts.organizator/` devient
`<base>/tts/`, où `<base>` vaut l'origine du serveur (cas 2) ou `https://<serveur>/t/<jeton>` (cas 3).
La traduction **inverse** s'applique à tout ce que la page envoie au serveur : `learning.json` et les
documents gardent les hôtes virtuels, et restent portables entre le PC et le serveur. `env.learnUrl` et
`env.ttsUrl` sont traduits de la même façon.

### 5.2 Mode « Révizator seul » (`app.js`)

Actif quand `window.REVIZATOR_SERVER.mode === 'revizator'` (ou `?mode=revizator` dans le shim, pour les
tests) :

- la page Révizator est la seule : pas d'onglet File, pas de file de tâches, pas de cartes de quotas ni
  d'articles, pas de cloche ni de remarques ; l'en-tête garde le titre, l'avancement de la semaine, la
  connexion et les réglages ;
- Réglages : seulement l'onglet Révizator (et ce qui concerne la voix et la dictée) ;
- rien de ce qui touche aux tâches n'est appelé (`saveData`, `getSessions`, `getUsage`, …).

### 5.3 Téléphone

- `mobile.css` (chargé seulement par le serveur) : mise en page pour 360–430 px de large, cibles
  tactiles de 44 px, barre d'onglets de Révizator défilante ou en bas d'écran, séance et exercices en
  plein écran, clavier virtuel pris en compte (`100dvh`, `env(safe-area-inset-*)`), pas de survol
  indispensable (les traductions au survol s'ouvrent au toucher).
- PWA : `wwwroot/manifest.webmanifest` (nom « Révizator », `display: standalone`, `start_url: "/"`),
  `wwwroot/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, et `wwwroot/sw.js` (service
  worker à la racine : met en cache l'enveloppe de la page — HTML, CSS, JS, polices, icônes — pour un
  démarrage rapide ; **jamais** `/api`, `/learn`, `/tts`, `/t/`, `/pair`). Enregistré par `app.js` en
  mode serveur seulement.
- Micro : `getUserMedia` exige HTTPS (assuré par NPM) ; le PCM et les WAV partent par le WebSocket comme
  dans WebView2.

## 6. Plusieurs appareils en même temps

`learning.json` est écrit en entier par la page (`learnSave`). Après chaque `learnSave` réussi, le
serveur envoie `{ event: 'learnChanged', payload: { rev, at } }` aux **autres** connexions (`rev` :
compteur incrémenté à chaque écriture). Dans `revizator/core.js`, à la réception : si rien n'attend
d'être sauvegardé, la page relit `learnLoad` et se redessine (sans interrompre une séance en cours :
elle attend la fin de la séance ou le retour à l'accueil) ; sinon, sa propre sauvegarde l'emporte
(dernier écrit gagnant). Limite assumée et documentée : faire réviser ses cartes sur deux appareils
**au même moment** peut perdre les réponses de l'un des deux.

## 7. Déploiement (`deploy/`)

- `deploy/Dockerfile` : construction multi-étapes (SDK .NET 8 → `mcr.microsoft.com/dotnet/aspnet:8.0`),
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
