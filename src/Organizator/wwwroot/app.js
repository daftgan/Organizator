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
    provider: 'claude', claudeModel: '', copilotModel: '', claudeEffort: '', copilotEffort: '',
    repoDir: '',
    /* Serveur Bitbucket de « Mes PRs Bitbucket » ; vide = celui que l'hôte détecte. */
    bitbucketUrl: '',
    /* Rédaction assistée : un modèle rapide suffit pour quelques phrases. */
    draftProvider: 'claude', draftModel: 'haiku', draftEffort: ''
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
    eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
    pullRequest: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2.4"></circle><circle cx="6" cy="19" r="2.4"></circle><circle cx="18" cy="19" r="2.4"></circle><path d="M6 7.5v9M18 16.5V11a3 3 0 0 0-3-3h-4.5M13 5.5L10.5 8 13 10.5"></path></svg>',
    /* Sous-tâches : le crochet « ↳ » de l'avancement, et le même avec un plus pour en ajouter une. */
    subtask: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4v9a3 3 0 0 0 3 3h11"></path><path d="M15 12l4 4-4 4"></path></svg>',
    subtaskAdd: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4v8a3 3 0 0 0 3 3h5"></path><path d="M17 11v9M12.5 15.5h9"></path></svg>'
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
    data: { tasks: [], types: [], convos: [], remarks: [], lastType: null },
    settings: Object.assign({}, DEFAULTS),
    env: { version: '?', hasClaude: true, hasCopilot: false, hasWt: false, defaultCwd: '', dataDir: '', userProfile: '', repoDir: '',
      bitbucketUrl: '', bitbucketSource: '', bitbucketToken: false, jiraUrl: '', models: null, efforts: null },
    ui: {
      search: '',
      hidden: [], filtersOpen: false,
      editingId: null,
      dragId: null, overId: null, overBefore: null,
      composerOpen: false, composerText: '', composerType: null, insertAt: 'top',
      /* Sous-tâche en cours de création : identifiant de la tâche parente, null pour une tâche de premier niveau. */
      composerParent: null,
      catFormOpen: false, catName: '', catPalette: 'terracotta',
      catsOpen: false, catKeywordDraft: {}, catKeywordEdit: '',
      settingsOpen: false, settingsTab: 'display',
      termTaskId: null, termConvId: null, artifactView: false, artifactConvId: null, artifactFilesOpen: false,
      /* Lecteur d'artefacts ouvert : { path, cwd, view, busy, error, back } — voir « Lecteur d'artefacts » */
      reader: null,
      newConvoOpen: false, newConvoCwd: '', newConvoPrompt: '', newConvoProvider: 'claude', newConvoModel: '', newConvoEffort: '', newConvoKeywords: [], newConvoCustom: false,
      /* Travail déjà fait, proposé au lancement : le texte (modifiable), sa lecture en cours, et ce qu'il couvre { convos, reports }. */
      newConvoRecap: '', newConvoRecapBusy: false, newConvoRecapMeta: null,
      newKeywordOpen: false, newKeywordName: '', newKeywordPrompt: '', newKeywordTeam: false, newKeywordAgents: [],
      modelsBusy: { claude: false, copilot: false }, settingsCustom: { claude: false, copilot: false }, draftCustom: false,
      /* Rédaction en cours ou proposée : { key, kind, target, prompt, busy, text, desc, team, error, ms } */
      draft: null,
      /* Atelier ouvert : { typeId, keywordId, launch, card, turns, note, busy, error, ms } */
      chat: null,
      /* Aperçu des PRs Bitbucket dans Nouvelle tâche : { busy, error, host, account, jiraUrl, groups, checked } */
      prImport: null,
      transcript: null,
      sessionExists: {},
      activity: {},
      usage: { reports: null, busy: false, fetchedAt: 0, error: '' },
      remarkText: '', sentOpen: false, launchBusy: false,
      toast: ''
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
      tasks: S.data.tasks, types: S.data.types, convos: S.data.convos, remarks: S.data.remarks, lastType: S.data.lastType
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
      defaultCwd: S.settings.defaultCwd, terminal: S.settings.terminal,
      provider: S.settings.provider, claudeModel: S.settings.claudeModel, copilotModel: S.settings.copilotModel,
      claudeEffort: S.settings.claudeEffort, copilotEffort: S.settings.copilotEffort,
      repoDir: S.settings.repoDir, bitbucketUrl: S.settings.bitbucketUrl,
      draftProvider: S.settings.draftProvider, draftModel: S.settings.draftModel, draftEffort: S.settings.draftEffort
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
        if (String(t.text || '').toLowerCase().indexOf(q) >= 0) groupHit[(parentOf(t) || t).id] = true;
      });
    }
    return S.data.tasks
      .filter(function (t) {
        if (S.ui.hidden.indexOf(t.type) >= 0) return false;
        var root = parentOf(t) || t;
        /* Une sous-tâche ne s'affiche jamais sans son parent : filtré, il l'emporte avec lui. */
        if (root !== t && S.ui.hidden.indexOf(root.type) >= 0) return false;
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
    if (withTask) lines.push('Tâche :', String(t.text || ''));
    lines.push('Réponds en français.');
    return lines.join('\n');
  }

  /* Premier message proposé au lancement : la tâche elle-même, pour que l'agent s'y mette dès
     l'ouverture plutôt que d'attendre une saisie. Le formulaire le donne à relire, et le vider
     rend l'ancien comportement : l'agent ouvre son invite, la tâche repart alors dans le contexte.
     Le carnet de remarques a son propre premier message (feedbackPrompt). */
  function buildPrompt(t) {
    if (!t || t.id === FEEDBACK_ID) return '';
    return String(t.text || '').trim();
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
    var tip = 'Ouvrir le terminal de l’agent';
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

  /* `kind` : 'report' pour les livrables seuls, 'file' pour le reste, absent pour tout. */
  function artifactEntries(convs, kind) {
    var entries = [];
    convs.forEach(function (c) {
      artifactsOf(c).forEach(function (artifact) {
        if (!artifact || !artifact.path) return;
        var report = isReport(artifact.path);
        if ((kind === 'report' && !report) || (kind === 'file' && report)) return;
        entries.push({
          path: String(artifact.path),
          action: String(artifact.action || 'modified'),
          tool: String(artifact.tool || 'outil'),
          agent: String(artifact.agent || ''),
          report: report,
          cwd: String(c.cwd || ''),
          convoId: c.id,
          convoTitle: c.title || 'Nouvelle session'
        });
      });
    });
    return entries;
  }

  function artifactRowHtml(artifact) {
    var openable = artifact.action !== 'deleted';
    var tag = openable ? 'button' : 'div';
    var folder = folderOf(artifact.path);
    /* « écrit par <agent> » : le fichier vient d'un sous-agent de la session, pas de l'agent principal. */
    var meta = (ARTIFACT_ACTIONS[artifact.action] || artifact.action) + (artifact.agent ? ' par ' + artifact.agent : '')
      + (folder ? ' · ' + folder : '');
    var attributes = openable
      ? ' type="button" class="artifact-row artifact-openable" data-act="open-artifact" data-path="' + esc(artifact.path)
        + '" data-cwd="' + esc(artifact.cwd) + '" title="Lire ici"'
      : ' class="artifact-row artifact-deleted" title="Ce fichier a été supprimé"';
    return '<' + tag + attributes + '>'
      + '<span class="artifact-row-icon">' + ICON.artifacts + '</span>'
      + '<div class="artifact-main"><div class="artifact-title" title="' + esc(artifact.path) + '">' + esc(lastSegment(artifact.path)) + '</div>'
      + '<div class="artifact-meta">' + esc(meta) + '</div></div>'
      + (openable ? '<span class="artifact-open-hint">Lire</span>' : '')
      + '</' + tag + '>';
  }

  /* La carte ne porte l'icône que si un rapport est sorti de la tâche : les fichiers de code
     touchés en chemin se consultent depuis le panneau, ils n'ont pas à encombrer la file. */
  function artifactBtnHtml(t, convs) {
    var count = artifactEntries(convs, 'report').length;
    if (!count) return '';
    return '<button type="button" class="icon-btn artifact-btn has" data-act="open-artifacts" data-id="' + esc(t.id)
      + '" title="' + esc(count + (count > 1 ? ' rapports produits' : ' rapport produit')) + '">'
      + ICON.artifacts + '<span class="artifact-count">' + esc(count) + '</span></button>';
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

  function render() {
    var t0 = perfNow();
    preserveFocus(function () {
      $('#app').classList.toggle('compact', !!S.settings.compact);
      $('#shell').classList.toggle('with-panel', !!S.ui.termTaskId);
      renderFilters();
      renderList();
      renderPanel();
      renderReader();
      renderDialogs();
      renderUsage();
      renderRemarksBtn();
    });
    perfRender(t0);
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
    preserveFocus(function () {
      renderList();
      renderPanel();
      renderRemarksBtn();
    });
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
    var asking = hasQuestion(convs);
    var sub = isSub(t);
    var progress = sub ? null : subtaskProgress(t);
    var h = [];

    h.push('<div class="item' + (sub ? ' is-sub' : '') + '" data-item="' + esc(t.id) + '">');

    if (showBand) {
      h.push('<div class="band"><span class="band-label">' + esc(band) + '</span>'
        + '<span class="band-rule"></span><span class="band-hint">' + esc(bandHint(band)) + '</span></div>');
    }

    h.push(gapHtml(rank.gapValue, t.id, false, sub ? t.parent : ''));
    h.push('<div class="drop drop-before"><div class="drop-line"></div><div class="drop-knob"></div></div>');

    h.push('<div class="task' + (doing ? ' is-doing' : '') + (t.done ? ' is-done' : '')
      + (asking ? ' is-asking' : '') + (editing ? ' is-editing' : '') + (sub ? ' is-sub' : '')
      + '" data-card="' + esc(t.id) + '" draggable="' + (editing ? 'false' : 'true') + '">');
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
    /* Le parent dit où en sont ses sous-tâches : terminées / total. */
    if (progress && progress.total) {
      h.push('<span class="sub-chip' + (progress.done === progress.total ? ' all' : '') + '" title="'
        + esc(progress.done + ' sur ' + progress.total + (progress.total > 1 ? ' sous-tâches terminées' : ' sous-tâche terminée')) + '">'
        + ICON.subtask + '<span>' + esc(progress.done + '/' + progress.total) + '</span></span>');
    }
    h.push('</div>');

    if (editing) {
      var rows = Math.min(12, Math.max(2, String(t.text || '').split('\n').length + 1));
      h.push('<textarea class="input edit-area" rows="' + rows + '" data-role="edit-text" data-focus-key="edit-text" data-id="'
        + esc(t.id) + '">' + esc(t.text) + '</textarea>');
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
        + taskTextHtml(t.text) + '</div>');
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

  /* Formulaire de lancement : agent, modèle, effort, dossier ; `launchLabel` nomme le bouton. */
  /* Le formulaire est reconstruit à chaque clic (mot-clé coché, modèle changé) : son apparition
     ne se joue qu'au premier rendu, sans quoi le fondu repartirait à chaque fois — ça clignotait. */
  var newFormEntered = false;

  function newFormHtml(launchLabel) {
    var task = taskById(S.ui.termTaskId);
    var enter = newFormEntered ? '' : ' enter';
    newFormEntered = true;
    return '<div class="new-form' + enter + '">' + newFormAgentHtml()
      + newFormKeywordHtml(task)
      + newFormPromptHtml(task)
      + newFormRecapHtml(task)
      + '<div class="new-form-label">Dossier de travail</div>'
      + '<div class="new-form-field">'
      + '<input class="dark-input" type="text" data-role="new-cwd" data-focus-key="new-cwd" spellcheck="false" placeholder="C:\\…" value="'
      + esc(S.ui.newConvoCwd) + '">'
      + '<button type="button" class="dark-btn" data-act="browse-cwd">Parcourir…</button>'
      + '</div>'
      + '<div class="new-form-actions">'
      + '<button type="button" class="dark-btn" data-act="cancel-new-convo">Annuler</button>'
      + '<button type="button" class="dark-btn dark-btn-primary" data-act="launch-convo"' + (S.ui.launchBusy ? ' disabled' : '') + '>'
      + esc(S.ui.launchBusy ? 'Lancement…' : launchLabel) + '</button>'
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

  /* Liste des sessions. Dans le carnet de remarques, chaque session propose d'y envoyer
     les remarques en attente (reprise avec un nouveau message). */
  function convoListHtml(convs, feedback) {
    var pending = feedback ? pendingRemarks().length : 0;
    return '<div class="convo-list">' + convs.map(function (c) {
      var artifactCount = artifactsOf(c).length;
      var reportCount = artifactEntries([c], 'report').length;
      return '<div class="convo">'
        + '<button type="button" class="convo-open" data-act="resume-convo" data-id="' + esc(c.id)
        + '" title="Reprendre cette session dans PowerShell">'
        + '<div class="convo-title">' + esc(c.title || 'Nouvelle session')
        + (reportCount ? '<span class="convo-artifacts" title="' + esc(reportCount + (reportCount > 1 ? ' rapports produits' : ' rapport produit')) + '">'
          + ICON.artifacts + ' ' + esc(reportCount) + '</span>' : '')
        + '</div>'
        + convoKeywordsHtml(c)
        + stateHtml(c)
        + saidHtml(c)
        + '<div class="convo-meta">' + esc(convoMeta(c)) + '</div>'
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
    var reports = artifactEntries(convs, 'report');
    var files = artifactEntries(convs, 'file');
    var h = ['<div class="panel-body">'];
    h.push('<div class="panel-kicker">' + (selected ? 'Rapports de la session' : 'Rapports produits') + ' · ' + reports.length + '</div>');
    if (reports.length) {
      h.push('<div class="artifact-list">' + reports.map(artifactRowHtml).join('') + '</div>');
    } else {
      h.push('<div class="panel-note">' + (files.length
        ? 'Aucun document produit : l’agent n’a touché que des fichiers de code.'
        : 'Aucun fichier produit n’a encore été détecté dans les sessions de cette tâche.') + '</div>');
    }

    if (files.length) {
      h.push('<button type="button" class="artifact-toggle' + (S.ui.artifactFilesOpen ? ' open' : '')
        + '" data-act="toggle-artifact-files"><span class="artifact-caret">›</span>'
        + esc(files.length + (files.length > 1 ? ' fichiers modifiés' : ' fichier modifié')) + '</button>');
      if (S.ui.artifactFilesOpen) {
        h.push('<div class="artifact-list artifact-files">' + files.map(artifactRowHtml).join('') + '</div>');
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

    h.push('<div class="panel-kicker">Conversations</div>');
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

  /* Le corps d'un message est rendu ligne par ligne : l'hôte fusionne les
     entrées assistant consécutives, si bien qu'un message mêle du texte et
     des lignes « [outil : X] », rendues atténuées. Les sauts de ligne sont
     conservés tels quels (.msg-body est en white-space: pre-wrap). */
  var TOOL_LINE = /^\s*\[outil\s*:/;

  function msgBodyHtml(txt) {
    return String(txt == null ? '' : txt).split('\n').map(function (line) {
      return TOOL_LINE.test(line) ? '<span class="tool-line">' + esc(line) + '</span>' : esc(line);
    }).join('\n');
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
      body = tr.messages.map(function (m) {
        var user = m.role === 'user';
        return '<div class="msg ' + (user ? 'user' : 'assistant') + '">'
          + '<div class="msg-role">' + (user ? 'vous ›' : 'agent ›') + '</div>'
          + '<div class="msg-body">' + msgBodyHtml(m.text) + '</div></div>';
      }).join('') + logStateHtml(c);
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
    var task = taskById(S.ui.termTaskId);
    if (!task) { host.innerHTML = ''; panelKey = null; S.ui.termTaskId = null; return; }

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
      + '<span class="panel-title">' + esc(task.id === FEEDBACK_ID ? 'remarques — Organizator' : 'agent — ' + firstLine(task.text, 40)) + '</span>'
      + '<span class="panel-spacer"></span>'
      + (conv ? '<button type="button" class="panel-link" data-act="back-to-list">‹ historique</button>' : '')
      + '<button type="button" class="panel-x" data-act="close-term" title="Fermer">✕</button>'
      + '</div>');
    h.push(conv
      ? panelTranscriptHtml(conv)
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
    h.push('<div class="dialog' + (enter ? ' enter' : '') + '" data-act="noop" role="dialog" aria-label="'
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
    }
    h.push('</div>');

    var n = prImportCounts();
    var label = !n.create && !n.update ? 'Créer les tâches'
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
    var im = S.ui.prImport = { busy: true, error: '', host: '', account: '', jiraUrl: S.env.jiraUrl || '', groups: [], checked: {} };
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
    var created = 0, updated = 0;
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
      S.data.tasks.splice(idx + created, 0, {
        id: uid('n'), type: S.ui.composerType, text: prTaskText(g, im.jiraUrl), done: false, doing: false, created: Date.now(),
        jira: g.key, prs: urls
      });
      created++;
    });
    S.ui.prImport = null;
    S.ui.composerOpen = false;
    S.ui.composerText = '';
    S.ui.catFormOpen = false;
    commit();
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
    else if (tab === 'folders') h.push(folderSettingsHtml(s));
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
      + setRowHtml('Mode compact', 'Cartes plus resserrées.', switchHtml(s.compact, 'toggle-compact', 'Mode compact'));
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

  /* Script d'amorçage du cadre : reçoit le HTML (message `html`), remonte les clics sur les
     liens (`link`) et Échap (`close`), et signale qu'il est prêt (`ready`). */
  var READER_SCRIPT = [
    '(function () {',
    'var doc = document.getElementById("doc");',
    'function post(m) { parent.postMessage(m, "*"); }',
    'addEventListener("message", function (e) {',
    '  var m = e.data || {}; if (m.type !== "html") return;',
    '  var root = document.documentElement;',
    '  var atBottom = innerHeight + scrollY >= root.scrollHeight - 40; var y = scrollY;',
    '  doc.innerHTML = String(m.html || "");',
    '  if (m.follow && atBottom) scrollTo(0, root.scrollHeight); else scrollTo(0, m.follow ? y : 0);',
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
    'document.addEventListener("keydown", function (e) { if (e.key === "Escape") post({ type: "close" }); });',
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
    var h = ['<div class="reader-backdrop"><div class="reader enter" role="dialog" aria-label="Lecture d’un rapport">'];
    h.push('<div class="reader-bar">'
      + (r.back ? '<button type="button" class="dark-btn reader-btn reader-back" data-act="reader-back" title="Revenir au rapport précédent">‹</button>' : '')
      + '<span class="reader-icon">' + ICON.artifacts + '</span>'
      + '<div class="reader-head"><div class="reader-name" title="' + esc(v ? v.full : r.path) + '">' + esc(name) + '</div>'
      + '<div class="reader-meta">' + esc(v ? readerMeta(v) : (kind === 'error' ? 'Lecture impossible' : 'Lecture…')) + '</div></div>'
      + '<span class="panel-spacer"></span>'
      + (v ? '<button type="button" class="dark-btn reader-btn" data-act="reader-vscode" title="Ouvrir dans Visual Studio Code">VS Code</button>'
        + '<button type="button" class="dark-btn reader-btn" data-act="reader-folder" title="Afficher dans l’Explorateur">Dossier</button>' : '')
      + '<button type="button" class="panel-x" data-act="close-reader" title="Fermer (Échap)">✕</button>'
      + '</div>');
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
    if (!r) {
      if (host.innerHTML) host.innerHTML = '';
      readerKey = null; readerStamp = null; readerFrame = null; readerReady = false;
      return;
    }
    var v = r.view;
    var kind = v ? v.kind : (r.error ? 'error' : 'loading');
    var key = r.path + '|' + r.cwd + '|' + kind + '|' + (r.back ? 'b' : '');
    if (readerKey !== key) {
      host.innerHTML = readerShellHtml(r, kind);
      readerKey = key; readerStamp = null; readerReady = false;
      readerFrame = host.querySelector('.reader-frame');
    }
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
     fin si on y était (un rapport qui s'écrit se lit au fil de l'eau). */
  function pushReaderHtml(follow) {
    var r = S.ui.reader;
    if (!r || !r.view || !readerFrame || !readerReady || !READER_FRAMED[r.view.kind]) return;
    try {
      readerFrame.contentWindow.postMessage({ type: 'html', html: r.view.html || '', follow: !!follow }, '*');
    } catch (e) { /* cadre en cours de remplacement */ }
  }

  /* ── Toast ──────────────────────────────────────────────────────────── */

  var toastTimer = null;
  function renderToast() {
    $('#toast-host').innerHTML = S.ui.toast ? '<div class="toast">' + esc(S.ui.toast) + '</div>' : '';
  }
  function toast(msg) {
    S.ui.toast = msg;
    renderToast();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { S.ui.toast = ''; renderToast(); }, 3400);
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
    var t = { id: uid('n'), type: S.ui.composerType, text: text, done: false, doing: false, created: Date.now() };
    var parent = S.ui.composerParent ? taskById(S.ui.composerParent) : null;
    var at = S.ui.insertAt || 'top';
    var idx = 0;
    if (at === 'bottom') idx = S.data.tasks.length;
    else if (at !== 'top') {
      var j = S.data.tasks.findIndex(function (x) { return x.id === at; });
      idx = j < 0 ? 0 : j + 1;
    }
    if (parent) {
      /* Dans le groupe du parent : après la tâche visée si elle en fait partie, sinon en dernier. */
      t.parent = parent.id;
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
      asChildOf = over.id;
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
    S.ui.newConvoOpen = false;
    S.ui.transcript = null;
    render();
    syncPolling();
    refreshSessions();
  }

  /* ── Lecteur d'artefacts : ouverture, relecture, liens ──────────────── */

  var readerTimer = null, readerToken = 0;

  /* `back` : le lecteur d'où l'on vient, quand un lien du rapport mène à un autre fichier. */
  function openReader(path, cwd, back) {
    S.ui.reader = { path: String(path || ''), cwd: String(cwd || ''), view: null, busy: false, error: '', back: back || null };
    render();
    syncReaderPolling();
    loadReader(false);
  }

  function closeReader() {
    S.ui.reader = null;
    syncReaderPolling();
    render();
  }

  function backReader() {
    var r = S.ui.reader;
    if (!r || !r.back) return;
    S.ui.reader = r.back;
    S.ui.reader.busy = false;
    render();
    loadReader(true);
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
    var r = S.ui.reader;
    if (!r || (silent && r.busy)) return Promise.resolve();
    var token = ++readerToken;
    r.busy = true;
    return bridge.call('readArtifact', { path: r.path, cwd: r.cwd, stamp: silent && r.view ? r.view.stamp : '' })
      .then(function (v) {
        if (S.ui.reader !== r) return;
        r.busy = false;
        if (token !== readerToken || !v || v.changed === false) return;
        if (v.kind === 'binary') {
          /* Rien à afficher ici (tableur, document Office…) : le fichier part vers son application. */
          closeReader();
          bridge.call('openPath', { path: v.full, editor: 'default' }).then(function (res) {
            toast(res && res.editor === 'default' ? 'Ouvert avec l’application associée' : 'Affiché dans l’Explorateur');
          })['catch'](function (e) { toast('Ouverture impossible : ' + e.message); });
          return;
        }
        r.view = v;
        r.error = '';
        render();
      })['catch'](function (e) {
        if (S.ui.reader !== r) return;
        r.busy = false;
        if (token !== readerToken) return;
        /* Une relecture qui échoue pendant que l'agent écrit ne doit pas effacer ce qu'on lit. */
        if (!silent || !r.view) { r.error = e.message; r.view = null; render(); }
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
      });
      if (changed) saveDataLater();
      /* Rien de neuf : on laisse la page tranquille (une relecture toutes les secondes et demie
         ne doit ni interrompre une sélection ni faire clignoter la liste). */
      if (changed || dirty) renderActivity();
      if (arrived.length) announce(arrived);
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

  /* Une réponse vient d'arriver : toast, et clignotement dans la barre des tâches si la
     fenêtre est en arrière-plan (c'est l'hôte qui tranche). */
  function announce(convs) {
    var titles = convs.map(function (c) { return c.title || 'Nouvelle session'; });
    toast(convs.length === 1 ? 'Réponse prête : ' + titles[0] : convs.length + ' réponses prêtes');
    bridge.call('notify', { count: convs.length, title: titles[0] })['catch'](function () { /* sans importance */ });
    /* Le quota vient de bouger : relecture forcée, une fois l'API à jour. */
    setTimeout(function () { refreshUsage(true); }, 2000);
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
      .map(function (pr) { return usageCardHtml(pr, reports[pr.id] || null); }).join('');
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
      return {
        path: String(artifact.path).trim(),
        action: String(artifact.action || 'modified'),
        tool: String(artifact.tool || 'outil'),
        agent: String(artifact.agent || '')
      };
    });
  }

  function sameArtifacts(a, b) {
    var left = normalizeArtifacts(a);
    var right = normalizeArtifacts(b);
    if (left.length !== right.length) return false;
    for (var i = 0; i < left.length; i++) {
      if (left[i].path !== right[i].path || left[i].action !== right[i].action || left[i].tool !== right[i].tool
        || left[i].agent !== right[i].agent) return false;
    }
    return true;
  }

  /* Agent par défaut des réglages, ou l'autre s'il est le seul installé. */
  function defaultProviderId() {
    var wanted = S.settings.provider === 'copilot' ? 'copilot' : 'claude';
    var other = wanted === 'copilot' ? 'claude' : 'copilot';
    return !hasProvider(wanted) && hasProvider(other) ? other : wanted;
  }

  function openNewConvo() {
    S.ui.newConvoOpen = true;
    newFormEntered = false;
    S.ui.newConvoCwd = defaultCwdFor(S.ui.termTaskId);
    S.ui.newConvoPrompt = buildPrompt(taskById(S.ui.termTaskId));
    S.ui.newConvoKeywords = [];
    S.ui.newKeywordOpen = false;
    S.ui.newKeywordName = '';
    S.ui.newKeywordPrompt = '';
    setNewConvoProvider(defaultProviderId());
    loadRecap(taskById(S.ui.termTaskId));
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
    var provider = S.ui.newConvoProvider === 'copilot' ? 'copilot' : 'claude';
    var cwd = String(S.ui.newConvoCwd || '').trim();
    if (!cwd) { toast('Indiquez un dossier de travail.'); return; }
    startSession(task, provider, String(S.ui.newConvoModel || '').trim(), String(S.ui.newConvoEffort || '').trim(), cwd,
      keywordIdsFor(task, S.ui.newConvoKeywords), S.ui.newConvoPrompt, S.ui.newConvoRecapBusy ? '' : S.ui.newConvoRecap);
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
    var title = feedback ? feedbackTitle(pending.length) : firstLine(task.text, 46);
    var chosen = keywordIdsFor(task, keywords);
    /* La tâche reste dans le contexte sauf quand c'est elle qui part en message : un message
       retouché (« commence par reproduire le bug ») ne doit pas priver l'agent de l'énoncé. */
    var taskInContext = first !== buildPrompt(task);
    S.ui.launchBusy = true;
    render();
    bridge.call('startSession', {
      taskId: task.id, provider: provider, model: model, effort: effort, cwd: cwd, title: title,
      keywords: chosen, context: buildContext(task, chosen, taskInContext, feedback ? '' : String(recap || '').trim()), prompt: first
    })
      .then(function (r) {
        if (!r || !r.sessionId) throw new Error('réponse incomplète de l’hôte');
        var now = Date.now();
        S.data.convos.push({
          id: r.sessionId, taskId: task.id, provider: provider, model: model, effort: effort, title: title, cwd: r.cwd || cwd,
          keywords: chosen, artifacts: [], created: toMs(r.created) || now, updated: toMs(r.created) || now, messageCount: 0
        });
        if (feedback) markRemarksSent(pending, r.sessionId);
        S.ui.sessionExists[r.sessionId] = false;
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

  /* Le texte tapé mais pas encore ajouté devient une remarque ; vrai si quelque chose a été ajouté. */
  function flushTypedRemark() {
    var text = String(S.ui.remarkText || '').trim();
    if (!text) return false;
    S.data.remarks.push({ id: uid('r'), text: text, created: Date.now(), sentAt: 0, sessionId: '' });
    S.ui.remarkText = '';
    return true;
  }

  /* L'hôte a-t-il ouvert un terminal, ou ramené celui de la session ? Quand le terminal groupe ses
     sessions en onglets, il active celui de la session ; s'il n'a pas su lequel c'était (deux
     onglets du même nom), il le nomme — à nous de le dire. */
  function resumeToast(r) {
    if (!r || !r.focused) return 'Session reprise dans PowerShell';
    if (r.tab) return 'Session déjà ouverte : fenêtre au premier plan, onglet « ' + r.tab + ' »';
    return r.tabActivated
      ? 'Session déjà ouverte : son onglet est au premier plan'
      : 'Session déjà ouverte : sa fenêtre est au premier plan';
  }

  /* `withRemarks` : reprend la session en lui envoyant les remarques en attente (carnet seulement). */
  function resumeConvo(convId, withRemarks) {
    var c = convoById(convId);
    if (!c) return;
    var provider = providerOf(c);
    if (!hasProvider(provider)) { toast(providerById(provider).missing); return; }
    var task = taskById(c.taskId);
    var pending = withRemarks && c.taskId === FEEDBACK_ID ? pendingRemarks() : [];
    bridge.call('resumeSession', {
      sessionId: c.id, provider: provider, model: c.model || '', effort: c.effort || '', cwd: c.cwd, title: c.title,
      keywords: task ? keywordIdsFor(task, c.keywords) : [],
      context: task ? buildContext(task, c.keywords, true) : '', prompt: pending.length ? feedbackPrompt(pending) : ''
    }).then(function (r) {
      if (!pending.length) { toast(resumeToast(r)); return; }
      markRemarksSent(pending, c.id);
      c.updated = Date.now();
      commit();
      toast('Remarques envoyées dans la session existante');
    })['catch'](function (e) { toast('Reprise impossible : ' + e.message); });
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

  function markRemarksSent(list, sessionId) {
    var now = Date.now();
    list.forEach(function (r) { r.sentAt = now; r.sessionId = sessionId || ''; });
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

    edit: function (el) {
      S.ui.editingId = el.getAttribute('data-id');
      render();
      var ta = document.querySelector('[data-focus-key="edit-text"]');
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    },
    'stop-edit': function () { S.ui.editingId = null; render(); },
    'set-type': function (el) { setType(el.getAttribute('data-id'), el.getAttribute('data-type')); },
    'toggle-done': function (el) { toggleDone(el.getAttribute('data-id')); },
    'toggle-doing': function (el) { toggleDoing(el.getAttribute('data-id')); },
    'remove-task': function (el) { removeTask(el.getAttribute('data-id')); },
    'move-bottom': function (el) { moveToBottom(el.getAttribute('data-id')); },
    'open-term': function (el) { openTerm(el.getAttribute('data-id')); },
    'open-artifacts': function (el) { openArtifacts(el.getAttribute('data-id')); },
    'open-artifact': function (el) {
      openReader(el.getAttribute('data-path') || '', el.getAttribute('data-cwd') || '');
    },
    'close-reader': closeReader,
    'reader-back': backReader,
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
    'cancel-new-convo': function () { S.ui.newConvoOpen = false; render(); },
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
    'settings-tab': function (el) { S.ui.settingsTab = el.getAttribute('data-id'); render(); },
    'refresh-usage': function () { refreshUsage(true); },
    'top-minus': function () { setSetting('topCount', Math.max(1, S.settings.topCount - 1)); },
    'top-plus': function () { setSetting('topCount', Math.min(8, S.settings.topCount + 1)); },
    'toggle-bands': function () { setSetting('showBands', !S.settings.showBands); },
    'toggle-compact': function () { setSetting('compact', !S.settings.compact); },
    'term-ps': function () { setSetting('terminal', 'powershell'); },
    'term-wt': function () { setSetting('terminal', 'wt'); },
    'default-claude': function () { setSetting('provider', 'claude'); },
    'default-copilot': function () { setSetting('provider', 'copilot'); },
    'browse-default-cwd': function () {
      browseFolder(S.settings.defaultCwd || S.env.defaultCwd).then(function (p) { if (p) setSetting('defaultCwd', p); });
    }
  };

  document.addEventListener('click', function (e) {
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
    if (role === 'edit-text') {
      var t = taskById(el.getAttribute('data-id'));
      if (!t) return;
      t.text = el.value;
      el.rows = Math.min(12, Math.max(2, el.value.split('\n').length + 1));
      saveDataSoon();
    } else if (role === 'composer-text') {
      S.ui.composerText = el.value;
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
    } else if (role === 'new-model') {
      S.ui.newConvoModel = el.value;
    } else if (role === 'set-model') {
      S.settings[modelSettingKey(el.getAttribute('data-provider'))] = el.value;
      saveSettingsSoon();
    } else if (role === 'draft-model') {
      S.settings.draftModel = el.value;
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
    var provider = el.getAttribute('data-provider') === 'copilot' ? 'copilot' : 'claude';
    var v = el.value;

    if (role === 'pr-check') {
      if (S.ui.prImport) { S.ui.prImport.checked[el.getAttribute('data-id')] = !!el.checked; render(); }
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
    }
  });

  document.addEventListener('keydown', function (e) {
    var el = e.target;
    var role = el && el.getAttribute ? el.getAttribute('data-role') : null;

    if (role === 'edit-text' && e.key === 'Escape') { e.preventDefault(); S.ui.editingId = null; render(); return; }
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
    if (role === 'new-kw-name' && e.key === 'Enter') { e.preventDefault(); addKeywordFromLaunch(); return; }
    if (role === 'new-kw-prompt' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addKeywordFromLaunch(); return; }
    if (role === 'remark-new' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addRemark(); return; }
    if ((role === 'new-cwd' || role === 'new-model') && e.key === 'Enter') { e.preventDefault(); launchConvo(); return; }
    if (role === 'new-prompt' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); launchConvo(); return; }

    /* Échap referme d'abord l'éditeur de mot-clé, puis le dialogue. */
    if (e.key === 'Escape' && S.ui.catsOpen && S.ui.catKeywordEdit) { S.ui.catKeywordEdit = ''; render(); return; }
    if (e.key === 'Escape' && S.ui.catsOpen) { closeCats(); return; }
    if (e.key === 'Escape' && S.ui.settingsOpen) { S.ui.settingsOpen = false; render(); return; }
    /* Le lecteur d'artefacts couvre la fenêtre : Échap le referme (depuis le cadre, il l'envoie par message). */
    if (e.key === 'Escape' && S.ui.reader) { closeReader(); return; }

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

  /* ══ Démarrage ════════════════════════════════════════════════════════ */

  function normalize(st) {
    var d = (st && st.data) || {};
    S.data.tasks = Array.isArray(d.tasks) ? d.tasks : [];
    S.data.types = Array.isArray(d.types) ? d.types : [];
    S.data.convos = Array.isArray(d.convos) ? d.convos : [];
    S.data.remarks = Array.isArray(d.remarks) ? d.remarks : [];
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
      c.messageCount = typeof c.messageCount === 'number' ? c.messageCount : 0;
      c.created = toMs(c.created);
      c.updated = toMs(c.updated) || c.created;
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
    S.settings.provider = S.settings.provider === 'copilot' ? 'copilot' : 'claude';
    S.settings.claudeModel = String(S.settings.claudeModel || '').trim();
    S.settings.copilotModel = String(S.settings.copilotModel || '').trim();
    S.settings.claudeEffort = String(S.settings.claudeEffort || '').trim();
    S.settings.copilotEffort = String(S.settings.copilotEffort || '').trim();
    S.settings.draftProvider = S.settings.draftProvider === 'copilot' ? 'copilot' : 'claude';
    S.settings.draftModel = String(S.settings.draftModel || '').trim();
    S.settings.draftEffort = String(S.settings.draftEffort || '').trim();

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
    });
    /* La largeur du panneau change le repliement des lignes : les zones de remarques se remesurent. */
    window.addEventListener('resize', function () { fitRemarks($('#panel')); });

    bridge.on('sessionsChanged', function () {
      refreshSessions();
      restartSessionsPoll();
      if (S.ui.termConvId) loadTranscript(true);
      if (S.ui.reader) loadReader(true);
    });
    bridge.on('focus', function () {
      refreshSessions();
      restartSessionsPoll();
      refreshUsage(false);
      if (S.ui.termConvId) loadTranscript(true);
      if (S.ui.reader) loadReader(true);
    });

    /* Messages du cadre isolé du lecteur : prêt à recevoir le HTML, lien cliqué, Échap. */
    window.addEventListener('message', function (e) {
      if (!readerFrame || !e.source || e.source !== readerFrame.contentWindow) return;
      var m = e.data || {};
      if (m.type === 'ready') {
        readerReady = true;
        pushReaderHtml(false);
        try { readerFrame.focus(); } catch (err) { /* cadre déjà remplacé */ }
      } else if (m.type === 'close') {
        closeReader();
      } else if (m.type === 'link') {
        followReaderLink(m.href);
      }
    });

    /* Les quotas bougent lentement : relecture toutes les 5 min au plus, fenêtre visible. */
    setInterval(function () { if (document.visibilityState !== 'hidden') refreshUsage(false); }, 60000);

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
      render();
      refreshSessions();
      restartSessionsPoll();
      refreshUsage(true);
      if (S.env.hasClaude === false) toast(NO_CLAUDE);
      /* Catalogues absents ou vieux d'un jour : détection silencieuse en arrière-plan. */
      if (S.env.hasCopilot && catalogStale('copilot')) refreshModels('copilot', false);
      if (S.env.hasClaude !== false && catalogStale('claude')) refreshModels('claude', false);
    })['catch'](function (e) {
      normalize({});
      render();
      toast('Données illisibles : ' + e.message);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* Exposé pour le débogage et les tests manuels. */
  window.__organizator = {
    state: S, render: render, toast: toast, refreshSessions: refreshSessions, refreshUsage: refreshUsage,
    openReader: openReader, closeReader: closeReader
  };
})();
