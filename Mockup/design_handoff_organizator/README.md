# Handoff : Organizator — file de tâches priorisable

## Overview
Organizator est une page unique de gestion de tâches : une file ordonnée par priorité (réordonnable au glisser-déposer), des tâches multi-lignes éditables en place, des catégories créées par l'utilisateur, un état « En cours », et un terminal d'agent LLM par tâche (conversations multiples, reprise d'une ancienne session).

## About the Design Files
Les fichiers de ce dossier sont des **références de design réalisées en HTML** — un prototype fonctionnel qui montre l'apparence et le comportement visés, pas du code de production à copier tel quel. Le travail attendu est de **recréer ces écrans dans l'environnement existant du codebase cible** (React, Vue, Svelte, SwiftUI, natif…) avec ses conventions, sa librairie de composants et son système de design. Si aucun environnement n'existe encore, choisir le framework le plus adapté au projet et y implémenter les écrans.

Le prototype est écrit comme un composant unique : un template HTML à trous et une classe de logique (état + handlers). Le fichier `Priorites.dc.html` contient les deux ; `support.js` est le runtime du prototype et n'a pas à être porté.

## Fidelity
**Hi-fi.** Couleurs, typographie, rayons, ombres et espacements sont définitifs (tokens du design system « Organic », reproduits plus bas). L'UI doit être recréée fidèlement avec les composants du codebase cible.

## Screens / Views

### 1. File de travail (écran principal)
**Purpose** : voir, ordonner, éditer et créer des tâches ; ouvrir l'agent sur une tâche.

**Layout** — colonne unique, pleine hauteur (`min-height: 100vh`), fond `--color-bg` :
- Conteneur interne : `display:flex; flex-direction:column; flex:1`, plus `padding-right: calc(min(46vw,520px) + 24px)` **quand le terminal est ouvert** (transition 0.2s) — c'est ce qui réserve la colonne du panneau fixe.
- **En-tête** : `padding: 34px clamp(20px,4vw,56px) 18px`, titre h1 « Organizator », `--font-heading`, `clamp(32px,4.2vw,48px)`, `line-height:1.02`. Aucun bouton.
- **Barre de filtres** : `padding: 0 clamp(20px,4vw,56px) 20px`, flex, `gap:12px`, wrap. À gauche : pastilles de catégories (uniquement celles portées par au moins une tâche). À droite : champ de recherche `.input`, `max-width:260px`.
- **Liste** : `display:flex; flex-direction:column; gap:12px`, `padding: 0 clamp(20px,4vw,56px) 60px`.

**Carte de tâche** — `padding:18px 20px` (13px 16px en mode compact), `border-radius: --radius-lg`, fond `--color-surface (#fffaf1)`, `border: 2px solid --color-neutral-200`, `box-shadow: --shadow-sm`, `cursor:grab`. Trois colonnes en flex, `gap:14px` :
1. **Rang** : cercle 30×30, `--font-heading` 14px. Les `topCount` premières tâches non terminées : fond `--color-accent-500`, texte blanc ; les autres : fond `--color-neutral-200`, texte `--color-neutral-700`. Une tâche terminée affiche « ✓ ». Sous le rang, une poignée à six points (`--color-neutral-500`, `cursor:grab`).
2. **Contenu** : rangée de méta (pastille de catégorie ; pastille « En cours » si applicable), puis le texte de la tâche en `white-space: pre-wrap`, 15.5px, `line-height:1.55`, `text-wrap: pretty`. Clic sur le texte → édition.
3. **Actions** (droite, `align-items:flex-start`, `gap:6px`) : groupe [▶ passer en cours, ✓ terminer, 🗑 supprimer] à `opacity:0; pointer-events:none` hors survol (transition 0.15s), puis le bouton **terminal** — lui reste à `opacity:1` en permanence dès qu'une conversation existe pour la tâche.

**Pastille de catégorie** : `padding:3px 12px`, `border-radius:999px`, `border:2px solid <bd>`, fond `<bg>`, texte `<fg>`, 12px, `font-weight:600`, `letter-spacing:0.03em`.

**Pastille « En cours »** : fond `--color-accent-2-700`, texte `--color-bg`, 12px/600, avec un point 7×7 en `--color-bg` animé (`@keyframes blink { 50% { opacity:.25 } }`, 1.4s infinite). La carte prend alors `border-color: --color-accent-2-600`.

**Bouton ▶ (en cours)** : 38×38, rond ; inactif `border:2px solid --color-neutral-300`, fond transparent, icône `--color-accent-2-800` ; actif fond + bordure `--color-accent-2-700`, icône `--color-bg`.

**Bouton terminal** : 38×38, rond ; sans conversation `border:2px solid --color-neutral-300` sur transparent ; avec conversations `border-color: --color-accent-2-500`, fond `--color-accent-2-100` ; icône `--color-accent-2-800`.

**Édition en place** : le texte devient un `textarea .input` (`border-radius: --radius-md`, 15.5px, `line-height:1.55`, `rows = min(12, max(2, lignes+1))`), suivi d'une rangée « Catégorie » listant toutes les catégories en pastilles cliquables (la courante est remplie, les autres en contour `--color-neutral-300` / texte `--color-neutral-600`) et d'un bouton **Terminé**. Sortie d'édition : Terminé ou Échap — **pas** de sortie au blur (elle annulerait le clic sur une pastille). Chaque frappe est persistée.

**Bandes de priorité** (option `showBands`) : avant la première tâche de chaque groupe, une ligne « Maintenant » / « Ensuite » / « Plus tard » / « Terminées » — libellé `--font-heading` 15px `--color-accent-800`, filet 2px `--color-neutral-200`, et à droite une glose 12px `--color-neutral-600` (« cette session », « cette semaine », « quand ce sera calme »).

**Interstice « + »** : entre deux cartes (et sous la dernière), une bande de 18px (`margin:-9px 0`, `z-index:3`) ; au survol elle affiche un filet 2px `--color-accent-300` et un rond 24×24 `--color-accent-500` centré avec un « + » blanc (`box-shadow: 0 0 0 3px --color-bg`). Le clic ouvre la popup de création **avec la position de cet interstice**. Cette bande est aussi une zone de dépôt pendant un glisser, et son clic est neutralisé tant qu'un glisser est en cours.

**État vide** : cadre `2px dashed --color-neutral-300`, `--radius-lg`, titre « File vide » (`--font-heading` 22px), texte d'aide, bouton primaire « Nouvelle tâche ».

### 2. Popup « Nouvelle tâche »
Backdrop `position:fixed; inset:0; z-index:60`, centré, `padding:24px`, classe `.dialog-backdrop` (fond `rgba(32,30,29,~.5)`). Dialogue : `width:min(600px,100%)`, `max-height:88vh`, `overflow:auto`, `padding:26px 28px`, `--radius-lg`, fond `--color-surface`, `--shadow-lg`, animation `rise` 0.18s. Contenu :
- Titre « Nouvelle tâche » (`--font-heading` 24px).
- Rangée de catégories en pastilles (`padding:7px 16px`) + bouton `+ catégorie` en `2px dashed --color-neutral-400`.
- Créateur de catégorie (replié par défaut) : bloc `--radius-lg` sur `--color-neutral-100`, bordure 2px `--color-neutral-200`, contenant un champ « Nom de la catégorie » (`max-width:210px`), six pastilles de palette 30×30 (la sélection prend une bordure 3px + `box-shadow 0 0 0 3px --color-neutral-200`), puis « Annuler » et « Créer la catégorie ».
- Textarea de la tâche, 3 lignes, placeholder « Décrivez la tâche… (plusieurs lignes possibles, Cmd/Ctrl + Entrée pour ajouter) ».
- Actions : message d'aide à gauche (13px `--color-accent-700`), « Annuler » (ghost), « Ajouter la tâche » (primary, désactivé sans catégorie).
- **Focus automatique** : le textarea à l'ouverture ; le champ nom de catégorie si le créateur est ouvert (cas d'un compte sans aucune catégorie).
- Fermeture : clic sur le backdrop, Annuler. Pas de champ « emplacement » : la position vient du « + » cliqué.

