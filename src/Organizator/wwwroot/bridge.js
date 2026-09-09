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
    repoDir: 'D:\\dev\\Organizator'
  };

  var SHIM_TRANSCRIPT = [
    { role: 'user', text: 'Fais le point sur cette tâche.', ts: Date.now() - 720000 },
    { role: 'assistant', text: 'Repéré le module concerné.\nJe propose de commencer par les tests.\nDis-moi si je lance.', ts: Date.now() - 700000 }
  ];

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
          claudeEffort: p.claudeEffort, copilotEffort: p.copilotEffort, repoDir: p.repoDir
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

      case 'openPath':
        console.log('[shim] openPath', p.path);
        return {};

      case 'log':
        console.log('[shim] log', p.level, p.message);
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
