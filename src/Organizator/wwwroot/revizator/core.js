/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — noyau de la page d'apprentissage (anglais d'abord)
   S'enregistre auprès d'app.js (window.__organizator.registerPage) et fournit aux modules
   (srs.js, lesson.js, test.js, progress.js, tutor.js) l'objet global window.Revizator (alias R).

   ── API pour les modules ─────────────────────────────────────────────────
   Enregistrement
     R.view(id, def)          def = { label, icon, order, nav: bool|fn, title, render(enter) → html,
                                      after(host), onShow(params), onHide(), keydown(e, el, role) → bool }
     R.go(id, params)         change de vue ; R.viewId(), R.params()
     R.homeCard(def)          def = { id, area: 'hero'|'main'|'side', order, html() → string }
     R.act(name, fn(el, e))   action de clic (data-act), nom préfixé 'rz-'
     R.input(role, fn), R.change(role, fn)   saisie (data-role), rôle préfixé 'rz-'
     R.key(fn(e, el, role) → bool)            raccourcis (aucun dialogue ouvert)
     R.settingsSection(def)   def = { id, order, html() } — une section de l'onglet Révizator des Réglages
     R.badge(fn)              pastille de l'onglet de page (ex. cartes à réviser)
     R.shim(type, fn(p, emit)), R.fixture(kind, fn(params) | doc | 'revizator/fixtures/x.json')   simulation hors WebView2
     R.on(name, fn) → off, R.emit(name, payload)
       événements : 'loaded', 'saved', 'job' (avancement), 'jobDone' ({ kind, job, params, result, error }),
       'tts' (événement hôte), 'view' (changement de vue), 'pagehide' (on quitte la page Révizator)
   État et persistance
     R.data       sujet « en » de learning.json (objet vivant : le modifier puis R.save())
     R.prefs, R.profile   raccourcis vers R.data.prefs / R.data.profile
     R.ui         état d'affichage en mémoire ; un sous-objet par module (R.ui.lesson, R.ui.test…)
     R.save(now)  persistance (800 ms de délai, immédiate avec now) ; R.isLoaded()
                  Serveur Révizator (docs/REVIZATOR-SERVER.md § 6) : learnChanged d'un autre appareil relit
                  les données en silence si rien n'attend d'être sauvegardé, à l'accueil ou dans Progrès
                  seulement (sinon au retour à l'accueil)
     R.doc(kind, id) → Promise<doc|null> (cache) ; R.docSave(kind, id, doc) ; R.docDelete(kind, id)
     R.render()   rendu complet de l'application ; R.renderSoon() (différé pendant la frappe)
     R.patch(selector, html)  réécrit un fragment sans rendu complet
   Génération (claude -p côté hôte, voir spec §4.2)
     R.gen(kind, params, { model, effort, context, job, timeout }) → Promise<{ job, kind, id, doc, ms, turns, cost, model }>
     R.jobs() → [job…] ; R.jobOf(kind) → job en cours de ce genre ou null ; R.cancel(job)
     R.context(kind) → texte de contexte de l'apprenant (8 000 caractères au plus)
   Modèle de l'apprenant
     R.SKILLS, R.LEVELS, R.band(theta), R.thetaOf(level), R.level(skill) → { theta, band, n, conf }
     R.globalBand(), R.explainLang() → 'fr'|'mixed'|'en'
     R.observe(skill, cefr, x 0..1, weight)    réponse à un item (Elo)
     R.observeLevel(skill, level, weight)      niveau estimé d'une production
     R.addErrors(edits, { mode, ref }) ; R.weakPoints(n) ; R.categoryLabel(cat) ; R.CATEGORIES
     R.logSession({ kind, ref, title, startedAt, endedAt, skillMinutes, score }) ; R.week()
     R.active() / R.setActive(obj|null)      séance reprenable
   Audio
     R.tts.status(), R.tts.ready(), R.tts.engine(), R.tts.refresh(), R.tts.download(), R.tts.remove()
     R.tts.voice(accent, gender, n) ; R.tts.voicesFor(speakers) → { id: voix }
     R.tts.say(text, { accent, gender, voice, speed, key }) → Player
     R.tts.script(lines [{ speaker, text }], speakers [{ id, accent, gender }], { speed, gapMs, key }) → Player
     R.audio(url, { key }) → Player (mp3 authentique, enregistrement)
     R.tts.stopAll()
     Player = { key, state ('loading'|'playing'|'paused'|'ended'|'error'), line, error, done (Promise),
                play(), pause(), toggle(), stop(), replay(), setRate(r), onChange(fn) (état), onLine(fn(i)) (segment lu) }
     R.players[key] ; R.h.player(key, { source: () => Player, label, maxPlays, speeds, small })
       (boutons ; actions communes rz-player-toggle / -replay / -speed ; surligne [data-rz-say=key][data-rz-idx=i])
     R.rec.start(opts) → Promise<Rec> ; R.rec.busy()
     R.h.rec(key, { maxMs, label, stt: { reference, keep } | null, onResult(r) })
       (bouton micro ; r = { audio: { data, seconds, blob, url }, stt }) ; R.recToggle(key) ; R.recState(key)
     R.stt(data, { reference, keep, job, accent }) → Promise<transcription enrichie, spec §4.4> (accent : calcule P(en), +100 % de temps)
   Affichage
     R.esc, R.uid, R.icon(name), R.fmtDate, R.fmtDay, R.fmtTime, R.fmtDur(s), R.fmtMin(min), R.today(), R.dayOf(ms)
     R.toast(msg, { label, run }), R.notify(body, view)  (notification Windows si la fenêtre est derrière)
     R.h.feedback(grade, { response, mode }) ; R.h.diff(a, b) ; R.h.level(band, label) ; R.h.skill(id) ;
     R.h.progress(ratio, label) ; R.h.empty(title, text) ; R.h.jobLine(job) ; R.h.chips(name, values, current, labels)
     R.text.norm(s), R.text.match(answer, expected, accepted) → 'exact'|'close'|'wrong',
     R.text.words(s), R.text.distance(a, b), R.text.count(s)
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var O = window.__organizator;
  if (!O || !O.registerPage) return;

  var R = window.Revizator = {};
  var A = null;                      /* pageApi d'app.js, rendu par registerPage */
  var DOC = null;                    /* learning.json entier */
  var loaded = false;
  var booted = false;                /* onBoot passé : getState a répondu, le transport est fixé */

  R.version = 1;
  R.ui = { view: 'home', params: {}, plays: {}, rec: {}, setCustom: {}, ttsDl: null, onboard: {} };

  /* ══ Constantes ═════════════════════════════════════════════════════════ */

  var SKILLS = [
    { id: 'read', label: 'Lecture', long: 'Compréhension écrite', hue: 'ardoise' },
    { id: 'listen', label: 'Écoute', long: 'Compréhension orale', hue: 'prune' },
    { id: 'write', label: 'Écrit', long: 'Expression écrite', hue: 'ocre' },
    { id: 'speak', label: 'Oral', long: 'Expression orale', hue: 'terracotta' },
    { id: 'lang', label: 'Langue', long: 'Vocabulaire et grammaire', hue: 'sauge' }
  ];
  var LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  var LEVEL_NAMES = { A1: 'Découverte', A2: 'Survie', B1: 'Seuil', B2: 'Indépendant', C1: 'Autonome', C2: 'Maîtrise' };

  var CATEGORIES = {
    'pron.stress.word': 'Accent de mot', 'pron.vowel.reduction': 'Voyelles réduites, formes faibles',
    'pron.vowel.i_ii': 'Voyelles /ɪ/ – /iː/', 'pron.vowel.ae_uh': 'Voyelles /æ/ – /ʌ/', 'pron.h': 'Le son h',
    'pron.ed': 'Terminaison -ed', 'pron.final_s': 'Terminaison -s', 'pron.diphthong': 'Diphtongues',
    'pron.th': 'Le son th', 'pron.sentence_stress': 'Accent de phrase',
    'gram.tense.pp_past': 'Present perfect ou prétérit', 'gram.tense.duration': 'Durée (depuis…)',
    'gram.for_since_ago': 'for, since, ago', 'gram.future_after_when': 'Futur après when / as soon as',
    'gram.question.aux': 'Questions et auxiliaires', 'gram.article.generic': 'Article générique',
    'gram.article.job': 'Article et métier', 'gram.countable': 'Indénombrables', 'gram.agreement': 'Accords',
    'gram.verb_pattern': 'Constructions verbales', 'gram.preposition': 'Prépositions', 'gram.word_order': 'Ordre des mots',
    'gram.possessive': 'Possessif', 'gram.modal': 'Modaux', 'gram.comparative': 'Comparatifs', 'gram.other': 'Grammaire',
    'lex.false_friend': 'Faux amis', 'lex.collocation': 'Collocations', 'lex.phrasal_avoidance': 'Verbes à particule',
    'lex.register': 'Registre', 'lex.franglais': 'Franglais', 'lex.word_choice': 'Choix des mots',
    'disc.connector': 'Connecteurs', 'disc.coherence': 'Cohérence', 'mech.capitalisation': 'Majuscules',
    'mech.punctuation_spacing': 'Ponctuation', 'mech.spelling': 'Orthographe'
  };

  var DEFAULT_PREFS = {
    lessonModel: 'sonnet', lessonEffort: 'medium', genModel: 'sonnet', genEffort: 'low', gradeModel: 'sonnet',
    tutorModel: 'haiku', cardModel: 'haiku', engine: 'auto', voiceUs: 'af_heart', voiceGb: 'bf_emma', speed: 1, retention: 0.9,
    whisperModel: 'small', tutorLive: true, tutorSensitivity: 40, tutorBargeIn: 'words'
  };
  var DEFAULT_PROFILE = { onboarded: false, goal: '', interests: '', startLevel: 'B1', weeklyGoal: 4, defaultMinutes: 20, explain: 'auto' };

  /* Délais d'attente de l'UI par genre (l'hôte abandonne avant, spec §4.2). */
  var GEN_WAIT = { lesson: 330000, exercise: 180000, toeic: 270000, sw: 180000, grade: 150000, tutor: 90000, cardcheck: 70000, cardfix: 160000 };
  var GEN_MODEL = {
    lesson: ['lessonModel', 'lessonEffort'], exercise: ['genModel', 'genEffort'], toeic: ['genModel', 'genEffort'],
    sw: ['genModel', 'genEffort'], grade: ['gradeModel', 'genEffort'], tutor: ['tutorModel', ''],
    cardcheck: ['cardModel', ''], cardfix: ['cardModel', '']
  };
  /* Générations qui se font sans bruit : pas de ligne « en préparation » dans la barre, pas de rendu
     à leur départ ni à leur fin (la vue qui les attend se met à jour elle-même), pas de document. */
  var QUIET_KINDS = { grade: 1, tutor: 1, cardcheck: 1, cardfix: 1 };

  var KOKORO = {
    'en-US': { female: ['af_heart', 'af_bella', 'af_nicole'], male: ['am_michael', 'am_puck', 'am_fenrir'] },
    'en-GB': { female: ['bf_emma', 'bf_isabella'], male: ['bm_george', 'bm_fable'] }
  };
  var VOICE_LABELS = {
    af_heart: 'Heart', af_bella: 'Bella', af_nicole: 'Nicole', am_michael: 'Michael', am_puck: 'Puck', am_fenrir: 'Fenrir',
    bf_emma: 'Emma', bf_isabella: 'Isabella', bm_george: 'George', bm_fable: 'Fable'
  };
  var FEMALE_NAMES = /zira|aria|jenny|hazel|susan|catherine|linda|heera|emma|sonia|libby|natasha|clara|eva|michelle|ana|sara|samantha|karen|moira|tessa|female/i;

  var ICONS = {
    book: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5.5c3-1.4 6-1.4 9 .2v13.2c-3-1.6-6-1.6-9-.2z"></path><path d="M21 5.5c-3-1.4-6-1.4-9 .2v13.2c3-1.6 6-1.6 9-.2z"></path></svg>',
    sun: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"></path></svg>',
    play: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l11.6-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8z"></path></svg>',
    pause: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4.2" height="15" rx="1.2"></rect><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2"></rect></svg>',
    replay: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"></path><path d="M3 4v5h5"></path></svg>',
    mic: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"></path></svg>',
    stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5.5" y="5.5" width="13" height="13" rx="2.5"></rect></svg>',
    check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"></path></svg>',
    cross: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>',
    spark: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"></path><path d="M19 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"></path></svg>',
    cards: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6.5" width="13" height="14" rx="2.5"></rect><path d="M8 3.5h10.5a2.5 2.5 0 0 1 2.5 2.5v11"></path></svg>',
    chart: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5h16"></path><path d="M6.5 15l4-4.5 3.5 3 5-6.5"></path></svg>',
    target: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><circle cx="12" cy="12" r="4.5"></circle><circle cx="12" cy="12" r="1" fill="currentColor"></circle></svg>',
    chat: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5a2 2 0 0 1-2 2H8l-4.5 4v-14a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"></path><path d="M8 9.5h8M8 13h4.5"></path></svg>',
    pen: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4.2-1 11-11a2.1 2.1 0 0 0-3-3l-11 11z"></path><path d="M14.5 6.5l3 3"></path></svg>',
    ear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 9a5.5 5.5 0 1 1 11 0c0 3-2.5 4-3.2 6.3-.6 2-1.6 4.7-4.3 4.7-1.6 0-2.7-1-3-2.3"></path><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.4-1 2-1.7 2.6"></path></svg>',
    speak: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5v5h3.5L13 19V5L7.5 9.5z"></path><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"></path></svg>',
    read: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5h9l3.5 3.5v13.5H6z"></path><path d="M9 10.5h6.5M9 14h6.5M9 17.5h4"></path></svg>',
    lang: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h9M8.5 4v2c0 4-2 7-4.5 8.5M6.5 10.5c1.2 2 3 3.4 5 4"></path><path d="M12.5 20l3.8-9 3.7 9M13.8 17h5"></path></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path></svg>',
    arrow: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>',
    back: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"></path></svg>',
    flag: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4.5M5 4.5c4-2 7 2 14 0v9c-7 2-10-2-14 0"></path></svg>',
    globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5S14.5 17.9 12 20.5c-2.5-2.6-3.6-5.4-3.6-8.5S9.5 6.1 12 3.5z"></path></svg>'
  };

  /* ══ Utilitaires ════════════════════════════════════════════════════════ */

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function uid(prefix) { return (prefix || 'rz') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dayOf(ms) { var d = new Date(ms || Date.now()); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function today() { return dayOf(Date.now()); }
  function fmtDur(s) {
    s = Math.max(0, Math.round(num(s, 0)));
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60), r = s % 60;
    return m + ' min' + (r ? ' ' + pad2(r) : '');
  }
  function fmtMin(min) {
    min = Math.round(num(min, 0));
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), r = min % 60;
    return h + ' h' + (r ? ' ' + pad2(r) : '');
  }
  function fmtDayShort(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
    if (!m) return String(key || '');
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }
  function daysBetween(a, b) { return Math.round((num(b, Date.now()) - num(a, 0)) / 86400000); }

  /* ── Texte : comparaison tolérante des réponses tapées ─────────────────── */
  var CONTRACTIONS = [
    [/\bcan't\b/g, 'cannot'], [/\bwon't\b/g, 'will not'], [/\bshan't\b/g, 'shall not'], [/\bain't\b/g, 'is not'],
    [/n't\b/g, ' not'], [/'re\b/g, ' are'], [/'ve\b/g, ' have'], [/'ll\b/g, ' will'], [/'d\b/g, ' would'],
    [/\bi'm\b/g, 'i am'], [/\b(it|that|there|what|he|she|who|where|here)'s\b/g, '$1 is'], [/\blet's\b/g, 'let us']
  ];
  var UK_US = [[/our\b/g, 'or'], [/ise\b/g, 'ize'], [/ised\b/g, 'ized'], [/ising\b/g, 'izing'], [/yse\b/g, 'yze'], [/tre\b/g, 'ter'], [/ogue\b/g, 'og']];

  function norm(s) {
    var t = String(s == null ? '' : s).toLowerCase()
      .replace(/[\u2018\u2019\u02bc`´]/g, "'").replace(/[\u201c\u201d«»]/g, '"')
      .replace(/[\u2013\u2014]/g, '-');
    CONTRACTIONS.forEach(function (c) { t = t.replace(c[0], c[1]); });
    t = t.replace(/[^a-z0-9'\- ]+/g, ' ').replace(/(^|\s)['-]+|['-]+(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    return t;
  }
  function normLoose(s) {
    return norm(s).split(' ').map(function (w) { UK_US.forEach(function (r) { w = w.replace(r[0], r[1]); }); return w; }).join(' ');
  }
  function words(s) { var t = String(s || '').trim(); return t ? t.split(/\s+/) : []; }
  function count(s) { return words(String(s || '').replace(/[—–]/g, ' ')).filter(function (w) { return /[A-Za-z0-9]/.test(w); }).length; }
  function distance(a, b) {
    a = String(a || ''); b = String(b || '');
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }
  /* 'exact' : identique une fois normalisé (casse, ponctuation, apostrophes, contractions, orthographe UK/US) ;
     'close' : une faute de frappe (1 à 2 lettres selon la longueur) ; 'wrong' sinon. */
  function match(answer, expected, accepted) {
    var a = normLoose(answer);
    if (!a) return 'wrong';
    var list = [expected].concat(accepted || []).filter(function (x) { return x != null && String(x).trim(); });
    var best = 'wrong';
    for (var i = 0; i < list.length; i++) {
      var e = normLoose(list[i]);
      if (a === e) return 'exact';
      var tol = e.length >= 12 ? 2 : (e.length >= 5 ? 1 : 0);
      if (tol && distance(a, e) <= tol) best = 'close';
    }
    return best;
  }

  /* Différences mot à mot (plus longue sous-suite commune) : ce qui a été retiré, ajouté. */
  function diffWords(a, b) {
    var x = words(a), y = words(b);
    var n = x.length, m = y.length, i, j;
    if (n * m > 250000) return [{ op: 'del', text: x.join(' ') }, { op: 'ins', text: y.join(' ') }];
    var key = function (w) { return w.toLowerCase().replace(/[^\w']/g, ''); };
    var L = [];
    for (i = 0; i <= n; i++) { L[i] = new Array(m + 1); L[i][m] = 0; }
    for (j = 0; j <= m; j++) L[n][j] = 0;
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) L[i][j] = key(x[i]) === key(y[j]) && x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    var out = [];
    var push = function (op, w) {
      var last = out[out.length - 1];
      if (last && last.op === op) last.text += ' ' + w; else out.push({ op: op, text: w });
    };
    i = 0; j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { push('eq', x[i]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { push('del', x[i]); i++; }
      else { push('ins', y[j]); j++; }
    }
    while (i < n) push('del', x[i++]);
    while (j < m) push('ins', y[j++]);
    return out;
  }

  R.esc = esc; R.uid = uid; R.clamp = clamp; R.today = today; R.dayOf = dayOf; R.fmtDur = fmtDur; R.fmtMin = fmtMin;
  R.fmtDayShort = fmtDayShort; R.daysBetween = daysBetween;
  R.text = { norm: norm, normLoose: normLoose, words: words, count: count, distance: distance, match: match, diff: diffWords };
  R.SKILLS = SKILLS; R.LEVELS = LEVELS; R.LEVEL_NAMES = LEVEL_NAMES; R.CATEGORIES = CATEGORIES;
  R.icon = function (name) { return ICONS[name] || (A && A.icon[name]) || ''; };
  R.categoryLabel = function (cat) { return CATEGORIES[cat] || String(cat || '').replace(/^[a-z]+\./, '').replace(/[._]/g, ' '); };
  R.skillById = function (id) { for (var i = 0; i < SKILLS.length; i++) if (SKILLS[i].id === id) return SKILLS[i]; return null; };

  /* ══ Bus d'événements internes ══════════════════════════════════════════ */

  var LISTENERS = Object.create(null);
  R.on = function (name, fn) {
    (LISTENERS[name] = LISTENERS[name] || []).push(fn);
    return function () { var l = LISTENERS[name] || []; var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
  };
  R.emit = function (name, payload) {
    (LISTENERS[name] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { if (window.console) console.error('[revizator] ' + name, e); }
    });
  };

  /* ══ Enregistrement des vues, cartes, actions ═══════════════════════════ */

  var VIEWS = Object.create(null), HOME_CARDS = [], SECTIONS = [], BADGE = null;
  var PENDING = { act: [], input: [], change: [], key: [] };

  R.view = function (id, def) { if (id && def && typeof def.render === 'function') { def.id = id; VIEWS[id] = def; } };
  R.homeCard = function (def) { if (def && def.id && typeof def.html === 'function') { HOME_CARDS = HOME_CARDS.filter(function (c) { return c.id !== def.id; }); HOME_CARDS.push(def); } };
  R.settingsSection = function (def) { if (def && def.id && typeof def.html === 'function') SECTIONS.push(def); };
  R.badge = function (fn) { BADGE = typeof fn === 'function' ? fn : null; };
  R.act = function (name, fn) { if (A) A.addAction(name, fn); else PENDING.act.push([name, fn]); };
  R.input = function (role, fn) { if (A) A.addInput(role, fn); else PENDING.input.push([role, fn]); };
  R.change = function (role, fn) { if (A) A.addChange(role, fn); else PENDING.change.push([role, fn]); };
  R.key = function (fn) { if (A) A.addKey(fn); else PENDING.key.push(fn); };

  R.viewId = function () { return VIEWS[R.ui.view] ? R.ui.view : 'home'; };
  R.params = function () { return R.ui.params || {}; };
  R.go = function (id, params) {
    var prev = R.viewId();
    if (!VIEWS[id]) id = 'home';
    var pv = VIEWS[prev];
    if (prev !== id && pv && pv.onHide) { try { pv.onHide(); } catch (e) { /* vue fautive */ } }
    R.ui.view = id;
    R.ui.params = params || {};
    try { localStorage.setItem('organizator.revizator.view', id === 'session' ? 'home' : id); } catch (e) { /* stockage refusé */ }
    if (A && A.currentPage() !== 'revizator') { A.goPage('revizator', true); }
    window.scrollTo(0, 0);
    var nv = VIEWS[id];
    if (nv && nv.onShow) { try { nv.onShow(R.ui.params); } catch (e) { if (window.console) console.error(e); } }
    R.emit('view', id);
    R.render();
  };

  /* ══ Persistance ════════════════════════════════════════════════════════ */

  function defaultSubject() {
    return {
      createdAt: Date.now(),
      profile: Object.assign({}, DEFAULT_PROFILE),
      prefs: Object.assign({}, DEFAULT_PREFS),
      skills: {}, toeic: { L: null, R: null, S: null, W: null, calib: { L: [], R: [] }, history: [] },
      cards: [], reviewLog: [], errors: {}, sessions: [], lessons: [], exercises: [], attempts: [],
      nextTopic: null, active: null, tutor: { chats: [] }, capsules: []
    };
  }

  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }

  function normalizeSubject(s) {
    var d = defaultSubject();
    s = obj(s) || {};
    var out = Object.assign({}, s);
    out.createdAt = num(s.createdAt, d.createdAt);
    out.profile = Object.assign({}, DEFAULT_PROFILE, obj(s.profile) || {});
    out.prefs = Object.assign({}, DEFAULT_PREFS, obj(s.prefs) || {});
    out.profile.weeklyGoal = clamp(Math.round(num(out.profile.weeklyGoal, 4)), 1, 7);
    out.profile.defaultMinutes = [10, 20, 30, 45].indexOf(+out.profile.defaultMinutes) >= 0 ? +out.profile.defaultMinutes : 20;
    out.prefs.speed = clamp(num(out.prefs.speed, 1), 0.7, 1.3);
    out.prefs.retention = clamp(num(out.prefs.retention, 0.9), 0.8, 0.97);
    /* Sensibilité du micro recalibrée (moteur v3, défaut 40) : l'ancien défaut 50, enregistré tel quel, suit. */
    if (!out.prefs.tutorSensV) {
      if (+out.prefs.tutorSensitivity === 50) out.prefs.tutorSensitivity = 40;
      out.prefs.tutorSensV = 2;
    }
    out.prefs.tutorSensitivity = clamp(Math.round(num(out.prefs.tutorSensitivity, 40)), 0, 100);
    if (['words', 'voice', 'off'].indexOf(out.prefs.tutorBargeIn) < 0) out.prefs.tutorBargeIn = 'words';
    out.skills = obj(s.skills) || {};
    out.toeic = Object.assign({}, d.toeic, obj(s.toeic) || {});
    out.toeic.calib = Object.assign({ L: [], R: [] }, obj(out.toeic.calib) || {});
    out.toeic.history = arr(out.toeic.history);
    ['cards', 'reviewLog', 'sessions', 'lessons', 'exercises', 'attempts', 'capsules'].forEach(function (k) { out[k] = arr(s[k]); });
    out.errors = obj(s.errors) || {};
    out.nextTopic = obj(s.nextTopic);
    out.active = obj(s.active);
    out.tutor = Object.assign({ chats: [] }, obj(s.tutor) || {});
    out.tutor.chats = arr(out.tutor.chats);
    SKILLS.forEach(function (k) {
      var sk = obj(out.skills[k.id]);
      if (!sk) sk = { theta: thetaOf(out.profile.startLevel) || 0, n: 0, at: 0, hist: [] };
      sk.theta = clamp(num(sk.theta, 0), -3, 3.5);
      sk.n = Math.max(0, Math.round(num(sk.n, 0)));
      sk.hist = arr(sk.hist);
      out.skills[k.id] = sk;
    });
    return out;
  }

  function subject() {
    if (!DOC) DOC = { version: 1, subjects: {} };
    if (!DOC.subjects || typeof DOC.subjects !== 'object') DOC.subjects = {};
    if (!DOC.subjects.en) DOC.subjects.en = normalizeSubject(null);
    return DOC.subjects.en;
  }

  Object.defineProperty(R, 'data', { get: subject });
  Object.defineProperty(R, 'prefs', { get: function () { return subject().prefs; } });
  Object.defineProperty(R, 'profile', { get: function () { return subject().profile; } });
  R.isLoaded = function () { return loaded; };

  var saveTimer = null, saveDirty = false, saveInFlight = null, saving = 0;
  function saveNow(retry) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!loaded) return Promise.resolve();
    saveDirty = false;
    trimSubject(subject());
    saving++;
    /* Sur un serveur Révizator : écriture conditionnelle (§ 6). Si un autre appareil a écrit depuis
       notre dernière lecture, le serveur n'écrit rien ; on fusionne sa version avec la nôtre, puis on renvoie. */
    var payload = { data: DOC }, snap = null;
    if (base.rev !== null && onServer()) { payload.baseRev = base.rev; snap = JSON.stringify(DOC); }
    saveInFlight = bridge.call('learnSave', payload, 20000).then(function (r) {
      if (r && r.conflict) {
        return mergeFromServer().then(function () {
          saving--;
          if ((retry || 0) < 3) return saveNow((retry || 0) + 1);
          saveDirty = true;
          R.toast('Révizator : sauvegarde différée, un autre appareil écrit en même temps.');
        }, function (e) { saving--; saveDirty = true; R.toast('Révizator : sauvegarde impossible — ' + e.message); });
      }
      saving--;
      if (snap !== null && r && typeof r.rev === 'number') { base.rev = r.rev; base.text = snap; }
      R.emit('saved', r);
      return r;
    },
      function (e) {
        saving--;
        /* Serveur Révizator coupé : la sauvegarde repart à la reconnexion. */
        if (e && e.offline) { saveDirty = true; R.toast('Révizator : serveur injoignable, la sauvegarde repartira à la reconnexion.'); return; }
        R.toast('Révizator : sauvegarde impossible — ' + e.message);
      });
    return saveInFlight;
  }
  R.save = function (now) {
    saveDirty = true;
    if (now) return saveNow();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 800);
    return null;
  };

  /* Les listes grandissent avec l'usage : on garde ce qui sert au suivi, pas tout l'historique. */
  function trimSubject(s) {
    var cap = function (k, n) { if (s[k].length > n) s[k] = s[k].slice(s[k].length - n); };
    cap('reviewLog', 3000); cap('sessions', 500); cap('attempts', 200); cap('capsules', 60);
    if (s.lessons.length > 100) s.lessons = s.lessons.slice(s.lessons.length - 100);
    if (s.exercises.length > 100) s.exercises = s.exercises.slice(s.exercises.length - 100);
    if (s.tutor.chats.length > 30) s.tutor.chats = s.tutor.chats.slice(s.tutor.chats.length - 30);
    SKILLS.forEach(function (k) { var h = s.skills[k.id].hist; if (h.length > 400) s.skills[k.id].hist = h.slice(h.length - 400); });
  }

  function adopt(r) {
    DOC = obj(r && r.data) || { version: 1, subjects: {} };
    if (!DOC.subjects) DOC.subjects = {};
    DOC.version = 1;
    DOC.subjects.en = normalizeSubject(DOC.subjects.en);
    R.env.learnUrl = (r && r.url) || 'https://learn.organizator/';
    /* Base des fusions : le rev du serveur (absent hors serveur) et le texte de ce qui a été lu. */
    base.rev = r && typeof r.rev === 'number' ? r.rev : null;
    base.text = base.rev !== null ? JSON.stringify(DOC) : null;
  }

  /* ── Fusion à trois (§ 6) ────────────────────────────────────────────
     base = dernière version lue ou écrite par cette page, local = DOC, remote = version du serveur.
     Ce qu'un seul côté a changé est gardé ; les deux ont changé : les objets se fusionnent clé par clé,
     les listes d'objets à `id` élément par élément, les autres listes (journaux) gardent les éléments
     du serveur plus ceux ajoutés ici ; une même valeur changée des deux côtés : la nôtre l'emporte.
     DOC est modifié sur place, même là où seul le serveur a changé : les vues gardent leurs objets
     (séance, révision en cours). */
  var base = { rev: null, text: null };
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function same(a, b) { return a === b || JSON.stringify(a) === JSON.stringify(b); }
  function byId(list) {
    var m = Object.create(null);
    for (var i = 0; i < list.length; i++) { if (!isObj(list[i]) || typeof list[i].id !== 'string') return null; m[list[i].id] = list[i]; }
    return m;
  }
  function merge3(b, l, r) {
    if (same(l, r)) return l;
    if (isObj(l) && isObj(r)) {
      var bo = isObj(b) ? b : {};
      Object.keys(r).forEach(function (k) { if (!(k in l) && !(k in bo)) l[k] = r[k]; });
      Object.keys(l).forEach(function (k) {
        if (k in r) l[k] = merge3(bo[k], l[k], r[k]);
        else if (k in bo && same(bo[k], l[k])) delete l[k];
      });
      return l;
    }
    if (Array.isArray(l) && Array.isArray(r)) {
      var ba = Array.isArray(b) ? b : [], out = [];
      var lm = byId(l), rm = byId(r), bm = byId(ba) || Object.create(null);
      if (lm && rm) {
        r.forEach(function (it) {
          if (lm[it.id]) out.push(merge3(bm[it.id], lm[it.id], it));
          else if (!bm[it.id]) out.push(it);
        });
        l.forEach(function (it) { if (!rm[it.id] && (!bm[it.id] || !same(bm[it.id], it))) out.push(it); });
      } else {
        var seen = Object.create(null), key = function (v) { return JSON.stringify(v); };
        ba.forEach(function (it) { var k = key(it); seen[k] = (seen[k] || 0) + 1; });
        r.forEach(function (it) { var k = key(it); seen[k] = (seen[k] || 0) + 1; out.push(it); });
        l.forEach(function (it) { var k = key(it); if (seen[k]) seen[k]--; else out.push(it); });
      }
      l.length = 0;
      Array.prototype.push.apply(l, out);
      return l;
    }
    return same(l, b) ? r : l;
  }
  function mergeFromServer() {
    return bridge.call('learnLoad', {}, 20000).then(function (r) {
      var remote = obj(r && r.data) || { version: 1, subjects: {} };
      var b = base.text ? JSON.parse(base.text) : {};
      DOC = merge3(b, DOC, remote);
      if (!DOC.subjects) DOC.subjects = {};
      base.rev = typeof r.rev === 'number' ? r.rev : null;
      base.text = base.rev !== null ? JSON.stringify(remote) : null;
      R.renderSoon();
    });
  }

  /* Données sur un serveur Révizator (page du serveur, ou Organizator réglé pour lui) : un échec de
     lecture ne se remplace jamais par des données vides, que la prochaine sauvegarde y écrirait. */
  var loadError = '', loadSeq = 0, loading = null;
  function onServer() { return !!(bridge.remote && bridge.remote()); }

  function load() {
    var seq = ++loadSeq;
    return (loading = bridge.call('learnLoad', {}, 20000).then(function (r) {
      loading = null;
      if (seq !== loadSeq) return;
      adopt(r);
      loadError = '';
      loaded = true;
      R.emit('loaded', R.data);
      R.render();
    }, function (e) {
      loading = null;
      if (seq !== loadSeq) return;
      if (onServer()) {
        loadError = (e && e.message) || 'Serveur Révizator injoignable.';
        R.render();
        return;
      }
      DOC = { version: 1, subjects: { en: normalizeSubject(null) } };
      loaded = true;
      R.toast('Révizator : données illisibles — ' + e.message);
      R.render();
    }));
  }

  /* ── Plusieurs appareils (§ 6) ───────────────────────────────────────
     Un autre appareil a écrit learning.json : relecture silencieuse si rien n'attend d'être sauvegardé
     (sinon notre sauvegarde l'emporte : dernier écrit gagnant). Jamais au milieu d'une séance, d'une
     série d'exercices, d'un bilan, d'une révision ou du tuteur : la vue garde ses objets, la relecture
     attend le retour à l'accueil. */
  var QUIET_VIEWS = { home: 1, progress: 1 };
  var reloadWanted = false;
  function reloadIfQuiet() {
    if (!reloadWanted || !loaded) return;
    if (saveDirty || saving) { reloadWanted = false; return; }
    if (!QUIET_VIEWS[R.viewId()]) return;
    reloadWanted = false;
    var seq = ++loadSeq;
    bridge.call('learnLoad', {}, 20000).then(function (r) {
      if (seq !== loadSeq || saveDirty || saving || !QUIET_VIEWS[R.viewId()]) return;
      adopt(r);
      R.emit('loaded', R.data);
      R.emit('reloaded', R.data);
      R.renderSoon();
    }, function () { reloadWanted = true; /* nouvel essai au prochain signal */ });
  }
  R.on('view', reloadIfQuiet);

  /* État de la liaison avec le serveur : un bandeau discret dans la page, réécrit sans rendu complet. */
  var conn = { state: null, lost: false };
  function connBannerHtml() {
    if (!conn.lost || conn.state === 'online' || !onServer()) return '';
    return '<div class="rz-conn" role="status"><span class="rz-conn-dot"></span>'
      + (conn.state === 'connecting' ? 'Reconnexion au serveur Révizator…' : 'Serveur Révizator injoignable : nouvel essai automatique. Rien n’est perdu de ce qui est affiché ; les sauvegardes repartiront à la reconnexion.')
      + '</div>';
  }
  function onConnection(p) {
    var st = (p && p.state) || null;
    conn.state = st;
    if (st === 'offline') conn.lost = true;
    if (st === 'online') {
      conn.lost = false;
      if (booted && !loaded && !loading) load().then(reattachJobs);
      else if (saveDirty) saveNow();
      reloadIfQuiet();
    }
    var els = document.querySelectorAll('[data-rz-conn]');
    for (var i = 0; i < els.length; i++) els[i].innerHTML = connBannerHtml();
    if (A && A.state && A.state.ui && A.state.ui.settingsOpen) R.renderSoon();
  }

  var DOCS = Object.create(null);
  R.doc = function (kind, id) {
    var k = kind + ':' + id;
    if (DOCS[k]) return Promise.resolve(DOCS[k]);
    return bridge.call('learnDoc', { kind: kind, id: id }, 20000).then(function (r) {
      if (r && r.doc) DOCS[k] = r.doc;
      return (r && r.doc) || null;
    });
  };
  R.docCached = function (kind, id) { return DOCS[kind + ':' + id] || null; };
  R.docPut = function (kind, id, doc) { if (doc) DOCS[kind + ':' + id] = doc; };
  R.docSave = function (kind, id, doc) {
    DOCS[kind + ':' + id] = doc;
    return bridge.call('learnDocSave', { kind: kind, id: id, doc: doc }, 20000);
  };
  R.docDelete = function (kind, id) {
    delete DOCS[kind + ':' + id];
    return bridge.call('learnDocDelete', { kind: kind, id: id }, 20000);
  };

  /* ══ Rendu ══════════════════════════════════════════════════════════════ */

  var soonTimer = null;
  R.render = function () { if (soonTimer) { clearTimeout(soonTimer); soonTimer = null; } if (A) A.render(); };
  R.renderSoon = function (ms) {
    if (soonTimer) return;
    soonTimer = setTimeout(function tick() {
      if (A && A.isTyping()) { soonTimer = setTimeout(tick, 400); return; }
      soonTimer = null;
      if (A) A.render();
    }, ms == null ? 120 : ms);
  };
  R.patch = function (selector, html) {
    var els = document.querySelectorAll(selector);
    for (var i = 0; i < els.length; i++) { if (A) A.setHtml(els[i], html); else els[i].innerHTML = html; }
    return els.length;
  };
  R.toast = function (msg, action) { if (A) A.toast(msg, action); };
  R.fmtDate = function (ms) { return A ? A.fmtDate(ms) : ''; };
  R.fmtTime = function (ms) { return A ? A.fmtTime(ms) : ''; };
  R.fmtDay = function (key, opts) { return A ? A.fmtDay(key, opts) : String(key || ''); };

  /* Une génération finie pendant qu'on est ailleurs : le toast le dit, et Windows aussi si la fenêtre est derrière. */
  R.notify = function (body, view) {
    var here = A && A.currentPage() === 'revizator';
    if (!here || document.visibilityState === 'hidden') {
      R.toast(body, { label: 'Ouvrir', run: function () { R.go(view || 'home'); } });
    }
    bridge.call('notify', {
      count: 0, title: 'Révizator',
      toasts: [{ title: 'Révizator', body: body, attribution: 'Anglais', args: 'rz=' + (view || 'home'), tag: 'rz-' + (view || 'home') }]
    })['catch'](function () { /* sans importance */ });
  };

  function navViews() {
    return Object.keys(VIEWS).map(function (k) { return VIEWS[k]; }).filter(function (v) {
      var n = v.nav;
      if (typeof n === 'function') { try { return !!n(); } catch (e) { return false; } }
      return n !== false;
    }).sort(function (a, b) { return num(a.order, 50) - num(b.order, 50); });
  }

  function renderBar(bar) {
    var cur = R.viewId();
    var h = ['<nav class="rz-tabs" role="tablist" aria-label="Révizator">'];
    navViews().forEach(function (v) {
      var on = v.id === cur;
      var badge = '';
      if (typeof v.badge === 'function') { try { badge = v.badge() || ''; } catch (e) { badge = ''; } }
      h.push('<button type="button" role="tab" class="rz-tab' + (on ? ' on' : '') + (v.id === 'session' ? ' is-session' : '') + '" data-act="rz-go" data-view="' + esc(v.id) + '"'
        + ' aria-selected="' + (on ? 'true' : 'false') + '"' + (v.title ? ' title="' + esc(v.title) + '"' : '') + '>'
        + (v.icon ? R.icon(v.icon) : '') + '<span>' + esc(v.label) + '</span>'
        + (badge ? '<span class="rz-tab-badge">' + esc(badge) + '</span>' : '') + '</button>');
    });
    h.push('</nav>');
    var running = R.jobs().filter(function (j) { return !QUIET_KINDS[j.kind]; });
    if (running.length) {
      var j = running[0];
      h.push('<button type="button" class="rz-bar-job" data-act="rz-go" data-view="' + esc(jobView(j)) + '" title="' + esc(jobTitle(j) + (j.text ? ' — ' + j.text : '')) + '">'
        + '<span class="rz-spin"></span><span>' + esc(jobTitle(j)) + '</span>'
        + (running.length > 1 ? '<span class="rz-bar-more">+' + (running.length - 1) + '</span>' : '') + '</button>');
    }
    if (loaded) {
      var w = R.week();
      h.push('<div class="rz-bar-stats">'
        + '<span class="rz-bar-stat" title="Séances cette semaine (objectif ' + w.goal + ')">' + R.icon('target') + '<b>' + w.done + '</b>/' + w.goal + '</span>'
        + '<span class="rz-bar-stat" title="Niveau estimé (toutes compétences)">' + levelHtml(R.globalBand(), '') + '</span>'
        + '</div>');
    }
    A.setHtml(bar, h.join(''));
  }

  function jobTitle(j) {
    var t = { lesson: 'Cours en préparation', exercise: 'Exercices en préparation', toeic: 'Bilan en préparation', sw: 'Bilan en préparation' }[j.kind] || 'Préparation';
    return t + ' · ' + A.fmtClock(Date.now() - j.startedAt);
  }
  function jobView(j) { return j.kind === 'toeic' || j.kind === 'sw' ? 'tests' : (j.kind === 'exercise' ? 'exercises' : 'home'); }

  var scrollMemo = Object.create(null);
  function renderPage(host, enter) {
    if (!loaded) {
      host.removeAttribute('data-rz-view');
      A.setHtml(host, loadError
        ? '<div class="rz"><div class="rz-error">' + esc(loadError) + '<br>Révizator relit vos données dès que le serveur répond.</div>'
          + '<div class="rz-load-actions"><button type="button" class="btn btn-secondary" data-act="rz-reload">Réessayer</button>'
          + (bridge.mode === 'server' ? '' : ' <button type="button" class="btn btn-ghost" data-act="rz-settings">Réglages du serveur</button>') + '</div></div>'
        : '<div class="rz rz-loading"><span class="rz-spin"></span> Chargement de Révizator…</div>');
      return;
    }
    var id = R.viewId();
    var v = VIEWS[id];
    var inner = '';
    try { inner = v.render(enter || host.getAttribute('data-rz-view') !== id); } catch (e) {
      inner = '<div class="rz-error">Cette vue n’a pas pu s’afficher : ' + esc(e && e.message) + '</div>';
      if (window.console) console.error(e);
    }
    var els = host.querySelectorAll('[data-rz-scroll]');
    for (var i = 0; i < els.length; i++) scrollMemo[els[i].getAttribute('data-rz-scroll')] = els[i].scrollTop;
    var firstHere = host.getAttribute('data-rz-view') !== id;
    host.setAttribute('data-rz-view', id);
    A.setHtml(host, '<div class="rz rz-view-' + esc(id) + (firstHere ? ' enter' : '') + '"><div data-rz-conn>' + connBannerHtml() + '</div>' + inner + '</div>');
    els = host.querySelectorAll('[data-rz-scroll]');
    for (i = 0; i < els.length; i++) {
      var k = els[i].getAttribute('data-rz-scroll');
      if (scrollMemo[k] != null) els[i].scrollTop = scrollMemo[k];
    }
    if (v.after) { try { v.after(host); } catch (e) { if (window.console) console.error(e); } }
    syncPlayersDom();
    syncRecDom();
  }

  /* ══ Génération ═════════════════════════════════════════════════════════ */

  var JOBS = Object.create(null);
  R.jobs = function () { return Object.keys(JOBS).map(function (k) { return JOBS[k]; }).sort(function (a, b) { return a.startedAt - b.startedAt; }); };
  R.jobOf = function (kind) { var l = R.jobs().filter(function (j) { return j.kind === kind; }); return l[0] || null; };
  R.jobById = function (id) { return JOBS[id] || null; };

  function modelFor(kind, opts) {
    var pair = GEN_MODEL[kind] || ['genModel', 'genEffort'];
    var p = R.prefs;
    return {
      model: opts.model != null ? opts.model : (p[pair[0]] || ''),
      effort: opts.effort != null ? opts.effort : (pair[1] ? (p[pair[1]] || '') : '')
    };
  }

  R.gen = function (kind, params, opts) {
    opts = opts || {};
    var job = opts.job || uid('rz' + kind.slice(0, 3));
    if (JOBS[job]) return JOBS[job].promise;
    var m = modelFor(kind, opts);
    var ctx = opts.context != null ? opts.context : R.context(kind);
    var j = JOBS[job] = { job: job, kind: kind, params: params || {}, phase: 'start', text: '', startedAt: Date.now(), steps: [] };
    R.emit('job', j);
    if (!QUIET_KINDS[kind]) R.renderSoon();
    j.promise = bridge.call('learnGenerate', {
      job: job, kind: kind, model: m.model, effort: m.effort, params: params || {}, context: String(ctx || '').slice(0, 8000)
    }, opts.timeout || GEN_WAIT[kind] || 180000).then(function (r) {
      delete JOBS[job];
      if (r && r.doc && r.id) R.docPut(kind === 'toeic' ? 'toeic' : kind, r.id, r.doc);
      R.emit('jobDone', { kind: kind, job: job, params: params || {}, result: r });
      if (!QUIET_KINDS[kind]) R.renderSoon();
      return r;
    }, function (e) {
      delete JOBS[job];
      R.emit('jobDone', { kind: kind, job: job, params: params || {}, error: e });
      if (!QUIET_KINDS[kind]) R.renderSoon();
      throw e;
    });
    return j.promise;
  };
  R.cancel = function (job) {
    return bridge.call('learnCancel', { job: job }, 15000)['catch'](function () { return { cancelled: false }; });
  };

  var jobPatchAt = 0;
  function onLearnEvent(p) {
    p = p || {};
    var j = JOBS[p.job];
    if (!j) return;
    j.phase = p.phase || j.phase;
    if (p.text) {
      j.text = String(p.text);
      if (p.phase === 'tool' && j.steps[j.steps.length - 1] !== j.text) { j.steps.push(j.text); if (j.steps.length > 8) j.steps.shift(); }
    }
    R.emit('job', j);
    /* Avancement sur place : les lignes [data-rz-job] des vues, sans rendu complet. */
    var now = Date.now();
    if (now - jobPatchAt > 250) { jobPatchAt = now; patchJobs(); }
  }

  function patchJobs() {
    var els = document.querySelectorAll('[data-rz-job]');
    for (var i = 0; i < els.length; i++) {
      var j = JOBS[els[i].getAttribute('data-rz-job')];
      if (j) A.setHtml(els[i], jobLineInner(j));
    }
    var bar = document.getElementById('page-bar');
    if (bar && A.currentPage() === 'revizator') renderBar(bar);
  }

  function jobLineInner(j) {
    var phase = { start: 'Démarrage de l’agent…', menu: 'Menu du jour prêt', tool: '', write: 'Rédaction…', retry: 'Fiche régénérée…', check: 'Vérification…', done: 'Terminé', error: 'Erreur' }[j.phase] || '';
    var text = j.text || phase;
    return '<span class="rz-spin"></span><span class="rz-job-text">' + esc(text) + '</span><span class="rz-job-time">' + esc(A.fmtClock(Date.now() - j.startedAt)) + '</span>';
  }

  /* Reprise après un rechargement de la page : les générations encore en cours côté hôte sont réattachées. */
  function reattachJobs() {
    bridge.call('learnJobs', {}, 15000).then(function (r) {
      arr(r && r.running).forEach(function (rj) {
        if (!rj || !rj.job || JOBS[rj.job]) return;
        var j = JOBS[rj.job] = { job: rj.job, kind: rj.kind, params: {}, phase: rj.phase || 'start', text: rj.text || '', startedAt: num(rj.startedAt, Date.now()), steps: [], reattached: true };
        j.promise = bridge.call('learnWait', { job: rj.job }, GEN_WAIT[rj.kind] || 330000).then(function (res) {
          delete JOBS[rj.job];
          if (res && res.doc && res.id) R.docPut(rj.kind, res.id, res.doc);
          R.emit('jobDone', { kind: rj.kind, job: rj.job, params: {}, result: res, reattached: true });
          R.renderSoon();
          return res;
        }, function (e) {
          delete JOBS[rj.job];
          R.emit('jobDone', { kind: rj.kind, job: rj.job, params: {}, error: e, reattached: true });
          R.renderSoon();
        });
      });
      arr(r && r.recent).forEach(function (rr) {
        if (!rr || !rr.ok || !rr.job) return;
        bridge.call('learnWait', { job: rr.job }, 20000).then(function (res) {
          R.emit('jobDone', { kind: rr.kind, job: rr.job, params: {}, result: res, reattached: true });
        })['catch'](function () { /* déjà intégré */ });
      });
      R.renderSoon();
    })['catch'](function () { /* hôte plus ancien */ });
  }

  setInterval(function () { if (R.jobs().length && A && A.currentPage() === 'revizator') patchJobs(); }, 1000);

  /* ══ Modèle de l'apprenant ══════════════════════════════════════════════ */

  function thetaOf(level) {
    var m = /^\s*(A1|A2|B1|B2|C1|C2)\s*(\+)?/.exec(String(level || '').toUpperCase());
    if (!m) return null;
    return LEVELS.indexOf(m[1]) - 2 + (m[2] ? 0.35 : 0);
  }
  function band(theta) {
    if (theta == null || !isFinite(theta)) return '—';
    var k = clamp(Math.round(theta), -2, 3);
    var plus = theta - k >= 0.2 && k >= -1 && k <= 1;
    return LEVELS[k + 2] + (plus ? '+' : '');
  }
  function skill(id) {
    var s = subject().skills[id];
    if (!s) s = subject().skills[id] = { theta: thetaOf(R.profile.startLevel) || 0, n: 0, at: 0, hist: [] };
    return s;
  }
  function pushHist(s) {
    var d = today(), h = s.hist;
    var v = Math.round(s.theta * 100) / 100;
    if (h.length && h[h.length - 1][0] === d) h[h.length - 1][1] = v; else h.push([d, v]);
  }
  function conf(id, n) {
    var productive = id === 'write' || id === 'speak';
    if (n < (productive ? 3 : 12)) return 'faible';
    if (n < (productive ? 8 : 40)) return 'moyenne';
    return 'bonne';
  }

  R.thetaOf = thetaOf; R.band = band;
  R.level = function (id) {
    var s = skill(id);
    return { theta: s.theta, band: band(s.theta), n: s.n, conf: conf(id, s.n), at: s.at, hist: s.hist };
  };
  R.globalBand = function () {
    var t = 0, w = 0;
    SKILLS.forEach(function (k) { var s = skill(k.id); var wt = k.id === 'lang' ? 0.5 : 1; t += s.theta * wt; w += wt; });
    return band(t / w);
  };
  R.globalTheta = function () {
    var t = 0, w = 0;
    SKILLS.forEach(function (k) { var s = skill(k.id); var wt = k.id === 'lang' ? 0.5 : 1; t += s.theta * wt; w += wt; });
    return t / w;
  };
  /* Réponse à un item réceptif (lecture, écoute, langue) : un « match » apprenant / item (Elo, logit). */
  R.observe = function (id, cefr, x, weight) {
    var s = skill(id);
    var b = thetaOf(cefr);
    if (b == null) b = s.theta;
    x = clamp(num(x, 0), 0, 1);
    var p = 1 / (1 + Math.exp(-(s.theta - b)));
    var k = Math.max(0.6 / (1 + 0.05 * s.n), 0.08) * clamp(num(weight, 1), 0.1, 3);
    s.theta = clamp(s.theta + k * (x - p), -3, 3.5);
    s.n++; s.at = Date.now();
    pushHist(s);
    R.save();
    return s.theta;
  };
  /* Niveau estimé d'une production (écrit, oral) par le correcteur : on s'en rapproche, plus vite au début. */
  R.observeLevel = function (id, level, weight) {
    var s = skill(id);
    var obs = thetaOf(level);
    if (obs == null) return s.theta;
    var k = Math.max(0.5 / (1 + 0.12 * s.n), 0.12) * clamp(num(weight, 1), 0.1, 3);
    s.theta = clamp(s.theta + k * (obs - s.theta), -3, 3.5);
    s.n++; s.at = Date.now();
    pushHist(s);
    R.save();
    return s.theta;
  };
  /* Une observation à fort poids (bilan) : le niveau d'une compétence est recalé. */
  R.calibrate = function (id, theta, weight) {
    var s = skill(id);
    var k = clamp(num(weight, 0.6), 0, 1);
    s.theta = clamp(s.theta + k * (num(theta, s.theta) - s.theta), -3, 3.5);
    s.n = Math.max(s.n, 12); s.at = Date.now();
    pushHist(s);
    R.save();
  };

  R.explainLang = function () {
    var p = R.profile.explain;
    if (p === 'fr' || p === 'en') return p;
    var t = R.globalTheta();
    return t < 0.5 ? 'fr' : (t < 1.5 ? 'mixed' : 'en');
  };

  R.addErrors = function (edits, meta) {
    var errs = subject().errors;
    var now = Date.now();
    arr(edits).forEach(function (e) {
      if (!e || e.type === 'improvement') return;
      var cat = CATEGORIES[e.category] ? e.category : (String(e.category || '').indexOf('lex.') === 0 ? 'lex.word_choice' : 'gram.other');
      var x = errs[cat] = errs[cat] || { count: 0, lastSeen: 0, examples: [], correctUses: 0, status: 'active' };
      x.count++; x.lastSeen = now; x.status = 'active';
      x.examples = arr(x.examples);
      if (e.original || e.correction) x.examples.unshift({ original: String(e.original || '').slice(0, 200), correction: String(e.correction || '').slice(0, 200), at: now, mode: meta && meta.mode || '' });
      if (x.examples.length > 5) x.examples.length = 5;
    });
    R.save();
  };
  R.weakPoints = function (n) {
    var errs = subject().errors, now = Date.now();
    return Object.keys(errs).map(function (k) {
      var e = errs[k];
      var days = Math.max(0, (now - num(e.lastSeen, 0)) / 86400000);
      return { category: k, label: R.categoryLabel(k), count: num(e.count, 0), lastSeen: e.lastSeen, examples: arr(e.examples), status: e.status,
        score: num(e.count, 0) * Math.exp(-days / 30) };
    }).filter(function (e) { return e.status !== 'mastered' && e.count > 0; })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, n || 6);
  };

  R.logSession = function (o) {
    o = o || {};
    var s = {
      id: o.id || uid('se'), kind: o.kind || 'lesson', ref: o.ref || '', title: String(o.title || '').slice(0, 160),
      startedAt: num(o.startedAt, Date.now()), endedAt: num(o.endedAt, Date.now()),
      minutes: 0, skillMinutes: {}, score: o.score == null ? null : o.score
    };
    var sm = obj(o.skillMinutes) || {};
    var total = 0;
    ['read', 'listen', 'write', 'speak', 'lang', 'srs'].forEach(function (k) { var v = Math.max(0, num(sm[k], 0)); if (v) { s.skillMinutes[k] = Math.round(v * 10) / 10; total += v; } });
    s.minutes = Math.round((o.minutes != null ? num(o.minutes, total) : (total || (s.endedAt - s.startedAt) / 60000)) * 10) / 10;
    subject().sessions.push(s);
    R.save();
    return s;
  };

  function weekStart(ms) {
    var d = new Date(ms || Date.now());
    var day = (d.getDay() + 6) % 7;
    d.setHours(0, 0, 0, 0);
    return d.getTime() - day * 86400000;
  }
  R.weekStart = weekStart;
  R.week = function (ms) {
    var from = weekStart(ms), to = from + 7 * 86400000;
    var list = subject().sessions.filter(function (s) { return s.startedAt >= from && s.startedAt < to; });
    var bySkill = { read: 0, listen: 0, write: 0, speak: 0, lang: 0, srs: 0 };
    var minutes = 0, done = 0, days = {};
    list.forEach(function (s) {
      minutes += num(s.minutes, 0);
      Object.keys(s.skillMinutes || {}).forEach(function (k) { if (bySkill[k] != null) bySkill[k] += num(s.skillMinutes[k], 0); });
      if (num(s.minutes, 0) >= 5) { done++; days[dayOf(s.startedAt)] = 1; }
    });
    return { from: from, done: done, days: Object.keys(days).length, goal: R.profile.weeklyGoal, minutes: Math.round(minutes), bySkill: bySkill, sessions: list };
  };

  R.active = function () { return subject().active; };
  R.setActive = function (a) { subject().active = a ? Object.assign({ updatedAt: Date.now() }, a) : null; R.save(); };

  /* Contexte de l'apprenant pour les générations : ce qu'un professeur saurait de lui. */
  R.context = function (kind) {
    var d = subject(), p = d.profile, L = [];
    L.push('Apprenant : adulte francophone, développeur, qui réapprend l’anglais (sessions de 10 à 45 minutes).');
    if (p.goal) L.push('Objectif : ' + String(p.goal).slice(0, 300));
    if (p.interests) L.push('Centres d’intérêt : ' + String(p.interests).slice(0, 400));
    var lv = SKILLS.map(function (k) { var l = R.level(k.id); return k.label.toLowerCase() + ' ' + l.band + (l.conf === 'faible' ? ' (à confirmer)' : ''); });
    L.push('Niveau estimé : ' + R.globalBand() + ' en moyenne — ' + lv.join(', ') + '.');
    var t = d.toeic;
    if (t && (t.L || t.R)) {
      L.push('Dernier bilan type TOEIC : ' + (t.L ? 'écoute ≈ ' + Math.round(t.L.mean) : '') + (t.L && t.R ? ', ' : '') + (t.R ? 'lecture ≈ ' + Math.round(t.R.mean) : '') + '.');
    }
    var weak = R.weakPoints(6);
    if (weak.length) {
      L.push('Points faibles (journal d’erreurs, du plus actif au moins actif) :');
      weak.forEach(function (w) {
        var ex = w.examples[0];
        L.push('- ' + w.label + ' [' + w.category + '] : ' + w.count + ' fois' + (ex ? ' — ex. « ' + ex.original + ' » → « ' + ex.correction + ' »' : ''));
      });
    }
    var recent = d.lessons.slice(-8).reverse();
    if (recent.length) {
      L.push('Derniers cours (ne pas reprendre le même sujet ; faire tourner les rubriques, la grammaire et le genre d’écrit) :');
      recent.forEach(function (l) {
        L.push('- ' + (l.day || '') + ' ' + (l.rubric || '') + (l.tone ? ', ' + l.tone : '') + ' : « ' + (l.title || '') + ' »'
          + (arr(l.keywords).length ? ' (' + arr(l.keywords).slice(0, 5).join(', ') + ')' : '')
          + (l.grammar ? ' — grammaire : ' + l.grammar : '') + (l.genre ? ' ; écrit : ' + l.genre : ''));
      });
    }
    var known = [];
    d.cards.forEach(function (c) { var f = c && (c.term || c.front); if (f && known.length < 150) known.push(String(f).replace(/\s+/g, ' ').slice(0, 40)); });
    if (known.length) L.push('Cartes déjà connues (ne pas recréer) : ' + known.join(', ') + '.');
    var ex = R.explainLang();
    L.push('Langue des explications : ' + (ex === 'fr' ? 'français' : (ex === 'mixed' ? 'anglais simple, avec des notes contrastives en français' : 'anglais')) + '.');
    return L.join('\n').slice(0, 8000);
  };

  /* ══ Audio : synthèse vocale et lecture ═════════════════════════════════ */

  R.env = { learnUrl: 'https://learn.organizator/', ttsUrl: 'https://tts.organizator/' };
  var TTS = { status: null, busy: false, sysVoices: [] };
  R.players = Object.create(null);
  var SOURCES = Object.create(null);

  function loadSysVoices() {
    try {
      if (!window.speechSynthesis) return;
      TTS.sysVoices = window.speechSynthesis.getVoices().filter(function (v) { return /^en[-_]/i.test(v.lang); });
    } catch (e) { TTS.sysVoices = []; }
  }
  if (window.speechSynthesis) {
    loadSysVoices();
    try { window.speechSynthesis.onvoiceschanged = loadSysVoices; } catch (e) { /* navigateur sans événement */ }
  }

  function engine() {
    var pref = R.isLoaded() ? R.prefs.engine : 'auto';
    var kokoro = !!(TTS.status && TTS.status.ready);
    if (pref === 'kokoro') return kokoro ? 'kokoro' : (TTS.sysVoices.length ? 'system' : 'none');
    if (pref === 'system') return TTS.sysVoices.length ? 'system' : (kokoro ? 'kokoro' : 'none');
    return kokoro ? 'kokoro' : (TTS.sysVoices.length ? 'system' : 'none');
  }

  function sysVoiceFor(accent, gender, n) {
    var lang = String(accent || 'en-US').toLowerCase();
    var list = TTS.sysVoices.filter(function (v) { return String(v.lang).toLowerCase().replace('_', '-') === lang; });
    if (!list.length) list = TTS.sysVoices.filter(function (v) { return /^en-us/i.test(v.lang.replace('_', '-')); });
    if (!list.length) list = TTS.sysVoices.slice();
    if (!list.length) return '';
    var g = list.filter(function (v) { return (gender === 'male') !== FEMALE_NAMES.test(v.name); });
    var pick = (g.length ? g : list);
    return pick[(n || 0) % pick.length].voiceURI;
  }

  function kokoroVoiceFor(accent, gender, n) {
    var acc = KOKORO[accent] ? accent : (/^en-(au|ie|nz)/i.test(accent || '') ? 'en-GB' : 'en-US');
    var g = gender === 'male' ? 'male' : 'female';
    var list = KOKORO[acc][g].slice();
    var pref = acc === 'en-GB' ? R.prefs.voiceGb : R.prefs.voiceUs;
    var i = list.indexOf(pref);
    if (i > 0) { list.splice(i, 1); list.unshift(pref); }
    return list[(n || 0) % list.length];
  }

  R.tts = {
    status: function () { return TTS.status; },
    ready: function () { return !!(TTS.status && TTS.status.ready); },
    engine: engine,
    systemVoices: function () { return TTS.sysVoices.slice(); },
    voiceLabel: function (id) { return VOICE_LABELS[id] || id; },
    refresh: function () {
      return bridge.call('ttsStatus', {}, 15000).then(function (s) { TTS.status = s; R.renderSoon(); return s; },
        function () { TTS.status = null; return null; });
    },
    download: function () {
      if (TTS.busy) return Promise.resolve(TTS.status);
      TTS.busy = true;
      R.ui.ttsDl = { received: 0, total: 0, error: '' };
      R.renderSoon();
      return bridge.call('ttsDownload', {}, 3600000).then(function (s) {
        TTS.busy = false; TTS.status = s; R.ui.ttsDl = null;
        R.toast('Voix naturelles prêtes : Révizator parle désormais avec elles.');
        R.renderSoon();
        return s;
      }, function (e) {
        TTS.busy = false; R.ui.ttsDl = { error: e.message };
        /* L'hôte préfixe déjà son message (« Téléchargement des voix impossible : réseau… ») : pas de doublon. */
        R.toast(/^Téléchargement des voix impossible/.test(e.message) ? e.message : 'Téléchargement des voix impossible : ' + e.message);
        R.renderSoon();
        throw e;
      });
    },
    downloading: function () { return TTS.busy || !!(TTS.status && TTS.status.model && TTS.status.model.downloading); },
    remove: function () {
      return bridge.call('ttsRemove', {}, 60000).then(function (r) { return R.tts.refresh().then(function () { return r; }); });
    },
    voice: function (accent, gender, n) {
      var e = engine();
      if (e === 'kokoro') return kokoroVoiceFor(accent, gender, n);
      if (e === 'system') return sysVoiceFor(accent, gender, n);
      return '';
    },
    /* Une voix par locuteur, distinctes à accent et sexe égaux. */
    voicesFor: function (speakers) {
      var used = {}, out = {};
      arr(speakers).forEach(function (s) {
        var key = (s.accent || 'en-US') + '|' + (s.gender || 'female');
        var n = used[key] = (used[key] == null ? 0 : used[key] + 1);
        out[s.id] = R.tts.voice(s.accent || 'en-US', s.gender || 'female', n);
      });
      return out;
    },
    say: function (text, opts) {
      opts = opts || {};
      var voice = opts.voice || R.tts.voice(opts.accent || 'en-US', opts.gender || 'female', opts.n || 0);
      return makePlayer(opts.key || uid('say'), [{ line: 0, voice: voice, text: String(text || '') }], opts);
    },
    script: function (lines, speakers, opts) {
      opts = opts || {};
      var voices = R.tts.voicesFor(speakers);
      var fallback = R.tts.voice('en-US', 'female', 0);
      var segs = arr(lines).map(function (l, i) { return { line: i, voice: voices[l.speaker] || fallback, text: String(l.text || '') }; })
        .filter(function (s) { return s.text.trim(); });
      return makePlayer(opts.key || uid('scr'), segs, opts);
    },
    stopAll: function () { Object.keys(R.players).forEach(function (k) { var p = R.players[k]; if (p && (p.state === 'playing' || p.state === 'loading')) p.stop(); }); }
  };
  R.audio = function (url, opts) { opts = opts || {}; return makePlayer(opts.key || uid('aud'), [{ line: 0, url: url }], Object.assign({ engine: 'url' }, opts)); };

  /* Un lecteur : une suite de segments (une ligne de dialogue chacun) lus l'un après l'autre.
     Kokoro : l'hôte synthétise phrase par phrase et annonce chaque fichier (événement tts « sentence »),
     la lecture commence à la première. Voix système : speechSynthesis. Sans aucune voix : un minuteur
     qui simule la durée (la page reste utilisable, le texte est affiché). */
  function makePlayer(key, segs, opts) {
    var old = R.players[key];
    if (old) old.stop(true);
    if (!opts.overlap) R.tts.stopAll();
    var eng = opts.engine || engine();
    var listeners = [], lineListeners = [];
    var p = {
      key: key, state: 'loading', line: -1, error: '', rate: clamp(num(opts.rate, 1), 0.5, 2), engine: eng,
      speed: clamp(num(opts.speed, R.isLoaded() ? R.prefs.speed : 1), 0.7, 1.3),
      onChange: function (fn) { listeners.push(fn); return p; },
      /* Passage à un autre segment (ligne de dialogue) : rang du segment, -1 à la fin. */
      onLine: function (fn) { lineListeners.push(fn); return p; }
    };
    var resolveDone;
    p.done = new Promise(function (res) { resolveDone = res; });
    var stopped = false, paused = false, queue = [], complete = false, cursor = { line: 0, idx: 0 }, audio = null, gapTimer = null, job = uid('tts');
    var timerSim = null, utter = null;

    function set(state, err) {
      if (p.state === state && !err) return;
      p.state = state;
      if (err) p.error = err;
      listeners.forEach(function (fn) { try { fn(p); } catch (e) { /* lecteur seulement */ } });
      syncPlayerDom(p);
      if (state === 'ended' || state === 'error') resolveDone(p);
    }
    function setLine(i) {
      if (p.line === i) return;
      p.line = i;
      lineListeners.forEach(function (fn) { try { fn(i, p); } catch (e) { /* lecteur seulement */ } });
      syncPlayerDom(p);
    }

    function nextItem() {
      for (var k = 0; k < queue.length; k++) { var q = queue[k]; if (q.line === cursor.line && q.index === cursor.idx) return q; }
      var later = queue.some(function (q) { return q.line > cursor.line || (q.line === cursor.line && q.index > cursor.idx); });
      if (later || complete) {
        /* La ligne courante est finie : on passe à la suivante. */
        var hasLine = queue.some(function (q) { return q.line > cursor.line; });
        if (!hasLine && complete) return 'end';
        if (!hasLine) return null;
        var nl = Infinity;
        queue.forEach(function (q) { if (q.line > cursor.line && q.line < nl) nl = q.line; });
        cursor = { line: nl, idx: 0 };
        return nextItem() || null;
      }
      return null;
    }

    /* Une phrase à la fois. Pendant le blanc entre deux lignes, aucun son ne joue mais la suivante
       est déjà programmée (gapTimer) : une phrase annoncée par l'hôte à ce moment, ou la fin de la
       synthèse, relançait pump, qui reprogrammait la même phrase — deux minuteurs, deux voix
       superposées, dont une qu'aucun « stop » n'atteignait plus. Chaque son ne répond plus que
       pour lui-même : un son remplacé ne fait plus avancer la lecture. */
    function pump() {
      if (stopped || paused || audio || gapTimer) return;
      var it = nextItem();
      if (it === 'end') { setLine(-1); set('ended'); return; }
      if (!it) { if (p.state !== 'loading') set('loading'); return; }
      var gap = it.line !== p.line && p.line >= 0 ? num(opts.gapMs, 450) : 0;
      var go = function () {
        gapTimer = null;
        if (stopped || paused || audio) return;
        setLine(it.line);
        var a = audio = new Audio(it.url);
        a.playbackRate = p.rate;
        a.onended = function () { if (audio !== a) return; audio = null; cursor.idx++; pump(); };
        a.onerror = function () { if (audio !== a) return; audio = null; set('error', 'lecture du son impossible'); };
        var pr = a.play();
        if (pr && pr.then) pr.then(function () { if (audio === a) set('playing'); }, function (e) { if (audio !== a) return; audio = null; set('error', e && e.message || 'lecture refusée'); });
        else set('playing');
      };
      if (gap) gapTimer = setTimeout(go, gap / p.rate); else go();
    }

    function startKokoro() {
      var off = bridge.on('tts', function (ev) {
        if (!ev || ev.job !== job) return;
        if (ev.phase === 'sentence' && ev.url) {
          var line = segs.length > 1 ? num(ev.line, 0) : 0;
          queue.push({ line: line, index: num(ev.index, 0), url: ev.url, duration: num(ev.duration, 0) });
          pump();
        } else if (ev.phase === 'error') {
          set('error', ev.error || 'synthèse impossible');
        }
      });
      var call = segs.length === 1 && !opts.forceScript
        ? bridge.call('speak', { job: job, text: segs[0].text, voice: segs[0].voice, speed: p.speed }, 180000).then(function (r) {
          arr(r && r.sentences).forEach(function (s) {
            if (!queue.some(function (q) { return q.line === 0 && q.index === s.index; })) queue.push({ line: 0, index: num(s.index, 0), url: s.url, duration: num(s.duration, 0) });
          });
        })
        : bridge.call('speakScript', { job: job, speed: p.speed, gapMs: num(opts.gapMs, 450), lines: segs.map(function (s) { return { id: String(s.line), voice: s.voice, text: s.text }; }) }, 600000).then(function (r) {
          arr(r && r.lines).forEach(function (l) {
            arr(l.sentences).forEach(function (s) {
              var line = num(l.id, 0);
              if (!queue.some(function (q) { return q.line === line && q.index === s.index; })) queue.push({ line: line, index: num(s.index, 0), url: s.url, duration: num(s.duration, 0) });
            });
          });
        });
      call.then(function () { complete = true; off(); pump(); }, function (e) { off(); if (!stopped) set('error', e.message); });
    }

    function startUrl() {
      queue.push({ line: 0, index: 0, url: segs[0].url });
      complete = true;
      pump();
    }

    /* Voix système : une phrase à la fois, pour pouvoir surligner la ligne et faire une pause. */
    var sysIdx = 0;
    function startSystem() {
      var synth = window.speechSynthesis;
      var speakNext = function () {
        if (stopped) return;
        if (sysIdx >= segs.length) { setLine(-1); set('ended'); return; }
        var s = segs[sysIdx];
        var gap = sysIdx > 0 ? num(opts.gapMs, 450) : 0;
        gapTimer = setTimeout(function () {
          gapTimer = null;
          if (stopped) return;
          setLine(s.line);
          utter = new SpeechSynthesisUtterance(s.text);
          var v = TTS.sysVoices.filter(function (x) { return x.voiceURI === s.voice; })[0];
          if (v) { utter.voice = v; utter.lang = v.lang; } else utter.lang = 'en-US';
          utter.rate = p.speed * p.rate;
          utter.onend = function () { utter = null; sysIdx++; speakNext(); };
          utter.onerror = function (e) { utter = null; if (!stopped && e && e.error !== 'interrupted' && e.error !== 'canceled') set('error', e.error === 'not-allowed' ? 'Lecture bloquée : cliquez sur ▶' : 'voix système : ' + e.error); };
          set('playing');
          synth.speak(utter);
        }, gap);
      };
      speakNext();
      p._sysResume = function () { synth.resume(); set('playing'); };
      p._sysPause = function () { synth.pause(); set('paused'); };
    }

    /* Aucune voix : la durée est simulée (2,6 mots par seconde). */
    function startSilent() {
      var i = 0, left = 0, since = 0;
      var arm = function (ms) { left = ms; since = Date.now(); timerSim = setTimeout(function () { timerSim = null; i++; tick(); }, ms); };
      var tick = function () {
        if (stopped) return;
        if (i >= segs.length) { setLine(-1); set('ended'); return; }
        setLine(segs[i].line);
        set('playing');
        arm(Math.max(600, count(segs[i].text) / 2.6 * 1000 / p.rate));
      };
      p._silentPause = function () { if (timerSim) { clearTimeout(timerSim); timerSim = null; left = Math.max(0, left - (Date.now() - since)); } set('paused'); };
      p._silentResume = function () { set('playing'); arm(left); };
      tick();
    }

    p.play = function () {
      if (p.state === 'ended' || p.state === 'error') return p.replay();
      if (!paused) return p;
      paused = false;
      if (eng === 'system' && p._sysResume) { p._sysResume(); return p; }
      if (p._silentResume) { p._silentResume(); return p; }
      if (audio) { var pr = audio.play(); if (pr && pr.then) pr.then(function () { set('playing'); }, function () { /* refus */ }); else set('playing'); }
      else pump();
      return p;
    };
    p.pause = function () {
      if (p.state !== 'playing') return p;
      paused = true;
      if (eng === 'system' && p._sysPause) { p._sysPause(); return p; }
      if (p._silentPause) { p._silentPause(); return p; }
      if (audio) audio.pause();
      if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
      set('paused');
      return p;
    };
    p.toggle = function () { return p.state === 'playing' ? p.pause() : p.play(); };
    p.stop = function (silent) {
      stopped = true;
      if (audio) { try { audio.pause(); } catch (e) { /* déjà arrêté */ } audio = null; }
      if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
      if (timerSim) { clearTimeout(timerSim); timerSim = null; }
      if (eng === 'system' && window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) { /* rien à arrêter */ } }
      if (eng === 'kokoro' && !complete) bridge.call('cancelSpeak', { job: job }, 15000)['catch'](function () { /* déjà finie */ });
      p.line = -1;
      if (!silent) set('ended'); else { p.state = 'ended'; resolveDone(p); }
      if (R.players[key] === p) syncPlayerDom(p);
      return p;
    };
    p.replay = function () {
      var np = makePlayer(key, segs, Object.assign({}, opts, { rate: p.rate, speed: p.speed }));
      listeners.forEach(function (fn) { np.onChange(fn); });
      lineListeners.forEach(function (fn) { np.onLine(fn); });
      return np;
    };
    p.setRate = function (r) {
      p.rate = clamp(num(r, 1), 0.5, 2);
      if (audio) audio.playbackRate = p.rate;
      syncPlayerDom(p);
      return p;
    };

    R.players[key] = p;
    if (eng === 'url') startUrl();
    else if (eng === 'kokoro') startKokoro();
    else if (eng === 'system') startSystem();
    else startSilent();
    return p;
  }

  /* Boutons et surlignage sur place : un lecteur qui avance ne provoque pas de rendu complet. */
  function syncPlayerDom(p) {
    if (!p) return;
    var btns = document.querySelectorAll('[data-rz-player="' + cssEsc(p.key) + '"]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.setAttribute('data-state', p.state);
      var t = b.querySelector('.rz-player-toggle');
      if (t) {
        var playing = p.state === 'playing' || p.state === 'loading';
        t.innerHTML = (p.state === 'loading' ? '<span class="rz-spin"></span>' : R.icon(playing ? 'pause' : 'play'))
          + '<span>' + esc(playing ? (p.state === 'loading' ? 'Préparation…' : 'Pause') : (p.state === 'paused' ? 'Reprendre' : (b.getAttribute('data-label') || 'Écouter'))) + '</span>';
        t.setAttribute('aria-pressed', playing ? 'true' : 'false');
      }
      var rates = b.querySelectorAll('[data-act="rz-player-speed"]');
      for (var r = 0; r < rates.length; r++) rates[r].classList.toggle('on', Math.abs(num(rates[r].getAttribute('data-rate'), 1) - p.rate) < 0.01);
    }
    var lines = document.querySelectorAll('[data-rz-say="' + cssEsc(p.key) + '"]');
    for (var j = 0; j < lines.length; j++) {
      lines[j].classList.toggle('is-speaking', p.state !== 'ended' && +lines[j].getAttribute('data-rz-idx') === p.line);
    }
  }
  function syncPlayersDom() { Object.keys(R.players).forEach(function (k) { syncPlayerDom(R.players[k]); }); }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  R.h = {};
  R.h.player = function (key, o) {
    o = o || {};
    SOURCES[key] = { source: o.source, maxPlays: o.maxPlays || 0 };
    var p = R.players[key];
    var plays = R.ui.plays[key] || 0;
    var limited = o.maxPlays && plays >= o.maxPlays && (!p || p.state === 'ended');
    var st = p ? p.state : 'idle';
    var playing = st === 'playing' || st === 'loading';
    var label = o.label || 'Écouter';
    var h = '<div class="rz-player' + (o.small ? ' is-small' : '') + '" data-rz-player="' + esc(key) + '" data-state="' + esc(st) + '" data-label="' + esc(label) + '">';
    h += '<button type="button" class="rz-player-toggle" data-act="rz-player-toggle" data-key="' + esc(key) + '"' + (limited ? ' disabled title="Écoutes épuisées"' : '') + ' aria-pressed="' + (playing ? 'true' : 'false') + '">'
      + (st === 'loading' ? '<span class="rz-spin"></span>' : R.icon(playing ? 'pause' : 'play'))
      + '<span>' + esc(playing ? (st === 'loading' ? 'Préparation…' : 'Pause') : (st === 'paused' ? 'Reprendre' : label)) + '</span></button>';
    if (!o.maxPlays || o.replay) h += '<button type="button" class="rz-player-btn" data-act="rz-player-replay" data-key="' + esc(key) + '" title="Reprendre depuis le début" aria-label="Reprendre depuis le début"' + (limited ? ' disabled' : '') + '>' + R.icon('replay') + '</button>';
    if (o.speeds !== false && !o.maxPlays) {
      var rate = p ? p.rate : 1;
      h += '<span class="rz-player-rates" role="group" aria-label="Vitesse">' + [0.8, 1, 1.15].map(function (r) {
        return '<button type="button" class="rz-rate' + (Math.abs(rate - r) < 0.01 ? ' on' : '') + '" data-act="rz-player-speed" data-key="' + esc(key) + '" data-rate="' + r + '">' + String(r).replace('.', ',') + '×</button>';
      }).join('') + '</span>';
    }
    if (o.maxPlays) h += '<span class="rz-player-plays">' + esc(Math.max(0, o.maxPlays - plays) + ' écoute' + (o.maxPlays - plays > 1 ? 's' : '') + ' restante' + (o.maxPlays - plays > 1 ? 's' : '')) + '</span>';
    if (p && p.state === 'error') h += '<span class="rz-player-err">' + esc(p.error) + '</span>';
    return h + '</div>';
  };

  function playerToggle(key) {
    var p = R.players[key];
    var src = SOURCES[key];
    if (p && (p.state === 'playing' || p.state === 'loading' || p.state === 'paused')) { p.toggle(); return; }
    if (!src || typeof src.source !== 'function') return;
    var plays = R.ui.plays[key] || 0;
    if (src.maxPlays && plays >= src.maxPlays) return;
    R.ui.plays[key] = plays + 1;
    var np = src.source();
    if (np && np.key !== key) { /* le lecteur doit porter la clé du bouton */ R.players[key] = np; np.key = key; }
    syncPlayersDom();
  }

  /* ══ Micro et transcription ═════════════════════════════════════════════ */

  R.rec = {
    start: function (opts) { return A.recordVoice(opts || {}); },
    busy: function () { return A.recording(); }
  };
  var REC_OPTS = Object.create(null), REC_LIVE = Object.create(null);

  R.stt = function (data, opts) {
    opts = opts || {};
    var job = opts.job || uid('rzstt');
    /* L'indice d'accent (P(en) à la détection libre) refait un passage de Whisper : seulement sur demande. */
    var payload = { job: job, data: data, model: R.prefs.whisperModel || 'small', language: 'en', detail: true, accent: !!opts.accent };
    if (opts.reference) payload.reference = String(opts.reference).slice(0, 2000);
    if (opts.keep) payload.keep = true;
    return bridge.call('transcribe', payload, 3600000);
  };

  R.recState = function (key) { return R.ui.rec[key] || { phase: 'idle' }; };

  R.h.rec = function (key, o) {
    o = o || {};
    REC_OPTS[key] = o;
    var st = R.ui.rec[key] || { phase: 'idle' };
    var h = '<div class="rz-rec" data-rz-rec="' + esc(key) + '" data-phase="' + esc(st.phase) + '">';
    if (st.phase === 'recording' || st.phase === 'starting') {
      h += '<button type="button" class="rz-rec-stop" data-act="rz-rec-stop" data-key="' + esc(key) + '" title="Terminer (Espace)">' + R.icon('stop') + '<span>Terminer</span></button>'
        + '<span class="rz-rec-dot"></span><span class="rz-rec-time">' + esc(A.fmtClock(st.ms || 0)) + (o.maxMs ? ' / ' + esc(A.fmtClock(o.maxMs)) : '') + '</span>'
        + '<span class="rz-rec-level"><i style="transform:scaleX(' + Math.max(0.04, st.level || 0).toFixed(3) + ')"></i></span>'
        + '<button type="button" class="rz-rec-cancel" data-act="rz-rec-cancel" data-key="' + esc(key) + '" title="Annuler" aria-label="Annuler l’enregistrement">' + R.icon('cross') + '</button>';
    } else if (st.phase === 'processing') {
      h += '<span class="rz-spin"></span><span class="rz-rec-label">' + esc(st.label || 'Transcription…') + '</span>';
    } else {
      h += '<button type="button" class="rz-rec-start" data-act="rz-rec-start" data-key="' + esc(key) + '"' + (o.disabled ? ' disabled' : '') + ' title="Enregistrer (Espace)">'
        + R.icon('mic') + '<span>' + esc(st.phase === 'done' ? (o.againLabel || 'Recommencer') : (o.label || 'Parler')) + '</span></button>';
      if (st.error) h += '<span class="rz-rec-err">' + esc(st.error) + '</span>';
      if (st.phase === 'done' && st.url) h += R.h.player(key + ':me', { label: 'Me réécouter', small: true, speeds: false, source: function () { return R.audio(st.url, { key: key + ':me' }); } });
    }
    return h + '</div>';
  };

  function syncRecDom() {
    Object.keys(REC_LIVE).forEach(function (k) {
      var st = R.ui.rec[k];
      var el = document.querySelector('[data-rz-rec="' + cssEsc(k) + '"]');
      if (!el || !st) return;
      var t = el.querySelector('.rz-rec-time');
      var o = REC_OPTS[k] || {};
      if (t) t.textContent = A.fmtClock(st.ms || 0) + (o.maxMs ? ' / ' + A.fmtClock(o.maxMs) : '');
      var bar = el.querySelector('.rz-rec-level i');
      if (bar) bar.style.transform = 'scaleX(' + Math.max(0.04, st.level || 0).toFixed(3) + ')';
    });
  }

  function recStart(key) {
    var o = REC_OPTS[key] || {};
    if (o.disabled) return;
    if (R.rec.busy()) { R.toast('Le micro est déjà pris par un autre enregistrement.'); return; }
    R.tts.stopAll();
    var st = R.ui.rec[key] = { phase: 'starting', ms: 0, level: 0 };
    R.render();
    R.rec.start({
      maxMs: o.maxMs || 300000,
      noiseSuppression: o.noiseSuppression,
      onTick: function (ms, level) { st.ms = ms; st.level = level; syncRecDom(); },
      onLimit: function () { /* la fin est prise en charge ci-dessous */ }
    }).then(function (rec) {
      if (R.ui.rec[key] !== st) { rec.cancel(); return; }
      st.phase = 'recording';
      st.rec = rec;
      REC_LIVE[key] = 1;
      if (o.onStart) { try { o.onStart(); } catch (e) { /* module */ } }
      R.render();
      if (o.maxMs) {
        st.limitTimer = setTimeout(function () { if (R.ui.rec[key] === st && st.phase === 'recording') recStop(key); }, o.maxMs + 50);
      }
    }, function (e) {
      if (R.ui.rec[key] !== st) return;
      R.ui.rec[key] = { phase: 'idle', error: 'Micro indisponible : ' + e.message };
      R.render();
    });
  }

  function recStop(key) {
    var st = R.ui.rec[key];
    var o = REC_OPTS[key] || {};
    if (!st || st.phase !== 'recording' || !st.rec) return;
    if (st.limitTimer) clearTimeout(st.limitTimer);
    delete REC_LIVE[key];
    st.phase = 'processing';
    st.label = 'Préparation du son…';
    R.render();
    st.rec.stop().then(function (audio) {
      if (R.ui.rec[key] !== st) return null;
      audio.url = URL.createObjectURL(audio.blob);
      st.audio = audio;
      if (!o.stt) return { audio: audio, stt: null };
      st.label = 'Transcription…';
      var job = uid('rzstt');
      st.job = job;
      R.patch('[data-rz-rec="' + cssEsc(key) + '"] .rz-rec-label', esc(st.label));
      return R.stt(audio.data, { reference: o.stt.reference, keep: o.stt.keep, job: job }).then(function (t) { return { audio: audio, stt: t }; });
    }).then(function (res) {
      if (!res || R.ui.rec[key] !== st) return;
      R.ui.rec[key] = { phase: 'done', url: (res.stt && res.stt.url) || res.audio.url, seconds: res.audio.seconds };
      if (o.onResult) { try { o.onResult(res); } catch (e) { if (window.console) console.error(e); } }
      R.render();
    }, function (e) {
      if (R.ui.rec[key] !== st) return;
      R.ui.rec[key] = { phase: 'idle', error: e.message === 'rien d’enregistré' ? 'Rien d’enregistré : parlez après avoir cliqué.' : 'Échec : ' + e.message };
      R.render();
    });
  }

  function recCancel(key) {
    var st = R.ui.rec[key];
    if (!st) return;
    if (st.limitTimer) clearTimeout(st.limitTimer);
    delete REC_LIVE[key];
    if (st.rec) st.rec.cancel();
    if (st.job) bridge.call('cancelTranscribe', { job: st.job }, 15000)['catch'](function () { /* déjà finie */ });
    R.ui.rec[key] = { phase: 'idle' };
    R.render();
  }

  R.recToggle = function (key) {
    var st = R.ui.rec[key];
    if (st && st.phase === 'recording') recStop(key);
    else if (!st || st.phase === 'idle' || st.phase === 'done') recStart(key);
  };
  R.recReset = function (key) { if (R.ui.rec[key] && R.ui.rec[key].phase !== 'recording') delete R.ui.rec[key]; };

  bridge.on('whisper', function (p) {
    if (!p || !p.job) return;
    Object.keys(R.ui.rec).forEach(function (k) {
      var st = R.ui.rec[k];
      if (!st || st.job !== p.job || st.phase !== 'processing') return;
      st.label = A.whisperPhaseLabel(p);
      R.patch('[data-rz-rec="' + cssEsc(k) + '"] .rz-rec-label', esc(st.label));
    });
  });

  /* ══ Fragments d'affichage communs ═════════════════════════════════════ */

  function levelHtml(b, label) {
    var base = String(b || '—').replace('+', '');
    return '<span class="rz-level lv-' + esc(base.toLowerCase()) + '" title="' + esc((LEVEL_NAMES[base] ? 'Niveau ' + base + ' — ' + LEVEL_NAMES[base] : 'Niveau non mesuré')) + '">'
      + (label ? '<span class="rz-level-k">' + esc(label) + '</span>' : '') + esc(b || '—') + '</span>';
  }
  R.h.level = levelHtml;
  R.h.skill = function (id, withLabel) {
    var k = R.skillById(id);
    var icon = { read: 'read', listen: 'ear', write: 'pen', speak: 'speak', lang: 'lang', srs: 'cards', pron: 'mic' }[id] || 'spark';
    return '<span class="rz-skill sk-' + esc(id) + '">' + R.icon(icon) + (withLabel !== false ? '<span>' + esc(k ? k.label : ({ srs: 'Révisions', pron: 'Prononciation' }[id] || id)) + '</span>' : '') + '</span>';
  };
  R.h.progress = function (ratio, label, cls) {
    var r = clamp(num(ratio, 0), 0, 1);
    return '<div class="rz-progress' + (cls ? ' ' + esc(cls) : '') + '" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(r * 100) + '"'
      + (label ? ' aria-label="' + esc(label) + '"' : '') + '><i style="width:' + (r * 100).toFixed(1) + '%"></i></div>';
  };
  R.h.empty = function (title, text, extra) {
    return '<div class="rz-empty"><div class="rz-empty-title">' + esc(title) + '</div>' + (text ? '<div class="rz-empty-text">' + esc(text) + '</div>' : '') + (extra || '') + '</div>';
  };
  R.h.jobLine = function (job) {
    var j = typeof job === 'string' ? JOBS[job] : job;
    if (!j) return '';
    return '<div class="rz-job" data-rz-job="' + esc(j.job) + '">' + jobLineInner(j) + '</div>';
  };
  /* Pastilles de choix : data-act="rz-pick" data-name data-value ; R.ui.pick[name] retient le choix. */
  R.ui.pick = {};
  R.h.chips = function (name, values, current, labels, act) {
    return '<div class="rz-chips" role="radiogroup">' + values.map(function (v, i) {
      var on = String(v) === String(current);
      return '<button type="button" role="radio" aria-checked="' + (on ? 'true' : 'false') + '" class="rz-chip' + (on ? ' on' : '') + '" data-act="' + esc(act || 'rz-pick') + '" data-name="' + esc(name) + '" data-value="' + esc(v) + '">'
        + esc(labels ? labels[i] : v) + '</button>';
    }).join('') + '</div>';
  };

  R.h.diff = function (a, b) {
    return diffWords(a, b).map(function (d) {
      if (d.op === 'eq') return esc(d.text);
      if (d.op === 'del') return '<del>' + esc(d.text) + '</del>';
      return '<ins>' + esc(d.text) + '</ins>';
    }).join(' ');
  };

  /* Retour d'une correction (spec §5.6) : réussites, priorité, erreurs prioritaires, version corrigée,
     phrase à refaire, tournures utiles. Toujours suivi d'une action (redire, réécrire, mettre en carte). */
  R.h.feedback = function (g, o) {
    if (!g) return '';
    o = o || {};
    var h = ['<div class="rz-fb">'];
    var sc = g.scores || {};
    var crit = [['task', 'Tâche'], ['coherence', 'Cohérence'], ['range', 'Étendue'], ['accuracy', 'Exactitude']];
    if (o.mode === 'speak') crit.push(['fluency', 'Aisance']);
    h.push('<div class="rz-fb-head">' + (g.levelEstimate ? levelHtml(g.levelEstimate, 'Niveau de cette réponse') : '')
      + '<div class="rz-fb-scores">' + crit.map(function (c) {
        var v = clamp(Math.round(num(sc[c[0]], 0)), 0, 5);
        return '<span class="rz-fb-score" title="' + esc(c[1] + ' : ' + v + ' / 5') + '"><span class="rz-fb-k">' + esc(c[1]) + '</span><span class="rz-dots">'
          + [1, 2, 3, 4, 5].map(function (i) { return '<i class="' + (i <= v ? 'on' : '') + '"></i>'; }).join('') + '</span></span>';
      }).join('') + '</div></div>');
    if (g.feedbackFr) h.push('<p class="rz-fb-text">' + esc(g.feedbackFr) + '</p>');
    var strengths = arr(g.strengthsFr);
    if (strengths.length || g.priorityFr) {
      h.push('<div class="rz-fb-two">');
      if (strengths.length) h.push('<div class="rz-fb-good"><div class="rz-fb-sub">' + R.icon('check') + ' Réussi</div><ul>' + strengths.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></div>');
      if (g.priorityFr) h.push('<div class="rz-fb-prio"><div class="rz-fb-sub">' + R.icon('target') + ' Priorité</div><p>' + esc(g.priorityFr) + '</p></div>');
      h.push('</div>');
    }
    var edits = arr(g.edits);
    var errors = edits.filter(function (e) { return e.type !== 'improvement'; }).sort(function (a, b) { return num(a.priority, 2) - num(b.priority, 2); });
    var better = edits.filter(function (e) { return e.type === 'improvement'; });
    if (errors.length) {
      h.push('<div class="rz-fb-sub">Erreurs à retenir</div><ol class="rz-fb-edits">');
      errors.forEach(function (e) {
        h.push('<li class="rz-fb-edit"><div class="rz-fb-pair"><span class="rz-fb-orig">' + esc(e.original) + '</span>' + R.icon('arrow')
          + '<span class="rz-fb-corr">' + esc(e.correction) + '</span><span class="rz-cat">' + esc(R.categoryLabel(e.category)) + '</span></div>'
          + (e.explanationFr ? '<div class="rz-fb-why">' + esc(e.explanationFr) + '</div>' : '') + '</li>');
      });
      h.push('</ol>');
    } else if (!better.length) {
      h.push('<div class="rz-fb-none">' + R.icon('check') + ' Aucune erreur relevée.</div>');
    }
    if (better.length) {
      h.push('<details class="rz-fb-more"><summary>Pour sonner plus naturel · ' + better.length + '</summary><ul class="rz-fb-edits is-soft">');
      better.forEach(function (e) {
        h.push('<li class="rz-fb-edit"><div class="rz-fb-pair"><span class="rz-fb-orig">' + esc(e.original) + '</span>' + R.icon('arrow')
          + '<span class="rz-fb-corr">' + esc(e.correction) + '</span></div>' + (e.explanationFr ? '<div class="rz-fb-why">' + esc(e.explanationFr) + '</div>' : '') + '</li>');
      });
      h.push('</ul></details>');
    }
    if (g.corrected && o.response && norm(g.corrected) !== norm(o.response)) {
      h.push('<details class="rz-fb-more"' + (o.openCorrected ? ' open' : '') + '><summary>Votre texte corrigé</summary><div class="rz-diff">' + R.h.diff(o.response, g.corrected) + '</div></details>');
    }
    var phrases = arr(g.usefulPhrases);
    if (phrases.length) h.push('<div class="rz-fb-sub">Tournures à réemployer</div><div class="rz-fb-phrases">' + phrases.map(function (p) { return '<span class="rz-phrase">' + esc(p) + '</span>'; }).join('') + '</div>');
    h.push('</div>');
    return h.join('');
  };

  /* ══ Accueil ════════════════════════════════════════════════════════════ */

  function homeHtml(enter) {
    if (!R.profile.onboarded) return onboardHtml();
    var cards = HOME_CARDS.slice().sort(function (a, b) { return num(a.order, 50) - num(b.order, 50); });
    var area = function (name) {
      return cards.filter(function (c) { return (c.area || 'main') === name; }).map(function (c) {
        var html = '';
        try { html = c.html() || ''; } catch (e) { html = '<div class="rz-card rz-error">' + esc(e && e.message) + '</div>'; }
        return html;
      }).join('');
    };
    var hour = new Date().getHours();
    var hello = hour < 12 ? 'Good morning' : (hour < 18 ? 'Good afternoon' : 'Good evening');
    var h = [];
    h.push('<div class="rz-home-head"><div><div class="rz-kicker">' + R.icon('book') + ' Révizator · Anglais</div>'
      + '<h2 class="rz-hello">' + esc(hello) + '!</h2><div class="rz-sub">' + esc(new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })) + ' — ' + esc(weekLine()) + '</div></div></div>');
    var hero = area('hero');
    if (hero) h.push('<div class="rz-hero-row">' + hero + '</div>');
    h.push('<div class="rz-home-grid"><div class="rz-home-main">' + area('main') + '</div><div class="rz-home-side">' + area('side') + '</div></div>');
    return h.join('');
  }

  function weekLine() {
    var w = R.week();
    if (!w.done) return 'aucune séance encore cette semaine, objectif ' + w.goal;
    if (w.done >= w.goal) return 'objectif de la semaine atteint (' + w.done + ' séances, ' + fmtMin(w.minutes) + ')';
    return w.done + ' séance' + (w.done > 1 ? 's' : '') + ' sur ' + w.goal + ' cette semaine, ' + fmtMin(w.minutes);
  }

  /* Cartes du noyau : la semaine et le niveau. Les modules ajoutent les leurs. */
  R.homeCard({ id: 'week', area: 'side', order: 80, html: function () {
    var w = R.week();
    var ratio = w.goal ? Math.min(1, w.done / w.goal) : 0;
    var C = 2 * Math.PI * 26;
    var ring = '<svg class="rz-ring" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" class="rz-ring-bg"></circle>'
      + '<circle cx="32" cy="32" r="26" class="rz-ring-fg" stroke-dasharray="' + (C * ratio).toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 32 32)"></circle>'
      + '<text x="32" y="37" text-anchor="middle">' + w.done + '/' + w.goal + '</text></svg>';
    var max = Math.max(1, w.bySkill.read, w.bySkill.listen, w.bySkill.write, w.bySkill.speak, w.bySkill.lang + w.bySkill.srs);
    var rows = ['read', 'listen', 'write', 'speak', 'lang'].map(function (k) {
      var v = k === 'lang' ? w.bySkill.lang + w.bySkill.srs : w.bySkill[k];
      return '<div class="rz-wk-row">' + R.h.skill(k) + '<span class="rz-wk-bar"><i class="sk-bg-' + k + '" style="width:' + (v / max * 100).toFixed(0) + '%"></i></span><span class="rz-wk-v">' + esc(fmtMin(v)) + '</span></div>';
    }).join('');
    return '<section class="rz-card rz-week"><div class="rz-card-head"><span class="rz-card-title">Cette semaine</span><span class="rz-card-meta">' + esc(fmtMin(w.minutes)) + '</span></div>'
      + '<div class="rz-week-body">' + ring + '<div class="rz-wk-rows">' + rows + '</div></div>'
      + '<div class="rz-card-foot">Objectif : ' + w.goal + ' séances de 5 min ou plus. Mieux vaut 10 minutes que rien : la régularité fait la mémoire.</div></section>';
  } });

  R.homeCard({ id: 'level', area: 'side', order: 60, html: function () {
    var rows = SKILLS.map(function (k) {
      var l = R.level(k.id);
      var pos = clamp((l.theta + 2.5) / 6, 0, 1);
      return '<div class="rz-lv-row" title="' + esc(k.long + ' : ' + l.band + ' — confiance ' + l.conf + (l.n ? ' (' + l.n + ' observations)' : '')) + '">'
        + R.h.skill(k.id) + '<span class="rz-lv-track"><i style="left:' + (pos * 100).toFixed(1) + '%" class="' + (l.conf === 'faible' ? 'is-unsure' : '') + '"></i></span>' + levelHtml(l.band) + '</div>';
    }).join('');
    var t = R.data.toeic || {};
    var est = t.L && t.R ? Math.round((t.L.mean + t.R.mean) / 5) * 5 : 0;
    return '<section class="rz-card rz-levelcard"><div class="rz-card-head"><span class="rz-card-title">Votre niveau</span>' + levelHtml(R.globalBand()) + '</div>'
      + '<div class="rz-lv-scale"><span></span><span class="rz-lv-ticks"><span>A1</span><span>A2</span><span>B1</span><span>B2</span><span>C1</span><span>C2</span></span><span></span></div>' + rows
      + (est ? '<div class="rz-lv-toeic">Score estimé façon TOEIC : <b>≈ ' + est + '</b> / 990<div class="rz-lv-ets">format type TOEIC® · score estimé, non officiel — TOEIC est une marque déposée d’ETS, qui n’est pas associé à Révizator</div></div>' : '')
      + '<div class="rz-card-foot">Estimé au fil des exercices, recalé par les bilans. Comptez environ 200 heures de travail guidé pour passer d’un niveau au suivant.</div></section>';
  } });

  /* ── Premier lancement ─────────────────────────────────────────────── */
  function onboardHtml() {
    var o = R.ui.onboard;
    var p = R.profile;
    if (o.level == null) o.level = '';
    var st = TTS.status;
    var h = [];
    h.push('<section class="rz-card rz-onboard">');
    h.push('<div class="rz-kicker">' + R.icon('book') + ' Bienvenue dans Révizator</div>');
    h.push('<h2 class="rz-onboard-title">Réapprendre l’anglais, un peu chaque jour.</h2>');
    h.push('<p class="rz-onboard-lead">Chaque jour, un cours bâti sur l’actualité, à la durée que vous choisissez — lecture, écoute, écrit et oral —, des révisions espacées qui ne laissent rien filer, des exercices à la demande, un tuteur avec qui parler anglais, et des bilans façon TOEIC pour mesurer vos progrès. Quatre réglages pour commencer :</p>');
    h.push('<div class="rz-onboard-grid">');
    h.push('<div class="rz-ob-step"><div class="rz-ob-n">1</div><div class="rz-ob-body"><div class="rz-ob-title">Votre objectif</div>'
      + '<textarea class="input rz-ob-goal" rows="2" data-role="rz-profile" data-field="goal" data-focus-key="rz-ob-goal" data-dict-lang="fr" placeholder="Tenir une réunion technique en anglais, voyager au Royaume-Uni, viser 800 au TOEIC…">' + esc(p.goal) + '</textarea>'
      + '<input class="input" type="text" data-role="rz-profile" data-field="interests" data-focus-key="rz-ob-interests" placeholder="Vos centres d’intérêt : tech, IA, rugby, cuisine, histoire…" value="' + esc(p.interests) + '"></div></div>');
    h.push('<div class="rz-ob-step"><div class="rz-ob-n">2</div><div class="rz-ob-body"><div class="rz-ob-title">Votre rythme</div>'
      + '<div class="rz-ob-row"><span class="rz-ob-k">Séances par semaine</span>' + R.h.chips('weeklyGoal', [2, 3, 4, 5, 6], p.weeklyGoal, null, 'rz-profile-pick') + '</div>'
      + '<div class="rz-ob-row"><span class="rz-ob-k">Durée habituelle</span>' + R.h.chips('defaultMinutes', [10, 20, 30, 45], p.defaultMinutes, ['10 min', '20 min', '30 min', '45 min'], 'rz-profile-pick') + '</div></div></div>');
    h.push('<div class="rz-ob-step"><div class="rz-ob-n">3</div><div class="rz-ob-body"><div class="rz-ob-title">Votre niveau, à peu près</div>'
      + R.h.chips('startLevel', ['A2', 'B1', 'B2', 'C1', '?'], o.level || (p.startLevel === 'B1' && !o.level ? '' : p.startLevel), ['A2 · bases', 'B1 · intermédiaire', 'B2 · à l’aise', 'C1 · avancé', 'Je ne sais pas'], 'rz-ob-level')
      + '<div class="rz-ob-note">' + esc(o.level === '?' ? 'Commencez par le bilan express (27 min) : il mesure votre niveau d’écoute et de lecture, les cours ajustent ensuite.' : 'Ce n’est qu’un point de départ : chaque exercice l’ajuste, et le bilan express le mesure quand vous voulez.') + '</div></div></div>');
    h.push('<div class="rz-ob-step"><div class="rz-ob-n">4</div><div class="rz-ob-body"><div class="rz-ob-title">Les voix</div>' + voiceStatusHtml(true) + '</div></div>');
    h.push('</div>');
    h.push('<div class="rz-onboard-foot"><button type="button" class="btn btn-primary rz-big" data-act="rz-ob-done">C’est parti ' + R.icon('arrow') + '</button>'
      + '<span class="rz-ob-hint">Tout se règle ensuite dans Réglages › Révizator.</span></div>');
    h.push('</section>');
    return h.join('');
  }

  /* Page servie par le serveur Révizator (téléphone) : les voix « système » sont celles de l'appareil, pas de
     Windows. Les voix naturelles tournent sur le serveur dès qu'il y en a un (aussi depuis Organizator). */
  function onServer() { return bridge.mode === 'server'; }
  function kokoroWhere() { return onServer() || (bridge.remote && bridge.remote()) ? 'sur le serveur Révizator' : 'sur ce poste'; }

  function voiceStatusHtml(onboard) {
    var st = TTS.status;
    var dl = R.ui.ttsDl;
    var h = [];
    if (st && st.ready) {
      h.push('<div class="rz-voice-ok">' + R.icon('check') + ' Voix naturelles installées — américaines et britanniques, ' + kokoroWhere() + '.</div>');
    } else if (R.tts.downloading()) {
      var m = st && st.model || {};
      var rec = (dl && dl.received) || m.received || 0, tot = (dl && dl.total) || m.total || 0;
      h.push('<div class="rz-voice-dl" data-rz-ttsdl>' + ttsDlInner(rec, tot) + '</div>');
    } else {
      h.push('<p class="rz-voice-p">' + (onServer() ? 'Les voix de l’appareil marchent tout de suite, mais sonnent souvent robotiques.' : 'Les voix de Windows (américaines) marchent tout de suite, mais sonnent robotiques.')
        + ' Des <b>voix naturelles</b> américaines et britanniques tournent ' + kokoroWhere() + ', comme la dictée : environ 375 Mo à télécharger une fois.</p>');
      h.push('<div class="rz-voice-actions"><button type="button" class="btn btn-secondary" data-act="rz-tts-download"' + (bridge.isShim && !window.__fakeTts ? ' disabled title="Indisponible dans le navigateur"' : '') + '>Télécharger les voix (375 Mo)</button>'
        + '<button type="button" class="btn btn-ghost" data-act="rz-tts-try">' + R.icon('speak') + ' Essayer</button></div>');
      if (dl && dl.error) h.push('<div class="rz-err-line">' + esc(dl.error) + '</div>');
    }
    if (onboard && st && st.ready) h.push('<button type="button" class="btn btn-ghost" data-act="rz-tts-try">' + R.icon('speak') + ' Essayer</button>');
    return h.join('');
  }
  R.h.voiceStatus = voiceStatusHtml;

  function ttsDlInner(rec, tot) {
    var pct = tot ? Math.round(rec / tot * 100) : 0;
    return '<div class="rz-dl-line"><span class="rz-spin"></span>Téléchargement des voix · ' + pct + ' %' + (tot ? ' · ' + esc(A.fmtSize(rec)) + ' / ' + esc(A.fmtSize(tot)) : '') + '</div>' + R.h.progress(tot ? rec / tot : 0, 'Téléchargement des voix');
  }

  bridge.on('tts', function (ev) {
    if (!ev) return;
    R.emit('tts', ev);
    if (ev.phase === 'download' && !ev.job) {
      R.ui.ttsDl = Object.assign(R.ui.ttsDl || {}, { received: num(ev.received, 0), total: num(ev.total, 0) });
      R.patch('[data-rz-ttsdl]', ttsDlInner(R.ui.ttsDl.received, R.ui.ttsDl.total));
    } else if ((ev.phase === 'downloaded' || ev.phase === 'download-failed') && !ev.job) {
      R.tts.refresh();
    }
  });

  /* ══ Réglages › Révizator ═══════════════════════════════════════════════ */

  var MODEL_FIELDS = [
    { key: 'lessonModel', effort: 'lessonEffort', label: 'Cours du jour', help: 'Cherche l’actualité, lit les articles et écrit le cours : sonnet avec un effort moyen. Deux à quatre minutes, et un peu de votre quota Claude Code.' },
    { key: 'genModel', effort: 'genEffort', label: 'Exercices et bilans', help: 'Écrit les séries d’exercices et les bilans, sans recherche web : une à deux minutes.' },
    { key: 'gradeModel', effort: '', label: 'Correction', help: 'Corrige l’écrit et l’oral : sonnet est plus fin, haiku plus rapide.' },
    { key: 'tutorModel', effort: '', label: 'Tuteur', help: 'Répond pendant la conversation : un modèle rapide garde l’échange fluide.' },
    { key: 'cardModel', effort: '', label: 'Correcteur des cartes', help: 'Relit une réponse refusée pendant les révisions et réécrit les cartes floues : un modèle rapide suffit.' }
  ];

  /* Serveur Révizator, dans Organizator seulement (la page du serveur n'a pas de serveur à régler).
     Les champs remplissent un brouillon ; « Enregistrer » le passe aux réglages et au pont. */
  function serverSettable() { return !!bridge.configureRemote && (bridge.mode === 'webview' || !!window.__shimRemote); }
  function serverSettings() { var s = (A && A.state && A.state.settings) || {}; return { url: String(s.revizatorServerUrl || ''), token: String(s.revizatorServerToken || '') }; }
  function serverDraft() {
    var u = R.ui.server = R.ui.server || { draft: null, test: null, testing: false };
    if (!u.draft) u.draft = serverSettings();
    return u;
  }
  var SERVER_STATES = { online: 'Connecté', connecting: 'Connexion…', offline: 'Injoignable', unreachable: 'Injoignable', refused: 'Jeton refusé', invalid: 'Adresse invalide' };

  function serverCardHtml() {
    var u = serverDraft(), cur = serverSettings(), live = bridge.remote ? bridge.remote() : null;
    var h = ['<div class="set-card"><div class="set-card-head"><span class="set-card-title">Serveur Révizator</span></div>'];
    h.push('<div class="rz-set-help">Vos cartes, cours et progrès sont alors lus et écrits sur le serveur ; vos tâches restent sur ce PC. Adresse vide : Révizator garde tout sur ce PC.</div>');
    h.push(A.setFieldHtml('Adresse', '<input class="input set-cwd" type="url" data-role="rz-server" data-field="url" data-focus-key="rz-server-url" spellcheck="false" autocomplete="off" placeholder="https://revizator.daft-lab.fr" value="' + esc(u.draft.url) + '">'));
    h.push(A.setFieldHtml('Jeton', '<input class="input set-cwd" type="password" data-role="rz-server" data-field="token" data-focus-key="rz-server-token" spellcheck="false" autocomplete="off" placeholder="revizator-server token new pc" value="' + esc(u.draft.token) + '">'));
    var dirty = u.draft.url.trim() !== cur.url || u.draft.token.trim() !== cur.token;
    h.push(A.setFieldHtml('', '<button type="button" class="btn btn-secondary" data-act="rz-server-test"' + (u.testing ? ' disabled' : '') + '>' + (u.testing ? 'Test…' : 'Tester la connexion') + '</button>'
      + '<button type="button" class="btn ' + (dirty ? 'btn-primary' : 'btn-ghost') + '" data-act="rz-server-save">Enregistrer</button>'));
    var t = u.test;
    if (t) {
      h.push('<div class="rz-set-help rz-server-test is-' + esc(t.state) + '"><strong>' + esc(SERVER_STATES[t.state] || t.state) + '</strong>'
        + (t.version ? ' · version ' + esc(t.version) : '') + (t.error ? ' — ' + esc(t.error) : '') + '</div>');
    }
    var foot = live
      ? 'En service : ' + esc(live.url) + ' — <strong>' + esc(SERVER_STATES[live.state] || live.state) + '</strong>.'
      : 'Aucun serveur : Révizator lit et écrit learning.json sur ce PC.';
    h.push('<div class="set-card-foot">' + foot + ' Le jeton vient de <code>revizator-server token new pc</code> sur le serveur.</div></div>');
    return h.join('');
  }

  function settingsHtml() {
    var p = R.prefs, pr = R.profile;
    var h = [];
    var srv = serverSettable() ? serverCardHtml() : '';
    if (!loaded) return srv + '<div class="set-note">' + esc(loadError || 'Chargement…') + '</div>';
    h.push(srv);
    h.push('<div class="set-card"><div class="set-card-head"><span class="set-card-title">Voix</span></div>');
    h.push('<div class="rz-set-voice">' + voiceStatusHtml(false) + '</div>');
    var eng = engine();
    h.push(A.setFieldHtml('Moteur', '<div class="seg2">' + [['auto', 'Automatique'], ['kokoro', 'Voix naturelles'], ['system', onServer() ? 'Voix de l’appareil' : 'Voix Windows']].map(function (o) {
      return '<button type="button" class="' + (p.engine === o[0] ? 'on' : '') + '" data-act="rz-set-engine" data-value="' + o[0] + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>'));
    var st = TTS.status;
    if (st && st.ready) {
      var us = arr(st.voices).filter(function (v) { return v.accent === 'en-US'; });
      var gb = arr(st.voices).filter(function (v) { return v.accent === 'en-GB'; });
      var sel = function (field, list) {
        return '<select class="input set-select" data-role="rz-set-pref" data-field="' + field + '" data-focus-key="rz-set-' + field + '">' + list.map(function (v) {
          return '<option value="' + esc(v.id) + '"' + (p[field] === v.id ? ' selected' : '') + '>' + esc((v.label || v.id) + (v.gender === 'M' ? ' · homme' : ' · femme') + (v.grade ? ' · ' + v.grade : '')) + '</option>';
        }).join('') + '</select>';
      };
      h.push(A.setFieldHtml('Voix américaine', sel('voiceUs', us) + '<button type="button" class="btn btn-secondary" data-act="rz-tts-try" data-accent="en-US">Essayer</button>'));
      h.push(A.setFieldHtml('Voix britannique', sel('voiceGb', gb) + '<button type="button" class="btn btn-secondary" data-act="rz-tts-try" data-accent="en-GB">Essayer</button>'));
    }
    h.push(A.setFieldHtml('Débit', '<div class="seg2">' + [0.85, 0.9, 1, 1.1].map(function (v) {
      return '<button type="button" class="' + (Math.abs(p.speed - v) < 0.01 ? 'on' : '') + '" data-act="rz-set-speed" data-value="' + v + '">' + String(v).replace('.', ',') + '×</button>';
    }).join('') + '</div>'));
    var foot = eng === 'kokoro' ? 'Voix naturelles en service.' : (eng === 'system' ? (onServer() ? 'Voix de l’appareil en service (' + TTS.sysVoices.length + ' voix anglaises).' : 'Voix Windows en service (' + TTS.sysVoices.length + ' voix anglaises sur ce poste). Pour d’autres accents : Paramètres Windows › Heure et langue › Voix.') : 'Aucune voix anglaise disponible : les textes restent affichés.');
    if (st && st.ready) foot += ' Le modèle pèse ' + esc(A.fmtSize(st.model && st.model.size || 0)) + ' ; environ 1 Go de mémoire par accent pendant l’usage, libéré après 5 minutes.';
    h.push('<div class="set-card-foot">' + esc(foot) + (st && (st.ready || (st.model && st.model.downloaded)) ? ' <button type="button" class="btn btn-ghost" data-act="rz-tts-remove">Supprimer les voix</button>' : '') + '</div>');
    h.push('</div>');

    h.push('<div class="set-card"><div class="set-card-head"><span class="set-card-title">Agents (Claude Code)</span></div>');
    MODEL_FIELDS.forEach(function (f) {
      var v = String(p[f.key] || '');
      var custom = R.ui.setCustom[f.key] || (v && !A.catalogHas(A.catalogFor('claude'), v));
      var ctl = A.modelSelectHtml('claude', v, R.ui.setCustom[f.key], 'rz-set-model', 'rz-set-model-' + f.key, false).replace('data-role="rz-set-model"', 'data-role="rz-set-model" data-field="' + f.key + '"');
      if (f.effort) ctl += A.effortSelectHtml('claude', String(p[f.effort] || ''), 'rz-set-effort', 'rz-set-effort-' + f.effort, false).replace('data-role="rz-set-effort"', 'data-role="rz-set-effort" data-field="' + f.effort + '"');
      h.push(A.setFieldHtml(f.label, ctl));
      if (custom) h.push(A.setFieldHtml('', '<input class="input set-cwd" type="text" data-role="rz-set-model-text" data-field="' + f.key + '" data-focus-key="rz-set-model-text-' + f.key + '" spellcheck="false" placeholder="Identifiant de modèle, ex. sonnet" value="' + esc(v) + '">'));
      h.push('<div class="rz-set-help">' + esc(f.help) + '</div>');
    });
    h.push('<div class="set-card-foot">Chaque préparation et chaque correction comptent dans votre quota Claude Code. Le tuteur n’a pas d’autre outil que la conversation.</div></div>');

    h.push('<div class="set-card"><div class="set-card-head"><span class="set-card-title">Apprentissage</span></div>');
    h.push(A.setFieldHtml('Séances par semaine', R.h.chips('weeklyGoal', [2, 3, 4, 5, 6, 7], pr.weeklyGoal, null, 'rz-profile-pick')));
    h.push(A.setFieldHtml('Durée habituelle', R.h.chips('defaultMinutes', [10, 20, 30, 45], pr.defaultMinutes, ['10 min', '20 min', '30 min', '45 min'], 'rz-profile-pick')));
    h.push(A.setFieldHtml('Explications', R.h.chips('explain', ['auto', 'fr', 'en'], pr.explain, ['Selon le niveau', 'En français', 'En anglais'], 'rz-profile-pick')));
    h.push(A.setFieldHtml('Objectif', '<textarea class="input set-topics" rows="2" data-role="rz-profile" data-field="goal" data-focus-key="rz-set-goal" data-dict-lang="fr">' + esc(pr.goal) + '</textarea>'));
    h.push(A.setFieldHtml('Centres d’intérêt', '<input class="input set-cwd" type="text" data-role="rz-profile" data-field="interests" data-focus-key="rz-set-interests" value="' + esc(pr.interests) + '">'));
    h.push(A.setFieldHtml('Rétention visée', R.h.chips('retention', ['0.85', '0.9', '0.95'], String(p.retention), ['85 % · moins de révisions', '90 % · conseillé', '95 % · plus de révisions'], 'rz-set-pick')));
    h.push(A.setFieldHtml('Whisper pour l’oral', R.h.chips('whisperModel', ['base', 'small'], p.whisperModel, ['Base · rapide', 'Small · conseillé'], 'rz-set-pick')));
    h.push('<div class="set-card-foot">L’oral est noté avec Whisper Small ou Base : le grand modèle devine trop bien ce que vous vouliez dire, et laisserait passer les fautes de prononciation.</div></div>');

    SECTIONS.slice().sort(function (a, b) { return num(a.order, 50) - num(b.order, 50); }).forEach(function (s) {
      try { h.push(s.html()); } catch (e) { h.push('<div class="set-note">' + esc(e && e.message) + '</div>'); }
    });

    var d = R.data;
    h.push('<div class="set-card"><div class="set-card-head"><span class="set-card-title">Données</span></div>');
    h.push('<div class="rz-set-help">' + esc(d.cards.length + ' cartes, ' + d.lessons.length + ' cours, ' + d.sessions.length + ' séances, ' + d.toeic.history.length + ' bilans, depuis le ' + new Date(d.createdAt).toLocaleDateString('fr-FR') + '.')
      + (onServer() ? ' Tout est gardé sur le serveur Révizator, dans son learning.json et son dossier learning/.' : ' Tout est gardé sur ce poste, dans learning.json et le dossier learning\\ du dossier de données.') + '</div>');
    h.push('<div class="set-card-foot"><button type="button" class="btn btn-ghost rz-danger" data-act="rz-reset">' + esc(R.ui.resetArm ? 'Confirmer : tout effacer' : 'Repartir de zéro…') + '</button></div></div>');
    return h.join('');
  }

  /* ══ Actions communes ═══════════════════════════════════════════════════ */

  function bindActions() {
    R.act('rz-go', function (el) { R.go(el.getAttribute('data-view'), el.getAttribute('data-param') ? { id: el.getAttribute('data-param') } : null); });
    R.act('rz-player-toggle', function (el) { playerToggle(el.getAttribute('data-key')); });
    R.act('rz-player-replay', function (el) {
      var key = el.getAttribute('data-key');
      var p = R.players[key];
      if (p) { R.players[key] = p.replay(); syncPlayersDom(); }
      else playerToggle(key);
    });
    R.act('rz-player-speed', function (el) {
      var key = el.getAttribute('data-key');
      var p = R.players[key];
      var r = num(el.getAttribute('data-rate'), 1);
      if (p) p.setRate(r);
      else { SOURCES[key] = SOURCES[key] || {}; }
      var btns = document.querySelectorAll('[data-rz-player="' + cssEsc(key) + '"] [data-act="rz-player-speed"]');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i] === el);
    });
    R.act('rz-rec-start', function (el) { recStart(el.getAttribute('data-key')); });
    R.act('rz-rec-stop', function (el) { recStop(el.getAttribute('data-key')); });
    R.act('rz-rec-cancel', function (el) { recCancel(el.getAttribute('data-key')); });
    R.act('rz-pick', function (el) { R.ui.pick[el.getAttribute('data-name')] = el.getAttribute('data-value'); R.render(); });
    R.act('rz-profile-pick', function (el) {
      var f = el.getAttribute('data-name'), v = el.getAttribute('data-value');
      R.profile[f] = /^\d+$/.test(v) ? +v : v;
      R.save(); R.render();
    });
    R.act('rz-set-pick', function (el) {
      var f = el.getAttribute('data-name'), v = el.getAttribute('data-value');
      R.prefs[f] = /^[\d.]+$/.test(v) ? +v : v;
      R.save(); R.render();
    });
    R.act('rz-ob-level', function (el) { R.ui.onboard.level = el.getAttribute('data-value'); R.render(); });
    R.act('rz-ob-done', function () {
      var lv = R.ui.onboard.level;
      var p = R.profile;
      if (lv && lv !== '?') {
        p.startLevel = lv;
        SKILLS.forEach(function (k) { var s = skill(k.id); if (!s.n) { s.theta = thetaOf(lv); s.hist = [[today(), Math.round(s.theta * 100) / 100]]; } });
      }
      p.onboarded = true;
      R.save(true);
      if (lv === '?' && VIEWS.tests) R.go('tests'); else R.go('home');
    });
    R.act('rz-tts-download', function () { R.tts.download()['catch'](function () { /* dit par le toast */ }); });
    R.act('rz-tts-remove', function () {
      R.tts.remove().then(function () { R.toast('Voix naturelles supprimées : Révizator reprend les voix ' + (onServer() ? 'de l’appareil' : 'Windows') + '.'); R.render(); },
        function (e) { R.toast('Suppression impossible : ' + e.message); });
    });
    R.act('rz-tts-try', function (el) {
      var acc = el.getAttribute('data-accent') || 'en-GB';
      var text = acc === 'en-US' ? 'Hi! I’m your English tutor. Shall we start today’s lesson?' : 'Hello there! Fancy a quick English lesson before your next meeting?';
      R.tts.say(text, { accent: acc, gender: 'female', key: 'rz-try' });
    });
    R.act('rz-set-engine', function (el) { R.prefs.engine = el.getAttribute('data-value'); R.save(); R.render(); });
    R.act('rz-set-speed', function (el) { R.prefs.speed = num(el.getAttribute('data-value'), 1); R.save(); R.render(); });
    R.act('rz-reset', function () {
      if (!R.ui.resetArm) { R.ui.resetArm = true; R.render(); setTimeout(function () { R.ui.resetArm = false; R.render(); }, 5000); return; }
      R.ui.resetArm = false;
      DOC.subjects.en = normalizeSubject(null);
      R.save(true);
      R.toast('Révizator repart de zéro.');
      R.go('home');
    });
    R.act('rz-settings', function () { A.openSettingsTab('revizator'); });
    R.act('rz-reload', function () { if (!loaded) { loadError = ''; R.render(); load().then(reattachJobs); } });
    R.input('rz-server', function (el) { serverDraft().draft[el.getAttribute('data-field')] = el.value; });
    R.act('rz-server-test', function () {
      var u = serverDraft();
      u.testing = true; u.test = null;
      R.render();
      bridge.testRemote({ url: u.draft.url, token: u.draft.token }).then(function (r) {
        u.testing = false; u.test = r;
        R.render();
      });
    });
    R.act('rz-server-save', function () {
      var u = serverDraft();
      var url = u.draft.url.trim(), token = u.draft.token.trim();
      if (url && !/^(https?:\/\/)?[^\/?#\s@]+\/?$/i.test(url)) { u.test = { state: 'invalid', error: 'Une adresse seule, sans chemin : https://revizator.exemple.fr' }; R.render(); return; }
      url = url.replace(/\/+$/, '');
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      u.draft = { url: url, token: token };
      u.test = null;
      window.organizatorApp.setSettings({ revizatorServerUrl: url, revizatorServerToken: token });
      bridge.configureRemote({ url: url, token: token });
      R.toast(url ? 'Révizator lit maintenant ses données sur ' + url + '.' : 'Révizator garde de nouveau ses données sur ce PC.');
      R.render();
    });

    R.input('rz-profile', function (el) { R.profile[el.getAttribute('data-field')] = el.value.slice(0, 600); R.save(); });
    R.change('rz-set-pref', function (el) { R.prefs[el.getAttribute('data-field')] = el.value; R.save(); R.render(); });
    R.change('rz-set-model', function (el) {
      var f = el.getAttribute('data-field');
      if (el.value === A.customModel) { R.ui.setCustom[f] = true; }
      else { R.ui.setCustom[f] = false; R.prefs[f] = el.value; R.save(); }
      R.render();
    });
    R.input('rz-set-model-text', function (el) { R.prefs[el.getAttribute('data-field')] = el.value.trim().slice(0, 80); R.save(); });
    R.change('rz-set-effort', function (el) { R.prefs[el.getAttribute('data-field')] = el.value; R.save(); });

    /* Espace démarre et termine l'enregistrement du seul micro affiché (hors champ de saisie). */
    R.key(function (e, el) {
      if (A.currentPage() !== 'revizator') return false;
      var typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      var v = VIEWS[R.viewId()];
      if (v && v.keydown) { try { if (v.keydown(e, el, el && el.getAttribute && el.getAttribute('data-role'))) return true; } catch (err) { /* vue fautive */ } }
      if (!typing && (e.key === ' ' || e.code === 'Space') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        var recs = document.querySelectorAll('#page-host [data-rz-rec]');
        if (recs.length === 1) { e.preventDefault(); R.recToggle(recs[0].getAttribute('data-rz-rec')); return true; }
      }
      return false;
    });
  }

  /* ══ Simulations hors WebView2 ═════════════════════════════════════════ */

  var FIXTURES = Object.create(null);
  R.fixture = function (kind, f) { FIXTURES[kind] = f; };
  R.shim = function (type, fn) { if (bridge.isShim && bridge.shimRegister) bridge.shimRegister(type, fn); };

  function bindShims() {
    if (!bridge.isShim) return;
    var LS = 'organizator.learning', LSD = 'organizator.learning.docs';
    var read = function (k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
    var write = function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota */ } };
    window.__learnCalls = window.__learnCalls || [];
    var running = {};
    R.shim('learnLoad', function () { return { data: read(LS, null), dir: 'C:\\shim\\learning', url: 'https://learn.organizator/' }; });
    R.shim('learnSave', function (p) { write(LS, p.data); return { bytes: JSON.stringify(p.data || {}).length }; });
    R.shim('learnDoc', function (p) { var docs = read(LSD, {}); return { doc: docs[p.kind + ':' + p.id] || null }; });
    R.shim('learnDocSave', function (p) { var docs = read(LSD, {}); docs[p.kind + ':' + p.id] = p.doc; write(LSD, docs); return {}; });
    R.shim('learnDocDelete', function (p) { var docs = read(LSD, {}); var had = !!docs[p.kind + ':' + p.id]; delete docs[p.kind + ':' + p.id]; write(LSD, docs); return { removed: had }; });
    R.shim('learnJobs', function () { return { running: [], recent: [] }; });
    R.shim('learnWait', function () { throw new Error('Travail inconnu.'); });
    R.shim('learnCancel', function (p) { var r = running[p.job]; if (r) { r.cancel(); return { cancelled: true }; } return { cancelled: false }; });
    R.shim('learnNews', function () {
      return { fetchedAt: Date.now(), items: [
        { source: 'France 24', title: 'Paris unveils plan to turn ring road into an urban boulevard', url: 'https://www.france24.com/en/', readable: true, published: new Date().toISOString(), heavy: false },
        { source: 'BBC News', title: 'Scientists map the oldest known forest on Earth', url: 'https://www.bbc.com/news', readable: false, published: new Date().toISOString(), heavy: false },
        { source: 'TechCrunch', title: 'Open-source AI coding agents gain ground in European companies', url: 'https://techcrunch.com/', readable: true, published: new Date().toISOString(), heavy: false }
      ], audio: [] };
    });
    R.shim('learnGenerate', function (p, emit) {
      window.__learnCalls.push({ kind: p.kind, params: p.params, model: p.model, effort: p.effort, context: p.context, at: Date.now() });
      var fake = window.__fakeLearn && window.__fakeLearn[p.kind];
      var delay = num(window.__fakeLearnDelay, 1200);
      return new Promise(function (resolve, reject) {
        var timers = [];
        var steps = p.kind === 'lesson' ? [['menu', '36 titres'], ['tool', 'Lecture : france24.com'], ['write', 'Rédaction…']] : [['write', 'Rédaction…']];
        steps.forEach(function (s, i) { timers.push(setTimeout(function () { emit('learn', { job: p.job, kind: p.kind, phase: s[0], text: s[1], at: Date.now() }); }, (i + 1) * delay / (steps.length + 1))); });
        running[p.job] = { cancel: function () { timers.forEach(clearTimeout); delete running[p.job]; reject(new Error('Préparation interrompue.')); } };
        timers.push(setTimeout(function () {
          delete running[p.job];
          if (fake === 'error') { reject(new Error('Claude Code n’est pas connecté (simulation).')); return; }
          var f = fake || FIXTURES[p.kind];
          /* Une simulation peut être l'adresse d'un document réel (revizator/fixtures/…json), lu à la demande. */
          var got = typeof f === 'string' ? fetch(f).then(function (r) { return r.json(); }) : Promise.resolve(typeof f === 'function' ? f(p.params || {}, p) : (f ? JSON.parse(JSON.stringify(f)) : null));
          got.then(function (doc) {
          if (!doc) { reject(new Error('Pas de simulation pour « ' + p.kind + ' ».')); return; }
          var id = p.kind + '-' + today().replace(/-/g, '') + '-' + Math.random().toString(16).slice(2, 8);
          if (!QUIET_KINDS[p.kind]) {
            doc = Object.assign({}, doc, { id: id, kind: p.kind, createdAt: Date.now(), day: today(), model: p.model || 'sonnet', ms: delay, cost: 0, turns: 1 });
            var docs = read(LSD, {}); docs[p.kind + ':' + id] = doc; write(LSD, docs);
          }
          resolve({ job: p.job, kind: p.kind, id: !QUIET_KINDS[p.kind] ? id : '', doc: doc, ms: delay, turns: 1, cost: 0, model: p.model || 'sonnet' });
          }, reject);
        }, delay));
      });
    });
    /* Voix : dans le navigateur, seules les voix système (ou le minuteur) servent, sauf __fakeTts. */
    R.shim('ttsStatus', function () {
      return window.__fakeTts || { ready: false, dir: 'C:\\shim\\tts', url: 'https://tts.organizator/', threads: 6, runtime: { version: '1.13.8', downloaded: false },
        model: { id: 'kokoro-v1_0', label: 'Kokoro v1.0', size: 366000000, downloaded: false, downloading: false, received: 0, total: 0 }, voices: [], loaded: [], cache: { files: 0, bytes: 0, max: 524288000 } };
    });
    R.shim('ttsDownload', function (p, emit) {
      return new Promise(function (resolve) {
        var total = 366000000, n = 0;
        var t = setInterval(function () {
          n++;
          emit('tts', { phase: 'download', model: 'kokoro-v1_0', received: Math.min(total, n * total / 8), total: total });
          if (n >= 8) {
            clearInterval(t);
            window.__fakeTts = { ready: true, dir: 'C:\\shim\\tts', url: 'https://tts.organizator/', threads: 6, runtime: { version: '1.13.8', downloaded: true },
              model: { id: 'kokoro-v1_0', label: 'Kokoro v1.0', size: total, downloaded: true, downloading: false, received: total, total: total },
              voices: Object.keys(VOICE_LABELS).map(function (id) { return { id: id, label: VOICE_LABELS[id], accent: id.charAt(0) === 'b' ? 'en-GB' : 'en-US', gender: id.charAt(1) === 'm' ? 'M' : 'F', grade: '' }; }),
              loaded: [], cache: { files: 0, bytes: 0, max: 524288000 } };
            emit('tts', { phase: 'downloaded', model: 'kokoro-v1_0' });
            resolve(window.__fakeTts);
          }
        }, 150);
      });
    });
    R.shim('ttsRemove', function () { window.__fakeTts = null; return { removed: true }; });
    R.shim('ttsWarm', function () { return {}; });
    R.shim('ttsClearCache', function () { return { removed: 0, bytes: 0 }; });
    R.shim('cancelSpeak', function () { return { cancelled: true }; });
    /* speak / speakScript simulés : des URL de silence (data: WAV) au rythme de la parole. */
    var silentWav = function (seconds) {
      var rate = 8000, n = Math.max(1, Math.round(seconds * rate)), buf = new ArrayBuffer(44 + n), v = new DataView(buf);
      var s = function (o, t) { for (var i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
      s(0, 'RIFF'); v.setUint32(4, 36 + n, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, 'data'); v.setUint32(40, n, true);
      for (var i = 0; i < n; i++) v.setUint8(44 + i, 128);
      return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    };
    var sentencesOf = function (text) { return String(text || '').split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/).filter(function (x) { return x.trim(); }); };
    R.shim('speak', function (p, emit) {
      var out = sentencesOf(p.text).map(function (t, i) { var d = Math.max(0.6, count(t) / 2.6); return { index: i, text: t, url: silentWav(d), start: 0, duration: d }; });
      out.forEach(function (s, i) { setTimeout(function () { emit('tts', { job: p.job, phase: 'sentence', index: s.index, url: s.url, duration: s.duration }); }, 60 + i * 30); });
      return new Promise(function (res) { setTimeout(function () { res({ job: p.job, voice: p.voice, speed: p.speed, duration: 0, ms: 50, cached: 0, sentences: out }); }, 80 + out.length * 30); });
    });
    R.shim('speakScript', function (p, emit) {
      var lines = arr(p.lines).map(function (l) {
        return { id: l.id, voice: l.voice, duration: 0, sentences: sentencesOf(l.text).map(function (t, i) { var d = Math.max(0.6, count(t) / 2.6); return { index: i, text: t, url: silentWav(d), start: 0, duration: d }; }) };
      });
      var k = 0;
      lines.forEach(function (l) { l.sentences.forEach(function (s) { k++; setTimeout(function () { emit('tts', { job: p.job, phase: 'sentence', line: l.id, index: s.index, url: s.url, duration: s.duration }); }, 60 + k * 25); }); });
      return new Promise(function (res) { setTimeout(function () { res({ job: p.job, duration: 0, lines: lines }); }, 80 + k * 25); });
    });
    /* Transcription enrichie : construite à partir de __fakeTranscript (ou d'une phrase type). */
    R.shim('transcribe', function (p) {
      if (!p.detail) return undefined;
      if (window.__fakeTranscribeDetail) { var fd = window.__fakeTranscribeDetail; return new Promise(function (res) { setTimeout(function () { res(Object.assign({ job: p.job }, fd)); }, num(window.__fakeTranscribeDelay, 500)); }); }
      if (window.__fakeTranscript === 'error') throw new Error('Transcription impossible (simulation).');
      var text = typeof window.__fakeTranscript === 'string' ? window.__fakeTranscript : 'I think the city should keep the ring road, because a lot of people drive to work every day.';
      var w = words(text), t = 0.4;
      var list = w.map(function (x) { var d = 0.18 + x.length * 0.035; var o = { text: x, start: +t.toFixed(2), end: +(t + d).toFixed(2), p: 0.9, pMin: 0.8 }; t += d + 0.08; return o; });
      var ref = p.reference ? words(p.reference) : null;
      return new Promise(function (res) {
        setTimeout(function () {
          res({ job: p.job, text: text, language: 'en', duration: t + 0.4, ms: 300, model: p.model, languageProbability: 0.93, words: list,
            wpm: Math.round(w.length / Math.max(1, t) * 60), articulationWpm: Math.round(w.length / Math.max(1, t - 0.3) * 60), speechSeconds: +t.toFixed(2),
            pauses: [], alignment: ref ? { accuracy: 0.9, wer: 0.1, ops: ref.map(function (r, i) { return { op: 'ok', ref: r, hyp: w[i] || '', start: list[i] ? list[i].start : 0, end: list[i] ? list[i].end : 0, p: 0.9 }; }) } : null,
            id: p.keep ? 'rec-shim' : '', url: '' });
        }, num(window.__fakeTranscribeDelay, 500));
      });
    });
    R.fixture('grade', function (params) {
      var resp = String(params.response || '');
      var first = words(resp).slice(0, 4).join(' ');
      return {
        scores: { task: 4, coherence: 3, range: 3, accuracy: 3, fluency: params.mode === 'speak' ? 3 : 0 }, swScore: 0,
        corrected: resp.replace(/\bsince (\w+) years\b/, 'for $1 years'),
        edits: first ? [{ type: 'error', category: 'gram.tense.duration', original: first, correction: first, explanationFr: 'Exemple de correction (simulation).', priority: 1 }] : [],
        strengthsFr: ['Idée claire et bien reliée au sujet.'], priorityFr: 'Le present perfect pour une durée qui dure encore.',
        feedbackFr: 'Bonne réponse dans l’ensemble (simulation).', redo: 'I have lived here for three years.',
        usefulPhrases: ['to be on the fence', 'as far as I’m concerned'], cards: [], levelEstimate: 'B1+'
      };
    });
  }

  /* ══ Enregistrement de la page ══════════════════════════════════════════ */

  R.view('home', { label: 'Aujourd’hui', icon: 'sun', order: 0, render: homeHtml });

  A = O.registerPage({
    id: 'revizator', label: 'Révizator', title: 'Révizator — apprendre et réviser (anglais)', icon: ICONS.book,
    badge: function () { if (!loaded || !BADGE) return ''; try { return BADGE() || ''; } catch (e) { return ''; } },
    render: renderPage,
    renderBar: function (bar) { if (A) renderBar(bar); },
    onBoot: function () {
      try { var v = localStorage.getItem('organizator.revizator.view'); if (v && v !== 'session') R.ui.view = v; } catch (e) { /* stockage refusé */ }
      booted = true;
      load().then(function () { reattachJobs(); });
      R.tts.refresh();
    },
    onShow: function () {
      if (!TTS.status) R.tts.refresh();
      var v = VIEWS[R.viewId()];
      if (v && v.onShow) { try { v.onShow(R.ui.params); } catch (e) { /* vue fautive */ } }
    },
    onHide: function () { R.tts.stopAll(); R.emit('pagehide'); R.save(true); },
    onFocus: function () { if (loaded && A.currentPage() === 'revizator') R.renderSoon(); }
  });
  if (!A) return;

  PENDING.act.forEach(function (x) { A.addAction(x[0], x[1]); });
  PENDING.input.forEach(function (x) { A.addInput(x[0], x[1]); });
  PENDING.change.forEach(function (x) { A.addChange(x[0], x[1]); });
  PENDING.key.forEach(function (fn) { A.addKey(fn); });
  bindActions();
  bindShims();

  A.addSettingsTab({ id: 'revizator', label: 'Révizator', lead: 'L’espace d’apprentissage de l’anglais : les voix, les agents qui préparent les cours et corrigent, votre rythme.', html: settingsHtml, onOpen: function () { R.tts.refresh(); } });

  /* Clic sur une notification Windows de Révizator : l'hôte a ramené la fenêtre, on ouvre la vue. */
  bridge.on('notificationClicked', function (p) {
    var m = /(?:^|&)rz=([a-z]+)/.exec(String((p && p.args) || ''));
    if (m) R.go(m[1]);
  });
  bridge.on('learn', onLearnEvent);
  bridge.on('learnChanged', function () { if (loaded) { reloadWanted = true; reloadIfQuiet(); } });
  bridge.on('connection', onConnection);
  if (bridge.connection) conn.state = bridge.connection();
  /* Serveur réglé ou retiré dans Organizator : la sauvegarde en attente part à l'ancien destinataire,
     puis tout est relu chez le nouveau (données, documents, travaux, voix). */
  bridge.on('remoteChanging', function () { if (loaded && saveDirty) saveNow(); });
  bridge.on('remoteChanged', function () {
    if (!booted) return;
    loaded = false; loadError = ''; reloadWanted = false; conn.lost = false;
    DOCS = Object.create(null);
    R.render();
    load().then(reattachJobs);
    R.tts.refresh();
  });

  /* La fermeture de la fenêtre vide aussi la sauvegarde de Révizator. */
  var prevFlush = window.organizatorFlush;
  window.organizatorFlush = function () {
    var a = prevFlush ? prevFlush() : Promise.resolve(true);
    var b = saveDirty ? saveNow() : (saveInFlight || Promise.resolve());
    return Promise.all([a, b]).then(function () { return true; });
  };
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && saveDirty) saveNow(); });
})();
