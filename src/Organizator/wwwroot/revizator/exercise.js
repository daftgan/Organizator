/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — exercices à la demande · module U1a
   Vue « Exercices » : une grille par compétence (types de la spec §5.3), durée 5 / 10 / 15 min, consigne libre
   (« Je veux travailler… »), suggestions tirées des points faibles et des compétences les moins travaillées,
   génération par R.gen('exercise', …), série jouée sur place avec items.js (texte avec glossaire au survol,
   dialogue lu par R.tts.script), bilan, cartes proposées, journal de séance, historique (reprendre, rejouer).
   Carte d'accueil « Exercice rapide ». Simulation hors WebView2 : revizator/fixtures/exercise-<compétence>.json.
   Styles : exercise.css (préfixe .rzx-).

   ── API ───────────────────────────────────────────────────────────────────
     R.exercise.launch({ skill, type, minutes, focus, topic }) → job (ouvre la vue Exercices)
     R.exercise.open(id, replay) → ouvre une série de l'historique (replay : repart de zéro)
     R.exercise.suggestions(n) → [{ type, skill, label, why, focus }] ; R.exercise.TYPES ; R.exercise.typeLabel(type)
   Données : R.data.exercises = [{ id, day, skill, type, title, status: 'ready'|'active'|'done', createdAt, doneAt, score (0..1 | null),
     progress? (état de reprise de items.js tant que la série est en cours, retiré à la fin) }]
   Le document (spec §5.3) reçoit à la fin result = { score, at, items: [{ v, s }] } (R.docSave).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R || !R.items) return;
  var esc = R.esc;
  var X = R.ui.exercise = R.ui.exercise || { minutes: 10, focus: '', freeSkill: 'lang', pending: null, play: null, showScript: {}, histAll: false, sugg: [] };

  var TYPES = [
    { id: 'read.article', skill: 'read', label: 'Article et questions', desc: 'Comprendre un article d’actualité : l’idée générale, les détails, le vrai du faux.', min: 10 },
    { id: 'read.speed', skill: 'read', label: 'Lecture rapide', desc: 'Lire un texte facile d’une traite, puis répondre sans relire : la fluidité.', min: 5 },
    { id: 'read.errors', skill: 'read', label: 'Chasse aux erreurs', desc: 'Repérer et corriger les fautes typiques d’un francophone dans un texte.', min: 5 },
    { id: 'listen.dialogue', skill: 'listen', label: 'Dialogue', desc: 'Comprendre une conversation à deux voix, accents variés, puis lire le script.', min: 10 },
    { id: 'listen.partial_dictation', skill: 'listen', label: 'Dictée à trous', desc: 'Entendre les petits mots avalés : formes faibles, contractions, liaisons.', min: 5 },
    { id: 'listen.dictation', skill: 'listen', label: 'Dictée', desc: 'Écrire des phrases entières entendues : le décodage mot à mot.', min: 5 },
    { id: 'listen.minimal_pairs', skill: 'listen', label: 'Paires minimales', desc: '« ship » ou « sheep » ? Distinguer les sons proches, avec plusieurs voix.', min: 5 },
    { id: 'write.translate', skill: 'write', label: 'Traduction piège', desc: 'Des phrases françaises truffées de pièges : faux amis, temps, articles.', min: 5 },
    { id: 'write.pro_message', skill: 'write', label: 'Message professionnel', desc: 'Un e-mail de travail (retard, demande, compte rendu), corrigé par Claude.', min: 10 },
    { id: 'write.free', skill: 'write', label: 'Écriture libre', desc: 'Écrire quelques minutes sans s’arrêter, puis trois points à améliorer.', min: 10 },
    { id: 'speak.shadowing', skill: 'speak', label: 'Shadowing', desc: 'Répéter juste après la voix : rythme, liaisons, accent de phrase.', min: 5 },
    { id: 'speak.read_aloud', skill: 'speak', label: 'Lecture à voix haute', desc: 'Lire un paragraphe : Whisper repère les mots qu’il ne reconnaît pas.', min: 5 },
    { id: 'speak.minute', skill: 'speak', label: 'Une minute pour…', desc: 'Parler soixante secondes sur un sujet, puis la correction de Claude.', min: 5 },
    { id: 'speak.tech', skill: 'speak', label: 'Explication technique', desc: 'Expliquer un bug, un commit ou un choix d’architecture, à l’oral.', min: 10 },
    { id: 'lang.false_friends', skill: 'lang', label: 'Faux amis', desc: 'actually, eventually, library… les pièges qui guettent les francophones.', min: 5 },
    { id: 'lang.tenses', skill: 'lang', label: 'Les temps', desc: 'Present perfect ou prétérit, for / since / ago, le futur après « when ».', min: 5 },
    { id: 'lang.prepositions', skill: 'lang', label: 'Prépositions', desc: 'depend on, arrive in, responsible for… celles qui ne se traduisent pas.', min: 5 },
    { id: 'lang.collocations', skill: 'lang', label: 'Collocations', desc: 'make a decision, take a break, do research : les mots qui vont ensemble.', min: 5 },
    { id: 'lang.weak_points', skill: 'lang', label: 'Mes points faibles', desc: 'Une série bâtie sur votre journal d’erreurs.', min: 5 },
    { id: 'pron.minimal_pairs', skill: 'pron', label: 'Sons proches', desc: 'Entendre puis dire : ship / sheep, hat / hut, heat / eat.', min: 5 },
    { id: 'pron.stress', skill: 'pron', label: 'Accent de mot', desc: 'deVELopment, TECHnology : trouver la syllabe qui porte l’accent.', min: 5 }
  ];
  var GROUPS = [
    { id: 'read', label: 'Lecture', icon: 'read', level: 'read' }, { id: 'listen', label: 'Écoute', icon: 'ear', level: 'listen' },
    { id: 'write', label: 'Écrit', icon: 'pen', level: 'write' }, { id: 'speak', label: 'Oral', icon: 'speak', level: 'speak' },
    { id: 'lang', label: 'Langue', icon: 'lang', level: 'lang' }, { id: 'pron', label: 'Prononciation', icon: 'mic', level: 'speak' }
  ];
  var DEFAULT_TYPE = { read: 'read.article', listen: 'listen.partial_dictation', write: 'write.translate', speak: 'speak.shadowing', lang: 'lang.collocations', pron: 'pron.minimal_pairs' };
  var GEN_LEVELS = ['A2', 'B1', 'B1+', 'B2', 'B2+', 'C1'];
  var ACCENTS = { 'en-GB': ['britannique', 'britannique'], 'en-US': ['américain', 'américaine'], 'en-AU': ['australien', 'australienne'], 'en-CA': ['canadien', 'canadienne'], 'en-IE': ['irlandais', 'irlandaise'], 'en-IN': ['indien', 'indienne'] };

  function arr(v) { return Array.isArray(v) ? v : []; }
  function typeById(id) { for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === id) return TYPES[i]; return null; }
  function groupById(id) { for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].id === id) return GROUPS[i]; return null; }
  function typeLabel(id) { var t = typeById(id); return t ? t.label : (id ? id : 'Série sur mesure'); }
  function setKey(id) { return 'rzx-' + id; }
  function skillChip(id) {
    var g = groupById(id);
    if (!g) return R.h.skill(id);
    return '<span class="rz-skill sk-' + (id === 'pron' ? 'speak' : esc(id)) + '">' + R.icon(g.icon) + '<span>' + esc(g.label) + '</span></span>';
  }
  function genLevel(skill) {
    var b = R.level(skill === 'pron' ? 'speak' : skill).band;
    if (GEN_LEVELS.indexOf(b) >= 0) return b;
    if (/^A/.test(b)) return 'A2';
    if (/^C/.test(b)) return 'C1';
    return 'B1';
  }
  function durOf(t, minutes) { return Math.max(minutes || X.minutes, t ? t.min : 5); }
  function entryOf(id) { var l = R.data.exercises; for (var i = 0; i < l.length; i++) if (l[i] && l[i].id === id) return l[i]; return null; }
  function ensureEntry(doc) {
    var e = entryOf(doc.id);
    if (e) return e;
    e = { id: doc.id, day: doc.day || R.today(), skill: doc.skill || '', type: doc.type || '', title: String(doc.title || '').slice(0, 160), status: 'ready', createdAt: doc.createdAt || Date.now(), doneAt: 0, score: null };
    R.data.exercises.push(e);
    R.save();
    return e;
  }
  function sessionSkill(doc) {
    var sk = doc && doc.skill;
    if (sk === 'read' || sk === 'listen' || sk === 'write' || sk === 'speak' || sk === 'lang') return sk;
    var items = arr(doc && doc.items), oral = items.filter(function (it) { return it && /^(shadow|read_aloud|open_speak)$/.test(it.kind); }).length;
    return oral * 2 > items.length ? 'speak' : 'listen';
  }

  /* ══ Suggestions ════════════════════════════════════════════════════════ */

  function weakType(cat) {
    if (/^lex\.(false_friend|franglais)/.test(cat)) return 'lang.false_friends';
    if (/^lex\.(collocation|phrasal)/.test(cat)) return 'lang.collocations';
    if (cat === 'gram.preposition') return 'lang.prepositions';
    if (/^gram\.(tense|for_since|future)/.test(cat)) return 'lang.tenses';
    if (/^pron\.(stress|sentence)/.test(cat)) return 'pron.stress';
    if (/^pron\./.test(cat)) return 'pron.minimal_pairs';
    return 'lang.weak_points';
  }
  function suggestions(n) {
    var out = [], seen = {};
    var push = function (type, why, focus) {
      var t = typeById(type);
      if (!t || seen[type]) return;
      seen[type] = 1;
      out.push({ type: type, skill: t.skill, label: t.label, why: why, focus: focus || '', min: t.min });
    };
    R.weakPoints(3).forEach(function (w) {
      var ex = w.examples[0];
      push(weakType(w.category), 'Votre point faible : ' + w.label.toLowerCase() + ' (' + w.count + ' erreur' + (w.count > 1 ? 's' : '') + ')',
        'Point faible à travailler : ' + w.label + ' [' + w.category + ']' + (ex ? ' — par exemple « ' + ex.original + ' » au lieu de « ' + ex.correction + ' »' : ''));
    });
    var wk = R.week().bySkill;
    ['listen', 'speak', 'read', 'write'].map(function (k) { return { k: k, v: wk[k] || 0, t: R.level(k).theta }; })
      .sort(function (a, b) { return a.v - b.v || a.t - b.t; })
      .forEach(function (o) {
        var lab = groupById(o.k).label;
        push(DEFAULT_TYPE[o.k], o.v ? lab + ' : la compétence la moins travaillée cette semaine (' + R.fmtMin(o.v) + ')' : lab + ' : pas encore travaillée cette semaine');
      });
    push('lang.false_friends', 'Un classique pour les francophones');
    return out.slice(0, n || 3);
  }

  /* ══ Lancer, recevoir, jouer ════════════════════════════════════════════ */

  function launch(o) {
    o = o || {};
    if (X.pending && !X.pending.error && R.jobById(X.pending.job)) { R.toast('Une série est déjà en préparation : elle s’ouvrira dès qu’elle sera prête.'); if (R.viewId() !== 'exercises') R.go('exercises'); return null; }
    var t = typeById(o.type);
    var skill = o.skill || (t && t.skill) || 'lang';
    var minutes = [5, 10, 15].indexOf(+o.minutes) >= 0 ? +o.minutes : X.minutes;
    if (t && minutes < t.min) minutes = t.min;
    var focus = String(o.focus != null && o.focus !== '' ? o.focus : (X.focus || '')).trim().slice(0, 600);
    var params = { skill: skill, type: t ? t.id : '', minutes: minutes, level: genLevel(skill), focus: focus, topic: String(o.topic || '').slice(0, 200) };
    var job = R.uid('rzexe');
    X.pending = { job: job, params: params, label: t ? t.label : 'Série sur mesure', error: '', startedAt: Date.now() };
    X.play = null;
    R.gen('exercise', params, { job: job })['catch'](function () { /* traité par jobDone */ });
    if (R.viewId() !== 'exercises') R.go('exercises'); else R.render();
    return job;
  }

  R.on('jobDone', function (ev) {
    if (!ev || ev.kind !== 'exercise') return;
    var mine = X.pending && X.pending.job === ev.job;
    if (ev.error) {
      if (mine) X.pending.error = (ev.error && ev.error.message) || String(ev.error);
      R.renderSoon();
      return;
    }
    var r = ev.result, doc = r && r.doc;
    if (!doc || !(doc.id || r.id)) return;
    if (!doc.id) doc.id = r.id;
    R.docPut('exercise', doc.id, doc);
    var fresh = !entryOf(doc.id);
    var entry = ensureEntry(doc);
    if (mine) {
      X.pending = null;
      openDoc(doc, entry, false);
      if (R.viewId() !== 'exercises' || document.visibilityState === 'hidden') R.notify('Votre série « ' + (doc.title || 'Exercices') + ' » est prête.', 'exercises');
    } else if (fresh && ev.reattached) {
      R.notify('Une série d’exercices est prête : « ' + (doc.title || '') + ' ».', 'exercises');
    }
    R.renderSoon();
  });

  function openDoc(doc, entry, replay) {
    if (replay) delete entry.progress;
    R.items.start(setKey(doc.id), arr(doc.items), {
      level: doc.level, skill: doc.skill, type: doc.type, ref: doc.id, origin: 'exercise',
      resume: !replay && entry.progress ? entry.progress : null,
      onChange: function (snap) { saveProgress(doc.id, snap); },
      onDone: function (sm) { finishDoc(doc.id, sm); }
    });
    X.play = { id: doc.id };
    if (replay || entry.status !== 'done') entry.status = 'active';
    R.save();
    window.scrollTo(0, 0);
  }
  function openById(id, replay) {
    var e = entryOf(id);
    return R.doc('exercise', id).then(function (doc) {
      if (!doc) { R.toast('Cette série est introuvable sur le disque.'); return; }
      if (!doc.id) doc.id = id;
      openDoc(doc, e || ensureEntry(doc), !!replay);
      if (R.viewId() !== 'exercises') R.go('exercises'); else R.render();
    }, function (err) { R.toast('Série illisible : ' + err.message); });
  }
  function saveProgress(id, snap) {
    var e = entryOf(id);
    if (!e || !snap || snap.done || e.status === 'done') return;
    e.progress = snap;
    e.status = 'active';
    R.save();
  }
  function finishDoc(id, sm) {
    var e = entryOf(id), doc = R.docCached('exercise', id), now = Date.now();
    if (e) { e.status = 'done'; e.doneAt = now; e.score = sm.scored ? sm.score : null; delete e.progress; }
    var sk = {};
    sk[sessionSkill(doc)] = Math.max(0.5, sm.activeMs / 60000);
    R.logSession({ kind: 'exercise', ref: id, title: doc ? doc.title : (e ? e.title : ''), startedAt: now - sm.activeMs, endedAt: now, skillMinutes: sk, score: sm.scored ? sm.score : null });
    if (doc) {
      doc.result = { score: sm.score, at: now, items: sm.items.map(function (r) { return { v: r.verdict || (r.skipped ? 'skip' : ''), s: r.score }; }) };
      var p = R.docSave('exercise', id, doc);
      if (p && p['catch']) p['catch'](function () { /* le résultat reste dans learning.json */ });
    }
    R.save();
  }

  /* ══ Texte et dialogue ══════════════════════════════════════════════════ */

  function reEsc(t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function glossify(text, gl) {
    var terms = gl.map(function (g, i) { return { t: String(g.term || '').trim(), i: i }; }).filter(function (x) { return x.t.length > 1; })
      .sort(function (a, b) { return b.t.length - a.t.length; });
    if (!terms.length) return esc(text);
    var re = new RegExp('\\b(' + terms.map(function (x) { return reEsc(x.t).replace(/\s+/g, '\\s+'); }).join('|') + ')(s|es|ed|d|ing)?\\b', 'gi');
    var out = '', last = 0, done = glossify.done, m;
    while ((m = re.exec(text))) {
      var low = m[1].toLowerCase().replace(/\s+/g, ' ');
      var hit = terms.filter(function (x) { return x.t.toLowerCase() === low; })[0];
      if (!hit || done[hit.i]) continue;
      done[hit.i] = 1;
      var g = gl[hit.i];
      out += esc(text.slice(last, m.index)) + '<span class="rzx-gloss" tabindex="0">' + esc(m[0])
        + '<span class="rzx-gloss-tip" role="tooltip"><b lang="en">' + esc(g.term) + '</b><span class="rzx-gloss-fr">' + esc(g.meaningFr) + '</span>'
        + (g.meaningEn ? '<span class="rzx-gloss-en" lang="en">' + esc(g.meaningEn) + '</span>' : '') + '</span></span>';
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  function passageHtml(doc) {
    var p = doc.passage, gl = arr(p.glossary);
    glossify.done = {};
    var h = ['<article class="rz-card rzx-passage">'];
    if (p.title) h.push('<h3 class="rzx-passage-title" lang="en">' + esc(p.title) + '</h3>');
    arr(p.paragraphs).forEach(function (par) { h.push('<p lang="en">' + glossify(String(par || ''), gl) + '</p>'); });
    if (gl.length) {
      h.push('<details class="rzx-glosslist"><summary>Glossaire · ' + gl.length + ' mot' + (gl.length > 1 ? 's' : '') + '</summary><ul>');
      gl.forEach(function (g, i) {
        var has = R.cards && R.cards.has(g.term);
        h.push('<li><span class="rzx-gl-t"><b lang="en">' + esc(g.term) + '</b> — ' + esc(g.meaningFr) + (g.example ? '<span class="rz-muted" lang="en">' + esc(g.example) + '</span>' : '') + '</span>'
          + (has ? '<span class="rzx-carded">' + R.icon('check') + ' En carte</span>' : '<button type="button" class="btn btn-ghost btn-small" data-act="rz-ex-gloss-card" data-id="' + esc(doc.id) + '" data-i="' + i + '">' + R.icon('cards') + ' Carte</button>') + '</li>');
      });
      h.push('</ul></details>');
    }
    h.push('</article>');
    return h.join('');
  }

  function scriptHtml(doc, set) {
    var sc = doc.script, key = 'rzx-scr-' + doc.id;
    var show = X.showScript[doc.id] || (set && set.done);
    var names = {};
    arr(sc.speakers).forEach(function (sp) { names[sp.id] = sp; });
    var h = ['<section class="rz-card rzx-script">'];
    h.push('<div class="rzx-script-head"><span class="rz-card-title" lang="en">' + esc(sc.title || 'Listening') + '</span></div>');
    if (sc.contextFr) h.push('<div class="rzx-script-ctx">' + esc(sc.contextFr) + '</div>');
    h.push('<div class="rzx-script-who">' + arr(sc.speakers).map(function (sp) {
      return '<span class="rzx-who"><b>' + esc(sp.name || sp.id) + '</b> · ' + esc(ACCENTS[sp.accent] ? ACCENTS[sp.accent][sp.gender === 'female' ? 1 : 0] : (sp.accent || '')) + '</span>';
    }).join('') + '</div>');
    h.push('<div class="rzx-script-player">' + R.h.player(key, { label: 'Écouter le dialogue', source: function () { return R.tts.script(arr(sc.lines), arr(sc.speakers), { key: key }); } }) + '</div>');
    if (show) {
      h.push('<div class="rzx-script-lines">' + arr(sc.lines).map(function (l, i) {
        var sp = names[l.speaker] || {};
        return '<p class="rzx-sline" data-rz-say="' + esc(key) + '" data-rz-idx="' + i + '"><b class="rzx-sline-who">' + esc(sp.name || l.speaker) + '</b><span lang="en">' + esc(l.text) + '</span></p>';
      }).join('') + '</div>');
      if (!(set && set.done)) h.push('<button type="button" class="btn btn-ghost btn-small" data-act="rz-ex-script" data-id="' + esc(doc.id) + '">Masquer le texte</button>');
    } else {
      h.push('<div class="rzx-script-hidden"><span class="rz-muted">Le texte reste caché pour entraîner l’oreille ; il s’affiche à la fin de la série.</span>'
        + '<button type="button" class="btn btn-ghost btn-small" data-act="rz-ex-script" data-id="' + esc(doc.id) + '">Afficher le texte</button></div>');
    }
    h.push('</section>');
    return h.join('');
  }

  function glossMissing(doc) {
    var p = doc.passage;
    return arr(p && p.glossary).filter(function (g) { return g && g.term && R.cards && !R.cards.has(g.term); });
  }

  function playHtml(doc) {
    var key = setKey(doc.id), set = R.items.state(key);
    var hasPassage = doc.passage && arr(doc.passage.paragraphs).length;
    var hasScript = doc.script && arr(doc.script.lines).length;
    var h = [];
    h.push('<div class="rzx-play-head"><button type="button" class="btn btn-ghost" data-act="rz-ex-back" title="Revenir aux exercices (Échap) — la série est gardée">' + R.icon('back') + ' Exercices</button>'
      + '<div class="rzx-play-title"><div class="rzx-play-kick">' + skillChip(doc.skill) + '<span class="rz-muted">' + esc(typeLabel(doc.type)) + '</span></div>'
      + '<h2 class="rz-section-title" lang="en">' + esc(doc.title || 'Exercises') + '</h2></div>'
      + '<div class="rzx-play-meta">' + R.h.level(doc.level || '—') + '<span class="rzx-tag">' + R.icon('clock') + ' ' + esc((doc.minutes || 10) + ' min') + '</span></div></div>');
    if (doc.instructionsFr) h.push('<div class="rz-callout rzx-instr">' + esc(doc.instructionsFr) + '</div>');
    var side = (hasPassage ? passageHtml(doc) : '') + (hasScript ? scriptHtml(doc, set) : '');
    h.push('<div class="rzx-play' + (side ? ' has-side' : '') + '">');
    if (side) h.push('<div class="rzx-play-side">' + side + '</div>');
    h.push('<div class="rzx-play-main"><section class="rz-card rzx-play-card">' + R.items.seriesHtml(key) + '</section>' + (set && set.done ? endHtml(doc) : '') + '</div>');
    h.push('</div>');
    return h.join('');
  }

  function endHtml(doc) {
    var t = typeById(doc.type);
    var miss = glossMissing(doc);
    var h = ['<section class="rz-card rzx-end">'];
    if (miss.length) h.push('<div class="rz-callout rzx-end-gloss">' + R.icon('cards') + ' <span>' + miss.length + ' mot' + (miss.length > 1 ? 's' : '') + ' du glossaire ne sont pas encore dans vos cartes : ' + esc(miss.slice(0, 6).map(function (g) { return g.term; }).join(', ')) + (miss.length > 6 ? '…' : '') + '</span>'
      + '<button type="button" class="btn btn-secondary btn-small" data-act="rz-ex-gloss-all" data-id="' + esc(doc.id) + '">Les ajouter</button></div>');
    h.push('<div class="rzx-end-actions">'
      + '<button type="button" class="btn btn-primary rz-big" data-act="rz-ex-again" data-id="' + esc(doc.id) + '">' + R.icon('spark') + ' Une autre série · ' + esc(t ? t.label : 'même genre') + '</button>'
      + '<button type="button" class="btn btn-secondary" data-act="rz-ex-replay" data-id="' + esc(doc.id) + '">' + R.icon('replay') + ' Rejouer celle-ci</button>'
      + '<button type="button" class="btn btn-ghost" data-act="rz-ex-back">Retour aux exercices</button></div>');
    h.push('</section>');
    return h.join('');
  }

  /* ══ Grille ═════════════════════════════════════════════════════════════ */

  function pendingHtml() {
    var p = X.pending;
    if (!p) return '';
    var t = typeById(p.params.type);
    var meta = groupById(p.params.skill) ? groupById(p.params.skill).label : '';
    meta += ' · ' + p.params.minutes + ' min · ' + p.params.level;
    if (p.error) {
      return '<section class="rz-card rzx-pending is-error"><div class="rz-card-head"><span class="rz-card-title">La série n’a pas pu être préparée</span><span class="rz-card-meta">' + esc(meta) + '</span></div>'
        + '<div class="rz-err-line">' + esc(p.error) + '</div>'
        + '<div class="rz-row"><button type="button" class="btn btn-primary" data-act="rz-ex-retry">Réessayer</button><button type="button" class="btn btn-ghost" data-act="rz-ex-dismiss">Fermer</button></div></section>';
    }
    var j = R.jobById(p.job);
    return '<section class="rz-card rzx-pending"><div class="rz-card-head"><span class="rz-card-title">Préparation · ' + esc(t ? t.label : p.label) + '</span><span class="rz-card-meta">' + esc(meta) + '</span></div>'
      + (j ? R.h.jobLine(j) : '<div class="rz-job"><span class="rz-spin"></span><span class="rz-job-text">Démarrage de l’agent…</span></div>')
      + (p.params.focus ? '<div class="rzx-pending-focus">Votre consigne : « ' + esc(p.params.focus.slice(0, 200)) + ' »</div>' : '')
      + '<div class="rz-card-foot">Claude écrit la série à votre niveau, en une à deux minutes. Vous pouvez faire autre chose : elle s’ouvrira ici, et une notification vous préviendra.</div>'
      + '<div class="rz-row"><button type="button" class="btn btn-ghost" data-act="rz-ex-cancel">Annuler</button></div></section>';
  }

  function suggHtml() {
    var sg = X.sugg = suggestions(3);
    if (!sg.length) return '';
    var busy = X.pending && !X.pending.error;
    return '<section class="rz-card rzx-sugg"><div class="rz-card-head"><span class="rz-card-title">' + R.icon('spark') + ' Pour vous, maintenant</span><span class="rz-card-meta">un clic suffit</span></div><div class="rzx-sugg-list">'
      + sg.map(function (x, i) {
        return '<button type="button" class="rzx-sugg-btn" data-act="rz-ex-sugg" data-i="' + i + '"' + (busy ? ' disabled' : '') + '>' + skillChip(x.skill)
          + '<span class="rzx-sugg-label">' + esc(x.label) + '</span><span class="rzx-sugg-why">' + esc(x.why) + '</span>'
          + '<span class="rzx-sugg-go">' + esc(durOf(typeById(x.type)) + ' min') + ' ' + R.icon('arrow') + '</span></button>';
      }).join('') + '</div></section>';
  }

  function prefsHtml() {
    var skills = [['lang', 'Langue'], ['read', 'Lecture'], ['listen', 'Écoute'], ['write', 'Écrit'], ['speak', 'Oral'], ['pron', 'Prononciation']];
    return '<section class="rz-card rzx-prefs"><div class="rzx-pref"><span class="rzx-pref-k">Durée</span>' + R.h.chips('rzx-min', [5, 10, 15], X.minutes, ['5 min', '10 min', '15 min'], 'rz-ex-minutes') + '</div>'
      + '<div class="rzx-pref is-focus"><label class="rzx-pref-k" for="rzx-focus">Je veux travailler…</label>'
      + '<input id="rzx-focus" class="input rzx-focus" type="text" data-role="rz-ex-focus" data-focus-key="rzx-ex-focus" data-dict-lang="fr" maxlength="300" placeholder="les questions au passé, le vocabulaire des réunions, « make » ou « do »…" value="' + esc(X.focus) + '">'
      + '<select class="input rzx-freeskill" data-role="rz-ex-freeskill" data-focus-key="rzx-ex-freeskill" aria-label="Compétence de la série sur mesure">' + skills.map(function (s) { return '<option value="' + s[0] + '"' + (X.freeSkill === s[0] ? ' selected' : '') + '>' + esc(s[1]) + '</option>'; }).join('') + '</select>'
      + '<button type="button" class="btn btn-secondary" data-act="rz-ex-free"' + (X.pending && !X.pending.error ? ' disabled' : '') + '>Série sur mesure</button></div>'
      + '<div class="rzx-pref-note rz-muted">La consigne accompagne aussi chaque série lancée ci-dessous. La durée s’ajuste au minimum de chaque exercice.</div></section>';
  }

  function groupsHtml() {
    var busy = X.pending && !X.pending.error;
    var wk = R.week().bySkill;
    return '<div class="rzx-groups">' + GROUPS.map(function (g) {
      var types = TYPES.filter(function (t) { return t.skill === g.id; });
      var mins = g.id === 'pron' ? 0 : (g.id === 'lang' ? (wk.lang || 0) + (wk.srs || 0) : wk[g.id] || 0);
      return '<section class="rz-card rzx-group is-' + esc(g.id) + '"><div class="rzx-group-head">' + skillChip(g.id) + '<span class="rzx-group-meta">'
        + (g.id !== 'pron' ? '<span class="rz-muted">' + esc(mins ? R.fmtMin(mins) + ' cette semaine' : 'pas encore cette semaine') + '</span>' : '')
        + R.h.level(R.level(g.level).band) + '</span></div><div class="rzx-types">'
        + types.map(function (t) {
          return '<button type="button" class="rzx-type" data-act="rz-ex-launch" data-type="' + esc(t.id) + '"' + (busy ? ' disabled' : '') + '>'
            + '<span class="rzx-type-l">' + esc(t.label) + '</span><span class="rzx-type-m">' + R.icon('clock') + esc(durOf(t) + ' min') + '</span>'
            + '<span class="rzx-type-d">' + esc(t.desc) + '</span></button>';
        }).join('') + '</div></section>';
    }).join('') + '</div>';
  }

  function histHtml() {
    var list = R.data.exercises.slice().reverse();
    if (!list.length) return '';
    var shown = X.histAll ? list : list.slice(0, 6);
    var h = ['<section class="rz-card rzx-hist"><div class="rz-card-head"><span class="rz-card-title">Vos séries</span><span class="rz-card-meta">' + list.length + '</span></div><div class="rzx-hist-list">'];
    shown.forEach(function (e) {
      var st = e.status === 'done' ? (e.score != null ? Math.round(e.score * 100) + ' %' : 'faite') : (e.status === 'active' ? 'en cours' : 'prête');
      var btn = e.status === 'done' ? '<button type="button" class="btn btn-ghost btn-small" data-act="rz-ex-replay" data-id="' + esc(e.id) + '">' + R.icon('replay') + ' Rejouer</button>'
        : '<button type="button" class="btn btn-secondary btn-small" data-act="rz-ex-open" data-id="' + esc(e.id) + '">' + (e.status === 'active' ? 'Reprendre' : 'Commencer') + '</button>';
      h.push('<div class="rzx-hrow is-' + esc(e.status) + '">' + skillChip(e.skill)
        + '<span class="rzx-hrow-t"><b lang="en">' + esc(e.title || typeLabel(e.type)) + '</b><span class="rz-muted">' + esc(typeLabel(e.type) + ' · ' + R.fmtDay(e.day)) + '</span></span>'
        + '<span class="rzx-hrow-s' + (e.status === 'done' && e.score != null ? (e.score >= 0.8 ? ' is-good' : (e.score < 0.5 ? ' is-low' : '')) : '') + '">' + esc(st) + '</span>' + btn + '</div>');
    });
    h.push('</div>');
    if (list.length > 6) h.push('<div class="rz-row"><button type="button" class="btn btn-ghost" data-act="rz-ex-hist-all">' + (X.histAll ? 'Réduire' : 'Tout afficher · ' + list.length) + '</button></div>');
    h.push('</section>');
    return h.join('');
  }

  function gridHtml() {
    var h = [];
    h.push('<div class="rzx-head"><div><div class="rz-kicker">' + R.icon('target') + ' Exercices à la demande</div><h2 class="rz-section-title">Que voulez-vous travailler ?</h2></div></div>');
    h.push(X.pending ? pendingHtml() : suggHtml());
    h.push(prefsHtml());
    h.push(groupsHtml());
    h.push(histHtml());
    return h.join('');
  }

  function render() {
    if (X.play) {
      var doc = R.docCached('exercise', X.play.id);
      if (doc && R.items.state(setKey(doc.id))) return playHtml(doc);
      X.play = null;
    }
    return gridHtml();
  }

  R.view('exercises', {
    label: 'Exercices', icon: 'target', order: 20, title: 'Exercices à la demande, par compétence ou par point faible',
    render: render,
    onShow: function (p) { if (p && p.id) openById(p.id, false); },
    onHide: function () { R.tts.stopAll(); },
    keydown: function (e, el, role) {
      if (e.key === 'Escape' && X.play) { e.preventDefault(); R.tts.stopAll(); X.play = null; R.render(); return true; }
      if (role === 'rz-ex-focus' && e.key === 'Enter') { e.preventDefault(); freeLaunch(); return true; }
      return false;
    }
  });

  function freeLaunch() {
    if (!X.focus.trim()) {
      R.toast('Dites ce que vous voulez travailler, ou choisissez un exercice dans la grille.');
      setTimeout(function () { var el = document.querySelector('[data-focus-key="rzx-ex-focus"]'); if (el) el.focus(); }, 0);
      return;
    }
    launch({ skill: X.freeSkill, type: '', focus: X.focus });
  }

  /* ══ Carte d'accueil ════════════════════════════════════════════════════ */

  R.homeCard({ id: 'quick', area: 'main', order: 40, html: function () {
    var h = ['<section class="rz-card rzx-quick"><div class="rz-card-head"><span class="rz-card-title">Exercice rapide</span><span class="rz-card-meta">une compétence, 5 minutes</span></div>'];
    var p = X.pending;
    var open = R.data.exercises.slice().reverse().filter(function (e) { return e && (e.status === 'active' || e.status === 'ready') && Date.now() - (e.createdAt || 0) < 7 * 86400000; })[0];
    if (p && !p.error) {
      var j = R.jobById(p.job);
      h.push('<div class="rzx-quick-job">' + (j ? R.h.jobLine(j) : '') + '<button type="button" class="btn btn-ghost btn-small" data-act="rz-go" data-view="exercises">Voir</button></div>');
    } else if (open) {
      h.push('<div class="rz-callout rzx-quick-open"><span>' + esc(open.status === 'active' ? 'Série en cours' : 'Série prête') + ' : <b lang="en">' + esc(open.title || typeLabel(open.type)) + '</b></span>'
        + '<button type="button" class="btn btn-secondary btn-small" data-act="rz-ex-open" data-id="' + esc(open.id) + '">' + (open.status === 'active' ? 'Reprendre' : 'Commencer') + '</button></div>');
    }
    var sg = X.sugg = suggestions(3);
    h.push('<div class="rzx-quick-list">' + sg.map(function (x, i) {
      return '<button type="button" class="rzx-quick-btn" data-act="rz-ex-quick" data-i="' + i + '"' + (p && !p.error ? ' disabled' : '') + '>' + skillChip(x.skill)
        + '<span class="rzx-quick-l">' + esc(x.label) + '</span><span class="rzx-quick-why">' + esc(x.why) + '</span>' + R.icon('arrow') + '</button>';
    }).join('') + '</div>');
    h.push('<div class="rz-card-foot rzx-quick-foot"><span>Lecture, écoute, écrit, oral, langue, prononciation : une série à la demande, corrigée sur-le-champ.</span>'
      + '<button type="button" class="btn btn-ghost" data-act="rz-go" data-view="exercises">Tous les exercices ' + R.icon('arrow') + '</button></div></section>');
    return h.join('');
  } });

  /* ══ Actions ════════════════════════════════════════════════════════════ */

  R.act('rz-ex-minutes', function (el) { X.minutes = +el.getAttribute('data-value') || 10; R.render(); });
  R.act('rz-ex-launch', function (el) { launch({ type: el.getAttribute('data-type') }); });
  R.act('rz-ex-sugg', function (el) { var s = X.sugg[+el.getAttribute('data-i')]; if (s) launch({ type: s.type, focus: s.focus }); });
  R.act('rz-ex-quick', function (el) { var s = X.sugg[+el.getAttribute('data-i')]; if (s) launch({ type: s.type, focus: s.focus, minutes: 5 }); });
  R.act('rz-ex-free', freeLaunch);
  R.act('rz-ex-cancel', function () {
    var p = X.pending;
    X.pending = null;
    if (p) R.cancel(p.job);
    R.toast('Préparation annulée.');
    R.render();
  });
  R.act('rz-ex-retry', function () { var p = X.pending; if (p) { X.pending = null; launch({ skill: p.params.skill, type: p.params.type, minutes: p.params.minutes, focus: p.params.focus, topic: p.params.topic }); } });
  R.act('rz-ex-dismiss', function () { X.pending = null; R.render(); });
  R.act('rz-ex-back', function () { R.tts.stopAll(); X.play = null; R.render(); window.scrollTo(0, 0); });
  R.act('rz-ex-open', function (el) { openById(el.getAttribute('data-id'), false); });
  R.act('rz-ex-replay', function (el) { openById(el.getAttribute('data-id'), true); });
  R.act('rz-ex-again', function (el) {
    var doc = R.docCached('exercise', el.getAttribute('data-id'));
    if (doc) launch({ skill: doc.skill, type: doc.type, minutes: doc.minutes });
  });
  R.act('rz-ex-script', function (el) { var id = el.getAttribute('data-id'); X.showScript[id] = !X.showScript[id]; R.render(); });
  R.act('rz-ex-gloss-card', function (el) {
    var doc = R.docCached('exercise', el.getAttribute('data-id'));
    var g = doc && arr(doc.passage && doc.passage.glossary)[+el.getAttribute('data-i')];
    if (!g || !R.cards) return;
    var c = R.cards.add({ kind: 'word', front: g.term, back: g.meaningFr, example: g.example }, { kind: 'exercise', ref: doc.id });
    R.toast(c ? '« ' + g.term + ' » ajouté à vos cartes.' : '« ' + g.term + ' » est déjà dans vos cartes.');
    R.render();
  });
  R.act('rz-ex-gloss-all', function (el) {
    var doc = R.docCached('exercise', el.getAttribute('data-id'));
    if (!doc || !R.cards) return;
    var n = R.cards.addMany(glossMissing(doc).map(function (g) { return { kind: 'word', front: g.term, back: g.meaningFr, example: g.example }; }), { kind: 'exercise', ref: doc.id });
    R.toast(n + ' mot' + (n > 1 ? 's' : '') + ' ajouté' + (n > 1 ? 's' : '') + ' à vos cartes.');
    R.render();
  });
  R.act('rz-ex-hist-all', function () { X.histAll = !X.histAll; R.render(); });
  R.input('rz-ex-focus', function (el) { X.focus = el.value.slice(0, 300); });
  R.change('rz-ex-freeskill', function (el) { X.freeSkill = el.value; });

  R.exercise = { launch: launch, open: openById, suggestions: suggestions, TYPES: TYPES, typeLabel: typeLabel };

  /* ══ Simulation hors WebView2 ═══════════════════════════════════════════ */

  var FALLBACK = {
    skill: 'lang', type: 'lang.false_friends', title: 'False friends at work', level: 'B1', minutes: 5,
    instructionsFr: 'Trois pièges classiques des francophones.', topic: 'Faux amis',
    passage: { title: '', paragraphs: [], glossary: [] }, script: { title: '', contextFr: '', speakers: [], lines: [] },
    items: [
      { id: 'i1', kind: 'choice', prompt: '« En fait, je n’ai pas fini. » → ___, I haven’t finished.', promptFr: '', options: ['Actually', 'Currently', 'Eventually', 'Actively'], answer: 'Actually', accepted: [], explanationFr: '« actually » = en fait ; « actuellement » = currently.', audioText: '', words: [], seconds: 0, criteria: [], modelAnswer: '' },
      { id: 'i2', kind: 'gap', prompt: 'Can you send me the ___ of the meeting?', promptFr: 'le compte rendu', options: [], answer: 'minutes', accepted: ['notes'], explanationFr: '« the minutes » : le compte rendu d’une réunion.', audioText: '', words: [], seconds: 0, criteria: [], modelAnswer: '' },
      { id: 'i3', kind: 'error_spot', prompt: 'I’m agree with you.', promptFr: '', options: [], answer: 'I agree with you.', accepted: [], explanationFr: '« agree » est un verbe : I agree.', audioText: '', words: [], seconds: 0, criteria: [], modelAnswer: '' }
    ]
  };
  /* Documents réels de l'hôte (exercise-listen, exercise-lang) et documents écrits au même format pour le reste. */
  var FIX_BY_TYPE = { 'listen.partial_dictation': 'listen-dictation', 'listen.dictation': 'listen-dictation', 'listen.minimal_pairs': 'pron', 'lang.false_friends': 'lang-false_friends' };
  R.fixture('exercise', function (params) {
    var skill = FIX_BY_TYPE[params.type] || (['read', 'listen', 'write', 'speak', 'lang', 'pron'].indexOf(params.skill) >= 0 ? params.skill : 'lang');
    var adapt = function (doc) {
      doc = JSON.parse(JSON.stringify(doc || FALLBACK));
      if (params.skill) doc.skill = params.skill;
      if (params.type) doc.type = params.type;
      if (params.level) doc.level = params.level;
      if (params.minutes) doc.minutes = params.minutes;
      return doc;
    };
    if (typeof fetch !== 'function') return adapt(FALLBACK);
    return fetch('revizator/fixtures/exercise-' + skill + '.json').then(function (r) { if (!r.ok) throw new Error('absent'); return r.json(); })
      .then(adapt, function () { return adapt(FALLBACK); });
  });
})();
