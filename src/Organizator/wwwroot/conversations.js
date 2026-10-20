/* ═══════════════════════════════════════════════════════════════════════════
   conversations.js — la fenêtre Conversations
   Les sessions d'agent d'Organizator, à la manière de Claude Code Desktop : à gauche les sessions,
   rangées par tâche dans l'ordre de la file, avec leur état ; au centre la conversation choisie, ses
   messages, la réponse qui s'écrit, les outils pas à pas, les questions de l'agent ; en bas la zone de
   saisie. Organizator reste le moteur : les sessions sont hébergées par l'hôte (LiveSessions) avec les
   paramètres choisis dans Organizator — cette page ne fait que les montrer et leur parler.
   Elle ne tient aucune donnée : la file vient de la fenêtre principale (getData, relu à chaque
   `dataChanged`), l'état des sessions de leurs fichiers (getSessions, getTranscript), la réponse en cours
   des événements `live`. Une session qui tourne dans une console se lit ici, et se pilote là-bas.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var MD = window.OrganizatorMd;
  var esc = MD.esc;
  var FEEDBACK_ID = '__feedback__';
  var STATE_WORDS = {
    working: 'Au travail', waiting: 'Attend votre réponse', ready: 'Réponse prête', error: 'Erreur',
    closed: 'Fermée', open: 'Ouverte', idle: 'Inactive'
  };
  var FOLD_CHARS = 1400, FOLD_LINES = 14, SHOWN = 120;
  var SEEN_KEY = 'organizator.conversations.seen';
  var ICON = {
    send: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>',
    stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>'
  };

  var C = {
    data: { tasks: [], types: [], convos: [] }, settings: {}, env: {},
    /* Par conversation : le dernier état lu (getSessions), l'empreinte de ses fichiers, la session
       hébergée (événements live), son journal (getTranscript). */
    sessions: {}, stamps: {}, live: {}, transcripts: {},
    selected: '', filter: 'all', showDone: false, drafts: {}, open: {}, answers: {}, older: {},
    seen: loadSeen(), loaded: false
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

  function typeOf(id) {
    for (var i = 0; i < C.data.types.length; i++) if (C.data.types[i].id === id) return C.data.types[i];
    return null;
  }

  function convoById(id) {
    for (var i = 0; i < C.data.convos.length; i++) if (C.data.convos[i].id === id) return C.data.convos[i];
    return null;
  }

  function convosOf(taskId) {
    return C.data.convos.filter(function (c) { return c.taskId === taskId; })
      .sort(function (a, b) { return toMs(updatedOf(b)) - toMs(updatedOf(a)); });
  }

  function providerOf(c) { return c && c.provider === 'copilot' ? 'copilot' : 'claude'; }

  function updatedOf(c) {
    var s = C.sessions[c.id];
    return Math.max(toMs(c.updated), s ? toMs(s.updated) : 0);
  }

  function agentTag(c) {
    return (providerOf(c) === 'copilot' ? 'Copilot' : 'Claude') + (c.model ? ' · ' + c.model : '') + (c.effort ? ' · ' + c.effort : '');
  }

  /* Rangs comme dans la file : les tâches actives de premier niveau. */
  function ranks() {
    var out = {}, r = 0;
    C.data.tasks.forEach(function (t) { if (!t.parent && !t.done) out[t.id] = ++r; });
    return out;
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
    return (st === 'ready' || st === 'error') && updatedOf(c) > (C.seen[c.id] || 0) && c.id !== C.selected;
  }

  function matches(c) {
    var st = displayState(c);
    if (C.filter === 'todo') return st === 'waiting' || unread(c);
    if (C.filter === 'working') return st === 'working' || st === 'open';
    return true;
  }

  /* Les tâches qui ont des conversations, dans l'ordre de la file ; le carnet de remarques à la fin. */
  function groups() {
    var active = [], done = [];
    C.data.tasks.forEach(function (t) {
      var convs = convosOf(t.id);
      if (convs.length) (t.done ? done : active).push({ task: t, convs: convs });
    });
    var remarks = convosOf(FEEDBACK_ID);
    if (remarks.length) active.push({ task: taskById(FEEDBACK_ID), convs: remarks });
    return { active: active, done: done };
  }

  function listedConvos() {
    var g = groups(), out = [];
    g.active.concat(C.showDone ? g.done : []).forEach(function (x) { out = out.concat(x.convs); });
    if (C.selected && convoById(C.selected) && out.indexOf(convoById(C.selected)) < 0) out.push(convoById(C.selected));
    return out;
  }

  /* ══ Hôte ════════════════════════════════════════════════════════════ */

  function load() {
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
    renderSide();
  }

  /* ══ Actions ═════════════════════════════════════════════════════════ */

  function select(id) {
    if (!id) return;
    C.selected = id;
    var c = convoById(id);
    if (c) { C.seen[id] = Math.max(updatedOf(c), now()); saveSeen(); }
    stick = true;
    render();
    loadTranscript(id);
    refreshSessions();
    var box = $('[data-role="cv-input"]');
    if (box) box.focus();
  }

  function launchParams(c) {
    return { sessionId: c.id, provider: providerOf(c), cwd: c.cwd || '', title: c.title || '', model: c.model || '', effort: c.effort || '' };
  }

  function send() {
    var c = convoById(C.selected);
    var box = $('[data-role="cv-input"]');
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
        + '<div class="cv-filters" data-role="cv-filters"></div></div><div class="cv-list" data-role="cv-list"></div>';
    }
    var g = groups();
    var all = [];
    g.active.forEach(function (x) { all = all.concat(x.convs); });
    var todo = all.filter(function (c) { return displayState(c) === 'waiting' || unread(c); }).length;
    var working = all.filter(function (c) { var st = displayState(c); return st === 'working' || st === 'open'; }).length;
    setHtml(side.querySelector('[data-role="cv-sub"]'), esc(all.length + (all.length > 1 ? ' conversations en file' : ' conversation en file')));
    setHtml(side.querySelector('[data-role="cv-filters"]'), [
      ['all', 'Toutes', 0], ['todo', 'À traiter', todo], ['working', 'En cours', working]
    ].map(function (f) {
      return '<button type="button" class="cv-filter' + (C.filter === f[0] ? ' on' : '') + '" data-act="cv-filter" data-id="' + f[0] + '">'
        + esc(f[1]) + (f[2] ? '<span class="cv-filter-n">' + f[2] + '</span>' : '') + '</button>';
    }).join(''));
    var rk = ranks();
    var h = [];
    g.active.forEach(function (x) { h.push(groupHtml(x, rk)); });
    if (g.done.length) {
      h.push('<button type="button" class="cv-done-toggle" data-act="cv-done">' + (C.showDone ? '▾' : '▸') + ' Tâches terminées · ' + g.done.length + '</button>');
      if (C.showDone) g.done.forEach(function (x) { h.push(groupHtml(x, rk)); });
    }
    var html = h.join('');
    var shown = g.active.some(function (x) { return x.convs.some(matches); });
    if (!shown && C.loaded) {
      html = '<div class="cv-side-empty">' + (C.filter === 'all'
        ? 'Aucune conversation encore. Lancez-en une depuis une tâche d’Organizator : avec le réglage « Fenêtre Conversations », elle s’ouvre ici.'
        : 'Rien ici pour l’instant.') + '</div>' + html;
    }
    setHtml(side.querySelector('[data-role="cv-list"]'), html);
  }

  function groupHtml(x, rk) {
    var convs = x.convs.filter(matches);
    if (!convs.length) return '';
    var ty = typeOf(x.task.type);
    var dot = ty ? ' style="background:' + esc(ty.bg) + ';border-color:' + esc(ty.bd) + '"' : '';
    return '<div class="cv-group"><div class="cv-group-head">'
      + (rk[x.task.id] ? '<span class="cv-group-rank">' + rk[x.task.id] + '</span>' : '')
      + '<span class="cv-group-dot"' + dot + '></span><span class="cv-group-title" title="' + esc(firstLine(x.task.text, 200)) + '">'
      + esc(firstLine(x.task.text, 80)) + '</span></div>'
      + convs.map(itemHtml).join('') + '</div>';
  }

  function itemHtml(c) {
    var st = displayState(c);
    var a = C.sessions[c.id];
    var said = st === 'waiting' && a && a.said ? a.said : '';
    var lv = C.live[c.id];
    if (lv && lv.question && lv.question.kind === 'ask' && lv.question.questions[0]) said = lv.question.questions[0].question;
    return '<button type="button" class="cv-item' + (c.id === C.selected ? ' on' : '') + (unread(c) ? ' unread' : '') + '" data-act="cv-select" data-id="' + esc(c.id) + '"'
      + ' title="' + esc((STATE_WORDS[st] || '') + (a && a.said ? ' · ' + a.said : '')) + '">'
      + '<span class="cv-state' + (st ? ' st-' + st : '') + '"></span>'
      + '<span class="cv-item-title">' + esc(c.title || 'Nouvelle session') + '</span>'
      + '<span class="cv-item-sub">' + esc(agentTag(c) + ' · ' + (STATE_WORDS[st] || '—') + (updatedOf(c) ? ' · ' + fmtTime(updatedOf(c)) : '')) + '</span>'
      + (said ? '<span class="cv-item-said">' + esc(said) + '</span>' : '')
      + '</button>';
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
    var c = convoById(C.selected);
    var lv = C.live[C.selected];
    if (!c) {
      setHtml(el, '<div class="cv-head-text"><div class="cv-title">Nouvelle conversation</div><div class="cv-meta">Démarrage…</div></div>');
      return;
    }
    var task = taskById(c.taskId);
    var st = displayState(c);
    var hosted = lv && lv.running;
    setHtml(el, '<div class="cv-head-text"><div class="cv-title" title="' + esc(c.title) + '">' + esc(c.title || 'Nouvelle session') + '</div>'
      + '<div class="cv-meta">'
      + (st ? '<span class="cv-chip st-' + esc(st) + '">' + esc(STATE_WORDS[st] || st) + '</span>' : '')
      + (task && task.id !== FEEDBACK_ID ? '<span class="cv-chip" title="' + esc(task.text) + '">' + esc(firstLine(task.text, 60)) + '</span>' : '')
      + '<span class="cv-chip">' + esc(agentTag(c)) + '</span>'
      + (c.cwd ? '<button type="button" class="cv-chip" data-act="cv-folder" title="Ouvrir le dossier : ' + esc(c.cwd) + '">' + esc(c.cwd) + '</button>' : '')
      + '</div></div>'
      + '<div class="cv-actions">'
      + (hosted && !(lv && lv.busy) ? '<button type="button" class="cv-btn" data-act="cv-close" title="Arrêter le processus de l’agent : la session reste, et reprend au prochain message">Mettre en pause</button>' : '')
      + (inConsole(c) ? '' : '<button type="button" class="cv-btn" data-act="cv-terminal"' + (lv && lv.busy ? ' disabled title="L’agent répond encore"' : ' title="Reprendre cette session dans une console"') + '>Ouvrir dans un terminal</button>')
      + '</div>');
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
    var note = c ? agentTag(c) + (c.cwd ? ' · ' + c.cwd : '') : '';
    if (lv && lv.question) note = 'Répondez à la question de l’agent, plus haut.';
    else if (c && !(lv && lv.running) && displayState(c) === 'closed') note = 'Session en pause : votre message la reprend. ' + note;
    setHtml(el.querySelector('[data-role="cv-note"]'), esc(note));
    setHtml(el.querySelector('[data-role="cv-btn"]'), lv && lv.busy
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
    'cv-filter': function (el) { C.filter = el.getAttribute('data-id'); renderSide(); },
    'cv-done': function () { C.showDone = !C.showDone; renderSide(); refreshSessions(); },
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
    var role = e.target && e.target.getAttribute && e.target.getAttribute('data-role');
    if (role === 'cv-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape') {
      var lv = C.live[C.selected];
      if (lv && lv.busy) { e.preventDefault(); stop(); }
    }
  });

  bridge.on('live', onLive);
  bridge.on('sessionsChanged', refreshSessions);
  bridge.on('dataChanged', reloadData);
  bridge.on('liveFocus', function (p) { if (p && p.sessionId) select(p.sessionId); });

  /* Filet : un état qui n'aurait pas été annoncé se rattrape. */
  setInterval(refreshSessions, 15000);

  window.__conversations = { state: C, select: select, send: send, onLive: onLive };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
