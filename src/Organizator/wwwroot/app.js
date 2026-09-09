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
    repoDir: ''
  };

  /* Agents disponibles. `short` sert dans les listes, `example` dans le champ de modèle libre. */
  var PROVIDERS = [
    { id: 'claude', label: 'Claude Code', short: 'Claude', example: 'claude-opus-5',
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
    alias: 'Alias (dernier modèle de la famille)', used: 'Déjà utilisés sur ce poste', auto: 'Automatique',
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
    terminal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l3 3-3 3M12.5 15h5"></path><rect x="2.5" y="4" width="19" height="16" rx="4"></rect></svg>',
    eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
  };

  /* ══ État ═════════════════════════════════════════════════════════════ */

  var S = {
    data: { tasks: [], types: [], convos: [], remarks: [], lastType: null },
    settings: Object.assign({}, DEFAULTS),
    env: { version: '?', hasClaude: true, hasCopilot: false, hasWt: false, defaultCwd: '', dataDir: '', userProfile: '', repoDir: '', models: null, efforts: null },
    ui: {
      search: '',
      hidden: [],
      editingId: null,
      dragId: null, overId: null, overBefore: null,
      composerOpen: false, composerText: '', composerType: null, insertAt: 'top',
      catFormOpen: false, catName: '', catPalette: 'terracotta',
      settingsOpen: false,
      termTaskId: null, termConvId: null,
      newConvoOpen: false, newConvoCwd: '', newConvoProvider: 'claude', newConvoModel: '', newConvoEffort: '', newConvoCustom: false,
      modelsBusy: false, settingsCustom: { claude: false, copilot: false },
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

  function saveSettingsNow() {
    if (setTimer) { clearTimeout(setTimer); setTimer = null; }
    setDirty = false;
    setInFlight = bridge.call('saveSettings', {
      topCount: S.settings.topCount, showBands: S.settings.showBands, compact: S.settings.compact,
      defaultCwd: S.settings.defaultCwd, terminal: S.settings.terminal,
      provider: S.settings.provider, claudeModel: S.settings.claudeModel, copilotModel: S.settings.copilotModel,
      claudeEffort: S.settings.claudeEffort, copilotEffort: S.settings.copilotEffort,
      repoDir: S.settings.repoDir
    })['catch'](function (e) { toast('Réglages non sauvegardés : ' + e.message); });
    return setInFlight;
  }

  function saveSettingsSoon() {
    setDirty = true;
    if (setTimer) clearTimeout(setTimer);
    setTimer = setTimeout(saveSettingsNow, 300);
  }

  window.organizatorFlush = function () {
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

  function taskById(id) {
    if (id === FEEDBACK_ID) return FEEDBACK_TASK;
    for (var i = 0; i < S.data.tasks.length; i++) if (S.data.tasks[i].id === id) return S.data.tasks[i];
    return null;
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

  function visibleTasks() {
    var q = S.ui.search.trim().toLowerCase();
    return S.data.tasks
      .filter(function (t) {
        return S.ui.hidden.indexOf(t.type) < 0 && (!q || String(t.text || '').toLowerCase().indexOf(q) >= 0);
      })
      .slice()
      .sort(function (a, b) { return (a.done ? 1 : 0) - (b.done ? 1 : 0); });
  }

  function buildContext(t) {
    if (t.id === FEEDBACK_ID) return FEEDBACK_CONTEXT;
    return "Tu travailles sur la tâche suivante, extraite d'Organizator (file de tâches de l'utilisateur).\n"
      + 'Catégorie : ' + typeOf(t.type).label + '\n'
      + 'Tâche :\n' + String(t.text || '') + '\n'
      + 'Réponds en français.';
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

  function catalogCount(cat) {
    var n = 0;
    (cat.groups || []).forEach(function (g) { (g.items || []).forEach(function (it) { if (it.id !== 'auto') n++; }); });
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

  /* ── État des sessions ──────────────────────────────────────────────────
     L'hôte lit l'état dans le transcript (working, waiting, ready, error, idle) et dit si le
     processus de l'agent vit encore. Fenêtre fermée : « closed », quoi qu'en dise le transcript.
     Session ouverte sans premier message : « open ». */
  var STATE_LABELS = {
    working: 'En cours', waiting: 'Attend votre réponse', ready: 'Réponse prête',
    error: 'Erreur', closed: 'Fermée', open: 'Ouverte', idle: 'Inactive'
  };
  var TASK_STATE_LABELS = { working: 'Agent en cours', waiting: 'Question de l’agent', ready: 'Réponse prête', error: 'Erreur de l’agent' };
  var STATE_RANK = { working: 4, waiting: 3, error: 2, ready: 1 };
  var DETAIL_LABELS = { fermee: 'fermée', 'question posee': 'question posée', 'autorisation demandee': 'autorisation demandée' };

  function activityOf(c) { return (c && S.ui.activity[c.id]) || null; }
  function detailLabel(d) { return DETAIL_LABELS[d] || d || ''; }

  /* État affiché d'une conversation, ou null tant qu'on ne sait rien. */
  function displayState(c) {
    var a = activityOf(c);
    if (!a) return null;
    if (a.alive === false) return a.exists ? 'closed' : null;
    if (!a.exists) return a.alive ? 'open' : null;
    return a.state || 'idle';
  }

  function stateText(c) {
    var st = displayState(c);
    if (!st) return '';
    var a = activityOf(c);
    var when = fmtTime(a.stateTs);
    var detail = detailLabel(a.detail);
    if (st === 'working' || st === 'waiting') return STATE_LABELS[st] + (when ? ' depuis ' + when : '');
    if (st === 'ready') return STATE_LABELS[st] + (when ? ' à ' + when : '');
    if (st === 'error') return STATE_LABELS[st] + (when ? ' à ' + when : '') + (detail ? ' · ' + detail : '');
    if (st === 'idle') return detail ? STATE_LABELS[st] + ' · ' + detail : '';
    return STATE_LABELS[st];
  }

  function stateHtml(c) {
    var text = stateText(c);
    if (!text) return '';
    var a = activityOf(c);
    var tip = displayState(c) === 'working' && a.detail ? 'Outil en cours : ' + a.detail : '';
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

  /* Bouton terminal de la carte : l'état des conversations se lit directement dessus. */
  function termBtnHtml(t, convs) {
    var c = bestConvo(convs);
    var st = c ? displayState(c) : null;
    var tip = 'Ouvrir le terminal de l’agent';
    if (c) {
      var line = stateText(c) || TASK_STATE_LABELS[st] || '';
      tip = (convs.length > 1 ? (c.title || 'Nouvelle session') + ' · ' : '') + line + ' · ' + tip;
    }
    return '<button type="button" class="icon-btn term-btn' + (convs.length ? ' has' : '')
      + (st ? ' is-' + esc(st) : '') + '" data-act="open-term" data-id="' + esc(t.id)
      + '" title="' + esc(tip) + '">' + ICON.terminal
      + (st ? '<span class="btn-dot st-' + esc(st) + '"></span>' : '') + '</button>';
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

  function copilotCatalogHint() {
    if (S.ui.modelsBusy) return 'Détection des modèles Copilot en cours…';
    var cat = catalogFor('copilot');
    if (!toMs(cat.fetchedAt)) return 'Liste non détectée : ↻ interroge la CLI Copilot (quelques secondes).';
    return catalogCount(cat) + ' modèles détectés le ' + fmtDate(cat.fetchedAt) + (catalogStale('copilot') ? ' (à rafraîchir)' : '') + '.';
  }

  /* Détection du catalogue Copilot par l'hôte (sonde ACP, mise en cache 24 h). */
  function refreshModels(force) {
    if (S.ui.modelsBusy) return Promise.resolve();
    if (!hasProvider('copilot')) { if (force) toast(providerById('copilot').missing); return Promise.resolve(); }
    S.ui.modelsBusy = true;
    render();
    return bridge.call('refreshModels', { provider: 'copilot', force: !!force }, 90000)
      .then(function (r) {
        S.ui.modelsBusy = false;
        if (r && r.copilot) {
          if (!S.env.models) S.env.models = {};
          S.env.models.copilot = r.copilot;
        }
        render();
        if (force) toast(catalogCount(catalogFor('copilot')) + ' modèles Copilot détectés');
      })['catch'](function (e) {
        S.ui.modelsBusy = false;
        render();
        if (force) toast('Détection impossible : ' + e.message);
        else console.warn('[organizator] refreshModels', e);
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
    preserveFocus(function () {
      $('#app').classList.toggle('compact', !!S.settings.compact);
      $('#shell').classList.toggle('with-panel', !!S.ui.termTaskId);
      renderChips();
      renderList();
      renderPanel();
      renderDialogs();
      renderUsage();
      renderRemarksBtn();
    });
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

  /* ── Barre de filtres ───────────────────────────────────────────────── */

  function renderChips() {
    var used = S.data.types.filter(function (ty) {
      return S.data.tasks.some(function (t) { return t.type === ty.id; });
    });
    $('#filter-chips').innerHTML = used.map(function (ty) {
      var off = S.ui.hidden.indexOf(ty.id) >= 0;
      var style = off ? '' : ' style="border-color:' + esc(color(ty.bd, 'var(--color-neutral-300)'))
        + ';background:' + esc(color(ty.bg, 'transparent'))
        + ';color:' + esc(color(ty.fg, 'var(--color-neutral-700)')) + '"';
      return '<button type="button" class="chip' + (off ? ' off' : '') + '" data-act="toggle-filter" data-id="'
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

  function gapHtml(value, taskId, tail) {
    return '<div class="gap' + (tail ? ' gap-tail' : '') + '" data-act="gap" data-gap="' + esc(value) + '"'
      + (taskId ? ' data-gap-task="' + esc(taskId) + '"' : '')
      + ' title="Ajouter une tâche ' + (tail ? 'en bas de file' : 'ici') + '">'
      + '<div class="gap-inner"><div class="gap-rule"></div><div class="gap-dot">' + ICON.plusSmall + '</div></div>'
      + '</div>';
  }

  function taskHtml(t, rank, isTop, band, showBand) {
    var ty = typeOf(t.type);
    var editing = S.ui.editingId === t.id;
    var doing = !!t.doing && !t.done;
    var convs = S.data.convos.filter(function (c) { return c.taskId === t.id; });
    var h = [];

    h.push('<div class="item" data-item="' + esc(t.id) + '">');

    if (showBand) {
      h.push('<div class="band"><span class="band-label">' + esc(band) + '</span>'
        + '<span class="band-rule"></span><span class="band-hint">' + esc(bandHint(band)) + '</span></div>');
    }

    h.push(gapHtml(rank.gapValue, t.id, false));
    h.push('<div class="drop drop-before"><div class="drop-line"></div><div class="drop-knob"></div></div>');

    h.push('<div class="task' + (doing ? ' is-doing' : '') + (t.done ? ' is-done' : '') + (editing ? ' is-editing' : '')
      + '" data-card="' + esc(t.id) + '" draggable="' + (editing ? 'false' : 'true') + '">');
    h.push('<div class="task-row">');

    h.push('<div class="rank-col">'
      + '<span class="rank' + (isTop ? ' is-top' : '') + '">' + esc(t.done ? '✓' : String(rank.n)) + '</span>'
      + '<span class="handle" title="Glisser pour déplacer">' + ICON.handle + '</span>'
      + '</div>');

    h.push('<div class="task-main">');
    h.push('<div class="meta-row"><span class="type-chip" style="border-color:' + esc(color(ty.bd, 'var(--color-neutral-300)'))
      + ';background:' + esc(color(ty.bg, 'transparent')) + ';color:' + esc(color(ty.fg, 'var(--color-neutral-600)')) + '">'
      + esc(ty.label) + '</span>');
    if (doing) {
      h.push('<span class="doing-chip"><span class="doing-dot"></span><span>En cours</span></span>');
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
        + '<button type="button" class="btn btn-ghost edit-done" data-act="stop-edit">Terminé</button></div>');
    } else {
      h.push('<div class="task-text" data-act="edit" data-id="' + esc(t.id) + '" title="Cliquer pour modifier">'
        + esc(t.text) + '</div>');
    }
    h.push('</div>');

    h.push('<div class="task-actions"><div class="hover-actions">'
      + '<button type="button" class="icon-btn doing-btn' + (doing ? ' on' : '') + '" data-act="toggle-doing" data-id="'
      + esc(t.id) + '" title="' + (doing ? 'Sortir de « en cours »' : 'Passer en cours') + '">'
      + (doing ? ICON.stop : ICON.play) + '</button>'
      + '<button type="button" class="btn btn-icon btn-ghost" data-act="toggle-done" data-id="' + esc(t.id)
      + '" title="Marquer terminée">' + ICON.check + '</button>'
      + '<button type="button" class="btn btn-icon btn-ghost" data-act="remove-task" data-id="' + esc(t.id)
      + '" title="Supprimer">' + ICON.trash + '</button>'
      + '</div>'
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
    var r = 0;
    var out = [];

    visible.forEach(function (t, i) {
      if (!t.done) r++;
      var band = t.done ? 'Terminées' : (r <= topCount ? 'Maintenant' : (r <= topCount * 2 ? 'Ensuite' : 'Plus tard'));
      var showBand = showBands && !seen[band];
      if (showBand) seen[band] = true;
      var isTop = !t.done && r <= topCount;
      out.push(taskHtml(t, { n: r, gapValue: i === 0 ? 'top' : visible[i - 1].id }, isTop, band, showBand));
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
    if (cur === 'copilot') {
      h.push('<button type="button" class="dark-btn" data-act="refresh-models"' + (S.ui.modelsBusy ? ' disabled' : '')
        + ' title="Redétecter les modèles Copilot">↻</button>');
    }
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

  /* Formulaire de lancement : agent, modèle, effort, dossier ; `launchLabel` nomme le bouton. */
  function newFormHtml(launchLabel) {
    return '<div class="new-form">' + newFormAgentHtml()
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

  /* Liste des sessions. Dans le carnet de remarques, chaque session propose d'y envoyer
     les remarques en attente (reprise avec un nouveau message). */
  function convoListHtml(convs, feedback) {
    var pending = feedback ? pendingRemarks().length : 0;
    return '<div class="convo-list">' + convs.map(function (c) {
      return '<div class="convo">'
        + '<button type="button" class="convo-open" data-act="resume-convo" data-id="' + esc(c.id)
        + '" title="Reprendre cette session dans PowerShell">'
        + '<div class="convo-title">' + esc(c.title || 'Nouvelle session') + '</div>'
        + stateHtml(c)
        + '<div class="convo-meta">' + esc(convoMeta(c)) + '</div>'
        + '</button>'
        + (pending ? '<button type="button" class="convo-btn" data-act="send-remarks-here" data-id="' + esc(c.id)
          + '" title="Envoyer les remarques en attente dans cette session">↪</button>' : '')
        + '<button type="button" class="convo-btn" data-act="open-transcript" data-id="' + esc(c.id)
        + '" title="Voir le journal">' + ICON.eye + '</button>'
        + '<button type="button" class="convo-btn" data-act="remove-convo" data-id="' + esc(c.id)
        + '" title="Supprimer la conversation">✕</button>'
        + '</div>';
    }).join('') + '</div>';
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
    h.push(conv ? panelTranscriptHtml(conv) : (task.id === FEEDBACK_ID ? feedbackHtml() : panelListHtml(S.ui.termTaskId)));
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
    var h = [];
    h.push('<div class="dialog-backdrop">');
    h.push('<div class="dialog' + (enter ? ' enter' : '') + '" data-act="noop" role="dialog" aria-label="Nouvelle tâche">');
    h.push('<div class="dialog-title">Nouvelle tâche</div>');

    h.push('<div class="composer-types">');
    h.push(types.map(function (ty) {
      var on = S.ui.composerType === ty.id;
      var style = on ? ' style="border-color:' + esc(color(ty.bd, 'var(--color-neutral-300)'))
        + ';background:' + esc(color(ty.bg, 'transparent')) + ';color:' + esc(color(ty.fg, 'var(--color-neutral-600)')) + '"' : '';
      return '<button type="button" class="opt-chip" data-act="pick-type" data-id="' + esc(ty.id)
        + '" title="Clic droit pour supprimer la catégorie"' + style + '>' + esc(ty.label) + '</button>';
    }).join(''));
    h.push('<button type="button" class="new-cat-btn" data-act="open-cat" title="Créer une catégorie">+ catégorie</button>');
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

    h.push('<textarea class="input composer-text" rows="3" data-role="composer-text" data-focus-key="composer-text" '
      + 'placeholder="Décrivez la tâche… (plusieurs lignes possibles, Cmd/Ctrl + Entrée pour ajouter)">'
      + esc(S.ui.composerText) + '</textarea>');

    h.push('<div class="dialog-actions">'
      + '<span class="dialog-hint">' + esc(hint) + '</span>'
      + '<button type="button" class="btn btn-ghost" data-act="close-composer">Annuler</button>'
      + '<button type="button" class="btn btn-primary" data-act="add-task"' + (S.ui.composerType ? '' : ' disabled')
      + '>Ajouter la tâche</button>'
      + '</div>');

    h.push('</div></div>');
    return h.join('');
  }

  function settingsHtml(enter) {
    var s = S.settings;
    var h = [];
    h.push('<div class="dialog-backdrop">');
    h.push('<div class="dialog' + (enter ? ' enter' : '') + '" data-act="noop" role="dialog" aria-label="Réglages">');
    h.push('<div class="dialog-title">Réglages</div>');

    h.push('<div class="set-row">'
      + '<div class="set-label"><div class="set-name">Tâches en tête</div>'
      + '<div class="set-help">Nombre de tâches mises en avant en haut de file.</div></div>'
      + '<div class="set-control"><div class="stepper">'
      + '<button type="button" class="step-btn" data-act="top-minus"' + (s.topCount <= 1 ? ' disabled' : '') + ' aria-label="Moins">−</button>'
      + '<span class="step-val">' + esc(s.topCount) + '</span>'
      + '<button type="button" class="step-btn" data-act="top-plus"' + (s.topCount >= 8 ? ' disabled' : '') + ' aria-label="Plus">+</button>'
      + '</div></div></div>');

    h.push('<div class="set-row">'
      + '<div class="set-label"><div class="set-name">Bandes de priorité</div>'
      + '<div class="set-help">Maintenant, Ensuite, Plus tard, Terminées.</div></div>'
      + '<div class="set-control"><button type="button" class="switch' + (s.showBands ? ' on' : '')
      + '" data-act="toggle-bands" role="switch" aria-checked="' + (s.showBands ? 'true' : 'false') + '" aria-label="Bandes de priorité"></button></div></div>');

    h.push('<div class="set-row">'
      + '<div class="set-label"><div class="set-name">Mode compact</div>'
      + '<div class="set-help">Cartes plus resserrées.</div></div>'
      + '<div class="set-control"><button type="button" class="switch' + (s.compact ? ' on' : '')
      + '" data-act="toggle-compact" role="switch" aria-checked="' + (s.compact ? 'true' : 'false') + '" aria-label="Mode compact"></button></div></div>');

    h.push('<div class="set-row stacked">'
      + '<div class="set-label"><div class="set-name">Dossier de travail par défaut</div>'
      + '<div class="set-help">Proposé au lancement d’une session sans conversation antérieure.</div></div>'
      + '<div class="set-control">'
      + '<input class="input set-cwd" type="text" data-role="settings-cwd" data-focus-key="settings-cwd" spellcheck="false" placeholder="'
      + esc(S.env.defaultCwd || 'C:\\…') + '" value="' + esc(s.defaultCwd) + '">'
      + '<button type="button" class="btn btn-secondary" data-act="browse-default-cwd">Parcourir…</button>'
      + '</div></div>');

    h.push('<div class="set-row stacked">'
      + '<div class="set-label"><div class="set-name">Sources d’Organizator</div>'
      + '<div class="set-help">Dépôt où l’agent traite vos remarques. Vide : le dossier détecté autour de l’exécutable'
      + (S.env.repoDir ? '.' : ' (aucun sur ce poste).') + '</div></div>'
      + '<div class="set-control">'
      + '<input class="input set-cwd" type="text" data-role="settings-repo" data-focus-key="settings-repo" spellcheck="false" placeholder="'
      + esc(S.env.repoDir || 'D:\\…\\Organizator') + '" value="' + esc(s.repoDir) + '">'
      + '<button type="button" class="btn btn-secondary" data-act="browse-repo-dir">Parcourir…</button>'
      + '</div></div>');

    h.push('<div class="set-row">'
      + '<div class="set-label"><div class="set-name">Terminal</div>'
      + '<div class="set-help">' + (S.env.hasWt ? 'Application utilisée pour lancer les sessions.' : 'Windows Terminal est introuvable sur ce poste.') + '</div></div>'
      + '<div class="set-control"><div class="seg2">'
      + '<button type="button" class="' + (s.terminal !== 'wt' ? 'on' : '') + '" data-act="term-ps">PowerShell</button>'
      + '<button type="button" class="' + (s.terminal === 'wt' ? 'on' : '') + '" data-act="term-wt"'
      + (S.env.hasWt ? '' : ' disabled') + '>Windows Terminal</button>'
      + '</div></div></div>');

    h.push('<div class="set-row">'
      + '<div class="set-label"><div class="set-name">Agent par défaut</div>'
      + '<div class="set-help">Présélectionné dans « Nouvelle conversation », avec son modèle et son effort par défaut.</div></div>'
      + '<div class="set-control"><div class="seg2">'
      + '<button type="button" class="' + (s.provider !== 'copilot' ? 'on' : '') + '" data-act="default-claude">Claude Code</button>'
      + '<button type="button" class="' + (s.provider === 'copilot' ? 'on' : '') + '" data-act="default-copilot"'
      + (hasProvider('copilot') ? '' : ' disabled') + '>GitHub Copilot</button>'
      + '</div></div></div>');

    PROVIDERS.forEach(function (pr) {
      var model = String(s[modelSettingKey(pr.id)] || '');
      var custom = S.ui.settingsCustom[pr.id] || (model && !catalogHas(catalogFor(pr.id), model));
      h.push('<div class="set-row stacked">'
        + '<div class="set-label"><div class="set-name">' + esc(pr.label) + ' · modèle par défaut</div>'
        + '<div class="set-help">' + (pr.id === 'copilot' ? esc(copilotCatalogHint()) : 'Alias ou identifiant complet, passé à --model. Vide : réglage propre de l’outil.') + '</div></div>'
        + '<div class="set-control">'
        + modelSelectHtml(pr.id, model, S.ui.settingsCustom[pr.id], 'set-model-select', 'set-model-select-' + pr.id, false)
        + (pr.id === 'copilot' ? '<button type="button" class="btn btn-secondary" data-act="refresh-models"' + (S.ui.modelsBusy ? ' disabled' : '')
          + ' title="Redétecter les modèles Copilot">↻</button>' : '')
        + '</div>'
        + (custom ? '<div class="set-control"><input class="input set-cwd" type="text" data-role="set-model" data-focus-key="set-model-' + esc(pr.id)
          + '" data-provider="' + esc(pr.id) + '" spellcheck="false" placeholder="Identifiant de modèle, ex. ' + esc(pr.example) + '" value="' + esc(model) + '"></div>' : '')
        + '</div>');
      h.push('<div class="set-row">'
        + '<div class="set-label"><div class="set-name">' + esc(pr.label) + ' · effort par défaut</div>'
        + '<div class="set-help">Passé à --effort. Vide : réglage propre de l’outil.</div></div>'
        + '<div class="set-control">' + effortSelectHtml(pr.id, String(s[effortSettingKey(pr.id)] || ''), 'set-effort', 'set-effort-' + pr.id, false) + '</div></div>');
    });

    h.push('<div class="dialog-actions"><button type="button" class="btn btn-primary" data-act="close-settings">Fermer</button></div>');
    h.push('</div></div>');
    return h.join('');
  }

  function renderDialogs() {
    var host = $('#dialogs');
    var key = S.ui.composerOpen ? 'composer' : (S.ui.settingsOpen ? 'settings' : null);
    if (!key) {
      if (host.innerHTML) host.innerHTML = '';
      dialogKey = null;
      composerFocus = null;
      return;
    }
    var enter = dialogKey !== key;
    host.innerHTML = key === 'composer' ? composerHtml(enter) : settingsHtml(enter);
    dialogKey = key;

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

  function commit() { saveDataNow(); render(); }

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

  function removeTask(id) {
    S.data.tasks = S.data.tasks.filter(function (t) { return t.id !== id; });
    S.data.convos = S.data.convos.filter(function (c) { return c.taskId !== id; });
    if (S.ui.termTaskId === id) { S.ui.termTaskId = null; S.ui.termConvId = null; syncPolling(); }
    if (S.ui.editingId === id) S.ui.editingId = null;
    commit();
  }

  function setType(taskId, typeId) {
    var t = taskById(taskId); if (!t) return;
    t.type = typeId;
    commit();
  }

  function move(id, delta) {
    var i = S.data.tasks.findIndex(function (t) { return t.id === id; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= S.data.tasks.length) return;
    S.data.tasks.splice(j, 0, S.data.tasks.splice(i, 1)[0]);
    commit();
  }

  /* ══ Actions — catégories ═════════════════════════════════════════════ */

  function addCat() {
    var name = S.ui.catName.trim();
    if (!name) return;
    var p = PALETTES.filter(function (x) { return x.id === S.ui.catPalette; })[0] || PALETTES[0];
    var t = { id: uid('k'), label: name, bg: p.bg, fg: p.fg, bd: p.bd, custom: true };
    S.data.types.push(t);
    S.ui.catFormOpen = false;
    S.ui.catName = '';
    S.ui.composerType = t.id;
    S.ui.composerOpen = true;
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

  function openComposer(at) {
    S.ui.composerOpen = true;
    S.ui.insertAt = at;
    S.ui.catFormOpen = S.data.types.length === 0;
    S.ui.termTaskId = null;
    S.ui.termConvId = null;
    syncPolling();
    render();
  }

  function closeComposer() {
    S.ui.composerOpen = false;
    S.ui.composerText = '';
    S.ui.catFormOpen = false;
    render();
  }

  function addFromComposer() {
    var text = S.ui.composerText.trim();
    if (!text || !S.ui.composerType) return;
    var t = { id: uid('n'), type: S.ui.composerType, text: text, done: false, doing: false, created: Date.now() };
    var at = S.ui.insertAt || 'top';
    var idx = 0;
    if (at === 'bottom') idx = S.data.tasks.length;
    else if (at !== 'top') {
      var j = S.data.tasks.findIndex(function (x) { return x.id === at; });
      idx = j < 0 ? 0 : j + 1;
    }
    S.data.tasks.splice(idx, 0, t);
    S.ui.composerOpen = false;
    S.ui.composerText = '';
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

  function setOver(id, before) {
    if (!S.ui.dragId || S.ui.dragId === id) return;
    if (S.ui.overId === id && S.ui.overBefore === before) return;
    S.ui.overId = id;
    S.ui.overBefore = before;
    markDrop();
  }

  function endDrag() {
    S.ui.dragId = null; S.ui.overId = null; S.ui.overBefore = null;
    $('#list').classList.remove('dragging');
    var d = $('#list').querySelector('.task.is-dragging');
    if (d) d.classList.remove('is-dragging');
    clearDropMarks();
  }

  function dropNow() {
    var dragId = S.ui.dragId, overId = S.ui.overId, overBefore = S.ui.overBefore;
    if (!dragId || !overId || dragId === overId) { endDrag(); return; }
    var from = S.data.tasks.findIndex(function (t) { return t.id === dragId; });
    if (from < 0) { endDrag(); return; }
    var moved = S.data.tasks.splice(from, 1)[0];
    var to = S.data.tasks.findIndex(function (t) { return t.id === overId; });
    if (to < 0) to = S.data.tasks.length; else if (!overBefore) to += 1;
    S.data.tasks.splice(to, 0, moved);
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
    S.ui.newConvoOpen = false;
    S.ui.transcript = null;
    syncPolling();
    render();
  }

  function openTranscript(convId) {
    S.ui.termConvId = convId;
    S.ui.newConvoOpen = false;
    S.ui.transcript = null;
    render();
    syncPolling();
    loadTranscript();
  }

  function backToList() {
    S.ui.termConvId = null;
    S.ui.transcript = null;
    syncPolling();
    render();
    refreshSessions();
  }

  /* Rafraîchit titre, compte et état de toutes les conversations, pas seulement celles du
     panneau ouvert : les cartes de tâches portent une pastille d'état. L'hôte ne relit que
     les transcripts qui ont changé. */
  function refreshSessions() {
    var convs = S.data.convos;
    if (!convs.length) return Promise.resolve();
    return bridge.call('getSessions', {
      sessions: convs.map(function (c) { return { sessionId: c.id, cwd: c.cwd, provider: providerOf(c) }; })
    }).then(function (res) {
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
        var before = displayState(c);
        var prev = S.ui.activity[c.id];
        var next = {
          exists: !!info.exists, state: info.state || 'idle', stateTs: toMs(info.stateTs),
          detail: info.detail || '', alive: typeof info.alive === 'boolean' ? info.alive : null
        };
        if (!prev || prev.exists !== next.exists || prev.state !== next.state
          || prev.stateTs !== next.stateTs || prev.detail !== next.detail || prev.alive !== next.alive) dirty = true;
        S.ui.activity[c.id] = next;
        if ((before === 'working' || before === 'waiting') && displayState(c) === 'ready') arrived.push(c);
      });
      if (changed) saveDataNow();
      /* Rien de neuf : on laisse la page tranquille (une relecture toutes les secondes et demie
         ne doit ni interrompre une sélection ni faire clignoter la liste). */
      if (changed || dirty) render();
      if (arrived.length) announce(arrived);
    })['catch'](function (e) { console.warn('[organizator] getSessions', e); });
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

  function pollSessions() {
    sessionsTimer = null;
    var again = function () { sessionsTimer = setTimeout(pollSessions, sessionsPollDelay()); };
    refreshSessions().then(again, again);
  }

  /* Relance immédiate (retour au premier plan, événement de l'hôte) : le prochain tour repart de zéro. */
  function restartSessionsPoll() {
    if (sessionsTimer) clearTimeout(sessionsTimer);
    sessionsTimer = setTimeout(pollSessions, sessionsPollDelay());
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

  function loadTranscript(silent) {
    var c = S.ui.termConvId ? convoById(S.ui.termConvId) : null;
    if (!c) return Promise.resolve();
    var token = ++transcriptToken;
    var id = c.id;
    return bridge.call('getTranscript', { sessionId: c.id, cwd: c.cwd, provider: providerOf(c) })
      .then(function (r) {
        if (token !== transcriptToken || S.ui.termConvId !== id) return;
        var next = { exists: !!(r && r.exists), messages: (r && r.messages) || [] };
        S.ui.sessionExists[id] = next.exists;
        if (silent && sameTranscript(S.ui.transcript, next)) return;
        S.ui.transcript = next;
        render();
      })['catch'](function (e) {
        if (token !== transcriptToken || S.ui.termConvId !== id) return;
        S.ui.transcript = { exists: false, messages: [], error: e.message };
        render();
      });
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

  /* Agent par défaut des réglages, ou l'autre s'il est le seul installé. */
  function defaultProviderId() {
    var wanted = S.settings.provider === 'copilot' ? 'copilot' : 'claude';
    var other = wanted === 'copilot' ? 'claude' : 'copilot';
    return !hasProvider(wanted) && hasProvider(other) ? other : wanted;
  }

  function openNewConvo() {
    S.ui.newConvoOpen = true;
    S.ui.newConvoCwd = defaultCwdFor(S.ui.termTaskId);
    setNewConvoProvider(defaultProviderId());
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
    startSession(task, provider, String(S.ui.newConvoModel || '').trim(), String(S.ui.newConvoEffort || '').trim(), cwd);
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
      String(S.settings[effortSettingKey(provider)] || '').trim(), cwd);
  }

  /* Lance une session dans PowerShell ; pour le carnet, les remarques en attente partent en premier message.
     Le bouton reste grisé (« Lancement… ») jusqu'à la réponse de l'hôte, puis un toast confirme. */
  function startSession(task, provider, model, effort, cwd) {
    if (S.ui.launchBusy) return;
    if (!hasProvider(provider)) { toast(providerById(provider).missing); return; }
    var feedback = task.id === FEEDBACK_ID;
    var pending = feedback ? pendingRemarks() : [];
    if (feedback && !pending.length) { toast('Aucune remarque à envoyer.'); return; }
    var title = feedback ? feedbackTitle(pending.length) : firstLine(task.text, 46);
    S.ui.launchBusy = true;
    render();
    bridge.call('startSession', {
      taskId: task.id, provider: provider, model: model, effort: effort, cwd: cwd, title: title,
      context: buildContext(task), prompt: feedback ? feedbackPrompt(pending) : ''
    })
      .then(function (r) {
        if (!r || !r.sessionId) throw new Error('réponse incomplète de l’hôte');
        var now = Date.now();
        S.data.convos.push({
          id: r.sessionId, taskId: task.id, provider: provider, model: model, effort: effort, title: title, cwd: r.cwd || cwd,
          created: toMs(r.created) || now, updated: toMs(r.created) || now, messageCount: 0
        });
        if (feedback) markRemarksSent(pending, r.sessionId);
        S.ui.sessionExists[r.sessionId] = false;
        S.ui.launchBusy = false;
        S.ui.newConvoOpen = false;
        S.ui.newConvoCwd = '';
        commit();
        toast(feedback
          ? (pending.length > 1 ? pending.length + ' remarques envoyées' : 'Remarque envoyée') + ' à ' + providerById(provider).label + ' dans PowerShell (' + lastSegment(cwd) + ')'
          : 'Session lancée dans PowerShell');
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
      context: task ? buildContext(task) : '', prompt: pending.length ? feedbackPrompt(pending) : ''
    }).then(function () {
      if (!pending.length) { toast('Session reprise dans PowerShell'); return; }
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

    'toggle-filter': function (el) {
      var id = el.getAttribute('data-id');
      S.ui.hidden = S.ui.hidden.indexOf(id) >= 0
        ? S.ui.hidden.filter(function (x) { return x !== id; })
        : S.ui.hidden.concat([id]);
      render();
    },

    gap: function (el) {
      if (S.ui.dragId) return;
      openComposer(el.getAttribute('data-gap'));
    },
    'add-tail': function () { openComposer('bottom'); },

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
    'open-term': function (el) { openTerm(el.getAttribute('data-id')); },

    'close-composer': closeComposer,
    'open-cat': function () { S.ui.catFormOpen = true; render(); },
    'close-cat': function () { S.ui.catFormOpen = false; S.ui.catName = ''; render(); },
    'add-cat': addCat,
    'pick-palette': function (el) { S.ui.catPalette = el.getAttribute('data-id'); render(); },
    'pick-type': function (el) { S.ui.composerType = el.getAttribute('data-id'); commit(); },
    'add-task': addFromComposer,

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
    'refresh-models': function () { refreshModels(true); },
    'launch-convo': launchConvo,
    'resume-convo': function (el) { resumeConvo(el.getAttribute('data-id')); },
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
    } else if (role === 'new-cwd') {
      S.ui.newConvoCwd = el.value;
    } else if (role === 'new-model') {
      S.ui.newConvoModel = el.value;
    } else if (role === 'set-model') {
      S.settings[modelSettingKey(el.getAttribute('data-provider'))] = el.value;
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

    if (role === 'new-model-select') {
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
    }
  });

  document.addEventListener('keydown', function (e) {
    var el = e.target;
    var role = el && el.getAttribute ? el.getAttribute('data-role') : null;

    if (role === 'edit-text' && e.key === 'Escape') { e.preventDefault(); S.ui.editingId = null; render(); return; }
    if (role === 'composer-text' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addFromComposer(); return; }
    if (role === 'cat-name' && e.key === 'Enter') { e.preventDefault(); addCat(); return; }
    if (role === 'remark-new' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addRemark(); return; }
    if ((role === 'new-cwd' || role === 'new-model') && e.key === 'Enter') { e.preventDefault(); launchConvo(); return; }

    if (e.key === 'Escape' && S.ui.settingsOpen) { S.ui.settingsOpen = false; render(); return; }

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
        if (last) setOver(last.id, false);
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

    S.data.tasks.forEach(function (t) {
      t.text = String(t.text == null ? '' : t.text);
      t.done = !!t.done;
      t.doing = !!t.doing;
      t.created = toMs(t.created) || Date.now();
    });
    S.data.convos.forEach(function (c) {
      c.provider = providerOf(c);
      c.model = String(c.model == null ? '' : c.model).trim();
      c.effort = String(c.effort == null ? '' : c.effort).trim();
      c.title = String(c.title == null ? '' : c.title);
      c.cwd = String(c.cwd == null ? '' : c.cwd);
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
    S.settings.terminal = S.settings.terminal === 'wt' ? 'wt' : 'powershell';
    S.settings.provider = S.settings.provider === 'copilot' ? 'copilot' : 'claude';
    S.settings.claudeModel = String(S.settings.claudeModel || '').trim();
    S.settings.copilotModel = String(S.settings.copilotModel || '').trim();
    S.settings.claudeEffort = String(S.settings.claudeEffort || '').trim();
    S.settings.copilotEffort = String(S.settings.copilotEffort || '').trim();

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
    });
    bridge.on('focus', function () {
      refreshSessions();
      restartSessionsPoll();
      refreshUsage(false);
      if (S.ui.termConvId) loadTranscript(true);
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

    bridge.call('getState').then(function (st) {
      normalize(st || {});
      render();
      refreshSessions();
      restartSessionsPoll();
      refreshUsage(true);
      if (S.env.hasClaude === false) toast(NO_CLAUDE);
      /* Catalogue Copilot absent ou vieux d'un jour : détection silencieuse en arrière-plan. */
      if (S.env.hasCopilot && catalogStale('copilot')) refreshModels(false);
    })['catch'](function (e) {
      normalize({});
      render();
      toast('Données illisibles : ' + e.message);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* Exposé pour le débogage et les tests manuels. */
  window.__organizator = { state: S, render: render, toast: toast, refreshSessions: refreshSessions, refreshUsage: refreshUsage };
})();