### 3. Terminal de l'agent (panneau droit)
`position:fixed; right: clamp(20px,4vw,56px); top:18px; bottom:18px; z-index:20`, `width: min(46vw,520px)`, `--radius-lg`, fond `--color-neutral-900`, `--shadow-lg`, `overflow:hidden`, animation `rise` 0.2s.
- **Barre de titre** : `padding:14px 18px`, fond `rgba(255,255,255,.06)`, trois points 10px (`--color-accent-500`, `--color-accent-2-400`, `rgba(255,255,255,.25)`), libellé `agent — <première ligne de la tâche, 40 car.>` en JetBrains Mono 12.5px `rgba(255,255,255,.72)`, puis « ‹ historique » (en conversation) et « ✕ ».
- **Liste des conversations** : bouton « + Nouvelle conversation » pleine largeur (`2px solid --color-accent-500`, fond `rgba(198,113,57,.14)`, texte `--color-accent-200`), titre de section en mono 11px `rgba(255,255,255,.4)`, puis une rangée par conversation (`1px solid rgba(255,255,255,.14)`, fond `rgba(255,255,255,.05)`, `--radius-md`) : titre 13.5px tronqué, méta mono 11px « N messages · 12 mars 14:05 », et un « ✕ » de 42px pour supprimer.
- **Conversation** : journal en JetBrains Mono 13px, `line-height:1.65` ; rôle en 11px capitales espacées (`--color-accent-300` pour « vous › », `--color-accent-2-300` pour « agent › »), corps en `white-space:pre-wrap` (`rgba(255,255,255,.95)` / `.8`). Pendant l'attente : `agent ▍…` en `--color-accent-2-300` avec le « … » clignotant.
- **Composer** : textarea 2 lignes sur `rgba(0,0,0,.35)`, bordure `rgba(255,255,255,.18)`, rayon 12px, mono 13px ; bouton « Envoyer » pilule `--color-accent-500`. Entrée envoie, Maj+Entrée saute une ligne.

