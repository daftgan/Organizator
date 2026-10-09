/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — le cours du jour et le lecteur de séance (module U1b)

   Ce que le module ajoute au noyau (core.js) :
     • la carte principale de l'accueil (hero, order 10) : choisir la durée et le sujet, préparer le cours
       (R.gen('lesson')), suivre la préparation (étapes, titres du jour), le commencer, le reprendre, le bilan ;
     • la carte « Cours précédents » (main, order 50) ;
     • la vue « Séance » (R.view('session')) : la frise des étapes du plan, un minuteur doux, et une étape à la
       fois — échauffement (révisions espacées de srs.js, sinon questions à voix haute), lecture (gloses,
       écoute du texte, questions), écoute (deux écoutes, questions, script), audio authentique, vocabulaire,
       grammaire, écrit (correction, phrase à réécrire, cartes), oral (préparation, micro, Whisper, correction,
       phrase à redire, mots en shadowing), bilan (rappel, autoévaluation, cartes, trois sujets suivants).

   Données (learning.json, sujet « en ») :
     lessons[]  { id, day, minutes, title, rubric, tone, keywords, grammar, genre, level, status, createdAt, doneAt,
                  result: { score (0..1 | null), right, total, minutes, cards, self, skills: { read|listen|lang: [juste, total] },
                            write, speak (niveaux estimés) } }   (result : une fois le cours fait)
     active     { kind: 'lesson', id, step (nom de l'étape), startedAt, updatedAt,
                  data: { v: 1, steps: [{ step, minutes }], cur, far, t: { étape: secondes }, done: { étape: 'done'|'skipped' },
                          ans: { clé d'item: { v, r: 'exact'|'close'|'wrong' } }, listen: { phase 0..2, script },
                          write: { text, grade, gradedText, redo: { v, r } }, speak: { rec, grade, redo, pron },
                          review: { recall, self, next, custom }, added: { recto: 1 }, srsDone, cardsAdded } }
     nextTopic  { title, query, rubric, pitchFr, tone, at, usedBy? }   (usedBy : travail de préparation qui l'emploie)
     attempts[] { id, at, mode: 'write'|'speak', ref, task, response, url, metrics, grade }
   Clés d'items : read:<i> (comprehension), listen:<i> (listening.questions), voc:<b>:<i> (vocabulary), gr:<i> (grammar).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R || !R.view) return;
  var esc = R.esc;

  var U = R.ui.lesson = {
    minutes: null, topicMode: null, topicOpen: false, custom: '',
    error: null, cancelled: {}, menu: '', news: null, newsAt: 0, newsBusy: false,
    prepSrs: false, prepSrsDone: false, docWait: {}, docMissing: {},
    gloss: null, confirmQuit: false, drafts: {}, show: {}, grading: {}, gradeError: {},
    prepUntil: {}, srsStarted: {}, acc: 0, lastAct: Date.now(), forceIdle: false, prevAll: false, abandonArm: false
  };

  /* ══ Constantes ═════════════════════════════════════════════════════════ */

  var ORDER = ['warmup', 'reading', 'listening', 'authenticAudio', 'vocabulary', 'grammar', 'writing', 'speaking', 'review'];
  var STEPS = {
    warmup: { label: 'Échauffement', skill: 'srs', title: 'On se met en route' },
    reading: { label: 'Lecture', skill: 'read', title: 'Lisez l’article' },
    listening: { label: 'Écoute', skill: 'listen', title: 'Écoutez' },
    authenticAudio: { label: 'Audio authentique', skill: 'listen', title: 'En bonus : un vrai podcast' },
    vocabulary: { label: 'Vocabulaire', skill: 'lang', title: 'Les mots du jour' },
    grammar: { label: 'Grammaire', skill: 'lang', title: 'Un point de grammaire' },
    writing: { label: 'Écrit', skill: 'write', title: 'À vous d’écrire' },
    speaking: { label: 'Oral', skill: 'speak', title: 'À vous de parler' },
    review: { label: 'Bilan', skill: 'srs', title: 'Le bilan' }
  };
  var SKILL_ICON = { read: 'read', listen: 'ear', write: 'pen', speak: 'speak', lang: 'lang', srs: 'cards' };
  var RUBRICS = {
    france: 'France', uk: 'Royaume-Uni', europe: 'Europe', world: 'Monde', usa: 'États-Unis', tech: 'Tech', science: 'Science',
    environment: 'Environnement', health: 'Santé', economy: 'Économie', culture: 'Culture', sport: 'Sport', society: 'Société', lifestyle: 'Art de vivre'
  };
  var TONES = { light: 'léger', balanced: 'équilibré', serious: 'grave' };
  var GENRES = { email: 'e-mail', message: 'message', comment: 'commentaire', opinion: 'avis argumenté', summary: 'résumé', letter: 'lettre', review: 'critique', story: 'récit' };
  var QSKILL = { gist: 'Sens général', detail: 'Détail', inference: 'Inférence', vocabulary: 'Vocabulaire' };
  var QRANK = { gist: 0, detail: 1, inference: 2, vocabulary: 3 };
  var VOCKIND = { gap_fill: 'Phrases à trous', matching: 'Associations', collocations: 'Collocations', word_formation: 'Formation des mots',
    false_friends: 'Faux amis', translation: 'Traduction', error_correction: 'Correction d’erreurs' };
  var POS = { noun: 'nom', verb: 'verbe', adjective: 'adjectif', adverb: 'adverbe', 'phrasal verb': 'verbe à particule', idiom: 'expression', collocation: 'collocation', other: '' };
  var ACCENTS = { 'en-GB': 'britannique', 'en-US': 'américain', 'en-AU': 'australien', 'en-IE': 'irlandais', 'en-CA': 'canadien', 'en-IN': 'indien' };
  var SELF = { easy: 'Facile', ok: 'Juste comme il faut', hard: 'Difficile' };
  /* Aperçu du déroulé avant la préparation (gabarits de pedagogie.md §3.2 ; l'agent fixe le vrai plan). */
  var PREVIEW = {
    10: [['warmup', 2], ['reading', 3], ['listening', 2], ['vocabulary', 1], ['speaking', 1], ['review', 1]],
    20: [['warmup', 2], ['reading', 4], ['listening', 4], ['vocabulary', 3], ['grammar', 2], ['writing', 2], ['speaking', 2], ['review', 1]],
    30: [['warmup', 3], ['reading', 5], ['listening', 5], ['vocabulary', 4], ['grammar', 3], ['writing', 4], ['speaking', 4], ['review', 2]],
    45: [['warmup', 4], ['reading', 8], ['listening', 7], ['vocabulary', 6], ['grammar', 5], ['writing', 7], ['speaking', 6], ['review', 2]]
  };
  var PREP_EXPECT_S = 150;           /* durée typique d'une préparation (sources.md §6.2) */
  var IDLE_MS = 180000;              /* au-delà de 3 min sans geste, le minuteur ne compte plus */

  /* ══ Utilitaires ════════════════════════════════════════════════════════ */

  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function str(v) { return v == null ? '' : String(v); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function icon(n) { return R.icon(n); }
  function plural(n, one, many) { return n + ' ' + (n > 1 ? (many || one + 's') : one); }
  function clock(sec) { sec = Math.max(0, Math.floor(sec)); return Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60); }
  function pct(x) { return Math.round(clamp(num(x, 0), 0, 1) * 100) + ' %'; }
  function stepLabel(st) { return (STEPS[st] || {}).label || st; }
  function stepSkill(st) { return (STEPS[st] || {}).skill || 'lang'; }
  function skillIcon(sk) { return icon(SKILL_ICON[sk] || 'spark'); }
  function rubricLabel(r) { return RUBRICS[r] || str(r); }
  function nrm(s) { return R.text.norm(s); }
  function clampLevel(b) {
    var m = /^(A1|A2|B1|B2|C1|C2)(\+)?/.exec(String(b || '').toUpperCase());
    if (!m) return 'B1';
    if (m[1] === 'A1') return 'A2';
    if (m[1] === 'C2') return 'C1';
    return m[1] === 'A2' || m[1] === 'C1' ? m[1] : m[1] + (m[2] || '');
  }
  function fmtPublished(p) { return /^\d{4}-\d{2}-\d{2}/.test(str(p)) ? R.fmtDayShort(p) : str(p); }

  /* ══ Le cours : documents, liste, forme normalisée ═════════════════════ */

  function lessons() { return arr(R.data.lessons); }
  function entry(id) {
    var l = lessons();
    for (var i = l.length - 1; i >= 0; i--) if (l[i] && l[i].id === id) return l[i];
    return null;
  }
  function sorted() { return lessons().filter(Boolean).slice().sort(function (a, b) { return num(a.createdAt, 0) - num(b.createdAt, 0); }); }
  function todayEntry() {
    var t = R.today();
    var l = sorted().filter(function (x) { return x.day === t; });
    return l.length ? l[l.length - 1] : null;
  }
  function docOf(id) { return id ? R.docCached('lesson', id) : null; }
  function ensureDoc(id) {
    if (!id || docOf(id) || U.docWait[id] || U.docMissing[id]) return;
    U.docWait[id] = true;
    R.doc('lesson', id).then(function (d) {
      delete U.docWait[id];
      if (!d) U.docMissing[id] = true;
      R.renderSoon();
    }, function () { delete U.docWait[id]; U.docMissing[id] = true; R.renderSoon(); });
  }

  /* Le document tel que l'hôte le rend (spec §5.2), lu avec tolérance : tout champ manquant devient vide. */
  var SHAPES = Object.create(null);
  function shape(doc) {
    if (!doc) return null;
    var key = str(doc.id) + '|' + str(doc.createdAt);
    var c = SHAPES[key];
    if (c && c.src === doc) return c.v;
    var q = function (x) {
      x = obj(x) || {};
      var options = arr(x.options).map(str).filter(function (o) { return o.trim(); });
      var kind = options.length ? (x.kind === 'true_false' ? 'true_false' : 'choice') : 'open';
      return { kind: kind, skill: QRANK[x.skill] != null ? x.skill : 'detail', question: str(x.question), options: options, answer: str(x.answer), explanationFr: str(x.explanationFr) };
    };
    var rd = obj(doc.reading) || {}, ls = obj(doc.listening) || {}, au = obj(doc.authenticAudio) || {}, gr = obj(doc.grammar) || {};
    var wr = obj(doc.writing) || {}, sp = obj(doc.speaking) || {};
    var v = {
      id: str(doc.id), title: str(doc.title), summaryFr: str(doc.summaryFr), level: clampLevel(doc.level), minutes: Math.max(0, Math.round(num(doc.minutes, 0))),
      rubric: str(doc.rubric), tone: str(doc.tone), keywords: arr(doc.keywords).map(str),
      plan: arr(doc.plan).map(function (p) { p = obj(p) || {}; return { step: str(p.step), minutes: Math.max(0, Math.round(num(p.minutes, 0))) }; }),
      sources: arr(doc.sources).map(function (s) { s = obj(s) || {}; return { title: str(s.title), url: str(s.url), outlet: str(s.outlet), published: str(s.published) }; }),
      warmup: arr(doc.warmup).map(str).filter(function (s) { return s.trim(); }),
      reading: {
        headline: str(rd.headline), standfirst: str(rd.standfirst), credit: str(rd.credit),
        paragraphs: arr(rd.paragraphs).map(str).filter(function (s) { return s.trim(); }),
        glossary: arr(rd.glossary).map(function (g) { g = obj(g) || {}; return { term: str(g.term), pos: str(g.pos), ipa: str(g.ipa), meaningEn: str(g.meaningEn), meaningFr: str(g.meaningFr), example: str(g.example) }; })
          .filter(function (g) { return g.term.trim(); })
      },
      readingWords: num(doc.readingWords, num(rd.wordCount, 0)),
      comprehension: arr(doc.comprehension).map(q).filter(function (x) { return x.question.trim(); }),
      listening: {
        format: str(ls.format), title: str(ls.title), contextFr: str(ls.contextFr),
        speakers: arr(ls.speakers).map(function (s) { s = obj(s) || {}; return { id: str(s.id), name: str(s.name), role: str(s.role), accent: str(s.accent) || 'en-US', gender: s.gender === 'male' ? 'male' : 'female' }; }),
        lines: arr(ls.lines).map(function (l) { l = obj(l) || {}; return { speaker: str(l.speaker), text: str(l.text) }; }),
        questions: arr(ls.questions).map(q).filter(function (x) { return x.question.trim(); })
      },
      authenticAudio: { title: str(au.title), outlet: str(au.outlet), audioUrl: str(au.audioUrl), pageUrl: str(au.pageUrl), published: str(au.published), taskFr: str(au.taskFr), questions: arr(au.questions).map(str).filter(function (s) { return s.trim(); }) },
      vocabulary: arr(doc.vocabulary).map(function (b) {
        b = obj(b) || {};
        return { kind: str(b.kind), instructionFr: str(b.instructionFr), items: arr(b.items).map(function (it) {
          it = obj(it) || {};
          return { prompt: str(it.prompt), options: arr(it.options).map(str).filter(function (o) { return o.trim(); }), answer: str(it.answer), explanationFr: str(it.explanationFr) };
        }).filter(function (it) { return it.prompt.trim() && it.answer.trim(); }) };
      }).filter(function (b) { return b.items.length; }),
      grammar: { point: str(gr.point), explanationFr: str(gr.explanationFr), examples: arr(gr.examples).map(str).filter(function (s) { return s.trim(); }),
        items: arr(gr.items).map(function (it) { it = obj(it) || {}; return { prompt: str(it.prompt), answer: str(it.answer) }; }).filter(function (it) { return it.prompt.trim() && it.answer.trim(); }) },
      writing: { taskFr: str(wr.taskFr), genre: str(wr.genre), words: Math.max(0, Math.round(num(wr.words, 0))), language: arr(wr.language).map(str), criteria: arr(wr.criteria).map(str), modelAnswer: str(wr.modelAnswer) },
      speaking: { taskFr: str(sp.taskFr), prompts: arr(sp.prompts).map(str).filter(function (s) { return s.trim(); }), prepSeconds: Math.max(0, Math.round(num(sp.prepSeconds, 30))),
        speakSeconds: Math.max(15, Math.round(num(sp.speakSeconds, 60))), language: arr(sp.language).map(str), modelAnswer: str(sp.modelAnswer),
        pronunciation: arr(sp.pronunciation).map(function (p) { p = obj(p) || {}; return { word: str(p.word), ipa: str(p.ipa), tipFr: str(p.tipFr) }; }).filter(function (p) { return p.word.trim(); }) },
      cards: arr(doc.cards).map(function (c) { c = obj(c) || {}; return { kind: str(c.kind) || 'word', front: str(c.front), back: str(c.back), example: str(c.example) }; }).filter(function (c) { return c.front.trim() && c.back.trim(); }),
      nextTopics: arr(doc.nextTopics).map(function (t) { t = obj(t) || {}; return { title: str(t.title), pitchFr: str(t.pitchFr), rubric: str(t.rubric), tone: str(t.tone), query: str(t.query) }; }).filter(function (t) { return t.title.trim(); })
    };
    if (!v.readingWords) v.readingWords = R.text.count(v.reading.paragraphs.join(' '));
    SHAPES[key] = { src: doc, v: v };
    return v;
  }

  function has(step, L) {
    switch (step) {
      case 'warmup': return !!(L.warmup.length || srsOk());
      case 'reading': return L.reading.paragraphs.length > 0;
      case 'listening': return L.listening.lines.some(function (l) { return l.text.trim(); });
      case 'authenticAudio': return /^https?:\/\//i.test(L.authenticAudio.audioUrl);
      case 'vocabulary': return L.vocabulary.length > 0;
      case 'grammar': return L.grammar.items.length > 0 || !!L.grammar.explanationFr.trim();
      case 'writing': return !!L.writing.taskFr.trim();
      case 'speaking': return !!(L.speaking.taskFr.trim() || L.speaking.prompts.length);
      case 'review': return true;
    }
    return false;
  }

  /* Les étapes de la séance : le plan de l'agent, sans les étapes vides ; l'audio authentique (bonus) et le
     bilan sont ajoutés s'ils manquent au plan. */
  function buildSteps(L) {
    var out = [], seen = {};
    var plan = L.plan.length ? L.plan : ORDER.map(function (s) { return { step: s, minutes: 0 }; });
    plan.forEach(function (p) {
      if (!STEPS[p.step] || seen[p.step] || !has(p.step, L)) return;
      seen[p.step] = 1;
      out.push({ step: p.step, minutes: p.minutes });
    });
    if (!seen.authenticAudio && has('authenticAudio', L)) {
      var at = -1;
      out.forEach(function (s, i) { if (s.step === 'listening' || s.step === 'reading') at = i; });
      out.splice(at + 1, 0, { step: 'authenticAudio', minutes: 0 });
    }
    if (!seen.review) out.push({ step: 'review', minutes: 0 });
    return out;
  }
  function planMinutes(steps) { return steps.reduce(function (t, s) { return t + num(s.minutes, 0); }, 0); }

  /* ══ Révisions espacées et cartes (srs.js, module U1a) ═══════════════════ */

  function srsOk() { return !!(R.srs && typeof R.srs.start === 'function' && typeof R.srs.html === 'function'); }
  /* Nombre de cartes dues ; null quand srs.js ne sait pas le dire. */
  function dueCount() {
    var s = R.srs;
    if (!s) return 0;
    try {
      if (R.cards && typeof R.cards.dueCount === 'function') return Math.max(0, num(R.cards.dueCount(Date.now()), 0));
      if (typeof s.dueCount === 'function') return Math.max(0, num(s.dueCount(), 0));
      if (typeof s.due === 'function') { var d = s.due(); return Array.isArray(d) ? d.length : Math.max(0, num(d, 0)); }
      if (typeof s.count === 'function') { var c = s.count(); return Math.max(0, num(c && typeof c === 'object' ? c.due : c, 0)); }
    } catch (e) { return 0; }
    return null;
  }
  function cardsOk() { return !!(R.cards && typeof R.cards.add === 'function'); }
  function cardKindOf(cat) {
    cat = str(cat);
    if (cat === 'lex.false_friend') return 'false_friend';
    if (cat === 'lex.collocation') return 'collocation';
    if (cat.indexOf('pron.') === 0) return 'pronunciation';
    if (cat.indexOf('gram.') === 0) return 'grammar';
    return 'phrase';
  }
  function addCard(card, id) {
    var a = act();
    if (!cardsOk()) { R.toast('Les cartes de révision ne sont pas encore disponibles.'); return false; }
    var made = null;
    try { made = R.cards.add({ kind: card.kind, front: card.front, back: card.back, example: card.example || '', note: card.note || '' }, { kind: 'lesson', ref: id || (a && a.id) || '' }); }
    catch (e) { R.toast('Carte non ajoutée : ' + (e && e.message)); return false; }
    if (a) { var d = sd(a); d.added[card.front] = 1; if (made) d.cardsMore = num(d.cardsMore, 0) + 1; persist(); }
    if (!made) R.toast('Déjà dans vos cartes.');
    return true;
  }
  /* Une carte déjà ajoutée pendant cette séance, ou déjà connue de srs.js (même recto). */
  function isAdded(front, a) {
    if (a && sd(a).added[front]) return true;
    try { return !!(R.cards && typeof R.cards.has === 'function' && R.cards.has(front)); } catch (e) { return false; }
  }

  /* ══ Préparation ═══════════════════════════════════════════════════════ */

  function voices() {
    var e = R.tts.engine();
    if (e === 'kokoro') return ['en-US', 'en-GB'];
    var acc = { 'en-US': 1 };
    if (e === 'system') {
      R.tts.systemVoices().forEach(function (v) {
        var m = /^en[-_](US|GB|AU|CA|IE|IN)/i.exec(str(v.lang));
        if (m) acc['en-' + m[1].toUpperCase()] = 1;
      });
    }
    return Object.keys(acc).sort(function (a, b) { return a === 'en-US' ? -1 : (b === 'en-US' ? 1 : a < b ? -1 : 1); });
  }
  function readAccent() { return voices().indexOf('en-GB') >= 0 ? 'en-GB' : 'en-US'; }
  function avoidRubrics() {
    var out = [];
    sorted().slice(-2).forEach(function (l) { if (l.rubric && out.indexOf(l.rubric) < 0) out.push(l.rubric); });
    return out;
  }
  function topicMode() {
    if (U.topicMode === 'custom' && U.custom.trim()) return 'custom';
    if (U.topicMode === 'teacher') return 'teacher';
    return R.data.nextTopic && R.data.nextTopic.title ? 'next' : 'teacher';
  }
  function chosenTopic() {
    var m = topicMode();
    if (m === 'custom') { var t = U.custom.trim().slice(0, 160); return { title: t, query: t, rubric: '' }; }
    if (m === 'next') { var n = R.data.nextTopic; return { title: str(n.title), query: str(n.query || n.title), rubric: str(n.rubric) }; }
    return null;
  }

  function prepare(opts) {
    opts = opts || {};
    if (R.jobOf('lesson')) { R.go('home'); return; }
    var minutes = [10, 20, 30, 45].indexOf(+opts.minutes) >= 0 ? +opts.minutes : (U.minutes || R.profile.defaultMinutes || 20);
    var topic = opts.timeless || opts.anotherTopic ? null : chosenTopic();
    if (opts.topic !== undefined) topic = opts.topic;
    var params = {
      minutes: minutes, level: clampLevel(R.globalBand()), topic: topic, voices: voices(),
      avoidRubrics: avoidRubrics(), timeless: !!opts.timeless
    };
    var job = R.uid('rzlesson');
    U.error = null; U.menu = ''; U.forceIdle = false; U.lastParams = params;
    if (topic && topicMode() === 'next' && R.data.nextTopic) { R.data.nextTopic.usedBy = job; R.save(); }
    loadNews();
    if (opts.srs && srsOk()) {
      U.prepSrs = true; U.prepSrsDone = false;
      startPrepSrs();
    } else { U.prepSrs = false; U.prepSrsDone = false; }
    R.gen('lesson', params, { job: job })['catch'](function () { /* dit par jobDone */ });
    R.render();
  }

  /* Réviser pendant la préparation : une séance de révision à part entière (notée dans sessions). */
  function startPrepSrs() {
    var t0 = Date.now();
    try {
      R.srs.start('lesson-prep', { minutes: 4, max: 30, newMax: 0, onDone: function (st) {
        U.prepSrsDone = true;
        if (st && st.reviewed) R.logSession({ kind: 'review', title: 'Révisions pendant la préparation du cours', startedAt: t0, endedAt: Date.now(), skillMinutes: { srs: Math.max(0.5, num(st.ms, 0) / 60000) }, score: st.accuracy });
        R.renderSoon();
      } });
    } catch (e) { U.prepSrs = false; }
  }

  /* Un cours prêt (génération de cette page, ou travail réattaché après un rechargement) : intégré une fois. */
  function integrate(id, doc, job) {
    if (!id || !doc) return null;
    var e = entry(id);
    var L = shape(Object.assign({ id: id }, doc));
    if (!e) {
      e = {
        id: id, day: str(doc.day) || R.dayOf(num(doc.createdAt, Date.now())), minutes: L.minutes || planMinutes(L.plan), title: L.title, rubric: L.rubric, tone: L.tone,
        keywords: L.keywords.slice(0, 6), grammar: L.grammar.point, genre: L.writing.genre, level: L.level, status: 'ready',
        createdAt: num(doc.createdAt, Date.now()), doneAt: 0
      };
      R.data.lessons.push(e);
      var nt = R.data.nextTopic;
      if (nt && nt.usedBy && nt.usedBy === job) R.data.nextTopic = null;
      R.save();
      return e;
    }
    return null;
  }

  R.on('job', function (j) {
    if (!j || j.kind !== 'lesson') return;
    if (j.phase === 'menu' && j.text) U.menu = j.text;
    R.patch('[data-rzl-steps]', stepsInner(j));
  });

  R.on('jobDone', function (ev) {
    if (!ev || ev.kind !== 'lesson') return;
    var nt = R.data.nextTopic;
    if (ev.error) {
      if (nt && nt.usedBy === ev.job) { delete nt.usedBy; R.save(); }
      if (U.cancelled[ev.job]) { delete U.cancelled[ev.job]; R.toast('Préparation annulée.'); return; }
      U.error = { message: str(ev.error && ev.error.message) || 'erreur inconnue', params: ev.params && ev.params.minutes ? ev.params : U.lastParams || null, at: Date.now() };
      U.prepSrs = U.prepSrs && !U.prepSrsDone;
      if (R.viewId() !== 'home') R.toast('Le cours n’a pas pu être préparé : ' + U.error.message, { label: 'Voir', run: function () { R.go('home'); } });
      return;
    }
    var r = ev.result || {};
    var e = integrate(r.id, r.doc, ev.job);
    if (e && !ev.reattached) R.notify('Le cours du jour est prêt : « ' + e.title + ' ».', 'home');
    else if (e && ev.reattached) R.toast('Le cours du jour est prêt : « ' + e.title + ' ».');
  });

  function loadNews(force) {
    if (U.newsBusy || (!force && U.news && Date.now() - U.newsAt < 600000)) return;
    U.newsBusy = true;
    bridge.call('learnNews', force ? { force: true } : {}, 20000).then(function (r) {
      U.newsBusy = false; U.news = arr(r && r.items); U.newsAt = Date.now(); R.renderSoon();
    }, function () { U.newsBusy = false; U.news = U.news || []; U.newsAt = Date.now(); R.renderSoon(); });
  }

  /* ══ Carte d'accueil : le cours d'aujourd'hui ═══════════════════════════ */

  function heroHtml() {
    if (!R.profile.onboarded) return '';
    var job = R.jobOf('lesson');
    if (job) return preparingHtml(job);
    var a = act();
    if (a) return activeHtml(a);
    var t = todayEntry();
    if (U.error) return idleHtml(t);
    if (t && !U.forceIdle) return t.status === 'done' ? doneHtml(t) : readyHtml(t);
    return idleHtml(t);
  }

  function menuHtml(steps, total, title) {
    var sum = Math.max(1, planMinutes(steps));
    var bar = steps.map(function (s) {
      var sk = stepSkill(s.step);
      return '<i class="sk-bg-' + esc(sk) + '" style="flex:' + Math.max(0.6, num(s.minutes, 0) || 0.6) + '" title="' + esc(stepLabel(s.step) + ' · ' + (s.minutes || 1) + ' min') + '"></i>';
    }).join('');
    var rows = steps.map(function (s) {
      var sk = stepSkill(s.step);
      return '<li class="rzl-menu-row"><span class="rzl-menu-ic sk-' + esc(sk) + '">' + skillIcon(sk) + '</span><span class="rzl-menu-l">' + esc(stepLabel(s.step)) + '</span>'
        + '<span class="rzl-menu-m">' + esc((s.minutes || '≈ 1') + ' min') + '</span></li>';
    }).join('');
    return '<div class="rzl-menu"><div class="rzl-menu-k">' + esc(title || 'Au programme') + ' · ' + esc(total || sum) + ' min</div>'
      + '<div class="rzl-menu-bar" aria-hidden="true">' + bar + '</div><ol class="rzl-menu-list">' + rows + '</ol></div>';
  }

  function idleHtml(t) {
    var mins = U.minutes || R.profile.defaultMinutes || 20;
    var lv = clampLevel(R.globalBand());
    var steps = PREVIEW[mins].map(function (p) { return { step: p[0], minutes: p[1] }; });
    var h = ['<section class="rz-card rzl-hero" data-state="idle"><div class="rzl-hero-main">'];
    h.push('<div class="rz-kicker">' + icon('sun') + ' Le cours d’aujourd’hui</div>');
    h.push('<h2 class="rzl-hero-title">Quel est le cours d’aujourd’hui ?</h2>');
    h.push('<p class="rzl-hero-lead">Votre professeur lit l’actualité du jour et écrit un cours à votre niveau ' + R.h.level(lv) + ' : un article, une conversation à écouter, du vocabulaire, un écrit et un oral corrigés — puis trois idées pour le suivant.</p>');
    if (U.error) h.push(errorHtml(U.error));
    h.push('<div class="rzl-form">');
    h.push('<div class="rzl-form-row"><span class="rzl-k">Durée</span>' + R.h.chips('rzl-minutes', [10, 20, 30, 45], mins, ['10 min', '20 min', '30 min', '45 min'], 'rz-lesson-minutes') + '</div>');
    h.push('<div class="rzl-form-row is-topic"><span class="rzl-k">Sujet</span>' + topicHtml() + '</div>');
    h.push('</div>');
    var due = dueCount();
    h.push('<div class="rzl-hero-actions"><button type="button" class="btn btn-primary rz-big rzl-cta" data-act="rz-lesson-prepare">' + icon('spark') + ' Préparer le cours <span class="rzl-cta-sub">≈ 2 min</span></button>');
    if (srsOk() && due) h.push('<button type="button" class="btn btn-secondary" data-act="rz-lesson-prepare" data-srs="1">' + icon('cards') + ' Commencer par les révisions pendant la préparation · ' + esc(plural(due, 'carte')) + '</button>');
    h.push('</div>');
    var last = sorted().filter(function (l) { return l.status !== 'done' && l.day !== R.today() && num(l.createdAt, 0) > Date.now() - 3 * 86400000; }).pop();
    if (last && !U.error) h.push('<div class="rzl-hero-note">Un cours prêt vous attend depuis le ' + esc(R.fmtDayShort(last.day)) + ' : « <span lang="en">' + esc(last.title) + '</span> ». <button type="button" class="btn btn-ghost" data-act="rz-lesson-start" data-id="' + esc(last.id) + '">Le commencer</button></div>');
    if (t && t.status === 'done' && U.forceIdle) h.push('<div class="rzl-hero-note">Le cours du jour est déjà fait. Un deuxième ? Excellente idée. <button type="button" class="btn btn-ghost" data-act="rz-lesson-unforce">Revenir au bilan du jour</button></div>');
    h.push('<div class="rzl-hero-foot">Rédigé par Claude à partir de France 24, Euronews, NPR, The Conversation… — chaque préparation compte dans votre quota Claude Code.</div>');
    h.push('</div><div class="rzl-hero-side">' + menuHtml(steps, mins, 'À peu près') + '</div></section>');
    return h.join('');
  }

  function topicHtml() {
    var m = topicMode(), nt = R.data.nextTopic;
    var h = '<div class="rzl-topic">';
    if (m === 'next') h += '<div class="rzl-topic-cur"><span class="rzl-topic-k">Sujet retenu au dernier cours</span><b lang="en">' + esc(nt.title) + '</b>' + (nt.pitchFr ? '<span class="rzl-topic-pitch">' + esc(nt.pitchFr) + '</span>' : '') + '</div>';
    else if (m === 'custom') h += '<div class="rzl-topic-cur"><span class="rzl-topic-k">Votre sujet</span><b>' + esc(U.custom.trim()) + '</b></div>';
    else h += '<div class="rzl-topic-cur"><b>Au choix du professeur, sur l’actualité</b><span class="rzl-topic-pitch">' + esc(avoidRubrics().length ? 'Une autre rubrique que ' + avoidRubrics().map(rubricLabel).join(' et ') + ', comme aux derniers cours.' : 'France, Royaume-Uni, monde, tech, science, culture, sport…') + '</span></div>';
    if (!U.topicOpen) return h + '<button type="button" class="btn btn-ghost rzl-topic-change" data-act="rz-lesson-topic-open">changer</button></div>';
    h += '<div class="rzl-topic-pick">';
    var chips = [];
    if (nt && nt.title) chips.push(['next', 'Le sujet retenu']);
    chips.push(['teacher', 'Au choix du professeur']);
    h += R.h.chips('rzl-topic', chips.map(function (c) { return c[0]; }), m === 'custom' ? '' : m, chips.map(function (c) { return c[1]; }), 'rz-lesson-topic');
    h += '<input class="input rzl-topic-in" type="text" data-role="rz-lesson-custom" data-focus-key="rzl-topic-custom" placeholder="Ou un sujet à vous : le rugby à Toulouse, l’IA au travail…" value="' + esc(U.custom) + '" maxlength="160">';
    return h + '</div></div>';
  }

  function errorHtml(err) {
    var msg = str(err.message);
    var hint = /connect/i.test(msg) ? 'Vérifiez que Claude Code est installé et connecté (la commande claude dans un terminal).'
      : (/limite d.usage/i.test(msg) ? 'Votre quota Claude Code est épuisé pour l’instant : réessayez quand il sera levé.'
      : (/déjà en préparation/i.test(msg) ? 'Une autre fenêtre prépare déjà un cours : il apparaîtra ici dès qu’il sera prêt.'
      : 'Le web ou l’agent n’a pas répondu à temps. Réessayez, ou demandez un cours hors actualité : il se prépare sans recherche, en une minute environ.'));
    return '<div class="rzl-error" role="alert"><div class="rzl-error-t">' + icon('cross') + ' La préparation n’a pas abouti</div><div class="rzl-error-m">' + esc(msg) + '</div><div class="rzl-error-h">' + esc(hint) + '</div>'
      + '<div class="rz-row"><button type="button" class="btn btn-primary" data-act="rz-lesson-retry">' + icon('replay') + ' Réessayer</button>'
      + '<button type="button" class="btn btn-secondary" data-act="rz-lesson-timeless">Cours hors actualité</button>'
      + '<button type="button" class="btn btn-ghost" data-act="rz-lesson-error-close">Fermer</button></div></div>';
  }

  function stepsInner(j) {
    var items = [];
    /* Textes réels de l'hôte : menu « 39 titres » ou « Menu du jour indisponible », tool « Lecture : … » / « Recherche : … »,
       write « 20 352 caractères », retry « Fiche refusée par le schéma : nouvelle rédaction ». */
    if (U.menu) items.push(['done', /^menu/i.test(U.menu) ? U.menu : 'Menu du jour : ' + U.menu]);
    var tools = arr(j && j.steps);
    tools.forEach(function (t, i) { items.push([j.phase === 'tool' && i === tools.length - 1 ? 'cur' : 'done', t]); });
    if (j && (j.phase === 'write' || j.phase === 'retry' || j.phase === 'check')) items.push(['cur', j.phase === 'retry' ? (j.text || 'Fiche refusée : nouvelle rédaction') : 'Rédaction du cours' + (j.text && j.phase === 'write' ? ' · ' + j.text : '')]);
    if (!items.length) items.push(['cur', 'L’agent démarre…']);
    return items.map(function (x) {
      return '<li class="rzl-pstep is-' + x[0] + '">' + (x[0] === 'done' ? icon('check') : '<span class="rz-spin"></span>') + '<span>' + esc(x[1]) + '</span></li>';
    }).join('');
  }

  function prepRatio(j) { return Math.min(0.95, (Date.now() - num(j.startedAt, Date.now())) / 1000 / PREP_EXPECT_S); }

  function preparingHtml(j) {
    var mins = num(j.params && j.params.minutes, 0) || (U.lastParams && U.lastParams.minutes) || R.profile.defaultMinutes;
    var topic = j.params && j.params.topic;
    var h = ['<section class="rz-card rzl-hero" data-state="preparing"><div class="rzl-hero-main">'];
    h.push('<div class="rz-kicker">' + icon('sun') + ' Le cours d’aujourd’hui · en préparation</div>');
    h.push('<h2 class="rzl-hero-title">Votre professeur prépare le cours…</h2>');
    h.push('<p class="rzl-hero-lead">' + esc((topic && topic.title ? 'Sur « ' + topic.title + ' » : il' : (j.params && j.params.timeless ? 'Un cours hors actualité : il' : 'Il choisit un sujet dans l’actualité,')) + ' lit les articles et écrit votre cours de ' + mins + ' minutes. Deux à trois minutes : vous pouvez faire autre chose, une notification vous préviendra.') + '</p>');
    h.push(R.h.jobLine(j));
    h.push('<div class="rzl-prepbar" data-rzl-prepbar>' + R.h.progress(prepRatio(j), 'Préparation du cours') + '</div>');
    h.push('<ul class="rzl-psteps" data-rzl-steps>' + stepsInner(j) + '</ul>');
    var due = dueCount();
    h.push('<div class="rzl-hero-actions"><button type="button" class="btn btn-secondary" data-act="rz-lesson-cancel" data-job="' + esc(j.job) + '">' + icon('cross') + ' Annuler</button>');
    if (srsOk() && due && !U.prepSrs) h.push('<button type="button" class="btn btn-ghost" data-act="rz-lesson-prep-srs">' + icon('cards') + ' Réviser en attendant · ' + esc(plural(due, 'carte')) + '</button>');
    h.push('</div></div>');
    h.push('<div class="rzl-hero-side">' + (U.prepSrs && srsOk() && !U.prepSrsDone ? '<div class="rzl-side-srs">' + srsHtml('lesson-prep') + '</div>' : newsHtml()) + '</div></section>');
    return h.join('');
  }

  function srsHtml(key) { try { return R.srs.html(key) || ''; } catch (e) { return '<div class="rz-error">' + esc(e && e.message) + '</div>'; } }

  function newsHtml() {
    if (!U.news) { loadNews(); return '<div class="rzl-news"><div class="rzl-menu-k">Les titres du jour</div><div class="rz-muted"><span class="rz-spin"></span> Lecture des flux…</div></div>'; }
    var items = U.news.filter(function (n) { return n && n.title && !n.heavy; })
      .sort(function (a, b) { return (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0); }).slice(0, 7);
    if (!items.length) return '<div class="rzl-news"><div class="rzl-menu-k">Les titres du jour</div><div class="rz-muted">Les flux ne répondent pas : l’agent cherchera lui-même.</div></div>';
    return '<div class="rzl-news"><div class="rzl-menu-k">En attendant, les titres du jour</div><ul class="rzl-news-list">' + items.map(function (n) {
      var t = Date.parse(n.published);
      return '<li class="rzl-news-row"><span class="rzl-news-src">' + esc(n.source) + (t ? ' · ' + esc(R.fmtTime(t)) : '') + '</span>'
        + (/^https?:\/\//i.test(str(n.url)) ? '<a class="rzl-news-t" lang="en" href="' + esc(n.url) + '" data-act="open-url" data-url="' + esc(n.url) + '" title="Ouvrir dans le navigateur">' + esc(n.title) + '</a>' : '<span class="rzl-news-t" lang="en">' + esc(n.title) + '</span>') + '</li>';
    }).join('') + '</ul></div>';
  }

  function sourcesHtml(L) {
    if (!L || !L.sources.length) return '';
    return '<div class="rzl-sources"><span class="rzl-k">D’après</span>' + L.sources.slice(0, 4).map(function (s) {
      var label = (s.outlet || s.title) + (s.published ? ' · ' + fmtPublished(s.published) : '');
      return /^https?:\/\//i.test(s.url) ? '<a class="rzl-src" href="' + esc(s.url) + '" data-act="open-url" data-url="' + esc(s.url) + '" title="' + esc(s.title) + '">' + esc(label) + '</a>' : '<span class="rzl-src">' + esc(label) + '</span>';
    }).join('') + '</div>';
  }

  function metaChips(L, e) {
    var rub = (L && L.rubric) || (e && e.rubric), tone = (L && L.tone) || (e && e.tone), lv = (L && L.level) || (e && e.level);
    return (rub ? '<span class="rzl-chip-rub">' + esc(rubricLabel(rub)) + (tone && TONES[tone] ? ' · ' + esc(TONES[tone]) : '') + '</span>' : '') + (lv ? R.h.level(lv) : '');
  }

  function readyHtml(t) {
    var d = docOf(t.id);
    ensureDoc(t.id);
    var L = shape(d);
    var mins = (L && L.minutes) || t.minutes || 20;
    var h = ['<section class="rz-card rzl-hero" data-state="ready"><div class="rzl-hero-main">'];
    h.push('<div class="rz-kicker">' + icon('sun') + ' Le cours d’aujourd’hui · prêt</div>');
    h.push('<div class="rzl-hero-meta">' + metaChips(L, t) + '</div>');
    h.push('<h2 class="rzl-hero-title is-lesson" lang="en">' + esc((L && L.title) || t.title) + '</h2>');
    if (L && L.summaryFr) h.push('<p class="rzl-hero-lead">' + esc(L.summaryFr) + '</p>');
    if (!L && U.docMissing[t.id]) h.push('<p class="rzl-hero-lead rz-err-line">Le document de ce cours est introuvable sur le disque. Préparez-en un autre.</p>');
    h.push(sourcesHtml(L));
    h.push('<div class="rzl-hero-actions"><button type="button" class="btn btn-primary rz-big rzl-cta" data-act="rz-lesson-start" data-id="' + esc(t.id) + '"' + (L ? '' : ' disabled') + '>' + icon('play') + ' Commencer · ' + esc(mins) + ' min</button>'
      + '<button type="button" class="btn btn-secondary" data-act="rz-lesson-again">' + icon('replay') + ' Un autre sujet</button></div>');
    if (U.prepSrs && srsOk() && !U.prepSrsDone) h.push('<div class="rzl-hero-note">Le cours est prêt : finissez vos révisions, puis commencez.</div><div class="rzl-side-srs">' + srsHtml('lesson-prep') + '</div>');
    h.push('</div><div class="rzl-hero-side">' + (L ? menuHtml(buildSteps(L), mins) : '<div class="rz-muted"><span class="rz-spin"></span> Chargement du cours…</div>') + '</div></section>');
    return h.join('');
  }

  function activeHtml(a) {
    var d = sd(a), e = entry(a.id), L = shape(docOf(a.id));
    ensureDoc(a.id);
    var steps = d.steps.length ? d.steps : (L ? buildSteps(L) : []);
    var cur = steps[d.cur] ? steps[d.cur].step : '';
    var spent = elapsed(a);
    var planned = (L && L.minutes) || planMinutes(steps) || (e && e.minutes) || 0;
    var h = ['<section class="rz-card rzl-hero" data-state="active"><div class="rzl-hero-main">'];
    h.push('<div class="rz-kicker">' + icon('play') + ' Séance en cours</div>');
    h.push('<div class="rzl-hero-meta">' + metaChips(L, e) + '</div>');
    h.push('<h2 class="rzl-hero-title is-lesson" lang="en">' + esc((L && L.title) || (e && e.title) || 'Le cours du jour') + '</h2>');
    h.push('<p class="rzl-hero-lead">Vous en étiez à l’étape ' + (d.cur + 1) + ' sur ' + steps.length + (cur ? ' : <b>' + esc(stepLabel(cur)) + '</b>' : '') + ' — ' + esc(Math.round(spent / 60) + ' min') + ' passées' + (planned ? ' sur ' + esc(planned) + ' prévues' : '') + '. Tout est gardé : reprenez quand vous voulez.</p>');
    h.push(timelineHtml(steps, d, true));
    h.push('<div class="rzl-hero-actions"><button type="button" class="btn btn-primary rz-big rzl-cta" data-act="rz-lesson-resume">' + icon('play') + ' Reprendre' + (cur ? ' · ' + esc(stepLabel(cur)) : '') + '</button>'
      + '<button type="button" class="btn btn-ghost" data-act="rz-lesson-abandon">' + esc(U.abandonArm ? 'Confirmer : abandonner la séance' : 'Abandonner la séance') + '</button></div>');
    h.push('</div><div class="rzl-hero-side">' + (L ? menuHtml(steps, planned) : '') + '</div></section>');
    return h.join('');
  }

  function topicCards(list, chosen, act0) {
    return '<div class="rzl-topics">' + list.map(function (t, i) {
      var on = chosen === i;
      return '<button type="button" class="rzl-topic-card' + (on ? ' on' : '') + '" data-act="' + esc(act0) + '" data-i="' + i + '" aria-pressed="' + on + '">'
        + '<span class="rzl-topic-rub">' + esc(rubricLabel(t.rubric)) + (TONES[t.tone] ? ' · ' + esc(TONES[t.tone]) : '') + (on ? ' · ' + icon('check') + ' retenu' : '') + '</span>'
        + '<span class="rzl-topic-title" lang="en">' + esc(t.title) + '</span><span class="rzl-topic-p">' + esc(t.pitchFr) + '</span></button>';
    }).join('') + '<button type="button" class="rzl-topic-card is-surprise' + (chosen === 'surprise' ? ' on' : '') + '" data-act="' + esc(act0) + '" data-i="surprise" aria-pressed="' + (chosen === 'surprise') + '">'
      + '<span class="rzl-topic-rub">' + icon('spark') + ' Au choix du professeur' + (chosen === 'surprise' ? ' · retenu' : '') + '</span><span class="rzl-topic-title">Surprenez-moi</span><span class="rzl-topic-p">Un sujet frais de l’actualité, dans une rubrique que vous n’avez pas vue depuis longtemps.</span></button></div>';
  }
  function nextChoiceIndex(L) {
    var nt = R.data.nextTopic;
    if (!nt || !L) return 'surprise';
    for (var i = 0; i < L.nextTopics.length; i++) if (L.nextTopics[i].title === nt.title) return i;
    return 'custom';
  }

  function doneHtml(t) {
    var d = docOf(t.id);
    ensureDoc(t.id);
    var L = shape(d), res = obj(t.result) || {};
    var h = ['<section class="rz-card rzl-hero" data-state="done"><div class="rzl-hero-main">'];
    h.push('<div class="rz-kicker">' + icon('check') + ' Le cours d’aujourd’hui · fait</div>');
    h.push('<div class="rzl-hero-meta">' + metaChips(L, t) + '</div>');
    h.push('<h2 class="rzl-hero-title is-lesson" lang="en">' + esc((L && L.title) || t.title) + '</h2>');
    h.push('<div class="rzl-stats">'
      + statHtml(res.score == null ? '—' : pct(res.score), 'de bonnes réponses')
      + statHtml(num(res.cards, 0), num(res.cards, 0) > 1 ? 'cartes créées' : 'carte créée')
      + statHtml(Math.round(num(res.minutes, 0)) + ' min', 'de travail')
      + (res.self && SELF[res.self] ? statHtml(SELF[res.self], 'votre ressenti') : '') + '</div>');
    var sk = obj(res.skills) || {};
    var rows = ['read', 'listen', 'lang'].filter(function (k) { return arr(sk[k])[1]; }).map(function (k) { return R.h.skill(k) + ' <b>' + sk[k][0] + '/' + sk[k][1] + '</b>'; });
    if (res.write) rows.push(R.h.skill('write') + ' ' + R.h.level(res.write));
    if (res.speak) rows.push(R.h.skill('speak') + ' ' + R.h.level(res.speak));
    if (rows.length) h.push('<div class="rzl-done-skills">' + rows.map(function (r) { return '<span>' + r + '</span>'; }).join('') + '</div>');
    var nt = R.data.nextTopic;
    h.push('<p class="rzl-done-next">' + (nt && nt.title ? 'À demain : le prochain cours partira de « <b lang="en">' + esc(nt.title) + '</b> ». Vous pouvez encore changer d’avis, à droite.' : 'À demain ! Choisissez à droite le sujet du prochain cours, ou laissez faire le professeur.') + '</p>');
    h.push('<div class="rzl-hero-actions"><button type="button" class="btn btn-secondary" data-act="rz-lesson-more">' + icon('spark') + ' Préparer un autre cours</button>'
      + '<button type="button" class="btn btn-ghost" data-act="rz-lesson-start" data-id="' + esc(t.id) + '">Refaire ce cours</button></div>');
    h.push('</div><div class="rzl-hero-side">');
    if (L && L.nextTopics.length) {
      var ch = nextChoiceIndex(L);
      h.push('<div class="rzl-menu-k">Pour le prochain cours</div>' + topicCards(L.nextTopics, ch, 'rz-lesson-next-pick'));
      if (ch === 'custom' && R.data.nextTopic) h.push('<div class="rz-muted">Sujet retenu : « ' + esc(R.data.nextTopic.title) + ' »</div>');
    } else h.push(L ? '' : '<div class="rz-muted"><span class="rz-spin"></span></div>');
    h.push('</div></section>');
    return h.join('');
  }
  function statHtml(v, k) { return '<div class="rzl-stat"><span class="rzl-stat-v">' + esc(v) + '</span><span class="rzl-stat-k">' + esc(k) + '</span></div>'; }

  R.homeCard({ id: 'lesson', area: 'hero', order: 10, html: heroHtml });

  /* ── Cours précédents ─────────────────────────────────────────────── */
  function prevHtml() {
    var a = act(), t = todayEntry(), hero = a ? a.id : (t && !U.forceIdle ? t.id : '');
    var list = sorted().reverse().filter(function (l) { return l.id !== hero; });
    if (!list.length) return '';
    var shown = U.prevAll ? list.slice(0, 40) : list.slice(0, 5);
    var h = ['<section class="rz-card rzl-prev"><div class="rz-card-head"><span class="rz-card-title">Cours précédents</span><span class="rz-card-meta">' + esc(plural(list.length, 'cours', 'cours')) + '</span></div><ul class="rzl-prev-list">'];
    shown.forEach(function (l) {
      var st = l.status === 'done' ? '<span class="rzl-st is-done">' + icon('check') + ' fait</span>' : (a && a.id === l.id ? '<span class="rzl-st is-active">en cours</span>' : '<span class="rzl-st">prêt</span>');
      h.push('<li class="rzl-prev-row"><span class="rzl-prev-day">' + esc(R.fmtDayShort(l.day)) + '</span>'
        + '<span class="rzl-prev-main"><span class="rzl-prev-title" lang="en">' + esc(l.title) + '</span><span class="rzl-prev-meta">' + esc([rubricLabel(l.rubric), (l.minutes || '?') + ' min', l.level, l.grammar].filter(Boolean).join(' · ')) + '</span></span>'
        + st + '<button type="button" class="btn btn-secondary rzl-prev-go" data-act="rz-lesson-start" data-id="' + esc(l.id) + '">' + esc(l.status === 'done' ? 'Refaire' : 'Commencer') + '</button></li>');
    });
    h.push('</ul>');
    if (list.length > 5) h.push('<button type="button" class="btn btn-ghost" data-act="rz-lesson-prev-all">' + esc(U.prevAll ? 'Voir moins' : 'Voir les ' + list.length + ' cours') + '</button>');
    h.push('</section>');
    return h.join('');
  }
  R.homeCard({ id: 'lesson-prev', area: 'main', order: 50, html: prevHtml });

  /* ══ Séance : état, minuteur, navigation ════════════════════════════════ */

  function act() { var a = R.active(); return a && a.kind === 'lesson' && a.id ? a : null; }
  function sd(a) {
    var d = a.data = obj(a.data) || {};
    d.steps = arr(d.steps);
    ['t', 'done', 'ans', 'listen', 'write', 'speak', 'review', 'added'].forEach(function (k) { d[k] = obj(d[k]) || {}; });
    d.speak.pron = obj(d.speak.pron) || {};
    d.cur = clamp(Math.round(num(d.cur, 0)), 0, Math.max(0, d.steps.length - 1));
    d.far = clamp(Math.round(num(d.far, 0)), d.cur, Math.max(0, d.steps.length - 1));
    return d;
  }
  function persist() {
    var a = act();
    if (a) { var d = sd(a); a.updatedAt = Date.now(); a.step = d.steps[d.cur] ? d.steps[d.cur].step : ''; }
    R.save();
  }
  function curStep(a) { var d = sd(a); return d.steps[d.cur] ? d.steps[d.cur].step : 'review'; }
  function elapsed(a) {
    var d = sd(a), t = 0;
    Object.keys(d.t).forEach(function (k) { t += num(d.t[k], 0); });
    return t + (act() === a ? U.acc : 0);
  }
  function flush() {
    var a = act();
    if (!a || !U.acc) { U.acc = 0; return; }
    var d = sd(a), st = curStep(a);
    d.t[st] = num(d.t[st], 0) + U.acc;
    U.acc = 0;
    persist();
  }
  function levelOf() { var a = act(); var L = a && shape(docOf(a.id)); return (L && L.level) || clampLevel(R.globalBand()); }
  function mediaBusy() {
    if (R.rec.busy && R.rec.busy()) return true;
    return Object.keys(R.players).some(function (k) { var p = R.players[k]; return p && (p.state === 'playing' || p.state === 'loading'); });
  }

  ['pointerdown', 'keydown', 'input', 'wheel'].forEach(function (ev) { document.addEventListener(ev, function () { U.lastAct = Date.now(); }, true); });

  /* Une seconde : le minuteur de la séance (seulement à l'écran, fenêtre visible, apprenant présent),
     le compte à rebours de préparation de l'oral, la barre de préparation du cours. */
  setInterval(function () {
    var a = act();
    var here = !!document.querySelector('.rz-view-session');
    if (a && here && document.visibilityState !== 'hidden' && (Date.now() - U.lastAct < IDLE_MS || mediaBusy())) {
      U.acc++;
      R.patch('[data-rzl-clock]', esc(clock(elapsed(a))));
      if (U.acc >= 15) flush();
    } else if (U.acc) flush();
    if (a && here) {
      var until = U.prepUntil[a.id];
      if (until) R.patch('[data-rzl-prep]', prepInner(a));
    }
    var j = R.jobOf('lesson');
    if (j) R.patch('[data-rzl-prepbar]', R.h.progress(prepRatio(j), 'Préparation du cours'));
  }, 1000);

  function startLesson(id, force) {
    var cur = act();
    if (cur && cur.id === id) { resume(); return; }
    var e = entry(id);
    if (cur && !force) {
      var ce = entry(cur.id);
      R.toast('Une séance est déjà en cours' + (ce ? ' : « ' + ce.title + ' »' : '') + '.', { label: 'La remplacer', run: function () { startLesson(id, true); } });
      return;
    }
    var d = docOf(id);
    if (!d) {
      R.doc('lesson', id).then(function (doc) { if (doc) startLesson(id, true); else { U.docMissing[id] = true; R.toast('Ce cours est introuvable sur le disque.'); R.render(); } },
        function (err) { R.toast('Cours illisible : ' + err.message); });
      return;
    }
    if (cur) { flush(); var oe = entry(cur.id); if (oe && oe.status === 'active') oe.status = 'ready'; }
    if (U.prepSrs && srsOk() && R.srs.active && R.srs.active('lesson-prep')) { try { R.srs.end('lesson-prep'); } catch (e) { /* déjà finie */ } }
    var steps = buildSteps(shape(d));
    U.acc = 0; U.gloss = null; U.confirmQuit = false; U.drafts = {}; U.show = {}; U.grading = {}; U.gradeError = {};
    U.prepUntil = {}; U.srsStarted = {}; U.abandonArm = false; U.forceIdle = false;
    R.setActive({ kind: 'lesson', id: id, step: steps[0].step, startedAt: Date.now(),
      data: { v: 1, steps: steps, cur: 0, far: 0, t: {}, done: {}, ans: {}, listen: { phase: 0 }, write: {}, speak: { pron: {} }, review: {}, added: {},
        srsDone: U.prepSrs && U.prepSrsDone ? -1 : null } });
    U.prepSrs = false;
    if (e && e.status !== 'done') e.status = 'active';
    R.save(true);
    R.go('session');
  }
  function resume() { U.abandonArm = false; R.go('session'); }

  function enterStep() {
    var a = act();
    if (!a) return;
    var d = sd(a), st = curStep(a);
    if (st === 'warmup') startWarmupSrs(a);
    if (st === 'speaking' && !d.speak.rec && U.prepUntil[a.id] == null) {
      var L = shape(docOf(a.id));
      U.prepUntil[a.id] = Date.now() + (L ? L.speaking.prepSeconds : 30) * 1000;
    }
    if (st === 'review') addLessonCards(a);
  }

  function startWarmupSrs(a) {
    var d = sd(a);
    if (!srsOk() || d.srsDone != null || U.srsStarted[a.id]) return;
    if (dueCount() === 0) return;
    U.srsStarted[a.id] = true;
    var step = d.steps[d.cur] || {};
    try {
      R.srs.start('lesson-warmup', { minutes: Math.max(2, num(step.minutes, 3)), max: 30, newMax: 0, onDone: function (res) {
        var a2 = act();
        if (!a2 || a2.id !== a.id) return;
        var n = obj(res) ? num(res.reviewed != null ? res.reviewed : (res.count != null ? res.count : res.done), 0) : num(res, 0);
        sd(a2).srsDone = n || 0;
        persist(); R.renderSoon();
      } });
    } catch (e) { U.srsStarted[a.id] = false; if (window.console) console.warn('[revizator] srs.start', e); }
  }

  function goStep(i) {
    var a = act();
    if (!a) return;
    var d = sd(a);
    i = clamp(i, 0, d.steps.length - 1);
    if (i === d.cur) return;
    flush();
    R.tts.stopAll();
    d.cur = i; d.far = Math.max(d.far, i);
    U.gloss = null; U.confirmQuit = false;
    persist();
    window.scrollTo(0, 0);
    enterStep();
    R.render();
  }
  function nextStep(skip) {
    var a = act();
    if (!a) return;
    var d = sd(a), st = curStep(a);
    d.done[st] = skip && d.done[st] !== 'done' ? 'skipped' : 'done';
    if (d.cur >= d.steps.length - 1) { finish(); return; }
    goStep(d.cur + 1);
  }
  function quit() {
    flush();
    R.tts.stopAll();
    U.confirmQuit = false;
    persist();
    R.save(true);
    R.go('home');
    R.toast('Séance mise de côté : vous la reprendrez là où vous en êtes.');
  }

  /* ══ Items : clés, correction tolérante, rendu ══════════════════════════ */

  function splitBlank(p) { var m = /_{2,}/.exec(p); return m ? [p.slice(0, m.index), p.slice(m.index + m[0].length)] : null; }
  var EDIT_INSTR = /^(corrigez|correct|transformez|transform|rewrite|réécrivez|reformulez)/i;

  /* Un item de grammaire : « [for / since] » donne des choix, « [present perfect] » une indication,
     « Choisissez : … » une consigne ; « Corrigez : » préremplit la réponse avec la phrase à corriger. */
  function grammarItem(it) {
    var p = it.prompt.trim(), hint = '', options = [], instr = '';
    var m = /\s*\[([^\]]+)\]\s*$/.exec(p);
    if (m) {
      p = p.slice(0, m.index).trim();
      var inner = m[1].trim();
      var opts = inner.split(/\s*\/\s*/).map(function (o) { return o.trim(); }).filter(Boolean);
      if (opts.length >= 2 && opts.length <= 4 && opts.some(function (o) { return nrm(o) === nrm(it.answer); })) options = opts;
      else hint = inner;
    }
    var mm = /^([^:]{3,90}?)\s*:\s+(.+)$/.exec(p);
    if (mm && /^(choisissez|complétez|completez|complete|corrigez|correct|transformez|transform|rewrite|réécrivez|reformulez|mettez|put|choose|traduisez|translate|conjuguez)/i.test(mm[1])) {
      instr = mm[1]; p = mm[2];
      var w = /\bavec\s+(.+)$/i.exec(instr) || /\bwith\s+(.+)$/i.exec(instr);
      if (!options.length && w) {
        var o2 = w[1].split(/\s*,\s*|\s+ou\s+|\s+or\s+/).map(function (o) { return o.trim(); }).filter(Boolean);
        if (o2.length >= 2 && o2.length <= 4 && o2.some(function (o) { return nrm(o) === nrm(it.answer); })) options = o2;
      }
    }
    return { prompt: p, options: options, hint: hint, instr: instr, answer: it.answer, explanationFr: '', prefill: EDIT_INSTR.test(instr) ? p : '' };
  }

  /* Tous les items du cours, par clé. */
  function itemsOf(L) {
    var map = Object.create(null);
    L.comprehension.forEach(function (q, i) { map['read:' + i] = { k: 'read:' + i, skill: 'read', step: 'reading', prompt: q.question, options: q.options, answer: q.answer, explanationFr: q.explanationFr, qskill: q.skill, open: q.kind === 'open' }; });
    L.listening.questions.forEach(function (q, i) { map['listen:' + i] = { k: 'listen:' + i, skill: 'listen', step: 'listening', prompt: q.question, options: q.options, answer: q.answer, explanationFr: q.explanationFr, qskill: q.skill, open: q.kind === 'open' }; });
    L.vocabulary.forEach(function (b, bi) {
      b.items.forEach(function (it, i) {
        var editing = b.kind === 'error_correction' && !it.options.length;
        map['voc:' + bi + ':' + i] = { k: 'voc:' + bi + ':' + i, skill: 'lang', step: 'vocabulary', prompt: it.prompt, options: it.options, answer: it.answer, explanationFr: it.explanationFr, prefill: editing ? it.prompt : '' };
      });
    });
    L.grammar.items.forEach(function (it, i) {
      var g = grammarItem(it);
      map['gr:' + i] = { k: 'gr:' + i, skill: 'lang', step: 'grammar', prompt: g.prompt, options: g.options, answer: g.answer, explanationFr: '', hint: g.hint, instr: g.instr, prefill: g.prefill };
    });
    return map;
  }
  /* Ordre d'affichage des items d'une étape (les questions : sens général, détail, inférence). */
  function orderOf(L, step, a) {
    var keys = [];
    if (step === 'reading' || step === 'listening') {
      var list = step === 'reading' ? L.comprehension : L.listening.questions, pre = step === 'reading' ? 'read:' : 'listen:';
      var idx = list.map(function (q, i) { return i; }).sort(function (x, y) { return (QRANK[list[x].skill] - QRANK[list[y].skill]) || x - y; });
      if (step === 'listening' && a && num(sd(a).listen.phase, 0) < 2) {
        var ph = num(sd(a).listen.phase, 0);
        idx = ph === 0 ? [] : idx.filter(function (i) { return list[i].skill === 'gist'; });
        if (ph === 1 && !idx.length && list.length) idx = [0];
      }
      keys = idx.map(function (i) { return pre + i; });
    } else if (step === 'vocabulary') {
      L.vocabulary.forEach(function (b, bi) { b.items.forEach(function (it, i) { keys.push('voc:' + bi + ':' + i); }); });
    } else if (step === 'grammar') {
      L.grammar.items.forEach(function (it, i) { keys.push('gr:' + i); });
    }
    return keys;
  }
  function currentItem(a) {
    var L = shape(docOf(a.id));
    if (!L) return null;
    var d = sd(a), map = itemsOf(L);
    var keys = orderOf(L, curStep(a), a);
    for (var i = 0; i < keys.length; i++) if (!d.ans[keys[i]]) return map[keys[i]];
    return null;
  }

  function overlap(a, b) {
    var stop = { the: 1, a: 1, an: 1, of: 1, to: 1, and: 1, is: 1, are: 1, was: 1, in: 1, on: 1, it: 1, that: 1, for: 1, with: 1 };
    var A = nrm(a).split(' ').filter(function (w) { return w && !stop[w]; }), B = nrm(b).split(' ').filter(function (w) { return w && !stop[w]; });
    if (!B.length) return 0;
    var hit = B.filter(function (w) { return A.indexOf(w) >= 0; }).length;
    return hit / B.length;
  }
  function judge(it, v) {
    if (it.options && it.options.length) {
      if (nrm(v) === nrm(it.answer)) return 'exact';
      return 'wrong';
    }
    var r = R.text.match(v, it.answer, []);
    if (r !== 'exact') {
      var parts = splitBlank(it.prompt);
      /* La phrase entière tapée au lieu du seul trou : « Carson has written poetry… », « They have lived… » pour « They (live)… ». */
      var full = parts ? (parts[0] + it.answer + parts[1]).replace(/\s*\([^)]*\)\s*/g, ' ') : (/\([^)]+\)/.test(it.prompt) ? it.prompt.replace(/\([^)]+\)/, it.answer) : '');
      if (full) { var r2 = R.text.match(v, full, []); if (r2 === 'exact' || (r2 === 'close' && r === 'wrong')) r = r2; }
    }
    if (r === 'wrong' && it.open && overlap(v, it.answer) >= 0.6) r = 'close';
    return r;
  }

  function answer(k, v) {
    var a = act();
    if (!a) return;
    var d = sd(a);
    if (d.ans[k]) return;
    var L = shape(docOf(a.id));
    var it = L && itemsOf(L)[k];
    if (!it) return;
    v = str(v).trim();
    if (!v) { R.toast('Écrivez votre réponse, ou passez à la suite.'); return; }
    var r = judge(it, v);
    d.ans[k] = { v: v.slice(0, 400), r: r };
    delete U.drafts[k];
    R.observe(it.skill, L.level, r === 'exact' ? 1 : (r === 'close' ? 0.75 : 0));
    persist();
    R.render();
    focusCurrent(a, false);
  }

  function focusCurrent(a, scroll) {
    var it = currentItem(a);
    setTimeout(function () {
      if (!it) { var p = document.querySelector('[data-rzl-primary]'); if (p && scroll) p.focus(); return; }
      var box = document.querySelector('[data-rzl-item="' + it.k + '"]');
      if (!box) return;
      var inp = box.querySelector('input.rzl-in');
      if (inp) inp.focus({ preventScroll: !scroll });
      if (scroll && box.scrollIntoView) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 30);
  }

  function itemHtml(it, n, a, cur) {
    var d = sd(a), ans = d.ans[it.k];
    var cls = 'rzl-item' + (cur ? ' is-current' : '') + (ans ? (ans.r === 'wrong' ? ' is-bad' : (ans.r === 'close' ? ' is-close' : ' is-ok')) : '');
    var typed = !it.options.length;
    var h = '<div class="' + cls + '" data-rzl-item="' + esc(it.k) + '">';
    h += '<div class="rzl-item-n">' + n + '</div><div class="rzl-item-body">';
    if (it.qskill) h += '<div class="rzl-item-tag">' + esc(QSKILL[it.qskill] || '') + '</div>';
    if (it.instr) h += '<div class="rzl-item-tag">' + esc(it.instr) + '</div>';
    var parts = splitBlank(it.prompt);
    var inp = '';
    if (typed) {
      var val = ans ? ans.v : (U.drafts[it.k] != null ? U.drafts[it.k] : (it.prefill || ''));
      var w = clamp(it.answer.length + 3, 7, 30);
      inp = '<input class="input rzl-in" type="text" data-role="rz-lesson-ans" data-k="' + esc(it.k) + '" data-focus-key="rzl-in-' + esc(it.k) + '" value="' + esc(val) + '"'
        + (parts && !it.prefill ? ' style="width:' + w + 'ch"' : '') + ' spellcheck="false" autocomplete="off" autocapitalize="off" lang="en" data-dict="off"' + (ans ? ' readonly' : '') + ' aria-label="Votre réponse">';
    }
    if (parts && !(typed && it.prefill)) {
      var fill = ans ? '<span class="rzl-blank is-filled">' + esc(it.answer) + '</span>' : '<span class="rzl-blank"></span>';
      h += '<div class="rzl-item-prompt" lang="en">' + esc(parts[0]) + (typed && !ans ? inp : fill) + esc(parts[1]) + '</div>';
      if (typed && ans) h += '<div class="rzl-item-line">' + inp + '</div>';
    } else {
      h += '<div class="rzl-item-prompt"' + (/[«»éèàçù]/.test(it.prompt) ? '' : ' lang="en"') + '>' + esc(it.prompt) + '</div>';
      if (typed) h += '<div class="rzl-item-line">' + inp + '</div>';
    }
    if (it.hint) h += '<div class="rzl-item-hint">' + esc(it.hint) + '</div>';
    if (!typed) {
      var tf = it.options.length === 2 && /^(true|false)$/i.test(it.options[0]);
      h += '<div class="rzl-opts' + (tf ? ' is-tf' : '') + (it.options.length > 2 && it.options.every(function (o) { return o.length < 28; }) ? ' is-grid' : '') + '">' + it.options.map(function (o, i) {
        var c = 'rzl-opt';
        if (ans) {
          if (nrm(o) === nrm(it.answer)) c += ' is-right';
          else if (nrm(o) === nrm(ans.v)) c += ' is-wrong';
          else c += ' is-dim';
        }
        var lab = tf ? (/^true$/i.test(o) ? 'Vrai · True' : 'Faux · False') : o;
        return '<button type="button" class="' + c + '" data-act="rz-lesson-answer" data-k="' + esc(it.k) + '" data-v="' + esc(o) + '"' + (ans ? ' disabled' : '') + '>'
          + '<span class="rzl-opt-key">' + (i + 1) + '</span><span class="rzl-opt-t" lang="en">' + esc(lab) + '</span></button>';
      }).join('') + '</div>';
    } else if (!ans) {
      h += '<div class="rzl-item-act"><button type="button" class="btn btn-secondary" data-act="rz-lesson-check" data-k="' + esc(it.k) + '">' + icon('check') + ' Vérifier</button><span class="rzl-hint-k"><span class="rz-kbd">Entrée</span></span></div>';
    }
    if (ans) {
      var good = ans.r !== 'wrong';
      var msg = ans.r === 'exact' ? 'Juste.' : (ans.r === 'close' ? (it.open ? 'C’est l’idée. La réponse attendue : « ' + it.answer + ' ».' : 'Presque — on écrit « ' + it.answer + ' ».') : 'La bonne réponse : « ' + it.answer + ' ».');
      h += '<div class="rzl-ifb ' + (ans.r === 'exact' ? 'is-ok' : (good ? 'is-close' : 'is-bad')) + '">' + icon(good ? 'check' : 'cross') + '<div><b>' + esc(msg) + '</b>'
        + (it.explanationFr ? '<div class="rzl-ifb-why">' + esc(it.explanationFr) + '</div>' : '') + '</div></div>';
    }
    return h + '</div></div>';
  }

  function itemsBlock(L, a, keys, startN) {
    var map = itemsOf(L), d = sd(a), curK = null;
    for (var i = 0; i < keys.length; i++) if (!d.ans[keys[i]]) { curK = keys[i]; break; }
    return keys.map(function (k, i) { return map[k] ? itemHtml(map[k], (startN || 1) + i, a, k === curK) : ''; }).join('');
  }
  function scoreOf(a, keys) {
    var d = sd(a), right = 0, done = 0;
    keys.forEach(function (k) { var x = d.ans[k]; if (x) { done++; if (x.r !== 'wrong') right++; } });
    return { right: right, done: done, total: keys.length };
  }
  function scoreLine(sc) {
    if (!sc.total) return '';
    return '<div class="rzl-score">' + (sc.done < sc.total ? esc(sc.done + ' sur ' + sc.total + ' répondues') : icon('check') + ' ' + esc(sc.right + ' / ' + sc.total + ' justes')) + R.h.progress(sc.total ? sc.done / sc.total : 0, 'Avancement', sc.done === sc.total ? 'is-good' : '') + '</div>';
  }

  /* ══ Séance : rendu ═════════════════════════════════════════════════════ */

  function timelineHtml(steps, d, compact) {
    return '<ol class="rzl-tl' + (compact ? ' is-compact' : '') + '" aria-label="Étapes de la séance">' + steps.map(function (s, i) {
      var st = i === d.cur ? 'cur' : (d.done[s.step] === 'skipped' ? 'skipped' : (d.done[s.step] || i < d.cur ? 'done' : 'todo'));
      var sk = stepSkill(s.step);
      var can = !compact && i <= d.far && i !== d.cur;
      var inner = '<span class="rzl-tl-bar sk-bg-' + esc(sk) + '"></span><span class="rzl-tl-lab">' + (st === 'done' ? icon('check') : skillIcon(sk)) + '<span class="rzl-tl-name">' + esc(stepLabel(s.step)) + '</span>'
        + '<span class="rzl-tl-min">' + esc((s.minutes || 1) + ' min') + '</span></span>';
      return '<li class="rzl-tl-step is-' + st + '" style="flex:' + Math.max(1, num(s.minutes, 1)) + ' 1 0" title="' + esc(stepLabel(s.step) + ' · ' + (s.minutes || 1) + ' min' + (st === 'skipped' ? ' · passée' : '')) + '"' + (i === d.cur ? ' aria-current="step"' : '') + '>'
        + (can ? '<button type="button" class="rzl-tl-btn" data-act="rz-lesson-goto" data-i="' + i + '" title="Revenir à cette étape">' + inner + '</button>' : '<span class="rzl-tl-btn">' + inner + '</span>') + '</li>';
    }).join('') + '</ol>';
  }

  function sessionHtml() {
    var a = act();
    if (!a) {
      return '<div class="rzl-session is-empty">' + R.h.empty('Aucune séance en cours', 'Préparez le cours du jour depuis l’accueil, puis commencez : la séance s’ouvre ici, une étape à la fois.',
        '<button type="button" class="btn btn-primary" data-act="rz-go" data-view="home">' + icon('sun') + ' Aller à l’accueil</button>') + '</div>';
    }
    var doc = docOf(a.id);
    if (!doc) {
      ensureDoc(a.id);
      if (U.docMissing[a.id]) {
        return '<div class="rzl-session is-empty">' + R.h.empty('Ce cours est introuvable', 'Son document a disparu du dossier de données. Vous pouvez abandonner la séance et en préparer un autre.',
          '<button type="button" class="btn btn-primary" data-act="rz-lesson-drop">Abandonner la séance</button>') + '</div>';
      }
      return '<div class="rzl-session is-empty"><div class="rz-loading"><span class="rz-spin"></span> Ouverture du cours…</div></div>';
    }
    var L = shape(doc), d = sd(a);
    if (!d.steps.length) { d.steps = buildSteps(L); persist(); }
    var step = d.steps[d.cur], st = step.step;
    var planned = L.minutes || planMinutes(d.steps);
    var spent = elapsed(a);
    var body = '', primary = null;
    try {
      var r = renderStep(st, L, a, step);
      body = r.html; primary = r.primary;
    } catch (e) {
      if (window.console) console.error(e);
      body = '<div class="rz-error">Cette étape n’a pas pu s’afficher : ' + esc(e && e.message) + '</div>';
    }
    var last = d.cur >= d.steps.length - 1;
    var nxt = last ? null : d.steps[d.cur + 1];
    if (primary === undefined || primary === null) primary = { act: last ? 'rz-lesson-finish' : 'rz-lesson-next', label: last ? 'Terminer la séance' : 'Suivant : ' + stepLabel(nxt.step) };
    var h = [];
    h.push('<div class="rzl-session" data-step="' + esc(st) + '">');
    h.push('<header class="rzl-sess-head"><div class="rzl-sess-id"><div class="rz-kicker">' + icon('play') + ' Séance · ' + esc(rubricLabel(L.rubric) || 'cours du jour') + ' · ' + esc(L.level) + '</div>'
      + '<div class="rzl-sess-name" lang="en">' + esc(L.title) + '</div></div>'
      + '<div class="rzl-sess-tools"><span class="rzl-clock' + (planned && spent > planned * 60 ? ' is-over' : '') + '" title="Temps passé / temps prévu — un repère, jamais une limite">' + icon('clock') + ' <b data-rzl-clock>' + esc(clock(spent)) + '</b><span> / ' + esc(planned) + ' min</span></span>'
      + (last ? '' : '<button type="button" class="btn btn-ghost" data-act="rz-lesson-skip" title="Passer sans pénalité">Passer cette étape</button>')
      + '<button type="button" class="btn btn-secondary" data-act="rz-lesson-quit" title="Quitter (Échap) — la séance reste reprenable">Quitter</button></div></header>');
    h.push(timelineHtml(d.steps, d, false));
    if (U.confirmQuit) {
      h.push('<div class="rzl-confirm" role="alertdialog"><span>Quitter la séance ? Tout est gardé : vous la reprendrez à cette étape.</span>'
        + '<button type="button" class="btn btn-primary" data-act="rz-lesson-quit-yes">Quitter <span class="rz-kbd">Entrée</span></button>'
        + '<button type="button" class="btn btn-secondary" data-act="rz-lesson-quit-no">Continuer <span class="rz-kbd">Échap</span></button></div>');
    }
    h.push('<section class="rz-card rzl-step rzl-step-' + esc(st) + '"><div class="rzl-step-head"><span class="rzl-step-n">Étape ' + (d.cur + 1) + ' sur ' + d.steps.length + '</span>'
      + '<span class="rzl-step-skill sk-' + esc(stepSkill(st)) + '">' + skillIcon(stepSkill(st)) + esc(stepLabel(st)) + '</span><span class="rzl-step-min">' + icon('clock') + ' ' + esc((step.minutes || 1) + ' min') + '</span></div>'
      + body + '</section>');
    h.push('<footer class="rzl-sess-foot">'
      + (d.cur > 0 ? '<button type="button" class="btn btn-ghost" data-act="rz-lesson-prev" title="Étape précédente (←)">' + icon('back') + ' ' + esc(stepLabel(d.steps[d.cur - 1].step)) + '</button>' : '<span></span>')
      + '<span class="rzl-foot-keys"><span class="rz-kbd">Entrée</span> valider · <span class="rz-kbd">1</span>–<span class="rz-kbd">4</span> choisir · <span class="rz-kbd">←</span><span class="rz-kbd">→</span> étapes · <span class="rz-kbd">Échap</span> quitter</span>'
      + (primary.act ? '<button type="button" class="btn btn-primary rz-big" data-act="' + esc(primary.act) + '" data-rzl-primary' + (primary.disabled ? ' disabled' : '') + '>' + esc(primary.label) + ' ' + icon(primary.icon || 'arrow') + '</button>' : '<span></span>')
      + '</footer>');
    h.push('</div>');
    return h.join('');
  }

  function renderStep(st, L, a, step) {
    switch (st) {
      case 'warmup': return warmupHtml(L, a);
      case 'reading': return readingHtml(L, a);
      case 'listening': return listeningHtml(L, a);
      case 'authenticAudio': return authenticHtml(L, a);
      case 'vocabulary': return vocabHtml(L, a);
      case 'grammar': return grammarHtml(L, a);
      case 'writing': return writingHtml(L, a);
      case 'speaking': return speakingHtml(L, a);
      case 'review': return reviewHtml(L, a);
    }
    return { html: '' };
  }

  function stepTitle(st, sub) { return '<h2 class="rzl-step-title">' + esc(STEPS[st].title) + '</h2>' + (sub ? '<p class="rzl-step-lead">' + sub + '</p>' : ''); }
  function sayBtn(text, label, accent) {
    return '<button type="button" class="rzl-mini" data-act="rz-lesson-say" data-text="' + esc(text) + '"' + (accent ? ' data-accent="' + esc(accent) + '"' : '') + ' title="Écouter">' + icon('speak') + (label ? ' ' + esc(label) : '') + '</button>';
  }

  /* ── Échauffement ── */
  function warmupHtml(L, a) {
    var d = sd(a), h = [];
    var srsRunning = srsOk() && U.srsStarted[a.id] && d.srsDone == null;
    if (srsRunning) {
      h.push(stepTitle('warmup', 'Quelques cartes à revoir avant d’attaquer : c’est le moment où la mémoire se consolide. Les nouvelles cartes du cours viendront au bilan.'));
      h.push('<div class="rzl-srs">' + srsHtml('lesson-warmup') + '</div>');
      return { html: h.join('') };
    }
    var reviewed = d.srsDone === -1 ? 'Révisions faites pendant la préparation.' : (num(d.srsDone, 0) > 0 ? plural(num(d.srsDone, 0), 'carte révisée', 'cartes révisées') + '.' : (U.srsStarted[a.id] ? 'Révisions écourtées : les cartes restantes reviendront.' : ''));
    h.push(stepTitle('warmup', esc(reviewed ? reviewed + ' Pour finir de vous mettre en route, répondez à voix haute — deux ou trois phrases, sans chercher la perfection.' : 'Rien à réviser aujourd’hui. Pour vous mettre en route, répondez à voix haute — deux ou trois phrases, sans chercher la perfection.')));
    if (reviewed) h.push('<div class="rzl-okline">' + icon('check') + ' ' + esc(reviewed) + '</div>');
    if (L.warmup.length) {
      h.push('<ol class="rzl-warm">' + L.warmup.map(function (q, i) {
        return '<li class="rzl-warm-q"><span class="rzl-warm-n">' + (i + 1) + '</span><span class="rzl-warm-t" lang="en">' + esc(q) + '</span>' + sayBtn(q, '', 'en-US') + '</li>';
      }).join('') + '</ol>');
      h.push('<div class="rz-callout">Personne ne vous écoute : parler, même seul, remet la langue en route. Pensez aux mots que vous aurez envie d’employer — le cours va vous en donner.</div>');
    }
    return { html: h.join('') };
  }

  /* ── Lecture ── */
  function termRegex(term) {
    var t = str(term).trim().replace(/^(to|a|an|the)\s+/i, '').replace(/[()…]/g, '').trim();
    if (t.length < 2) return null;
    var ws = t.split(/\s+/).slice(0, 5).map(function (w) {
      var base = w.toLowerCase().replace(/[^a-z'’-]/g, '');
      if (!base) return null;
      var stem = base.length > 3 ? base.replace(/(e|y)$/, '') : base;
      return stem.replace(/['’-]/g, '[-\'’]?') + '[a-z]{0,4}';
    });
    if (ws.some(function (w) { return !w; })) return null;
    try { return new RegExp('(^|[^A-Za-z])(' + ws.join('[\\s-]+') + ')(?![A-Za-z])', 'i'); } catch (e) { return null; }
  }
  function markGlossary(text, gloss, used) {
    var ranges = [];
    gloss.forEach(function (g, gi) {
      if (used[gi]) return;
      var re = termRegex(g.term);
      var m = re && re.exec(text);
      if (!m) return;
      var s = m.index + m[1].length, e = s + m[2].length;
      if (ranges.some(function (r) { return s < r.e && e > r.s; })) return;
      ranges.push({ s: s, e: e, gi: gi });
      used[gi] = true;
    });
    ranges.sort(function (x, y) { return x.s - y.s; });
    var out = '', pos = 0;
    ranges.forEach(function (r) { out += esc(text.slice(pos, r.s)) + glossSpan(text.slice(r.s, r.e), gloss[r.gi], r.gi); pos = r.e; });
    return out + esc(text.slice(pos));
  }
  function ipaOf(s) { s = str(s).trim(); return !s ? '' : (/^[\/\[]/.test(s) ? s : '/' + s + '/'); }
  function glossCard(g) {
    var pos = str(g.pos);
    return { kind: pos === 'collocation' ? 'collocation' : (pos === 'idiom' || pos === 'phrasal verb' ? 'phrase' : 'word'), front: g.term, back: g.meaningFr || g.meaningEn, example: g.example };
  }
  function glossSpan(txt, g, gi) {
    var open = U.gloss === gi;
    var a = act(), added = isAdded(g.term, a);
    var pop = '';
    if (open) {
      pop = '<span class="rzl-gl-pop" data-act="rz-lesson-noop" role="dialog" aria-label="' + esc(g.term) + '">'
        + '<span class="rzl-gl-top"><b lang="en">' + esc(g.term) + '</b>' + (g.ipa ? '<span class="rzl-ipa">' + esc(ipaOf(g.ipa)) + '</span>' : '') + (POS[g.pos] ? '<span class="rzl-pos">' + esc(POS[g.pos]) + '</span>' : '')
        + '<button type="button" class="rzl-x" data-act="rz-lesson-gloss" data-i="' + gi + '" aria-label="Fermer">' + icon('cross') + '</button></span>'
        + (g.meaningFr ? '<span class="rzl-gl-fr">' + esc(g.meaningFr) + '</span>' : '')
        + (g.meaningEn ? '<span class="rzl-gl-en" lang="en">' + esc(g.meaningEn) + '</span>' : '')
        + (g.example ? '<span class="rzl-gl-ex" lang="en">« ' + esc(g.example) + ' »</span>' : '')
        + '<span class="rzl-gl-act">' + sayBtn(g.term + '. ' + (g.example || ''), 'Écouter', readAccent())
        + (added ? '<span class="rzl-added">' + icon('check') + ' Dans vos cartes</span>' : '<button type="button" class="rzl-mini is-accent" data-act="rz-lesson-gloss-card" data-i="' + gi + '"' + (cardsOk() ? '' : ' disabled title="Les cartes de révision ne sont pas encore disponibles"') + '>' + icon('cards') + ' Ajouter aux cartes</button>')
        + '</span></span>';
    }
    return '<span class="rzl-gl' + (open ? ' is-open' : '') + (added ? ' is-added' : '') + '" data-act="rz-lesson-gloss" data-i="' + gi + '" tabindex="0" role="button" aria-expanded="' + open + '">'
      + esc(txt) + (open ? '' : '<span class="rzl-gl-tip" aria-hidden="true">' + esc(g.meaningFr || g.meaningEn) + '</span>') + pop + '</span>';
  }

  function readingHtml(L, a) {
    var rd = L.reading, key = 'rzl-read-' + a.id, used = {};
    var minutes = Math.max(1, Math.round(L.readingWords / 140));
    var h = [];
    h.push('<div class="rzl-read">');
    h.push('<article class="rzl-article" lang="en">');
    h.push('<div class="rzl-art-kicker">' + esc(rubricLabel(L.rubric)) + (L.readingWords ? ' · ' + esc(L.readingWords + ' mots · ≈ ' + minutes + ' min de lecture') : '') + '</div>');
    h.push('<h2 class="rzl-headline">' + esc(rd.headline || L.title) + '</h2>');
    if (rd.standfirst) h.push('<p class="rzl-standfirst">' + esc(rd.standfirst) + '</p>');
    h.push('<div class="rzl-art-tools" lang="fr">' + R.h.player(key, { label: 'Écouter le texte', source: function () {
      return R.tts.script(rd.paragraphs.map(function (p) { return { speaker: 'N', text: p }; }), [{ id: 'N', accent: readAccent(), gender: 'female' }], { key: key, gapMs: 650 });
    } }) + '<span class="rzl-art-hint">Les mots <span class="rzl-gl-demo">soulignés</span> ont leur traduction : survolez, cliquez pour l’ajouter à vos cartes.</span></div>');
    rd.paragraphs.forEach(function (p, i) { h.push('<p class="rzl-para" data-rz-say="' + esc(key) + '" data-rz-idx="' + i + '">' + markGlossary(p, rd.glossary, used) + '</p>'); });
    if (rd.credit) h.push('<div class="rzl-credit">' + esc(rd.credit) + '</div>');
    h.push(sourcesHtml(L).replace('class="rzl-sources"', 'class="rzl-sources" lang="fr"'));
    h.push('</article>');
    if (rd.glossary.length) {
      var d = sd(a);
      h.push('<aside class="rzl-glossary"><div class="rzl-side-title">Les mots du texte · ' + rd.glossary.length + '</div><ul>' + rd.glossary.map(function (g, gi) {
        var added = isAdded(g.term, a);
        return '<li class="rzl-gx' + (U.gloss === gi ? ' on' : '') + '"><button type="button" class="rzl-gx-t" data-act="rz-lesson-gloss" data-i="' + gi + '" lang="en">' + esc(g.term) + '</button>'
          + '<span class="rzl-gx-fr">' + esc(g.meaningFr) + '</span>'
          + (U.gloss === gi ? '<span class="rzl-gx-more">' + (g.ipa ? '<span class="rzl-ipa">' + esc(ipaOf(g.ipa)) + '</span> ' : '') + (g.example ? '<span lang="en">« ' + esc(g.example) + ' »</span> ' : '') + sayBtn(g.term + '. ' + (g.example || ''), '', readAccent()) + '</span>' : '')
          + (added ? '<span class="rzl-gx-ok" title="Dans vos cartes">' + icon('check') + '</span>' : '<button type="button" class="rzl-gx-add" data-act="rz-lesson-gloss-card" data-i="' + gi + '" title="Ajouter aux cartes" aria-label="Ajouter « ' + esc(g.term) + ' » aux cartes"' + (cardsOk() ? '' : ' disabled') + '>+</button>') + '</li>';
      }).join('') + '</ul></aside>');
    }
    h.push('</div>');
    var keys = orderOf(L, 'reading', a);
    if (keys.length) {
      h.push('<div class="rzl-qs"><div class="rzl-qs-head"><h3 class="rzl-h3">Avez-vous compris ?</h3><span class="rz-muted">Le sens général d’abord, puis les détails, puis ce qu’on devine entre les lignes.</span></div>');
      h.push(itemsBlock(L, a, keys) + scoreLine(scoreOf(a, keys)) + '</div>');
    }
    return { html: h.join('') };
  }

  /* ── Écoute ── */
  function listenPlayer(L, a) {
    var key = 'rzl-listen-' + a.id;
    return R.h.player(key, { label: 'Écouter', source: function () {
      var p = R.tts.script(L.listening.lines, L.listening.speakers, { key: key, gapMs: 420 });
      p.onChange(function (pp) {
        if (pp.state !== 'ended' || pp._rzlCounted) return;
        pp._rzlCounted = true;
        var a2 = act();
        if (!a2 || a2.id !== a.id) return;
        var ls = sd(a2).listen;
        ls.plays = num(ls.plays, 0) + 1;
        if (num(ls.phase, 0) < 2) ls.phase = Math.min(2, num(ls.phase, 0) + 1);
        persist(); R.renderSoon();
      });
      return p;
    } });
  }
  function listeningHtml(L, a) {
    var ls = L.listening, d = sd(a), ph = num(d.listen.phase, 0), key = 'rzl-listen-' + a.id;
    var h = [];
    h.push(stepTitle('listening'));
    h.push('<div class="rzl-listen">');
    h.push('<div class="rzl-listen-card"><div class="rzl-listen-top"><div><div class="rzl-art-kicker">' + esc({ dialogue: 'Dialogue', interview: 'Interview', report: 'Reportage', podcast: 'Podcast', phone_call: 'Appel téléphonique', debate: 'Débat', vox_pop: 'Micro-trottoir' }[ls.format] || 'Écoute') + '</div>'
      + (ls.title ? '<div class="rzl-listen-title" lang="en">' + esc(ls.title) + '</div>' : '') + '</div>'
      + '<div class="rzl-speakers">' + ls.speakers.map(function (s) { return '<span class="rzl-spk"><b>' + esc(s.name || s.id) + '</b>' + (s.role ? ' · <span lang="en">' + esc(s.role) + '</span>' : '') + ' · ' + esc(ACCENTS[s.accent] || s.accent) + '</span>'; }).join('') + '</div></div>');
    if (ls.contextFr) h.push('<p class="rzl-context">' + esc(ls.contextFr) + '</p>');
    h.push('<div class="rzl-listen-play">' + listenPlayer(L, a) + '<span class="rzl-listen-n">' + esc(ph === 0 ? 'Première écoute : le sens général. Qui parle, de quoi ?' : (ph === 1 ? 'Deuxième écoute : les détails.' : 'Réécoutez librement, à la vitesse qui vous va.')) + '</span></div>');
    h.push('</div>');
    var keys = orderOf(L, 'listening', a);
    var all = ls.questions.map(function (q, i) { return 'listen:' + i; });
    if (ph === 0) {
      h.push('<div class="rzl-locked">' + icon('ear') + '<div><b>Écoutez une première fois, sans lire.</b><div class="rz-muted">Les questions viennent après chaque écoute : d’abord le sens général, puis les détails.</div></div>'
        + '<button type="button" class="btn btn-ghost" data-act="rz-lesson-listen-show">Voir les questions maintenant</button></div>');
    } else {
      h.push('<div class="rzl-qs"><div class="rzl-qs-head"><h3 class="rzl-h3">' + esc(ph === 1 ? 'Le sens général' : 'Les questions') + '</h3>'
        + (ph === 1 ? '<button type="button" class="btn btn-ghost" data-act="rz-lesson-listen-show">Afficher toutes les questions</button>' : '') + '</div>');
      h.push(itemsBlock(L, a, keys));
      if (ph === 1) h.push('<div class="rzl-locked is-soft">' + icon('replay') + '<div><b>Réécoutez pour les détails.</b><div class="rz-muted">Les autres questions s’affichent à la fin de la deuxième écoute.</div></div></div>');
      else h.push(scoreLine(scoreOf(a, all)));
      h.push('</div>');
    }
    var sc = scoreOf(a, all);
    var reveal = d.listen.script || (ph >= 2 && sc.done === sc.total);
    if (reveal) {
      h.push('<div class="rzl-script"><div class="rzl-qs-head"><h3 class="rzl-h3">Le script</h3><span class="rz-muted">Réécoutez en lisant : la réplique en cours s’éclaire.</span></div><ol class="rzl-lines" lang="en">');
      var names = {};
      ls.speakers.forEach(function (s) { names[s.id] = s.name || s.id; });
      ls.lines.forEach(function (l, i) {
        if (!l.text.trim()) return;
        h.push('<li class="rzl-line" data-rz-say="' + esc(key) + '" data-rz-idx="' + i + '"><span class="rzl-line-who">' + esc(names[l.speaker] || l.speaker) + '</span><span class="rzl-line-t">' + esc(l.text) + '</span></li>');
      });
      h.push('</ol></div>');
    } else if (ph >= 1) {
      h.push('<div class="rzl-reveal"><button type="button" class="btn btn-ghost" data-act="rz-lesson-script">Afficher le script</button><span class="rz-muted">Il s’affiche de lui-même une fois les questions faites.</span></div>');
    }
    return { html: h.join('') };
  }

  /* ── Audio authentique ── */
  function authenticHtml(L, a) {
    var au = L.authenticAudio, key = 'rzl-auth-' + a.id;
    var h = [stepTitle('authenticAudio', 'De l’anglais tel qu’on le parle à la radio : ne cherchez pas à tout comprendre, attrapez l’essentiel.')];
    h.push('<div class="rzl-auth"><div class="rzl-art-kicker">' + esc([au.outlet, fmtPublished(au.published)].filter(Boolean).join(' · ')) + '</div>'
      + '<div class="rzl-listen-title" lang="en">' + esc(au.title) + '</div>'
      + (au.taskFr ? '<p class="rzl-context">' + esc(au.taskFr) + '</p>' : '')
      + '<div class="rzl-listen-play">' + R.h.player(key, { label: 'Écouter l’épisode', source: function () { return R.audio(au.audioUrl, { key: key }); } })
      + (/^https?:\/\//i.test(au.pageUrl) ? '<a class="btn btn-ghost" href="' + esc(au.pageUrl) + '" data-act="open-url" data-url="' + esc(au.pageUrl) + '">La page de l’émission ↗</a>' : '') + '</div></div>');
    if (au.questions.length) {
      h.push('<div class="rzl-qs"><h3 class="rzl-h3">En écoutant</h3><ol class="rzl-warm">' + au.questions.map(function (q, i) {
        return '<li class="rzl-warm-q"><span class="rzl-warm-n">' + (i + 1) + '</span><span class="rzl-warm-t" lang="en">' + esc(q) + '</span></li>';
      }).join('') + '</ol><div class="rz-muted">Répondez pour vous, à voix haute ou de tête : c’est un bonus, sans correction.</div></div>');
    }
    return { html: h.join('') };
  }

  /* ── Vocabulaire ── */
  function vocabHtml(L, a) {
    var h = [stepTitle('vocabulary', 'Les mots du texte et de l’écoute, réemployés ailleurs. Choisissez avec <span class="rz-kbd">1</span>–<span class="rz-kbd">4</span>, tapez quand il faut écrire.')];
    var n = 1, all = [];
    var map = itemsOf(L), d = sd(a), curK = null;
    orderOf(L, 'vocabulary', a).some(function (k) { if (!d.ans[k]) { curK = k; return true; } return false; });
    L.vocabulary.forEach(function (b, bi) {
      h.push('<div class="rzl-block"><div class="rzl-block-head"><span class="rzl-block-k">' + esc(VOCKIND[b.kind] || 'Exercice') + '</span><span class="rzl-block-i">' + esc(b.instructionFr) + '</span></div>');
      b.items.forEach(function (it, i) { var k = 'voc:' + bi + ':' + i; all.push(k); h.push(itemHtml(map[k], n++, a, k === curK)); });
      h.push('</div>');
    });
    h.push(scoreLine(scoreOf(a, all)));
    return { html: h.join('') };
  }

  /* ── Grammaire ── */
  function grammarHtml(L, a) {
    var g = L.grammar;
    var h = [stepTitle('grammar')];
    h.push('<div class="rzl-gram"><div class="rzl-gram-point" lang="en">' + esc(g.point || 'Grammar') + '</div>' + (g.explanationFr ? '<p class="rzl-gram-ex">' + esc(g.explanationFr) + '</p>' : '')
      + (g.examples.length ? '<div class="rzl-examples"><div class="rzl-side-title">Dans le cours</div><ul lang="en">' + g.examples.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '') + '</div>');
    var keys = orderOf(L, 'grammar', a);
    if (keys.length) h.push('<div class="rzl-qs"><h3 class="rzl-h3">À vous</h3>' + itemsBlock(L, a, keys) + scoreLine(scoreOf(a, keys)) + '</div>');
    return { html: h.join('') };
  }

  /* ── Écrit ── */
  function wordRange(w) {
    var m = /(\d{2,3})\s*(?:à|-|–|to)\s*(\d{2,3})\s*mots/i.exec(w.taskFr + ' ' + w.criteria.join(' '));
    if (m && +m[1] < +m[2]) return [+m[1], +m[2]];
    var n = w.words || 80;
    return [Math.max(20, Math.round(n * 0.85 / 5) * 5), Math.round(n * 1.2 / 5) * 5];
  }
  function wcInner(text, rg) {
    var n = R.text.count(text);
    var cls = n < rg[0] ? 'is-short' : (n > rg[1] ? 'is-long' : 'is-ok');
    return '<span class="rzl-wc-n ' + cls + '">' + esc(plural(n, 'mot')) + '</span><span class="rzl-wc-r">visé : ' + rg[0] + ' à ' + rg[1] + '</span>'
      + '<span class="rzl-wc-bar"><i class="' + cls + '" style="width:' + Math.min(100, n / rg[1] * 100).toFixed(1) + '%"></i><b style="left:' + (rg[0] / rg[1] * 100).toFixed(1) + '%"></b></span>';
  }
  function writingTask(L, a) {
    var w = L.writing, rg = wordRange(w);
    return { id: a.id + ':writing', kind: 'writing', promptFr: w.taskFr, prompt: '', criteria: w.criteria, scale: 5, words: rg, seconds: 0 };
  }
  function writingHtml(L, a) {
    var w = L.writing, d = sd(a), ws = d.write, rg = wordRange(w);
    var text = str(ws.text), g = obj(ws.grade);
    var job = U.grading.write ? R.jobById(U.grading.write) : null;
    var h = [stepTitle('writing')];
    h.push('<div class="rzl-task"><div class="rzl-task-k">' + icon('pen') + ' ' + esc((GENRES[w.genre] || 'texte') + ' · ' + rg[0] + ' à ' + rg[1] + ' mots') + '</div><p class="rzl-task-t">' + esc(w.taskFr) + '</p>'
      + (w.criteria.length ? '<ul class="rzl-criteria">' + w.criteria.map(function (c) { return '<li>' + icon('check') + '<span>' + esc(c) + '</span></li>'; }).join('') + '</ul>' : '') + '</div>');
    h.push('<div class="rzl-write">');
    h.push('<div class="rzl-editor"><textarea class="input rzl-textarea" rows="9" data-role="rz-lesson-write" data-dict="off" data-focus-key="rzl-write-' + esc(a.id) + '" spellcheck="false" autocomplete="off" lang="en" placeholder="Write here, in English…"' + (job ? ' readonly' : '') + '>' + esc(text) + '</textarea>'
      + '<div class="rzl-wc" data-rzl-wc>' + wcInner(text, rg) + '</div></div>');
    if (w.language.length) {
      h.push('<aside class="rzl-phrases"><div class="rzl-side-title">Tournures utiles</div><div class="rzl-phrase-list">' + w.language.map(function (p) {
        return '<button type="button" class="rzl-phrase" data-act="rz-lesson-insert" data-text="' + esc(p) + '" title="Insérer dans votre texte" lang="en">' + esc(p) + '</button>';
      }).join('') + '</div><div class="rz-muted">Un clic l’insère là où est le curseur.</div></aside>');
    }
    h.push('</div>');
    var primary = null;
    if (job) {
      h.push('<div class="rzl-grading">' + R.h.jobLine(job).replace('rz-job"', 'rz-job" title="Correction en cours"') + '<span class="rz-muted">Le correcteur relève 2 ou 3 erreurs prioritaires, sans toucher à ce qui est juste.</span></div>');
      primary = { act: 'rz-lesson-noop', label: 'Correction…', disabled: true, icon: 'pen' };
    } else if (U.gradeError.write) {
      h.push('<div class="rzl-error" role="alert"><div class="rzl-error-m">Correction impossible : ' + esc(U.gradeError.write) + '</div><div class="rz-row"><button type="button" class="btn btn-primary" data-act="rz-lesson-grade-write">' + icon('replay') + ' Réessayer</button></div></div>');
    }
    if (g) {
      h.push('<div class="rzl-fb-wrap"><h3 class="rzl-h3">Le retour du correcteur</h3>' + R.h.feedback(g, { response: str(ws.gradedText || text), mode: 'write' }) + '</div>');
      h.push(redoWriteHtml(g, ws));
      h.push(cardsPropHtml(g, 'write', a));
      if (str(ws.gradedText) !== text && text.trim() && !job) h.push('<div class="rz-row"><button type="button" class="btn btn-secondary" data-act="rz-lesson-grade-write">' + icon('pen') + ' Faire corriger la nouvelle version</button></div>');
    } else if (!job) {
      primary = { act: 'rz-lesson-grade-write', label: 'Faire corriger', icon: 'check' };
    }
    if (w.modelAnswer) {
      h.push(U.show.writeModel ? '<div class="rzl-model"><div class="rzl-side-title">Une réponse modèle <button type="button" class="btn btn-ghost" data-act="rz-lesson-toggle" data-k="writeModel">Masquer</button></div><p lang="en">' + esc(w.modelAnswer) + '</p></div>'
        : '<div class="rzl-reveal"><button type="button" class="btn btn-ghost" data-act="rz-lesson-toggle" data-k="writeModel">Voir la réponse modèle</button>' + (g ? '' : '<span class="rz-muted">Mieux vaut écrire d’abord : la comparaison n’en sera que plus parlante.</span>') + '</div>');
    }
    if (!g && !job) h.push('<div class="rz-muted rzl-under">Écrivez sans dictionnaire ni correcteur : <span class="rz-kbd">Ctrl</span> + <span class="rz-kbd">Entrée</span> envoie à la correction.</div>');
    return { html: h.join(''), primary: primary };
  }
  function redoWriteHtml(g, ws) {
    if (!g.redo) return '';
    var r = obj(ws.redo);
    var h = '<div class="rzl-redo"><div class="rzl-redo-k">' + icon('replay') + ' À vous : réécrivez la phrase corrigée, de mémoire si vous pouvez</div>'
      + (U.show.redoHide && !(r && r.r !== 'wrong') ? '<div class="rzl-redo-s is-hidden">Phrase masquée — <button type="button" class="btn btn-ghost" data-act="rz-lesson-toggle" data-k="redoHide">la revoir</button></div>'
        : '<div class="rzl-redo-s" lang="en">' + esc(g.redo) + (r && r.r !== 'wrong' ? '' : ' <button type="button" class="btn btn-ghost" data-act="rz-lesson-toggle" data-k="redoHide">Masquer pour l’écrire de mémoire</button>') + '</div>');
    if (r && r.r !== 'wrong') return h + '<div class="rzl-ifb is-ok">' + icon('check') + '<div><b>' + esc(r.r === 'exact' ? 'Parfait : c’est la bonne phrase.' : 'Presque parfait — une lettre près.') + '</b></div></div></div>';
    h += '<div class="rzl-redo-row"><input class="input rzl-in is-wide" type="text" data-role="rz-lesson-redo" data-focus-key="rzl-redo-write" value="' + esc(U.drafts.redo != null ? U.drafts.redo : '') + '" spellcheck="false" autocomplete="off" lang="en" data-dict="off" placeholder="Retapez la phrase…">'
      + '<button type="button" class="btn btn-secondary" data-act="rz-lesson-redo-check">' + icon('check') + ' Vérifier</button></div>';
    if (r && r.r === 'wrong') h += '<div class="rzl-ifb is-bad">' + icon('cross') + '<div><b>Pas tout à fait :</b><div class="rz-diff">' + R.h.diff(r.v, g.redo) + '</div></div></div>';
    return h + '</div>';
  }
  function proposedCards(g) {
    var out = [], seen = {};
    if (R.cards && typeof R.cards.fromEdits === 'function') {
      try { arr(R.cards.fromEdits(arr(g && g.edits), 3)).forEach(function (c) { if (c && c.front && c.back) out.push(c); }); } catch (e) { /* forme inattendue */ }
    } else {
      arr(g && g.edits).forEach(function (e) {
        if (!e || e.type === 'improvement' || !e.correction || !e.original) return;
        out.push({ kind: cardKindOf(e.category), front: e.original, back: e.correction, example: '', note: e.explanationFr || '' });
      });
    }
    arr(g && g.cards).forEach(function (c) { if (c && c.front && c.back) out.push({ kind: c.kind || 'phrase', front: str(c.front), back: str(c.back), example: str(c.example) }); });
    return out.filter(function (c) { if (seen[c.front]) return false; seen[c.front] = 1; return true; }).slice(0, 8);
  }
  function cardsPropHtml(g, src, a) {
    var list = proposedCards(g);
    if (!list.length) return '';
    var left = list.filter(function (c) { return !isAdded(c.front, a); }).length;
    return '<div class="rzl-cardprop"><div class="rzl-qs-head"><h3 class="rzl-h3">À mettre en cartes</h3>'
      + (left ? '<button type="button" class="btn btn-secondary" data-act="rz-lesson-cards-all" data-src="' + src + '"' + (cardsOk() ? '' : ' disabled title="Les cartes de révision ne sont pas encore disponibles"') + '>' + icon('cards') + ' Tout ajouter · ' + left + '</button>' : '<span class="rzl-added">' + icon('check') + ' Toutes dans vos cartes</span>') + '</div>'
      + '<ul class="rzl-cp-list">' + list.map(function (c, i) {
        var on = isAdded(c.front, a);
        return '<li class="rzl-cp' + (on ? ' is-added' : '') + '"><span class="rzl-cp-f">' + (c.kind === 'error' ? '<span class="rz-cat">à corriger</span> ' : '') + esc(c.front) + '</span>' + icon('arrow') + '<span class="rzl-cp-b" lang="en">' + esc(c.back) + '</span>'
          + (on ? '<span class="rzl-added">' + icon('check') + '</span>' : '<button type="button" class="rzl-gx-add" data-act="rz-lesson-card" data-src="' + src + '" data-i="' + i + '" title="Ajouter aux cartes" aria-label="Ajouter aux cartes"' + (cardsOk() ? '' : ' disabled') + '>+</button>') + '</li>';
      }).join('') + '</ul></div>';
  }

  /* ── Oral ── */
  function prepInner(a) {
    var until = U.prepUntil[a.id] || 0;
    var left = Math.ceil((until - Date.now()) / 1000);
    if (left > 0) return '<span class="rzl-prep-k">Préparation</span><span class="rzl-prep-v">' + esc(clock(left)) + '</span><button type="button" class="btn btn-ghost" data-act="rz-lesson-prep-skip">Passer</button>';
    return '<span class="rzl-prep-k is-go">' + icon('mic') + ' À vous : parlez</span>';
  }
  function speakingHtml(L, a) {
    var s = L.speaking, d = sd(a), sp = d.speak, rec = obj(sp.rec), g = obj(sp.grade);
    var job = U.grading.speak ? R.jobById(U.grading.speak) : null;
    var maxMs = Math.round(s.speakSeconds * 1.5) * 1000;
    var h = [stepTitle('speaking')];
    h.push('<div class="rzl-task"><div class="rzl-task-k">' + icon('speak') + ' ' + esc('Environ ' + R.fmtDur(s.speakSeconds) + ' de parole') + '</div><p class="rzl-task-t">' + esc(s.taskFr) + '</p>'
      + (s.prompts.length ? '<ul class="rzl-prompts" lang="en">' + s.prompts.map(function (p) { return '<li><span>' + esc(p) + '</span>' + sayBtn(p, '', 'en-US') + '</li>'; }).join('') + '</ul>' : '') + '</div>');
    h.push('<div class="rzl-speak-box">');
    if (!rec && U.prepUntil[a.id]) h.push('<div class="rzl-prep" data-rzl-prep>' + prepInner(a) + '</div>');
    h.push('<div class="rzl-mic">' + R.h.rec('rzl-speak-' + a.id, { maxMs: maxMs, label: 'Parler · ' + R.fmtDur(s.speakSeconds), againLabel: 'Recommencer', stt: { keep: true }, onStart: function () { U.prepUntil[a.id] = 0; }, onResult: function (r) { onSpeakResult(a.id, r); } })
      + '<span class="rz-muted">' + (rec ? 'Un nouvel enregistrement remplace le précédent.' : '<span class="rz-kbd">Espace</span> pour commencer et finir. Jusqu’à ' + esc(R.fmtDur(maxMs / 1000)) + '.') + '</span></div>');
    h.push('</div>');
    if (s.language.length) h.push('<div class="rzl-phrase-list is-inline"><span class="rzl-k">Pour vous aider</span>' + s.language.map(function (p) { return '<span class="rz-phrase" lang="en">' + esc(p) + '</span>'; }).join('') + '</div>');
    var primary = null;
    if (rec) {
      h.push(transcriptHtml(rec, s, a));
      if (job) {
        h.push('<div class="rzl-grading">' + R.h.jobLine(job) + '<span class="rz-muted">Le correcteur lit ce que Whisper a compris ; il ne juge pas l’accent.</span></div>');
        primary = { act: 'rz-lesson-noop', label: 'Correction…', disabled: true, icon: 'speak' };
      } else if (U.gradeError.speak) {
        h.push('<div class="rzl-error" role="alert"><div class="rzl-error-m">Correction impossible : ' + esc(U.gradeError.speak) + '</div><div class="rz-row"><button type="button" class="btn btn-primary" data-act="rz-lesson-grade-speak">' + icon('replay') + ' Réessayer</button></div></div>');
      } else if (!g && rec.text.trim()) primary = { act: 'rz-lesson-grade-speak', label: 'Faire corriger', icon: 'check' };
    }
    if (g && rec) {
      h.push('<div class="rzl-fb-wrap"><h3 class="rzl-h3">Le retour du correcteur</h3>' + R.h.feedback(g, { response: rec.text, mode: 'speak' }) + '</div>');
      if (g.redo) {
        var rd = obj(sp.redo);
        h.push('<div class="rzl-redo"><div class="rzl-redo-k">' + icon('replay') + ' À vous : redites la phrase corrigée</div><div class="rzl-redo-s" lang="en">' + esc(g.redo) + ' ' + sayBtn(g.redo, 'Modèle', 'en-US') + '</div>'
          + '<div class="rzl-mic">' + R.h.rec('rzl-redo-' + a.id, { maxMs: 20000, label: 'Redire', againLabel: 'Redire encore', stt: { reference: g.redo }, onResult: function (r) { onRedoResult(a.id, r); } }) + '</div>'
          + (rd ? accuracyHtml(rd, g.redo) : '') + '</div>');
      }
      if (s.pronunciation.length) {
        h.push('<div class="rzl-shadow"><h3 class="rzl-h3">Les mots à bien prononcer</h3><div class="rz-muted">Écoutez, répétez : Whisper dit ce qu’il a entendu. Un mot reconnu n’est pas une prononciation parfaite, mais un mot mal reconnu est un vrai signal.</div><ul class="rzl-pron">');
        s.pronunciation.forEach(function (p, i) {
          var pr = obj(sp.pron[i]);
          h.push('<li class="rzl-pron-row"><div class="rzl-pron-w"><b lang="en">' + esc(p.word) + '</b>' + (p.ipa ? '<span class="rzl-ipa">' + esc(ipaOf(p.ipa)) + '</span>' : '') + '</div>'
            + '<div class="rzl-pron-tip">' + esc(p.tipFr) + '</div><div class="rzl-pron-act">' + sayBtn(p.word + '. ' + p.word + '.', 'Écouter', 'en-GB')
            + R.h.rec('rzl-pron-' + a.id + '-' + i, { maxMs: 6000, label: 'Répéter', againLabel: 'Encore', stt: { reference: p.word }, onResult: function (r) { onPronResult(a.id, i, r); } })
            + (pr ? '<span class="rzl-acc ' + accClass(pr.accuracy) + '">« ' + esc(pr.text || '…') + ' » · ' + esc(pct(pr.accuracy)) + '</span>' : '') + '</div></li>');
        });
        h.push('</ul></div>');
      }
      h.push(cardsPropHtml(g, 'speak', a));
    }
    if (s.modelAnswer) {
      h.push(U.show.speakModel ? '<div class="rzl-model"><div class="rzl-side-title">Ce qu’une bonne réponse pourrait dire ' + sayBtn(s.modelAnswer, 'Écouter', 'en-GB') + ' <button type="button" class="btn btn-ghost" data-act="rz-lesson-toggle" data-k="speakModel">Masquer</button></div><p lang="en">' + esc(s.modelAnswer) + '</p></div>'
        : '<div class="rzl-reveal"><button type="button" class="btn btn-ghost" data-act="rz-lesson-toggle" data-k="speakModel">Voir une réponse modèle</button></div>');
    }
    return { html: h.join(''), primary: primary };
  }
  function accClass(x) { x = num(x, 0); return x >= 0.85 ? 'is-ok' : (x >= 0.6 ? 'is-close' : 'is-bad'); }
  function accuracyHtml(rd, ref) {
    var ops = arr(rd.ops);
    var line = ops.length ? ops.map(function (o) {
      if (o.op === 'ok') return '<span class="rzl-w is-ok">' + esc(o.ref) + '</span>';
      if (o.op === 'sub') return '<span class="rzl-w is-sub" title="Entendu : « ' + esc(o.hyp) + ' »">' + esc(o.ref) + '</span>';
      if (o.op === 'del') return '<span class="rzl-w is-del" title="Non entendu">' + esc(o.ref) + '</span>';
      return '';
    }).join(' ') : esc(rd.text);
    return '<div class="rzl-accline"><span class="rzl-acc ' + accClass(rd.accuracy) + '">' + esc(pct(rd.accuracy)) + ' des mots reconnus</span><span class="rzl-acc-words" lang="en">' + line + '</span></div>';
  }
  function transcriptHtml(rec, s, a) {
    var words = arr(rec.words);
    var body = words.length ? words.map(function (w) {
      var t = str(w[0]), p = num(w[1], 1);
      return p < 0.5 ? '<span class="rzl-unsure" title="Mot peu sûr : Whisper a hésité (' + Math.round(p * 100) + ' %)">' + esc(t) + '</span>' : esc(t);
    }).join(' ') : esc(rec.text);
    var unsure = words.filter(function (w) { return num(w[1], 1) < 0.5; }).length;
    var wpm = Math.round(num(rec.wpm, 0));
    var pace = !wpm ? '' : (wpm < 90 ? 'posé — l’aisance viendra' : (wpm < 150 ? 'naturel' : 'rapide'));
    var h = '<div class="rzl-transcript"><div class="rzl-side-title">Ce que Whisper a compris' + (rec.url && /^https?:/i.test(rec.url) && !R.ui.rec['rzl-speak-' + a.id] ? ' ' + R.h.player('rzl-me-' + a.id, { label: 'Me réécouter', small: true, speeds: false, source: function () { return R.audio(rec.url, { key: 'rzl-me-' + a.id }); } }) : '') + '</div>';
    if (!str(rec.text).trim()) return h + '<p class="rz-err-line">Whisper n’a rien entendu. Rapprochez-vous du micro et recommencez.</p></div>';
    h += '<p class="rzl-tr-text" lang="en">' + body + '</p><div class="rzl-metrics">'
      + '<span>' + icon('clock') + ' ' + esc(R.fmtDur(rec.seconds || rec.duration)) + (s.speakSeconds ? ' sur ' + esc(R.fmtDur(s.speakSeconds)) + ' visées' : '') + '</span>'
      + (wpm ? '<span>' + esc(wpm + ' mots/min · ' + pace) + '</span>' : '')
      + '<span>' + esc(plural(num(rec.pauses, 0), 'pause')) + '</span>'
      + (unsure ? '<span class="rzl-unsure-k">' + esc(plural(unsure, 'mot peu sûr', 'mots peu sûrs')) + ' — à articuler</span>' : '') + '</div>'
      + '<div class="rz-muted">Whisper lisse parfois les erreurs : le correcteur juge les mots, pas l’accent.</div></div>';
    return h;
  }
  function onSpeakResult(id, r) {
    var a = act();
    if (!a || a.id !== id) return;
    var sp = sd(a).speak, t = obj(r && r.stt) || {};
    var words = arr(t.words).slice(0, 600).map(function (w) { return [str(w.text).trim(), Math.round(num(w.pMin != null ? w.pMin : w.p, 1) * 100) / 100]; }).filter(function (w) { return w[0]; });
    sp.rec = { text: str(t.text).trim(), words: words, wpm: Math.round(num(t.wpm, 0)), seconds: Math.round(num(t.speechSeconds, 0) * 10) / 10 || Math.round(num(r.audio && r.audio.seconds, 0)),
      duration: Math.round(num(r.audio && r.audio.seconds, 0) * 10) / 10, pauses: arr(t.pauses).length, url: str(t.url), at: Date.now() };
    sp.grade = null; sp.redo = null; sp.pron = {};
    U.prepUntil[id] = 0; delete U.gradeError.speak;
    persist();
  }
  function onRedoResult(id, r) {
    var a = act();
    if (!a || a.id !== id) return;
    var t = obj(r && r.stt) || {}, al = obj(t.alignment);
    sd(a).speak.redo = { text: str(t.text), accuracy: al ? num(al.accuracy, 0) : (R.text.match(t.text, (sd(a).speak.grade || {}).redo) === 'wrong' ? 0.5 : 1),
      ops: al ? arr(al.ops).slice(0, 80).map(function (o) { return { op: str(o.op), ref: str(o.ref), hyp: str(o.hyp) }; }) : [] };
    persist();
  }
  function onPronResult(id, i, r) {
    var a = act();
    if (!a || a.id !== id) return;
    var t = obj(r && r.stt) || {}, al = obj(t.alignment);
    sd(a).speak.pron[i] = { text: str(t.text).trim(), accuracy: al ? num(al.accuracy, 0) : 0 };
    persist();
  }

  /* ── Bilan ── */
  function addLessonCards(a) {
    var d = sd(a);
    if (d.cardsAdded != null) return;
    var L = shape(docOf(a.id));
    if (!L || !L.cards.length || !R.cards || typeof R.cards.addMany !== 'function') return;
    try {
      var r = R.cards.addMany(L.cards.map(function (c) { return { kind: c.kind, front: c.front, back: c.back, example: c.example }; }), { kind: 'lesson', ref: a.id });
      d.cardsAdded = typeof r === 'number' ? r : (Array.isArray(r) ? r.length : (obj(r) && r.added != null ? num(r.added, 0) : L.cards.length));
      L.cards.forEach(function (c) { d.added[c.front] = 1; });
      persist();
    } catch (e) { if (window.console) console.warn('[revizator] cards.addMany', e); }
  }
  function summaryOf(L, a) {
    var d = sd(a), map = itemsOf(L), by = { read: [0, 0], listen: [0, 0], lang: [0, 0] }, x = 0, n = 0;
    Object.keys(map).forEach(function (k) {
      var it = map[k], s = d.ans[k];
      if (!s || !by[it.skill]) return;
      by[it.skill][1]++; n++;
      if (s.r !== 'wrong') by[it.skill][0]++;
      x += s.r === 'exact' ? 1 : (s.r === 'close' ? 0.75 : 0);
    });
    var sm = { read: 0, listen: 0, write: 0, speak: 0, lang: 0, srs: 0 };
    Object.keys(d.t).forEach(function (st) { var sk = stepSkill(st); sm[sk] = num(sm[sk], 0) + num(d.t[st], 0) / 60; });
    var cur = curStep(a);
    if (act() === a && U.acc) sm[stepSkill(cur)] += U.acc / 60;
    var cards = num(d.cardsAdded, 0) + num(d.cardsMore, 0);
    return { by: by, score: n ? Math.round(x / n * 100) / 100 : null, right: by.read[0] + by.listen[0] + by.lang[0], total: n, skillMinutes: sm,
      minutes: Math.round(elapsed(a) / 6) / 10, cards: cards,
      write: d.write.grade && d.write.grade.levelEstimate || '', speak: d.speak.grade && d.speak.grade.levelEstimate || '' };
  }
  function reviewHtml(L, a) {
    var d = sd(a), rv = d.review, sum = summaryOf(L, a);
    var h = [stepTitle('review', 'Dernière minute : ce que vous retenez, ce que vous en pensez, et le sujet du prochain cours.')];
    h.push('<div class="rzl-review">');
    h.push('<div class="rzl-rv-col"><div class="rzl-rv-block"><div class="rzl-side-title">Trois choses retenues <span class="rz-muted">· facultatif, sans regarder</span></div>'
      + '<textarea class="input rzl-recall" rows="3" data-role="rz-lesson-recall" data-focus-key="rzl-recall-' + esc(a.id) + '" placeholder="Un mot, une tournure, une idée… en anglais ou en français">' + esc(rv.recall || '') + '</textarea></div>');
    h.push('<div class="rzl-rv-block"><div class="rzl-side-title">Ce cours était…</div>' + R.h.chips('rzl-self', ['easy', 'ok', 'hard'], rv.self || '', ['Facile', 'Juste comme il faut', 'Difficile'], 'rz-lesson-self') + '</div>');
    var by = sum.by;
    var rows = [];
    [['read', 'Lecture'], ['listen', 'Écoute'], ['lang', 'Vocabulaire et grammaire']].forEach(function (x) {
      if (by[x[0]][1]) rows.push('<li>' + R.h.skill(x[0], false) + '<span>' + esc(x[1]) + '</span><b>' + by[x[0]][0] + ' / ' + by[x[0]][1] + '</b></li>');
    });
    if (sum.write) rows.push('<li>' + R.h.skill('write', false) + '<span>Écrit</span>' + R.h.level(sum.write) + '</li>');
    if (sum.speak) rows.push('<li>' + R.h.skill('speak', false) + '<span>Oral</span>' + R.h.level(sum.speak) + '</li>');
    h.push('<div class="rzl-rv-block"><div class="rzl-side-title">Votre séance</div><div class="rzl-stats is-small">' + statHtml(clock(elapsed(a)), 'temps passé')
      + statHtml(sum.score == null ? '—' : pct(sum.score), 'de bonnes réponses') + statHtml(sum.cards, sum.cards > 1 ? 'cartes' : 'carte') + '</div>'
      + (rows.length ? '<ul class="rzl-rv-skills">' + rows.join('') + '</ul>' : '') + '</div>');
    if (L.cards.length) {
      h.push('<div class="rzl-rv-block"><div class="rzl-side-title">' + (d.cardsAdded != null ? icon('check') + ' ' + esc(plural(L.cards.length, 'carte ajoutée', 'cartes ajoutées') + ' à vos révisions') : esc('Les cartes du cours · ' + L.cards.length)) + '</div><div class="rzl-cardchips" lang="en">'
        + L.cards.map(function (c) { return '<span class="rzl-cardchip" title="' + esc(c.back) + '">' + esc(c.front) + '</span>'; }).join('') + '</div>'
        + (d.cardsAdded == null ? '<div class="rz-muted">' + esc(cardsOk() ? 'Elles rejoindront vos révisions.' : 'Elles rejoindront vos révisions dès que le module des cartes sera là.') + '</div>' : '<div class="rz-muted">Premières révisions dès demain, au début de la prochaine séance.</div>') + '</div>');
    }
    h.push('</div>');
    h.push('<div class="rzl-rv-col is-next"><div class="rzl-side-title">Le prochain cours portera sur…</div>');
    var ch = rv.next != null ? rv.next : (L.nextTopics.length ? null : 'surprise');
    h.push(topicCards(L.nextTopics, ch === 'custom' ? null : (ch === 'surprise' ? 'surprise' : (ch == null ? null : num(ch, -1))), 'rz-lesson-review-next'));
    h.push('<div class="rzl-custom' + (ch === 'custom' ? ' on' : '') + '"><span class="rzl-k">Autre sujet…</span><input class="input" type="text" data-role="rz-lesson-review-custom" data-focus-key="rzl-review-custom" value="' + esc(rv.custom || '') + '" maxlength="160" placeholder="Le Tour de France, la sobriété numérique, les pubs anglais…"></div>');
    h.push('</div></div>');
    return { html: h.join(''), primary: { act: 'rz-lesson-finish', label: 'Terminer la séance', icon: 'check' } };
  }

  function finish() {
    var a = act();
    if (!a) { R.go('home'); return; }
    flush();
    var L = shape(docOf(a.id));
    var d = sd(a), rv = d.review, now = Date.now();
    if (L) addLessonCards(a);
    var sum = L ? summaryOf(L, a) : { skillMinutes: {}, score: null, minutes: 0, cards: 0, by: {}, right: 0, total: 0 };
    var e = entry(a.id);
    R.logSession({ kind: 'lesson', ref: a.id, title: (L && L.title) || (e && e.title) || '', startedAt: num(a.startedAt, now), endedAt: now, skillMinutes: sum.skillMinutes, score: sum.score });
    if (e) {
      e.status = 'done'; e.doneAt = now;
      e.result = { score: sum.score, right: sum.right, total: sum.total, minutes: sum.minutes, cards: sum.cards, self: rv.self || '',
        skills: { read: sum.by.read, listen: sum.by.listen, lang: sum.by.lang }, write: sum.write || '', speak: sum.speak || '' };
      if (rv.recall) e.result.recall = str(rv.recall).slice(0, 600);
    }
    var nt = null;
    if (rv.next === 'custom' && str(rv.custom).trim()) { var c = str(rv.custom).trim().slice(0, 160); nt = { title: c, query: c, rubric: '', pitchFr: '', tone: '', at: now }; }
    else if (L && rv.next != null && rv.next !== 'surprise' && L.nextTopics[num(rv.next, -1)]) { var t = L.nextTopics[num(rv.next, -1)]; nt = { title: t.title, query: t.query, rubric: t.rubric, pitchFr: t.pitchFr, tone: t.tone, at: now }; }
    if (rv.next != null || nt) R.data.nextTopic = nt;
    R.tts.stopAll();
    R.setActive(null);
    U.acc = 0; U.confirmQuit = false; U.prepUntil = {}; U.drafts = {}; U.show = {}; U.topicMode = null; U.topicOpen = false; U.custom = '';
    R.save(true);
    R.go('home');
    R.toast('Séance terminée — ' + Math.max(1, Math.round(sum.minutes)) + ' min' + (sum.score != null ? ', ' + pct(sum.score) + ' de bonnes réponses' : '') + '. À demain !');
  }

  /* ══ Correction de l'écrit et de l'oral ═════════════════════════════════ */

  function pushAttempt(o) {
    R.data.attempts.push({ id: R.uid('at'), at: Date.now(), mode: o.mode, ref: o.ref, task: str(o.task).slice(0, 600), response: str(o.response).slice(0, 4000), url: o.url || '', metrics: o.metrics || null, grade: o.grade });
  }
  function targets() { return R.weakPoints(4).map(function (w) { return w.category; }); }

  function gradeWriting() {
    var a = act();
    if (!a || U.grading.write) return;
    var L = shape(docOf(a.id));
    if (!L) return;
    var ws = sd(a).write, text = str(ws.text).trim();
    if (R.text.count(text) < 5) { R.toast('Écrivez au moins une ou deux phrases avant de demander la correction.'); return; }
    var job = R.uid('rzgrw'), id = a.id, startedAt = a.startedAt;
    U.grading.write = job; delete U.gradeError.write;
    R.gen('grade', { mode: 'write', rubric: 'lesson', task: writingTask(L, a), response: text, metrics: null, level: L.level, targets: targets() }, { job: job }).then(function (r) {
      delete U.grading.write;
      var g = r && r.doc;
      var a2 = act();
      if (!g || !a2 || a2.id !== id || a2.startedAt !== startedAt) { R.render(); return; }
      var w = sd(a2).write;
      w.grade = g; w.gradedText = text; w.gradedAt = Date.now(); w.redo = null;
      U.drafts.redo = '';
      R.addErrors(g.edits, { mode: 'write', ref: id });
      if (g.levelEstimate) R.observeLevel('write', g.levelEstimate);
      pushAttempt({ mode: 'write', ref: id, task: L.writing.taskFr, response: text, grade: g });
      persist(); R.render();
    }, function (e) { delete U.grading.write; U.gradeError.write = e.message; R.render(); });
    R.render();
  }

  function gradeSpeaking() {
    var a = act();
    if (!a || U.grading.speak) return;
    var L = shape(docOf(a.id));
    var sp = sd(a).speak, rec = obj(sp.rec);
    if (!L || !rec || !rec.text.trim()) return;
    var uncertain = arr(rec.words).filter(function (w) { return num(w[1], 1) < 0.5; }).map(function (w) { return w[0]; }).slice(0, 30);
    var metrics = { seconds: num(rec.seconds || rec.duration, 0), wpm: num(rec.wpm, 0), pauses: num(rec.pauses, 0), uncertain: uncertain };
    var task = { id: a.id + ':speaking', kind: 'speaking', promptFr: L.speaking.taskFr, prompt: L.speaking.prompts.join(' '), criteria: [], scale: 5, words: [0, 0], seconds: L.speaking.speakSeconds };
    var job = R.uid('rzgrs'), id = a.id, startedAt = a.startedAt;
    U.grading.speak = job; delete U.gradeError.speak;
    R.gen('grade', { mode: 'speak', rubric: 'lesson', task: task, response: rec.text, metrics: metrics, level: L.level, targets: targets() }, { job: job }).then(function (r) {
      delete U.grading.speak;
      var g = r && r.doc;
      var a2 = act();
      if (!g || !a2 || a2.id !== id || a2.startedAt !== startedAt) { R.render(); return; }
      var s2 = sd(a2).speak;
      s2.grade = g; s2.redo = null;
      R.addErrors(g.edits, { mode: 'speak', ref: id });
      if (g.levelEstimate) R.observeLevel('speak', g.levelEstimate);
      pushAttempt({ mode: 'speak', ref: id, task: L.speaking.taskFr, response: rec.text, url: rec.url, metrics: metrics, grade: g });
      persist(); R.render();
    }, function (e) { delete U.grading.speak; U.gradeError.speak = e.message; R.render(); });
    R.render();
  }

  /* ══ Actions ════════════════════════════════════════════════════════════ */

  function attr(el, n) { return el && el.getAttribute ? el.getAttribute(n) : null; }

  R.act('rz-lesson-noop', function () { /* absorbe le clic (bulle de glose) */ });
  R.act('rz-lesson-minutes', function (el) { U.minutes = +attr(el, 'data-value') || 20; R.render(); });
  R.act('rz-lesson-topic-open', function () { U.topicOpen = !U.topicOpen; R.render(); });
  R.act('rz-lesson-topic', function (el) { U.topicMode = attr(el, 'data-value'); U.custom = ''; U.topicOpen = false; R.render(); });
  R.input('rz-lesson-custom', function (el) { U.custom = el.value.slice(0, 160); U.topicMode = U.custom.trim() ? 'custom' : null; });
  R.act('rz-lesson-prepare', function (el) { prepare({ srs: attr(el, 'data-srs') === '1' }); });
  R.act('rz-lesson-prep-srs', function () {
    if (!srsOk()) return;
    U.prepSrs = true; U.prepSrsDone = false;
    startPrepSrs();
    R.render();
  });
  R.act('rz-lesson-again', function () { var t = todayEntry(); prepare({ anotherTopic: true, minutes: t && t.minutes }); });
  R.act('rz-lesson-retry', function () {
    var p = U.error && U.error.params;
    U.error = null;
    prepare(p ? { minutes: p.minutes, topic: p.topic || null, timeless: !!p.timeless } : {});
  });
  R.act('rz-lesson-timeless', function () { var p = U.error && U.error.params; U.error = null; prepare({ minutes: p && p.minutes, timeless: true }); });
  R.act('rz-lesson-error-close', function () { U.error = null; R.render(); });
  R.act('rz-lesson-cancel', function (el) {
    var job = attr(el, 'data-job') || (R.jobOf('lesson') || {}).job;
    if (!job) return;
    U.cancelled[job] = true;
    el.disabled = true;
    R.cancel(job).then(function (r) { if (!r || !r.cancelled) { delete U.cancelled[job]; R.toast('La préparation ne s’est pas laissé interrompre : elle va finir.'); } });
  });
  R.act('rz-lesson-start', function (el) { startLesson(attr(el, 'data-id')); });
  R.act('rz-lesson-resume', resume);
  R.act('rz-lesson-abandon', function () {
    if (!U.abandonArm) { U.abandonArm = true; R.render(); setTimeout(function () { if (U.abandonArm) { U.abandonArm = false; R.renderSoon(); } }, 5000); return; }
    U.abandonArm = false;
    var a = act();
    if (!a) return;
    flush();
    var e = entry(a.id);
    if (e && e.status === 'active') e.status = 'ready';
    R.setActive(null); R.save(true); R.render();
    R.toast('Séance abandonnée. Le cours reste dans « Cours précédents ».');
  });
  R.act('rz-lesson-drop', function () { var a = act(); if (a) { var e = entry(a.id); if (e && e.status === 'active') e.status = 'ready'; } R.setActive(null); R.save(true); R.go('home'); });
  R.act('rz-lesson-more', function () { U.forceIdle = true; R.render(); });
  R.act('rz-lesson-unforce', function () { U.forceIdle = false; R.render(); });
  R.act('rz-lesson-prev-all', function () { U.prevAll = !U.prevAll; R.render(); });
  R.act('rz-lesson-next-pick', function (el) {
    var t = todayEntry(), L = t && shape(docOf(t.id)), i = attr(el, 'data-i');
    if (i === 'surprise') R.data.nextTopic = null;
    else if (L && L.nextTopics[+i]) { var x = L.nextTopics[+i]; R.data.nextTopic = { title: x.title, query: x.query, rubric: x.rubric, pitchFr: x.pitchFr, tone: x.tone, at: Date.now() }; }
    U.topicMode = null; R.save(); R.render();
  });

  /* Séance */
  R.act('rz-lesson-next', function () { nextStep(false); });
  R.act('rz-lesson-skip', function () { nextStep(true); });
  R.act('rz-lesson-prev', function () { var a = act(); if (a) goStep(sd(a).cur - 1); });
  R.act('rz-lesson-goto', function (el) { var a = act(); var i = +attr(el, 'data-i'); if (a && i <= sd(a).far) goStep(i); });
  R.act('rz-lesson-finish', function () { finish(); });
  R.act('rz-lesson-quit', quit);
  R.act('rz-lesson-quit-yes', quit);
  R.act('rz-lesson-quit-no', function () { U.confirmQuit = false; R.render(); });
  R.act('rz-lesson-answer', function (el) { answer(attr(el, 'data-k'), attr(el, 'data-v')); });
  R.act('rz-lesson-check', function (el) {
    var k = attr(el, 'data-k');
    var inp = document.querySelector('input.rzl-in[data-k="' + k + '"]');
    answer(k, inp ? inp.value : U.drafts[k]);
  });
  R.input('rz-lesson-ans', function (el) { U.drafts[attr(el, 'data-k')] = el.value; });
  R.act('rz-lesson-gloss', function (el) { var i = +attr(el, 'data-i'); U.gloss = U.gloss === i ? null : i; R.render(); });
  R.act('rz-lesson-gloss-card', function (el) {
    var a = act(), L = a && shape(docOf(a.id)), g = L && L.reading.glossary[+attr(el, 'data-i')];
    if (g && addCard(glossCard(g), a.id)) { R.toast('« ' + g.term + ' » rejoint vos cartes.'); R.render(); }
  });
  R.act('rz-lesson-say', function (el) {
    var t = attr(el, 'data-text');
    if (t) R.tts.say(t, { key: 'rzl-say', accent: attr(el, 'data-accent') || readAccent(), gender: 'female' });
  });
  R.act('rz-lesson-listen-show', function () { var a = act(); if (!a) return; sd(a).listen.phase = 2; persist(); R.render(); focusCurrent(a, true); });
  R.act('rz-lesson-script', function () { var a = act(); if (!a) return; sd(a).listen.script = true; persist(); R.render(); });
  R.act('rz-lesson-toggle', function (el) { var k = attr(el, 'data-k'); U.show[k] = !U.show[k]; R.render(); });

  R.input('rz-lesson-write', function (el) {
    var a = act();
    if (!a) return;
    var L = shape(docOf(a.id));
    sd(a).write.text = el.value.slice(0, 8000);
    if (L) R.patch('[data-rzl-wc]', wcInner(el.value, wordRange(L.writing)));
    persist();
  });
  R.act('rz-lesson-insert', function (el) {
    var a = act();
    var ta = document.querySelector('textarea[data-role="rz-lesson-write"]');
    if (!a || !ta || ta.readOnly) return;
    var t = attr(el, 'data-text') || '';
    var s = ta.selectionStart != null ? ta.selectionStart : ta.value.length, e = ta.selectionEnd != null ? ta.selectionEnd : s;
    var before = ta.value.slice(0, s), after = ta.value.slice(e);
    var ins = (before && !/\s$/.test(before) ? ' ' : '') + t + (after && !/^\s/.test(after) ? ' ' : '');
    ta.value = before + ins + after;
    ta.focus();
    try { ta.setSelectionRange(s + ins.length, s + ins.length); } catch (x) { /* champ non textuel */ }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  R.act('rz-lesson-grade-write', gradeWriting);
  R.input('rz-lesson-redo', function (el) { U.drafts.redo = el.value; });
  function checkRedo(v) {
    var a = act();
    if (!a) return;
    var ws = sd(a).write, g = obj(ws.grade);
    v = str(v != null ? v : U.drafts.redo).trim();
    if (!g || !g.redo || !v) return;
    ws.redo = { v: v.slice(0, 400), r: R.text.match(v, g.redo, []) };
    if (ws.redo.r !== 'wrong') U.show.redoHide = false;
    persist(); R.render();
  }
  R.act('rz-lesson-redo-check', function () { var inp = document.querySelector('input[data-role="rz-lesson-redo"]'); checkRedo(inp ? inp.value : null); });
  R.act('rz-lesson-card', function (el) {
    var a = act();
    if (!a) return;
    var src = attr(el, 'data-src'), g = obj(sd(a)[src === 'speak' ? 'speak' : 'write'].grade);
    var c = proposedCards(g)[+attr(el, 'data-i')];
    if (c && addCard(c, a.id)) R.render();
  });
  R.act('rz-lesson-cards-all', function (el) {
    var a = act();
    if (!a) return;
    var src = attr(el, 'data-src'), g = obj(sd(a)[src === 'speak' ? 'speak' : 'write'].grade), d = sd(a), n = 0;
    proposedCards(g).forEach(function (c) { if (!isAdded(c.front, a) && addCard(c, a.id)) n++; });
    if (n) R.toast(plural(n, 'carte ajoutée', 'cartes ajoutées') + ' à vos révisions.');
    R.render();
  });
  R.act('rz-lesson-prep-skip', function () { var a = act(); if (a) U.prepUntil[a.id] = Date.now() - 1; R.render(); });
  R.act('rz-lesson-grade-speak', gradeSpeaking);

  R.input('rz-lesson-recall', function (el) { var a = act(); if (a) { sd(a).review.recall = el.value.slice(0, 600); persist(); } });
  R.act('rz-lesson-self', function (el) { var a = act(); if (a) { sd(a).review.self = attr(el, 'data-value'); persist(); R.render(); } });
  R.act('rz-lesson-review-next', function (el) {
    var a = act();
    if (!a) return;
    var i = attr(el, 'data-i'), rv = sd(a).review;
    rv.next = i === 'surprise' ? 'surprise' : +i;
    persist(); R.render();
  });
  R.input('rz-lesson-review-custom', function (el) {
    var a = act();
    if (!a) return;
    var rv = sd(a).review, had = rv.next === 'custom';
    rv.custom = el.value.slice(0, 160);
    if (rv.custom.trim()) rv.next = 'custom'; else if (had) rv.next = null;
    persist();
    if (had !== (rv.next === 'custom')) {
      var box = document.querySelector('.rzl-custom');
      if (box) box.classList.toggle('on', rv.next === 'custom');
      var cards = document.querySelectorAll('.rzl-rv-col.is-next .rzl-topic-card');
      for (var c = 0; c < cards.length; c++) if (rv.next === 'custom') cards[c].classList.remove('on');
    }
  });

  /* ══ Vue Séance ═════════════════════════════════════════════════════════ */

  function primaryAction(a) {
    var it = currentItem(a);
    if (it) { focusCurrent(a, true); return; }
    var p = document.querySelector('[data-rzl-primary]');
    if (p && !p.disabled) p.click();
  }

  R.view('session', {
    label: 'Séance', icon: 'play', order: 5, title: 'La séance en cours (reprenable à tout moment)',
    nav: function () { return !!act(); },
    render: sessionHtml,
    after: function (host) {
      var pop = host.querySelector('.rzl-gl-pop');
      if (!pop || !pop.getBoundingClientRect) return;
      var box = (pop.closest && pop.closest('.rzl-step')) || host;
      var a = box.getBoundingClientRect(), r = pop.getBoundingClientRect(), dx = 0;
      if (r.right > a.right - 12) dx = a.right - 12 - r.right;
      if (r.left + dx < a.left + 12) dx = a.left + 12 - r.left;
      if (dx) pop.style.transform = 'translateX(' + Math.round(dx) + 'px)';
    },
    onShow: function () { U.confirmQuit = false; U.lastAct = Date.now(); enterStep(); },
    onHide: function () { flush(); R.tts.stopAll(); U.confirmQuit = false; U.gloss = null; R.save(); },
    keydown: function (e, el, role) {
      var a = act();
      if (!a || e.altKey || e.metaKey) return false;
      if (R.srs && typeof R.srs.keydown === 'function' && document.querySelector('#page-host [data-rzx-srs]') && (e.key === 'Enter' || e.key === ' ' || /^[1-4]$/.test(e.key))) {
        return R.srs.keydown(e, el);
      }
      var tag = el && el.tagName;
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable);
      if (e.ctrlKey) {
        if (e.key === 'Enter' && role === 'rz-lesson-write') { e.preventDefault(); gradeWriting(); return true; }
        return false;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (U.gloss != null) { U.gloss = null; R.render(); return true; }
        U.confirmQuit = !U.confirmQuit;
        R.render();
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        if (U.confirmQuit) { e.preventDefault(); quit(); return true; }
        if (role === 'rz-lesson-ans') { e.preventDefault(); answer(attr(el, 'data-k'), el.value); return true; }
        if (role === 'rz-lesson-redo') { e.preventDefault(); checkRedo(el.value); return true; }
        if (typing || tag === 'BUTTON' || tag === 'A') return false;
        if (el && attr(el, 'data-act')) { e.preventDefault(); el.click(); return true; }
        e.preventDefault();
        primaryAction(a);
        return true;
      }
      if (typing) return false;
      var d = sd(a);
      if (e.key === 'ArrowLeft') { if (d.cur > 0) { e.preventDefault(); goStep(d.cur - 1); } return true; }
      if (e.key === 'ArrowRight') { if (d.cur < d.far) { e.preventDefault(); goStep(d.cur + 1); } return true; }
      if (/^[1-9]$/.test(e.key)) {
        var it = currentItem(a);
        if (it && it.options.length >= +e.key) { e.preventDefault(); answer(it.k, it.options[+e.key - 1]); return true; }
      }
      return false;
    }
  });

  /* ══ Simulation hors WebView2 : un vrai cours (sample20, Nobel de littérature 2026) ══ */

  function miniLesson() {
    return {
      title: 'Why Britain loves its allotments', summaryFr: 'Un cours de repli (le fichier de simulation manque) : les jardins familiaux au Royaume-Uni.',
      level: 'B1+', minutes: 10, rubric: 'lifestyle', tone: 'light', keywords: ['allotments', 'gardening'],
      plan: [{ step: 'warmup', minutes: 2 }, { step: 'reading', minutes: 4 }, { step: 'speaking', minutes: 3 }, { step: 'review', minutes: 1 }],
      sources: [], facts: [], warmup: ['Do you grow anything at home, even herbs?'],
      reading: { headline: 'Why Britain loves its allotments', standfirst: 'Small gardens, long waiting lists.', credit: 'Written for learners',
        paragraphs: ['In many British towns, people rent a small piece of land called an allotment. They grow vegetables, meet neighbours and slow down.', 'Waiting lists can be long: in some cities, people wait for years.'],
        glossary: [{ term: 'allotment', pos: 'noun', ipa: 'əˈlɒtmənt', meaningEn: 'a small piece of land rented for growing food', meaningFr: 'jardin familial, jardin ouvrier', example: 'My uncle grows potatoes on his allotment.' }] },
      comprehension: [{ kind: 'choice', skill: 'gist', question: 'What is the text about?', options: ['Small rented gardens', 'A new park', 'A farm'], answer: 'Small rented gardens', explanationFr: '« a small piece of land called an allotment ».' }],
      listening: { format: '', title: '', contextFr: '', speakers: [], lines: [], questions: [] },
      authenticAudio: { title: '', outlet: '', audioUrl: '', pageUrl: '', published: '', taskFr: '', questions: [] },
      vocabulary: [], grammar: { point: '', explanationFr: '', examples: [], items: [] },
      writing: { taskFr: '', genre: '', words: 0, language: [], criteria: [], modelAnswer: '' },
      speaking: { taskFr: 'Parlez 45 secondes : aimeriez-vous un jardin familial ? Pourquoi ?', prompts: ['Would you like an allotment?'], prepSeconds: 20, speakSeconds: 45, language: ['I’d love to…'], pronunciation: [], modelAnswer: '' },
      cards: [{ kind: 'word', front: 'allotment', back: 'jardin familial', example: 'She spends Sundays on her allotment.' }],
      nextTopics: [{ title: 'The quiet return of the night train', pitchFr: 'Les trains de nuit reviennent en Europe.', rubric: 'europe', tone: 'light', query: 'night trains Europe' }]
    };
  }
  R.fixture('lesson', function () {
    var url = 'revizator/fixtures/lesson.json';
    var get = typeof fetch === 'function' ? fetch(url).then(function (r) { return r.ok ? r.json() : null; })['catch'](function () { return null; }) : Promise.resolve(null);
    return get.then(function (doc) { return doc || miniLesson(); });
  });
})();
