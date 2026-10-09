/* ═══════════════════════════════════════════════════════════════════════════
   Organizator — application
   Un état unique, un rendu par zones idempotent, des handlers délégués.
   Toutes les données viennent de bridge.call('getState') au démarrage ;
   chaque action structurelle est persistée immédiatement, la frappe l'est
   avec 300 ms de debounce. window.organizatorFlush() vide la file d'attente.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ══ Constantes ═══════════════════════════════════════════════════════ */

  var PALETTES = [
    { id: 'terracotta', title: 'Terracotta', bg: 'oklch(0.9 0.06 55)', fg: 'oklch(0.4 0.11 50)', bd: 'oklch(0.76 0.1 55)' },
    { id: 'sauge', title: 'Sauge', bg: 'oklch(0.9 0.05 128)', fg: 'oklch(0.38 0.07 128)', bd: 'oklch(0.74 0.07 128)' },
    { id: 'ocre', title: 'Ocre', bg: 'oklch(0.92 0.08 90)', fg: 'oklch(0.42 0.09 80)', bd: 'oklch(0.79 0.1 85)' },
    { id: 'prune', title: 'Prune', bg: 'oklch(0.89 0.05 345)', fg: 'oklch(0.4 0.1 345)', bd: 'oklch(0.74 0.08 345)' },
    { id: 'ardoise', title: 'Ardoise', bg: 'oklch(0.89 0.04 235)', fg: 'oklch(0.4 0.07 240)', bd: 'oklch(0.73 0.06 235)' },
    { id: 'encre', title: 'Encre', bg: 'oklch(0.89 0.012 60)', fg: 'oklch(0.32 0.012 60)', bd: 'oklch(0.72 0.015 60)' }
  ];

  var NOTYPE = { id: '', label: 'sans catégorie', bg: 'transparent', fg: 'var(--color-neutral-600)', bd: 'var(--color-neutral-300)' };

  var DEFAULTS = {
    topCount: 3, showBands: true, compact: false, defaultCwd: '', terminal: 'powershell',
    /* Clic sur l'icône de console d'une carte : 'panel' ouvre le panneau, 'terminal' ramène la
       fenêtre de la conversation quand la tâche n'en a qu'une (voir clickTerm). */
    termClick: 'panel',
    provider: 'claude', claudeModel: '', copilotModel: '', claudeEffort: '', copilotEffort: '',
    repoDir: '',
    /* Serveur Bitbucket de « Mes PRs Bitbucket » ; vide = celui que l'hôte détecte. */
    bitbucketUrl: '',
    /* Rédaction assistée : un modèle rapide suffit pour quelques phrases. */
    draftProvider: 'claude', draftModel: 'haiku', draftEffort: '',
    /* Article du jour : un article du web pour les sujets du moment, cherché et résumé par Claude Code.
       Chercher, lire et résumer demande mieux qu'un modèle rapide. */
    articleEnabled: true, articleTopics: '', articleModel: 'sonnet', articleEffort: 'medium',
    /* Veille IA : un second article par jour, sur l'actualité récente de l'IA, même modèle et même effort. */
    articleAiEnabled: true,
    /* Notifications Windows quand une réponse arrive alors qu'Organizator est en arrière-plan. */
    windowsNotifications: true,
    /* Dictée et transcription des enregistrements joints, par Whisper sur le poste. Small : quelques
       secondes pour une dictée sur un processeur récent ; voir « Dictée et transcription ». */
    whisperEnabled: true, whisperAuto: true, whisperModel: 'small', whisperLanguage: 'fr',
    /* Mode Conversation (voice.js) : interlocuteur à voix et avatar. Base pour Whisper : chaque phrase
       dite doit être transcrite en moins d'une seconde. */
    voiceModel: 'sonnet', voiceEffort: 'low', voiceVoice: '', voiceRate: 1, voicePersona: 'Alma', voiceTopic: 'libre',
    voiceInstructions: '', voiceWeb: true, voiceWhisperModel: 'base', voiceSensitivity: 50
  };

  /* Agents disponibles. `short` sert dans les listes, `example` dans le champ de modèle libre. */
  var PROVIDERS = [
    { id: 'claude', label: 'Claude Code', short: 'Claude', example: 'claude-opus-5-5',
      missing: 'claude introuvable dans le PATH : les sessions Claude ne pourront pas démarrer' },
    { id: 'copilot', label: 'GitHub Copilot', short: 'Copilot', example: 'gpt-5.4',
      missing: 'copilot (CLI GitHub Copilot) introuvable : les sessions Copilot ne pourront pas démarrer' }
  ];

  /* Catalogues de repli si l'hôte n'en fournit pas (navigateur ordinaire, hôte plus ancien).
     Même forme que `env.models` :
     { defaultModel, defaultEffort, fetchedAt, groups: [{ key, items: [{ id, name, usage, price, enabled }] }] }. */
  var FALLBACK_MODELS = {
    claude: { defaultModel: '', defaultEffort: '', fetchedAt: 0, groups: [
      { key: 'alias', items: [{ id: 'fable' }, { id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }] }
    ] },
    copilot: { defaultModel: '', defaultEffort: '', fetchedAt: 0, groups: [
      { key: 'auto', items: [{ id: 'auto', name: 'Auto' }] }
    ] }
  };
  var FALLBACK_EFFORTS = {
    claude: ['low', 'medium', 'high', 'xhigh', 'max'],
    copilot: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  };
  var GROUP_LABELS = {
    alias: 'Alias (dernier modèle de la famille)', anthropic: 'Modèles Anthropic', used: 'Déjà utilisés sur ce poste', auto: 'Automatique',
    claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', grok: 'Grok', other: 'Autres'
  };
  var PRICE_LABELS = { low: 'prix bas', medium: 'prix moyen', high: 'prix élevé' };
  var CUSTOM = '__custom__';
  var CATALOG_MAX_AGE = 24 * 3600 * 1000;

  var NO_CLAUDE = PROVIDERS[0].missing;

  /* Carnet de remarques sur Organizator : une tâche virtuelle, jamais listée, qui porte ses
     propres conversations (taskId = FEEDBACK_ID). L'agent démarre dans le dépôt des sources
     avec ce contexte en prompt système et les remarques numérotées comme premier message. */
  var FEEDBACK_ID = '__feedback__';
  var FEEDBACK_TASK = { id: FEEDBACK_ID, type: '', text: 'Remarques sur Organizator', done: false, doing: false, created: 0 };
  /* Article du jour et veille IA : leur panneau s'ouvre à la place de celui d'une tâche
     (S.ui.termTaskId), sans tâche ni conversation derrière — renderPanel les reconnaît à ces
     identifiants (ARTICLE_FEEDS). */
  var ARTICLE_ID = '__article__';
  var ARTICLE_AI_ID = '__article_ai__';
  var FEEDBACK_CONTEXT = "Tu travailles sur le code source d'Organizator, l'application depuis laquelle l'utilisateur t'envoie ses remarques ; le dossier courant est son dépôt.\n"
    + 'Avant de modifier quoi que ce soit, lis README.md et docs/ARCHITECTURE.md : structure, contrat JS ↔ hôte, construction (MSBuild 18 via Organizator.sln, jamais un .csproj seul) et publication (publish.ps1).\n'
    + "L'application tourne probablement pendant ton travail (publish\\Organizator.exe) : ne la ferme pas sans prévenir l'utilisateur, et préserve ses données dans %LOCALAPPDATA%\\Organizator.\n"
    + 'Réponds en français.';

  var ICON = {
    handle: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"></circle><circle cx="15" cy="6" r="1.6"></circle><circle cx="9" cy="12" r="1.6"></circle><circle cx="15" cy="12" r="1.6"></circle><circle cx="9" cy="18" r="1.6"></circle><circle cx="15" cy="18" r="1.6"></circle></svg>',
    plusSmall: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
    plus: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
    play: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 5l12 7-12 7z"></path></svg>',
    stop: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"></path></svg>',
    trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9.5 7V5h5v2M6.5 7l1 12.5h9L17.5 7"></path></svg>',
    toBottom: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v10M7.5 9.5L12 14l4.5-4.5M5 19h14"></path></svg>',
    terminal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l3 3-3 3M12.5 15h5"></path><rect x="2.5" y="4" width="19" height="16" rx="4"></rect></svg>',
    artifacts: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5h8l4 4V20.5H6z"></path><path d="M14 3.5v4h4M9 12h6M9 16h6"></path></svg>',
    /* Résultat d'une revue de code : une planchette cochée. */
    review: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2h-2"></path><rect x="9" y="3" width="6" height="3.5" rx="1"></rect><path d="M8.5 12.5l1.6 1.6 2.9-2.9M8.5 17.5h7"></path></svg>',
    eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
    /* Consommation d'une tâche (jauge). */
    gauge: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 17.5a8.5 8.5 0 1 1 15 0"></path><path d="M12 13.5l4-4.5"></path></svg>',
    /* Appels d'outils regroupés dans le journal. */
    tool: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.3a1.8 1.8 0 0 0 2.6 2.6l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.4-.4-2.4z"></path></svg>',
    pullRequest: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2.4"></circle><circle cx="6" cy="19" r="2.4"></circle><circle cx="18" cy="19" r="2.4"></circle><path d="M6 7.5v9M18 16.5V11a3 3 0 0 0-3-3h-4.5M13 5.5L10.5 8 13 10.5"></path></svg>',
    /* Sous-tâches : le crochet « ↳ » de l'avancement, et le même avec un plus pour en ajouter une. */
    subtask: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4v9a3 3 0 0 0 3 3h11"></path><path d="M15 12l4 4-4 4"></path></svg>',
    subtaskAdd: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4v8a3 3 0 0 0 3 3h5"></path><path d="M17 11v9M12.5 15.5h9"></path></svg>',
    /* Chevron des groupes repliables : pointe vers le bas déplié, vers la droite replié (CSS). */
    caret: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>',
    /* Pièces jointes : trombone (fichier), image, et bloc de texte. */
    clip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"></path></svg>',
    image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"></rect><circle cx="9" cy="10" r="1.8"></circle><path d="M21 16l-5-5-8 8"></path></svg>',
    note: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6h14M5 11h14M5 16h9"></path></svg>',
    talk: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><path d="M8 9h8M8 13h5"></path></svg>',
    /* Dictée et transcription des enregistrements (Whisper). */
    mic: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"></path></svg>'
  };

  /* Un artefact « rapport » est un livrable qui se lit tel quel : c'est lui qu'on met en avant.
     Le code touché en chemin reste accessible, mais replié : ce n'est pas ce qu'on vient voir. */
  var REPORT_EXT = {
    md: 1, markdown: 1, txt: 1, rst: 1, adoc: 1, asciidoc: 1, org: 1, log: 1,
    pdf: 1, csv: 1, tsv: 1, xlsx: 1, xls: 1, docx: 1, doc: 1, pptx: 1, ppt: 1,
    odt: 1, ods: 1, odp: 1, rtf: 1, html: 1, htm: 1,
    png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1
  };

  var ARTIFACT_ACTIONS = { written: 'écrit', created: 'créé', modified: 'modifié', deleted: 'supprimé' };

  /* ══ État ═════════════════════════════════════════════════════════════ */

  var S = {
    data: { tasks: [], types: [], convos: [], remarks: [], notifications: [], lastType: null },
    settings: Object.assign({}, DEFAULTS),
    env: { version: '?', hasClaude: true, hasCopilot: false, hasWt: false, defaultCwd: '', dataDir: '', userProfile: '', repoDir: '',
      bitbucketUrl: '', bitbucketSource: '', bitbucketToken: false, jiraUrl: '', attachmentsDir: '', attachmentsUrl: '', models: null, efforts: null,
      /* Modèles Whisper : { dir, models: [{ id, label, size, note, downloaded, downloading, received, total }], loaded, extensions } */
      whisper: null },
    ui: {
      search: '',
      hidden: [], filtersOpen: false,
      editingId: null,
      dragId: null, overId: null, overBefore: null,
      composerOpen: false, composerText: '', composerType: null, insertAt: 'top',
      /* Sous-tâche en cours de création : identifiant de la tâche parente, null pour une tâche de premier niveau. */
      composerParent: null,
      /* Tâche en cours de création : son identifiant est tiré à l'ouverture, pour que ses pièces
         jointes soient copiées là où elles resteront ; abandonnée, son dossier est supprimé. */
      composerId: null, composerAttachments: [],
      /* Copies de pièces jointes en cours, par tâche (ou tâche en création). */
      attachBusy: {},
      /* Transcriptions en cours, par pièce jointe audio : { owner, job, phase, percent, received, total } ;
         modèles Whisper en téléchargement depuis les Réglages : { received, total }. */
      transcribing: {}, whisperDl: {},
      catFormOpen: false, catName: '', catPalette: 'terracotta',
      catsOpen: false, catKeywordDraft: {}, catKeywordEdit: '',
      settingsOpen: false, settingsTab: 'display',
      termTaskId: null, termConvId: null, artifactView: false, artifactConvId: null, artifactFilesOpen: false, artifactWorkOpen: false,
      /* Lecteur d'artefacts ouvert : { path, cwd, view, busy, error, back } — voir « Lecteur d'artefacts » */
      reader: null,
      newConvoOpen: false, newConvoCwd: '', newConvoPrompt: '', newConvoProvider: 'claude', newConvoModel: '', newConvoEffort: '', newConvoKeywords: [], newConvoCustom: false,
      /* Travail déjà fait, proposé au lancement : le texte (modifiable), sa lecture en cours, et ce qu'il couvre { convos, reports }. */
      newConvoRecap: '', newConvoRecapBusy: false, newConvoRecapMeta: null,
      /* Lancement depuis une tâche parente : sur elle ('self') ou une conversation par sous-tâche
         cochée ('subs', `newConvoSubs` : id → coché), avec une précision ajoutée à chaque premier
         message ; avancement du lot en cours : { parentId, done, total, phase: 'recap' | 'launch' }. */
      newConvoTarget: 'self', newConvoSubs: {}, newConvoNote: '', batchProgress: null,
      newKeywordOpen: false, newKeywordName: '', newKeywordPrompt: '', newKeywordTeam: false, newKeywordAgents: [],
      modelsBusy: { claude: false, copilot: false }, settingsCustom: { claude: false, copilot: false }, draftCustom: false,
      /* Rédaction en cours ou proposée : { key, kind, target, prompt, busy, text, desc, team, error, ms } */
      draft: null,
      /* Atelier ouvert : { typeId, keywordId, launch, card, turns, note, busy, error, ms } */
      chat: null,
      /* Aperçu des PRs Bitbucket dans Nouvelle tâche : { busy, error, host, account, jiraUrl, groups, checked } */
      prImport: null,
      transcript: null,
      /* Messages longs dépliés dans le journal (clé : conversation, rang, longueur). */
      logOpen: {},
      sessionExists: {},
      activity: {},
      usage: { reports: null, busy: false, fetchedAt: 0, error: '' },
      remarkText: '', sentOpen: false, launchBusy: false,
      /* Menu de la cloche (historique des notifications) ouvert ; carte qui s'éclaire un instant
         après l'ouverture d'une notification : { id, at }. */
      notifsOpen: false, flash: null,
      /* Article du jour et veille IA, un état par fil (ARTICLE_FEEDS) : ce que l'hôte garde
         ({ current, history }), recherche en cours, dernier échec, article précédent affiché dans le
         panneau (son adresse). `loaded` : l'état gardé par l'hôte a été lu — rien n'est cherché avant
         (les centres d'intérêt viennent des données, absentes tant que getState n'a pas répondu).
         `articleCustom` : modèle libre dans les Réglages, commun aux deux fils. */
      articles: {
        daily: { loaded: false, store: null, busy: false, error: '', failedAt: 0, shown: '' },
        ai: { loaded: false, store: null, busy: false, error: '', failedAt: 0, shown: '' }
      },
      articleCustom: false,
      /* `toastAction` : { label, run } — le bouton que porte le toast affiché, ou null. */
      toast: '', toastAction: null
    }
  };

  /* ══ Utilitaires ══════════════════════════════════════════════════════ */

  function $(sel) { return document.querySelector(sel); }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Les couleurs viennent des données ; on n'accepte qu'un vocabulaire sûr
     pour empêcher toute injection de déclaration CSS via data.json. */
  var COLOR_OK = /^[#a-zA-Z0-9 .,()%\-\/]+$/;
  function color(v, fallback) {
    return typeof v === 'string' && v && COLOR_OK.test(v) ? v : fallback;
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function firstLine(text, n) {
    return String(text || '').split('\n')[0].slice(0, n);
  }

  function lastSegment(p) {
    var s = String(p || '').replace(/[\\\/]+$/, '');
    var parts = s.split(/[\\\/]/);
    return parts[parts.length - 1] || s || '—';
  }

  function extOf(path) {
    var name = lastSegment(path);
    var dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  /* Le dossier qui contient le fichier, relatif au dossier de travail ; vide à la racine. */
  function folderOf(path) {
    var s = String(path || '').replace(/[\\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > 0 ? s.slice(0, i) : '';
  }

  function toMs(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') { var t = Date.parse(v); if (!isNaN(t)) return t; }
    return 0;
  }

  function fmtDate(ms) {
    ms = toMs(ms);
    if (!ms) return '—';
    return new Date(ms).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function fmtSize(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes < 1024) return bytes + ' o';
    if (bytes < 1048576) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0).replace('.', ',') + ' Ko';
    return (bytes / 1048576).toFixed(1).replace('.', ',') + ' Mo';
  }

  /* Heure seule si c'est aujourd'hui, sinon date et heure. */
  function fmtTime(ms) {
    ms = toMs(ms);
    if (!ms) return '';
    var d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return fmtDate(ms);
  }

  /* ══ Persistance ══════════════════════════════════════════════════════ */

  var dataTimer = null, dataDirty = false, dataInFlight = null;
  var setTimer = null, setDirty = false, setInFlight = null;

  function saveDataNow() {
    if (dataTimer) { clearTimeout(dataTimer); dataTimer = null; }
    dataDirty = false;
    if (S.ui.composerType) S.data.lastType = S.ui.composerType;
    dataInFlight = bridge.call('saveData', {
      tasks: S.data.tasks, types: S.data.types, convos: S.data.convos, remarks: S.data.remarks,
      notifications: S.data.notifications, lastType: S.data.lastType
    })['catch'](function (e) { toast('Sauvegarde impossible : ' + e.message); });
    return dataInFlight;
  }

  function saveDataSoon() {
    dataDirty = true;
    if (dataTimer) clearTimeout(dataTimer);
    dataTimer = setTimeout(saveDataNow, 300);
  }

  /* Ce que les relectures de sessions recopient (titre, nombre de messages, date, fichiers) change
     à chaque ligne qu'un agent écrit, et se relit de toute façon au passage suivant. L'écrire aussitôt
     réenregistrait tout data.json une fois par seconde pendant qu'un agent travaillait : ces
     changements partent au plus toutes les 5 s — ou avec la prochaine sauvegarde ordinaire, ou à la
     fermeture (`organizatorFlush`). */
  var DERIVED_SAVE_MS = 5000;

  function saveDataLater() {
    dataDirty = true;
    if (!dataTimer) dataTimer = setTimeout(saveDataNow, DERIVED_SAVE_MS);
  }

  function saveSettingsNow() {
    if (setTimer) { clearTimeout(setTimer); setTimer = null; }
    setDirty = false;
    setInFlight = bridge.call('saveSettings', {
      topCount: S.settings.topCount, showBands: S.settings.showBands, compact: S.settings.compact,
      defaultCwd: S.settings.defaultCwd, terminal: S.settings.terminal, termClick: S.settings.termClick,
      provider: S.settings.provider, claudeModel: S.settings.claudeModel, copilotModel: S.settings.copilotModel,
      claudeEffort: S.settings.claudeEffort, copilotEffort: S.settings.copilotEffort,
      repoDir: S.settings.repoDir, bitbucketUrl: S.settings.bitbucketUrl,
      draftProvider: S.settings.draftProvider, draftModel: S.settings.draftModel, draftEffort: S.settings.draftEffort,
      articleEnabled: S.settings.articleEnabled, articleTopics: S.settings.articleTopics, articleAiEnabled: S.settings.articleAiEnabled,
      articleModel: S.settings.articleModel, articleEffort: S.settings.articleEffort,
      windowsNotifications: S.settings.windowsNotifications,
      whisperEnabled: S.settings.whisperEnabled, whisperAuto: S.settings.whisperAuto,
      whisperModel: S.settings.whisperModel, whisperLanguage: S.settings.whisperLanguage,
      voiceModel: S.settings.voiceModel, voiceEffort: S.settings.voiceEffort, voiceVoice: S.settings.voiceVoice,
      voiceRate: S.settings.voiceRate, voicePersona: S.settings.voicePersona, voiceTopic: S.settings.voiceTopic,
      voiceInstructions: S.settings.voiceInstructions, voiceWeb: S.settings.voiceWeb,
      voiceWhisperModel: S.settings.voiceWhisperModel, voiceSensitivity: S.settings.voiceSensitivity
    })['catch'](function (e) { toast('Réglages non sauvegardés : ' + e.message); });
    return setInFlight;
  }

  function saveSettingsSoon() {
    setDirty = true;
    if (setTimer) clearTimeout(setTimer);
    setTimer = setTimeout(saveSettingsNow, 300);
  }

  window.organizatorFlush = function () {
    perfSend();
    var jobs = [];
    jobs.push(dataDirty ? saveDataNow() : (dataInFlight || Promise.resolve()));
    jobs.push(setDirty ? saveSettingsNow() : (setInFlight || Promise.resolve()));
    jobs.push(flushTextWrites());
    return Promise.all(jobs).then(function () { return true; });
  };

  /* ══ Sélecteurs ═══════════════════════════════════════════════════════ */

  function typeOf(id) {
    for (var i = 0; i < S.data.types.length; i++) if (S.data.types[i].id === id) return S.data.types[i];
    return NOTYPE;
  }

  /* ── Mots-clés ───────────────────────────────────────────────────────────
     Un mot-clé de catégorie se gère comme une skill : un nom court, ce qu'il veut dire, et la
     consigne qui part avec la tâche dans le contexte de l'agent. Les données d'avant n'avaient
     que le nom, une simple chaîne : elles se relisent telles quelles. */
  var KEYWORD_MAX = 32;
  var AGENT_MAX = 8;

  /* Rôles proposés pour ranger les agents d'une équipe. Le champ reste libre : ce ne sont que des
     suggestions, mais elles suffisent à regrouper l'équipe par métier plutôt qu'en vrac. */
  var AGENT_ROLES = ['exploration', 'conception', 'implémentation', 'tests', 'revue', 'documentation', 'données', 'sécurité'];

  function lower(v) { return String(v == null ? '' : v).toLocaleLowerCase('fr-FR'); }

  function normalizeKeywords(value) {
    var out = [];
    var seen = {};
    (Array.isArray(value) ? value : []).forEach(function (item) {
      var kw = typeof item === 'string' ? { name: item } : item;
      if (!kw || typeof kw !== 'object') return;
      var name = String(kw.name == null ? '' : kw.name).trim().slice(0, 80);
      if (!name || seen[lower(name)]) return;
      seen[lower(name)] = true;
      out.push({
        id: String(kw.id || '').trim() || uid('w'),
        name: name,
        desc: String(kw.desc == null ? '' : kw.desc).trim().slice(0, 160),
        prompt: String(kw.prompt == null ? '' : kw.prompt).trim().slice(0, 4000),
        team: !!kw.team,
        agents: normalizeAgents(kw.agents)
      });
    });
    return out.slice(0, KEYWORD_MAX);
  }

  /* ── Équipes d'agents ────────────────────────────────────────────────────
     Un mot-clé peut demander à l'agent de ne pas travailler seul : il ouvre alors, dès le premier
     tour, les agents décrits ici — chacun avec son nom, son rôle (qui le range) et sa mission. Ces
     agents vivent dans le mot-clé : ils partent avec lui dans le contexte, et nulle part ailleurs. */
  function normalizeAgents(value) {
    var out = [];
    var seen = {};
    (Array.isArray(value) ? value : []).forEach(function (item) {
      var a = typeof item === 'string' ? { name: item } : item;
      if (!a || typeof a !== 'object') return;
      var name = String(a.name == null ? '' : a.name).trim().slice(0, 60);
      /* Un agent sans nom est une ligne qu'on vient d'ouvrir : elle se garde le temps d'être remplie,
         et ne part pas dans le contexte (voir teamOf). Seuls les noms déjà pris sont écartés. */
      if (name && seen[lower(name)]) return;
      if (name) seen[lower(name)] = true;
      out.push({
        id: String(a.id || '').trim() || uid('a'),
        name: name,
        role: String(a.role == null ? '' : a.role).trim().slice(0, 32),
        /* Vides : le sous-agent ouvert travaille avec le modèle et l'effort de la session principale. */
        model: String(a.model == null ? '' : a.model).trim().slice(0, 40),
        effort: String(a.effort == null ? '' : a.effort).trim().slice(0, 16),
        prompt: String(a.prompt == null ? '' : a.prompt).trim().slice(0, 2000)
      });
    });
    return out.slice(0, AGENT_MAX);
  }

  /* L'équipe que ce mot-clé lance vraiment : décocher la case la met en sommeil sans l'effacer. */
  function teamOf(kw) {
    if (!kw || !kw.team) return [];
    return (Array.isArray(kw.agents) ? kw.agents : []).filter(function (a) { return a && a.name; });
  }

  /* Agents groupés par rôle, dans l'ordre où les rôles apparaissent. */
  function agentsByRole(agents) {
    var order = [];
    var groups = {};
    (agents || []).forEach(function (a) {
      var role = a.role || '';
      if (!groups[role]) { groups[role] = []; order.push(role); }
      groups[role].push(a);
    });
    return order.map(function (role) { return { role: role, agents: groups[role] }; });
  }

  function teamLine(agents) {
    return 'Équipe : ' + agents.map(function (a) { return a.name || '…'; }).join(', ');
  }

  /* ── Niveau d'un agent ───────────────────────────────────────────────────
     Chaque agent d'une équipe peut demander un modèle — celui avec lequel l'agent principal
     l'ouvrira — et un effort, le soin attendu de lui. Les deux sont vides par défaut : le sous-agent
     travaille alors comme la session qui l'ouvre. Le vocabulaire est celui de l'agent de lancement,
     puisque c'est lui qui ouvrira l'équipe, et non celui de la rédaction assistée. */
  function teamProviderId() { return S.settings.provider === 'copilot' ? 'copilot' : 'claude'; }

  function teamModels() {
    var out = [];
    (catalogFor(teamProviderId()).groups || []).forEach(function (g) {
      (g.items || []).forEach(function (it) {
        if (it.id && it.enabled !== false && out.indexOf(it.id) < 0) out.push(it.id);
      });
    });
    return out;
  }

  function teamEfforts() { return effortsFor(teamProviderId()); }

  /* « haiku · high » pour l'affichage, « modèle haiku, effort high » pour ce qu'on écrit à un agent. */
  function tuneTag(a) {
    return [(a && a.model) || '', (a && a.effort) || ''].filter(Boolean).join(' · ');
  }

  function tuneWords(a) {
    var parts = [];
    if (a && a.model) parts.push('modèle ' + a.model);
    if (a && a.effort) parts.push('effort ' + a.effort);
    return parts.join(', ');
  }

  function hasTune(agents) {
    return (agents || []).some(function (a) { return a && (a.model || a.effort); });
  }

  /* Une case du milieu d'une ligne « Nom | rôle | modèle | effort | mission » : un modèle, un effort,
     ou un tiret quand rien n'est demandé. null si on n'y reconnaît ni l'un ni l'autre — c'est alors
     déjà la mission, et la ligne se relit comme avant. */
  var TUNE_NONE = { '': 1, '-': 1, '—': 1, '–': 1, 'auto': 1, 'aucun': 1, 'aucune': 1, 'n/a': 1,
    'defaut': 1, 'défaut': 1, 'par defaut': 1, 'par défaut': 1, 'inchange': 1, 'inchangé': 1 };

  function tuneCell(cell) {
    var v = lower(cell).replace(/[«»"*]/g, '').replace(/^(?:mod[èe]les?|models?|efforts?|niveaux?)\s*[:=]?\s*/, '').trim();
    if (TUNE_NONE[v]) return {};
    if (teamEfforts().indexOf(v) >= 0) return { effort: v };
    var models = teamModels();
    for (var i = 0; i < models.length; i++) if (lower(models[i]) === v) return { model: models[i] };
    /* Catalogue non détecté (Copilot jamais sondé) : un identifiant plausible passe quand même. */
    if (/^[a-z0-9][a-z0-9.\-]{1,39}$/.test(v)) return { model: v };
    return null;
  }

  function keywordOf(typeId, keywordId) {
    var list = typeOf(typeId).keywords;
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === keywordId) return list[i];
    return null;
  }

  function agentOf(kw, agentId) {
    var list = (kw && Array.isArray(kw.agents)) ? kw.agents : [];
    for (var i = 0; i < list.length; i++) if (list[i].id === agentId) return list[i];
    return null;
  }

  /* Saisie libre : « revue, tests » donne deux noms. */
  function parseKeywordNames(text) {
    return String(text == null ? '' : text).split(/[,\n]/).map(function (name) {
      return name.trim().slice(0, 80);
    }).filter(Boolean);
  }

  function keywordsForTask(task) {
    if (!task || task.id === FEEDBACK_ID) return [];
    var list = typeOf(task.type).keywords;
    return Array.isArray(list) ? list : [];
  }

  /* Ne garde que les mots-clés que la catégorie porte encore, dans l'ordre de la catégorie.
     Un nom est accepté autant qu'un identifiant : les conversations d'avant retenaient le mot. */
  function keywordIdsFor(task, values) {
    var wanted = (Array.isArray(values) ? values : [values]).map(lower).filter(Boolean);
    if (!wanted.length) return [];
    return keywordsForTask(task).filter(function (kw) {
      return wanted.indexOf(lower(kw.id)) >= 0 || wanted.indexOf(lower(kw.name)) >= 0;
    }).map(function (kw) { return kw.id; });
  }

  function keywordsByIds(task, ids) {
    var list = keywordsForTask(task);
    return (Array.isArray(ids) ? ids : []).map(function (id) {
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    }).filter(Boolean);
  }

  function keywordsOfConvo(c) {
    var task = c ? taskById(c.taskId) : null;
    return task ? keywordsByIds(task, keywordIdsFor(task, c.keywords)) : [];
  }

  function taskById(id) {
    if (id === FEEDBACK_ID) return FEEDBACK_TASK;
    for (var i = 0; i < S.data.tasks.length; i++) if (S.data.tasks[i].id === id) return S.data.tasks[i];
    return null;
  }

  /* ── Sous-tâches ──────────────────────────────────────────────────────
     `task.parent` désigne la tâche parente — un seul niveau : une sous-tâche n'en a pas. Dans
     `tasks`, les sous-tâches suivent leur parent (`regroupTasks` y veille après chaque changement),
     si bien que l'ordre du tableau reste la priorité, sous-tâches comprises, et qu'un parent
     déplacé emmène les siennes. */
  function parentOf(t) { return t && t.parent ? taskById(t.parent) : null; }

  function childrenOf(id) {
    return S.data.tasks.filter(function (t) { return t.parent === id; });
  }

  function isSub(t) { return !!parentOf(t); }

  /* Dernière tâche du groupe : la dernière sous-tâche, ou la tâche elle-même. */
  function lastOfGroup(t) {
    var kids = childrenOf(t.id);
    return kids.length ? kids[kids.length - 1] : t;
  }

  function subtaskProgress(t) {
    var kids = childrenOf(t.id);
    return { total: kids.length, done: kids.filter(function (k) { return k.done; }).length };
  }

  /* Sous-tâches repliées sous leur parent (`task.collapsed`, conservé dans data.json). Une
     recherche passe outre : ce qu'elle trouve dans un groupe replié doit se voir. */
  function subsFolded(t) {
    return !!(t && t.collapsed) && !S.ui.search.trim() && childrenOf(t.id).length > 0;
  }

  /* Remet chaque sous-tâche derrière son parent, dans leur ordre relatif ; un parent disparu, ou
     lui-même sous-tâche, rend la tâche à la file de premier niveau, là où elle était. */
  function regroupTasks() {
    var byId = {}, kids = {}, out = [];
    S.data.tasks.forEach(function (t) { byId[t.id] = t; });
    S.data.tasks.forEach(function (t) {
      if (t.parent && (!byId[t.parent] || t.parent === t.id)) delete t.parent;
    });
    S.data.tasks.forEach(function (t) {
      if (t.parent && byId[t.parent].parent) delete t.parent;
    });
    S.data.tasks.forEach(function (t) {
      if (t.parent) (kids[t.parent] = kids[t.parent] || []).push(t);
    });
    S.data.tasks.forEach(function (t) {
      if (t.parent) return;
      out.push(t);
      (kids[t.id] || []).forEach(function (k) { out.push(k); });
    });
    S.data.tasks = out;
  }

  function remarkById(id) {
    for (var i = 0; i < S.data.remarks.length; i++) if (S.data.remarks[i].id === id) return S.data.remarks[i];
    return null;
  }

  function pendingRemarks() { return S.data.remarks.filter(function (r) { return !r.sentAt; }); }

  function sentRemarks() {
    return S.data.remarks.filter(function (r) { return !!r.sentAt; })
      .sort(function (a, b) { return b.sentAt - a.sentAt; });
  }

  function convoById(id) {
    for (var i = 0; i < S.data.convos.length; i++) if (S.data.convos[i].id === id) return S.data.convos[i];
    return null;
  }

  function convosOf(taskId) {
    return S.data.convos.filter(function (c) { return c.taskId === taskId; })
      .sort(function (a, b) { return toMs(b.updated) - toMs(a.updated); });
  }

  /* L'ordre affiché est celui de `tasks`, terminées comprises : une tâche cochée reste là où elle
     était, sous les yeux, jusqu'à ce qu'on la supprime ou qu'on la descende (bouton ↓). */
  function visibleTasks() {
    var q = S.ui.search.trim().toLowerCase();
    /* La recherche s'applique au groupe : une sous-tâche qui répond montre son parent et ses
       sœurs, un parent qui répond montre ses sous-tâches — le contexte reste lisible. */
    var groupHit = {};
    if (q) {
      S.data.tasks.forEach(function (t) {
        /* Les pièces jointes comptent : nom d'un fichier, titre ou contenu d'un bloc de texte. */
        var hay = String(t.text || '') + attachmentsOf(t).map(function (a) { return '\n' + a.name + '\n' + (a.text || ''); }).join('');
        if (hay.toLowerCase().indexOf(q) >= 0) groupHit[(parentOf(t) || t).id] = true;
      });
    }
    return S.data.tasks
      .filter(function (t) {
        if (S.ui.hidden.indexOf(t.type) >= 0) return false;
        var root = parentOf(t) || t;
        /* Une sous-tâche ne s'affiche jamais sans son parent : filtré, il l'emporte avec lui. */
        if (root !== t && S.ui.hidden.indexOf(root.type) >= 0) return false;
        if (root !== t && subsFolded(root)) return false;
        return !q || !!groupHit[root.id];
      });
  }

  /* Contexte envoyé à l'agent en prompt système : sa mission, la catégorie de la tâche et les
     mots-clés retenus — avec, pour chacun, la consigne qu'il porte (c'est là tout leur intérêt).
     `withTask` : le texte de la tâche y est écrit, comme avant, quand rien ne part en premier
     message (champ vidé, reprise) ; sinon c'est le message qui le porte, et l'agent démarre
     dessus au lieu d'ouvrir une invite vide. */
  function buildContext(t, keywords, withTask, recap) {
    if (t.id === FEEDBACK_ID) return FEEDBACK_CONTEXT;
    var chosen = keywordsByIds(t, keywordIdsFor(t, keywords));
    var lines = [withTask
      ? "Tu travailles sur la tâche suivante, extraite d'Organizator (file de tâches de l'utilisateur)."
      : "Tu travailles sur une tâche de l'utilisateur, tirée d'Organizator (sa file de tâches) ; elle t'est donnée dans le message qui suit.",
      'Catégorie : ' + typeOf(t.type).label];
    if (chosen.length) {
      lines.push('Mots-clés : ' + chosen.map(function (kw) { return kw.name; }).join(', '));
      var guided = chosen.filter(function (kw) { return kw.prompt; });
      if (guided.length) {
        lines.push(guided.length > 1 ? 'Ce que ces mots-clés demandent :' : 'Ce que ce mot-clé demande :');
        guided.forEach(function (kw) {
          lines.push('- ' + kw.name + ' : ' + kw.prompt.replace(/\r?\n/g, '\n  '));
        });
      }
      appendTeams(lines, chosen);
    }
    /* Ce qu'ont rendu les conversations précédentes (tâche parente, sous-tâches sœurs, cette tâche
       elle-même) : l'agent repart de là plutôt que de zéro. Texte relu et retouché dans le formulaire. */
    if (recap) {
      lines.push('', 'Travail déjà fait — ce qu’ont rendu les conversations précédentes liées à cette tâche. Lis-le avant de commencer, '
        + 'lis sur le disque les rapports qu’il cite s’ils te servent, et ne refais pas ce qui est fait.', recap, '');
    }
    if (withTask) lines.push('Tâche :', String(t.text || '') + attachmentsPrompt(t));
    lines.push('Réponds en français.');
    return lines.join('\n');
  }

  /* Premier message proposé au lancement : la tâche elle-même, pour que l'agent s'y mette dès
     l'ouverture plutôt que d'attendre une saisie — ses pièces jointes comprises. Le formulaire le
     donne à relire, et le vider rend l'ancien comportement : l'agent ouvre son invite, la tâche
     repart alors dans le contexte. Le carnet de remarques a son propre premier message (feedbackPrompt). */
  function buildPrompt(t) {
    if (!t || t.id === FEEDBACK_ID) return '';
    return (String(t.text || '').trim() + attachmentsPrompt(t)).trim();
  }

  /* ── Pièces jointes ────────────────────────────────────────────────────
     Fichiers, images et blocs de texte joints à une tâche. L'hôte copie les fichiers sous
     <données>\attachments\<tâche>\ (TaskAttachments) ; la tâche n'en garde que la description,
     { id, kind: image | file | text, name, path, size, added, text? }. Un bloc de texte vit dans
     data.json, et l'hôte en tient une copie sur le disque (texte-<id>.txt) pour l'agent.
     Tout part avec la tâche dans le premier message : le chemin de chaque fichier, à ouvrir, et le
     texte des blocs recopié tant qu'il tient (ATTACH_INLINE_MAX, la ligne de commande est bornée),
     sinon le chemin de sa copie. Une sous-tâche reçoit aussi celles de sa tâche parente. */
  var ATTACH_INLINE_MAX = 6000;
  var ATTACH_DATA_MAX = 40 * 1024 * 1024;
  var ATTACH_KINDS = { image: 1, file: 1, text: 1 };
  var ATTACH_SKIP = {
    folder: 'un dossier ne se joint pas, joignez ses fichiers', missing: 'introuvable',
    'too-large': 'trop volumineux', error: 'copie impossible'
  };

  function attachmentsOf(t) { return t && Array.isArray(t.attachments) ? t.attachments : []; }

  function attachmentsPrompt(t) {
    if (!t || t.id === FEEDBACK_ID) return '';
    var groups = [];
    var parent = parentOf(t);
    if (parent && attachmentsOf(parent).length) {
      groups.push({ label: 'Pièces jointes de la tâche parente (« ' + firstLine(parent.text, 60).trim() + ' ») :', list: attachmentsOf(parent) });
    }
    if (attachmentsOf(t).length) groups.push({ label: 'Pièces jointes :', list: attachmentsOf(t) });
    var budget = ATTACH_INLINE_MAX, files = 0, out = [];
    groups.forEach(function (g) {
      var lines = [];
      g.list.forEach(function (a) {
        if (a.kind !== 'text') {
          if (!a.path) return;
          /* Un enregistrement ne se lit pas : l'agent a sa transcription, jointe en texte (voir transcribeAttachment). */
          var media = mediaKind(a);
          if (media) {
            lines.push('- ' + attachLabel(a) + ' (enregistrement ' + (media === 'audio' ? 'audio' : 'vidéo')
              + (transcriptOf(g.list, a.id) ? ', sa transcription est jointe ci-dessous' : ', non transcrit') + ') : ' + a.path);
            return;
          }
          lines.push('- ' + attachLabel(a) + (a.kind === 'image' ? ' (image)' : '') + ' : ' + a.path);
          files++;
          return;
        }
        var text = String(a.text || '').replace(/^(\s*\n)+/, '').replace(/\s+$/, '');
        if (!text) return;
        var label = 'Texte' + (a.name.trim() ? ' « ' + a.name.trim() + ' »' : '');
        if (text.length > budget && a.path) {
          lines.push('- ' + label + ', ' + fmtCount(text.length) + ' caractères, à lire sur le disque : ' + a.path);
          files++;
          return;
        }
        /* Sans copie sur le disque (pas encore écrite), le texte part quand même, raccourci. */
        if (text.length > budget) text = text.slice(0, Math.max(budget, 500)) + '\n[… texte tronqué]';
        budget = Math.max(0, budget - text.length);
        lines.push('- ' + label + ' :');
        text.split(/\r?\n/).forEach(function (l) { lines.push('    ' + l); });
      });
      if (lines.length) out = out.concat([''], [g.label], lines);
    });
    if (!out.length) return '';
    if (files) out.push('Ouvre ces fichiers avant de commencer : ils font partie de la demande (ton outil de lecture ouvre aussi les images et les PDF).');
    return '\n' + out.join('\n');
  }

  function normalizeAttachments(list) {
    if (!Array.isArray(list)) return [];
    var seen = {};
    return list.filter(function (a) { return a && typeof a === 'object'; }).map(function (a) {
      var kind = ATTACH_KINDS[a.kind] ? a.kind : 'file';
      var out = {
        id: String(a.id || uid('pj')), kind: kind, name: String(a.name == null ? '' : a.name),
        path: String(a.path == null ? '' : a.path), size: Number(a.size) || 0, added: toMs(a.added) || Date.now()
      };
      if (kind === 'text') out.text = String(a.text == null ? '' : a.text);
      /* Transcription d'un enregistrement joint : l'identifiant de la pièce audio. */
      if (kind === 'text' && a.source) out.source = String(a.source);
      return out;
    }).filter(function (a) {
      if (seen[a.id]) return false;
      seen[a.id] = true;
      return a.kind === 'text' || !!a.path;
    });
  }

  /* Liste d'un « propriétaire » : une tâche, ou celle qu'on est en train de créer (Nouvelle tâche).
     null quand il n'existe plus (tâche supprimée, création abandonnée entre-temps). */
  function attachListFor(ownerId, create) {
    if (ownerId && ownerId === S.ui.composerId) return S.ui.composerAttachments;
    var t = taskById(ownerId);
    if (!t || t.id === FEEDBACK_ID) return null;
    if (!Array.isArray(t.attachments)) {
      if (!create) return [];
      t.attachments = [];
    }
    return t.attachments;
  }

  function attachmentById(ownerId, attId) {
    return (attachListFor(ownerId, false) || []).filter(function (a) { return a.id === attId; })[0] || null;
  }

  /* Une tâche réelle s'enregistre ; celle du dialogue attend d'être créée. */
  function attachChanged(ownerId, now) {
    if (ownerId === S.ui.composerId || !taskById(ownerId)) return;
    if (now) saveDataNow(); else saveDataSoon();
  }

  /* Le formulaire de lancement ouvert propose un premier message ; s'il n'a pas été retouché, il
     suit les pièces jointes qu'on ajoute ou retire pendant ce temps. */
  function editAttachments(fn) {
    var open = S.ui.newConvoOpen ? taskById(S.ui.termTaskId) : null;
    if (open && open.id === FEEDBACK_ID) open = null;
    var before = open ? buildPrompt(open) : null;
    fn();
    if (open && S.ui.newConvoPrompt === before) S.ui.newConvoPrompt = buildPrompt(open);
  }

  function attachLabel(a) {
    if (a.kind === 'text') return a.name.trim() || firstLine(String(a.text || '').trim(), 60) || 'Texte vide';
    return a.name || lastSegment(a.path);
  }

  function attachTip(a) {
    if (a.kind !== 'text') return attachLabel(a) + (a.size ? ' · ' + fmtSize(a.size) : '');
    var n = String(a.text || '').length;
    return attachLabel(a) + ' · ' + fmtCount(n) + (n > 1 ? ' caractères' : ' caractère');
  }

  /* Vignette d'une image : le dossier des pièces jointes est servi par l'hôte (attach.organizator). */
  function attachUrl(a) {
    var base = String(S.env.attachmentsUrl || ''), dir = String(S.env.attachmentsDir || '').replace(/[\\\/]+$/, '');
    var p = String(a.path || '');
    if (!base || !dir || p.toLowerCase().indexOf(dir.toLowerCase() + '\\') !== 0) return '';
    return base + p.slice(dir.length + 1).split(/[\\\/]/).map(encodeURIComponent).join('/');
  }

  function attachBusy(ownerId, delta) {
    S.ui.attachBusy[ownerId] = Math.max(0, (S.ui.attachBusy[ownerId] || 0) + delta);
    if (!S.ui.attachBusy[ownerId]) delete S.ui.attachBusy[ownerId];
  }

  /* Range ce que l'hôte a copié ; ce qu'il a laissé de côté est dit, avec pourquoi. Si la tâche
     a disparu entre-temps, les copies n'ont plus de raison d'être. */
  function receiveAttachments(ownerId, r) {
    var added = (r && r.attachments) || [];
    var list = attachListFor(ownerId, true);
    if (!list) {
      added.forEach(function (a) { bridge.call('removeAttachment', { path: a.path })['catch'](function () { /* sans importance */ }); });
      return 0;
    }
    var fresh = [];
    editAttachments(function () {
      added.forEach(function (a) {
        var item = {
          id: uid('pj'), kind: a.kind === 'image' ? 'image' : 'file', name: String(a.name || lastSegment(a.path)),
          path: String(a.path || ''), size: Number(a.size) || 0, added: Date.now()
        };
        list.push(item);
        fresh.push(item);
      });
    });
    var skipped = (r && r.skipped) || [];
    if (skipped.length) {
      toast(skipped.map(function (s) { return '« ' + s.name + ' » : ' + (ATTACH_SKIP[s.reason] || s.reason); }).join(' · '));
    }
    /* Un enregistrement audio se transcrit aussitôt (Réglages › Dictée) : c'est son texte que l'agent lira. */
    if (S.settings.whisperAuto !== false) {
      fresh.forEach(function (a) { if (mediaKind(a) === 'audio') transcribeAttachment(ownerId, a.id); });
    }
    return added.length;
  }

  function attachDone(ownerId, n, quiet) {
    if (n) attachChanged(ownerId, true);
    render();
    if (n && !quiet) toast(n > 1 ? n + ' pièces jointes ajoutées' : 'Pièce jointe ajoutée');
  }

  function attachFailed(ownerId, e) {
    attachBusy(ownerId, -1);
    render();
    toast('Pièce jointe impossible : ' + e.message);
  }

  /* Bouton « Joindre des fichiers » : le sélecteur de Windows, plusieurs fichiers à la fois. */
  function pickAttachments(ownerId) {
    if (!attachListFor(ownerId, false)) return;
    attachBusy(ownerId, 1);
    render();
    bridge.call('addAttachments', { taskId: ownerId, pick: true }, 600000)
      .then(function (r) {
        attachBusy(ownerId, -1);
        attachDone(ownerId, r && r.cancelled ? 0 : receiveAttachments(ownerId, r));
      })['catch'](function (e) { attachFailed(ownerId, e); });
  }

  /* Fichiers déposés ou collés : WebView2 en donne le chemin à l'hôte, qui les copie. Ce qui n'a
     pas de chemin — une capture dans le presse-papiers — repart par son contenu. */
  function attachFiles(ownerId, fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length || !attachListFor(ownerId, false)) return;
    attachBusy(ownerId, 1);
    render();
    bridge.call('addAttachments', { taskId: ownerId, names: files.map(function (f) { return f.name; }) }, 300000, files)
      .then(function (r) {
        var n = receiveAttachments(ownerId, r);
        var rest = ((r && r.unresolved) || []).map(function (i) { return files[i]; }).filter(Boolean);
        return rest.length ? pasteFiles(ownerId, rest).then(function (m) { return n + m; }) : n;
      }, function (e) {
        /* Message non parti (WebView2 sans transport de fichiers) : le contenu fait l'affaire. */
        if (!e || !e.notSent) throw e;
        return pasteFiles(ownerId, files);
      })
      .then(function (n) { attachBusy(ownerId, -1); attachDone(ownerId, n); })
      ['catch'](function (e) { attachFailed(ownerId, e); });
  }

  function readBase64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = function () { reject(fr.error || new Error('lecture impossible')); };
      fr.readAsDataURL(file);
    });
  }

  function pasteFiles(ownerId, files) {
    var n = 0;
    return files.reduce(function (p, f) {
      return p.then(function () {
        if (f.size > ATTACH_DATA_MAX) { toast('« ' + f.name + ' » : trop volumineux pour être collé'); return null; }
        return readBase64(f)
          .then(function (data) { return bridge.call('pasteAttachment', { taskId: ownerId, name: pastedName(f), data: data }, 60000); })
          .then(function (r) { n += receiveAttachments(ownerId, r); });
      });
    }, Promise.resolve()).then(function () { return n; });
  }

  /* Une capture collée s'appelle « image.png » : elle prend la date et l'heure. */
  function pastedName(f) {
    var name = String(f.name || '');
    if (name && !/^image\.(png|jpe?g|gif|bmp|webp)$/i.test(name)) return name;
    var d = new Date();
    function p2(x) { return (x < 10 ? '0' : '') + x; }
    var m = /^image\/(png|jpeg|gif|webp|bmp)$/.exec(f.type || '');
    return 'capture-' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
      + '-' + p2(d.getHours()) + 'h' + p2(d.getMinutes()) + '.' + (m ? m[1].replace('jpeg', 'jpg') : 'png');
  }

  /* Blocs de texte : la copie sur le disque suit la frappe (700 ms), et tout ce qui attend est
     écrit avant un lancement, pour que l'agent lise la dernière version. */
  var textPending = {}, textInFlight = {};

  function addTextAttachment(ownerId) {
    var list = attachListFor(ownerId, true);
    if (!list) return;
    var a = { id: uid('pj'), kind: 'text', name: '', text: '', path: '', size: 0, added: Date.now() };
    list.push(a);
    attachChanged(ownerId, true);
    writeTextSoon(ownerId, a);
    writeTextNow(a.id);
    render();
    var ta = document.querySelector('[data-focus-key="att-text-' + a.id + '"]');
    if (ta) ta.focus();
  }

  function writeTextSoon(ownerId, a) {
    var p = textPending[a.id];
    if (p) clearTimeout(p.timer);
    textPending[a.id] = { owner: ownerId, att: a, timer: setTimeout(function () { writeTextNow(a.id); }, 700) };
  }

  function writeTextNow(id) {
    var p = textPending[id];
    if (!p) return textInFlight[id] || Promise.resolve();
    clearTimeout(p.timer);
    delete textPending[id];
    var a = p.att;
    var job = (textInFlight[id] || Promise.resolve())
      .then(function () { return bridge.call('writeAttachmentText', { taskId: p.owner, id: a.id, text: a.text || '' }); })
      .then(function (r) {
        var fresh = !a.path;
        a.path = String((r && r.path) || a.path);
        a.size = Number(r && r.size) || 0;
        if (fresh && a.path) attachChanged(p.owner, false);
      })['catch'](function (e) { toast('Texte joint non enregistré : ' + e.message); });
    textInFlight[id] = job;
    job.then(function () { if (textInFlight[id] === job) delete textInFlight[id]; });
    return job;
  }

  function flushTextWrites() {
    var jobs = Object.keys(textPending).map(writeTextNow);
    Object.keys(textInFlight).forEach(function (k) { jobs.push(textInFlight[k]); });
    return Promise.all(jobs);
  }

  /* Retirer une pièce jointe supprime sa copie — l'original, s'il y en avait un, n'est pas touché. */
  function removeAttachment(ownerId, attId) {
    var list = attachListFor(ownerId, false) || [];
    var i = list.findIndex(function (a) { return a.id === attId; });
    if (i < 0) return;
    var a = list[i];
    editAttachments(function () { list.splice(i, 1); });
    cancelTranscription(attId, true);
    var p = textPending[attId];
    if (p) { clearTimeout(p.timer); delete textPending[attId]; }
    /* Un bloc en cours d'écriture reçoit son chemin à la fin de l'écriture : on l'attend. */
    (textInFlight[attId] || Promise.resolve()).then(function () {
      if (a.path) bridge.call('removeAttachment', { path: a.path })['catch'](function () { /* sans importance */ });
    });
    attachChanged(ownerId, true);
    render();
  }

  /* Ouvrir : dans le lecteur de la fenêtre (image, PDF, texte, Markdown…), comme un rapport ; depuis
     le dialogue Nouvelle tâche, qui couvrirait le lecteur, avec l'application de Windows. */
  function openAttachment(ownerId, attId) {
    var a = attachmentById(ownerId, attId);
    if (!a) return;
    var ready = Promise.resolve();
    if (a.kind === 'text') { writeTextSoon(ownerId, a); ready = writeTextNow(a.id); }
    ready.then(function () {
      if (!a.path) { toast('Pièce jointe introuvable sur le disque.'); return; }
      if (ownerId === S.ui.composerId) {
        bridge.call('openPath', { path: a.path, editor: 'default' })['catch'](function (e) { toast('Ouverture impossible : ' + e.message); });
      } else {
        openReader(a.path, '');
      }
    });
  }

  /* La tâche en création abandonnée emporte ses copies. */
  function dropComposerAttachments() {
    var id = S.ui.composerId;
    var had = S.ui.composerAttachments.length || S.ui.attachBusy[id];
    if (id) cancelOwnerTranscriptions(id);
    S.ui.composerAttachments.forEach(function (a) {
      var p = textPending[a.id];
      if (p) { clearTimeout(p.timer); delete textPending[a.id]; }
    });
    S.ui.composerAttachments = [];
    S.ui.composerId = null;
    if (id && had) bridge.call('removeAttachments', { taskId: id })['catch'](function () { /* sans importance */ });
  }

  /* Rendu : en lecture, une rangée de vignettes et de pastilles qui s'ouvrent d'un clic ; en édition
     (carte ou dialogue), les mêmes avec une croix, les blocs de texte dépliés, et de quoi en ajouter. */
  function attachChipHtml(ownerId, a, editing) {
    var url = a.kind === 'image' ? attachUrl(a) : '';
    var icon = a.kind === 'text' ? ICON.note : (a.kind === 'image' ? ICON.image : ICON.clip);
    var ids = ' data-owner="' + esc(ownerId) + '" data-att="' + esc(a.id) + '"';
    var open = '<button type="button" class="att att-' + esc(a.kind) + (url ? ' att-thumb' : '') + '" data-act="open-attachment"'
      + ids + ' draggable="false" title="' + esc(attachTip(a)) + '">'
      + (url
        ? '<img src="' + esc(url) + '" alt="' + esc(attachLabel(a)) + '" loading="lazy" draggable="false">'
        : icon + '<span class="att-name">' + esc(attachLabel(a)) + '</span>')
      + '</button>';
    if (!editing) return open;
    return '<span class="att-wrap">' + open + '<button type="button" class="att-x" data-act="remove-attachment"' + ids
      + ' title="Retirer cette pièce jointe" aria-label="Retirer ' + esc(attachLabel(a)) + '">×</button></span>';
  }

  function attachTextEditorHtml(ownerId, a) {
    var ids = ' data-owner="' + esc(ownerId) + '" data-att="' + esc(a.id) + '"';
    var rows = Math.min(10, Math.max(3, String(a.text || '').split('\n').length + 1));
    return '<div class="att-note">'
      + '<div class="att-note-head">' + ICON.note
      + '<input class="input att-note-title" type="text" data-role="att-title"' + ids + ' data-focus-key="att-title-' + esc(a.id)
      + '" spellcheck="false" placeholder="Titre du texte (facultatif)" value="' + esc(a.name) + '">'
      + '<button type="button" class="att-x" data-act="remove-attachment"' + ids + ' title="Retirer ce texte" aria-label="Retirer ce texte">×</button>'
      + '</div>'
      + '<textarea class="input att-note-text" rows="' + rows + '" data-role="att-text"' + ids + ' data-focus-key="att-text-' + esc(a.id)
      + '" spellcheck="false" placeholder="Collez ou écrivez le texte : un log, un mail, une consigne…">' + esc(a.text) + '</textarea>'
      + '</div>';
  }

  function attachmentsHtml(ownerId, list, editing) {
    list = list || [];
    var busy = !!S.ui.attachBusy[ownerId];
    if (!editing && !list.length && !busy) return '';
    var chips = list.filter(function (a) { return !(editing && a.kind === 'text'); })
      .map(function (a) { return attachChipHtml(ownerId, a, editing) + attachMediaHtml(ownerId, a, list); });
    var h = ['<div class="attach' + (editing ? ' is-editing' : '') + '">'];
    if (chips.length || busy) {
      h.push('<div class="attach-strip">' + chips.join('')
        + (busy ? '<span class="att-busy"><span class="draft-spin"></span>Copie…</span>' : '') + '</div>');
    }
    if (editing) {
      list.filter(function (a) { return a.kind === 'text'; }).forEach(function (a) { h.push(attachTextEditorHtml(ownerId, a)); });
      var ids = ' data-owner="' + esc(ownerId) + '"';
      h.push('<div class="attach-tools">'
        + '<button type="button" class="draft-btn" data-act="attach-pick"' + ids + (busy ? ' disabled' : '')
        + ' title="Copier des fichiers dans la tâche : l’agent les recevra">' + ICON.clip + 'Joindre des fichiers</button>'
        + '<button type="button" class="draft-btn" data-act="attach-text"' + ids
        + ' title="Un log, un mail, un extrait : gardé à part, envoyé en entier à l’agent">' + ICON.note + 'Ajouter un texte</button>'
        + '<span class="attach-hint">ou glissez des fichiers ici, collez une capture (Ctrl + V)</span>'
        + '</div>');
    }
    h.push('</div>');
    return h.join('');
  }

  /* ── Dictée et transcription (Whisper) ─────────────────────────────────
     Un même moteur pour deux usages : Whisper, sur le poste (hôte : WhisperTranscriber).
     - Dictée : un micro se pose dans le coin de la zone de saisie active (#dictate, hors des zones
       de rendu) ; Ctrl + Maj + Espace démarre et termine, Échap annule. La page enregistre
       (MediaRecorder), ramène le son à 16 kHz mono (OfflineAudioContext) et l'envoie en WAV à l'hôte
       (`transcribe` avec `data`), puis insère le texte au curseur par insertText : Ctrl + Z le défait,
       et le gestionnaire `input` du champ enregistre la saisie comme une frappe.
     - Enregistrements joints : un fichier audio joint à une tâche est transcrit (`transcribe` avec
       `path`), et sa transcription jointe en bloc de texte (`source` = la pièce audio) : c'est elle que
       l'agent lit. Une vidéo — souvent une capture d'écran muette — ne se transcrit qu'à la demande. */
  var AUDIO_EXT = { mp3: 1, wav: 1, m4a: 1, aac: 1, wma: 1, ogg: 1, oga: 1, opus: 1, flac: 1, amr: 1 };
  var VIDEO_EXT = { mp4: 1, m4v: 1, mov: 1, webm: 1, mkv: 1, '3gp': 1 };
  var DICTATE_MAX_MS = 10 * 60 * 1000;
  var WHISPER_LANGS = [
    { id: 'fr', label: 'Français' }, { id: 'en', label: 'Anglais' }, { id: 'auto', label: 'Détection automatique' }
  ];
  var WHISPER_PHASES = { queue: 'En attente…', decode: 'Lecture…', load: 'Chargement du modèle…' };

  function whisperOn() { return S.settings.whisperEnabled !== false; }
  function whisperModels() { return (S.env.whisper && S.env.whisper.models) || []; }

  function mediaKind(a) {
    if (!a || a.kind !== 'file') return '';
    var ext = extOf(a.path || a.name);
    return AUDIO_EXT[ext] ? 'audio' : (VIDEO_EXT[ext] ? 'video' : '');
  }

  function transcriptOf(list, attId) {
    return (list || []).filter(function (x) { return x.kind === 'text' && x.source === attId; })[0] || null;
  }

  /* L'avancement tel qu'on le lit : le modèle qui se télécharge (premier usage), puis les étapes de l'hôte. */
  function whisperPhaseLabel(p) {
    if (!p || !p.phase) return 'Transcription…';
    if (p.phase === 'download') {
      return 'Téléchargement du modèle' + (p.total ? ' · ' + Math.floor(100 * (p.received || 0) / p.total) + ' %' : '…');
    }
    if (p.phase === 'transcribe') return 'Transcription' + (p.percent ? ' · ' + p.percent + ' %' : '…');
    return WHISPER_PHASES[p.phase] || 'Transcription…';
  }

  /* Dans la carte des modèles, à côté du nom : plus court. */
  function whisperDlLabel(p) {
    return 'Téléchargement' + (p && p.total ? ' · ' + Math.floor(100 * (p.received || 0) / p.total) + ' %' : '…');
  }

  /* ·· Enregistrements joints ·· */

  function transcribeAttachment(ownerId, attId) {
    var a = attachmentById(ownerId, attId);
    if (!a || !a.path || S.ui.transcribing[attId]) return;
    var run = S.ui.transcribing[attId] = { owner: ownerId, job: uid('tj'), phase: 'queue' };
    render();
    bridge.call('transcribe', {
      job: run.job, path: a.path, model: S.settings.whisperModel, language: S.settings.whisperLanguage
    }, 4 * 3600000).then(function (r) {
      if (S.ui.transcribing[attId] !== run) return;
      delete S.ui.transcribing[attId];
      var list = attachListFor(ownerId, true);
      var text = String((r && r.text) || '').trim();
      /* Tâche supprimée, création abandonnée ou enregistrement retiré entre-temps : rien à joindre. */
      if (!list || !attachmentById(ownerId, attId)) { render(); return; }
      if (!text) { render(); toast('Aucune parole reconnue dans « ' + attachLabel(a) + ' »'); return; }
      var t = { id: uid('pj'), kind: 'text', name: 'Transcription — ' + attachLabel(a), text: text, path: '', size: 0, added: Date.now(), source: attId };
      editAttachments(function () { list.push(t); });
      attachChanged(ownerId, true);
      writeTextSoon(ownerId, t);
      writeTextNow(t.id);
      render();
      toast('« ' + attachLabel(a) + ' » transcrit : ' + fmtCount(text.length) + ' caractères, joints en texte');
    }, function (e) {
      if (S.ui.transcribing[attId] !== run) return;
      delete S.ui.transcribing[attId];
      render();
      toast('Transcription impossible : ' + e.message);
    });
  }

  function cancelTranscription(attId, quiet) {
    var run = S.ui.transcribing[attId];
    if (!run) return;
    delete S.ui.transcribing[attId];
    bridge.call('cancelTranscribe', { job: run.job })['catch'](function () { /* déjà finie */ });
    if (!quiet) render();
  }

  /* Tâche supprimée, création abandonnée : ses transcriptions n'ont plus où aller. */
  function cancelOwnerTranscriptions(ownerId) {
    Object.keys(S.ui.transcribing).forEach(function (id) {
      if (S.ui.transcribing[id].owner === ownerId) cancelTranscription(id, true);
    });
  }

  /* À côté d'un enregistrement : l'avancement de sa transcription, ou de quoi la lancer s'il n'en a pas. */
  function attachMediaHtml(ownerId, a, list) {
    var kind = mediaKind(a);
    if (!kind) return '';
    var ids = ' data-owner="' + esc(ownerId) + '" data-att="' + esc(a.id) + '"';
    var run = S.ui.transcribing[a.id];
    if (run) {
      return '<span class="att-tr"><span class="draft-spin"></span><span data-tr="' + esc(a.id) + '">' + esc(whisperPhaseLabel(run)) + '</span>'
        + '<button type="button" class="att-x" data-act="cancel-transcribe"' + ids + ' title="Arrêter la transcription" aria-label="Arrêter la transcription">×</button></span>';
    }
    if (transcriptOf(list, a.id)) return '';
    return '<button type="button" class="att-tr-btn" data-act="transcribe-attachment"' + ids
      + ' title="Transcrire ' + (kind === 'audio' ? 'l’enregistrement' : 'le son de la vidéo') + ' avec Whisper, sur ce poste : le texte est joint à la tâche, et c’est lui que l’agent lit">'
      + ICON.mic + 'Transcrire</button>';
  }

  /* Avancement : le libellé seul est réécrit, sans redessiner la file à chaque pour-cent. */
  function patchTranscribing(attId) {
    var run = S.ui.transcribing[attId];
    if (!run) return;
    var label = whisperPhaseLabel(run);
    Array.prototype.forEach.call(document.querySelectorAll('[data-tr="' + attId + '"]'), function (el) { el.textContent = label; });
  }

  /* Événement `whisper` de l'hôte : l'étape d'une transcription (`job`), ou un téléchargement de modèle
     (`model` seul) — que suivent alors les Réglages et tout ce qui attend ce modèle. */
  function onWhisperEvent(p) {
    p = p || {};
    if (p.job) {
      if (dict && dict.job === p.job) { dict.progress = p; renderDictate(); return; }
      Object.keys(S.ui.transcribing).forEach(function (id) {
        var run = S.ui.transcribing[id];
        if (run.job !== p.job) return;
        run.phase = p.phase; run.percent = p.percent; run.received = p.received; run.total = p.total;
        patchTranscribing(id);
      });
      return;
    }
    if (!p.model) return;
    if (p.phase === 'download') {
      S.ui.whisperDl[p.model] = { received: p.received || 0, total: p.total || 0 };
      if (dict && dict.progress && dict.progress.phase === 'download') { dict.progress = p; renderDictate(); }
      Object.keys(S.ui.transcribing).forEach(function (id) {
        var run = S.ui.transcribing[id];
        if (run.phase !== 'download') return;
        run.received = p.received; run.total = p.total;
        patchTranscribing(id);
      });
      var dl = document.querySelector('[data-whisper-dl="' + p.model + '"]');
      if (dl) dl.textContent = whisperDlLabel(p);
      return;
    }
    /* Téléchargement fini ou en échec : les Réglages relisent l'état des modèles. */
    delete S.ui.whisperDl[p.model];
    refreshWhisper();
  }

  function refreshWhisper() {
    return bridge.call('whisperStatus', {}).then(function (st) {
      S.env.whisper = st;
      if (S.ui.settingsOpen && settingsTab() === 'voice') renderDialogs();
    })['catch'](function () { /* l'état affiché reste celui du démarrage */ });
  }

  function downloadWhisper(id) {
    if (S.ui.whisperDl[id]) return;
    S.ui.whisperDl[id] = { received: 0, total: 0 };
    renderDialogs();
    bridge.call('whisperDownload', { model: id }, 3600000).then(function (st) {
      delete S.ui.whisperDl[id];
      if (st && st.models) S.env.whisper = st;
      renderDialogs();
    }, function (e) {
      delete S.ui.whisperDl[id];
      renderDialogs();
      toast(e.message);
    });
  }

  function removeWhisper(id) {
    bridge.call('whisperRemove', { model: id }, 60000).then(function () {
      delete S.ui.whisperDl[id];
      return refreshWhisper();
    }, function (e) { toast('Suppression impossible : ' + e.message); });
  }

  /* ·· Dictée ·· */

  /* Dictée en cours : { key, el, phase: starting | recording | transcribing, job, selStart, selEnd,
     startedAt, chunks, recorder, stream, ctx, analyser, wave, level, timer, progress, cancelled }. */
  var dict = null, dictFocus = null, dictBox = null;

  /* Un champ qui se dicte : une zone de texte du rendu (data-focus-key la retrouve après un rendu). */
  function dictTarget(el) {
    if (!el || el.tagName !== 'TEXTAREA' || el.disabled || el.readOnly) return null;
    /* data-dict="off" : un champ où l'on doit écrire soi-même (exercice d'écrit de Révizator). */
    if (el.getAttribute('data-dict') === 'off') return null;
    return el.getAttribute('data-focus-key') ? el : null;
  }

  /* Le rendu a pu reconstruire le champ : on le retrouve par sa clé. */
  function dictField(d) {
    if (d.el && document.contains(d.el)) return d.el;
    d.el = document.querySelector('textarea[data-focus-key="' + d.key + '"]');
    return d.el;
  }

  function fmtClock(ms) {
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  function renderDictate() {
    if (!dictBox) return;
    /* Champ reconstruit par un rendu, ou focus donné sans événement (fenêtre inactive) : l'élément actif fait foi. */
    if (!dictFocus || !document.contains(dictFocus)) dictFocus = dictTarget(document.activeElement);
    var field = dict ? dictField(dict) : (whisperOn() ? dictFocus : null);
    if (!dict && !field) {
      if (!dictBox.hidden) { dictBox.hidden = true; dictBox.innerHTML = ''; dictBox.removeAttribute('data-mode'); }
      return;
    }
    var mode = !dict ? 'idle' : (dict.phase === 'transcribing' ? 'busy' : 'rec');
    if (dictBox.getAttribute('data-mode') !== mode || mode === 'busy') {
      var h;
      if (mode === 'idle') {
        h = '<button type="button" class="dictate-mic" data-dictate="start" title="Dicter — Whisper, sur ce poste (Ctrl + Maj + Espace)" aria-label="Dicter">' + ICON.mic + '</button>';
      } else if (mode === 'rec') {
        h = '<span class="dictate-dot"></span><span class="dictate-time">0:00</span><span class="dictate-level"><i></i></span>'
          + '<button type="button" class="dictate-btn dictate-ok" data-dictate="stop" title="Terminer et transcrire (Ctrl + Maj + Espace)" aria-label="Terminer et transcrire">' + ICON.check + '</button>'
          + '<button type="button" class="dictate-btn" data-dictate="cancel" title="Annuler (Échap)" aria-label="Annuler la dictée">×</button>';
      } else {
        h = '<span class="draft-spin"></span><span class="dictate-label">' + esc(whisperPhaseLabel(dict.progress)) + '</span>'
          + '<button type="button" class="dictate-btn" data-dictate="cancel" title="Abandonner (Échap)" aria-label="Abandonner la dictée">×</button>';
      }
      dictBox.innerHTML = h;
      dictBox.setAttribute('data-mode', mode);
      dictBox.className = 'dictate is-' + mode;
    }
    dictBox.hidden = false;
    placeDictate(field);
  }

  /* Dans le coin bas droit du champ, à l'intérieur ; le champ refermé pendant une dictée, en bas à droite de la fenêtre. */
  function placeDictate(field) {
    if (!dictBox || dictBox.hidden) return;
    var w = dictBox.offsetWidth, h = dictBox.offsetHeight;
    var r = field ? field.getBoundingClientRect() : null;
    if (!r || !r.width || r.bottom < 0 || r.top > window.innerHeight) {
      if (!dict) { dictBox.hidden = true; return; }
      r = { right: window.innerWidth - 10, bottom: window.innerHeight - 10 };
    }
    var bar = field ? Math.max(0, field.offsetWidth - field.clientWidth - 4) : 0;
    dictBox.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, r.right - bar - w - 6)) + 'px';
    dictBox.style.top = Math.max(4, Math.min(window.innerHeight - h - 4, r.bottom - h - 6)) + 'px';
  }

  function micError(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'accès refusé (Paramètres Windows › Confidentialité › Microphone).';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'aucun micro trouvé.';
    if (n === 'NotReadableError') return 'le micro est déjà pris par une autre application.';
    return (e && e.message) || String(e);
  }

  function startDictation(field) {
    field = dictTarget(field);
    if (dict || !field || !whisperOn()) return;
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast('Dictée impossible : pas d’accès au micro dans cette fenêtre.');
      return;
    }
    if (voiceRec) { toast('Le micro est déjà pris par un enregistrement en cours.'); return; }
    var d = dict = {
      key: field.getAttribute('data-focus-key'), el: field, phase: 'starting', job: uid('dj'),
      /* data-dict-lang="en" : un champ qui se dicte toujours dans cette langue (Révizator), quel que soit le réglage. */
      lang: field.getAttribute('data-dict-lang') || '',
      selStart: field.selectionStart, selEnd: field.selectionEnd, chunks: [], startedAt: Date.now(), level: 0
    };
    /* Le modèle se télécharge (premier usage) ou se charge pendant qu'on parle. */
    bridge.call('whisperWarm', { model: S.settings.whisperModel })['catch'](function () { /* redit à la transcription */ });
    renderDictate();
    md.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (stream) {
        if (dict !== d) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        d.stream = stream;
        d.recorder = new MediaRecorder(stream);
        d.recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) d.chunks.push(ev.data); };
        d.recorder.onstop = function () { recordingStopped(d); };
        d.recorder.start(1000);
        try {
          d.ctx = new (window.AudioContext || window.webkitAudioContext)();
          d.analyser = d.ctx.createAnalyser();
          d.analyser.fftSize = 1024;
          d.ctx.createMediaStreamSource(stream).connect(d.analyser);
          d.wave = new Float32Array(d.analyser.fftSize);
        } catch (err) { d.analyser = null; }
        d.phase = 'recording';
        d.startedAt = Date.now();
        d.timer = setInterval(function () { tickDictate(d); }, 100);
        renderDictate();
      })['catch'](function (e) {
        if (dict !== d) return;
        endDictation(d);
        toast('Micro indisponible : ' + micError(e));
      });
  }

  /* Chrono et niveau du micro, réécrits sur place : on voit que le son passe. */
  function tickDictate(d) {
    if (dict !== d || d.phase !== 'recording' || !dictBox) return;
    var ms = Date.now() - d.startedAt;
    if (ms >= DICTATE_MAX_MS) { stopDictation(); toast('Dictée arrêtée au bout de dix minutes : pour plus long, joignez un enregistrement.'); return; }
    if (d.analyser) {
      d.analyser.getFloatTimeDomainData(d.wave);
      var sum = 0;
      for (var i = 0; i < d.wave.length; i++) sum += d.wave[i] * d.wave[i];
      d.level = Math.max(Math.min(1, Math.sqrt(sum / d.wave.length) * 5), d.level * 0.8);
    }
    var t = dictBox.querySelector('.dictate-time');
    if (t) t.textContent = fmtClock(ms);
    var bar = dictBox.querySelector('.dictate-level i');
    if (bar) bar.style.transform = 'scaleX(' + Math.max(0.04, d.level).toFixed(3) + ')';
  }

  function releaseMic(d) {
    if (d.timer) { clearInterval(d.timer); d.timer = null; }
    if (d.stream) { d.stream.getTracks().forEach(function (t) { t.stop(); }); d.stream = null; }
    if (d.ctx) { try { d.ctx.close(); } catch (e) { /* déjà fermé */ } d.ctx = null; }
  }

  function stopDictation() {
    var d = dict;
    if (!d) return;
    if (d.phase === 'starting') { cancelDictation(); return; }
    if (d.phase !== 'recording') return;
    d.phase = 'transcribing';
    d.progress = null;
    renderDictate();
    /* stop() rend les derniers morceaux puis appelle onstop : la suite est dans recordingStopped. */
    try { d.recorder.stop(); } catch (e) { recordingStopped(d); }
    releaseMic(d);
  }

  function cancelDictation() {
    var d = dict;
    if (!d) return;
    d.cancelled = true;
    if (d.phase === 'transcribing') bridge.call('cancelTranscribe', { job: d.job })['catch'](function () { /* déjà finie */ });
    if (d.recorder && d.recorder.state !== 'inactive') { try { d.recorder.stop(); } catch (e) { /* déjà arrêté */ } }
    endDictation(d);
  }

  function endDictation(d) {
    releaseMic(d);
    if (dict === d) dict = null;
    renderDictate();
  }

  function recordingStopped(d) {
    if (d.cancelled || dict !== d) return;
    var blob = new Blob(d.chunks, { type: (d.recorder && d.recorder.mimeType) || 'audio/webm' });
    d.chunks = [];
    if (!blob.size || Date.now() - d.startedAt < 400) { endDictation(d); toast('Rien d’enregistré.'); return; }
    wav16k(blob).then(readBase64).then(function (data) {
      if (d.cancelled) return null;
      return bridge.call('transcribe', { job: d.job, data: data, model: S.settings.whisperModel, language: d.lang || S.settings.whisperLanguage }, 3600000);
    }).then(function (r) {
      if (r && !d.cancelled) insertDictation(d, r.text);
    }, function (e) {
      if (!d.cancelled) toast('Dictée impossible : ' + e.message);
    }).then(function () { endDictation(d); });
  }

  /* Ce que MediaRecorder rend (webm/opus) devient ce que Whisper lit : WAV 16 kHz mono 16 bits. */
  function wav16k(blob) {
    var AC = window.AudioContext || window.webkitAudioContext;
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC || !OAC) return Promise.reject(new Error('décodage audio indisponible dans cette fenêtre'));
    return blob.arrayBuffer().then(function (buf) {
      var ctx = new AC();
      return ctx.decodeAudioData(buf).then(function (audio) { ctx.close(); return audio; },
        function () { ctx.close(); throw new Error('enregistrement illisible'); });
    }).then(function (audio) {
      var off = new OAC(1, Math.max(1, Math.ceil(audio.duration * 16000)), 16000);
      var src = off.createBufferSource();
      src.buffer = audio;
      src.connect(off.destination);
      src.start();
      return off.startRendering();
    }).then(function (rendered) { return wavBlob(rendered.getChannelData(0), 16000); });
  }

  function wavBlob(samples, rate) {
    var n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (var i = 0, o = 44; i < n; i++, o += 2) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* Un enregistrement du micro pour une autre page que la file (exercice oral, tuteur) : même chaîne
     que la dictée — getUserMedia, MediaRecorder, WAV 16 kHz mono — mais sans champ ni transcription.
     opts : { maxMs, noiseSuppression, onTick(ms, level) }. Rend { stop() → Promise<{ data (base64),
     seconds, blob }>, cancel(), startedAt } ; une seule prise de son à la fois, dictée comprise. */
  var voiceRec = null;

  function recordVoice(opts) {
    opts = opts || {};
    var md = navigator.mediaDevices;
    if (dict || voiceRec) return Promise.reject(new Error('le micro est déjà en cours d’enregistrement'));
    if (!md || !md.getUserMedia || typeof MediaRecorder === 'undefined') return Promise.reject(new Error('pas d’accès au micro dans cette fenêtre'));
    var r = voiceRec = { chunks: [], level: 0, startedAt: Date.now(), done: null };
    var maxMs = Math.max(1000, Math.min(Number(opts.maxMs) || 300000, DICTATE_MAX_MS));
    var ns = opts.noiseSuppression !== false;
    return md.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: ns, autoGainControl: true } })
      .then(function (stream) {
        if (voiceRec !== r) { stream.getTracks().forEach(function (t) { t.stop(); }); throw new Error('enregistrement annulé'); }
        r.stream = stream;
        r.recorder = new MediaRecorder(stream);
        r.recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) r.chunks.push(ev.data); };
        var stopped = new Promise(function (resolve) { r.recorder.onstop = resolve; });
        r.recorder.start(1000);
        try {
          r.ctx = new (window.AudioContext || window.webkitAudioContext)();
          r.analyser = r.ctx.createAnalyser();
          r.analyser.fftSize = 1024;
          r.ctx.createMediaStreamSource(stream).connect(r.analyser);
          r.wave = new Float32Array(r.analyser.fftSize);
        } catch (err) { r.analyser = null; }
        r.startedAt = Date.now();
        var finish = function (keep) {
          if (r.done) return r.done;
          if (r.timer) { clearInterval(r.timer); r.timer = null; }
          try { if (r.recorder.state !== 'inactive') r.recorder.stop(); } catch (e) { /* déjà arrêté */ }
          var seconds = (Date.now() - r.startedAt) / 1000;
          r.done = stopped.then(function () {
            if (r.stream) { r.stream.getTracks().forEach(function (t) { t.stop(); }); r.stream = null; }
            if (r.ctx) { try { r.ctx.close(); } catch (e) { /* déjà fermé */ } r.ctx = null; }
            if (voiceRec === r) voiceRec = null;
            if (!keep) throw new Error('enregistrement annulé');
            var blob = new Blob(r.chunks, { type: (r.recorder && r.recorder.mimeType) || 'audio/webm' });
            if (!blob.size || seconds < 0.4) throw new Error('rien d’enregistré');
            return wav16k(blob).then(function (wav) {
              return readBase64(wav).then(function (data) { return { data: data, seconds: seconds, blob: wav }; });
            });
          });
          return r.done;
        };
        r.timer = setInterval(function () {
          var ms = Date.now() - r.startedAt;
          if (r.analyser) {
            r.analyser.getFloatTimeDomainData(r.wave);
            var sum = 0;
            for (var i = 0; i < r.wave.length; i++) sum += r.wave[i] * r.wave[i];
            r.level = Math.max(Math.min(1, Math.sqrt(sum / r.wave.length) * 5), r.level * 0.8);
          }
          if (opts.onTick) { try { opts.onTick(ms, r.level); } catch (e) { /* affichage seulement */ } }
          if (ms >= maxMs && opts.onLimit) { try { opts.onLimit(); } catch (e) { /* idem */ } }
          if (ms >= maxMs) finish(true);
        }, 100);
        return {
          startedAt: r.startedAt,
          level: function () { return r.level; },
          stop: function () { return finish(true); },
          cancel: function () { finish(false)['catch'](function () { /* annulé */ }); }
        };
      }, function (e) {
        if (voiceRec === r) voiceRec = null;
        throw new Error(micError(e));
      });
  }

  /* Au curseur — ou là où il était au départ si l'on a cliqué ailleurs —, avec les espaces qu'il faut
     de part et d'autre, et une majuscule en début de phrase. */
  function insertDictation(d, text) {
    text = String(text || '').trim();
    if (!text) { toast('Aucune parole reconnue.'); return; }
    var el = dictField(d);
    if (!el || el.disabled || el.readOnly) {
      try { navigator.clipboard.writeText(text); } catch (e) { /* presse-papiers refusé */ }
      toast('Le champ s’est refermé : la dictée est copiée dans le presse-papiers.');
      return;
    }
    var v = el.value;
    var focused = document.activeElement === el;
    var s = Math.min(focused ? el.selectionStart : (d.selStart == null ? v.length : d.selStart), v.length);
    var e = Math.max(s, Math.min(focused ? el.selectionEnd : (d.selEnd == null ? s : d.selEnd), v.length));
    var before = v.slice(0, s), after = v.slice(e);
    if (!before.trim() || /[.!?…:]\s*$|\n\s*$/.test(before)) text = text.charAt(0).toUpperCase() + text.slice(1);
    if (before && !/\s$/.test(before)) text = ' ' + text;
    if (after && !/^\s/.test(after)) text += ' ';
    el.focus();
    try { el.setSelectionRange(s, e); } catch (x) { /* champ non textuel */ }
    var done = false;
    try { done = document.execCommand('insertText', false, text); } catch (x) { done = false; }
    if (!done || el.value === v) {
      el.value = before + text + after;
      try { el.setSelectionRange(s + text.length, s + text.length); } catch (x) { /* champ non textuel */ }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  /* Après un rendu, le champ a pu être reconstruit ou disparaître : le micro le suit. */
  function syncDictate() {
    if (dictBox && (dict || dictFocus || !dictBox.hidden)) renderDictate();
  }

  function bindDictate() {
    dictBox = document.createElement('div');
    dictBox.id = 'dictate';
    dictBox.className = 'dictate';
    dictBox.hidden = true;
    document.body.appendChild(dictBox);
    /* Cliquer le micro ne doit pas ôter le focus au champ : le texte ira là où était le curseur. */
    dictBox.addEventListener('mousedown', function (e) { e.preventDefault(); });
    dictBox.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-dictate]') : null;
      if (!b) return;
      var act = b.getAttribute('data-dictate');
      if (act === 'start') startDictation(dictFocus);
      else if (act === 'stop') stopDictation();
      else if (act === 'cancel') cancelDictation();
    });
    document.addEventListener('focusin', function (e) {
      dictFocus = dictTarget(e.target);
      renderDictate();
    }, true);
    document.addEventListener('focusout', function (e) {
      if (e.target !== dictFocus) return;
      setTimeout(function () {
        if (document.activeElement === dictFocus) return;
        dictFocus = dictTarget(document.activeElement);
        renderDictate();
      }, 0);
    }, true);
    /* Le champ grandit à la frappe, la page défile : le micro reste dans son coin. */
    document.addEventListener('input', function (e) { if (e.target === dictFocus) placeDictate(dictFocus); }, true);
    window.addEventListener('scroll', function () { if (!dictBox.hidden) placeDictate(dict ? dictField(dict) : dictFocus); }, { capture: true, passive: true });
    window.addEventListener('resize', function () { if (!dictBox.hidden) placeDictate(dict ? dictField(dict) : dictFocus); });
    /* Ctrl + Maj + Espace démarre et termine ; Échap annule, sans refermer le dialogue qui est dessous. */
    window.addEventListener('keydown', function (e) {
      if ((e.code === 'Space' || e.key === ' ') && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        if (dict) {
          e.preventDefault(); e.stopPropagation();
          if (dict.phase !== 'transcribing') stopDictation();
          return;
        }
        var t = dictTarget(document.activeElement);
        if (t && whisperOn()) { e.preventDefault(); e.stopPropagation(); startDictation(t); }
        return;
      }
      if (e.key === 'Escape' && dict) { e.preventDefault(); e.stopPropagation(); cancelDictation(); }
    }, true);
  }

  /* ── Travail déjà fait ────────────────────────────────────────────────
     Une nouvelle conversation ne part pas de rien : ce qu'ont rendu les conversations précédentes
     est résumé dans son contexte — pour une sous-tâche, celles de la tâche parente et des sous-tâches
     sœurs qui la précèdent ; pour un parent, celles de ses sous-tâches ; et dans les deux cas celles
     de la tâche elle-même. Le résumé est mécanique et gratuit : la dernière réponse complète de
     chaque agent (son récapitulatif, lue par l'hôte : `getRecaps`) et les rapports qu'il a produits.
     Il se relit et se corrige dans le formulaire avant de partir. La ligne de commande qui porte le
     contexte est bornée (32 Ko) : les réponses les plus anciennes sont raccourcies d'abord. */
  var RECAP_ANSWER_MAX = 3000;
  var RECAP_TOTAL_MAX = 12000;
  var RECAP_SHORT = 500;

  function priorTasksOf(task) {
    if (!task || task.id === FEEDBACK_ID) return [];
    var out = [];
    var parent = parentOf(task);
    if (parent) {
      out.push({ task: parent, kind: 'parent' });
      var sibs = childrenOf(parent.id);
      for (var i = 0; i < sibs.length && sibs[i].id !== task.id; i++) out.push({ task: sibs[i], kind: 'sibling' });
      out.push({ task: task, kind: 'self' });
    } else {
      out.push({ task: task, kind: 'self' });
      childrenOf(task.id).forEach(function (k) { out.push({ task: k, kind: 'child' }); });
    }
    return out.filter(function (e) { return convosOf(e.task.id).length > 0; });
  }

  function byCreated(a, b) { return toMs(a.created) - toMs(b.created); }

  function recapConvos(entries) {
    var convs = [];
    entries.forEach(function (e) {
      convosOf(e.task.id).slice().sort(byCreated).forEach(function (c) { convs.push(c); });
    });
    return convs;
  }

  var recapToken = 0;

  /* Demande à l'hôte la dernière réponse de chaque conversation concernée, puis compose le résumé.
     Le formulaire s'affiche aussitôt (« lecture… ») et se complète quand la réponse arrive. */
  function loadRecap(task) {
    var entries = priorTasksOf(task);
    var convs = recapConvos(entries);
    S.ui.newConvoRecap = '';
    S.ui.newConvoRecapMeta = null;
    S.ui.newConvoRecapBusy = convs.length > 0;
    if (!convs.length) return;
    var token = ++recapToken;
    bridge.call('getRecaps', {
      sessions: convs.map(function (c) { return { sessionId: c.id, cwd: c.cwd, provider: providerOf(c) }; })
    }).then(function (res) {
      if (token !== recapToken || !S.ui.newConvoOpen) return;
      var answers = {};
      ((res && res.sessions) || []).forEach(function (s) { if (s && s.sessionId) answers[s.sessionId] = s; });
      var built = buildRecap(entries, answers);
      S.ui.newConvoRecap = built.text;
      S.ui.newConvoRecapMeta = { convos: convs.length, reports: built.reports };
      S.ui.newConvoRecapBusy = false;
      render();
    })['catch'](function (e) {
      if (token !== recapToken) return;
      S.ui.newConvoRecapBusy = false;
      S.ui.newConvoRecapMeta = { convos: convs.length, reports: 0 };
      S.ui.newConvoRecap = '';
      render();
      toast('Résumé des conversations précédentes indisponible : ' + e.message);
    });
  }

  /* Lot lancé depuis une tâche parente : chaque sous-tâche reçoit le travail de sa parente et le
     sien, pas celui de ses sœurs — elles tournent en même temps, et la revue d'un autre ticket
     userait le budget du contexte sans rien apprendre à l'agent. */
  function batchRecapEntries(sub) {
    return priorTasksOf(sub).filter(function (e) { return e.kind !== 'sibling'; });
  }

  /* Une seule lecture pour tout le lot. Rend { recaps: { id de sous-tâche → texte }, failed } :
     un échec n'empêche pas le lancement, les conversations partent sans « Travail déjà fait ». */
  function loadBatchRecaps(subs) {
    var plan = subs.map(function (sub) { return { sub: sub, entries: batchRecapEntries(sub) }; });
    var convs = [], seen = {};
    plan.forEach(function (p) {
      recapConvos(p.entries).forEach(function (c) { if (!seen[c.id]) { seen[c.id] = true; convs.push(c); } });
    });
    if (!convs.length) return Promise.resolve({ recaps: {}, failed: false });
    return bridge.call('getRecaps', {
      sessions: convs.map(function (c) { return { sessionId: c.id, cwd: c.cwd, provider: providerOf(c) }; })
    }, 60000).then(function (res) {
      var answers = {}, recaps = {};
      ((res && res.sessions) || []).forEach(function (s) { if (s && s.sessionId) answers[s.sessionId] = s; });
      plan.forEach(function (p) { if (p.entries.length) recaps[p.sub.id] = buildRecap(p.entries, answers).text; });
      return { recaps: recaps, failed: false };
    }, function () {
      return { recaps: {}, failed: true };
    });
  }

  function recapKindLabel(kind) {
    if (kind === 'parent') return 'Tâche parente';
    if (kind === 'sibling') return 'Sous-tâche précédente';
    if (kind === 'child') return 'Sous-tâche';
    return 'Cette tâche';
  }

  function recapStateWord(c) {
    var st = displayState(c);
    if (st === 'ready') return 'réponse rendue';
    if (st === 'working') return 'agent encore au travail';
    if (st === 'waiting') return 'question en attente';
    if (st === 'error') return 'en erreur';
    if (st === 'closed') return 'fenêtre fermée';
    return '';
  }

  /* Chemin complet d'un artefact : l'hôte le donne relatif au dossier de travail quand il est dessous. */
  function artifactFullPath(path, cwd) {
    var p = String(path || '');
    if (/^([a-zA-Z]:|\\\\|\/)/.test(p)) return p;
    return String(cwd || '').replace(/[\\\/]+$/, '') + '\\' + p.replace(/\//g, '\\');
  }

  function buildRecap(entries, answers) {
    var reports = 0;
    var blocks = entries.map(function (e) {
      var t = e.task;
      var status = t.done ? ' (terminée)' : (t.doing ? ' (en cours)' : '');
      var head = ['## ' + recapKindLabel(e.kind) + ' : ' + firstLine(t.text, 120).trim() + status];
      if (e.kind !== 'self') {
        var body = String(t.text || '').split('\n').slice(1).join('\n').trim();
        if (body) head.push(body);
      }
      return {
        head: head.join('\n'),
        convos: convosOf(t.id).slice().sort(byCreated).map(function (c) {
          var a = answers[c.id] || {};
          var files = artifactEntries([c], 'file').length;
          var docs = artifactEntries([c], 'report').filter(function (r) { return r.action !== 'deleted'; });
          reports += docs.length;
          var word = recapStateWord(c);
          var answer = String(a.answer || '').trim();
          if (answer.length > RECAP_ANSWER_MAX) answer = answer.slice(0, RECAP_ANSWER_MAX).replace(/\s+\S*$/, '') + ' […]';
          var tail = [];
          if (docs.length) {
            tail.push('Rapports produits (à lire sur le disque) :');
            docs.forEach(function (r) { tail.push('- ' + artifactFullPath(r.path, c.cwd)); });
          }
          if (files) tail.push((files > 1 ? files + ' autres fichiers modifiés' : '1 autre fichier modifié') + (c.cwd ? ' dans ' + c.cwd : ''));
          return {
            head: '### Conversation « ' + (c.title || 'Nouvelle session') + ' » — ' + agentTag(c) + ', ' + fmtDate(c.updated) + (word ? ', ' + word : ''),
            answer: answer,
            tail: tail.join('\n')
          };
        })
      };
    });
    return { text: fitRecap(blocks), reports: reports };
  }

  function recapText(blocks) {
    return blocks.map(function (b) {
      return [b.head].concat(b.convos.map(function (c) {
        return [c.head, c.answer ? 'Dernière réponse de l’agent :\n' + c.answer : 'Aucune réponse de l’agent n’a été enregistrée.', c.tail]
          .filter(Boolean).join('\n');
      })).join('\n\n');
    }).join('\n\n');
  }

  /* Trop long pour la ligne de commande : les réponses sont raccourcies de la plus ancienne à la
     plus récente, puis omises dans le même ordre, jusqu'à tenir. */
  function fitRecap(blocks) {
    var text = recapText(blocks);
    if (text.length <= RECAP_TOTAL_MAX) return text;
    var all = [];
    blocks.forEach(function (b) { b.convos.forEach(function (c) { all.push(c); }); });
    for (var i = 0; i < all.length && text.length > RECAP_TOTAL_MAX; i++) {
      if (all[i].answer.length > RECAP_SHORT) {
        all[i].answer = all[i].answer.slice(0, RECAP_SHORT).replace(/\s+\S*$/, '') + ' […]';
        text = recapText(blocks);
      }
    }
    for (var j = 0; j < all.length && text.length > RECAP_TOTAL_MAX; j++) {
      all[j].answer = '(réponse omise : trop longue pour le contexte)';
      text = recapText(blocks);
    }
    return text;
  }

  /* Un mot-clé peut lancer une équipe : l'agent principal délègue aussitôt, dans la même session,
     plutôt que de tout faire seul. Les agents qu'il ouvre se comptent dans le badge de la console. */
  function appendTeams(lines, chosen) {
    var withTeam = chosen.filter(function (kw) { return teamOf(kw).length; });
    if (!withTeam.length) return;
    lines.push('', 'Équipe à lancer : commence par ouvrir ces agents en parallèle — un appel d’outil de sous-agent '
      + 'par agent, tous dans le même message pour qu’ils travaillent en même temps. Attends leurs retours, puis fais '
      + 'la synthèse et poursuis. Si tu n’as pas d’outil de sous-agent, traite leurs missions toi-même, dans cet ordre.');
    if (withTeam.some(function (kw) { return hasTune(teamOf(kw)); })) {
      lines.push('Un agent suivi de « modèle … » s’ouvre avec ce modèle-là quand ton outil de sous-agent '
        + 'le permet ; « effort … » dit le soin attendu de lui — à défaut de réglage, redis-le-lui dans sa '
        + 'consigne. Sans précision, il travaille comme toi.');
    }
    withTeam.forEach(function (kw) {
      if (withTeam.length > 1) lines.push('Pour « ' + kw.name + ' » :');
      agentsByRole(teamOf(kw)).forEach(function (g) {
        g.agents.forEach(function (a) {
          lines.push('- ' + a.name + (g.role ? ' [' + g.role + ']' : '')
            + (tuneWords(a) ? ' (' + tuneWords(a) + ')' : '') + ' : '
            + (a.prompt ? a.prompt.replace(/\r?\n/g, ' ') : 'à toi de tirer sa mission de la tâche, dans son rôle.'));
        });
      });
    });
  }

  function defaultCwdFor(taskId) {
    var convs = convosOf(taskId);
    /* Carnet : jamais le dossier de travail ordinaire, seulement le dépôt (réglage, dernière session, détection). */
    if (taskId === FEEDBACK_ID) return S.settings.repoDir || (convs.length && convs[0].cwd) || S.env.repoDir || '';
    if (convs.length && convs[0].cwd) return convs[0].cwd;
    if (S.settings.defaultCwd) return S.settings.defaultCwd;
    return S.env.defaultCwd || '';
  }

  /* ── Agents et modèles ──────────────────────────────────────────────── */

  function providerById(id) {
    for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].id === id) return PROVIDERS[i];
    return PROVIDERS[0];
  }

  /* Les conversations antérieures à cette option n'ont pas de `provider` : Claude. */
  function providerOf(c) { return c && c.provider === 'copilot' ? 'copilot' : 'claude'; }

  function hasProvider(id) { return id === 'copilot' ? !!S.env.hasCopilot : S.env.hasClaude !== false; }

  function catalogFor(id) {
    var fromHost = S.env.models && S.env.models[id] && Array.isArray(S.env.models[id].groups) ? S.env.models[id] : null;
    return fromHost || FALLBACK_MODELS[id] || { defaultModel: '', defaultEffort: '', fetchedAt: 0, groups: [] };
  }

  function effortsFor(id) {
    var fromHost = S.env.efforts && Array.isArray(S.env.efforts[id]) ? S.env.efforts[id] : null;
    return (fromHost && fromHost.length ? fromHost : FALLBACK_EFFORTS[id]) || [];
  }

  function catalogHas(cat, id) {
    var groups = cat.groups || [];
    for (var g = 0; g < groups.length; g++) {
      var items = groups[g].items || [];
      for (var i = 0; i < items.length; i++) if (items[i].id === id) return true;
    }
    return false;
  }

  /* Modèles détectés par l'hôte : hors alias, « déjà utilisés » et « auto », qui ne viennent pas d'une détection. */
  function catalogCount(cat) {
    var n = 0;
    (cat.groups || []).forEach(function (g) {
      if (g.key === 'alias' || g.key === 'used' || g.key === 'auto') return;
      n += (g.items || []).length;
    });
    return n;
  }

  function catalogStale(id) {
    var at = toMs(catalogFor(id).fetchedAt);
    return !at || Date.now() - at > CATALOG_MAX_AGE;
  }

  /* Libellé d'un modèle : « Claude Sonnet 5 · 1× · prix moyen ». */
  function itemLabel(it) {
    var s = it.name || it.id;
    if (it.usage) s += ' · ' + String(it.usage).replace(/x$/i, '×');
    if (it.price) s += ' · ' + (PRICE_LABELS[it.price] || it.price);
    return s;
  }

  /* Réglages qui portent le modèle et l'effort par défaut d'un agent. */
  function modelSettingKey(id) { return id === 'copilot' ? 'copilotModel' : 'claudeModel'; }
  function effortSettingKey(id) { return id === 'copilot' ? 'copilotEffort' : 'claudeEffort'; }

  function setNewConvoProvider(id) {
    S.ui.newConvoProvider = id;
    S.ui.newConvoModel = String(S.settings[modelSettingKey(id)] || '');
    S.ui.newConvoEffort = String(S.settings[effortSettingKey(id)] || '');
    S.ui.newConvoCustom = false;
  }

  function agentTag(c) {
    var p = providerById(providerOf(c));
    return p.short + (c.model ? ' · ' + c.model : '') + (c.effort ? ' · ' + c.effort : '');
  }

  /* ── Rédaction assistée ─────────────────────────────────────────────────
     Un titre suffit : l'agent réglé dans les Réglages écrit le texte qui va dessous — le contenu
     d'une tâche, la consigne d'un mot-clé, la composition d'une équipe ou la mission d'un de ses
     agents — sans ouvrir de terminal (l'hôte appelle la CLI en mode
     non interactif). La proposition s'affiche d'abord : rien n'est écrit tant qu'on ne la garde
     pas. Une seule rédaction à la fois, celle que `S.ui.draft` porte. */
  var DRAFT_WAIT = 150000;

  var DRAFT_SYSTEM = 'Tu rédiges des textes courts pour Organizator, la file de tâches de l’utilisateur. '
    + 'Réponds en français, en texte brut : pas de préambule, pas de titre, pas de balises Markdown, '
    + 'pas de guillemets autour du texte, pas de question à l’utilisateur. '
    + 'N’utilise aucun outil : écris directement ce qu’on te demande, et rien d’autre.';

  /* Agent de rédaction des réglages, ou l'autre s'il est le seul installé. */
  function draftProviderId() {
    var wanted = S.settings.draftProvider === 'copilot' ? 'copilot' : 'claude';
    var other = wanted === 'copilot' ? 'claude' : 'copilot';
    return !hasProvider(wanted) && hasProvider(other) ? other : wanted;
  }

  function draftOf(key) { return S.ui.draft && S.ui.draft.key === key ? S.ui.draft : null; }

  function keywordDraftPrompt(typeLabel, name) {
    return 'Un mot-clé d’Organizator est une consigne réutilisable que l’utilisateur coche au lancement '
      + 'd’un agent, à la manière d’une skill.\n'
      + 'Mot-clé : « ' + name + ' »\n'
      + (typeLabel ? 'Catégorie des tâches concernées : ' + typeLabel + '\n' : '')
      + 'Rends exactement deux lignes, dans ce format :\n'
      + 'Description: <ce que ce mot-clé veut dire, douze mots au plus>\n'
      + 'Consigne: <deux à quatre phrases à l’impératif, ce que l’agent doit faire quand ce mot-clé est coché>';
  }

  function taskDraftPrompt(typeLabel, title) {
    return 'Voici le titre d’une tâche d’Organizator : « ' + title + ' »\n'
      + (typeLabel ? 'Catégorie : ' + typeLabel + '\n' : '')
      + 'Développe cette tâche en trois à six lignes courtes : ce qu’il y a à faire, les points d’attention, '
      + 'et ce qui permettra de la considérer terminée.\n'
      + 'Ne répète pas le titre, et n’invente pas de détail technique que le titre ne laisse pas deviner.';
  }

  /* Le vocabulaire dans lequel ✦ doit choisir : les rôles qui rangent l'équipe, et les modèles et
     efforts que l'agent de lancement connaît vraiment — inventer « gpt-4-turbo » ne servirait à rien. */
  function teamVocabPrompt() {
    var models = teamModels();
    var efforts = teamEfforts();
    return 'Rôle : ce que l’agent fait, de préférence parmi ' + AGENT_ROLES.join(', ')
      + ' — un autre mot si aucun ne dit son métier.\n'
      + 'Modèle : celui avec lequel l’ouvrir, parmi ' + (models.length ? models.join(', ') : 'ceux de l’outil')
      + ' — « — » pour garder celui de l’agent principal.\n'
      + 'Effort : le soin attendu, parmi ' + (efforts.length ? efforts.join(', ') : 'les niveaux de l’outil')
      + ' — « — » si rien de particulier.\n'
      + 'Règle les deux sur la mission et sur le rôle : un relevé, un repérage ou une mise en forme se '
      + 'contentent d’un modèle rapide et d’un effort bas ; une conception, une revue délicate ou une '
      + 'analyse qui engage la suite méritent le modèle le plus fort et un effort élevé. Ne mets pas '
      + 'tout le monde au maximum : une équipe qui coûte trop cher ne sera pas lancée.';
  }

  /* Composition d'une équipe : une ligne par agent, « Nom | rôle | modèle | effort | mission ». */
  function teamDraftPrompt(typeLabel, name, rule, agents) {
    var already = (agents || []).filter(function (a) { return a.name; })
      .map(function (a) { return a.name + (a.role ? ' (' + a.role + ')' : '') + (tuneTag(a) ? ' [' + tuneTag(a) + ']' : ''); }).join(', ');
    return 'Dans Organizator, un mot-clé peut lancer une équipe d’agents : l’agent principal ouvre aussitôt '
      + 'plusieurs sous-agents en parallèle, chacun avec sa mission, attend leurs retours et fait la synthèse.\n'
      + 'Mot-clé : « ' + name + ' »\n'
      + (typeLabel ? 'Catégorie des tâches concernées : ' + typeLabel + '\n' : '')
      + (rule ? 'Ce que ce mot-clé demande déjà : ' + rule + '\n' : '')
      + (already ? 'Équipe actuelle, à revoir : ' + already + '\n' : '')
      + 'Compose l’équipe : deux à quatre agents complémentaires, sans doublon, chacun utile seul.\n'
      + 'Rends une ligne par agent, rien d’autre, dans ce format :\n'
      + 'Nom | rôle | modèle | effort | mission en une ou deux phrases à l’impératif\n'
      + 'Le nom est un mot (ex. architecte).\n'
      + teamVocabPrompt();
  }

  function agentDraftPrompt(typeLabel, kwName, rule, agent) {
    return 'Dans Organizator, un mot-clé lance une équipe d’agents ouverts en parallèle sur une même tâche.\n'
      + 'Mot-clé : « ' + kwName + ' »\n'
      + (typeLabel ? 'Catégorie des tâches concernées : ' + typeLabel + '\n' : '')
      + (rule ? 'Ce que ce mot-clé demande : ' + rule + '\n' : '')
      + 'Agent : « ' + agent.name + ' »' + (agent.role ? ', rôle : ' + agent.role : '')
      + (tuneWords(agent) ? ' (' + tuneWords(agent) + ')' : '') + '\n'
      + 'Écris sa mission : deux à trois phrases à l’impératif, ce qu’il doit faire et ce qu’il doit rendre '
      + 'à l’agent principal. Reste dans son rôle, et ne parle pas des autres agents.'
      + (tuneWords(agent)
        ? '\nCale l’ampleur de la mission sur son niveau : un modèle rapide ou un effort bas veut une '
          + 'mission courte et cadrée ; un modèle fort ou un effort élevé peut porter une vraie analyse.'
        : '');
  }

  /* Lecture d'une équipe proposée. Le format demandé est « Nom | rôle | modèle | effort | mission »,
     mais les modèles écrivent aussi « Nom | rôle | mission », « Nom [rôle] — mission » ou
     « Nom : mission » : tout se relit. Les cases du milieu ne sont prises pour un modèle ou un effort
     que si on les y reconnaît — sinon la mission commence là, comme avant. */
  function parseTeamLine(raw) {
    var bar = raw.split('|');
    if (bar.length >= 3) {
      var rest = bar.slice(2);
      var tune = {};
      while (rest.length > 1) {
        var got = tuneCell(rest[0]);
        if (!got) break;
        if (got.model) tune.model = got.model;
        if (got.effort) tune.effort = got.effort;
        rest.shift();
      }
      return { name: bar[0], role: bar[1], model: tune.model || '', effort: tune.effort || '', prompt: rest.join('|') };
    }
    if (bar.length === 2) return { name: bar[0], role: '', prompt: bar[1] };
    var m = /^(.{1,60}?)\s*[\[(]([^\])]{1,32})[\])]\s*[—–:-]?\s*([\s\S]+)$/.exec(raw);
    if (m) return { name: m[1], role: m[2], prompt: m[3] };
    m = /^(.{1,60}?)\s+[—–]\s+([\s\S]+)$/.exec(raw);
    if (m) return { name: m[1], role: '', prompt: m[2] };
    m = /^([^:]{1,60}):\s+([\s\S]+)$/.exec(raw);
    if (m) return { name: m[1], role: '', prompt: m[2] };
    return null;
  }

  function parseTeamDraft(text) {
    var agents = [];
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (line) {
      var raw = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
      if (!raw) return;
      var got = parseTeamLine(raw);
      if (!got) return;
      var name = got.name.replace(/[«»"*]/g, '').trim();
      var prompt = got.prompt.trim();
      if (!name || !prompt) return;
      agents.push({ name: name, role: got.role.replace(/[«»"*]/g, '').trim(),
        model: got.model || '', effort: got.effort || '', prompt: prompt });
    });
    return normalizeAgents(agents);
  }

  /* Réponse d'un mot-clé : « Description: … » puis « Consigne: … ». Format non suivi : tout est
     pris pour la consigne, ce qui reste utilisable. */
  function splitKeywordDraft(text) {
    var desc = /^[ \t]*description[ \t]*:[ \t]*(.+)$/im.exec(text);
    var rule = /^[ \t]*consignes?[ \t]*:[ \t]*([\s\S]+)$/im.exec(text);
    if (!desc && !rule) return { desc: '', text: text };
    return {
      desc: desc ? desc[1].trim() : '',
      text: rule ? rule[1].trim() : text.replace(desc[0], '').trim()
    };
  }

  /* Remplace ce qui suit la première ligne : le titre reste celui que l'utilisateur a écrit. */
  function withBody(current, body) {
    var title = firstLine(current, 200).trim();
    return title ? title + '\n\n' + body : body;
  }

  /* Ce qu'on envoie vraiment : la demande de départ, puis les versions déjà proposées et ce que
     l'utilisateur en a dit. C'est ce qui fait de la rédaction une discussion plutôt qu'un tirage. */
  function draftPrompt(d) {
    if (!d.turns.length) return d.prompt;
    var parts = [d.prompt, ''];
    d.turns.forEach(function (turn, i) {
      parts.push('Version ' + (i + 1) + ', que tu as proposée :');
      parts.push(turn.text);
      parts.push(turn.note
        ? 'Ce que l’utilisateur en dit : ' + turn.note
        : 'L’utilisateur n’en veut pas et redemande autre chose.');
      parts.push('');
    });
    parts.push('Propose une nouvelle version qui en tient compte. Rends uniquement le texte, dans le même format que précédemment.');
    return parts.join('\n');
  }

  function runDraft(key, kind, target, prompt, turns) {
    if (!prompt) { toast('Écrivez d’abord un titre.'); return; }
    var provider = draftProviderId();
    if (!hasProvider(provider)) { toast(providerById(provider).missing); return; }
    var d = {
      key: key, kind: kind, target: target, prompt: prompt, turns: turns || [],
      busy: true, text: '', desc: '', team: null, note: '', error: '', ms: 0
    };
    S.ui.draft = d;
    render();
    bridge.call('draftText', {
      provider: provider, model: String(S.settings.draftModel || ''), effort: String(S.settings.draftEffort || ''),
      system: DRAFT_SYSTEM, prompt: draftPrompt(d)
    }, DRAFT_WAIT).then(function (r) {
      var d = draftOf(key);
      if (!d) return;  /* annulé entre-temps */
      var text = String((r && r.text) || '').trim();
      var parts = kind === 'keyword' || kind === 'new-keyword' ? splitKeywordDraft(text) : { desc: '', text: text };
      d.busy = false;
      d.text = parts.text;
      d.desc = parts.desc;
      d.team = kind === 'team' || kind === 'new-team' ? parseTeamDraft(text) : null;
      d.ms = (r && r.ms) || 0;
      if (!d.text) d.error = 'L’agent n’a rien proposé.';
      else if (d.team && !d.team.length) d.error = 'L’agent n’a pas rendu d’équipe lisible. Réessayez.';
      render();
    })['catch'](function (e) {
      var d = draftOf(key);
      if (!d) return;
      d.busy = false;
      d.error = e.message;
      render();
    });
  }

  /* Relance : la version affichée rejoint l'historique, avec le retour qu'on vient d'écrire s'il
     y en a un. L'agent sait donc ce qu'il a déjà proposé et ce qu'on lui en a dit. */
  function retryDraft() {
    var d = S.ui.draft;
    if (!d || d.busy) return;
    var turns = d.turns.slice();
    if (d.text) turns.push({ text: d.text, note: String(d.note || '').trim() });
    runDraft(d.key, d.kind, d.target, d.prompt, turns);
  }

  function replyDraft() {
    var d = S.ui.draft;
    if (!d || d.busy || !String(d.note || '').trim()) return;
    retryDraft();
  }

  function keepDraft() {
    var d = S.ui.draft;
    if (!d || d.busy || !d.text) return;
    var target = d.target || {};
    S.ui.draft = null;

    if (d.kind === 'keyword') {
      setKeywordField(target.typeId, target.keywordId, 'prompt', d.text);
      if (d.desc) setKeywordField(target.typeId, target.keywordId, 'desc', d.desc);
      commit();
      return;
    }
    if (d.kind === 'new-keyword') {
      S.ui.newKeywordPrompt = d.text;
      render();
      return;
    }
    if (d.kind === 'team') {
      setKeywordAgents(target.typeId, target.keywordId, d.team);
      commit();
      return;
    }
    if (d.kind === 'new-team') {
      S.ui.newKeywordTeam = true;
      S.ui.newKeywordAgents = normalizeAgents(d.team);
      render();
      return;
    }
    if (d.kind === 'agent') {
      setAgentField(target.typeId, target.keywordId, target.agentId, 'prompt', d.text);
      commit();
      return;
    }
    if (d.kind === 'task') {
      var task = taskById(target.taskId);
      if (task) task.text = withBody(task.text, d.text);
      commit();
      return;
    }
    S.ui.composerText = withBody(S.ui.composerText, d.text);
    render();
  }

  /* Encadré de proposition, sous le champ concerné. `dark` : panneau de l'agent (fond sombre). */
  function draftBoxHtml(key, dark) {
    var d = draftOf(key);
    if (!d) return '';
    var box = 'draft-box' + (dark ? ' draft-dark' : '');
    var btn = dark ? 'dark-btn' : 'btn btn-ghost';
    var main = dark ? 'dark-btn dark-btn-primary' : 'btn btn-primary';

    var history = d.turns.length
      ? '<div class="draft-history">' + d.turns.map(function (turn, i) {
        return '<div class="draft-turn"><span class="draft-turn-n">v' + (i + 1) + '</span>'
          + '<span class="draft-turn-text" title="' + esc(turn.text) + '">' + esc(firstLine(turn.text, 70)) + '</span>'
          + (turn.note ? '<span class="draft-turn-note">vous : ' + esc(turn.note) + '</span>' : '')
          + '</div>';
      }).join('') + '</div>'
      : '';

    if (d.busy) {
      return '<div class="' + box + '">' + history + '<div class="draft-wait"><span class="draft-spin"></span>'
        + esc(providerById(draftProviderId()).short) + (d.turns.length ? ' reprend…' : ' rédige…') + '</div></div>';
    }
    if (d.error) {
      return '<div class="' + box + ' draft-failed">' + history + '<div class="draft-text">' + esc(d.error) + '</div>'
        + '<div class="draft-actions"><span class="draft-meta"></span>'
        + '<button type="button" class="' + btn + '" data-act="draft-cancel">Fermer</button>'
        + '<button type="button" class="' + main + '" data-act="draft-retry">Réessayer</button></div></div>';
    }

    var version = d.turns.length ? 'version ' + (d.turns.length + 1) + ' · ' : '';
    var body = d.team && d.team.length
      ? '<div class="draft-team">' + d.team.map(function (a) {
        return '<div class="draft-team-row"><b>' + esc(a.name) + '</b>'
          + (a.role ? '<span class="agent-role-tag">' + esc(a.role) + '</span>' : '')
          + (tuneTag(a) ? '<span class="agent-tune-tag">' + esc(tuneTag(a)) + '</span>' : '')
          + '<span class="draft-team-mission">' + esc(a.prompt) + '</span></div>';
      }).join('') + '</div>'
      : '<div class="draft-text">' + esc(d.text) + '</div>';
    return '<div class="' + box + '">'
      + history
      + (d.desc ? '<div class="draft-desc">' + esc(d.desc) + '</div>' : '')
      + body
      + '<div class="draft-reply">'
      + '<textarea class="' + (dark ? 'dark-input' : 'input') + ' draft-note" rows="2" data-role="draft-note" '
      + 'data-focus-key="draft-note" placeholder="Ce qu’il faudrait changer… (Entrée pour renvoyer)">' + esc(d.note || '') + '</textarea>'
      + '<button type="button" class="' + btn + ' draft-send" data-act="draft-reply"'
      + (String(d.note || '').trim() ? '' : ' disabled') + '>Renvoyer</button>'
      + '</div>'
      + '<div class="draft-actions"><span class="draft-meta">'
      + esc(version + providerById(draftProviderId()).short + (d.ms ? ' · ' + Math.round(d.ms / 1000) + ' s' : '')) + '</span>'
      + '<button type="button" class="' + btn + '" data-act="draft-cancel">Annuler</button>'
      + '<button type="button" class="' + btn + '" data-act="draft-retry">Autre version</button>'
      + '<button type="button" class="' + main + '" data-act="draft-keep">Garder</button>'
      + '</div></div>';
  }

  /* Bouton d'appel, posé contre le champ qu'il remplit. */
  function draftBtnHtml(act, attrs, dark, label) {
    var busy = (S.ui.draft && S.ui.draft.busy) || chatBusy();
    return '<button type="button" class="draft-btn' + (dark ? ' draft-btn-dark' : '') + '" data-act="' + esc(act) + '"'
      + attrs + (busy ? ' disabled' : '') + ' title="Faire rédiger ce texte par l’agent de rédaction">'
      + '<span class="draft-star">✦</span>' + esc(label) + '</button>';
  }

  /* ── Atelier d'un mot-clé ───────────────────────────────────────────────
     Une discussion pour régler un mot-clé d'un bloc — son nom, ce qu'il veut dire, sa consigne et son
     équipe — plutôt qu'un champ après l'autre. L'agent reçoit les mots-clés déjà en place dans la
     catégorie (pour s'en inspirer sans les redoubler) et la fiche en cours ; il répond soit par une
     question, soit par la fiche entière. La CLI étant appelée sans mémoire, tout l'échange repart à
     chaque tour. Rien n'est enregistré tant qu'on n'a pas gardé, et rien de l'échange n'est conservé :
     rouvrir l'atelier plus tard repart de la fiche telle qu'elle est alors. */
  var CHAT_TURNS = 12;      /* échanges renvoyés à chaque tour */
  var CHAT_CATALOG = 12;    /* mots-clés voisins montrés à l'agent */
  var CHAT_QUESTIONS = 3;   /* questions posées en une fois, au plus */
  var CHAT_RUN = 2;         /* tours de questions d'affilée avant de devoir proposer */

  var CHAT_SYSTEM = 'Tu règles avec l’utilisateur un mot-clé d’Organizator, sa file de tâches. Un mot-clé est une '
    + 'consigne réutilisable, cochée au lancement d’un agent, à la manière d’une skill ; il peut aussi lancer une '
    + 'équipe de sous-agents que l’agent principal ouvre en parallèle. '
    + 'Réponds en français, en texte brut : pas de préambule, pas de titre, pas de balises Markdown, pas de '
    + 'guillemets autour du texte. N’utilise aucun outil. Tu réponds soit par des questions (trois au plus), '
    + 'soit par la fiche entière — jamais les deux, et rien d’autre.';

  function chatBusy() { return !!(S.ui.chat && S.ui.chat.busy); }

  /* La fiche d'un mot-clé : ce qui se discute, et ce que « Garder » écrira. */
  function keywordCard(kw) {
    return {
      name: String((kw && kw.name) || '').trim(),
      desc: String((kw && kw.desc) || '').trim(),
      prompt: String((kw && kw.prompt) || '').trim(),
      team: !!(kw && kw.team),
      agents: normalizeAgents(kw && kw.agents)
    };
  }

  function cardAgents(card) {
    return (card && Array.isArray(card.agents) ? card.agents : []).filter(function (a) { return a && a.name; });
  }

  /* La fiche telle qu'on la montre à l'agent — et telle qu'on lui demande de la rendre. */
  function cardText(card) {
    var agents = cardAgents(card);
    var lines = ['Nom: ' + (card.name || '(à trouver)'),
      'Description: ' + (card.desc || '(vide)'),
      'Consigne: ' + (card.prompt ? card.prompt.replace(/\r?\n/g, ' ') : '(vide)'),
      'Équipe: ' + (card.team && agents.length ? 'oui' : 'non')];
    agents.forEach(function (a) {
      lines.push('- ' + a.name + ' | ' + (a.role || '') + ' | ' + (a.model || '—') + ' | ' + (a.effort || '—')
        + ' | ' + String(a.prompt || '').replace(/\r?\n/g, ' '));
    });
    return lines.join('\n');
  }

  /* Ce qui existe déjà dans la catégorie : l'agent s'en inspire, garde le même ton, et ne redouble pas. */
  function catalogText(ty, exceptId) {
    if (ty === NOTYPE) return '';
    var others = normalizeKeywords(ty.keywords).filter(function (kw) { return kw.id !== exceptId && kw.name; });
    if (!others.length) return '';
    var lines = ['Mots-clés déjà en place dans la catégorie « ' + ty.label + ' » — inspire-t’en, ne les redouble pas :'];
    others.slice(0, CHAT_CATALOG).forEach(function (kw) {
      lines.push('- ' + kw.name + (kw.desc ? ' — ' + kw.desc : ''));
      if (kw.prompt) lines.push('  consigne : ' + firstLine(kw.prompt, 200));
      var crew = teamOf(kw);
      if (crew.length) {
        lines.push('  équipe : ' + crew.map(function (a) {
          return a.name + (a.role ? ' [' + a.role + ']' : '') + (tuneTag(a) ? ' (' + tuneTag(a) + ')' : '');
        }).join(', '));
      }
    });
    return lines.join('\n');
  }

  /* Tours de questions posés d'affilée sans rien proposer entre-temps. L'atelier doit pouvoir
     interroger — c'est ainsi qu'on règle un mot-clé qu'on ne sait pas encore décrire — sans tourner
     en rond : passé CHAT_RUN, le prompt lui rappelle qu'il a déjà demandé et lui réclame la fiche,
     à moins que l'utilisateur ne vienne d'en redemander. */
  function questionRun(c) {
    var run = 0;
    for (var i = c.turns.length - 1; i >= 0; i--) {
      if (c.turns[i].who !== 'agent') continue;
      if (c.turns[i].kind !== 'question') break;
      run++;
    }
    return run;
  }

  function chatPrompt(c) {
    var ty = typeOf(c.typeId);
    var parts = [];
    var catalog = catalogText(ty, c.keywordId);
    if (catalog) parts.push(catalog, '');
    parts.push('Le mot-clé en cours de réglage' + (ty === NOTYPE ? '' : ' (catégorie ' + ty.label + ')') + ' :', cardText(c.card), '');
    if (c.turns.length) {
      parts.push('La discussion jusqu’ici :');
      c.turns.slice(-CHAT_TURNS).forEach(function (t) {
        parts.push(t.who === 'agent'
          ? 'Toi : ' + (t.kind === 'card' ? '(fiche proposée)\n' + cardText(t.card) : t.text)
          : 'L’utilisateur : ' + t.text);
      });
      parts.push('');
    }
    var run = questionRun(c);
    if (run >= CHAT_RUN) {
      parts.push('Tu viens de poser des questions ' + run + ' fois de suite : propose maintenant la fiche, '
        + 'l’utilisateur la corrigera. N’en repose que si son dernier message t’en réclame — dans ce cas, '
        + 'une ligne « Question: … » par question, ' + CHAT_QUESTIONS + ' au plus, et rien d’autre.',
        'Sinon, rends la fiche entière, rien d’autre, dans ce format :');
    } else if (!chatHasCard(c)) {
      parts.push('Tu peux commencer par interroger l’utilisateur : demande d’un coup ce qui te manque vraiment '
        + 'pour écrire quelque chose d’utile — une à ' + CHAT_QUESTIONS + ' questions courtes, une par ligne :',
        'Question: <ta question>',
        (c.card.prompt
          ? 'Si tu en sais assez, rends plutôt la fiche entière, rien d’autre, dans ce format :'
          : 'Ce mot-clé est presque vide : mieux vaut demander que deviner. Si tu en sais vraiment assez, '
            + 'rends la fiche entière, rien d’autre, dans ce format :'));
    } else {
      parts.push('Rends la fiche entière, revue d’après ce que l’utilisateur vient de dire, rien d’autre. '
        + 'Pose plutôt des questions — une ligne « Question: … » chacune, ' + CHAT_QUESTIONS + ' au plus — s’il '
        + 'en demande, ou s’il te manque quelque chose qu’aucune supposition raisonnable ne remplace. '
        + 'Format de la fiche :');
    }
    parts.push('Nom: <un mot, le nom du mot-clé>',
      'Description: <à quoi il sert, douze mots au plus>',
      'Consigne: <deux à quatre phrases à l’impératif, ce que l’agent doit faire quand ce mot-clé est coché>',
      'Équipe: oui (ou non, si le travail ne gagne rien à être découpé)',
      '- <agent> | <rôle> | <modèle> | <effort> | <sa mission, une ou deux phrases à l’impératif>',
      '(une ligne par agent, deux à quatre agents, seulement si Équipe: oui)',
      teamVocabPrompt());
    return parts.join('\n');
  }

  /* Réponse de l'agent : la fiche entière, ou des questions. Ce qui n'est ni l'un ni l'autre est
     traité comme une question — mieux vaut afficher ce qu'il a dit que de le perdre. */
  function parseChatReply(text) {
    var body = String(text == null ? '' : text).trim();
    if (!body) return null;
    var card = parseCard(body);
    if (card) return { kind: 'card', card: card };
    return { kind: 'question', items: parseQuestions(body) };
  }

  /* Une ligne « Question: … » par question. À défaut d'étiquette, une liste dont plusieurs lignes
     s'achèvent sur un « ? » en est une aussi ; sinon tout le texte fait une seule question. */
  function parseQuestions(body) {
    var out = [];
    body.split(/\r?\n/).forEach(function (line) {
      var m = /^[ \t]*(?:[-*•]|\d+[.)])?[ \t]*\**[ \t]*questions?[ \t]*\**[ \t]*:[ \t]*(.+)$/i.exec(line);
      if (m && m[1].trim()) out.push(m[1].trim().slice(0, 400));
    });
    if (!out.length) {
      var lines = body.split(/\r?\n/)
        .map(function (l) { return l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim(); })
        .filter(function (l) { return l; });
      var asked = lines.filter(function (l) { return l.indexOf('?') >= 0; });
      if (lines.length > 1 && asked.length > 1) out = asked.map(function (l) { return l.slice(0, 400); });
    }
    return out.length ? out.slice(0, CHAT_QUESTIONS) : [body.slice(0, 2000)];
  }

  var CARD_KEYS = {
    'nom': 'nom', 'description': 'description', 'consigne': 'consigne', 'consignes': 'consigne',
    'equipe': 'equipe', 'équipe': 'equipe', 'equipes': 'equipe', 'équipes': 'equipe'
  };

  function parseCard(body) {
    var got = { nom: '', description: '', consigne: '', equipe: '' };
    var field = null;
    body.split(/\r?\n/).forEach(function (line) {
      var m = /^[ \t]*\**[ \t]*([A-Za-zÀ-ÿ]+)[ \t]*\**[ \t]*:[ \t]*([\s\S]*)$/.exec(line);
      var key = m ? CARD_KEYS[lower(m[1])] : null;
      if (key) { field = key; got[key] = m[2].trim(); return; }
      if (field) got[field] += (got[field] ? '\n' : '') + line;
    });
    if (!got.consigne.trim()) return null;

    var wants = /^(oui|yes|true|1)\b/i.test(got.equipe.trim());
    var agents = wants ? parseTeamDraft(got.equipe) : [];
    /* Repli : une équipe listée sans être annoncée. Les lignes « nom | rôle | mission » tombées dans
       la consigne en sont : on les en retire plutôt que de les y laisser. */
    if (!agents.length) {
      var lines = got.consigne.split(/\r?\n/);
      var stray = lines.filter(function (l) { return l.split('|').length >= 3; });
      if (stray.length) {
        agents = parseTeamDraft(stray.join('\n'));
        if (agents.length) {
          wants = true;
          got.consigne = lines.filter(function (l) { return l.split('|').length < 3; }).join('\n').trim();
        }
      }
    }
    return {
      name: got.nom.replace(/[«»"*]/g, '').replace(/\n[\s\S]*$/, '').trim().slice(0, 80),
      desc: got.description.replace(/\n[\s\S]*$/, '').trim().slice(0, 160),
      prompt: got.consigne.trim().slice(0, 4000),
      team: wants && agents.length > 0,
      agents: agents
    };
  }

  /* Une fiche qui ne redit pas tout garde ce qu'elle ne touche pas. */
  function mergeCard(base, next) {
    return {
      name: next.name || base.name,
      desc: next.desc || base.desc,
      prompt: next.prompt || base.prompt,
      team: !!next.team,
      agents: next.agents.length ? next.agents : base.agents
    };
  }

  function chatHasCard(c) {
    return !!c && c.turns.some(function (t) { return t.who === 'agent' && t.kind === 'card'; });
  }

  /* launch : mot-clé en cours de création depuis le formulaire de lancement (rien encore enregistré). */
  function openKeywordChat(typeId, keywordId, launch) {
    if (chatBusy() || (S.ui.draft && S.ui.draft.busy)) return;
    var provider = draftProviderId();
    if (!hasProvider(provider)) { toast(providerById(provider).missing); return; }
    var kw = launch
      ? { name: parseKeywordNames(S.ui.newKeywordName)[0] || '', desc: '', prompt: S.ui.newKeywordPrompt,
        team: S.ui.newKeywordTeam, agents: S.ui.newKeywordAgents }
      : keywordOf(typeId, keywordId);
    if (!kw) return;
    if (!kw.name) { toast('Donnez d’abord un nom au mot-clé.'); return; }
    S.ui.draft = null;
    S.ui.chat = { typeId: typeId, keywordId: keywordId || '', launch: !!launch, card: keywordCard(kw),
      turns: [], note: '', busy: false, error: '', ms: 0 };
    sendChat();
  }

  /* Un tour : toute la discussion repart, puisque la CLI n'en garde rien. */
  function sendChat() {
    var c = S.ui.chat;
    if (!c || c.busy) return;
    c.busy = true;
    c.error = '';
    render();
    var provider = draftProviderId();
    bridge.call('draftText', {
      provider: provider, model: String(S.settings.draftModel || ''), effort: String(S.settings.draftEffort || ''),
      system: CHAT_SYSTEM, prompt: chatPrompt(c)
    }, DRAFT_WAIT).then(function (r) {
      var c = S.ui.chat;
      if (!c) return;  /* refermé entre-temps */
      c.busy = false;
      c.ms = (r && r.ms) || 0;
      var reply = parseChatReply((r && r.text) || '');
      if (!reply) { c.error = 'L’agent n’a rien répondu.'; render(); return; }
      c.turns.push(reply.kind === 'card'
        ? { who: 'agent', kind: 'card', card: reply.card }
        : { who: 'agent', kind: 'question', items: reply.items, text: reply.items.join('\n') });
      if (reply.kind === 'card') c.card = mergeCard(c.card, reply.card);
      render();
    })['catch'](function (e) {
      var c = S.ui.chat;
      if (!c) return;
      c.busy = false;
      c.error = e.message;
      render();
    });
  }

  function replyChat() {
    var c = S.ui.chat;
    if (!c || c.busy) return;
    var note = String(c.note || '').trim();
    if (!note) return;
    c.turns.push({ who: 'vous', text: note.slice(0, 2000) });
    c.note = '';
    sendChat();
  }

  /* L'atelier ne sert à rien s'il ne peut pas demander. Ce bouton le réclame dans la discussion
     elle-même — c'est elle que l'agent relit à chaque tour —, avec ce qui était déjà tapé s'il y a. */
  function askChat() {
    var c = S.ui.chat;
    if (!c || c.busy) return;
    var note = String(c.note || '').trim();
    c.turns.push({ who: 'vous', text: (note ? note + ' — ' : '')
      + 'Pose-moi les questions qu’il te faut pour bien régler ce mot-clé — ne propose rien avant.' });
    c.note = '';
    sendChat();
  }

  function keepChat() {
    var c = S.ui.chat;
    if (!c || c.busy || !chatHasCard(c)) return;
    var card = c.card;
    if (c.launch) {
      S.ui.newKeywordName = card.name;
      S.ui.newKeywordPrompt = card.prompt;
      S.ui.newKeywordTeam = !!card.team;
      S.ui.newKeywordAgents = normalizeAgents(card.agents);
      S.ui.chat = null;
      render();
      toast('Fiche reprise dans le formulaire — « Ajouter » pour créer le mot-clé.');
      return;
    }
    var kw = keywordOf(c.typeId, c.keywordId);
    S.ui.chat = null;
    if (!kw) { render(); return; }
    /* Un nom déjà porté par un autre mot-clé de la catégorie disparaîtrait à la normalisation
       (doublon) : dans ce cas on garde celui d'origine. */
    var taken = normalizeKeywords(typeOf(c.typeId).keywords)
      .filter(function (k) { return k.id !== kw.id; }).map(function (k) { return lower(k.name); });
    if (card.name && taken.indexOf(lower(card.name)) < 0) kw.name = card.name;
    else if (card.name && lower(card.name) !== lower(kw.name)) toast('« ' + card.name + ' » est déjà pris : le nom n’a pas changé.');
    kw.desc = card.desc;
    kw.prompt = card.prompt;
    kw.team = !!card.team;
    kw.agents = normalizeAgents(card.agents);
    S.ui.catKeywordEdit = kw.id;
    commit();
  }

  /* Le fil : questions de l'agent, vos réponses, et les fiches — la dernière en entier, les
     précédentes en une ligne, pour garder le fil lisible. */
  function chatFilHtml(c) {
    var last = -1;
    c.turns.forEach(function (t, i) { if (t.who === 'agent' && t.kind === 'card') last = i; });
    var version = 0;
    return c.turns.map(function (t, i) {
      if (t.who === 'vous') return '<div class="chat-turn chat-you"><div class="chat-bubble">' + esc(t.text) + '</div></div>';
      if (t.kind === 'question') {
        var qs = t.items && t.items.length ? t.items : [t.text];
        return '<div class="chat-turn chat-them"><span class="chat-who">' + esc(providerById(draftProviderId()).short)
          + '</span><div class="chat-bubble">' + (qs.length > 1
            ? '<ul class="chat-qs">' + qs.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>'
            : esc(qs[0])) + '</div></div>';
      }
      version++;
      if (i !== last) {
        var crew = cardAgents(t.card).length;
        return '<div class="chat-card chat-card-old">fiche v' + esc(version) + ' · ' + esc(t.card.name || '…')
          + (crew ? ' — ' + esc(crew) + (crew > 1 ? ' agents' : ' agent') : '') + '</div>';
      }
      return chatCardHtml(t.card, version);
    }).join('');
  }

  function chatCardHtml(card, version) {
    var agents = cardAgents(card);
    var h = ['<div class="chat-card"><div class="chat-card-head">Fiche proposée<span class="chat-card-n">v' + esc(version) + '</span></div>'];
    h.push('<div class="chat-card-row"><span>Nom</span><b>' + esc(card.name || '—') + '</b></div>');
    h.push('<div class="chat-card-row"><span>Description</span><div>' + esc(card.desc || '—') + '</div></div>');
    h.push('<div class="chat-card-row"><span>Consigne</span><div class="chat-card-text">' + esc(card.prompt || '—') + '</div></div>');
    h.push('<div class="chat-card-row"><span>Équipe</span><div>' + (card.team && agents.length
      ? agents.map(function (a) {
        return '<div class="chat-card-agent"><b>' + esc(a.name) + '</b>'
          + (a.role ? '<span class="agent-role-tag">' + esc(a.role) + '</span>' : '')
          + (tuneTag(a) ? '<span class="agent-tune-tag">' + esc(tuneTag(a)) + '</span>' : '')
          + '<span class="draft-team-mission">' + esc(a.prompt) + '</span></div>';
      }).join('')
      : '<span class="chat-card-none">aucune</span>') + '</div></div>');
    return h.join('') + '</div>';
  }

  function chatHtml(enter) {
    var c = S.ui.chat;
    if (!c) return '';
    var ty = typeOf(c.typeId);
    var agent = providerById(draftProviderId()).short;
    var h = ['<div class="dialog-backdrop">'];
    h.push('<div class="dialog dialog-wide' + (enter ? ' enter' : '') + '" data-act="noop" role="dialog" aria-label="Atelier du mot-clé">');
    h.push('<div class="dialog-title">Atelier — mot-clé « ' + esc(c.card.name || '…') + ' »'
      + (ty === NOTYPE ? '' : '<span class="chat-cat">' + esc(ty.label) + '</span>') + '</div>');
    h.push('<div class="dialog-lead">' + esc(agent) + ' connaît les mots-clés déjà en place dans la catégorie. '
      + 'Il vous interroge tant qu’il lui manque quelque chose — « Questionne-moi » le lui réclame à tout moment —, '
      + 'et propose la fiche entière — nom, description, consigne et équipe — quand il en sait assez. '
      + 'Rien n’est écrit tant que vous n’avez pas gardé.</div>');

    h.push('<div class="chat-fil" data-role="chat-fil">' + chatFilHtml(c));
    if (c.busy) {
      h.push('<div class="chat-turn chat-them"><span class="chat-who">' + esc(agent) + '</span>'
        + '<div class="chat-bubble chat-wait"><span class="draft-spin"></span>'
        + (c.turns.length ? 'reprend…' : 'lit ce qui existe…') + '</div></div>');
    }
    if (c.error) h.push('<div class="chat-error">' + esc(c.error) + '</div>');
    h.push('</div>');

    h.push('<div class="chat-reply">'
      + '<textarea class="input chat-note" rows="2" data-role="chat-note" data-focus-key="chat-note" '
      + (c.busy ? 'disabled ' : '') + 'placeholder="Votre réponse… (Entrée pour envoyer, Maj + Entrée pour une nouvelle ligne)">'
      + esc(c.note || '') + '</textarea>'
      + '<button type="button" class="btn btn-ghost chat-ask" data-act="chat-ask"' + (c.busy ? ' disabled' : '')
      + ' title="Demande à l’agent de te questionner avant de proposer quoi que ce soit">Questionne-moi</button>'
      + '<button type="button" class="btn btn-secondary chat-send" data-act="chat-send"'
      + (c.busy || !String(c.note || '').trim() ? ' disabled' : '') + '>Envoyer</button>'
      + '</div>');

    h.push('<div class="dialog-actions">'
      + '<span class="chat-meta">' + esc(c.ms ? agent + ' · ' + Math.round(c.ms / 1000) + ' s' : '') + '</span>'
      + (c.error ? '<button type="button" class="btn btn-secondary" data-act="chat-retry">Réessayer</button>' : '')
      + '<button type="button" class="btn btn-ghost" data-act="chat-close">Fermer</button>'
      + '<button type="button" class="btn btn-primary" data-act="chat-keep"'
      + (c.busy || !chatHasCard(c) ? ' disabled' : '') + '>' + (c.launch ? 'Reprendre la fiche' : 'Garder la fiche') + '</button>'
      + '</div>');

    return h.join('') + '</div></div>';
  }

  /* ── État des sessions ──────────────────────────────────────────────────
     L'hôte lit l'état dans le transcript (working, waiting, ready, error, idle) et dit si le
     processus de l'agent vit encore. Fenêtre fermée : « closed », quoi qu'en dise le transcript.
     Session ouverte sans premier message : « open ». */
  var STATE_LABELS = {
    working: 'En cours', waiting: 'Attend votre réponse', ready: 'Réponse prête',
    error: 'Erreur', closed: 'Fermée', open: 'Ouverte', idle: 'Inactive'
  };
  var TASK_STATE_LABELS = { working: 'Agent en cours', waiting: 'Question de l’agent', ready: 'Réponse prête', error: 'Erreur de l’agent' };
  /* Une question posée passe devant le travail en cours : c'est elle qui réclame une réponse,
     et c'est donc elle que l'icône du terminal annonce quand la tâche a plusieurs sessions. */
  var STATE_RANK = { waiting: 5, working: 4, error: 2, ready: 1 };
  var DETAIL_LABELS = { fermee: 'fermée', 'question posee': 'question posée', 'autorisation demandee': 'autorisation demandée' };

  function activityOf(c) { return (c && S.ui.activity[c.id]) || null; }
  function detailLabel(d) { return DETAIL_LABELS[d] || d || ''; }

  /* Agents lancés par la conversation et pas encore revenus (équipe d'agents, tâche de fond).
     Fenêtre fermée : l'équipe est partie avec elle. */
  function agentsOf(c) {
    var a = activityOf(c);
    if (!a || a.alive === false || !Array.isArray(a.agents)) return [];
    return a.agents;
  }

  /* Ce qui travaille en ce moment pour cette conversation : l'agent du terminal s'il traite un
     prompt, plus les agents qu'il a lancés. C'est le nombre porté par l'icône du terminal. */
  function workerCount(c) {
    var a = activityOf(c);
    if (!a || a.alive === false) return 0;
    return (a.state === 'working' ? 1 : 0) + agentsOf(c).length;
  }

  function crewCount(convs) {
    return convs.reduce(function (n, c) { return n + workerCount(c); }, 0);
  }

  function agentsLabel(c) {
    var n = agentsOf(c).length;
    return n ? n + (n > 1 ? ' agents au travail' : ' agent au travail') : '';
  }

  /* État affiché d'une conversation, ou null tant qu'on ne sait rien. */
  function displayState(c) {
    var a = activityOf(c);
    if (!a) return null;
    if (a.alive === false) return a.exists ? 'closed' : null;
    if (!a.exists) return a.alive ? 'open' : null;
    /* L'agent du terminal a beau avoir rendu la main, l'équipe qu'il a lancée travaille encore :
       annoncer « réponse prête » à ce moment-là serait faux. */
    if ((a.state === 'ready' || a.state === 'idle') && agentsOf(c).length) return 'working';
    return a.state || 'idle';
  }

  function stateText(c) {
    var st = displayState(c);
    if (!st) return '';
    var a = activityOf(c);
    var when = fmtTime(a.stateTs);
    var detail = detailLabel(a.detail);
    var crew = agentsLabel(c);
    if (st === 'working') return STATE_LABELS[st] + (when ? ' depuis ' + when : '') + (crew ? ' · ' + crew : '');
    if (st === 'waiting') return STATE_LABELS[st] + (when ? ' depuis ' + when : '');
    if (st === 'ready') return STATE_LABELS[st] + (when ? ' à ' + when : '');
    if (st === 'error') return STATE_LABELS[st] + (when ? ' à ' + when : '') + (detail ? ' · ' + detail : '');
    if (st === 'idle') return detail ? STATE_LABELS[st] + ' · ' + detail : '';
    return STATE_LABELS[st];
  }

  /* Ce que l'agent vient de dire : sa réponse, ou la question qu'il pose. C'est ce qui manquait
     pour savoir où en est une conversation sans ouvrir son journal ni sa fenêtre. */
  function saidOf(c) {
    var a = activityOf(c);
    return a && a.said ? String(a.said) : '';
  }

  function saidHtml(c) {
    var said = saidOf(c);
    var st = displayState(c);
    if (!said || !st) return '';
    return '<div class="convo-said st-' + esc(st) + '" title="' + esc(said) + '">' + esc(said) + '</div>';
  }

  function stateHtml(c) {
    var text = stateText(c);
    if (!text) return '';
    var a = activityOf(c);
    var crew = agentsOf(c);
    var tip = crew.length ? 'Agents lancés : ' + crew.join(', ')
      : (displayState(c) === 'working' && a.detail ? 'Outil en cours : ' + a.detail : '');
    return '<div class="convo-state st-' + esc(displayState(c)) + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>'
      + '<span class="st-dot"></span><span>' + esc(text) + '</span></div>';
  }

  /* Conversation la plus pressante d'une tâche, et son état : c'est ce que porte la pastille
     posée en coin de l'icône terminal (et le point du bouton « Remarques »). */
  function bestConvo(convs) {
    var best = null, rank = 0;
    convs.forEach(function (c) {
      var r = STATE_RANK[displayState(c)] || 0;
      if (r > rank) { rank = r; best = c; }
    });
    return best;
  }

  function bestState(convs) {
    var c = bestConvo(convs);
    return c ? displayState(c) : null;
  }

  /* Une question attend une réponse quelque part dans la tâche : la carte s'en cerne de bleu.
     Toutes les conversations sont regardées, pas seulement la plus pressante — une session peut
     travailler pendant qu'une autre attend. */
  function hasQuestion(convs) {
    return convs.some(function (c) { return displayState(c) === 'waiting'; });
  }

  /* Bouton terminal de la carte : l'état des conversations se lit directement dessus, et le
     nombre d'agents qui travaillent pour la tâche — terminaux et agents qu'ils ont lancés —
     se compte dans un badge, comme les rapports sur l'icône de fichiers. */
  function termBtnHtml(t, convs) {
    var c = bestConvo(convs);
    var st = c ? displayState(c) : null;
    var busy = crewCount(convs);
    /* L'infobulle dit ce que fera le clic (clickTerm), et Maj + clic quand il fait autre chose. */
    var toTerm = wantsTerminal(convs, false);
    var tip = toTerm ? (displayState(convs[0]) === 'closed' ? 'Rouvrir son terminal' : 'Aller à son terminal') + ' · Maj + clic : le panneau'
      : convs.length > 1 && S.settings.termClick === 'terminal' ? 'Choisir la conversation'
      : 'Ouvrir le terminal de l’agent' + (convs.length === 1 ? ' · Maj + clic : aller à sa fenêtre' : '');
    if (c) {
      var line = stateText(c) || TASK_STATE_LABELS[st] || '';
      tip = (convs.length > 1 ? (c.title || 'Nouvelle session') + ' · ' : '') + line + ' · ' + tip;
    }
    if (busy) tip = busy + (busy > 1 ? ' agents au travail' : ' agent au travail') + ' · ' + tip;
    /* Sa dernière parole sur sa propre ligne : la question posée se lit sans ouvrir le panneau. */
    var said = c ? saidOf(c) : '';
    if (said) tip += '\n« ' + said + ' »';
    return '<button type="button" class="icon-btn term-btn' + (convs.length ? ' has' : '')
      + (st ? ' is-' + esc(st) : '') + '" data-act="open-term" data-id="' + esc(t.id)
      + '" title="' + esc(tip) + '">' + ICON.terminal
      + (busy ? '<span class="term-count">' + esc(busy) + '</span>' : '')
      + (st ? '<span class="btn-dot st-' + esc(st) + '"></span>' : '') + '</button>';
  }

  function artifactsOf(c) {
    return c && Array.isArray(c.artifacts) ? c.artifacts : [];
  }

  function isReport(path) { return REPORT_EXT[extOf(path)] === 1; }

  /* Ce qu'on ne vient jamais lire : notes de mémoire et réglages de Claude (…\.claude\…), fichiers
     temporaires et scratchpads des agents, chemins restés en variable ($SP\…). */
  function isScratchPath(path) {
    var s = String(path || '').replace(/\//g, '\\').toLowerCase();
    return /\$/.test(s) || /(^|\\)\.claude\\/.test(s) || /(^|\\)scratchpad\\/.test(s) || /(^|\\)(tmp|temp)\\/.test(s);
  }

  /* Le rapport d'une conversation, c'est le document que l'agent principal nomme dans une réponse
     finale (« rapport écrit dans review-UDM-1601.md ») : l'hôte le marque `cited`. Les autres
     documents — notes intermédiaires des sous-agents, brouillons, mémoire — sont des documents de
     travail, gardés à portée mais repliés. Une liste relevée avant ce marquage (pas de `cited`
     du tout) retient les documents de la session elle-même, hors brouillons. */
  function mainReport(artifact, legacy) {
    if (artifact.action === 'deleted' || isScratchPath(artifact.path)) return false;
    return legacy ? !artifact.agent : artifact.cited > 0;
  }

  /* `kind` : 'report' pour les rapports (livrables cités), 'work' pour les autres documents,
     'doc' pour les deux, 'file' pour le reste (le code touché en chemin), absent pour tout. */
  function artifactEntries(convs, kind) {
    var entries = [];
    convs.forEach(function (c) {
      var list = artifactsOf(c);
      var legacy = !list.some(function (a) { return a && a.cited != null; });
      list.forEach(function (artifact) {
        if (!artifact || !artifact.path) return;
        var doc = isReport(artifact.path);
        var main = doc && mainReport(artifact, legacy);
        if (kind === 'report' && !main) return;
        if (kind === 'work' && (!doc || main)) return;
        if (kind === 'doc' && !doc) return;
        if (kind === 'file' && doc) return;
        entries.push({
          path: String(artifact.path),
          action: String(artifact.action || 'modified'),
          tool: String(artifact.tool || 'outil'),
          agent: String(artifact.agent || ''),
          report: doc,
          main: main,
          cited: Number(artifact.cited) || 0,
          cwd: String(c.cwd || ''),
          convoId: c.id,
          convoTitle: c.title || 'Nouvelle session'
        });
      });
    });
    return entries;
  }

  /* ── Consommation ───────────────────────────────────────────────────────
     Avec les fichiers produits, l'hôte relève ce qu'a consommé chaque session (`convo.usage`) : les
     jetons de chaque appel du modèle, sous-agents compris, et leur coût au tarif public de l'API —
     ce qu'aurait coûté la session facturée à l'usage ; l'abonnement, lui, compte en quotas. Copilot
     donne ses requêtes premium, et ses jetons dans le bilan qu'il écrit à la fermeture. */
  function normalizeUsage(u) {
    if (!u || typeof u !== 'object') return null;
    function n(v) { v = Number(v); return isFinite(v) && v > 0 ? v : 0; }
    var out = {
      input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite),
      cost: n(u.cost), unpriced: n(u.unpriced), premium: n(u.premium),
      models: (Array.isArray(u.models) ? u.models : []).filter(function (m) { return m && m.model; }).slice(0, 8).map(function (m) {
        return { model: String(m.model), tokens: n(m.tokens), cost: n(m.cost) };
      })
    };
    return usageTokens(out) || out.premium ? out : null;
  }

  function usageTokens(u) { return u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0; }

  function sameUsage(a, b) { return JSON.stringify(a || null) === JSON.stringify(b || null); }

  /* Somme de plusieurs conversations ; null si rien n'a été consommé. */
  function usageOf(convs) {
    var sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0, premium: 0, models: [], convos: 0 };
    var byModel = {};
    convs.forEach(function (c) {
      var u = c && c.usage;
      if (!u) return;
      sum.convos++;
      ['input', 'output', 'cacheRead', 'cacheWrite', 'cost', 'unpriced', 'premium'].forEach(function (k) { sum[k] += u[k] || 0; });
      (u.models || []).forEach(function (m) {
        var x = byModel[m.model] || (byModel[m.model] = { model: m.model, tokens: 0, cost: 0 });
        x.tokens += m.tokens; x.cost += m.cost;
      });
    });
    if (!sum.convos) return null;
    sum.models = Object.keys(byModel).map(function (k) { return byModel[k]; }).sort(function (a, b) { return b.cost - a.cost || b.tokens - a.tokens; });
    return usageTokens(sum) || sum.premium ? sum : null;
  }

  function fmtNum(v, digits) {
    return v.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function fmtCost(d) {
    if (d < 0.005) return '< 0,01 $';
    return fmtNum(d, d < 10 ? 2 : (d < 100 ? 1 : 0)) + ' $';
  }

  function fmtTokens(n) {
    if (n < 1000) return Math.round(n) + '';
    if (n < 1e6) return fmtNum(n / 1e3, n < 1e4 ? 1 : 0) + ' k';
    if (n < 1e9) return fmtNum(n / 1e6, n < 1e7 ? 1 : 0) + ' M';
    return fmtNum(n / 1e9, 1) + ' Md';
  }

  function premiumText(p) { return fmtNum(p, p % 1 ? 1 : 0) + ' req. premium'; }

  /* « ≈ 2,40 $ · 18 M jetons », « 3 req. premium · 99 M jetons ». */
  function usageText(u) {
    var parts = [];
    if (u.cost > 0) parts.push('≈ ' + fmtCost(u.cost));
    if (u.premium > 0) parts.push(premiumText(u.premium));
    var tokens = usageTokens(u);
    if (tokens) parts.push(fmtTokens(tokens) + ' jetons');
    return parts.join(' · ');
  }

  function usageTip(u, what) {
    var lines = [what + ' : ' + usageText(u)];
    if (u.cost > 0) lines.push('Coût estimé au tarif public de l’API Anthropic (l’abonnement compte en quotas, pas en dollars).');
    if (usageTokens(u)) {
      lines.push('Jetons : ' + fmtTokens(u.input) + ' en entrée, ' + fmtTokens(u.output) + ' en sortie, '
        + fmtTokens(u.cacheRead) + ' lus dans le cache, ' + fmtTokens(u.cacheWrite) + ' écrits dans le cache.');
    }
    if (u.premium > 0) lines.push('Copilot : ' + premiumText(u.premium) + ' décomptées par GitHub.');
    u.models.slice(0, 4).forEach(function (m) {
      lines.push('· ' + m.model + ' : ' + fmtTokens(m.tokens) + ' jetons' + (m.cost > 0 ? ', ≈ ' + fmtCost(m.cost) : ''));
    });
    if (u.unpriced > 0) lines.push(fmtTokens(u.unpriced) + ' jetons d’un modèle sans tarif connu, non chiffrés.');
    return lines.join('\n');
  }

  /* Pastille de la carte : la tâche, et pour une parente ses sous-tâches avec. */
  function usageChipHtml(t, convs) {
    var all = convs;
    var kids = isSub(t) ? [] : childrenOf(t.id);
    if (kids.length) {
      var ids = {};
      kids.forEach(function (k) { ids[k.id] = true; });
      all = convs.concat(S.data.convos.filter(function (c) { return ids[c.taskId]; }));
    }
    var u = usageOf(all);
    if (!u) return '';
    return '<span class="usage-chip" title="' + esc(usageTip(u, kids.length ? 'Consommation de la tâche et de ses sous-tâches' : 'Consommation de la tâche')
      + '\n' + u.convos + (u.convos > 1 ? ' conversations' : ' conversation')) + '">' + ICON.gauge
      + '<span>' + esc(usageText(u)) + '</span></span>';
  }

  /* Rapports d'un ensemble de conversations : un par fichier (le même rapport cité par deux
     conversations n'en fait qu'un), le plus récemment cité en tête. */
  function reportsOf(convs) {
    var seen = {}, out = [];
    artifactEntries(convs, 'report').forEach(function (a) {
      var key = artifactFullPath(a.path, a.cwd).toLowerCase();
      var had = seen[key];
      if (had) { if (a.cited > had.cited) { out[out.indexOf(had)] = a; seen[key] = a; } return; }
      seen[key] = a;
      out.push(a);
    });
    return out.sort(function (a, b) { return b.cited - a.cited; });
  }

  function artifactRowHtml(artifact, latest) {
    var openable = artifact.action !== 'deleted';
    var tag = openable ? 'button' : 'div';
    var folder = folderOf(artifact.path);
    /* « écrit par <agent> » : le fichier vient d'un sous-agent de la session, pas de l'agent principal.
       Un rapport dit quand l'agent l'a cité pour la dernière fois. */
    var meta = (artifact.main && artifact.cited > 1 ? 'cité ' + fmtTime(artifact.cited) + ' · ' : '')
      + (ARTIFACT_ACTIONS[artifact.action] || artifact.action) + (artifact.agent ? ' par ' + artifact.agent : '')
      + (folder ? ' · ' + folder : '');
    var attributes = openable
      ? ' type="button" class="artifact-row artifact-openable' + (latest ? ' is-latest' : '') + '" data-act="open-artifact" data-path="' + esc(artifact.path)
        + '" data-cwd="' + esc(artifact.cwd) + '" title="Lire ici"'
      : ' class="artifact-row artifact-deleted" title="Ce fichier a été supprimé"';
    return '<' + tag + attributes + '>'
      + '<span class="artifact-row-icon">' + ICON.artifacts + '</span>'
      + '<div class="artifact-main">' + (latest ? '<div class="artifact-latest">Dernier rapport</div>' : '')
      + '<div class="artifact-title" title="' + esc(artifact.path) + '">' + esc(lastSegment(artifact.path)) + '</div>'
      + '<div class="artifact-meta">' + esc(meta) + '</div></div>'
      + (openable ? '<span class="artifact-open-hint">Lire</span>' : '')
      + '</' + tag + '>';
  }

  /* La carte ne porte l'icône que si la tâche a rendu un rapport : brouillons et fichiers de code
     se consultent depuis le panneau, ils n'ont pas à encombrer la file. Un seul rapport s'ouvre
     d'un clic dans le lecteur ; avec plusieurs, le panneau les liste, le plus récent en tête. */
  function artifactBtnHtml(t, convs) {
    var reports = reportsOf(convs);
    var count = reports.length;
    if (!count) return '';
    var tip = count > 1 ? count + ' rapports — le dernier : ' + lastSegment(reports[0].path) : 'Lire le rapport : ' + lastSegment(reports[0].path);
    return '<button type="button" class="icon-btn artifact-btn has" data-act="open-artifacts" data-id="' + esc(t.id)
      + '" title="' + esc(tip + '\nMaj + clic : tous les fichiers de la tâche') + '">'
      + ICON.artifacts + (count > 1 ? '<span class="artifact-count">' + esc(count) + '</span>' : '') + '</button>';
  }

  /* Rapports de revue de la tâche, le plus probable en tête : un Markdown nommé review-… ou revue-…
     (les notes de mémoire « project_review_… » n'en sont pas), écrit sous le dossier de travail plutôt
     qu'ailleurs (brouillons du scratchpad), puis celui de la conversation la plus récente. C'est le
     nom qui décide ici, sans lire le fichier : la vue revue ne s'ouvre que si l'hôte y trouve des constats. */
  var REVIEW_NAME = /^(review|revue)[-_ .]/i;

  function reviewReportsOf(convs) {
    var seen = {};
    /* Tous les documents : un rapport de revue écrit par le « rapporteur » d'une équipe et jamais
       cité par l'agent principal reste un rapport de revue. */
    var list = artifactEntries(convs, 'doc').filter(function (a) {
      var name = lastSegment(a.path);
      if (isScratchPath(a.path)) return false;
      if (a.action === 'deleted' || !REVIEW_NAME.test(name) || !/^(md|markdown)$/.test(extOf(name))) return false;
      var full = artifactFullPath(a.path, a.cwd).toLowerCase();
      if (seen[full]) return false;
      seen[full] = true;
      return true;
    });
    function outside(a) { return /^([a-zA-Z]:|\\\\|\/)/.test(a.path) ? 1 : 0; }
    function updated(a) { var c = convoById(a.convoId); return c ? toMs(c.updated) || toMs(c.created) : 0; }
    return list.sort(function (a, b) {
      return outside(a) - outside(b) || updated(b) - updated(a)
        || (lastSegment(b.path).toLowerCase() < lastSegment(a.path).toLowerCase() ? -1 : 1);
    });
  }

  /* Rapports de revue d'une tâche. Le temps d'un rendu (renderPass), chacune n'est calculée qu'une
     fois : sa carte, celle de sa parente, le bouton « Revues » et les onglets la redemandent. */
  var reviewMemo = null;

  function taskReviews(id) {
    if (!reviewMemo) return reviewReportsOf(convosOf(id));
    return reviewMemo[id] || (reviewMemo[id] = reviewReportsOf(convosOf(id)));
  }

  /* Accès direct au résultat de la revue, à côté des rapports : la vue plein écran des constats.
     Une tâche dont des sous-tâches ont un rapport ouvre le panneau à onglets, un par sous-tâche. */
  function reviewBtnHtml(t) {
    var subs = childrenOf(t.id).filter(function (k) { return taskReviews(k.id).length > 0; }).length;
    if (subs) {
      return '<button type="button" class="icon-btn review-btn has" data-act="open-review-group" data-id="' + esc(t.id)
        + '" title="' + esc('Résultats des revues — ' + subs + (subs > 1 ? ' rapports de sous-tâches' : ' rapport de sous-tâche')) + '">'
        + ICON.review + '<span class="artifact-count review-count">' + esc(subs) + '</span></button>';
    }
    var list = taskReviews(t.id);
    if (!list.length) return '';
    return '<button type="button" class="icon-btn review-btn has" data-act="open-review" data-id="' + esc(t.id)
      + '" title="' + esc('Résultat de la revue — ' + lastSegment(list[0].path)) + '">' + ICON.review + '</button>';
  }

  /* Sous le dernier message du journal : ce que fait l'agent en ce moment. */
  function logStateHtml(c) {
    var st = displayState(c);
    var a = activityOf(c);
    if (st === 'working') {
      return '<div class="log-state st-working"><span class="st-dot"></span><span>L’agent travaille…</span>'
        + (a.detail ? '<span class="log-tool">' + esc(a.detail) + '</span>' : '') + '</div>';
    }
    if (st === 'waiting') return '<div class="log-state st-waiting"><span class="st-dot"></span><span>L’agent attend votre réponse dans PowerShell.</span></div>';
    if (st === 'error') return '<div class="log-state st-error"><span class="st-dot"></span><span>' + esc(stateText(c)) + '</span></div>';
    return '';
  }

  /* Liste déroulante des modèles : « par défaut de l'outil », les groupes du catalogue, puis
     « Autre… » qui ouvre un champ libre. Une valeur hors catalogue est présentée comme « Autre… ». */
  function modelSelectHtml(provider, value, custom, role, key, dark) {
    var cat = catalogFor(provider);
    var selected = custom || (value && !catalogHas(cat, value)) ? CUSTOM : (value || '');
    var h = [];
    h.push('<select class="' + (dark ? 'dark-select' : 'input set-select') + '" data-role="' + esc(role)
      + '" data-focus-key="' + esc(key) + '" data-provider="' + esc(provider) + '">');
    h.push('<option value=""' + (selected === '' ? ' selected' : '') + '>Par défaut de l’outil'
      + (cat.defaultModel ? ' · ' + esc(cat.defaultModel) : '') + '</option>');
    (cat.groups || []).forEach(function (g) {
      h.push('<optgroup label="' + esc(GROUP_LABELS[g.key] || g.key) + '">');
      (g.items || []).forEach(function (it) {
        h.push('<option value="' + esc(it.id) + '"' + (selected === it.id ? ' selected' : '')
          + (it.enabled === false ? ' disabled' : '') + '>' + esc(itemLabel(it)) + '</option>');
      });
      h.push('</optgroup>');
    });
    h.push('<option value="' + CUSTOM + '"' + (selected === CUSTOM ? ' selected' : '') + '>Autre… (saisir un identifiant)</option>');
    h.push('</select>');
    return h.join('');
  }

  function effortSelectHtml(provider, value, role, key, dark) {
    var cat = catalogFor(provider);
    var list = effortsFor(provider);
    var h = [];
    h.push('<select class="' + (dark ? 'dark-select' : 'input set-select') + '" data-role="' + esc(role)
      + '" data-focus-key="' + esc(key) + '" data-provider="' + esc(provider) + '">');
    h.push('<option value=""' + (!value ? ' selected' : '') + '>Par défaut de l’outil'
      + (cat.defaultEffort ? ' · ' + esc(cat.defaultEffort) : '') + '</option>');
    list.forEach(function (l) {
      h.push('<option value="' + esc(l) + '"' + (value === l ? ' selected' : '') + '>' + esc(l) + '</option>');
    });
    if (value && list.indexOf(value) < 0) h.push('<option value="' + esc(value) + '" selected>' + esc(value) + '</option>');
    h.push('</select>');
    return h.join('');
  }

  /* Sous le choix du modèle par défaut : d'où vient la liste et de quand elle date. */
  function catalogHint(provider) {
    var copilot = provider === 'copilot';
    if (S.ui.modelsBusy[provider]) return copilot ? 'Détection des modèles Copilot en cours…' : 'Lecture des modèles Anthropic en cours…';
    var cat = catalogFor(provider);
    if (!toMs(cat.fetchedAt)) {
      return copilot
        ? 'Liste non détectée : ↻ interroge la CLI Copilot (quelques secondes).'
        : 'Alias et modèles déjà utilisés seulement : ↻ lit la liste sur l’API Anthropic avec la connexion de Claude Code.';
    }
    var stale = catalogStale(provider) ? ' (à rafraîchir)' : '';
    return copilot
      ? catalogCount(cat) + ' modèles détectés le ' + fmtDate(cat.fetchedAt) + stale + '.'
      : catalogCount(cat) + ' modèles Anthropic lus le ' + fmtDate(cat.fetchedAt) + stale + ', passés à --model comme les alias.';
  }

  function refreshModelsTitle(provider) {
    return provider === 'copilot' ? 'Redétecter les modèles Copilot' : 'Relire les modèles Anthropic (connexion Claude Code)';
  }

  /* Détection du catalogue par l'hôte, mis en cache 24 h de part et d'autre : sonde ACP pour
     Copilot, `GET /v1/models` de l'API Anthropic avec le jeton de Claude Code pour Claude. */
  function refreshModels(provider, force) {
    provider = provider === 'copilot' ? 'copilot' : 'claude';
    var p = providerById(provider);
    if (S.ui.modelsBusy[provider]) return Promise.resolve();
    if (!hasProvider(provider)) { if (force) toast(p.missing); return Promise.resolve(); }
    S.ui.modelsBusy[provider] = true;
    render();
    return bridge.call('refreshModels', { provider: provider, force: !!force }, 90000)
      .then(function (r) {
        S.ui.modelsBusy[provider] = false;
        if (r && r[provider]) {
          if (!S.env.models) S.env.models = {};
          S.env.models[provider] = r[provider];
        }
        render();
        if (force) toast(catalogCount(catalogFor(provider)) + ' modèles ' + p.short + ' détectés');
      })['catch'](function (e) {
        S.ui.modelsBusy[provider] = false;
        render();
        if (force) toast('Détection impossible : ' + e.message);
        else console.warn('[organizator] refreshModels', provider, e);
      });
  }

  /* ══ Rendu ════════════════════════════════════════════════════════════ */

  var panelKey = null, dialogKey = null, composerFocus = null;

  /* Restaure focus et caret quand le champ actif a été reconstruit. */
  function preserveFocus(fn) {
    var a = document.activeElement;
    var key = a && a.getAttribute ? a.getAttribute('data-focus-key') : null;
    var sel = null;
    if (key) {
      try { sel = { s: a.selectionStart, e: a.selectionEnd, top: a.scrollTop }; } catch (err) { sel = null; }
    }
    fn();
    if (!key || document.contains(a)) return;
    var el = document.querySelector('[data-focus-key="' + key + '"]');
    if (!el) return;
    el.focus({ preventScroll: true });
    if (sel && el.setSelectionRange) {
      try { el.setSelectionRange(sel.s, sel.e); el.scrollTop = sel.top; } catch (err) { /* champ non textuel */ }
    }
  }

  /* Un passage de rendu : le focus est gardé, et les rapports de revue ne sont lus qu'une fois par tâche. */
  function renderPass(fn) {
    reviewMemo = Object.create(null);
    try { preserveFocus(fn); } finally { reviewMemo = null; }
  }

  function render() {
    var t0 = perfNow();
    renderPass(function () {
      var page = currentPage();
      $('#app').classList.toggle('compact', !!S.settings.compact);
      $('#app').setAttribute('data-page', page);
      $('#shell').classList.toggle('with-panel', !!S.ui.termTaskId);
      renderPageTabs();
      if (page === 'queue') {
        renderFilters();
        renderList();
      }
      renderPageBody(page);
      renderPanel();
      renderReader();
      renderDialogs();
      renderUsage();
      renderRemarksBtn();
      renderReviewsBtn();
      renderNotifsBtn();
      renderNotifs();
    });
    syncDictate();
    perfRender(t0);
  }

  /* ── Pages ───────────────────────────────────────────────────────────
     La file est la page d'accueil. D'autres pages (Révizator, dans revizator/core.js) s'enregistrent
     par window.__organizator.registerPage avant le premier rendu : un onglet dans l'en-tête, un corps
     rendu dans #page-host à la place des filtres et de la file, leurs actions (data-act), leurs rôles
     de saisie (data-role) et, au besoin, un onglet des Réglages. Le panneau, le lecteur, les dialogues,
     la cloche et les cartes de l'en-tête restent communs. La page ouverte est retenue d'un lancement
     à l'autre (localStorage : une commodité d'affichage, rien d'important n'en dépend). */
  var PAGES = [], pageShownKey = null, booted = false;
  var PAGE_INPUT = Object.create(null), PAGE_CHANGE = Object.create(null), PAGE_KEYS = [];
  var EXTRA_SETTINGS = Object.create(null);
  var PAGE_STORE_KEY = 'organizator.page';

  function pageDef(id) {
    for (var i = 0; i < PAGES.length; i++) if (PAGES[i].id === id) return PAGES[i];
    return null;
  }

  function currentPage() {
    var p = S.ui.page;
    return p && p !== 'queue' && pageDef(p) ? p : 'queue';
  }

  function renderPageTabs() {
    var nav = $('#page-tabs');
    if (!nav) return;
    if (!PAGES.length) { setHtml(nav, ''); nav.hidden = true; return; }
    var cur = currentPage();
    var all = [{ id: 'queue', label: 'File', title: 'La file de tâches' }].concat(PAGES);
    nav.hidden = false;
    setHtml(nav, all.map(function (p) {
      var on = p.id === cur;
      return '<button type="button" role="tab" class="page-tab' + (on ? ' on' : '') + '" data-act="go-page" data-page="' + esc(p.id) + '"'
        + ' aria-selected="' + (on ? 'true' : 'false') + '"' + (p.title ? ' title="' + esc(p.title) + '"' : '') + '>'
        + (p.icon || '') + '<span>' + esc(p.label) + '</span>'
        + (p.badge ? pageBadgeHtml(p) : '') + '</button>';
    }).join(''));
  }

  function pageBadgeHtml(p) {
    var b = '';
    try { b = p.badge(); } catch (e) { b = ''; }
    return b ? '<span class="page-tab-badge">' + esc(b) + '</span>' : '';
  }

  function renderPageBody(page) {
    var host = $('#page-host');
    if (!host) return;
    var def = page === 'queue' ? null : pageDef(page);
    var bar = $('#page-bar');
    if (bar) {
      bar.hidden = !(def && def.renderBar);
      if (bar.hidden) setHtml(bar, '');
      else { try { def.renderBar(bar); } catch (e) { setHtml(bar, ''); } }
    }
    host.hidden = !def;
    if (!def) { if (pageShownKey) { host.innerHTML = ''; host.rvHtml = null; } pageShownKey = null; return; }
    var enter = pageShownKey !== def.id;
    pageShownKey = def.id;
    try { def.render(host, enter); } catch (e) {
      host.innerHTML = '<div class="page-error">Affichage impossible : ' + esc(e && e.message) + '</div>';
      host.rvHtml = null;
      if (window.console) console.error(e);
    }
  }

  function goPage(id, quiet) {
    var next = id && id !== 'queue' && pageDef(id) ? id : 'queue';
    var prev = currentPage();
    if (next === prev) { if (!quiet) render(); return; }
    var pd = pageDef(prev), nd = pageDef(next);
    if (pd && pd.onHide) { try { pd.onHide(); } catch (e) { /* page fautive : on change quand même */ } }
    S.ui.page = next;
    try { localStorage.setItem(PAGE_STORE_KEY, next); } catch (e) { /* stockage refusé : la page n'est pas retenue */ }
    window.scrollTo(0, 0);
    if (nd && nd.onShow) { try { nd.onShow(); } catch (e) { /* idem */ } }
    render();
  }

  function registerPage(def) {
    if (!def || !def.id || def.id === 'queue' || pageDef(def.id) || typeof def.render !== 'function') return null;
    PAGES.push(def);
    if (!S.ui.page) {
      try { S.ui.page = localStorage.getItem(PAGE_STORE_KEY) || ''; } catch (e) { S.ui.page = ''; }
    }
    if (booted) render();
    return pageApi;
  }

  /* Actions et rôles des pages : un préfixe propre à chacune évite les collisions avec la file. */
  function addPageAction(name, fn) { if (name && typeof fn === 'function' && !ACTIONS[name]) ACTIONS[name] = fn; }
  function addPageInput(role, fn) { if (role && typeof fn === 'function') PAGE_INPUT[role] = fn; }
  function addPageChange(role, fn) { if (role && typeof fn === 'function') PAGE_CHANGE[role] = fn; }
  function addPageKey(fn) { if (typeof fn === 'function') PAGE_KEYS.push(fn); }

  /* Un onglet de plus dans les Réglages : { id, label, lead, html(settings), onOpen() }. */
  function addSettingsTab(tab) {
    if (!tab || !tab.id || EXTRA_SETTINGS[tab.id] || typeof tab.html !== 'function') return;
    EXTRA_SETTINGS[tab.id] = tab;
    var at = SETTINGS_TABS.map(function (t) { return t.id; }).indexOf('folders');
    SETTINGS_TABS.splice(at < 0 ? SETTINGS_TABS.length : at, 0, { id: tab.id, label: tab.label, lead: tab.lead || '' });
  }

  function openSettingsTab(id) {
    S.ui.settingsOpen = true;
    if (id) S.ui.settingsTab = id;
    render();
    var x = EXTRA_SETTINGS[settingsTab()];
    if (x && x.onOpen) x.onOpen();
  }

  /* Un dialogue, le lecteur ou la cloche ouverts gardent le clavier pour eux. */
  function overlayOpen() {
    return !!(S.ui.settingsOpen || S.ui.catsOpen || S.ui.composerOpen || S.ui.chat || S.ui.reader || S.ui.notifsOpen);
  }

  /* ── Rendus de fond ──────────────────────────────────────────────────
     Les relectures de sessions et du journal reviennent toutes les secondes tant qu'un agent
     travaille. Redessiner à ce moment-là reconstruisait le champ où l'on tapait : frappe retardée,
     touche morte (^, ¨) avalée entre ses deux appuis, historique d'annulation perdu. Ces rendus-là
     attendent donc une pause de frappe, et ne touchent que ce qui montre l'état des sessions — la
     file, le panneau, le bouton Remarques — jamais les dialogues, qui n'en affichent rien. */
  var TYPING_QUIET_MS = 1200;
  var lastTypingAt = 0, composing = false, activityTimer = null;

  function isTyping() {
    if (composing) return true;
    var a = document.activeElement;
    if (!a || !(a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable)) return false;
    return Date.now() - lastTypingAt < TYPING_QUIET_MS;
  }

  function renderActivity() {
    if (isTyping()) {
      if (!activityTimer) {
        activityTimer = setTimeout(function () { activityTimer = null; renderActivity(); }, TYPING_QUIET_MS / 2);
      }
      return;
    }
    if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
    var t0 = perfNow();
    renderPass(function () {
      /* Sur une autre page, la file n'est pas affichée : rien à redessiner, les notifications suivent quand même. */
      if (currentPage() === 'queue') renderList();
      renderPanel();
      renderRemarksBtn();
      renderReviewsBtn();
      /* Revues groupées : un rapport qui paraît ouvre son onglet « en cours ». */
      if (S.ui.reader && S.ui.reader.group) renderReader();
    });
    syncDictate();
    perfRender(t0);
  }

  document.addEventListener('keydown', function () { lastTypingAt = Date.now(); }, true);
  document.addEventListener('input', function () { lastTypingAt = Date.now(); }, true);
  document.addEventListener('compositionstart', function () { composing = true; }, true);
  document.addEventListener('compositionend', function () { composing = false; lastTypingAt = Date.now(); }, true);

  /* ── Surveillance des performances ───────────────────────────────────
     Ce que l'on ressent — frappe qui traîne, fenêtre figée — se mesure ici : tâches longues du fil
     JS (plus de 50 ms d'affilée), saisies lentes (plus de 100 ms entre la touche et l'affichage),
     durée des rendus. Les mesures partent à l'hôte chaque minute (message `perf`), qui les reprend
     dans son bilan de host.log toutes les 10 min ; un gel franc (plus d'une demi-seconde) y est noté
     aussitôt, pour relier « ça a figé vers 14 h 32 » à une cause. */
  var PERF_SEND_MS = 60000;
  var PERF_ALERT_MS = 500;
  var perfStats = null, perfAlertAt = 0;

  function perfReset() {
    perfStats = {
      longTasks: { n: 0, total: 0, max: 0 },
      inputs: { n: 0, max: 0, what: '' },
      renders: { n: 0, total: 0, max: 0 }
    };
  }
  perfReset();

  function perfNow() {
    return window.performance && performance.now ? performance.now() : Date.now();
  }

  function perfRender(t0) {
    var ms = perfNow() - t0;
    var r = perfStats.renders;
    r.n++; r.total += ms; if (ms > r.max) r.max = ms;
  }

  function perfAlert(text) {
    var now = Date.now();
    if (now - perfAlertAt < 30000) return;
    perfAlertAt = now;
    bridge.call('log', { level: 'perf', message: text })['catch'](function () { /* sans importance */ });
  }

  function perfSend() {
    var s = perfStats;
    perfReset();
    if (!s.longTasks.n && !s.inputs.n && !s.renders.n) return;
    bridge.call('perf', s)['catch'](function () { /* sans importance */ });
  }

  function startPerfMonitor() {
    if (typeof PerformanceObserver !== 'function') return;
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          var l = perfStats.longTasks;
          l.n++; l.total += e.duration; if (e.duration > l.max) l.max = e.duration;
          if (e.duration >= PERF_ALERT_MS) perfAlert('Interface figée ' + Math.round(e.duration) + ' ms (tâche longue du fil JS)');
        });
      }).observe({ type: 'longtask' });
    } catch (err) { /* non pris en charge */ }
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (!/^(key|input|beforeinput|composition|pointer|mouse|click)/.test(e.name)) return;
          var i = perfStats.inputs;
          i.n++;
          if (e.duration > i.max) { i.max = e.duration; i.what = e.name; }
          if (e.duration >= PERF_ALERT_MS) perfAlert('Saisie lente : « ' + e.name + ' » affiché après ' + Math.round(e.duration) + ' ms');
        });
      }).observe({ type: 'event', durationThreshold: 104 });
    } catch (err) { /* non pris en charge */ }
    setInterval(perfSend, PERF_SEND_MS);
  }

  /* ── Bouton « Remarques » de l'en-tête : remarques en attente et état des sessions ── */

  function renderRemarksBtn() {
    var btn = $('#remarks-btn');
    if (!btn) return;
    var n = pendingRemarks().length;
    var st = bestState(convosOf(FEEDBACK_ID));
    var badge = btn.querySelector('.btn-badge');
    var dot = btn.querySelector('.btn-dot');
    badge.textContent = n ? String(n) : '';
    badge.hidden = !n;
    dot.className = 'btn-dot' + (st ? ' st-' + st : '');
    dot.hidden = !st;
    btn.classList.toggle('on', S.ui.termTaskId === FEEDBACK_ID);
    btn.title = 'Remarques sur Organizator' + (n ? ' · ' + n + ' à envoyer' : '') + (st ? ' · ' + TASK_STATE_LABELS[st] : '');
  }

  /* Bouton « Revues » de l'en-tête : les rapports de revue des tâches en file, un onglet chacun.
     Masqué tant qu'aucune n'en a ; son badge compte les onglets qu'il ouvrira. */
  function renderReviewsBtn() {
    var btn = $('#reviews-btn');
    if (!btn) return;
    var n = S.data.tasks.filter(function (t) { return !t.done && taskReviews(t.id).length > 0; }).length;
    var badge = btn.querySelector('.btn-badge');
    badge.textContent = n ? String(n) : '';
    badge.hidden = !n;
    btn.hidden = !n;
    btn.title = 'Revues de code' + (n ? ' · ' + n + (n > 1 ? ' rapports' : ' rapport') + ' (tâches en file)' : '');
  }

  /* ── Barre de filtres ─────────────────────────────────────────────────
     Les pastilles de catégorie encombraient la vue en permanence : elles ne se déplient
     plus que sur demande, sous le bouton entonnoir, et repartent repliées au lancement.
     Un badge dit alors combien de catégories sont masquées — sans quoi une file filtrée
     passerait pour une file vide. */

  function renderFilters() {
    var used = S.data.types.filter(function (ty) {
      return S.data.tasks.some(function (t) { return t.type === ty.id; });
    });
    var off = used.filter(function (ty) { return S.ui.hidden.indexOf(ty.id) >= 0; }).length;
    var open = !!S.ui.filtersOpen && used.length > 0;

    var btn = $('#filters-btn');
    if (btn) {
      /* Rien à filtrer tant qu'aucune catégorie n'est portée par une tâche. */
      btn.hidden = !used.length;
      btn.classList.toggle('on', open || off > 0);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      var badge = btn.querySelector('.btn-badge');
      badge.textContent = off ? String(off) : '';
      badge.hidden = !off;
      btn.title = (open ? 'Masquer les filtres' : 'Filtrer par catégorie')
        + (off ? ' · ' + off + (off > 1 ? ' catégories masquées' : ' catégorie masquée') : '');
    }

    var host = $('#filter-chips');
    host.hidden = !open;
    host.innerHTML = !open ? '' : used.map(function (ty) {
      var hid = S.ui.hidden.indexOf(ty.id) >= 0;
      var style = hid ? '' : ' style="border-color:' + esc(color(ty.bd, 'var(--color-neutral-300)'))
        + ';background:' + esc(color(ty.bg, 'transparent'))
        + ';color:' + esc(color(ty.fg, 'var(--color-neutral-700)')) + '"';
      return '<button type="button" class="chip' + (hid ? ' off' : '') + '" data-act="toggle-filter" data-id="'
        + esc(ty.id) + '" title="Clic droit pour supprimer la catégorie"' + style + '>' + esc(ty.label) + '</button>';
    }).join('');
  }

  /* ── Liste ──────────────────────────────────────────────────────────── */

  function bandHint(band) {
    if (band === 'Maintenant') return 'cette session';
    if (band === 'Ensuite') return 'cette semaine';
    if (band === 'Plus tard') return 'quand ce sera calme';
    return '';
  }

  /* `parentId` : le trou est au-dessus d'une sous-tâche — ce qu'on y ajoute en est une aussi. */
  function gapHtml(value, taskId, tail, parentId) {
    return '<div class="gap' + (tail ? ' gap-tail' : '') + '" data-act="gap" data-gap="' + esc(value) + '"'
      + (taskId ? ' data-gap-task="' + esc(taskId) + '"' : '')
      + (parentId ? ' data-gap-parent="' + esc(parentId) + '"' : '')
      + ' title="Ajouter une ' + (parentId ? 'sous-tâche' : 'tâche') + ' ' + (tail ? 'en bas de file' : 'ici') + '">'
      + '<div class="gap-inner"><div class="gap-rule"></div><div class="gap-dot">' + ICON.plusSmall + '</div></div>'
      + '</div>';
  }

  function taskHtml(t, rank, isTop, band, showBand) {
    var ty = typeOf(t.type);
    var editing = S.ui.editingId === t.id;
    var doing = !!t.doing && !t.done;
    var convs = S.data.convos.filter(function (c) { return c.taskId === t.id; });
    var sub = isSub(t);
    var progress = sub ? null : subtaskProgress(t);
    /* Sous-tâches repliées : leurs sessions se lisent sur le parent — l'avancement prend leur état
       le plus pressant, et une question posée cerne encore la carte de bleu. */
    var folded = !sub && subsFolded(t);
    var kidIds = {};
    if (folded) childrenOf(t.id).forEach(function (k) { kidIds[k.id] = true; });
    var kidConvs = folded ? S.data.convos.filter(function (c) { return kidIds[c.taskId]; }) : [];
    var asking = hasQuestion(convs) || hasQuestion(kidConvs);
    var h = [];

    h.push('<div class="item' + (sub ? ' is-sub' : '') + '" data-item="' + esc(t.id) + '">');

    if (showBand) {
      h.push('<div class="band"><span class="band-label">' + esc(band) + '</span>'
        + '<span class="band-rule"></span><span class="band-hint">' + esc(bandHint(band)) + '</span></div>');
    }

    h.push(gapHtml(rank.gapValue, t.id, false, sub ? t.parent : ''));
    h.push('<div class="drop drop-before"><div class="drop-line"></div><div class="drop-knob"></div></div>');

    h.push('<div class="task' + (doing ? ' is-doing' : '') + (t.done ? ' is-done' : '')
      + (asking ? ' is-asking' : '') + (editing ? ' is-editing' : '') + (sub ? ' is-sub' : '') + (flashStyle(t.id) ? ' is-flash' : '')
      + '" data-card="' + esc(t.id) + '" draggable="' + (editing ? 'false' : 'true') + '"' + flashStyle(t.id) + '>');
    h.push('<div class="task-row">');

    h.push('<div class="rank-col">'
      + '<span class="rank' + (isTop ? ' is-top' : '') + (sub ? ' is-sub' : '') + '">' + esc(t.done ? '✓' : String(rank.n)) + '</span>'
      + '<span class="handle" title="Glisser pour déplacer">' + ICON.handle + '</span>'
      + '</div>');

    h.push('<div class="task-main">');
    h.push('<div class="meta-row"><span class="type-chip" style="border-color:' + esc(color(ty.bd, 'var(--color-neutral-300)'))
      + ';background:' + esc(color(ty.bg, 'transparent')) + ';color:' + esc(color(ty.fg, 'var(--color-neutral-600)')) + '">'
      + esc(ty.label) + '</span>');
    h.push(jiraChipsHtml(t));
    h.push(prChipsHtml(t));
    if (doing) {
      h.push('<span class="doing-chip"><span class="doing-dot"></span><span>En cours</span></span>');
    }
    /* Le parent dit où en sont ses sous-tâches — terminées / total — et la pastille les replie ou
       les déplie d'un clic. */
    if (progress && progress.total) {
      var kidSt = folded ? bestState(kidConvs) : null;
      var subTip = progress.done + ' sur ' + progress.total + (progress.total > 1 ? ' sous-tâches terminées' : ' sous-tâche terminée')
        + (kidSt ? ' · ' + TASK_STATE_LABELS[kidSt] : '')
        + ' · ' + (folded ? 'cliquer pour les déplier' : 'cliquer pour les replier');
      h.push('<button type="button" class="sub-chip' + (progress.done === progress.total ? ' all' : '') + (folded ? ' is-folded' : '')
        + '" data-act="toggle-subs" data-id="' + esc(t.id) + '" draggable="false" aria-expanded="' + (folded ? 'false' : 'true')
        + '" title="' + esc(subTip) + '">'
        + ICON.subtask + '<span>' + esc(progress.done + '/' + progress.total) + '</span>'
        + (kidSt ? '<span class="sub-st st-' + esc(kidSt) + '"></span>' : '')
        + '<span class="sub-caret">' + ICON.caret + '</span></button>');
    }
    h.push(usageChipHtml(t, convs));
    h.push('</div>');

    if (editing) {
      var rows = Math.min(12, Math.max(2, String(t.text || '').split('\n').length + 1));
      h.push('<textarea class="input edit-area" rows="' + rows + '" data-role="edit-text" data-focus-key="edit-text" data-id="'
        + esc(t.id) + '">' + esc(t.text) + '</textarea>');
      h.push(attachmentsHtml(t.id, attachmentsOf(t), true));
      h.push('<div class="edit-row"><span class="edit-label">Catégorie</span>');
      h.push(S.data.types.map(function (ct) {
        var on = ct.id === t.type;
        var style = on ? ' style="border-color:' + esc(color(ct.bd, 'var(--color-neutral-300)'))
          + ';background:' + esc(color(ct.bg, 'transparent')) + ';color:' + esc(color(ct.fg, 'var(--color-neutral-600)')) + '"' : '';
        return '<button type="button" class="cat-chip" data-act="set-type" data-id="' + esc(t.id)
          + '" data-type="' + esc(ct.id) + '"' + style + '>' + esc(ct.label) + '</button>';
      }).join(''));
      h.push('<span class="edit-spacer"></span>'
        + draftBtnHtml('draft-task', ' data-id="' + esc(t.id) + '"', false, 'Rédiger')
        + '<button type="button" class="btn btn-ghost edit-done" data-act="stop-edit">Terminé</button></div>');
      h.push(draftBoxHtml('task:' + t.id, false));
    } else {
      h.push('<div class="task-text" data-act="edit" data-id="' + esc(t.id) + '" title="Cliquer pour modifier">'
        + taskTitleBodyHtml(t.text) + '</div>');
      h.push(attachmentsHtml(t.id, attachmentsOf(t), false));
    }
    h.push('</div>');

    h.push('<div class="task-actions"><div class="hover-actions">'
      /* Un seul niveau : le bouton n'existe que sur une tâche de premier niveau. */
      + (sub ? '' : '<button type="button" class="btn btn-icon btn-ghost sub-add" data-act="add-sub" data-id="' + esc(t.id)
        + '" title="Ajouter une sous-tâche">' + ICON.subtaskAdd + '</button>')
      + '<button type="button" class="icon-btn doing-btn' + (doing ? ' on' : '') + '" data-act="toggle-doing" data-id="'
      + esc(t.id) + '" title="' + (doing ? 'Sortir de « en cours »' : 'Passer en cours') + '">'
      + (doing ? ICON.stop : ICON.play) + '</button>'
      + '<button type="button" class="btn btn-icon btn-ghost" data-act="toggle-done" data-id="' + esc(t.id)
      + '" title="' + (t.done ? 'Rouvrir la tâche' : 'Marquer terminée') + '">' + ICON.check + '</button>'
      /* Ce qu'on fait d'une tâche terminée, et rien qu'elle : la ranger en bas, ou la supprimer.
         Une tâche encore en file ne se supprime pas d'un clic — il faut d'abord la cocher. */
      + (t.done
        ? '<button type="button" class="btn btn-icon btn-ghost" data-act="move-bottom" data-id="' + esc(t.id)
          + '" title="Descendre en bas de file">' + ICON.toBottom + '</button>'
          + '<button type="button" class="btn btn-icon btn-ghost" data-act="remove-task" data-id="' + esc(t.id)
          + '" title="Supprimer">' + ICON.trash + '</button>'
        : '')
      + '</div>'
      + reviewBtnHtml(t)
      + artifactBtnHtml(t, convs)
      + termBtnHtml(t, convs)
      + '</div>');

    h.push('</div></div>');
    h.push('<div class="drop drop-after"><div class="drop-line"></div><div class="drop-knob"></div></div>');
    h.push('</div>');
    return h.join('');
  }

  function renderList() {
    var visible = visibleTasks();
    var topCount = S.settings.topCount;
    var showBands = S.settings.showBands !== false;
    var seen = {};
    var r = 0, k = 0, parentRank = '';
    var out = [];

    visible.forEach(function (t, i) {
      var sub = isSub(t);
      /* Seules les tâches de premier niveau prennent un rang et ouvrent les bandes ; une sous-tâche
         se numérote sous son parent (3.1, 3.2…), sans compter dans la file. */
      if (!sub) {
        if (!t.done) r++;
        k = 0;
        parentRank = t.done ? '' : String(r);
      } else if (!t.done) {
        k++;
      }
      /* Les bandes sont posées par les tâches actives : une tâche terminée, restée au milieu de la
         file, n'en ouvre aucune — elle appartient encore à celle de ses voisines. */
      var band = sub || t.done ? '' : (r <= topCount ? 'Maintenant' : (r <= topCount * 2 ? 'Ensuite' : 'Plus tard'));
      var showBand = showBands && !!band && !seen[band];
      if (showBand) seen[band] = true;
      var isTop = !sub && !t.done && r <= topCount;
      var label = sub ? (parentRank ? parentRank + '.' : '') + k : r;
      out.push(taskHtml(t, { n: label, gapValue: i === 0 ? 'top' : visible[i - 1].id }, isTop, band, showBand));
    });

    if (visible.length) {
      out.push(gapHtml('bottom', '', true));
    } else {
      out.push('<div class="empty">'
        + '<div class="empty-title">File vide</div>'
        + '<div class="empty-text">Ajoutez une tâche ou changez les filtres.</div>'
        + '<button type="button" class="btn btn-primary" data-act="add-tail">' + ICON.plus + '<span>Nouvelle tâche</span></button>'
        + '</div>');
    }

    $('#list').innerHTML = out.join('');
    if (S.ui.dragId) markDrop();
  }

  /* ── Panneau agent ──────────────────────────────────────────────────── */

  function convoMeta(c) {
    var folder = lastSegment(c.cwd);
    var known = Object.prototype.hasOwnProperty.call(S.ui.sessionExists, c.id);
    if (known && !S.ui.sessionExists[c.id]) return agentTag(c) + ' · jamais utilisée · ' + folder;
    var n = c.messageCount || 0;
    return agentTag(c) + ' · ' + n + (n > 1 ? ' messages' : ' message') + ' · ' + fmtDate(c.updated) + ' · ' + folder;
  }

  /* Choix de l'agent puis du modèle : pastilles de préréglages, et un champ libre
     pour tout identifiant que l'outil accepte (`--model`). Vide = modèle par défaut. */
  function newFormAgentHtml() {
    var cur = S.ui.newConvoProvider;
    var p = providerById(cur);
    var custom = S.ui.newConvoCustom || (S.ui.newConvoModel && !catalogHas(catalogFor(cur), S.ui.newConvoModel));
    var h = [];
    h.push('<div class="new-form-block"><div class="new-form-label">Agent</div><div class="seg-dark">');
    h.push(PROVIDERS.map(function (pr) {
      var ok = hasProvider(pr.id);
      return '<button type="button" class="' + (pr.id === cur ? 'on' : '') + '" data-act="pick-provider" data-id="' + esc(pr.id) + '"'
        + (ok ? '' : ' disabled title="' + esc(pr.missing) + '"') + '>' + esc(pr.label) + '</button>';
    }).join(''));
    h.push('</div></div>');
    h.push('<div class="new-form-block"><div class="new-form-label">Modèle</div><div class="model-row">');
    h.push(modelSelectHtml(cur, S.ui.newConvoModel, S.ui.newConvoCustom, 'new-model-select', 'new-model-select', true));
    h.push('<button type="button" class="dark-btn" data-act="refresh-models" data-provider="' + esc(cur) + '"' + (S.ui.modelsBusy[cur] ? ' disabled' : '')
      + ' title="' + esc(refreshModelsTitle(cur)) + '">↻</button>');
    h.push('</div>');
    if (custom) {
      h.push('<input class="dark-input model-input" type="text" data-role="new-model" data-focus-key="new-model" spellcheck="false" '
        + 'placeholder="Identifiant de modèle, ex. ' + esc(p.example) + '" value="' + esc(S.ui.newConvoModel) + '">');
    }
    if (cur === 'copilot') h.push('<div class="model-hint">' + esc(copilotCatalogHint()) + '</div>');
    h.push('</div>');
    h.push('<div class="new-form-block"><div class="new-form-label">Effort</div>');
    h.push(effortSelectHtml(cur, S.ui.newConvoEffort, 'new-effort', 'new-effort', true));
    h.push('</div>');
    return h.join('');
  }

  /* Les mots-clés ne se montrent qu'ici, au moment de lancer l'agent : on en coche autant qu'on
     veut, et on en crée un à la volée s'il manque. Leur consigne part dans le contexte. */
  function newFormKeywordHtml(task) {
    if (!task || task.id === FEEDBACK_ID || typeOf(task.type) === NOTYPE) return '';
    var keywords = keywordsForTask(task);
    var selected = keywordIdsFor(task, S.ui.newConvoKeywords);
    var h = [];
    h.push('<div class="new-form-block keyword-block">');
    h.push('<div class="new-form-label">Mots-clés <span class="new-form-note">' + esc(typeOf(task.type).label) + '</span></div>');
    h.push('<div class="kw-choices">');
    keywords.forEach(function (kw) {
      var on = selected.indexOf(kw.id) >= 0;
      var crew = teamOf(kw).length;
      var tip = (kw.desc || kw.prompt || 'Aucune consigne : seul le mot part avec la tâche.')
        + (crew ? ' — lance une équipe de ' + crew + (crew > 1 ? ' agents : ' : ' agent : ') + teamOf(kw).map(function (a) { return a.name; }).join(', ') : '');
      var mark = crew ? '<span class="kw-team-n">' + esc(crew) + '</span>'
        : (kw.prompt ? '<span class="kw-guided">•</span>' : '');
      h.push('<button type="button" class="kw-choice' + (on ? ' on' : '') + '" data-act="pick-keyword" data-kw="'
        + esc(kw.id) + '" title="' + esc(tip) + '">' + esc(kw.name) + mark + '</button>');
    });
    h.push('<button type="button" class="kw-choice kw-add" data-act="kw-new-open" title="Créer un mot-clé pour cette catégorie">+</button>');
    h.push('</div>');

    if (S.ui.newKeywordOpen) {
      h.push('<div class="kw-new">'
        + '<input class="dark-input" type="text" data-role="new-kw-name" data-focus-key="new-kw-name" spellcheck="false" '
        + 'placeholder="Mot-clé, ex. résolution" value="' + esc(S.ui.newKeywordName) + '">'
        + '<textarea class="dark-input kw-new-prompt" rows="3" data-role="new-kw-prompt" data-focus-key="new-kw-prompt" '
        + 'placeholder="Ce que ce mot-clé demande à l’agent (facultatif)">' + esc(S.ui.newKeywordPrompt) + '</textarea>'
        + draftBoxHtml('new-kw', true)
        + '<label class="kw-new-team"><input type="checkbox" data-act="kw-new-team-toggle"'
        + (S.ui.newKeywordTeam ? ' checked' : '') + '><span>Lance une équipe d’agents</span></label>'
        + (S.ui.newKeywordTeam ? newKeywordTeamHtml() : '')
        + '<div class="kw-new-actions">'
        + draftBtnHtml('kw-new-chat', '', true, 'En discuter')
        + draftBtnHtml('draft-new-keyword', '', true, 'Rédiger')
        + '<span class="kw-new-spacer"></span>'
        + '<button type="button" class="dark-btn" data-act="kw-new-cancel">Annuler</button>'
        + '<button type="button" class="dark-btn dark-btn-primary" data-act="kw-new-save">Ajouter</button>'
        + '</div></div>');
    } else if (selected.length) {
      var chosen = keywordsByIds(task, selected).filter(function (kw) { return kw.desc || kw.prompt || teamOf(kw).length; });
      if (chosen.length) {
        h.push('<div class="kw-hint">' + chosen.map(function (kw) {
          var crew = teamOf(kw);
          return '<b>' + esc(kw.name) + '</b> · ' + esc(firstLine(kw.desc || kw.prompt, 90))
            + (crew.length ? '<span class="kw-hint-team">' + esc(teamLine(crew)) + '</span>' : '');
        }).join('<br>') + '</div>');
      }
    }

    h.push('<button type="button" class="kw-manage" data-act="open-cats">Gérer les mots-clés de la catégorie…</button>');
    h.push('</div>');
    return h.join('');
  }

  /* Équipe du mot-clé qu'on crée depuis le formulaire de lancement : on la fait composer par ✦ et
     on la retouche ensuite dans Catégories — ici, seuls les noms et les rôles se lisent. */
  function newKeywordTeamHtml() {
    var agents = S.ui.newKeywordAgents || [];
    return '<div class="kw-new-agents">'
      + (agents.length
        ? agents.map(function (a) {
          return '<span class="kw-new-agent" title="' + esc(a.prompt || 'Sans mission : à écrire dans Catégories.') + '">'
            + '<b>' + esc(a.name) + '</b>' + (a.role ? '<i>' + esc(a.role) + '</i>' : '')
            + (tuneTag(a) ? '<i class="kw-new-tune">' + esc(tuneTag(a)) + '</i>' : '')
            + '<button type="button" class="kw-x" data-act="kw-new-agent-remove" data-agent="' + esc(a.id)
            + '" title="Retirer cet agent" aria-label="Retirer ' + esc(a.name) + '">×</button></span>';
        }).join('')
        : '<span class="kw-new-agents-empty">Aucun agent pour l’instant.</span>')
      + draftBtnHtml('draft-new-team', '', true, agents.length ? 'Recomposer' : 'Composer l’équipe')
      + '</div>' + draftBoxHtml('new-team', true);
  }

  /* Premier message : la tâche, relue et retouchable avant de partir. Vidé, l'agent ouvre son
     invite et attend — la tâche lui est alors donnée dans le contexte, comme avant. Le carnet de
     remarques n'a pas ce champ : son premier message, ce sont les remarques en attente. */
  function newFormPromptHtml(task) {
    if (!task || task.id === FEEDBACK_ID) return '';
    var text = String(S.ui.newConvoPrompt || '');
    return '<div class="new-form-block">'
      + '<div class="new-form-label">Premier message <span class="new-form-note">part dès l’ouverture ; vidé, l’agent attend</span></div>'
      + '<textarea class="dark-input new-prompt" rows="' + Math.min(10, Math.max(3, text.split('\n').length))
      + '" data-role="new-prompt" data-focus-key="new-prompt" spellcheck="false" '
      + 'placeholder="Ce que l’agent doit faire en ouvrant la session (Ctrl + Entrée pour lancer)">'
      + esc(text) + '</textarea></div>';
  }

  /* Travail déjà fait : le résumé des conversations précédentes, tel qu'il partira dans le contexte
     de l'agent — relisible, retouchable, ou vidé pour ne rien transmettre. Absent quand il n'y a rien. */
  function newFormRecapHtml(task) {
    if (!task || task.id === FEEDBACK_ID) return '';
    var busy = !!S.ui.newConvoRecapBusy;
    var text = String(S.ui.newConvoRecap || '');
    var meta = S.ui.newConvoRecapMeta;
    if (!busy && !text && !meta) return '';
    var note = busy ? 'lecture des conversations précédentes…'
      : (meta ? meta.convos + (meta.convos > 1 ? ' conversations' : ' conversation')
        + (meta.reports ? ' · ' + meta.reports + (meta.reports > 1 ? ' rapports' : ' rapport') : '')
        + ' · part dans le contexte ; vidé, rien ne part' : '');
    return '<div class="new-form-block">'
      + '<div class="new-form-label">Travail déjà fait <span class="new-form-note">' + esc(note) + '</span></div>'
      + (busy
        ? '<div class="new-recap-busy">Lecture des réponses précédentes…</div>'
        : '<textarea class="dark-input new-recap" rows="' + Math.min(8, Math.max(3, text.split('\n').length))
          + '" data-role="new-recap" data-focus-key="new-recap" spellcheck="false" '
          + 'placeholder="Rien à transmettre des conversations précédentes.">' + esc(text) + '</textarea>')
      + '</div>';
  }

  /* ── Lancement sur les sous-tâches ──────────────────────────────────────
     Une tâche de premier niveau dont des sous-tâches restent à faire se lance sur elle-même, ou sur
     chacune d'elles : une conversation par sous-tâche cochée, toutes avec le même agent, le même
     modèle, le même effort et les mêmes mots-clés (voir launchBatch). Jamais le carnet de remarques. */
  function batchSubsOf(task) {
    if (!task || task.id === FEEDBACK_ID || isSub(task)) return [];
    return childrenOf(task.id).filter(function (k) { return !k.done; });
  }

  function batchTargetOn(task) {
    return S.ui.newConvoTarget === 'subs' && batchSubsOf(task).length > 0;
  }

  function batchChosen(task) {
    return batchSubsOf(task).filter(function (k) { return !!S.ui.newConvoSubs[k.id]; });
  }

  function batchSubBusy(sub) {
    return convosOf(sub.id).some(function (c) {
      var st = displayState(c);
      return st === 'working' || st === 'waiting' || st === 'open';
    });
  }

  /* Ce qui fait partir une sous-tâche décochée, ou ce qui lui manquera. */
  function batchSubNote(task, sub) {
    var notes = [];
    if (taskReviews(sub.id).length) notes.push('rapport de revue déjà écrit');
    if (batchSubBusy(sub)) notes.push('conversation en cours');
    var missing = keywordsByIds(task, keywordIdsFor(task, S.ui.newConvoKeywords)).filter(function (kw) {
      return !keywordIdsFor(sub, [kw.name]).length;
    }).map(function (kw) { return kw.name; });
    if (missing.length) notes.push('sans « ' + missing.join(' », « ') + ' » : autre catégorie');
    return notes.join(' · ');
  }

  function newFormTargetHtml(task) {
    var subs = batchSubsOf(task);
    if (!subs.length) return '';
    var on = batchTargetOn(task);
    var off = S.ui.launchBusy ? ' disabled' : '';
    return '<div class="new-form-block"><div class="new-form-label">Lancer sur</div><div class="seg-dark">'
      + '<button type="button" class="' + (on ? '' : 'on') + '" data-act="pick-target" data-id="self"' + off + '>Cette tâche</button>'
      + '<button type="button" class="' + (on ? 'on' : '') + '" data-act="pick-target" data-id="subs"' + off + '>Chaque sous-tâche · '
      + subs.length + '</button>'
      + '</div></div>';
  }

  /* À la place du premier message et du « Travail déjà fait » : chaque sous-tâche a les siens. */
  function newFormSubsHtml(task) {
    var h = ['<div class="new-form-block">'];
    h.push('<div class="new-form-label">Sous-tâches <span class="new-form-note">une conversation chacune, en parallèle</span></div>');
    h.push('<div class="batch-subs">');
    batchSubsOf(task).forEach(function (sub) {
      var on = !!S.ui.newConvoSubs[sub.id];
      var note = batchSubNote(task, sub);
      h.push('<label class="batch-sub' + (on ? ' on' : '') + '"><input type="checkbox" data-role="batch-sub" data-id="' + esc(sub.id) + '"'
        + (on ? ' checked' : '') + (S.ui.launchBusy ? ' disabled' : '') + '>'
        + '<span class="batch-sub-main"><span class="batch-sub-title">' + esc(firstLine(sub.text, 90).trim() || 'Sans titre') + '</span>'
        + (note ? '<span class="batch-sub-note">' + esc(note) + '</span>' : '') + '</span></label>');
    });
    h.push('</div>');
    h.push('<div class="kw-hint">Chaque conversation reçoit le texte de sa sous-tâche et ses pièces jointes comme premier message, '
      + 'et son propre « Travail déjà fait ».</div>');
    h.push('</div>');
    h.push('<div class="new-form-block">'
      + '<div class="new-form-label">Précision pour chaque sous-tâche <span class="new-form-note">facultatif, ajoutée à la fin de chaque premier message</span></div>'
      + '<textarea class="dark-input new-prompt" rows="2" data-role="batch-note" data-focus-key="batch-note" spellcheck="false" '
      + 'placeholder="ex. « concentre-toi sur les régressions »">' + esc(S.ui.newConvoNote) + '</textarea></div>');
    return h.join('');
  }

  function batchLaunchLabel(task) {
    var p = S.ui.batchProgress;
    if (p && p.parentId === task.id) {
      return p.phase === 'recap' ? 'Préparation…' : 'Lancement ' + Math.min(p.done + 1, p.total) + ' / ' + p.total + '…';
    }
    if (S.ui.launchBusy) return 'Lancement…';
    var n = batchChosen(task).length;
    return n ? 'Lancer ' + n + (n > 1 ? ' conversations' : ' conversation') + ' dans PowerShell' : 'Aucune sous-tâche cochée';
  }

  /* Formulaire de lancement : agent, modèle, effort, dossier ; `launchLabel` nomme le bouton. */
  /* Le formulaire est reconstruit à chaque clic (mot-clé coché, modèle changé) : son apparition
     ne se joue qu'au premier rendu, sans quoi le fondu repartirait à chaque fois — ça clignotait. */
  var newFormEntered = false;

  function newFormHtml(launchLabel) {
    var task = taskById(S.ui.termTaskId);
    var enter = newFormEntered ? '' : ' enter';
    newFormEntered = true;
    var batch = batchTargetOn(task);
    return '<div class="new-form' + enter + '">' + newFormTargetHtml(task) + newFormAgentHtml()
      + newFormKeywordHtml(task)
      + (batch ? newFormSubsHtml(task) : newFormPromptHtml(task) + newFormRecapHtml(task))
      + '<div class="new-form-label">Dossier de travail</div>'
      + '<div class="new-form-field">'
      + '<input class="dark-input" type="text" data-role="new-cwd" data-focus-key="new-cwd" spellcheck="false" placeholder="C:\\…" value="'
      + esc(S.ui.newConvoCwd) + '">'
      + '<button type="button" class="dark-btn" data-act="browse-cwd">Parcourir…</button>'
      + '</div>'
      + '<div class="new-form-actions">'
      + '<button type="button" class="dark-btn" data-act="cancel-new-convo">Annuler</button>'
      + (batch
        ? '<button type="button" class="dark-btn dark-btn-primary" data-act="launch-convo"'
          + (S.ui.launchBusy || !batchChosen(task).length ? ' disabled' : '') + '>' + esc(batchLaunchLabel(task)) + '</button>'
        : '<button type="button" class="dark-btn dark-btn-primary" data-act="launch-convo"' + (S.ui.launchBusy ? ' disabled' : '') + '>'
          + esc(S.ui.launchBusy ? 'Lancement…' : launchLabel) + '</button>')
      + '</div></div>';
  }

  /* Mots-clés partis avec la conversation : ils disent d'un coup d'œil ce qu'on a demandé. */
  function convoKeywordsHtml(c) {
    var chosen = keywordsOfConvo(c);
    if (!chosen.length) return '';
    return '<div class="convo-kw">' + chosen.map(function (kw) {
      var crew = teamOf(kw).length;
      var tip = (kw.desc || kw.prompt || '') + (crew ? (kw.desc || kw.prompt ? ' — ' : '') + teamLine(teamOf(kw)) : '');
      return '<span class="convo-kw-tag"' + (tip ? ' title="' + esc(tip) + '"' : '')
        + '>' + esc(kw.name) + (crew ? '<span class="convo-kw-n">' + esc(crew) + '</span>' : '') + '</span>';
    }).join('') + '</div>';
  }

  function convoRemarks(c) {
    return c && Array.isArray(c.remarks) ? c.remarks : [];
  }

  /* Carnet de remarques : ce qui a donné lieu à la conversation — son titre (« Remarques Organizator
     · 2 · 9 sept. ») ne le dit pas —, numéroté comme l'agent l'a reçu, puis ce qu'on lui a renvoyé
     ensuite (↪, avec la date). Chaque remarque tient en trois lignes ; l'infobulle la donne en entier. */
  function convoRemarksHtml(c) {
    var groups = [];
    convoRemarks(c).forEach(function (r) {
      var g = groups[groups.length - 1];
      if (!g || g.at !== r.sentAt) groups.push(g = { at: r.sentAt, items: [] });
      g.items.push(r);
    });
    if (!groups.length) return '';
    return '<div class="convo-remarks">' + groups.map(function (g, gi) {
      return (gi ? '<div class="convo-remarks-again">↪ envoyée' + (g.items.length > 1 ? 's' : '') + ' le ' + esc(fmtDate(g.at)) + '</div>' : '')
        + g.items.map(function (r, i) {
          return '<div class="convo-remark" title="' + esc(r.text) + '"><span class="convo-remark-num">' + (i + 1) + '</span>'
            + '<span class="convo-remark-text">' + esc(String(r.text).trim()) + '</span></div>';
        }).join('');
    }).join('') + '</div>';
  }

  /* Liste des sessions. Dans le carnet de remarques, chaque session propose d'y envoyer
     les remarques en attente (reprise avec un nouveau message), et montre celles qu'elle a reçues. */
  function convoListHtml(convs, feedback) {
    var pending = feedback ? pendingRemarks().length : 0;
    return '<div class="convo-list">' + convs.map(function (c) {
      var artifactCount = artifactsOf(c).length;
      var reportCount = reportsOf([c]).length;
      return '<div class="convo">'
        + '<button type="button" class="convo-open" data-act="resume-convo" data-id="' + esc(c.id)
        + '" title="Reprendre cette session dans PowerShell">'
        + '<div class="convo-title">' + esc(c.title || 'Nouvelle session')
        + (reportCount ? '<span class="convo-artifacts" title="' + esc(reportCount + (reportCount > 1 ? ' rapports produits' : ' rapport produit')) + '">'
          + ICON.artifacts + ' ' + esc(reportCount) + '</span>' : '')
        + '</div>'
        + (feedback ? convoRemarksHtml(c) : '')
        + convoKeywordsHtml(c)
        + stateHtml(c)
        + saidHtml(c)
        + '<div class="convo-meta">' + esc(convoMeta(c)) + '</div>'
        + (c.usage ? '<div class="convo-usage" title="' + esc(usageTip(c.usage, 'Consommation de la conversation')) + '">'
          + ICON.gauge + '<span>' + esc(usageText(c.usage)) + '</span></div>' : '')
        + '</button>'
        + (pending ? '<button type="button" class="convo-btn" data-act="send-remarks-here" data-id="' + esc(c.id)
          + '" title="Envoyer les remarques en attente dans cette session">↪</button>' : '')
        + (artifactCount ? '<button type="button" class="convo-btn" data-act="open-artifacts-convo" data-id="' + esc(c.id)
          + '" title="Voir ce que cette session a produit">' + ICON.artifacts + '</button>' : '')
        + '<button type="button" class="convo-btn" data-act="open-transcript" data-id="' + esc(c.id)
        + '" title="Voir le journal">' + ICON.eye + '</button>'
        + '<button type="button" class="convo-btn" data-act="remove-convo" data-id="' + esc(c.id)
        + '" title="Supprimer la conversation">✕</button>'
        + '</div>';
    }).join('') + '</div>';
  }

  function artifactsPanelHtml(taskId) {
    var selected = S.ui.artifactConvId ? convoById(S.ui.artifactConvId) : null;
    var convs = selected && selected.taskId === taskId ? [selected] : convosOf(taskId);
    var reports = reportsOf(convs);
    var work = artifactEntries(convs, 'work');
    var files = artifactEntries(convs, 'file');
    var h = ['<div class="panel-body">'];
    h.push('<div class="panel-kicker">' + (selected ? 'Rapports de la session' : 'Rapports') + ' · ' + reports.length + '</div>');
    if (reports.length) {
      h.push('<div class="artifact-list">' + reports.map(function (a, i) { return artifactRowHtml(a, i === 0 && reports.length > 1); }).join('') + '</div>');
    } else {
      h.push('<div class="panel-note">' + (work.length || files.length
        ? 'Aucun rapport : l’agent n’a cité aucun document dans ses réponses. Ce qu’il a écrit en chemin est ci-dessous.'
        : 'Aucun fichier produit n’a encore été détecté dans les sessions de cette tâche.') + '</div>');
    }

    /* Brouillons, notes des sous-agents, mémoire : à portée, mais repliés. */
    if (work.length) {
      h.push('<button type="button" class="artifact-toggle' + (S.ui.artifactWorkOpen ? ' open' : '')
        + '" data-act="toggle-artifact-work"><span class="artifact-caret">›</span>'
        + esc(work.length + (work.length > 1 ? ' documents de travail' : ' document de travail'))
        + '<span class="artifact-toggle-sub">brouillons, notes des sous-agents, mémoire</span></button>');
      if (S.ui.artifactWorkOpen) {
        h.push('<div class="artifact-list artifact-files">' + work.map(function (a) { return artifactRowHtml(a); }).join('') + '</div>');
      }
    }

    if (files.length) {
      h.push('<button type="button" class="artifact-toggle' + (S.ui.artifactFilesOpen ? ' open' : '')
        + '" data-act="toggle-artifact-files"><span class="artifact-caret">›</span>'
        + esc(files.length + (files.length > 1 ? ' fichiers modifiés' : ' fichier modifié')) + '</button>');
      if (S.ui.artifactFilesOpen) {
        h.push('<div class="artifact-list artifact-files">' + files.map(function (a) { return artifactRowHtml(a); }).join('') + '</div>');
      }
    }

    h.push('<button type="button" class="new-convo-btn artifact-back" data-act="back-to-list">‹ Retour aux conversations</button>');
    h.push('</div>');
    return h.join('');
  }

  function panelListHtml(taskId) {
    var convs = convosOf(taskId);
    var h = [];

    if (S.ui.newConvoOpen) {
      h.push(newFormHtml('Lancer dans PowerShell'));
    } else {
      h.push('<button type="button" class="new-convo-btn" data-act="new-convo">+ Nouvelle conversation</button>');
    }

    var spent = usageOf(convs);
    h.push('<div class="panel-kicker">Conversations' + (spent ? '<span class="panel-kicker-usage" title="' + esc(usageTip(spent, 'Consommation de la tâche')) + '"> · ' + esc(usageText(spent)) + '</span>' : '') + '</div>');
    if (!convs.length) {
      h.push('<div class="panel-note">Aucune conversation pour cette tâche.</div>');
    } else {
      h.push(convoListHtml(convs, false));
    }
    return '<div class="panel-body">' + h.join('') + '</div>';
  }

  /* Carnet de remarques : saisie, liste numérotée (l'agent reçoit les mêmes numéros), envoi,
     sessions déjà ouvertes, puis l'historique des remarques envoyées. */
  /* Hauteur initiale d'une zone de remarque, d'après ses retours à la ligne ; les lignes
     repliées sont rattrapées par fitRemark une fois l'élément dans le document. */
  function remarkRows(text) { return Math.max(1, String(text || '').split('\n').length); }

  /* Une remarque se lit en entier : la zone prend la hauteur de son contenu, lignes repliées
     comprises (`rows` ne compte que les retours à la ligne et tronquait les remarques longues).
     Sans effet tant que l'élément n'est pas affiché (rien à mesurer). */
  function fitRemark(el) {
    el.style.height = '';
    if (!el.scrollHeight) return;
    el.style.height = (el.scrollHeight + el.offsetHeight - el.clientHeight) + 'px';
  }

  function fitRemarks(host) {
    var list = host.querySelectorAll('textarea[data-role="remark-text"], textarea[data-role="remark-new"]');
    for (var i = 0; i < list.length; i++) fitRemark(list[i]);
  }

  function feedbackHtml() {
    var pending = pendingRemarks();
    var sent = sentRemarks();
    var convs = convosOf(FEEDBACK_ID);
    var n = pending.length;
    var h = [];

    h.push('<div class="panel-kicker">Remarques à envoyer' + (n ? ' · ' + n : '') + '</div>');
    h.push('<div class="remark-add">'
      + '<textarea class="dark-input remark-input" rows="' + remarkRows(S.ui.remarkText) + '" data-role="remark-new" data-focus-key="remark-new" '
      + 'placeholder="Ce qui vous gêne, ce qui manque, ce que vous changeriez… (Ctrl + Entrée pour ajouter)">' + esc(S.ui.remarkText) + '</textarea>'
      + '<div class="remark-add-row"><button type="button" class="dark-btn" data-act="add-remark">Ajouter la remarque</button></div>'
      + '</div>');

    if (n) {
      h.push('<div class="remark-list">' + pending.map(function (r, i) {
        return '<div class="remark"><span class="remark-num">' + (i + 1) + '</span>'
          + '<textarea class="remark-text" rows="' + remarkRows(r.text) + '" data-role="remark-text" data-focus-key="remark-' + esc(r.id)
          + '" data-id="' + esc(r.id) + '" spellcheck="false">' + esc(r.text) + '</textarea>'
          + '<button type="button" class="convo-btn" data-act="remove-remark" data-id="' + esc(r.id) + '" title="Supprimer la remarque">✕</button>'
          + '</div>';
      }).join('') + '</div>');
    } else {
      h.push('<div class="panel-note">Aucune remarque en attente. Notez ici, au fil de l’eau, ce que vous voudriez changer dans Organizator ; vous enverrez le tout d’un coup à un agent.</div>');
    }

    if (S.ui.newConvoOpen) {
      h.push(newFormHtml('Envoyer ' + n + (n > 1 ? ' remarques' : ' remarque') + ' dans PowerShell'));
    } else {
      /* Envoi direct : agent, modèle et effort par défaut, dans le dépôt. Le bouton dit où et avec quoi. */
      var provider = defaultProviderId();
      var target = [defaultCwdFor(FEEDBACK_ID) || 'dossier des sources à indiquer',
        S.settings[modelSettingKey(provider)] || 'modèle par défaut', S.settings[effortSettingKey(provider)]].filter(Boolean).join(' · ');
      h.push('<button type="button" class="new-convo-btn" data-act="send-remarks"' + (S.ui.launchBusy ? ' disabled' : '') + '>'
        + esc(S.ui.launchBusy ? 'Lancement de l’agent…' : 'Envoyer à ' + providerById(provider).label + ' →')
        + '<span class="new-convo-sub">' + esc(target) + '</span></button>');
      h.push('<div class="feedback-alt"><button type="button" class="panel-link" data-act="new-convo">Choisir l’agent, le modèle ou le dossier…</button></div>');
    }

    h.push('<div class="panel-kicker">Conversations</div>');
    if (!convs.length) {
      h.push('<div class="panel-note">Aucune session encore. L’agent démarre dans les sources d’Organizator et reçoit vos remarques comme premier message.</div>');
    } else {
      h.push(convoListHtml(convs, true));
    }

    if (sent.length) {
      h.push('<div class="remark-sent"><button type="button" class="remark-sent-toggle" data-act="toggle-sent">'
        + (S.ui.sentOpen ? '▾' : '▸') + ' Déjà envoyées · ' + sent.length + '</button>');
      if (S.ui.sentOpen) {
        h.push(sent.map(function (r) {
          return '<div class="remark-old"><div class="remark-old-text">' + esc(r.text) + '</div>'
            + '<div class="remark-old-meta">' + esc(fmtDate(r.sentAt)) + '</div></div>';
        }).join(''));
        h.push('<div class="remark-sent-actions"><button type="button" class="dark-btn" data-act="clear-sent-remarks">Effacer l’historique</button></div>');
      }
      h.push('</div>');
    }
    return '<div class="panel-body">' + h.join('') + '</div>';
  }

  /* ── Journal ────────────────────────────────────────────────────────────
     Le journal se lit comme une conversation : vos messages dans une bulle, les réponses de
     l'agent rendues en Markdown (titres, listes, code, tableaux, citations, liens), et ses appels
     d'outils — que l'hôte écrit « [outil : X] », une ligne chacun — regroupés en une ligne
     discrète (« Read ×3 · Edit · Bash »). Le rendu se fait ici, texte échappé d'abord : rien de
     ce que l'agent écrit ne devient du HTML actif, seuls les liens http(s) deviennent cliquables
     (ouverts dans le navigateur). Un message très long — la tâche entière et ses pièces jointes,
     une liste de remarques — se replie après LOG_FOLD_LINES lignes ; « Afficher tout » le déplie. */
  var TOOL_LINE = /^\s*\[outil\s*:\s*([^\]]*)\]\s*$/;
  var LIST_LINE = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
  var LOG_FOLD_LINES = 14;
  var LOG_FOLD_CHARS = 1400;
  /* Rendu Markdown d'un message, par texte : le journal est relu toutes les deux secondes. */
  var logHtmlMemo = {};
  var logHtmlMemoSize = 0;

  function mdLinkHtml(url, label) {
    return '<a class="md-link" draggable="false" data-act="open-url" data-url="' + esc(url)
      + '" title="' + esc(url) + '">' + esc(label) + '</a>';
  }

  /* Une ligne : code entre accents graves, liens, gras, italique, barré. Le code et les liens sont
     mis de côté avant l'échappement, pour que leur contenu ne soit pas réinterprété. */
  function mdInline(raw) {
    var keep = [];
    function hold(html) { keep.push(html); return '\u0000' + (keep.length - 1) + '\u0000'; }
    var s = String(raw == null ? '' : raw).replace(/\u0000/g, '');
    s = s.replace(/`([^`\n]+)`/g, function (m, code) { return hold('<code>' + esc(code) + '</code>'); });
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (m, label, url) { return hold(mdLinkHtml(url, label)); });
    s = s.replace(/https?:\/\/[^\s<>"'`\u0000]+/g, function (m) {
      var url = m.replace(/[.,;:!?)\]]+$/, '');
      return hold(mdLinkHtml(url, url)) + m.slice(url.length);
    });
    s = esc(s)
      .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__([^_\n]+?)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return keep[+i]; });
  }

  /* Appels d'outils consécutifs : un nom par outil, dans l'ordre d'apparition, avec leur nombre.
     Un outil MCP (« mcp__bitbucket__get_diff ») se lit par son dernier segment. */
  function logToolsHtml(names) {
    var order = [], n = {};
    names.forEach(function (x) { if (!n[x]) { n[x] = 0; order.push(x); } n[x]++; });
    return '<div class="msg-tools" title="' + esc(names.length + (names.length > 1 ? ' appels d’outils : ' : ' appel d’outil : ') + order.join(', ')) + '">'
      + '<span class="msg-tools-icon">' + ICON.tool + '</span>'
      + order.map(function (x) {
        var short = /^mcp__/.test(x) ? x.split('__').pop() : x;
        return '<span class="msg-tool">' + esc(short) + (n[x] > 1 ? '<span class="msg-tool-n">×' + n[x] + '</span>' : '') + '</span>';
      }).join('') + '</div>';
  }

  function mdTableHtml(rows) {
    function cells(line) {
      return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
    }
    var head = cells(rows[0]);
    return '<div class="md-table-wrap"><table class="md-table"><thead><tr>'
      + head.map(function (c) { return '<th>' + mdInline(c) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + rows.slice(1).map(function (r) {
        return '<tr>' + cells(r).map(function (c) { return '<td>' + mdInline(c) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* Blocs : code délimité, lignes d'outils, titres, filets, tableaux, citations, listes (cases à
     cocher comprises, numérotation gardée d'un bloc à l'autre), paragraphes. */
  function mdBlocksHtml(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var out = [], para = [], list = null, i = 0;
    function flushPara() { if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; } }
    function flushList() { if (list) { out.push('<' + list.tag + ' class="md-list">' + list.items.join('') + '</' + list.tag + '>'); list = null; } }
    function flush() { flushPara(); flushList(); }
    while (i < lines.length) {
      var line = lines[i];
      var fence = /^\s*(`{3,}|~{3,})\s*[\w+#.-]*\s*$/.exec(line);
      if (fence) {
        flush();
        var close = new RegExp('^\\s*' + (fence[1].charAt(0) === '`' ? '`' : '~') + '{' + fence[1].length + ',}\\s*$');
        var code = [];
        for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i]);
        i++;
        out.push('<pre class="md-code"><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if (TOOL_LINE.test(line)) {
        flush();
        var names = [];
        while (i < lines.length && (TOOL_LINE.test(lines[i]) || (!lines[i].trim() && TOOL_LINE.test(lines[i + 1] || '')))) {
          var t = TOOL_LINE.exec(lines[i]);
          if (t) names.push(t[1].trim() || '?');
          i++;
        }
        out.push(logToolsHtml(names));
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      var h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) { flush(); out.push('<div class="md-h md-h' + Math.min(h[1].length, 4) + '">' + mdInline(h[2]) + '</div>'); i++; continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr class="md-hr">'); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
        flush();
        var rows = [line];
        for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
        out.push(mdTableHtml(rows));
        continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        flush();
        var quote = [];
        for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        out.push('<blockquote class="md-quote">' + quote.map(mdInline).join('<br>') + '</blockquote>');
        continue;
      }
      var li = LIST_LINE.exec(line);
      if (li) {
        flushPara();
        var tag = /\d/.test(li[2]) ? 'ol' : 'ul';
        var depth = Math.min(3, Math.floor(li[1].replace(/\t/g, '  ').length / 2));
        if (list && list.tag !== tag && !depth) flushList();
        if (!list) list = { tag: tag, items: [] };
        var box = /^\[([ xX])\]\s+(.*)$/.exec(li[3]);
        var item = box ? '<span class="md-box">' + (box[1] === ' ' ? '☐' : '☑') + '</span> ' + mdInline(box[2]) : mdInline(li[3]);
        /* Lignes suivantes en retrait : la suite du même élément. */
        for (i++; i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_LINE.test(lines[i]) && !TOOL_LINE.test(lines[i]); i++) {
          item += '<br>' + mdInline(lines[i].trim());
        }
        list.items.push('<li' + (depth ? ' class="md-d' + depth + '"' : '')
          + (tag === 'ol' && !depth ? ' value="' + parseInt(li[2], 10) + '"' : '') + '>' + item + '</li>');
        continue;
      }
      flushList();
      para.push(line.trim());
      i++;
    }
    flush();
    return out.join('');
  }

  function logMsgHtml(text) {
    var key = String(text == null ? '' : text);
    var hit = logHtmlMemo[key];
    if (hit != null) return hit;
    if (logHtmlMemoSize > 600) { logHtmlMemo = {}; logHtmlMemoSize = 0; }
    logHtmlMemoSize++;
    return (logHtmlMemo[key] = mdBlocksHtml(key));
  }

  function logLong(text) {
    var s = String(text || '');
    return s.length > LOG_FOLD_CHARS || s.split('\n').length > LOG_FOLD_LINES;
  }

  function logMessagesHtml(c, messages) {
    var open = S.ui.logOpen || {};
    return messages.map(function (m, i) {
      var user = m.role === 'user';
      var k = c.id + ':' + i + ':' + String(m.text || '').length;
      var fold = user && logLong(m.text) && !open[k];
      var at = fmtTime(m.ts);
      return '<div class="msg ' + (user ? 'user' : 'assistant') + '">'
        + '<div class="msg-head"><span class="msg-role">' + (user ? 'Vous' : 'Agent') + '</span>'
        + (at ? '<span class="msg-time">' + esc(at) + '</span>' : '') + '</div>'
        + '<div class="msg-body md' + (fold ? ' is-folded' : '') + '">' + logMsgHtml(m.text) + '</div>'
        + (user && logLong(m.text)
          ? '<button type="button" class="msg-unfold" data-act="log-fold" data-k="' + esc(k) + '">'
            + (fold ? 'Afficher tout ▾' : 'Replier ▴') + '</button>'
          : '')
        + '</div>';
    }).join('');
  }

  function panelTranscriptHtml(c) {
    var tr = S.ui.transcript;
    var body;
    if (!tr) {
      body = '<div class="log-note">Lecture du journal…</div>';
    } else if (tr.error) {
      body = '<div class="log-note">Journal illisible : ' + esc(tr.error) + '</div>';
    } else if (!tr.exists) {
      body = '<div class="log-note">Cette session n’a pas encore de messages. Reprenez-la dans PowerShell pour commencer.</div>';
    } else if (!tr.messages || !tr.messages.length) {
      body = '<div class="log-note">Cette session n’a pas encore de messages. Reprenez-la dans PowerShell pour commencer.</div>';
    } else {
      body = logMessagesHtml(c, tr.messages) + logStateHtml(c);
    }
    var footState = stateText(c);
    return '<div class="log">' + body + '</div>'
      + '<div class="panel-foot">'
      + '<div class="foot-cwd" title="' + esc(c.cwd) + '">'
      + (footState ? '<span class="foot-state st-' + esc(displayState(c)) + '">' + esc(footState) + '</span> · ' : '')
      + esc(agentTag(c) + ' · ' + (c.cwd || '—')) + '</div>'
      + '<button type="button" class="resume-btn" data-act="resume-convo" data-id="' + esc(c.id) + '">Reprendre dans PowerShell</button>'
      + '</div>';
  }

  function renderPanel() {
    var host = $('#panel');
    if (!S.ui.termTaskId) {
      if (host.innerHTML) host.innerHTML = '';
      panelKey = null;
      return;
    }
    var feed = feedOfPanel(S.ui.termTaskId);
    var task = feed ? null : taskById(S.ui.termTaskId);
    if (!task && !feed) { host.innerHTML = ''; panelKey = null; S.ui.termTaskId = null; return; }

    var oldLog = host.querySelector('.log');
    var oldBody = host.querySelector('.panel-body');
    var atBottom = oldLog ? (oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 24) : true;
    var logScroll = oldLog ? oldLog.scrollTop : 0;
    var bodyScroll = oldBody ? oldBody.scrollTop : 0;
    var isNew = panelKey !== S.ui.termTaskId;

    var conv = S.ui.termConvId ? convoById(S.ui.termConvId) : null;
    if (S.ui.termConvId && !conv) S.ui.termConvId = null;

    var h = [];
    h.push('<div class="panel' + (isNew ? ' enter' : '') + '">');
    h.push('<div class="panel-bar">'
      + '<span class="dots"><span class="dot-1"></span><span class="dot-2"></span><span class="dot-3"></span></span>'
      + '<span class="panel-title">' + esc(feed ? feed.title
        : (task.id === FEEDBACK_ID ? 'remarques — Organizator' : 'agent — ' + firstLine(task.text, 40))) + '</span>'
      + '<span class="panel-spacer"></span>'
      + (conv ? '<button type="button" class="panel-link" data-act="back-to-list">‹ historique</button>' : '')
      + '<button type="button" class="panel-x" data-act="close-term" title="Fermer">✕</button>'
      + '</div>');
    h.push(feed ? articlePanelHtml(feed)
      : conv ? panelTranscriptHtml(conv)
      : (S.ui.artifactView ? artifactsPanelHtml(S.ui.termTaskId)
        : (task.id === FEEDBACK_ID ? feedbackHtml() : panelListHtml(S.ui.termTaskId))));
    h.push('</div>');

    host.innerHTML = h.join('');
    panelKey = S.ui.termTaskId;
    fitRemarks(host);

    var log = host.querySelector('.log');
    if (log) log.scrollTop = atBottom ? log.scrollHeight : logScroll;
    var body = host.querySelector('.panel-body');
    if (body && !isNew) body.scrollTop = bodyScroll;
  }

  /* ── Dialogues ──────────────────────────────────────────────────────── */

  function composerHtml(enter) {
    var types = S.data.types;
    var hint = types.length === 0 ? 'Créez d’abord une catégorie.' : (S.ui.composerType ? '' : 'Choisissez une catégorie.');
    var parent = S.ui.composerParent ? taskById(S.ui.composerParent) : null;
    var h = [];
    h.push('<div class="dialog-backdrop">');
    h.push('<div class="dialog composer-dialog' + (enter ? ' enter' : '') + '" data-act="noop" role="dialog" aria-label="'
      + (parent ? 'Nouvelle sous-tâche' : 'Nouvelle tâche') + '">');
    h.push('<div class="dialog-title">' + (parent ? 'Nouvelle sous-tâche' : 'Nouvelle tâche') + '</div>');
    /* Sous-tâche : on dit de quoi, et la catégorie du parent est proposée d'office. */
    if (parent) {
      h.push('<div class="composer-parent">' + ICON.subtask + '<span>Sous-tâche de « ' + esc(firstLine(parent.text, 90).trim()) + ' »</span></div>');
    }

    h.push('<div class="composer-types">');
    h.push(types.map(function (ty) {
      var on = S.ui.composerType === ty.id;
      var style = on ? ' style="border-color:' + esc(color(ty.bd, 'var(--color-neutral-300)'))
        + ';background:' + esc(color(ty.bg, 'transparent')) + ';color:' + esc(color(ty.fg, 'var(--color-neutral-600)')) + '"' : '';
      return '<button type="button" class="opt-chip" data-act="pick-type" data-id="' + esc(ty.id)
        + '" title="Clic droit pour supprimer la catégorie"' + style + '>' + esc(ty.label) + '</button>';
    }).join(''));
    h.push('<button type="button" class="new-cat-btn" data-act="open-cat" title="Créer une catégorie">+ catégorie</button>');
    h.push('<button type="button" class="new-cat-btn" data-act="open-cats" title="Gérer les catégories et leurs mots-clés">gérer…</button>');
    h.push('</div>');

    if (S.ui.catFormOpen) {
      h.push('<div class="cat-form">');
      h.push('<input class="input cat-name" type="text" data-role="cat-name" data-focus-key="cat-name" placeholder="Nom de la catégorie" value="'
        + esc(S.ui.catName) + '">');
      h.push('<div class="palettes">' + PALETTES.map(function (p) {
        return '<button type="button" class="palette' + (S.ui.catPalette === p.id ? ' sel' : '') + '" data-act="pick-palette" data-id="'
          + esc(p.id) + '" title="' + esc(p.title) + '" aria-label="' + esc(p.title)
          + '" style="background:' + esc(p.bg) + ';border-color:' + esc(p.bd) + '"></button>';
      }).join('') + '</div>');
      h.push('<span class="cat-form-spacer"></span>');
      h.push('<button type="button" class="btn btn-ghost" data-act="close-cat">Annuler</button>');
      h.push('<button type="button" class="btn btn-secondary" data-act="add-cat">Créer la catégorie</button>');
      h.push('</div>');
    }

    /* L'aperçu des PRs Bitbucket prend la place de la zone de texte : la catégorie choisie
       au-dessus est celle des tâches à créer. */
    if (S.ui.prImport) {
      h.push(prImportHtml(hint));
      h.push('</div></div>');
      return h.join('');
    }

    h.push('<textarea class="input composer-text" rows="3" data-role="composer-text" data-focus-key="composer-text" '
      + 'placeholder="' + (parent ? 'Décrivez la sous-tâche…' : 'Décrivez la tâche…') + ' (plusieurs lignes possibles, Cmd/Ctrl + Entrée pour ajouter)">'
      + esc(S.ui.composerText) + '</textarea>');
    h.push(draftBoxHtml('composer', false));
    if (S.ui.composerId) h.push(attachmentsHtml(S.ui.composerId, S.ui.composerAttachments, true));

    h.push('<div class="dialog-actions">'
      + draftBtnHtml('draft-composer', '', false, 'Rédiger à partir du titre')
      + (parent ? '' : prImportBtnHtml())
      + '<span class="dialog-hint">' + esc(hint) + '</span>'
      + '<button type="button" class="btn btn-ghost" data-act="close-composer">Annuler</button>'
      + '<button type="button" class="btn btn-primary" data-act="add-task"' + (S.ui.composerType ? '' : ' disabled')
      + '>' + (parent ? 'Ajouter la sous-tâche' : 'Ajouter la tâche') + '</button>'
      + '</div>');

    h.push('</div></div>');
    return h.join('');
  }

  /* ── PRs Bitbucket en attente ──────────────────────────────────────────
     « Mes PRs Bitbucket », dans Nouvelle tâche : l'hôte demande au tableau de bord de Bitbucket les
     pull requests ouvertes où l'utilisateur est relecteur et n'a pas encore donné son avis ; l'UI les
     regroupe par ticket Jira (la clé lue dans la branche, sinon dans le titre) et propose une tâche
     par ticket, à cocher. Une tâche encore en file pour le même ticket n'est pas doublée : si de
     nouvelles PRs s'y rattachent, elles y sont ajoutées. Une tâche ainsi créée porte son ticket
     (`task.jira`) et les adresses de ses PRs (`task.prs`) ; une tâche terminée ne compte plus — la
     PR qui revient après de nouveaux commits fait une nouvelle tâche. */

  function prImportBtnHtml() {
    return '<button type="button" class="draft-btn" data-act="pr-import"'
      + ' title="Lister mes PRs Bitbucket qui attendent ma relecture, et en faire une tâche par ticket">'
      + ICON.pullRequest + 'Mes PRs Bitbucket</button>';
  }

  function prImportHtml(hint) {
    var im = S.ui.prImport;
    var h = [];
    h.push('<div class="pr-import">');
    if (im.busy) {
      h.push('<div class="draft-wait"><span class="draft-spin"></span>Lecture des pull requests'
        + (im.host ? ' sur ' + esc(im.host) : '') + '…</div>');
    } else if (im.error) {
      h.push('<div class="pr-import-error">' + esc(im.error) + '</div>');
    } else if (!im.groups.length) {
      h.push('<div class="pr-import-empty">Aucune pull request n’attend votre avis'
        + (im.account ? ' (' + esc(im.account) + ')' : '') + '.</div>');
    } else {
      h.push('<div class="pr-import-lead">' + esc(prImportLead(im)) + '</div>');
      h.push('<div class="pr-groups">' + im.groups.map(prGroupHtml).join('') + '</div>');
      h.push(prGroupToggleHtml(im));
    }
    h.push('</div>');

    var n = prImportCounts();
    var label = prImportGrouped(im)
      ? 'Créer la revue générale · ' + n.create + (n.create > 1 ? ' sous-tâches' : ' sous-tâche')
        + (n.update ? ', compléter ' + n.update + (n.update > 1 ? ' tâches' : ' tâche') : '')
      : !n.create && !n.update ? 'Créer les tâches'
      : (n.create ? 'Créer ' + (n.create > 1 ? n.create + ' tâches' : 'une tâche') : '')
        + (n.create && n.update ? ', ' : '')
        + (n.update ? (n.create ? 'compléter ' : 'Compléter ') + (n.update > 1 ? n.update + ' tâches' : 'une tâche') : '');
    h.push('<div class="dialog-actions">'
      + '<button type="button" class="btn btn-ghost" data-act="pr-import-close">‹ Retour</button>'
      + '<span class="dialog-hint">' + esc(hint) + '</span>'
      + (im.error && !im.busy ? '<button type="button" class="btn btn-secondary" data-act="pr-import-retry">Réessayer</button>' : '')
      + '<button type="button" class="btn btn-ghost" data-act="close-composer">Annuler</button>'
      + '<button type="button" class="btn btn-primary" data-act="pr-import-create"'
      + ((n.create || n.update) && S.ui.composerType && !im.busy ? '' : ' disabled') + '>' + esc(label) + '</button>'
      + '</div>');
    return h.join('');
  }

  /* Revue générale : une tâche datée porte les tickets créés en sous-tâches — lancée sur ses
     sous-tâches, elle ouvre une conversation par ticket. Les tâches déjà en file qu'on complète
     restent où elles sont. Sans ticket à créer, il n'y a rien à regrouper. */
  function prGroupTitle() {
    return 'Revue générale · ' + new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  }

  function prImportGrouped(im) {
    return !!(im && im.group && !im.busy && !im.error && prImportCounts().create > 0);
  }

  function prGroupToggleHtml(im) {
    var off = !prImportCounts().create;
    return '<label class="pr-import-group' + (off ? ' is-off' : '') + '">'
      + '<input type="checkbox" class="pr-check" data-role="pr-group-toggle"' + (im.group && !off ? ' checked' : '') + (off ? ' disabled' : '') + '>'
      + '<span class="pr-import-group-main"><span class="pr-import-group-title">Regrouper sous une revue générale</span>'
      + '<span class="pr-import-group-note">une tâche « ' + esc(prGroupTitle()) + ' », les tickets en sous-tâches</span></span>'
      + '</label>';
  }

  function prImportLead(im) {
    var total = 0;
    im.groups.forEach(function (g) { total += g.prs.length; });
    var parts = [im.groups.length + (im.groups.length > 1 ? ' tickets' : ' ticket'),
      total + (total > 1 ? ' PRs' : ' PR') + ' en attente de votre avis'];
    if (im.account) parts.push(im.account);
    if (im.host) parts.push(im.host);
    return parts.join(' · ');
  }

  function prGroupHtml(g) {
    var im = S.ui.prImport;
    var same = g.status === 'same';
    var on = !same && !!im.checked[g.id];
    var badge = same ? '<span class="pr-badge">déjà en file</span>'
      : (g.status === 'update' ? '<span class="pr-badge pr-badge-more">déjà en file · +' + g.fresh + ' PR</span>' : '');
    return '<label class="pr-group' + (same ? ' is-same' : '') + (on ? ' on' : '') + '">'
      + '<input type="checkbox" class="pr-check" data-role="pr-check" data-id="' + esc(g.id) + '"'
      + (on ? ' checked' : '') + (same ? ' disabled' : '') + '>'
      + '<div class="pr-group-main">'
      + '<div class="pr-head">'
      + (g.key ? '<span class="pr-key">' + esc(g.key) + '</span>' : '')
      + '<span class="pr-title">' + esc(g.title) + '</span>' + badge + '</div>'
      + '<div class="pr-lines">' + g.prs.map(function (p) {
        var meta = [p.author, fmtTime(p.updated)];
        if (p.comments) meta.push(p.comments + (p.comments > 1 ? ' commentaires' : ' commentaire'));
        if (p.openTasks) meta.push(p.openTasks + (p.openTasks > 1 ? ' tâches ouvertes' : ' tâche ouverte'));
        if (p.draft) meta.push('brouillon');
        return '<div class="pr-line' + (p.known ? ' is-known' : '') + '">'
          + '<button type="button" class="pr-link" data-act="open-url" data-url="' + esc(p.url)
          + '" title="Ouvrir la pull request dans le navigateur">' + esc(p.project + '/' + p.repo + ' #' + p.id) + '</button>'
          + '<span class="pr-branch" title="' + esc(p.branch + ' → ' + p.target) + '">' + esc(p.branch) + ' → ' + esc(p.target) + '</span>'
          + '<span class="pr-meta">' + esc(meta.filter(Boolean).join(' · ')) + '</span>'
          + '</div>';
      }).join('') + '</div>'
      + '</div></label>';
  }

  /* Un groupe par ticket Jira, dans l'ordre d'ouverture des PRs (la plus ancienne attend depuis le
     plus longtemps) ; une PR sans clé fait son propre groupe. */
  function groupPullRequests(prs) {
    var byId = {}, groups = [];
    prs.slice().sort(function (a, b) { return (toMs(a.created) || 0) - (toMs(b.created) || 0); }).forEach(function (p) {
      var id = p.key ? 'k:' + p.key : 'u:' + p.url;
      var g = byId[id];
      if (!g) { g = byId[id] = { id: id, key: p.key || '', prs: [], title: '' }; groups.push(g); }
      g.prs.push(p);
    });
    groups.forEach(function (g) { g.title = prTitle(g.prs[0].title, g.key); });
    return groups;
  }

  /* « Feature/UDM-1449 contact update… », « [UDM-1532] fix… », « Bugfix/UDM-1621 Add logs » :
     le titre sans le préfixe de branche ni la clé, qui est déjà en tête de la tâche. */
  function prTitle(title, key) {
    var t = String(title || '').replace(/\s+/g, ' ').trim();
    if (key) {
      t = t.replace(new RegExp('^(?:(?:feature|bugfix|hotfix|fix|release|chore|task|story)\\/)?\\s*\\[?' + key + '\\]?\\s*[:\\-–·]?\\s*', 'i'), '');
    }
    t = t.trim();
    if (!t) return key || 'Pull request';
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function taskHasPr(t, url) {
    return (Array.isArray(t.prs) && t.prs.indexOf(url) >= 0) || String(t.text || '').indexOf(url) >= 0;
  }

  /* Une tâche encore en file pour ce ticket (ou pour l'une de ses PRs) n'est pas doublée.
     `new` : rien en file ; `update` : la tâche existe et des PRs lui manquent ; `same` : tout y est. */
  function prGroupStatus(g) {
    var active = S.data.tasks.filter(function (t) { return !t.done; });
    var task = null;
    if (g.key) task = active.filter(function (t) { return t.jira === g.key; })[0] || null;
    if (!task) task = active.filter(function (t) { return g.prs.some(function (p) { return taskHasPr(t, p.url); }); })[0] || null;
    g.prs.forEach(function (p) { p.known = !!task && taskHasPr(task, p.url); });
    g.fresh = g.prs.filter(function (p) { return !p.known; }).length;
    g.taskId = task ? task.id : null;
    g.status = !task ? 'new' : (g.fresh ? 'update' : 'same');
  }

  function prAuthors(prs) {
    var seen = {}, out = [];
    prs.forEach(function (p) {
      var a = String(p.author || '').trim();
      if (a && !seen[a]) { seen[a] = 1; out.push(a); }
    });
    return out;
  }

  function prHeadline(g) {
    var n = g.prs.length;
    var authors = prAuthors(g.prs);
    return 'Relecture de ' + (n > 1 ? n + ' PRs Bitbucket' : 'la PR Bitbucket')
      + (authors.length ? ', par ' + authors.join(', ') : '') + ' :';
  }

  function prLines(p) {
    return ['- ' + p.project + '/' + p.repo + ' #' + p.id + ' · ' + p.branch + ' → ' + p.target, '  ' + p.url];
  }

  function jiraLink(key, jiraUrl) {
    return key && jiraUrl ? String(jiraUrl).replace(/\/+$/, '') + '/browse/' + key : '';
  }

  /* Adresse de Jira : celle que l'hôte a détectée (serveur MCP Atlassian, JIRA_URL), sinon celle
     d'un lien de ticket déjà collé dans une tâche (…/browse/UDM-1234). */
  var JIRA_BROWSE_RE = /(https?:\/\/[^\s<>"'`]+?)\/browse\/[A-Z][A-Z0-9]+-\d+/;
  function jiraBase() {
    if (S.env.jiraUrl) return S.env.jiraUrl;
    for (var i = 0; i < S.data.tasks.length; i++) {
      var m = JIRA_BROWSE_RE.exec(String(S.data.tasks[i].text || ''));
      if (m) return m[1];
    }
    return '';
  }

  /* Clés de ticket d'une tâche : celle posée par l'import des PRs, puis celles écrites dans le
     texte. Les sigles qui ont la forme d'une clé sans en être une (UTF-8, ISO-9001, GPT-5…) sont
     écartés. Trois au plus : c'est une ligne de pastilles, pas un index. */
  var JIRA_KEY_RE = /(^|[^A-Za-z0-9_-])([A-Z][A-Z0-9]{1,9}-\d+)(?![A-Za-z0-9_])/g;
  var NOT_JIRA = /^(UTF|UCS|ISO|IEC|IEEE|EN|NF|DIN|RFC|CVE|CWE|SHA|MD|AES|RSA|TLS|SSL|HTTP|HTML|CSS|ES|ECMA|PEP|GPT|WIN|X|COVID|CRC|RGB|ARGB|WPA|IP|PDF|PAL|NTSC)-/;
  function taskJiraKeys(t) {
    var keys = [];
    function add(k) { if (k && keys.indexOf(k) < 0 && !NOT_JIRA.test(k)) keys.push(k); }
    add(t.jira);
    var s = String(t.text || ''), m;
    JIRA_KEY_RE.lastIndex = 0;
    while ((m = JIRA_KEY_RE.exec(s))) add(m[2]);
    return keys.slice(0, 3);
  }

  /* Pastilles-liens des tickets, posées à côté de la catégorie ; rien si l'adresse de Jira est inconnue. */
  function jiraChipsHtml(t) {
    var keys = taskJiraKeys(t);
    var base = keys.length ? jiraBase() : '';
    if (!base) return '';
    return keys.map(function (key) {
      return '<a class="jira-chip" draggable="false" data-act="open-url" data-url="' + esc(jiraLink(key, base))
        + '" title="Ouvrir ' + esc(key) + ' dans Jira">' + esc(key) + '<span class="jira-chip-arrow">↗</span></a>';
    }).join('');
  }

  /* Pull requests d'une tâche : celles posées par l'import, puis les adresses de PR écrites dans le
     texte — Bitbucket Data Center (…/projects/P/repos/r/pull-requests/12), Bitbucket Cloud
     (…/w/r/pull-requests/12), GitHub (…/o/r/pull/12), GitLab (…/g/r/-/merge_requests/12).
     L'adresse est ramenée à la PR elle-même (sans /overview, /diff…) : la même PR citée deux fois
     ne fait qu'une pastille. */
  var PR_URL_RE = /https?:\/\/[^\s<>"'`]+?\/([^\/\s<>"'`]+)\/(?:-\/)?(?:pull-requests|pull|merge_requests)\/(\d+)/g;
  function taskPullRequests(t) {
    var prs = [], seen = {};
    function scan(s) {
      var m;
      PR_URL_RE.lastIndex = 0;
      while ((m = PR_URL_RE.exec(s))) {
        var k = m[0].toLowerCase();
        if (seen[k]) continue;
        seen[k] = 1;
        prs.push({ url: m[0], repo: m[1], id: m[2] });
      }
    }
    (Array.isArray(t.prs) ? t.prs : []).forEach(function (u) { scan(String(u || '')); });
    scan(String(t.text || ''));
    return prs;
  }

  /* Pastilles-liens des PRs, après celles des tickets : trois au plus, les suivantes comptées dans
     un « +n » dont l'infobulle les nomme (leurs adresses restent cliquables dans le texte). */
  function prChipsHtml(t) {
    var prs = taskPullRequests(t);
    var shown = prs.slice(0, 3), rest = prs.slice(3);
    function name(p) { return p.repo + ' #' + p.id; }
    return shown.map(function (p) {
      return '<a class="pr-chip" draggable="false" data-act="open-url" data-url="' + esc(p.url)
        + '" title="' + esc('Ouvrir la PR ' + name(p) + ' dans le navigateur') + '">' + ICON.pullRequest
        + '<span class="pr-chip-repo">' + esc(p.repo) + '</span><span>#' + esc(p.id) + '</span><span class="jira-chip-arrow">↗</span></a>';
    }).join('') + (rest.length ? '<span class="pr-chip-more" title="' + esc(rest.map(name).join('\n')) + '">+'
      + rest.length + ' PR</span>' : '');
  }

  /* Le texte d'une tâche : le ticket et le titre en première ligne (c'est elle qui fait le titre de
     la session), puis une ligne et l'adresse de chaque PR, et le lien du ticket. */
  function prTaskText(g, jiraUrl) {
    var first = g.prs[0];
    var lines = [g.key ? g.key + ' · ' + g.title : first.project + '/' + first.repo + ' #' + first.id + ' · ' + g.title];
    lines.push(prHeadline(g));
    g.prs.forEach(function (p) { lines.push.apply(lines, prLines(p)); });
    var link = jiraLink(g.key, jiraUrl);
    if (link) lines.push('Ticket : ' + link);
    return lines.join('\n');
  }

  /* Complète une tâche en file : les PRs qui lui manquent sont ajoutées à la suite des siennes
     (avant la ligne du ticket, si elle est là), et l'en-tête reprend le compte. */
  function prAppendText(text, g) {
    var lines = String(text || '').split('\n');
    var add = [];
    g.prs.forEach(function (p) { if (!p.known) add.push.apply(add, prLines(p)); });
    if (!add.length) return text;
    var at = lines.length - 1;
    for (var i = lines.length - 1; i >= 0; i--) {
      if (/^\s*https?:\/\//.test(lines[i]) || /^- /.test(lines[i])) { at = i; break; }
    }
    Array.prototype.splice.apply(lines, [at + 1, 0].concat(add));
    if (lines.length > 1 && /^Relecture de (la PR|\d+ PRs) Bitbucket/.test(lines[1])) lines[1] = prHeadline(g);
    return lines.join('\n');
  }

  function prImportError(r) {
    var msg = (r && r.message) || '';
    var status = r && r.status;
    var host = r && r.host ? ' (' + r.host + ')' : '';
    if (status === 'missing') {
      return 'Aucun accès Bitbucket configuré : ' + msg + '. Adresse et jeton sont ceux du serveur MCP bitbucket de '
        + '~/.claude.json (BITBUCKET_URL, BITBUCKET_TOKEN) ou de l’environnement ; l’adresse peut aussi se fixer dans les Réglages.';
    }
    if (status === 'expired') {
      return 'Jeton Bitbucket refusé' + host + ' : ' + msg + '. Il a expiré, ou n’a pas le droit de lecture sur les pull requests.';
    }
    return 'Bitbucket injoignable' + host + ' : ' + (msg || 'réponse inattendue');
  }

  function prImportCounts() {
    var im = S.ui.prImport, n = { create: 0, update: 0 };
    if (!im) return n;
    im.groups.forEach(function (g) {
      if (!im.checked[g.id]) return;
      if (g.status === 'new') n.create++;
      else if (g.status === 'update') n.update++;
    });
    return n;
  }

  function openPrImport() {
    /* `group` : les tickets créés vont en sous-tâches d'une revue générale (case décochée d'office). */
    var im = S.ui.prImport = { busy: true, error: '', host: '', account: '', jiraUrl: S.env.jiraUrl || '', groups: [], checked: {}, group: false };
    render();
    bridge.call('getPullRequests', {}, 60000).then(function (r) {
      if (S.ui.prImport !== im) return;
      im.busy = false;
      im.host = (r && r.host) || '';
      im.account = (r && r.account) || '';
      im.jiraUrl = (r && r.jiraUrl) || im.jiraUrl;
      if (!r || r.status !== 'ok') { im.error = prImportError(r); render(); return; }
      im.groups = groupPullRequests(Array.isArray(r.prs) ? r.prs : []);
      im.groups.forEach(function (g) {
        prGroupStatus(g);
        /* Coché d'office, sauf ce qui est déjà en file et les brouillons, pas encore à relire. */
        im.checked[g.id] = g.status !== 'same' && !g.prs.every(function (p) { return p.draft; });
      });
      render();
    })['catch'](function (e) {
      if (S.ui.prImport !== im) return;
      im.busy = false;
      im.error = 'Bitbucket injoignable : ' + e.message;
      render();
    });
  }

  function createFromPrImport() {
    var im = S.ui.prImport;
    if (!im || im.busy || !S.ui.composerType) return;
    var chosen = im.groups.filter(function (g) { return im.checked[g.id] && g.status !== 'same'; });
    if (!chosen.length) return;
    var at = S.ui.insertAt || 'top';
    var idx = 0;
    if (at === 'bottom') idx = S.data.tasks.length;
    else if (at !== 'top') {
      var j = S.data.tasks.findIndex(function (x) { return x.id === at; });
      idx = j < 0 ? 0 : j + 1;
    }
    var created = 0, updated = 0, parentId = null;
    chosen.forEach(function (g) {
      var urls = g.prs.map(function (p) { return p.url; });
      var t = g.status === 'update' ? taskById(g.taskId) : null;
      if (t) {
        var fresh = urls.filter(function (u) { return !taskHasPr(t, u); });
        t.text = prAppendText(t.text, g);
        t.prs = (Array.isArray(t.prs) ? t.prs : []).concat(fresh);
        if (g.key && !t.jira) t.jira = g.key;
        updated++;
        return;
      }
      /* Regroupé : la revue générale prend la place prévue, ses sous-tâches la suivent. */
      if (im.group && !parentId) {
        parentId = uid('n');
        S.data.tasks.splice(idx, 0, {
          id: parentId, type: S.ui.composerType, text: prGroupTitle(), done: false, doing: false, created: Date.now(), reviewGroup: true
        });
      }
      var nt = {
        id: uid('n'), type: S.ui.composerType, text: prTaskText(g, im.jiraUrl), done: false, doing: false, created: Date.now(),
        jira: g.key, prs: urls
      };
      if (parentId) nt.parent = parentId;
      S.data.tasks.splice(idx + (parentId ? 1 : 0) + created, 0, nt);
      created++;
    });
    dropComposerAttachments();
    S.ui.prImport = null;
    S.ui.composerOpen = false;
    S.ui.composerText = '';
    S.ui.catFormOpen = false;
    commit();
    if (parentId) {
      toast('Revue générale créée avec ' + created + (created > 1 ? ' sous-tâches' : ' sous-tâche')
        + (updated ? ' · ' + (updated > 1 ? updated + ' tâches déjà en file complétées, laissées à leur place'
          : '1 tâche déjà en file complétée, laissée à sa place') : '') + '.');
      return;
    }
    toast((created ? created + (created > 1 ? ' tâches créées' : ' tâche créée') : '')
      + (created && updated ? ', ' : '')
      + (updated ? updated + (updated > 1 ? ' tâches complétées' : ' tâche complétée') : '') + '.');
  }

  /* Le texte d'une tâche, avec ses adresses cliquables : un clic sur l'une ouvre le navigateur
     (action `open-url`, la plus proche) au lieu d'ouvrir l'édition. */
  var URL_RE = /https?:\/\/[^\s<>"'`]+/g;
  function taskTextHtml(text) {
    var s = String(text || ''), out = [], last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(s))) {
      var url = m[0].replace(/[.,;:!?)\]]+$/, '');
      out.push(esc(s.slice(last, m.index)));
      out.push('<a class="task-link" draggable="false" data-act="open-url" data-url="' + esc(url)
        + '" title="Ouvrir dans le navigateur">' + esc(url) + '</a>');
      last = m.index + url.length;
    }
    out.push(esc(s.slice(last)));
    return out.join('');
  }

  /* La première ligne est le titre de la tâche, le reste son contexte : même saisie qu'avant,
     deux tons à l'affichage. */
  function taskTitleBodyHtml(text) {
    var s = String(text || '').replace(/^(\s*\n)+/, '');
    var i = s.indexOf('\n');
    var title = i < 0 ? s : s.slice(0, i);
    var body = i < 0 ? '' : s.slice(i + 1).replace(/^(\s*\n)+/, '').replace(/\s+$/, '');
    return '<div class="task-title">' + taskTextHtml(title) + '</div>'
      + (body ? '<div class="task-body">' + taskTextHtml(body) + '</div>' : '');
  }

  /* Éditeur d'un mot-clé, déplié sous sa catégorie : son nom, ce qu'il veut dire, et la consigne
     ajoutée au contexte de l'agent quand il est coché au lancement. */
  function keywordEditorHtml(ty, kw) {
    return '<div class="kw-editor">'
      + '<div class="kw-editor-grid">'
      + '<label class="kw-field"><span>Nom</span>'
      + '<input class="input" type="text" data-role="kw-name" data-id="' + esc(ty.id) + '" data-kw="' + esc(kw.id)
      + '" data-focus-key="kw-name-' + esc(kw.id) + '" spellcheck="false" value="' + esc(kw.name) + '"></label>'
      + '<label class="kw-field"><span>Description</span>'
      + '<input class="input" type="text" data-role="kw-desc" data-id="' + esc(ty.id) + '" data-kw="' + esc(kw.id)
      + '" data-focus-key="kw-desc-' + esc(kw.id) + '" placeholder="À quoi sert ce mot-clé (infobulle)" value="' + esc(kw.desc) + '"></label>'
      + '</div>'
      + '<label class="kw-field"><span class="kw-field-head">Consigne pour l’agent'
      + draftBtnHtml('draft-keyword', ' data-id="' + esc(ty.id) + '" data-kw="' + esc(kw.id) + '"', false, 'Rédiger') + '</span>'
      + '<textarea class="input kw-prompt" rows="4" data-role="kw-prompt" data-id="' + esc(ty.id) + '" data-kw="' + esc(kw.id)
      + '" data-focus-key="kw-prompt-' + esc(kw.id) + '" placeholder="Ex. : corrige la cause, pas le symptôme ; propose un test de non-régression.">'
      + esc(kw.prompt) + '</textarea></label>'
      + draftBoxHtml('kw:' + kw.id, false)
      + keywordTeamHtml(ty, kw)
      + '<div class="kw-editor-actions">'
      + draftBtnHtml('kw-chat', ' data-id="' + esc(ty.id) + '" data-kw="' + esc(kw.id) + '"', false, 'En discuter')
      + '<span class="kw-editor-hint">Part avec la tâche dans le contexte de l’agent.</span>'
      + '<button type="button" class="btn btn-ghost" data-act="cat-edit-keyword" data-kw="">Fermer</button>'
      + '</div></div>';
  }

  /* Équipe d'un mot-clé : la case l'arme, la liste dit qui la compose. Chaque agent porte un nom,
     un rôle qui le range, et une mission — que ✦ sait écrire, pour l'équipe entière ou un agent seul. */
  function keywordTeamHtml(ty, kw) {
    var agents = Array.isArray(kw.agents) ? kw.agents : [];
    var ids = ' data-id="' + esc(ty.id) + '" data-kw="' + esc(kw.id) + '"';
    var h = ['<div class="kw-team' + (kw.team ? ' on' : '') + '">'];
    h.push('<div class="kw-team-head">'
      + '<label class="kw-team-switch"><input type="checkbox" data-act="kw-team-toggle"' + ids
      + (kw.team ? ' checked' : '') + '><span>Lance une équipe d’agents</span></label>'
      + (kw.team ? draftBtnHtml('draft-team', ids, false, agents.length ? 'Recomposer l’équipe' : 'Composer l’équipe') : '')
      + '</div>');

    if (!kw.team) {
      h.push('<div class="kw-team-off">Coché, ce mot-clé demande à l’agent d’ouvrir aussitôt une équipe '
        + 'de sous-agents en parallèle, au lieu de tout faire seul.'
        + (agents.length ? ' Son équipe (' + esc(agents.length) + ') est gardée en sommeil.' : '') + '</div></div>');
      return h.join('');
    }

    h.push(draftBoxHtml('team:' + kw.id, false));
    h.push('<div class="agent-rows">' + agents.map(function (a) { return agentRowHtml(ty, kw, a); }).join('') + '</div>');
    h.push('<div class="kw-team-foot">'
      + '<button type="button" class="btn btn-secondary btn-small" data-act="kw-agent-add"' + ids
      + (agents.length >= AGENT_MAX ? ' disabled title="Huit agents au plus"' : '') + '>+ Agent</button>'
      + '<span class="kw-team-hint">' + esc(teamOf(kw).length
        ? teamLine(teamOf(kw)) + ' — ouverts en parallèle au lancement, chacun avec le modèle et l’effort demandés.'
        : 'Aucun agent nommé : le mot-clé partira sans équipe.') + '</span>'
      + '</div></div>');
    return h.join('');
  }

  function agentRowHtml(ty, kw, a) {
    var ids = ' data-id="' + esc(ty.id) + '" data-kw="' + esc(kw.id) + '" data-agent="' + esc(a.id) + '"';
    return '<div class="agent-row">'
      + '<div class="agent-row-head">'
      + '<input class="input agent-name" type="text" data-role="agent-name"' + ids
      + ' data-focus-key="agent-name-' + esc(a.id) + '" spellcheck="false" placeholder="Nom, ex. architecte" value="' + esc(a.name) + '">'
      + '<input class="input agent-role" type="text" data-role="agent-role"' + ids + ' list="agent-roles"'
      + ' data-focus-key="agent-role-' + esc(a.id) + '" placeholder="Rôle" value="' + esc(a.role) + '">'
      + draftBtnHtml('draft-agent', ids, false, 'Mission')
      + '<button type="button" class="kw-x" data-act="kw-agent-remove"' + ids
      + ' title="Retirer cet agent" aria-label="Retirer ' + esc(a.name || 'cet agent') + '">×</button>'
      + '</div>'
      + '<div class="agent-tune">'
      + '<label class="agent-tune-f" title="Modèle avec lequel l’agent principal ouvrira ce sous-agent.">'
      + '<span>Modèle</span>' + agentTuneSelectHtml('model', teamModels(), a, ids) + '</label>'
      + '<label class="agent-tune-f" title="Soin attendu de ce sous-agent : plus il est élevé, plus il creuse et vérifie.">'
      + '<span>Effort</span>' + agentTuneSelectHtml('effort', teamEfforts(), a, ids) + '</label>'
      + '</div>'
      + '<textarea class="input agent-prompt" rows="2" data-role="agent-prompt"' + ids
      + ' data-focus-key="agent-prompt-' + esc(a.id) + '" placeholder="Sa mission : ce qu’il doit faire, et ce qu’il rend.">'
      + esc(a.prompt) + '</textarea>'
      + draftBoxHtml('agent:' + a.id, false)
      + '</div>';
  }

  /* Modèle et effort d'un agent : le catalogue est celui de l'agent de lancement, et « comme l'agent
     principal » est le choix par défaut — c'est ce que fait un sous-agent dont on ne dit rien. Une
     valeur venue d'ailleurs (catalogue changé depuis) reste offerte plutôt que d'être perdue. */
  function agentTuneSelectHtml(field, list, a, ids) {
    var value = String(a[field] || '');
    var known = false;
    var h = ['<select class="input agent-tune-select" data-role="agent-' + field + '"' + ids
      + ' data-focus-key="agent-' + field + '-' + esc(a.id) + '">'];
    h.push('<option value=""' + (value ? '' : ' selected') + '>comme l’agent principal</option>');
    (list || []).forEach(function (id) {
      if (id === value) known = true;
      h.push('<option value="' + esc(id) + '"' + (id === value ? ' selected' : '') + '>' + esc(id) + '</option>');
    });
    if (value && !known) h.push('<option value="' + esc(value) + '" selected>' + esc(value) + '</option>');
    return h.join('') + '</select>';
  }

  /* Dialogue « Catégories » : nom, couleur et mots-clés de chaque catégorie, au même endroit.
     Les mots-clés sont ce que le formulaire de lancement proposera pour une tâche de ce type. */
  function catsHtml(enter) {
    var h = [];
    h.push('<div class="dialog-backdrop">');
    h.push('<div class="dialog dialog-wide' + (enter ? ' enter' : '') + '" data-act="noop" role="dialog" aria-label="Catégories">');
    h.push('<div class="dialog-title">Catégories</div>');
    h.push('<div class="dialog-lead">Chaque catégorie porte ses mots-clés. Ils ne sont proposés qu’au lancement d’un agent, '
      + 'où l’on en coche autant qu’on veut. Un mot-clé se règle comme une skill : un nom, ce qu’il veut dire, '
      + 'et la consigne qui part avec la tâche.</div>');

    /* Rôles proposés pour les agents d'une équipe : le champ reste libre, ce n'est qu'une liste. */
    h.push('<datalist id="agent-roles">' + AGENT_ROLES.map(function (role) {
      return '<option value="' + esc(role) + '"></option>';
    }).join('') + '</datalist>');

    if (!S.data.types.length) {
      h.push('<div class="cat-empty">Aucune catégorie pour l’instant.</div>');
    }

    h.push('<div class="cat-rows">');
    S.data.types.forEach(function (ty) {
      var used = S.data.tasks.filter(function (t) { return t.type === ty.id; }).length;
      var keywords = normalizeKeywords(ty.keywords);
      h.push('<div class="cat-row" style="border-color:' + esc(color(ty.bd, 'var(--color-neutral-300)')) + '">');

      h.push('<div class="cat-row-head">');
      h.push('<input class="input cat-row-name" type="text" data-role="cat-label" data-id="' + esc(ty.id)
        + '" data-focus-key="cat-label-' + esc(ty.id) + '" placeholder="Nom de la catégorie" value="' + esc(ty.label)
        + '" style="background:' + esc(color(ty.bg, 'var(--color-field)')) + ';color:' + esc(color(ty.fg, 'var(--color-text)')) + '">');
      h.push('<div class="palettes">' + PALETTES.map(function (p) {
        return '<button type="button" class="palette' + (p.bg === ty.bg ? ' sel' : '') + '" data-act="cat-palette" data-id="'
          + esc(ty.id) + '" data-palette="' + esc(p.id) + '" title="' + esc(p.title) + '" aria-label="' + esc(p.title)
          + '" style="background:' + esc(p.bg) + ';border-color:' + esc(p.bd) + '"></button>';
      }).join('') + '</div>');
      h.push('<span class="cat-row-count">' + esc(used ? used + (used > 1 ? ' tâches' : ' tâche') : 'inutilisée') + '</span>');
      h.push('<button type="button" class="btn btn-icon btn-ghost" data-act="cat-delete" data-id="' + esc(ty.id) + '"'
        + (used ? ' disabled title="Encore portée par des tâches"' : ' title="Supprimer la catégorie"') + '>' + ICON.trash + '</button>');
      h.push('</div>');

      h.push('<div class="cat-row-kw">');
      h.push('<span class="cat-kw-label">Mots-clés</span>');
      h.push(keywords.map(function (kw) {
        var open = S.ui.catKeywordEdit === kw.id;
        var tip = kw.desc || kw.prompt || 'Aucune consigne pour l’agent';
        return '<span class="kw-tag' + (open ? ' open' : '') + (kw.prompt ? ' guided' : '') + '">'
          + '<button type="button" class="kw-open" data-act="cat-edit-keyword" data-kw="' + esc(kw.id)
          + '" title="' + esc(tip) + '">' + esc(kw.name) + '</button>'
          + '<button type="button" class="kw-x" data-act="cat-remove-keyword" data-id="'
          + esc(ty.id) + '" data-kw="' + esc(kw.id) + '" title="Retirer ce mot-clé" aria-label="Retirer ' + esc(kw.name) + '">×</button></span>';
      }).join(''));
      h.push('<input class="input kw-input" type="text" data-role="cat-keyword-new" data-id="' + esc(ty.id)
        + '" data-focus-key="cat-kw-' + esc(ty.id) + '" placeholder="ajouter…" spellcheck="false" value="'
        + esc(S.ui.catKeywordDraft[ty.id] || '') + '">');
      h.push('</div>');

      var edited = keywords.filter(function (kw) { return kw.id === S.ui.catKeywordEdit; })[0];
      if (edited) h.push(keywordEditorHtml(ty, edited));

      h.push('</div>');
    });
    h.push('</div>');

    h.push('<div class="dialog-actions">'
      + '<button type="button" class="btn btn-secondary" data-act="cats-new">+ Nouvelle catégorie</button>'
      + '<span class="cat-form-spacer"></span>'
      + '<button type="button" class="btn btn-primary" data-act="close-cats">Fermer</button>'
      + '</div>');

    h.push('</div></div>');
    return h.join('');
  }

  /* ── Réglages ──────────────────────────────────────────────────────────
     Rangés par thème, un onglet à la fois : la liste unique était devenue trop longue pour
     s'y retrouver. L'onglet ouvert reste celui de la dernière visite (S.ui.settingsTab). */
  var SETTINGS_TABS = [
    { id: 'display', label: 'Affichage', lead: 'L’allure de la file.' },
    { id: 'agents', label: 'Agents', lead: 'Ce qui est proposé au lancement d’une conversation.' },
    { id: 'draft', label: 'Rédaction', lead: 'L’agent qui écrit le contenu d’une tâche ou la consigne d’un mot-clé à partir de son titre, sans ouvrir de terminal.' },
    { id: 'article', label: 'Articles du jour', lead: 'Chaque jour, un article trouvé sur le web pour vos sujets du moment et un autre sur l’actualité récente de l’IA, lus et résumés par Claude Code. Chacun a sa carte en tête de fenêtre, à côté des quotas.' },
    { id: 'voice', label: 'Dictée', lead: 'Dicter dans les zones de saisie, et transcrire les enregistrements joints aux tâches, avec Whisper. Tout se passe sur ce poste : seul le modèle se télécharge, une fois.' },
    { id: 'folders', label: 'Dossiers', lead: 'Où les agents travaillent.' },
    { id: 'bitbucket', label: 'Bitbucket', lead: 'Serveur interrogé par « Mes PRs Bitbucket », dans le dialogue Nouvelle tâche.' }
  ];

  function settingsTab() {
    var id = S.ui.settingsTab;
    return SETTINGS_TABS.some(function (t) { return t.id === id; }) ? id : SETTINGS_TABS[0].id;
  }

  function settingsTabLabel() {
    var id = settingsTab();
    return SETTINGS_TABS.filter(function (t) { return t.id === id; })[0].label;
  }

  /* Une ligne : nom et aide à gauche, contrôle à droite (ou dessous, `stacked`). L'aide est du HTML déjà échappé. */
  function setRowHtml(name, help, control, stacked) {
    return '<div class="set-row' + (stacked ? ' stacked' : '') + '">'
      + '<div class="set-label"><div class="set-name">' + esc(name) + '</div>'
      + (help ? '<div class="set-help">' + help + '</div>' : '') + '</div>'
      + '<div class="set-control">' + control + '</div></div>';
  }

  /* Un champ d'une carte : étiquette courte à gauche, contrôle à droite. */
  function setFieldHtml(label, control) {
    return '<div class="set-field"><div class="set-field-label">' + esc(label) + '</div>'
      + '<div class="set-field-control">' + control + '</div></div>';
  }

  function switchHtml(on, act, label) {
    return '<button type="button" class="switch' + (on ? ' on' : '') + '" data-act="' + act + '" role="switch" aria-checked="'
      + (on ? 'true' : 'false') + '" aria-label="' + esc(label) + '"></button>';
  }

  function folderInputHtml(role, placeholder, value, act) {
    return '<input class="input set-cwd" type="text" data-role="' + role + '" data-focus-key="' + role + '" spellcheck="false" placeholder="'
      + esc(placeholder) + '" value="' + esc(value) + '">'
      + '<button type="button" class="btn btn-secondary" data-act="' + act + '">Parcourir…</button>';
  }

  function settingsHtml(enter) {
    var s = S.settings;
    var tab = settingsTab();
    var info = SETTINGS_TABS.filter(function (t) { return t.id === tab; })[0];
    var h = [];
    h.push('<div class="dialog-backdrop">');
    h.push('<div class="dialog dialog-settings' + (enter ? ' enter' : '') + '" data-act="noop" role="dialog" aria-label="Réglages">');
    h.push('<div class="dialog-title">Réglages</div>');
    h.push('<div class="set-layout">');
    h.push('<div class="set-nav" role="tablist" aria-label="Rubriques des réglages">'
      + SETTINGS_TABS.map(function (t) {
        return '<button type="button" role="tab" class="set-tab' + (t.id === tab ? ' on' : '') + '" data-act="settings-tab" data-id="' + t.id + '"'
          + ' aria-selected="' + (t.id === tab ? 'true' : 'false') + '">' + esc(t.label) + '</button>';
      }).join('')
      + '</div>');
    h.push('<div class="set-panel" role="tabpanel" data-role="settings-panel" aria-label="' + esc(info.label) + '">');
    h.push('<div class="set-lead">' + esc(info.lead) + '</div>');
    if (tab === 'display') h.push(displaySettingsHtml(s));
    else if (tab === 'agents') h.push(agentSettingsHtml(s));
    else if (tab === 'draft') h.push(draftSettingsHtml(s));
    else if (tab === 'article') h.push(articleSettingsHtml(s));
    else if (tab === 'voice') h.push(voiceSettingsHtml(s));
    else if (tab === 'folders') h.push(folderSettingsHtml(s));
    else if (EXTRA_SETTINGS[tab]) {
      try { h.push(EXTRA_SETTINGS[tab].html(s)); } catch (e) { h.push('<div class="set-note">Réglages illisibles : ' + esc(e && e.message) + '</div>'); }
    }
    else h.push(bitbucketSettingsHtml(s));
    h.push('</div></div>');
    h.push('<div class="dialog-actions"><button type="button" class="btn btn-primary" data-act="close-settings">Fermer</button></div>');
    h.push('</div></div>');
    return h.join('');
  }

  function displaySettingsHtml(s) {
    return setRowHtml('Tâches en tête', 'Nombre de tâches mises en avant en haut de file.',
        '<div class="stepper">'
        + '<button type="button" class="step-btn" data-act="top-minus"' + (s.topCount <= 1 ? ' disabled' : '') + ' aria-label="Moins">−</button>'
        + '<span class="step-val">' + esc(s.topCount) + '</span>'
        + '<button type="button" class="step-btn" data-act="top-plus"' + (s.topCount >= 8 ? ' disabled' : '') + ' aria-label="Plus">+</button>'
        + '</div>')
      + setRowHtml('Bandes de priorité', 'Maintenant, Ensuite, Plus tard.', switchHtml(s.showBands, 'toggle-bands', 'Bandes de priorité'))
      + setRowHtml('Mode compact', 'Cartes plus resserrées.', switchHtml(s.compact, 'toggle-compact', 'Mode compact'))
      + setRowHtml('Notifications Windows', 'Quand une réponse est prête ou qu’un agent pose une question alors qu’Organizator est derrière une autre fenêtre ou réduit : une notification en bas de l’écran, gardée dans le centre de notifications. La cloche, en tête, en garde l’historique dans tous les cas.',
        switchHtml(s.windowsNotifications !== false, 'toggle-win-notifs', 'Notifications Windows'));
  }

  /* Agent par défaut et terminal, puis une carte par agent : son modèle et son effort par défaut. */
  function agentSettingsHtml(s) {
    var h = [];
    h.push(setRowHtml('Agent par défaut', 'Présélectionné dans « Nouvelle conversation ».',
      '<div class="seg2">'
      + '<button type="button" class="' + (s.provider !== 'copilot' ? 'on' : '') + '" data-act="default-claude">Claude Code</button>'
      + '<button type="button" class="' + (s.provider === 'copilot' ? 'on' : '') + '" data-act="default-copilot"'
      + (hasProvider('copilot') ? '' : ' disabled') + '>GitHub Copilot</button>'
      + '</div>'));
    h.push(setRowHtml('Terminal', esc(S.env.hasWt ? 'Application qui accueille les sessions.' : 'Windows Terminal est introuvable sur ce poste.'),
      '<div class="seg2">'
      + '<button type="button" class="' + (s.terminal !== 'wt' ? 'on' : '') + '" data-act="term-ps">PowerShell</button>'
      + '<button type="button" class="' + (s.terminal === 'wt' ? 'on' : '') + '" data-act="term-wt"'
      + (S.env.hasWt ? '' : ' disabled') + '>Windows Terminal</button>'
      + '</div>'));
    h.push(setRowHtml('Clic sur l’icône de console', 'Sur une carte. « Aller au terminal » : quand la tâche n’a qu’une conversation, '
      + 'sa fenêtre revient au premier plan — reprise si elle a été fermée ; avec plusieurs, ou aucune, le panneau s’ouvre pour choisir. '
      + 'Maj&nbsp;+&nbsp;clic fait l’autre.',
      '<div class="seg2">'
      + '<button type="button" class="' + (s.termClick !== 'terminal' ? 'on' : '') + '" data-act="term-click-panel">Ouvrir le panneau</button>'
      + '<button type="button" class="' + (s.termClick === 'terminal' ? 'on' : '') + '" data-act="term-click-terminal">Aller au terminal</button>'
      + '</div>'));

    PROVIDERS.forEach(function (pr) {
      var model = String(s[modelSettingKey(pr.id)] || '');
      var custom = S.ui.settingsCustom[pr.id] || (model && !catalogHas(catalogFor(pr.id), model));
      var isDefault = (s.provider === 'copilot' ? 'copilot' : 'claude') === pr.id;
      h.push('<div class="set-card">');
      h.push('<div class="set-card-head"><span class="set-card-title">' + esc(pr.label) + '</span>'
        + (isDefault ? '<span class="set-badge">par défaut</span>' : '')
        + (hasProvider(pr.id) ? '' : '<span class="set-badge warn" title="' + esc(pr.missing) + '">introuvable</span>')
        + '</div>');
      h.push(setFieldHtml('Modèle',
        modelSelectHtml(pr.id, model, S.ui.settingsCustom[pr.id], 'set-model-select', 'set-model-select-' + pr.id, false)
        + '<button type="button" class="btn btn-secondary set-refresh" data-act="refresh-models" data-provider="' + esc(pr.id) + '"'
        + (S.ui.modelsBusy[pr.id] ? ' disabled' : '') + ' title="' + esc(refreshModelsTitle(pr.id)) + '" aria-label="' + esc(refreshModelsTitle(pr.id)) + '">↻</button>'));
      if (custom) {
        h.push(setFieldHtml('', '<input class="input set-cwd" type="text" data-role="set-model" data-focus-key="set-model-' + esc(pr.id)
          + '" data-provider="' + esc(pr.id) + '" spellcheck="false" placeholder="Identifiant de modèle, ex. ' + esc(pr.example) + '" value="' + esc(model) + '">'));
      }
      h.push(setFieldHtml('Effort', effortSelectHtml(pr.id, String(s[effortSettingKey(pr.id)] || ''), 'set-effort', 'set-effort-' + pr.id, false)));
      h.push('<div class="set-card-foot">' + esc(catalogHint(pr.id)) + ' L’effort est passé à --effort.</div>');
      h.push('</div>');
    });
    h.push('<div class="set-note">« Par défaut de l’outil » : Organizator ne passe rien, l’agent applique son propre réglage.</div>');
    return h.join('');
  }

  /* Agent de rédaction : celui qui propose un texte à partir d'un titre. Réglé à part des
     conversations — la tâche est courte, un modèle rapide suffit et coûte moins. */
  function draftSettingsHtml(s) {
    var provider = draftProviderId();
    var model = String(s.draftModel || '');
    var custom = S.ui.draftCustom || (model && !catalogHas(catalogFor(provider), model));
    var h = [];
    h.push(setRowHtml('Agent', '',
      '<div class="seg2">'
      + PROVIDERS.map(function (pr) {
        return '<button type="button" class="' + (pr.id === provider ? 'on' : '') + '" data-act="draft-provider" data-id="' + esc(pr.id) + '"'
          + (hasProvider(pr.id) ? '' : ' disabled title="' + esc(pr.missing) + '"') + '>' + esc(pr.label) + '</button>';
      }).join('')
      + '</div>'));
    h.push('<div class="set-card">');
    h.push(setFieldHtml('Modèle', modelSelectHtml(provider, model, S.ui.draftCustom, 'draft-model-select', 'draft-model-select', false)));
    if (custom) {
      h.push(setFieldHtml('', '<input class="input set-cwd" type="text" data-role="draft-model" data-focus-key="draft-model" '
        + 'spellcheck="false" placeholder="Identifiant de modèle, ex. ' + esc(providerById(provider).example) + '" value="' + esc(model) + '">'));
    }
    h.push(setFieldHtml('Effort', effortSelectHtml(provider, String(s.draftEffort || ''), 'draft-effort', 'draft-effort', false)));
    h.push('<div class="set-card-foot">Quelques phrases suffisent : un modèle rapide répond en une poignée de secondes.</div>');
    h.push('</div>');
    return h.join('');
  }

  /* Article du jour et veille IA : les activer, dire ce qui intéresse (l'article du jour seulement),
     et l'agent qui cherche, commun aux deux (Claude seulement : la recherche web passe par ses
     outils WebSearch et WebFetch). */
  function articleSettingsHtml(s) {
    var model = String(s.articleModel || '');
    var custom = S.ui.articleCustom || (model && !catalogHas(catalogFor('claude'), model));
    var claude = hasProvider('claude');
    var h = [];
    h.push(setRowHtml('Proposer un article chaque jour', esc(claude ? 'Pour vos sujets du moment. Cherché au premier lancement de la journée, ou au changement de date.'
      : 'Claude Code est introuvable sur ce poste : l’article du jour a besoin de sa recherche web.'),
      switchHtml(s.articleEnabled !== false, 'toggle-article', 'Proposer un article chaque jour')));
    h.push(setRowHtml('Vos sujets', 'Un par ligne, ou séparés par des virgules. Ils passent avant ce que l’agent devine de votre file de tâches et de vos dernières conversations, qu’il lit aussi.',
      '<textarea class="input set-topics" rows="4" data-role="article-topics" data-focus-key="article-topics" spellcheck="false" '
      + 'placeholder="ex. .NET et performances, revue de code, agents IA, migration Git">' + esc(s.articleTopics || '') + '</textarea>', true));
    h.push(setRowHtml('Veille IA', esc(claude ? 'Un second article chaque jour, dans sa propre carte : ce qui vient de se passer dans l’IA — modèles, agents de code, outils, recherche —, publié dans les deux dernières semaines et vu par un développeur. Il ne tient compte ni de vos sujets ni de votre file.'
      : 'Claude Code est introuvable sur ce poste : la veille IA a besoin de sa recherche web.'),
      switchHtml(s.articleAiEnabled !== false, 'toggle-article-ai', 'Veille IA')));
    h.push('<div class="set-card">');
    h.push('<div class="set-card-head"><span class="set-card-title">Claude Code</span></div>');
    h.push(setFieldHtml('Modèle', modelSelectHtml('claude', model, S.ui.articleCustom, 'article-model-select', 'article-model-select', false)));
    if (custom) {
      h.push(setFieldHtml('', '<input class="input set-cwd" type="text" data-role="article-model" data-focus-key="article-model" '
        + 'spellcheck="false" placeholder="Identifiant de modèle, ex. sonnet" value="' + esc(model) + '">'));
    }
    h.push(setFieldHtml('Effort', effortSelectHtml('claude', String(s.articleEffort || ''), 'article-effort', 'article-effort', false)));
    h.push('<div class="set-card-foot">Le même agent cherche les deux articles. Chercher, lire et résumer prend une minute environ ; sonnet avec un effort moyen y suffit. Chaque recherche compte dans votre quota Claude Code.</div>');
    h.push('</div>');
    return h.join('');
  }

  /* Dictée et transcription : les activer, la langue parlée, et le modèle Whisper — chacun avec sa
     taille, ce qu'il vaut, et de quoi le télécharger ou le supprimer. */
  function voiceSettingsHtml(s) {
    var h = [];
    h.push(setRowHtml('Dictée', 'Un micro se pose dans le coin de la zone de saisie où vous écrivez. '
      + '<b>Ctrl + Maj + Espace</b> démarre et termine, Échap annule ; le texte s’insère au curseur.',
      switchHtml(s.whisperEnabled !== false, 'toggle-whisper', 'Dictée')));
    h.push(setRowHtml('Transcrire les enregistrements joints', 'Un fichier audio joint à une tâche (mp3, m4a, wav, ogg…) est transcrit aussitôt, '
      + 'et sa transcription jointe en texte : c’est elle que l’agent lit. Sinon, et pour le son d’une vidéo, le bouton Transcrire de la pièce jointe.',
      switchHtml(s.whisperAuto !== false, 'toggle-whisper-auto', 'Transcrire les enregistrements joints')));
    h.push(setRowHtml('Langue parlée', 'La fixer évite les contresens sur une dictée de quelques mots ; la détection automatique convient à un enregistrement dans une autre langue.',
      '<select class="input set-select" data-role="whisper-language" data-focus-key="whisper-language">'
      + WHISPER_LANGS.map(function (l) {
        return '<option value="' + l.id + '"' + (s.whisperLanguage === l.id ? ' selected' : '') + '>' + esc(l.label) + '</option>';
      }).join('') + '</select>'));

    var models = whisperModels();
    h.push('<div class="set-card">');
    h.push('<div class="set-card-head"><span class="set-card-title">Modèle Whisper</span></div>');
    if (!models.length) h.push('<div class="set-card-foot">Moteur de transcription indisponible dans cette fenêtre.</div>');
    models.forEach(function (m) {
      var on = s.whisperModel === m.id;
      var dl = S.ui.whisperDl[m.id] || (m.downloading ? { received: m.received, total: m.total } : null);
      var state = dl
        ? '<span class="wm-state" data-whisper-dl="' + esc(m.id) + '">' + esc(whisperDlLabel(dl)) + '</span>'
          + '<button type="button" class="btn btn-ghost wm-btn" data-act="whisper-remove" data-id="' + esc(m.id) + '">Interrompre</button>'
        : (m.downloaded
          ? '<span class="wm-state is-ok">' + ICON.check + 'Téléchargé</span>'
            + '<button type="button" class="btn btn-ghost wm-btn" data-act="whisper-remove" data-id="' + esc(m.id) + '" title="Libérer ' + esc(fmtSize(m.size)) + ' sur le disque">Supprimer</button>'
          : '<button type="button" class="btn btn-secondary wm-btn" data-act="whisper-download" data-id="' + esc(m.id) + '">Télécharger</button>');
      h.push('<div class="wm-row' + (on ? ' on' : '') + '">'
        + '<button type="button" class="wm-pick" data-act="whisper-model" data-id="' + esc(m.id) + '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '">'
        + '<span class="wm-radio"></span><span class="wm-text"><span class="wm-name">' + esc(m.label)
        + ' <span class="wm-size">' + esc(fmtSize(m.size)) + '</span>' + (m.id === DEFAULTS.whisperModel ? '<span class="set-badge">recommandé</span>' : '') + '</span>'
        + '<span class="wm-note">' + esc(m.note) + '</span></span></button>'
        + '<span class="wm-side">' + state + '</span></div>');
    });
    if (models.length) {
      var chosen = models.filter(function (m) { return m.id === s.whisperModel; })[0];
      h.push('<div class="set-card-foot">' + (chosen && !chosen.downloaded
        ? 'Le modèle choisi se téléchargera de lui-même à la première dictée (' + esc(fmtSize(chosen.size)) + ').'
        : 'Le modèle reste en mémoire dix minutes après une transcription, puis il est libéré.')
        + ' Rangés dans ' + esc((S.env.whisper && S.env.whisper.dir) || 'le dossier de données') + '.</div>');
    }
    h.push('</div>');
    return h.join('');
  }

  function folderSettingsHtml(s) {
    return setRowHtml('Dossier de travail par défaut', 'Proposé au lancement d’une session sans conversation antérieure.',
        folderInputHtml('settings-cwd', S.env.defaultCwd || 'C:\\…', s.defaultCwd, 'browse-default-cwd'), true)
      + setRowHtml('Sources d’Organizator', 'Dépôt où l’agent traite vos remarques. Vide : le dossier détecté autour de l’exécutable'
        + (S.env.repoDir ? '.' : ' (aucun sur ce poste).'),
        folderInputHtml('settings-repo', S.env.repoDir || 'D:\\…\\Organizator', s.repoDir, 'browse-repo-dir'), true);
  }

  /* Adresse surchargeable ; ce qui a été détecté est dit à part, le jeton n'est jamais saisi ici. */
  function bitbucketSettingsHtml(s) {
    var detected = S.env.bitbucketUrl
      ? esc(S.env.bitbucketUrl) + ' <span class="set-muted">(' + esc(bitbucketSourceLabel(S.env.bitbucketSource)) + ')</span>'
      : '<span class="set-muted">aucun serveur</span>';
    var token = S.env.bitbucketUrl
      ? (S.env.bitbucketToken ? 'trouvé' : '<span class="set-warn">absent</span>')
      : '<span class="set-muted">—</span>';
    return setRowHtml('Adresse du serveur', 'Vide : le serveur détecté ci-dessous.',
        '<input class="input set-cwd" type="text" data-role="settings-bitbucket" data-focus-key="settings-bitbucket" spellcheck="false" placeholder="'
        + esc(S.env.bitbucketUrl || 'https://bitbucket.exemple.com') + '" value="' + esc(s.bitbucketUrl) + '">', true)
      + '<div class="set-card">'
      + setFieldHtml('Détecté', '<span class="set-value">' + detected + '</span>')
      + setFieldHtml('Jeton', '<span class="set-value">' + token + '</span>')
      + '<div class="set-card-foot">Adresse et jeton sont lus dans le serveur MCP bitbucket de ~/.claude.json '
      + '(BITBUCKET_URL, BITBUCKET_TOKEN), sinon dans les variables d’environnement du même nom. '
      + 'Le jeton n’est jamais enregistré par Organizator.</div>'
      + '</div>';
  }

  function bitbucketSourceLabel(source) {
    return source === 'env' ? 'variables d’environnement'
      : (source === 'settings' ? 'réglage' : 'serveur MCP de ~/.claude.json');
  }

  function renderDialogs() {
    var host = $('#dialogs');
    var key = S.ui.chat ? 'chat' : (S.ui.catsOpen ? 'cats' : (S.ui.composerOpen ? 'composer' : (S.ui.settingsOpen ? 'settings' : null)));
    if (!key) {
      if (host.innerHTML) host.innerHTML = '';
      dialogKey = null;
      composerFocus = null;
      return;
    }
    var enter = dialogKey !== key;
    /* Chaque réglage modifié redessine le dialogue : le panneau garde sa position, sauf changement d'onglet. */
    var setPanel = host.querySelector('[data-role="settings-panel"]');
    var setScroll = setPanel && !enter && setPanel.getAttribute('aria-label') === (settingsTabLabel() || '') ? setPanel.scrollTop : 0;
    host.innerHTML = key === 'chat' ? chatHtml(enter)
      : (key === 'composer' ? composerHtml(enter) : (key === 'cats' ? catsHtml(enter) : settingsHtml(enter)));
    dialogKey = key;
    if (setScroll) {
      setPanel = host.querySelector('[data-role="settings-panel"]');
      if (setPanel) setPanel.scrollTop = setScroll;
    }

    if (key === 'chat') {
      /* Le fil suit ce qui vient d'arriver, et la main reste dans la zone de réponse. */
      var fil = host.querySelector('[data-role="chat-fil"]');
      if (fil) fil.scrollTop = fil.scrollHeight;
      var note = host.querySelector('[data-focus-key="chat-note"]');
      if (note && !note.disabled && document.activeElement !== note) note.focus();
    }

    if (key === 'composer') {
      var want = S.ui.catFormOpen ? 'cat-name' : 'composer-text';
      if (composerFocus !== want) {
        var el = host.querySelector('[data-focus-key="' + want + '"]');
        if (el) { el.focus(); composerFocus = want; }
      }
    } else {
      composerFocus = null;
    }
  }

  /* ── Lecteur d'artefacts ───────────────────────────────────────────────
     Un rapport se lit dans la fenêtre, sans passer par un éditeur. L'hôte rend le fichier
     (readArtifact : Markdown → HTML, CSV → tableau, texte → bloc) ; l'UI le pose dans un cadre
     isolé — sandbox sans même origine, CSP qui n'autorise que notre script d'amorçage (nonce) et
     nos feuilles : le document de l'agent n'atteint ni l'application, ni le disque. Pages, PDF
     et images sont servis par l'hôte virtuel https://report.organizator/ et chargés tels quels.
     Le cadre n'est reconstruit que si le fichier ou son genre change : un rendu de l'application
     ne le touche pas, et une relecture ne fait que pousser le nouveau HTML (le défilement tient). */

  var READER_HOST = 'https://report.organizator/';
  /* Genres dont l'hôte rend du HTML, posé dans le cadre isolé (l'image aussi : la page de
     l'application ne peut pas charger elle-même une ressource de l'hôte des rapports). */
  var READER_FRAMED = { markdown: 1, text: 1, table: 1, image: 1 };

  /* Script d'amorçage du cadre : reçoit le HTML (message `html`, `variant` pour la mise en page,
     `y` pour reprendre un défilement), remonte les clics sur les liens (`link`), Échap (`close`),
     ← → (`key`, pour passer d'un constat à l'autre dans la vue revue), Ctrl + Pg↑ / Pg↓ / Tab
     (`key` TabPrev / TabNext, d'un ticket à l'autre dans les revues groupées), son défilement
     (`scroll`, au plus toutes les 250 ms), et signale qu'il est prêt (`ready`). */
  var READER_SCRIPT = [
    '(function () {',
    'var doc = document.getElementById("doc");',
    'function post(m) { parent.postMessage(m, "*"); }',
    'addEventListener("message", function (e) {',
    '  var m = e.data || {}; if (m.type !== "html") return;',
    '  document.body.className = m.variant ? String(m.variant) : "";',
    '  var root = document.documentElement;',
    '  var atBottom = innerHeight + scrollY >= root.scrollHeight - 40; var y = scrollY;',
    '  doc.innerHTML = String(m.html || "");',
    '  if (m.follow && atBottom) scrollTo(0, root.scrollHeight); else scrollTo(0, m.follow ? y : (+m.y || 0));',
    '});',
    'var scrollTimer = 0, sentY = -1;',
    'addEventListener("scroll", function () {',
    '  if (scrollTimer) return;',
    '  scrollTimer = setTimeout(function () { scrollTimer = 0; if (scrollY !== sentY) { sentY = scrollY; post({ type: "scroll", y: scrollY }); } }, 250);',
    '});',
    'document.addEventListener("click", function (e) {',
    '  var a = e.target && e.target.closest ? e.target.closest("a[href]") : null; if (!a) return;',
    '  e.preventDefault(); var href = a.getAttribute("href") || "";',
    '  if (href.charAt(0) === "#") {',
    '    var t = null; try { t = document.getElementById(decodeURIComponent(href.slice(1))); } catch (err) { t = null; }',
    '    if (t) t.scrollIntoView(); return;',
    '  }',
    '  post({ type: "link", href: a.href });',
    '});',
    'document.addEventListener("keydown", function (e) {',
    '  if (e.key === "Escape") { post({ type: "close" }); return; }',
    '  if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "PageDown" || e.key === "PageUp" || e.key === "Tab")) {',
    '    e.preventDefault(); post({ type: "key", key: e.key === "PageUp" || (e.key === "Tab" && e.shiftKey) ? "TabPrev" : "TabNext" }); return;',
    '  }',
    '  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) post({ type: "key", key: e.key });',
    '});',
    'post({ type: "ready" });',
    '})();'
  ].join('\n');

  var readerKey = null, readerStamp = null, readerFrame = null, readerReady = false;

  /* Document d'amorçage du cadre isolé : la CSP ne laisse passer que nos feuilles (polices,
     reader.css), les images du dossier servi, et le seul script porteur du nonce. */
  function readerFrameDoc() {
    var nonce = uid('n');
    var origin = location.origin;
    var csp = "default-src 'none'; img-src " + READER_HOST.slice(0, -1) + ' ' + origin + " data: blob:; "
      + "style-src 'unsafe-inline' " + origin + '; font-src ' + origin + "; script-src 'nonce-" + nonce + "'; "
      + "base-uri 'none'; form-action 'none'";
    return '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">'
      + '<meta http-equiv="Content-Security-Policy" content="' + csp + '">'
      + '<link rel="stylesheet" href="' + origin + '/fonts.css">'
      + '<link rel="stylesheet" href="' + origin + '/reader.css">'
      + '</head><body><article id="doc" class="doc"></article>'
      + '<script nonce="' + nonce + '">' + READER_SCRIPT + '</' + 'script></body></html>';
  }

  function readerMeta(v) {
    var dir = folderOf(v.full);
    var ms = toMs(v.modified);
    var when = '';
    if (ms) {
      var d = new Date(ms), now = new Date();
      when = d.toDateString() === now.toDateString() ? 'modifié à ' + fmtTime(ms) : 'modifié le ' + fmtDate(ms);
    }
    return [dir, when, fmtSize(v.size)].filter(Boolean).join(' · ');
  }

  function readerShellHtml(r, kind) {
    var v = r.view;
    var name = lastSegment(v ? v.full : r.path);
    var busting = v ? '?t=' + encodeURIComponent(v.stamp) : '';
    var G = r.group;
    /* Revues groupées : le lecteur prend toute la fenêtre, comme la vue revue, sous la barre d'onglets. */
    var h = [G
      ? '<div class="reader-backdrop rv-backdrop is-group"><div class="reader is-wide' + (G.entered ? '' : ' enter') + '" role="dialog" aria-label="Lecture d’un rapport">'
      : '<div class="reader-backdrop"><div class="reader enter" role="dialog" aria-label="Lecture d’un rapport">'];
    h.push('<div class="reader-bar">'
      + (r.back ? '<button type="button" class="dark-btn reader-btn reader-back" data-act="reader-back" title="Revenir au rapport précédent">‹</button>' : '')
      + '<span class="reader-icon">' + ICON.artifacts + '</span>'
      + '<div class="reader-head"><div class="reader-name" title="' + esc(v ? v.full : r.path) + '">' + esc(name) + '</div>'
      + '<div class="reader-meta">' + esc(v ? readerMeta(v) : (kind === 'error' ? 'Lecture impossible' : 'Lecture…')) + '</div></div>'
      + '<span class="panel-spacer"></span>'
      + (v && reviewModel(v) ? '<button type="button" class="dark-btn reader-btn" data-act="rv-review" title="Revenir à l’inventaire des constats">Vue revue</button>' : '')
      + (v ? '<button type="button" class="dark-btn reader-btn" data-act="reader-vscode" title="Ouvrir dans Visual Studio Code">VS Code</button>'
        + '<button type="button" class="dark-btn reader-btn" data-act="reader-folder" title="Afficher dans l’Explorateur">Dossier</button>' : '')
      + '<button type="button" class="panel-x" data-act="close-reader" title="Fermer (Échap)">✕</button>'
      + '</div>');
    if (G) h.push('<div class="rv-tabs-host" data-role="rv-tabs"></div>');
    h.push('<div class="reader-body">');
    if (READER_FRAMED[kind]) {
      h.push('<iframe class="reader-frame" title="Contenu du rapport" sandbox="allow-scripts" srcdoc="' + esc(readerFrameDoc()) + '"></iframe>');
    } else if (kind === 'html') {
      h.push('<iframe class="reader-frame" title="Contenu du rapport" sandbox="allow-scripts" data-stamp="' + esc(v.stamp)
        + '" src="' + esc(v.url + busting) + '"></iframe>');
    } else if (kind === 'pdf') {
      /* Pas de sandbox : le lecteur PDF intégré n'y fonctionne pas. */
      h.push('<iframe class="reader-frame" title="Contenu du rapport" data-stamp="' + esc(v.stamp) + '" src="' + esc(v.url + busting) + '"></iframe>');
    } else if (kind === 'missing') {
      h.push('<div class="reader-note"><p><strong>Ce fichier n’existe plus.</strong></p><p>Il a été déplacé ou supprimé depuis que l’agent l’a écrit.</p></div>');
    } else if (kind === 'large') {
      h.push('<div class="reader-note"><p><strong>Fichier trop volumineux pour être affiché ici</strong> (' + esc(fmtSize(v.size)) + ').</p>'
        + '<p>Le bouton « VS Code » l’ouvre dans l’éditeur.</p></div>');
    } else if (kind === 'error') {
      h.push('<div class="reader-note"><p><strong>Lecture impossible.</strong></p><p>' + esc(r.error) + '</p></div>');
    } else {
      h.push('<div class="reader-note reader-loading">Lecture…</div>');
    }
    h.push('</div></div></div>');
    return h.join('');
  }

  function renderReader() {
    var host = $('#reader');
    if (!host) return;
    var r = S.ui.reader;
    /* Revues groupées : les onglets suivent les rapports qui paraissent (l'onglet actif peut changer). */
    if (r && r.group) { syncReviewGroup(r.group); r = S.ui.reader; }
    if (!r) {
      if (host.innerHTML) host.innerHTML = '';
      readerKey = null; readerStamp = null; readerFrame = null; readerReady = false;
      chatFrame = null; chatReady = false;
      return;
    }
    if (r.pending) { renderReviewPending(host, r); return; }
    if (reviewShown(r)) { renderReview(host, r); return; }
    var v = r.view;
    var kind = v ? v.kind : (r.error ? 'error' : 'loading');
    var key = r.path + '|' + r.cwd + '|' + kind + '|' + (r.back ? 'b' : '') + (r.group ? '|g' + r.taskId : '');
    if (readerKey !== key) {
      host.innerHTML = readerShellHtml(r, kind);
      readerKey = key; readerStamp = null; readerReady = false;
      readerFrame = host.querySelector('.reader-frame');
      chatFrame = null; chatReady = false;
      if (r.group) r.group.entered = true;
    }
    if (r.group) renderReviewTabs(host, r.group);
    if (!v || readerStamp === v.stamp) return;
    var first = readerStamp === null;
    readerStamp = v.stamp;
    var meta = host.querySelector('.reader-meta');
    if (meta) meta.textContent = readerMeta(v);
    if (first) return; /* le cadre vient d'être construit avec ce contenu ; le HTML attend son `ready` */
    if (READER_FRAMED[kind]) {
      pushReaderHtml(true);
    } else if ((kind === 'html' || kind === 'pdf') && readerFrame) {
      readerFrame.setAttribute('data-stamp', v.stamp);
      readerFrame.src = v.url + '?t=' + encodeURIComponent(v.stamp);
    }
  }

  /* `follow` : relecture d'un fichier déjà affiché — le cadre garde son défilement, ou suit la
     fin si on y était (un rapport qui s'écrit se lit au fil de l'eau). Dans la vue revue, le cadre
     montre le corps du constat ouvert. */
  function pushReaderHtml(follow) {
    var r = S.ui.reader;
    if (!r || !r.view || !readerFrame || !readerReady) return;
    var msg;
    if (reviewShown(r)) {
      var f = reviewCurrent(r);
      reviewPushed = (f ? f.key : '') + '|' + r.view.stamp;
      msg = { type: 'html', html: f ? f.html : '', follow: !!follow, variant: 'finding' };
    } else {
      if (!READER_FRAMED[r.view.kind]) return;
      /* `y` : le défilement retenu par l'onglet, quand on revient à son rapport complet. */
      msg = { type: 'html', html: r.view.html || '', follow: !!follow, y: follow ? 0 : r.docY || 0 };
    }
    try {
      readerFrame.contentWindow.postMessage(msg, '*');
    } catch (e) { /* cadre en cours de remplacement */ }
  }

  /* ── Vue revue ─────────────────────────────────────────────────────────
     Un rapport de revue de code (l'hôte y a trouvé des constats : readArtifact → `review`) ne se
     lit pas d'un bloc : il s'ouvre en plein écran sur l'inventaire de ses constats, en colonnes
     par criticité, comme l'écran Résultats de ReviewTool. Un clic ouvre un constat : son en-tête
     dans l'application, son corps dans le même cadre isolé que le lecteur (le Markdown de l'agent
     n'atteint toujours pas la page), la liste à côté, ↑ ↓ pour passer au suivant. « Rapport
     complet » rend le Markdown entier, dans le lecteur ordinaire. Rien n'est enregistré. */

  var REVIEW_SEV = {
    blocker: { label: 'Bloquant', many: 'Bloquants', color: '#c0392b', ink: '#9d2f24', weight: 30 },
    major: { label: 'Majeur', many: 'Majeurs', color: '#e08a1e', ink: '#9a5a0b', weight: 12 },
    minor: { label: 'Mineur', many: 'Mineurs', color: '#d9b21f', ink: '#7d6300', weight: 4 },
    info: { label: 'Suggestion', many: 'Suggestions', color: '#2f6fb5', ink: '#245a93', weight: 1 }
  };
  var REVIEW_ORDER = ['blocker', 'major', 'minor', 'info'];
  /* Pastille de tête d'un verdict (« 🔴 Ne pas merger ») : la couleur la dit déjà. */
  var REVIEW_MARK = /^\s*(?:🔴|🟠|🟡|🔵|🟢|✅|⚪|⛔|🛑|ℹ️?)\s*/;

  var reviewPushed = null, reviewAsideSel = null;

  /* Constats de la vue, rangés par gravité puis dans l'ordre du rapport ; calculés une fois par lecture. */
  function reviewModel(v) {
    if (!v || !v.review || !Array.isArray(v.review.findings) || !v.review.findings.length) return null;
    if (v.rvModel) return v.rvModel;
    var seen = {};
    var list = v.review.findings.map(function (f, i) {
      var key = String(f.id || i + 1);
      while (seen[key]) key += '′';
      seen[key] = true;
      return {
        key: key, id: String(f.id || ''), sev: REVIEW_SEV[f.severity] ? f.severity : 'minor',
        title: String(f.title || ''), category: String(f.category || ''), where: String(f.where || ''),
        tags: Array.isArray(f.tags) ? f.tags.map(String) : [], html: String(f.html || ''), order: i
      };
    });
    list.sort(function (a, b) { return REVIEW_ORDER.indexOf(a.sev) - REVIEW_ORDER.indexOf(b.sev) || a.order - b.order; });
    v.rvModel = { verdict: String(v.review.verdict || ''), level: String(v.review.level || ''), findings: list };
    return v.rvModel;
  }

  /* La vue revue l'emporte sur le lecteur tant qu'on ne lui a pas préféré le rapport complet. */
  function reviewShown(r) {
    if (!(r && r.view && r.mode !== 'doc' && reviewModel(r.view))) return false;
    if (!r.rv) r.rv = { sel: '', cat: '', scroll: 0 };
    return true;
  }

  /* Constats affichés : ceux de la catégorie retenue, s'il y en a une. */
  function reviewList(r) {
    var m = reviewModel(r.view);
    var cat = r.rv.cat;
    return cat ? m.findings.filter(function (f) { return f.category.toLowerCase() === cat; }) : m.findings;
  }

  function reviewCurrent(r) {
    if (!r || !r.rv || !r.rv.sel) return null;
    var m = reviewModel(r.view);
    for (var i = 0; m && i < m.findings.length; i++) if (m.findings[i].key === r.rv.sel) return m.findings[i];
    return null;
  }

  /* Santé de la branche, calculée comme dans ReviewTool : bloquant 30, majeur 12, mineur 4
     (suggestion 1) ; un bloquant la plafonne bas, aucun constat la met à 100. */
  function reviewHealth(m) {
    var weight = 0, blockers = 0;
    m.findings.forEach(function (f) { weight += REVIEW_SEV[f.sev].weight; if (f.sev === 'blocker') blockers++; });
    var score = Math.min(100, Math.max(blockers ? 5 : 55, Math.round(100 - weight * 0.9)));
    var tone = blockers ? REVIEW_SEV.blocker.color : (score >= 80 ? '#2b7a4b' : REVIEW_SEV.major.color);
    return { score: score, color: tone, blockers: blockers };
  }

  /* Niveau d'un rapport pour la pastille de son onglet : celui du verdict, sinon le constat le plus grave. */
  function reviewLevel(m) {
    if (REVIEW_SEV[m.level]) return m.level;
    if (m.level === 'ok') return 'ok';
    return m.findings[0] ? m.findings[0].sev : 'ok';
  }

  /* Le code d'un titre garde ses accents graves : on le rend en <code>, le reste échappé. */
  function tickHtml(text) {
    return String(text || '').split('`').map(function (part, i) {
      return i % 2 ? '<code>' + esc(part) + '</code>' : esc(part);
    }).join('');
  }

  /* Emplacement court pour une carte : le premier fichier cité (« Contact.cs:987 »), sinon le début du texte. */
  function reviewLoc(where) {
    var spans = String(where || '').match(/`[^`]+`/g) || [];
    for (var i = 0; i < spans.length; i++) {
      var m = /^(.*?[\w\-]+\.[A-Za-z][A-Za-z0-9]{0,7})(:\S*)?$/.exec(spans[i].slice(1, -1).trim());
      if (m) return lastSegment(m[1]) + (m[2] || '');
    }
    var plain = String(where || '').replace(/`/g, '').trim();
    return plain.length > 48 ? plain.slice(0, 47) + '…' : plain;
  }

  function reviewSevStyle(sev) {
    var s = REVIEW_SEV[sev];
    return '--sev:' + s.color + ';--sev-ink:' + s.ink;
  }

  function reviewRingHtml(h, size, hole) {
    return '<span class="rv-ring" style="width:' + size + 'px;height:' + size + 'px;background:conic-gradient('
      + h.color + ' ' + (h.score * 3.6) + 'deg, var(--color-neutral-300) 0)">'
      + (hole ? '<span class="rv-ring-hole" style="width:' + hole + 'px;height:' + hole + 'px">' + esc(h.score) + '</span>' : '')
      + '</span>';
  }

  function reviewCardHtml(f, talks) {
    var loc = reviewLoc(f.where);
    return '<button type="button" class="rv-card" data-act="rv-pick" data-key="' + esc(f.key) + '" style="' + reviewSevStyle(f.sev) + '">'
      + '<span class="rv-card-body">'
      + '<span class="rv-card-top">' + (f.id ? '<span class="rv-id">' + esc(f.id) + '</span>' : '')
      + (f.category ? '<span class="rv-cat">' + esc(f.category) + '</span>' : '')
      + f.tags.map(function (t) { return '<span class="rv-tag">' + esc(t) + '</span>'; }).join('')
      + talkMarkHtml(talks && talks[f.key]) + '</span>'
      + '<span class="rv-card-title">' + tickHtml(f.title) + '</span>'
      + (loc ? '<span class="rv-card-loc" title="' + esc(f.where.replace(/`/g, '')) + '">' + esc(loc) + '</span>' : '')
      + '</span></button>';
  }

  function reviewOverviewHtml(r, m) {
    var h = reviewHealth(m);
    var shown = reviewList(r);
    var verdict = m.verdict.replace(REVIEW_MARK, '');
    verdict = verdict.charAt(0).toUpperCase() + verdict.slice(1);
    var level = REVIEW_SEV[m.level] ? m.level : (m.level === 'ok' ? '' : (h.blockers ? 'blocker' : ''));
    var counts = REVIEW_ORDER.map(function (sev) {
      var n = m.findings.filter(function (f) { return f.sev === sev; }).length;
      return '<span class="rv-count" style="' + reviewSevStyle(sev) + '"><span class="rv-sq"></span><b>' + esc(n) + '</b>'
        + esc((n > 1 ? REVIEW_SEV[sev].many : REVIEW_SEV[sev].label).toLowerCase()) + '</span>';
    }).join('');

    var cats = {};
    m.findings.forEach(function (f) {
      if (!f.category) return;
      var k = f.category.toLowerCase();
      if (!cats[k]) cats[k] = { label: f.category, n: 0 };
      cats[k].n++;
    });
    var catKeys = Object.keys(cats);
    var filters = catKeys.length > 1
      ? '<div class="rv-filters"><span class="rv-filters-label">Catégories</span>'
        + '<button type="button" class="rv-chip" data-act="rv-cat" data-cat="" aria-pressed="' + (!r.rv.cat) + '">Toutes<span class="rv-chip-n">' + esc(m.findings.length) + '</span></button>'
        + catKeys.map(function (k) {
          return '<button type="button" class="rv-chip" data-act="rv-cat" data-cat="' + esc(k) + '" aria-pressed="' + (r.rv.cat === k) + '">'
            + esc(cats[k].label) + '<span class="rv-chip-n">' + esc(cats[k].n) + '</span></button>';
        }).join('') + '</div>'
      : '';

    var talks = findingTalks(r);
    var cols = REVIEW_ORDER.map(function (sev) {
      var items = shown.filter(function (f) { return f.sev === sev; });
      return '<section class="rv-col" style="' + reviewSevStyle(sev) + '"><div class="rv-col-head">'
        + '<span class="rv-col-label">' + esc(REVIEW_SEV[sev].many) + '</span><span class="rv-col-n">' + esc(items.length) + '</span></div>'
        + (items.length ? items.map(function (f) { return reviewCardHtml(f, talks); }).join('') : '<span class="rv-col-empty">Aucun</span>') + '</section>';
    }).join('');

    return '<div class="rv-overview-in">'
      + '<section class="rv-health">' + reviewRingHtml(h, 64, 52)
      + '<div class="rv-verdict"><span class="rv-kicker">' + (verdict ? 'Verdict' : 'Santé de la branche') + '</span>'
      + (verdict ? '<span class="rv-verdict-text">' + tickHtml(verdict) + '</span>' : '')
      + '<span class="rv-badge" style="' + reviewSevStyle(h.blockers ? 'blocker' : (level || 'info')) + '">'
      + esc(h.blockers ? h.blockers + (h.blockers > 1 ? ' bloquants avant merge' : ' bloquant avant merge') : 'Aucun bloquant') + '</span></div>'
      + '<div class="rv-counts">' + counts + '</div></section>'
      + filters
      + '<div class="rv-cols">' + cols + '</div>'
      + '</div>';
  }

  function reviewHeadHtml(r, m, f) {
    var shown = reviewList(r);
    var idx = -1;
    for (var i = 0; i < shown.length; i++) if (shown[i].key === f.key) idx = i;
    var talk = findingTalks(r)[f.key];
    var talking = !!r.rv.chat;
    return '<div class="rv-art-top"><span class="rv-art-pos">' + esc((idx + 1) + ' / ' + shown.length) + '</span>'
      + '<span class="rv-art-nav">'
      + '<button type="button" class="rv-nav-btn rv-talk-btn' + (talk && talk.running ? ' is-running' : '') + '" data-act="rv-chat" aria-pressed="' + talking + '" title="'
      + esc(talking ? 'Revenir à la liste des constats (Échap)' : 'Poser des questions sur ce constat à l’agent qui a écrit la revue') + '">'
      + ICON.talk + '<span>Discuter</span>' + (talk && talk.n ? '<span class="rv-talk-n">' + esc(talk.n) + '</span>' : '') + '</button>'
      + '<button type="button" class="rv-nav-btn" data-act="rv-prev"' + (idx <= 0 ? ' disabled' : '') + ' title="Constat précédent (↑)">‹ Précédent</button>'
      + '<button type="button" class="rv-nav-btn" data-act="rv-next"' + (idx >= shown.length - 1 ? ' disabled' : '') + ' title="Constat suivant (↓)">Suivant ›</button>'
      + '</span></div>'
      + '<div class="rv-art-badges"><span class="rv-badge">' + esc(REVIEW_SEV[f.sev].label) + '</span>'
      + (f.id ? '<span class="rv-id">' + esc(f.id) + '</span>' : '')
      + (f.category ? '<span class="rv-cat">' + esc(f.category) + '</span>' : '')
      + f.tags.map(function (t) { return '<span class="rv-tag">' + esc(t) + '</span>'; }).join('') + '</div>'
      + '<h2 class="rv-art-title">' + tickHtml(f.title) + '</h2>'
      + (f.where ? '<div class="rv-art-where"><span class="rv-art-where-k">Où</span>' + tickHtml(f.where) + '</div>' : '');
  }

  function reviewAsideHtml(r, m, f) {
    var shown = reviewList(r);
    var h = reviewHealth(m);
    var talks = findingTalks(r);
    var groups = REVIEW_ORDER.map(function (sev) {
      var items = shown.filter(function (x) { return x.sev === sev; });
      if (!items.length) return '';
      return '<div class="rv-side-group" style="' + reviewSevStyle(sev) + '"><div class="rv-side-head"><span class="rv-sq"></span>'
        + esc(items.length > 1 ? REVIEW_SEV[sev].many : REVIEW_SEV[sev].label) + '<span class="rv-col-n">' + esc(items.length) + '</span></div>'
        + items.map(function (x) {
          return '<button type="button" class="rv-side-item" data-act="rv-pick" data-key="' + esc(x.key) + '"'
            + (x.key === f.key ? ' aria-current="true"' : '') + '>'
            + '<span class="rv-side-id">' + esc(x.id || '·') + '</span>'
            + '<span class="rv-side-title">' + tickHtml(x.title) + '</span>' + talkMarkHtml(talks[x.key]) + '</button>';
        }).join('') + '</div>';
    }).join('');
    return '<button type="button" class="rv-overview-btn" data-act="rv-overview" title="Revenir aux colonnes (Échap)">'
      + reviewRingHtml(h, 28, 0) + '<span class="rv-overview-label">Vue d’ensemble</span>'
      + '<span class="rv-overview-score">santé ' + esc(h.score) + '</span></button>'
      + '<div class="rv-side-list">' + groups + '</div>'
      + '<div class="rv-keys">↑ ↓ constat précédent / suivant · ' + (r.group ? 'Ctrl + Pg↑ / Pg↓ ticket · ' : '') + 'Échap vue d’ensemble</div>';
  }

  function reviewShellHtml(r) {
    var v = r.view;
    var G = r.group;
    return '<div class="reader-backdrop rv-backdrop' + (G ? ' is-group' : '') + '"><div class="rv' + (G && G.entered ? '' : ' enter') + '" role="dialog" aria-label="Revue de code">'
      + '<div class="reader-bar">'
      + (r.back ? '<button type="button" class="dark-btn reader-btn reader-back" data-act="reader-back" title="Revenir au rapport précédent">‹</button>' : '')
      + '<span class="reader-icon">' + ICON.review + '</span>'
      + '<div class="reader-head"><div class="rv-title" title="' + esc(v.title) + '">' + esc(v.title || lastSegment(v.full)) + '</div>'
      + '<div class="reader-meta" data-role="rv-meta"></div></div>'
      + '<span class="panel-spacer"></span>'
      + '<button type="button" class="dark-btn reader-btn" data-act="rv-doc" title="Lire le rapport en entier">Rapport complet</button>'
      + '<button type="button" class="dark-btn reader-btn" data-act="reader-vscode" title="Ouvrir dans Visual Studio Code">VS Code</button>'
      + '<button type="button" class="dark-btn reader-btn" data-act="reader-folder" title="Afficher dans l’Explorateur">Dossier</button>'
      + '<button type="button" class="panel-x" data-act="close-reader" title="Fermer (Échap)">✕</button>'
      + '</div>'
      + (G ? '<div class="rv-tabs-host" data-role="rv-tabs"></div>' : '')
      + '<div class="rv-main">'
      + '<div class="rv-overview" data-role="rv-overview"></div>'
      + '<div class="rv-focus" data-role="rv-focus" hidden>'
      + '<article class="rv-article" data-role="rv-article"><div class="rv-art-head" data-role="rv-art-head"></div>'
      + '<div class="rv-art-body"><iframe class="reader-frame rv-frame" title="Détail du constat" sandbox="allow-scripts" srcdoc="'
      + esc(readerFrameDoc()) + '"></iframe></div></article>'
      + '<aside class="rv-aside" data-role="rv-aside"></aside>'
      /* Discussion sur le constat ouvert : construite une fois avec la vue, comme le cadre du constat.
         Le fil (texte de l'agent) est dans un cadre isolé ; la zone de saisie reste dans la page. */
      + '<section class="rv-chat" data-role="rv-chat" hidden aria-label="Discussion sur le constat">'
      + '<div class="rv-chat-head" data-role="rv-chat-head"></div>'
      + '<div class="rv-chat-body"><iframe class="reader-frame rv-chat-frame" title="Discussion sur le constat" sandbox="allow-scripts" srcdoc="'
      + esc(readerFrameDoc()) + '"></iframe></div>'
      + '<div class="rv-chat-form"><textarea class="input rv-chat-q" data-role="rv-chat-q" rows="2" spellcheck="true"></textarea>'
      + '<div class="rv-chat-actions" data-role="rv-chat-actions"></div></div>'
      + '</section>'
      + '</div></div></div></div>';
  }

  /* Ne réécrit un bloc que si son HTML a changé : un rendu de l'application (relecture des
     sessions…) ne doit ni faire clignoter la vue ni perdre un survol. */
  function setHtml(el, html) {
    if (el && el.rvHtml !== html) { el.innerHTML = html; el.rvHtml = html; }
  }

  /* Le cadre du constat est construit une fois pour toutes avec la vue : les rendus suivants
     ne touchent qu'à ce qui l'entoure, et lui poussent le corps du constat ouvert. */
  function renderReview(host, r) {
    var v = r.view;
    var m = reviewModel(v);
    var key = 'review|' + r.path + '|' + r.cwd + '|' + (r.back ? 'b' : '') + (r.group ? '|g' + r.taskId : '');
    var built = readerKey !== key;
    if (built) {
      host.innerHTML = reviewShellHtml(r);
      readerKey = key; readerStamp = null; readerReady = false;
      readerFrame = host.querySelector('.rv-frame');
      reviewPushed = null; reviewAsideSel = null;
      chatFrame = host.querySelector('.rv-chat-frame'); chatReady = false; chatPushed = null; chatShape = null;
      if (r.group) r.group.entered = true;
    }
    if (r.group) renderReviewTabs(host, r.group);
    readerStamp = v.stamp;
    var meta = host.querySelector('[data-role="rv-meta"]');
    if (meta) meta.textContent = lastSegment(v.full) + ' · ' + readerMeta(v);
    ensureFindingChats(v.full);

    if (r.rv.sel && !reviewCurrent(r)) r.rv.sel = '';
    var f = reviewCurrent(r);
    var overview = host.querySelector('[data-role="rv-overview"]');
    var focus = host.querySelector('[data-role="rv-focus"]');
    if (f) {
      /* Vue tout juste reconstruite (retour sur un onglet, d'un lien) : ses colonnes n'ont pas défilé. */
      if (!overview.hidden) { if (!built) r.rv.scroll = overview.scrollTop; overview.hidden = true; }
      focus.hidden = false;
      host.querySelector('[data-role="rv-article"]').setAttribute('style', reviewSevStyle(f.sev));
      setHtml(host.querySelector('[data-role="rv-art-head"]'), reviewHeadHtml(r, m, f));
      /* À côté du constat : la liste des autres, ou la discussion sur celui-ci. */
      var aside = host.querySelector('[data-role="rv-aside"]');
      var chatEl = host.querySelector('[data-role="rv-chat"]');
      aside.hidden = !!r.rv.chat;
      chatEl.hidden = !r.rv.chat;
      if (r.rv.chat) {
        reviewAsideSel = null;
        renderFindingChat(host, r, f);
      } else {
        setHtml(aside, reviewAsideHtml(r, m, f));
        if (reviewAsideSel !== f.key) {
          reviewAsideSel = f.key;
          var cur = host.querySelector('.rv-side-item[aria-current="true"]');
          if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
        }
      }
    } else {
      focus.hidden = true;
      reviewAsideSel = null;
      var back = overview.hidden;
      overview.hidden = false;
      setHtml(overview, reviewOverviewHtml(r, m));
      if (back || built) overview.scrollTop = r.rv.scroll || 0;
    }

    /* Nouveau constat : son corps part en haut ; même constat relu (le rapport s'écrit) : le défilement tient. */
    var pushKey = (f ? f.key : '') + '|' + v.stamp;
    if (readerReady && pushKey !== reviewPushed) {
      var same = reviewPushed !== null && reviewPushed.split('|')[0] === (f ? f.key : '');
      pushReaderHtml(same);
    }
  }

  /* Les colonnes vont disparaître (rapport complet, autre onglet) : leur défilement est relevé, la
     vue reconstruite au retour le reprend. */
  function keepReviewScroll(r) {
    var overview = $('#reader [data-role="rv-overview"]');
    if (overview && !overview.hidden && reviewShown(r) && !r.rv.sel) r.rv.scroll = overview.scrollTop;
  }

  function reviewPick(key) {
    var r = S.ui.reader;
    if (!reviewShown(r)) return;
    r.rv.sel = String(key || '');
    render();
  }

  function reviewStep(delta) {
    var r = S.ui.reader;
    var f = reviewCurrent(r);
    if (!f) return;
    var shown = reviewList(r);
    for (var i = 0; i < shown.length; i++) {
      if (shown[i].key !== f.key) continue;
      var next = shown[i + delta];
      if (next) reviewPick(next.key);
      return;
    }
  }

  /* Touches de la vue revue (depuis la page ou le cadre) : Échap remonte d'un cran — discussion,
     constat, puis vue d'ensemble, puis fermeture —, ↑ ↓ (et ← →) passent d'un constat à l'autre. */
  function reviewKey(key) {
    var r = S.ui.reader;
    if (!reviewShown(r)) return false;
    if (key === 'Escape') {
      if (r.rv.sel && r.rv.chat) closeFindingChat();
      else if (r.rv.sel) { r.rv.sel = ''; render(); } else { closeReader(); }
      return true;
    }
    if (!r.rv.sel) return false;
    if (key === 'ArrowUp' || key === 'ArrowLeft') { reviewStep(-1); return true; }
    if (key === 'ArrowDown' || key === 'ArrowRight') { reviewStep(1); return true; }
    return false;
  }

  /* ── Discussion sur un constat ───────────────────────────────────────────
     « Discuter », dans l'en-tête d'un constat, remplace la liste latérale par une discussion avec
     l'agent : la première question part dans une copie de la session qui a écrit la revue (il a
     déjà lu le ticket, le diff et le code ; l'original n'est pas touché), les suivantes reprennent
     cette copie. Sans session Claude à copier, un agent neuf lit le rapport et le code. Lecture
     seule, hors terminal : l'hôte appelle `claude -p` et pousse la réponse au fil de l'eau
     (événement `findingChat`). Les discussions sont gardées par l'hôte (finding-chats.json), une
     par constat ; la page n'en tient qu'une copie, par rapport, et le texte en cours de saisie. */

  var FINDING_WAIT_MS = 11 * 60000;
  /* Par rapport (chemin complet en minuscules) : { loaded, loading, chats: clé → discussion,
     runs: clé → réponse en cours, doneAt: clé → début de la dernière réponse rendue,
     stopping: clé → arrêt demandé, pour ne pas l'annoncer comme une réponse }. */
  var fcStore = {};
  var fcDrafts = {};
  var fcArmed = null, fcArmTimer = null, fcClock = null;
  var chatFrame = null, chatReady = false, chatPushed = null, chatShape = null;

  function fcGet(full) {
    var k = String(full || '').toLowerCase();
    return fcStore[k] || (fcStore[k] = { loaded: false, loading: false, chats: {}, runs: {}, doneAt: {}, stopping: {} });
  }

  function fcKey(full, key) { return String(full || '').toLowerCase() + '|' + key; }

  function ensureFindingChats(full) {
    var st = fcGet(full);
    if (!st.loaded && !st.loading) loadFindingChats(full);
  }

  function loadFindingChats(full) {
    var st = fcGet(full);
    st.loading = true;
    return bridge.call('getFindingChats', { report: full }).then(function (res) {
      st.loading = false;
      st.loaded = true;
      st.chats = {};
      ((res && res.chats) || []).forEach(function (c) { if (c && c.finding) st.chats[c.finding] = c; });
      ((res && res.running) || []).forEach(function (p) { if (p && p.finding && !st.runs[p.finding]) st.runs[p.finding] = p; });
      if (Object.keys(st.runs).length) startChatClock();
      fcRefresh(full);
    })['catch'](function (e) {
      st.loading = false;
      st.loaded = true;
      bridge.call('log', { level: 'warn', message: 'Discussions illisibles : ' + e.message })['catch'](function () { /* sans importance */ });
    });
  }

  /* Redessine la vue revue si elle montre ce rapport. */
  function fcRefresh(full) {
    var r = S.ui.reader;
    if (r && r.view && String(r.view.full || '').toLowerCase() === String(full || '').toLowerCase()) renderReader();
  }

  /* Constats qui ont une discussion : nombre de questions, réponse en cours. */
  function findingTalks(r) {
    var out = {};
    if (!r || !r.view) return out;
    var st = fcGet(r.view.full);
    Object.keys(st.chats).forEach(function (k) {
      var n = (st.chats[k].turns || []).length;
      if (n) out[k] = { n: n, running: false };
    });
    Object.keys(st.runs).forEach(function (k) { (out[k] = out[k] || { n: 0 }).running = true; });
    return out;
  }

  function talkMarkHtml(t) {
    if (!t) return '';
    var tip = t.running ? 'L’agent répond…' : t.n + (t.n > 1 ? ' questions posées' : ' question posée');
    return '<span class="rv-talk' + (t.running ? ' is-running' : '') + '" title="' + esc(tip) + '">' + ICON.talk
      + (t.n ? '<b>' + esc(t.n) + '</b>' : '') + '</span>';
  }

  /* La conversation qui a écrit le rapport (la plus récente si plusieurs l'ont touché) : c'est elle
     qu'on copie. Une session Copilot ne se copie pas : un agent Claude neuf prend le relais. */
  function reviewSourceConvo(full) {
    var want = String(full || '').toLowerCase();
    var best = null;
    if (!want) return null;
    S.data.convos.forEach(function (c) {
      if (c.taskId === FEEDBACK_ID) return;
      var wrote = (c.artifacts || []).some(function (a) {
        return a.action !== 'deleted' && artifactFullPath(a.path, c.cwd).toLowerCase() === want;
      });
      if (wrote && (!best || (toMs(c.updated) || toMs(c.created)) > (toMs(best.updated) || toMs(best.created)))) best = c;
    });
    return best;
  }

  function findingAgent(r) {
    var c = reviewSourceConvo(r.view.full);
    var fork = !!(c && providerOf(c) === 'claude');
    return {
      convo: c, fork: fork, source: fork ? c.id : '',
      cwd: c ? c.cwd : (r.cwd || folderOf(r.view.full)),
      model: fork ? c.model : S.settings.claudeModel,
      effort: fork ? c.effort : S.settings.claudeEffort,
      task: c ? taskById(c.taskId) : (r.taskId ? taskById(r.taskId) : null)
    };
  }

  function findingAgentLine(ag, chat) {
    var started = chat && chat.sessionId;
    var fork = started ? !!chat.source : ag.fork;
    var who = fork ? 'Copie de la session du relecteur' : (started ? 'Agent neuf' : 'Agent neuf (aucune session Claude à copier)');
    var conv = fork && ag.convo ? ' « ' + firstLine(ag.convo.title, 40) + ' »' : '';
    var model = (started ? chat.model : ag.model) || 'modèle par défaut';
    var effort = started ? chat.effort : ag.effort;
    return who + conv + ' · ' + model + (effort ? ' · ' + effort : '') + ' · lecture seule';
  }

  function openFindingChat() {
    var r = S.ui.reader;
    if (!reviewShown(r) || !reviewCurrent(r)) return;
    r.rv.chat = true;
    chatShape = null;
    render();
    var ta = $('#reader [data-role="rv-chat-q"]');
    if (ta) ta.focus();
  }

  function closeFindingChat() {
    var r = S.ui.reader;
    if (!r || !r.rv) return;
    r.rv.chat = false;
    render();
  }

  function renderFindingChat(host, r, f) {
    var full = r.view.full;
    var st = fcGet(full);
    var chat = st.chats[f.key] || null;
    var run = st.runs[f.key] || null;
    var ag = findingAgent(r);
    var bind = fcKey(full, f.key);
    var turns = chat && Array.isArray(chat.turns) ? chat.turns : [];
    var armed = fcArmed === bind;

    setHtml(host.querySelector('[data-role="rv-chat-head"]'), '<div class="rv-chat-top">'
      + '<button type="button" class="rv-nav-btn" data-act="rv-chat-close" title="Revenir à la liste des constats (Échap)">‹ Constats</button>'
      + '<span class="rv-chat-title">' + ICON.talk + '<span>Discussion' + (f.id ? ' · <b>' + esc(f.id) + '</b>' : '') + '</span></span>'
      + (turns.length ? '<button type="button" class="rv-nav-btn rv-chat-forget' + (armed ? ' is-armed' : '') + '" data-act="rv-chat-forget"'
        + (run ? ' disabled' : '') + ' title="Effacer cette discussion : la question suivante repartira d’une copie neuve de la revue">'
        + (armed ? 'Effacer la discussion ?' : 'Nouvelle discussion') + '</button>' : '')
      + '</div><div class="rv-chat-agent">' + esc(findingAgentLine(ag, chat)) + '</div>');

    var draft = fcDrafts[bind] || '';
    setHtml(host.querySelector('[data-role="rv-chat-actions"]'), run
      ? '<span class="rv-chat-status" data-role="rv-chat-clock">' + esc(runPhaseText(run)) + '</span>'
        + '<button type="button" class="rv-nav-btn rv-chat-stop" data-act="rv-chat-stop" title="Arrêter la réponse en cours">' + ICON.stop + 'Arrêter</button>'
      : '<span class="rv-chat-hint">Entrée envoie · Maj + Entrée : à la ligne</span>'
        + '<button type="button" class="rv-nav-btn rv-chat-send" data-act="rv-chat-send"' + (draft.trim() ? '' : ' disabled') + '>Envoyer</button>');

    var ta = host.querySelector('[data-role="rv-chat-q"]');
    if (ta.getAttribute('data-bound') !== bind) {
      ta.setAttribute('data-bound', bind);
      ta.value = draft;
      fitChatInput(ta);
    }
    var hint = run ? 'Votre prochaine question… (l’agent répond encore)'
      : (turns.length ? 'Une autre question sur ' : 'Votre question sur ') + (f.id || 'ce constat') + '…';
    if (ta.placeholder !== hint) ta.placeholder = hint;

    pushFindingChat();
    updateChatClock();
  }

  /* Le fil de la discussion, dans le cadre isolé : les réponses sont le Markdown de l'agent, rendu
     par l'hôte (comme le corps d'un constat), les questions sont échappées. */
  function findingThreadHtml(f, chat, run, ag) {
    var turns = chat && Array.isArray(chat.turns) ? chat.turns : [];
    var h = [];
    if (!turns.length && !run) {
      var fork = chat && chat.sessionId ? !!chat.source : ag.fork;
      h.push('<div class="chat-empty"><p><strong>Posez vos questions sur ' + esc(f.id || 'ce constat') + '.</strong></p><p>'
        + esc(fork
          ? 'Elles partent vers une copie de la session qui a écrit la revue : l’agent a déjà lu le ticket, le diff et le code. La session d’origine n’est pas touchée.'
          : 'Aucune session Claude de cette revue n’est disponible : un agent neuf lira le rapport et le code avant de répondre.')
        + '</p><p>L’agent est en lecture seule : il relit le code et l’historique, ne modifie rien et ne poste rien.</p>'
        + '<p class="chat-ideas">Par exemple : « Pourquoi bloquant plutôt que majeur ? », « Montre-moi le chemin qui déclenche le problème », '
        + '« La correction proposée casse-t-elle autre chose ? »</p></div>');
    }
    turns.forEach(function (t) {
      h.push('<section class="turn' + (t.error ? ' is-error' : '') + '"><div class="q">' + esc(t.q) + '</div>'
        + (t.html ? '<div class="a">' + t.html + '</div>' : '')
        + (t.error ? '<div class="a-error">' + esc(t.error) + '</div>' : '')
        + '<div class="a-meta">' + esc(turnMeta(t)) + '</div></section>');
    });
    if (run) {
      var steps = Array.isArray(run.steps) ? run.steps : [];
      h.push('<section class="turn is-running"><div class="q">' + esc(run.q) + '</div>'
        + (steps.length ? '<ol class="steps">' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : '')
        + (run.html ? '<div class="a">' + run.html + '</div>' : '')
        + '<div class="a-meta is-wait">' + esc(runPhaseText(run)) + '</div></section>');
    }
    return '<div class="chat">' + h.join('') + '</div>';
  }

  /* Pousse le fil au cadre s'il a changé. Une question de plus (ou un autre constat) ramène en
     bas ; une réponse qui s'écrit garde la lecture en place, ou suit la fin si on y était. */
  function pushFindingChat() {
    var r = S.ui.reader;
    if (!chatFrame || !chatReady || !reviewShown(r) || !r.rv.chat) return;
    var f = reviewCurrent(r);
    if (!f) return;
    var st = fcGet(r.view.full);
    var chat = st.chats[f.key] || null, run = st.runs[f.key] || null;
    var html = findingThreadHtml(f, chat, run, findingAgent(r));
    var shape = r.view.full + '|' + f.key + '|' + (chat && chat.turns ? chat.turns.length : 0) + '|' + (run ? 'r' : '');
    if (html === chatPushed && shape === chatShape) return;
    var jump = shape !== chatShape;
    chatPushed = html;
    chatShape = shape;
    try {
      chatFrame.contentWindow.postMessage({ type: 'html', html: html, follow: !jump, y: jump ? 1e9 : 0, variant: 'chat' }, '*');
    } catch (e) { /* cadre en cours de remplacement */ }
  }

  function turnMeta(t) {
    var parts = [fmtTime(t.at)];
    if (t.ms) parts.push(fmtSpan(t.ms));
    if (t.error) parts.push('échec');
    return parts.filter(Boolean).join(' · ');
  }

  function fmtSpan(ms) {
    var s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + ('0' + (s % 60)).slice(-2);
  }

  function runPhaseText(run) {
    var steps = Array.isArray(run.steps) ? run.steps : [];
    if (run.phase === 'tool' && steps.length) return steps[steps.length - 1] + '…';
    if (run.phase === 'writing') return 'L’agent répond…';
    return steps.length || run.text ? 'L’agent réfléchit…' : 'L’agent reprend la revue…';
  }

  /* Le temps écoulé se met à jour seul, sans redessiner la vue. */
  function updateChatClock() {
    var r = S.ui.reader;
    var el = $('#reader [data-role="rv-chat-clock"]');
    var f = r && reviewShown(r) ? reviewCurrent(r) : null;
    var run = f ? fcGet(r.view.full).runs[f.key] : null;
    if (el && run) el.textContent = runPhaseText(run) + ' · ' + fmtSpan(Date.now() - (toMs(run.startedAt) || Date.now()));
    var any = Object.keys(fcStore).some(function (k) { return Object.keys(fcStore[k].runs).length > 0; });
    if (!any && fcClock) { clearInterval(fcClock); fcClock = null; }
  }

  function startChatClock() {
    if (!fcClock) fcClock = setInterval(updateChatClock, 1000);
  }

  function fitChatInput(ta) {
    ta.rows = Math.min(8, Math.max(2, String(ta.value || '').split('\n').length));
  }

  function sendFindingQuestion() {
    var r = S.ui.reader;
    if (!reviewShown(r)) return;
    var f = reviewCurrent(r);
    if (!f) return;
    var full = r.view.full;
    var st = fcGet(full);
    var bind = fcKey(full, f.key);
    var ta = $('#reader [data-role="rv-chat-q"]');
    var q = String((ta && ta.getAttribute('data-bound') === bind ? ta.value : fcDrafts[bind]) || '').trim();
    if (!q) return;
    if (st.runs[f.key]) { toast('L’agent répond encore : attendez sa réponse, ou arrêtez-la.'); return; }
    var chat = st.chats[f.key] || null;
    var started = !!(chat && chat.sessionId);
    var ag = findingAgent(r);
    var task = ag.task;
    st.runs[f.key] = { report: full, finding: f.key, q: q, phase: 'thinking', text: '', html: '', steps: [], startedAt: Date.now() };
    fcDrafts[bind] = '';
    if (ta) { ta.value = ''; fitChatInput(ta); }
    startChatClock();
    renderReader();
    bridge.call('askFinding', {
      report: full, cwd: ag.cwd, source: ag.source,
      /* Une discussion commencée garde son modèle : la copie et le cache de l'API vont avec. */
      model: started ? String(chat.model || '') : ag.model,
      effort: started ? String(chat.effort || '') : ag.effort,
      context: task ? String(task.text || '').slice(0, 3000) : '',
      question: q,
      finding: { key: f.key, id: f.id, order: f.order, title: f.title, severity: f.sev, where: f.where, category: f.category }
    }, FINDING_WAIT_MS).then(function (res) {
      if (res && res.finding) st.chats[res.finding] = res;
      delete st.runs[f.key];
      fcRefresh(full);
    })['catch'](function (e) {
      delete st.runs[f.key];
      /* Rien n'est perdu : la question revient dans la zone de saisie. */
      if (!fcDrafts[bind]) fcDrafts[bind] = q;
      var cur = $('#reader [data-role="rv-chat-q"]');
      if (cur && cur.getAttribute('data-bound') === bind && !cur.value.trim()) { cur.value = q; fitChatInput(cur); }
      toast('Question non envoyée : ' + e.message);
      fcRefresh(full);
    });
  }

  function stopFindingAnswer() {
    var r = S.ui.reader;
    var f = reviewShown(r) ? reviewCurrent(r) : null;
    if (!f) return;
    var st = fcGet(r.view.full);
    (st.stopping = st.stopping || {})[f.key] = true;
    bridge.call('stopFinding', { report: r.view.full, finding: f.key })['catch'](function (e) {
      delete st.stopping[f.key];
      toast('Arrêt impossible : ' + e.message);
    });
  }

  /* La discussion de ce constat est-elle sous les yeux ? */
  function fcWatching(full, key) {
    var r = S.ui.reader;
    return !!(r && r.view && r.rv && r.rv.chat && r.rv.sel === key && document.visibilityState !== 'hidden'
      && String(r.view.full || '').toLowerCase() === String(full || '').toLowerCase());
  }

  /* Rouvre un rapport sur la discussion d'un de ses constats (toast « Voir »). */
  function openFindingChatAt(full, key) {
    var r = S.ui.reader;
    if (!(r && r.view && String(r.view.full || '').toLowerCase() === String(full || '').toLowerCase())) {
      openReader(full, '');
      r = S.ui.reader;
    }
    r.mode = 'review';
    r.rv = r.rv || { sel: '', cat: '', scroll: 0 };
    r.rv.cat = '';
    r.rv.sel = key;
    r.rv.chat = true;
    chatShape = null;
    render();
  }

  /* « Nouvelle discussion » : un premier clic arme le bouton, un second (dans les 4 s) efface. */
  function forgetFindingChat() {
    var r = S.ui.reader;
    var f = reviewShown(r) ? reviewCurrent(r) : null;
    if (!f) return;
    var full = r.view.full;
    var bind = fcKey(full, f.key);
    clearTimeout(fcArmTimer);
    if (fcArmed !== bind) {
      fcArmed = bind;
      fcArmTimer = setTimeout(function () { fcArmed = null; renderReader(); }, 4000);
      renderReader();
      return;
    }
    fcArmed = null;
    bridge.call('forgetFinding', { report: full, finding: f.key }).then(function () {
      delete fcGet(full).chats[f.key];
      chatShape = null;
      fcRefresh(full);
      toast('Discussion effacée : la prochaine question repartira d’une copie neuve de la revue');
    })['catch'](function (e) { toast('Effacement impossible : ' + e.message); renderReader(); });
  }

  /* Avancement poussé par l'hôte ; `done` : la réponse est rangée, on relit la discussion. Un
     avancement d'une réponse déjà rendue (arrivé en retard) est ignoré. */
  function onFindingChat(p) {
    if (!p || !p.report || !p.finding) return;
    var st = fcGet(p.report);
    var key = String(p.finding);
    if (p.phase === 'done') {
      st.doneAt[key] = toMs(p.startedAt);
      delete st.runs[key];
      loadFindingChats(p.report);
      /* Une réponse met une à trois minutes : si l'on est passé à autre chose, un toast y ramène. */
      if (st.stopping && st.stopping[key]) delete st.stopping[key];
      else if (!fcWatching(p.report, key)) {
        toast('L’agent a répondu sur ' + key.replace(/′/g, '') + ' : « ' + firstLine(p.q, 50) + ' »',
          { label: 'Voir', run: function () { openFindingChatAt(p.report, key); } });
      }
    } else {
      if (toMs(p.startedAt) && st.doneAt[key] >= toMs(p.startedAt)) return;
      st.runs[key] = p;
      startChatClock();
    }
    fcRefresh(p.report);
  }

  /* Messages du cadre de la discussion : prêt, lien cliqué, Échap, Ctrl + Pg↑ / Pg↓. Les flèches
     y font défiler le fil, elles ne changent pas de constat. */
  function onChatFrameMessage(m) {
    if (m.type === 'ready') {
      chatReady = true;
      chatPushed = null;
      chatShape = null;
      pushFindingChat();
    } else if (m.type === 'close') {
      reviewKey('Escape');
    } else if (m.type === 'key') {
      var key = String(m.key || '');
      if (key === 'TabNext' || key === 'TabPrev') reviewGroupStep(key === 'TabNext' ? 1 : -1);
    } else if (m.type === 'link') {
      followReaderLink(m.href);
    }
  }

  /* ── Toast ──────────────────────────────────────────────────────────── */

  var toastTimer = null;
  function renderToast() {
    var act = S.ui.toast ? S.ui.toastAction : null;
    $('#toast-host').innerHTML = S.ui.toast
      ? '<div class="toast' + (act ? ' has-act' : '') + '">' + esc(S.ui.toast)
        + (act ? '<button type="button" class="toast-act" data-act="toast-act">' + esc(act.label) + '</button>' : '') + '</div>'
      : '';
  }
  /* `action` : { label, run } — un bouton dans le toast, qui reste alors 12 s pour laisser le temps de cliquer. */
  function toast(msg, action) {
    S.ui.toast = msg;
    S.ui.toastAction = action || null;
    renderToast();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(clearToast, action ? 12000 : 3400);
  }
  function clearToast() {
    clearTimeout(toastTimer);
    S.ui.toast = '';
    S.ui.toastAction = null;
    renderToast();
  }

  /* ══ Actions — tâches ═════════════════════════════════════════════════ */

  function commit() { regroupTasks(); saveDataNow(); render(); }

  function toggleDone(id) {
    var t = taskById(id); if (!t) return;
    t.done = !t.done;
    commit();
  }

  /* Le bouton bascule l'état *affiché* (« en cours » n'est visible que sur une tâche non
     terminée) : sur une tâche terminée qui avait gardé doing, il la remet en cours. */
  function toggleDoing(id) {
    var t = taskById(id); if (!t) return;
    t.doing = !(t.doing && !t.done);
    if (t.doing) t.done = false;
    commit();
  }

  /* Seule une tâche terminée s'efface : la règle tient aussi ici, pour qu'aucun autre chemin
     (rendu en retard, raccourci) ne fasse disparaître une tâche encore en file. */
  function removeTask(id) {
    var task = taskById(id);
    if (!task || !task.done) return;
    /* Ses sous-tâches ne meurent pas avec lui : elles reprennent la file là où elles étaient. */
    var orphans = childrenOf(id);
    orphans.forEach(function (k) { delete k.parent; });
    S.data.tasks = S.data.tasks.filter(function (t) { return t.id !== id; });
    S.data.convos = S.data.convos.filter(function (c) { return c.taskId !== id; });
    /* Ses pièces jointes sont des copies : elles partent avec elle (les originaux restent où ils sont). */
    cancelOwnerTranscriptions(id);
    if (Array.isArray(task.attachments)) {
      task.attachments.forEach(function (a) {
        var p = textPending[a.id];
        if (p) { clearTimeout(p.timer); delete textPending[a.id]; }
      });
      bridge.call('removeAttachments', { taskId: id })['catch'](function () { /* sans importance */ });
    }
    if (S.ui.termTaskId === id) {
      S.ui.termTaskId = null; S.ui.termConvId = null; S.ui.artifactView = false; S.ui.artifactConvId = null; syncPolling();
    }
    if (S.ui.editingId === id) S.ui.editingId = null;
    commit();
  }

  function setType(taskId, typeId) {
    var t = taskById(taskId); if (!t) return;
    t.type = typeId;
    if (S.ui.termTaskId === taskId) S.ui.newConvoKeywords = [];
    commit();
  }

  function move(id, delta) {
    var i = S.data.tasks.findIndex(function (t) { return t.id === id; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= S.data.tasks.length) return;
    S.data.tasks.splice(j, 0, S.data.tasks.splice(i, 1)[0]);
    commit();
  }

  /* Ranger une tâche tout en bas de la file, sans la supprimer : ce que faisait le tri d'office
     des tâches terminées, devenu un geste. */
  function moveToBottom(id) {
    var t = taskById(id);
    if (!t) return;
    var parent = parentOf(t);
    var block = [t].concat(childrenOf(id));
    var ids = {};
    block.forEach(function (x) { ids[x.id] = true; });
    var rest = S.data.tasks.filter(function (x) { return !ids[x.id]; });
    if (parent) {
      /* Une sous-tâche descend en bas de sa fratrie, pas de la file. */
      var sibs = rest.filter(function (x) { return x.parent === parent.id; });
      rest.splice(rest.indexOf(sibs.length ? sibs[sibs.length - 1] : parent) + 1, 0, t);
    } else {
      rest = rest.concat(block);
    }
    S.data.tasks = rest;
    commit();
  }

  /* ══ Actions — catégories ═════════════════════════════════════════════ */

  function addCat() {
    var name = S.ui.catName.trim();
    if (!name) return;
    var p = PALETTES.filter(function (x) { return x.id === S.ui.catPalette; })[0] || PALETTES[0];
    var t = { id: uid('k'), label: name, bg: p.bg, fg: p.fg, bd: p.bd, keywords: [], custom: true };
    S.data.types.push(t);
    S.ui.catFormOpen = false;
    S.ui.catName = '';
    S.ui.composerType = t.id;
    S.ui.composerOpen = true;
    if (!S.ui.composerId) S.ui.composerId = uid('n');
    commit();
  }

  /* ── Dialogue « Catégories » ─────────────────────────────────────────── */

  function openCats() {
    S.ui.catsOpen = true;
    S.ui.catKeywordDraft = {};
    S.ui.catKeywordEdit = '';
    render();
  }

  function closeCats() {
    // Un nom vidé en cours de route laisserait une pastille sans texte dans la file ; un mot-clé
    // sans nom, ou en double, ne survit pas à la normalisation.
    S.data.types.forEach(function (ty) {
      if (!String(ty.label == null ? '' : ty.label).trim()) ty.label = 'Sans nom';
      ty.keywords = normalizeKeywords(ty.keywords);
    });
    S.ui.catsOpen = false;
    S.ui.catKeywordDraft = {};
    S.ui.catKeywordEdit = '';
    if (S.ui.termTaskId) {
      S.ui.newConvoKeywords = keywordIdsFor(taskById(S.ui.termTaskId), S.ui.newConvoKeywords);
    }
    commit();
  }

  function newCatInDialog() {
    var p = PALETTES[S.data.types.length % PALETTES.length];
    var t = { id: uid('k'), label: 'Nouvelle catégorie', bg: p.bg, fg: p.fg, bd: p.bd, keywords: [], custom: true };
    S.data.types.push(t);
    commit();
    var el = document.querySelector('[data-focus-key="cat-label-' + t.id + '"]');
    if (el) { el.focus(); el.select(); }
  }

  function setCatPalette(id, paletteId) {
    var ty = typeOf(id);
    var p = PALETTES.filter(function (x) { return x.id === paletteId; })[0];
    if (ty === NOTYPE || !p) return;
    ty.bg = p.bg;
    ty.fg = p.fg;
    ty.bd = p.bd;
    commit();
  }

  /* Ajoute les mots-clés tapés dans une catégorie et renvoie le dernier créé, s'il y en a un. */
  function addKeywordsTo(ty, names) {
    if (ty === NOTYPE) return null;
    var before = normalizeKeywords(ty.keywords);
    var merged = normalizeKeywords(before.concat(names.map(function (name) { return { name: name }; })));
    ty.keywords = merged;
    if (merged.length === before.length) return null;
    return merged[merged.length - 1];
  }

  function addKeyword(id) {
    var ty = typeOf(id);
    if (ty === NOTYPE) return;
    var added = addKeywordsTo(ty, parseKeywordNames(S.ui.catKeywordDraft[id] || ''));
    S.ui.catKeywordDraft[id] = '';
    if (!added) { render(); return; }
    // Un mot-clé sans consigne ne sert pas à grand-chose : son éditeur s'ouvre aussitôt.
    S.ui.catKeywordEdit = added.id;
    commit();
    var el = document.querySelector('[data-focus-key="kw-prompt-' + added.id + '"]');
    if (el) el.focus();
  }

  function setKeywordField(typeId, keywordId, field, value) {
    var ty = typeOf(typeId);
    if (ty === NOTYPE || !Array.isArray(ty.keywords)) return;
    ty.keywords.forEach(function (kw) {
      if (kw.id === keywordId) kw[field] = value;
    });
    saveDataSoon();
  }

  function setAgentField(typeId, keywordId, agentId, field, value) {
    var a = agentOf(keywordOf(typeId, keywordId), agentId);
    if (!a) return;
    a[field] = value;
    saveDataSoon();
  }

  /* Équipe proposée par ✦ : on garde l'identifiant des agents dont le nom ne change pas, pour ne pas
     refermer sous les doigts la mission qu'on était en train de lire. */
  function setKeywordAgents(typeId, keywordId, agents) {
    var kw = keywordOf(typeId, keywordId);
    if (!kw) return;
    var before = {};
    (Array.isArray(kw.agents) ? kw.agents : []).forEach(function (a) { if (a.name) before[lower(a.name)] = a.id; });
    kw.agents = normalizeAgents((agents || []).map(function (a) {
      return { id: before[lower(a.name)] || a.id, name: a.name, role: a.role,
        model: a.model, effort: a.effort, prompt: a.prompt };
    }));
    kw.team = true;
  }

  function addAgent(typeId, keywordId) {
    var kw = keywordOf(typeId, keywordId);
    if (!kw) return;
    var agents = normalizeAgents(kw.agents);
    if (agents.length >= AGENT_MAX) { toast('Huit agents au plus dans une équipe.'); return; }
    var added = { id: uid('a'), name: '', role: '', model: '', effort: '', prompt: '' };
    kw.agents = agents.concat([added]);
    kw.team = true;
    commit();
    var box = document.querySelector('[data-focus-key="agent-name-' + added.id + '"]');
    if (box) box.focus();
  }

  function removeAgent(typeId, keywordId, agentId) {
    var kw = keywordOf(typeId, keywordId);
    if (!kw) return;
    kw.agents = normalizeAgents(kw.agents).filter(function (a) { return a.id !== agentId; });
    if (S.ui.draft && S.ui.draft.key === 'agent:' + agentId) S.ui.draft = null;
    commit();
  }

  function removeKeyword(id, keywordId) {
    var ty = typeOf(id);
    if (ty === NOTYPE) return;
    ty.keywords = normalizeKeywords(ty.keywords).filter(function (kw) { return kw.id !== keywordId; });
    // Un mot-clé retiré de la catégorie ne peut plus être celui d'une conversation.
    S.data.convos.forEach(function (convo) {
      var task = taskById(convo.taskId);
      if (task && task.type === ty.id) convo.keywords = keywordIdsFor(task, convo.keywords);
    });
    if (S.ui.catKeywordEdit === keywordId) S.ui.catKeywordEdit = '';
    if (S.ui.termTaskId) {
      S.ui.newConvoKeywords = keywordIdsFor(taskById(S.ui.termTaskId), S.ui.newConvoKeywords);
    }
    commit();
  }

  function resetNewKeyword() {
    S.ui.newKeywordOpen = false;
    S.ui.newKeywordName = '';
    S.ui.newKeywordPrompt = '';
    S.ui.newKeywordTeam = false;
    S.ui.newKeywordAgents = [];
  }

  /* Création d'un mot-clé depuis le formulaire de lancement : il est aussitôt coché. */
  function addKeywordFromLaunch() {
    var task = taskById(S.ui.termTaskId);
    var ty = task ? typeOf(task.type) : NOTYPE;
    var names = parseKeywordNames(S.ui.newKeywordName);
    if (ty === NOTYPE || !names.length) { toast('Donnez un nom au mot-clé.'); return; }
    var added = addKeywordsTo(ty, names.slice(0, 1));
    if (!added) { toast('Ce mot-clé existe déjà.'); S.ui.newKeywordOpen = false; render(); return; }
    added.prompt = String(S.ui.newKeywordPrompt || '').trim().slice(0, 4000);
    added.team = !!S.ui.newKeywordTeam;
    added.agents = normalizeAgents(S.ui.newKeywordAgents);
    S.ui.newConvoKeywords = keywordIdsFor(task, (S.ui.newConvoKeywords || []).concat([added.id]));
    resetNewKeyword();
    commit();
  }

  function removeCat(id) {
    if (S.data.tasks.some(function (t) { return t.type === id; })) {
      toast('Cette catégorie est utilisée par des tâches.');
      return;
    }
    S.data.types = S.data.types.filter(function (t) { return t.id !== id; });
    if (S.ui.composerType === id) {
      S.ui.composerType = S.data.types.length ? S.data.types[S.data.types.length - 1].id : null;
    }
    if (S.data.lastType === id) S.data.lastType = S.ui.composerType;
    S.ui.hidden = S.ui.hidden.filter(function (x) { return x !== id; });
    commit();
  }

  /* ══ Actions — composer ═══════════════════════════════════════════════ */

  /* `parentId` : la tâche créée sera une sous-tâche de celle-là, dans sa catégorie. */
  function openComposer(at, parentId) {
    var parent = parentId ? taskById(parentId) : null;
    if (parent && parent.parent) parent = parentOf(parent) || parent;
    dropComposerAttachments();
    S.ui.composerId = uid('n');
    S.ui.composerOpen = true;
    S.ui.insertAt = at;
    S.ui.composerParent = parent ? parent.id : null;
    if (parent) S.ui.composerType = parent.type;
    S.ui.prImport = null;
    S.ui.catFormOpen = S.data.types.length === 0;
    S.ui.termTaskId = null;
    S.ui.termConvId = null;
    S.ui.artifactView = false;
    S.ui.artifactConvId = null;
    syncPolling();
    render();
  }

  function closeComposer() {
    dropComposerAttachments();
    S.ui.composerOpen = false;
    S.ui.composerText = '';
    S.ui.composerParent = null;
    S.ui.catFormOpen = false;
    S.ui.prImport = null;
    render();
  }

  function addFromComposer() {
    var text = S.ui.composerText.trim();
    if (!text || !S.ui.composerType) return;
    var t = { id: S.ui.composerId || uid('n'), type: S.ui.composerType, text: text, done: false, doing: false, created: Date.now() };
    /* Les pièces jointes sont déjà copiées sous l'identifiant de la tâche : elle les emporte. */
    if (S.ui.composerAttachments.length) t.attachments = S.ui.composerAttachments;
    S.ui.composerAttachments = [];
    S.ui.composerId = null;
    var parent = S.ui.composerParent ? taskById(S.ui.composerParent) : null;
    var at = S.ui.insertAt || 'top';
    var idx = 0;
    if (at === 'bottom') idx = S.data.tasks.length;
    else if (at !== 'top') {
      var j = S.data.tasks.findIndex(function (x) { return x.id === at; });
      idx = j < 0 ? 0 : j + 1;
    }
    if (parent) {
      /* Dans le groupe du parent : après la tâche visée si elle en fait partie, sinon en dernier.
         Un groupe replié se déplie, sans quoi la sous-tâche créée disparaîtrait aussitôt. */
      t.parent = parent.id;
      delete parent.collapsed;
      var anchor = at !== 'top' && at !== 'bottom' ? taskById(at) : null;
      if (!anchor || (anchor.id !== parent.id && anchor.parent !== parent.id)) {
        idx = S.data.tasks.indexOf(lastOfGroup(parent)) + 1;
      }
    }
    S.data.tasks.splice(idx, 0, t);
    S.ui.composerOpen = false;
    S.ui.composerText = '';
    S.ui.composerParent = null;
    S.ui.catFormOpen = false;
    commit();
  }

  /* ══ Actions — glisser-déposer ════════════════════════════════════════ */

  function itemEl(id) {
    var items = $('#list').querySelectorAll('.item');
    for (var i = 0; i < items.length; i++) if (items[i].getAttribute('data-item') === id) return items[i];
    return null;
  }

  function clearDropMarks() {
    var marked = $('#list').querySelectorAll('.item[data-drop]');
    for (var i = 0; i < marked.length; i++) marked[i].removeAttribute('data-drop');
  }

  function markDrop() {
    clearDropMarks();
    if (!S.ui.dragId || !S.ui.overId || S.ui.overId === S.ui.dragId) return;
    var el = itemEl(S.ui.overId);
    if (el) el.setAttribute('data-drop', S.ui.overBefore ? 'before' : 'after');
  }

  /* `tail` : dépôt sur le trou du bas de file — après le dernier groupe, au premier niveau. */
  function setOver(id, before, tail) {
    if (!S.ui.dragId || S.ui.dragId === id) return;
    if (S.ui.overId === id && S.ui.overBefore === before && !!S.ui.overTail === !!tail) return;
    S.ui.overId = id;
    S.ui.overBefore = before;
    S.ui.overTail = !!tail;
    markDrop();
  }

  function endDrag() {
    S.ui.dragId = null; S.ui.overId = null; S.ui.overBefore = null; S.ui.overTail = false;
    $('#list').classList.remove('dragging');
    var d = $('#list').querySelector('.task.is-dragging');
    if (d) d.classList.remove('is-dragging');
    clearDropMarks();
  }

  /* Le dépôt tient compte des groupes. Un parent emmène ses sous-tâches et reste de premier niveau :
     posé avant ou après le groupe visé, jamais dedans. Une tâche seule déposée parmi des sous-tâches
     en devient une (avant ou après celle visée) ; déposée juste sous la carte d'un parent, elle
     devient sa première sous-tâche ; posée avant une tâche de premier niveau, après un groupe entier
     ou sur le trou du bas de file, elle est de premier niveau. */
  function dropNow() {
    var dragId = S.ui.dragId, overId = S.ui.overId, overBefore = S.ui.overBefore, tail = !!S.ui.overTail;
    if (!dragId || !overId || dragId === overId) { endDrag(); return; }
    var drag = taskById(dragId), over = taskById(overId);
    if (!drag || !over || over.parent === dragId) { endDrag(); return; }
    var block = [drag].concat(childrenOf(dragId));
    var ids = {};
    block.forEach(function (t) { ids[t.id] = true; });
    S.data.tasks = S.data.tasks.filter(function (t) { return !ids[t.id]; });
    var overParent = parentOf(over);
    var anchor = over, after = !overBefore, asChildOf = null;
    if (tail) {
      anchor = lastOfGroup(overParent || over);
      after = true;
    } else if (block.length > 1) {
      if (overParent) { anchor = overBefore ? overParent : lastOfGroup(overParent); after = !overBefore; }
      else if (after) anchor = lastOfGroup(over);
    } else if (overParent) {
      asChildOf = overParent.id;
    } else if (after && childrenOf(over.id).length) {
      /* Sous la carte d'un parent replié, on ne voit pas ses sous-tâches : la tâche se pose
         après le groupe, au premier niveau, plutôt que de disparaître dedans. */
      if (subsFolded(over)) anchor = lastOfGroup(over);
      else asChildOf = over.id;
    }
    if (asChildOf) drag.parent = asChildOf; else delete drag.parent;
    var to = S.data.tasks.indexOf(anchor);
    if (to < 0) to = S.data.tasks.length; else if (after) to += 1;
    Array.prototype.splice.apply(S.data.tasks, [to, 0].concat(block));
    endDrag();
    commit();
  }

  /* ══ Actions — panneau agent ══════════════════════════════════════════ */

  var pollTimer = null;
  var transcriptToken = 0;

  function syncPolling() {
    var want = !!S.ui.termConvId;
    if (want && !pollTimer) pollTimer = setInterval(function () { loadTranscript(true); }, 2000);
    if (!want && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function openTerm(taskId) {
    var convs = convosOf(taskId);
    markTaskNotificationsRead(taskId);
    S.ui.termTaskId = taskId;
    S.ui.termConvId = convs.length === 1 && taskId !== FEEDBACK_ID ? convs[0].id : null;
    S.ui.artifactView = false;
    S.ui.artifactConvId = null;
    S.ui.newConvoOpen = false;
    S.ui.transcript = null;
    render();
    syncPolling();
    refreshSessions();
    if (S.ui.termConvId) loadTranscript();
  }

  /* Ce que fait le clic sur l'icône de console d'une carte reste au choix (`termClick`) : le panneau,
     ou le terminal de la seule conversation — sa fenêtre ramenée, ou la session reprise si elle a été
     fermée (resumeConvo). Avec plusieurs conversations, ou aucune, le panneau s'ouvre : c'est là
     qu'on choisit, ou qu'on en lance une. Maj + clic fait l'autre, pour que le panneau d'une tâche à
     une seule conversation reste à portée — c'est lui qui en lance une seconde. */
  function wantsTerminal(convs, shift) {
    return convs.length === 1 && (S.settings.termClick === 'terminal') !== !!shift;
  }

  function clickTerm(taskId, shift) {
    var convs = convosOf(taskId);
    if (!wantsTerminal(convs, shift)) { openTerm(taskId); return; }
    if (markTaskNotificationsRead(taskId)) render();
    resumeConvo(convs[0].id);
  }

  function closeTerm() {
    S.ui.termTaskId = null;
    S.ui.termConvId = null;
    S.ui.artifactView = false;
    S.ui.artifactConvId = null;
    S.ui.newConvoOpen = false;
    S.ui.transcript = null;
    syncPolling();
    render();
  }

  function openTranscript(convId) {
    S.ui.termConvId = convId;
    S.ui.artifactView = false;
    S.ui.artifactConvId = null;
    S.ui.newConvoOpen = false;
    S.ui.transcript = null;
    render();
    syncPolling();
    loadTranscript();
  }

  function backToList() {
    S.ui.termConvId = null;
    S.ui.artifactView = false;
    S.ui.artifactConvId = null;
    S.ui.transcript = null;
    syncPolling();
    render();
    refreshSessions();
  }

  function openArtifacts(taskId, convoId) {
    S.ui.termTaskId = taskId;
    S.ui.termConvId = null;
    S.ui.artifactView = true;
    S.ui.artifactConvId = convoId || null;
    S.ui.artifactFilesOpen = false;
    S.ui.artifactWorkOpen = false;
    S.ui.newConvoOpen = false;
    S.ui.transcript = null;
    render();
    syncPolling();
    refreshSessions();
  }

  /* ── Lecteur d'artefacts : ouverture, relecture, liens ──────────────── */

  var readerTimer = null, readerToken = 0;

  /* `back` : le lecteur d'où l'on vient, quand un lien du rapport mène à un autre fichier.
     `mode` : un rapport de revue s'ouvre sur l'inventaire de ses constats (`rv` : constat ouvert,
     catégorie filtrée, défilement des colonnes), sauf si l'on a demandé le rapport complet (`doc`). */
  function openReader(path, cwd, back) {
    S.ui.reader = { path: String(path || ''), cwd: String(cwd || ''), view: null, busy: false, error: '', back: back || null,
      mode: 'review', rv: { sel: '', cat: '', scroll: 0 } };
    /* Lien suivi depuis un onglet de revues groupées : la chaîne des lecteurs reste dans l'onglet. */
    if (back && back.group) { S.ui.reader.group = back.group; S.ui.reader.taskId = back.taskId; }
    render();
    syncReaderPolling();
    loadReader(false);
  }

  function closeReader() {
    S.ui.reader = null;
    syncReaderPolling();
    render();
  }

  /* Bouton de la carte : le rapport de revue le plus probable de la tâche, dans la vue revue. */
  function openReview(taskId) {
    var list = reviewReportsOf(convosOf(taskId));
    if (!list.length) { toast('Aucun rapport de revue pour cette tâche'); return; }
    openReader(list[0].path, list[0].cwd);
  }

  function backReader() {
    var r = S.ui.reader;
    if (!r || !r.back) return;
    S.ui.reader = r.back;
    S.ui.reader.busy = false;
    render();
    loadReader(true);
  }

  /* ── Revues groupées : un onglet par ticket ───────────────────────────
     Les rapports de revue de plusieurs tâches — les sous-tâches d'une revue générale, ou toute la
     file — se lisent dans un même panneau plein écran, un onglet par tâche. Chaque onglet a son
     lecteur, de la forme de `S.ui.reader` plus `group`, `taskId`, `pending` (« Revue en cours… »),
     `docY` (défilement du rapport complet) : constat ouvert, filtre, rapport complet, lien suivi y
     restent quand on passe à un autre. `S.ui.reader` désigne toujours le lecteur de l'onglet actif :
     vue revue, clavier et relecture toutes les 2 s marchent comme pour un rapport seul.
     `group` = { scope: { parentId, taskIds }, title, tabs: [{ taskId, state, path, cwd, r, fetched }],
     active, entered, prefetch }. Rien n'est enregistré. */

  var REVIEW_PENDING_STATES = { working: 1, waiting: 1, open: 1 };
  /* Genres dont la lecture fait servir leur dossier par l'hôte (un seul à la fois). */
  var READER_SERVED = { markdown: 1, html: 1, pdf: 1, image: 1 };
  var readerServed = '';

  /* Ouvre le panneau à onglets. `parentId` : la parente (si elle a son propre rapport) puis ses
     sous-tâches, terminées comprises, qui ont un rapport ou une session en cours ; `taskIds` : ces
     tâches-là, dans cet ordre ; ni l'un ni l'autre : les tâches en file qui ont un rapport.
     `focusTaskId` : l'onglet ouvert d'abord (sinon le premier qui a un rapport). */
  function openReviewGroup(opts) {
    opts = opts || {};
    var scope = {
      parentId: opts.parentId ? String(opts.parentId) : '',
      taskIds: Array.isArray(opts.taskIds) ? opts.taskIds.map(String) : null
    };
    var tabs = reviewGroupTabs(scope);
    var first = null;
    tabs.forEach(function (tab) { if (!first && tab.state === 'report') first = tab; });
    if (!first) { toast('Aucun rapport de revue pour l’instant'); return false; }
    var parent = scope.parentId ? taskById(scope.parentId) : null;
    var G = {
      scope: scope, tabs: tabs, active: '', entered: false, prefetch: '',
      title: parent ? firstLine(parent.text, 60) || 'Revues' : (scope.taskIds ? 'Revues' : 'Revues — tâches en file')
    };
    tabs.forEach(function (tab) { tab.r = tabReader(tab, G); });
    first = (opts.focusTaskId && reviewTab(G, String(opts.focusTaskId))) || first;
    G.active = first.taskId;
    first.fetched = true;
    S.ui.reader = first.r;
    render();
    syncReaderPolling();
    loadReader(false).then(function () { prefetchReviewGroup(G); });
    return true;
  }

  function reviewGroupTabs(scope) {
    var tasks;
    if (scope.parentId) {
      var p = taskById(scope.parentId);
      tasks = p ? [p].concat(childrenOf(p.id)) : [];
    } else if (scope.taskIds) {
      tasks = scope.taskIds.map(function (id) { return taskById(id); }).filter(Boolean);
    } else {
      tasks = S.data.tasks.filter(function (t) { return !t.done; });
    }
    var tabs = [];
    tasks.forEach(function (t) {
      var list = taskReviews(t.id);
      if (list.length) { tabs.push({ taskId: t.id, state: 'report', path: list[0].path, cwd: list[0].cwd }); return; }
      if (scope.parentId && t.id !== scope.parentId
          && convosOf(t.id).some(function (c) { return REVIEW_PENDING_STATES[displayState(c)]; })) {
        tabs.push({ taskId: t.id, state: 'pending', path: '', cwd: '' });
      }
    });
    return tabs;
  }

  function tabReader(tab, G) {
    return { path: tab.path, cwd: tab.cwd, view: null, busy: false, error: '', back: null, mode: 'review',
      rv: { sel: '', cat: '', scroll: 0 }, group: G, taskId: tab.taskId, pending: tab.state === 'pending', docY: 0 };
  }

  function reviewTab(G, taskId) {
    for (var i = 0; i < G.tabs.length; i++) if (G.tabs[i].taskId === taskId) return G.tabs[i];
    return null;
  }

  /* Lecteur affiché par un onglet (l'actif : celui du panneau), et celui de son rapport, sous les liens suivis. */
  function tabCurrent(G, tab) {
    return tab.taskId === G.active && S.ui.reader && S.ui.reader.group === G ? S.ui.reader : tab.r;
  }

  function tabRoot(r) {
    while (r && r.back) r = r.back;
    return r;
  }

  /* Remet les onglets d'accord avec les rapports à chaque rendu du panneau : un onglet « en cours »
     dont le rapport paraît devient un vrai onglet (lu aussitôt s'il est actif), un nouveau rapport
     ajoute le sien, un onglet « en cours » dont la session s'est arrêtée sans rapport s'en va. Un
     rapport déjà là reste, avec son chemin d'ouverture. Ne redessine rien elle-même. */
  function syncReviewGroup(G) {
    var fresh = reviewGroupTabs(G.scope);
    var old = {}, tabs = [], load = null, at = 0;
    G.tabs.forEach(function (tab, i) { old[tab.taskId] = tab; if (tab.taskId === G.active) at = i; });
    fresh.forEach(function (f) {
      var tab = old[f.taskId];
      if (!tab) { f.r = tabReader(f, G); tabs.push(f); return; }
      delete old[f.taskId];
      if (tab.state === 'pending' && f.state === 'report') {
        tab.state = 'report'; tab.path = f.path; tab.cwd = f.cwd;
        tab.r.pending = false; tab.r.path = f.path; tab.r.cwd = f.cwd;
        if (tab.taskId === G.active) { tab.fetched = true; load = tab.r; }
      }
      tabs.push(tab);
    });
    var prev = null;
    G.tabs.forEach(function (tab) {
      if (old[tab.taskId] === tab && tab.state === 'report' && taskById(tab.taskId)) {
        tabs.splice(prev ? tabs.indexOf(prev) + 1 : 0, 0, tab);
      }
      if (tabs.indexOf(tab) >= 0) prev = tab;
    });
    G.tabs = tabs;
    if (!tabs.length) {
      S.ui.reader = null;
      syncReaderPolling();
      toast('Plus aucun rapport de revue à afficher');
      return;
    }
    if (!reviewTab(G, G.active)) {
      var next = tabs[Math.min(at, tabs.length - 1)];
      G.active = next.taskId;
      next.fetched = true;
      next.r.busy = false;
      S.ui.reader = next.r;
      load = next.r;
    }
    if (load) setTimeout(function () { if (S.ui.reader === load) loadReader(false); }, 0);
    if (G.prefetch === 'done' && tabs.some(function (t) { return t.state === 'report' && !t.fetched; })) {
      G.prefetch = '';
      setTimeout(function () { prefetchReviewGroup(G); }, 0);
    }
  }

  /* Passe à l'onglet d'une autre tâche : celui qu'on quitte garde son lecteur tel quel. Le rapport
     visé est relu en entier (l'hôte sert alors son dossier) ; sa vue déjà lue s'affiche en attendant. */
  function reviewGroupGo(taskId) {
    var r = S.ui.reader;
    var G = r && r.group;
    if (!G) return;
    var to = reviewTab(G, String(taskId || ''));
    var from = reviewTab(G, G.active);
    if (!to || to === from) return;
    if (from) {
      from.r = r;
      keepReviewScroll(r);
    }
    G.active = to.taskId;
    to.fetched = true;
    to.r.busy = false;
    S.ui.reader = to.r;
    render();
    if (!to.r.pending) loadReader(false);
  }

  /* Onglet suivant (1) ou précédent (-1), en boucle. */
  function reviewGroupStep(delta) {
    var r = S.ui.reader;
    var G = r && r.group;
    if (!G || G.tabs.length < 2) return;
    var n = G.tabs.length;
    var i = Math.max(0, G.tabs.indexOf(reviewTab(G, G.active)));
    reviewGroupGo(G.tabs[(i + (delta < 0 ? -1 : 1) + n) % n].taskId);
  }

  /* Lit une fois, à la suite, les onglets jamais lus, pour que leur pastille dise leur verdict ;
     seul l'onglet actif est ensuite relu toutes les 2 s. L'hôte ne sert que le dossier du dernier
     rapport lu : à la fin, s'il n'est plus celui de l'onglet actif, celui-ci est relu en entier. */
  function prefetchReviewGroup(G) {
    if (G.prefetch === 'running') return;
    G.prefetch = 'running';
    function shown() { return S.ui.reader && S.ui.reader.group === G; }
    function next() {
      if (!shown()) { G.prefetch = 'done'; return; }
      var tab = null;
      G.tabs.forEach(function (t) {
        if (!tab && t.state === 'report' && !t.fetched && t.taskId !== G.active) tab = t;
      });
      if (!tab) {
        G.prefetch = 'done';
        var a = S.ui.reader;
        if (a.view && !a.busy && READER_SERVED[a.view.kind]
            && String(a.view.root || '').toLowerCase() !== readerServed.toLowerCase()) loadReader(false);
        return;
      }
      tab.fetched = true;
      if (tab.r.view || tab.r.busy) { next(); return; }
      readReport(tab.r, false).then(function () {
        if (shown()) renderReader();
        next();
      });
    }
    next();
  }

  /* Barre d'onglets et en-tête du ticket actif. La pastille d'un onglet dit le niveau de son
     rapport (grise tant qu'il n'est pas lu), son compteur les bloquants ; ✓ : tâche terminée. */
  function reviewTabsHtml(G) {
    var tabs = G.tabs.map(function (tab) {
      var t = taskById(tab.taskId) || { id: tab.taskId, text: '' };
      var root = tabRoot(tabCurrent(G, tab));
      var m = tab.state === 'report' && root && root.view ? reviewModel(root.view) : null;
      var level = m ? reviewLevel(m) : '';
      var color = level === 'ok' ? '#2b7a4b' : (REVIEW_SEV[level] ? REVIEW_SEV[level].color : '');
      var blockers = m ? reviewHealth(m).blockers : 0;
      var state;
      if (tab.state === 'pending') state = 'Revue en cours…';
      else if (!root || !root.view) state = root && root.error ? 'Lecture impossible' : 'Pas encore lu';
      else if (!m) state = 'Aucun constat reconnu';
      else state = (m.verdict.replace(REVIEW_MARK, '') || 'Sans verdict')
        + (blockers ? ' · ' + blockers + (blockers > 1 ? ' bloquants' : ' bloquant') : '');
      var label = t.jira || taskJiraKeys(t)[0] || firstLine(t.text, 28) || 'Tâche';
      return '<button type="button" class="rv-tab' + (t.done ? ' is-done' : '') + '" role="tab" data-act="rv-tab" data-id="'
        + esc(tab.taskId) + '" aria-selected="' + (tab.taskId === G.active) + '" title="' + esc(firstLine(t.text, 160) + '\n' + state) + '">'
        + '<span class="rv-tab-dot' + (tab.state === 'pending' ? ' is-pending' : '') + '"' + (color ? ' style="--sev:' + color + '"' : '') + '></span>'
        + '<span class="rv-tab-label">' + esc(label) + '</span>'
        + (blockers ? '<span class="rv-tab-n">' + esc(blockers) + '</span>' : '')
        + '</button>';
    }).join('');
    var act = taskById(G.active);
    var head = act
      ? '<div class="rv-tab-head"><span class="rv-tab-head-text" title="' + esc(firstLine(act.text, 300)) + '">' + esc(firstLine(act.text, 300)) + '</span>'
        + jiraChipsHtml(act) + prChipsHtml(act) + '</div>'
      : '';
    return '<div class="rv-tabs-bar"><span class="rv-tabs-title" title="' + esc(G.title) + '">' + esc(G.title) + '</span>'
      + '<div class="rv-tabs" role="tablist" aria-label="Rapports de revue">' + tabs + '</div>'
      + '<span class="rv-tabs-keys">Ctrl + Pg↑ / Pg↓</span></div>'
      + head;
  }

  /* Ne réécrit la barre que si elle a changé, et ramène alors l'onglet actif en vue. */
  function renderReviewTabs(host, G) {
    var el = host.querySelector('[data-role="rv-tabs"]');
    if (!el) return;
    var html = reviewTabsHtml(G);
    if (el.rvHtml === html) return;
    setHtml(el, html);
    var cur = el.querySelector('.rv-tab[aria-selected="true"]');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /* Onglet d'une sous-tâche dont la session tourne encore : il s'ouvrira sur le rapport dès qu'il paraîtra. */
  function renderReviewPending(host, r) {
    var G = r.group;
    var key = 'pending|' + r.taskId;
    if (readerKey !== key) {
      host.innerHTML = '<div class="reader-backdrop rv-backdrop is-group"><div class="reader is-wide' + (G.entered ? '' : ' enter')
        + '" role="dialog" aria-label="Revue en cours">'
        + '<div class="reader-bar"><span class="reader-icon">' + ICON.review + '</span>'
        + '<div class="reader-head"><div class="rv-title">Revue en cours…</div><div class="reader-meta" data-role="rv-meta"></div></div>'
        + '<span class="panel-spacer"></span>'
        + '<button type="button" class="panel-x" data-act="close-reader" title="Fermer (Échap)">✕</button></div>'
        + '<div class="rv-tabs-host" data-role="rv-tabs"></div>'
        + '<div class="reader-body"><div class="reader-note rv-pending"><p><strong>Revue en cours…</strong></p>'
        + '<p>L’agent n’a pas encore écrit son rapport ; cet onglet s’ouvrira dessus dès qu’il paraîtra.</p>'
        + '<p class="rv-pending-state" data-role="rv-pending-state"></p></div></div></div></div>';
      readerKey = key; readerStamp = null; readerFrame = null; readerReady = false;
      chatFrame = null; chatReady = false;
      G.entered = true;
    }
    renderReviewTabs(host, G);
    var c = bestConvo(convosOf(r.taskId));
    var meta = host.querySelector('[data-role="rv-meta"]');
    var title = c ? c.title || 'Nouvelle session' : '';
    if (meta && meta.textContent !== title) meta.textContent = title;
    var line = host.querySelector('[data-role="rv-pending-state"]');
    var text = stateText(c);
    if (line && line.textContent !== text) line.textContent = text;
  }

  /* Tant que le lecteur est ouvert, le fichier est relu toutes les 2 s : l'hôte ne renvoie rien
     si son empreinte n'a pas changé, et le cadre garde son défilement quand elle change. */
  function syncReaderPolling() {
    var want = !!S.ui.reader;
    if (want && !readerTimer) {
      readerTimer = setInterval(function () { if (document.visibilityState !== 'hidden') loadReader(true); }, 2000);
    }
    if (!want && readerTimer) { clearInterval(readerTimer); readerTimer = null; }
  }

  function loadReader(silent) {
    return readReport(S.ui.reader, silent);
  }

  /* Lit le fichier d'un lecteur, affiché ou non (préchargement des onglets des revues groupées).
     Un jeton par lecteur écarte une réponse dépassée ; un lecteur quitté pendant sa lecture garde
     la vue reçue et ne reste pas « occupé » (il ne serait plus relu). Seul le lecteur affiché
     redessine. */
  function readReport(r, silent) {
    if (!r || r.pending || (silent && r.busy)) return Promise.resolve();
    var token = ++readerToken;
    r.token = token;
    r.busy = true;
    return bridge.call('readArtifact', { path: r.path, cwd: r.cwd, stamp: silent && r.view ? r.view.stamp : '' })
      .then(function (v) {
        if (r.token !== token) return;
        r.busy = false;
        if (!v || v.changed === false) return;
        if (READER_SERVED[v.kind]) readerServed = String(v.root || '');
        if (v.kind === 'binary') {
          if (S.ui.reader !== r) return;
          /* Rien à afficher ici (tableur, document Office…) : le fichier part vers son application.
             Atteint par un lien depuis un onglet des revues groupées, on revient au rapport. */
          if (r.group && r.back) backReader(); else closeReader();
          bridge.call('openPath', { path: v.full, editor: 'default' }).then(function (res) {
            toast(res && res.editor === 'default' ? 'Ouvert avec l’application associée' : 'Affiché dans l’Explorateur');
          })['catch'](function (e) { toast('Ouverture impossible : ' + e.message); });
          return;
        }
        r.view = v;
        r.error = '';
        if (S.ui.reader === r) render();
      })['catch'](function (e) {
        if (r.token !== token) return;
        r.busy = false;
        /* Une relecture qui échoue pendant que l'agent écrit ne doit pas effacer ce qu'on lit. */
        if (!silent || !r.view) { r.error = e.message; r.view = null; if (S.ui.reader === r) render(); }
      });
  }

  /* Un lien cliqué dans le rapport : un autre fichier du dossier servi s'ouvre ici (avec retour),
     une adresse externe part dans le navigateur. */
  function followReaderLink(href) {
    var r = S.ui.reader;
    if (!r || !r.view) return;
    href = String(href || '');
    if (href.slice(0, READER_HOST.length).toLowerCase() === READER_HOST) {
      var rel = href.slice(READER_HOST.length).split(/[?#]/)[0];
      try { rel = decodeURIComponent(rel); } catch (e) { return; }
      if (!rel) return;
      openReader(String(r.view.root || '').replace(/[\\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\'), r.cwd, r);
      return;
    }
    if (/^(https?|mailto):/i.test(href)) {
      bridge.call('openUrl', { url: href })['catch'](function (e) { toast('Ouverture impossible : ' + e.message); });
    }
  }

  /* Rafraîchit titre, compte et état de toutes les conversations, pas seulement celles du
     panneau ouvert : les cartes de tâches portent une pastille d'état. L'hôte ne relit que
     les transcripts qui ont changé. */
  /* Une seule relecture à la fois : l'hôte pousse `sessionsChanged` jusqu'à une fois par seconde
     pendant qu'un agent écrit, et chaque appel arrivé pendant une relecture en lançait une autre
     par-dessus. Elles s'empilaient quand l'hôte ralentissait, et le ralentissaient davantage. Une
     demande reçue en cours de route est retenue, et servie par une seule relecture à la fin. */
  var sessionsInFlight = null, sessionsAgain = false;
  /* Empreinte des fichiers produits que l'UI détient, par session : l'hôte ne renvoie la liste
     que si elle a changé. Tenue en mémoire seulement — une page rechargée repart de listes complètes. */
  var artifactStamps = {};
  /* Le premier relevé lit tous les transcripts (plusieurs centaines de Mo, une vingtaine de
     secondes quand le disque est froid) : au-delà des 15 s habituelles, il expirait au démarrage. */
  var SESSIONS_TIMEOUT = 60000;

  function refreshSessions() {
    if (sessionsInFlight) { sessionsAgain = true; return sessionsInFlight; }
    var convs = S.data.convos;
    if (!convs.length) return Promise.resolve();
    sessionsInFlight = bridge.call('getSessions', {
      sessions: convs.map(function (c) {
        return { sessionId: c.id, cwd: c.cwd, provider: providerOf(c), artifactsStamp: artifactStamps[c.id] || '' };
      })
    }, SESSIONS_TIMEOUT).then(function (res) {
      var list = (res && res.sessions) || [];
      var changed = false;  /* à persister dans data.json */
      var dirty = false;    /* à redessiner */
      var arrived = [];
      var asking = [];
      list.forEach(function (info) {
        var c = convoById(info.sessionId);
        if (!c) return;
        S.ui.sessionExists[c.id] = !!info.exists;
        if (info.title && info.title !== c.title) { c.title = info.title; changed = true; }
        if (typeof info.messageCount === 'number' && info.messageCount !== c.messageCount) {
          c.messageCount = info.messageCount; changed = true;
        }
        var up = toMs(info.updated);
        if (up && up !== toMs(c.updated)) { c.updated = up; changed = true; }
        /* Liste absente : elle n'a pas changé depuis l'empreinte envoyée. */
        if (Array.isArray(info.artifacts)) {
          if (!sameArtifacts(c.artifacts, info.artifacts)) {
            c.artifacts = normalizeArtifacts(info.artifacts);
            changed = true;
            dirty = true;
          }
          /* La consommation vient des mêmes transcripts : elle suit la même empreinte. */
          var used = normalizeUsage(info.usage);
          if (!sameUsage(c.usage, used)) {
            if (used) c.usage = used; else delete c.usage;
            changed = true;
            dirty = true;
          }
          artifactStamps[c.id] = String(info.artifactsStamp || '');
        }
        var before = displayState(c);
        var prev = S.ui.activity[c.id];
        var next = {
          exists: !!info.exists, state: info.state || 'idle', stateTs: toMs(info.stateTs),
          detail: info.detail || '', said: info.said ? String(info.said) : '',
          alive: typeof info.alive === 'boolean' ? info.alive : null,
          agents: Array.isArray(info.agents) ? info.agents.map(String) : []
        };
        if (!prev || prev.exists !== next.exists || prev.state !== next.state
          || prev.stateTs !== next.stateTs || prev.detail !== next.detail || prev.alive !== next.alive
          || prev.said !== next.said
          || (prev.agents || []).join('') !== next.agents.join('')) dirty = true;
        S.ui.activity[c.id] = next;
        if ((before === 'working' || before === 'waiting') && displayState(c) === 'ready') arrived.push(c);
        else if (before && before !== 'waiting' && displayState(c) === 'waiting') asking.push(c);
      });
      if (changed) saveDataLater();
      /* Rien de neuf : on laisse la page tranquille (une relecture toutes les secondes et demie
         ne doit ni interrompre une sélection ni faire clignoter la liste). */
      if (changed || dirty) renderActivity();
      if (arrived.length) announce(arrived);
      if (asking.length) announceQuestions(asking);
      /* Après l'annonce : la fin d'un lot passe devant la « réponse prête » de sa dernière conversation. */
      checkBatches();
    })['catch'](function (e) {
      console.warn('[organizator] getSessions', e);
    }).then(function () {
      sessionsInFlight = null;
      if (sessionsAgain) { sessionsAgain = false; return refreshSessions(); }
    });
    return sessionsInFlight;
  }

  /* Filet de sécurité : l'hôte pousse « sessionsChanged » dès qu'un fichier de session bouge, mais
     un événement peut manquer (tampon de surveillance débordé, dossier créé après le démarrage).
     On relit donc en boucle : vite tant qu'un agent travaille, au ralenti sinon, et à peine en
     arrière-plan (le navigateur bride de toute façon les minuteurs d'un onglet caché). */
  var SESSIONS_POLL_BUSY = 1500;
  var SESSIONS_POLL_IDLE = 10000;
  var SESSIONS_POLL_HIDDEN = 30000;
  var sessionsTimer = null;

  function sessionsBusy() {
    return S.data.convos.some(function (c) {
      var st = displayState(c);
      return st === 'working' || st === 'waiting' || st === 'open';
    });
  }

  function sessionsPollDelay() {
    if (document.visibilityState === 'hidden') return SESSIONS_POLL_HIDDEN;
    return sessionsBusy() ? SESSIONS_POLL_BUSY : SESSIONS_POLL_IDLE;
  }

  /* Un seul minuteur, toujours désarmé avant d'être réarmé. L'ancienne boucle réarmait le sien à la
     fin de chaque relecture sans regarder si un événement de l'hôte en avait armé un entre-temps :
     les deux boucles tournaient alors côte à côte, puis trois… Au bout de quelques heures, des
     dizaines de relectures par seconde saturaient l'hôte, et la frappe traînait. */
  function armSessionsPoll() {
    if (sessionsTimer) clearTimeout(sessionsTimer);
    sessionsTimer = setTimeout(pollSessions, sessionsPollDelay());
  }

  function pollSessions() {
    sessionsTimer = null;
    refreshSessions().then(armSessionsPoll, armSessionsPoll);
  }

  /* Relance immédiate (retour au premier plan, événement de l'hôte) : le prochain tour repart de zéro. */
  function restartSessionsPoll() {
    armSessionsPoll();
  }

  /* Une réponse vient d'arriver : toast, notification gardée dans la cloche, et — si la fenêtre est
     en arrière-plan, c'est l'hôte qui tranche — clignotement dans la barre des tâches et
     notification Windows. */
  function announce(convs) {
    var titles = convs.map(function (c) { return c.title || 'Nouvelle session'; });
    toast(convs.length === 1 ? 'Réponse prête : ' + titles[0] : convs.length + ' réponses prêtes');
    notifyOutside(convs.map(function (c) { return recordNotification('ready', c); }));
    /* Le quota vient de bouger : relecture forcée, une fois l'API à jour. */
    setTimeout(function () { refreshUsage(true); }, 2000);
  }

  /* Un agent pose une question (ou demande une autorisation) : il est bloqué tant qu'on ne lui
     répond pas — c'est l'événement qu'on veut le moins manquer hors d'Organizator. */
  function announceQuestions(convs) {
    var notes = convs.map(function (c) { return recordNotification('waiting', c); });
    toast(notes.length === 1 ? 'Question de l’agent : ' + notes[0].title : notes.length + ' questions des agents');
    notifyOutside(notes);
  }

  /* ── Notifications ──────────────────────────────────────────────────────
     Ce qui a été annoncé (réponse prête, question, fin d'un lot de sous-tâches) est gardé dans
     data.json (`notifications`, les plus récentes d'abord) : la cloche de l'en-tête les liste,
     son badge compte les non lues. Hors d'Organizator, l'hôte en fait des notifications Windows,
     rangées dans le centre de notifications ; un clic ramène la fenêtre sur la tâche. */
  var NOTIF_MAX = 60;
  var NOTIF_KINDS = { ready: 'Réponse prête', waiting: 'Question de l’agent', batch: 'Sous-tâches terminées' };

  function normalizeNotifications(list) {
    return (Array.isArray(list) ? list : []).filter(function (n) {
      return n && typeof n === 'object' && n.id && NOTIF_KINDS[n.kind];
    }).map(function (n) {
      return {
        id: String(n.id), at: toMs(n.at), kind: n.kind, read: !!n.read,
        taskId: String(n.taskId || ''), convoId: String(n.convoId || ''),
        title: String(n.title || ''), convoTitle: String(n.convoTitle || ''), text: String(n.text || ''),
        reports: Number(n.reports) || 0
      };
    }).slice(0, NOTIF_MAX);
  }

  function notificationById(id) {
    for (var i = 0; i < S.data.notifications.length; i++) if (S.data.notifications[i].id === id) return S.data.notifications[i];
    return null;
  }

  function unreadCount() {
    return S.data.notifications.filter(function (n) { return !n.read; }).length;
  }

  /* `c` : la conversation concernée ; `extra` complète ou remplace (fin d'un lot : la tâche parente). */
  function recordNotification(kind, c, extra) {
    var task = c ? taskById(c.taskId) : null;
    var n = Object.assign({
      id: uid('nt'), at: Date.now(), kind: kind, read: false,
      taskId: c ? c.taskId : '', convoId: c ? c.id : '',
      title: task ? (firstLine(task.text, 90).trim() || 'Tâche sans titre') : '',
      convoTitle: c ? (c.title || 'Nouvelle session') : '',
      text: c ? saidOf(c) : '', reports: 0
    }, extra || {});
    /* Une conversation ne garde qu'une notification non lue de chaque genre : la dernière. */
    S.data.notifications = S.data.notifications.filter(function (x) {
      return x.read || !n.convoId || x.convoId !== n.convoId || x.kind !== n.kind;
    });
    S.data.notifications.unshift(n);
    if (S.data.notifications.length > NOTIF_MAX) S.data.notifications.length = NOTIF_MAX;
    saveDataSoon();
    renderNotifsBtn();
    if (S.ui.notifsOpen) renderNotifs();
    return n;
  }

  /* Clignotement et notifications Windows : l'hôte n'en montre que si la fenêtre n'est pas devant. */
  function notifyOutside(notes) {
    if (!notes.length) return;
    var toasts = S.settings.windowsNotifications === false ? [] : notes.slice(0, 3).map(function (n) {
      return {
        title: NOTIF_KINDS[n.kind] + ' · ' + (n.title || 'Organizator'),
        body: n.text || '', attribution: n.kind === 'batch' ? '' : n.convoTitle,
        args: 'n=' + n.id, tag: n.convoId || n.id
      };
    });
    bridge.call('notify', { count: notes.length, title: notes[0].title, toasts: toasts })['catch'](function () { /* sans importance */ });
  }

  /* Ouvrir le panneau d'une tâche, c'est avoir vu ce qu'elle annonçait. */
  function markTaskNotificationsRead(taskId) {
    var any = false;
    S.data.notifications.forEach(function (n) {
      if (!n.read && n.taskId === taskId) { n.read = true; any = true; }
    });
    if (any) saveDataSoon();
    return any;
  }

  /* Une notification ouverte (cloche, ou clic sur la notification Windows) : la tâche se montre —
     dépliée si c'est une sous-tâche repliée —, son panneau s'ouvre sur la conversation concernée ;
     la fin d'une revue générale ouvre ses rapports. */
  function openNotification(id) {
    var n = notificationById(id);
    S.ui.notifsOpen = false;
    /* Une notification mène à une tâche : la file doit être à l'écran pour qu'on la trouve. */
    if (n && currentPage() !== 'queue') goPage('queue', true);
    if (!n) { render(); return; }
    n.read = true;
    saveDataSoon();
    var task = taskById(n.taskId);
    if (!task) { render(); toast('La tâche de cette notification n’existe plus.'); return; }
    if (n.kind === 'batch' && n.reports && openReviewGroup({ parentId: task.id })) { render(); return; }
    var parent = parentOf(task);
    if (parent && parent.collapsed) delete parent.collapsed;
    var c = n.convoId ? convoById(n.convoId) : null;
    openTerm(task.id);
    if (c && c.taskId === task.id) openTranscript(c.id);
    if (task.id !== FEEDBACK_ID) revealTask(task.id);
  }

  /* Amène la carte sous les yeux et la fait briller un instant. */
  function revealTask(id) {
    var find = function () { return document.querySelector('.task[data-card="' + id + '"]'); };
    var el = find();
    if (!el && S.ui.search) {
      S.ui.search = '';
      var box = $('#search');
      if (box) box.value = '';
      renderList();
      el = find();
    }
    if (!el) return;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    /* L'éclat est noté dans l'état : un rendu dans la foulée (journal relu, sessions) reconstruit la
       carte, qui le reprend là où il en était (flashStyle) au lieu de le perdre ou de le rejouer. */
    S.ui.flash = { id: id, at: Date.now() };
    el.className += ' is-flash';
    el.setAttribute('style', flashStyle(id).replace(/^ style="|"$/g, ''));
  }

  var FLASH_MS = 1800;

  function flashStyle(id) {
    var f = S.ui.flash;
    if (!f || f.id !== id) return '';
    var gone = Date.now() - f.at;
    return gone < FLASH_MS ? ' style="animation-delay:-' + gone + 'ms"' : '';
  }

  function renderNotifsBtn() {
    var btn = $('#notifs-btn');
    if (!btn) return;
    var n = unreadCount();
    var badge = btn.querySelector('.btn-badge');
    badge.textContent = n ? String(n) : '';
    badge.hidden = !n;
    btn.classList.toggle('on', !!S.ui.notifsOpen);
    btn.setAttribute('aria-expanded', S.ui.notifsOpen ? 'true' : 'false');
    btn.title = 'Notifications' + (n ? ' · ' + n + (n > 1 ? ' non lues' : ' non lue') : '');
    /* Le bouton de la barre des tâches porte aussi le compte, comme les messageries. */
    if (n !== lastBadge) {
      lastBadge = n;
      bridge.call('badge', { count: n })['catch'](function () { /* hôte plus ancien */ });
    }
  }
  var lastBadge = -1;

  function notifItemHtml(n) {
    return '<button type="button" class="notif k-' + esc(n.kind) + (n.read ? '' : ' is-unread') + '" data-act="open-notif" data-id="' + esc(n.id) + '"'
      + (n.text ? ' title="' + esc(n.text) + '"' : '') + '>'
      + '<span class="notif-dot"></span>'
      + '<span class="notif-main">'
      + '<span class="notif-head"><span class="notif-kind">' + esc(NOTIF_KINDS[n.kind]) + '</span>'
      + '<span class="notif-time">' + esc(fmtTime(n.at)) + '</span></span>'
      + '<span class="notif-task">' + esc(n.title || 'Tâche supprimée') + '</span>'
      + (n.text ? '<span class="notif-text">' + esc(n.text) + '</span>' : '')
      + (n.kind !== 'batch' && n.convoTitle ? '<span class="notif-convo">' + esc(n.convoTitle) + '</span>' : '')
      + '</span></button>';
  }

  function notifsHtml() {
    var list = S.data.notifications;
    var unread = unreadCount();
    var h = ['<div class="notifs-head"><span class="notifs-title">Notifications</span><span class="notifs-spacer"></span>'];
    if (unread) h.push('<button type="button" class="notifs-link" data-act="notifs-read-all">Tout marquer comme lu</button>');
    if (list.length) h.push('<button type="button" class="notifs-link" data-act="notifs-clear">Effacer</button>');
    h.push('</div>');
    if (!list.length) {
      h.push('<div class="notifs-empty">Aucune notification. Les réponses prêtes et les questions des agents s’afficheront ici'
        + (S.settings.windowsNotifications === false ? '.' : ' — et dans le centre de notifications de Windows quand Organizator est en arrière-plan.') + '</div>');
    } else {
      h.push('<div class="notifs-list">' + list.map(notifItemHtml).join('') + '</div>');
    }
    h.push('<div class="notifs-foot">Notifications Windows : ' + (S.settings.windowsNotifications === false ? 'coupées' : 'actives')
      + ' · <button type="button" class="notifs-link" data-act="notifs-settings">Réglages</button></div>');
    return h.join('');
  }

  /* Menu déroulant sous la cloche : posé en position fixe sous le bouton, refermé par un clic
     ailleurs ou Échap. */
  function renderNotifs() {
    var host = $('#notifs');
    if (!host) return;
    if (!S.ui.notifsOpen) { if (host.innerHTML) host.innerHTML = ''; return; }
    var list = host.querySelector('.notifs-list');
    var scroll = list ? list.scrollTop : 0;
    host.innerHTML = '<div class="notifs-pop" role="dialog" aria-label="Notifications">' + notifsHtml() + '</div>';
    placeNotifs();
    list = host.querySelector('.notifs-list');
    if (list) list.scrollTop = scroll;
  }

  /* Sous la cloche, qui bouge avec la page (défilement, largeur de la fenêtre). */
  function placeNotifs() {
    var pop = $('#notifs .notifs-pop');
    if (!pop) return;
    var btn = $('#notifs-btn');
    var r = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
    pop.style.top = (r && r.bottom ? Math.round(r.bottom + 8) : 64) + 'px';
    pop.style.right = (r && r.right ? Math.max(12, Math.round(window.innerWidth - r.right)) : 24) + 'px';
  }

  function closeNotifs() {
    if (!S.ui.notifsOpen) return;
    S.ui.notifsOpen = false;
    renderNotifs();
    renderNotifsBtn();
  }

  /* ── Quotas des agents ──────────────────────────────────────────────── */

  var USAGE_LABELS = {
    session: 'Session (5 h)', weekly: 'Semaine', extra: 'Usage supplémentaire',
    premium: 'Requêtes premium', chat: 'Chat', completions: 'Complétions'
  };
  var USAGE_STATUS = {
    claude: { missing: 'Non connecté · lancez claude puis /login', expired: 'Jeton expiré · relancez claude' },
    copilot: { missing: 'Non connecté · lancez copilot puis /login', expired: 'Jeton refusé · lancez copilot puis /login' }
  };
  var USAGE_MAX_AGE = 5 * 60 * 1000;

  function usageLabel(bar) {
    var base = USAGE_LABELS[bar.key] || bar.key;
    return bar.scope ? base + ' · ' + bar.scope : base;
  }

  function fmtCount(n) { return Math.round(n).toLocaleString('fr-FR'); }

  /* « reset à 00:19 » aujourd'hui, « reset lun. 06:59 » dans la semaine, « reset le 1 oct. » au-delà. */
  function fmtReset(ms) {
    if (!ms) return '';
    var d = new Date(ms), now = new Date();
    var hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'reset à ' + hm;
    var delta = d.getTime() - now.getTime();
    if (delta > 0 && delta < 7 * 86400000) return 'reset ' + d.toLocaleDateString('fr-FR', { weekday: 'short' }) + ' ' + hm;
    return 'reset le ' + d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  function usageLevel(p) { return p >= 100 ? 'lv-full' : p >= 80 ? 'lv-high' : p >= 50 ? 'lv-warn' : 'lv-ok'; }

  function usageCardHtml(pr, rep) {
    var u = S.ui.usage;
    var h = ['<div class="usage-card' + (u.busy ? ' busy' : '') + '" data-act="refresh-usage" title="Cliquer pour actualiser">'];
    h.push('<div class="usage-head"><span class="usage-name">' + esc(pr.label) + '</span>');
    var who = rep ? [rep.plan, rep.account, rep.host].filter(Boolean).join(' · ') : '';
    if (who) h.push('<span class="usage-plan">' + esc(who) + '</span>');
    h.push('</div>');
    if (!rep) {
      h.push('<div class="usage-msg">' + (u.busy ? 'Lecture du quota…' : (u.error ? 'Indisponible · ' + esc(u.error) : '—')) + '</div>');
    } else if (rep.status !== 'ok') {
      var m = (USAGE_STATUS[pr.id] || {})[rep.status] || ('Indisponible' + (rep.message ? ' · ' + rep.message : ''));
      h.push('<div class="usage-msg st-' + esc(rep.status) + '">' + esc(m) + '</div>');
    } else if (!rep.bars || !rep.bars.length) {
      h.push('<div class="usage-msg">Quotas illimités</div>');
    } else {
      rep.bars.forEach(function (b) {
        var p = Math.max(0, Math.min(100, Math.round(b.percent || 0)));
        var label = usageLabel(b);
        var note = [];
        if (typeof b.used === 'number' && typeof b.limit === 'number') note.push(fmtCount(b.used) + ' / ' + fmtCount(b.limit));
        if (b.resetsAt) note.push(fmtReset(b.resetsAt));
        if (b.overage) note.push('dépassement autorisé');
        h.push('<div class="usage-row"><span class="usage-label">' + esc(label) + '</span>'
          + '<span class="usage-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + p + '" aria-label="' + esc(label) + '">'
          + '<span class="usage-fill ' + usageLevel(p) + '" style="width:' + p + '%"></span></span>'
          + '<span class="usage-pct">' + p + ' %</span>'
          + (note.length ? '<span class="usage-note">' + esc(note.join(' · ')) + '</span>' : '')
          + '</div>');
      });
      if (rep.stale) h.push('<div class="usage-msg">Dernière lecture ' + esc(fmtTime(rep.fetchedAt)) + (rep.message ? ' · ' + esc(rep.message) : '') + '</div>');
    }
    h.push('</div>');
    return h.join('');
  }

  function renderUsage() {
    var host = $('#usage');
    if (!host) return;
    var reports = S.ui.usage.reports || {};
    host.innerHTML = PROVIDERS.filter(function (pr) { return hasProvider(pr.id) || !!reports[pr.id]; })
      .map(function (pr) { return usageCardHtml(pr, reports[pr.id] || null); }).join('')
      + ARTICLE_FEEDS.map(function (F) { return articleCardHtml(F); }).join('');
  }

  /* Sans `force`, une lecture de moins de 5 min suffit ; l'hôte a lui-même un cache de 2 min. */
  function refreshUsage(force) {
    var u = S.ui.usage;
    if (u.busy) return Promise.resolve();
    if (!force && u.fetchedAt && Date.now() - u.fetchedAt < USAGE_MAX_AGE) return Promise.resolve();
    u.busy = true;
    renderUsage();
    return bridge.call('getUsage', { force: !!force }).then(function (r) {
      u.busy = false;
      u.error = '';
      u.reports = { claude: (r && r.claude) || null, copilot: (r && r.copilot) || null };
      u.fetchedAt = Date.now();
      renderUsage();
    })['catch'](function (e) {
      u.busy = false;
      u.error = e.message;
      u.fetchedAt = Date.now();
      renderUsage();
      console.warn('[organizator] getUsage', e);
    });
  }

  /* ── Article du jour et veille IA ───────────────────────────────────────
     Une fois par jour, Claude Code (outils web seulement, hors terminal) cherche un article, le lit
     et le résume. Deux fils, mêmes mécanismes : l'article du jour éclaire ce sur quoi l'utilisateur
     travaille ; la veille IA raconte ce qui vient de se passer dans l'IA, vu par un développeur qui
     travaille avec des agents, sans regarder sa file. L'hôte garde chaque fiche et ses précédentes
     (article.json, article-ai.json) ; l'UI lui donne les centres d'intérêt (article du jour
     seulement) et les affiche : une carte par fil en tête de fenêtre, à côté des quotas, et le
     panneau latéral au clic. */
  var ARTICLE_WAIT = 270000;              /* l'hôte abandonne à 240 s */
  var ARTICLE_CHECK_MS = 10 * 60 * 1000;  /* changement de date, fenêtre restée ouverte */
  var ARTICLE_RETRY_MS = 60 * 60 * 1000;  /* après un échec, nouvel essai automatique dans l'heure */
  var ARTICLE_TASKS = 25, ARTICLE_CONVOS = 12;
  var ARTICLE_LANGS = { en: 'en anglais', de: 'en allemand', es: 'en espagnol', it: 'en italien' };

  /* `id` : le `kind` envoyé à l'hôte et la clé de S.ui.articles ; `panel` : l'identifiant du panneau ;
     `setting` : l'interrupteur des Réglages ; `interests` : ce que l'agent reçoit de l'utilisateur. */
  var ARTICLE_FEEDS = [
    {
      id: 'daily', panel: ARTICLE_ID, setting: 'articleEnabled', interests: articleInterests,
      name: 'Article du jour', title: 'article du jour', subject: 'l’article du jour', of: 'Article du ',
      back: '‹ Article du jour', searching: 'Recherche de l’article du jour…', why: 'Pourquoi pour vous',
      lookup: 'L’agent cherche un article qui éclaire vos sujets du moment, le lit et le résume. Comptez une minute environ.',
      off: 'L’article du jour est désactivé dans les Réglages.',
      empty: 'Pas encore d’article aujourd’hui.', fetch: 'Chercher l’article du jour',
      settings: 'Sujets et réglages de l’article du jour…'
    },
    {
      id: 'ai', panel: ARTICLE_AI_ID, setting: 'articleAiEnabled', interests: null,
      name: 'Veille IA', title: 'veille IA', subject: 'la veille IA', of: 'Veille IA du ',
      back: '‹ Veille IA du jour', searching: 'Recherche de la veille IA…', why: 'Ce que ça change pour vous',
      lookup: 'L’agent cherche ce qui a marqué l’IA ces derniers jours, choisit un article récent, le lit et le résume. Comptez une minute environ.',
      off: 'La veille IA est désactivée dans les Réglages.',
      empty: 'Pas encore de veille IA aujourd’hui.', fetch: 'Chercher la veille IA',
      settings: 'Réglages de la veille IA…'
    }
  ];

  function feedById(id) { return ARTICLE_FEEDS.filter(function (F) { return F.id === id; })[0] || ARTICLE_FEEDS[0]; }

  /* Le fil dont le panneau est ouvert sous cet identifiant, ou null (une tâche). */
  function feedOfPanel(id) { return ARTICLE_FEEDS.filter(function (F) { return F.panel === id; })[0] || null; }

  /* Boutons des cartes et du panneau : le fil est porté par `data-feed`. */
  function feedOf(el) { return feedById(el && el.getAttribute('data-feed')); }

  function articleState(F) { return S.ui.articles[F.id]; }

  function pad2(n) { return ('0' + n).slice(-2); }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* « 2026-10-05 » → date locale, ou null. */
  function dayDate(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  function fmtDay(key, opts) {
    var d = dayDate(key);
    return d ? d.toLocaleDateString('fr-FR', opts || { weekday: 'long', day: 'numeric', month: 'long' }) : String(key || '');
  }

  function articleOn(F) { return S.settings[F.setting] !== false && hasProvider('claude'); }

  function currentArticle(F) {
    var st = articleState(F).store;
    return st && st.current && st.current.url ? st.current : null;
  }

  function articleHistory(F) {
    var st = articleState(F).store;
    return st && Array.isArray(st.history) ? st.history.filter(function (a) { return a && a.url; }) : [];
  }

  function articleIsToday(a) { return !!a && a.day === todayKey(); }

  /* Ce que l'agent sait de l'utilisateur : les sujets qu'il a fixés, qui priment, puis ce qu'il a
     en file et ses dernières conversations — des titres, sans les adresses. */
  function articleInterests() {
    var lines = [];
    var clean = function (v) { return String(v || '').replace(URL_RE, '').replace(/\s+/g, ' ').trim(); };
    var topics = String(S.settings.articleTopics || '').trim();
    if (topics) lines.push('Sujets qui l’intéressent, fixés par lui (prioritaires) :', topics, '');
    var seen = {};
    var tasks = S.data.tasks.filter(function (t) { return !t.done; }).slice(0, ARTICLE_TASKS)
      .map(function (t) { return clean(firstLine(t.text, 160)); })
      .filter(function (v) { if (!v || seen[v]) return false; seen[v] = true; return true; });
    if (tasks.length) {
      lines.push('Ce sur quoi il travaille en ce moment — sa file de tâches, par ordre de priorité :');
      tasks.forEach(function (v) { lines.push('- ' + v); });
      lines.push('');
    }
    var convs = S.data.convos.filter(function (c) { return c.taskId !== FEEDBACK_ID; })
      .sort(function (a, b) { return toMs(b.updated) - toMs(a.updated); })
      .map(function (c) { return clean(c.title); })
      .filter(function (v) { if (!v || v === 'Nouvelle session' || seen[v]) return false; seen[v] = true; return true; })
      .slice(0, ARTICLE_CONVOS);
    if (convs.length) {
      lines.push('Ses dernières conversations avec des agents :');
      convs.forEach(function (v) { lines.push('- ' + v); });
    }
    return lines.join('\n').trim();
  }

  /* Les cartes et, s'il est ouvert, le panneau du fil : rien d'autre ne montre l'article. */
  function renderArticle(F) {
    renderPass(function () {
      renderUsage();
      if (S.ui.termTaskId === F.panel) renderPanel();
    });
  }

  /* Au démarrage : ce que l'hôte garde, sans rien lancer — puis l'article du jour de chaque fil s'il manque. */
  function peekArticles() {
    ARTICLE_FEEDS.forEach(function (F) {
      bridge.call('getArticle', { kind: F.id, mode: 'peek' }).then(function (r) {
        var A = articleState(F);
        A.store = r || null;
        A.loaded = true;
        renderArticle(F);
        ensureArticle(F, !!(r && r.busy));
      })['catch'](function (e) { console.warn('[organizator] getArticle ' + F.id, e); });
    });
  }

  function ensureArticles() {
    ARTICLE_FEEDS.forEach(function (F) { ensureArticle(F, false); });
  }

  /* Un article par jour et par fil : cherché s'il manque celui du jour (démarrage, retour au premier
     plan, changement de date), jamais par-dessus une recherche en cours, et pas plus d'une fois par
     heure après un échec. `hostBusy` : l'hôte cherche déjà (page rechargée) — on attend sa fiche. */
  function ensureArticle(F, hostBusy) {
    var A = articleState(F);
    if (!A.loaded || !articleOn(F) || A.busy) return;
    if (!hostBusy) {
      if (articleIsToday(currentArticle(F))) return;
      if (A.failedAt && Date.now() - A.failedAt < ARTICLE_RETRY_MS) return;
    }
    fetchArticle(F, 'today');
  }

  /* `today` : l'article du jour (l'hôte rend celui qu'il garde s'il date d'aujourd'hui) ;
     `another` : un autre, l'actuel passant dans les précédents. */
  function fetchArticle(F, mode) {
    var A = articleState(F);
    if (A.busy) return;
    A.busy = true;
    A.error = '';
    if (mode === 'another') A.shown = '';
    renderArticle(F);
    bridge.call('getArticle', { kind: F.id, mode: mode, interests: F.interests ? F.interests() : '' }, ARTICLE_WAIT).then(function (r) {
      A.busy = false;
      A.failedAt = 0;
      if (r) A.store = r;
      if (S.ui.termTaskId === F.panel && !A.shown) markArticleSeen(F);
      renderArticle(F);
    })['catch'](function (e) {
      A.busy = false;
      A.error = e.message;
      A.failedAt = Date.now();
      renderArticle(F);
      /* Lancé depuis la carte, panneau fermé : la carte garde l'article actuel, l'échec ne se verrait pas. */
      if (mode === 'another' && S.ui.termTaskId !== F.panel) toast('Pas d’autre article pour l’instant : ' + firstLine(e.message, 120));
    });
  }

  /* L'article du jour du fil est ouvert : sa carte ne le signale plus comme neuf. */
  function markArticleSeen(F) {
    var a = currentArticle(F);
    if (!a || a.seenAt) return;
    a.seenAt = Date.now();
    bridge.call('articleSeen', { kind: F.id, url: a.url })['catch'](function () { /* sans importance */ });
  }

  function scrollPanelTop() {
    var body = $('#panel .panel-body');
    if (body) body.scrollTop = 0;
  }

  function toggleArticle(F) {
    if (S.ui.termTaskId === F.panel) { closeTerm(); return; }
    articleState(F).shown = '';
    markArticleSeen(F);
    openTerm(F.panel);
    if (!currentArticle(F) && articleOn(F)) ensureArticle(F, false);
  }

  /* « source · 8 min · en anglais » */
  function articleMetaShort(a) {
    return [a.source, a.readingMinutes ? a.readingMinutes + ' min' : '', ARTICLE_LANGS[a.language] || ''].filter(Boolean).join(' · ');
  }

  function articlePublished(a) {
    var d = dayDate(a.published);
    return d ? 'publié le ' + d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  }

  function articleCardHtml(F) {
    if (!articleOn(F)) return '';
    var A = articleState(F);
    var a = currentArticle(F);
    var fresh = a && !a.seenAt && articleIsToday(a);
    var open = S.ui.termTaskId === F.panel;
    var feed = ' data-feed="' + F.id + '"';
    var tip = a ? a.title + (a.why ? '\n' + a.why : '') + '\nCliquer pour lire le résumé' : F.name;
    var h = ['<div class="usage-card article-card article-' + F.id + (open ? ' on' : '') + (A.busy && !a ? ' busy' : '') + '" data-act="open-article"' + feed + ' title="' + esc(tip) + '">'];
    h.push('<div class="usage-head"><span class="usage-name">' + esc(F.name) + '</span>'
      + '<span class="usage-plan">' + esc(a ? fmtDay(a.day, { weekday: 'short', day: 'numeric', month: 'short' }) : '') + '</span>'
      + (fresh ? '<span class="article-new" title="Pas encore lu"></span>' : '') + '</div>');
    if (a) {
      h.push('<div class="article-card-title">' + esc(a.title) + '</div>');
      /* « Suivant › » cherche un autre article sans ouvrir le panneau : le bouton porte sa propre
         action, le dispatcher prend la plus proche du clic. */
      h.push('<div class="article-card-foot">'
        + '<span class="article-card-meta' + (A.busy ? ' article-searching' : '') + '">' + esc(A.busy ? 'Recherche d’un nouvel article…' : articleMetaShort(a)) + '</span>'
        + '<button type="button" class="article-next" data-act="article-another"' + feed + (A.busy ? ' disabled' : '')
        + ' title="' + esc(A.busy ? 'Recherche en cours…' : 'Article suivant : en chercher un autre, celui-ci passe dans les précédents') + '">Suivant ›</button>'
        + '</div>');
    } else if (A.busy) {
      h.push('<div class="usage-msg article-searching">' + esc(F.searching) + '</div>');
    } else if (A.error) {
      h.push('<div class="usage-msg st-error">Indisponible · ' + esc(firstLine(A.error, 90)) + '</div>');
    } else {
      h.push('<div class="usage-msg">Aucun article pour l’instant.</div>');
    }
    h.push('</div>');
    return h.join('');
  }

  function articleBodyHtml(F, a, current) {
    var A = articleState(F);
    var h = ['<article class="article">'];
    h.push('<a class="article-title" href="' + esc(a.url) + '" data-act="open-url" data-url="' + esc(a.url) + '" title="Lire l’article dans le navigateur">'
      + esc(a.title) + '</a>');
    var meta = [a.source, a.author, articlePublished(a), a.readingMinutes ? a.readingMinutes + ' min de lecture' : '', ARTICLE_LANGS[a.language] || '']
      .filter(Boolean);
    if (meta.length) h.push('<div class="article-meta">' + esc(meta.join(' · ')) + '</div>');
    if (a.topic) h.push('<div class="article-topic">' + esc(a.topic) + '</div>');
    h.push('<p class="article-summary">' + esc(a.summary) + '</p>');
    var points = Array.isArray(a.keyPoints) ? a.keyPoints.filter(Boolean) : [];
    if (points.length) {
      h.push('<div class="article-sub">À retenir</div><ul class="article-points">'
        + points.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>');
    }
    if (a.why) h.push('<div class="article-sub">' + esc(F.why) + '</div><p class="article-why">' + esc(a.why) + '</p>');
    h.push('<div class="article-actions">'
      + '<button type="button" class="dark-btn dark-btn-primary" data-act="open-url" data-url="' + esc(a.url) + '">Lire l’article ↗</button>'
      + '</div>');
    if (current && A.error) h.push('<div class="article-error">Recherche impossible : ' + esc(A.error) + '</div>');
    var by = [a.fetchedAt ? 'Proposé le ' + fmtDate(a.fetchedAt) : '', a.model, a.ms ? Math.round(a.ms / 1000) + ' s' : ''].filter(Boolean);
    if (by.length) h.push('<div class="article-foot">' + esc(by.join(' · ')) + '</div>');
    h.push('</article>');
    return h.join('');
  }

  function articlePanelHtml(F) {
    var A = articleState(F);
    var cur = currentArticle(F);
    var history = articleHistory(F);
    var shown = A.shown ? history.filter(function (a) { return a.url === A.shown; })[0] || null : null;
    var a = shown || cur;
    var feed = ' data-feed="' + F.id + '"';
    var h = ['<div class="panel-body article-panel">'];
    if (shown) h.push('<button type="button" class="panel-link article-back" data-act="article-current"' + feed + '>' + esc(F.back) + '</button>');
    /* « Article suivant › » en tête de la fiche du jour, pas sous le résumé où on ne le voyait pas. */
    h.push('<div class="article-head"><div class="panel-kicker">' + esc((shown ? F.of : F.name + ' · ') + fmtDay(a ? a.day : todayKey())) + '</div>'
      + (a && !shown ? '<button type="button" class="dark-btn btn-small article-next-dark' + (A.busy ? ' article-searching' : '') + '" data-act="article-another"' + feed
        + (A.busy ? ' disabled' : '') + ' title="En chercher un autre : celui-ci passe dans les précédents">'
        + esc(A.busy ? 'Recherche en cours…' : 'Article suivant ›') + '</button>' : '')
      + '</div>');

    if (a) {
      if (!shown && !articleIsToday(a) && A.busy) h.push('<div class="panel-note">Recherche de l’article d’aujourd’hui… En attendant, celui du ' + esc(fmtDay(a.day)) + '.</div>');
      h.push(articleBodyHtml(F, a, !shown));
    } else if (A.busy) {
      h.push('<div class="panel-note article-searching">' + esc(F.lookup) + '</div>');
    } else if (A.error) {
      h.push('<div class="article-error">' + esc(A.error) + '</div>');
      h.push('<div class="article-actions"><button type="button" class="dark-btn" data-act="article-retry"' + feed + '>Réessayer</button></div>');
    } else if (!articleOn(F)) {
      h.push('<div class="panel-note">' + esc(hasProvider('claude') ? F.off
        : 'Claude Code est introuvable sur ce poste : ' + F.subject + ' a besoin de sa recherche web.') + '</div>');
    } else {
      h.push('<div class="panel-note">' + esc(F.empty) + '</div>');
      h.push('<div class="article-actions"><button type="button" class="dark-btn" data-act="article-retry"' + feed + '>' + esc(F.fetch) + '</button></div>');
    }

    var older = history.filter(function (x) { return !shown || x.url !== shown.url; });
    if (shown && cur) older.unshift(cur);
    if (older.length) {
      h.push('<div class="panel-kicker">Articles précédents · ' + older.length + '</div><div class="article-olds">');
      h.push(older.map(function (x) {
        var isCur = x === cur;
        return '<button type="button" class="article-old" data-act="' + (isCur ? 'article-current' : 'article-show') + '"' + feed + ' data-url="' + esc(x.url) + '">'
          + '<span class="article-old-title">' + esc(x.title) + '</span>'
          + '<span class="article-old-meta">' + esc([fmtDay(x.day, { day: 'numeric', month: 'short' }), x.source, x.topic].filter(Boolean).join(' · ')) + '</span>'
          + '</button>';
      }).join(''));
      h.push('</div>');
    }
    h.push('<div class="feedback-alt"><button type="button" class="panel-link" data-act="article-settings">' + esc(F.settings) + '</button></div>');
    h.push('</div>');
    return h.join('');
  }

  /* Relectures du journal en cours : une relecture de fond (minuteur, événement de l'hôte) ne part
     pas par-dessus une autre — la suivante verra ce que celle-ci aurait manqué. */
  var transcriptInFlight = 0;

  function loadTranscript(silent) {
    var c = S.ui.termConvId ? convoById(S.ui.termConvId) : null;
    if (!c) return Promise.resolve();
    if (silent && transcriptInFlight) return Promise.resolve();
    var token = ++transcriptToken;
    var id = c.id;
    transcriptInFlight++;
    return bridge.call('getTranscript', { sessionId: c.id, cwd: c.cwd, provider: providerOf(c) })
      .then(function (r) {
        if (token !== transcriptToken || S.ui.termConvId !== id) return;
        var next = { exists: !!(r && r.exists), messages: (r && r.messages) || [] };
        S.ui.sessionExists[id] = next.exists;
        if (silent && sameTranscript(S.ui.transcript, next)) return;
        S.ui.transcript = next;
        if (silent) renderActivity(); else render();
      })['catch'](function (e) {
        if (token !== transcriptToken || S.ui.termConvId !== id) return;
        S.ui.transcript = { exists: false, messages: [], error: e.message };
        render();
      }).then(function () { transcriptInFlight--; });
  }

  function sameTranscript(a, b) {
    if (!a || !b) return false;
    if (a.exists !== b.exists) return false;
    var ma = a.messages || [], mb = b.messages || [];
    if (ma.length !== mb.length) return false;
    for (var i = 0; i < ma.length; i++) {
      if (ma[i].role !== mb[i].role || ma[i].text !== mb[i].text) return false;
    }
    return true;
  }

  function normalizeArtifacts(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(function (artifact) {
      return artifact && String(artifact.path || '').trim();
    }).map(function (artifact) {
      var out = {
        path: String(artifact.path).trim(),
        action: String(artifact.action || 'modified'),
        tool: String(artifact.tool || 'outil'),
        agent: String(artifact.agent || '')
      };
      /* Dernière citation dans une réponse finale de l'agent (ms), 0 jamais ; absent d'un relevé ancien. */
      if (artifact.cited != null) out.cited = Number(artifact.cited) || 0;
      return out;
    });
  }

  function sameArtifacts(a, b) {
    var left = normalizeArtifacts(a);
    var right = normalizeArtifacts(b);
    if (left.length !== right.length) return false;
    for (var i = 0; i < left.length; i++) {
      if (left[i].path !== right[i].path || left[i].action !== right[i].action || left[i].tool !== right[i].tool
        || left[i].agent !== right[i].agent || left[i].cited !== right[i].cited) return false;
    }
    return true;
  }

  /* Agent par défaut des réglages, ou l'autre s'il est le seul installé. */
  function defaultProviderId() {
    var wanted = S.settings.provider === 'copilot' ? 'copilot' : 'claude';
    var other = wanted === 'copilot' ? 'claude' : 'copilot';
    return !hasProvider(wanted) && hasProvider(other) ? other : wanted;
  }

  /* Dossier proposé sur une tâche parente : le sien si elle a déjà tourné, sinon celui de la
     dernière conversation de ses sous-tâches — c'est là que la revue s'est faite —, sinon le réglage. */
  function groupCwdFor(parent) {
    if (convosOf(parent.id).length) return defaultCwdFor(parent.id);
    var convs = [];
    childrenOf(parent.id).forEach(function (k) { convs = convs.concat(convosOf(k.id)); });
    convs.sort(function (a, b) { return toMs(b.updated) - toMs(a.updated); });
    for (var i = 0; i < convs.length; i++) if (convs[i].cwd) return convs[i].cwd;
    return defaultCwdFor(parent.id);
  }

  function openNewConvo() {
    flushTextWrites();
    var task = taskById(S.ui.termTaskId);
    var subs = batchSubsOf(task);
    S.ui.newConvoOpen = true;
    newFormEntered = false;
    S.ui.newConvoCwd = subs.length ? groupCwdFor(task) : defaultCwdFor(S.ui.termTaskId);
    S.ui.newConvoPrompt = buildPrompt(task);
    S.ui.newConvoKeywords = [];
    S.ui.newKeywordOpen = false;
    S.ui.newKeywordName = '';
    S.ui.newKeywordPrompt = '';
    /* Une revue générale, ou une tâche dont chaque sous-tâche porte ses PRs, se lance d'office sur
       ses sous-tâches. Celles qui ont déjà leur rapport de revue, ou une conversation ouverte, partent
       décochées. */
    S.ui.newConvoTarget = subs.length && (task.reviewGroup
      || subs.every(function (k) { return taskPullRequests(k).length > 0; })) ? 'subs' : 'self';
    S.ui.newConvoSubs = {};
    subs.forEach(function (k) {
      S.ui.newConvoSubs[k.id] = !reviewReportsOf(convosOf(k.id)).length && !batchSubBusy(k);
    });
    S.ui.newConvoNote = '';
    setNewConvoProvider(defaultProviderId());
    if (S.ui.newConvoTarget === 'self') {
      loadRecap(task);
    } else {
      recapToken++;
      S.ui.newConvoRecap = '';
      S.ui.newConvoRecapMeta = null;
      S.ui.newConvoRecapBusy = false;
    }
    render();
    var el = document.querySelector('[data-focus-key="new-cwd"]');
    if (el) { el.focus(); el.select(); }
  }

  function browseFolder(initial) {
    return bridge.call('pickFolder', { initial: initial || '' })
      .then(function (r) { return r && r.path ? r.path : null; })
      ['catch'](function (e) { toast('Sélecteur de dossier indisponible : ' + e.message); return null; });
  }

  /* Formulaire validé : lance la session avec les choix du formulaire. */
  function launchConvo() {
    var task = taskById(S.ui.termTaskId);
    if (!task) return;
    if (batchTargetOn(task)) { launchBatch(task); return; }
    var provider = S.ui.newConvoProvider === 'copilot' ? 'copilot' : 'claude';
    var cwd = String(S.ui.newConvoCwd || '').trim();
    if (!cwd) { toast('Indiquez un dossier de travail.'); return; }
    /* Les blocs de texte joints sont écrits sur le disque avant le départ : l'agent lit la dernière
       version, et un message resté tel que proposé est recomposé avec leurs chemins à jour. */
    var auto = S.ui.newConvoPrompt === buildPrompt(task);
    flushTextWrites().then(function () {
      startSession(task, provider, String(S.ui.newConvoModel || '').trim(), String(S.ui.newConvoEffort || '').trim(), cwd,
        keywordIdsFor(task, S.ui.newConvoKeywords), auto ? buildPrompt(task) : S.ui.newConvoPrompt,
        S.ui.newConvoRecapBusy ? '' : S.ui.newConvoRecap);
    });
  }

  /* Bouton direct du carnet : agent, modèle et effort par défaut, dans le dépôt. Le texte
     encore dans la zone de saisie part aussi. Sans dossier connu, le formulaire s'ouvre. */
  function sendRemarks() {
    if (S.ui.launchBusy) return;
    flushTypedRemark();
    if (!pendingRemarks().length) { toast('Écrivez d’abord une remarque.'); return; }
    var provider = defaultProviderId();
    var cwd = defaultCwdFor(FEEDBACK_ID);
    if (!cwd) { toast('Indiquez le dossier des sources d’Organizator.'); openNewConvo(); return; }
    startSession(FEEDBACK_TASK, provider, String(S.settings[modelSettingKey(provider)] || '').trim(),
      String(S.settings[effortSettingKey(provider)] || '').trim(), cwd, []);
  }

  /* Lance une session dans PowerShell ; pour le carnet, les remarques en attente partent en premier message.
     `prompt` : le premier message d'une tâche (absent = son texte, tel que buildPrompt le propose).
     Le bouton reste grisé (« Lancement… ») jusqu'à la réponse de l'hôte, puis un toast confirme. */
  function startSession(task, provider, model, effort, cwd, keywords, prompt, recap) {
    if (S.ui.launchBusy) return;
    if (!hasProvider(provider)) { toast(providerById(provider).missing); return; }
    var feedback = task.id === FEEDBACK_ID;
    var pending = feedback ? pendingRemarks() : [];
    if (feedback && !pending.length) { toast('Aucune remarque à envoyer.'); return; }
    var first = feedback ? feedbackPrompt(pending)
      : String(prompt == null ? buildPrompt(task) : prompt).trim();
    S.ui.launchBusy = true;
    render();
    launchSession(task, {
      provider: provider, model: model, effort: effort, cwd: cwd, keywords: keywords, prompt: first, recap: recap,
      title: feedback ? feedbackTitle(pending.length) : ''
    })
      .then(function (c) {
        if (feedback) markRemarksSent(pending, c.id);
        S.ui.launchBusy = false;
        S.ui.newConvoOpen = false;
        S.ui.newConvoCwd = '';
        S.ui.newConvoPrompt = '';
        commit();
        toast(feedback
          ? (pending.length > 1 ? pending.length + ' remarques envoyées' : 'Remarque envoyée') + ' à ' + providerById(provider).label + ' dans PowerShell (' + lastSegment(cwd) + ')'
          : (first ? 'Session lancée : l’agent démarre sur la tâche' : 'Session lancée : l’agent attend votre saisie'));
      })['catch'](function (e) {
        S.ui.launchBusy = false;
        render();
        toast('Lancement impossible : ' + e.message);
      });
  }

  /* Demande à l'hôte d'ouvrir la session, puis l'enregistre ; rend la conversation. Ni verrou, ni
     formulaire, ni toast : c'est l'affaire de l'appelant (startSession pour une conversation,
     launchBatch pour un lot). `o` : { provider, model, effort, cwd, keywords, prompt, recap,
     title?, taskInContext?, batch? } — `taskInContext`, s'il est donné, remplace la règle ordinaire. */
  function launchSession(task, o) {
    var first = String(o.prompt == null ? buildPrompt(task) : o.prompt).trim();
    var title = o.title || firstLine(task.text, 46);
    var chosen = keywordIdsFor(task, o.keywords);
    /* La tâche reste dans le contexte sauf quand c'est elle qui part en message : un message
       retouché (« commence par reproduire le bug ») ne doit pas priver l'agent de l'énoncé. */
    var taskInContext = typeof o.taskInContext === 'boolean' ? o.taskInContext : first !== buildPrompt(task);
    var recap = task.id === FEEDBACK_ID ? '' : String(o.recap || '').trim();
    return bridge.call('startSession', {
      taskId: task.id, provider: o.provider, model: o.model, effort: o.effort, cwd: o.cwd, title: title,
      keywords: chosen, context: buildContext(task, chosen, taskInContext, recap), prompt: first
    }).then(function (r) {
      if (!r || !r.sessionId) throw new Error('réponse incomplète de l’hôte');
      return recordConvo(task, r, { provider: o.provider, model: o.model, effort: o.effort, title: title, cwd: o.cwd, keywords: chosen, batch: o.batch });
    });
  }

  /* `batch` : identifiant du lot dont la conversation fait partie (voir launchBatch). */
  function recordConvo(task, r, o) {
    var now = Date.now();
    var c = {
      id: r.sessionId, taskId: task.id, provider: o.provider, model: o.model, effort: o.effort, title: o.title, cwd: r.cwd || o.cwd,
      keywords: o.keywords, artifacts: [], created: toMs(r.created) || now, updated: toMs(r.created) || now, messageCount: 0
    };
    if (o.batch) c.batch = o.batch;
    S.data.convos.push(c);
    S.ui.sessionExists[r.sessionId] = false;
    return c;
  }

  /* Le texte tapé mais pas encore ajouté devient une remarque ; vrai si quelque chose a été ajouté. */
  function flushTypedRemark() {
    var text = String(S.ui.remarkText || '').trim();
    if (!text) return false;
    S.data.remarks.push({ id: uid('r'), text: text, created: Date.now(), sentAt: 0, sessionId: '' });
    S.ui.remarkText = '';
    return true;
  }

  /* L'hôte a-t-il ouvert un terminal, ou ramené celui de la session ? Quand le terminal groupe ses
     sessions en onglets, il active celui de la session ; s'il n'a pas su lequel c'était, il le
     nomme — à nous de le dire. Une session vivante dont la fenêtre reste introuvable n'est pas
     relancée (`alive`) : un second agent travaillerait sur le même fichier de session. */
  function resumeToast(r) {
    if (r && r.alive && !r.focused) return 'Session déjà ouverte, mais sa fenêtre est introuvable';
    if (!r || !r.focused) return 'Session reprise dans PowerShell';
    if (r.raised === false) {
      return 'Session déjà ouverte : Windows n’a pas laissé passer son terminal devant — son bouton clignote dans la barre des tâches'
        + (r.tab ? ', onglet « ' + r.tab + ' »' : '');
    }
    if (r.tab) return 'Session déjà ouverte : fenêtre au premier plan, onglet « ' + r.tab + ' »';
    return r.tabActivated
      ? 'Session déjà ouverte : son onglet est au premier plan'
      : 'Session déjà ouverte : sa fenêtre est au premier plan';
  }

  /* Reprises en cours, par conversation : un double-clic en envoyait deux, et la seconde, partie
     avant que le terminal de la première n'ait sa fenêtre, pouvait en ouvrir un second. */
  var resuming = {};

  /* `withRemarks` : reprend la session en lui envoyant les remarques en attente (carnet seulement).
     `force` : second terminal sur une session vivante dont la fenêtre est introuvable, demandé
     depuis le toast. */
  function resumeConvo(convId, withRemarks, force) {
    var c = convoById(convId);
    if (!c || resuming[convId]) return;
    var provider = providerOf(c);
    if (!hasProvider(provider)) { toast(providerById(provider).missing); return; }
    var task = taskById(c.taskId);
    var pending = withRemarks && c.taskId === FEEDBACK_ID ? pendingRemarks() : [];
    resuming[convId] = true;
    bridge.call('resumeSession', {
      sessionId: c.id, provider: provider, model: c.model || '', effort: c.effort || '', cwd: c.cwd, title: c.title,
      keywords: task ? keywordIdsFor(task, c.keywords) : [],
      context: task ? buildContext(task, c.keywords, true) : '', prompt: pending.length ? feedbackPrompt(pending) : '',
      force: !!force
    }).then(function (r) {
      delete resuming[convId];
      if (r && r.alive && !r.focused) {
        toast(resumeToast(r), { label: 'Ouvrir un second terminal', run: function () { resumeConvo(convId, withRemarks, true); } });
        return;
      }
      if (!pending.length) { toast(resumeToast(r)); return; }
      markRemarksSent(pending, c.id);
      c.updated = Date.now();
      commit();
      toast('Remarques envoyées dans la session existante');
    })['catch'](function (e) { delete resuming[convId]; toast('Reprise impossible : ' + e.message); });
  }

  /* ══ Lancement sur les sous-tâches et lots ════════════════════════════ */

  /* Depuis une tâche parente, une conversation par sous-tâche cochée — même agent, même modèle,
     même effort, mêmes mots-clés —, chacune sur le texte de sa sous-tâche, avec son propre
     « Travail déjà fait ». Les lancements se suivent, espacés : chacun occupe le fil de l'hôte un
     instant (Process.Start), écrit ~/.claude.json, et ouvre un onglet de terminal qu'on veut dans
     l'ordre de la file. Le lot est noté sur la parente (`batch` : { id, at, n, endedAt }, le dernier
     seulement) et sur chacune de ses conversations (`batch` : id) : c'est ce qui dit quand tout est fini. */
  var BATCH_LAUNCH_GAP_MS = 1500, BATCH_GRACE_MS = 30000, BATCH_DEAD_MS = 120000, BATCH_CONFIRM_MS = 5000;
  /* Lot en cours de lancement : il n'est pas jugé avant que toutes ses conversations soient parties. */
  var batchLaunching = null;
  /* Lot vu fini à une relecture, en attente de la confirmation : id → heure (mémoire seulement). */
  var batchDoneSince = {};

  function batchWait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function launchBatch(parent) {
    if (S.ui.launchBusy) return;
    var provider = S.ui.newConvoProvider === 'copilot' ? 'copilot' : 'claude';
    if (!hasProvider(provider)) { toast(providerById(provider).missing); return; }
    var cwd = String(S.ui.newConvoCwd || '').trim();
    if (!cwd) { toast('Indiquez un dossier de travail.'); return; }
    var subs = batchChosen(parent);
    if (!subs.length) { toast('Cochez au moins une sous-tâche.'); return; }
    /* Tout est figé au départ : retoucher le formulaire pendant le lancement ne change rien au lot. */
    var model = String(S.ui.newConvoModel || '').trim();
    var effort = String(S.ui.newConvoEffort || '').trim();
    /* Par nom : une sous-tâche peut être rangée dans une autre catégorie que sa parente. */
    var names = keywordsByIds(parent, keywordIdsFor(parent, S.ui.newConvoKeywords)).map(function (kw) { return kw.name; });
    var note = String(S.ui.newConvoNote || '').trim();
    var id = uid('b'), prev = parent.batch;
    var launched = [], failed = [], noRecap = false;
    var progress = S.ui.batchProgress = { parentId: parent.id, done: 0, total: subs.length, phase: 'recap' };
    S.ui.launchBusy = true;
    batchLaunching = id;
    render();
    flushTextWrites().then(function () {
      return loadBatchRecaps(subs);
    }).then(function (res) {
      noRecap = res.failed;
      parent.batch = { id: id, at: Date.now(), n: 0, endedAt: 0 };
      progress.phase = 'launch';
      render();
      return subs.reduce(function (chain, sub, i) {
        return chain.then(function () {
          return i ? batchWait(BATCH_LAUNCH_GAP_MS) : null;
        }).then(function () {
          /* La précision commune suit la tâche dans le message : la tâche n'a pas à revenir dans le contexte. */
          return launchSession(sub, {
            provider: provider, model: model, effort: effort, cwd: cwd, keywords: keywordIdsFor(sub, names),
            prompt: buildPrompt(sub) + (note ? '\n\n' + note : ''), taskInContext: false,
            recap: res.recaps[sub.id] || '', batch: id
          });
        }).then(function (c) {
          launched.push(c);
          /* Déjà lancée : elle ne doit pas se perdre si l'application se ferme avant la fin du lot. */
          saveDataLater();
        }, function (e) {
          failed.push({ task: sub, message: e && e.message ? e.message : String(e) });
        }).then(function () {
          progress.done++;
          render();
        });
      }, Promise.resolve());
    })['catch'](function (e) {
      console.warn('[organizator] launchBatch', e);
    }).then(function () {
      var n = launched.length;
      if (n) parent.batch.n = n;
      else if (prev) parent.batch = prev;
      else delete parent.batch;
      batchLaunching = null;
      S.ui.launchBusy = false;
      S.ui.batchProgress = null;
      /* Rien de parti : le formulaire reste ouvert, comme après l'échec d'un lancement ordinaire. */
      if (n && S.ui.newConvoOpen && S.ui.termTaskId === parent.id) {
        S.ui.newConvoOpen = false;
        S.ui.newConvoCwd = '';
        S.ui.newConvoPrompt = '';
        S.ui.newConvoTarget = 'self';
        S.ui.newConvoSubs = {};
        S.ui.newConvoNote = '';
      }
      commit();
      refreshSessions();
      toast(batchLaunchText(parent, subs.length, n, failed, noRecap));
    });
  }

  function batchLaunchText(parent, total, n, failed, noRecap) {
    var tail = noRecap ? ' (sans « Travail déjà fait » : lecture impossible)' : '';
    if (!n) return 'Lancement impossible : ' + (failed.length ? failed[0].message : 'aucune conversation lancée') + tail;
    if (failed.length) {
      return n + (n > 1 ? ' conversations lancées' : ' conversation lancée') + ' sur ' + total + ' — échec pour '
        + failed.map(function (f) { return '« ' + firstLine(f.task.text, 40).trim() + ' »'; }).join(', ')
        + ' : ' + failed[0].message + tail;
    }
    return n + (n > 1 ? ' conversations lancées, une par sous-tâche' : ' conversation lancée, sur la sous-tâche cochée')
      + (parent.reviewGroup ? ' — la revue générale est en cours' : '') + tail;
  }

  /* Conversations du dernier lot lancé depuis `t`. */
  function batchConvos(t) {
    var id = t && t.batch ? t.batch.id : '';
    return id ? S.data.convos.filter(function (c) { return c.batch === id; }) : [];
  }

  /* L'agent a-t-il rendu la main ? Prudence au départ : le processus n'est vu vivant qu'au premier
     balayage (4 s après le lancement), l'état dirait « fermée » d'ici là. Une conversation dont
     l'équipe travaille encore est « en cours » pour displayState : elle n'est pas finie. */
  function batchConvoDone(c, now) {
    var age = (now || Date.now()) - toMs(c.created);
    if (age < BATCH_GRACE_MS) return false;
    var st = displayState(c);
    if (st === 'ready' || st === 'error' || st === 'closed' || st === 'idle') return true;
    /* Jamais démarrée : ni fichier de session ni processus, longtemps après le lancement. */
    var a = activityOf(c);
    return st === null && !!a && a.alive === false && age > BATCH_DEAD_MS;
  }

  /* Après chaque relecture des sessions. Un lot est fini quand toutes ses conversations ont rendu
     la main, constaté à deux relectures espacées d'au moins BATCH_CONFIRM_MS : un agent qui enchaîne
     deux tours passe un instant par « réponse prête ». Rien ne s'ouvre tout seul : un toast le dit. */
  function checkBatches() {
    var now = Date.now();
    S.data.tasks.forEach(function (t) {
      var b = t.batch;
      if (!b || b.endedAt || b.id === batchLaunching) return;
      var convs = batchConvos(t);
      /* Conversations supprimées entre-temps : le lot se clôt sans bruit. */
      if (!convs.length) { b.endedAt = now; delete batchDoneSince[b.id]; saveDataLater(); return; }
      if (!convs.every(function (c) { return batchConvoDone(c, now); })) { delete batchDoneSince[b.id]; return; }
      if (!batchDoneSince[b.id]) { batchDoneSince[b.id] = now; return; }
      if (now - batchDoneSince[b.id] < BATCH_CONFIRM_MS) return;
      delete batchDoneSince[b.id];
      b.endedAt = now;
      saveDataNow();
      batchEndToast(t, convs);
    });
  }

  /* Rapports comptés par sous-tâche : ceux qu'une conversation du lot a écrits. */
  function batchEndToast(t, convs) {
    var seen = {}, reports = 0;
    convs.forEach(function (c) {
      if (seen[c.taskId] || !reviewReportsOf([c]).length) return;
      seen[c.taskId] = true;
      reports++;
    });
    var errors = convs.filter(function (c) { return displayState(c) === 'error'; }).length;
    var errText = errors ? ', ' + errors + ' en erreur' : '';
    var said = reports ? 'Revue générale terminée — ' + reports + (reports > 1 ? ' rapports' : ' rapport') + errText
      : (t.reviewGroup ? 'Revue générale terminée — aucun rapport de revue écrit' + errText : 'Toutes les conversations des sous-tâches ont rendu la main.');
    notifyOutside([recordNotification('batch', null, {
      taskId: t.id, title: firstLine(t.text, 90).trim() || 'Tâche sans titre', text: said, reports: reports
    })]);
    if (reports) {
      toast('Revue générale terminée — ' + reports + (reports > 1 ? ' rapports' : ' rapport') + errText,
        { label: 'Ouvrir', run: function () { openReviewGroup({ parentId: t.id }); } });
    } else if (t.reviewGroup) {
      toast('Revue générale terminée — aucun rapport de revue écrit' + errText);
    } else {
      toast('Conversations des sous-tâches terminées — « ' + firstLine(t.text, 40).trim() + ' »');
    }
  }

  /* ══ Actions — remarques sur Organizator ══════════════════════════════ */

  /* Premier message de l'agent : les remarques, numérotées comme dans le panneau. */
  function feedbackPrompt(list) {
    var many = list.length > 1;
    var lines = list.map(function (r, i) {
      return (i + 1) + '. ' + String(r.text || '').trim().replace(/\r?\n/g, '\n   ');
    });
    return (many ? 'Voici mes remarques sur Organizator, à traiter dans ce dépôt :' : 'Voici ma remarque sur Organizator, à traiter dans ce dépôt :')
      + '\n\n' + lines.join('\n') + '\n\n'
      + (many ? 'Traite-les dans l’ordre. ' : '')
      + 'Si une remarque est ambiguë, pose-moi la question avant de coder. '
      + 'Termine par un récapitulatif de ce qui a changé et de ce qui reste à faire.';
  }

  function feedbackTitle(n) {
    return 'Remarques Organizator · ' + n + ' · ' + new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  /* La session garde aussi le texte de ce qu'elle a reçu (`convo.remarks`) : ce qui a donné lieu à la
     conversation se lit sous elle, même une fois l'historique des remarques envoyées effacé. */
  function markRemarksSent(list, sessionId) {
    var now = Date.now();
    list.forEach(function (r) { r.sentAt = now; r.sessionId = sessionId || ''; });
    var c = sessionId ? convoById(sessionId) : null;
    if (c) {
      c.remarks = convoRemarks(c).concat(list.map(function (r) { return { id: r.id, text: r.text, sentAt: now }; }));
    }
  }

  function addRemark() {
    if (!flushTypedRemark()) { toast('Écrivez d’abord la remarque.'); return; }
    commit();
  }

  function removeRemark(id) {
    S.data.remarks = S.data.remarks.filter(function (r) { return r.id !== id; });
    commit();
  }

  function clearSentRemarks() {
    S.data.remarks = S.data.remarks.filter(function (r) { return !r.sentAt; });
    S.ui.sentOpen = false;
    commit();
  }

  function toggleFeedback() {
    if (S.ui.termTaskId === FEEDBACK_ID) closeTerm(); else openTerm(FEEDBACK_ID);
  }

  function removeConvo(convId) {
    S.data.convos = S.data.convos.filter(function (c) { return c.id !== convId; });
    delete S.ui.sessionExists[convId];
    delete S.ui.activity[convId];
    if (S.ui.artifactConvId === convId) S.ui.artifactConvId = null;
    if (S.ui.termConvId === convId) { S.ui.termConvId = null; S.ui.transcript = null; syncPolling(); }
    commit();
  }

  /* ══ Actions — réglages ═══════════════════════════════════════════════ */

  function setSetting(key, value, immediate) {
    S.settings[key] = value;
    if (immediate === false) saveSettingsSoon(); else saveSettingsNow();
    if (immediate !== false) render();
  }

  /* ══ Événements ═══════════════════════════════════════════════════════ */

  var ACTIONS = {
    noop: function (el, e) { e.stopPropagation(); },

    'toggle-filters': function () {
      S.ui.filtersOpen = !S.ui.filtersOpen;
      render();
    },

    'toggle-filter': function (el) {
      var id = el.getAttribute('data-id');
      S.ui.hidden = S.ui.hidden.indexOf(id) >= 0
        ? S.ui.hidden.filter(function (x) { return x !== id; })
        : S.ui.hidden.concat([id]);
      render();
    },

    gap: function (el) {
      if (S.ui.dragId) return;
      openComposer(el.getAttribute('data-gap'), el.getAttribute('data-gap-parent') || null);
    },
    'add-tail': function () { openComposer('bottom'); },
    /* Sous-tâche depuis la carte : elle prend place après les sous-tâches existantes. */
    'add-sub': function (el) {
      var t = taskById(el.getAttribute('data-id'));
      if (!t) return;
      openComposer(lastOfGroup(t).id, t.id);
    },
    'toggle-subs': function (el) {
      var t = taskById(el.getAttribute('data-id'));
      if (!t) return;
      if (subsFolded(t)) delete t.collapsed; else t.collapsed = true;
      commit();
    },

    edit: function (el) {
      S.ui.editingId = el.getAttribute('data-id');
      render();
      var ta = document.querySelector('[data-focus-key="edit-text"]');
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    },
    'stop-edit': function () { S.ui.editingId = null; flushTextWrites(); render(); },
    'attach-pick': function (el) { pickAttachments(el.getAttribute('data-owner')); },
    'attach-text': function (el) { addTextAttachment(el.getAttribute('data-owner')); },
    'remove-attachment': function (el) { removeAttachment(el.getAttribute('data-owner'), el.getAttribute('data-att')); },
    'open-attachment': function (el) { openAttachment(el.getAttribute('data-owner'), el.getAttribute('data-att')); },
    'set-type': function (el) { setType(el.getAttribute('data-id'), el.getAttribute('data-type')); },
    'toggle-done': function (el) { toggleDone(el.getAttribute('data-id')); },
    'toggle-doing': function (el) { toggleDoing(el.getAttribute('data-id')); },
    'remove-task': function (el) { removeTask(el.getAttribute('data-id')); },
    'move-bottom': function (el) { moveToBottom(el.getAttribute('data-id')); },
    'open-term': function (el, e) { clickTerm(el.getAttribute('data-id'), e && e.shiftKey); },
    /* Un seul rapport : il s'ouvre aussitôt dans le lecteur. Plusieurs, ou Maj + clic : le panneau. */
    'open-artifacts': function (el, e) {
      var id = el.getAttribute('data-id');
      var reports = reportsOf(convosOf(id));
      if (reports.length === 1 && !(e && e.shiftKey)) openReader(reports[0].path, reports[0].cwd);
      else openArtifacts(id);
    },
    'open-artifact': function (el) {
      openReader(el.getAttribute('data-path') || '', el.getAttribute('data-cwd') || '');
    },
    'close-reader': closeReader,
    'reader-back': backReader,
    'open-review': function (el) { openReview(el.getAttribute('data-id')); },
    'open-review-group': function (el) { openReviewGroup({ parentId: el.getAttribute('data-id') }); },
    'open-reviews': function () { openReviewGroup({}); },
    'rv-tab': function (el) { reviewGroupGo(el.getAttribute('data-id')); },
    'rv-pick': function (el) { reviewPick(el.getAttribute('data-key')); },
    'rv-overview': function () { reviewPick(''); },
    'rv-prev': function () { reviewStep(-1); },
    'rv-next': function () { reviewStep(1); },
    'rv-cat': function (el) {
      var r = S.ui.reader;
      if (!r || !r.rv) return;
      r.rv.cat = el.getAttribute('data-cat') || '';
      render();
    },
    'rv-chat': function () { var r = S.ui.reader; if (r && r.rv && r.rv.chat) closeFindingChat(); else openFindingChat(); },
    'rv-chat-close': closeFindingChat,
    'rv-chat-send': sendFindingQuestion,
    'rv-chat-stop': stopFindingAnswer,
    'rv-chat-forget': forgetFindingChat,
    'rv-doc': function () { if (S.ui.reader) { keepReviewScroll(S.ui.reader); S.ui.reader.mode = 'doc'; render(); } },
    'rv-review': function () { if (S.ui.reader) { S.ui.reader.mode = 'review'; render(); } },
    'reader-vscode': function () {
      var r = S.ui.reader;
      if (!r || !r.view) return;
      bridge.call('openPath', { path: r.view.full, editor: 'vscode' }).then(function (result) {
        if (result && result.editor === 'explorer') toast('VS Code introuvable : fichier affiché dans l’Explorateur');
      })['catch'](function (e) { toast('Ouverture impossible : ' + e.message); });
    },
    'reader-folder': function () {
      var r = S.ui.reader;
      if (!r || !r.view) return;
      bridge.call('openPath', { path: r.view.full })['catch'](function (e) { toast('Ouverture impossible : ' + e.message); });
    },

    'toggle-artifact-files': function () { S.ui.artifactFilesOpen = !S.ui.artifactFilesOpen; render(); },
    'toggle-artifact-work': function () { S.ui.artifactWorkOpen = !S.ui.artifactWorkOpen; render(); },

    'close-composer': closeComposer,
    'open-cat': function () { S.ui.catFormOpen = true; render(); },
    'close-cat': function () { S.ui.catFormOpen = false; S.ui.catName = ''; render(); },
    'add-cat': addCat,

    'open-cats': openCats,
    'close-cats': closeCats,
    'cats-new': newCatInDialog,
    'cat-palette': function (el) { setCatPalette(el.getAttribute('data-id'), el.getAttribute('data-palette')); },
    'cat-remove-keyword': function (el) { removeKeyword(el.getAttribute('data-id'), el.getAttribute('data-kw')); },
    'cat-edit-keyword': function (el) {
      var id = el.getAttribute('data-kw') || '';
      S.ui.catKeywordEdit = S.ui.catKeywordEdit === id ? '' : id;
      render();
      if (S.ui.catKeywordEdit) {
        var box = document.querySelector('[data-focus-key="kw-name-' + S.ui.catKeywordEdit + '"]');
        if (box) box.focus();
      }
    },
    'cat-delete': function (el) { removeCat(el.getAttribute('data-id')); },
    'pick-palette': function (el) { S.ui.catPalette = el.getAttribute('data-id'); render(); },
    'pick-type': function (el) { S.ui.composerType = el.getAttribute('data-id'); commit(); },
    'add-task': addFromComposer,
    'pr-import': openPrImport,
    'pr-import-retry': openPrImport,
    'pr-import-close': function () { S.ui.prImport = null; render(); },
    'pr-import-create': createFromPrImport,
    'open-url': function (el, e) {
      if (e && e.preventDefault) e.preventDefault();
      var url = el.getAttribute('data-url') || '';
      if (!/^https?:\/\//i.test(url)) return;
      bridge.call('openUrl', { url: url })['catch'](function (err) { toast('Ouverture impossible : ' + err.message); });
    },

    'close-term': closeTerm,
    'back-to-list': backToList,
    'new-convo': openNewConvo,
    'cancel-new-convo': function () {
      S.ui.newConvoOpen = false;
      S.ui.newConvoTarget = 'self';
      S.ui.newConvoSubs = {};
      S.ui.newConvoNote = '';
      render();
    },
    /* Lancer sur la tâche elle-même ou sur chacune de ses sous-tâches. Le « Travail déjà fait » de la
       tâche n'est lu qu'au premier passage sur elle-même. */
    'pick-target': function (el) {
      S.ui.newConvoTarget = el.getAttribute('data-id') === 'subs' ? 'subs' : 'self';
      if (S.ui.newConvoTarget === 'self' && !S.ui.newConvoRecapMeta && !S.ui.newConvoRecapBusy && !S.ui.newConvoRecap) {
        loadRecap(taskById(S.ui.termTaskId));
      }
      render();
    },
    'toast-act': function () {
      var act = S.ui.toastAction;
      clearToast();
      if (act && act.run) act.run();
    },
    'browse-cwd': function () {
      browseFolder(S.ui.newConvoCwd).then(function (p) { if (p) { S.ui.newConvoCwd = p; render(); } });
    },
    'pick-provider': function (el) {
      setNewConvoProvider(el.getAttribute('data-id') === 'copilot' ? 'copilot' : 'claude');
      render();
    },
    /* Choix multiple : une pastille se coche et se décoche. */
    'pick-keyword': function (el) {
      var id = el.getAttribute('data-kw') || '';
      var current = S.ui.newConvoKeywords || [];
      var next = current.indexOf(id) >= 0
        ? current.filter(function (x) { return x !== id; })
        : current.concat([id]);
      S.ui.newConvoKeywords = keywordIdsFor(taskById(S.ui.termTaskId), next);
      render();
    },
    'kw-new-open': function () {
      S.ui.newKeywordOpen = true;
      render();
      var box = document.querySelector('[data-focus-key="new-kw-name"]');
      if (box) box.focus();
    },
    'kw-new-cancel': function () {
      resetNewKeyword();
      render();
    },
    'kw-new-team-toggle': function () {
      S.ui.newKeywordTeam = !S.ui.newKeywordTeam;
      render();
    },
    'kw-new-agent-remove': function (el) {
      var agentId = el.getAttribute('data-agent');
      S.ui.newKeywordAgents = (S.ui.newKeywordAgents || []).filter(function (a) { return a.id !== agentId; });
      render();
    },
    'kw-new-save': addKeywordFromLaunch,

    /* Équipe portée par un mot-clé : la case l'arme, et l'agent principal la lancera lui-même. */
    'kw-team-toggle': function (el) {
      var kw = keywordOf(el.getAttribute('data-id'), el.getAttribute('data-kw'));
      if (!kw) return;
      kw.team = !kw.team;
      commit();
      /* Armée sans personne, l'équipe ne ferait rien : une première ligne s'ouvre d'office. */
      if (kw.team && !normalizeAgents(kw.agents).length) addAgent(el.getAttribute('data-id'), el.getAttribute('data-kw'));
    },
    'kw-agent-add': function (el) { addAgent(el.getAttribute('data-id'), el.getAttribute('data-kw')); },
    'kw-agent-remove': function (el) {
      removeAgent(el.getAttribute('data-id'), el.getAttribute('data-kw'), el.getAttribute('data-agent'));
    },

    /* Rédaction assistée : un titre, l'agent propose le texte qui va dessous. */
    'draft-keyword': function (el) {
      var typeId = el.getAttribute('data-id');
      var keywordId = el.getAttribute('data-kw');
      var ty = typeOf(typeId);
      var kw = (Array.isArray(ty.keywords) ? ty.keywords : []).filter(function (k) { return k.id === keywordId; })[0];
      if (!kw) return;
      runDraft('kw:' + keywordId, 'keyword', { typeId: typeId, keywordId: keywordId },
        keywordDraftPrompt(ty.label, kw.name));
    },
    'draft-new-keyword': function () {
      var task = taskById(S.ui.termTaskId);
      var name = parseKeywordNames(S.ui.newKeywordName)[0] || '';
      if (!name) { toast('Donnez d’abord un nom au mot-clé.'); return; }
      runDraft('new-kw', 'new-keyword', {}, keywordDraftPrompt(task ? typeOf(task.type).label : '', name));
    },
    'draft-team': function (el) {
      var typeId = el.getAttribute('data-id');
      var keywordId = el.getAttribute('data-kw');
      var kw = keywordOf(typeId, keywordId);
      if (!kw) return;
      if (!kw.name) { toast('Donnez d’abord un nom au mot-clé.'); return; }
      runDraft('team:' + keywordId, 'team', { typeId: typeId, keywordId: keywordId },
        teamDraftPrompt(typeOf(typeId).label, kw.name, kw.prompt, kw.agents));
    },
    'draft-agent': function (el) {
      var typeId = el.getAttribute('data-id');
      var keywordId = el.getAttribute('data-kw');
      var agentId = el.getAttribute('data-agent');
      var kw = keywordOf(typeId, keywordId);
      var agent = agentOf(kw, agentId);
      if (!agent) return;
      if (!agent.name) { toast('Donnez d’abord un nom à l’agent.'); return; }
      runDraft('agent:' + agentId, 'agent', { typeId: typeId, keywordId: keywordId, agentId: agentId },
        agentDraftPrompt(typeOf(typeId).label, kw.name, kw.prompt, agent));
    },
    'draft-new-team': function () {
      var task = taskById(S.ui.termTaskId);
      var name = parseKeywordNames(S.ui.newKeywordName)[0] || '';
      if (!name) { toast('Donnez d’abord un nom au mot-clé.'); return; }
      runDraft('new-team', 'new-team', {}, teamDraftPrompt(task ? typeOf(task.type).label : '', name,
        S.ui.newKeywordPrompt, S.ui.newKeywordAgents));
    },
    'draft-task': function (el) {
      var task = taskById(el.getAttribute('data-id'));
      if (!task) return;
      var title = firstLine(task.text, 200).trim();
      if (!title) { toast('Écrivez d’abord un titre sur la première ligne.'); return; }
      runDraft('task:' + task.id, 'task', { taskId: task.id }, taskDraftPrompt(typeOf(task.type).label, title));
    },
    'draft-composer': function () {
      var ty = S.ui.composerType ? typeOf(S.ui.composerType) : NOTYPE;
      var title = firstLine(S.ui.composerText, 200).trim();
      if (!title) { toast('Écrivez d’abord un titre sur la première ligne.'); return; }
      runDraft('composer', 'composer', {}, taskDraftPrompt(ty === NOTYPE ? '' : ty.label, title));
    },
    /* Atelier : une discussion pour régler le mot-clé d'un bloc. */
    'kw-chat': function (el) { openKeywordChat(el.getAttribute('data-id'), el.getAttribute('data-kw'), false); },
    'kw-new-chat': function () {
      var task = taskById(S.ui.termTaskId);
      openKeywordChat(task ? task.type : '', '', true);
    },
    'chat-send': replyChat,
    'chat-ask': askChat,
    'chat-retry': function () { sendChat(); },
    'chat-keep': keepChat,
    'chat-close': function () { S.ui.chat = null; render(); },

    'draft-keep': keepDraft,
    'draft-retry': retryDraft,
    'draft-reply': replyDraft,
    'draft-cancel': function () { S.ui.draft = null; render(); },
    'draft-provider': function (el) {
      var id = el.getAttribute('data-id') === 'copilot' ? 'copilot' : 'claude';
      if (id === S.settings.draftProvider) return;
      S.settings.draftProvider = id;
      /* Le modèle et l'effort ne valent que pour un agent : ceux de l'autre ne s'appliquent pas. */
      S.settings.draftModel = id === 'claude' ? 'haiku' : '';
      S.settings.draftEffort = '';
      S.ui.draftCustom = false;
      saveSettingsNow();
      render();
    },
    'refresh-models': function (el) { refreshModels(el.getAttribute('data-provider'), true); },
    'launch-convo': launchConvo,
    'resume-convo': function (el) { resumeConvo(el.getAttribute('data-id')); },
    'open-artifacts-convo': function (el) {
      var convo = convoById(el.getAttribute('data-id'));
      if (convo) openArtifacts(convo.taskId, convo.id);
    },
    'open-transcript': function (el) { openTranscript(el.getAttribute('data-id')); },
    'log-fold': function (el) {
      var k = el.getAttribute('data-k');
      if (S.ui.logOpen[k]) delete S.ui.logOpen[k]; else S.ui.logOpen[k] = true;
      render();
    },
    'remove-convo': function (el) { removeConvo(el.getAttribute('data-id')); },

    'open-remarks': toggleFeedback,
    'add-remark': addRemark,
    'remove-remark': function (el) { removeRemark(el.getAttribute('data-id')); },
    'clear-sent-remarks': clearSentRemarks,
    'toggle-sent': function () { S.ui.sentOpen = !S.ui.sentOpen; render(); },
    'send-remarks': sendRemarks,
    'send-remarks-here': function (el) { flushTypedRemark(); resumeConvo(el.getAttribute('data-id'), true); },
    'browse-repo-dir': function () {
      browseFolder(S.settings.repoDir || S.env.repoDir).then(function (p) { if (p) setSetting('repoDir', p); });
    },

    'close-settings': function () { S.ui.settingsOpen = false; render(); },
    'settings-tab': function (el) {
      S.ui.settingsTab = el.getAttribute('data-id');
      render();
      /* Les modèles ont pu se télécharger (première dictée) depuis la lecture du démarrage. */
      if (S.ui.settingsTab === 'voice') refreshWhisper();
      var x = EXTRA_SETTINGS[S.ui.settingsTab];
      if (x && x.onOpen) x.onOpen();
    },
    'go-page': function (el) { goPage(el.getAttribute('data-page')); },
    'refresh-usage': function () { refreshUsage(true); },
    'open-article': function (el) { toggleArticle(feedOf(el)); },
    'toggle-notifs': function () {
      S.ui.notifsOpen = !S.ui.notifsOpen;
      renderNotifs();
      renderNotifsBtn();
    },
    'open-notif': function (el) { openNotification(el.getAttribute('data-id')); },
    'notifs-read-all': function () {
      S.data.notifications.forEach(function (n) { n.read = true; });
      saveDataSoon();
      renderNotifs();
      renderNotifsBtn();
    },
    'notifs-clear': function () {
      S.data.notifications = [];
      saveDataSoon();
      renderNotifs();
      renderNotifsBtn();
    },
    'notifs-settings': function () { S.ui.notifsOpen = false; S.ui.settingsTab = 'display'; S.ui.settingsOpen = true; render(); },
    'toggle-win-notifs': function () { setSetting('windowsNotifications', S.settings.windowsNotifications === false); },
    'toggle-whisper': function () { setSetting('whisperEnabled', S.settings.whisperEnabled === false); },
    'toggle-whisper-auto': function () { setSetting('whisperAuto', S.settings.whisperAuto === false); },
    'whisper-model': function (el) { setSetting('whisperModel', el.getAttribute('data-id')); },
    'whisper-download': function (el) { downloadWhisper(el.getAttribute('data-id')); },
    'whisper-remove': function (el) { removeWhisper(el.getAttribute('data-id')); },
    'transcribe-attachment': function (el) { transcribeAttachment(el.getAttribute('data-owner'), el.getAttribute('data-att')); },
    'cancel-transcribe': function (el) { cancelTranscription(el.getAttribute('data-att')); },
    'article-another': function (el) { fetchArticle(feedOf(el), 'another'); },
    'article-retry': function (el) { var F = feedOf(el); articleState(F).failedAt = 0; fetchArticle(F, 'today'); },
    'article-show': function (el) { articleState(feedOf(el)).shown = el.getAttribute('data-url') || ''; renderPanel(); scrollPanelTop(); },
    'article-current': function (el) { articleState(feedOf(el)).shown = ''; renderPanel(); scrollPanelTop(); },
    'article-settings': function () { S.ui.settingsTab = 'article'; S.ui.settingsOpen = true; render(); },
    'toggle-article': function () {
      setSetting('articleEnabled', S.settings.articleEnabled === false);
      if (S.settings.articleEnabled) ensureArticle(feedById('daily'), false);
    },
    'toggle-article-ai': function () {
      setSetting('articleAiEnabled', S.settings.articleAiEnabled === false);
      if (S.settings.articleAiEnabled) ensureArticle(feedById('ai'), false);
    },
    'top-minus': function () { setSetting('topCount', Math.max(1, S.settings.topCount - 1)); },
    'top-plus': function () { setSetting('topCount', Math.min(8, S.settings.topCount + 1)); },
    'toggle-bands': function () { setSetting('showBands', !S.settings.showBands); },
    'toggle-compact': function () { setSetting('compact', !S.settings.compact); },
    'term-ps': function () { setSetting('terminal', 'powershell'); },
    'term-wt': function () { setSetting('terminal', 'wt'); },
    'term-click-panel': function () { setSetting('termClick', 'panel'); },
    'term-click-terminal': function () { setSetting('termClick', 'terminal'); },
    'default-claude': function () { setSetting('provider', 'claude'); },
    'default-copilot': function () { setSetting('provider', 'copilot'); },
    'browse-default-cwd': function () {
      browseFolder(S.settings.defaultCwd || S.env.defaultCwd).then(function (p) { if (p) setSetting('defaultCwd', p); });
    }
  };

  document.addEventListener('click', function (e) {
    if (S.ui.notifsOpen && e.target.closest && !e.target.closest('#notifs, #notifs-btn')) closeNotifs();
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var fn = ACTIONS[el.getAttribute('data-act')];
    if (fn) fn(el, e);
  });

  document.addEventListener('contextmenu', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act="toggle-filter"], [data-act="pick-type"]') : null;
    if (!el) return;
    e.preventDefault();
    removeCat(el.getAttribute('data-id'));
  });

  document.addEventListener('input', function (e) {
    var el = e.target;
    var role = el.getAttribute ? el.getAttribute('data-role') : null;
    if (!role) return;
    if (PAGE_INPUT[role]) { PAGE_INPUT[role](el, e); return; }
    if (role === 'edit-text') {
      var t = taskById(el.getAttribute('data-id'));
      if (!t) return;
      t.text = el.value;
      el.rows = Math.min(12, Math.max(2, el.value.split('\n').length + 1));
      saveDataSoon();
    } else if (role === 'composer-text') {
      S.ui.composerText = el.value;
    } else if (role === 'att-text' || role === 'att-title') {
      var owner = el.getAttribute('data-owner');
      var att = attachmentById(owner, el.getAttribute('data-att'));
      if (!att) return;
      if (role === 'att-title') {
        att.name = el.value;
      } else {
        att.text = el.value;
        el.rows = Math.min(10, Math.max(3, el.value.split('\n').length + 1));
        writeTextSoon(owner, att);
      }
      attachChanged(owner, false);
    } else if (role === 'cat-name') {
      S.ui.catName = el.value;
    } else if (role === 'cat-keyword-new') {
      S.ui.catKeywordDraft[el.getAttribute('data-id')] = el.value;
    } else if (role === 'kw-name' || role === 'kw-desc' || role === 'kw-prompt') {
      setKeywordField(el.getAttribute('data-id'), el.getAttribute('data-kw'), role.slice(3), el.value);
    } else if (role === 'agent-name' || role === 'agent-role' || role === 'agent-prompt') {
      setAgentField(el.getAttribute('data-id'), el.getAttribute('data-kw'), el.getAttribute('data-agent'),
        role.slice(6), el.value);
    } else if (role === 'new-kw-name') {
      S.ui.newKeywordName = el.value;
    } else if (role === 'new-kw-prompt') {
      S.ui.newKeywordPrompt = el.value;
    } else if (role === 'rv-chat-q') {
      /* Pas de rendu à chaque frappe : le texte est retenu par constat, seul « Envoyer » change d'état. */
      var bound = el.getAttribute('data-bound');
      if (bound) fcDrafts[bound] = el.value;
      fitChatInput(el);
      var send = $('#reader [data-act="rv-chat-send"]');
      if (send) send.disabled = !el.value.trim();
    } else if (role === 'draft-note') {
      /* Pas de rendu à chaque frappe : seul le bouton « Renvoyer » change d'état. */
      if (S.ui.draft) S.ui.draft.note = el.value;
      var send = document.querySelector('[data-act="draft-reply"]');
      if (send) send.disabled = !el.value.trim();
    } else if (role === 'chat-note') {
      if (S.ui.chat) S.ui.chat.note = el.value;
      var go = document.querySelector('[data-act="chat-send"]');
      if (go) go.disabled = !el.value.trim();
    } else if (role === 'cat-label') {
      var ty = typeOf(el.getAttribute('data-id'));
      if (ty === NOTYPE) return;
      ty.label = el.value;
      saveDataSoon();
    } else if (role === 'remark-new') {
      S.ui.remarkText = el.value;
      fitRemark(el);
    } else if (role === 'remark-text') {
      var r = remarkById(el.getAttribute('data-id'));
      if (!r) return;
      r.text = el.value;
      fitRemark(el);
      saveDataSoon();
    } else if (role === 'settings-repo') {
      S.settings.repoDir = el.value;
      saveSettingsSoon();
    } else if (role === 'settings-bitbucket') {
      S.settings.bitbucketUrl = el.value;
      saveSettingsSoon();
    } else if (role === 'new-cwd') {
      S.ui.newConvoCwd = el.value;
    } else if (role === 'new-prompt') {
      S.ui.newConvoPrompt = el.value;
    } else if (role === 'new-recap') {
      S.ui.newConvoRecap = el.value;
    } else if (role === 'batch-note') {
      S.ui.newConvoNote = el.value;
    } else if (role === 'new-model') {
      S.ui.newConvoModel = el.value;
    } else if (role === 'set-model') {
      S.settings[modelSettingKey(el.getAttribute('data-provider'))] = el.value;
      saveSettingsSoon();
    } else if (role === 'draft-model') {
      S.settings.draftModel = el.value;
      saveSettingsSoon();
    } else if (role === 'article-topics') {
      S.settings.articleTopics = el.value;
      saveSettingsSoon();
    } else if (role === 'article-model') {
      S.settings.articleModel = el.value;
      saveSettingsSoon();
    } else if (role === 'settings-cwd') {
      S.settings.defaultCwd = el.value;
      saveSettingsSoon();
    }
  });

  /* Listes déroulantes du formulaire de conversation et des réglages. */
  document.addEventListener('change', function (e) {
    var el = e.target;
    var role = el && el.getAttribute ? el.getAttribute('data-role') : null;
    if (!role) return;
    if (PAGE_CHANGE[role]) { PAGE_CHANGE[role](el, e); return; }
    var provider = el.getAttribute('data-provider') === 'copilot' ? 'copilot' : 'claude';
    var v = el.value;

    if (role === 'pr-check') {
      if (S.ui.prImport) { S.ui.prImport.checked[el.getAttribute('data-id')] = !!el.checked; render(); }
    } else if (role === 'pr-group-toggle') {
      if (S.ui.prImport) { S.ui.prImport.group = !!el.checked; render(); }
    } else if (role === 'batch-sub') {
      S.ui.newConvoSubs[el.getAttribute('data-id')] = !!el.checked;
      render();
    } else if (role === 'agent-model' || role === 'agent-effort') {
      setAgentField(el.getAttribute('data-id'), el.getAttribute('data-kw'), el.getAttribute('data-agent'),
        role.slice(6), v);
      render();
    } else if (role === 'new-model-select') {
      S.ui.newConvoCustom = v === CUSTOM;
      S.ui.newConvoModel = v === CUSTOM ? '' : v;
      render();
      if (v === CUSTOM) { var inp = document.querySelector('[data-focus-key="new-model"]'); if (inp) inp.focus(); }
    } else if (role === 'new-effort') {
      S.ui.newConvoEffort = v;
    } else if (role === 'set-model-select') {
      S.ui.settingsCustom[provider] = v === CUSTOM;
      setSetting(modelSettingKey(provider), v === CUSTOM ? '' : v);
      if (v === CUSTOM) { var box = document.querySelector('[data-focus-key="set-model-' + provider + '"]'); if (box) box.focus(); }
    } else if (role === 'set-effort') {
      setSetting(effortSettingKey(provider), v);
    } else if (role === 'draft-model-select') {
      S.ui.draftCustom = v === CUSTOM;
      setSetting('draftModel', v === CUSTOM ? '' : v);
      if (v === CUSTOM) { var free = document.querySelector('[data-focus-key="draft-model"]'); if (free) free.focus(); }
    } else if (role === 'draft-effort') {
      setSetting('draftEffort', v);
    } else if (role === 'article-model-select') {
      S.ui.articleCustom = v === CUSTOM;
      setSetting('articleModel', v === CUSTOM ? '' : v);
      if (v === CUSTOM) { var own = document.querySelector('[data-focus-key="article-model"]'); if (own) own.focus(); }
    } else if (role === 'article-effort') {
      setSetting('articleEffort', v);
    } else if (role === 'whisper-language') {
      setSetting('whisperLanguage', v);
    }
  });

  document.addEventListener('keydown', function (e) {
    var el = e.target;
    var role = el && el.getAttribute ? el.getAttribute('data-role') : null;

    if ((role === 'edit-text' || role === 'att-text' || role === 'att-title') && e.key === 'Escape' && el.closest('.task.is-editing')) {
      e.preventDefault(); S.ui.editingId = null; flushTextWrites(); render(); return;
    }
    if (role === 'composer-text' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addFromComposer(); return; }
    if (role === 'cat-name' && e.key === 'Enter') { e.preventDefault(); addCat(); return; }
    if (role === 'cat-keyword-new' && (e.key === 'Enter' || e.key === ',')) {
      e.preventDefault();
      addKeyword(el.getAttribute('data-id'));
      return;
    }
    if (role === 'cat-label' && e.key === 'Enter') { e.preventDefault(); el.blur(); render(); return; }
    if ((role === 'kw-name' || role === 'kw-desc') && e.key === 'Enter') { e.preventDefault(); el.blur(); render(); return; }
    if ((role === 'agent-name' || role === 'agent-role') && e.key === 'Enter') { e.preventDefault(); el.blur(); render(); return; }
    if (role === 'draft-note' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); replyDraft(); return; }
    if (role === 'chat-note' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); replyChat(); return; }
    /* Discussion sur un constat : Entrée envoie, Échap referme la discussion (pas la vue revue). */
    if (role === 'rv-chat-q' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendFindingQuestion(); return; }
    if (role === 'rv-chat-q' && e.key === 'Escape') { e.preventDefault(); closeFindingChat(); return; }
    if (role === 'new-kw-name' && e.key === 'Enter') { e.preventDefault(); addKeywordFromLaunch(); return; }
    if (role === 'new-kw-prompt' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addKeywordFromLaunch(); return; }
    if (role === 'remark-new' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addRemark(); return; }
    if ((role === 'new-cwd' || role === 'new-model') && e.key === 'Enter') {
      e.preventDefault();
      /* Un lot ouvre plusieurs terminaux d'un coup : il ne part que du bouton. */
      if (!batchTargetOn(taskById(S.ui.termTaskId))) launchConvo();
      return;
    }
    if (role === 'new-prompt' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); launchConvo(); return; }

    /* Échap referme d'abord l'éditeur de mot-clé, puis le dialogue. */
    if (e.key === 'Escape' && S.ui.catsOpen && S.ui.catKeywordEdit) { S.ui.catKeywordEdit = ''; render(); return; }
    if (e.key === 'Escape' && S.ui.catsOpen) { closeCats(); return; }
    if (e.key === 'Escape' && S.ui.settingsOpen) { S.ui.settingsOpen = false; render(); return; }
    if (e.key === 'Escape' && S.ui.notifsOpen) { closeNotifs(); return; }
    /* Revues groupées : Ctrl + Pg↓ / Pg↑ (et Ctrl + Tab, Ctrl + Maj + Tab) passent d'un ticket à
       l'autre. Pas Alt + ← → : en mode --wwwroot, la WebView en fait un retour arrière. */
    if (S.ui.reader && S.ui.reader.group && e.ctrlKey && !e.altKey && !e.metaKey
        && !S.ui.catsOpen && !S.ui.settingsOpen && !S.ui.chat) {
      var tabStep = e.key === 'PageDown' || (e.key === 'Tab' && !e.shiftKey) ? 1
        : (e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 0);
      if (tabStep) { e.preventDefault(); reviewGroupStep(tabStep); return; }
    }
    /* La vue revue : Échap remonte d'un cran, ↑ ↓ passent d'un constat à l'autre. */
    if (S.ui.reader && !e.altKey && !e.ctrlKey && !e.metaKey
        && !(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable))
        && reviewKey(e.key)) {
      e.preventDefault();
      return;
    }
    /* Le lecteur d'artefacts couvre la fenêtre : Échap le referme (depuis le cadre, il l'envoie par message). */
    if (e.key === 'Escape' && S.ui.reader) { closeReader(); return; }

    /* Une autre page que la file : ses raccourcis, une fois les dialogues servis. */
    if (currentPage() !== 'queue') {
      if (!overlayOpen()) {
        for (var k = 0; k < PAGE_KEYS.length; k++) { if (PAGE_KEYS[k](e, el, role)) return; }
      }
      return;
    }

    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (!S.ui.editingId) return;
      e.preventDefault();
      move(S.ui.editingId, e.key === 'ArrowUp' ? -1 : 1);
    }
  });

  /* ── Glisser-déposer ────────────────────────────────────────────────── */

  var listEl;

  function bindDrag() {
    listEl = $('#list');

    listEl.addEventListener('dragstart', function (e) {
      var card = e.target.closest ? e.target.closest('.task[data-card]') : null;
      if (!card) return;
      var id = card.getAttribute('data-card');
      if (S.ui.editingId === id) { e.preventDefault(); return; }
      S.ui.dragId = id;
      S.ui.overId = null;
      S.ui.overBefore = null;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', id); } catch (err) { /* IE-isme */ }
      }
      card.classList.add('is-dragging');
      listEl.classList.add('dragging');
    });

    listEl.addEventListener('dragover', function (e) {
      if (!S.ui.dragId) return;
      var gap = e.target.closest ? e.target.closest('.gap') : null;
      if (gap) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        var taskId = gap.getAttribute('data-gap-task');
        if (taskId) { setOver(taskId, true); return; }
        var vis = visibleTasks();
        var last = vis[vis.length - 1];
        if (last) setOver(last.id, false, true);
        return;
      }
      var card = e.target.closest ? e.target.closest('.task[data-card]') : null;
      if (!card) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      var box = card.getBoundingClientRect();
      setOver(card.getAttribute('data-card'), (e.clientY - box.top) < box.height / 2);
    });

    listEl.addEventListener('drop', function (e) {
      if (!S.ui.dragId) return;
      e.preventDefault();
      dropNow();
    });

    listEl.addEventListener('dragend', function () { endDrag(); });
  }

  /* ── Fichiers déposés ou collés ─────────────────────────────────────────
     Des fichiers glissés depuis l'Explorateur sur une carte (ou sur le dialogue Nouvelle tâche) sont
     joints à la tâche ; coller une capture ou des fichiers copiés pendant l'édition fait de même.
     Ailleurs, le dépôt est refusé — sans quoi WebView2 tenterait d'ouvrir le fichier. */
  var fileOverEl = null;

  function hasFiles(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (var i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
    return false;
  }

  /* À qui joindre, et l'élément à surligner pendant le survol. */
  function fileDropTarget(el) {
    if (!el || !el.closest) return null;
    var dialog = el.closest('.composer-dialog');
    if (dialog) return S.ui.composerId && !S.ui.prImport ? { owner: S.ui.composerId, el: dialog } : null;
    if (el.closest('.dialog-backdrop, #reader')) return null;
    var card = el.closest('.task[data-card]');
    return card ? { owner: card.getAttribute('data-card'), el: card } : null;
  }

  function markFileOver(el) {
    if (fileOverEl === el) return;
    if (fileOverEl) fileOverEl.classList.remove('file-over');
    fileOverEl = el;
    if (el) el.classList.add('file-over');
  }

  document.addEventListener('dragover', function (e) {
    if (S.ui.dragId || !hasFiles(e)) return;
    e.preventDefault();
    var target = fileDropTarget(e.target);
    e.dataTransfer.dropEffect = target ? 'copy' : 'none';
    markFileOver(target ? target.el : null);
  });

  document.addEventListener('dragleave', function (e) {
    /* Sortie de la fenêtre : plus rien sous le curseur. */
    if (!e.relatedTarget) markFileOver(null);
  });

  document.addEventListener('drop', function (e) {
    if (S.ui.dragId || !hasFiles(e)) return;
    e.preventDefault();
    var target = fileDropTarget(e.target);
    markFileOver(null);
    if (target) attachFiles(target.owner, e.dataTransfer.files);
  });

  document.addEventListener('paste', function (e) {
    var el = e.target;
    var owner = null;
    if (el && el.closest) {
      if (S.ui.composerId && !S.ui.prImport && el.closest('.composer-dialog')) owner = S.ui.composerId;
      else {
        var card = el.closest('.task.is-editing[data-card]');
        if (card) owner = card.getAttribute('data-card');
      }
    }
    var dt = e.clipboardData;
    if (!owner || !dt || !dt.files || !dt.files.length) return;
    var files = Array.prototype.slice.call(dt.files);
    /* Du texte copié depuis Word ou Excel arrive aussi en image : le texte l'emporte et se colle. */
    var text = dt.getData ? dt.getData('text/plain') : '';
    if (text && text.trim() && files.every(function (f) { return /^image\//.test(f.type); })) return;
    e.preventDefault();
    attachFiles(owner, files);
  });

  /* ══ Démarrage ════════════════════════════════════════════════════════ */

  function normalize(st) {
    var d = (st && st.data) || {};
    S.data.tasks = Array.isArray(d.tasks) ? d.tasks : [];
    S.data.types = Array.isArray(d.types) ? d.types : [];
    S.data.convos = Array.isArray(d.convos) ? d.convos : [];
    S.data.remarks = Array.isArray(d.remarks) ? d.remarks : [];
    S.data.notifications = normalizeNotifications(d.notifications);
    S.data.lastType = d.lastType || null;

    S.data.types.forEach(function (type) {
      type.keywords = normalizeKeywords(type.keywords);
    });
    S.data.tasks.forEach(function (t) {
      t.text = String(t.text == null ? '' : t.text);
      t.done = !!t.done;
      t.doing = !!t.doing;
      t.created = toMs(t.created) || Date.now();
      /* Tâches issues de « Mes PRs Bitbucket » : ticket et adresses des PRs (voir prGroupStatus). */
      if (t.jira != null) t.jira = String(t.jira);
      if (t.prs != null && !Array.isArray(t.prs)) delete t.prs;
      /* Sous-tâche : identifiant du parent ; un parent inconnu est oublié par regroupTasks. */
      if (t.parent != null && typeof t.parent !== 'string') t.parent = String(t.parent);
      if (!t.parent) delete t.parent;
      /* Sous-tâches repliées sous ce parent (voir subsFolded). */
      if (t.collapsed !== true) delete t.collapsed;
      /* Revue générale (import groupé des PRs) et dernier lot lancé sur les sous-tâches (voir launchBatch). */
      if (t.reviewGroup !== true) delete t.reviewGroup;
      if (t.batch != null) {
        if (typeof t.batch !== 'object' || !t.batch.id) delete t.batch;
        else t.batch = { id: String(t.batch.id), at: toMs(t.batch.at), n: Number(t.batch.n) || 0, endedAt: toMs(t.batch.endedAt) };
      }
      /* Pièces jointes : copies sous <données>\attachments\<tâche>\ (voir attachmentsPrompt). */
      if (t.attachments != null) {
        t.attachments = normalizeAttachments(t.attachments);
        if (!t.attachments.length) delete t.attachments;
      }
    });
    regroupTasks();
    S.data.convos.forEach(function (c) {
      c.provider = providerOf(c);
      c.model = String(c.model == null ? '' : c.model).trim();
      c.effort = String(c.effort == null ? '' : c.effort).trim();
      c.title = String(c.title == null ? '' : c.title);
      c.cwd = String(c.cwd == null ? '' : c.cwd);
      // `keyword` (un seul mot) est devenu `keywords` (plusieurs) : les données d'avant se relisent.
      c.keywords = keywordIdsFor(taskById(c.taskId), c.keywords || c.keyword);
      delete c.keyword;
      c.artifacts = normalizeArtifacts(c.artifacts);
      var used = normalizeUsage(c.usage);
      if (used) c.usage = used; else delete c.usage;
      c.messageCount = typeof c.messageCount === 'number' ? c.messageCount : 0;
      c.created = toMs(c.created);
      c.updated = toMs(c.updated) || c.created;
      /* Carnet de remarques : ce que la session a reçu. Les conversations d'avant ce relevé le
         retrouvent dans les remarques envoyées, par leur `sessionId`. */
      if (c.taskId === FEEDBACK_ID) {
        var given = Array.isArray(c.remarks) ? c.remarks : S.data.remarks.filter(function (r) {
          return r && toMs(r.sentAt) && r.sessionId === c.id;
        });
        c.remarks = given.filter(function (r) { return r && String(r.text || '').trim(); }).map(function (r) {
          return { id: String(r.id || ''), text: String(r.text), sentAt: toMs(r.sentAt) };
        });
        if (!c.remarks.length) delete c.remarks;
      } else {
        delete c.remarks;
      }
      /* Lot dont la conversation fait partie : seule source de vérité de l'appartenance. */
      if (c.batch != null) c.batch = String(c.batch);
      if (!c.batch) delete c.batch;
    });
    S.data.remarks.forEach(function (r) {
      if (!r.id) r.id = uid('r');
      r.text = String(r.text == null ? '' : r.text);
      r.created = toMs(r.created) || Date.now();
      r.sentAt = toMs(r.sentAt) || 0;
      r.sessionId = String(r.sessionId == null ? '' : r.sessionId);
    });

    var s = (st && st.settings) || {};
    S.settings = Object.assign({}, DEFAULTS, s);
    S.settings.topCount = Math.min(8, Math.max(1, parseInt(S.settings.topCount, 10) || DEFAULTS.topCount));
    S.settings.showBands = S.settings.showBands !== false;
    S.settings.compact = S.settings.compact === true;
    S.settings.defaultCwd = String(S.settings.defaultCwd || '');
    S.settings.repoDir = String(S.settings.repoDir || '');
    S.settings.bitbucketUrl = String(S.settings.bitbucketUrl || '');
    S.settings.terminal = S.settings.terminal === 'wt' ? 'wt' : 'powershell';
    S.settings.termClick = S.settings.termClick === 'terminal' ? 'terminal' : 'panel';
    S.settings.provider = S.settings.provider === 'copilot' ? 'copilot' : 'claude';
    S.settings.claudeModel = String(S.settings.claudeModel || '').trim();
    S.settings.copilotModel = String(S.settings.copilotModel || '').trim();
    S.settings.claudeEffort = String(S.settings.claudeEffort || '').trim();
    S.settings.copilotEffort = String(S.settings.copilotEffort || '').trim();
    S.settings.draftProvider = S.settings.draftProvider === 'copilot' ? 'copilot' : 'claude';
    S.settings.draftModel = String(S.settings.draftModel || '').trim();
    S.settings.draftEffort = String(S.settings.draftEffort || '').trim();
    S.settings.articleEnabled = S.settings.articleEnabled !== false;
    S.settings.articleTopics = String(S.settings.articleTopics || '');
    S.settings.articleAiEnabled = S.settings.articleAiEnabled !== false;
    S.settings.articleModel = String(S.settings.articleModel == null ? DEFAULTS.articleModel : S.settings.articleModel).trim();
    S.settings.articleEffort = String(S.settings.articleEffort == null ? DEFAULTS.articleEffort : S.settings.articleEffort).trim();
    S.settings.windowsNotifications = S.settings.windowsNotifications !== false;
    S.settings.whisperEnabled = S.settings.whisperEnabled !== false;
    S.settings.whisperAuto = S.settings.whisperAuto !== false;
    S.settings.whisperModel = String(S.settings.whisperModel || DEFAULTS.whisperModel);
    S.settings.whisperLanguage = WHISPER_LANGS.some(function (l) { return l.id === S.settings.whisperLanguage; })
      ? S.settings.whisperLanguage : DEFAULTS.whisperLanguage;

    Object.assign(S.env, (st && st.env) || {});

    var known = S.data.types.map(function (t) { return t.id; });
    if (S.data.lastType && known.indexOf(S.data.lastType) >= 0) S.ui.composerType = S.data.lastType;
    else S.ui.composerType = known.length ? known[known.length - 1] : null;
  }

  function boot() {
    bindDrag();

    var search = $('#search');
    search.addEventListener('input', function () {
      S.ui.search = search.value;
      renderList();
    });
    $('#settings-btn').addEventListener('click', function () {
      S.ui.settingsOpen = true;
      render();
      if (settingsTab() === 'voice') refreshWhisper();
      var x = EXTRA_SETTINGS[settingsTab()];
      if (x && x.onOpen) x.onOpen();
    });
    /* La largeur du panneau change le repliement des lignes : les zones de remarques se remesurent. */
    window.addEventListener('resize', function () { fitRemarks($('#panel')); placeNotifs(); });
    window.addEventListener('scroll', placeNotifs, { passive: true });

    bridge.on('sessionsChanged', function () {
      refreshSessions();
      restartSessionsPoll();
      if (S.ui.termConvId) loadTranscript(true);
      if (S.ui.reader) loadReader(true);
    });
    /* Clic sur une notification Windows : l'hôte a ramené la fenêtre, la page ouvre la tâche. */
    bridge.on('notificationClicked', function (p) {
      var m = /(?:^|&)n=([^&]+)/.exec(String((p && p.args) || ''));
      if (m) openNotification(decodeURIComponent(m[1]));
    });
    bridge.on('focus', function () {
      refreshSessions();
      restartSessionsPoll();
      refreshUsage(false);
      ensureArticles();
      if (S.ui.termConvId) loadTranscript(true);
      if (S.ui.reader) loadReader(true);
      PAGES.forEach(function (p) { if (p.onFocus) { try { p.onFocus(); } catch (e) { /* page fautive */ } } });
    });

    /* Discussion sur un constat : la réponse de l'agent arrive au fil de l'eau. */
    bridge.on('findingChat', onFindingChat);

    /* Dictée et transcription : le micro des zones de saisie, l'avancement de Whisper. */
    bindDictate();
    bridge.on('whisper', onWhisperEvent);

    /* Messages du cadre isolé du lecteur : prêt à recevoir le HTML, lien cliqué, Échap. */
    window.addEventListener('message', function (e) {
      if (chatFrame && e.source && e.source === chatFrame.contentWindow) { onChatFrameMessage(e.data || {}); return; }
      if (!readerFrame || !e.source || e.source !== readerFrame.contentWindow) return;
      var m = e.data || {};
      if (m.type === 'ready') {
        readerReady = true;
        pushReaderHtml(false);
        /* La vue revue garde la main dans la page : ↑ ↓ y passent d'un constat à l'autre. */
        if (!reviewShown(S.ui.reader)) {
          try { readerFrame.focus(); } catch (err) { /* cadre déjà remplacé */ }
        }
      } else if (m.type === 'close') {
        if (!reviewKey('Escape')) closeReader();
      } else if (m.type === 'key') {
        var key = String(m.key || '');
        if (key === 'TabNext' || key === 'TabPrev') reviewGroupStep(key === 'TabNext' ? 1 : -1);
        else reviewKey(key);
      } else if (m.type === 'scroll') {
        /* Rapport complet d'un onglet des revues groupées : son défilement est repris au retour. */
        var cur = S.ui.reader;
        if (cur && cur.group && !reviewShown(cur)) cur.docY = +m.y || 0;
      } else if (m.type === 'link') {
        followReaderLink(m.href);
      }
    });

    /* Les quotas bougent lentement : relecture toutes les 5 min au plus, fenêtre visible. */
    setInterval(function () { if (document.visibilityState !== 'hidden') refreshUsage(false); }, 60000);
    /* Fenêtre restée ouverte d'un jour sur l'autre : les articles du lendemain viennent tout seuls. */
    setInterval(ensureArticles, ARTICLE_CHECK_MS);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { window.organizatorFlush(); return; }
      /* De retour à l'écran : l'état affiché peut dater de la dernière lecture au ralenti. */
      refreshSessions();
      restartSessionsPoll();
      if (S.ui.termConvId) loadTranscript(true);
    });
    window.addEventListener('pagehide', function () { window.organizatorFlush(); });

    startPerfMonitor();

    bridge.call('getState').then(function (st) {
      normalize(st || {});
      booted = true;
      PAGES.forEach(function (p) { if (p.onBoot) { try { p.onBoot(); } catch (e) { /* page fautive : la file démarre quand même */ } } });
      render();
      var shown = pageDef(currentPage());
      if (shown && shown.onShow) { try { shown.onShow(); } catch (e) { /* idem */ } }
      appReady();
      refreshSessions();
      restartSessionsPoll();
      refreshUsage(true);
      peekArticles();
      if (S.env.hasClaude === false) toast(NO_CLAUDE);
      /* Catalogues absents ou vieux d'un jour : détection silencieuse en arrière-plan. */
      if (S.env.hasCopilot && catalogStale('copilot')) refreshModels('copilot', false);
      if (S.env.hasClaude !== false && catalogStale('claude')) refreshModels('claude', false);
    })['catch'](function (e) {
      normalize({});
      booted = true;
      render();
      appReady();
      toast('Données illisibles : ' + e.message);
    });
  }

  /* ── Point d'accroche des modules chargés après app.js (voice.js) ─────────
     Ils lisent et changent les réglages, montrent un toast, branchent leurs boutons sur la
     délégation `data-act` : rien d'autre ne sort de l'application. `onReady` attend getState. */
  var readyFns = [], isReady = false;

  function appReady() {
    isReady = true;
    readyFns.splice(0).forEach(function (fn) {
      try { fn(); } catch (e) { console.error('[organizator] module', e); }
    });
  }

  window.organizatorApp = {
    onReady: function (fn) { if (isReady) fn(); else readyFns.push(fn); },
    settings: function () { return S.settings; },
    env: function () { return S.env; },
    /* Change des réglages et les sauvegarde (300 ms de debounce, comme la frappe). */
    setSettings: function (patch) { Object.assign(S.settings, patch || {}); saveSettingsSoon(); },
    toast: toast,
    addActions: function (map) { Object.keys(map || {}).forEach(function (k) { ACTIONS[k] = map[k]; }); },
    /* Choix du modèle et de l'effort Claude, tels que les Réglages les présentent. */
    modelSelectHtml: function (value, custom, role, key) { return modelSelectHtml('claude', value, custom, role, key, false); },
    effortSelectHtml: function (value, role, key) { return effortSelectHtml('claude', value, role, key, false); },
    customModel: CUSTOM,
    micError: micError
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* Exposé pour le débogage et les tests manuels. */
  window.__organizator = {
    state: S, render: render, toast: toast, refreshSessions: refreshSessions, refreshUsage: refreshUsage,
    openReader: openReader, closeReader: closeReader, openReview: openReview
  };
  Object.assign(window.__organizator, { checkBatches: checkBatches, launchBatch: launchBatch });
  Object.assign(window.__organizator, { openReviewGroup: openReviewGroup, reviewGroupStep: reviewGroupStep });
  Object.assign(window.__organizator, { openNotification: openNotification, recordNotification: recordNotification });
  Object.assign(window.__organizator, { findingChats: fcStore, openFindingChat: openFindingChat, sendFindingQuestion: sendFindingQuestion });
  Object.assign(window.__organizator, {
    startDictation: startDictation, stopDictation: stopDictation, cancelDictation: cancelDictation,
    insertDictation: insertDictation, dictation: function () { return dict; }, transcribeAttachment: transcribeAttachment,
    buildPrompt: buildPrompt
  });
  Object.assign(window.__organizator, {
    mdBlocksHtml: mdBlocksHtml, reportsOf: reportsOf, usageOf: usageOf, usageText: usageText, normalizeUsage: normalizeUsage
  });

  /* Contrat des pages (voir « Pages » plus haut) : ce qu'une page peut utiliser de l'application.
     registerPage({ id, label, title, icon, badge(), render(host, enter), onBoot, onShow, onHide, onFocus })
     rend cet objet. Tout le reste d'app.js reste privé. */
  var pageApi = {
    state: S, render: render, toast: toast, goPage: goPage, currentPage: currentPage,
    addAction: addPageAction, addInput: addPageInput, addChange: addPageChange, addKey: addPageKey,
    addSettingsTab: addSettingsTab, openSettingsTab: openSettingsTab, overlayOpen: overlayOpen,
    esc: esc, uid: uid, color: color, setHtml: setHtml, isTyping: isTyping, icon: ICON,
    fmtDate: fmtDate, fmtTime: fmtTime, fmtDay: fmtDay, fmtSize: fmtSize, fmtClock: fmtClock,
    setRowHtml: setRowHtml, setFieldHtml: setFieldHtml, switchHtml: switchHtml,
    modelSelectHtml: modelSelectHtml, effortSelectHtml: effortSelectHtml, catalogFor: catalogFor, catalogHas: catalogHas,
    customModel: CUSTOM, hasProvider: hasProvider,
    recordVoice: recordVoice, recording: function () { return !!(voiceRec || dict); }, wav16k: wav16k, readBase64: readBase64,
    whisperOn: whisperOn, whisperPhaseLabel: whisperPhaseLabel
  };
  window.__organizator.registerPage = registerPage;
  window.__organizator.pageApi = pageApi;
})();
