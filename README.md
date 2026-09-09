# Organizator

File de tâches priorisable pour Windows, avec un terminal d'agent (Claude Code ou GitHub Copilot CLI) par tâche.

- Une seule fenêtre : la file, ordonnée par priorité, réordonnable au glisser-déposer.
- Tâches multi-lignes éditables en place, catégories créées par l'utilisateur, état « En cours », tâches terminées.
- Pour chaque tâche, une ou plusieurs **conversations** : chacune est une session d'agent lancée dans une fenêtre PowerShell. Au lancement, on choisit l'**agent** (Claude Code : `claude --dangerously-skip-permissions`, ou GitHub Copilot CLI : `copilot --allow-all`), le **modèle** (liste groupée par famille, ou identifiant libre passé à `--model`) et l'**effort** (`--effort`). Vide = réglage propre de l'outil. Les Réglages fixent l'agent, le modèle et l'effort par défaut de chaque agent. Relancer une conversation reprend la session existante (`--resume`) avec le même agent, le même modèle et le même effort. Le panneau de l'application affiche la liste des sessions et une transcription en lecture seule.
- Les modèles Copilot sont **détectés** auprès de la CLI (mode ACP), avec leur multiplicateur d'usage et leur niveau de prix ; la liste est mise en cache un jour et se rafraîchit d'un clic sur ↻. Pour Claude Code, qui n'expose pas de liste, sont proposés les alias officiels et les modèles déjà utilisés sur le poste.
- Tout est conservé entre deux lancements de l'exécutable.

## Lancer

Exécutable publié : `publish\Organizator.exe` (voir « Construire »). Prérequis : runtime .NET 8 Desktop et WebView2 Runtime (fournis avec Windows 11), puis au moins un agent : `claude` dans le PATH, et/ou la CLI GitHub Copilot (`copilot` dans le PATH, ou la copie téléchargée par `gh copilot`). Un agent absent est simplement grisé dans le formulaire.

Organizator peut être lancé de n'importe où, y compris depuis une session Claude Code : les marqueurs de session hérités de l'environnement sont retirés au démarrage (et notés dans `host.log`), si bien que chaque conversation ouverte est une session à part entière, avec sa transcription. `NO_COLOR` et ses semblables, posés par l'agent parent, sont retirés de la même façon : sans quoi les terminaux ouverts depuis Organizator s'afficheraient tout en gris.

Options de ligne de commande :

| Option               | Effet                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| `--data <dossier>`   | Dossier de données à la place de `%LOCALAPPDATA%\Organizator`          |
| `--wwwroot <dossier>` | Mode développement : sert l'UI depuis ce dossier (F5 recharge, F12 DevTools) |
| `--page <fichier>`   | Page de démarrage (par défaut `index.html`)                            |

## Données

`%LOCALAPPDATA%\Organizator\` contient `data.json` (tâches, catégories, conversations), `settings.json` (réglages et état de la fenêtre), `host.log`, les scripts de lancement générés dans `launch\` et le cache WebView2.

Les sessions elles-mêmes restent là où chaque outil les range : `%USERPROFILE%\.claude\projects\<dossier encodé>\<uuid>.jsonl` pour Claude Code, `%USERPROFILE%\.copilot\session-state\<uuid>\` pour Copilot. Supprimer une conversation dans Organizator ne supprime pas ces fichiers.

Chaque conversation indique ce que fait l'agent : « En cours depuis 14:58 », « Attend votre réponse » (question posée, autorisation demandée), « Réponse prête à 14:59 », « Erreur », « Fermée » quand la fenêtre PowerShell n'existe plus. L'état est lu dans le fichier de session, dont seules les lignes ajoutées depuis la dernière lecture sont relues ; la présence de la fenêtre vient d'un balayage des processus `claude` / `copilot` toutes les 4 s. Sur chaque carte, c'est **l'icône du terminal** qui porte l'état : le bouton se teinte et une pastille se pose dans son coin — verte (et cerclée d'une onde) quand une réponse est prête, orange pendant le travail, violette quand l'agent attend une réponse, rouge en cas d'erreur ; l'infobulle donne le détail et l'heure. Quand une réponse arrive, un toast s'affiche et le bouton de la barre des tâches clignote si Organizator est en arrière-plan.

En tête de fenêtre, deux cartes montrent les quotas des agents : pour Claude, la session de 5 h, la semaine et les limites par modèle, comme `/usage` les affiche ; pour Copilot, les requêtes premium du mois (consommées / plafond, date de remise à zéro). Les jetons sont ceux des clients eux-mêmes (`~/.claude/.credentials.json`, Gestionnaire d'identifiants Windows pour la CLI Copilot) : Organizator ne les renouvelle pas et ne les écrit nulle part ; un jeton expiré s'affiche comme tel, il suffit de relancer le client. Relecture toutes les 5 min, au retour au premier plan, quand une réponse arrive, ou d'un clic sur la carte. Les dialogues (nouvelle tâche, réglages) ne se ferment qu'avec leurs boutons (Échap pour les réglages), pas d'un clic à côté.

Le bouton « Remarques » (bulle, à côté des réglages) ouvre un carnet où noter au fil de l'eau ce que vous voudriez changer dans Organizator. Les remarques s'accumulent, numérotées, affichées en entier et modifiables en place ; « Envoyer à Claude Code → » (ou Copilot, selon l'agent par défaut des Réglages) lance aussitôt l'agent dans une fenêtre PowerShell, avec le modèle et l'effort par défaut, dans le dépôt des sources (détecté autour de l'exécutable, ou fixé dans les Réglages) ; le bouton affiche le dossier et le modèle qu'il va utiliser, et le texte encore dans la zone de saisie part avec. Un lien « Choisir l'agent, le modèle ou le dossier… » ouvre le formulaire complet avant l'envoi. L'agent démarre avec les consignes du dépôt en prompt système et vos remarques comme premier message : il se met au travail sans attendre. Une session déjà ouverte peut recevoir les remarques suivantes (bouton ↪). Les remarques envoyées passent dans un historique effaçable ; le badge du bouton compte celles en attente, son point d'état suit les sessions du carnet.

## Construire

Toujours via la solution, avec MSBuild 18 :

```powershell
& "C:\Program Files\Microsoft Visual Studio\18\Professional\MSBuild\Current\Bin\amd64\MSBuild.exe" Organizator.sln /restore /p:Configuration=Release /v:m
```

Publication en un exécutable unique (`publish\Organizator.exe`) :

```powershell
powershell -ExecutionPolicy Bypass -File publish.ps1
```

## Structure

- `src/Organizator/` — hôte WPF (.NET 8) + WebView2 : persistance, lancement de PowerShell, lecture des sessions Claude Code et Copilot.
- `src/Organizator/wwwroot/` — l'interface (HTML/CSS/JS sans framework), embarquée dans l'exécutable.
- `docs/ARCHITECTURE.md` — architecture et contrat des messages JS ↔ .NET.
- `Mockup/` — le prototype de design d'origine.
- `tools/bridge-test.html` — page de test du pont JS ↔ .NET (`--wwwroot tools --page bridge-test.html`).
