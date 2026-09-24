/* ═══════════════════════════════════════════════════════════════════════════
   bridge.js — pont JS ↔ hôte WPF (WebView2)
   Expose window.bridge :
     call(type, payload, timeoutMs) -> Promise   requête/réponse corrélées par id, 15 s par défaut
     on(event, handler)  -> off()     événements poussés par l'hôte
     isShim                           vrai hors WebView2
   Hors WebView2 (navigateur ordinaire), un shim complet prend le relais :
   persistance localStorage, sessions simulées, pickFolder via prompt().
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var TIMEOUT = 15000;
  var pending = new Map();
  var handlers = new Map();
  var seq = 0;
  var wv = (window.chrome && window.chrome.webview) || null;

  /* ── Événements ─────────────────────────────────────────────────────── */
  function on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, []);
    handlers.get(name).push(fn);
    return function off() {
      var list = handlers.get(name) || [];
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  function emit(name, payload) {
    var list = handlers.get(name);
    if (!list) return;
    list.slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[bridge] handler ' + name, e); }
    });
  }

  /* ── Transport WebView2 ─────────────────────────────────────────────── */
  function settle(msg) {
    if (!msg) return;
    if (msg.event) { emit(msg.event, msg.payload || {}); return; }
    if (msg.id == null) return;
    var p = pending.get(String(msg.id));
    if (!p) return;
    pending.delete(String(msg.id));
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.payload || {});
    else p.reject(new Error(msg.error || 'Erreur inconnue de l’hôte.'));
  }

  function hostCall(type, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = String(++seq);
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error('L’hôte n’a pas répondu (' + type + ').'));
      }, timeoutMs || TIMEOUT);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        wv.postMessage({ id: id, type: type, payload: payload || {} });
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  if (wv) {
    wv.addEventListener('message', function (ev) {
      var m = ev.data;
      if (typeof m === 'string') {
        try { m = JSON.parse(m); } catch (e) { return; }
      }
      settle(m);
    });
  }

  /* ── Shim navigateur ────────────────────────────────────────────────── */
  var LS_DATA = 'organizator.data';
  var LS_SETTINGS = 'organizator.settings';

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    (window.crypto || {}).getRandomValues
      ? window.crypto.getRandomValues(b)
      : b.forEach(function (_, i) { b[i] = Math.floor(Math.random() * 256); });
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('')
      + '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }

  function lsRead(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : fallback;
    } catch (e) { return fallback; }
  }

  function lsWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('[shim] écriture impossible', e); }
  }

  var SHIM_ENV = {
    version: 'dev',
    hasClaude: true,
    hasCopilot: true,
    hasWt: true,
    models: {
      claude: { defaultModel: 'claude-fable-5-1[1m]', defaultEffort: 'xhigh', fetchedAt: 0, groups: [
        { key: 'alias', items: [{ id: 'fable' }, { id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }] },
        { key: 'used', items: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }] }
      ] },
      copilot: { defaultModel: 'claude-opus-4.6', defaultEffort: 'max', fetchedAt: 0, groups: [
        { key: 'auto', items: [{ id: 'auto', name: 'Auto' }] },
        { key: 'used', items: [{ id: 'gpt-5.6-luna' }] }
      ] }
    },
    efforts: { claude: ['low', 'medium', 'high', 'xhigh', 'max'], copilot: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    defaultCwd: 'C:\\Users\\moi\\Documents',
    dataDir: '(shim)',
    userProfile: 'C:\\Users\\moi',
    repoDir: 'D:\\dev\\Organizator',
    bitbucketUrl: 'https://git.exemple.com',
    bitbucketSource: 'claude.json',
    bitbucketToken: true,
    jiraUrl: 'https://jira.exemple.com'
  };

  /* PRs simulées de « Mes PRs Bitbucket » : deux dépôts pour un même ticket, une PR sans ticket,
     un brouillon. window.__fakePullRequests remplace la réponse entière pour les essais. */
  function shimPullRequests() {
    var now = Date.now();
    function pr(id, key, project, repo, title, branch, author, ago, extra) {
      return Object.assign({
        id: id, title: title, project: project, projectName: project, repo: repo, repoName: repo.toUpperCase(),
        branch: branch, target: 'develop', author: author,
        url: 'https://git.exemple.com/projects/' + project + '/repos/' + repo + '/pull-requests/' + id,
        created: now - ago, updated: now - ago / 2, comments: 0, openTasks: 0, draft: false, key: key
      }, extra || {});
    }
    return {
      status: 'ok', message: null, host: 'git.exemple.com', account: 'moi@exemple.com', jiraUrl: 'https://jira.exemple.com', fetchedAt: now,
      prs: [
        pr(455, 'UDM-1449', 'BRDM', 'dm-umisoft', 'Feature/UDM-1449 contact update umisoft preset', 'feature/UDM-1449-contact-update-umisoft-preset', 'Xavier LE MEN', 9 * 86400000, { comments: 5 }),
        pr(683, 'UDM-1449', 'BRDM', 'dm-standalone', 'Feature/UDM-1449 contact update umisoft preset', 'feature/UDM-1449-contact-update-umisoft-preset', 'Xavier LE MEN', 8 * 86400000),
        pr(730, 'UDM-1532', 'BRDM', 'dm-standalone', '[UDM-1532] fix tvg all chanel create contact', 'bugfix/UDM-1532-fix-tvg', 'Clément BONET', 3 * 86400000, { openTasks: 1 }),
        pr(499, '', 'BRDM', 'dm-umisoft', 'Ajout de trois configurations à Aspire', 'feature/aspire-configs', 'Nicolas FAGET', 86400000),
        pr(740, 'UDM-1600', 'BRDM', 'dm-standalone', '[UDM-1600] Correction THU', 'bugfix/UDM-1600-thu', 'Clément BONET', 3600000, { draft: true })
      ]
    };
  }

  var SHIM_TRANSCRIPT = [
    { role: 'user', text: 'Fais le point sur cette tâche.', ts: Date.now() - 720000 },
    { role: 'assistant', text: 'Repéré le module concerné.\nJe propose de commencer par les tests.\nDis-moi si je lance.', ts: Date.now() - 700000 }
  ];

  var SHIM_REPORT_HTML = '<h1 id="rapport-de-demonstration">Rapport de démonstration</h1>'
    + '<p>Ce document est <strong>rendu par le shim</strong> : dans Organizator, c’est l’hôte qui rend le Markdown (Markdig).</p>'
    + '<h2 id="constats">Constats</h2><ul><li>Le module <code>AgentArtifacts</code> détecte les fichiers écrits.</li>'
    + '<li>Un lien relatif : <a href="https://report.organizator/annexe.md">annexe.md</a> ; un lien externe : <a href="https://example.org/">example.org</a>.</li></ul>'
    + '<h2 id="suivi">Suivi</h2><ul class="contains-task-list"><li class="task-list-item"><input disabled="disabled" type="checkbox" class="task-list-item-checkbox" checked="checked" /> Lire le rapport</li>'
    + '<li class="task-list-item"><input disabled="disabled" type="checkbox" class="task-list-item-checkbox" /> Publier</li></ul>'
    + '<table><thead><tr><th>Fichier</th><th style="text-align: right;">Lignes</th></tr></thead><tbody><tr><td><code>app.js</code></td><td style="text-align: right;">4075</td></tr><tr><td><code>app.css</code></td><td style="text-align: right;">876</td></tr></tbody></table>'
    + '<blockquote><p>Une citation, pour l’allure.</p></blockquote>'
    + '<pre><code class="language-js">function lire() { return "ici"; }\n</code></pre>';

  function shimCall(type, payload) {
    payload = payload || {};
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try { resolve(shimHandle(type, payload)); } catch (e) { reject(e); }
      }, 40);
    });
  }

  function shimHandle(type, p) {
    var settings, data;
    switch (type) {
      case 'getState':
        data = lsRead(LS_DATA, { tasks: [], types: [], convos: [], remarks: [], lastType: null });
        settings = lsRead(LS_SETTINGS, {});
        return {
          data: {
            tasks: Array.isArray(data.tasks) ? data.tasks : [],
            types: Array.isArray(data.types) ? data.types : [],
            convos: Array.isArray(data.convos) ? data.convos : [],
            remarks: Array.isArray(data.remarks) ? data.remarks : [],
            lastType: data.lastType || null
          },
          settings: settings,
          env: Object.assign({}, SHIM_ENV, { defaultCwd: settings.defaultCwd || SHIM_ENV.defaultCwd })
        };

      case 'saveData':
        lsWrite(LS_DATA, {
          version: 1,
          tasks: p.tasks || [],
          types: p.types || [],
          convos: p.convos || [],
          remarks: p.remarks || [],
          lastType: p.lastType || null
        });
        return {};

      case 'saveSettings':
        lsWrite(LS_SETTINGS, {
          topCount: p.topCount, showBands: p.showBands, compact: p.compact,
          defaultCwd: p.defaultCwd, terminal: p.terminal,
          provider: p.provider, claudeModel: p.claudeModel, copilotModel: p.copilotModel,
          claudeEffort: p.claudeEffort, copilotEffort: p.copilotEffort, repoDir: p.repoDir, bitbucketUrl: p.bitbucketUrl,
          draftProvider: p.draftProvider, draftModel: p.draftModel, draftEffort: p.draftEffort
        });
        return {};

      case 'pickFolder': {
        var v = window.prompt('Dossier de travail', p.initial || SHIM_ENV.defaultCwd);
        return { path: v && v.trim() ? v.trim() : null };
      }

      case 'startSession':
        console.log('[shim] startSession', p);
        window.__lastSession = { type: type, payload: p };
        return { sessionId: uuid(), cwd: p.cwd, created: Date.now() };

      case 'resumeSession':
        console.log('[shim] resumeSession', p);
        window.__lastSession = { type: type, payload: p };
        return {};

      case 'getSessions': {
        var asked = (p.sessions || []);
        if (Array.isArray(window.__fakeSessions)) {
          var byId = {};
          window.__fakeSessions.forEach(function (s) { byId[s.sessionId] = s; });
          return {
            sessions: asked.map(function (s) {
              return byId[s.sessionId] || { sessionId: s.sessionId, exists: false, messageCount: 0, updated: 0, title: '' };
            })
          };
        }
        return {
          sessions: asked.map(function (s) {
            return { sessionId: s.sessionId, exists: false, messageCount: 0, updated: 0, title: '' };
          })
        };
      }

      case 'getRecaps': {
        /* Dernière réponse de chaque session : `answer` d'une session simulée, sinon un texte de démonstration. */
        var fakes = Array.isArray(window.__fakeSessions) ? window.__fakeSessions : [];
        return {
          sessions: (p.sessions || []).map(function (s) {
            var f = fakes.filter(function (x) { return x.sessionId === s.sessionId; })[0];
            var exists = !!f && f.exists !== false;
            return {
              sessionId: s.sessionId, exists: exists,
              answer: exists ? (f.answer || 'Réponse de démonstration : le travail est terminé, le rapport est écrit.') : ''
            };
          })
        };
      }

      case 'getTranscript': {
        var fake = Array.isArray(window.__fakeSessions)
          ? window.__fakeSessions.filter(function (s) { return s.sessionId === p.sessionId; })[0]
          : null;
        if (fake && fake.exists === false) return { exists: false, title: fake.title || '', messages: [] };
        return {
          exists: true,
          title: (fake && fake.title) || 'Session de démonstration',
          messages: SHIM_TRANSCRIPT.slice()
        };
      }

      case 'refreshModels':
        console.log('[shim] refreshModels', p);
        if (p.provider === 'claude') {
          return { claude: { defaultModel: 'claude-fable-5-1[1m]', defaultEffort: 'xhigh', fetchedAt: Date.now(), groups: [
            { key: 'alias', items: [{ id: 'fable' }, { id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }] },
            { key: 'anthropic', items: [
              { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
              { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
              { id: 'claude-opus-5', name: 'Claude Opus 5' },
              { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
              { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' }
            ] },
            { key: 'used', items: [{ id: 'claude-opus-4-6[1m]' }] }
          ] } };
        }
        return { copilot: { defaultModel: 'claude-opus-4.6', defaultEffort: 'max', fetchedAt: Date.now(), groups: [
          { key: 'auto', items: [{ id: 'auto', name: 'Auto' }] },
          { key: 'claude', items: [
            { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', usage: '1x', price: 'medium' },
            { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', usage: '15x', price: 'high' },
            { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', usage: '0.33x', price: 'low' }
          ] },
          { key: 'gpt', items: [
            { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', usage: '1x', price: 'medium' },
            { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', usage: '0.33x', price: 'low', enabled: false }
          ] },
          { key: 'gemini', items: [{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', usage: '14x', price: 'low' }] }
        ] } };

      case 'notify':
        console.log('[shim] notify', p);
        return { flashed: false };

      case 'getUsage':
        if (window.__fakeUsage) return window.__fakeUsage;
        return {
          fetchedAt: Date.now(),
          claude: { provider: 'claude', status: 'ok', message: null, plan: 'Max 5×', account: null, host: null, stale: false, fetchedAt: Date.now(), bars: [
            { key: 'session', scope: null, percent: 71, used: null, limit: null, overage: false, resetsAt: Date.now() + 60000 },
            { key: 'weekly', scope: null, percent: 28, used: null, limit: null, overage: false, resetsAt: Date.now() + 5 * 86400000 },
            { key: 'weekly', scope: 'Fable', percent: 50, used: null, limit: null, overage: false, resetsAt: Date.now() + 5 * 86400000 }
          ] },
          copilot: { provider: 'copilot', status: 'ok', message: null, plan: 'Business', account: 'moi', host: 'github.com', stale: false, fetchedAt: Date.now(), bars: [
            { key: 'premium', scope: null, percent: 12, used: 960, limit: 8000, overage: true, resetsAt: Date.now() + 20 * 86400000 }
          ] }
        };

      case 'getPullRequests':
        console.log('[shim] getPullRequests');
        if (window.__fakePullRequests === 'error') throw new Error('réseau simulé indisponible');
        return window.__fakePullRequests || shimPullRequests();

      case 'draftText': {
        console.log('[shim] draftText', p);
        window.__lastDraft = p;
        /* Texte simulé : window.__fakeDraft le remplace pour les essais. */
        if (window.__fakeDraft === 'error') throw new Error('Claude Code n’est pas connecté.');
        return {
          text: window.__fakeDraft || 'Description: proposition simulée du shim\nConsigne: Vérifie la cause, corrige-la, puis explique en deux lignes ce qui a changé.',
          ms: 1200, provider: p.provider, model: p.model
        };
      }

      case 'openPath':
        console.log('[shim] openPath', p.path, p.editor || '');
        return { editor: p.editor === 'vscode' ? 'vscode' : (p.editor === 'default' ? 'default' : 'explorer') };

      case 'openUrl':
        console.log('[shim] openUrl', p.url);
        return { opened: true };

      case 'readArtifact': {
        /* Rapport simulé : window.__fakeArtifact le remplace pour les essais (mêmes champs). */
        console.log('[shim] readArtifact', p.path, p.stamp || '');
        if (window.__fakeArtifact) {
          if (p.stamp && p.stamp === window.__fakeArtifact.stamp) return { changed: false, stamp: p.stamp };
          return Object.assign({ changed: true }, window.__fakeArtifact);
        }
        if (p.stamp === 'shim-1') return { changed: false, stamp: 'shim-1' };
        var rel = String(p.path || 'rapport.md').replace(/\//g, '\\');
        return {
          changed: true, kind: 'markdown',
          full: 'C:\\Users\\moi\\Documents\\' + rel, root: 'C:\\Users\\moi\\Documents',
          url: 'https://report.organizator/' + String(p.path || 'rapport.md'),
          title: 'Rapport de démonstration', stamp: 'shim-1', size: 2480, modified: Date.now() - 90000,
          html: SHIM_REPORT_HTML
        };
      }

      case 'log':
        console.log('[shim] log', p.level, p.message);
        return {};

      case 'perf':
        return {};

      default:
        throw new Error('Type de message inconnu : ' + type);
    }
  }

  window.bridge = {
    call: wv ? hostCall : shimCall,
    on: on,
    isShim: !wv
  };
})();