## Interactions & Behavior
- **Glisser-déposer** : `draggable` sur la carte (désactivé en édition). `dragover` sur une carte détermine la moitié survolée (`clientY - rect.top < height/2`) → `overId` + `overBefore` ; un filet 4px `--color-accent-500` (avec un rond 14px à gauche, `box-shadow 0 0 0 3px --color-bg`) est dessiné dans l'interstice correspondant. **Le déplacement n'a lieu qu'au `drop`** : retirer l'élément, l'insérer avant/après la cible. Les bandes d'interstice acceptent aussi le dépôt (`overBefore = true` ; la bande de fin insère après la dernière). La carte tirée passe à `opacity:.55` avec `--color-accent-500` en bordure et `--shadow-lg`.
- **Réordonnancement clavier** : Alt+↑ / Alt+↓ sur la tâche en cours d'édition.
- **Terminées** : toujours affichées jusqu'à suppression ; triées en fin de file (tri stable), badge « ✓ », texte barré `--color-neutral-600`, carte à `opacity:.62`. Elles ne consomment pas de rang.
- **En cours** : exclusif avec « terminée » (passer en cours remet `done:false`).
- **Catégories** : aucune par défaut ; création uniquement depuis la popup de tâche ; obligatoire pour créer une tâche (bouton désactivé sinon) ; la dernière utilisée reste présélectionnée (persistée) ; clic droit sur une pastille supprime la catégorie, refusé (toast) si des tâches l'utilisent ; les filtres n'affichent que les catégories en usage.
- **Agent** : le bouton terminal ouvre le panneau ; s'il n'existe qu'une conversation elle s'ouvre directement, sinon la liste. Une session sans message est écartée automatiquement à la fermeture ou au retour à l'historique. Le titre de la conversation est la première ligne du premier message (46 car.).
- **Toast** : pilule centrée en bas, `--color-neutral-900` / `--color-neutral-100`, 13px, 3.4s.
- **Responsive** : tout est fluide (`clamp()`, `min()`, flex wrap) ; le panneau agent occupe `min(46vw,520px)`.

