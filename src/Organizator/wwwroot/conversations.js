/* ═══════════════════════════════════════════════════════════════════════════
   conversations.js — la fenêtre Conversations
   Les sessions d'agent d'Organizator, à la manière de Claude Code Desktop : à gauche les sessions —
   une recherche, les épinglées en haut, les autres dans l'ordre de la file, les archivées repliées
   en bas de la liste, et sous elle, fixe, le bloc « Organizator » : l'assistant et les sessions du
   carnet de remarques en cours — avec leur état ; au centre la conversation choisie, ses messages, la
   réponse qui s'écrit, les outils pas à pas, les questions de l'agent ; en bas la zone de saisie.
   Organizator reste le moteur : les sessions sont hébergées par l'hôte (LiveSessions) avec les
   paramètres choisis dans Organizator — cette page ne fait que les montrer et leur parler.
   Elle ne tient aucune donnée : la file vient de la fenêtre principale (getData, relu à chaque
   `dataChanged`), l'état des sessions de leurs fichiers (getSessions, getTranscript), la réponse en cours
   des événements `live`. Épingler ou archiver se demande à la fenêtre principale (convoMark), qui
   enregistre ; l'assistant aussi y vit (assistantRemote → assistantView). Une session qui tourne
   dans une console se lit ici, et se pilote là-bas.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var MD = window.OrganizatorMd;
  var esc = MD.esc;
  var FEEDBACK_ID = '__feedback__';
  /* L'assistant, choisi dans la liste comme une conversation. */
  var ASSISTANT_ID = '__assistant__';
  var STATE_WORDS = {
    working: 'Au travail', waiting: 'Attend votre réponse', ready: 'Réponse prête', error: 'Erreur',
    closed: 'Fermée', open: 'Ouverte', idle: 'Inactive'
  };
  var FOLD_CHARS = 1400, FOLD_LINES = 14, SHOWN = 120;
  var SEEN_KEY = 'organizator.conversations.seen';
  var SINCE_KEY = 'organizator.conversations.since';
  var SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICON = {
    send: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>',
    stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>',
    search: SVG + '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>',
    pin: SVG + '<path d="M12 17v5"></path><path d="M5 17h14v-1.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2Z"></path></svg>',
    archive: SVG + '<rect x="2" y="3" width="20" height="5" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg>',
    unarchive: SVG + '<rect x="2" y="3" width="20" height="5" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="m9.5 14.5 2.5-2.5 2.5 2.5"></path><path d="M12 12v6"></path></svg>',
    spark: SVG + '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"></path><path d="M19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"></path></svg>',
    /* La bulle du bouton « Remarques » de la fenêtre principale. */
    remarks: SVG + '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><path d="M8 9h8M8 13h5"></path></svg>'
  };

  var C = {
    data: { tasks: [], types: [], convos: [] }, settings: {}, env: {},
    /* Par conversation : le dernier état lu (getSessions), l'empreinte de ses fichiers, la session
       hébergée (événements live), son journal (getTranscript). */
    sessions: {}, stamps: {}, live: {}, transcripts: {},
    selected: '', query: '', showArchive: false, drafts: {}, open: {}, answers: {}, older: {},
    /* Épingler / archiver demandé à la fenêtre principale, pas encore enregistré. */
    marking: {},
    /* Session du carnet qu'on lit : elle reste dans le bloc du bas tant qu'elle est choisie. */
    stay: '',
    /* L'assistant, tenu par la fenêtre principale : son résumé, puis — quand on le montre — ses
       entrées, en données (assistantView). */
    as: { summary: null, keys: [], items: {}, restoredAt: 0, toastAt: 0 },
    seen: loadSeen(), since: loadSince(), loaded: false
  };

  /* ══ Utilitaires ═════════════════════════════════════════════════════ */

  function $(sel) { return document.querySelector(sel); }
  function firstLine(t, n) { return String(t || '').split('\n')[0].trim().slice(0, n || 90); }
  function toMs(v) { if (typeof v === 'number') return v; var t = Date.parse(v); return isNaN(t) ? 0 : t; }
  function now() { return Date.now(); }

  function fmtTime(ms) {
    ms = toMs(ms);
    if (!ms) return '';
    var d = new Date(ms), today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  function loadSeen() {
    try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function saveSeen() {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(C.seen)); } catch (e) { /* stockage refusé : rien de grave */ }
  }

  /* Première ouverture de la fenêtre : ce qui s'est dit avant est tenu pour lu (sans quoi toutes les
     vieilles conversations s'afficheraient en gras, « non lues »). */
  function loadSince() {
    var v = 0;
    try { v = Number(localStorage.getItem(SINCE_KEY)) || 0; } catch (e) { /* stockage refusé */ }
    if (!v) {
      v = Date.now();
      try { localStorage.setItem(SINCE_KEY, String(v)); } catch (e) { /* idem */ }
    }
    return v;
  }

  /* Recherche : sans accents ni casse, chaque mot doit se trouver. */
  function fold(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function words(q) { return fold(q).split(/\s+/).filter(Boolean); }

  function setHtml(el, html) { if (el && el.cvHtml !== html) { el.innerHTML = html; el.cvHtml = html; } }

  var toastTimer = null;
  function toast(text) {
    var host = $('#cv-toast');
    if (!host) return;
    host.innerHTML = '<div class="cv-toast">' + esc(text) + '</div>';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { host.innerHTML = ''; }, 4200);
  }

  /* ══ Données ═════════════════════════════════════════════════════════ */

  function taskById(id) {
    if (id === FEEDBACK_ID) return { id: FEEDBACK_ID, type: '', text: 'Remarques sur Organizator', done: false };
    for (var i = 0; i < C.data.tasks.length; i++) if (C.data.tasks[i].id === id) return C.data.tasks[i];
    return null;
  }

  function convoById(id) {
    for (var i = 0; i < C.data.convos.length; i++) if (C.data.convos[i].id === id) return C.data.convos[i];
    return null;
  }

  function providerOf(c) { return c && c.provider === 'copilot' ? 'copilot' : 'claude'; }

  function updatedOf(c) {
    var s = C.sessions[c.id];
    return Math.max(toMs(c.updated), s ? toMs(s.updated) : 0);
  }

  function agentTag(c) {
    return (providerOf(c) === 'copilot' ? 'Copilot' : 'Claude') + (c.model ? ' · ' + c.model : '') + (c.effort ? ' · ' + c.effort : '');
  }

  /* Le titre d'une conversation, en entier (il passe à la ligne, rien n'est coupé) : le sien, ou celui de
     sa tâche tant qu'elle n'en a pas. Le nom donné à la session au lancement n'est que le début de
     la tâche (46 caractères) : c'est alors la première ligne de la tâche qui s'affiche, complète. */
  function convTitle(c) {
    var own = String(c.title || '').trim();
    var t = taskById(c.taskId);
    var line = t && t.id !== FEEDBACK_ID ? firstLine(t.text, 1000) : '';
    if (!own || own === 'Nouvelle session') return line || own || 'Nouvelle session';
    var start = fold(own).replace(/…$/, '').trim();
    if (line && start && fold(line).indexOf(start) === 0) return line;
    return own;
  }

  /* Sa tâche, seulement quand elle dit autre chose que le titre : le plus souvent c'est le même, et la
     répéter ferait doublon. */
  function taskLine(c) {
    var t = taskById(c.taskId);
    if (!t || t.id === FEEDBACK_ID) return '';
    var line = firstLine(t.text, 1000);
    var a = fold(line), b = fold(convTitle(c));
    return !a || a.indexOf(b) === 0 || b.indexOf(a) === 0 ? '' : line;
  }

  /* L'état d'une conversation : la session hébergée d'abord (question, réponse en cours), puis ses fichiers. */
  function displayState(c) {
    var lv = C.live[c.id];
    if (lv && lv.question) return 'waiting';
    if (lv && lv.busy) return 'working';
    var a = C.sessions[c.id];
    if (!a) return lv && lv.running ? 'idle' : null;
    if (a.alive === false) return a.exists ? 'closed' : null;
    if (!a.exists) return a.alive ? 'open' : null;
    if ((a.state === 'ready' || a.state === 'idle') && a.agents && a.agents.length) return 'working';
    return a.state || 'idle';
  }

  /* Une session qui tourne dans une console : elle se lit ici, mais se pilote dans sa fenêtre. */
  function inConsole(c) {
    var a = C.sessions[c.id], lv = C.live[c.id];
    return !!(a && a.alive === true && !(lv && lv.running));
  }

  function unread(c) {
    var st = displayState(c);
    return (st === 'ready' || st === 'error') && updatedOf(c) > Math.max(C.seen[c.id] || 0, C.since) && c.id !== C.selected;
  }

  /* Une tâche terminée, ou dont la parente l'est (une revue générale cochée et ses tickets) : ses
     conversations rejoignent d'elles-mêmes les Archives. */
  function taskDone(c) {
    var t = taskById(c.taskId);
    if (!t) return false;
    if (t.done) return true;
    var p = t.parent ? taskById(t.parent) : null;
    return !!(p && p.done);
  }

  /* Au travail, ou une question en attente : une telle conversation ne se cache jamais dans les archives. */
  function active(c) { var st = displayState(c); return st === 'working' || st === 'waiting'; }

  /* Carnet de remarques : une session en cours a son agent qui tourne (console ouverte, ou hébergée
     ici), une réponse pas encore lue, ou c'est celle qu'on lit. */
  function ongoing(c) {
    var a = C.sessions[c.id], lv = C.live[c.id];
    return !!(a && a.alive === true) || !!(lv && lv.running) || unread(c) || c.id === C.stay;
  }

  /* La dernière session du carnet : elle reste dans le bloc du bas, au niveau de l'assistant, même au
     repos — sauf si on l'a archivée. */
  function latestFeedback() {
    var best = null;
    C.data.convos.forEach(function (c) {
      if (c.taskId === FEEDBACK_ID && (!best || updatedOf(c) > updatedOf(best))) best = c;
    });
    return best ? best.id : '';
  }

  /* Sa tâche est en cours (et pas validée) : la conversation est « épinglée ». */
  function taskDoing(c) {
    var t = taskById(c.taskId);
    return !!(t && t.id !== FEEDBACK_ID && t.doing && !taskDone(c));
  }

  /* Où se range une conversation. Pour une tâche, son état décide — en cours = épinglée (section du
     haut), validée = archivée (repliée en bas) — et une conversation au travail ne se cache jamais
     dans les archives. Le carnet de remarques, sans tâche, va dans le bloc « Organizator » (la
     dernière session, celles en cours, celles qu'on y garde par l'épingle) ou aux Archives (au repos,
     ou rangée à la main). */
  function placeOf(c) {
    if (c.taskId === FEEDBACK_ID) {
      if (active(c)) return 'organizator';
      if (c.archived) return 'archive';
      return c.pinned || ongoing(c) || c.id === latestFeedback() ? 'organizator' : 'archive';
    }
    if (taskDone(c)) return active(c) ? 'list' : 'archive';
    return taskDoing(c) ? 'pinned' : 'list';
  }

  /* Où elle irait si on la sortait des Archives : nulle part ailleurs, pour celles qui y sont d'office. */
  function placeUnarchived(c) {
    var copy = Object.assign({}, c);
    delete copy.archived;
    return placeOf(copy);
  }

  /* Titre de la conversation, texte de sa tâche, agent, modèle, effort. */
  function hit(c, ws) {
    if (!ws.length) return true;
    var t = taskById(c.taskId);
    var hay = fold(convTitle(c) + '\n' + (c.title || '') + '\n' + (t ? t.text : '') + '\n' + agentTag(c));
    return ws.every(function (w) { return hay.indexOf(w) >= 0; });
  }

  /* Dans l'ordre de la file (les conversations d'une tâche à la suite, la plus récente d'abord) ; le
     carnet de remarques à la fin. */
  function ordered(convs) {
    var by = {};
    convs.forEach(function (c) { (by[c.taskId] || (by[c.taskId] = [])).push(c); });
    var out = [];
    C.data.tasks.map(function (t) { return t.id; }).concat([FEEDBACK_ID]).forEach(function (id) {
      if (!by[id]) return;
      out = out.concat(by[id].sort(function (a, b) { return toMs(updatedOf(b)) - toMs(updatedOf(a)); }));
    });
    return out;
  }

  /* Les conversations de la liste, rangées et filtrées par la recherche. */
  function sections() {
    var ws = words(C.query);
    var out = { pinned: [], list: [], organizator: [], archive: [], all: 0 };
    C.data.convos.forEach(function (c) {
      if (!taskById(c.taskId)) return;
      out.all++;
      if (hit(c, ws)) out[placeOf(c)].push(c);
    });
    out.pinned = ordered(out.pinned);
    /* Le carnet : celles qu'on garde par l'épingle d'abord, puis la plus récente. */
    out.organizator.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || toMs(updatedOf(b)) - toMs(updatedOf(a)); });
    out.assistant = !ws.length || ws.every(function (w) { return fold('assistant organizator ✦ ' + ((C.as.summary && C.as.summary.said) || '')).indexOf(w) >= 0; });
    return out;
  }

  /* Celles dont on suit l'état : pas les archives des tâches validées tant qu'elles sont repliées (le
     carnet se suit toujours, pour ressortir s'il se remet au travail). */
  function listedConvos() {
    var open = C.showArchive || !!C.query.trim();
    var out = C.data.convos.filter(function (c) { return taskById(c.taskId) && (open || !taskDone(c)); });
    if (C.selected && convoById(C.selected) && out.indexOf(convoById(C.selected)) < 0) out.push(convoById(C.selected));
    return out;
  }

  /* ══ Hôte ════════════════════════════════════════════════════════════ */

  function load() {
    asking('sync')['catch'](function () { /* la fenêtre principale n'est pas prête : le filet redemandera */ });
    return bridge.call('getState', {}, 30000).then(function (st) {
      C.data = normalizeData(st.data);
      C.settings = st.settings || {};
      C.env = st.env || {};
      return bridge.call('liveState', {});
    }).then(function (live) {
      ((live && live.sessions) || []).forEach(function (s) { C.live[s.sessionId] = fromSnapshot(s); });
      C.loaded = true;
      var wanted = /[?&]session=([^&]+)/.exec(location.search);
      if (wanted) select(decodeURIComponent(wanted[1]));
      render();
      refreshSessions();
    })['catch'](function (e) {
      C.loaded = true;
      toast('Lecture impossible : ' + e.message);
      render();
    });
  }

  function normalizeData(d) {
    d = d || {};
    return {
      tasks: Array.isArray(d.tasks) ? d.tasks : [],
      types: Array.isArray(d.types) ? d.types : [],
      convos: Array.isArray(d.convos) ? d.convos : []
    };
  }

  var dataTimer = null;
  function reloadData() {
    clearTimeout(dataTimer);
    dataTimer = setTimeout(function () {
      bridge.call('getData', {}).then(function (r) {
        C.data = normalizeData(r && r.data);
        render();
        refreshSessions();
      })['catch'](function () { /* la prochaine relecture rattrapera */ });
    }, 400);
  }

  var sessionsTimer = null, sessionsBusy = false, sessionsAgain = false;
  function refreshSessions() {
    clearTimeout(sessionsTimer);
    sessionsTimer = setTimeout(function () {
      if (sessionsBusy) { sessionsAgain = true; return; }
      var convs = listedConvos();
      if (!convs.length) return;
      sessionsBusy = true;
      bridge.call('getSessions', {
        sessions: convs.map(function (c) { return { sessionId: c.id, cwd: c.cwd, provider: providerOf(c), artifactsStamp: C.stamps[c.id] || '' }; })
      }, 60000).then(function (r) {
        ((r && r.sessions) || []).forEach(function (s) {
          if (!s || !s.sessionId) return;
          C.sessions[s.sessionId] = s;
          if (s.artifactsStamp) C.stamps[s.sessionId] = s.artifactsStamp;
        });
        sessionsBusy = false;
        reviveArchived();
        renderSide();
        renderHead();
        renderCompose();
        /* Une session en console, ou qui ne répond pas : son journal se relit tel qu'il s'écrit. */
        var c = convoById(C.selected);
        var lv = c ? C.live[c.id] : null;
        if (c && !(lv && lv.busy)) loadTranscript(c.id);
        if (sessionsAgain) { sessionsAgain = false; refreshSessions(); }
      }, function () {
        sessionsBusy = false;
      });
    }, 500);
  }

  function loadTranscript(id) {
    var c = convoById(id);
    if (!c) return;
    var tr = C.transcripts[id] || (C.transcripts[id] = { messages: null, loading: false });
    if (tr.loading) { tr.again = true; return; }
    tr.loading = true;
    bridge.call('getTranscript', { sessionId: id, cwd: c.cwd, provider: providerOf(c) }, 30000).then(function (r) {
      tr.loading = false;
      tr.messages = (r && r.messages) || [];
      tr.exists = !!(r && r.exists);
      tr.error = '';
      var lv = C.live[id];
      /* La réponse est dans le journal : ce qui s'affichait en direct s'efface. */
      if (lv && !lv.busy && lv.ended) clearTurn(lv);
      if (tr.again) { tr.again = false; loadTranscript(id); }
      if (id === C.selected) renderThread();
    }, function (e) {
      tr.loading = false;
      tr.error = e.message;
      if (id === C.selected) renderThread();
    });
  }

  /* ══ Sessions hébergées ═════════════════════════════════════════════ */

  function liveOf(id) {
    return C.live[id] || (C.live[id] = { running: false, busy: false, provider: '', phase: '', items: [], texts: {}, steps: {}, echo: [], notices: [], question: null, end: null, ended: false, base: null });
  }

  function fromSnapshot(s) {
    var lv = liveOf(s.sessionId);
    lv.running = !!s.running;
    lv.busy = !!s.busy;
    lv.provider = s.provider || '';
    lv.phase = s.phase || '';
    lv.question = s.question || null;
    (s.texts || []).forEach(function (t) { lv.texts[t.msg] = t.text; lv.items.push({ kind: 'text', id: t.msg }); });
    (s.steps || []).forEach(function (st) { lv.steps[st.id] = st; lv.items.push({ kind: 'step', id: st.id }); });
    return lv;
  }

  function clearTurn(lv) {
    lv.items = [];
    lv.texts = {};
    lv.steps = {};
    lv.echo = [];
    lv.notices = [];
    lv.question = null;
    lv.ended = false;
    lv.base = null;
  }

  function onLive(p) {
    if (!p || !p.sessionId) return;
    var lv = liveOf(p.sessionId);
    switch (p.phase) {
      case 'state':
        lv.running = !!p.running;
        lv.busy = !!p.busy;
        if (p.provider) lv.provider = p.provider;
        /* L'hôte vient d'arrêter son processus : la session n'est plus vivante, même si la dernière
           lecture des fichiers le disait encore (elle passerait sinon pour une session en console). */
        if (!lv.running && C.sessions[p.sessionId]) C.sessions[p.sessionId].alive = false;
        if (!lv.running) refreshSessions();
        break;
      case 'user':
        /* Un nouveau tour : ce qui restait du précédent s'efface, le journal sert de base. */
        if (!lv.busy || lv.ended) clearTurn(lv);
        if (lv.base == null) {
          var tr = C.transcripts[p.sessionId];
          lv.base = tr && tr.messages ? tr.messages.length : null;
        }
        lv.busy = true;
        lv.end = null;
        lv.echo.push({ text: p.text, at: now() });
        lv.phase = 'thinking';
        break;
      case 'thinking':
        lv.phase = 'thinking';
        break;
      case 'text':
        if (!(p.msg in lv.texts)) lv.items.push({ kind: 'text', id: p.msg });
        lv.texts[p.msg] = p.text;
        lv.phase = 'text';
        break;
      case 'tool':
        if (!lv.steps[p.id]) lv.items.push({ kind: 'step', id: p.id });
        lv.steps[p.id] = { id: p.id, name: p.name, detail: p.detail, status: p.status };
        if (p.status === 'running') lv.phase = 'tool';
        break;
      case 'question':
        lv.question = p.answered ? null : { request: p.request, kind: p.kind, questions: p.questions || [], plan: p.plan || '' };
        if (p.answered) lv.phase = 'thinking';
        break;
      case 'notice':
        lv.notices.push({ text: p.text, error: false });
        break;
      case 'error':
        lv.notices.push({ text: p.error || 'L’agent n’a pas pu répondre.', error: true });
        break;
      case 'done':
        lv.busy = false;
        lv.ended = true;
        lv.question = null;
        lv.phase = '';
        lv.end = { cost: Number(p.cost) || 0, ms: Number(p.ms) || 0, cancelled: !!p.cancelled };
        /* Une réponse arrivée sous les yeux est lue. */
        if (p.sessionId === C.selected) { C.seen[p.sessionId] = now(); saveSeen(); }
        loadTranscript(p.sessionId);
        refreshSessions();
        break;
    }
    if (p.sessionId === C.selected) {
      if (p.phase === 'state' || p.phase === 'question' || p.phase === 'done' || p.phase === 'user') { renderHead(); renderCompose(); }
      renderThread();
    }
    reviveArchived();
    renderSide();
  }

  /* ══ Actions ═════════════════════════════════════════════════════════ */

  function select(id) {
    if (!id) return;
    var c = convoById(id);
    /* Une session du carnet qu'on ouvre depuis le bloc du bas y reste tant qu'on la lit, même lue. */
    var keep = !!c && placeOf(c) === 'organizator';
    C.selected = id;
    C.stay = keep ? id : '';
    if (c) { C.seen[id] = Math.max(updatedOf(c), now()); saveSeen(); }
    /* Ouverte depuis la recherche, une notification ou la fenêtre principale : une archivée se
       montre à sa place, section dépliée. */
    if (c && placeOf(c) === 'archive') C.showArchive = true;
    stick = true;
    watchAssistant();
    render();
    if (id !== ASSISTANT_ID) {
      loadTranscript(id);
      refreshSessions();
    }
    var box = $('[data-role="cv-input"]');
    if (box) box.focus();
  }

  /* ── L'assistant ──────────────────────────────────────────────────────
     Tenu par la fenêtre principale (assistant.js) : chaque geste lui est relayé par l'hôte, et ce
     qu'il faut montrer revient par l'événement `assistantView`. */
  function asking(op, extra, front) {
    var payload = Object.assign({ op: op }, extra || {});
    if (front) payload.front = true;
    return bridge.call('assistantRemote', payload);
  }

  /* Dit à la fenêtre principale si la discussion est sous les yeux : elle envoie alors ses entrées,
     et ne signale pas une réponse qu'on a vue arriver ici. */
  var watched = null;
  function watchAssistant() {
    var on = C.selected === ASSISTANT_ID;
    var focused = on && document.hasFocus() && document.visibilityState !== 'hidden';
    var key = on + '|' + focused;
    if (key === watched) return;
    watched = key;
    asking('watch', { on: on, focused: focused })['catch'](function () { watched = null; });
  }

  function onAsView(p) {
    if (!p) return;
    var A = C.as;
    if (p.summary) A.summary = p.summary;
    if (Array.isArray(p.keys)) {
      var changed = p.changed || {};
      Object.keys(changed).forEach(function (k) { A.items[k] = changed[k]; });
      var present = {};
      p.keys.forEach(function (k) { present[k] = true; });
      Object.keys(A.items).forEach(function (k) { if (!present[k]) delete A.items[k]; });
      A.keys = p.keys;
    }
    if (p.toast && p.toast.at > A.toastAt) { A.toastAt = p.toast.at; toast(p.toast.text); }
    /* Un message qui n'est pas parti revient dans la zone de saisie. */
    var back = A.summary && A.summary.restore;
    if (back && back.at > A.restoredAt) {
      A.restoredAt = back.at;
      if (!C.drafts[ASSISTANT_ID]) C.drafts[ASSISTANT_ID] = back.text;
      var box = $('[data-role="cv-input"]');
      if (box && C.selected === ASSISTANT_ID && !box.value) { box.value = back.text; fit(box); }
    }
    asClock();
    renderSide();
    if (C.selected === ASSISTANT_ID) { renderHead(); renderThread(); renderCompose(); }
  }

  /* Pendant une réponse, la durée se met à jour chaque seconde. */
  var asTimer = null;
  function asClock() {
    var busy = !!(C.as.summary && C.as.summary.busy);
    if (busy && !asTimer) {
      asTimer = setInterval(function () {
        if (C.selected === ASSISTANT_ID) { renderThread(); renderCompose(); }
      }, 1000);
    } else if (!busy && asTimer) {
      clearInterval(asTimer);
      asTimer = null;
    }
  }

  function asBusyWords(b) {
    if (!b) return '';
    var s = Math.max(0, Math.round((now() - toMs(b.startedAt)) / 1000));
    var what = b.phase === 'text' ? 'L’assistant écrit…'
      : (b.phase === 'tool' || b.phase === 'call') && b.label ? b.label + '…'
      : 'L’assistant réfléchit…';
    return what + ' · ' + (s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + ('0' + (s % 60)).slice(-2));
  }

  function asState() {
    var s = C.as.summary;
    if (!s) return '';
    return s.busy ? 'working' : s.pending ? 'waiting' : s.unseen ? 'ready' : 'idle';
  }

  function asStateWords() {
    var s = C.as.summary;
    if (!s) return 'Lecture…';
    if (s.busy) return 'Répond…';
    if (s.pending) return s.pending > 1 ? s.pending + ' propositions à valider' : 'Une proposition à valider';
    if (s.unseen) return 'Réponse prête';
    return s.count ? 'Au repos' : 'Nouvelle discussion';
  }

  function asSend(box, text) {
    var s = C.as.summary;
    if (!s || !s.loaded) { toast('La discussion se charge encore dans la fenêtre principale.'); return; }
    if (s.busy) { toast('L’assistant répond encore : attendez sa réponse, ou arrêtez-la.'); return; }
    box.value = '';
    C.drafts[ASSISTANT_ID] = '';
    fit(box);
    stick = true;
    asking('send', { text: text })['catch'](function (e) {
      toast('Message non envoyé : ' + e.message);
      if (!box.value) { box.value = text; C.drafts[ASSISTANT_ID] = text; fit(box); }
    });
  }

  /* Formulaire de lancement, tâche montrée dans la file, panneau, réglages : ça se passe dans la
     fenêtre principale, qui revient devant. */
  var AS_FRONT = { 'as-form': true, 'as-reveal': true, 'as-open': true, 'as-settings': true };
  function asAct(el) {
    var act = el.getAttribute('data-as');
    if (!act) return;
    var extra = { act: act };
    if (el.getAttribute('data-id')) extra.id = el.getAttribute('data-id');
    if (el.getAttribute('data-key')) extra.key = el.getAttribute('data-key');
    if (el.getAttribute('data-i')) extra.i = parseInt(el.getAttribute('data-i'), 10);
    asking('act', extra, !!AS_FRONT[act])['catch'](function (e) { toast(e.message); });
  }

  /* Une suggestion de l'accueil : celles qui partent telles quelles sont envoyées, les autres
     commencent un message à compléter. */
  function asIdea(el) {
    var i = parseInt(el.getAttribute('data-i'), 10);
    var empty = C.as.items.empty;
    var idea = empty && empty.ideas ? empty.ideas[i] : null;
    if (!idea) return;
    if (idea.send) { asking('act', { act: 'as-suggest', i: i })['catch'](function (e) { toast(e.message); }); return; }
    var box = $('[data-role="cv-input"]');
    if (!box) return;
    box.value = idea.text;
    C.drafts[ASSISTANT_ID] = idea.text;
    fit(box);
    box.focus();
    box.setSelectionRange(idea.text.length, idea.text.length);
  }

  function launchParams(c) {
    return { sessionId: c.id, provider: providerOf(c), cwd: c.cwd || '', title: c.title || '', model: c.model || '', effort: c.effort || '' };
  }

  function send() {
    var c = convoById(C.selected);
    var box = $('[data-role="cv-input"]');
    if (box && C.selected === ASSISTANT_ID) { if (box.value.trim()) asSend(box, box.value.trim()); return; }
    if (!c || !box) return;
    var text = box.value.trim();
    if (!text) return;
    var lv = C.live[c.id];
    if (lv && lv.question) { toast('L’agent attend la réponse à sa question, plus haut.'); return; }
    if (lv && lv.busy && providerOf(c) === 'copilot') { toast('Copilot répond encore : attendez sa réponse, ou arrêtez-la.'); return; }
    box.value = '';
    C.drafts[c.id] = '';
    fit(box);
    stick = true;
    var payload = launchParams(c);
    payload.text = text;
    bridge.call('liveSend', payload, 60000)['catch'](function (e) {
      toast('Message non envoyé : ' + e.message);
      if (!box.value) { box.value = text; C.drafts[c.id] = text; fit(box); }
    });
  }

  function stop() {
    if (!C.selected) return;
    if (C.selected === ASSISTANT_ID) { asking('act', { act: 'as-stop' })['catch'](function (e) { toast('Arrêt impossible : ' + e.message); }); return; }
    bridge.call('liveStop', { sessionId: C.selected })['catch'](function (e) { toast('Arrêt impossible : ' + e.message); });
  }

  function answer(kind) {
    var c = convoById(C.selected);
    var lv = c ? C.live[c.id] : null;
    if (!lv || !lv.question) return;
    var q = lv.question;
    var payload = { sessionId: c.id, request: q.request };
    if (kind === 'ask') {
      var st = C.answers[q.request] || {};
      var answers = {};
      var missing = false;
      (q.questions || []).forEach(function (qq, i) {
        var a = st[i] || { picked: [], other: '' };
        var value = a.other && a.other.trim() ? a.other.trim() : a.picked.join(', ');
        if (!value) missing = true;
        answers[qq.question] = value;
      });
      if (missing) { toast('Répondez à chaque question (un choix, ou « Autre »).'); return; }
      payload.answers = answers;
    } else {
      payload.allow = kind === 'approve';
      if (!payload.allow) payload.message = 'L’utilisateur ne valide pas ce plan : revois-le avec lui.';
    }
    bridge.call('liveAnswer', payload).then(function () {
      delete C.answers[q.request];
    })['catch'](function (e) { toast('Réponse non transmise : ' + e.message); });
  }

  function toTerminal() {
    var c = convoById(C.selected);
    if (!c) return;
    bridge.call('liveTerminal', launchParams(c), 30000).then(function () {
      toast('Session rouverte dans un terminal.');
    })['catch'](function (e) { toast(e.message); });
  }

  function goConsole() {
    var c = convoById(C.selected);
    if (!c) return;
    bridge.call('resumeSession', Object.assign(launchParams(c), { keywords: [], context: '', prompt: '', force: false }), 30000)
      ['catch'](function (e) { toast('Terminal introuvable : ' + e.message); });
  }

  function closeSession() {
    var c = convoById(C.selected);
    if (!c) return;
    bridge.call('liveClose', { sessionId: c.id })['catch'](function (e) { toast(e.message); });
  }

  /* Épingler, archiver : la copie locale change tout de suite, la fenêtre principale enregistre
     (convoMark), et son enregistrement revient ici par `dataChanged`. Pour une conversation de tâche,
     c'est la tâche qui change (en cours, validée) — la fenêtre principale y ajoute ce que la file en
     déduit (sous-tâches validées avec elle, parente rouverte), que la relecture apporte. */
  function mark(ids, flags) {
    ids = [].concat(ids).filter(function (id) { return !!convoById(id); });
    if (!ids.length) return;
    var payload = { sessionIds: ids };
    Object.keys(flags).forEach(function (k) { payload[k] = !!flags[k]; });
    ids.forEach(function (id) {
      var c = convoById(id);
      var t = c.taskId === FEEDBACK_ID ? null : taskById(c.taskId);
      if (t) markTask(t, flags);
      else Object.keys(flags).forEach(function (k) { if (flags[k]) c[k] = now(); else delete c[k]; });
      C.marking[id] = true;
    });
    renderSide();
    renderHead();
    bridge.call('convoMark', payload).then(function () {
      ids.forEach(function (id) { delete C.marking[id]; });
    }, function (e) {
      ids.forEach(function (id) { delete C.marking[id]; });
      toast('Rangement non enregistré : ' + e.message);
      reloadData();
    });
  }

  /* La copie locale de la tâche, comme la fenêtre principale va l'écrire (markConvo). */
  function markTask(t, flags) {
    var p = t.parent ? taskById(t.parent) : null;
    function reopen() { t.done = false; if (p && p.done) p.done = false; }
    if (typeof flags.archived === 'boolean') {
      if (flags.archived) {
        t.done = true;
        C.data.tasks.forEach(function (k) { if (k.parent === t.id) k.done = true; });
      } else {
        reopen();
      }
    }
    if (typeof flags.pinned === 'boolean') {
      if (flags.pinned) reopen();
      t.doing = flags.pinned;
    }
  }

  function togglePin(id) {
    var c = convoById(id);
    if (!c) return;
    if (c.taskId !== FEEDBACK_ID) {
      var on = taskDoing(c);
      mark(id, { pinned: !on });
      toast(on ? 'La tâche n’est plus en cours : la conversation retourne dans la liste.' : 'Tâche passée en cours : la conversation monte dans « En cours ».');
      return;
    }
    if (c.pinned) mark(id, { pinned: false });
    else mark(id, { pinned: true, archived: false });
  }

  function toggleArchive(id) {
    var c = convoById(id);
    if (!c) return;
    if (c.taskId !== FEEDBACK_ID) {
      /* Archiver valide la tâche, sortir des Archives la rouvre — toutes ses conversations suivent. */
      var done = taskDone(c);
      mark(id, { archived: !done });
      toast(done ? 'Tâche rouverte : la conversation revient dans la liste.'
        : active(c) ? 'Tâche validée : la conversation rejoindra les Archives quand l’agent aura fini.'
        : 'Tâche validée : la conversation est rangée dans les Archives.');
      return;
    }
    if (placeOf(c) === 'archive') {
      if (c.archived) mark(id, { archived: false });
      return;
    }
    if (active(c)) { toast('L’agent travaille encore : archivez la conversation une fois sa réponse rendue.'); return; }
    if (C.stay === id) C.stay = '';
    mark(id, { archived: true, pinned: false });
    toast('Conversation rangée dans les Archives, en bas de la liste.');
  }

  /* Une session du carnet archivée à la main qui se remet au travail (message, reprise en console)
     ressort pour de bon. (Une conversation de tâche suit sa tâche : au travail, elle reste visible le
     temps de sa réponse, sans rouvrir la tâche.) */
  function reviveArchived() {
    C.data.convos.forEach(function (c) {
      if (c.taskId === FEEDBACK_ID && c.archived && active(c) && !C.marking[c.id]) mark(c.id, { archived: false });
    });
  }

  /* ══ Affichage ═══════════════════════════════════════════════════════ */

  function render() {
    renderSide();
    renderMain();
  }

  function renderSide() {
    var side = $('#cv-side');
    if (!side) return;
    if (!side.firstChild) {
      side.innerHTML = '<div class="cv-side-head"><div class="cv-brand">Conversations</div><div class="cv-brand-sub" data-role="cv-sub"></div>'
        + '<label class="cv-search">' + ICON.search + '<input type="search" data-role="cv-search" placeholder="Rechercher (Ctrl + F)"'
        + ' spellcheck="false" autocomplete="off" aria-label="Rechercher une conversation"></label></div>'
        + '<div class="cv-list" data-role="cv-list"></div>'
        + '<div class="cv-side-foot" data-role="cv-foot"></div>';
    }
    var s = sections();
    var searching = !!words(C.query).length;
    var shown = s.pinned.length + s.list.length;
    var sub = shown + (shown > 1 ? ' conversations' : ' conversation');
    if (s.archive.length) sub += ' · ' + s.archive.length + (s.archive.length > 1 ? ' archivées' : ' archivée');
    if (searching) sub = (shown + s.organizator.length + s.archive.length) + ' sur ' + s.all + ' pour cette recherche';
    setHtml(side.querySelector('[data-role="cv-sub"]'), esc(sub));
    var h = [];
    if (s.pinned.length) {
      h.push('<div class="cv-section">En cours</div>');
      h.push(s.pinned.map(itemHtml).join(''));
      if (s.list.length) h.push('<div class="cv-section">Conversations</div>');
    }
    /* Pas de titre de tâche au-dessus : celui de la conversation le dit déjà (taskLine quand il diffère). */
    h.push(ordered(s.list).map(itemHtml).join(''));
    if (s.archive.length) {
      /* Une recherche montre ses résultats archivés sans qu'on ait à déplier. */
      var open = C.showArchive || searching;
      h.push(searching
        ? '<div class="cv-section">Archives</div>'
        : '<button type="button" class="cv-archive-toggle" data-act="cv-archive-toggle" aria-expanded="' + open + '">'
          + ICON.archive + '<span>Archives</span><span class="cv-archive-n">' + s.archive.length + '</span>'
          + '<span class="cv-archive-chev">' + (open ? '▾' : '▸') + '</span></button>');
      if (open) h.push(ordered(s.archive).map(itemHtml).join(''));
    }
    var html = h.join('');
    if (C.loaded && searching && !shown && !s.archive.length && !s.organizator.length && !s.assistant) {
      html = '<div class="cv-side-empty">Aucune conversation ne correspond à « ' + esc(C.query.trim()) + ' ».</div>';
    } else if (C.loaded && !shown && !searching) {
      html = '<div class="cv-side-empty">' + (s.archive.length
        ? 'Rien en cours : les conversations des tâches terminées et celles que vous avez rangées sont dans les Archives.'
        : 'Aucune conversation encore. Lancez-en une depuis une tâche d’Organizator : avec le réglage « Fenêtre Conversations », elle s’ouvre ici.')
        + '</div>' + html;
    }
    setHtml(side.querySelector('[data-role="cv-list"]'), html);
    setHtml(side.querySelector('[data-role="cv-foot"]'), footHtml(s));
  }

  /* Le bloc du bas, toujours visible : l'assistant, puis les sessions du carnet de remarques en cours
     (les autres sont aux Archives). */
  function footHtml(s) {
    var rows = (s.assistant ? [assistantItemHtml()] : []).concat(s.organizator.map(itemHtml));
    if (!rows.length) return '';
    return '<div class="cv-section cv-foot-title">Organizator</div>' + rows.join('');
  }

  function assistantItemHtml() {
    var sm = C.as.summary;
    var st = asState();
    var tip = 'Assistant · ' + asStateWords() + (sm && sm.said ? ' · ' + sm.said : '');
    return '<div class="cv-item cv-item-as' + (C.selected === ASSISTANT_ID ? ' on' : '') + (sm && sm.unseen ? ' unread' : '') + '" role="button" tabindex="0"'
      + ' data-act="cv-select" data-id="' + ASSISTANT_ID + '" title="' + esc(tip) + '">'
      + '<span class="cv-state' + (st ? ' st-' + st : '') + '"></span>'
      + '<span class="cv-item-title"><span class="cv-spark">' + ICON.spark + '</span>Assistant</span>'
      + '<span class="cv-item-sub">' + esc((sm ? sm.model : 'Claude') + ' · ' + asStateWords() + (sm && sm.at ? ' · ' + fmtTime(sm.at) : '')) + '</span>'
      + (sm && sm.said && (st === 'ready' || st === 'waiting') ? '<span class="cv-item-said">' + esc(sm.said) + '</span>' : '')
      + '</div>';
  }

  /* Une ligne de la liste : le titre en entier, sa tâche quand elle dit autre chose. Les boutons
     Épingler / Archiver paraissent au survol. */
  function itemHtml(c) {
    var st = displayState(c);
    var a = C.sessions[c.id];
    var said = st === 'waiting' && a && a.said ? a.said : '';
    var lv = C.live[c.id];
    if (lv && lv.question && lv.question.kind === 'ask' && lv.question.questions[0]) said = lv.question.questions[0].question;
    var task = taskLine(c);
    return '<div class="cv-item' + (c.id === C.selected ? ' on' : '') + (unread(c) ? ' unread' : '') + '" role="button" tabindex="0"'
      + ' data-act="cv-select" data-id="' + esc(c.id) + '"'
      + ' title="' + esc((STATE_WORDS[st] || '') + (a && a.said ? ' · ' + a.said : '')) + '">'
      + '<span class="cv-state' + (st ? ' st-' + st : '') + '"></span>'
      + '<span class="cv-item-title">' + (c.taskId === FEEDBACK_ID ? '<span class="cv-spark">' + ICON.remarks + '</span>' : '') + esc(convTitle(c)) + '</span>'
      + (task ? '<span class="cv-item-task">' + esc(task) + '</span>' : '')
      + '<span class="cv-item-sub">' + esc(agentTag(c) + ' · ' + (STATE_WORDS[st] || '—') + (updatedOf(c) ? ' · ' + fmtTime(updatedOf(c)) : '')) + '</span>'
      + (said ? '<span class="cv-item-said">' + esc(said) + '</span>' : '')
      + '<span class="cv-item-acts">' + markButtons(c, 'cv-item-act') + '</span>'
      + '</div>';
  }

  /* Épingler / désépingler ; archiver / désarchiver. Pour une tâche, c'est la passer en cours, la
     valider, et l'inverse. Pour le carnet, l'épingle le garde dans le bloc du bas, et une session rangée
     d'office (au repos) n'a que l'épingle. */
  function markButtons(c, cls) {
    var place = placeOf(c);
    if (c.taskId !== FEEDBACK_ID) {
      var on = taskDoing(c), done = taskDone(c);
      return '<button type="button" class="' + cls + (on ? ' on' : '') + '" data-act="cv-pin" data-id="' + esc(c.id) + '"'
        + ' title="' + (on ? 'Désépingler : la tâche n’est plus en cours' : 'Épingler : la tâche passe en cours') + '" aria-pressed="' + on + '">' + ICON.pin + '</button>'
        + '<button type="button" class="' + cls + '" data-act="cv-archive" data-id="' + esc(c.id) + '"'
        + ' title="' + (done ? 'Sortir des Archives : la tâche est rouverte' : 'Archiver : la tâche est validée') + '">' + (done ? ICON.unarchive : ICON.archive) + '</button>';
    }
    var h = '<button type="button" class="' + cls + (c.pinned ? ' on' : '') + '" data-act="cv-pin" data-id="' + esc(c.id) + '"'
      + ' title="' + (c.pinned ? 'Ne plus la garder dans le bloc Organizator' : 'La garder dans le bloc Organizator, même au repos') + '" aria-pressed="' + !!c.pinned + '">' + ICON.pin + '</button>';
    if (place === 'archive' && placeUnarchived(c) === 'archive') return h;
    return h + '<button type="button" class="' + cls + '" data-act="cv-archive" data-id="' + esc(c.id) + '"'
      + ' title="' + (place === 'archive' ? 'Sortir des Archives' : 'Archiver') + '">' + (place === 'archive' ? ICON.unarchive : ICON.archive) + '</button>';
  }

  function renderMain() {
    var main = $('#cv-main');
    if (!main) return;
    if (!C.selected) {
      main.cvShell = '';
      setHtml(main, '<div class="cv-scroll"><div class="cv-empty"><h2>Vos conversations</h2>'
        + '<p>Choisissez une conversation à gauche. Celles qu’Organizator héberge — réglage <b>Réglages › Agents › Terminal : Fenêtre Conversations</b> — '
        + 'se pilotent d’ici, avec l’agent, le modèle, l’effort et les consignes choisis dans Organizator. Celles qui tournent dans une console se lisent ici.</p></div></div>');
      return;
    }
    if (main.cvShell !== C.selected) {
      main.cvShell = C.selected;
      main.cvHtml = null;
      main.innerHTML = '<div class="cv-head" data-role="cv-head"></div>'
        + '<div class="cv-scroll" data-role="cv-scroll"><div class="cv-thread" data-role="cv-thread"></div></div>'
        + '<div class="cv-compose" data-role="cv-compose"></div>';
    }
    renderHead();
    renderThread();
    renderCompose();
  }

  function renderHead() {
    var el = $('[data-role="cv-head"]');
    if (!el) return;
    if (C.selected === ASSISTANT_ID) { setHtml(el, asHeadHtml()); return; }
    var c = convoById(C.selected);
    var lv = C.live[C.selected];
    if (!c) {
      setHtml(el, '<div class="cv-head-text"><div class="cv-title">Nouvelle conversation</div><div class="cv-meta">Démarrage…</div></div>');
      return;
    }
    var task = taskById(c.taskId);
    var st = displayState(c);
    var hosted = lv && lv.running;
    var place = placeOf(c);
    var other = taskLine(c);
    setHtml(el, '<div class="cv-head-text"><div class="cv-title">' + (c.taskId === FEEDBACK_ID ? '<span class="cv-spark">' + ICON.remarks + '</span>' : '') + esc(convTitle(c)) + '</div>'
      + '<div class="cv-meta">'
      + (st ? '<span class="cv-chip st-' + esc(st) + '">' + esc(STATE_WORDS[st] || st) + '</span>' : '')
      + (place === 'archive' ? '<span class="cv-chip">' + (c.taskId !== FEEDBACK_ID ? 'Archivée · tâche validée' : c.archived ? 'Archivée' : 'Archivée · au repos') + '</span>' : '')
      + (other ? '<span class="cv-chip" title="' + esc(task.text) + '">' + esc(other) + '</span>' : '')
      + '<span class="cv-chip">' + esc(agentTag(c)) + '</span>'
      + (c.cwd ? '<button type="button" class="cv-chip" data-act="cv-folder" title="Ouvrir le dossier : ' + esc(c.cwd) + '">' + esc(c.cwd) + '</button>' : '')
      + '</div></div>'
      + '<div class="cv-actions">'
      + markButtons(c, 'cv-icon-btn')
      + (hosted && !(lv && lv.busy) ? '<button type="button" class="cv-btn" data-act="cv-close" title="Arrêter le processus de l’agent : la session reste, et reprend au prochain message">Mettre en pause</button>' : '')
      + (inConsole(c) ? '' : '<button type="button" class="cv-btn" data-act="cv-terminal"' + (lv && lv.busy ? ' disabled title="L’agent répond encore"' : ' title="Reprendre cette session dans une console"') + '>Ouvrir dans un terminal</button>')
      + '</div>');
  }

  function asHeadHtml() {
    var sm = C.as.summary;
    var st = asState();
    return '<div class="cv-head-text"><div class="cv-title"><span class="cv-spark">' + ICON.spark + '</span>Assistant</div>'
      + '<div class="cv-meta">'
      + (st && st !== 'idle' ? '<span class="cv-chip st-' + esc(st) + '">' + esc(asStateWords()) + '</span>' : '')
      + '<span class="cv-chip">' + esc(sm ? sm.model : 'Claude') + '</span>'
      + '<span class="cv-chip">Agit sur la file d’Organizator</span>'
      + '</div></div>'
      + '<div class="cv-actions">'
      + (sm && sm.count ? '<button type="button" class="cv-btn' + (sm.armed ? ' is-armed' : '') + '" data-act="cv-as-act" data-as="as-reset"'
        + ' title="Effacer la discussion : l’assistant repartira sans son historique">' + (sm.armed ? 'Effacer la discussion ?' : 'Nouvelle discussion') + '</button>' : '')
      + '<button type="button" class="cv-btn" data-act="cv-as-act" data-as="as-open" title="Le panneau ✦ de la fenêtre principale, sur la même discussion">Ouvrir dans la fenêtre principale</button>'
      + '</div>';
  }

  /* La discussion de l'assistant, telle que la fenêtre principale la décrit (assistant.js, remoteItems). */
  function asThreadItems() {
    var items = [];
    if (!C.as.summary) return [{ key: 'loading', html: '<div class="cv-notice">Lecture de la discussion dans la fenêtre principale…</div>' }];
    C.as.keys.forEach(function (k) {
      var m = C.as.items[k];
      if (m) items.push({ key: 'a-' + k, html: asItemHtml(m, k) });
    });
    return items;
  }

  function asItemHtml(m, k) {
    switch (m.k) {
      case 'user': return messageHtml({ role: 'user', text: m.text, ts: m.at }, 'as:' + k);
      case 'agent': return '<div class="cv-msg assistant md">' + MD.blocks(m.text || '') + '</div>';
      case 'tools': return '<div class="cv-as-tools">' + MD.tools(m.names || []) + '</div>';
      case 'notice': return '<div class="cv-notice' + (m.error ? ' is-error' : '') + '">' + esc(m.text) + '</div>';
      case 'end': return '<div class="cv-end">' + esc(m.text) + '</div>';
      case 'wait': return '<div class="cv-thinking"><i></i>' + esc(asBusyWords(C.as.summary && C.as.summary.busy) || 'L’assistant réfléchit…') + '</div>';
      case 'more': return '<button type="button" class="cv-older" data-act="cv-as-act" data-as="as-more">Afficher les ' + m.n + ' messages précédents</button>';
      case 'empty':
        return '<div class="cv-as-empty"><h2>L’assistant d’Organizator</h2>'
          + '<p>Il lit vos tâches, vos conversations et les consignes de vos mots-clés ; il crée, modifie et range des tâches — '
          + 'chaque action s’annule d’un clic. Réécrire une consigne, supprimer un mot-clé ou lancer un agent vous est proposé : rien ne change sans vous.</p>'
          + '<div class="cv-as-ideas">' + (m.ideas || []).map(function (x, i) {
            return '<button type="button" class="cv-as-idea" data-act="cv-as-idea" data-i="' + i + '">' + esc(x.label) + '</button>';
          }).join('') + '</div></div>';
      case 'card': return asCardHtml(m);
    }
    return '';
  }

  /* Une carte d'action de l'assistant : faite (Annuler), proposée (Appliquer / Refuser, Lancer). Ses
     boutons repartent vers la fenêtre principale, qui les exécute. */
  function asCardHtml(m) {
    var id = esc(m.id);
    var h = ['<div class="cv-card is-' + esc(m.status) + (m.proposal ? ' is-proposal' : '') + '">'];
    h.push('<div class="cv-card-head"><span class="cv-card-title">' + esc(m.title) + '</span>'
      + (m.state ? '<span class="cv-card-state">' + esc(m.state) + '</span>' : '') + '</div>');
    if (m.subject) h.push('<div class="cv-card-subject">« ' + esc(m.subject) + ' »</div>');
    if (m.detail) h.push('<div class="cv-card-detail">' + esc(m.detail) + '</div>');
    if (m.reason) h.push('<div class="cv-card-reason">' + esc(m.reason) + '</div>');
    if (m.diff) {
      h.push('<div class="cv-diff">' + m.diff.map(function (r) {
        return '<div class="cv-diff-row"><div class="cv-diff-label">' + esc(r.label) + '</div>'
          + '<div class="cv-diff-new">' + esc(r.after == null || r.after === '' ? '(vide)' : r.after) + '</div>'
          + '<button type="button" class="cv-diff-toggle" data-act="cv-as-act" data-as="as-toggle" data-id="' + id + '" data-key="' + esc(r.key) + '">'
          + (r.open ? 'Masquer l’actuel ▴' : 'Voir l’actuel ▾') + '</button>'
          + (r.open ? '<div class="cv-diff-old">' + esc(r.before == null || r.before === '' ? '(vide)' : r.before) + '</div>' : '')
          + '</div>';
      }).join('') + '</div>');
    }
    if (m.launch) {
      h.push('<div class="cv-launch">' + m.launch.map(function (l) {
        return '<div class="cv-launch-row"><span class="cv-launch-key">' + esc(l[0]) + '</span><span class="cv-launch-val">' + esc(l[1]) + '</span></div>';
      }).join('') + '</div>');
    }
    if (m.result) h.push('<div class="cv-card-detail">' + esc(m.result) + '</div>');
    var btns = (m.buttons || []).map(function (b) {
      return '<button type="button" class="' + (b.link ? 'cv-link' : 'cv-btn' + (b.primary ? ' cv-btn-primary' : '')) + '"'
        + ' data-act="cv-as-act" data-as="' + esc(b.act) + '" data-id="' + id + '"'
        + (b.disabled ? ' disabled title="' + esc(b.tip || '') + '"' : '') + '>' + esc(b.label) + '</button>';
    });
    if (btns.length) h.push('<div class="cv-card-actions">' + btns.join('') + '</div>');
    h.push('</div>');
    return h.join('');
  }

  /* Le fil : le journal de la session, puis — pendant une réponse hébergée — ce qui s'écrit en direct. */
  var stick = false;
  function renderThread() {
    var el = $('[data-role="cv-thread"]');
    var scroll = $('[data-role="cv-scroll"]');
    if (!el || !scroll) return;
    var follow = stick || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    var items = threadItems();
    var kids = el.children;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var node = kids[i];
      if (!node || node.getAttribute('data-k') !== it.key) {
        var found = null;
        for (var j = i + 1; j < kids.length; j++) if (kids[j].getAttribute('data-k') === it.key) { found = kids[j]; break; }
        if (!found) { found = document.createElement('div'); found.setAttribute('data-k', it.key); }
        el.insertBefore(found, node || null);
        node = found;
      }
      if (node.cvHtml !== it.html) { node.innerHTML = it.html; node.cvHtml = it.html; }
    }
    while (kids.length > items.length) el.removeChild(el.lastChild);
    if (follow) scroll.scrollTop = scroll.scrollHeight;
    stick = false;
  }

  function threadItems() {
    if (C.selected === ASSISTANT_ID) return asThreadItems();
    var id = C.selected;
    var tr = C.transcripts[id];
    var lv = C.live[id];
    var items = [];
    var messages = tr && tr.messages ? tr.messages : [];
    /* Pendant une réponse, le journal s'arrête au début du tour : la suite s'affiche en direct. */
    if (lv && (lv.busy || lv.echo.length) && !lv.ended) {
      var cut = lv.base;
      if (cut == null) {
        for (cut = messages.length - 1; cut >= 0 && messages[cut].role !== 'user'; cut--) { /* dernier message de l'utilisateur */ }
        if (cut < 0) cut = messages.length;
        if (!lv.echo.length && messages[cut]) lv.echo.push({ text: messages[cut].text, at: toMs(messages[cut].ts) });
        lv.base = cut;
      }
      messages = messages.slice(0, cut);
    }
    if (!tr || (tr.messages === null && tr.loading)) {
      items.push({ key: 'loading', html: '<div class="cv-notice">Lecture de la conversation…</div>' });
    } else if (tr.error) {
      items.push({ key: 'err', html: '<div class="cv-notice is-error">Journal illisible : ' + esc(tr.error) + '</div>' });
    }
    var start = C.older[id] ? 0 : Math.max(0, messages.length - SHOWN);
    if (start > 0) items.push({ key: 'older', html: '<button type="button" class="cv-older" data-act="cv-older">Afficher les ' + start + ' messages précédents</button>' });
    for (var i = start; i < messages.length; i++) {
      var m = messages[i];
      items.push({ key: 'm' + i + '-' + String(m.text || '').length, html: messageHtml(m, id + ':' + i) });
    }
    if (lv) {
      lv.echo.forEach(function (e, k) { items.push({ key: 'e' + k, html: messageHtml({ role: 'user', text: e.text, ts: e.at }, id + ':e' + k) }); });
      var block = [];
      function flushSteps() {
        if (!block.length) return;
        items.push({ key: 's' + block[0], html: '<div class="cv-steps">' + block.map(function (sid) { return stepHtml(lv.steps[sid]); }).join('') + '</div>' });
        block = [];
      }
      lv.items.forEach(function (it) {
        if (it.kind === 'step') { block.push(it.id); return; }
        flushSteps();
        items.push({ key: 't' + it.id, html: '<div class="cv-msg assistant md">' + MD.blocks(lv.texts[it.id] || '') + '</div>' });
      });
      flushSteps();
      lv.notices.forEach(function (n, k) { items.push({ key: 'n' + k, html: '<div class="cv-notice' + (n.error ? ' is-error' : '') + '">' + esc(n.text) + '</div>' }); });
      if (lv.question) items.push({ key: 'q' + lv.question.request, html: questionHtml(lv.question) });
      else if (lv.busy) items.push({ key: 'think', html: '<div class="cv-thinking"><i></i>' + esc(lv.phase === 'tool' ? 'Au travail…' : lv.phase === 'text' ? 'Écrit…' : 'Réfléchit…') + '</div>' });
      if (lv.end && !lv.busy) {
        var parts = [];
        if (lv.end.cancelled) parts.push('Réponse arrêtée');
        if (lv.end.ms) parts.push(Math.max(1, Math.round(lv.end.ms / 1000)) + ' s');
        if (lv.end.cost) parts.push('≈ ' + lv.end.cost.toFixed(lv.end.cost < 0.1 ? 3 : 2).replace('.', ',') + ' $');
        if (parts.length) items.push({ key: 'end', html: '<div class="cv-end">' + esc(parts.join(' · ')) + '</div>' });
      }
    }
    if (!items.length) {
      items.push({ key: 'empty', html: '<div class="cv-notice">Pas encore de message dans cette conversation.</div>' });
    }
    return items;
  }

  function messageHtml(m, key) {
    if (m.role === 'user') {
      var text = String(m.text || '');
      var long = text.length > FOLD_CHARS || text.split('\n').length > FOLD_LINES;
      var folded = long && !C.open[key];
      return '<div class="cv-msg user"><div class="cv-bubble md' + (folded ? ' is-folded' : '') + '">' + MD.blocks(text) + '</div>'
        + (long ? '<button type="button" class="cv-unfold" data-act="cv-unfold" data-k="' + esc(key) + '">' + (folded ? 'Afficher tout ▾' : 'Replier ▴') + '</button>' : '')
        + (m.ts ? '<div class="cv-time">' + esc(fmtTime(m.ts)) + '</div>' : '') + '</div>';
    }
    return '<div class="cv-msg assistant md">' + MD.blocks(m.text) + '</div>';
  }

  function stepHtml(s) {
    if (!s) return '';
    var icon = s.status === 'done' ? '✓' : s.status === 'error' ? '✕' : '•';
    return '<div class="cv-step ' + esc(s.status || '') + '"><span class="cv-step-icon">' + icon + '</span>'
      + '<span class="cv-step-name">' + esc(s.name || 'Outil') + '</span>'
      + (s.detail ? '<span class="cv-step-detail" title="' + esc(s.detail) + '">' + esc(s.detail) + '</span>' : '') + '</div>';
  }

  function questionHtml(q) {
    if (q.kind === 'plan') {
      return '<div class="cv-ask"><div class="cv-ask-title">Plan à valider</div><div class="cv-plan md">' + MD.blocks(q.plan || '') + '</div>'
        + '<div class="cv-ask-actions"><button type="button" class="cv-btn" data-act="cv-plan-no">Refuser</button>'
        + '<button type="button" class="cv-btn cv-btn-primary" data-act="cv-plan-yes">Approuver le plan</button></div></div>';
    }
    var st = C.answers[q.request] || {};
    return '<div class="cv-ask"><div class="cv-ask-title">L’agent vous pose ' + ((q.questions || []).length > 1 ? 'des questions' : 'une question') + '</div>'
      + (q.questions || []).map(function (qq, i) {
        var a = st[i] || { picked: [], other: '' };
        return '<div class="cv-q"><div class="cv-q-text">' + esc(qq.question) + '</div><div class="cv-opts">'
          + (qq.options || []).map(function (o) {
            var on = a.picked.indexOf(o.label) >= 0;
            return '<button type="button" class="cv-opt' + (on ? ' on' : '') + '" data-act="cv-opt" data-q="' + i + '" data-label="' + esc(o.label) + '"'
              + ' data-multi="' + (qq.multiSelect ? '1' : '') + '"><span>' + esc(o.label) + '</span>'
              + (o.description ? '<span class="cv-opt-desc">' + esc(o.description) + '</span>' : '') + '</button>';
          }).join('')
          + '</div><input class="cv-other" type="text" data-role="cv-other" data-q="' + i + '" placeholder="Autre réponse…" value="' + esc(a.other) + '"></div>';
      }).join('')
      + '<div class="cv-ask-actions"><button type="button" class="cv-btn cv-btn-primary" data-act="cv-answer">Répondre</button></div></div>';
  }

  function renderCompose() {
    var el = $('[data-role="cv-compose"]');
    if (!el) return;
    var c = convoById(C.selected);
    var lv = C.live[C.selected];
    var as = C.selected === ASSISTANT_ID;
    if (c && inConsole(c)) {
      el.cvBox = false;
      setHtml(el, '<div class="cv-console"><span>Cette session tourne dans une console : elle se lit ici, et se pilote dans sa fenêtre.</span>'
        + '<button type="button" class="cv-btn" data-act="cv-console">Aller au terminal</button></div>');
      return;
    }
    if (!el.cvBox) {
      el.cvBox = true;
      el.cvHtml = null;
      el.innerHTML = '<div class="cv-box"><textarea class="cv-input" rows="1" data-role="cv-input" spellcheck="true" '
        + 'placeholder="Répondre à l’agent… (Entrée envoie, Maj + Entrée : à la ligne)"></textarea>'
        + '<div class="cv-box-foot"><span class="cv-box-note" data-role="cv-note"></span><span data-role="cv-btn"></span></div></div>';
    }
    var box = el.querySelector('[data-role="cv-input"]');
    if (box.getAttribute('data-for') !== C.selected) {
      box.setAttribute('data-for', C.selected);
      box.value = C.drafts[C.selected] || '';
      fit(box);
    }
    box.placeholder = as ? 'Demandez à l’assistant… (Entrée envoie, Maj + Entrée : à la ligne)' : 'Répondre à l’agent… (Entrée envoie, Maj + Entrée : à la ligne)';
    var sm = C.as.summary;
    var note = c ? agentTag(c) + (c.cwd ? ' · ' + c.cwd : '') : '';
    if (as) note = !sm ? 'Lecture de la discussion…' : sm.busy ? asBusyWords(sm.busy) : sm.ready ? sm.model + ' · agit sur la file d’Organizator' : 'Claude Code est introuvable sur ce poste : l’assistant passe par lui.';
    else if (lv && lv.question) note = 'Répondez à la question de l’agent, plus haut.';
    else if (c && !(lv && lv.running) && displayState(c) === 'closed') note = 'Session en pause : votre message la reprend. ' + note;
    setHtml(el.querySelector('[data-role="cv-note"]'), esc(note));
    setHtml(el.querySelector('[data-role="cv-btn"]'), (as ? sm && sm.busy : lv && lv.busy)
      ? '<button type="button" class="cv-stop" data-act="cv-stop" title="Arrêter la réponse (Échap)">' + ICON.stop + '</button>'
      : '<button type="button" class="cv-send" data-act="cv-send" title="Envoyer (Entrée)">' + ICON.send + '</button>');
  }

  function fit(box) {
    box.style.height = 'auto';
    box.style.height = Math.min(260, Math.max(26, box.scrollHeight)) + 'px';
  }

  /* ══ Événements ══════════════════════════════════════════════════════ */

  var ACTIONS = {
    'cv-select': function (el) { select(el.getAttribute('data-id')); },
    'cv-archive-toggle': function () { C.showArchive = !C.showArchive; renderSide(); refreshSessions(); },
    'cv-pin': function (el) { togglePin(el.getAttribute('data-id')); },
    'cv-archive': function (el) { toggleArchive(el.getAttribute('data-id')); },
    'cv-as-act': asAct,
    'cv-as-idea': asIdea,
    'cv-send': send,
    'cv-stop': stop,
    'cv-terminal': toTerminal,
    'cv-console': goConsole,
    'cv-close': closeSession,
    'cv-older': function () { C.older[C.selected] = true; renderThread(); },
    'cv-unfold': function (el) { var k = el.getAttribute('data-k'); C.open[k] = !C.open[k]; renderThread(); },
    'cv-folder': function () {
      var c = convoById(C.selected);
      if (c && c.cwd) bridge.call('openPath', { path: c.cwd, editor: 'default' })['catch'](function (e) { toast(e.message); });
    },
    'cv-opt': function (el) {
      var lv = C.live[C.selected];
      if (!lv || !lv.question) return;
      var req = lv.question.request;
      var st = C.answers[req] || (C.answers[req] = {});
      var i = el.getAttribute('data-q');
      var a = st[i] || (st[i] = { picked: [], other: '' });
      var label = el.getAttribute('data-label');
      if (el.getAttribute('data-multi')) {
        a.picked = a.picked.indexOf(label) >= 0 ? a.picked.filter(function (x) { return x !== label; }) : a.picked.concat([label]);
      } else {
        a.picked = [label];
        a.other = '';
      }
      renderThread();
    },
    'cv-answer': function () { answer('ask'); },
    'cv-plan-yes': function () { answer('approve'); },
    'cv-plan-no': function () { answer('refuse'); },
    'open-url': function (el) {
      bridge.call('openUrl', { url: el.getAttribute('data-url') })['catch'](function (e) { toast(e.message); });
    }
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var fn = ACTIONS[el.getAttribute('data-act')];
    if (fn) { e.preventDefault(); fn(el, e); }
  });

  document.addEventListener('input', function (e) {
    var el = e.target;
    var role = el.getAttribute && el.getAttribute('data-role');
    if (role === 'cv-input') {
      C.drafts[C.selected] = el.value;
      fit(el);
    } else if (role === 'cv-search') {
      var was = !!C.query.trim();
      C.query = el.value;
      renderSide();
      /* Une recherche fouille aussi les archives : leur état se relit. */
      if (!was && C.query.trim()) refreshSessions();
    } else if (role === 'cv-other') {
      var lv = C.live[C.selected];
      if (!lv || !lv.question) return;
      var st = C.answers[lv.question.request] || (C.answers[lv.question.request] = {});
      var i = el.getAttribute('data-q');
      var a = st[i] || (st[i] = { picked: [], other: '' });
      a.other = el.value;
    }
  });

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    var role = t && t.getAttribute && t.getAttribute('data-role');
    if (role === 'cv-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F' || e.key === 'k' || e.key === 'K')) {
      var search = $('[data-role="cv-search"]');
      if (search) { e.preventDefault(); search.focus(); search.select(); }
      return;
    }
    if (role === 'cv-search' && e.key === 'Escape') {
      e.preventDefault();
      if (t.value) { t.value = ''; C.query = ''; renderSide(); } else t.blur();
      return;
    }
    /* Une ligne de la liste se choisit au clavier comme un bouton. */
    if ((e.key === 'Enter' || e.key === ' ') && t && t.getAttribute && t.getAttribute('role') === 'button' && t.hasAttribute('data-act')) {
      var fn = ACTIONS[t.getAttribute('data-act')];
      if (fn) { e.preventDefault(); fn(t, e); }
      return;
    }
    if (e.key === 'Escape') {
      var lv = C.live[C.selected];
      var busy = C.selected === ASSISTANT_ID ? !!(C.as.summary && C.as.summary.busy) : !!(lv && lv.busy);
      if (busy) { e.preventDefault(); stop(); }
    }
  });

  bridge.on('live', onLive);
  bridge.on('sessionsChanged', refreshSessions);
  bridge.on('dataChanged', reloadData);
  bridge.on('liveFocus', function (p) { if (p && p.sessionId) select(p.sessionId); });
  bridge.on('assistantView', onAsView);
  window.addEventListener('focus', watchAssistant);
  window.addEventListener('blur', watchAssistant);
  document.addEventListener('visibilitychange', watchAssistant);

  /* Filet : un état qui n'aurait pas été annoncé se rattrape ; l'assistant, s'il n'a encore rien dit
     (fenêtre principale rechargée), se redemande. */
  setInterval(function () {
    refreshSessions();
    if (!C.as.summary) asking('sync')['catch'](function () { /* la fenêtre principale n'est pas prête */ });
  }, 15000);

  window.__conversations = { state: C, select: select, send: send, onLive: onLive, onAsView: onAsView, placeOf: placeOf, convTitle: convTitle };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
