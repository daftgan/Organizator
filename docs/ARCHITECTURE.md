# Organizator — Architecture et contrat JS ↔ .NET

## Vue d'ensemble

Organizator est une application de bureau Windows :

- **Hôte** : application WPF (.NET 8, `net8.0-windows`) qui affiche une seule fenêtre contenant un contrôle **WebView2** plein cadre. L'hôte gère la persistance sur disque, le lancement des sessions d'agent (Claude Code ou GitHub Copilot CLI) dans PowerShell, la lecture des fichiers de session des deux outils, le sélecteur de dossier et l'état de la fenêtre.
- **UI** : page HTML/CSS/JS **vanilla** (aucun framework, aucune étape de build) dans `src/Organizator/wwwroot/`. C'est le portage hi-fi du mockup `Mockup/design_handoff_organizator/`. Elle parle à l'hôte via `window.chrome.webview.postMessage`.

```
Organizator.sln
src/Organizator/
  Organizator.csproj          net8.0-windows, WPF, Microsoft.Web.WebView2, Microsoft.Data.Sqlite, System.Management
  App.xaml / App.xaml.cs
  MainWindow.xaml / .cs       WebView2 plein cadre, titre « Organizator »
  Bridge/                     réception des messages, dispatch, réponses
  Services/
    DataStore.cs              data.json + settings.json (écriture atomique)
    AgentProvider.cs          identifiants d'agent (claude / copilot), validation des noms de modèle
    AgentLauncher.cs          génère un .ps1 et lance PowerShell (claude ou copilot, --model, --effort)
    AgentProcessScanner.cs    processus claude/copilot vivants et leurs --session-id/--resume (WMI), toutes les 4 s
    ClaudeSessions.cs         lit ~/.claude/projects/<encodé>/<id>.jsonl
    CopilotSessions.cs        lit ~/.copilot/session-state/<id>/{workspace.yaml, events.jsonl}
    ModelCatalog.cs           types du catalogue de modèles envoyé à l'UI
    ClaudeModelCatalog.cs     alias + modèles déjà utilisés + défauts de ~/.claude/settings.json
    CopilotModelCatalog.cs    sonde ACP de la CLI Copilot, cache copilot-models.json, nettoyage de la session fantôme
    TranscriptAccumulator.cs  fusion des messages, choix du titre et état de la session, commun aux deux lecteurs
    SessionScan.cs            lecture incrémentale d'un JSONL en cours d'écriture (offset + accumulateur conservés)
    SessionsWatcher.cs        surveillance d'un dossier de sessions, regroupement des événements, reprise après panne
    TaskbarFlash.cs           clignotement du bouton dans la barre des tâches (FlashWindowEx)
    AgentUsage.cs             quotas : lecteurs Claude (API OAuth /usage) et Copilot (copilot_internal/user)
    UsageMonitor.cs           lecture des deux quotas en parallèle, cache 2 min, jauges gardées en cas de panne
    WindowsCredentials.cs     lecture du Gestionnaire d'identifiants Windows (jeton de la CLI Copilot)
    WwwRoot.cs                extraction des ressources embarquées
    InheritedEnvironment.cs   retrait de l'hérité d'une session Claude Code (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION…, NO_COLOR)
  wwwroot/                    index.html, app.css, app.js, organic.css, fonts.css, fonts/
docs/ARCHITECTURE.md          ce fichier
publish.ps1                   build + publication d'un exécutable unique
```

## Persistance

