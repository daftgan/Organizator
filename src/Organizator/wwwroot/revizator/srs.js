/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — cartes et révisions espacées (FSRS-6) · module U1a
   Planificateur FSRS-6 (paramètres par défaut, rétention visée R.prefs.retention), magasin des cartes,
   composant de séance de révision intégrable dans n'importe quelle vue, pastille de l'onglet de page,
   carte d'accueil « Révisions » et vue Cartes. Styles : exercise.css (préfixe .rzx-).

   ── API ───────────────────────────────────────────────────────────────────
   Cartes (R.data.cards)
     R.cards.add(spec, origin) → la carte créée | null (doublon : même recto normalisé, ou recto vide)
       spec   = { kind: 'word'|'collocation'|'phrase'|'false_friend'|'grammar'|'pronunciation'|'error',
                  front, back, example, audioText?, note?, accepted? }   (forme des cards des cours et des corrections)
       origin = { kind: 'lesson'|'exercise'|'grade'|'tutor'|'test'|'manual', ref }
     R.cards.addMany(list, origin) → nombre ajouté
     R.cards.due(now) → cartes à revoir (non suspendues, déjà vues, échéance passée), R le plus bas d'abord
     R.cards.count() → nombre total ; R.cards.dueCount(now) → nombre à revoir ;
     R.cards.counts(now) → { total, due, fresh, learning, review, suspended, mature, leeches }
     R.cards.byId(id), R.cards.remove(id) → bool, R.cards.suspend(id, bool) → carte | null
     R.cards.has(front) → bool ; R.cards.all() → R.data.cards ; R.cards.stats(now) → counts + { retention30, reviews30, nextDue, nextDueCount }
     R.cards.fromEdits(edits, max) → [spec] (cartes « error » tirées des erreurs d'une correction, spec §5.6)
     R.cards.retrievability(card, now) → R actuel (0..1, 0 pour une carte nouvelle)
   Forme d'une carte :
     { id, kind, front, back, example, audioText, note, accepted: [string], origin: { kind, ref }, createdAt, suspended, leech,
       fsrs: { state: 'new'|'learning'|'review'|'relearning', S (stabilité, jours ; 0 tant que nouvelle),
               D (difficulté 1..10 ; 0 tant que nouvelle), due (ms), last (ms ; 0 si jamais revue), reps, lapses, step } }
   Journal R.data.reviewLog : { c: id de la carte, g: note 1..4 (Raté, Difficile, Bien, Facile), at: ms, ms: temps de réponse }
   Séance de révision (composant intégrable : U1b l'insère en échauffement du cours du jour)
     R.srs.start(key, { max, minutes, newMax, onDone(stats) }) → état
       file : cartes dues d'abord (R le plus bas), puis au plus newMax nouvelles (plafond quotidien 20) ; max cartes
       distinctes ; minutes = temps au-delà duquel la séance s'arrête à la carte suivante (0 = sans limite).
       File vide : onDone({ empty: true, … }) est appelé aussitôt après (setTimeout 0).
     R.srs.html(key) → HTML de la carte courante (ou du bilan) ; R.srs.stats(key) ; R.srs.end(key) (termine, appelle onDone)
     R.srs.active(key) → bool ; R.srs.keydown(e, el) → bool (Entrée, Espace, 1-4 ; à appeler depuis le keydown d'une vue
       qui consommerait ces touches — sinon le module les reçoit seul par R.key)
     stats = { key, total, reviewed, remaining, again, hard, good, easy, correct, accuracy, fresh, ms, minutes, done, empty, startedAt }
   FSRS pur : R.srs.fsrs = { W, retrievability(tDays, S), interval(S, r), initStability(g), initDifficulty(g), nextDifficulty(D, g),
     recall(D, S, R, g), forget(D, S, R), shortTerm(S, g), schedule(fsrs, now, retention, seed) → [_, r1, r2, r3, r4], dayIndex(ms) }
     ri = { fsrs (état suivant), ivl (jours, 0 si la carte reste en apprentissage), requeue (bool) }
   Une carte ratée revient dans la séance après 3 à 5 autres ; une carte nouvelle jugée difficile, après 5 à 7.
   Notation automatique (pedagogie §1.1) : faux → Raté ; juste avec indice, faute de frappe ou réponse lente → Difficile ;
   juste → Bien ; « Facile » seulement sur action explicite (touche 4).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R) return;
  var esc = R.esc;

  var DAY = 86400000, ROLLOVER = 4 * 3600000;   /* une « journée » de révisions bascule à 4 h du matin */
  var DAILY_NEW = 20, LEECH_LAPSES = 6, MATURE_DAYS = 21;

  /* ══ FSRS-6 (py-fsrs, paramètres par défaut) ════════════════════════════ */

  var W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
    1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
  var DECAY = -W[20], FACTOR = Math.pow(0.9, 1 / DECAY) - 1;
  var STEP_AGAIN = 60000, STEP_HARD = 5 * 60000, RELEARN = 10 * 60000, MAX_IVL = 36500;

  function clampD(d) { return Math.min(10, Math.max(1, d)); }
  function retrievability(t, S) { return S > 0 ? Math.pow(1 + FACTOR * Math.max(0, t) / S, DECAY) : 0; }
  function initStability(g) { return Math.max(W[g - 1], 0.001); }
  function d0Raw(g) { return W[4] - Math.exp(W[5] * (g - 1)) + 1; }
  function initDifficulty(g) { return clampD(d0Raw(g)); }
  function nextDifficulty(D, g) {
    var mid = D + (-W[6] * (g - 3)) * (10 - D) / 9;
    return clampD(W[7] * d0Raw(4) + (1 - W[7]) * mid);
  }
  function recall(D, S, Rv, g) {
    var hp = g === 2 ? W[15] : 1, eb = g === 4 ? W[16] : 1;
    return S * (1 + Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9]) * (Math.exp((1 - Rv) * W[10]) - 1) * hp * eb);
  }
  function forget(D, S, Rv) {
    var long = W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1) * Math.exp((1 - Rv) * W[14]);
    return Math.min(long, S / Math.exp(W[17] * W[18]));
  }
  function shortTerm(S, g) {
    var inc = Math.exp(W[17] * (g - 3 + W[18])) * Math.pow(S, -W[19]);
    if (g >= 2) inc = Math.max(inc, 1);
    return S * inc;
  }
  function interval(S, r) {
    r = r || 0.9;
    return Math.min(Math.max(Math.round(S / FACTOR * (Math.pow(r, 1 / DECAY) - 1)), 1), MAX_IVL);
  }
  /* Dispersion (py-fsrs) : aucune sous 2,5 j, ±15 % de 2,5 à 7 j, ±10 % de 7 à 20 j, ±5 % au-delà. Tirage stable par carte. */
  function fuzz(ivl, seed) {
    if (ivl < 2.5) return ivl;
    var delta = 1 + 0.15 * Math.max(Math.min(ivl, 7) - 2.5, 0) + 0.1 * Math.max(Math.min(ivl, 20) - 7, 0) + 0.05 * Math.max(ivl - 20, 0);
    var lo = Math.max(2, Math.round(ivl - delta)), hi = Math.min(Math.round(ivl + delta), MAX_IVL);
    if (lo > hi) lo = hi;
    return lo + Math.floor(seed * (hi - lo + 1));
  }
  function hash01(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
  }
  /* Jours calendaires (bascule à 4 h) : réviser la veille au soir puis le matin compte pour un jour. */
  function dayIndex(ms) { var d = new Date(ms - ROLLOVER); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); }
  function dayStart(idx) { var d = new Date(idx * DAY); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime() + ROLLOVER; }

  /* Une note sur un état FSRS : l'état suivant, sans l'échéance des réussites (fixée par schedule). */
  function stepState(f, g, now) {
    var isNew = !f || f.state === 'new' || !(f.S > 0);
    var n = { state: 'review', S: 0, D: 0, due: now, last: now, reps: ((f && f.reps) || 0) + 1, lapses: (f && f.lapses) || 0, step: 0 };
    if (isNew) { n.S = initStability(g); n.D = initDifficulty(g); }
    else {
      var t = dayIndex(now) - dayIndex(f.last || now);
      if (t < 1) n.S = shortTerm(f.S, g);
      else { var rv = retrievability(t, f.S); n.S = g === 1 ? forget(f.D, f.S, rv) : recall(f.D, f.S, rv, g); }
      n.D = nextDifficulty(f.D, g);
    }
    n.S = Math.max(n.S, 0.001);
    var learning = isNew || f.state === 'learning' || f.state === 'relearning';
    if (g === 1) {
      n.state = learning && (isNew || f.state === 'learning') ? 'learning' : 'relearning';
      if (!learning) n.lapses++;
      n.due = now + (n.state === 'relearning' ? RELEARN : STEP_AGAIN);
      return { fsrs: n, ivl: 0, requeue: true };
    }
    if (g === 2 && learning) {
      n.state = isNew ? 'learning' : f.state;
      n.due = now + STEP_HARD;
      return { fsrs: n, ivl: 0, requeue: true };
    }
    return { fsrs: n, ivl: -1, requeue: false };
  }

  /* Les quatre issues d'une révision, avec Difficile ≤ Bien < Facile pour les intervalles (comme Anki et py-fsrs). */
  function schedule(f, now, retention, seed) {
    var r = R.clamp(Number(retention) || 0.9, 0.7, 0.99);
    var out = [null];
    for (var g = 1; g <= 4; g++) out.push(stepState(f, g, now));
    var iv = [0, 0, 0, 0, 0];
    for (g = 2; g <= 4; g++) if (out[g].ivl < 0) iv[g] = fuzz(interval(out[g].fsrs.S, r), seed == null ? 0.5 : seed);
    if (out[2].ivl < 0 && out[3].ivl < 0) { iv[2] = Math.min(iv[2], iv[3]); iv[3] = Math.max(iv[3], iv[2] + 1); }
    if (out[3].ivl < 0 && out[4].ivl < 0) iv[4] = Math.max(iv[4], iv[3] + 1);
    for (g = 2; g <= 4; g++) {
      if (out[g].ivl < 0) { out[g].ivl = iv[g]; out[g].fsrs.due = dayStart(dayIndex(now) + iv[g]); }
    }
    return out;
  }

  /* ══ Magasin des cartes ═════════════════════════════════════════════════ */

  var KINDS = ['word', 'collocation', 'phrase', 'false_friend', 'grammar', 'pronunciation', 'error'];
  var KIND_LABELS = { word: 'Mot', collocation: 'Collocation', phrase: 'Tournure', false_friend: 'Faux ami', grammar: 'Grammaire', pronunciation: 'Prononciation', error: 'Erreur' };
  var ORIGINS = ['lesson', 'exercise', 'grade', 'tutor', 'test', 'manual'];
  var ORIGIN_LABELS = { lesson: 'Cours', exercise: 'Exercice', grade: 'Correction', tutor: 'Tuteur', test: 'Bilan', manual: 'Ajout manuel' };
  var STATE_LABELS = { 'new': 'Nouvelle', learning: 'En apprentissage', review: 'En révision', relearning: 'À réapprendre' };

  function list() { return R.data.cards; }
  function str(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 400); }
  function key(front) {
    var s = String(front || '');
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* navigateur ancien */ }
    return R.text.norm(s);
  }
  function byId(id) { var l = list(); for (var i = 0; i < l.length; i++) if (l[i] && l[i].id === id) return l[i]; return null; }
  function freshFsrs(now) { return { state: 'new', S: 0, D: 0, due: now, last: 0, reps: 0, lapses: 0, step: 0 }; }

  function add(spec, origin) {
    if (!spec) return null;
    var front = str(spec.front, 300);
    var k = key(front);
    if (!k) return null;
    var l = list();
    for (var i = 0; i < l.length; i++) if (l[i] && key(l[i].front) === k) return null;
    var now = Date.now();
    var o = origin || {};
    var ok = String(o.kind || o.source || '');
    if (ok === 'sw' || ok === 'toeic') ok = 'test';
    var c = {
      id: R.uid('c'), kind: KINDS.indexOf(spec.kind) >= 0 ? spec.kind : 'phrase',
      front: front, back: str(spec.back, 400), example: str(spec.example, 300), audioText: str(spec.audioText, 300),
      note: str(spec.note || spec.explanationFr, 300),
      accepted: (Array.isArray(spec.accepted) ? spec.accepted : []).map(function (a) { return str(a, 200); }).filter(Boolean).slice(0, 8),
      origin: { kind: ORIGINS.indexOf(ok) >= 0 ? ok : 'manual', ref: str(o.ref, 80) },
      createdAt: now, suspended: false, leech: false, fsrs: freshFsrs(now)
    };
    l.push(c);
    R.save();
    if (fuzzy(c)) scheduleFix();
    return c;
  }
  function addMany(arr, origin) {
    var n = 0;
    (Array.isArray(arr) ? arr : []).forEach(function (s) { if (add(s, origin)) n++; });
    return n;
  }
  function remove(id) {
    var l = list();
    for (var i = 0; i < l.length; i++) if (l[i] && l[i].id === id) { l.splice(i, 1); R.save(); return true; }
    return false;
  }
  function suspend(id, on) {
    var c = byId(id);
    if (!c) return null;
    c.suspended = !!on;
    if (!on) c.leech = false;
    R.save();
    return c;
  }
  function rNow(c, now) {
    var f = c && c.fsrs;
    if (!f || f.state === 'new' || !(f.S > 0)) return 0;
    return retrievability(Math.max(0, (now - (f.last || now)) / DAY), f.S);
  }
  function isDue(c, now) { return c && !c.suspended && c.fsrs && c.fsrs.state !== 'new' && c.fsrs.due <= now; }
  function due(now) {
    now = now || Date.now();
    return list().filter(function (c) { return isDue(c, now); })
      .sort(function (a, b) { return rNow(a, now) - rNow(b, now) || a.fsrs.due - b.fsrs.due; });
  }
  function dueCount(now) { now = now || Date.now(); var n = 0; list().forEach(function (c) { if (isDue(c, now)) n++; }); return n; }
  function counts(now) {
    now = now || Date.now();
    var o = { total: 0, due: 0, fresh: 0, learning: 0, review: 0, suspended: 0, mature: 0, leeches: 0 };
    list().forEach(function (c) {
      if (!c || !c.fsrs) return;
      o.total++;
      if (c.leech) o.leeches++;
      if (c.suspended) { o.suspended++; return; }
      var s = c.fsrs.state;
      if (s === 'new') o.fresh++; else if (s === 'review') o.review++; else o.learning++;
      if (s !== 'new' && c.fsrs.S >= MATURE_DAYS) o.mature++;
      if (isDue(c, now)) o.due++;
    });
    return o;
  }
  /* Rétention réelle : part des révisions réussies (Difficile, Bien, Facile) parmi celles faites au moins un jour après
     la précédente — de vrais tests de mémoire, pas les reprises de la séance. */
  function retention(days, now) {
    now = now || Date.now();
    var log = R.data.reviewLog, since = now - days * DAY, last = {}, ok = 0, n = 0;
    for (var i = 0; i < log.length; i++) {
      var e = log[i];
      if (!e) continue;
      var prev = last[e.c];
      if (e.at >= since && prev != null && dayIndex(e.at) - dayIndex(prev) >= 1) { n++; if (e.g >= 2) ok++; }
      last[e.c] = e.at;
    }
    return { rate: n ? ok / n : null, n: n };
  }
  function stats(now) {
    now = now || Date.now();
    var o = counts(now);
    var ret = retention(30, now);
    o.retention30 = ret.rate; o.reviews30 = ret.n;
    var next = 0, nextN = 0;
    list().forEach(function (c) {
      if (!c || c.suspended || !c.fsrs || c.fsrs.state === 'new' || c.fsrs.due <= now) return;
      var d = dayIndex(c.fsrs.due);
      if (!next || d < next) { next = d; nextN = 1; } else if (d === next) nextN++;
    });
    o.nextDue = next ? dayStart(next) : 0; o.nextDueCount = nextN;
    return o;
  }
  /* Une correction (spec §5.6) : les erreurs deviennent des cartes de production (règle 6 de pedagogie §9.1). */
  function fromEdits(edits, max) {
    return (Array.isArray(edits) ? edits : []).filter(function (e) { return e && e.type !== 'improvement' && e.original && e.correction && key(e.original) !== key(e.correction); })
      .sort(function (a, b) { return (a.priority || 2) - (b.priority || 2); })
      .slice(0, max || 3)
      .map(function (e) { return { kind: 'error', front: e.original, back: e.correction, example: '', note: e.explanationFr || '' }; });
  }

  R.cards = {
    add: add, addMany: addMany, due: due, dueCount: dueCount, count: function () { return list().length; }, counts: counts,
    byId: byId, remove: remove, suspend: suspend, has: function (front) { var k = key(front); return !!k && list().some(function (c) { return c && key(c.front) === k; }); },
    all: list, stats: stats, fromEdits: fromEdits, retrievability: rNow, KINDS: KINDS, KIND_LABELS: KIND_LABELS, ORIGIN_LABELS: ORIGIN_LABELS, STATE_LABELS: STATE_LABELS,
    normKey: key
  };

  /* ══ Ce qu'on demande sur une carte ════════════════════════════════════
     Les cartes des cours sont des paires question → réponse écrites par l'agent : recto anglais et verso français
     (reconnaissance), recto français ou phrase à trou (production : on tape la réponse), ou erreur à corriger. */

  var FR_WORDS = /(^|[^a-zà-ÿ])(le|la|les|un|une|des|du|de|est|et|en|pour|avec|dans|qui|que|quoi|pas|au|aux|sur|ce|cette|ces|il|elle|ils|elles|nous|vous|je|tu|son|sa|ses|mon|ma|mes|comment|faux|ami|depuis|très|où|mais|donc|car|dit)(?=$|[^a-zà-ÿ])/gi;
  var EN_WORDS = /(^|[^a-z])(the|an|to|is|are|of|and|in|for|with|it|this|that|be|have|has|was|were|you|he|she|we|they|i|my|your|not|do|does|did|will|would|can|at|by|from)(?=$|[^a-z])/gi;
  function isFrench(s) {
    s = String(s || '');
    if (/[àâçéèêëîïôûùüÿœæ«»≠]/i.test(s)) return true;
    var fr = (s.match(FR_WORDS) || []).length, en = (s.match(EN_WORDS) || []).length;
    return fr > en;
  }
  function hasGap(s) { return /_{2,}/.test(String(s || '')); }
  function clean(s) {
    return String(s || '').replace(/\([^)]*\)/g, ' ').replace(/[«»"“”]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '');
  }
  function stripLead(s) { return String(s || '').replace(/^\s*(to be|to|an|a|the)\s+/i, ''); }
  function uniq(arr) {
    var seen = {}, out = [];
    arr.forEach(function (a) { var k = R.text.normLoose(a); if (a && k && !seen[k]) { seen[k] = 1; out.push(a); } });
    return out;
  }
  /* Phrase à trou : les mots du verso absents du recto sont ce qu'il fallait écrire (« to draw ___ » / « to draw on » → « on »). */
  function gapFill(front, back) {
    var fw = R.text.normLoose(clean(front).replace(/_{2,}/g, ' ')).split(' ').filter(Boolean);
    var pool = {};
    fw.forEach(function (w) { pool[w] = (pool[w] || 0) + 1; });
    var out = [];
    R.text.normLoose(back).split(' ').forEach(function (w) {
      if (!w) return;
      if (pool[w]) pool[w]--; else out.push(w);
    });
    return out.join(' ');
  }
  function answersOf(text, extra) {
    var base = clean(text);
    var alts = base.split(/\s+;\s+/).filter(Boolean);
    var list = [];
    alts.forEach(function (a) { list.push(a); var s = stripLead(a); if (s !== a) list.push(s); });
    return uniq(list.concat(extra || []));
  }
  function blankIn(example, word) {
    var w = stripLead(clean(word));
    if (!example || !w || w.length < 2) return '';
    var re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\w*', 'i');
    return re.test(example) ? example.replace(re, '___') : '';
  }

  function cardView(c) {
    var f = c.fsrs || {};
    var v = { mode: 'reveal', instruction: '', prompt: c.front, context: c.example, answers: [], prefill: '', englishFront: !isFrench(clean(c.front)) && !hasGap(c.front) };
    var backFr = isFrench(clean(c.back));
    if (c.kind === 'error') {
      v.mode = 'type'; v.instruction = 'Corrigez la phrase';
      v.prefill = c.front; v.context = '';
      v.answers = answersOf(c.back, c.accepted);
    } else if (c.kind === 'pronunciation') {
      v.instruction = 'Dites-le à voix haute, puis vérifiez';
    } else if (hasGap(c.front)) {
      v.mode = 'type'; v.instruction = 'Complétez';
      var fill = gapFill(c.front, clean(c.back));
      v.answers = answersOf(c.back, (fill ? [fill] : []).concat(c.accepted || []));
      v.context = '';
    } else if (isFrench(clean(c.front)) && !backFr) {
      v.mode = 'type'; v.instruction = 'En anglais';
      v.answers = answersOf(c.back, c.accepted);
      v.context = '';
    } else if (v.englishFront && backFr && f.state === 'review' && f.S >= 7) {
      /* Reconnaissance stable : on passe à la production (pedagogie §1.1). */
      v.mode = 'type'; v.instruction = 'Retrouvez l’anglais'; v.reverse = true;
      v.prompt = c.back;
      v.context = blankIn(c.example, c.front);
      v.answers = answersOf(c.front, c.accepted);
    } else {
      v.instruction = v.englishFront ? 'Que veut dire…' : '';
    }
    return v;
  }
  function audioOf(c) {
    if (c.audioText) return c.audioText;
    if (c.kind === 'pronunciation') return clean(c.front);
    if (c.example && !isFrench(c.example)) return c.example;
    if (!isFrench(c.front) && !hasGap(c.front)) return clean(c.front);
    if (!isFrench(c.back)) return clean(c.back);
    return '';
  }
  function hintOf(answer) {
    return String(answer || '').split(/\s+/).map(function (w) {
      var m = /^([^A-Za-z0-9]*)([A-Za-z0-9])(.*)$/.exec(w);
      if (!m) return w;
      return m[1] + m[2] + m[3].replace(/[A-Za-z0-9]/g, '·');
    }).join(' ');
  }

  /* ══ Cartes floues ══════════════════════════════════════════════════════
     Une carte se révise en tapant sa réponse, comparée à son verso. Beaucoup de versos écrits par les
     agents mêlent la réponse et son explication (« actually = en fait / vraiment. Actuellement =
     currently. »), collent deux réponses par une barre oblique, ou attendent deux trous (« is … old ») :
     on ne sait pas quoi taper, et une bonne réponse est refusée. Le correcteur (R.gen('cardfix'),
     haiku) les réécrit en tâche de fond, par lots, quand on ouvre les cartes ou commence des révisions,
     et peu après l'arrivée d'une carte floue : la question avec son indice, la réponse exacte, ses
     variantes acceptées, l'explication à part (note). La version d'origine est gardée (c.orig) et se
     rétablit depuis la vue Cartes ; une carte rétablie (c.fixKeep) ou déjà vue (c.fixedAt) n'est plus
     proposée. */
  var FUZZY_MARKS = /[=≠…]|\s[—–-]\s|\s\/\s|\.\s+\S/;
  var FIX_BATCH = 12;
  var FIX = { busy: false, failedAt: 0, timer: null, n: 0 };

  function fuzzy(c) {
    if (!c || c.suspended || c.fixedAt || c.fixKeep || c.kind === 'pronunciation') return false;
    var v = cardView(c);
    if (v.mode !== 'type' || v.reverse) return false;
    if (FUZZY_MARKS.test(clean(c.back))) return true;
    return c.kind !== 'error' && String(v.answers[0] || '').length > 40;
  }

  function scheduleFix(ms) {
    if (FIX.timer) clearTimeout(FIX.timer);
    FIX.timer = setTimeout(function () { FIX.timer = null; fixFuzzy(); }, ms == null ? 4000 : ms);
  }

  function fixFuzzy() {
    if (FIX.busy || !R.isLoaded() || Date.now() - FIX.failedAt < 30 * 60000) return;
    var todo = list().filter(fuzzy).slice(0, FIX_BATCH);
    if (!todo.length) return;
    FIX.busy = true;
    FIX.n = todo.length;
    R.gen('cardfix', {
      level: levelLabel(),
      cards: todo.map(function (c) { return { id: c.id, kind: c.kind, front: c.front, back: c.back, example: c.example || '', note: c.note || '', accepted: c.accepted || [] }; })
    }, { context: '' }).then(function (r) {
      var got = {};
      ((r && r.doc && r.doc.cards) || []).forEach(function (f) { if (f && f.id) got[f.id] = f; });
      var n = 0, now = Date.now();
      todo.forEach(function (t) {
        var c = byId(t.id);
        if (!c) return;
        c.fixedAt = now;  /* vue par le correcteur, réécrite ou rendue telle quelle */
        if (got[c.id] && applyFix(c, got[c.id])) n++;
      });
      FIX.busy = false;
      R.save();
      if (n) {
        R.toast(n + (n > 1 ? ' cartes floues réécrites' : ' carte floue réécrite') + ' par le correcteur : la réponse attendue est désormais claire.',
          { label: 'Voir', run: function () { U.state = 'fixed'; U.limit = 60; R.go('cards'); } });
      }
      R.renderSoon();
      if (list().some(fuzzy)) scheduleFix(1500);
    }, function () {
      /* Pas connecté, quota atteint, trois préparations en cours : on réessaiera plus tard. */
      FIX.busy = false;
      FIX.failedAt = Date.now();
      R.renderSoon();
    });
  }

  /* Applique une réécriture ; vrai si la question ou la réponse a changé. Les variantes acceptées
     s'ajoutent dans tous les cas : c'est ce qui rend une carte moins stricte. */
  function applyFix(c, f) {
    var front = str(f.front, 300), answer = str(f.answer, 300);
    if (!front || !answer) return false;
    if (key(front) !== key(c.front) && list().some(function (o) { return o && o !== c && key(o.front) === key(front); })) front = c.front;
    var extra = (Array.isArray(f.accepted) ? f.accepted : []).map(function (a) { return str(a, 200); }).filter(Boolean);
    var changed = front !== c.front || answer !== c.back;
    if (changed && !c.orig) c.orig = { front: c.front, back: c.back, note: c.note || '', example: c.example || '', accepted: (c.accepted || []).slice() };
    if (changed) {
      c.front = front;
      c.back = answer;
      if (str(f.note, 300)) c.note = str(f.note, 300);
      if (str(f.example, 300)) c.example = str(f.example, 300);
    }
    c.accepted = uniq((c.accepted || []).concat(extra)).filter(function (a) { return R.text.normLoose(a) !== R.text.normLoose(c.back); }).slice(0, 8);
    return changed;
  }

  function unfix(c) {
    if (!c || !c.orig) return false;
    c.front = c.orig.front; c.back = c.orig.back; c.note = c.orig.note; c.example = c.orig.example;
    c.accepted = (c.orig.accepted || []).slice();
    delete c.orig;
    c.fixKeep = true;
    R.save();
    return true;
  }

  /* ══ Séance de révision ═════════════════════════════════════════════════ */

  R.ui.srs = R.ui.srs || {};
  var RATE_LABELS = [null, 'Raté', 'Difficile', 'Bien', 'Facile'];

  function medianMs() {
    var log = R.data.reviewLog, v = [];
    for (var i = log.length - 1; i >= 0 && v.length < 200; i--) { var m = log[i] && log[i].ms; if (m > 300 && m < 120000) v.push(m); }
    if (v.length < 8) return 8000;
    v.sort(function (a, b) { return a - b; });
    return v[Math.floor(v.length / 2)];
  }
  function introducedToday(now) {
    var today = dayIndex(now), n = 0, todayCount = {};
    R.data.reviewLog.forEach(function (e) { if (e && dayIndex(e.at) === today) todayCount[e.c] = (todayCount[e.c] || 0) + 1; });
    list().forEach(function (c) { if (c && c.fsrs && c.fsrs.reps > 0 && todayCount[c.id] >= c.fsrs.reps) n++; });
    return n;
  }

  function newStats(st) {
    return { key: st.key, total: 0, reviewed: 0, remaining: 0, again: 0, hard: 0, good: 0, easy: 0, correct: 0, accuracy: null, fresh: 0, ms: 0, minutes: 0, done: false, empty: false, startedAt: st.startedAt };
  }
  function statsOf(st) {
    var s = Object.assign({}, st.stats);
    s.remaining = Math.max(0, st.queue.length - st.pos);
    s.total = st.queue.length;
    s.accuracy = s.reviewed ? s.correct / s.reviewed : null;
    s.minutes = Math.round((s.ms / 60000) * 10) / 10;
    s.done = st.done; s.empty = !!st.empty;
    return s;
  }

  function start(k, o) {
    o = o || {};
    var now = Date.now();
    var st = { key: k, opts: o, queue: [], pos: 0, startedAt: now, cur: null, done: false, empty: false, tries: {}, notified: false };
    st.stats = newStats(st);
    var dues = due(now).map(function (c) { return c.id; });
    var max = o.max > 0 ? Math.round(o.max) : 200;
    dues = dues.slice(0, max);
    var newMax = o.newMax == null ? 5 : Math.max(0, Math.round(o.newMax));
    var room = Math.max(0, Math.min(newMax, DAILY_NEW - introducedToday(now), max - dues.length));
    var fresh = list().filter(function (c) { return c && !c.suspended && c.fsrs && c.fsrs.state === 'new'; })
      .sort(function (a, b) { return a.createdAt - b.createdAt; }).slice(0, room).map(function (c) { return c.id; });
    st.queue = dues.concat(fresh);
    st.stats.fresh = fresh.length;
    R.ui.srs[k] = st;
    fixFuzzy();
    if (!st.queue.length) {
      st.done = true; st.empty = true;
      setTimeout(function () { finish(st); }, 0);
    } else prepare(st);
    return st;
  }

  function prepare(st) {
    while (st.pos < st.queue.length) {
      var c = byId(st.queue[st.pos]);
      if (c && !c.suspended) break;
      st.queue.splice(st.pos, 1);
    }
    if (st.pos >= st.queue.length) { st.cur = null; return false; }
    var card = byId(st.queue[st.pos]);
    var v = cardView(card);
    st.cur = { id: card.id, view: v, phase: 'q', value: v.prefill || '', shownAt: Date.now(), verdict: '', auto: 0, why: '', hint: false, ms: 0, n: (st.tries[card.id] || 0) };
    return true;
  }

  function finish(st) {
    st.done = true;
    st.cur = null;
    if (st.notified) return;
    st.notified = true;
    var fn = st.opts && st.opts.onDone;
    if (fn) { try { fn(statsOf(st)); } catch (e) { if (window.console) console.error(e); } }
  }

  function check(st, giveUp) {
    var cur = st.cur;
    if (!cur || cur.phase !== 'q') return;
    var c = byId(cur.id);
    cur.ms = Math.min(Date.now() - cur.shownAt, 600000);
    if (cur.view.mode === 'reveal') {
      cur.phase = 'a'; cur.auto = 3; cur.verdict = 'reveal';
      return;
    }
    var v = 'wrong';
    if (!giveUp) {
      var ans = cur.view.answers;
      v = R.text.match(cur.value, ans[0], ans.slice(1));
      /* Corriger une erreur, c'est changer la phrase : la recopier telle quelle ne compte pas. */
      if (c.kind === 'error' && R.text.normLoose(cur.value) === R.text.normLoose(c.front)) v = 'wrong';
    }
    cur.verdict = giveUp ? 'dunno' : v;
    var expected = cur.view.answers[0] || '';
    var slowLimit = Math.max(2 * medianMs(), 10000) * (1 + 0.15 * Math.max(0, R.text.count(expected) - 2));
    var slow = cur.ms > slowLimit && cur.ms < 300000;
    cur.slow = slow;
    if (v === 'exact') {
      cur.auto = cur.hint || slow ? 2 : 3;
      cur.why = cur.hint ? 'Juste, avec l’indice' : (slow ? 'Juste, mais après un moment' : 'Juste');
    } else if (v === 'close') { cur.auto = 2; cur.why = 'Presque : une faute de frappe'; }
    else { cur.auto = 1; cur.why = giveUp ? 'À apprendre' : 'Pas tout à fait'; }
    cur.phase = 'a';
    if (!giveUp && v !== 'exact' && String(cur.value || '').trim()) askChecker(st, cur, c);
  }

  /* ── Le correcteur ──────────────────────────────────────────────────────
     La vérification locale compare au caractère près : un synonyme, une contraction, une variante
     britannique passent pour fausses. Une réponse tapée qu'elle refuse part donc, pendant qu'on lit
     le verso, chez un agent rapide (R.gen('cardcheck'), haiku) qui la juge comme un professeur —
     juste, presque ou fausse — et dit ce qu'il fallait taper et pourquoi. Juste, la note proposée
     remonte d'elle-même et la réponse rejoint les variantes acceptées de la carte. Si l'on a déjà
     validé la note proposée (Entrée) avant son retour, la révision est renotée après coup, tant que
     la carte n'a pas été revue entre-temps ; une note choisie soi-même (1 à 4) n'est pas touchée. */
  function levelLabel() { try { return R.globalBand ? R.globalBand() : 'B1'; } catch (e) { return 'B1'; } }

  function askChecker(st, cur, c) {
    if (!c) return;
    var v = cur.view;
    cur.review = { busy: true };
    R.gen('cardcheck', {
      level: levelLabel(),
      card: { kind: c.kind, front: c.front, back: c.back, example: c.example || '', note: c.note || '', accepted: c.accepted || [] },
      instruction: v.instruction || '', prompt: v.prompt || '', expected: (v.answers || []).slice(0, 6), answer: String(cur.value || '').slice(0, 300)
    }, { context: '' }).then(function (r) {
      var d = (r && r.doc) || {};
      var verdict = d.verdict === 'right' || d.verdict === 'close' ? d.verdict : 'wrong';
      cur.review = { verdict: verdict, expected: String(d.expected || ''), why: String(d.explanationFr || '') };
      var card = byId(cur.id);
      if (card && d.accept && verdict === 'right') addAccepted(card, cur.value);
      var g = verdict === 'right' ? (cur.hint || cur.slow ? 2 : 3) : (verdict === 'close' ? 2 : 1);
      if (st.cur === cur && cur.phase === 'a') {
        if (g > cur.auto) {
          cur.auto = g;
          cur.verdict = verdict === 'right' ? 'exact' : 'close';
          cur.why = verdict === 'right' ? 'Juste, d’après le correcteur' : 'Presque, d’après le correcteur';
        }
      } else if (cur.rated && cur.rated.auto && g > cur.rated.g) {
        regrade(st, cur, g);
      }
      R.render();
    }, function () {
      /* Correcteur indisponible (pas connecté, quota, trois préparations en cours) : le verdict local reste. */
      cur.review = null;
      if (st.cur === cur) R.render();
    });
  }

  function addAccepted(c, value) {
    var v = str(value, 200);
    if (!v) return;
    c.accepted = Array.isArray(c.accepted) ? c.accepted : [];
    if (c.accepted.some(function (a) { return R.text.normLoose(a) === R.text.normLoose(v); })) return;
    c.accepted.push(v);
    if (c.accepted.length > 8) c.accepted.shift();
    R.save();
  }

  /* Renote une révision validée avant le retour du correcteur : même état de départ, même instant,
     même dispersion, nouvelle note ; la reprise prévue dans la séance s'en va si elle n'a plus lieu d'être. */
  function regrade(st, cur, g) {
    var c = byId(cur.id), r = cur.rated;
    if (!c || !r || c.fsrs !== r.after) return;
    var res = schedule(r.before, r.at, R.prefs.retention, r.seed)[g];
    c.fsrs = res.fsrs;
    r.after = res.fsrs;
    var log = R.data.reviewLog[r.logIndex];
    if (log && log.c === c.id && log.at === r.at) log.g = g;
    var names = ['', 'again', 'hard', 'good', 'easy'];
    st.stats[names[r.g]]--;
    st.stats[names[g]]++;
    if (r.g < 2 && g >= 2) st.stats.correct++;
    if (r.requeued && !res.requeue) {
      var i = st.queue.indexOf(c.id, st.pos + 1);
      if (i >= 0) st.queue.splice(i, 1);
      r.requeued = false;
    }
    if (r.leeched) { c.suspended = false; c.leech = false; r.leeched = false; }
    r.g = g;
    R.save();
    R.toast('Le correcteur accepte « ' + str(cur.value, 60) + ' » : la carte est renotée « ' + RATE_LABELS[g] + ' ».');
  }

  function rate(st, g) {
    var cur = st.cur;
    if (!cur || cur.phase !== 'a') return;
    var auto = !(g >= 1 && g <= 4);
    g = auto ? cur.auto || 3 : g;
    var c = byId(cur.id);
    var now = Date.now();
    R.tts.stopAll();
    if (c) {
      var seed = hash01(c.id + ':' + ((c.fsrs && c.fsrs.reps) || 0));
      var before = c.fsrs;
      var res = schedule(c.fsrs, now, R.prefs.retention, seed)[g];
      var wasReview = c.fsrs.state === 'review';
      c.fsrs = res.fsrs;
      R.data.reviewLog.push({ c: c.id, g: g, at: now, ms: Math.round(cur.ms || 0) });
      /* De quoi renoter si le correcteur, encore au travail, accepte la réponse (voir regrade). */
      cur.rated = { g: g, auto: auto, at: now, before: before, after: res.fsrs, seed: seed, logIndex: R.data.reviewLog.length - 1, requeued: false, leeched: false };
      st.stats.reviewed++;
      st.stats.ms += Math.min(cur.ms || 0, 120000);
      st.stats[['', 'again', 'hard', 'good', 'easy'][g]]++;
      if (g >= 2) st.stats.correct++;
      if (wasReview && g === 1 && c.fsrs.lapses >= LEECH_LAPSES) {
        c.suspended = true; c.leech = true;
        cur.rated.leeched = true;
        R.toast('« ' + clean(c.front).slice(0, 60) + ' » résiste (' + c.fsrs.lapses + ' oublis) : carte mise de côté. Retravaillez-la depuis la vue Cartes.');
      } else if (res.requeue) {
        var n = st.tries[c.id] = (st.tries[c.id] || 0) + 1;
        if (n <= 3) {
          var gap = g === 1 ? 3 + Math.floor(Math.random() * 3) : 5 + Math.floor(Math.random() * 3);
          st.queue.splice(Math.min(st.pos + 1 + gap, st.queue.length), 0, c.id);
          cur.rated.requeued = true;
        }
      }
      R.save();
    }
    st.pos++;
    var o = st.opts || {};
    var over = o.minutes > 0 && Date.now() - st.startedAt >= o.minutes * 60000;
    if (over || !prepare(st)) finish(st);
  }

  function end(k) {
    var st = R.ui.srs[k];
    if (!st || st.done) return;
    finish(st);
  }

  /* ── Rendu du composant ── */
  function ivlLabel(r, now) {
    if (!r) return '';
    if (r.requeue) { var m = Math.round((r.fsrs.due - now) / 60000); return m < 2 ? '< 1 min' : m + ' min'; }
    return fmtDays(r.ivl);
  }
  function fmtDays(d) {
    d = Math.max(0, Number(d) || 0);
    if (d < 1) return '< 1 j';
    if (d < 31) return Math.round(d) + ' j';
    if (d < 365) { var mo = d / 30.4; return (mo < 10 ? (Math.round(mo * 10) / 10) : Math.round(mo)).toString().replace('.', ',') + ' mois'; }
    var y = d / 365; return (Math.round(y * 10) / 10).toString().replace('.', ',') + ' an' + (y >= 2 ? 's' : '');
  }
  function gapify(h) { return h.replace(/_{2,}/g, '<span class="rzx-blank" aria-label="trou"></span>'); }
  function accentOf(c) { return hash01(c.id) < 0.5 ? 'en-GB' : 'en-US'; }

  function html(k) {
    var st = R.ui.srs[k];
    if (!st) return '';
    if (st.done || !st.cur) return endHtml(st);
    var cur = st.cur, c = byId(cur.id);
    if (!c) return endHtml(st);
    var v = cur.view, a = cur.phase === 'a', now = Date.now();
    var total = st.queue.length;
    var h = ['<div class="rzx-srs" data-rzx-srs="' + esc(k) + '">'];
    h.push('<div class="rzx-srs-top"><span class="rzx-srs-count">Carte ' + Math.min(st.pos + 1, total) + ' / ' + total + '</span>'
      + R.h.progress(st.pos / Math.max(1, total), 'Avancement des révisions')
      + '<button type="button" class="btn btn-ghost rzx-srs-end" data-act="rz-srs-end" data-key="' + esc(k) + '" title="Terminer les révisions (Échap dans la vue Cartes)">Terminer</button></div>');
    var f = c.fsrs || {};
    h.push('<div class="rzx-srs-card is-' + v.mode + (a ? ' is-answer' : '') + '">');
    h.push('<div class="rzx-srs-meta"><span class="rzx-tag">' + esc(KIND_LABELS[c.kind] || c.kind) + '</span>'
      + '<span class="rzx-tag is-' + esc(f.state) + '">' + esc(STATE_LABELS[f.state] || '') + '</span>'
      + (cur.n ? '<span class="rzx-tag is-again">Encore une fois</span>' : '')
      + (v.instruction ? '<span class="rzx-srs-instr">' + esc(v.instruction) + '</span>' : '') + '</div>');
    var frontFr = isFrench(v.prompt);
    h.push('<div class="rzx-srs-front"' + (frontFr ? ' lang="fr"' : ' lang="en"') + '>' + gapify(esc(v.prompt)) + '</div>');
    if (v.context) h.push('<div class="rzx-srs-example" lang="en">' + gapify(esc(v.context)) + '</div>');
    var audio = audioOf(c);
    if (c.kind === 'pronunciation' && audio) {
      h.push('<div class="rzx-srs-audio">' + R.h.player('rzx-srs-' + k + '-' + c.id, { label: 'Écouter', small: true, speeds: false, source: playSource(k, c, audio) }) + '</div>');
    }
    if (v.mode === 'type') {
      var fk = 'rzx-srs-ans-' + k + '-' + c.id;
      var cls = a ? (cur.verdict === 'exact' ? ' is-right' : (cur.verdict === 'close' ? ' is-close' : ' is-wrong')) : '';
      h.push('<div class="rzx-srs-answer"><input class="input rzx-srs-input' + cls + '" type="text" data-role="rz-srs-answer" data-key="' + esc(k) + '"'
        + ' data-focus-key="' + esc(fk) + '" data-dict="off" autocomplete="off" spellcheck="false" lang="en" placeholder="' + esc(c.kind === 'error' ? 'Corrigez directement dans le champ…' : 'Votre réponse…') + '"'
        + ' value="' + esc(cur.value) + '"' + (a ? ' readonly' : '') + '>');
      if (!a) {
        h.push('<button type="button" class="btn btn-primary" data-act="rz-srs-check" data-key="' + esc(k) + '">Vérifier <span class="rz-kbd">Entrée</span></button></div>');
        h.push('<div class="rzx-srs-help">'
          + (cur.hint ? '<span class="rzx-srs-hint">Indice : <b lang="en">' + esc(hintOf(v.answers[0])) + '</b></span>' : '<button type="button" class="btn btn-ghost" data-act="rz-srs-hint" data-key="' + esc(k) + '">Un indice</button>')
          + '<button type="button" class="btn btn-ghost" data-act="rz-srs-dunno" data-key="' + esc(k) + '">Je ne sais pas</button></div>');
      } else h.push('</div>');
    } else if (!a) {
      h.push('<div class="rzx-srs-answer"><button type="button" class="btn btn-primary rz-big" data-act="rz-srs-reveal" data-key="' + esc(k) + '">Voir la réponse <span class="rz-kbd">Espace</span></button></div>');
    }
    if (a) {
      var tone = cur.verdict === 'reveal' ? 'is-neutral' : (cur.auto >= 3 ? 'is-right' : (cur.auto === 2 ? 'is-close' : 'is-wrong'));
      h.push('<div class="rzx-srs-back ' + tone + '">');
      if (cur.verdict !== 'reveal') h.push('<div class="rzx-srs-verdict">' + R.icon(cur.auto >= 2 ? 'check' : 'cross') + '<span>' + esc(cur.why) + '</span></div>');
      if (cur.review) h.push(checkHtml(cur.review));
      var shown = v.reverse ? c.front : c.back;
      h.push('<div class="rzx-srs-backtext"' + (isFrench(shown) ? ' lang="fr"' : ' lang="en"') + '>' + esc(shown) + '</div>');
      if (c.example && (v.mode === 'type' || v.context !== c.example)) h.push('<div class="rzx-srs-example" lang="en">' + esc(c.example) + '</div>');
      if (c.note) h.push('<div class="rzx-srs-note">' + esc(c.note) + '</div>');
      if (audio && c.kind !== 'pronunciation') h.push('<div class="rzx-srs-audio">' + R.h.player('rzx-srs-' + k + '-' + c.id, { label: 'Écouter', small: true, speeds: false, source: playSource(k, c, audio) }) + '</div>');
      h.push('</div>');
      var sch = schedule(c.fsrs, now, R.prefs.retention, hash01(c.id + ':' + ((c.fsrs && c.fsrs.reps) || 0)));
      h.push('<div class="rzx-srs-rates" role="group" aria-label="Votre note">');
      for (var g = 1; g <= 4; g++) {
        var auto = g === cur.auto;
        h.push('<button type="button" class="rzx-rate g' + g + (auto ? ' is-auto' : '') + '" data-act="rz-srs-rate" data-key="' + esc(k) + '" data-g="' + g + '"'
          + (auto ? ' aria-current="true" title="Note proposée — Entrée"' : '') + '>'
          + '<span class="rzx-rate-k">' + g + '</span><span class="rzx-rate-l">' + esc(RATE_LABELS[g]) + '</span><span class="rzx-rate-i">' + esc(ivlLabel(sch[g], now)) + '</span></button>');
      }
      h.push('</div>');
      h.push('<div class="rzx-srs-foot"><span>Entrée : « ' + esc(RATE_LABELS[cur.auto]) + ' »' + (cur.verdict === 'reveal' ? ' · 1 à 4 pour noter vous-même' : ' · 1 à 4 pour changer — « Facile » seulement si c’était évident') + '</span>'
        + '<button type="button" class="btn btn-ghost" data-act="rz-srs-bury" data-key="' + esc(k) + '" title="Suspendre cette carte : elle ne reviendra plus">Mettre de côté</button></div>');
    }
    h.push('</div></div>');
    return h.join('');
  }

  /* Ce que dit le correcteur, sous le verdict : il relit, puis son avis — et ce qu'il fallait taper. */
  function checkHtml(rv) {
    if (rv.busy) return '<div class="rzx-srs-check is-busy" role="status"><span class="rz-spin"></span><span>Le correcteur relit votre réponse…</span></div>';
    var head = rv.verdict === 'right' ? 'Le correcteur accepte votre réponse.' : (rv.verdict === 'close' ? 'Presque, pour le correcteur.' : 'Le correcteur confirme : pas tout à fait.');
    return '<div class="rzx-srs-check is-' + esc(rv.verdict) + '" role="status">' + R.icon('spark')
      + '<div><b>' + esc(head) + '</b>' + (rv.why ? ' ' + esc(rv.why) : '')
      + (rv.expected && rv.verdict !== 'right' ? '<div class="rzx-srs-check-exp">À taper : <b lang="en">' + esc(rv.expected) + '</b></div>' : '')
      + '</div></div>';
  }

  function playSource(k, c, text) {
    var pk = 'rzx-srs-' + k + '-' + c.id;
    return function () { return R.tts.say(text, { key: pk, accent: accentOf(c), gender: hash01(c.id + 'g') < 0.5 ? 'female' : 'male' }); };
  }

  function endHtml(st) {
    var s = statsOf(st);
    if (s.empty) {
      return '<div class="rzx-srs is-done" data-rzx-srs-done="' + esc(st.key) + '">' + R.h.empty('Aucune carte à revoir', 'Tout est à jour : les cartes reviendront au bon moment. Les cours, les exercices et les corrections en ajoutent de nouvelles.') + '</div>';
    }
    var pct = s.reviewed ? Math.round(s.correct / s.reviewed * 100) : 0;
    return '<div class="rzx-srs is-done" data-rzx-srs-done="' + esc(st.key) + '"><div class="rzx-srs-sum">'
      + '<div class="rzx-srs-sum-big">' + R.icon('check') + '<span>Révisions terminées</span></div>'
      + '<div class="rzx-srs-sum-row"><span><b>' + s.reviewed + '</b> révision' + (s.reviewed > 1 ? 's' : '') + '</span>'
      + '<span><b>' + pct + ' %</b> réussies</span>'
      + (s.fresh ? '<span><b>' + s.fresh + '</b> nouvelle' + (s.fresh > 1 ? 's' : '') + '</span>' : '')
      + '<span><b>' + esc(R.fmtDur(s.ms / 1000)) + '</b></span>'
      + (s.remaining ? '<span class="rz-muted">' + s.remaining + ' laissée' + (s.remaining > 1 ? 's' : '') + ' pour la prochaine fois</span>' : '') + '</div></div></div>';
  }

  function focusSoon(sel) {
    setTimeout(function () {
      var el = document.querySelector(sel);
      if (el && document.activeElement !== el) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
    }, 0);
  }
  function afterMove(st) {
    R.render();
    if (st.cur && st.cur.view.mode === 'type' && st.cur.phase === 'q') {
      focusSoon('[data-focus-key="rzx-srs-ans-' + st.key + '-' + st.cur.id + '"]');
    }
  }

  function keydown(e, el) {
    var host = document.querySelector('#page-host [data-rzx-srs]');
    if (!host) return false;
    var k = host.getAttribute('data-rzx-srs');
    var st = R.ui.srs[k];
    if (!st || !st.cur || st.done) return false;
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    var role = el && el.getAttribute ? el.getAttribute('data-role') : '';
    var editable = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    var mine = role === 'rz-srs-answer';
    if (editable && !mine) return false;
    if (el && el.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return false;
    var typing = mine && !el.readOnly;
    var cur = st.cur;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (cur.phase === 'q') { if (mine) cur.value = el.value; check(st); R.render(); if (cur.view.mode === 'type') focusSoon('[data-focus-key="rzx-srs-ans-' + k + '-' + cur.id + '"]'); }
      else { rate(st, 0); afterMove(st); }
      return true;
    }
    if (typing) return false;
    if ((e.key === ' ' || e.code === 'Space') && cur.phase === 'q' && cur.view.mode === 'reveal') { e.preventDefault(); check(st); R.render(); return true; }
    if (/^[1-4]$/.test(e.key) && cur.phase === 'a') { e.preventDefault(); rate(st, +e.key); afterMove(st); return true; }
    return false;
  }

  R.srs = {
    start: start, html: html, end: end, keydown: keydown,
    stats: function (k) { var st = R.ui.srs[k]; return st ? statsOf(st) : null; },
    active: function (k) { var st = R.ui.srs[k]; return !!(st && !st.done); },
    fsrs: {
      W: W, retrievability: retrievability, interval: interval, initStability: initStability, initDifficulty: initDifficulty,
      nextDifficulty: nextDifficulty, recall: recall, forget: forget, shortTerm: shortTerm, schedule: schedule, fuzz: fuzz,
      dayIndex: dayIndex, dayStart: dayStart, FACTOR: FACTOR
    },
    cardView: cardView, isFrench: isFrench, fmtDays: fmtDays, medianMs: medianMs,
    fuzzy: fuzzy, fixFuzzy: fixFuzzy, applyFix: applyFix, fixing: function () { return FIX.busy; }
  };

  R.act('rz-srs-check', function (el) {
    var st = R.ui.srs[el.getAttribute('data-key')];
    if (!st || !st.cur) return;
    var inp = document.querySelector('[data-focus-key="rzx-srs-ans-' + st.key + '-' + st.cur.id + '"]');
    if (inp) st.cur.value = inp.value;
    check(st); R.render();
  });
  R.act('rz-srs-reveal', function (el) { var st = R.ui.srs[el.getAttribute('data-key')]; if (st) { check(st); R.render(); } });
  R.act('rz-srs-dunno', function (el) { var st = R.ui.srs[el.getAttribute('data-key')]; if (st) { check(st, true); R.render(); } });
  R.act('rz-srs-hint', function (el) {
    var st = R.ui.srs[el.getAttribute('data-key')];
    if (!st || !st.cur) return;
    st.cur.hint = true; R.render();
    focusSoon('[data-focus-key="rzx-srs-ans-' + st.key + '-' + st.cur.id + '"]');
  });
  R.act('rz-srs-rate', function (el) { var st = R.ui.srs[el.getAttribute('data-key')]; if (st) { rate(st, +el.getAttribute('data-g')); afterMove(st); } });
  R.act('rz-srs-bury', function (el) {
    var st = R.ui.srs[el.getAttribute('data-key')];
    if (!st || !st.cur) return;
    suspend(st.cur.id, true);
    R.toast('Carte mise de côté : retrouvez-la dans Cartes › Suspendues.');
    st.pos++;
    if (!prepare(st)) finish(st);
    afterMove(st);
  });
  R.act('rz-srs-end', function (el) { end(el.getAttribute('data-key')); R.render(); });
  R.input('rz-srs-answer', function (el) {
    var st = R.ui.srs[el.getAttribute('data-key')];
    if (st && st.cur && st.cur.phase === 'q') st.cur.value = el.value.slice(0, 300);
  });
  R.key(function (e, el) { return R.viewId() === 'cards' ? false : keydown(e, el); });

  /* ══ Pastille, accueil ═════════════════════════════════════════════════ */

  R.badge(function () { var n = dueCount(Date.now()); return n ? String(n > 999 ? '999+' : n) : ''; });

  function estimate(nDue, nNew) {
    var s = nDue * Math.max(5, medianMs() / 1000 + 3) + nNew * 18;
    return Math.max(1, Math.round(s / 60));
  }
  function relDay(ms) {
    if (!ms) return '';
    var d = dayIndex(ms) - dayIndex(Date.now());
    if (d <= 0) return 'aujourd’hui';
    if (d === 1) return 'demain';
    if (d < 7) return 'dans ' + d + ' jours';
    return 'le ' + new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  }

  R.homeCard({ id: 'reviews', area: 'side', order: 20, html: function () {
    var s = stats(Date.now());
    var room = Math.max(0, Math.min(10, DAILY_NEW - introducedToday(Date.now()), s.fresh));
    var h = ['<section class="rz-card rzx-revcard">'];
    h.push('<div class="rz-card-head"><span class="rz-card-title">Révisions</span><span class="rz-card-meta">' + esc(s.total + ' carte' + (s.total > 1 ? 's' : '')) + '</span></div>');
    if (!s.total) {
      h.push('<p class="rzx-revcard-p">Aucune carte encore. Chaque cours, chaque exercice et chaque correction en proposent : les mots et les erreurs reviennent ensuite juste avant d’être oubliés.</p>');
      h.push('<div class="rz-row"><button type="button" class="btn btn-secondary" data-act="rz-go" data-view="cards">Ouvrir les cartes</button></div>');
    } else if (s.due) {
      h.push('<div class="rzx-revcard-big"><b>' + s.due + '</b><span>carte' + (s.due > 1 ? 's' : '') + ' à revoir<br><span class="rz-muted">≈ ' + estimate(s.due, 0) + ' min' + (room ? ' · ' + room + ' nouvelle' + (room > 1 ? 's' : '') : '') + '</span></span></div>');
      h.push('<button type="button" class="btn btn-primary rz-big rzx-revcard-go" data-act="rz-srs-go">' + R.icon('cards') + ' Réviser</button>');
    } else {
      h.push('<div class="rzx-revcard-ok">' + R.icon('check') + '<span>Rien à revoir pour l’instant.' + (s.nextDue ? ' Prochaine révision ' + esc(relDay(s.nextDue)) + ' (' + s.nextDueCount + ' carte' + (s.nextDueCount > 1 ? 's' : '') + ').' : '') + '</span></div>');
      if (room) h.push('<button type="button" class="btn btn-secondary" data-act="rz-srs-go">Découvrir ' + room + ' nouvelle' + (room > 1 ? 's' : '') + ' carte' + (room > 1 ? 's' : '') + '</button>');
    }
    if (s.total) h.push('<div class="rz-card-foot">' + esc(s.mature + ' mûre' + (s.mature > 1 ? 's' : '') + ' (stables 3 semaines ou plus)' + (s.retention30 != null ? ' · rétention réelle ' + Math.round(s.retention30 * 100) + ' % sur 30 jours' : '')) + '</div>');
    h.push('</section>');
    return h.join('');
  } });
  R.act('rz-srs-go', function () { R.go('cards', { review: 1 }); });

  /* ══ Vue Cartes ═════════════════════════════════════════════════════════ */

  var U = R.ui.cards = R.ui.cards || { q: '', kind: '', state: '', origin: '', limit: 60, form: { kind: 'word', front: '', back: '', example: '' }, delArm: '', sessionStart: 0 };

  function startReview() {
    U.sessionStart = Date.now();
    start('cards', { max: 150, minutes: 0, newMax: 10, onDone: function (s) {
      if (s.reviewed) R.logSession({ kind: 'review', title: 'Révisions', startedAt: U.sessionStart, endedAt: Date.now(), skillMinutes: { srs: Math.max(0.5, s.ms / 60000) }, score: s.accuracy });
      R.renderSoon();
    } });
  }

  function matchFilter(c, now) {
    if (U.kind && c.kind !== U.kind) return false;
    if (U.origin && (c.origin && c.origin.kind) !== U.origin) return false;
    if (U.state) {
      if (U.state === 'due') { if (!isDue(c, now)) return false; }
      else if (U.state === 'suspended') { if (!c.suspended) return false; }
      else if (U.state === 'leech') { if (!c.leech) return false; }
      else if (U.state === 'fixed') { if (!c.orig) return false; }
      else if (U.state === 'mature') { if (c.suspended || c.fsrs.state === 'new' || c.fsrs.S < MATURE_DAYS) return false; }
      else if (U.state === 'learning') { if (c.suspended || (c.fsrs.state !== 'learning' && c.fsrs.state !== 'relearning')) return false; }
      else if (c.suspended || c.fsrs.state !== U.state) return false;
    }
    if (U.q) {
      var q = key(U.q);
      if (q && (key(c.front + ' ' + c.back + ' ' + c.example).indexOf(q) < 0)) return false;
    }
    return true;
  }

  function dueLabel(c, now) {
    if (c.suspended) return c.leech ? 'sangsue, suspendue' : 'suspendue';
    var f = c.fsrs;
    if (f.state === 'new') return 'nouvelle';
    if (f.due <= now) {
      var late = dayIndex(now) - dayIndex(f.due);
      return late >= 1 ? 'en retard de ' + late + ' j' : 'à revoir';
    }
    var d = dayIndex(f.due) - dayIndex(now);
    if (d <= 0) { var m = Math.round((f.due - now) / 60000); return m < 60 ? 'dans ' + Math.max(1, m) + ' min' : 'aujourd’hui'; }
    if (d === 1) return 'demain';
    return 'dans ' + fmtDays(d);
  }

  function listInner() {
    var now = Date.now();
    var all = list().filter(function (c) { return c && c.fsrs && matchFilter(c, now); });
    all.sort(function (a, b) {
      var an = a.fsrs.state === 'new' || a.suspended, bn = b.fsrs.state === 'new' || b.suspended;
      if (an !== bn) return an ? 1 : -1;
      if (an) return b.createdAt - a.createdAt;
      return a.fsrs.due - b.fsrs.due;
    });
    if (!all.length) {
      return list().length ? R.h.empty('Aucune carte ne correspond', 'Changez la recherche ou les filtres.') : R.h.empty('Pas encore de carte', 'Les cours du jour, les exercices et les corrections en proposent. Vous pouvez aussi en ajouter une à la main, ci-dessus.');
    }
    var shown = all.slice(0, U.limit);
    var h = ['<div class="rzx-clist" role="table" aria-label="Cartes">'];
    h.push('<div class="rzx-crow is-head" role="row"><span>Recto · verso</span><span>Type</span><span>Échéance</span><span>Stabilité</span><span></span></div>');
    shown.forEach(function (c) {
      var f = c.fsrs;
      var arm = U.delArm === c.id;
      h.push('<div class="rzx-crow' + (c.suspended ? ' is-suspended' : '') + (isDue(c, now) ? ' is-due' : '') + '" role="row">'
        + '<span class="rzx-cfront"><b>' + esc(c.front) + '</b><span class="rzx-cback">' + esc(c.back)
          + (c.accepted && c.accepted.length ? '<span class="rzx-caccepted"> · aussi : ' + esc(c.accepted.join(', ')) + '</span>' : '') + '</span>'
          + (c.orig ? '<span class="rzx-cfixed" title="' + esc('Avant : « ' + c.orig.front + ' » → « ' + c.orig.back + ' »') + '">' + R.icon('spark') + ' clarifiée par le correcteur</span>' : '') + '</span>'
        + '<span class="rzx-cmeta"><span class="rzx-tag">' + esc(KIND_LABELS[c.kind] || c.kind) + '</span><span class="rzx-corigin">' + esc(ORIGIN_LABELS[c.origin && c.origin.kind] || '') + '</span></span>'
        + '<span class="rzx-cdue">' + esc(dueLabel(c, now)) + '</span>'
        + '<span class="rzx-cstab" title="' + esc(f.state === 'new' ? 'Pas encore revue' : 'Stabilité : intervalle pour lequel la probabilité de se souvenir vaut 90 % · difficulté ' + (Math.round(f.D * 10) / 10) + ' / 10 · ' + f.reps + ' révision(s), ' + f.lapses + ' oubli(s)') + '">' + esc(f.state === 'new' ? '—' : fmtDays(f.S)) + '</span>'
        + '<span class="rzx-cact">'
        + (c.orig ? '<button type="button" class="btn btn-ghost btn-small" data-act="rz-cards-unfix" data-id="' + esc(c.id) + '" title="Revenir à la carte telle qu’elle était avant le correcteur">Version d’origine</button>' : '')
        + (c.leech ? '<button type="button" class="btn btn-ghost btn-small" data-act="rz-cards-relearn" data-id="' + esc(c.id) + '" title="Remettre la carte à zéro et la réapprendre">Réapprendre</button>' : '')
        + '<button type="button" class="btn btn-ghost btn-small" data-act="rz-cards-suspend" data-id="' + esc(c.id) + '">' + (c.suspended ? 'Reprendre' : 'Suspendre') + '</button>'
        + '<button type="button" class="btn btn-ghost btn-small rz-danger" data-act="rz-cards-del" data-id="' + esc(c.id) + '">' + (arm ? 'Confirmer ?' : 'Supprimer') + '</button>'
        + '</span></div>');
    });
    h.push('</div>');
    if (all.length > shown.length) h.push('<div class="rzx-cmore"><button type="button" class="btn btn-secondary" data-act="rz-cards-more">Afficher ' + Math.min(100, all.length - shown.length) + ' de plus · ' + (all.length - shown.length) + ' restantes</button></div>');
    h.push('<div class="rzx-ccount rz-muted">' + all.length + ' carte' + (all.length > 1 ? 's' : '') + (all.length !== list().length ? ' sur ' + list().length : '') + '</div>');
    return h.join('');
  }

  function selectHtml(field, opts, cur, label) {
    return '<label class="rzx-csel"><span class="rzx-sr">' + esc(label) + '</span><select class="input" data-role="rz-cards-filter" data-field="' + field + '" data-focus-key="rzx-cards-f-' + field + '" aria-label="' + esc(label) + '">'
      + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
  }

  function statTile(v, label, hint) {
    return '<div class="rzx-stat"' + (hint ? ' title="' + esc(hint) + '"' : '') + '><b>' + esc(v) + '</b><span>' + esc(label) + '</span></div>';
  }

  function cardsView(enter) {
    var now = Date.now();
    var st = R.ui.srs.cards;
    var s = stats(now);
    var h = [];
    h.push('<div class="rzx-head"><div><div class="rz-kicker">' + R.icon('cards') + ' Révisions espacées · FSRS</div><h2 class="rz-section-title">Vos cartes</h2></div></div>');
    if (st && !st.done) {
      h.push('<section class="rz-card rzx-revpanel is-live">' + html('cards') + '</section>');
      return h.join('');
    }
    h.push('<div class="rzx-stats">'
      + statTile(String(s.total), 'cartes', s.suspended ? s.suspended + ' suspendue(s)' : '')
      + statTile(String(s.due), 'à revoir', '')
      + statTile(String(s.mature), 'mûres', 'Stabilité de 21 jours ou plus')
      + statTile(s.retention30 == null ? '—' : Math.round(s.retention30 * 100) + ' %', 'rétention réelle · 30 j', s.reviews30 ? s.reviews30 + ' révisions faites au moins un jour après la précédente' : 'Pas encore assez de révisions espacées')
      + '</div>');
    h.push('<div class="rzx-cgrid">');
    /* Réviser maintenant */
    h.push('<section class="rz-card rzx-revpanel">');
    if (st && st.done && !st.empty) h.push(html('cards'));
    var room = Math.max(0, Math.min(10, DAILY_NEW - introducedToday(now), s.fresh));
    h.push('<div class="rz-card-head"><span class="rz-card-title">Réviser maintenant</span><span class="rz-card-meta">rétention visée ' + Math.round(R.prefs.retention * 100) + ' %</span></div>');
    if (s.due || room) {
      h.push('<p class="rzx-revpanel-p">' + esc((s.due ? s.due + ' carte' + (s.due > 1 ? 's' : '') + ' à revoir' : 'Rien à revoir') + (room ? ', ' + room + ' nouvelle' + (room > 1 ? 's' : '') + ' à découvrir' : '') + ' · ≈ ' + estimate(s.due, room) + ' min.') + '</p>');
      h.push('<div class="rz-row"><button type="button" class="btn btn-primary rz-big" data-act="rz-cards-review">' + R.icon('cards') + ' ' + (s.due ? 'Réviser' : 'Découvrir les nouvelles') + '</button>'
        + '<span class="rz-muted rzx-keys-hint">Entrée valide, 1 à 4 notent, Échap termine.</span></div>');
    } else {
      h.push('<p class="rzx-revpanel-p">' + (s.total ? esc('Tout est à jour.' + (s.nextDue ? ' Prochaine révision ' + relDay(s.nextDue) + ' : ' + s.nextDueCount + ' carte' + (s.nextDueCount > 1 ? 's' : '') + '.' : '')) : 'Ajoutez une carte, ou faites un cours ou un exercice : les mots à retenir arrivent ici.') + '</p>');
    }
    if (s.leeches) {
      h.push('<div class="rz-callout is-accent rzx-leech">' + esc(s.leeches + ' carte' + (s.leeches > 1 ? 's résistent' : ' résiste') + ' (6 oublis ou plus) : mise' + (s.leeches > 1 ? 's' : '') + ' de côté. Une série d’exercices bâtie sur elles aide à les fixer autrement.')
        + '<div class="rz-row"><button type="button" class="btn btn-secondary" data-act="rz-cards-leech-ex">Travailler ces cartes en exercice</button>'
        + '<button type="button" class="btn btn-ghost" data-act="rz-cards-pick-leech">Les voir</button></div></div>');
    }
    if (FIX.busy) h.push('<div class="rzx-fixing" role="status"><span class="rz-spin"></span>Le correcteur clarifie ' + FIX.n + (FIX.n > 1 ? ' cartes floues' : ' carte floue') + ' : la réponse attendue, ses variantes, l’explication à part.</div>');
    h.push('<div class="rz-card-foot">Une carte revient juste avant d’être oubliée : l’intervalle grandit à chaque réussite. Une carte ratée revient dans la séance, après quelques autres. Une réponse refusée est relue par le correcteur, qui l’accepte si elle est juste.</div>');
    h.push('</section>');
    /* Ajouter une carte */
    var fm = U.form;
    h.push('<section class="rz-card rzx-addcard"><div class="rz-card-head"><span class="rz-card-title">Ajouter une carte</span></div>');
    h.push('<div class="rzx-addgrid">'
      + '<label class="rzx-field"><span>Type</span><select class="input" data-role="rz-cards-form" data-field="kind" data-focus-key="rzx-add-kind">'
      + KINDS.map(function (k) { return '<option value="' + k + '"' + (fm.kind === k ? ' selected' : '') + '>' + esc(KIND_LABELS[k]) + '</option>'; }).join('') + '</select></label>'
      + '<label class="rzx-field"><span>Recto · la question</span><input class="input" type="text" data-role="rz-cards-form" data-field="front" data-focus-key="rzx-add-front" maxlength="300" placeholder="to take a decision ? · un faux ami · I ___ here since 2021" value="' + esc(fm.front) + '"></label>'
      + '<label class="rzx-field"><span>Verso · la réponse</span><input class="input" type="text" data-role="rz-cards-form" data-field="back" data-focus-key="rzx-add-back" maxlength="400" placeholder="prendre une décision · to make a decision" value="' + esc(fm.back) + '"></label>'
      + '<label class="rzx-field"><span>Exemple en anglais</span><input class="input" type="text" data-role="rz-cards-form" data-field="example" data-focus-key="rzx-add-example" data-dict-lang="en" maxlength="300" placeholder="We need to make a decision by Friday." value="' + esc(fm.example) + '"></label>'
      + '</div>');
    h.push('<div class="rz-row"><button type="button" class="btn btn-secondary" data-act="rz-cards-add">Ajouter la carte</button><span class="rz-muted">Un recto français ou à trou se révise en écrivant la réponse ; un recto anglais, en la retrouvant de tête.</span></div>');
    h.push('</section>');
    h.push('</div>');
    /* Liste */
    h.push('<section class="rz-card rzx-cards"><div class="rz-card-head"><span class="rz-card-title">Toutes les cartes</span></div>');
    h.push('<div class="rzx-filters"><input class="input rzx-search" type="search" data-role="rz-cards-q" data-focus-key="rzx-cards-q" placeholder="Rechercher un mot, une traduction…" value="' + esc(U.q) + '" aria-label="Rechercher">'
      + selectHtml('kind', [['', 'Tous les types']].concat(KINDS.map(function (k) { return [k, KIND_LABELS[k]]; })), U.kind, 'Type')
      + selectHtml('state', [['', 'Tous les états'], ['due', 'À revoir'], ['new', 'Nouvelles'], ['learning', 'En apprentissage'], ['review', 'En révision'], ['mature', 'Mûres'], ['suspended', 'Suspendues'], ['leech', 'Sangsues'], ['fixed', 'Clarifiées par le correcteur']], U.state, 'État')
      + selectHtml('origin', [['', 'Toutes les origines']].concat(ORIGINS.map(function (o) { return [o, ORIGIN_LABELS[o]]; })), U.origin, 'Origine')
      + '</div>');
    h.push('<div data-rzx-cardlist data-rz-scroll="rzx-cardlist" class="rzx-clist-wrap">' + listInner() + '</div>');
    h.push('</section>');
    return h.join('');
  }

  R.view('cards', {
    label: 'Cartes', icon: 'cards', order: 60, title: 'Révisions espacées : vos cartes',
    badge: function () { var n = dueCount(Date.now()); return n ? String(n) : ''; },
    render: cardsView,
    onHide: function () { var st = R.ui.srs.cards; if (st && st.done) delete R.ui.srs.cards; },
    onShow: function (p) {
      if (p && p.review && !R.srs.active('cards')) startReview();
      fixFuzzy();
      if (R.srs.active('cards')) { var st = R.ui.srs.cards; if (st.cur && st.cur.view.mode === 'type') focusSoon('[data-focus-key="rzx-srs-ans-cards-' + st.cur.id + '"]'); }
    },
    keydown: function (e, el, role) {
      if (R.srs.active('cards')) {
        if (e.key === 'Escape') { e.preventDefault(); end('cards'); R.render(); return true; }
        return keydown(e, el);
      }
      if (role === 'rz-cards-form' && e.key === 'Enter' && el.tagName === 'INPUT') { e.preventDefault(); addFromForm(); return true; }
      return false;
    }
  });

  function addFromForm() {
    var fm = U.form;
    if (!str(fm.front)) { R.toast('Écrivez au moins le recto de la carte.'); return; }
    var c = add({ kind: fm.kind, front: fm.front, back: fm.back, example: fm.example }, { kind: 'manual', ref: '' });
    if (!c) { R.toast('Cette carte existe déjà.'); return; }
    U.form = { kind: fm.kind, front: '', back: '', example: '' };
    R.toast('Carte ajoutée : elle arrivera dans vos prochaines révisions.');
    R.render();
    focusSoon('[data-focus-key="rzx-add-front"]');
  }

  R.act('rz-cards-review', function () { startReview(); R.render(); var st = R.ui.srs.cards; if (st && st.cur && st.cur.view.mode === 'type') focusSoon('[data-focus-key="rzx-srs-ans-cards-' + st.cur.id + '"]'); });
  R.act('rz-cards-add', addFromForm);
  R.act('rz-cards-more', function () { U.limit += 100; R.render(); });
  R.act('rz-cards-suspend', function (el) { var c = byId(el.getAttribute('data-id')); if (c) { suspend(c.id, !c.suspended); R.render(); } });
  R.act('rz-cards-relearn', function (el) {
    var c = byId(el.getAttribute('data-id'));
    if (!c) return;
    c.fsrs = freshFsrs(Date.now()); c.suspended = false; c.leech = false;
    R.save(); R.toast('Carte remise à zéro : elle revient comme une nouvelle.'); R.render();
  });
  var delTimer = null;
  R.act('rz-cards-del', function (el) {
    var id = el.getAttribute('data-id');
    if (U.delArm !== id) {
      U.delArm = id; R.render();
      if (delTimer) clearTimeout(delTimer);
      delTimer = setTimeout(function () { U.delArm = ''; R.render(); }, 4000);
      return;
    }
    U.delArm = '';
    remove(id);
    R.render();
  });
  R.act('rz-cards-pick-leech', function () { U.state = 'leech'; R.render(); });
  R.act('rz-cards-unfix', function (el) {
    if (unfix(byId(el.getAttribute('data-id')))) { R.toast('Carte rétablie telle qu’elle était : le correcteur n’y touchera plus.'); R.render(); }
  });
  R.act('rz-cards-leech-ex', function () {
    var l = list().filter(function (c) { return c && c.leech; }).slice(0, 12);
    if (!l.length) return;
    var focus = 'Cartes qui résistent (à fixer autrement : contraste avec le français, nouveaux exemples) : ' + l.map(function (c) { return clean(c.front) + ' = ' + clean(c.back); }).join(' ; ');
    if (R.exercise && R.exercise.launch) R.exercise.launch({ skill: 'lang', type: 'lang.weak_points', minutes: 10, focus: focus.slice(0, 600) });
    else R.toast('Le module d’exercices n’est pas chargé.');
  });
  R.input('rz-cards-form', function (el) { U.form[el.getAttribute('data-field')] = el.value.slice(0, 400); });
  R.change('rz-cards-form', function (el) { U.form[el.getAttribute('data-field')] = el.value; });
  R.input('rz-cards-q', function (el) { U.q = el.value.slice(0, 80); U.limit = 60; R.patch('[data-rzx-cardlist]', listInner()); });
  R.change('rz-cards-filter', function (el) { U[el.getAttribute('data-field')] = el.value; U.limit = 60; R.render(); });

  /* ══ Simulations (navigateur, hors WebView2) ═══════════════════════════
     Le correcteur simulé accepte une réponse contenue dans le verso ; window.__fakeCardCheck impose
     son verdict. La réécriture simulée garde la première réponse du verso et range le reste en note. */
  function firstAnswer(back) { return clean(back).split(/\s[=≠—–-]\s|\s\/\s|\.\s+|;/)[0].replace(/[.…]+$/, '').trim(); }
  R.fixture('cardcheck', function (p) {
    if (window.__fakeCardCheck) return JSON.parse(JSON.stringify(window.__fakeCardCheck));
    var a = R.text.normLoose(p.answer || '');
    var ok = !!a && (p.expected || []).concat([p.card && p.card.back || '']).some(function (e) { return R.text.normLoose(e).indexOf(a) >= 0; });
    return { verdict: ok ? 'right' : 'wrong', expected: ok ? p.answer : firstAnswer((p.card && p.card.back) || ''),
      explanationFr: ok ? 'Votre réponse dit exactement ce que la carte demande.' : 'Ce n’est pas le mot que la carte fait travailler.', accept: ok };
  });
  R.fixture('cardfix', function (p) {
    return { cards: (p.cards || []).map(function (c) {
      var parts = clean(c.back).split(/\s\/\s/);
      return { id: c.id, front: c.front, answer: firstAnswer(c.back) || c.back, accepted: parts.slice(1).map(firstAnswer).filter(Boolean), note: c.back, example: c.example || '' };
    }) };
  });
})();