## State Management
```
tasks:       [{ id, type, text, done, doing, created }]      // ordre = priorité
customTypes: [{ id, label, bg, fg, bd, custom:true }]
convos:      [{ id, taskId, title, messages:[{role,content}], updated }]
editingId, hoverCard, hoverGap ('tail' | taskId)
dragId, overId, overBefore
search, hidden:[typeId]                                       // filtres
composerOpen, composerText, composerType, insertAt ('top'|'bottom'|taskId)
catFormOpen, catName, catPalette
termTaskId, termConvId, draft, sending, toast
```
Persistance locale : `prio.tasks.v1`, `prio.types.v1`, `prio.convos.v1`, `prio.lastType.v1` (localStorage ; à remplacer par l'API du codebase cible). Options exposées : `topCount` (1–8, défaut 3), `showBands` (défaut vrai), `compact` (défaut faux), `agentModel` (« Rapide (Haiku) » / « Réfléchi (Sonnet) »).

**Appel LLM** (prototype : `window.claude.complete`) : historique de la conversation + system prompt « agent de développement en binôme, dans un terminal, réponses en français, concises, orientées action » complété du type et du texte de la tâche courante ; `max_tokens: 900`. À remplacer par l'endpoint du codebase. Échec → message `⚠ L'agent est injoignable pour le moment.` inséré dans le journal.

## Design Tokens
Design system « Organic » (fond crème, accent terracotta, second accent sauge, titres Caprasimo, texte Figtree, rayon 16px) :
- `--color-bg` #f5ead8 · `--color-text` #201e1d · `--color-surface` #fffaf1
- `--color-accent` #c67139 (ramp 100→900) · `--color-accent-2` #7a8a5e (ramp 100→900) · `--color-neutral-100→900`
- Valeurs mesurées utilisées ici : accent-500 #c67139, accent-300 ~#e9b892, accent-700 #8c491a, accent-800 #6b3813, accent-2-600 #728157, accent-2-700 #56633f, accent-2-800 #3d472b, neutral-200 #eee7db, neutral-900 #2e2b25
- Rayons : `--radius-md` 12px, `--radius-lg` 16px, pilules 999px
- Ombres : `--shadow-sm/md/lg` (tokens du système)
- Type : `--font-heading` Caprasimo, `--font-body` Figtree, JetBrains Mono 400/600 pour le terminal
- Espacements : échelle `--space-*` du système (densité 1.10×)
- Focus clavier : `outline: 2px solid var(--color-accent); outline-offset: 2px`

**Palettes de catégories** (six teintes, fond clair + texte foncé de même teinte) :
| Nom | fond | texte | bordure |
| --- | --- | --- | --- |
| Terracotta | oklch(0.9 0.06 55) | oklch(0.4 0.11 50) | oklch(0.76 0.1 55) |
| Sauge | oklch(0.9 0.05 128) | oklch(0.38 0.07 128) | oklch(0.74 0.07 128) |
| Ocre | oklch(0.92 0.08 90) | oklch(0.42 0.09 80) | oklch(0.79 0.1 85) |
| Prune | oklch(0.89 0.05 345) | oklch(0.4 0.1 345) | oklch(0.74 0.08 345) |
| Ardoise | oklch(0.89 0.04 235) | oklch(0.4 0.07 240) | oklch(0.73 0.06 235) |
| Encre | oklch(0.89 0.012 60) | oklch(0.32 0.012 60) | oklch(0.72 0.015 60) |

## Assets
Aucune image. Icônes : jeu Lucide (https://lucide.dev), `stroke-width: 2.75` (3.2 pour le « + » de l'interstice) — poignée à six points, terminal, lecture (▶), coche, corbeille, plus, bulle. Polices : Caprasimo + Figtree (via le design system), JetBrains Mono (Google Fonts). Aucun asset de marque.

## Files
- `Priorites.dc.html` — le prototype complet (template + logique + options).
- `_ds/organic-.../styles.css` — la feuille de tokens et composants du design system Organic (source des `var(--*)`).
- `support.js` — runtime du prototype, à ignorer lors du portage.
