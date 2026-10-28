/* ═══════════════════════════════════════════════════════════════════════════
   assistant.js — l'assistant d'Organizator
   Une discussion avec Claude, hors terminal, dans le panneau latéral : il lit la file, crée, range
   et remonte des tâches, relit les consignes des mots-clés et leurs équipes d'agents, lance des
   conversations. L'hôte (AssistantChat) garde le processus claude et sert les outils déclarés ici :
   chaque appel revient à la page (événement `assistant`, phase `call`), qui l'exécute sur l'état de
   l'application avec les mêmes fonctions que les clics, puis rend le résultat (`assistantToolResult`).
   Ce qui se défait s'applique tout de suite, avec un bouton Annuler ; réécrire ou supprimer un
   mot-clé et lancer un agent sont des propositions, qui attendent un clic. Ce que l'utilisateur en
   a fait part avec son message suivant, en tête, pour que l'agent le sache.
   Le journal de la discussion est gardé par l'hôte (assistant.json), tel que cette page l'écrit.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var A = window.__organizator && window.__organizator.assistantApi;
  /* Révizator seul (téléphone) : ni file, ni assistant. */
  if (!A || !window.bridge || document.documentElement.classList.contains('rz-only')) return;
  var S = A.state, esc = A.esc, ICON = A.icon;

  var ID = '__assistant__';
  /* Entrées gardées dans le journal, et montrées d'un coup (les plus anciennes se déplient). */
  var LOG_MAX = 400;
  var SHOWN = 80;
  var SAVE_MS = 800;
  var RESULT_MAX = 60000;
  var ARM_MS = 4000;

  var SPARK = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"></path><path d="M19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"></path></svg>';

  /* ══ État ═════════════════════════════════════════════════════════════
     `log` est ce qui est gardé : { sessionId, used (une réponse au moins : la session existe et se
     reprend), entries, notes (ce que l'agent apprendra avec le prochain message) }.
     Entrée : { id, kind: user | agent | tools | card | notice | error | end, at, … }. */
  var log = { sessionId: '', used: false, entries: [], notes: [] };
  var loaded = false;
  /* Réponse en cours : { turn, startedAt, phase, label } ; null sinon. */
  var busy = null;
  var draft = '';
  /* D'où est parti le dernier message : 'remote' (fenêtre Conversations) ou 'panel' — c'est là qu'un
     document montré s'ouvre (show_document). */
  var lastFrom = 'panel';
  var unseen = false;
  var armed = false, armTimer = null;
  var showAll = false;
  var customModel = false;
  var saveTimer = null;
  var clock = null;
  var stick = false;

  function now() { return Date.now(); }

  function newSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var hex = '';
    for (var i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-a' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
  }

  function lower(v) { return String(v == null ? '' : v).trim().toLocaleLowerCase('fr-FR'); }
  function clip(v, n) { var s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function title(t) { return A.firstLine(t && t.text, 90).trim() || '(sans titre)'; }
  function ok(text) { return { ok: true, text: text }; }
  function fail(text) { return { ok: false, text: text }; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function push(entry) {
    entry.id = entry.id || A.uid('e');
    entry.at = entry.at || now();
    log.entries.push(entry);
    if (log.entries.length > LOG_MAX) log.entries.splice(0, log.entries.length - LOG_MAX);
    saveSoon();
    return entry;
  }

  function entryById(id) {
    for (var i = log.entries.length - 1; i >= 0; i--) if (log.entries[i].id === id) return log.entries[i];
    return null;
  }

  function note(text) {
    log.notes.push(text);
    saveSoon();
  }

  function pendingCards() {
    return log.entries.filter(function (e) { return e.kind === 'card' && e.status === 'proposed'; });
  }

  /* ══ Données de la file ══════════════════════════════════════════════
     L'agent désigne une tâche par son identifiant, une catégorie ou un mot-clé par son nom (ou son
     identifiant) : la recherche ignore la casse et les espaces autour. */

  function findTask(id) {
    var key = String(id == null ? '' : id).trim().replace(/^\[|\]$/g, '');
    return key ? A.taskById(key) : null;
  }

  function findCategory(ref) {
    var key = lower(ref);
    if (!key) return null;
    var list = S.data.types;
    for (var i = 0; i < list.length; i++) if (lower(list[i].id) === key || lower(list[i].label) === key) return list[i];
    return null;
  }

  function findKeyword(ty, ref) {
    var key = lower(ref);
    var list = ty && Array.isArray(ty.keywords) ? ty.keywords : [];
    for (var i = 0; i < list.length; i++) if (lower(list[i].id) === key || lower(list[i].name) === key) return list[i];
    return null;
  }

  function categoryNames() {
    return S.data.types.map(function (t) { return t.label; }).join(', ') || '(aucune)';
  }

  function unknownTask(id) { return 'Tâche introuvable : « ' + id + ' ». Relis la file (get_queue) : les identifiants sont entre crochets.'; }
  function unknownCategory(ref) { return 'Catégorie inconnue : « ' + ref + ' ». Catégories : ' + categoryNames() + '.'; }
  function unknownKeyword(ty, ref) {
    var names = (ty.keywords || []).map(function (k) { return k.name; }).join(', ') || '(aucun)';
    return 'Mot-clé inconnu dans « ' + ty.label + ' » : « ' + ref + ' ». Mots-clés : ' + names + '.';
  }

  /* Rangs comme dans la file : seules les tâches actives de premier niveau en prennent un, une
     sous-tâche se numérote sous son parent (3.1, 3.2), une tâche terminée porte ✓. */
  function rankMap() {
    var out = {}, r = 0, k = 0, parentRank = '';
    S.data.tasks.forEach(function (t) {
      if (!A.parentOf(t)) {
        if (!t.done) r++;
        k = 0;
        parentRank = t.done ? '' : String(r);
        out[t.id] = t.done ? '✓' : String(r);
      } else {
        if (!t.done) k++;
        out[t.id] = t.done ? '✓' : (parentRank ? parentRank + '.' : '') + k;
      }
    });
    return out;
  }

  function bandOf(rank) {
    var n = parseInt(rank, 10), top = S.settings.topCount || 3;
    if (!n || String(n) !== String(rank)) return '';
    return n <= top ? 'Maintenant' : (n <= top * 2 ? 'Ensuite' : 'Plus tard');
  }

  var STATE_WORDS = {
    working: 'au travail', waiting: 'attend une réponse de l’utilisateur', ready: 'réponse prête', error: 'en erreur',
    closed: 'fenêtre fermée', open: 'ouverte', idle: 'inactive'
  };

  function convoLine(c) {
    var st = A.displayState(c);
    var said = A.saidOf(c);
    return A.agentTag(c) + ' · « ' + clip(c.title || 'Nouvelle session', 60) + ' »'
      + (st ? ' · ' + (STATE_WORDS[st] || st) : '')
      + (said ? ' : « ' + clip(said.replace(/\s+/g, ' '), 140) + ' »' : '');
  }

  /* ── Historique (journal des événements de la fenêtre principale, le plus récent d'abord) ── */
  var EVENT_WORDS = {
    created: 'créée', removed: 'supprimée', done: 'terminée', reopened: 'rouverte', doing: 'passée en cours',
    undoing: 'n’est plus en cours', type: 'catégorie changée', moved: 'déplacée', launched: 'conversation lancée',
    archived: 'session archivée', unarchived: 'session sortie des Archives'
  };
  var FROM_WORDS = { conversations: 'depuis la fenêtre Conversations', assistant: 'par toi, l’assistant' };

  function events() { return (A.events && A.events()) || []; }

  /* Quand la tâche a-t-elle été terminée (dernier événement « terminée ») ; 0 si le journal ne le sait pas. */
  function doneAt(t) {
    var list = events();
    for (var i = 0; i < list.length; i++) {
      if (list[i].taskId !== t.id) continue;
      if (list[i].kind === 'done') return list[i].at;
      if (list[i].kind === 'reopened') return 0;
    }
    return 0;
  }

  function eventLine(e) {
    var details = [];
    if (e.subs) details.push(e.kind === 'done' ? 'avec ' + e.subs + (e.subs > 1 ? ' sous-tâches qui restaient' : ' sous-tâche qui restait')
      : 'avec ' + e.subs + (e.subs > 1 ? ' sous-tâches terminées avec elle' : ' sous-tâche terminée avec elle'));
    if (e.by) details.push('parce que sa sous-tâche « ' + clip(e.by, 80) + ' » l’a été');
    if (e.kind === 'type') details.push(e.fromType + ' → ' + e.toType);
    if (e.kind === 'moved') details.push(e.bottom ? 'en bas de la file' : e.rank ? 'au rang ' + e.rank : e.under ? 'sous « ' + e.under + ' »' : '');
    if (e.kind === 'created' && e.under) details.push('sous-tâche de « ' + e.under + ' »');
    if (e.agent) details.push(e.agent);
    if (e.from) details.push(FROM_WORDS[e.from] || e.from);
    details = details.filter(Boolean);
    var who = e.taskId && e.taskId !== '__feedback__' ? '[' + e.taskId + '] ' : '';
    return '- ' + A.fmtDate(e.at) + ' · ' + (EVENT_WORDS[e.kind] || e.kind) + ' — ' + who + '« ' + clip(e.title || '', 120) + ' »'
      + (details.length ? ' (' + details.join(', ') + ')' : '');
  }

  function historyText(a) {
    var list = events();
    if (!list.length) return ok('L’historique est vide : Organizator n’a encore rien noté (il note chaque geste sur la file depuis cette version).');
    var since = Number(a.since_hours) > 0 ? Date.now() - Number(a.since_hours) * 3600000 : 0;
    var t = a.id ? findTask(a.id) : null;
    if (a.id && !t && !list.some(function (e) { return e.taskId === a.id; })) return fail(unknownTask(a.id));
    var ids = {};
    if (a.id) { ids[a.id] = true; if (t) A.childrenOf(t.id).forEach(function (k) { ids[k.id] = true; }); }
    var limit = Math.max(1, Math.min(300, parseInt(a.limit, 10) || 60));
    var kept = list.filter(function (e) {
      return (!since || e.at >= since) && (!a.id || ids[e.taskId]) && (!a.kind || e.kind === a.kind);
    });
    var oldest = list[list.length - 1];
    var head = 'Historique de la file, le plus récent d’abord — noté depuis le ' + A.fmtDate(oldest.at) + ' (rien d’antérieur n’est connu)'
      + (a.id ? ', tâche [' + a.id + '] et ses sous-tâches' : '') + (since ? ', dernières ' + Number(a.since_hours) + ' h' : '')
      + (a.kind ? ', seulement « ' + (EVENT_WORDS[a.kind] || a.kind) + ' »' : '') + ' :';
    if (!kept.length) return ok(head + '\n(aucun événement)');
    return ok([head].concat(kept.slice(0, limit).map(eventLine))
      .concat(kept.length > limit ? ['… et ' + (kept.length - limit) + ' plus anciens (augmente limit).'] : []).join('\n'));
  }

  function taskSummary(t, rank) {
    var parts = [A.typeOf(t.type).label];
    var ended = t.done ? doneAt(t) : 0;
    if (t.done) parts.push(ended ? 'terminée le ' + A.fmtDate(ended) : 'terminée');
    else if (t.doing) parts.push('en cours');
    var kids = A.childrenOf(t.id);
    if (kids.length) parts.push(kids.length + ' sous-tâche' + (kids.length > 1 ? 's' : '') + ' (' + A.subtaskProgress(t).done + ' terminée' + (A.subtaskProgress(t).done > 1 ? 's' : '') + ')');
    if (t.jira) parts.push(t.jira);
    var prs = A.taskPullRequests(t);
    if (prs.length) parts.push(prs.length + ' PR');
    var convs = A.convosOf(t.id);
    if (convs.length) {
      parts.push(convs.length + ' conversation' + (convs.length > 1 ? 's' : '') + ' : ' + convs.slice(0, 3).map(convoLine).join(' ; ')
        + (convs.length > 3 ? ' ; …' : ''));
    }
    var band = bandOf(rank);
    return rank + '. [' + t.id + '] « ' + title(t) + ' » — ' + parts.join(' · ') + (band ? ' · bande ' + band : '');
  }

  function queueText(a) {
    var cat = a.category ? findCategory(a.category) : null;
    if (a.category && !cat) return fail(unknownCategory(a.category));
    var q = lower(a.search);
    var limit = Math.max(1, Math.min(300, parseInt(a.limit, 10) || 120));
    var ranks = rankMap();
    var lines = [], shown = 0, more = 0, doneHidden = 0, active = 0;
    var hit = {};
    if (q) {
      S.data.tasks.forEach(function (t) {
        var hay = lower(t.text + '\n' + A.attachmentsOf(t).map(function (x) { return x.name; }).join('\n'));
        if (hay.indexOf(q) >= 0) hit[(A.parentOf(t) || t).id] = true;
      });
    }
    S.data.tasks.forEach(function (t) {
      var root = A.parentOf(t) || t;
      if (!A.parentOf(t) && !t.done) active++;
      if (cat && root.type !== cat.id) return;
      if (q && !hit[root.id]) return;
      if (!a.include_done && (t.done || root.done)) { if (!A.parentOf(t)) doneHidden++; return; }
      if (shown >= limit) { more++; return; }
      lines.push((root !== t ? '    ' : '') + taskSummary(t, ranks[t.id]));
      shown++;
    });
    var head = 'File de tâches — l’ordre est la priorité (1 = la plus prioritaire). ' + active + ' tâches actives ; '
      + 'les ' + (S.settings.topCount || 3) + ' premières forment la bande « Maintenant ».'
      + (doneHidden ? ' ' + doneHidden + ' tâches terminées non montrées (include_done).' : '')
      + (cat ? ' Filtre : catégorie « ' + cat.label + ' ».' : '') + (q ? ' Recherche : « ' + a.search + ' ».' : '');
    return ok([head, ''].concat(lines.length ? lines : ['(aucune tâche)'])
      .concat(more ? ['… et ' + more + ' autres (augmente limit).'] : []).join('\n'));
  }

  function taskText(a) {
    var t = findTask(a.id);
    if (!t) return fail(unknownTask(a.id));
    var ranks = rankMap();
    var parent = A.parentOf(t);
    var out = ['Tâche [' + t.id + '], rang ' + ranks[t.id] + (bandOf(ranks[t.id]) ? ' (bande ' + bandOf(ranks[t.id]) + ')' : ''),
      'Catégorie : ' + A.typeOf(t.type).label,
      'État : ' + (t.done ? 'terminée' + (doneAt(t) ? ' le ' + A.fmtDate(doneAt(t)) : '') : (t.doing ? 'en cours' : 'à faire')),
      'Créée le ' + A.fmtDate(t.created)];
    if (parent) out.push('Sous-tâche de [' + parent.id + '] « ' + title(parent) + ' »');
    out.push('', 'Texte (1re ligne = titre) :', String(t.text || ''));
    var kids = A.childrenOf(t.id);
    if (kids.length) {
      out.push('', 'Sous-tâches :');
      kids.forEach(function (k) { out.push('- ' + taskSummary(k, ranks[k.id])); });
    }
    var past = events().filter(function (e) { return e.taskId === t.id; }).slice(0, 8);
    if (past.length) {
      out.push('', 'Historique récent (get_history pour la suite) :');
      past.forEach(function (e) { out.push(eventLine(e)); });
    }
    var atts = A.attachmentsOf(t);
    if (atts.length) {
      out.push('', 'Pièces jointes :');
      atts.forEach(function (x) { out.push('- ' + (x.kind === 'text' ? 'Texte « ' + (x.name || 'sans titre') + ' »' : x.name) + ' : ' + x.path); });
    }
    var convs = A.convosOf(t.id);
    if (convs.length) {
      out.push('', 'Conversations (la plus récente d’abord) :');
      convs.forEach(function (c) {
        var kws = A.keywordsByIds(t, A.keywordIdsFor(t, c.keywords)).map(function (k) { return k.name; });
        out.push('- [' + c.id + '] ' + convoLine(c) + ' · lancée le ' + A.fmtDate(c.created) + ', dernière activité ' + A.fmtDate(c.updated)
          + (kws.length ? ' · mots-clés : ' + kws.join(', ') : '') + ' · dossier ' + (c.cwd || '—'));
      });
      var reports = A.reportsOf(convs);
      if (reports.length) {
        out.push('', 'Rapports produits (lisibles avec Read) :');
        reports.slice(0, 12).forEach(function (r) { out.push('- ' + A.artifactFullPath(r.path, r.cwd)); });
      }
      var usage = A.usageOf ? A.usageOf(convs) : null;
      if (usage && A.usageText) { var u = A.usageText(usage); if (u) out.push('', 'Consommation : ' + u); }
    } else {
      out.push('', 'Aucune conversation d’agent.');
    }
    return ok(out.join('\n'));
  }

  function agentLine(ag) {
    var tune = [ag.model ? 'modèle ' + ag.model : '', ag.effort ? 'effort ' + ag.effort : ''].filter(Boolean).join(', ');
    return '    - ' + (ag.name || '(sans nom)') + (ag.role ? ' [' + ag.role + ']' : '') + (tune ? ' (' + tune + ')' : '')
      + ' : ' + (ag.prompt ? ag.prompt.replace(/\s*\n\s*/g, ' ') : '(pas de mission écrite)');
  }

  function categoriesText(a) {
    var only = a.category ? findCategory(a.category) : null;
    if (a.category && !only) return fail(unknownCategory(a.category));
    var out = [];
    (only ? [only] : S.data.types).forEach(function (ty) {
      var n = S.data.tasks.filter(function (t) { return t.type === ty.id && !t.done; }).length;
      out.push('## Catégorie « ' + ty.label + ' » [' + ty.id + '] — ' + n + ' tâche' + (n > 1 ? 's' : '') + ' active' + (n > 1 ? 's' : ''));
      var kws = Array.isArray(ty.keywords) ? ty.keywords : [];
      if (!kws.length) out.push('(aucun mot-clé)');
      kws.forEach(function (kw) {
        out.push('', '### Mot-clé « ' + kw.name + ' » [' + kw.id + ']');
        out.push('Description : ' + (kw.desc || '(aucune)'));
        out.push('Consigne :', kw.prompt ? kw.prompt : '(aucune : le mot-clé n’est qu’un mot)');
        var agents = Array.isArray(kw.agents) ? kw.agents.filter(function (x) { return x && x.name; }) : [];
        if (agents.length) {
          out.push('Équipe : ' + (kw.team ? 'lancée au démarrage' : 'en sommeil (case décochée : elle ne part pas)') + ', ' + agents.length + ' agent' + (agents.length > 1 ? 's' : '') + ' :');
          agents.forEach(function (ag) { out.push(agentLine(ag)); });
        } else {
          out.push('Équipe : aucune');
        }
      });
      out.push('');
    });
    out.push('Pour les agents d’une équipe — modèles possibles : ' + (A.teamModels().join(', ') || '(catalogue non détecté)')
      + ' ; efforts : ' + A.teamEfforts().join(', ') + ' ; rôles suggérés : ' + A.agentRoles.join(', ')
      + '. Modèle et effort vides = comme l’agent principal.');
    return ok(out.join('\n'));
  }

  /* ══ Déplacements ════════════════════════════════════════════════════
     Comme le glisser-déposer : une tâche de premier niveau emmène ses sous-tâches et se range parmi
     les groupes de premier niveau ; une sous-tâche se range parmi ses sœurs. `where` :
     { pos: top | bottom | before | after | rank, target (tâche), rank (1 = en tête) }. */

  function blockOf(t, asSub) {
    return asSub ? [t] : [t].concat(A.childrenOf(t.id));
  }

  /* Ce qui permet de revenir en arrière : le parent, et ce qui suivait le bloc à son niveau. */
  function positionOf(t) {
    var list = S.data.tasks, parent = A.parentOf(t);
    var block = blockOf(t, !!parent);
    var end = list.indexOf(block[block.length - 1]);
    var next = null;
    for (var i = end + 1; i < list.length; i++) {
      var x = list[i];
      if (parent ? x.parent === parent.id : !A.parentOf(x)) { next = x.id; break; }
      if (parent && x.parent !== parent.id) break;
    }
    return { parent: parent ? parent.id : null, next: next };
  }

  function placeTask(t, parentId, where) {
    A.hintMoved(t.id);
    var asSub = !!parentId;
    var block = blockOf(t, asSub);
    var ids = {};
    block.forEach(function (x) { ids[x.id] = true; });
    var rest = S.data.tasks.filter(function (x) { return !ids[x.id]; });
    if (asSub) t.parent = parentId; else delete t.parent;
    var idx;
    var parent = asSub ? A.taskById(parentId) : null;
    function at(x) { return rest.indexOf(x); }
    function endOf(x) {
      var kids = rest.filter(function (k) { return k.parent === x.id; });
      return at(kids.length ? kids[kids.length - 1] : x) + 1;
    }
    var target = where.target || null;
    if (asSub) {
      var sibs = rest.filter(function (k) { return k.parent === parentId; });
      if (where.pos === 'top') idx = at(parent) + 1;
      else if ((where.pos === 'before' || where.pos === 'after') && target && target.parent === parentId) idx = at(target) + (where.pos === 'after' ? 1 : 0);
      else idx = sibs.length ? at(sibs[sibs.length - 1]) + 1 : at(parent) + 1;
    } else {
      var root = target ? (A.parentOf(target) || target) : null;
      if (where.pos === 'top') idx = 0;
      else if (where.pos === 'before' && root) idx = at(root);
      else if (where.pos === 'after' && root) idx = endOf(root);
      else if (where.pos === 'rank') {
        var n = Math.max(1, parseInt(where.rank, 10) || 1), seen = 0, last = null;
        idx = -1;
        for (var i = 0; i < rest.length; i++) {
          var x = rest[i];
          if (A.parentOf(x) || x.done) continue;
          seen++;
          last = x;
          if (seen === n) { idx = i; break; }
        }
        if (idx < 0) idx = last ? endOf(last) : rest.length;
      } else idx = rest.length;
    }
    if (idx < 0 || idx > rest.length) idx = rest.length;
    Array.prototype.splice.apply(rest, [idx, 0].concat(block));
    S.data.tasks = rest;
    if (parent) delete parent.collapsed;
    A.commit();
  }

  function rankWords(r) { return r === '✓' ? 'terminée' : 'rang ' + r; }

  /* ══ Cartes ══════════════════════════════════════════════════════════
     Une action faite (status done → undone | failed) ou proposée (proposed → applied | refused,
     launching → launched | failed). `undo` dit comment la défaire, `proposal` ce qu'il faut faire. */

  function card(o) {
    o.kind = 'card';
    var e = push(o);
    renderAll();
    return e;
  }

  function undoCard(e) {
    if (!e || !e.undo || (e.status !== 'done' && e.status !== 'applied')) return;
    var res;
    try { res = A.fromSource('assistant', function () { return runUndo(e.undo); }); } catch (err) { res = fail(err.message); }
    if (!res.ok) { warn('Annulation impossible : ' + res.text); return; }
    e.status = 'undone';
    note('L’utilisateur a annulé : ' + e.title + (e.subject ? ' « ' + e.subject + ' »' : '') + '.');
    renderAll();
  }

  function runUndo(u) {
    var t, ty, kw;
    if (u.type === 'create') {
      var gone = u.ids.map(A.taskById).filter(Boolean);
      if (gone.some(function (x) { return A.convosOf(x.id).length; })) return fail('une des tâches a déjà des conversations.');
      var ids = {};
      gone.forEach(function (x) { ids[x.id] = true; });
      S.data.tasks = S.data.tasks.filter(function (x) { return !ids[x.id]; });
      if (ids[S.ui.editingId]) S.ui.editingId = null;
      A.commit();
      return ok('');
    }
    if (u.type === 'update') {
      t = A.taskById(u.id);
      if (!t) return fail('la tâche n’existe plus.');
      t.text = u.before.text; t.type = u.before.type; t.doing = u.before.doing; t.done = u.before.done;
      /* Ses sous-tâches et sa parente, terminées ou rouvertes avec elle, reprennent leur état. */
      if (u.before.family) A.restoreDone(u.before.family);
      A.commit();
      return ok('');
    }
    if (u.type === 'move') {
      t = A.taskById(u.id);
      if (!t) return fail('la tâche n’existe plus.');
      var parent = u.parent && A.taskById(u.parent) && !A.parentOf(A.taskById(u.parent)) ? u.parent : null;
      if (parent && A.childrenOf(t.id).length) parent = null;
      var next = u.next ? A.taskById(u.next) : null;
      placeTask(t, parent, next && (parent ? next.parent === parent : !A.parentOf(next)) ? { pos: 'before', target: next } : { pos: 'bottom' });
      return ok('');
    }
    if (u.type === 'cat-create') {
      if (S.data.tasks.some(function (x) { return x.type === u.id; })) return fail('des tâches portent déjà cette catégorie.');
      S.data.types = S.data.types.filter(function (x) { return x.id !== u.id; });
      A.commit();
      return ok('');
    }
    if (u.type === 'cat-update') {
      ty = A.typeOf(u.id);
      if (ty === A.notype) return fail('la catégorie n’existe plus.');
      ty.label = u.before.label; ty.bg = u.before.bg; ty.fg = u.before.fg; ty.bd = u.before.bd;
      A.commit();
      return ok('');
    }
    if (u.type === 'kw-create') {
      if (A.typeOf(u.typeId) === A.notype) return fail('la catégorie n’existe plus.');
      A.removeKeyword(u.typeId, u.kwId);
      return ok('');
    }
    if (u.type === 'kw-restore') {
      ty = A.typeOf(u.typeId);
      kw = findKeyword(ty, u.kwId);
      if (!kw) return fail('le mot-clé n’existe plus.');
      kw.name = u.before.name; kw.desc = u.before.desc; kw.prompt = u.before.prompt; kw.team = u.before.team; kw.agents = clone(u.before.agents);
      ty.keywords = A.normalizeKeywords(ty.keywords);
      A.commit();
      return ok('');
    }
    if (u.type === 'kw-reinsert') {
      ty = A.typeOf(u.typeId);
      if (ty === A.notype) return fail('la catégorie n’existe plus.');
      if (findKeyword(ty, u.kw.name)) return fail('un mot-clé de ce nom existe de nouveau.');
      var list = (ty.keywords || []).slice();
      list.splice(Math.min(u.index, list.length), 0, clone(u.kw));
      ty.keywords = A.normalizeKeywords(list);
      (u.convos || []).forEach(function (id) {
        var c = A.convoById(id);
        if (c && (c.keywords || []).indexOf(u.kw.id) < 0) c.keywords = (c.keywords || []).concat([u.kw.id]);
      });
      A.commit();
      return ok('');
    }
    return fail('action inconnue.');
  }

  function applyCard(e) {
    if (!e || e.status !== 'proposed' || !e.proposal) return;
    var p = e.proposal;
    if (p.op === 'launch') { launchCard(e); return; }
    var res;
    try { res = A.fromSource('assistant', function () { return applyProposal(p); }); } catch (err) { res = fail(err.message); }
    if (!res.ok) { warn('Impossible d’appliquer : ' + res.text); return; }
    e.status = 'applied';
    e.undo = res.undo || null;
    note('L’utilisateur a appliqué ta proposition : ' + e.title + (e.subject ? ' « ' + e.subject + ' »' : '') + '.');
    renderAll();
  }

  function refuseCard(e) {
    if (!e || e.status !== 'proposed') return;
    e.status = 'refused';
    note('L’utilisateur a refusé ta proposition : ' + e.title + (e.subject ? ' « ' + e.subject + ' »' : '') + '.');
    renderAll();
  }

  function applyProposal(p) {
    var ty = A.typeOf(p.typeId);
    if (ty === A.notype) return fail('la catégorie n’existe plus.');
    var kw = findKeyword(ty, p.kwId);
    if (!kw) return fail('le mot-clé n’existe plus.');
    if (p.op === 'kw-update') {
      var before = { name: kw.name, desc: kw.desc, prompt: kw.prompt, team: !!kw.team, agents: clone(kw.agents || []) };
      if (p.patch.name != null && lower(p.patch.name) !== lower(kw.name) && findKeyword(ty, p.patch.name)) return fail('le nom « ' + p.patch.name + ' » est déjà pris.');
      if (p.patch.name != null) kw.name = p.patch.name;
      if (p.patch.desc != null) kw.desc = p.patch.desc;
      if (p.patch.prompt != null) kw.prompt = p.patch.prompt;
      if (p.patch.team != null) kw.team = p.patch.team;
      if (p.patch.agents != null) kw.agents = A.normalizeAgents(clone(p.patch.agents));
      ty.keywords = A.normalizeKeywords(ty.keywords);
      A.commit();
      return { ok: true, undo: { type: 'kw-restore', typeId: ty.id, kwId: kw.id, before: before } };
    }
    if (p.op === 'kw-delete') {
      var index = (ty.keywords || []).indexOf(kw);
      var convos = S.data.convos.filter(function (c) {
        var t = A.taskById(c.taskId);
        return t && t.type === ty.id && (c.keywords || []).indexOf(kw.id) >= 0;
      }).map(function (c) { return c.id; });
      var copy = clone(kw);
      A.removeKeyword(ty.id, kw.id);
      return { ok: true, undo: { type: 'kw-reinsert', typeId: ty.id, index: index, kw: copy, convos: convos } };
    }
    return fail('proposition inconnue.');
  }

  /* Lancement proposé : « Lancer » part tout de suite, avec ce que la carte affiche ; « Formulaire… »
     ouvre le formulaire de la tâche, prérempli, pour retoucher avant de lancer. */
  function launchCard(e) {
    var p = e.proposal;
    var task = A.taskById(p.taskId);
    if (!task) { warn('La tâche n’existe plus.'); return; }
    if (S.ui.launchBusy) { warn('Un lancement est déjà en cours : réessayez dans un instant.'); return; }
    if (!p.cwd) { formCard(e); return; }
    e.status = 'launching';
    renderAll();
    var run;
    if (p.target === 'subs') {
      var subs = p.subs.map(A.taskById).filter(function (k) { return k && !k.done && k.parent === task.id; });
      run = A.launchBatch(task, { provider: p.provider, model: p.model, effort: p.effort, cwd: p.cwd, keywords: p.keywords, note: p.message, subs: subs })
        .then(function (r) {
          return r && r.n ? ok(r.n + ' conversation' + (r.n > 1 ? 's' : '') + ' lancée' + (r.n > 1 ? 's' : '') + (r.failed && r.failed.length ? ', ' + r.failed.length + ' en échec' : ''))
            : fail(r && r.failed && r.failed.length ? r.failed[0].message : 'rien n’est parti');
        });
    } else {
      run = A.flushTextWrites().then(function () { return A.recapTextFor(task); }).then(function (recap) {
        var prompt = A.buildPrompt(task) + (p.message ? '\n\n' + p.message : '');
        return A.startSession(task, p.provider, p.model, p.effort, p.cwd, A.keywordIdsFor(task, p.keywords), prompt, recap);
      }).then(function (c) { return c ? ok('conversation lancée') : fail('le lancement n’a pas abouti'); });
    }
    run.then(null, function (err) { return fail(err && err.message ? err.message : String(err)); }).then(function (r) {
      e.status = r.ok ? 'launched' : 'failed';
      e.result = r.text;
      note(r.ok ? 'Ta proposition de lancement sur « ' + e.subject + ' » a été acceptée : ' + r.text + '.'
        : 'Ta proposition de lancement sur « ' + e.subject + ' » a échoué : ' + r.text + '.');
      renderAll();
    });
  }

  function formCard(e) {
    var p = e.proposal;
    if (!A.taskById(p.taskId)) { warn('La tâche n’existe plus.'); return; }
    A.openLaunchForm(p.taskId, {
      provider: p.provider, model: p.model, effort: p.effort, cwd: p.cwd, keywords: p.keywords,
      target: p.target, subs: p.subs, note: p.message,
      prompt: p.message ? A.buildPrompt(A.taskById(p.taskId)) + '\n\n' + p.message : ''
    });
    if (e.status === 'proposed') {
      e.status = 'form';
      note('L’utilisateur a ouvert le formulaire de lancement de « ' + e.subject + ' » pour le régler lui-même.');
      saveSoon();
    }
    renderButton();
  }

  /* ══ Outils ══════════════════════════════════════════════════════════
     Servis à Claude sous mcp__organizator__<nom>. `run(args)` rend { ok, text } (ou une Promise) :
     le texte est ce que l'agent lit. Les descriptions disent ce qui s'applique tout de suite et ce
     qui n'est qu'une proposition. */

  var STR = { type: 'string' };
  var BOOL = { type: 'boolean' };

  function schema(props, required) {
    return { type: 'object', properties: props, required: required || [], additionalProperties: false };
  }

  var AGENT_SCHEMA = {
    type: 'array', maxItems: 8,
    description: 'Agents de l’équipe, dans l’ordre. Remplace toute l’équipe.',
    items: schema({
      name: { type: 'string', description: 'Nom court de l’agent.' },
      role: { type: 'string', description: 'Rôle qui le range : exploration, conception, implémentation, tests, revue, documentation, données, sécurité… (libre).' },
      model: { type: 'string', description: 'Modèle avec lequel l’ouvrir ; vide = comme l’agent principal.' },
      effort: { type: 'string', description: 'Effort attendu (low, medium, high…) ; vide = comme l’agent principal.' },
      mission: { type: 'string', description: 'Sa mission, précise.' }
    }, ['name'])
  };

  var TOOLS = [
    {
      name: 'get_queue',
      label: 'Lit la file',
      description: 'Lit la file de tâches dans l’ordre de priorité (rang 1 = la plus prioritaire) : identifiant entre crochets, titre, catégorie, état, sous-tâches (en retrait), conversations d’agent et leur état (au travail, attend une réponse, réponse prête…). Tâches actives seulement, sauf include_done.',
      inputSchema: schema({
        include_done: { type: 'boolean', description: 'Montrer aussi les tâches terminées.' },
        category: { type: 'string', description: 'Ne garder qu’une catégorie (nom).' },
        search: { type: 'string', description: 'Ne garder que les tâches dont le texte contient ce mot.' },
        limit: { type: 'integer', description: 'Nombre de lignes au plus (120 par défaut).' }
      }),
      run: queueText
    },
    {
      name: 'get_task',
      label: 'Lit une tâche',
      description: 'Lit une tâche en entier : texte complet, sous-tâches, pièces jointes, conversations (agent, modèle, état, dernière parole, mots-clés, dossier) et rapports produits (chemins à lire avec Read).',
      inputSchema: schema({ id: { type: 'string', description: 'Identifiant de la tâche.' } }, ['id']),
      run: taskText
    },
    {
      name: 'get_categories',
      label: 'Lit les mots-clés',
      description: 'Lit les catégories et leurs mots-clés en entier : description, consigne (le « script » donné à l’agent), équipe d’agents (nom, rôle, modèle, effort, mission). À lire avant de relire ou de réécrire des consignes.',
      inputSchema: schema({ category: { type: 'string', description: 'Une seule catégorie (nom) ; toutes sinon.' } }),
      run: categoriesText
    },
    {
      name: 'get_recap',
      label: 'Lit ce qu’ont rendu les agents',
      description: 'Ce qu’ont rendu les conversations d’une tâche (et de sa parente ou de ses sous-tâches) : la dernière réponse de chaque agent et les rapports produits. Pour répondre à « où en est… ».',
      inputSchema: schema({ id: { type: 'string', description: 'Identifiant de la tâche.' } }, ['id']),
      run: function (a) {
        var t = findTask(a.id);
        if (!t) return fail(unknownTask(a.id));
        return A.recapTextFor(t).then(function (text) {
          return ok(text ? clip(text, RESULT_MAX) : 'Aucune conversation rendue pour « ' + title(t) + ' » (ni sa parente, ni ses sous-tâches).');
        });
      }
    },
    {
      name: 'create_task',
      description: 'Crée une tâche (s’applique tout de suite, l’utilisateur peut annuler). Texte multi-lignes : 1re ligne = titre, la suite = contexte. Position : en tête de file par défaut (= haute priorité).',
      inputSchema: schema({
        text: { type: 'string', description: 'Texte de la tâche ; la première ligne est le titre.' },
        category: { type: 'string', description: 'Catégorie (nom), obligatoire sauf pour une sous-tâche (celle de la parente).' },
        position: { type: 'string', enum: ['top', 'bottom', 'before', 'after'], description: 'top (défaut), bottom, ou before/after target_id.' },
        target_id: { type: 'string', description: 'Tâche de référence pour before/after.' },
        parent_id: { type: 'string', description: 'Pour créer une sous-tâche : la tâche parente (un seul niveau).' },
        subtasks: { type: 'array', items: STR, maxItems: 20, description: 'Sous-tâches à créer sous elle (un texte chacune).' },
        doing: { type: 'boolean', description: 'La marquer « en cours ».' }
      }, ['text']),
      run: createTask
    },
    {
      name: 'update_task',
      description: 'Modifie une tâche (s’applique tout de suite, l’utilisateur peut annuler) : texte entier, ou titre seul (1re ligne), catégorie, « en cours », « terminée ».',
      inputSchema: schema({
        id: { type: 'string' },
        text: { type: 'string', description: 'Nouveau texte complet (remplace tout).' },
        title: { type: 'string', description: 'Nouveau titre seul : la suite du texte est gardée.' },
        category: { type: 'string', description: 'Nouvelle catégorie (nom).' },
        doing: BOOL,
        done: { type: 'boolean', description: 'Terminer une tâche termine ses sous-tâches ; la rouvrir rouvre celles terminées avec elle ; rouvrir une sous-tâche rouvre sa parente.' }
      }, ['id']),
      run: updateTask
    },
    {
      name: 'move_task',
      description: 'Déplace une tâche dans la file (s’applique tout de suite, l’utilisateur peut annuler) : l’ordre est la priorité, « remettre en haute priorité » = position top. Une tâche emmène ses sous-tâches ; une sous-tâche se range parmi ses sœurs. parent_id change le niveau : vide pour en faire une tâche de premier niveau, l’identifiant d’une tâche pour en faire sa sous-tâche.',
      inputSchema: schema({
        id: { type: 'string' },
        position: { type: 'string', enum: ['top', 'bottom', 'before', 'after', 'rank'], description: 'top = en tête, bottom = en bas, before/after target_id, rank = au rang donné (1 = en tête).' },
        target_id: { type: 'string', description: 'Tâche de référence pour before/after.' },
        rank: { type: 'integer', description: 'Rang visé pour position rank.' },
        parent_id: { type: 'string', description: 'Nouveau parent (vide = premier niveau). Absent = niveau inchangé.' }
      }, ['id', 'position']),
      run: moveTask
    },
    {
      name: 'create_category',
      description: 'Crée une catégorie (s’applique tout de suite, l’utilisateur peut annuler).',
      inputSchema: schema({
        name: STR,
        color: { type: 'string', enum: A.palettes.map(function (p) { return p.id; }), description: 'Couleur ; une libre par défaut.' }
      }, ['name']),
      run: createCategory
    },
    {
      name: 'update_category',
      description: 'Renomme une catégorie ou change sa couleur (s’applique tout de suite, l’utilisateur peut annuler).',
      inputSchema: schema({
        category: { type: 'string', description: 'Catégorie (nom).' },
        name: STR,
        color: { type: 'string', enum: A.palettes.map(function (p) { return p.id; }) }
      }, ['category']),
      run: updateCategory
    },
    {
      name: 'create_keyword',
      description: 'Crée un mot-clé dans une catégorie (s’applique tout de suite, l’utilisateur peut annuler) : nom, description, consigne pour l’agent, équipe d’agents éventuelle.',
      inputSchema: schema({
        category: { type: 'string', description: 'Catégorie (nom).' },
        name: STR,
        description: { type: 'string', description: 'À quoi il sert (une phrase).' },
        instruction: { type: 'string', description: 'La consigne donnée à l’agent qui le reçoit.' },
        team: { type: 'boolean', description: 'Lancer l’équipe au démarrage.' },
        agents: AGENT_SCHEMA
      }, ['category', 'name']),
      run: createKeyword
    },
    {
      name: 'update_keyword',
      description: 'PROPOSE de modifier un mot-clé existant (nom, description, consigne, équipe) : l’utilisateur voit l’avant/après et applique ou refuse d’un clic. Rien n’est changé tant qu’il n’a pas appliqué ; ne le présente pas comme fait. Les champs absents restent tels quels ; donne la consigne réécrite en entier.',
      inputSchema: schema({
        category: { type: 'string', description: 'Catégorie (nom).' },
        keyword: { type: 'string', description: 'Mot-clé visé (nom).' },
        name: { type: 'string', description: 'Nouveau nom.' },
        description: STR,
        instruction: { type: 'string', description: 'Nouvelle consigne complète.' },
        team: BOOL,
        agents: AGENT_SCHEMA,
        reason: { type: 'string', description: 'Pourquoi, en une ou deux phrases (affiché à l’utilisateur).' }
      }, ['category', 'keyword']),
      run: proposeKeywordUpdate
    },
    {
      name: 'delete_keyword',
      description: 'PROPOSE de supprimer un mot-clé : l’utilisateur applique ou refuse d’un clic. Rien n’est supprimé tant qu’il n’a pas appliqué.',
      inputSchema: schema({
        category: STR,
        keyword: STR,
        reason: { type: 'string', description: 'Pourquoi (affiché à l’utilisateur).' }
      }, ['category', 'keyword']),
      run: proposeKeywordDelete
    },
    {
      name: 'launch_conversation',
      description: 'PROPOSE de lancer une conversation d’agent (Claude Code ou Copilot, dans un terminal) sur une tâche, ou une par sous-tâche : l’utilisateur la lance d’un clic, ou ouvre le formulaire pour la régler. Rien ne part sans lui. Par défaut : l’agent, le modèle, l’effort et le dossier des réglages.',
      inputSchema: schema({
        id: { type: 'string', description: 'Tâche.' },
        target: { type: 'string', enum: ['self', 'subtasks'], description: 'self (défaut) ou subtasks : une conversation par sous-tâche non terminée.' },
        subtask_ids: { type: 'array', items: STR, description: 'Avec subtasks : les sous-tâches à lancer (défaut : celles sans rapport de revue ni conversation en cours).' },
        provider: { type: 'string', enum: ['claude', 'copilot'] },
        model: STR,
        effort: STR,
        keywords: { type: 'array', items: STR, description: 'Mots-clés de la catégorie à cocher (noms) : leur consigne part avec l’agent.' },
        message: { type: 'string', description: 'Précision ajoutée à la fin du premier message (la tâche part toujours).' },
        cwd: { type: 'string', description: 'Dossier de travail (défaut : celui des conversations de la tâche, ou le réglage).' }
      }, ['id']),
      run: proposeLaunch
    },
    {
      name: 'get_history',
      label: 'Lit l’historique',
      description: 'L’historique de la file, le plus récent d’abord, daté et sourcé : tâches créées, terminées (avec les sous-tâches qu’elles emportent), rouvertes, passées en cours ou plus, déplacées, changées de catégorie, supprimées ; conversations lancées ; sessions du carnet de remarques archivées. Chaque ligne dit d’où vient le geste : la file, la fenêtre Conversations (y « archiver » une conversation termine sa tâche, l’« épingler » la passe en cours), ou toi. Pour « qu’est-ce que je viens de faire / d’archiver / de terminer », « quand ai-je… ».',
      inputSchema: schema({
        since_hours: { type: 'number', description: 'Seulement les dernières heures (2 = depuis deux heures).' },
        id: { type: 'string', description: 'Seulement cette tâche et ses sous-tâches.' },
        kind: { type: 'string', enum: Object.keys(EVENT_WORDS), description: 'Seulement ce genre d’événement (done = terminée, archived = session du carnet archivée…).' },
        limit: { type: 'integer', description: 'Nombre de lignes au plus (60 par défaut).' }
      }),
      run: historyText
    },
    {
      name: 'show_document',
      label: 'Montre un document',
      description: 'Montre un fichier à l’utilisateur : à droite de la discussion dans la fenêtre Conversations quand il te parle de là, sinon dans le lecteur de la fenêtre principale — Markdown, PDF, image, page HTML, CSV, texte. Pour lui présenter un rapport d’une conversation, un document cité, plutôt que d’en recopier le contenu.',
      inputSchema: schema({
        path: { type: 'string', description: 'Chemin complet du fichier (celui des rapports de get_task, par exemple).' },
        title: { type: 'string', description: 'Titre court à afficher (facultatif).' }
      }, ['path']),
      run: showDocument
    },
    {
      name: 'open_task',
      label: 'Montre une tâche',
      description: 'Montre une tâche à l’utilisateur dans la file : elle défile jusqu’à elle et la fait briller un instant.',
      inputSchema: schema({ id: STR }, ['id']),
      run: function (a) {
        var t = findTask(a.id);
        if (!t) return fail(unknownTask(a.id));
        reveal(t.id);
        return ok('Tâche montrée.');
      }
    }
  ];

  /* Le fichier doit exister ; il s'ouvre là d'où l'utilisateur écrit (la fenêtre Conversations le
     reçoit par le résumé de la discussion : remoteSummary.show). */
  function showDocument(a) {
    var path = String(a.path || '').trim();
    if (!path) return fail('Indique le chemin du fichier (path).');
    return bridge.call('readArtifact', { path: path, cwd: '', peek: true }).then(function (v) {
      if (!v || v.kind === 'missing') return fail('Fichier introuvable : ' + path + '.');
      var full = v.full || path;
      var title = clip(String(a.title || '').trim(), 120);
      if (lastFrom === 'remote' && remote.watching) {
        remote.show = { path: full, title: title, at: now() };
        pushRemote();
        return ok('Document ouvert pour l’utilisateur, dans le panneau de droite de la fenêtre Conversations (' + full + ').');
      }
      A.openReader(full, '');
      return ok('Document ouvert pour l’utilisateur, dans le lecteur de la fenêtre principale (' + full + ').');
    });
  }

  var TOOL_BY_NAME = {};
  TOOLS.forEach(function (t) { TOOL_BY_NAME[t.name] = t; });

  function toolDefs() {
    return TOOLS.map(function (t) { return { name: t.name, description: t.description, inputSchema: t.inputSchema }; });
  }

  function reveal(id) {
    var t = A.taskById(id);
    if (!t) return;
    var parent = A.parentOf(t);
    if (parent && parent.collapsed) { delete parent.collapsed; A.commit(); }
    if (A.currentPage() !== 'queue') A.goPage('queue', true);
    A.revealTask(id);
  }

  function taskCard(o) {
    return card({ tool: o.tool, title: o.title, subject: o.subject, detail: o.detail || '', taskId: o.taskId || '', status: 'done', undo: o.undo });
  }

  function createTask(a) {
    var text = String(a.text || '').replace(/\r\n?/g, '\n').trim();
    if (!text) return fail('Le texte de la tâche est vide.');
    var parent = a.parent_id ? findTask(a.parent_id) : null;
    if (a.parent_id && !parent) return fail(unknownTask(a.parent_id));
    if (parent && A.parentOf(parent)) return fail('« ' + title(parent) + ' » est déjà une sous-tâche : un seul niveau de sous-tâches.');
    var ty = a.category ? findCategory(a.category) : (parent ? A.typeOf(parent.type) : null);
    if (!ty || ty === A.notype) return fail(a.category ? unknownCategory(a.category) : 'Précise la catégorie (category). Catégories : ' + categoryNames() + '.');
    var target = a.target_id ? findTask(a.target_id) : null;
    if (a.target_id && !target) return fail(unknownTask(a.target_id));
    if ((a.position === 'before' || a.position === 'after') && !target) return fail('Donne target_id pour before/after.');
    var t = { id: A.uid('n'), type: ty.id, text: text.slice(0, 20000), done: false, doing: !!a.doing, created: now() };
    S.data.tasks.unshift(t);
    placeTask(t, parent ? parent.id : null, { pos: a.position || (parent ? 'bottom' : 'top'), target: target });
    var created = [t.id];
    var subs = (Array.isArray(a.subtasks) ? a.subtasks : []).map(function (s) { return String(s || '').trim(); }).filter(Boolean).slice(0, 20);
    if (subs.length && !parent) {
      var at = S.data.tasks.indexOf(t) + 1;
      subs.forEach(function (s, i) {
        var k = { id: A.uid('n'), type: ty.id, text: s.slice(0, 20000), done: false, doing: false, created: now(), parent: t.id };
        S.data.tasks.splice(at + i, 0, k);
        created.push(k.id);
      });
      A.commit();
    }
    var r = rankMap()[t.id];
    taskCard({
      tool: 'create_task', title: parent ? 'Sous-tâche créée' : 'Tâche créée', subject: title(t), taskId: t.id,
      detail: ty.label + ' · ' + rankWords(r) + (subs.length && !parent ? ' · ' + subs.length + ' sous-tâche' + (subs.length > 1 ? 's' : '') : ''),
      undo: { type: 'create', ids: created.slice().reverse() }
    });
    reveal(t.id);
    return ok('Tâche créée : [' + t.id + '] « ' + title(t) + ' », ' + rankWords(r) + '.'
      + (subs.length && !parent ? ' Sous-tâches : ' + created.slice(1).map(function (id) { return '[' + id + ']'; }).join(', ') + '.' : '')
      + (subs.length && parent ? ' (Sous-tâches ignorées : une sous-tâche n’en a pas.)' : ''));
  }

  function updateTask(a) {
    var t = findTask(a.id);
    if (!t) return fail(unknownTask(a.id));
    var before = { text: t.text, type: t.type, doing: !!t.doing, done: !!t.done, family: A.doneSnapshot(t) };
    var changes = [];
    if (a.text != null && String(a.text).trim()) {
      t.text = String(a.text).replace(/\r\n?/g, '\n').trim().slice(0, 20000);
      changes.push('texte réécrit');
    } else if (a.title != null && String(a.title).trim()) {
      var lines = String(t.text || '').split('\n');
      lines[0] = String(a.title).replace(/\s*\n\s*/g, ' ').trim();
      t.text = lines.join('\n');
      changes.push('titre changé');
    }
    if (a.category != null) {
      var ty = findCategory(a.category);
      if (!ty) { t.text = before.text; return fail(unknownCategory(a.category)); }
      if (ty.id !== t.type) { t.type = ty.id; changes.push('catégorie → ' + ty.label); }
    }
    /* Terminer ou rouvrir suit la règle de la file : les sous-tâches avec la parente (setDone). */
    var family = null;
    if (typeof a.doing === 'boolean' && a.doing !== !!t.doing) {
      t.doing = a.doing;
      if (a.doing && t.done) family = A.setDone(t, false);
      changes.push(a.doing ? 'mise en cours' : 'plus en cours');
    }
    if (typeof a.done === 'boolean' && a.done !== !!t.done) {
      family = A.setDone(t, a.done);
      changes.push(a.done ? 'terminée' : 'rouverte');
    }
    if (family && (family.closed || family.reopened)) {
      var n = family.closed || family.reopened;
      changes.push(n + ' sous-tâche' + (n > 1 ? 's' : '') + (family.closed ? ' terminée' : ' rouverte') + (n > 1 ? 's' : '') + ' avec elle');
    }
    if (family && family.parent) changes.push('parente « ' + title(family.parent) + ' » rouverte');
    if (!changes.length) return fail('Rien ne change : donne text, title, category, doing ou done.');
    A.commit();
    taskCard({ tool: 'update_task', title: 'Tâche modifiée', subject: title(t), taskId: t.id, detail: changes.join(' · '), undo: { type: 'update', id: t.id, before: before } });
    return ok('Tâche [' + t.id + '] modifiée : ' + changes.join(', ') + '.');
  }

  function moveTask(a) {
    var t = findTask(a.id);
    if (!t) return fail(unknownTask(a.id));
    var pos = a.position || 'top';
    var target = a.target_id ? findTask(a.target_id) : null;
    if (a.target_id && !target) return fail(unknownTask(a.target_id));
    if ((pos === 'before' || pos === 'after') && !target) return fail('Donne target_id pour before/after.');
    if (target && (target === t || target.parent === t.id)) return fail('La tâche de référence ne peut pas être la tâche déplacée ni l’une de ses sous-tâches.');
    var parentId = A.parentOf(t) ? t.parent : null;
    if (a.parent_id !== undefined && a.parent_id !== null) {
      var p = String(a.parent_id).trim() ? findTask(a.parent_id) : null;
      if (String(a.parent_id).trim() && !p) return fail(unknownTask(a.parent_id));
      if (p && (p === t || A.parentOf(p))) return fail('Le parent doit être une tâche de premier niveau, autre que celle-ci.');
      if (p && A.childrenOf(t.id).length) return fail('« ' + title(t) + ' » a des sous-tâches : elle ne peut pas devenir une sous-tâche (un seul niveau).');
      parentId = p ? p.id : null;
    }
    if (pos === 'rank' && parentId) return fail('position rank vaut pour une tâche de premier niveau ; pour une sous-tâche, top, bottom, before ou after.');
    var ranks = rankMap();
    var from = ranks[t.id];
    var undo = positionOf(t);
    undo.type = 'move';
    undo.id = t.id;
    placeTask(t, parentId, { pos: pos, target: target, rank: a.rank });
    var to = rankMap()[t.id];
    var what = pos === 'top' ? (parentId ? 'En tête de ses sous-tâches' : 'Remontée en tête de file')
      : pos === 'bottom' ? (parentId ? 'En bas de ses sous-tâches' : 'Descendue en bas de file')
      : pos === 'rank' ? 'Déplacée au rang ' + to : 'Déplacée';
    taskCard({ tool: 'move_task', title: what, subject: title(t), taskId: t.id, detail: rankWords(from) + ' → ' + rankWords(to), undo: undo });
    reveal(t.id);
    return ok('Tâche [' + t.id + '] : ' + rankWords(from) + ' → ' + rankWords(to) + (parentId ? ' (sous-tâche de [' + parentId + '])' : '') + '.');
  }

  function paletteOf(id) {
    for (var i = 0; i < A.palettes.length; i++) if (A.palettes[i].id === id) return A.palettes[i];
    return null;
  }

  function createCategory(a) {
    var name = String(a.name || '').trim().slice(0, 60);
    if (!name) return fail('Donne un nom à la catégorie.');
    if (findCategory(name)) return fail('La catégorie « ' + name + ' » existe déjà.');
    var used = S.data.types.map(function (t) { return t.bg; });
    var p = paletteOf(a.color) || A.palettes.filter(function (x) { return used.indexOf(x.bg) < 0; })[0] || A.palettes[0];
    var ty = { id: A.uid('k'), label: name, bg: p.bg, fg: p.fg, bd: p.bd, keywords: [], custom: true };
    S.data.types.push(ty);
    A.commit();
    card({ tool: 'create_category', title: 'Catégorie créée', subject: name, detail: p.title, status: 'done', undo: { type: 'cat-create', id: ty.id } });
    return ok('Catégorie « ' + name + ' » créée [' + ty.id + '].');
  }

  function updateCategory(a) {
    var ty = findCategory(a.category);
    if (!ty) return fail(unknownCategory(a.category));
    var before = { label: ty.label, bg: ty.bg, fg: ty.fg, bd: ty.bd };
    var changes = [];
    var name = a.name != null ? String(a.name).trim().slice(0, 60) : '';
    if (name && name !== ty.label) {
      var other = findCategory(name);
      if (other && other !== ty) return fail('Le nom « ' + name + ' » est déjà pris.');
      ty.label = name;
      changes.push('renommée « ' + before.label + ' » → « ' + name + ' »');
    }
    var p = a.color ? paletteOf(a.color) : null;
    if (a.color && !p) return fail('Couleur inconnue : ' + a.color + '.');
    if (p && p.bg !== ty.bg) { ty.bg = p.bg; ty.fg = p.fg; ty.bd = p.bd; changes.push('couleur ' + p.title); }
    if (!changes.length) return fail('Rien ne change.');
    A.commit();
    card({ tool: 'update_category', title: 'Catégorie modifiée', subject: ty.label, detail: changes.join(' · '), status: 'done', undo: { type: 'cat-update', id: ty.id, before: before } });
    return ok('Catégorie modifiée : ' + changes.join(', ') + '.');
  }

  function agentsFrom(list) {
    return A.normalizeAgents((Array.isArray(list) ? list : []).map(function (x) {
      return { name: x && x.name, role: x && x.role, model: x && x.model, effort: x && x.effort, prompt: x && (x.mission != null ? x.mission : x.prompt) };
    }));
  }

  function createKeyword(a) {
    var ty = findCategory(a.category);
    if (!ty) return fail(unknownCategory(a.category));
    var name = String(a.name || '').trim().slice(0, 80);
    if (!name) return fail('Donne un nom au mot-clé.');
    if (findKeyword(ty, name)) return fail('Le mot-clé « ' + name + ' » existe déjà dans « ' + ty.label + ' » : utilise update_keyword.');
    if ((ty.keywords || []).length >= A.keywordMax) return fail('« ' + ty.label + ' » a déjà ' + A.keywordMax + ' mots-clés, le maximum.');
    var kw = { id: A.uid('w'), name: name, desc: String(a.description || '').trim(), prompt: String(a.instruction || '').trim(), team: !!a.team, agents: agentsFrom(a.agents) };
    ty.keywords = A.normalizeKeywords((ty.keywords || []).concat([kw]));
    A.commit();
    var n = A.teamOf(kw).length;
    card({
      tool: 'create_keyword', title: 'Mot-clé créé', subject: name, status: 'done',
      detail: ty.label + (kw.prompt ? ' · consigne de ' + kw.prompt.length + ' caractères' : ' · sans consigne') + (n ? ' · équipe de ' + n : ''),
      undo: { type: 'kw-create', typeId: ty.id, kwId: kw.id }
    });
    return ok('Mot-clé « ' + name + ' » créé dans « ' + ty.label + ' » [' + kw.id + '].');
  }

  function proposeKeywordUpdate(a) {
    var ty = findCategory(a.category);
    if (!ty) return fail(unknownCategory(a.category));
    var kw = findKeyword(ty, a.keyword);
    if (!kw) return fail(unknownKeyword(ty, a.keyword));
    var patch = {};
    if (a.name != null && String(a.name).trim() && String(a.name).trim() !== kw.name) {
      var name = String(a.name).trim().slice(0, 80);
      if (findKeyword(ty, name)) return fail('Le nom « ' + name + ' » est déjà pris dans « ' + ty.label + ' ».');
      patch.name = name;
    }
    if (a.description != null && String(a.description).trim() !== (kw.desc || '')) patch.desc = String(a.description).trim().slice(0, 160);
    if (a.instruction != null && String(a.instruction).trim() !== (kw.prompt || '')) patch.prompt = String(a.instruction).trim().slice(0, 4000);
    if (typeof a.team === 'boolean' && a.team !== !!kw.team) patch.team = a.team;
    if (Array.isArray(a.agents)) {
      var agents = agentsFrom(a.agents);
      var key = function (list) { return JSON.stringify((list || []).filter(function (x) { return x.name; }).map(function (x) { return [x.name, x.role, x.model, x.effort, x.prompt]; })); };
      if (key(agents) !== key(kw.agents)) patch.agents = agents;
    }
    if (!Object.keys(patch).length) return fail('Rien ne change par rapport au mot-clé actuel.');
    var e = card({
      tool: 'update_keyword', title: 'Modifier le mot-clé', subject: kw.name, detail: ty.label, reason: String(a.reason || '').trim(),
      status: 'proposed', proposal: { op: 'kw-update', typeId: ty.id, kwId: kw.id, patch: patch },
      before: { name: kw.name, desc: kw.desc || '', prompt: kw.prompt || '', team: !!kw.team, agents: clone(kw.agents || []) }
    });
    attention();
    return ok('Proposition affichée à l’utilisateur (' + e.title + ' « ' + kw.name + ' ») : il l’appliquera ou la refusera d’un clic, tu le sauras à son prochain message. Ne la présente pas comme faite.');
  }

  function proposeKeywordDelete(a) {
    var ty = findCategory(a.category);
    if (!ty) return fail(unknownCategory(a.category));
    var kw = findKeyword(ty, a.keyword);
    if (!kw) return fail(unknownKeyword(ty, a.keyword));
    card({
      tool: 'delete_keyword', title: 'Supprimer le mot-clé', subject: kw.name, detail: ty.label, reason: String(a.reason || '').trim(),
      status: 'proposed', proposal: { op: 'kw-delete', typeId: ty.id, kwId: kw.id }
    });
    attention();
    return ok('Proposition de suppression affichée à l’utilisateur : rien n’est supprimé tant qu’il ne l’a pas appliquée.');
  }

  var MODEL_RULE = /^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]{0,79}$/;

  function proposeLaunch(a) {
    var task = findTask(a.id);
    if (!task) return fail(unknownTask(a.id));
    if (task.done) return fail('« ' + title(task) + ' » est terminée.');
    var subsAll = A.batchSubsOf(task);
    var target = a.target === 'subtasks' ? 'subs' : 'self';
    if (target === 'subs' && !subsAll.length) return fail('« ' + title(task) + ' » n’a pas de sous-tâche à faire.');
    var provider = a.provider === 'copilot' || a.provider === 'claude' ? a.provider : A.defaultProviderId();
    if (!A.hasProvider(provider)) return fail(A.providerById(provider).missing);
    var model = a.model != null ? String(a.model).trim() : String(S.settings[A.modelSettingKey(provider)] || '');
    if (model && !MODEL_RULE.test(model)) return fail('Nom de modèle invalide : ' + model);
    var effort = a.effort != null ? lower(a.effort) : String(S.settings[A.effortSettingKey(provider)] || '');
    if (effort && A.effortsFor(provider).indexOf(effort) < 0) return fail('Effort inconnu pour ' + A.providerById(provider).label + ' : ' + effort + ' (' + A.effortsFor(provider).join(', ') + ').');
    var wanted = Array.isArray(a.keywords) ? a.keywords.map(function (k) { return String(k || '').trim(); }).filter(Boolean) : [];
    var known = A.keywordsByIds(task, A.keywordIdsFor(task, wanted)).map(function (k) { return k.name; });
    var unknown = wanted.filter(function (w) { return !known.some(function (k) { return lower(k) === lower(w); }); });
    var subs = [];
    if (target === 'subs') {
      var ids = Array.isArray(a.subtask_ids) ? a.subtask_ids.map(function (x) { return String(x || '').trim(); }) : null;
      subs = subsAll.filter(function (k) {
        return ids ? ids.indexOf(k.id) >= 0 : !A.reviewReportsOf(A.convosOf(k.id)).length && !A.batchSubBusy(k);
      }).map(function (k) { return k.id; });
      if (!subs.length) return fail('Aucune sous-tâche à lancer' + (ids ? ' parmi celles données' : ' : toutes ont déjà un rapport de revue ou une conversation en cours') + '.');
    }
    var cwd = String(a.cwd || '').trim() || (target === 'subs' ? A.groupCwdFor(task) : A.defaultCwdFor(task.id)) || '';
    var message = String(a.message || '').trim().slice(0, 4000);
    card({
      tool: 'launch_conversation', title: target === 'subs' ? 'Lancer une conversation par sous-tâche' : 'Lancer une conversation', subject: title(task),
      taskId: task.id, status: 'proposed',
      proposal: { op: 'launch', taskId: task.id, target: target, subs: subs, provider: provider, model: model, effort: effort, keywords: known, message: message, cwd: cwd }
    });
    attention();
    return ok('Proposition de lancement affichée à l’utilisateur (' + A.providerById(provider).short + (model ? ' · ' + model : '') + (effort ? ' · ' + effort : '')
      + (target === 'subs' ? ', ' + subs.length + ' sous-tâche' + (subs.length > 1 ? 's' : '') : '') + (cwd ? ', dans ' + cwd : ', dossier à choisir') + ').'
      + (unknown.length ? ' Mots-clés inconnus dans la catégorie, ignorés : ' + unknown.join(', ') + '.' : '')
      + ' Rien ne part sans son clic ; tu le sauras à son prochain message.');
  }

  /* Un appel d'outil de l'hôte : exécuté sur l'état de l'application, résultat rendu à l'hôte. */
  function runTool(p) {
    var tool = TOOL_BY_NAME[p.name];
    var res;
    if (busy) {
      busy.phase = 'call';
      busy.label = tool && tool.label ? tool.label : 'Agit sur la file';
    }
    if (tool && tool.label) addToolLine(p.turn, tool.label);
    try {
      res = tool ? A.fromSource('assistant', function () { return tool.run(p.args && typeof p.args === 'object' ? p.args : {}); }) : fail('Outil inconnu : ' + p.name);
    } catch (err) {
      res = fail('Erreur dans Organizator : ' + (err && err.message ? err.message : String(err)));
      if (window.console) console.error('[assistant] ' + p.name, err);
    }
    Promise.resolve(res).then(null, function (err) { return fail(err && err.message ? err.message : String(err)); }).then(function (r) {
      r = r || fail('Pas de résultat.');
      return bridge.call('assistantToolResult', { call: p.call, ok: r.ok !== false, text: clip(r.text || '', RESULT_MAX) });
    })['catch'](function () { /* l'appel a échu côté hôte */ });
    renderAll();
  }

  /* ══ Discussion ══════════════════════════════════════════════════════ */

  var SYSTEM = [
    'Tu es l’assistant d’Organizator, l’application de bureau où l’utilisateur tient sa file de tâches priorisée et lance, pour chaque tâche, des conversations d’agents de code (Claude Code ou GitHub Copilot CLI) dans des terminaux. Tu lui parles dans un panneau de l’application. Réponds en français, brièvement, en Markdown simple (pas de titres de premier niveau).',
    '',
    'Organizator :',
    '- La file : l’ordre des tâches EST la priorité (rang 1 = la plus prioritaire). Les premières forment la bande « Maintenant », puis « Ensuite » et « Plus tard ». « Remettre en haute priorité » = remonter la tâche en tête de file (move_task, position top), sauf précision.',
    '- Une tâche : un texte (1re ligne = titre, la suite = contexte), une catégorie, « en cours », « terminée ». Une tâche terminée garde sa place. Sous-tâches sur un seul niveau, rangées sous leur parente et déplacées avec elle.',
    '- Une catégorie porte des mots-clés. Un mot-clé = un nom, une description, une consigne donnée à l’agent (son « script »), et parfois une équipe d’agents (nom, rôle, modèle, effort, mission) que l’agent principal ouvre en parallèle dès le départ. On coche les mots-clés au lancement d’une conversation ; leur consigne et leur équipe partent dans le prompt système de l’agent.',
    '- Les conversations : des sessions d’agent liées à une tâche, avec leur état (au travail, attend une réponse, réponse prête, erreur, fermée), leur dernière parole et leurs rapports (fichiers à lire avec Read).',
    '',
    'Tes outils (serveur « organizator ») :',
    '- Relis avant d’agir (get_queue, get_task, get_categories) : la file change aussi sans toi. Désigne les tâches par leur identifiant entre crochets, jamais par un rang qui a pu bouger.',
    '- Créer, modifier, déplacer une tâche, la marquer en cours ou terminée, créer une catégorie ou un mot-clé : s’applique tout de suite, l’utilisateur peut annuler d’un clic. Fais-le quand on te le demande, sans redemander confirmation, puis dis en une ligne ce que tu as fait.',
    '- L’historique (get_history) date chaque geste sur la file et dit d’où il vient. Dans la fenêtre Conversations, « archiver » une conversation termine sa tâche, l’« épingler » la passe en cours : « qu’est-ce que je viens d’archiver » se lit dans l’historique (terminée, depuis la fenêtre Conversations).',
    '- Réécrire ou supprimer un mot-clé existant, lancer une conversation : ce sont des PROPOSITIONS, que l’utilisateur applique ou refuse d’un clic. Ne les présente jamais comme faites. Ce qu’il en a décidé t’est dit en tête de son message suivant.',
    '- Tu ne supprimes pas de tâche : pour en écarter une, marque-la terminée ou descends-la en bas de file.',
    '- Tu peux lire le disque (Read, Grep, Glob) — rapports des conversations, sources d’un projet — mais rien y écrire.',
    '- Pour présenter un fichier à l’utilisateur (un rapport, un document cité), montre-le (show_document) plutôt que d’en recopier le contenu.',
    '',
    'Revue des consignes des agents (« review mes scripts ») : lis toutes les catégories (get_categories), puis juge chaque mot-clé — consigne claire et actionnable, livrable attendu (fichier rapport, format, où l’écrire), critère de fin, garde-fous avant les actions irréversibles (push, merge, commentaire de PR, ticket), cohérence avec l’équipe (rôles qui se recouvrent, missions vagues, modèle ou effort mal dosés : un relevé se contente d’un modèle rapide, une conception mérite le plus fort), doublons entre mots-clés, manques. Donne un constat bref par mot-clé et les points communs, puis propose les réécritures les plus utiles avec update_keyword : une proposition par mot-clé, consigne complète, dans le style et le vocabulaire de l’utilisateur.',
    '',
    'Chaque message de l’utilisateur commence par une ligne entre crochets : la date, l’heure et ce qui s’est passé depuis ton dernier message (propositions appliquées ou refusées, actions annulées). C’est du contexte, pas une demande.'
  ].join('\n');

  function stamp() {
    var d = new Date();
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      + ', ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  /* `fromRemote` : le message vient de la fenêtre Conversations — la zone de saisie d'ici, et ce qu'on
     y tape, n'y sont pour rien ; un échec lui rend son texte. Rend vrai si le message part. */
  function send(text, fromRemote, images) {
    text = String(text == null ? draft : text).trim();
    if (!text || busy || !loaded) return false;
    if (!A.hasProvider('claude')) { warn('Claude Code est introuvable sur ce poste : l’assistant passe par lui.'); return false; }
    if (!log.sessionId) log.sessionId = newSessionId();
    var notes = log.notes.slice();
    var head = '[' + stamp() + (notes.length ? ' — depuis ton dernier message : ' + notes.join(' ') : '') + ']';
    var entry = push({ kind: 'user', text: text });
    lastFrom = fromRemote ? 'remote' : 'panel';
    busy = { turn: 0, startedAt: now(), phase: 'thinking', label: '' };
    stick = true;
    if (!fromRemote) {
      draft = '';
      var ta = document.querySelector('[data-role="as-input"]');
      if (ta) { ta.value = ''; fit(ta); }
    }
    startClock();
    renderAll();
    bridge.call('assistantSend', {
      sessionId: log.sessionId, resume: !!log.used, text: head + '\n' + text, system: SYSTEM, tools: toolDefs(),
      /* Images jointes depuis la fenêtre Conversations : le texte les cite, l'hôte les joint au message. */
      images: Array.isArray(images) ? images.map(String) : [],
      model: String(S.settings.assistantModel || ''), effort: String(S.settings.assistantEffort || '')
    }, 30000).then(function (r) {
      if (busy && !busy.turn) busy.turn = r && r.turn ? r.turn : 0;
      log.notes = log.notes.slice(notes.length);
      saveSoon();
    })['catch'](function (e) {
      busy = null;
      /* Rien n'est parti : le message revient dans la zone de saisie (celle d'où il est parti). */
      log.entries = log.entries.filter(function (x) { return x !== entry; });
      if (fromRemote) {
        remote.restore = { text: text, at: now() };
      } else {
        if (!draft) draft = text;
        var box = document.querySelector('[data-role="as-input"]');
        if (box && !box.value) { box.value = draft; fit(box); }
      }
      push({ kind: 'error', text: 'Message non envoyé : ' + e.message });
      renderAll();
    });
    return true;
  }

  function stop() {
    if (!busy) return;
    bridge.call('assistantStop', {})['catch'](function (e) { warn('Arrêt impossible : ' + e.message); });
  }

  /* « Nouvelle discussion » : un premier clic arme le bouton, un second (dans les 4 s) efface. */
  function reset() {
    clearTimeout(armTimer);
    if (!armed) {
      armed = true;
      armTimer = setTimeout(function () { armed = false; renderAll(); }, ARM_MS);
      renderAll();
      return;
    }
    armed = false;
    bridge.call('assistantReset', {}).then(function () {
      busy = null;
      log = { sessionId: '', used: false, entries: [], notes: [] };
      showAll = false;
      remote.showAll = false;
      saveNow();
      renderAll();
    })['catch'](function (e) { warn('Nouvelle discussion impossible : ' + e.message); });
  }

  function addToolLine(turn, label) {
    var last = log.entries[log.entries.length - 1];
    if (last && last.kind === 'tools' && last.turn === turn) {
      last.names.push(label);
    } else {
      push({ kind: 'tools', turn: turn, names: [label] });
    }
  }

  function agentEntry(turn, msg) {
    for (var i = log.entries.length - 1; i >= 0; i--) {
      var e = log.entries[i];
      if (e.kind === 'agent' && e.msg === msg) return e;
      if (e.kind === 'user') break;
    }
    return push({ kind: 'agent', turn: turn, msg: msg, text: '' });
  }

  function onEvent(p) {
    if (!p || !p.phase) return;
    /* Un appel d'outil s'exécute toujours : l'hôte l'attend, même après un rechargement de la page. */
    if (p.phase === 'call') { runTool(p); return; }
    if (!busy) {
      if (p.phase === 'done' || p.phase === 'error') return;
      busy = { turn: p.turn, startedAt: now(), phase: 'thinking', label: '' };
      startClock();
    }
    if (!busy.turn) busy.turn = p.turn;
    if (p.turn !== busy.turn) return;
    if (p.phase === 'text') {
      var e = agentEntry(p.turn, p.msg);
      e.text = String(p.text || '');
      busy.phase = 'text';
      saveSoon();
      renderLog();
    } else if (p.phase === 'tool') {
      busy.phase = 'tool';
      busy.label = p.name + (p.detail ? ' · ' + A.lastSegment(p.detail) : '');
      addToolLine(p.turn, p.name + (p.detail ? ' · ' + A.lastSegment(p.detail) : ''));
      renderLog();
    } else if (p.phase === 'notice') {
      push({ kind: 'notice', text: p.text });
      renderLog();
    } else if (p.phase === 'done' || p.phase === 'error') {
      var took = now() - busy.startedAt;
      busy = null;
      stopClock();
      if (p.phase === 'error') {
        push({ kind: 'error', text: p.error || 'L’assistant n’a pas pu répondre.' });
      } else {
        log.used = true;
        if (p.cancelled) push({ kind: 'notice', text: 'Réponse arrêtée.' });
        else push({ kind: 'end', cost: Number(p.cost) || 0, ms: Number(p.ms) || took });
      }
      saveNow();
      if (!inSight()) {
        unseen = true;
        if (!p.cancelled) A.toast(p.phase === 'error' ? 'L’assistant n’a pas pu répondre' : 'L’assistant a répondu', { label: 'Voir', run: open });
      }
      renderAll();
    }
  }

  /* Une proposition attend : le bouton de l'en-tête le dit, et un toast si personne ne regarde. */
  function attention() {
    if (!inSight()) A.toast('L’assistant propose une action à valider', { label: 'Voir', run: open });
  }

  /* La discussion est sous les yeux : panneau ouvert ici, ou montrée dans la fenêtre Conversations
     au premier plan. */
  function inSight() {
    return (isOpen() && document.visibilityState !== 'hidden') || (remote.watching && remote.focused);
  }

  /* ══ Persistance ═════════════════════════════════════════════════════ */

  function saveSoon() {
    if (!loaded) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_MS);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!loaded) return Promise.resolve();
    return bridge.call('assistantSave', { log: { version: 1, sessionId: log.sessionId, used: !!log.used, entries: log.entries, notes: log.notes } })
      ['catch'](function (e) { if (window.console) console.warn('[assistant] sauvegarde', e); });
  }

  function load() {
    return bridge.call('assistantLoad', {}).then(function (r) {
      var l = r && r.log;
      if (l && typeof l === 'object') {
        log = {
          sessionId: typeof l.sessionId === 'string' ? l.sessionId : '',
          used: !!l.used,
          entries: Array.isArray(l.entries) ? l.entries.filter(function (e) { return e && typeof e === 'object' && e.kind; }) : [],
          notes: Array.isArray(l.notes) ? l.notes.map(String) : []
        };
        /* Un lancement interrompu par la fermeture : on ne sait pas s'il est parti. */
        log.entries.forEach(function (e) { if (e.status === 'launching') { e.status = 'failed'; e.result = 'interrompu (Organizator fermé)'; } });
      }
      loaded = true;
      return bridge.call('assistantStatus', {});
    }).then(function (st) {
      if (st && st.busy && st.sessionId === log.sessionId) {
        busy = { turn: st.turn, startedAt: now(), phase: 'thinking', label: '' };
        startClock();
      }
      renderAll();
    })['catch'](function (e) {
      loaded = true;
      if (window.console) console.warn('[assistant] chargement', e);
      renderAll();
    });
  }

  /* ══ Affichage ═══════════════════════════════════════════════════════ */

  function isOpen() { return S.ui.termTaskId === ID; }

  function open() {
    S.ui.termTaskId = ID;
    S.ui.termConvId = null;
    S.ui.artifactView = false;
    S.ui.artifactConvId = null;
    S.ui.newConvoOpen = false;
    S.ui.transcript = null;
    A.syncPolling();
    unseen = false;
    stick = true;
    A.render();
    var ta = document.querySelector('[data-role="as-input"]');
    if (ta) ta.focus();
  }

  function toggle() {
    if (isOpen()) { S.ui.termTaskId = null; A.render(); return; }
    open();
  }

  function renderAll() {
    if (isOpen()) A.renderPanel();
    renderButton();
  }

  function renderLog() {
    var el = isOpen() ? document.querySelector('#panel [data-role="as-log"]') : null;
    if (el) keepBottom(function () { syncLog(el); });
    renderButton();
  }

  /* Le fil suit la fin s'il y était (ou après un envoi) : la position est relevée avant tout
     changement — une ligne d'état qui paraît sous le fil le raccourcit — et rétablie après. */
  function keepBottom(fn) {
    var el = document.querySelector('#panel [data-role="as-log"]');
    var follow = !!el && (stick || el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    fn();
    if (el && follow) el.scrollTop = el.scrollHeight;
    if (el) stick = false;
  }

  function renderButton() {
    pushRemote();
    var btn = document.getElementById('assistant-btn');
    if (!btn) return;
    var n = pendingCards().length;
    var badge = btn.querySelector('.btn-badge');
    var dot = btn.querySelector('.btn-dot');
    if (badge) { badge.textContent = n ? String(n) : ''; badge.hidden = !n; }
    var st = busy ? 'working' : (unseen ? 'ready' : '');
    if (dot) { dot.hidden = !st; dot.className = 'btn-dot' + (st ? ' st-' + st : ''); }
    btn.classList.toggle('on', isOpen());
    btn.title = 'Assistant' + (busy ? ' · répond…' : (unseen ? ' · réponse prête' : ''))
      + (n ? ' · ' + n + (n > 1 ? ' propositions à valider' : ' proposition à valider') : '');
  }

  function panelRender(host, fresh) {
    var root = host.querySelector('.as-panel');
    if (!root) {
      host.innerHTML = shellHtml(fresh);
      root = host.querySelector('.as-panel');
      var ta = root.querySelector('[data-role="as-input"]');
      ta.value = draft;
      fit(ta);
      stick = true;
    }
    keepBottom(function () {
      A.setHtml(root.querySelector('[data-role="as-head"]'), headHtml());
      syncLog(root.querySelector('[data-role="as-log"]'));
      A.setHtml(root.querySelector('[data-role="as-actions"]'), actionsHtml());
      statusNow();
    });
  }

  function shellHtml(fresh) {
    return '<div class="panel as-panel' + (fresh ? ' enter' : '') + '" role="complementary" aria-label="Assistant">'
      + '<div class="panel-bar">'
      + '<span class="dots"><span class="dot-1"></span><span class="dot-2"></span><span class="dot-3"></span></span>'
      + '<span class="panel-title">assistant — Organizator</span>'
      + '<span class="panel-spacer"></span>'
      + '<span class="as-head" data-role="as-head"></span>'
      + '<button type="button" class="panel-x" data-act="close-term" title="Fermer">✕</button>'
      + '</div>'
      + '<div class="log as-log" data-role="as-log" aria-live="polite"></div>'
      + '<div class="as-foot">'
      + '<div class="as-status" data-role="as-status"></div>'
      + '<textarea class="dark-input as-input" rows="2" data-role="as-input" data-focus-key="as-input" spellcheck="true" '
      + 'placeholder="Demandez à l’assistant… (Entrée envoie, Maj + Entrée : à la ligne)"></textarea>'
      + '<div class="as-actions" data-role="as-actions"></div>'
      + '</div></div>';
  }

  function headHtml() {
    if (!log.entries.length) return '';
    return '<button type="button" class="panel-link as-reset' + (armed ? ' is-armed' : '') + '" data-act="as-reset"'
      + ' title="Effacer la discussion : l’assistant repartira sans son historique">'
      + (armed ? 'Effacer la discussion ?' : 'Nouvelle discussion') + '</button>';
  }

  function modelWords() {
    return [S.settings.assistantModel || 'modèle par défaut', S.settings.assistantEffort].filter(Boolean).join(' · ');
  }

  function actionsHtml() {
    return '<button type="button" class="panel-link as-meta" data-act="as-settings" title="Modèle et effort de l’assistant (Réglages)">'
      + esc('Claude · ' + modelWords()) + '</button>'
      + '<span class="panel-spacer"></span>'
      + (busy
        ? '<button type="button" class="dark-btn as-stop" data-act="as-stop" title="Arrêter la réponse en cours">' + ICON.stop + 'Arrêter</button>'
        : '<button type="button" class="dark-btn dark-btn-primary as-send" data-act="as-send"' + (draft.trim() && loaded ? '' : ' disabled') + '>Envoyer</button>');
  }

  function statusText() {
    if (!busy) return '';
    var s = Math.max(0, Math.round((now() - busy.startedAt) / 1000));
    var what = busy.phase === 'text' ? 'L’assistant écrit…'
      : (busy.phase === 'tool' || busy.phase === 'call') && busy.label ? busy.label + '…'
      : 'L’assistant réfléchit…';
    return what + ' · ' + (s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + ('0' + (s % 60)).slice(-2));
  }

  function statusNow() {
    var el = document.querySelector('#panel [data-role="as-status"]');
    if (!el) return;
    var text = statusText();
    if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
  }

  function updateStatus() { keepBottom(statusNow); }

  function startClock() { if (!clock) clock = setInterval(updateStatus, 1000); }
  function stopClock() { if (clock) { clearInterval(clock); clock = null; } updateStatus(); }

  function fit(ta) {
    ta.rows = Math.min(8, Math.max(2, String(ta.value || '').split('\n').length));
  }

  /* Le fil, entrée par entrée : seules celles qui ont changé sont réécrites — une réponse qui
     s'écrit ne fait ni sauter la lecture ni perdre une sélection plus haut. */
  function syncLog(el) {
    if (!el) return;
    var items = viewItems();
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
      if (node.asHtml !== it.html) { node.innerHTML = it.html; node.asHtml = it.html; }
    }
    while (kids.length > items.length) el.removeChild(el.lastChild);
  }

  function viewItems() {
    var items = [];
    var list = log.entries;
    if (!list.length && !busy) {
      items.push({ key: 'empty', html: emptyHtml() });
      return items;
    }
    var start = showAll ? 0 : Math.max(0, list.length - SHOWN);
    if (start > 0) {
      items.push({ key: 'more', html: '<button type="button" class="as-more" data-act="as-more">Afficher les ' + start + ' messages précédents</button>' });
    }
    /* Une réponse peut tenir en plusieurs messages (avant et après un outil) : « Assistant » une fois. */
    var spoke = false;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.kind === 'user') spoke = false;
      var head = e.kind === 'agent' && !spoke;
      if (e.kind === 'agent') spoke = true;
      if (i >= start) items.push({ key: e.id, html: entryHtml(e, head) });
    }
    if (busy && (busy.phase === 'thinking' || busy.phase === 'call' || busy.phase === 'tool')) {
      items.push({ key: 'wait', html: '<div class="as-wait"><span></span><span></span><span></span></div>' });
    }
    return items;
  }

  var SUGGESTIONS = [
    { text: 'Passe en revue les consignes et les équipes de tous mes mots-clés, et propose les améliorations les plus utiles.', send: true, label: 'Relire les consignes de tous mes agents' },
    { text: 'Qu’est-ce qui est en tête de file, et qu’est-ce qui attend une réponse de ma part ?', send: true, label: 'Où en est ma file ?' },
    { text: 'Remets en haute priorité la tâche ', send: false, label: 'Remettre une tâche en haute priorité…' },
    { text: 'Crée une tâche : ', send: false, label: 'Créer une tâche…' }
  ];

  function emptyHtml() {
    return '<div class="as-empty"><p><strong>Demandez, l’assistant agit sur la file.</strong></p>'
      + '<p>Il lit vos tâches, vos conversations et les consignes de vos mots-clés ; il crée, modifie et range des tâches — '
      + 'chaque action s’annule d’un clic. Réécrire une consigne, supprimer un mot-clé ou lancer un agent vous est proposé : rien ne change sans vous.</p>'
      + '<div class="as-ideas">' + SUGGESTIONS.map(function (s, i) {
        return '<button type="button" class="as-idea" data-act="as-suggest" data-i="' + i + '">' + esc(s.label) + '</button>';
      }).join('') + '</div></div>';
  }

  function entryHtml(e, head) {
    if (e.kind === 'user') {
      return '<div class="msg user"><div class="msg-head"><span class="msg-role">Vous</span><span class="msg-time">' + esc(A.fmtTime(e.at)) + '</span></div>'
        + '<div class="msg-body md">' + A.mdHtml(e.text) + '</div></div>';
    }
    if (e.kind === 'agent') {
      return '<div class="msg assistant">' + (head ? '<div class="msg-head"><span class="msg-role">Assistant</span></div>' : '')
        + '<div class="msg-body md">' + A.mdHtml(e.text) + '</div></div>';
    }
    if (e.kind === 'tools') {
      var order = [], n = {};
      e.names.forEach(function (x) { if (!n[x]) { n[x] = 0; order.push(x); } n[x]++; });
      return '<div class="msg-tools as-tools"><span class="msg-tools-icon">' + ICON.tool + '</span>'
        + order.map(function (x) {
          return '<span class="msg-tool">' + esc(x) + (n[x] > 1 ? '<span class="msg-tool-n">×' + n[x] + '</span>' : '') + '</span>';
        }).join('') + '</div>';
    }
    if (e.kind === 'notice') return '<div class="as-notice">' + esc(e.text) + '</div>';
    if (e.kind === 'error') return '<div class="as-notice is-error">' + esc(e.text) + '</div>';
    if (e.kind === 'end') {
      var end = endText(e);
      return end ? '<div class="as-end">' + esc(end) + '</div>' : '';
    }
    if (e.kind === 'card') return cardHtml(e);
    return '';
  }

  function endText(e) {
    var parts = [];
    if (e.ms) parts.push(Math.max(1, Math.round(e.ms / 1000)) + ' s');
    if (e.cost) parts.push('≈ ' + e.cost.toFixed(e.cost < 0.1 ? 3 : 2).replace('.', ',') + ' $');
    return parts.join(' · ');
  }

  var STATUS_WORDS = {
    done: '', undone: 'Annulé', failed: 'Échec', proposed: 'À valider', applied: 'Appliqué', refused: 'Refusé',
    launching: 'Lancement…', launched: 'Lancé', form: 'Formulaire ouvert'
  };

  /* Ce qu'une carte montre et les boutons qu'elle offre : rendu ici (cardHtml) et dans la fenêtre
     Conversations (remoteItems), qui renvoie ses clics par l'hôte. */
  function cardModel(e) {
    var p = e.proposal || null;
    var m = {
      status: e.status, proposal: !!p, title: e.title, state: STATUS_WORDS[e.status] || '',
      subject: e.subject || '', detail: e.detail || '', reason: e.reason || '', result: e.result || '',
      diff: p && p.op === 'kw-update' ? keywordDiff(e) : null,
      launch: p && p.op === 'launch' ? launchLines(p) : null,
      buttons: []
    };
    if (e.status === 'proposed') {
      if (p.op === 'launch') {
        m.buttons.push({ act: 'as-apply', label: 'Lancer', primary: true, disabled: !p.cwd, tip: p.cwd ? '' : 'Dossier de travail à choisir : ouvrez le formulaire' });
        m.buttons.push({ act: 'as-form', label: 'Formulaire…' });
      } else {
        m.buttons.push({ act: 'as-apply', label: 'Appliquer', primary: true });
      }
      m.buttons.push({ act: 'as-refuse', label: 'Refuser' });
    } else if ((e.status === 'done' || e.status === 'applied') && e.undo) {
      m.buttons.push({ act: 'as-undo', label: 'Annuler' });
    }
    if (e.taskId && A.taskById(e.taskId)) m.buttons.push({ act: 'as-reveal', label: 'Voir dans la file', link: true });
    return m;
  }

  function cardHtml(e) {
    var m = cardModel(e);
    var h = [];
    var id = esc(e.id);
    h.push('<div class="as-card is-' + esc(e.status) + (m.proposal ? ' is-proposal' : '') + '">');
    h.push('<div class="as-card-head"><span class="as-card-title">' + esc(m.title) + '</span>'
      + (m.state ? '<span class="as-card-state">' + esc(m.state) + '</span>' : '') + '</div>');
    if (m.subject) h.push('<div class="as-card-subject">« ' + esc(m.subject) + ' »</div>');
    if (m.detail) h.push('<div class="as-card-detail">' + esc(m.detail) + '</div>');
    if (m.reason) h.push('<div class="as-card-reason">' + esc(m.reason) + '</div>');
    if (m.diff) h.push('<div class="as-diff">' + m.diff.map(function (r) { return diffRow(r, e); }).join('') + '</div>');
    if (m.launch) h.push(launchDetailHtml(m.launch));
    if (m.result) h.push('<div class="as-card-detail">' + esc(m.result) + '</div>');
    var btns = m.buttons.map(function (b) {
      if (b.link) return '<button type="button" class="panel-link as-see" data-act="' + b.act + '" data-id="' + id + '">' + esc(b.label) + '</button>';
      return '<button type="button" class="dark-btn' + (b.primary ? ' dark-btn-primary' : '') + '" data-act="' + b.act + '" data-id="' + id + '"'
        + (b.disabled ? ' disabled title="' + esc(b.tip) + '"' : '') + '>' + esc(b.label) + '</button>';
    });
    if (btns.length) h.push('<div class="as-card-actions">' + btns.join('') + '</div>');
    h.push('</div>');
    return h.join('');
  }

  function keywordDiff(e) {
    var patch = e.proposal.patch, before = e.before || {};
    var rows = [];
    function row(label, was, now, key) { rows.push({ label: label, before: was, after: now, key: key, open: !!(e.open && e.open[key]) }); }
    if (patch.name != null) row('Nom', before.name, patch.name, 'name');
    if (patch.desc != null) row('Description', before.desc, patch.desc, 'desc');
    if (patch.prompt != null) row('Consigne', before.prompt, patch.prompt, 'prompt');
    if (patch.team != null) row('Équipe lancée', before.team ? 'oui' : 'non', patch.team ? 'oui' : 'non', 'team');
    if (patch.agents != null) row('Équipe', teamText(before.agents), teamText(patch.agents), 'agents');
    return rows;
  }

  function teamText(agents) {
    var list = (agents || []).filter(function (a) { return a && a.name; });
    if (!list.length) return '(aucun agent)';
    return list.map(function (a) {
      var tune = [a.model, a.effort].filter(Boolean).join(' · ');
      return '- ' + a.name + (a.role ? ' [' + a.role + ']' : '') + (tune ? ' (' + tune + ')' : '') + ' : ' + (a.prompt || '');
    }).join('\n');
  }

  /* Le texte proposé se lit d'office ; l'ancien se déplie à la demande. */
  function diffRow(r, e) {
    return '<div class="as-diff-row"><div class="as-diff-label">' + esc(r.label) + '</div>'
      + '<div class="as-diff-new">' + esc(r.after == null || r.after === '' ? '(vide)' : r.after) + '</div>'
      + '<button type="button" class="as-diff-toggle" data-act="as-toggle" data-id="' + esc(e.id) + '" data-key="' + esc(r.key) + '">'
      + (r.open ? 'Masquer l’actuel ▴' : 'Voir l’actuel ▾') + '</button>'
      + (r.open ? '<div class="as-diff-old">' + esc(r.before == null || r.before === '' ? '(vide)' : r.before) + '</div>' : '')
      + '</div>';
  }

  function launchLines(p) {
    var task = A.taskById(p.taskId);
    var lines = [];
    lines.push(['Agent', A.providerById(p.provider).label + (p.model ? ' · ' + p.model : ' · modèle par défaut') + (p.effort ? ' · ' + p.effort : '')]);
    if (p.target === 'subs') {
      lines.push(['Sous-tâches', p.subs.map(function (id) { var k = A.taskById(id); return k ? title(k) : id; }).join(' · ')]);
    }
    lines.push(['Mots-clés', p.keywords.length ? p.keywords.join(', ') : 'aucun']);
    if (p.message) lines.push(['Précision', p.message]);
    lines.push(['Dossier', p.cwd || 'à choisir dans le formulaire']);
    if (!task) lines.push(['', 'La tâche n’existe plus.']);
    return lines;
  }

  function launchDetailHtml(lines) {
    return '<div class="as-launch">' + lines.map(function (l) {
      return '<div class="as-launch-row"><span class="as-launch-key">' + esc(l[0]) + '</span><span class="as-launch-val">' + esc(l[1]) + '</span></div>';
    }).join('') + '</div>';
  }

  /* ══ Fenêtre Conversations ═══════════════════════════════════════════
     La discussion s'y montre aussi, dans le bloc « Organizator » en bas à gauche. Cette page reste
     seule à la tenir — journal, outils, cartes, enregistrement : la fenêtre lui demande tout par
     l'hôte (`assistantRemote`, relayé ici en événement) et reçoit ce qu'elle affiche (`assistantView`) —
     un résumé à chaque changement, et, tant qu'elle montre la discussion, les entrées qui ont changé
     depuis le dernier envoi, en données qu'elle met en forme à sa façon. */
  var remote = {
    connected: false, watching: false, focused: false, showAll: false,
    sent: {}, last: '', timer: null, toast: null, restore: null, acting: false, show: null
  };

  /* Un avertissement sur un geste : le toast d'ici, et celui de la fenêtre Conversations quand le
     geste vient d'elle. */
  function warn(text) {
    A.toast(text);
    if (remote.acting) { remote.toast = { text: text, at: now() }; pushRemote(); }
  }

  function plain(md) {
    return String(md || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[#*_`>|]+/g, '').replace(/\s+/g, ' ').trim();
  }

  function remoteSummary() {
    var said = '';
    for (var i = log.entries.length - 1; i >= 0; i--) {
      if (log.entries[i].kind === 'agent' && log.entries[i].text) { said = plain(log.entries[i].text); break; }
    }
    var last = log.entries[log.entries.length - 1];
    return {
      loaded: loaded, ready: A.hasProvider('claude'),
      busy: busy ? { phase: busy.phase, label: busy.label || '', startedAt: busy.startedAt } : null,
      unseen: unseen, pending: pendingCards().length, armed: armed,
      said: clip(said, 220), at: last ? last.at : 0, count: log.entries.length,
      model: 'Claude · ' + modelWords(), restore: remote.restore, show: remote.show
    };
  }

  function entryModel(e, head) {
    if (e.kind === 'user') return { k: 'user', text: e.text, at: e.at };
    if (e.kind === 'agent') return { k: 'agent', text: e.text, head: head };
    if (e.kind === 'tools') return { k: 'tools', names: e.names.slice() };
    if (e.kind === 'notice' || e.kind === 'error') return { k: 'notice', text: e.text, error: e.kind === 'error' };
    if (e.kind === 'end') { var end = endText(e); return end ? { k: 'end', text: end } : null; }
    if (e.kind === 'card') { var m = cardModel(e); m.k = 'card'; m.id = e.id; return m; }
    return null;
  }

  /* Comme viewItems, en données. */
  function remoteItems() {
    var items = [];
    var list = log.entries;
    if (!list.length && !busy) {
      items.push({ key: 'empty', m: { k: 'empty', ideas: SUGGESTIONS.map(function (s) { return { label: s.label, text: s.text, send: s.send }; }) } });
      return items;
    }
    var start = remote.showAll ? 0 : Math.max(0, list.length - SHOWN);
    if (start > 0) items.push({ key: 'more', m: { k: 'more', n: start } });
    var spoke = false;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.kind === 'user') spoke = false;
      var head = e.kind === 'agent' && !spoke;
      if (e.kind === 'agent') spoke = true;
      if (i < start) continue;
      var m = entryModel(e, head);
      if (m) items.push({ key: e.id, m: m });
    }
    if (busy && (busy.phase === 'thinking' || busy.phase === 'call' || busy.phase === 'tool')) items.push({ key: 'wait', m: { k: 'wait' } });
    return items;
  }

  /* Au plus un envoi toutes les 120 ms, et seulement ce qui a changé. */
  function pushRemote() {
    if (!remote.connected || remote.timer) return;
    remote.timer = setTimeout(sendRemote, 120);
  }

  function sendRemote() {
    remote.timer = null;
    var view = { summary: remoteSummary() };
    if (remote.watching) {
      var keys = [], changed = {}, present = {};
      remoteItems().forEach(function (it) {
        var json = JSON.stringify(it.m);
        keys.push(it.key);
        present[it.key] = true;
        if (remote.sent[it.key] !== json) { remote.sent[it.key] = json; changed[it.key] = it.m; }
      });
      Object.keys(remote.sent).forEach(function (k) { if (!present[k]) delete remote.sent[k]; });
      view.keys = keys;
      view.changed = changed;
    }
    if (remote.toast) { view.toast = remote.toast; remote.toast = null; }
    var json = JSON.stringify(view);
    if (json === remote.last) return;
    remote.last = json;
    bridge.call('assistantView', view)['catch'](function () { /* fenêtre absente : rien à montrer */ });
  }

  /* `sync` : la fenêtre (re)part de zéro ; `watch` : elle montre la discussion (ou plus), au premier
     plan ou non ; `send` : un message ; `act` : un bouton de la discussion. */
  function onRemote(p) {
    if (!p || !p.op) return;
    remote.connected = true;
    if (p.op === 'sync') {
      remote.sent = {};
      remote.last = '';
    } else if (p.op === 'watch') {
      if (p.on && !remote.watching) { remote.sent = {}; remote.last = ''; }
      remote.watching = !!p.on;
      remote.focused = !!p.focused;
      if (remote.watching && remote.focused) unseen = false;
    } else if (p.op === 'send') {
      if (!send(p.text, true, p.images)) remote.restore = { text: String(p.text || ''), at: now() };
    } else if (p.op === 'act') {
      remote.acting = true;
      try { remoteAct(p); } finally { remote.acting = false; }
    }
    renderAll();
  }

  function remoteAct(p) {
    var e = p.id ? entryById(p.id) : null;
    switch (p.act) {
      case 'as-apply': applyCard(e); break;
      case 'as-refuse': refuseCard(e); break;
      case 'as-undo': undoCard(e); break;
      case 'as-form': if (e) formCard(e); break;
      case 'as-reveal': if (e && e.taskId) reveal(e.taskId); break;
      case 'as-toggle':
        if (e) { e.open = e.open || {}; e.open[p.key] = !e.open[p.key]; }
        break;
      case 'as-more': remote.showAll = true; break;
      case 'as-suggest':
        var s = SUGGESTIONS[p.i];
        if (s && s.send && !send(s.text, true)) warn('L’assistant répond encore : attendez sa réponse.');
        break;
      case 'as-stop': stop(); break;
      case 'as-reset': reset(); break;
      case 'as-open': open(); break;
      case 'as-settings': S.ui.settingsTab = 'assistant'; S.ui.settingsOpen = true; A.render(); break;
    }
  }

  /* ══ Réglages ════════════════════════════════════════════════════════ */

  A.addSettingsTab({
    id: 'assistant', label: 'Assistant',
    lead: 'La discussion du bouton ✦, en tête de fenêtre : elle lit la file et agit dessus — créer, ranger, remonter des tâches, relire les consignes des mots-clés, proposer des lancements. Claude Code seulement, sans terminal.',
    html: function (s) {
      var model = String(s.assistantModel || '');
      var custom = customModel || (model && !A.catalogHas(A.catalogFor('claude'), model));
      var h = [];
      h.push('<div class="set-card">');
      h.push('<div class="set-card-head"><span class="set-card-title">Claude Code</span>'
        + (A.hasProvider('claude') ? '' : '<span class="set-badge warn">introuvable</span>') + '</div>');
      h.push(A.setFieldHtml('Modèle', A.modelSelectHtml('claude', model, customModel, 'as-model-select', 'as-model-select', false)));
      if (custom) {
        h.push(A.setFieldHtml('', '<input class="input set-cwd" type="text" data-role="as-model" data-focus-key="as-model" '
          + 'spellcheck="false" placeholder="Identifiant de modèle, ex. sonnet" value="' + esc(model) + '">'));
      }
      h.push(A.setFieldHtml('Effort', A.effortSelectHtml('claude', String(s.assistantEffort || ''), 'as-effort', 'as-effort', false)));
      h.push('<div class="set-card-foot">Relire les consignes de vos agents demande un bon modèle : sonnet avec un effort moyen y suffit, opus pour une revue plus fouillée. '
        + 'Chaque message compte dans votre quota Claude Code ; le coût estimé de chaque réponse s’affiche sous elle. '
        + 'L’assistant peut lire les fichiers du poste (rapports des agents), jamais les modifier.</div>');
      h.push('</div>');
      return h.join('');
    }
  });

  function setSetting(key, value) {
    S.settings[key] = value;
    A.saveSettingsSoon();
    A.render();
  }

  A.addChange('as-model-select', function (el) {
    customModel = el.value === A.customModel;
    setSetting('assistantModel', customModel ? '' : el.value);
    if (customModel) { var box = document.querySelector('[data-focus-key="as-model"]'); if (box) box.focus(); }
  });
  A.addChange('as-effort', function (el) { setSetting('assistantEffort', el.value); });
  A.addInput('as-model', function (el) { S.settings.assistantModel = el.value.trim(); A.saveSettingsSoon(); });

  /* ══ Événements ══════════════════════════════════════════════════════ */

  function cardOf(el) { return entryById(el.getAttribute('data-id')); }

  A.addAction('open-assistant', toggle);
  A.addAction('as-send', function () { send(); });
  A.addAction('as-stop', stop);
  A.addAction('as-reset', reset);
  A.addAction('as-more', function () { showAll = true; renderAll(); });
  A.addAction('as-settings', function () { S.ui.settingsTab = 'assistant'; S.ui.settingsOpen = true; A.render(); });
  A.addAction('as-suggest', function (el) {
    var s = SUGGESTIONS[parseInt(el.getAttribute('data-i'), 10)];
    if (!s) return;
    if (s.send) { send(s.text); return; }
    draft = s.text;
    var ta = document.querySelector('[data-role="as-input"]');
    if (ta) { ta.value = draft; fit(ta); ta.focus(); ta.setSelectionRange(draft.length, draft.length); }
    renderAll();
  });
  A.addAction('as-apply', function (el) { applyCard(cardOf(el)); });
  A.addAction('as-refuse', function (el) { refuseCard(cardOf(el)); });
  A.addAction('as-undo', function (el) { undoCard(cardOf(el)); });
  A.addAction('as-form', function (el) { var e = cardOf(el); if (e) formCard(e); });
  A.addAction('as-reveal', function (el) { var e = cardOf(el); if (e && e.taskId) reveal(e.taskId); });
  A.addAction('as-toggle', function (el) {
    var e = cardOf(el);
    if (!e) return;
    var key = el.getAttribute('data-key');
    e.open = e.open || {};
    e.open[key] = !e.open[key];
    renderAll();
  });

  /* Pas de rendu à chaque frappe : seul le bouton « Envoyer » change d'état. */
  A.addInput('as-input', function (el) {
    draft = el.value;
    fit(el);
    var btn = document.querySelector('#panel [data-act="as-send"]');
    if (btn) btn.disabled = !draft.trim() || !loaded;
  });

  document.addEventListener('keydown', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || el.getAttribute('data-role') !== 'as-input') return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  A.registerPanel({ id: ID, render: panelRender });
  A.onRender(renderButton);
  bridge.on('assistant', onEvent);
  bridge.on('assistantRemote', onRemote);
  A.onReady(function () { load(); });

  /* Pour les essais (jsdom, DevTools). */
  window.__organizator.assistant = {
    open: open, send: send, state: function () { return { log: log, busy: busy, draft: draft, loaded: loaded, remote: remote }; },
    tools: TOOL_BY_NAME, system: SYSTEM, onEvent: onEvent, onRemote: onRemote, cardHtml: cardHtml
  };
})();
