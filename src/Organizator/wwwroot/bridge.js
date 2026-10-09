/* ═══════════════════════════════════════════════════════════════════════════
   bridge.js — pont JS ↔ hôte WPF (WebView2)
   Expose window.bridge :
     call(type, payload, timeoutMs, files) -> Promise   requête/réponse corrélées par id, 15 s par défaut ;
                                      `files` (File[]) : l'hôte en reçoit les chemins
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

  /* `files` : des objets File (dépôt, collage) dont l'hôte lit le chemin — WebView2 les passe par
     postMessageWithAdditionalObjects, la page n'en connaît que le nom. */
  function hostCall(type, payload, timeoutMs, files) {
    return new Promise(function (resolve, reject) {
      var id = String(++seq);
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error('L’hôte n’a pas répondu (' + type + ').'));
      }, timeoutMs || TIMEOUT);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        var msg = { id: id, type: type, payload: payload || {} };
        if (files && files.length) {
          if (!wv.postMessageWithAdditionalObjects) throw new Error('WebView2 trop ancien pour transmettre des fichiers.');
          wv.postMessageWithAdditionalObjects(msg, files);
        } else {
          wv.postMessage(msg);
        }
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        /* Rien n'est parti : l'appelant peut essayer autrement (fichiers envoyés par leur contenu). */
        try { e.notSent = true; } catch (err) { /* objet figé */ }
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
    jiraUrl: 'https://jira.exemple.com',
    /* Pièces jointes : pas de fichiers servis hors WebView2, sauf si un essai fournit une adresse
       (window.__shimAttachUrl) où poser les vignettes. */
    attachmentsDir: 'C:\\Users\\moi\\AppData\\Local\\Organizator\\attachments',
    attachmentsUrl: ''
  };

  /* Pièce jointe simulée : le shim ne copie rien, il rend ce que l'hôte aurait rendu. */
  function shimAttachment(taskId, name, size) {
    var clean = String(name || 'fichier').replace(/[\\\/:*?"<>|]/g, '_');
    return {
      name: clean, size: size || 0,
      path: SHIM_ENV.attachmentsDir + '\\' + taskId + '\\' + clean,
      kind: /\.(png|jpe?g|gif|webp|bmp)$/i.test(clean) ? 'image' : 'file'
    };
  }

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

  /* Revue simulée : un fichier nommé review-… s'ouvre sur la vue revue, comme avec l'hôte. */
  function shimReview() {
    function finding(id, severity, title, category, where, tags, body) {
      return { id: id, severity: severity, title: title, category: category, where: where, tags: tags,
        html: '<p><strong>Le problème en clair</strong></p><p>' + body + '</p><pre><code>var x = lire();\n</code></pre>' };
    }
    return {
      verdict: '🔴 Ne pas merger en l’état', level: 'blocker',
      findings: [
        finding('C1', 'blocker', 'L’import lit mal les en-têtes de canal : les `bookmarks` disparaissent', 'correction',
          '`dm-standalone` · `Cache/XTF/PacketXTFChannel.cs:35`', ['#756'], 'Un champ inséré décale toute la structure.'),
        finding('C2', 'major', 'Aucun test ajouté', 'tests', '`DM.Cache.Tests/ChannelTests.cs`', [], 'Un test aurait bloqué C1.'),
        finding('C3', 'minor', 'La détection « ground » diffère selon l’endroit du code', 'correction',
          '`XTFCache.cs:1129`', [], 'Trois tests différents pour la même question.'),
        finding('C4', 'info', 'Historique de branche difficile à lire', 'historique', '', [], 'Un commit « s ».')
      ]
    };
  }

  /* Article du jour et veille IA simulés (`kind` : 'daily' par défaut, ou 'ai') : `peek` rend ce qui
     est gardé, `today` en fabrique un s'il manque celui du jour, `another` en fabrique un autre.
     window.__fakeArticleStore (veille IA : __fakeArticleStoreAi) impose l'état gardé ;
     window.__fakeArticle (__fakeArticleAi) impose la fiche fabriquée, ou 'error' fait échouer la recherche. */
  function shimArticleAi(p) { return !!p && p.kind === 'ai'; }

  function shimArticleStore(p) {
    var key = shimArticleAi(p) ? '__fakeArticleStoreAi' : '__fakeArticleStore';
    if (!window[key]) window[key] = { version: 1, current: null, history: [] };
    return window[key];
  }

  function shimToday() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function shimArticle(p) {
    var store = shimArticleStore(p);
    var ai = shimArticleAi(p);
    var fake = ai ? window.__fakeArticleAi : window.__fakeArticle;
    (window.__articleCalls = window.__articleCalls || []).push(p);
    if (p.mode === 'peek' || (p.mode !== 'another' && store.current && store.current.day === shimToday())) {
      return Object.assign({}, store, { busy: false });
    }
    if (fake === 'error') throw new Error('Claude Code n’est pas connecté : ouvrez un terminal, lancez l’agent et connectez-vous.');
    var n = (store.history.length + (store.current ? 1 : 0)) + 1;
    var card = Object.assign(ai ? {
      title: 'What the new coding agents change for code review (' + n + ')',
      url: 'https://exemple.org/ia/' + n, source: 'exemple.org', author: 'Grace Hopper', published: shimToday(), language: 'en',
      readingMinutes: 6, topic: 'Agents de code en revue de PR',
      summary: 'Résumé simulé : un laboratoire publie un agent qui relit les pull requests de bout en bout ; premiers retours et limites.',
      keyPoints: ['L’agent lit le ticket avant le diff.', 'Les faux positifs baissent de moitié.', 'La décision reste humaine.'],
      why: 'Vous relisez des PRs avec des agents : voici ce que la nouvelle génération change.'
    } : {
      title: 'Migrate from Newtonsoft.Json to System.Text.Json in a large codebase (' + n + ')',
      url: 'https://exemple.org/articles/' + n, source: 'exemple.org', author: 'Ada Lovelace', published: '2026-05-30', language: 'en',
      readingMinutes: 8, topic: 'Newtonsoft Licence Risk',
      summary: 'Résumé simulé : comment sortir de Newtonsoft.Json sans casser le contrat JSON, en six étapes et un déploiement progressif.',
      keyPoints: ['Capturer des échantillons JSON avant de migrer.', 'Migrer une assembly à la fois.', 'Mutualiser les JsonSerializerOptions.'],
      why: 'Vous évaluez le risque lié à Newtonsoft.Json : voici un plan de sortie réaliste.'
    }, fake || {}, { day: shimToday(), fetchedAt: Date.now(), model: 'sonnet', ms: 32000, seenAt: 0 });
    if (store.current) store.history.unshift(store.current);
    store.current = card;
    return Object.assign({}, store, { busy: false });
  }

  /* Discussions sur les constats, simulées : une par rapport + constat. `askFinding` pousse
     l'avancement (`findingChat`) puis rend la discussion ; window.__fakeFindingAnswer impose la
     réponse (ou 'error'), window.__fakeFindingDelay sa durée (1,2 s) ; chaque question est notée
     dans window.__findingAsks. */
  var shimChats = {};
  var shimRuns = {};

  function shimChatKey(report, finding) { return String(report || '').toLowerCase() + '|' + finding; }

  function shimEscape(s) {
    return String(s || '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function shimAskFinding(p) {
    var f = p.finding || {};
    var key = shimChatKey(p.report, f.key);
    (window.__findingAsks = window.__findingAsks || []).push(p);
    if (shimRuns[key]) throw new Error('L’agent répond déjà sur ce constat.');
    var startedAt = Date.now();
    var delay = window.__fakeFindingDelay || 1200;
    var run = shimRuns[key] = { stopped: false };
    function progress(phase, text, steps) {
      emit('findingChat', { report: p.report, finding: f.key, phase: phase, q: p.question, text: text || '',
        html: text ? '<p>' + shimEscape(text) + '</p>' : '', steps: steps || [], startedAt: startedAt });
    }
    progress('thinking');
    setTimeout(function () { if (!run.stopped) progress('tool', '', ['Lit Calc.cs']); }, delay * 0.25);
    setTimeout(function () { if (!run.stopped) progress('writing', 'Parce que la division…', ['Lit Calc.cs']); }, delay * 0.5);
    return new Promise(function (resolve) {
      var timer = setInterval(function () {
        if (!run.stopped && Date.now() - startedAt < delay) return;
        clearInterval(timer);
        delete shimRuns[key];
        var chat = shimChats[key] || { report: p.report, finding: f.key, created: Date.now(), turns: [],
          sessionId: '', source: '', cwd: p.cwd, model: p.model, effort: p.effort };
        var fail = run.stopped ? 'Arrêtée à votre demande.' : (window.__fakeFindingAnswer === 'error' ? 'Claude Code n’est pas connecté.' : '');
        var answer = fail ? '' : (window.__fakeFindingAnswer || 'Parce que **la division par zéro** fait planter l’appelant : `Calc.cs:5`.');
        if (!fail && !chat.sessionId) { chat.sessionId = uuid(); chat.source = p.source || ''; }
        chat.findingId = f.id; chat.title = f.title; chat.severity = f.severity; chat.updated = Date.now();
        chat.turns = chat.turns.concat([{ q: p.question, a: answer, html: answer ? '<p>' + shimEscape(answer) + '</p>' : '',
          at: Date.now(), ms: Date.now() - startedAt, cost: 0, error: fail }]);
        shimChats[key] = chat;
        progress('done');
        resolve(JSON.parse(JSON.stringify(chat)));
      }, 50);
    });
  }

  /* Whisper simulé : modèles, téléchargement et transcription, avec l'avancement (événement `whisper`).
     window.__fakeWhisper impose l'état des modèles, window.__fakeTranscript le texte rendu ('error' fait
     échouer), window.__fakeTranscribeDelay la durée (600 ms) ; chaque appel est noté dans window.__transcribes. */
  var shimWhisperModels = [
    { id: 'base', label: 'Base', size: 147951465, note: 'Le plus rapide (moins d’une seconde pour une dictée), mais approximatif en français.', downloaded: false },
    { id: 'small', label: 'Small', size: 487601967, note: 'Le bon compromis : quelques secondes pour une dictée, un enregistrement transcrit environ six fois plus vite que sa durée.', downloaded: true },
    { id: 'large-v3-turbo-q5_0', label: 'Large v3 Turbo', size: 574041195, note: 'Le plus précis (noms propres, termes techniques), mais cinq à six fois plus lent que Small sur le processeur.', downloaded: false }
  ];
  var shimJobs = {};

  function shimWhisperStatus() {
    if (window.__fakeWhisper) return window.__fakeWhisper;
    return {
      dir: 'C:\\Users\\moi\\AppData\\Local\\Organizator\\whisper', loaded: null,
      models: shimWhisperModels.map(function (m) { return Object.assign({ downloading: false, received: 0, total: 0 }, m); }),
      extensions: ['mp3', 'wav', 'm4a', 'aac', 'wma', 'ogg', 'oga', 'opus', 'flac', 'webm', 'mp4', 'm4v', 'mov', '3gp', 'amr', 'mkv']
    };
  }

  function shimDownloadWhisper(p) {
    var m = shimWhisperModels.filter(function (x) { return x.id === p.model; })[0];
    if (!m) return Promise.reject(new Error('Modèle Whisper inconnu : ' + p.model));
    return new Promise(function (resolve) {
      [0.25, 0.5, 0.75].forEach(function (f, i) {
        setTimeout(function () { emit('whisper', { phase: 'download', model: m.id, received: Math.round(m.size * f), total: m.size }); }, 150 * (i + 1));
      });
      setTimeout(function () {
        m.downloaded = true;
        emit('whisper', { phase: 'downloaded', model: m.id });
        resolve(shimWhisperStatus());
      }, 600);
    });
  }

  function shimTranscribe(p) {
    (window.__transcribes = window.__transcribes || []).push({
      job: p.job, path: p.path || '', data: p.data ? String(p.data).length : 0, model: p.model, language: p.language
    });
    var delay = window.__fakeTranscribeDelay == null ? 600 : window.__fakeTranscribeDelay;
    var run = shimJobs[p.job] = { stopped: false };
    return new Promise(function (resolve, reject) {
      var steps = [{ phase: 'decode' }, { phase: 'load' }, { phase: 'transcribe', percent: 0 }, { phase: 'transcribe', percent: 50 }];
      steps.forEach(function (s, i) {
        setTimeout(function () { if (!run.stopped) emit('whisper', Object.assign({ job: p.job }, s)); }, delay * i / steps.length);
      });
      setTimeout(function () {
        delete shimJobs[p.job];
        if (run.stopped) { reject(new Error('Transcription interrompue.')); return; }
        if (window.__fakeTranscript === 'error') { reject(new Error('Windows ne sait pas lire cet enregistrement.')); return; }
        var text = window.__fakeTranscript != null ? String(window.__fakeTranscript)
          : (p.path ? 'Compte rendu de démonstration : le ticket est presque terminé, il reste les tests.' : 'texte dicté de démonstration');
        resolve({ job: p.job, text: text, language: p.language === 'auto' ? 'fr' : p.language, duration: p.path ? 102.9 : 4.2, ms: delay, model: p.model });
      }, delay);
    });
  }

  /* Conversation vocale simulée (moteur voice-engine.js : mode Conversation, Tuteur). `voiceSay` rend le tour aussitôt puis
     pousse l'évènement `voice` : thinking, une étape `tool` si window.__fakeVoiceTool, les phrases de
     window.__fakeVoiceReply (tableau, ou 'error' pour un échec), puis done ; window.__fakeVoiceDelay
     espace les phrases (350 ms). `voiceSpeak` rend un WAV synthétique (voyelles modulées, durée selon
     le texte) ; window.__fakeVoiceSpeak = 'error' le fait échouer (repli speechSynthesis),
     window.__fakeVoiceSpeakDelay retarde la réponse. window.__fakeVoiceVoices remplace la liste des voix.
     Chaque appel est noté dans window.__voiceCalls ({ type, payload, at }). */
  var shimVoice = { convs: {}, turn: 0 };

  function shimVoiceLog(type, p) {
    (window.__voiceCalls = window.__voiceCalls || []).push({ type: type, payload: JSON.parse(JSON.stringify(p || {})), at: Date.now() });
  }

  function shimVoiceSay(p) {
    var conv = shimVoice.convs[p.conversationId];
    if (!conv) throw new Error('Conversation terminée : rouvrez le mode Conversation.');
    var turn = ++shimVoice.turn;
    conv.turn = turn;
    var tutor = conv.options && conv.options.mode === 'tutor';
    var reply = tutor ? shimTutorReply(conv, p) : (window.__fakeVoiceReply || [
      'Avec plaisir, parlons des volcans !',
      'Un volcan, c’est une ouverture dans la croûte terrestre par laquelle le magma remonte à la surface.',
      'Vous voulez qu’on parle d’un volcan en particulier, l’Etna ou le Piton de la Fournaise par exemple ?'
    ]);
    var gap = window.__fakeVoiceDelay || 350;
    var steps = [{ phase: 'thinking' }];
    if (window.__fakeVoiceTool) steps.push({ phase: 'tool', text: 'Recherche web…' });
    if (reply === 'error') {
      steps.push({ phase: 'error', error: 'Claude Code ne répond pas : vérifiez qu’il est connecté.' });
    } else {
      var full = '';
      reply.forEach(function (t) { full += (full ? ' ' : '') + t; steps.push({ phase: 'sentence', text: t, full: full }); });
      var meta = tutor ? shimTutorMeta(p, full) : null;
      if (meta) steps.push({ phase: 'meta', meta: meta });
      steps.push({ phase: 'done', full: full });
    }
    steps.forEach(function (st, i) {
      setTimeout(function () {
        if (conv.turn !== turn || conv.stopped) return;
        emit('voice', Object.assign({ conversationId: p.conversationId, turn: turn, text: '', full: '', error: '' }, st));
      }, 120 + i * gap);
    });
    return { turn: turn };
  }

  /* Mode tutor (Tuteur de Révizator) : réplique anglaise, puis la phase `meta` (traduction, reformulation,
     aide, fin) entre la dernière phrase et `done`, comme l'hôte. window.__fakeTutorReply (tableau) remplace
     la réplique ; window.__fakeTutorMeta remplace la meta ('none' : pas de meta). La reformulation
     factice reprend « since two weeks » → « for two weeks » quand l'apprenant l'a dit. */
  function shimTutorReply(conv, p) {
    if (window.__fakeTutorReply) return window.__fakeTutorReply;
    var t = conv.options.tutor || {}, sc = t.scenario || {};
    if (/^\s*\(/.test(String(p.text || ''))) {
      return ['Hi there, welcome!', 'I’m ' + (sc.tutorRole || 'your tutor') + ', so what can I do for you today?'];
    }
    if (/since two weeks/i.test(p.text)) return ['Oh, for two weeks, that’s quite a while.', 'How are you finding it so far?'];
    return ['That sounds really interesting.', 'Could you tell me a little more about it?'];
  }

  function shimTutorMeta(p, full) {
    var fm = window.__fakeTutorMeta;
    if (fm === 'none') return null;
    if (fm) return fm;
    var text = String(p.text || '');
    if (/^\s*\(/.test(text)) return { replyFr: 'Bonjour, bienvenue ! Que puis-je faire pour vous aujourd’hui ? (simulation)', recast: { said: '', better: '' }, tipFr: '', end: false };
    var m = /since two weeks/i.exec(text);
    return {
      replyFr: 'Traduction (simulation) : ' + full,
      recast: m ? { said: m[0], better: 'for two weeks' } : { said: '', better: '' },
      tipFr: m ? 'Pour une durée, « for » + durée ; « since » + point de départ.' : '',
      end: /\b(bye|goodbye)\b/i.test(text)
    };
  }

  /* Un WAV mono 16 bits : une « voix » en dents de scie filtrée, modulée en syllabes de 4 à 6 Hz. */
  function shimVoiceWav(text) {
    var rate = 22050, secs = Math.max(0.6, Math.min(6, String(text || '').length * 0.055));
    var n = Math.floor(rate * secs), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    var lp = 0;
    for (var i = 0; i < n; i++) {
      var t = i / rate, f0 = 150 + 25 * Math.sin(t * 2.1);
      var saw = 2 * ((t * f0) % 1) - 1;
      lp += 0.18 * (saw - lp);
      var env = Math.max(0, Math.sin(Math.PI * t * (4 + Math.sin(t * 1.3)))) * Math.min(1, t * 20, (secs - t) * 20);
      v.setInt16(44 + i * 2, Math.round(lp * env * 0.5 * 32767), true);
    }
    var bytes = new Uint8Array(buf), bin = '';
    for (var k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
    return { audio: btoa(bin), ms: Math.round(secs * 1000) };
  }

  function shimVoiceSpeak(p) {
    if (window.__fakeVoiceSpeak === 'error') throw new Error('Aucune voix Windows installée.');
    var out = shimVoiceWav(p.text);
    var delay = window.__fakeVoiceSpeakDelay || 0;
    return delay ? new Promise(function (resolve) { setTimeout(function () { resolve(out); }, delay); }) : out;
  }

  function shimCall(type, payload) {
    payload = payload || {};
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try { resolve(shimHandle(type, payload)); } catch (e) { reject(e); }
      }, 40);
    });
  }

  /* Simulations ajoutées par les pages (Révizator) : shimRegister(type, fn) ; fn(payload, emit) rend la
     réponse, une Promise, ou undefined pour laisser la main au shim d’origine (ex. « transcribe »). */
  var shimExtra = Object.create(null);
  function shimRegister(type, fn) { if (type && typeof fn === 'function') shimExtra[type] = fn; }

  function shimHandle(type, p) {
    var settings, data;
    if (shimExtra[type]) {
      var extra = shimExtra[type](p, emit);
      if (extra !== undefined) return extra;
    }
    switch (type) {
      case 'getState':
        data = lsRead(LS_DATA, { tasks: [], types: [], convos: [], remarks: [], notifications: [], lastType: null });
        settings = lsRead(LS_SETTINGS, {});
        return {
          data: {
            tasks: Array.isArray(data.tasks) ? data.tasks : [],
            types: Array.isArray(data.types) ? data.types : [],
            convos: Array.isArray(data.convos) ? data.convos : [],
            remarks: Array.isArray(data.remarks) ? data.remarks : [],
            notifications: Array.isArray(data.notifications) ? data.notifications : [],
            lastType: data.lastType || null
          },
          settings: settings,
          env: Object.assign({}, SHIM_ENV, {
            defaultCwd: settings.defaultCwd || SHIM_ENV.defaultCwd,
            attachmentsUrl: window.__shimAttachUrl || '',
            whisper: shimWhisperStatus()
          })
        };

      case 'saveData':
        lsWrite(LS_DATA, {
          version: 1,
          tasks: p.tasks || [],
          types: p.types || [],
          convos: p.convos || [],
          remarks: p.remarks || [],
          notifications: p.notifications || [],
          lastType: p.lastType || null
        });
        return {};

      case 'saveSettings':
        lsWrite(LS_SETTINGS, {
          topCount: p.topCount, showBands: p.showBands, compact: p.compact,
          defaultCwd: p.defaultCwd, terminal: p.terminal, termClick: p.termClick,
          provider: p.provider, claudeModel: p.claudeModel, copilotModel: p.copilotModel,
          claudeEffort: p.claudeEffort, copilotEffort: p.copilotEffort, repoDir: p.repoDir, bitbucketUrl: p.bitbucketUrl,
          draftProvider: p.draftProvider, draftModel: p.draftModel, draftEffort: p.draftEffort,
          articleEnabled: p.articleEnabled, articleTopics: p.articleTopics, articleAiEnabled: p.articleAiEnabled,
          articleModel: p.articleModel, articleEffort: p.articleEffort,
          windowsNotifications: p.windowsNotifications,
          whisperEnabled: p.whisperEnabled, whisperAuto: p.whisperAuto, whisperModel: p.whisperModel, whisperLanguage: p.whisperLanguage,
          voiceModel: p.voiceModel, voiceEffort: p.voiceEffort, voiceVoice: p.voiceVoice, voiceRate: p.voiceRate,
          voicePersona: p.voicePersona, voiceTopic: p.voiceTopic, voiceInstructions: p.voiceInstructions, voiceWeb: p.voiceWeb,
          voiceWhisperModel: p.voiceWhisperModel, voiceSensitivity: p.voiceSensitivity
        });
        return {};

      case 'pickFolder': {
        var v = window.prompt('Dossier de travail', p.initial || SHIM_ENV.defaultCwd);
        return { path: v && v.trim() ? v.trim() : null };
      }

      case 'startSession': {
        /* Chaque lancement est noté dans window.__sessions ; window.__fakeStartError(payload), s'il
           rend un message, fait échouer celui-là (lancements groupés, échec partiel). */
        console.log('[shim] startSession', p);
        window.__lastSession = { type: type, payload: p };
        (window.__sessions = window.__sessions || []).push({ payload: p, at: Date.now() });
        var failure = typeof window.__fakeStartError === 'function' ? window.__fakeStartError(p) : '';
        if (failure) throw new Error(String(failure));
        return { sessionId: uuid(), cwd: p.cwd, created: Date.now() };
      }

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
        /* window.__fakeLogs[sessionId] impose les messages du journal (essais du rendu). */
        var log = window.__fakeLogs && window.__fakeLogs[p.sessionId];
        if (Array.isArray(log)) return { exists: true, title: (fake && fake.title) || 'Session de démonstration', messages: log.slice() };
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
        /* Chaque appel est noté dans window.__notifies (notifications Windows demandées). */
        console.log('[shim] notify', p);
        (window.__notifies = window.__notifies || []).push(p);
        return { flashed: false, shown: 0 };

      case 'badge':
        window.__badge = p.count;
        return {};

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

      case 'getArticle':
        return shimArticle(p);

      case 'articleSeen': {
        var seen = shimArticleStore(p);
        if (seen.current && seen.current.url === p.url && !seen.current.seenAt) seen.current.seenAt = Date.now();
        return Object.assign({}, seen, { busy: false });
      }

      case 'openPath':
        console.log('[shim] openPath', p.path, p.editor || '');
        return { editor: p.editor === 'vscode' ? 'vscode' : (p.editor === 'default' ? 'default' : 'explorer') };

      case 'openUrl':
        console.log('[shim] openUrl', p.url);
        return { opened: true };

      case 'readArtifact': {
        /* Rapport simulé : window.__fakeArtifacts[chemin], puis window.__fakeArtifact, le remplacent
           pour les essais (mêmes champs) ; chaque lecture est notée dans window.__reads. */
        console.log('[shim] readArtifact', p.path, p.stamp || '');
        (window.__reads = window.__reads || []).push({ path: p.path, stamp: p.stamp || '' });
        var fakeArt = (window.__fakeArtifacts && window.__fakeArtifacts[p.path]) || window.__fakeArtifact;
        if (fakeArt) {
          if (p.stamp && p.stamp === fakeArt.stamp) return { changed: false, stamp: p.stamp };
          return Object.assign({ changed: true }, fakeArt);
        }
        if (p.stamp === 'shim-1') return { changed: false, stamp: 'shim-1' };
        var rel = String(p.path || 'rapport.md').replace(/\//g, '\\');
        var isReview = /(^|[\\\/])(review|revue)[-_ .][^\\\/]*$/i.test(rel);
        return {
          changed: true, kind: 'markdown',
          full: 'C:\\Users\\moi\\Documents\\' + rel, root: 'C:\\Users\\moi\\Documents',
          url: 'https://report.organizator/' + String(p.path || 'rapport.md'),
          title: isReview ? 'Revue UDM-1673 — démonstration' : 'Rapport de démonstration',
          stamp: 'shim-1', size: 2480, modified: Date.now() - 90000,
          html: SHIM_REPORT_HTML, review: isReview ? shimReview() : null
        };
      }

      case 'getFindingChats': {
        var rep = String(p.report || '').toLowerCase() + '|';
        return {
          report: p.report,
          chats: Object.keys(shimChats).filter(function (k) { return k.indexOf(rep) === 0; })
            .map(function (k) { return JSON.parse(JSON.stringify(shimChats[k])); }),
          running: []
        };
      }

      case 'askFinding':
        return shimAskFinding(p);

      case 'stopFinding': {
        var run = shimRuns[shimChatKey(p.report, p.finding)];
        if (run) run.stopped = true;
        return { stopped: !!run };
      }

      case 'forgetFinding': {
        var k = shimChatKey(p.report, p.finding);
        var had = !!shimChats[k];
        delete shimChats[k];
        return { removed: had };
      }

      case 'addAttachments': {
        /* Sélecteur : un fichier de démonstration ; dépôt : les noms que la page a joints (`names`). */
        console.log('[shim] addAttachments', p.taskId, p.pick ? 'sélecteur' : (p.names || []).join(', '));
        window.__lastAttach = p;
        var names = p.pick ? ['cahier-des-charges.pdf'] : (p.names || []);
        return {
          attachments: names.map(function (n) { return shimAttachment(p.taskId, n, 48213); }),
          skipped: [], unresolved: []
        };
      }

      case 'pasteAttachment':
        console.log('[shim] pasteAttachment', p.taskId, p.name, String(p.data || '').length);
        return { attachments: [shimAttachment(p.taskId, p.name, Math.round(String(p.data || '').length * 0.75))], skipped: [] };

      case 'writeAttachmentText':
        return shimAttachment(p.taskId, 'texte-' + p.id + '.txt', String(p.text || '').length);

      case 'removeAttachment':
      case 'removeAttachments':
        console.log('[shim] ' + type, p.path || p.taskId);
        return { removed: true };

      case 'whisperStatus':
        return shimWhisperStatus();

      case 'whisperWarm':
        window.__whisperWarm = (window.__whisperWarm || 0) + 1;
        return {};

      case 'whisperDownload':
        return shimDownloadWhisper(p);

      case 'whisperRemove': {
        var wm = shimWhisperModels.filter(function (x) { return x.id === p.model; })[0];
        var present = !!(wm && wm.downloaded);
        if (wm) wm.downloaded = false;
        return { removed: present };
      }

      case 'transcribe':
        return shimTranscribe(p);

      case 'cancelTranscribe': {
        var tj = shimJobs[p.job];
        if (tj) tj.stopped = true;
        return { cancelled: !!tj };
      }

      case 'voiceStart': {
        shimVoiceLog(type, p);
        Object.keys(shimVoice.convs).forEach(function (k) { shimVoice.convs[k].stopped = true; });
        var cid = uuid();
        shimVoice.convs[cid] = { turn: 0, stopped: false, options: p };
        return { conversationId: cid };
      }

      case 'voiceSay':
        shimVoiceLog(type, p);
        return shimVoiceSay(p);

      case 'voiceInterrupt': {
        shimVoiceLog(type, p);
        var vc = shimVoice.convs[p.conversationId];
        if (vc) vc.turn = -1;
        return {};
      }

      case 'voiceStop':
        shimVoiceLog(type, p);
        if (shimVoice.convs[p.conversationId]) shimVoice.convs[p.conversationId].stopped = true;
        delete shimVoice.convs[p.conversationId];
        return {};

      case 'voiceVoices':
        shimVoiceLog(type, p);
        return window.__fakeVoiceVoices || {
          voices: [
            { id: 'shim-hortense', name: 'Microsoft Hortense', lang: 'fr-FR', gender: 'female' },
            { id: 'shim-paul', name: 'Microsoft Paul', lang: 'fr-FR', gender: 'male' },
            { id: 'shim-zira', name: 'Microsoft Zira', lang: 'en-US', gender: 'female' }
          ],
          default: 'shim-hortense'
        };

      case 'voiceSpeak':
        shimVoiceLog(type, { text: p.text, voice: p.voice, rate: p.rate });
        return shimVoiceSpeak(p);

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
  /* Hors WebView2 seulement : de quoi simuler les messages d’une page et pousser ses événements. */
  if (!wv) {
    window.bridge.shimRegister = shimRegister;
    window.bridge.shimEmit = emit;
  }
})();