Dossier : `%LOCALAPPDATA%\Organizator\`

- `data.json` — `{ "version": 1, "tasks": [...], "types": [...], "convos": [...], "remarks": [...], "lastType": "k123" }`
- `settings.json` — `{ "topCount": 3, "showBands": true, "compact": false, "defaultCwd": "", "repoDir": "", "terminal": "powershell", "provider": "claude", "claudeModel": "", "copilotModel": "", "claudeEffort": "", "copilotEffort": "", "window": { "x", "y", "width", "height", "maximized" } }`. `provider`, `claudeModel` / `copilotModel` et `claudeEffort` / `copilotEffort` sont l'agent, le modèle et l'effort par défaut, réglés dans le dialogue Réglages : ils présélectionnent le formulaire de nouvelle conversation. Vide = réglage propre de l'outil (rien n'est passé sur la ligne de commande). `repoDir` est le dossier des sources d'Organizator proposé pour envoyer les remarques ; vide = `env.repoDir` (détecté).
- `copilot-models.json` — cache du catalogue Copilot : `{ "fetchedAt": ms, "models": [{ "id", "name", "usage", "price", "enabled" }] }`, rafraîchi par la sonde ACP (voir « Sessions GitHub Copilot CLI »).
- `probe\` — dossier de travail de la sonde ACP (vide).
- `launch\<sessionId>.ps1` — scripts de lancement générés (peuvent être supprimés à tout moment)
- `www\` — copie extraite des ressources web embarquées (réécrite à chaque démarrage)

Écriture atomique : écrire dans `data.json.tmp`, puis `File.Move(tmp, data.json, overwrite: true)`. Conserver `data.json.bak` (copie de la version précédente) avant chaque remplacement. À la lecture, si `data.json` est corrompu, tenter `data.json.bak`.

## Modèles de données (JSON, camelCase)

```
task:  { id: string, type: string, text: string, done: bool, doing: bool, created: number(ms epoch) }
type:  { id: string, label: string, bg: string, fg: string, bd: string, custom: true }
convo: { id: string(uuid v4 minuscule = sessionId de l'outil), taskId: string, title: string,
         provider: "claude" | "copilot", model: string ("" = modèle par défaut de l'outil),
         effort: string ("" = réglage propre de l'outil),
         cwd: string, created: number, updated: number, messageCount: number }
remark: { id: string, text: string, created: number, sentAt: number (0 = en attente), sessionId: string (session qui l'a reçue) }
```

L'ordre du tableau `tasks` **est** la priorité. `convos` ne contient plus de messages : la conversation vit dans l'outil ; l'hôte lit le fichier de session pour fournir titre, nombre de messages, date et transcription en lecture seule. Une `convo` sans `provider` (données antérieures) est une session Claude. Les conversations du carnet de remarques portent `taskId: "__feedback__"`, l'identifiant d'une tâche virtuelle que l'UI ne liste jamais.

## Sessions Claude Code

- Lancement d'une nouvelle session : `claude --dangerously-skip-permissions --session-id <uuid> --name "<titre>" [--model <modèle>] [--effort <niveau>] --append-system-prompt <contexte>` dans le dossier `cwd`.
- Reprise : `claude --dangerously-skip-permissions --resume <uuid> [--model <modèle>] [--effort <niveau>] --append-system-prompt <contexte>` dans le **même** `cwd` (Claude range les sessions par dossier de travail).
- `--model` accepte un alias (`fable`, `opus`, `sonnet`, `haiku`) ou un identifiant complet (`claude-opus-5`). `--effort` : `low`, `medium`, `high`, `xhigh`, `max`.
- La CLI n'expose aucun listing de modèles. La liste proposée (`ClaudeModelCatalog`) combine les alias, les identifiants déjà utilisés sur le poste (`~/.claude/stats-cache.json` → `modelUsage`, `~/.claude.json` → `projects.*.lastModelUsage`) et les valeurs par défaut de `~/.claude/settings.json` (`model`, `effortLevel`), affichées dans l'option « Par défaut de l'outil ».
- Fichiers de session : `%USERPROFILE%\.claude\projects\<cwd encodé>\<uuid>.jsonl`. Encodage du cwd : chaque caractère qui n'est pas `[A-Za-z0-9]` est remplacé par `-`, casse conservée. Exemples : `D:\02-side\Organizator` → `D--02-side-Organizator`, `C:\Users\dagan.remeur\Impot` → `C--Users-dagan-remeur-Impot`.
- Format JSONL (une entrée JSON par ligne). Entrées utiles :
  - `{"type":"user","message":{"role":"user","content":"texte" | [{"type":"text","text":"..."} | {"type":"tool_result",...}]},"timestamp":"ISO","uuid":"..."}`
  - `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."} | {"type":"tool_use","name":"Read",...}]},"timestamp":"ISO"}`
  - `{"type":"ai-title","aiTitle":"..."}` et éventuellement `{"type":"custom-title","customTitle":"..."}` — titre de la session.
  - Autres types (`mode`, `permission-mode`, `attachment`, `file-history-snapshot`, `last-prompt`, `summary`, `progress`, `system`…) à ignorer.
  - Ignorer les entrées `isSidechain: true` et les messages `user` dont le contenu n'est que des `tool_result`, ou dont le texte commence par `<` (commandes locales type `<command-name>`, `<local-command-stdout>`).
- Compte de messages = nombre d'entrées `user` (texte réel) + `assistant` (au moins un bloc `text` non vide).
- Titre = `customTitle` si présent, sinon `aiTitle`, sinon première ligne du premier message utilisateur (46 caractères), sinon « Nouvelle session ».
- État (voir « État des sessions ») : chaque ligne `assistant` porte le `stop_reason` **final** de son message API — `tool_use` tant que l'agent enchaîne des outils, `end_turn` (ou `stop_sequence`, `max_tokens`) quand la réponse est complète. Une entrée `user` texte relance le traitement, un `tool_result` le poursuit, `[Request interrupted…]` l'interrompt ; `isApiErrorMessage` et `isAbortedMidStream` terminent le tour ; `isCompactSummary` n'est pas un tour. Un `tool_use` nommé `AskUserQuestion` met la session en attente de l'utilisateur.

## Sessions GitHub Copilot CLI

- Lancement : `copilot --allow-all --session-id=<uuid> --name "<titre>" [--model <modèle>] [--effort <niveau>] -i <contexte>` dans le dossier `cwd`. Copilot n'a pas d'équivalent de `--append-system-prompt` : le contexte de la tâche est envoyé comme **premier message** de la session.
- Reprise : `copilot --allow-all --resume=<uuid> [--model <modèle>] [--effort <niveau>]` dans le même `cwd`. Le contexte n'est pas renvoyé, il est déjà dans l'historique. `--effort` : `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- Fichiers de session : `%USERPROFILE%\.copilot\session-state\<uuid>\` (pas de classement par dossier de travail). `workspace.yaml` porte `name:` (titre donné par Copilot, ou par l'utilisateur quand `user_named: true`) et `cwd:` ; `events.jsonl` contient un événement JSON par ligne.
  - `{"type":"user.message","data":{"content":"…"},"timestamp":"ISO"}` — message de l'utilisateur.
  - `{"type":"assistant.message","data":{"content":"…","toolRequests":[{"name":"powershell",…}]},"timestamp":"ISO"}` — réponse de l'agent ; chaque entrée de `toolRequests` donne une ligne `[outil : nom]`.
  - Les événements qui portent un `agentId` à la racine viennent des sous-agents : ignorés (équivalent de `isSidechain`). Les autres types ne servent qu'à l'état de la session : `assistant.turn_start` / `assistant.turn_end`, `tool.execution_start` / `tool.execution_complete`, `permission.requested` / `permission.completed`, `abort`, `session.error`, `session.start` / `session.resume` / `session.shutdown`. Copilot écrit un `assistant.turn_end` après **chaque** appel du modèle, outils compris : la réponse n'est complète que si aucun `assistant.message` du tour ne portait de `toolRequests`.
- Compte de messages = `user.message` non vides + `assistant.message` dont `content` est non vide.
- Titre = `name` de `workspace.yaml`, sinon première ligne du premier message utilisateur (46 caractères), sinon « Nouvelle session ».
- Détection de la CLI : `copilot.exe` / `copilot.cmd` dans le PATH (en ignorant le « bootstrapper » que l'extension VS Code dépose dans `globalStorage\github.copilot-chat`, qui ne fait que chercher la vraie CLI), sinon `%LOCALAPPDATA%\GitHub CLI\copilot\copilot.exe` (téléchargée par `gh copilot`), sinon `gh copilot --` si `gh.exe` est dans le PATH. Le chemin complet est toujours écrit dans le script.
- Catalogue des modèles (`CopilotModelCatalog`) : la CLI ne l'expose que par son mode **ACP** (Agent Client Protocol, JSON-RPC sur stdio). La sonde lance `copilot --acp --no-auto-update` avec `probe\` comme dossier de travail, envoie `initialize` puis `session/new`, et lit `result.models.availableModels[]` : `modelId`, `name`, `_meta.copilotUsage` (multiplicateur, ex. `1x`), `_meta.copilotPriceCategory` (`low` / `medium` / `high`), `_meta.copilotEnablement`. Elle envoie ensuite `session/close` et ferme l'entrée standard. La CLI ne purge jamais la session vide ainsi créée : la sonde supprime son dossier `session-state\<uuid>` (seulement s'il n'a pas d'`events.jsonl`) et sa ligne `sessions` dans `session-store.db` (Microsoft.Data.Sqlite), pour qu'elle n'apparaisse pas dans `copilot --resume`. Résultat mis en cache dans `copilot-models.json` ; rafraîchi quand il a plus de 24 h (au démarrage, en silence) ou à la demande (bouton ↻, message `refreshModels`). Sans cache, la liste se limite à `auto` et aux identifiants déjà vus dans `~/.copilot` (`settings.json` → `model`, `config.json` → `recentModelIds`, `session.start` → `selectedModel`). Les valeurs par défaut de `~/.copilot/settings.json` (`model`, `effortLevel`) sont affichées dans l'option « Par défaut de l'outil ».
- Le champ libre accepte tout identifiant `[A-Za-z0-9._:/[]-]` (64 caractères max) ; le reste est refusé avant d'être écrit dans un script.

## État des sessions

Chaque conversation affiche ce que fait l'agent. L'état vient de deux sources :

- **Le transcript** (`TranscriptAccumulator.State`, calculé par les deux lecteurs pendant la lecture normale) : `working` (prompt en traitement, outil en cours), `waiting` (question posée via `AskUserQuestion`, autorisation demandée par Copilot), `ready` (réponse complète), `error` (erreur d'API, authentification), `idle` (pas encore de prompt, tour interrompu, session refermée). `stateTs` est l'horodatage d'**entrée** dans l'état : « en cours depuis » le prompt, « réponse prête à » l'heure du `end_turn`. `detail` précise l'outil en cours, le motif (`interrompue`, `fermee`, `question posee`, `autorisation demandee`) ou le message d'erreur (première ligne, 80 caractères).
- **Les processus** (`AgentProcessScanner`) : toutes les 4 s, une requête WMI `Win32_Process` (`System.Management`) liste `claude.exe`, `copilot.exe`, `node.exe` et `bun.exe` et extrait les `--session-id` / `--resume` de leur ligne de commande (environ 300 ms, sur un thread du pool). `alive` vaut `true`/`false`, ou `null` tant que WMI n'a pas répondu ou s'il est indisponible (abandon après 3 échecs, journalisé). Un changement de l'ensemble déclenche `sessionsChanged`.

L'UI en déduit l'état affiché : `alive === false` → « Fermée » quel que soit le transcript ; fichier absent mais processus vivant → « Ouverte » ; sinon l'état du transcript. Sur une carte de tâche, l'état le plus pressant de ses conversations (`working` > `waiting` > `error` > `ready`) est porté par le **bouton terminal** lui-même : classe `is-<état>` sur le bouton (teinte et bordure) et `.btn-dot.st-<état>` posée dans son coin, l'infobulle reprenant `stateText` de la conversation concernée. Quand une conversation passe de `working`/`waiting` à `ready`, l'UI affiche un toast et envoie `notify` : l'hôte fait clignoter le bouton de la barre des tâches (`FlashWindowEx`) si la fenêtre n'est pas au premier plan.

### Fraîcheur de l'affichage

Trois mécanismes bornent le délai entre « l'agent a répondu » et « la carte le montre » :

- **Lecture incrémentale** (`SessionScan`) : un fichier de session atteint plusieurs mégaoctets et grossit à chaque outil ; le relire en entier à chaque écriture coûtait ~30 ms par rafraîchissement et par session. Chaque lecteur garde, par session, l'octet où il s'est arrêté et l'accumulateur correspondant : seules les lignes ajoutées sont relues (une ligne encore sans `\n` est laissée au passage suivant). Un fichier plus court, ou modifié sans avoir grandi, fait repartir la lecture du début — comme un fichier supprimé puis recréé. Un scan par session pour les résumés, un seul pour la transcription (l'UI n'en affiche qu'une).
- **Notification** (`SessionsWatcher`) : les événements du `FileSystemWatcher` sont regroupés sur 250 ms, mais jamais repoussés au-delà d'**1 s** — un agent qui écrit sans arrêt retardait sinon la notification indéfiniment. Tampon de 256 Ko ; si la surveillance tombe (débordement) ou si le dossier n'existe pas encore (Copilot avant la première session), une reprise est tentée toutes les 15 s et `sessionsChanged` est levé dès qu'elle aboutit, des événements ayant été manqués.
- **Relecture périodique** (UI) : filet de sécurité si une notification manque malgré tout. `refreshSessions` toutes les 1,5 s tant qu'une conversation est `working`/`waiting`/`open`, 10 s sinon, 30 s fenêtre cachée ; relance immédiate au retour au premier plan. Le rendu n'est refait que si un état a changé, pour ne pas interrompre une sélection ou une saisie. La transcription ouverte est relue toutes les 2 s.

`getSessions` porte sur **toutes** les conversations à chaque `sessionsChanged`, `focus`, relecture périodique et au démarrage. L'hôte garde en cache le résumé de chaque transcript avec une empreinte taille + date (`GetStamp`) et ne redemande une lecture que pour les fichiers qui ont changé.

## Quotas des agents

Deux cartes en tête de fenêtre montrent la part consommée des limites de chaque agent (`UsageMonitor`, message `getUsage`) :

- **Claude** (`ClaudeUsageReader`) : `GET https://api.anthropic.com/api/oauth/usage` avec le jeton OAuth de `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`, en-tête `anthropic-beta: oauth-2025-04-20`), l'appel que Claude Code fait pour `/usage`. Le tableau `limits` donne `session` (5 h), `weekly_all` et `weekly_scoped` (par modèle, `scope.model.display_name`) en `percent` avec `resets_at` ; les champs historiques `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` servent de repli, et `extra_usage` ajoute une jauge s'il est activé. Le plan vient de `subscriptionType` + `rateLimitTier` (« Max 5× »). Le jeton n'est jamais renouvelé par Organizator : passé `expiresAt`, l'état est `expired` jusqu'à ce que Claude Code le rafraîchisse.
- **Copilot** (`CopilotUsageReader`) : hôte et login du dernier compte connecté dans `~/.copilot/config.json` (JSON avec commentaires, `lastLoggedInUser`), jeton OAuth lu dans le Gestionnaire d'identifiants Windows (`WindowsCredentials`, cible `copilot-cli/<hôte>:<login>`, UTF-8 ou UTF-16), sinon `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`. `GET <api>/copilot_internal/user` (`Authorization: token …`) avec `api.github.com`, `api.<sous-domaine>.ghe.com` pour la résidence des données, `<hôte>/api/v3` pour GHES. `quota_snapshots.premium_interactions` donne `entitlement`, `remaining`, `percent_remaining`, `overage_permitted` ; `chat` et `completions` ne donnent une jauge que s'ils ne sont pas `unlimited` ; `quota_reset_date` (jour, minuit local) et `copilot_plan`.

Chaque rapport porte `status` (`ok` ; `missing` : pas de compte connecté ; `expired` : jeton périmé ou refusé ; `error` : réseau), un `message` technique ASCII, `plan`, `account`, `host` et des `bars` (`key` session/weekly/extra/premium/chat/completions, `scope`, `percent` consommé, `used`, `limit`, `overage`, `resetsAt`). L'UI porte les libellés et les messages accentués. L'hôte lit les deux en parallèle (délai 12 s), garde la dernière lecture 2 min sauf `force`, et en cas d'erreur réseau rend les jauges précédentes marquées `stale`. L'UI relit toutes les 5 min fenêtre visible, au `focus`, 2 s après l'arrivée d'une réponse (le quota vient de bouger), et d'un clic sur une carte. Aucun jeton n'est journalisé ni transmis à l'UI.

Les dialogues (nouvelle tâche, réglages) ne se ferment que par leurs boutons ou Échap : le fond (`.dialog-backdrop`) ne porte plus d'action.

## Remarques sur Organizator

Le carnet (bouton « Remarques » de l'en-tête) est une tâche virtuelle côté UI : `taskById("__feedback__")` renvoie un objet fixe, jamais présent dans `tasks`, si bien que le panneau, le formulaire de lancement, la liste des sessions et le transcript sont ceux des tâches ordinaires. Ses conversations ont `taskId: "__feedback__"`.

- `remarks` (data.json) : une remarque est en attente tant que `sentAt` vaut 0 ; l'envoi la date et note la session (`sessionId`). L'historique des envoyées est effaçable d'un bouton.
- Envoi direct (bouton principal) : agent par défaut des réglages (ou le seul installé), son modèle et son effort par défaut, dossier = `settings.repoDir` / dernière session / `env.repoDir` ; le texte encore saisi devient une remarque avant l'envoi. Sans dossier connu, le formulaire s'ouvre. Le lien secondaire ouvre ce formulaire (agent, modèle, effort, dossier).
- Envoi : `startSession` avec `context` = consignes fixes (lire README et ARCHITECTURE, construire via la solution, ne pas fermer l'application qui tourne, préserver `%LOCALAPPDATA%\Organizator`, répondre en français) et `prompt` = les remarques numérotées comme dans le panneau (les lignes suivantes d'une remarque sont indentées de trois espaces), suivi d'une consigne de récapitulatif. Titre : `Remarques Organizator · <n> · <date>`.
- Envoi dans une session existante : `resumeSession` avec le même `prompt` (bouton ↪ sur la session) ; le contexte est déjà dans l'historique.
- Dossier de travail proposé : `settings.repoDir`, sinon le dossier de la dernière session du carnet, sinon `env.repoDir` (premier parent de l'exécutable contenant `Organizator.sln`).
- Bouton de l'en-tête : badge = remarques en attente ; point d'état = état le plus pressant des sessions du carnet (même règle que la pastille des cartes de tâches).

## Contrat de messages (bridge)

### JS → hôte

```js
window.chrome.webview.postMessage({ id: "<uuid ou compteur>", type: "<type>", payload: {...} });
```

L'hôte répond **toujours** avec un message au même `id` :

```js
{ id, ok: true,  payload: {...} }
{ id, ok: false, error: "message lisible en français" }
```

L'hôte peut aussi envoyer des événements non sollicités : `{ event: "<nom>", payload }`.

| type              | payload (JS → hôte)                                            | réponse (payload)                                                                 |
| ----------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `getState`        | `{}`                                                           | `{ data: { tasks, types, convos, remarks, lastType }, settings, env }`                     |
| `saveData`        | `{ tasks, types, convos, remarks, lastType }`                           | `{}`                                                                              |
| `saveSettings`    | `{ topCount, showBands, compact, defaultCwd, terminal, provider, claudeModel, copilotModel, claudeEffort, copilotEffort, repoDir }` | `{}` (l'hôte conserve `window` lui-même)   |
| `pickFolder`      | `{ initial: string }`                                          | `{ path: string \| null }` (null si annulé)                                       |
| `startSession`    | `{ taskId, provider, model, effort, cwd, title, context, prompt }`     | `{ sessionId, cwd, created, provider, model, effort }` — l'hôte génère l'uuid et lance PowerShell |
| `resumeSession`   | `{ sessionId, provider, model, effort, cwd, title, context, prompt }`  | `{}`                                                                              |
| `getSessions`     | `{ sessions: [{ sessionId, cwd, provider }] }`                 | `{ sessions: [{ sessionId, exists, messageCount, updated, title, state, stateTs, detail, alive }] }` — `state` ∈ working/waiting/ready/error/idle, `alive` bool ou null |
| `getTranscript`   | `{ sessionId, cwd, provider }`                                 | `{ exists, title, messages: [{ role: "user"\|"assistant", text, ts }] }` (max 300 derniers) |
| `refreshModels`   | `{ provider: "copilot", force: bool }`                         | `{ copilot: <catalogue, même forme que env.models.copilot> }` — sonde ACP, jusqu'à ~60 s ; l'UI attend 90 s |
| `notify`          | `{ count, title }`                                             | `{ flashed: bool }` — une réponse est arrivée : clignotement dans la barre des tâches si la fenêtre est en arrière-plan |
| `getUsage`        | `{ force: bool }`                                              | `{ fetchedAt, claude: rapport, copilot: rapport }` — voir « Quotas des agents » ; sans `force`, lecture de moins de 2 min rendue telle quelle |

`provider` vaut `"claude"` ou `"copilot"` (absent ou inconnu = `"claude"`). `model` est vide ou un nom validé par l'hôte ; `effort` est vide ou l'un des niveaux de l'outil (erreur lisible sinon). `prompt` (facultatif) est le premier message de l'utilisateur, envoyé dès l'ouverture ; vide, l'agent attend la saisie.
| `openPath`        | `{ path }`                                                     | `{}` — ouvre le dossier dans l'Explorateur                                        |
| `log`             | `{ level, message }`                                           | `{}` — trace dans la sortie debug de l'hôte                                       |

`env` = `{ version: "1.0.0", hasClaude: bool, hasCopilot: bool, hasWt: bool, defaultCwd: string, dataDir: string, userProfile: string, repoDir: string, models: { claude: <catalogue>, copilot: <catalogue> }, efforts: { claude: [niveaux…], copilot: [niveaux…] } }`.
Un catalogue = `{ defaultModel, defaultEffort, fetchedAt (ms, 0 = jamais détecté), groups: [{ key, items: [{ id, name?, usage?, price?, enabled? }] }] }`. `key` est traduit par l'UI (`alias`, `used`, `auto`, `claude`, `gpt`, `gemini`, `grok`, `other`) ; l'UI compose le libellé « nom · 1× · prix moyen ». La liste déroulante ajoute « Par défaut de l'outil » (avec `defaultModel`) en tête et « Autre… » (champ libre) en queue.
`defaultCwd` de `env` = `settings.defaultCwd` si non vide, sinon le dossier Documents de l'utilisateur. `repoDir` = premier parent de l'exécutable contenant `Organizator.sln`, sinon vide.

Événements hôte → JS :

| event             | payload                | quand                                                                 |
| ----------------- | ---------------------- | --------------------------------------------------------------------- |
| `sessionsChanged` | `{}`                   | un `*.jsonl` sous `~/.claude/projects` ou un `events.jsonl` sous `~/.copilot/session-state` a changé (debounce 1 s), ou l'ensemble des processus d'agent vivants a changé |
| `focus`           | `{}`                   | la fenêtre reprend le focus                                           |

### Contexte transmis à Claude

`context` (construit côté JS) :

```
Tu travailles sur la tâche suivante, extraite d'Organizator (file de tâches de l'utilisateur).
Catégorie : <label>
Tâche :
<texte complet de la tâche>
Réponds en français.
```

`title` = première ligne de la tâche, 46 caractères max.

Pour le carnet de remarques, `context` est un texte fixe (consignes du dépôt) et `prompt` porte les remarques ; voir « Remarques sur Organizator ».

### Script PowerShell généré (hôte)

```powershell
$Host.UI.RawUI.WindowTitle = 'Organizator — <titre>'
Set-Location -LiteralPath '<cwd>'
$ctx = @'
<contexte, tel quel>
'@
$ctx = [regex]::Replace($ctx, '(\\*)"', '$1$1\"')
if ($ctx -match '\s') { $ctx = [regex]::Replace($ctx, '(\\+)$', '$1$1') }
& claude --dangerously-skip-permissions --session-id '<uuid>' --name '<titre>' --model '<modèle>' --effort '<niveau>' --append-system-prompt $ctx
```

Pour une reprise : `& claude --dangerously-skip-permissions --resume '<uuid>' [--model '<modèle>'] [--effort '<niveau>'] --append-system-prompt $ctx`.
Avec un `prompt`, un second here-string `$msg` (mêmes deux lignes de protection) est ajouté en argument positionnel final : `… --append-system-prompt $ctx $msg`, à la création comme à la reprise ; claude ouvre la session et traite ce message aussitôt.
Avec Copilot : `& '<chemin>\copilot.exe' --allow-all --session-id=<uuid> --name '<titre>' [--model '<modèle>'] [--effort '<niveau>'] -i $ctx`, et à la reprise `--resume=<uuid>` sans `-i`. Copilot n'ayant pas de prompt système, un `prompt` est fusionné au contexte dans `$ctx` (contexte, ligne vide, message) à la création ; à la reprise, `$ctx` ne contient que le message et `-i $ctx` est écrit.
`--model` et `--effort` ne sont écrits que si une valeur a été choisie ; `--append-system-prompt` / `-i` que si le contexte n'est pas vide (PowerShell 5.1 supprime un argument vide, l'option resterait sans valeur).
Les apostrophes dans les chaînes simples sont doublées (`'` → `''`). Le here-string `@'…'@` n'a pas besoin d'échappement (le terminateur `'@` doit être seul en début de ligne).
Les deux lignes `[regex]::Replace` compensent un défaut de Windows PowerShell 5.1 : il n'échappe pas les guillemets doubles quand il transmet un argument à un exécutable natif, si bien qu'un texte de tâche contenant `"` arrivait tronqué et découpé. Elles appliquent les règles de `CommandLineToArgvW` (antislashs doublés devant un guillemet, guillemet échappé, antislashs finaux doublés quand PowerShell entourera l'argument de guillemets). Le titre passé à `--name` subit le même traitement côté hôte (`AgentLauncher.NativeArg`).

Commande de lancement : `powershell.exe -NoExit -NoLogo -ExecutionPolicy Bypass -File "<script.ps1>"` avec `WorkingDirectory = cwd`, nouvelle console. Si `settings.terminal == "wt"` et que `wt.exe` existe : `wt.exe -d "<cwd>" powershell.exe -NoExit -NoLogo -ExecutionPolicy Bypass -File "<script.ps1>"`.

Environnement hérité : au démarrage, l'hôte retire de son propre environnement les marqueurs qu'une session Claude Code pose dans ses processus enfants (`InheritedEnvironment` : `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`) et note dans `host.log` ceux qu'il a trouvés. Lancé depuis une session Claude Code (par exemple par l'agent des remarques après une publication), Organizator les transmettrait sinon à chaque `claude` qu'il ouvre ; celui-ci se croirait session enfant et n'enregistrerait pas sa transcription (« Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker ») : conversation illisible dans le panneau et impossible à reprendre. Les variables que l'utilisateur fixe lui-même dans `~/.claude/settings.json` (`env`) ne sont pas touchées : `claude` les réapplique à son démarrage.

Même passage, mêmes causes : les variables qui coupent la couleur (`NO_COLOR`, `FORCE_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`) sont retirées elles aussi. Claude Code pose `NO_COLOR=1` dans ses enfants pour lire leur sortie sans codes ANSI ; hérité, il rendait **entièrement gris** chaque terminal ouvert depuis Organizator, l'agent y suivant la règle de `supports-color`. Elles ne sont retirées que si elles ne figurent **pas** dans l'environnement persistant de l'utilisateur ou de la machine (`EnvironmentVariableTarget.User` / `Machine`, c'est-à-dire le registre) : un réglage voulu est respecté, un réglage hérité d'un parent ne l'est pas.

## Mode développement

- `Organizator.exe --wwwroot <dossier>` sert l'UI depuis ce dossier au lieu des ressources embarquées (F5 dans la WebView recharge la page ; l'hôte doit autoriser F5 / Ctrl+R).
- `Organizator.exe --data <dossier>` remplace `%LOCALAPPDATA%\Organizator`.
- Dans un navigateur ordinaire (sans `window.chrome.webview`), l'UI utilise un **shim** : persistance dans `localStorage`, sessions simulées, `pickFolder` via `prompt()`. Ceci permet de développer et tester l'UI dans Chrome.

## Build

Toujours via la solution avec MSBuild 18 :

```
& "C:\Program Files\Microsoft Visual Studio\18\Professional\MSBuild\Current\Bin\amd64\MSBuild.exe" Organizator.sln /restore /p:Configuration=Release /v:m
```

Publication (exécutable unique, dépendant du runtime .NET 8 installé) : `publish.ps1` → `publish\Organizator.exe`.
