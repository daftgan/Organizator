/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — bilans (module U2)
   Vue « tests » (Bilans) et carte d'accueil « tests » : bilan express écoute + lecture (format MSA
   réduit, spec §5.4, ≈ 27 min), bilan oral et écrit (spec §5.5, ≈ 25 min), estimateurs, calibration
   par des scores officiels, historique des bilans.

   Estimateur (research/toeic.md §3.3-3.6, repris de toeic_sim/toeic_estimator.js) :
     R.toeic.estimateSection(section 'L'|'R', [{ item: { section, part, cefr, features, nOptions,
       ability, calibrationOffset }, correct }], { prior, modelSd }) → { score, sd, sdMeasurement,
       ci90, cefr, cefrProb, nItems, nCorrect }
     R.toeic.combineTotal(L, R) → { score, sd, ci90, cefr, cefrProb }
     R.toeic.routeStage2(section, responsesÉtape1, seuil) → 'easy'|'hard'
     R.toeic.weakPoints(section, responses, score) → [{ ability, n, correct, expected, z, weak, strong }]
     R.toeic.kalman(état|null, { score, sd }, jours, dérive) → { mean, sd }
     R.toeic.calibrationOffset([{ official, app }]) → décalage rétréci (points)
     R.toeic.estimateProductive('speaking'|'writing', [{ type, score }]) → { composite, score, range, cefr, capped }
     R.toeic.thetaOfScore(section 'L'|'R'|'S'|'W'|'T', score) → theta (échelle du noyau, B1 = 0)
     R.toeic.cefrLabel(estimation) → { label: 'B1-B2 limite' | 'B2', main, p, pair }

   Données (R.data.toeic, spec §6) :
     L, R, S, W, T : { mean, sd, at } — tendance (Kalman) ; T = total L + R
     history : [{ id, at, kind: 'express'|'sw', … }] (voir notes U2) ; calib : { L: [{ official, app, at }], R }
     prep (préparation du bilan express), run (bilan express en cours), bank (modules d'étape 2 non servis),
     topics (thèmes déjà vus, passés en « avoid »), swPrep, swRun (bilan oral et écrit).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R) return;
  var esc = R.esc;

  /* ══ Estimateur (IRT simple, EAP sur grille) ════════════════════════════ */

  var CFG = {
    scale: { L: 90, R: 95 },
    guessFactor: 0.8,
    prior: { L: { mean: 325, sd: 150 }, R: { mean: 260, sd: 150 } },
    modelSd: 35,
    levelDifficulty: {
      L: { A1: 85, A2: 190, B1: 335, B2: 445, C1: 520 },
      R: { A1: 85, A2: 195, B1: 330, B2: 420, C1: 500 }
    },
    featureAdj: {
      indirect_response: 30, negation: 15, paraphrase: 20, info_in_middle: 15,
      cross_text: 30, inference: 20, rare_vocabulary: 25, graphic: 10, lexical_match: -25
    },
    cefrCuts: {
      L: { A1: 60, A2: 110, B1: 275, B2: 400, C1: 490 },
      R: { A1: 60, A2: 115, B1: 275, B2: 385, C1: 455 },
      S: { A1: 50, A2: 90, B1: 120, B2: 160, C1: 180 },
      W: { A1: 30, A2: 70, B1: 120, B2: 150, C1: 180 },
      T: { A1: 120, A2: 225, B1: 550, B2: 785, C1: 945 }
    },
    max: { L: 495, R: 495, S: 200, W: 200, T: 990 }
  };
  var CEFR_NAMES = ['<A1', 'A1', 'A2', 'B1', 'B2', 'C1'];

  var GRID = [];
  for (var gs = -150; gs <= 650; gs += 5) GRID.push(gs);

  function round5(x, lo, hi) { return Math.min(hi, Math.max(lo, Math.round(x / 5) * 5)); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function itemLevel(c) {
    c = String(c || '').toUpperCase().replace(/[^A-C12]/g, '');
    if (c === 'C2') return 'C1';
    return CFG.levelDifficulty.L[c] != null ? c : 'B1';
  }

  function difficulty(item) {
    var d = item.difficultyPoints != null ? item.difficultyPoints : CFG.levelDifficulty[item.section][itemLevel(item.cefr)];
    arr(item.features).forEach(function (f) { d += CFG.featureAdj[f] || 0; });
    return d + num(item.calibrationOffset, 0);
  }

  function pCorrect(S, item) {
    var c = CFG.guessFactor / (item.nOptions || 4);
    return c + (1 - c) / (1 + Math.exp(-(S - difficulty(item)) / CFG.scale[item.section]));
  }

  function cefrOf(section, score) {
    var cuts = CFG.cefrCuts[section];
    var b = [-Infinity, cuts.A1, cuts.A2, cuts.B1, cuts.B2, cuts.C1, Infinity];
    for (var k = 0; k < CEFR_NAMES.length; k++) if (score >= b[k] && score < b[k + 1]) return CEFR_NAMES[k];
    return 'C1';
  }

  /* responses : [{ item, correct }] d'une section → score, écart type, IC 90 %, probabilités CECRL. */
  function estimateSection(section, responses, opts) {
    opts = opts || {};
    var prior = opts.prior || CFG.prior[section];
    var modelSd = opts.modelSd != null ? opts.modelSd : CFG.modelSd;
    var pre = arr(responses).map(function (r) {
      return { d: difficulty(r.item), c: CFG.guessFactor / (r.item.nOptions || 4), x: !!r.correct };
    });
    var sc = CFG.scale[section];
    var logPost = GRID.map(function (S) {
      var lp = -0.5 * Math.pow((S - prior.mean) / prior.sd, 2);
      for (var i = 0; i < pre.length; i++) {
        var q = pre[i];
        var p = q.c + (1 - q.c) / (1 + Math.exp(-(S - q.d) / sc));
        lp += Math.log(q.x ? p : 1 - p);
      }
      return lp;
    });
    var m = Math.max.apply(null, logPost);
    var w = logPost.map(function (v) { return Math.exp(v - m); });
    var z = w.reduce(function (a, b) { return a + b; }, 0);
    var post = w.map(function (v) { return v / z; });
    var mean = 0, i;
    for (i = 0; i < GRID.length; i++) mean += GRID[i] * post[i];
    var varM = 0;
    for (i = 0; i < GRID.length; i++) varM += Math.pow(GRID[i] - mean, 2) * post[i];
    var sdMeas = Math.sqrt(varM);
    var sd = Math.sqrt(sdMeas * sdMeas + modelSd * modelSd);
    var quant = function (p) { var acc = 0; for (var k = 0; k < GRID.length; k++) { acc += post[k]; if (acc >= p) return GRID[k]; } return GRID[GRID.length - 1]; };
    var widen = function (x) { return mean + (x - mean) * (sd / Math.max(sdMeas, 1e-9)); };
    var cuts = CFG.cefrCuts[section];
    var bounds = [-Infinity, cuts.A1, cuts.A2, cuts.B1, cuts.B2, cuts.C1, Infinity];
    var cefrProb = {};
    CEFR_NAMES.forEach(function (n, k) {
      var a = 0;
      for (var g = 0; g < GRID.length; g++) if (GRID[g] >= bounds[k] && GRID[g] < bounds[k + 1]) a += post[g];
      cefrProb[n] = +a.toFixed(3);
    });
    var score = round5(mean, 5, 495);
    var lo = round5(widen(quant(0.05)), 5, 495), hi = round5(widen(quant(0.95)), 5, 495);
    /* Aux bords de l'échelle (tout juste ou tout faux), l'intervalle borné s'écraserait sur 5 ou 495. */
    if (lo >= score) lo = round5(score - 1.645 * sd, 5, 495);
    if (hi <= score) hi = round5(score + 1.645 * sd, 5, 495);
    return {
      section: section, score: score, mean: Math.round(mean), sd: Math.round(sd), sdMeasurement: Math.round(sdMeas),
      ci90: [lo, hi],
      cefr: cefrOf(section, score), cefrProb: cefrProb,
      nItems: pre.length, nCorrect: pre.filter(function (q) { return q.x; }).length
    };
  }

  function normCdf(x) {
    /* Abramowitz & Stegun 7.1.26 */
    var t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }

  function normalCefr(section, mean, sd) {
    var cuts = CFG.cefrCuts[section];
    var b = [-Infinity, cuts.A1, cuts.A2, cuts.B1, cuts.B2, cuts.C1, Infinity];
    var out = {};
    CEFR_NAMES.forEach(function (n, k) {
      var lo = b[k] === -Infinity ? 0 : normCdf((b[k] - mean) / sd);
      var hi = b[k + 1] === Infinity ? 1 : normCdf((b[k + 1] - mean) / sd);
      out[n] = +Math.max(0, hi - lo).toFixed(3);
    });
    return out;
  }

  function combineTotal(L, Rr) {
    var sd = Math.sqrt(L.sd * L.sd + Rr.sd * Rr.sd), t = L.score + Rr.score;
    return {
      score: t, sd: Math.round(sd), ci90: [round5(t - 1.645 * sd, 10, 990), round5(t + 1.645 * sd, 10, 990)],
      cefr: cefrOf('T', t), cefrProb: normalCefr('T', t, sd)
    };
  }

  /* Routage après l'étape 1 : estimation provisoire sans erreur de modèle. */
  function routeStage2(section, stage1, threshold) {
    return estimateSection(section, stage1, { modelSd: 0 }).score >= threshold ? 'hard' : 'easy';
  }

  /* Écart observé − attendu par capacité, au score estimé (faible si z < −1,5 et n ≥ 4). */
  function weakPoints(section, responses, score) {
    var by = {}, order = [];
    arr(responses).forEach(function (r) {
      var k = r.item.ability;
      if (!k) return;
      var p = pCorrect(score, r.item);
      if (!by[k]) { by[k] = { ability: k, n: 0, correct: 0, expected: 0, v: 0 }; order.push(k); }
      by[k].n++; by[k].correct += r.correct ? 1 : 0; by[k].expected += p; by[k].v += p * (1 - p);
    });
    return order.map(function (k) {
      var a = by[k];
      var z = +((a.correct - a.expected) / Math.sqrt(a.v || 1)).toFixed(2);
      return { ability: k, n: a.n, correct: a.correct, expected: +a.expected.toFixed(2), v: +a.v.toFixed(3), z: z, weak: a.n >= 4 && z < -1.5, strong: a.n >= 4 && z > 1.5 };
    });
  }

  /* Tendance : filtre de Kalman 1D (dérive = variation plausible en points par racine de jour). */
  function kalman(state, meas, days, drift) {
    if (drift == null) drift = 4;
    if (!state) return { mean: Math.round(meas.score), sd: Math.round(meas.sd) };
    var pv = state.sd * state.sd + drift * drift * Math.max(0, days), k = pv / (pv + meas.sd * meas.sd);
    return { mean: Math.round(state.mean + k * (meas.score - state.mean)), sd: Math.round(Math.sqrt((1 - k) * pv)) };
  }

  /* Calibration sur des scores officiels : décalage rétréci vers zéro. */
  function calibrationOffset(pairs, k) {
    if (k == null) k = 2;
    pairs = arr(pairs).filter(function (p) { return p && isFinite(p.official) && isFinite(p.app) && p.app != null; });
    return pairs.length ? Math.round(pairs.reduce(function (a, p) { return a + (p.official - p.app); }, 0) / (pairs.length + k)) : 0;
  }

  /* ── Oral et écrit : estimation 0-200 (heuristique de conception, non ETS) ── */
  function interp(x, pts) {
    if (x <= pts[0][0]) return pts[0][1];
    for (var i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) { var a = pts[i - 1], b = pts[i]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); }
    }
    return pts[pts.length - 1][1];
  }
  var SPEAKING_W = { read_aloud: [1, 3], describe_picture: [1, 3], respond_questions: [1.5, 3], respond_info: [1.5, 3], opinion: [2, 5] };
  var SPEAKING_MAP = [[0, 0], [0.05, 15], [0.21, 45], [0.32, 65], [0.44, 90], [0.61, 115], [0.74, 140], [0.90, 170], [0.99, 195], [1, 200]];
  var WRITING_W = { picture_sentence: [1, 3], email: [2, 4], essay: [3, 5] };
  var WRITING_MAP = [[0, 0], [0.05, 15], [0.22, 40], [0.33, 55], [0.44, 75], [0.54, 95], [0.67, 120], [0.79, 150], [0.93, 180], [1, 200]];
  var WRITING_MAP_NO_ESSAY = [[0, 0], [0.05, 15], [0.28, 40], [0.43, 55], [0.57, 75], [0.68, 95], [0.79, 120], [0.93, 150], [1, 160]];
  var TASK_ALIAS = { describe: 'describe_picture', respond: 'respond_questions', sentence: 'picture_sentence' };

  function estimateProductive(kind, tasks) {
    var speaking = kind === 'speaking' || kind === 'S' || kind === 'speak';
    var W = speaking ? SPEAKING_W : WRITING_W;
    var byType = {};
    arr(tasks).forEach(function (t) {
      var type = TASK_ALIAS[t.type] || t.type;
      if (!W[type]) return;
      (byType[type] = byType[type] || []).push(Math.max(0, Math.min(1, num(t.score, 0) / W[type][1])));
    });
    var nu = 0, de = 0;
    Object.keys(byType).forEach(function (type) {
      var vals = byType[type];
      var m = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      nu += W[type][0] * m; de += W[type][0];
    });
    var comp = de ? nu / de : 0;
    var noEssay = !speaking && !byType.essay;
    var map = speaking ? SPEAKING_MAP : (noEssay ? WRITING_MAP_NO_ESSAY : WRITING_MAP);
    var score = Math.min(200, Math.max(0, Math.round(interp(comp, map) / 10) * 10));
    var half = speaking ? 20 : (noEssay ? 30 : 20);
    var cuts = CFG.cefrCuts[speaking ? 'S' : 'W'];
    var cefr = ['C1', 'B2', 'B1', 'A2', 'A1'].filter(function (l) { return score >= cuts[l]; })[0] || '<A1';
    return { kind: speaking ? 'speaking' : 'writing', composite: +comp.toFixed(3), score: score, range: [Math.max(0, score - half), Math.min(200, score + half)], cefr: cefr, capped: noEssay && score >= 150 };
  }

  /* Score → theta du noyau (B1 au centre = 0) : chaque seuil officiel est la frontière basse d'un niveau,
     placée à mi-chemin entre deux centres (A2 = −1, B1 = 0…). */
  function thetaOfScore(section, score) {
    var c = CFG.cefrCuts[section];
    if (!c || !isFinite(score)) return null;
    var pts = [[c.A1, -2.5], [c.A2, -1.5], [c.B1, -0.5], [c.B2, 0.5], [c.C1, 1.5]];
    var t;
    if (score <= pts[0][0]) t = -2.5 - (pts[0][0] - score) / (pts[1][0] - pts[0][0]);
    else if (score >= pts[4][0]) t = 1.5 + (score - pts[4][0]) / (pts[4][0] - pts[3][0]);
    else {
      for (var i = 1; i < pts.length; i++) {
        if (score <= pts[i][0]) { t = pts[i - 1][1] + (score - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]); break; }
      }
    }
    return Math.max(-3, Math.min(3.5, Math.round(t * 100) / 100));
  }

  /* « B2 », ou « B1-B2 limite » quand le niveau du score a moins de 60 % de probabilité. */
  function cefrLabel(est) {
    var main = est.cefr, p = num(est.cefrProb && est.cefrProb[main], 0);
    if (p >= 0.6 || !est.cefrProb) return { label: main, main: main, p: p };
    var i = CEFR_NAMES.indexOf(main);
    var lo = CEFR_NAMES[i - 1], hi = CEFR_NAMES[i + 1];
    var plo = lo ? num(est.cefrProb[lo], 0) : 0, phi = hi ? num(est.cefrProb[hi], 0) : 0;
    var nb = phi >= plo ? hi : lo, pnb = Math.max(plo, phi);
    if (!nb || pnb < 0.2) return { label: main, main: main, p: p, unsure: true };
    var pair = CEFR_NAMES.indexOf(nb) < i ? [nb, main] : [main, nb];
    return { label: pair[0] + '-' + pair[1] + ' limite', main: main, p: p, pair: pair };
  }

  /* ══ Libellés ═══════════════════════════════════════════════════════════ */

  var MENTION = 'format type TOEIC® · score estimé, non officiel — TOEIC est une marque déposée d’ETS, qui n’est pas associé à Révizator';
  var LETTERS = ['A', 'B', 'C', 'D'];
  var SPOKEN_LETTERS = ['A', 'Bee', 'See', 'Dee'];
  var READ_MS = 16 * 60000;
  var LIS_WAIT = { 2: 5000, 3: 8000, 4: 8000 };
  var NEXT_EXPRESS_DAYS = 21, NEXT_SW_DAYS = 30;
  var PARTS = {
    2: 'Questions-réponses', 3: 'Conversations', 4: 'Exposés', 5: 'Phrases à compléter', 6: 'Textes à compléter', 7: 'Documents'
  };
  var PART_ONE = { 2: 'Question-réponse', 3: 'Conversation', 4: 'Exposé', 5: 'Phrase à compléter', 6: 'Texte à compléter', 7: 'Document' };
  var ABILITIES = {
    L_gist_short: { label: 'Saisir l’essentiel d’un échange court', tip: 'Questions-réponses : écoutez la question jusqu’au bout, repérez le mot interrogatif et méfiez-vous des réponses qui reprennent un mot entendu.' },
    L_gist_ext: { label: 'Saisir l’essentiel d’une conversation ou d’un exposé', tip: 'Avant l’écoute, lisez les questions : qui parle, où, pourquoi. Les dialogues longs des exercices d’écoute entraînent ce réflexe.' },
    L_detail_short: { label: 'Comprendre les détails d’un échange court', tip: 'Dictées partielles et questions de détail : chiffres, heures, lieux, noms.' },
    L_detail_ext: { label: 'Comprendre les détails d’un texte long', tip: 'Notez les détails au fil de l’écoute : la réponse est presque toujours reformulée, rarement répétée mot pour mot.' },
    L_pragmatic: { label: 'Comprendre l’intention ou le sous-entendu', tip: 'Questions d’intention : demandez-vous ce que la phrase fait (refuser, s’excuser, rassurer, proposer) plutôt que ce qu’elle dit.' },
    R_locate: { label: 'Trouver une information dans un tableau ou un texte', tip: 'Lecture rapide : cherchez d’abord les mots-clés de la question dans le texte, puis leurs reformulations.' },
    R_connect: { label: 'Relier des informations entre phrases et documents', tip: 'Documents multiples : surlignez les renvois d’un texte à l’autre (noms, dates, chiffres) avant de répondre.' },
    R_infer: { label: 'Faire des inférences', tip: 'Inférences et intentions : appuyez chaque réponse sur une phrase précise du texte, jamais sur une impression.' },
    R_vocab: { label: 'Vocabulaire du travail', tip: 'Révisez vos cartes et les collocations du monde professionnel (meet a deadline, place an order…).' },
    R_grammar: { label: 'Grammaire', tip: 'Partie 5 : regardez d’abord ce qui entoure le trou (nom, verbe, proposition ?) — forme des mots, temps, prépositions, connecteurs.' }
  };
  var SW_TASKS = {
    read_aloud: { label: 'Lecture à voix haute', mode: 'speak', criteria: ['Prononciation : intelligible, peu d’écarts', 'Intonation et accentuation adaptées au texte', 'Pauses aux bons endroits, débit régulier'] },
    describe: { label: 'Décrire une scène', mode: 'speak', criteria: ['Décrit la scène de façon complète et exacte', 'Vocabulaire et structures suffisants', 'Discours enchaîné et intelligible'] },
    respond: { label: 'Répondre à des questions', mode: 'speak', criteria: ['Répond à la question de façon pertinente et complète', 'Langue correcte et suffisante', 'Intelligible sans effort'] },
    respond_info: { label: 'Répondre à partir d’un document', mode: 'speak', criteria: ['Donne les informations exactes du document', 'Les reformule clairement à l’oral', 'Langue correcte et intelligible'] },
    opinion: { label: 'Donner son opinion', mode: 'speak', criteria: ['Position claire', 'Raisons, détails et exemples cohérents', 'Débit, grammaire et vocabulaire'] },
    sentence: { label: 'Phrase avec deux mots imposés', mode: 'write', criteria: ['Une seule phrase grammaticalement correcte', 'Les deux mots employés correctement', 'Cohérente avec la situation'] },
    email: { label: 'Répondre à un e-mail', mode: 'write', criteria: ['Toutes les consignes traitées', 'Organisation et liens logiques', 'Ton et registre adaptés', 'Qualité et variété des phrases'] },
    essay: { label: 'Essai d’opinion', mode: 'write', criteria: ['Opinion étayée par des raisons et des exemples', 'Organisation, unité et progression', 'Grammaire et vocabulaire variés et précis', 'Au moins 300 mots'] }
  };
  var SW_ESTIMATE_TYPE = { read_aloud: 'read_aloud', describe: 'describe_picture', respond: 'respond_questions', respond_info: 'respond_info', opinion: 'opinion', sentence: 'picture_sentence', email: 'email', essay: 'essay' };

  /* ══ État ═══════════════════════════════════════════════════════════════ */

  var U = R.ui.test = R.ui.test || {};
  U.screen = U.screen || 'home';
  U.skew = U.skew || 0;
  U.tok = 0;
  U.arm = {};
  U.cal = U.cal || { date: '', L: '', R: '' };
  U.swGrades = U.swGrades || {};
  U.blobUrls = U.blobUrls || {};

  function now() { return Date.now() + U.skew; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clock(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + pad2(s % 60); }
  function pageApi() { return window.__organizator && window.__organizator.pageApi; }
  function onTestsView() {
    var A = pageApi();
    return !!(A && A.currentPage() === 'revizator' && R.viewId() === 'tests');
  }
  function frDate(ms) { return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }
  function frShort(ms) { return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); }
  function signed(n) { return (n > 0 ? '+' : (n < 0 ? '−' : '')) + Math.abs(n); }
  function plural(n, one, many) { return n + ' ' + (n > 1 ? (many || one + 's') : one); }

  function TD() {
    var t = R.data.toeic;
    if (!t.calib || typeof t.calib !== 'object') t.calib = { L: [], R: [] };
    if (!Array.isArray(t.calib.L)) t.calib.L = [];
    if (!Array.isArray(t.calib.R)) t.calib.R = [];
    if (!Array.isArray(t.history)) t.history = [];
    if (!Array.isArray(t.bank)) t.bank = [];
    if (!Array.isArray(t.topics)) t.topics = [];
    if (t.prep === undefined) t.prep = null;
    if (t.run === undefined) t.run = null;
    if (t.swPrep === undefined) t.swPrep = null;
    if (t.swRun === undefined) t.swRun = null;
    if (t.T === undefined) t.T = null;
    return t;
  }

  function lastOf(kind) {
    var h = TD().history;
    for (var i = h.length - 1; i >= 0; i--) if (h[i] && h[i].kind === kind) return h[i];
    return null;
  }
  function historyById(id) {
    var h = TD().history;
    for (var i = 0; i < h.length; i++) if (h[i] && h[i].id === id) return h[i];
    return null;
  }

  /* Niveau visé par l'étape 1 : la dernière estimation (bilan, sinon niveau courant d'écoute et de lecture). */
  function centerLevel() {
    var t = TD(), th;
    if (t.L && t.R) th = (thetaOfScore('L', t.L.mean) + thetaOfScore('R', t.R.mean)) / 2;
    else th = (R.level('listen').theta + R.level('read').theta) / 2;
    var b = String(R.band(th)).replace('+', '');
    return { A1: 'A2', A2: 'A2', B1: 'B1', B2: 'B2', C1: 'C1', C2: 'C1' }[b] || 'B1';
  }
  function genLevel() {
    var b = R.globalBand();
    var ok = ['A2', 'B1', 'B1+', 'B2', 'B2+', 'C1'];
    if (ok.indexOf(b) >= 0) return b;
    return /^A/.test(b) ? 'A2' : (/^C/.test(b) ? 'C1' : 'B1');
  }
  function threshold(section, center) {
    var base = CFG.levelDifficulty[section][center] - (section === 'R' ? 20 : 0);
    var tr = TD()[section];
    if (tr && isFinite(tr.mean) && center === centerLevel()) return Math.max(base - 50, Math.min(base + 50, tr.mean));
    return base;
  }
  function calibPairs(s) { return TD().calib[s].filter(function (p) { return p && p.app != null && isFinite(p.app); }); }
  function offsetFor(s) { return calibrationOffset(calibPairs(s)); }
  function modelSdFor(s) { var n = calibPairs(s).length; return n >= 2 ? 20 : (n === 1 ? 25 : 35); }

  /* ══ Documents ══════════════════════════════════════════════════════════ */

  var LOADING = {};
  function doc(kind, id) { return id ? R.docCached(kind, id) : null; }
  function needDocs(kind, ids) {
    var missing = ids.filter(function (id) { return id && !R.docCached(kind, id); });
    missing.forEach(function (id) {
      var k = kind + ':' + id;
      if (LOADING[k]) return;
      LOADING[k] = R.doc(kind, id).then(function (d) {
        delete LOADING[k];
        if (!d) U.docError = 'Un module du bilan est introuvable (' + id + ').';
        R.render();
      }, function (e) { delete LOADING[k]; U.docError = e.message; R.render(); });
    });
    return !missing.length;
  }

  function validModule(d) {
    if (!d) return 'module vide';
    var lq = 0, rq = 0;
    arr(d.listening).forEach(function (s) { lq += arr(s.questions).length; });
    arr(d.reading).forEach(function (s) { rq += arr(s.questions).length; });
    if (!lq || !rq) return 'module incomplet (' + lq + ' questions d’écoute, ' + rq + ' de lecture)';
    return '';
  }

  /* ══ Préparation du bilan express ═══════════════════════════════════════ */

  function avoidTopics() {
    var t = TD();
    return t.topics.slice(-30);
  }
  function rememberTopics(ids) {
    var t = TD();
    ids.forEach(function (id) {
      var d = doc('toeic', id);
      if (!d) return;
      arr(d.listening).concat(arr(d.reading)).forEach(function (s) {
        var tp = String(s.topic || '').trim().slice(0, 60);
        if (tp && t.topics.indexOf(tp) < 0) t.topics.push(tp);
      });
    });
    if (t.topics.length > 60) t.topics = t.topics.slice(t.topics.length - 60);
  }

  function bankClean() {
    var t = TD(), lim = Date.now() - 120 * 86400000;
    t.bank = t.bank.filter(function (b) { return b && b.id && (b.L || b.R) && num(b.at, 0) > lim; });
    if (t.bank.length > 10) t.bank = t.bank.slice(t.bank.length - 10);
  }
  function bankAdd(id, module, center, sections) {
    if (!id || (module !== 'easy' && module !== 'hard')) return;
    var t = TD();
    var e = t.bank.filter(function (b) { return b.id === id; })[0];
    if (!e) { e = { id: id, module: module, center: center, at: Date.now(), L: false, R: false }; t.bank.push(e); }
    sections.forEach(function (s) { e[s] = true; });
    bankClean();
  }
  function bankTake(module, center, s) {
    var t = TD();
    for (var i = 0; i < t.bank.length; i++) {
      var b = t.bank[i];
      if (b.module === module && b.center === center && b[s]) { b[s] = false; return b.id; }
    }
    return null;
  }
  function bankHas(module, center, s) {
    return TD().bank.some(function (b) { return b.module === module && b.center === center && b[s]; });
  }
  function bankReady(center) {
    return ['easy', 'hard'].filter(function (m) { return bankHas(m, center, 'L') && bankHas(m, center, 'R'); });
  }

  function prepStart() {
    var t = TD();
    if (t.prep || t.run) return;
    var center = centerLevel();
    var prep = t.prep = { id: R.uid('rztp'), center: center, startedAt: Date.now(), jobs: {}, docs: {}, errors: {}, slots: { L: {}, R: {} }, taken: [], readyAt: 0, notified: false };
    bankClean();
    ['easy', 'hard'].forEach(function (m) {
      ['L', 'R'].forEach(function (s) {
        var id = bankTake(m, center, s);
        if (id) { prep.slots[s][m] = id; prep.taken.push({ id: id, module: m, s: s }); }
      });
      if (prep.slots.L[m] && prep.slots.R[m]) prep.docs[m] = 'bank';
    });
    var ids = prep.taken.map(function (x) { return x.id; });
    needDocs('toeic', ids);
    ['stage1', 'easy', 'hard'].forEach(function (m) { if (!prep.docs[m]) launchModule(m); });
    R.save(true);
    R.render();
  }

  function launchModule(m) {
    var prep = TD().prep;
    if (!prep) return;
    var job = R.uid('rzt' + m.charAt(0));
    prep.jobs[m] = job;
    delete prep.errors[m];
    R.gen('toeic', { module: m, center: prep.center, avoid: avoidTopics() }, { job: job }).then(function (r) {
      moduleDone(m, job, r);
    }, function (e) {
      var p = TD().prep;
      if (!p || p.jobs[m] !== job) return;
      p.jobs[m] = null;
      p.errors[m] = (e && e.message) || 'échec de la préparation';
      R.save();
      R.render();
    });
  }

  function moduleDone(m, job, r) {
    var t = TD(), prep = t.prep;
    if (!r || !r.id || !r.doc) return;
    R.docPut('toeic', r.id, r.doc);
    var mod = r.doc.module || m;
    if (!prep || (prep.jobs[mod] !== job && prep.docs[mod] !== r.id)) {
      /* Un module arrivé après l'annulation : un module d'étape 2 jamais vu sert au bilan suivant. */
      if (mod === 'easy' || mod === 'hard') { bankAdd(r.id, mod, r.doc.center || (prep && prep.center) || 'B1', ['L', 'R']); R.save(); }
      return;
    }
    if (prep.docs[mod] === r.id) return;
    var bad = validModule(r.doc);
    prep.jobs[mod] = null;
    if (bad) { prep.errors[mod] = 'Le module reçu est inutilisable : ' + bad + '.'; R.save(); R.render(); return; }
    prep.docs[mod] = r.id;
    if (mod !== 'stage1') {
      ['L', 'R'].forEach(function (s) {
        if (!prep.slots[s][mod]) prep.slots[s][mod] = r.id;
        else bankAdd(r.id, mod, prep.center, [s]);
      });
    }
    checkReady();
    R.save();
    R.render();
  }

  function prepComplete(prep) {
    return !!(prep && prep.docs.stage1 && prep.slots.L.easy && prep.slots.L.hard && prep.slots.R.easy && prep.slots.R.hard);
  }
  function checkReady() {
    var prep = TD().prep;
    if (!prepComplete(prep) || prep.readyAt) return;
    prep.readyAt = Date.now();
    if (!prep.notified) {
      prep.notified = true;
      R.notify('Votre bilan express est prêt : 43 questions, environ 27 minutes.', 'tests');
    }
  }

  function prepCancel() {
    var t = TD(), prep = t.prep;
    if (!prep) return;
    ['stage1', 'easy', 'hard'].forEach(function (m) { if (prep.jobs[m]) R.cancel(prep.jobs[m]); });
    prep.taken.forEach(function (x) { bankAdd(x.id, x.module, prep.center, [x.s]); });
    ['easy', 'hard'].forEach(function (m) {
      var id = prep.docs[m];
      if (id && id !== 'bank') ['L', 'R'].forEach(function (s) { if (prep.slots[s][m] === id) bankAdd(id, m, prep.center, [s]); });
    });
    t.prep = null;
    R.save(true);
    R.render();
  }

  function prepModuleState(prep, m) {
    if (prep.docs[m] === 'bank') return 'bank';
    if (prep.docs[m]) return 'done';
    if (prep.errors[m]) return 'error';
    if (prep.jobs[m] && R.jobById(prep.jobs[m])) return 'running';
    if (prep.jobs[m] && U.reattachDone) return 'lost';
    return 'running';
  }

  /* ══ Bilan express : déroulé ════════════════════════════════════════════ */

  function runStart() {
    var t = TD(), p = t.prep;
    if (!p || !prepComplete(p) || t.run) return;
    t.run = {
      id: R.uid('rztr'), kind: 'express', center: p.center, createdAt: Date.now(), startedAt: 0, phase: 'intro',
      docs: { stage1: p.docs.stage1, L: { easy: p.slots.L.easy, hard: p.slots.L.hard }, R: { easy: p.slots.R.easy, hard: p.slots.R.hard } },
      path: { L: '', R: '' }, threshold: { L: threshold('L', p.center), R: threshold('R', p.center) },
      lis: { stage: 1, i: 0, phase: 'ready', deadline: 0, rest: 0 },
      read: { stage: 1, qi: 0, ms: 0, from: 0 },
      answers: {}, pauses: 0, replays: 0, paused: false, lisMs: 0, lisFrom: 0
    };
    t.prep = null;
    U.screen = 'express';
    R.save(true);
    R.render();
  }

  function runDocIds(run) {
    return [run.docs.stage1, run.docs.L.easy, run.docs.L.hard, run.docs.R.easy, run.docs.R.hard];
  }
  function stageDocId(run, section, stage) {
    return stage === 1 ? run.docs.stage1 : (run.path[section] ? run.docs[section][run.path[section]] : null);
  }
  function setsOf(run, section, stage) {
    var d = doc('toeic', stageDocId(run, section, stage));
    if (!d) return [];
    return arr(section === 'L' ? d.listening : d.reading).filter(function (s) { return s && arr(s.questions).length; });
  }
  function flat(run, section, stage) {
    var id = stageDocId(run, section, stage);
    var out = [];
    setsOf(run, section, stage).forEach(function (set, si) {
      arr(set.questions).forEach(function (q, qi) {
        out.push({ set: set, si: si, q: q, qi: qi, key: id + ':' + set.id + ':' + (q.id || ('q' + (qi + 1))), docId: id, stage: stage, section: section });
      });
    });
    return out;
  }
  function numberOffset(run, section, stage) { return stage === 1 ? 0 : flat(run, section, 1).length; }
  function setFirstNumber(run, section, stage, si) {
    var n = numberOffset(run, section, stage) + 1;
    var sets = setsOf(run, section, stage);
    for (var i = 0; i < si; i++) n += arr(sets[i].questions).length;
    return n;
  }
  function qKey(run, set, q, qi, section, stage) { return stageDocId(run, section, stage) + ':' + set.id + ':' + (q.id || ('q' + (qi + 1))); }

  function itemOf(it, offset) {
    var part = num(it.set.part, it.section === 'L' ? 3 : 5);
    return {
      section: it.section, part: part, cefr: itemLevel(it.q.cefr), features: arr(it.q.features), ability: it.q.ability || '',
      nOptions: arr(it.q.options).length || (part === 2 ? 3 : 4), calibrationOffset: offset || 0
    };
  }
  function responsesOf(run, section, stages, offset) {
    var out = [];
    stages.forEach(function (st) {
      flat(run, section, st).forEach(function (it) {
        var a = run.answers[it.key];
        out.push({ item: itemOf(it, offset), correct: a != null && +a === +it.q.answer, it: it });
      });
    });
    return out;
  }

  /* ── Écoute ── */

  function curSet(run) { return setsOf(run, 'L', run.lis.stage)[run.lis.i] || null; }
  function lisKey(run) { return 'rzt-l-' + run.id + '-' + run.lis.stage + '-' + run.lis.i; }

  function normAccent(a) {
    a = String(a || '').trim();
    if (/^en-/i.test(a)) return 'en-' + a.slice(3).toUpperCase();
    if (/^(US|GB|UK|AU|CA|IE|IN)$/i.test(a)) return 'en-' + (a.toUpperCase() === 'UK' ? 'GB' : a.toUpperCase());
    return 'en-US';
  }
  function introText(set, first, last, forSpeech) {
    var range = first === last ? String(first) : first + (forSpeech ? ' through ' : '-') + last;
    var txt = String(set.intro || '').trim();
    if (txt) return txt.replace(/Questions?\s+\d+\s*(?:[-–—]|to|through)\s*\d+/i, 'Questions ' + range);
    var n = arr(set.speakers).filter(function (s) { return s.id !== 'N'; }).length;
    var what = set.part === 4 ? 'talk' : (n >= 3 ? 'conversation with three speakers' : 'conversation');
    if (set.graphic) what += ' and ' + (/chart/.test(set.graphic.kind) ? 'chart' : (set.graphic.kind === 'schedule' ? 'schedule' : 'table'));
    return 'Questions ' + range + ' refer to the following ' + what + '.';
  }
  /* Partie 6 ou 7 : « Questions 4-7 refer to the following e-mail. », renuméroté comme à l'écran. */
  function readIntro(set, first, last) {
    var range = first === last ? 'Question ' + first : 'Questions ' + first + '-' + last;
    var txt = String(set.intro || '').trim();
    if (txt) return txt.replace(/Questions?\s+\d+(?:\s*(?:[-–—]|to|through|and)\s*\d+)?/i, range);
    var kinds = arr(set.documents).map(function (d) { return { email: 'e-mail', memo: 'memo', article: 'article', notice: 'notice', ad: 'advertisement', chat: 'text-message chain', form: 'form', letter: 'letter', webpage: 'Web page', schedule: 'schedule', text: 'text message' }[d.kind] || 'text'; });
    return range + ' refer to the following ' + (kinds.length ? kinds.join(' and ') : 'text') + '.';
  }

  function audioSpec(set, first, last) {
    var sp = arr(set.speakers).map(function (s) { return { id: s.id, accent: normAccent(s.accent), gender: s.gender === 'male' ? 'male' : 'female', role: s.role || '' }; });
    var lines = [];
    if (+set.part === 2) {
      var a = arr(set.audio)[0] || { speaker: sp[0] ? sp[0].id : '', text: '' };
      var qs = sp.filter(function (x) { return x.id === a.speaker; })[0];
      if (!qs) { qs = { id: '_Q', accent: 'en-US', gender: 'female' }; sp.push(qs); }
      /* L'hôte met en speakers[1] la voix qui dit les trois réponses. */
      var resp = sp[1] && sp[1].id !== qs.id ? sp[1] : sp.filter(function (x) { return x.id !== qs.id; })[0];
      if (!resp) { resp = { id: '_R', accent: qs.accent === 'en-GB' ? 'en-US' : 'en-GB', gender: qs.gender === 'male' ? 'female' : 'male' }; sp.push(resp); }
      lines.push({ speaker: qs.id, text: String(a.text || ''), shown: String(a.text || '') });
      arr(set.questions[0] && set.questions[0].options).forEach(function (o, i) {
        /* La lettre est écrite comme elle se dit : seule, « B. » sortait « bay » et « C. » « zee » des voix
           naturelles (vérifié par Whisper sur l'hôte) ; « Bee », « See » se prononcent juste dans les deux accents. */
        lines.push({ speaker: resp.id, text: SPOKEN_LETTERS[i] + '. ' + o, shown: '(' + LETTERS[i] + ') ' + o, opt: i });
      });
    } else {
      var first0 = sp[0];
      var narr = { id: '_N', accent: 'en-US', gender: first0 && first0.gender === 'male' && first0.accent === 'en-US' ? 'female' : 'male' };
      lines.push({ speaker: '_N', text: introText(set, first, last, true), shown: introText(set, first, last, false), intro: true });
      arr(set.audio).forEach(function (l) { lines.push({ speaker: l.speaker, text: String(l.text || ''), shown: String(l.text || '') }); });
      sp.push(narr);
    }
    return { lines: lines, speakers: sp };
  }

  function lisPlay(isReplay) {
    var run = TD().run;
    if (!run) return;
    var set = curSet(run);
    if (!set) { lisNext(); return; }
    if (isReplay) run.replays++;
    run.lis.phase = 'audio';
    run.lis.deadline = 0;
    run.paused = false;
    if (!run.lisFrom) run.lisFrom = Date.now();
    var key = lisKey(run);
    var first = setFirstNumber(run, 'L', run.lis.stage, run.lis.i), last = first + arr(set.questions).length - 1;
    var spec = audioSpec(set, first, last);
    var tok = ++U.tok;
    U.lisKey = key;
    U.lisError = '';
    U.activeQ = 0;
    R.ui.plays[key] = 1;
    var p = R.tts.script(spec.lines.map(function (l) { return { speaker: l.speaker, text: l.text }; }), spec.speakers, { key: key, gapMs: +set.part === 2 ? 650 : 450 });
    p.onChange(function () { if (tok === U.tok) R.renderSoon(0); });
    p.done.then(function (pl) {
      if (tok !== U.tok) return;
      var r2 = TD().run;
      if (!r2 || r2.phase !== 'listen' || lisKey(r2) !== key) return;
      var A = pageApi();
      if (A && A.currentPage() !== 'revizator') { r2.lis.phase = 'cut'; r2.paused = true; R.save(); return; }
      if (pl.state === 'error') { r2.lis.phase = 'error'; U.lisError = pl.error || 'lecture impossible'; R.render(); return; }
      lisAnswerPhase();
    });
    R.save();
    R.render();
  }

  function lisAnswerPhase() {
    var run = TD().run;
    var set = curSet(run);
    if (!set) return;
    run.lis.phase = 'answer';
    var wait = (LIS_WAIT[set.part] || 8000) * (+set.part === 2 ? 1 : arr(set.questions).length);
    run.lis.deadline = now() + wait;
    run.lis.total = wait;
    R.save();
    R.render();
  }

  function lisNext() {
    var t = TD(), run = t.run;
    if (!run || run.phase !== 'listen') return;
    U.tok++;
    var key = lisKey(run);
    if (R.players[key]) R.players[key].stop(true);
    run.lis.i++;
    run.lis.deadline = 0;
    var sets = setsOf(run, 'L', run.lis.stage);
    if (run.lis.i >= sets.length) {
      if (run.lis.stage === 1) {
        run.path.L = routeStage2('L', responsesOf(run, 'L', [1], offsetFor('L')), run.threshold.L);
        run.lis.stage = 2;
        run.lis.i = 0;
        U.flash = 'Étape 2 : la suite s’adapte à vos réponses.';
        saveAnswersToDocs(run);
        if (!needDocs('toeic', [stageDocId(run, 'L', 2)])) { run.lis.phase = 'ready'; R.save(true); R.render(); return; }
      } else {
        run.lisMs = run.lisFrom ? Date.now() - run.lisFrom : 0;
        run.phase = 'pause';
        run.lis.phase = 'done';
        saveAnswersToDocs(run);
        R.save(true);
        R.render();
        return;
      }
    }
    lisPlay(false);
  }

  function lisAnswer(key, i) {
    var run = TD().run;
    if (!run) return;
    run.answers[key] = i;
    var set = curSet(run);
    if (set && +set.part !== 2) {
      var qs = arr(set.questions);
      var next = -1;
      for (var k = 0; k < qs.length; k++) {
        var kk = qKey(run, set, qs[k], k, 'L', run.lis.stage);
        if (run.answers[kk] == null) { next = k; break; }
      }
      if (next >= 0) U.activeQ = next;
    }
    R.save();
    R.render();
  }

  /* ── Pause et reprise (onglet quitté, fenêtre rechargée, bouton Pause) ── */

  function examPause() {
    var t = TD(), run = t.run;
    if (run && !run.paused && (run.phase === 'listen' || run.phase === 'read')) {
      run.paused = true;
      run.pauses++;
      if (run.phase === 'listen') {
        if (run.lis.phase === 'audio') {
          var p = R.players[U.lisKey];
          if (p && (p.state === 'playing' || p.state === 'loading')) p.pause();
          if (!p || p.state !== 'paused') { U.tok++; if (p) p.stop(true); run.lis.phase = 'cut'; }
        } else if (run.lis.phase === 'answer') {
          run.lis.rest = Math.max(1500, run.lis.deadline - now());
          run.lis.deadline = 0;
        }
      } else {
        run.read.ms = readElapsed(run);
        run.read.from = 0;
      }
      R.save();
    }
    var sr = t.swRun;
    if (sr && sr.phase === 'task' && !sr.paused) swPause();
  }

  function examResume() {
    var run = TD().run;
    if (!run || !run.paused) return;
    run.paused = false;
    if (run.phase === 'listen') {
      if (run.lis.phase === 'audio') {
        var p = R.players[U.lisKey];
        if (p && p.state === 'paused') p.play(); else lisPlay(true);
      } else if (run.lis.phase === 'cut' || run.lis.phase === 'error') lisPlay(true);
      else if (run.lis.phase === 'answer') run.lis.deadline = now() + Math.max(1500, run.lis.rest || 3000);
      else if (run.lis.phase === 'ready') lisPlay(false);
    } else if (run.phase === 'read') {
      run.read.from = now();
    }
    R.save();
    R.render();
  }

  /* ── Lecture ── */

  function readElapsed(run) { return run.read.ms + (run.read.from ? now() - run.read.from : 0); }
  function readRemaining(run) { return Math.max(0, READ_MS - readElapsed(run)); }

  function readStart() {
    var run = TD().run;
    if (!run || run.phase !== 'pause') return;
    run.phase = 'read';
    run.read = { stage: 1, qi: 0, ms: 0, from: now() };
    run.paused = false;
    U.lastCheckpoint = Date.now();
    R.save(true);
    R.render();
  }

  function readGo(qi) {
    var run = TD().run;
    if (!run || run.phase !== 'read') return;
    var items = flat(run, 'R', run.read.stage);
    run.read.qi = Math.max(0, Math.min(items.length - 1, qi));
    R.save();
    R.render();
  }

  function readFinishStage(timeUp) {
    var run = TD().run;
    if (!run || run.phase !== 'read') return;
    if (run.read.stage === 1) {
      run.path.R = routeStage2('R', responsesOf(run, 'R', [1], offsetFor('R')), run.threshold.R);
      saveAnswersToDocs(run);
      if (timeUp || readRemaining(run) <= 0) { finishExpress(); return; }
      run.read.stage = 2;
      run.read.qi = 0;
      U.flash = 'Étape 2 : la suite s’adapte à vos réponses. Le chronomètre continue.';
      needDocs('toeic', [stageDocId(run, 'R', 2)]);
      R.save(true);
      R.render();
    } else {
      finishExpress();
    }
  }

  /* ── Fin : estimation, enregistrement, recalage ── */

  function saveAnswersToDocs(run) {
    var by = {};
    Object.keys(run.answers).forEach(function (k) {
      var id = k.split(':')[0];
      (by[id] = by[id] || {})[k.slice(id.length + 1)] = run.answers[k];
    });
    Object.keys(by).forEach(function (id) {
      var d = doc('toeic', id);
      if (!d) return;
      d.answers = Object.assign({}, d.answers || {}, by[id]);
      d.taken = { run: run.id, at: Date.now(), path: run.path };
      R.docSave('toeic', id, d)['catch'](function () { /* les réponses restent dans learning.json */ });
    });
  }

  function partsOf(resps) {
    var parts = {};
    resps.forEach(function (r) {
      var p = String(r.item.part);
      var x = parts[p] = parts[p] || { n: 0, c: 0 };
      x.n++; if (r.correct) x.c++;
    });
    return parts;
  }

  function finishExpress() {
    var t = TD(), run = t.run;
    if (!run) return;
    U.tok++;
    R.tts.stopAll();
    if (!run.path.L) run.path.L = routeStage2('L', responsesOf(run, 'L', [1], offsetFor('L')), run.threshold.L);
    if (!run.path.R) run.path.R = routeStage2('R', responsesOf(run, 'R', [1], offsetFor('R')), run.threshold.R);
    var ids = [stageDocId(run, 'L', 2), stageDocId(run, 'R', 2)];
    if (!needDocs('toeic', ids)) { U.finishPending = true; R.render(); return; }
    U.finishPending = false;
    var endedAt = Date.now();
    var readMs = run.phase === 'read' ? readElapsed(run) : run.read.ms;
    var res = {}, abil = {};
    ['L', 'R'].forEach(function (s) {
      var off = offsetFor(s);
      var resp = responsesOf(run, s, [1, 2], off);
      var est = estimateSection(s, resp, { modelSd: modelSdFor(s) });
      var raw = off ? estimateSection(s, responsesOf(run, s, [1, 2], 0), { modelSd: modelSdFor(s) }).score : est.score;
      var lab = cefrLabel(est);
      res[s] = {
        score: est.score, sd: est.sd, sdMeasurement: est.sdMeasurement, ci90: est.ci90, cefr: est.cefr, cefrProb: est.cefrProb,
        label: lab.label, n: est.nItems, correct: est.nCorrect, raw: raw, offset: off, path: run.path[s], parts: partsOf(resp)
      };
      weakPoints(s, resp, est.score).forEach(function (w) { abil[w.ability] = { n: w.n, c: w.correct, e: w.expected, v: w.v, z: w.z }; });
    });
    var total = combineTotal(res.L, res.R);
    var lastTrendAt = t.T ? t.T.at : 0;
    var days = function (st) { return st && st.at ? (endedAt - st.at) / 86400000 : 0; };
    var tL = kalman(t.L, res.L, days(t.L)), tR = kalman(t.R, res.R, days(t.R)), tT = kalman(t.T, total, days(t.T));
    t.L = { mean: tL.mean, sd: tL.sd, at: endedAt };
    t.R = { mean: tR.mean, sd: tR.sd, at: endedAt };
    t.T = { mean: tT.mean, sd: tT.sd, at: endedAt };
    var entry = {
      id: run.id, at: endedAt, kind: 'express', startedAt: run.startedAt || run.createdAt, center: run.center,
      minutes: Math.round(((run.lisMs || 0) + readMs) / 6000) / 10,
      L: res.L, R: res.R, total: { score: total.score, sd: total.sd, ci90: total.ci90, cefr: total.cefr, cefrProb: total.cefrProb },
      path: { L: run.path.L, R: run.path.R }, threshold: run.threshold,
      modules: { stage1: run.docs.stage1, L: stageDocId(run, 'L', 2), R: stageDocId(run, 'R', 2) },
      answers: Object.assign({}, run.answers), abilities: abil, pauses: run.pauses, replays: run.replays,
      trend: { L: { mean: tL.mean, sd: tL.sd }, R: { mean: tR.mean, sd: tR.sd }, T: { mean: tT.mean, sd: tT.sd } },
      prevTrendAt: lastTrendAt
    };
    t.history.push(entry);
    /* Modules d'étape 2 non servis : gardés pour le bilan suivant. */
    ['L', 'R'].forEach(function (s) {
      ['easy', 'hard'].forEach(function (m) { if (m !== run.path[s]) bankAdd(run.docs[s][m], m, run.center, [s]); });
    });
    rememberTopics([run.docs.stage1, entry.modules.L, entry.modules.R]);
    saveAnswersToDocs(run);
    /* Le modèle de l'apprenant est recalé par le bilan (observation à fort poids). */
    R.calibrate('listen', thetaOfScore('L', res.L.score), R.level('listen').n < 12 ? 0.7 : 0.5);
    R.calibrate('read', thetaOfScore('R', res.R.score), R.level('read').n < 12 ? 0.7 : 0.5);
    responsesOf(run, 'R', [1, 2], 0).forEach(function (r) { if (r.item.part === 5) R.observe('lang', r.item.cefr, r.correct ? 1 : 0, 0.4); });
    R.logSession({
      kind: 'toeic', ref: entry.id, title: 'Bilan express', startedAt: entry.startedAt, endedAt: endedAt,
      skillMinutes: { listen: Math.round((run.lisMs || 0) / 6000) / 10, read: Math.round(readMs / 6000) / 10 }, score: null
    });
    t.run = null;
    U.screen = 'result';
    U.resultId = entry.id;
    U.flash = '';
    R.save(true);
    R.render();
  }

  function runAbandon() {
    var t = TD(), run = t.run;
    if (!run) return;
    U.tok++;
    R.tts.stopAll();
    ['L', 'R'].forEach(function (s) {
      ['easy', 'hard'].forEach(function (m) { if (!run.path[s] || m !== run.path[s]) bankAdd(run.docs[s][m], m, run.center, [s]); });
    });
    if (!run.startedAt) {
      /* Jamais commencé : la préparation est rendue telle quelle. */
      t.prep = { id: R.uid('rztp'), center: run.center, startedAt: run.createdAt, jobs: {}, docs: { stage1: run.docs.stage1, easy: 'bank', hard: 'bank' }, errors: {}, slots: { L: {}, R: {} }, taken: [], readyAt: Date.now(), notified: true };
      ['easy', 'hard'].forEach(function (m) { ['L', 'R'].forEach(function (s) { t.prep.slots[s][m] = bankTake(m, run.center, s); }); });
      if (!prepComplete(t.prep)) t.prep = null;
    }
    t.run = null;
    U.screen = 'home';
    R.save(true);
    R.toast('Bilan express abandonné.');
    R.render();
  }

  /* ══ Bilan oral et écrit ════════════════════════════════════════════════ */

  function swPrepStart() {
    var t = TD();
    if (t.swPrep || t.swRun) return;
    var job = R.uid('rztsw');
    var withEssay = !!U.swEssay;
    t.swPrep = { job: job, level: genLevel(), withEssay: withEssay, startedAt: Date.now(), id: '', error: '', readyAt: 0 };
    R.gen('sw', { level: t.swPrep.level, withEssay: withEssay }, { job: job }).then(function (r) { swPrepDone(job, r); }, function (e) {
      var p = TD().swPrep;
      if (!p || p.job !== job) return;
      p.error = (e && e.message) || 'échec de la préparation';
      p.job = '';
      R.save();
      R.render();
    });
    R.save(true);
    R.render();
  }
  function swPrepDone(job, r) {
    var p = TD().swPrep;
    if (!r || !r.id || !r.doc) return;
    R.docPut('sw', r.id, r.doc);
    if (!p || p.job !== job || p.id) return;
    if (!arr(r.doc.speaking).length && !arr(r.doc.writing).length) { p.error = 'Le bilan reçu est vide.'; p.job = ''; R.save(); R.render(); return; }
    p.id = r.id;
    p.job = '';
    p.readyAt = Date.now();
    R.notify('Votre bilan oral et écrit est prêt : environ ' + (p.withEssay ? 55 : 25) + ' minutes, micro nécessaire.', 'tests');
    R.save();
    R.render();
  }
  function swPrepCancel() {
    var t = TD(), p = t.swPrep;
    if (!p) return;
    if (p.job) R.cancel(p.job);
    t.swPrep = null;
    R.save(true);
    R.render();
  }

  /* Les étapes : une par réponse orale, une page pour les phrases, une par e-mail ou essai. */
  function swSteps(d, withEssay) {
    var steps = [];
    arr(d && d.speaking).forEach(function (t) {
      var secs = arr(t.speakSeconds);
      var type = SW_TASKS[t.task] ? t.task : 'respond';
      if (type === 'respond' || type === 'respond_info') {
        var qs = arr(t.questions);
        if (type === 'respond_info') steps.push({ key: t.id + ':read', type: type, task: t, qi: -1, mode: 'speak', read: true, prep: num(t.prepSeconds, 45), rec: 0 });
        qs.forEach(function (q, i) {
          var say = (i === 0 ? String(t.prompt || '') + ' ' : '') + q;
          if (type === 'respond_info' && i === qs.length - 1) say = q + ' … ' + q;
          steps.push({ key: t.id + ':' + i, type: type, task: t, qi: i, mode: 'speak', say: say.trim(), prep: type === 'respond_info' ? 3 : Math.max(3, num(t.prepSeconds, 3)), rec: num(secs[i], i === qs.length - 1 ? 30 : 15) });
        });
      } else {
        steps.push({ key: t.id, type: type, task: t, qi: -1, mode: 'speak', say: type === 'opinion' ? String(t.prompt || '') : '', prep: num(t.prepSeconds, 45), rec: num(secs[0], type === 'opinion' ? 60 : (type === 'describe' ? 30 : 45)) });
      }
    });
    var writing = arr(d && d.writing);
    var sentences = writing.filter(function (w) { return w.task === 'sentence'; });
    if (sentences.length) steps.push({ key: 'wr-sentences', type: 'sentence', tasks: sentences, mode: 'write', minutes: Math.max(2, Math.round(sentences.length * 1.6)) });
    writing.forEach(function (w) {
      if (w.task === 'email') steps.push({ key: w.id, type: 'email', task: w, mode: 'write', minutes: num(w.minutes, 10) || 10 });
      if (w.task === 'essay' && withEssay) steps.push({ key: w.id, type: 'essay', task: w, mode: 'write', minutes: num(w.minutes, 30) || 30 });
    });
    return steps;
  }
  /* Les réponses notées une à une : clé de réponse → tâche, barème, consignes. */
  function swAnswerUnits(steps) {
    var out = [];
    steps.forEach(function (st) {
      if (st.read) return;
      if (st.type === 'sentence') st.tasks.forEach(function (w) { out.push({ key: w.id, type: 'sentence', task: w, mode: 'write', step: st }); });
      else out.push({ key: st.key, type: st.type, task: st.task, mode: st.mode, step: st, qi: st.qi });
    });
    return out;
  }

  function swStart() {
    var t = TD(), p = t.swPrep;
    if (!p || !p.id || t.swRun) return;
    t.swRun = { id: R.uid('rzts'), docId: p.id, withEssay: p.withEssay, level: p.level, createdAt: Date.now(), startedAt: 0, step: 0, phase: 'intro', sub: 'ready',
      deadline: 0, rest: 0, wms: 0, wfrom: 0, responses: {}, grades: {}, gradeJobs: {}, gradeErrors: {}, paused: false, done: false };
    t.swPrep = null;
    U.screen = 'sw';
    R.save(true);
    R.render();
  }

  function swDoc(sr) { return doc('sw', sr && sr.docId); }
  function swCur(sr) { var d = swDoc(sr); if (!d) return null; return swSteps(d, sr.withEssay)[sr.step] || null; }

  function swBegin() {
    var sr = TD().swRun;
    if (!sr) return;
    sr.startedAt = sr.startedAt || Date.now();
    sr.phase = 'task';
    swEnterStep();
  }

  function swEnterStep() {
    var sr = TD().swRun;
    var st = swCur(sr);
    if (!st) { swFinishTasks(); return; }
    sr.paused = false;
    var tok = ++U.tok;
    if (st.mode === 'write') {
      sr.sub = 'write';
      sr.wms = 0;
      sr.wfrom = now();
      U.focusWrite = true;
    } else if (st.read) {
      sr.sub = 'prep';
      sr.deadline = now() + st.prep * 1000;
    } else if (st.say) {
      sr.sub = 'say';
      var key = 'rzt-sw-say-' + st.key;
      R.ui.plays[key] = 1;
      var p = R.tts.say(st.say, { accent: 'en-US', gender: 'female', key: key });
      p.done.then(function () {
        if (tok !== U.tok) return;
        var s2 = TD().swRun;
        if (!s2 || s2.sub !== 'say' || swCur(s2) !== null && swCur(s2).key !== st.key) return;
        s2.sub = 'prep';
        s2.deadline = now() + st.prep * 1000;
        R.save();
        R.render();
      });
    } else {
      sr.sub = 'prep';
      sr.deadline = now() + st.prep * 1000;
    }
    R.recReset('rzt-sw-rec-' + st.key);
    R.save();
    R.render();
  }

  function swStartRec() {
    var sr = TD().swRun;
    var st = swCur(sr);
    if (!st) return;
    if (st.read) { swNext(); return; }
    sr.sub = 'rec';
    sr.deadline = 0;
    R.save();
    R.render();
    var key = 'rzt-sw-rec-' + st.key;
    if (document.querySelector('[data-rz-rec="' + key + '"]')) R.recToggle(key);
  }

  function swOnRec(st, r) {
    var sr = TD().swRun;
    if (!sr) return;
    var stt = r && r.stt;
    var url = (stt && stt.url) || '';
    if (!url && r && r.audio && r.audio.url) U.blobUrls[st.key] = r.audio.url;
    var uncertain = arr(stt && stt.words).filter(function (w) { return num(w.p, 1) < 0.5; }).map(function (w) { return w.text; }).slice(0, 12);
    sr.responses[st.key] = {
      text: String((stt && stt.text) || '').trim().slice(0, 4000), url: url, recId: (stt && stt.id) || '', at: Date.now(),
      metrics: { seconds: Math.round(num(r && r.audio && r.audio.seconds, 0) * 10) / 10, wpm: Math.round(num(stt && stt.wpm, 0)), pauses: arr(stt && stt.pauses).length, uncertain: uncertain,
        accuracy: stt && stt.alignment ? stt.alignment.accuracy : null }
    };
    gradeEnqueue(st.key);
    R.save();
    if (TD().swRun && swCur(TD().swRun) && swCur(TD().swRun).key === st.key) {
      sr.sub = 'saved';
      R.render();
      var tok = ++U.tok;
      setTimeout(function () { if (tok === U.tok) swNext(); }, 900);
    }
  }

  function swSkip() {
    var sr = TD().swRun;
    var st = swCur(sr);
    if (!st) return;
    U.tok++;
    R.tts.stopAll();
    var key = 'rzt-sw-rec-' + st.key;
    var rs = R.recState(key);
    if (rs.phase === 'recording' || rs.phase === 'starting') { var btn = document.querySelector('[data-act="rz-rec-cancel"][data-key="' + key + '"]'); if (btn) btn.click(); }
    if (!st.read && st.mode === 'speak' && !sr.responses[st.key]) { sr.responses[st.key] = { text: '', url: '', at: Date.now(), skipped: true, metrics: null }; gradeEnqueue(st.key); }
    swNext();
  }

  function swSubmitWrite(timeUp) {
    var sr = TD().swRun;
    var st = swCur(sr);
    if (!st || st.mode !== 'write') return;
    var keys = st.type === 'sentence' ? st.tasks.map(function (w) { return w.id; }) : [st.key];
    var secs = Math.round(swWriteElapsed(sr) / 1000);
    keys.forEach(function (k) {
      var r = sr.responses[k] = sr.responses[k] || { text: '' };
      r.at = Date.now();
      r.metrics = { seconds: st.type === 'sentence' ? Math.round(secs / keys.length) : secs, wpm: 0, pauses: 0, uncertain: [], words: R.text.count(r.text) };
      gradeEnqueue(k);
    });
    if (timeUp) R.toast('Temps écoulé : votre réponse est rendue telle quelle.');
    swNext();
  }
  function swWriteElapsed(sr) { return sr.wms + (sr.wfrom ? now() - sr.wfrom : 0); }

  function swNext() {
    var sr = TD().swRun;
    if (!sr) return;
    U.tok++;
    sr.step++;
    sr.sub = 'ready';
    sr.deadline = 0;
    R.save();
    if (!swCur(sr)) { swFinishTasks(); return; }
    swEnterStep();
  }

  function swPause() {
    var sr = TD().swRun;
    if (!sr || sr.paused) return;
    sr.paused = true;
    U.tok++;
    R.tts.stopAll();
    var st = swCur(sr);
    if (st) {
      var key = 'rzt-sw-rec-' + st.key;
      var rs = R.recState(key);
      if (rs.phase === 'recording' || rs.phase === 'starting') { var btn = document.querySelector('[data-act="rz-rec-cancel"][data-key="' + key + '"]'); if (btn) btn.click(); else R.recReset(key); }
      if (st.mode === 'write') { sr.wms = swWriteElapsed(sr); sr.wfrom = 0; }
      else if (sr.sub !== 'saved') { sr.sub = 'ready'; sr.deadline = 0; }
    }
    R.save();
  }
  function swResume() {
    var sr = TD().swRun;
    if (!sr || !sr.paused) return;
    sr.paused = false;
    var st = swCur(sr);
    if (!st) { swFinishTasks(); return; }
    if (st.mode === 'write') { sr.wfrom = now(); R.save(); R.render(); return; }
    swEnterStep();
  }

  function swFinishTasks() {
    var sr = TD().swRun;
    if (!sr) return;
    sr.phase = 'grading';
    sr.endedAt = sr.endedAt || Date.now();
    var d = swDoc(sr);
    swAnswerUnits(swSteps(d, sr.withEssay)).forEach(function (u) {
      if (!sr.responses[u.key]) sr.responses[u.key] = { text: '', url: '', at: Date.now(), skipped: true, metrics: null };
      gradeEnqueue(u.key);
    });
    R.save(true);
    R.render();
    swMaybeFinalize();
  }

  /* ── Corrections : en parallèle pendant que l'apprenant continue, trois au plus ── */
  var GQ = [], GRUN = 0;
  function unitOf(sr, key) {
    var d = swDoc(sr);
    var units = swAnswerUnits(swSteps(d, sr.withEssay));
    for (var i = 0; i < units.length; i++) if (units[i].key === key) return units[i];
    return null;
  }
  function gradeEnqueue(key) {
    var sr = TD().swRun;
    if (!sr || sr.grades[key] || GQ.indexOf(key) >= 0 || (sr.gradeJobs[key] && R.jobById(sr.gradeJobs[key]))) return;
    delete sr.gradeErrors[key];
    GQ.push(key);
    gradePump();
  }
  function gradePump() {
    while (GRUN < 3 && GQ.length) {
      var key = GQ.shift();
      GRUN++;
      runGrade(key).then(gradeFin, gradeFin);
    }
  }
  function gradeFin() { GRUN = Math.max(0, GRUN - 1); gradePump(); swMaybeFinalize(); }

  function scaleOf(u) { var s = num(u.task && u.task.scale, 0); return s || (u.type === 'opinion' || u.type === 'essay' ? 5 : (u.type === 'email' ? 4 : 3)); }

  function gradeParams(sr, u) {
    var resp = sr.responses[u.key] || {};
    var t = u.task || {};
    var prompt = String(t.prompt || '');
    if (u.type === 'read_aloud') prompt += '\nText to read: ' + String(t.text || '');
    if (u.type === 'describe') prompt += '\nScene (given in French): ' + String(t.text || '');
    if (u.type === 'respond' || u.type === 'respond_info') prompt += '\nQuestion: ' + String(arr(t.questions)[u.qi] || '');
    if (u.type === 'respond_info' && t.info) prompt += '\nDocument: ' + String(t.info.title || '') + '\n' + arr(t.info.rows).map(function (r) { return arr(r).join(' | '); }).join('\n');
    if (u.type === 'sentence') prompt += '\nSituation: ' + String(t.situation || '') + '\nWords to use: ' + arr(t.words).join(', ');
    if (u.type === 'email' && t.email) prompt += '\nE-mail received — from: ' + String(t.email.from || '') + ' — subject: ' + String(t.email.subject || '') + '\n' + String(t.email.body || '');
    var words = u.type === 'essay' ? [300, 600] : (u.type === 'email' ? [60, 200] : (u.type === 'sentence' ? [6, 40] : [0, 0]));
    var m = resp.metrics || null;
    return {
      mode: u.mode, rubric: 'sw',
      task: { id: u.key, kind: u.type, promptFr: String(t.promptFr || ''), prompt: prompt.slice(0, 3000), criteria: (SW_TASKS[u.type] || SW_TASKS.respond).criteria, scale: scaleOf(u), words: words, seconds: u.step && u.step.rec ? u.step.rec : (u.step && u.step.minutes ? u.step.minutes * 60 : 0) },
      response: String(resp.text || ''),
      metrics: m ? { seconds: num(m.seconds, 0), wpm: num(m.wpm, 0), pauses: num(m.pauses, 0), uncertain: arr(m.uncertain) } : null,
      level: R.level(u.mode === 'speak' ? 'speak' : 'write').band,
      targets: R.weakPoints(5).map(function (w) { return w.category; })
    };
  }

  function runGrade(key) {
    var sr = TD().swRun;
    if (!sr) return Promise.resolve();
    var u = unitOf(sr, key);
    if (!u) return Promise.resolve();
    var resp = sr.responses[key] || {};
    if (!String(resp.text || '').trim()) {
      setGrade(sr, key, { scores: { task: 0, coherence: 0, range: 0, accuracy: 0, fluency: 0 }, swScore: 0, corrected: '', edits: [], strengthsFr: [], priorityFr: '', feedbackFr: resp.skipped ? 'Pas de réponse : la tâche compte 0.' : 'Réponse vide ou inaudible : la tâche compte 0.', redo: '', usefulPhrases: [], cards: [], levelEstimate: '', empty: true });
      return Promise.resolve();
    }
    var job = R.uid('rztg');
    sr.gradeJobs[key] = job;
    R.save();
    return R.gen('grade', gradeParams(sr, u), { job: job }).then(function (r) {
      var s2 = TD().swRun;
      if (!s2 || s2.id !== sr.id) return;
      setGrade(s2, key, r && r.doc);
    }, function (e) {
      var s2 = TD().swRun;
      if (!s2 || s2.id !== sr.id) return;
      s2.gradeErrors[key] = (e && e.message) || 'correction impossible';
      R.save();
      R.renderSoon();
    });
  }

  function setGrade(sr, key, g) {
    if (!g || sr.grades[key]) return;
    var u = unitOf(sr, key);
    var scale = u ? scaleOf(u) : 3;
    var s = num(g.swScore, NaN);
    /* Hors WebView2, la correction simulée du noyau ne note pas sur le barème : on le déduit des critères. */
    if ((!isFinite(s) || (window.bridge && bridge.isShim && !s)) && g.scores) {
      var sc = g.scores, vals = ['task', 'coherence', 'range', 'accuracy'].map(function (k) { return num(sc[k], 0); });
      s = Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length / 5 * scale);
      if (g.empty) s = 0;
    }
    s = Math.max(0, Math.min(scale, isFinite(s) ? s : 0));
    U.swGrades[sr.id + ':' + key] = g;
    sr.grades[key] = { s: s, scale: scale, lv: String(g.levelEstimate || '') };
    delete sr.gradeErrors[key];
    var d = swDoc(sr);
    if (d) {
      d.responses = d.responses || {}; d.grades = d.grades || {};
      d.responses[key] = sr.responses[key];
      d.grades[key] = g;
      d.run = sr.id;
      swDocSaveSoon(sr.docId);
    }
    R.save();
    R.renderSoon();
  }
  var swSaveTimer = null;
  function swDocSaveSoon(id) {
    if (swSaveTimer) clearTimeout(swSaveTimer);
    swSaveTimer = setTimeout(function () {
      swSaveTimer = null;
      var d = doc('sw', id);
      if (d) R.docSave('sw', id, d)['catch'](function () { /* retenté au prochain enregistrement */ });
    }, 600);
  }

  function swMaybeFinalize() {
    var sr = TD().swRun;
    if (!sr || sr.phase !== 'grading' || sr.done) return;
    var units = swAnswerUnits(swSteps(swDoc(sr), sr.withEssay));
    if (!units.every(function (u) { return sr.grades[u.key]; })) { R.renderSoon(); return; }
    swFinalize();
  }

  function swFinalize() {
    var t = TD(), sr = t.swRun;
    if (!sr || sr.done) return;
    sr.done = true;
    var d = swDoc(sr);
    var units = swAnswerUnits(swSteps(d, sr.withEssay));
    var sp = [], wr = [], tasks = {};
    units.forEach(function (u) {
      var g = sr.grades[u.key];
      var row = { type: SW_ESTIMATE_TYPE[u.type] || u.type, score: g.s };
      (u.mode === 'speak' ? sp : wr).push(row);
      tasks[u.key] = { type: u.type, s: g.s, scale: g.scale, lv: g.lv, mode: u.mode };
    });
    var endedAt = Date.now();
    var entry = { id: sr.id, at: endedAt, kind: 'sw', startedAt: sr.startedAt || sr.createdAt, docId: sr.docId, withEssay: sr.withEssay, level: sr.level, tasks: tasks };
    var days = function (st) { return st && st.at ? (endedAt - st.at) / 86400000 : 0; };
    if (sp.length) {
      var S = estimateProductive('speaking', sp);
      entry.S = { score: S.score, range: S.range, cefr: S.cefr, composite: S.composite };
      var kS = kalman(t.S, { score: S.score, sd: 20 }, days(t.S), 1.5);
      t.S = { mean: kS.mean, sd: kS.sd, at: endedAt };
      R.calibrate('speak', thetaOfScore('S', S.score), R.level('speak').n < 3 ? 0.7 : 0.5);
    }
    if (wr.length) {
      var W = estimateProductive('writing', wr);
      entry.W = { score: W.score, range: W.range, cefr: W.cefr, composite: W.composite, capped: W.capped };
      var kW = kalman(t.W, { score: W.score, sd: W.capped || !sr.withEssay ? 30 : 20 }, days(t.W), 1.5);
      t.W = { mean: kW.mean, sd: kW.sd, at: endedAt };
      R.calibrate('write', thetaOfScore('W', W.score), R.level('write').n < 3 ? 0.7 : 0.5);
    }
    entry.trend = { S: t.S ? { mean: t.S.mean, sd: t.S.sd } : null, W: t.W ? { mean: t.W.mean, sd: t.W.sd } : null };
    /* Erreurs au journal, cartes, tentatives (une fois par réponse). */
    var cards = [];
    var spMin = 0, wrMin = 0;
    units.forEach(function (u) {
      var g = U.swGrades[sr.id + ':' + u.key] || (d && d.grades && d.grades[u.key]);
      var resp = sr.responses[u.key] || {};
      if (u.mode === 'speak') spMin += num(u.step && u.step.rec, 30) / 60 + num(u.step && u.step.prep, 0) / 60;
      if (!g || g.empty) return;
      R.addErrors(g.edits, { mode: u.mode, ref: sr.docId });
      arr(g.cards).forEach(function (c) { cards.push(c); });
      if (R.cards && typeof R.cards.fromEdits === 'function') { try { arr(R.cards.fromEdits(g.edits, 1)).forEach(function (c) { cards.push(c); }); } catch (e) { /* module des cartes différent */ } }
      R.data.attempts.push({ id: R.uid('att'), at: resp.at || endedAt, mode: u.mode, ref: 'sw:' + sr.docId, task: (SW_TASKS[u.type] || {}).label || u.type, response: String(resp.text || '').slice(0, 2000),
        url: resp.url || '', metrics: resp.metrics || null, grade: { swScore: sr.grades[u.key].s, scale: sr.grades[u.key].scale, levelEstimate: g.levelEstimate || '', scores: g.scores || null } });
    });
    var wSecs = 0;
    units.forEach(function (u) { if (u.mode === 'write') { var r = sr.responses[u.key]; wSecs += num(r && r.metrics && r.metrics.seconds, 0); } });
    wrMin = wSecs / 60;
    if (cards.length && R.cards && typeof R.cards.addMany === 'function') {
      try { entry.cards = R.cards.addMany(cards.slice(0, 24), { kind: 'test', ref: sr.docId }); } catch (e) { /* module des cartes absent ou différent */ }
    }
    t.history.push(entry);
    R.logSession({ kind: 'sw', ref: entry.id, title: 'Bilan oral et écrit', startedAt: entry.startedAt, endedAt: sr.endedAt || endedAt, skillMinutes: { speak: Math.round(spMin * 10) / 10, write: Math.round(wrMin * 10) / 10 }, score: null });
    if (d) { d.run = sr.id; d.result = { S: entry.S || null, W: entry.W || null }; R.docSave('sw', sr.docId, d)['catch'](function () { /* gardé en mémoire */ }); }
    t.swRun = null;
    U.screen = 'result';
    U.resultId = entry.id;
    R.save(true);
    R.notify('Votre bilan oral et écrit est corrigé' + (entry.S ? ' : oral ≈ ' + entry.S.score : '') + (entry.W ? (entry.S ? ', ' : ' : ') + 'écrit ≈ ' + (entry.W.capped ? '150 ou plus' : entry.W.score) : '') + ' sur 200.', 'tests');
    R.render();
  }

  function swAbandon() {
    var t = TD();
    if (!t.swRun) return;
    U.tok++;
    R.tts.stopAll();
    t.swRun = null;
    U.screen = 'home';
    R.save(true);
    R.toast('Bilan oral et écrit abandonné.');
    R.render();
  }

  /* ══ Calibration par des scores officiels ═══════════════════════════════ */

  function appEstimateAt(s, at) {
    var h = TD().history.filter(function (e) { return e.kind === 'express' && e[s] && e.at <= at + 7 * 86400000 && e.at >= at - 75 * 86400000; });
    if (!h.length) return null;
    var e = h[h.length - 1];
    return e[s].raw != null ? e[s].raw : e[s].score;
  }

  function calSave() {
    var t = TD(), c = U.cal;
    var at = c.date ? new Date(c.date + 'T12:00:00').getTime() : Date.now();
    if (!isFinite(at)) at = Date.now();
    var any = false, bad = '';
    ['L', 'R'].forEach(function (s) {
      var v = String(c[s] || '').trim();
      if (!v) return;
      var n = Math.round(Number(v));
      if (!isFinite(n) || n < 5 || n > 495) { bad = 'Un score de section va de 5 à 495.'; return; }
      n = Math.round(n / 5) * 5;
      t.calib[s].push({ official: n, app: appEstimateAt(s, at), at: at });
      t.calib[s].sort(function (a, b) { return a.at - b.at; });
      /* Un score officiel récent est une mesure précise (± 25) : la tendance et le niveau s'y recalent. */
      var st = t[s];
      if (!st || at >= num(st.at, 0) - 86400000) {
        var k = kalman(st, { score: n, sd: 25 }, st ? Math.max(0, (at - num(st.at, at)) / 86400000) : 0);
        t[s] = { mean: k.mean, sd: k.sd, at: Math.max(at, st ? num(st.at, 0) : 0) };
      }
      R.calibrate(s === 'L' ? 'listen' : 'read', thetaOfScore(s, n), 0.7);
      any = true;
    });
    if (bad) { U.calError = bad; R.render(); return; }
    if (!any) { U.calError = 'Saisissez au moins un des deux scores.'; R.render(); return; }
    if (t.L && t.R) {
      var kT = kalman(t.T, { score: t.L.mean + t.R.mean, sd: 35 }, t.T ? Math.max(0, (Date.now() - num(t.T.at, Date.now())) / 86400000) : 0);
      t.T = { mean: kT.mean, sd: kT.sd, at: Date.now() };
    }
    U.cal = { date: '', L: '', R: '' };
    U.calOpen = false;
    U.calError = '';
    R.save(true);
    R.toast('Score officiel enregistré : les prochains bilans en tiennent compte.');
    R.render();
  }

  /* ══ Rendu : fragments ══════════════════════════════════════════════════ */

  function mentionHtml() { return '<p class="rzt-mention">' + esc(MENTION) + '</p>'; }
  function btn(act, label, cls, attrs) {
    return '<button type="button" class="btn ' + (cls || 'btn-secondary') + '" data-act="' + esc(act) + '"' + (attrs || '') + '>' + label + '</button>';
  }
  function scoreRange(ci) { return arr(ci).length === 2 ? '[' + ci[0] + '–' + ci[1] + ']' : ''; }

  function graphicHtml(g) {
    if (!g || (!arr(g.rows).length && !arr(g.columns).length)) return '';
    var cols = arr(g.columns);
    var h = '<figure class="rzt-graphic"><figcaption>' + esc(g.title || 'Graphic') + '</figcaption><div class="rzt-gwrap"><table class="rzt-gtable">';
    if (cols.length) h += '<thead><tr>' + cols.map(function (c) { return '<th scope="col">' + esc(c) + '</th>'; }).join('') + '</tr></thead>';
    h += '<tbody>' + arr(g.rows).map(function (r) {
      return '<tr>' + arr(r).map(function (c, i) { return i === 0 ? '<th scope="row">' + esc(c) + '</th>' : '<td' + (/^[\d\s.,%£$€:–-]+$/.test(String(c)) ? ' class="is-num"' : '') + '>' + esc(c) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div></figure>';
    return h;
  }

  /* Paragraphe d'un document : trous [1]… (Partie 6) ou positions [1]… (Partie 7). */
  function paraHtml(p, ctx) {
    var h = esc(p);
    return h.replace(/\[(\d)\]/g, function (m0, n) {
      if (ctx && ctx.blanks) {
        var b = ctx.blanks[+n - 1];
        var cur = ctx.current === +n - 1;
        var fill = b && b.text ? '<span class="rzt-blank-fill">' + esc(b.text) + '</span>' : '<span class="rzt-blank-line"></span>';
        return '<span class="rzt-blank' + (cur ? ' is-current' : '') + (b && b.cls ? ' ' + b.cls : '') + '"><span class="rzt-blank-n">' + n + '</span>' + fill + '</span>';
      }
      return '<span class="rzt-pos">[' + n + ']</span>';
    });
  }

  function metaPairs(meta) {
    return arr(meta).map(function (m) {
      var mm = /^\s*([A-Za-z][A-Za-z .'-]{0,18}):\s*(.+)$/.exec(String(m));
      return mm ? { k: mm[1], v: mm[2] } : { k: '', v: String(m) };
    });
  }

  function chatLines(paras) {
    return arr(paras).map(function (p) {
      var s = String(p), m;
      if ((m = /^(.{1,40}?)\s*[[(](\d{1,2}[:.]\d{2}\s*(?:[AaPp]\.?\s?[Mm]\.?)?)[\])]\s*[:—–-]?\s*(.+)$/.exec(s))) return { who: m[1], time: m[2], text: m[3] };
      if ((m = /^[[(](\d{1,2}[:.]\d{2}\s*(?:[AaPp]\.?\s?[Mm]\.?)?)[\])]\s*(.{1,40}?):\s*(.+)$/.exec(s))) return { who: m[2], time: m[1], text: m[3] };
      if ((m = /^(.{1,40}?):\s*(.+)$/.exec(s))) return { who: m[1], time: '', text: m[2] };
      return { who: '', time: '', text: s };
    });
  }

  function documentHtml(d, ctx, n, total) {
    var kind = String(d.kind || 'text');
    var paras = arr(d.paragraphs);
    var body = function (cls) { return '<div class="rzt-doc-body' + (cls ? ' ' + cls : '') + '">' + paras.map(function (p) { return '<p>' + paraHtml(p, ctx) + '</p>'; }).join('') + '</div>'; };
    var label = total > 1 ? '<div class="rzt-doc-n">Document ' + n + ' sur ' + total + '</div>' : '';
    var h = '<article class="rzt-doc rzt-doc-' + esc(kind) + '" lang="en">' + label;
    var meta = metaPairs(d.meta);
    if (kind === 'email' || kind === 'memo') {
      var subj = meta.filter(function (m) { return /^(subject|re)$/i.test(m.k); })[0];
      h += '<div class="rzt-doc-bar">' + (kind === 'memo' ? '<span class="rzt-doc-badge">MEMO</span>' : '<span class="rzt-doc-badge">E-mail</span>') + '</div>';
      h += '<dl class="rzt-mail-head">' + meta.filter(function (m) { return m !== subj; }).map(function (m) { return m.k ? '<dt>' + esc(m.k) + '</dt><dd>' + esc(m.v) + '</dd>' : '<dd class="is-wide">' + esc(m.v) + '</dd>'; }).join('')
        + ((subj || d.title) ? '<dt>' + esc(subj ? subj.k : 'Subject') + '</dt><dd class="rzt-mail-subj">' + esc(subj ? subj.v : d.title) + '</dd>' : '') + '</dl>';
      h += body('rzt-mail-body');
    } else if (kind === 'chat') {
      var whoList = [];
      h += '<div class="rzt-doc-bar"><span class="rzt-doc-badge">' + esc(d.title || 'Messages') + '</span></div><div class="rzt-chat">';
      chatLines(paras).forEach(function (l) {
        if (l.who && whoList.indexOf(l.who) < 0) whoList.push(l.who);
        var side = whoList.indexOf(l.who) % 2 === 1 ? ' is-right' : '';
        h += '<div class="rzt-msg' + side + '"><div class="rzt-msg-head">' + (l.who ? '<b>' + esc(l.who) + '</b>' : '') + (l.time ? '<span>' + esc(l.time) + '</span>' : '') + '</div><div class="rzt-msg-text">' + paraHtml(l.text, ctx) + '</div></div>';
      });
      h += '</div>';
    } else if (kind === 'text') {
      h += '<div class="rzt-doc-bar"><span class="rzt-doc-badge">' + esc(d.title || 'Text message') + '</span></div>';
      if (meta.length) h += '<div class="rzt-sms-meta">' + meta.map(function (m) { return esc((m.k ? m.k + ': ' : '') + m.v); }).join(' · ') + '</div>';
      h += '<div class="rzt-sms">' + paras.map(function (p) { return '<p>' + paraHtml(p, ctx) + '</p>'; }).join('') + '</div>';
    } else if (kind === 'webpage') {
      h += '<div class="rzt-web-bar"><span class="rzt-web-dots"><i></i><i></i><i></i></span><span class="rzt-web-url">' + esc(meta.length ? meta[0].v : 'www.example.com') + '</span></div>';
      if (d.title) h += '<h4 class="rzt-doc-title">' + esc(d.title) + '</h4>';
      h += body('rzt-web-body');
    } else if (kind === 'article') {
      if (meta.length) h += '<div class="rzt-art-meta">' + meta.map(function (m) { return esc((m.k ? m.k + ': ' : '') + m.v); }).join(' · ') + '</div>';
      if (d.title) h += '<h4 class="rzt-art-title">' + esc(d.title) + '</h4>';
      h += body('rzt-art-body');
    } else if (kind === 'schedule' || kind === 'form') {
      if (d.title) h += '<h4 class="rzt-doc-title">' + esc(d.title) + '</h4>';
      if (meta.length) h += '<div class="rzt-art-meta">' + meta.map(function (m) { return esc((m.k ? m.k + ': ' : '') + m.v); }).join(' · ') + '</div>';
      h += '<table class="rzt-sched"><tbody>' + paras.map(function (p) {
        var m = /^\s*([^–—:|]{1,28}?)\s*(?:[–—|]|:\s|\s-\s)\s*(.+)$/.exec(String(p));
        return m ? '<tr><th scope="row">' + paraHtml(m[1], ctx) + '</th><td>' + paraHtml(m[2], ctx) + '</td></tr>' : '<tr><td colspan="2">' + paraHtml(p, ctx) + '</td></tr>';
      }).join('') + '</tbody></table>';
    } else if (kind === 'notice' || kind === 'ad') {
      if (meta.length) h += '<div class="rzt-notice-meta">' + meta.map(function (m) { return esc((m.k ? m.k + ': ' : '') + m.v); }).join(' · ') + '</div>';
      if (d.title) h += '<h4 class="rzt-notice-title">' + esc(d.title) + '</h4>';
      h += body('rzt-notice-body');
    } else {
      if (meta.length) h += '<div class="rzt-letter-meta">' + meta.map(function (m) { return '<div>' + esc((m.k ? m.k + ': ' : '') + m.v) + '</div>'; }).join('') + '</div>';
      if (d.title) h += '<h4 class="rzt-doc-title">' + esc(d.title) + '</h4>';
      h += body('');
    }
    return h + '</article>';
  }

  function documentsHtml(set, ctx) {
    var docs = arr(set.documents);
    return docs.map(function (d, i) { return documentHtml(d, i === 0 ? ctx : null, i + 1, docs.length); }).join('') + graphicHtml(set.graphic);
  }

  /* ══ Rendu : écran d'accueil des bilans ═════════════════════════════════ */

  function jobLineOrWait(job, label) {
    var j = job ? R.jobById(job) : null;
    return j ? R.h.jobLine(j) : '<div class="rz-job"><span class="rz-spin"></span><span class="rz-job-text">' + esc(label || 'Démarrage…') + '</span></div>';
  }

  function expressCardHtml() {
    var t = TD(), prep = t.prep, run = t.run;
    var h = ['<section class="rz-card rzt-kind rzt-kind-express">'];
    h.push('<div class="rzt-kind-head"><span class="rzt-kind-icon">' + R.icon('ear') + R.icon('read') + '</span><div><div class="rz-card-title">Bilan express</div>'
      + '<div class="rz-card-meta">Écoute + lecture · 43 questions · ≈ 27 min</div></div></div>');
    if (run) {
      var where = run.phase === 'intro' ? 'prêt à commencer' : (run.phase === 'listen' ? 'écoute, étape ' + run.lis.stage + ' sur 2' : (run.phase === 'pause' ? 'écoute terminée, lecture à faire' : 'lecture, étape ' + run.read.stage + ' sur 2, ' + clock(readRemaining(run)) + ' restantes'));
      h.push('<div class="rz-callout is-accent rzt-state">' + R.icon('clock') + ' Bilan en cours — ' + esc(where) + '.</div>');
      h.push('<div class="rzt-actions">' + btn('rz-test-open', (run.startedAt ? 'Reprendre le bilan ' : 'Commencer le bilan ') + R.icon('arrow'), 'btn-primary rz-big')
        + btn('rz-test-abandon', esc(U.arm.abandon ? 'Confirmer l’abandon' : 'Abandonner'), 'btn-ghost rz-danger') + '</div>');
    } else if (prep && prep.readyAt) {
      h.push('<div class="rzt-ready">' + R.icon('check') + '<span>Votre bilan est prêt · niveau visé ' + esc(prep.center) + ' · préparé ' + esc(R.fmtDate(prep.readyAt)) + '</span></div>');
      h.push('<div class="rzt-actions">' + btn('rz-test-start', 'Commencer le bilan ' + R.icon('arrow'), 'btn-primary rz-big') + btn('rz-test-prep-cancel', 'Annuler la préparation', 'btn-ghost') + '</div>');
      h.push('<div class="rz-card-foot">Prévoyez 27 minutes au calme, avec un casque ou des écouteurs.</div>');
    } else if (prep) {
      var labels = { stage1: 'Étape 1 · commune', easy: 'Étape 2 · module facile', hard: 'Étape 2 · module difficile' };
      var done = 0;
      h.push('<div class="rzt-prep">');
      ['stage1', 'easy', 'hard'].forEach(function (m) {
        var st = prepModuleState(prep, m);
        if (st === 'done' || st === 'bank') done++;
        var line;
        if (st === 'done') line = '<span class="rzt-prep-ok">' + R.icon('check') + ' Prêt</span>';
        else if (st === 'bank') line = '<span class="rzt-prep-ok">' + R.icon('check') + ' Repris d’un bilan précédent (jamais vu)</span>';
        else if (st === 'error') line = '<span class="rz-err-line">' + esc(prep.errors[m]) + '</span> ' + btn('rz-test-prep-retry', 'Réessayer', 'btn-secondary rzt-sm', ' data-module="' + m + '"');
        else if (st === 'lost') line = '<span class="rz-err-line">Préparation interrompue.</span> ' + btn('rz-test-prep-retry', 'Relancer', 'btn-secondary rzt-sm', ' data-module="' + m + '"');
        else line = jobLineOrWait(prep.jobs[m], 'Rédaction des questions…');
        h.push('<div class="rzt-prep-row"><span class="rzt-prep-k">' + esc(labels[m]) + '</span><span class="rzt-prep-v">' + line + '</span></div>');
      });
      h.push('</div>');
      h.push(R.h.progress(done / 3, 'Préparation du bilan'));
      h.push('<div class="rz-card-foot">Environ deux minutes. Vous pouvez faire autre chose : Révizator vous prévient quand c’est prêt.</div>');
      h.push('<div class="rzt-actions">' + btn('rz-test-prep-cancel', 'Annuler la préparation', 'btn-ghost') + '</div>');
    } else {
      h.push('<ul class="rzt-bullets"><li><b>Écoute</b> · 23 questions rythmées par l’audio : questions-réponses, conversations, exposés.</li>'
        + '<li><b>Lecture</b> · 20 questions en 16 minutes : phrases, texte à compléter, e-mails et messages.</li>'
        + '<li>En deux étapes : la seconde s’adapte à vos réponses, comme la version adaptative officielle.</li>'
        + '<li>Résultat : score estimé sur 990 avec sa marge, niveau CECRL, points forts et points faibles, correction détaillée.</li></ul>');
      var reuse = bankReady(centerLevel());
      h.push('<div class="rz-card-foot">La préparation prend environ deux minutes (trois modules rédigés en parallèle)' + (reuse.length ? ' ; ' + (reuse.length === 2 ? 'les deux modules d’étape 2 sont déjà prêts' : 'un module d’étape 2 déjà prêt sera repris') : '') + '.</div>');
      h.push('<div class="rzt-actions">' + btn('rz-test-prep', 'Préparer le bilan ' + R.icon('arrow'), 'btn-primary rz-big') + '</div>');
    }
    h.push('</section>');
    return h.join('');
  }

  function swCardHtml() {
    var t = TD(), p = t.swPrep, sr = t.swRun;
    var h = ['<section class="rz-card rzt-kind rzt-kind-sw">'];
    h.push('<div class="rzt-kind-head"><span class="rzt-kind-icon">' + R.icon('speak') + R.icon('pen') + '</span><div><div class="rz-card-title">Bilan oral et écrit</div>'
      + '<div class="rz-card-meta">5 tâches orales + 4 écrites · ≈ 25 min · micro</div></div></div>');
    if (sr) {
      var units = swAnswerUnits(swSteps(swDoc(sr) || {}, sr.withEssay));
      var graded = units.filter(function (u) { return sr.grades[u.key]; }).length;
      var txt = sr.phase === 'grading' ? 'correction en cours (' + graded + ' sur ' + units.length + ')' : (sr.startedAt ? 'tâche ' + (sr.step + 1) + ' en cours' : 'prêt à commencer');
      h.push('<div class="rz-callout is-accent rzt-state">' + R.icon('clock') + ' Bilan en cours — ' + esc(txt) + '.</div>');
      h.push('<div class="rzt-actions">' + btn('rz-test-sw-open', (sr.startedAt ? 'Reprendre ' : 'Commencer ') + R.icon('arrow'), 'btn-primary rz-big')
        + btn('rz-test-sw-abandon', esc(U.arm.swAbandon ? 'Confirmer l’abandon' : 'Abandonner'), 'btn-ghost rz-danger') + '</div>');
    } else if (p && p.id) {
      h.push('<div class="rzt-ready">' + R.icon('check') + '<span>Prêt · niveau ' + esc(p.level) + (p.withEssay ? ' · avec essai' : '') + '</span></div>');
      h.push('<div class="rzt-actions">' + btn('rz-test-sw-start', 'Commencer ' + R.icon('arrow'), 'btn-primary rz-big') + btn('rz-test-sw-cancel', 'Annuler', 'btn-ghost') + '</div>');
    } else if (p) {
      if (p.error) h.push('<div class="rz-err-line">' + esc(p.error) + '</div><div class="rzt-actions">' + btn('rz-test-sw-retry', 'Réessayer', 'btn-secondary') + btn('rz-test-sw-cancel', 'Annuler', 'btn-ghost') + '</div>');
      else if (p.job && !R.jobById(p.job) && U.reattachDone) h.push('<div class="rz-err-line">Préparation interrompue.</div><div class="rzt-actions">' + btn('rz-test-sw-retry', 'Relancer', 'btn-secondary') + btn('rz-test-sw-cancel', 'Annuler', 'btn-ghost') + '</div>');
      else h.push(jobLineOrWait(p.job, 'Rédaction des tâches…') + '<div class="rz-card-foot">Une à deux minutes ; Révizator vous prévient.</div><div class="rzt-actions">' + btn('rz-test-sw-cancel', 'Annuler', 'btn-ghost') + '</div>');
    } else {
      h.push('<ul class="rzt-bullets"><li><b>Oral</b> · lire à voix haute, décrire une scène, répondre à des questions, donner son avis — avec temps de préparation et de parole.</li>'
        + '<li><b>Écrit</b> · trois phrases avec des mots imposés et une réponse à un e-mail.</li>'
        + '<li>Chaque réponse est corrigée en détail ; estimation 0-200 pour l’oral et pour l’écrit.</li></ul>');
      h.push('<div class="rz-card-foot">Une à deux minutes de préparation, puis environ 25 minutes (55 avec l’essai). Prévoyez un endroit où parler à voix haute.</div>');
      h.push('<div class="rzt-actions">' + btn('rz-test-sw-prep', 'Préparer le bilan ' + R.icon('arrow'), 'btn-primary rz-big')
        + '<label class="rzt-check"><input type="checkbox" data-role="rz-test-sw-essay"' + (U.swEssay ? ' checked' : '') + '> Avec un essai (+ 30 min)</label></div>');
    }
    h.push('</section>');
    return h.join('');
  }

  function rangeBarHtml(section, est, max) {
    max = max || CFG.max[section];
    var pct = function (v) { return Math.max(0, Math.min(100, v / max * 100)).toFixed(2); };
    var cuts = CFG.cefrCuts[section];
    var ticks = ['A2', 'B1', 'B2', 'C1'].map(function (l) { return '<i class="rzt-rb-cut" style="left:' + pct(cuts[l]) + '%"><span>' + l + '</span></i>'; }).join('');
    var ci = arr(est.ci90).length === 2 ? est.ci90 : arr(est.range);
    return '<div class="rzt-rb" aria-hidden="true"><div class="rzt-rb-track">' + ticks
      + (ci.length === 2 ? '<span class="rzt-rb-ci" style="left:' + pct(ci[0]) + '%;width:' + (pct(ci[1]) - pct(ci[0])).toFixed(2) + '%"></span>' : '')
      + '<span class="rzt-rb-dot" style="left:' + pct(est.score) + '%"></span></div></div>';
  }

  function lastResultCardHtml() {
    var e = lastOf('express'), s = lastOf('sw'), t = TD();
    if (!e && !s) return '';
    var h = ['<section class="rz-card rzt-last"><div class="rz-card-head"><span class="rz-card-title">Vos derniers résultats</span>' + btn('rz-test-progress', R.icon('chart') + ' Progrès', 'btn-ghost') + '</div>'];
    if (e) {
      h.push('<div class="rzt-last-row"><div class="rzt-last-k">Bilan express · ' + esc(frShort(e.at)) + '</div><div class="rzt-last-v"><b class="rzt-big-num">' + e.total.score + '</b><span class="rz-muted"> / 990 ' + esc(scoreRange(e.total.ci90)) + '</span></div>'
        + '<div class="rzt-last-sub">Écoute ' + e.L.score + ' · Lecture ' + e.R.score + ' · ' + R.h.level(e.total.cefr) + '</div>'
        + (t.T && t.history.filter(function (x) { return x.kind === 'express'; }).length > 1 ? '<div class="rzt-last-sub">Tendance de vos bilans : ≈ ' + t.T.mean + ' ± ' + Math.round(1.645 * t.T.sd) + '</div>' : '')
        + btn('rz-test-result', 'Voir les résultats', 'btn-secondary rzt-sm', ' data-id="' + esc(e.id) + '"') + '</div>');
    }
    if (s) {
      h.push('<div class="rzt-last-row"><div class="rzt-last-k">Bilan oral et écrit · ' + esc(frShort(s.at)) + '</div><div class="rzt-last-v">'
        + (s.S ? '<span>Oral <b class="rzt-mid-num">' + s.S.score + '</b><span class="rz-muted"> / 200</span></span> ' : '')
        + (s.W ? '<span>Écrit <b class="rzt-mid-num">' + (s.W.capped ? '≥ 150' : s.W.score) + '</b><span class="rz-muted"> / 200</span></span>' : '') + '</div>'
        + btn('rz-test-result', 'Voir les résultats', 'btn-secondary rzt-sm', ' data-id="' + esc(s.id) + '"') + '</div>');
    }
    var nextE = e ? Math.ceil((e.at + NEXT_EXPRESS_DAYS * 86400000 - Date.now()) / 86400000) : 0;
    h.push('<div class="rz-card-foot">' + esc(e ? (nextE > 0 ? 'Prochain bilan express conseillé dans ' + nextLabel(nextE) + '.' : 'Un nouveau bilan express est conseillé : le dernier date de plus de trois semaines.') : '') + ' Un écart de moins de 130 points par section d’un bilan à l’autre reste dans la marge d’erreur : c’est la tendance qui compte.</div>');
    h.push(mentionHtml() + '</section>');
    return h.join('');
  }
  function nextLabel(days) { return days >= 14 ? Math.round(days / 7) + ' semaines' : (days >= 7 ? '1 semaine' : plural(days, 'jour')); }

  function calibCardHtml() {
    var t = TD();
    var h = ['<section class="rz-card rzt-calib"><div class="rz-card-head"><span class="rz-card-title">Scores officiels</span>'
      + (U.calOpen ? '' : btn('rz-test-cal-open', 'Saisir un score officiel', 'btn-secondary rzt-sm')) + '</div>'];
    var list = [];
    ['L', 'R'].forEach(function (s) { t.calib[s].forEach(function (c, i) { list.push({ s: s, i: i, c: c }); }); });
    list.sort(function (a, b) { return b.c.at - a.c.at; });
    if (U.calOpen) {
      h.push('<div class="rzt-cal-form"><label><span>Date du test</span><input class="input" type="date" data-role="rz-test-cal" data-field="date" data-focus-key="rzt-cal-date" value="' + esc(U.cal.date) + '"></label>'
        + '<label><span>Listening (5-495)</span><input class="input" type="number" min="5" max="495" step="5" inputmode="numeric" data-role="rz-test-cal" data-field="L" data-focus-key="rzt-cal-L" value="' + esc(U.cal.L) + '"></label>'
        + '<label><span>Reading (5-495)</span><input class="input" type="number" min="5" max="495" step="5" inputmode="numeric" data-role="rz-test-cal" data-field="R" data-focus-key="rzt-cal-R" value="' + esc(U.cal.R) + '"></label></div>'
        + (U.calError ? '<div class="rz-err-line">' + esc(U.calError) + '</div>' : '')
        + '<div class="rzt-actions">' + btn('rz-test-cal-save', 'Enregistrer', 'btn-primary') + btn('rz-test-cal-close', 'Annuler', 'btn-ghost') + '</div>');
    }
    if (list.length) {
      h.push('<ul class="rzt-cal-list">' + list.slice(0, 8).map(function (x) {
        return '<li><span>' + esc(frDate(x.c.at)) + '</span><span>' + (x.s === 'L' ? 'Listening' : 'Reading') + ' <b>' + x.c.official + '</b></span>'
          + '<span class="rz-muted">' + (x.c.app != null ? 'bilan ≈ ' + x.c.app : 'sans bilan proche') + '</span>'
          + '<button type="button" class="rzt-x" data-act="rz-test-cal-del" data-s="' + x.s + '" data-i="' + x.i + '" title="Retirer" aria-label="Retirer ce score">' + R.icon('cross') + '</button></li>';
      }).join('') + '</ul>');
      var oL = offsetFor('L'), oR = offsetFor('R');
      h.push('<div class="rz-card-foot">Recalage appliqué aux bilans : écoute ' + signed(oL) + ', lecture ' + signed(oR) + ' points (décalage prudent, rétréci vers zéro).</div>');
    } else if (!U.calOpen) {
      h.push('<div class="rz-card-foot">Une ou deux fois par an, un vrai test (ou un test blanc officiel) recale l’estimation : saisissez ici vos scores Listening et Reading. Révizator les compare au bilan le plus proche.</div>');
    }
    h.push('</section>');
    return h.join('');
  }

  function historyCardHtml() {
    var h = TD().history.slice().reverse();
    if (!h.length) return '';
    var shown = U.histAll ? h : h.slice(0, 6);
    var out = ['<section class="rz-card rzt-hist"><div class="rz-card-head"><span class="rz-card-title">Historique</span><span class="rz-card-meta">' + plural(h.length, 'bilan') + '</span></div><ul class="rzt-hist-list">'];
    shown.forEach(function (e) {
      var what = e.kind === 'express'
        ? '<b>' + e.total.score + '</b> / 990 <span class="rz-muted">· É ' + e.L.score + ' · L ' + e.R.score + '</span>'
        : (e.S ? 'Oral <b>' + e.S.score + '</b>' : '') + (e.S && e.W ? ' · ' : '') + (e.W ? 'Écrit <b>' + (e.W.capped ? '≥ 150' : e.W.score) + '</b>' : '');
      out.push('<li><button type="button" class="rzt-hist-item" data-act="rz-test-result" data-id="' + esc(e.id) + '"><span class="rzt-hist-date">' + esc(frShort(e.at)) + '</span>'
        + '<span class="rzt-hist-kind">' + (e.kind === 'express' ? 'Express' : 'Oral et écrit') + '</span><span class="rzt-hist-what">' + what + '</span>' + R.icon('arrow') + '</button></li>');
    });
    out.push('</ul>');
    if (h.length > 6) out.push('<div>' + btn('rz-test-hist-more', U.histAll ? 'Moins' : 'Tout l’historique', 'btn-ghost rzt-sm') + '</div>');
    out.push('</section>');
    return out.join('');
  }

  function homeViewHtml() {
    var h = [];
    h.push('<div class="rzt-head"><div><div class="rz-kicker">' + R.icon('flag') + ' Bilans</div><h2 class="rz-section-title">Mesurer votre niveau</h2>'
      + '<div class="rz-sub">Deux bilans courts, à refaire de temps en temps : le bilan express toutes les 2 à 4 semaines, l’oral et l’écrit chaque mois.</div></div></div>');
    if (U.docError) h.push('<div class="rz-error">' + esc(U.docError) + '</div>');
    h.push('<div class="rz-grid2 rzt-kinds">' + expressCardHtml() + swCardHtml() + '</div>');
    var main = lastResultCardHtml() + historyCardHtml();
    if (!main) {
      main = '<section class="rz-card">' + R.h.empty('Pas encore de bilan',
        'Le premier bilan express situe votre écoute et votre lecture sur l’échelle 10-990, avec sa marge d’erreur et votre niveau CECRL. Les suivants affinent la tendance, visible dans Progrès ; les modules d’étape 2 non servis sont gardés pour la fois suivante.') + '</section>';
    }
    h.push('<div class="rzt-lower">' + '<div class="rzt-lower-main">' + main + '</div><div class="rzt-lower-side">' + calibCardHtml() + '</div></div>');
    if (!TD().history.length) h.push(mentionHtml());
    return h.join('');
  }

  /* ══ Rendu : bilan express ══════════════════════════════════════════════ */

  function voiceWarningHtml() {
    var e = R.tts.engine();
    if (e === 'kokoro') return '';
    if (e === 'system') {
      return '<div class="rz-callout rzt-voicewarn"><b>Écoute avec les voix de Windows.</b> Les voix naturelles ne sont pas installées : l’écoute sera lue par des voix plus robotiques, avec moins d’accents. Pour un bilan fidèle, installez les voix naturelles (375 Mo, une fois).'
        + '<div class="rzt-voicewarn-dl">' + R.h.voiceStatus(false) + '</div></div>';
    }
    return '<div class="rz-callout rzt-voicewarn is-bad"><b>Aucune voix anglaise sur ce poste.</b> L’écoute ne peut pas se faire dans de bonnes conditions : le texte s’affichera sur demande à la place du son. Installez les voix naturelles pour un vrai bilan.'
      + '<div class="rzt-voicewarn-dl">' + R.h.voiceStatus(false) + '</div></div>';
  }

  function introHtml(run) {
    var h = ['<section class="rz-card rzt-intro">'];
    h.push('<div class="rz-kicker">' + R.icon('flag') + ' Bilan express · format type TOEIC®</div><h2 class="rzt-h2">Avant de commencer</h2>');
    h.push('<div class="rzt-intro-parts"><div class="rzt-ip"><div class="rzt-ip-head">' + R.icon('ear') + ' Écoute</div><div class="rzt-ip-big">≈ 11 min</div><div class="rzt-ip-sub">23 questions · rythme imposé par l’audio</div></div>'
      + '<div class="rzt-ip"><div class="rzt-ip-head">' + R.icon('read') + ' Lecture</div><div class="rzt-ip-big">16 min</div><div class="rzt-ip-sub">20 questions · chronomètre global</div></div></div>');
    h.push('<ul class="rzt-rules">'
      + '<li><b>Une seule écoute.</b> Chaque enregistrement passe une fois ; Pause l’interrompt sans le rejouer.</li>'
      + '<li><b>Questions-réponses :</b> les trois réponses sont seulement entendues, lues par une autre voix ; environ 5 secondes pour choisir A, B ou C.</li>'
      + '<li><b>Conversations et exposés :</b> questions et réponses s’affichent dès le début ; environ 8 secondes par question après l’audio.</li>'
      + '<li><b>Pas de transcription avant la fin :</b> vous la verrez dans la correction, avec l’audio à réécouter.</li>'
      + '<li><b>Lecture :</b> 16 minutes pour les deux étapes ; vous pouvez revenir en arrière dans une étape.</li>'
      + '<li><b>Deux étapes :</b> la seconde s’adapte à vos réponses — plus facile ou plus difficile, c’est normal.</li>'
      + '<li>Une question sans réponse compte comme fausse : répondez toujours.</li></ul>');
    h.push('<div class="rzt-keys"><span><span class="rz-kbd">1</span> à <span class="rz-kbd">4</span> choisir</span><span><span class="rz-kbd">Entrée</span> suivant</span><span><span class="rz-kbd">Espace</span> pause</span><span><span class="rz-kbd">Échap</span> quitter (le bilan reste en cours)</span></div>');
    h.push(voiceWarningHtml());
    h.push('<div class="rzt-actions">' + btn('rz-test-begin', 'Commencer l’écoute ' + R.icon('arrow'), 'btn-primary rz-big') + btn('rz-test-home', 'Plus tard', 'btn-ghost') + '</div>');
    h.push(mentionHtml() + '</section>');
    return h.join('');
  }

  function examHeadHtml(run, section) {
    var stage = section === 'L' ? run.lis.stage : run.read.stage;
    var totalN = section === 'L' ? 23 : 20;
    var s1 = flat(run, section, 1).length;
    if (stage === 2 && run.path[section]) totalN = s1 + flat(run, section, 2).length;
    else totalN = s1 + (section === 'L' ? 12 : 10);
    var cur;
    if (section === 'L') cur = setFirstNumber(run, 'L', stage, run.lis.i);
    else cur = numberOffset(run, 'R', stage) + run.read.qi + 1;
    var h = '<div class="rzt-examhead">';
    h += '<div class="rzt-eh-left"><span class="rzt-eh-sec">' + R.icon(section === 'L' ? 'ear' : 'read') + (section === 'L' ? 'Écoute' : 'Lecture') + '</span>'
      + '<span class="rzt-eh-stage">Étape ' + stage + ' sur 2' + (stage === 2 && run.path[section] ? ' · ' + (run.path[section] === 'hard' ? 'plus exigeante' : 'plus accessible') : '') + '</span></div>';
    h += '<div class="rzt-eh-mid"><span class="rzt-eh-count">Question ' + cur + ' sur ' + totalN + '</span>' + R.h.progress((cur - 1) / totalN, 'Avancement du bilan') + '</div>';
    if (section === 'R') {
      var rem = readRemaining(run);
      h += '<div class="rzt-eh-clock' + (rem < 120000 ? ' is-low' : '') + '" data-rzt-clockbox="read" title="Temps restant pour la lecture">' + R.icon('clock') + '<span data-rzt-clock="read">' + clock(rem) + '</span></div>';
    }
    h += '<div class="rzt-eh-right">' + (run.paused ? btn('rz-test-resume', R.icon('play') + ' Reprendre', 'btn-primary') : btn('rz-test-pause', R.icon('pause') + ' Pause', 'btn-secondary')) + '</div>';
    return h + '</div>';
  }

  function optionLetterBtn(key, i, chosen, extra, label) {
    return '<button type="button" class="rzt-opt' + (chosen === i ? ' is-on' : '') + (extra || '') + '" data-act="rz-test-ans" data-key="' + esc(key) + '" data-i="' + i + '" aria-pressed="' + (chosen === i ? 'true' : 'false') + '">'
      + '<span class="rzt-opt-l">' + LETTERS[i] + '</span>' + (label != null ? '<span class="rzt-opt-t" lang="en">' + esc(label) + '</span>' : '') + '</button>';
  }

  function audioStateHtml(run, set) {
    var ph = run.lis.phase;
    var key = U.lisKey;
    var p = R.players[key];
    if (run.paused) return '<div class="rzt-astate is-paused">' + R.icon('pause') + '<span>En pause — ' + (ph === 'cut' ? 'l’enregistrement reprendra depuis le début de cet ensemble.' : 'reprenez quand vous voulez.') + '</span></div>';
    if (ph === 'cut') return '<div class="rzt-astate is-paused">' + R.icon('replay') + '<span>L’écoute a été interrompue : elle reprend au début de cet ensemble.</span>' + btn('rz-test-resume', 'Reprendre l’écoute', 'btn-primary') + '</div>';
    if (ph === 'error') return '<div class="rzt-astate is-bad"><span>Le son n’a pas pu être lu : ' + esc(U.lisError || 'erreur') + '.</span>' + btn('rz-test-replay', 'Réessayer', 'btn-primary') + '</div>';
    if (ph === 'ready') return '<div class="rzt-astate"><span>Prêt pour la suite.</span>' + btn('rz-test-resume', 'Lancer l’écoute ' + R.icon('play'), 'btn-primary') + '</div>';
    if (ph === 'answer') {
      return '<div class="rzt-astate is-answer">' + R.icon('clock') + '<span>À vous : <b data-rzt-clock="lis">' + clock(run.lis.deadline - now()) + '</b></span></div>';
    }
    var line = p && p.line >= 0 ? p.line : -1;
    var st = p ? p.state : 'loading';
    var heard = +set.part === 2 ? '<span class="rzt-heard" aria-hidden="true">' + arr(set.questions[0] && set.questions[0].options).map(function (o, i) {
      return '<span class="rzt-heard-l' + (line === i + 1 ? ' is-speaking' : '') + '" data-rz-say="' + esc(key) + '" data-rz-idx="' + (i + 1) + '">' + LETTERS[i] + '</span>';
    }).join('') + '</span>' : '';
    return '<div class="rzt-astate is-playing"><span class="rzt-wave' + (st === 'playing' ? ' on' : '') + '"><i></i><i></i><i></i><i></i><i></i></span><span>' + (st === 'loading' ? 'Préparation de l’audio…' : 'Écoute en cours…') + '</span>' + heard + '</div>';
  }

  function transcriptFallbackHtml(set, first, last) {
    if (R.tts.engine() !== 'none') return '';
    var spec = audioSpec(set, first, last);
    return '<details class="rzt-novoice"><summary>Aucune voix : afficher le texte à la place du son</summary><div class="rzt-trans" lang="en">'
      + spec.lines.map(function (l) { return '<p><b>' + esc(speakerName(set, l.speaker)) + '</b> ' + esc(l.shown) + '</p>'; }).join('') + '</div></details>';
  }

  function listenHtml(run) {
    var set = curSet(run);
    if (!set) return '<section class="rz-card"><span class="rz-spin"></span> Chargement…</section>';
    var stage = run.lis.stage;
    var first = setFirstNumber(run, 'L', stage, run.lis.i), qs = arr(set.questions), last = first + qs.length - 1;
    var heard = run.lis.phase === 'answer';
    var h = [examHeadHtml(run, 'L')];
    if (U.flash) h.push('<div class="rz-callout is-accent rzt-flash">' + esc(U.flash) + '</div>');
    h.push('<section class="rz-card rzt-lset' + (run.paused ? ' is-paused' : '') + '" data-part="' + esc(set.part) + '">');
    h.push('<div class="rzt-part">Partie ' + esc(set.part) + ' · ' + esc(PART_ONE[set.part] || '') + '</div>');
    h.push(audioStateHtml(run, set));
    if (+set.part === 2) {
      var q = qs[0];
      var key = qKey(run, set, q, 0, 'L', stage);
      var chosen = run.answers[key] != null ? +run.answers[key] : -1;
      h.push('<div class="rzt-p2"><div class="rzt-p2-n">' + first + '</div><div class="rzt-p2-q">Écoutez la question, puis les trois réponses. Choisissez la meilleure.</div>'
        + '<div class="rzt-p2-opts">' + arr(q.options).map(function (o, i) { return optionLetterBtn(key, i, chosen, ' is-big'); }).join('') + '</div></div>');
    } else {
      h.push('<p class="rzt-intro-line" lang="en">' + esc(introText(set, first, last, false)) + '</p>');
      var body = '<div class="rzt-lqs">';
      qs.forEach(function (q, qi) {
        var key = qKey(run, set, q, qi, 'L', stage);
        var chosen = run.answers[key] != null ? +run.answers[key] : -1;
        var active = (U.activeQ || 0) === qi;
        body += '<div class="rzt-q' + (active ? ' is-active' : '') + '" data-act="rz-test-active" data-q="' + qi + '"><div class="rzt-q-stem" lang="en"><span class="rzt-q-n">' + (first + qi) + '</span>' + esc(q.stem) + '</div>'
          + '<div class="rzt-q-opts">' + arr(q.options).map(function (o, i) { return optionLetterBtn(key, i, chosen, '', o); }).join('') + '</div></div>';
      });
      body += '</div>';
      if (set.graphic) h.push('<div class="rzt-lgrid">' + body + '<div class="rzt-lside">' + graphicHtml(set.graphic) + '</div></div>');
      else h.push(body);
    }
    h.push(transcriptFallbackHtml(set, first, last));
    var allAns = qs.every(function (q, qi) { return run.answers[qKey(run, set, q, qi, 'L', stage)] != null; });
    h.push('<div class="rzt-lfoot"><span class="rz-muted">' + (heard ? (allAns ? 'Entrée : passer à la suite.' : 'La suite démarre seule à la fin du temps.') : 'Vous pouvez répondre pendant l’écoute.') + '</span>'
      + (heard ? btn('rz-test-next', (allAns ? 'Suivant ' : 'Passer ') + R.icon('arrow'), allAns ? 'btn-primary' : 'btn-secondary') : '') + '</div>');
    h.push('</section>');
    return h.join('');
  }

  function pauseHtml(run) {
    var n = flat(run, 'L', 1).length + flat(run, 'L', 2).length;
    var answered = Object.keys(run.answers).length;
    return '<section class="rz-card rzt-intro rzt-break"><div class="rz-kicker">' + R.icon('check') + ' Écoute terminée</div><h2 class="rzt-h2">Pause avant la lecture</h2>'
      + '<p class="rzt-lead">' + n + ' questions d’écoute, ' + answered + ' réponses données. Les résultats viendront à la fin. Respirez, buvez un verre d’eau : le chronomètre de la lecture ne démarre que quand vous cliquez.</p>'
      + '<div class="rzt-intro-parts"><div class="rzt-ip"><div class="rzt-ip-head">' + R.icon('read') + ' Lecture</div><div class="rzt-ip-big">16 min</div><div class="rzt-ip-sub">20 questions · phrases, texte à compléter, documents</div></div>'
      + '<div class="rzt-ip"><div class="rzt-ip-head">' + R.icon('clock') + ' Rythme</div><div class="rzt-ip-big">≈ 48 s</div><div class="rzt-ip-sub">par question ; visez 8 minutes par étape</div></div></div>'
      + '<div class="rzt-keys"><span><span class="rz-kbd">1</span> à <span class="rz-kbd">4</span> choisir</span><span><span class="rz-kbd">←</span> <span class="rz-kbd">→</span> question précédente, suivante</span><span><span class="rz-kbd">Espace</span> pause</span></div>'
      + '<div class="rzt-actions">' + btn('rz-test-read', 'Commencer la lecture ' + R.icon('arrow'), 'btn-primary rz-big') + btn('rz-test-home', 'Plus tard', 'btn-ghost') + '</div></section>';
  }

  function readHtml(run) {
    var items = flat(run, 'R', run.read.stage);
    if (!items.length) return '<section class="rz-card"><span class="rz-spin"></span> Chargement…</section>';
    var cur = items[Math.min(run.read.qi, items.length - 1)];
    var set = cur.set, off = numberOffset(run, 'R', run.read.stage);
    var h = [examHeadHtml(run, 'R')];
    if (U.flash) h.push('<div class="rz-callout is-accent rzt-flash">' + esc(U.flash) + '</div>');
    var pills = '<nav class="rzt-pills" aria-label="Questions de l’étape">' + items.map(function (it, i) {
      var ans = run.answers[it.key] != null;
      return '<button type="button" class="rzt-pill' + (i === run.read.qi ? ' is-cur' : '') + (ans ? ' is-done' : '') + '" data-act="rz-test-rgo" data-qi="' + i + '" title="Question ' + (off + i + 1) + (ans ? ' · répondue' : ' · sans réponse') + '">' + (off + i + 1) + '</button>';
    }).join('') + '</nav>';
    var hasDoc = arr(set.documents).length || set.graphic;
    var chosen = run.answers[cur.key] != null ? +run.answers[cur.key] : -1;
    var q = cur.q;
    var ctx = null;
    if (+set.part === 6) {
      ctx = { blanks: arr(set.questions).map(function (qq, i) {
        var k = qKey(run, set, qq, i, 'R', run.read.stage);
        var a = run.answers[k];
        return { text: a != null ? arr(qq.options)[+a] : '' };
      }), current: cur.qi };
    }
    var qhtml = '<div class="rzt-qpanel"><div class="rzt-part">Partie ' + esc(set.part) + ' · ' + esc(PART_ONE[set.part] || '') + '</div>'
      + '<div class="rzt-q-stem is-big" lang="en"><span class="rzt-q-n">' + (off + run.read.qi + 1) + '</span>'
      + '<span class="rzt-q-txt">' + (+set.part === 6 && !String(q.stem || '').trim() ? '<span lang="fr">Choisissez ce qui convient pour le trou <b>[' + (cur.qi + 1) + ']</b>.</span>' : (+set.part === 5 ? esc(q.stem).replace(/-{3,}|_{3,}/, '<span class="rzt-gap"></span>') : esc(q.stem))) + '</span></div>'
      + '<div class="rzt-q-opts is-col">' + arr(q.options).map(function (o, i) { return optionLetterBtn(cur.key, i, chosen, '', o); }).join('') + '</div>'
      + '<div class="rzt-rnav">' + btn('rz-test-rprev', R.icon('back') + ' Précédente', 'btn-ghost', run.read.qi <= 0 ? ' disabled' : '')
      + (run.read.qi < items.length - 1 ? btn('rz-test-rnext', 'Suivante ' + R.icon('arrow'), 'btn-primary') : btn('rz-test-rfinish', esc(finishLabel(run, items)), 'btn-primary')) + '</div>';
    var unanswered = items.filter(function (it) { return run.answers[it.key] == null; }).length;
    if (run.read.qi >= items.length - 1 && unanswered && U.arm.rfinish) qhtml += '<div class="rz-err-line">' + plural(unanswered, 'question') + ' sans réponse : cliquez encore pour terminer quand même.</div>';
    qhtml += '</div>';
    h.push('<section class="rz-card rzt-rset' + (run.paused ? ' is-paused' : '') + '">' + pills);
    var setFirst = off + items.indexOf(cur) - cur.qi + 1;
    var introLine = hasDoc && (set.intro || +set.part >= 6) ? '<p class="rzt-intro-line" lang="en">' + esc(readIntro(set, setFirst, setFirst + arr(set.questions).length - 1)) + '</p>' : '';
    if (hasDoc) h.push('<div class="rzt-rgrid"><div class="rzt-docs" data-rz-scroll="rzt-doc-' + esc(cur.docId + ':' + set.id) + '">' + introLine + documentsHtml(set, ctx) + '</div>' + qhtml + '</div>');
    else h.push('<div class="rzt-rsolo">' + qhtml + '</div>');
    if (run.paused) h.push('<div class="rzt-veil"><div>' + R.icon('pause') + '<b>Lecture en pause</b><span>Le chronomètre est arrêté et le texte masqué.</span>' + btn('rz-test-resume', R.icon('play') + ' Reprendre', 'btn-primary rz-big') + '</div></div>');
    h.push('</section>');
    return h.join('');
  }
  function finishLabel(run, items) {
    var unanswered = items.filter(function (it) { return run.answers[it.key] == null; }).length;
    var base = run.read.stage === 1 ? 'Terminer l’étape 1' : 'Terminer le bilan';
    return U.arm.rfinish && unanswered ? 'Confirmer : ' + base.toLowerCase() : base;
  }

  /* ══ Rendu : résultats d'un bilan express ═══════════════════════════════ */

  /* Pastille de niveau, y compris « B1-B2 limite » (teinte du niveau du bas). */
  function levelPill(label, k) {
    var m = /^(<?[ABC][12])(?:-([ABC][12]))?/.exec(String(label || ''));
    if (!m || m[1].charAt(0) === '<') return R.h.level(label, k);
    if (!m[2]) return R.h.level(m[1], k);
    return '<span class="rz-level lv-' + m[1].toLowerCase() + ' rzt-level-edge" title="' + esc('Entre ' + m[1] + ' et ' + m[2] + ' : aucun des deux niveaux n’atteint 60 % de probabilité') + '">'
      + (k ? '<span class="rz-level-k">' + esc(k) + '</span>' : '') + esc(label) + '</span>';
  }

  function cefrBarsHtml(probs, order) {
    order = order || ['A2', 'B1', 'B2', 'C1'];
    return '<div class="rzt-cp">' + order.map(function (l) {
      var p = num(probs && probs[l], 0) + (l === 'A2' ? num(probs && probs.A1, 0) + num(probs && probs['<A1'], 0) : 0);
      return '<div class="rzt-cp-row" title="' + esc(l + ' : ' + Math.round(p * 100) + ' %') + '"><span class="rzt-cp-k">' + (l === 'A2' ? 'A2 ou moins' : l) + '</span><span class="rzt-cp-bar"><i style="width:' + (p * 100).toFixed(1) + '%"></i></span><span class="rzt-cp-v">' + Math.round(p * 100) + ' %</span></div>';
    }).join('') + '</div>';
  }

  function sectionResultHtml(s, r, prev) {
    var name = s === 'L' ? 'Écoute' : 'Lecture';
    var delta = prev && prev[s] ? r.score - prev[s].score : null;
    return '<div class="rz-card rzt-sec"><div class="rzt-sec-head">' + R.h.skill(s === 'L' ? 'listen' : 'read', false) + '<span class="rzt-sec-name">' + name + '</span>' + levelPill(r.label || r.cefr) + '</div>'
      + '<div class="rzt-sec-score"><b>' + r.score + '</b><span class="rz-muted"> / 495</span><span class="rzt-sec-ci">' + esc(scoreRange(r.ci90)) + ' à 90 %</span></div>'
      + rangeBarHtml(s, r)
      + '<div class="rzt-sec-sub">' + r.correct + ' bonnes réponses sur ' + r.n + ' · étape 2 ' + (r.path === 'hard' ? 'exigeante' : 'accessible')
      + (delta != null ? ' · <span class="' + (delta >= 0 ? 'rzt-up' : 'rzt-down') + '">' + signed(delta) + '</span> depuis le bilan précédent' : '') + '</div>'
      + cefrBarsHtml(r.cefrProb) + '</div>';
  }

  function abilityAgg(e) {
    var list = TD().history.filter(function (x) { return x.kind === 'express' && x.at <= e.at && x.abilities; }).slice(-3);
    var agg = {};
    list.forEach(function (x) {
      Object.keys(x.abilities).forEach(function (k) {
        var a = x.abilities[k], g = agg[k] = agg[k] || { n: 0, c: 0, e: 0, v: 0, k: 0 };
        g.n += a.n; g.c += a.c; g.e += a.e; g.v += a.v; g.k++;
      });
    });
    return { agg: agg, count: list.length };
  }

  function abilitiesHtml(e) {
    var ag = abilityAgg(e);
    var rows = Object.keys(e.abilities || {}).map(function (k) { return { k: k, a: e.abilities[k] }; })
      .sort(function (x, y) { return x.k.localeCompare(y.k); });
    if (!rows.length) return '';
    var weak = [], strong = [];
    var h = ['<div class="rzt-abil">'];
    ['L', 'R'].forEach(function (s) {
      h.push('<div class="rzt-abil-col"><div class="rzt-abil-head">' + R.h.skill(s === 'L' ? 'listen' : 'read') + '</div>');
      rows.filter(function (r) { return r.k.charAt(0) === s; }).forEach(function (r) {
        var a = r.a, g = ag.agg[r.k];
        var zAgg = g && g.v ? (g.c - g.e) / Math.sqrt(g.v) : 0;
        var tag = '';
        if (g && g.n >= 4 && g.k > 1 && zAgg < -1.5) { tag = '<span class="rzt-tag is-weak">Point faible confirmé</span>'; weak.push(r.k); }
        else if (g && g.n >= 4 && g.k > 1 && zAgg > 1.5) { tag = '<span class="rzt-tag is-strong">Point fort confirmé</span>'; strong.push(r.k); }
        else if (a.z < -1 && a.c < a.e) { tag = '<span class="rzt-tag is-weak">Tendance : point faible</span>'; weak.push(r.k); }
        else if (a.z > 1 && a.c > a.e) { tag = '<span class="rzt-tag is-strong">Tendance : point fort</span>'; strong.push(r.k); }
        var ratio = a.n ? a.c / a.n : 0, exp = a.n ? a.e / a.n : 0;
        h.push('<div class="rzt-ab-row"><div class="rzt-ab-label">' + esc((ABILITIES[r.k] || { label: r.k }).label) + tag + '</div>'
          + '<div class="rzt-ab-bar" title="' + esc(a.c + ' sur ' + a.n + ' — attendu à votre score : ' + (Math.round(a.e * 10) / 10).toString().replace('.', ',')) + '"><i style="width:' + (ratio * 100).toFixed(1) + '%"></i><b style="left:' + (exp * 100).toFixed(1) + '%"></b></div>'
          + '<div class="rzt-ab-v">' + a.c + '/' + a.n + '</div></div>');
      });
      h.push('</div>');
    });
    h.push('</div>');
    h.push('<div class="rz-card-foot">Barre : réussite observée ; trait : réussite attendue à votre score. Un seul bilan ne compte que 2 à 4 questions par capacité : on parle de <b>tendance</b>, confirmée quand vos trois derniers bilans vont dans le même sens.</div>');
    if (weak.length) {
      h.push('<div class="rzt-advice"><div class="rz-fb-sub">' + R.icon('target') + ' À travailler</div><ul>' + weak.slice(0, 3).map(function (k) { return '<li><b>' + esc((ABILITIES[k] || { label: k }).label) + '.</b> ' + esc((ABILITIES[k] || { tip: '' }).tip) + '</li>'; }).join('') + '</ul>'
        + btn('rz-go', 'Exercices ' + R.icon('arrow'), 'btn-secondary rzt-sm', ' data-view="exercises"') + '</div>');
    }
    return h.join('');
  }

  function partsTableHtml(e) {
    var rows = [];
    ['L', 'R'].forEach(function (s) {
      var parts = e[s].parts || {};
      Object.keys(parts).sort().forEach(function (p) { rows.push({ s: s, p: p, n: parts[p].n, c: parts[p].c }); });
    });
    return '<table class="rzt-parts"><thead><tr><th scope="col">Partie</th><th scope="col">Bonnes réponses</th><th scope="col"></th></tr></thead><tbody>' + rows.map(function (r) {
      return '<tr><th scope="row">' + R.h.skill(r.s === 'L' ? 'listen' : 'read', false) + ' ' + r.p + ' · ' + esc(PARTS[r.p] || '') + '</th><td>' + r.c + ' / ' + r.n + '</td><td><span class="rzt-pbar"><i style="width:' + (r.n ? r.c / r.n * 100 : 0).toFixed(1) + '%"></i></span></td></tr>';
    }).join('') + '</tbody></table>';
  }

  function speakerName(set, id) {
    if (id === '_N') return 'Narrator';
    if (id === '_Q' || id === '_R') return id === '_Q' ? 'Speaker 1' : 'Speaker 2';
    var sp = arr(set.speakers).filter(function (s) { return s.id === id; })[0];
    var base = { W1: 'Woman', W2: 'Woman 2', M1: 'Man', M2: 'Man 2', N: 'Speaker' }[id] || id;
    return sp && sp.role ? base + ' · ' + sp.role : base;
  }

  function reviewSetHtml(e, set, section, stage, docId, startN) {
    var qs = arr(set.questions);
    var h = ['<div class="rzt-rv-set">'];
    h.push('<div class="rzt-part">' + (section === 'L' ? 'Écoute' : 'Lecture') + ' · Partie ' + esc(set.part) + ' · ' + esc(PART_ONE[set.part] || '') + (set.topic ? ' · <span class="rz-muted">' + esc(set.topic) + '</span>' : '') + '</div>');
    if (section === 'L') {
      var spec = audioSpec(set, startN, startN + qs.length - 1);
      var key = 'rzt-rv-' + e.id + '-' + docId + '-' + set.id;
      h.push('<div class="rzt-rv-audio">' + R.h.player(key, { label: 'Réécouter', source: function () { return R.tts.script(spec.lines.map(function (l) { return { speaker: l.speaker, text: l.text }; }), spec.speakers, { key: key }); } }) + '</div>');
      h.push('<div class="rzt-trans" lang="en">' + spec.lines.map(function (l, i) {
        return '<p data-rz-say="' + esc(key) + '" data-rz-idx="' + i + '"' + (l.intro ? ' class="is-intro"' : '') + '><b>' + esc(speakerName(set, l.speaker)) + '</b> ' + esc(l.shown) + '</p>';
      }).join('') + '</div>');
      if (set.graphic) h.push(graphicHtml(set.graphic));
    } else if (arr(set.documents).length || set.graphic) {
      var ctx = +set.part === 6 ? { blanks: qs.map(function (q) { return { text: arr(q.options)[q.answer] || '', cls: 'is-key' }; }), current: -1 } : null;
      h.push('<details class="rzt-rv-docs"><summary>Revoir le document</summary>' + documentsHtml(set, ctx) + '</details>');
    }
    qs.forEach(function (q, qi) {
      var k = docId + ':' + set.id + ':' + (q.id || ('q' + (qi + 1)));
      var a = e.answers[k];
      var ok = a != null && +a === +q.answer;
      h.push('<div class="rzt-rv-q ' + (ok ? 'is-ok' : 'is-ko') + '"><div class="rzt-q-stem" lang="en"><span class="rzt-q-n">' + (startN + qi) + '</span>'
        + (+set.part === 2 ? 'Meilleure réponse à la question entendue' : (q.stem ? esc(q.stem) : 'Trou [' + (qi + 1) + ']')) + '<span class="rzt-rv-mark">' + R.icon(ok ? 'check' : 'cross') + (ok ? 'Juste' : (a == null ? 'Sans réponse' : 'Faux')) + '</span></div>');
      h.push('<ul class="rzt-rv-opts" lang="en">' + arr(q.options).map(function (o, i) {
        var cls = i === +q.answer ? ' is-key' : (a != null && +a === i ? ' is-wrong' : '');
        return '<li class="' + cls.trim() + '"><span class="rzt-opt-l">' + LETTERS[i] + '</span>' + esc(o) + (i === +q.answer ? ' <span class="rzt-rv-why">bonne réponse</span>' : (a != null && +a === i ? ' <span class="rzt-rv-why">votre réponse</span>' : '')) + '</li>';
      }).join('') + '</ul>');
      if (q.explanationFr) h.push('<div class="rzt-rv-exp">' + esc(q.explanationFr) + '</div>');
      if (q.evidence) h.push('<div class="rzt-rv-ev" lang="en">« ' + esc(q.evidence) + ' »</div>');
      h.push('</div>');
    });
    h.push('</div>');
    return h.join('');
  }

  function reviewHtml(e) {
    var ids = [e.modules.stage1, e.modules.L, e.modules.R];
    if (!needDocs('toeic', ids)) return '<div class="rz-muted"><span class="rz-spin"></span> Chargement de la correction…</div>';
    var h = [];
    ['L', 'R'].forEach(function (s) {
      var n = 1;
      h.push('<details class="rzt-rv-sec"' + (U.rvOpen && U.rvOpen[s] ? ' open' : '') + ' data-rzt-rv="' + s + '"><summary>' + R.h.skill(s === 'L' ? 'listen' : 'read') + ' Correction de ' + (s === 'L' ? 'l’écoute' : 'la lecture') + ' · ' + e[s].correct + ' / ' + e[s].n + '</summary>');
      [1, 2].forEach(function (stage) {
        var id = stage === 1 ? e.modules.stage1 : e.modules[s];
        var d = doc('toeic', id);
        if (!d) return;
        h.push('<div class="rzt-rv-stage">Étape ' + stage + (stage === 2 ? ' · module ' + (e.path[s] === 'hard' ? 'difficile' : 'facile') : '') + '</div>');
        arr(s === 'L' ? d.listening : d.reading).forEach(function (set) {
          if (!arr(set.questions).length) return;
          h.push(reviewSetHtml(e, set, s, stage, id, n));
          n += arr(set.questions).length;
        });
      });
      h.push('</details>');
    });
    return h.join('');
  }

  function expressResultHtml(e) {
    var prev = TD().history.filter(function (x) { return x.kind === 'express' && x.at < e.at; }).slice(-1)[0] || null;
    var h = [];
    h.push('<div class="rzt-head"><div><div class="rz-kicker">' + R.icon('flag') + ' Bilan express · ' + esc(frDate(e.at)) + '</div><h2 class="rz-section-title">Vos résultats</h2></div>'
      + '<div class="rzt-actions">' + btn('rz-test-home', R.icon('back') + ' Bilans', 'btn-ghost') + btn('rz-test-progress', R.icon('chart') + ' Progrès', 'btn-secondary') + '</div></div>');
    var tl = cefrLabel({ cefr: e.total.cefr, cefrProb: e.total.cefrProb });
    h.push('<section class="rz-card rzt-hero"><div class="rzt-hero-main"><div class="rzt-hero-k">Score estimé</div><div class="rzt-hero-v"><b>' + e.total.score + '</b><span> / 990</span></div>'
      + '<div class="rzt-hero-ci">entre ' + e.total.ci90[0] + ' et ' + e.total.ci90[1] + ' à 90 % · ' + levelPill(tl.label, 'Niveau') + '</div>'
      + rangeBarHtml('T', { score: e.total.score, ci90: e.total.ci90 })
      + (prev ? '<div class="rzt-hero-sub">Bilan précédent (' + esc(frShort(prev.at)) + ') : ' + prev.total.score + '. Tendance de vos bilans : ≈ ' + e.trend.T.mean + ' ± ' + Math.round(1.645 * e.trend.T.sd) + '.</div>'
        : '<div class="rzt-hero-sub">Premier bilan : la marge est large (± ' + Math.round(1.645 * e.total.sd) + '). Elle se resserre bilan après bilan.</div>')
      + '</div><div class="rzt-hero-note">Ce score est estimé à partir de 43 questions ; un test officiel en compte 200. Il situe votre niveau, pas un résultat au point près.'
      + (e.L.offset || e.R.offset ? ' Recalé sur vos scores officiels (écoute ' + signed(e.L.offset) + ', lecture ' + signed(e.R.offset) + ').' : '')
      + (e.pauses || e.replays ? ' ' + plural(e.pauses, 'pause') + (e.replays ? ', ' + plural(e.replays, 'reprise') + ' d’écoute' : '') + '.' : '') + '</div>'
      + mentionHtml() + '</section>');
    h.push('<div class="rz-grid2 rzt-secs">' + sectionResultHtml('L', e.L, prev) + sectionResultHtml('R', e.R, prev) + '</div>');
    h.push('<div class="rz-grid2 rzt-details"><section class="rz-card"><div class="rz-card-head"><span class="rz-card-title">Par partie</span></div>' + partsTableHtml(e) + '</section>'
      + '<section class="rz-card"><div class="rz-card-head"><span class="rz-card-title">Par capacité</span></div>' + abilitiesHtml(e) + '</section></div>');
    h.push('<section class="rz-card rzt-review"><div class="rz-card-head"><span class="rz-card-title">Correction détaillée</span><span class="rz-card-meta">transcriptions et audio, maintenant visibles</span></div>' + reviewHtml(e) + '</section>');
    return h.join('');
  }

  /* ══ Rendu : bilan oral et écrit ════════════════════════════════════════ */

  function swIntroHtml(sr) {
    var d = swDoc(sr);
    var steps = swSteps(d || {}, sr.withEssay);
    var nSp = arr(d && d.speaking).length, nWr = arr(d && d.writing).filter(function (w) { return w.task !== 'essay' || sr.withEssay; }).length;
    var h = ['<section class="rz-card rzt-intro">'];
    h.push('<div class="rz-kicker">' + R.icon('speak') + ' Bilan oral et écrit · format type TOEIC®</div><h2 class="rzt-h2">Avant de commencer</h2>');
    h.push('<div class="rzt-intro-parts"><div class="rzt-ip"><div class="rzt-ip-head">' + R.icon('speak') + ' Oral</div><div class="rzt-ip-big">≈ 10 min</div><div class="rzt-ip-sub">' + plural(nSp, 'tâche') + ' · micro</div></div>'
      + '<div class="rzt-ip"><div class="rzt-ip-head">' + R.icon('pen') + ' Écrit</div><div class="rzt-ip-big">≈ ' + (sr.withEssay ? 45 : 15) + ' min</div><div class="rzt-ip-sub">' + plural(nWr, 'tâche') + ' · clavier</div></div></div>');
    h.push('<ul class="rzt-rules"><li><b>Chaque tâche orale</b> a un temps de préparation, puis l’enregistrement démarre seul pour le temps de parole. <span class="rz-kbd">Espace</span> le termine plus tôt.</li>'
      + '<li>Les questions sont lues à voix haute, comme au téléphone. Parlez le plus possible : le temps de parole compte.</li>'
      + '<li>À l’écrit, écrivez vous-même : pas de dictée ni de correcteur. Un minuteur indique le temps restant.</li>'
      + '<li>Chaque réponse part à la correction pendant que vous continuez ; les résultats arrivent à la fin.</li></ul>');
    if (bridge.isShim && !window.__fakeMic) h.push('<div class="rz-callout">Hors de l’application, le micro peut être indisponible : les tâches orales se passent alors avec « Passer ».</div>');
    h.push('<div class="rzt-actions">' + btn('rz-test-sw-begin', 'Commencer ' + R.icon('arrow'), 'btn-primary rz-big') + btn('rz-test-home', 'Plus tard', 'btn-ghost') + '</div>');
    h.push('<div class="rz-card-foot">' + plural(steps.length, 'étape') + ' au total.</div>' + mentionHtml() + '</section>');
    return h.join('');
  }

  function swHeadHtml(sr, steps) {
    var st = steps[sr.step];
    return '<div class="rzt-examhead"><div class="rzt-eh-left"><span class="rzt-eh-sec">' + R.icon(st.mode === 'speak' ? 'speak' : 'pen') + (st.mode === 'speak' ? 'Oral' : 'Écrit') + '</span><span class="rzt-eh-stage">' + esc((SW_TASKS[st.type] || {}).label || '') + '</span></div>'
      + '<div class="rzt-eh-mid"><span class="rzt-eh-count">Étape ' + (sr.step + 1) + ' sur ' + steps.length + '</span>' + R.h.progress(sr.step / steps.length, 'Avancement du bilan') + '</div>'
      + '<div class="rzt-eh-right">' + (sr.paused ? btn('rz-test-sw-resume', R.icon('play') + ' Reprendre', 'btn-primary') : btn('rz-test-sw-pause', R.icon('pause') + ' Pause', 'btn-secondary')) + '</div></div>';
  }

  function infoTableHtml(info) {
    if (!info) return '';
    return '<figure class="rzt-graphic"><figcaption>' + esc(info.title || '') + '</figcaption><div class="rzt-gwrap"><table class="rzt-gtable"><tbody>'
      + arr(info.rows).map(function (r) { return '<tr>' + arr(r).map(function (c, i) { return i === 0 ? '<th scope="row">' + esc(c) + '</th>' : '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div></figure>';
  }

  function swTaskHtml(sr) {
    var d = swDoc(sr);
    var steps = swSteps(d, sr.withEssay);
    var st = steps[sr.step];
    if (!st) return '';
    var t = st.task || {};
    var h = [swHeadHtml(sr, steps), '<section class="rz-card rzt-swtask' + (sr.paused ? ' is-paused' : '') + '">'];
    if (st.mode === 'speak') {
      h.push('<div class="rzt-sw-fr">' + esc(t.promptFr || '') + '</div>');
      if (st.type === 'read_aloud') h.push('<div class="rzt-sw-text" lang="en">' + esc(t.text || '') + '</div>');
      else if (st.type === 'describe') h.push('<div class="rzt-sw-scene"><div class="rzt-sw-scene-k">La scène (à décrire en anglais)</div><p>' + esc(t.text || '') + '</p></div>');
      else if (st.type === 'opinion') h.push('<div class="rzt-sw-text is-q" lang="en">' + esc(t.prompt || '') + '</div>');
      else {
        if (t.prompt && (st.qi <= 0)) h.push('<div class="rzt-sw-ctx" lang="en">' + esc(t.prompt) + '</div>');
        if (st.type === 'respond_info') h.push(infoTableHtml(t.info));
        if (st.qi >= 0) h.push('<div class="rzt-sw-text is-q" lang="en"><span class="rzt-q-n">' + (st.qi + 1) + '</span>' + esc(arr(t.questions)[st.qi] || '') + '</div>');
      }
      var key = 'rzt-sw-rec-' + st.key;
      var stateLine;
      if (sr.paused) stateLine = '<div class="rzt-astate is-paused">' + R.icon('pause') + '<span>En pause : la tâche reprendra depuis le début.</span></div>';
      else if (sr.sub === 'say') stateLine = '<div class="rzt-astate is-playing"><span class="rzt-wave on"><i></i><i></i><i></i><i></i><i></i></span><span>Écoutez la question…</span></div>';
      else if (sr.sub === 'prep') stateLine = '<div class="rzt-astate is-answer">' + R.icon('clock') + '<span>' + (st.read ? 'Lisez le document : ' : 'Préparation : ') + '<b data-rzt-clock="sw">' + clock(sr.deadline - now()) + '</b></span>' + btn('rz-test-sw-go', st.read ? 'J’ai lu' : 'Parler maintenant', 'btn-secondary rzt-sm') + '</div>';
      else if (sr.sub === 'rec') stateLine = '<div class="rzt-astate is-rec"><span class="rz-rec-dot"></span><span>Parlez : <b data-rzt-clock="swrec">' + clock(st.rec * 1000 - num(R.recState(key).ms, 0)) + '</b> restantes</span></div>';
      else if (sr.sub === 'saved') stateLine = '<div class="rzt-astate is-answer">' + R.icon('check') + '<span>Réponse enregistrée. Suite…</span></div>';
      else stateLine = '<div class="rzt-astate"><span>Prêt.</span>' + btn('rz-test-sw-resume', 'Commencer cette tâche', 'btn-primary') + '</div>';
      h.push(stateLine);
      if (!st.read && (sr.sub === 'rec' || sr.sub === 'prep')) {
        h.push('<div class="rzt-sw-rec">' + R.h.rec(key, {
          maxMs: st.rec * 1000, label: 'Parler', againLabel: 'Recommencer',
          stt: { keep: true, reference: st.type === 'read_aloud' ? String(t.text || '') : undefined },
          onStart: function () { var s2 = TD().swRun; if (s2 && s2.sub === 'prep') { s2.sub = 'rec'; s2.deadline = 0; R.save(); R.renderSoon(0); } },
          onResult: function (r) { swOnRec(st, r); }
        }) + '</div>');
      }
      h.push('<div class="rzt-lfoot"><span class="rz-muted">Temps de parole : ' + (st.read ? '—' : st.rec + ' s') + '</span>' + btn('rz-test-sw-skip', st.read ? 'Passer à la question' : 'Passer cette question', 'btn-ghost') + '</div>');
    } else {
      var rem = st.minutes * 60000 - swWriteElapsed(sr);
      h.push('<div class="rzt-sw-wtop"><div class="rzt-sw-fr">' + esc((st.type === 'sentence' ? st.tasks[0].promptFr : t.promptFr) || '') + '</div>'
        + '<div class="rzt-eh-clock' + (rem < 60000 ? ' is-low' : '') + '" data-rzt-clockbox="sw">' + R.icon('clock') + '<span data-rzt-clock="sw">' + clock(rem) + '</span></div></div>');
      if (st.type === 'sentence') {
        st.tasks.forEach(function (w, i) {
          var r = sr.responses[w.id] || {};
          h.push('<div class="rzt-sw-sent"><div class="rzt-sw-scene"><div class="rzt-sw-scene-k">Situation ' + (i + 1) + '</div><p>' + esc(w.situation || '') + '</p></div>'
            + '<div class="rzt-sw-words" lang="en">' + arr(w.words).map(function (x) { return '<span class="rz-phrase">' + esc(x) + '</span>'; }).join(' / ') + '</div>'
            + '<textarea class="input rzt-sw-area is-short" rows="2" lang="en" spellcheck="false" data-dict="off" data-role="rz-test-sw-text" data-key="' + esc(w.id) + '" data-focus-key="rzt-sw-' + esc(w.id) + '" placeholder="One sentence…">' + esc(r.text || '') + '</textarea></div>');
        });
      } else {
        if (st.type === 'email' && t.email) {
          h.push('<article class="rzt-doc rzt-doc-email" lang="en"><div class="rzt-doc-bar"><span class="rzt-doc-badge">E-mail</span></div><dl class="rzt-mail-head"><dt>From</dt><dd>' + esc(t.email.from || '') + '</dd><dt>Subject</dt><dd class="rzt-mail-subj">' + esc(t.email.subject || '') + '</dd></dl>'
            + '<div class="rzt-doc-body rzt-mail-body">' + String(t.email.body || '').split(/\n+/).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') + '</div></article>');
        }
        h.push('<div class="rzt-sw-text is-q" lang="en">' + esc(t.prompt || '') + '</div>');
        var r = sr.responses[st.key] || {};
        h.push('<textarea class="input rzt-sw-area" rows="' + (st.type === 'essay' ? 16 : 9) + '" lang="en" spellcheck="false" data-dict="off" data-role="rz-test-sw-text" data-key="' + esc(st.key) + '" data-focus-key="rzt-sw-' + esc(st.key) + '" placeholder="Write your answer here…">' + esc(r.text || '') + '</textarea>'
          + '<div class="rzt-wc" data-rzt-wc="' + esc(st.key) + '">' + wcText(st, r.text) + '</div>');
      }
      h.push('<div class="rzt-lfoot"><span class="rz-muted">Pas de dictée ni de correcteur : écrivez vous-même.</span>' + btn('rz-test-sw-submit', 'Rendre ' + R.icon('arrow'), 'btn-primary') + '</div>');
      if (sr.paused) h.push('<div class="rzt-veil"><div>' + R.icon('pause') + '<b>En pause</b><span>Le minuteur est arrêté.</span>' + btn('rz-test-sw-resume', R.icon('play') + ' Reprendre', 'btn-primary rz-big') + '</div></div>');
    }
    h.push(gradeStatusHtml(sr));
    h.push('</section>');
    return h.join('');
  }
  function wcText(st, text) {
    var n = R.text.count(text || '');
    var goal = st.type === 'essay' ? ' · au moins 300' : (st.type === 'email' ? ' · 60 à 150 conseillés' : '');
    return n + ' mot' + (n > 1 ? 's' : '') + goal;
  }

  function gradeStatusHtml(sr) {
    var units = swAnswerUnits(swSteps(swDoc(sr) || {}, sr.withEssay));
    var answered = units.filter(function (u) { return sr.responses[u.key]; });
    if (!answered.length) return '';
    var graded = units.filter(function (u) { return sr.grades[u.key]; }).length;
    var errs = Object.keys(sr.gradeErrors || {}).length;
    return '<div class="rzt-gstat">' + (graded < answered.length && !errs ? '<span class="rz-spin"></span>' : R.icon('check')) + '<span>Corrections : ' + graded + ' sur ' + answered.length + ' réponses données</span>' + (errs ? '<span class="rz-err-line">' + plural(errs, 'correction') + ' en échec</span>' : '') + '</div>';
  }

  function swGradingHtml(sr) {
    var units = swAnswerUnits(swSteps(swDoc(sr) || {}, sr.withEssay));
    var graded = units.filter(function (u) { return sr.grades[u.key]; }).length;
    var errs = Object.keys(sr.gradeErrors || {});
    var h = '<section class="rz-card rzt-intro"><div class="rz-kicker">' + R.icon('check') + ' Tâches terminées</div><h2 class="rzt-h2">Correction en cours</h2>'
      + '<p class="rzt-lead">Chaque réponse est corrigée en détail : ' + graded + ' sur ' + units.length + '. Cela prend une à deux minutes ; vous pouvez faire autre chose, les résultats vous attendront ici.</p>'
      + R.h.progress(units.length ? graded / units.length : 0, 'Corrections');
    if (errs.length) h += '<div class="rz-err-line">' + plural(errs.length, 'correction') + ' en échec : ' + esc(sr.gradeErrors[errs[0]]) + '</div><div class="rzt-actions">' + btn('rz-test-sw-regrade', 'Réessayer', 'btn-primary') + '</div>';
    return h + '<div class="rzt-actions">' + btn('rz-test-home', R.icon('back') + ' Bilans', 'btn-ghost') + '</div></section>';
  }

  function swResultHtml(e) {
    var d = doc('sw', e.docId);
    if (!d && !needDocs('sw', [e.docId])) return '<section class="rz-card"><span class="rz-spin"></span> Chargement…</section>';
    var h = [];
    h.push('<div class="rzt-head"><div><div class="rz-kicker">' + R.icon('speak') + ' Bilan oral et écrit · ' + esc(frDate(e.at)) + '</div><h2 class="rz-section-title">Vos résultats</h2></div>'
      + '<div class="rzt-actions">' + btn('rz-test-home', R.icon('back') + ' Bilans', 'btn-ghost') + btn('rz-test-progress', R.icon('chart') + ' Progrès', 'btn-secondary') + '</div></div>');
    var tile = function (k, label, skill, x) {
      if (!x) return '';
      var lab = k === 'W' && x.capped ? '≥ 150' : String(x.score);
      return '<div class="rz-card rzt-sec"><div class="rzt-sec-head">' + R.h.skill(skill, false) + '<span class="rzt-sec-name">' + label + '</span>' + R.h.level(x.cefr) + '</div>'
        + '<div class="rzt-sec-score"><b>' + esc(lab) + '</b><span class="rz-muted"> / 200</span><span class="rzt-sec-ci">[' + x.range[0] + '–' + x.range[1] + ']</span></div>' + rangeBarHtml(k, x, 200)
        + '<div class="rzt-sec-sub">' + (k === 'W' && x.capped ? 'Sans essai, l’écrit plafonne à 150 : faites le bilan avec l’essai pour aller au-delà.' : (k === 'W' && !e.withEssay ? 'Estimé sans essai : marge plus large (± 30).' : 'Estimation à partir de la note de chaque tâche, pondérée comme les tâches officielles.')) + '</div></div>';
    };
    h.push('<div class="rz-grid2 rzt-secs">' + tile('S', 'Oral', 'speak', e.S) + tile('W', 'Écrit', 'write', e.W) + '</div>');
    h.push('<section class="rz-card rzt-hero-note-only">' + '<div class="rz-card-foot">Notes données par Claude à partir de la transcription de Whisper et de votre texte, selon des grilles inspirées des barèmes officiels (0-3, 0-4, 0-5). La prononciation n’est jugée qu’indirectement.</div>' + mentionHtml() + '</section>');
    var steps = swSteps(d || {}, e.withEssay);
    var units = swAnswerUnits(steps);
    h.push('<section class="rz-card rzt-review"><div class="rz-card-head"><span class="rz-card-title">Réponse par réponse</span></div>');
    units.forEach(function (u) {
      var g = (d && d.grades && d.grades[u.key]) || U.swGrades[e.id + ':' + u.key];
      var resp = (d && d.responses && d.responses[u.key]) || {};
      var tk = e.tasks && e.tasks[u.key];
      var t = u.task || {};
      var q = u.type === 'respond' || u.type === 'respond_info' ? arr(t.questions)[u.qi] : (u.type === 'sentence' ? arr(t.words).join(' / ') : (u.type === 'read_aloud' || u.type === 'describe' ? '' : t.prompt));
      h.push('<details class="rzt-rv-sec rzt-sw-rv"><summary>' + R.h.skill(u.mode === 'speak' ? 'speak' : 'write', false) + '<span>' + esc((SW_TASKS[u.type] || {}).label || u.type) + (u.qi >= 0 && u.qi != null ? ' · question ' + (u.qi + 1) : '') + '</span>'
        + (tk ? '<span class="rzt-sw-note">' + tk.s + ' / ' + tk.scale + '</span>' : '') + '</summary>');
      if (q) h.push('<div class="rzt-sw-text is-q is-small" lang="en">' + esc(q) + '</div>');
      if (u.mode === 'speak') {
        var url = resp.url || U.blobUrls[u.key] || '';
        if (url) h.push(R.h.player('rzt-swrv-' + e.id + '-' + u.key, { label: 'Me réécouter', small: true, source: function () { return R.audio(url, { key: 'rzt-swrv-' + e.id + '-' + u.key }); } }));
        h.push('<div class="rzt-sw-said" lang="en"><span class="rzt-sw-said-k">Transcription</span>' + (resp.text ? esc(resp.text) : '<i>(rien)</i>') + '</div>');
        if (resp.metrics && resp.metrics.wpm) h.push('<div class="rz-muted rzt-sw-metrics">' + resp.metrics.wpm + ' mots/min · ' + plural(resp.metrics.pauses || 0, 'pause') + (resp.metrics.accuracy != null ? ' · lecture reconnue à ' + Math.round(resp.metrics.accuracy * 100) + ' %' : '') + '</div>');
      }
      if (g) h.push(R.h.feedback(g, { response: resp.text || '', mode: u.mode }));
      h.push('</details>');
    });
    h.push('</section>');
    return h.join('');
  }

  /* ══ Vue ════════════════════════════════════════════════════════════════ */

  function screenOf() {
    var t = TD();
    if (U.screen === 'result') { var e = historyById(U.resultId); if (e) return 'result'; U.screen = 'home'; }
    if (U.screen === 'express' && t.run) return 'express';
    if (U.screen === 'sw' && t.swRun) return 'sw';
    U.screen = 'home';
    return 'home';
  }

  function renderView() {
    var t = TD();
    var s = screenOf();
    if (s === 'home') return homeViewHtml();
    if (s === 'result') {
      var e = historyById(U.resultId);
      return e.kind === 'sw' ? swResultHtml(e) : expressResultHtml(e);
    }
    if (s === 'express') {
      var run = t.run;
      if (U.docError) return '<div class="rz-error">' + esc(U.docError) + '</div>' + btn('rz-test-home', 'Revenir aux bilans', 'btn-secondary');
      var need = [run.docs.stage1];
      if (run.phase === 'listen' && run.lis.stage === 2) need.push(stageDocId(run, 'L', 2));
      if (run.phase === 'read') { need.push(stageDocId(run, 'R', 1)); if (run.read.stage === 2) need.push(stageDocId(run, 'R', 2)); }
      if (!needDocs('toeic', need)) return '<section class="rz-card"><span class="rz-spin"></span> Chargement du bilan…</section>';
      if (U.finishPending) { setTimeout(finishExpress, 0); return '<section class="rz-card"><span class="rz-spin"></span> Calcul des résultats…</section>'; }
      var body = run.phase === 'intro' ? introHtml(run) : (run.phase === 'listen' ? listenHtml(run) : (run.phase === 'pause' ? pauseHtml(run) : readHtml(run)));
      return '<div class="rzt-exam is-' + esc(run.phase) + '">' + body + '</div>';
    }
    var sr = t.swRun;
    if (!needDocs('sw', [sr.docId])) return '<section class="rz-card"><span class="rz-spin"></span> Chargement du bilan…</section>';
    if (sr.phase === 'intro') return '<div class="rzt-exam">' + swIntroHtml(sr) + '</div>';
    if (sr.phase === 'grading') return '<div class="rzt-exam">' + swGradingHtml(sr) + '</div>';
    return '<div class="rzt-exam is-sw">' + swTaskHtml(sr) + '</div>';
  }

  /* Le clavier de la vue : 1-4 / A-D choisissent, Entrée avance, ← → naviguent, Espace met en pause. */
  function keydown(e, el) {
    var typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    var t = TD(), s = screenOf();
    if (e.key === 'Escape') {
      if (s === 'home') return false;
      if (typing && el.tagName === 'TEXTAREA') return false;
      examPause();
      U.screen = 'home';
      R.render();
      return true;
    }
    if (typing) return false;
    var k = e.key;
    var idx = /^[1-4]$/.test(k) ? +k - 1 : (/^[a-dA-D]$/.test(k) ? k.toLowerCase().charCodeAt(0) - 97 : -1);
    if (s === 'express') {
      var run = t.run;
      if (run.phase === 'intro' && k === 'Enter') { beginListening(); return true; }
      if (run.phase === 'pause' && k === 'Enter') { readStart(); return true; }
      if (run.phase === 'listen') {
        if (k === ' ') { if (run.paused) examResume(); else { examPause(); R.render(); } return true; }
        if (run.paused) return false;
        var set = curSet(run);
        if (!set) return false;
        var qs = arr(set.questions);
        var qi = +set.part === 2 ? 0 : (U.activeQ || 0);
        if (k === 'ArrowDown' || k === 'ArrowUp') { U.activeQ = Math.max(0, Math.min(qs.length - 1, qi + (k === 'ArrowDown' ? 1 : -1))); R.render(); return true; }
        if (idx >= 0 && qs[qi] && idx < arr(qs[qi].options).length) { lisAnswer(qKey(run, set, qs[qi], qi, 'L', run.lis.stage), idx); return true; }
        if (k === 'Enter' && run.lis.phase === 'answer') { lisNext(); return true; }
        return false;
      }
      if (run.phase === 'read') {
        if (k === ' ') { if (run.paused) examResume(); else { examPause(); R.render(); } return true; }
        if (run.paused) return false;
        var items = flat(run, 'R', run.read.stage);
        var cur = items[run.read.qi];
        if (idx >= 0 && cur && idx < arr(cur.q.options).length) { run.answers[cur.key] = idx; R.save(); R.render(); return true; }
        if (k === 'ArrowRight' || (k === 'Enter' && run.read.qi < items.length - 1)) { readGo(run.read.qi + 1); return true; }
        if (k === 'ArrowLeft') { readGo(run.read.qi - 1); return true; }
        if (k === 'Enter') { finishClick(); return true; }
      }
      return false;
    }
    if (s === 'sw') {
      var sr = t.swRun;
      if (sr.phase === 'intro' && k === 'Enter') { swBegin(); return true; }
      if (sr.phase === 'task' && sr.sub === 'prep' && k === 'Enter') { swStartRec(); return true; }
    }
    return false;
  }

  function beginListening() {
    var run = TD().run;
    if (!run || run.phase !== 'intro') return;
    run.phase = 'listen';
    run.startedAt = Date.now();
    run.lis = { stage: 1, i: 0, phase: 'ready', deadline: 0, rest: 0 };
    if (R.tts.ready() && window.bridge) {
      ['en-US', 'en-GB'].forEach(function (a) { bridge.call('ttsWarm', { accent: a }, 15000)['catch'](function () { /* facultatif */ }); });
    }
    lisPlay(false);
  }

  function finishClick() {
    var run = TD().run;
    if (!run || run.phase !== 'read') return;
    var items = flat(run, 'R', run.read.stage);
    var unanswered = items.filter(function (it) { return run.answers[it.key] == null; }).length;
    if (unanswered && !U.arm.rfinish) { arm('rfinish'); return; }
    U.arm.rfinish = false;
    readFinishStage(false);
  }

  function arm(name) {
    U.arm[name] = true;
    R.render();
    setTimeout(function () { if (U.arm[name]) { U.arm[name] = false; R.render(); } }, 5000);
  }

  /* ══ Minuteur commun ════════════════════════════════════════════════════ */

  function tick() {
    if (!R.isLoaded()) return;
    var t = TD();
    var run = t.run, sr = t.swRun;
    if (!run && !sr) return;
    var here = onTestsView();
    if (!here) {
      if ((run && !run.paused && (run.phase === 'listen' || run.phase === 'read')) || (sr && sr.phase === 'task' && !sr.paused)) examPause();
      return;
    }
    if (U.screen === 'home' || U.screen === 'result') {
      if ((run && !run.paused && (run.phase === 'listen' || run.phase === 'read')) || (sr && sr.phase === 'task' && !sr.paused)) examPause();
      return;
    }
    if (run && U.screen === 'express' && !run.paused) {
      if (run.phase === 'listen' && run.lis.phase === 'answer' && run.lis.deadline) {
        var left = run.lis.deadline - now();
        if (left <= 0) { lisNext(); return; }
        R.patch('[data-rzt-clock="lis"]', esc(clock(left)));
      }
      if (run.phase === 'read' && run.read.from) {
        var rem = readRemaining(run);
        if (rem <= 0) { U.flash = 'Temps écoulé : la lecture est terminée.'; readFinishStage(true); return; }
        R.patch('[data-rzt-clock="read"]', esc(clock(rem)));
        var box = document.querySelector('[data-rzt-clockbox="read"]');
        if (box) box.classList.toggle('is-low', rem < 120000);
        if (!U.lastCheckpoint || Date.now() - U.lastCheckpoint > 5000) {
          U.lastCheckpoint = Date.now();
          run.read.ms = readElapsed(run);
          run.read.from = now();
          R.save();
        }
      }
    }
    if (sr && U.screen === 'sw' && sr.phase === 'task' && !sr.paused) {
      var st = swCur(sr);
      if (!st) return;
      if (sr.sub === 'prep' && sr.deadline) {
        var l2 = sr.deadline - now();
        if (l2 <= 0) { swStartRec(); return; }
        R.patch('[data-rzt-clock="sw"]', esc(clock(l2)));
      } else if (sr.sub === 'rec') {
        var rs = R.recState('rzt-sw-rec-' + st.key);
        R.patch('[data-rzt-clock="swrec"]', esc(clock(st.rec * 1000 - num(rs.ms, 0))));
      } else if (sr.sub === 'write') {
        var r3 = st.minutes * 60000 - swWriteElapsed(sr);
        if (r3 <= 0) { swSubmitWrite(true); return; }
        R.patch('[data-rzt-clock="sw"]', esc(clock(r3)));
        var b2 = document.querySelector('[data-rzt-clockbox="sw"]');
        if (b2) b2.classList.toggle('is-low', r3 < 60000);
        if (!U.lastWriteSave || Date.now() - U.lastWriteSave > 5000) { U.lastWriteSave = Date.now(); sr.wms = swWriteElapsed(sr); sr.wfrom = now(); R.save(); }
      }
    }
  }
  setInterval(tick, 250);

  /* ══ Actions ════════════════════════════════════════════════════════════ */

  R.act('rz-test-prep', function () { prepStart(); });
  R.act('rz-test-prep-cancel', function () { prepCancel(); });
  R.act('rz-test-prep-retry', function (el) { var m = el.getAttribute('data-module'); if (TD().prep) { launchModule(m); R.save(); R.render(); } });
  R.act('rz-test-start', function () { runStart(); });
  R.act('rz-test-open', function () { U.screen = 'express'; examPause(); R.render(); });
  R.act('rz-test-begin', function () { beginListening(); });
  R.act('rz-test-abandon', function () { if (!U.arm.abandon) { arm('abandon'); return; } U.arm.abandon = false; runAbandon(); });
  R.act('rz-test-home', function () { examPause(); U.screen = 'home'; U.flash = ''; R.render(); });
  R.act('rz-test-progress', function () { R.go('progress'); });
  R.act('rz-test-result', function (el) { U.screen = 'result'; U.resultId = el.getAttribute('data-id'); U.rvOpen = {}; R.render(); window.scrollTo(0, 0); });
  R.act('rz-test-hist-more', function () { U.histAll = !U.histAll; R.render(); });
  R.act('rz-test-ans', function (el, ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    var run = TD().run;
    if (!run || run.paused) return;
    var key = el.getAttribute('data-key'), i = +el.getAttribute('data-i');
    if (run.phase === 'listen') {
      var q = el.closest ? el.closest('[data-q]') : null;
      if (q) U.activeQ = +q.getAttribute('data-q');
      lisAnswer(key, i);
    } else if (run.phase === 'read') { run.answers[key] = i; R.save(); R.render(); }
  });
  R.act('rz-test-active', function (el) { U.activeQ = +el.getAttribute('data-q'); R.render(); });
  R.act('rz-test-next', function () { lisNext(); });
  R.act('rz-test-pause', function () { examPause(); R.render(); });
  R.act('rz-test-resume', function () {
    var run = TD().run;
    if (run && run.phase === 'listen' && !run.paused && run.lis.phase === 'ready') { lisPlay(false); return; }
    if (run && run.phase === 'listen' && !run.paused && run.lis.phase === 'cut') { lisPlay(true); return; }
    examResume();
  });
  R.act('rz-test-replay', function () { lisPlay(true); });
  R.act('rz-test-read', function () { readStart(); });
  R.act('rz-test-rgo', function (el) { readGo(+el.getAttribute('data-qi')); });
  R.act('rz-test-rprev', function () { var run = TD().run; if (run) readGo(run.read.qi - 1); });
  R.act('rz-test-rnext', function () { var run = TD().run; if (run) readGo(run.read.qi + 1); });
  R.act('rz-test-rfinish', function () { finishClick(); });

  R.act('rz-test-sw-prep', function () { swPrepStart(); });
  R.act('rz-test-sw-retry', function () { TD().swPrep = null; swPrepStart(); });
  R.act('rz-test-sw-cancel', function () { swPrepCancel(); });
  R.act('rz-test-sw-start', function () { swStart(); });
  R.act('rz-test-sw-open', function () { U.screen = 'sw'; R.render(); });
  R.act('rz-test-sw-begin', function () { swBegin(); });
  R.act('rz-test-sw-go', function () { swStartRec(); });
  R.act('rz-test-sw-skip', function () { swSkip(); });
  R.act('rz-test-sw-submit', function () { swSubmitWrite(false); });
  R.act('rz-test-sw-pause', function () { swPause(); R.render(); });
  R.act('rz-test-sw-resume', function () {
    var sr = TD().swRun;
    if (sr && !sr.paused && sr.sub === 'ready') { swEnterStep(); return; }
    swResume();
  });
  R.act('rz-test-sw-regrade', function () { var sr = TD().swRun; if (!sr) return; Object.keys(sr.gradeErrors).forEach(function (k) { delete sr.gradeErrors[k]; gradeEnqueue(k); }); R.render(); });
  R.act('rz-test-sw-abandon', function () { if (!U.arm.swAbandon) { arm('swAbandon'); return; } U.arm.swAbandon = false; swAbandon(); });

  R.act('rz-test-cal-open', function () { U.calOpen = true; U.calError = ''; if (!U.cal.date) U.cal.date = R.today(); R.render(); });
  R.act('rz-test-cal-close', function () { U.calOpen = false; U.calError = ''; R.render(); });
  R.act('rz-test-cal-save', function () { calSave(); });
  R.act('rz-test-cal-del', function (el) {
    var s = el.getAttribute('data-s'), i = +el.getAttribute('data-i');
    var list = TD().calib[s];
    if (list && list[i]) { list.splice(i, 1); R.save(true); R.render(); }
  });

  R.input('rz-test-cal', function (el) { U.cal[el.getAttribute('data-field')] = el.value; });
  R.change('rz-test-cal', function (el) { U.cal[el.getAttribute('data-field')] = el.value; });
  R.change('rz-test-sw-essay', function (el) { U.swEssay = !!el.checked; });
  R.input('rz-test-sw-text', function (el) {
    var sr = TD().swRun;
    if (!sr) return;
    var key = el.getAttribute('data-key');
    var r = sr.responses[key] = sr.responses[key] || { text: '' };
    r.text = el.value.slice(0, 8000);
    R.save();
    var st = swCur(sr);
    if (st) R.patch('[data-rzt-wc="' + key + '"]', esc(wcText(st, r.text)));
  });

  /* ══ Événements ═════════════════════════════════════════════════════════ */

  R.on('loaded', function () {
    var t = TD();
    /* Un rechargement interrompt l'examen : il reprend en pause, au début de l'ensemble d'écoute en cours. */
    if (t.run) {
      if (t.run.phase === 'listen') { t.run.paused = true; if (t.run.lis.phase === 'audio') t.run.lis.phase = 'cut'; if (t.run.lis.phase === 'answer') { t.run.lis.rest = 4000; t.run.lis.deadline = 0; } }
      if (t.run.phase === 'read') { t.run.paused = true; t.run.read.from = 0; }
    }
    if (t.swRun && t.swRun.phase === 'task') {
      t.swRun.paused = true;
      t.swRun.wfrom = 0;
      if (t.swRun.sub !== 'write') t.swRun.sub = 'ready';
    }
    if (t.swRun && t.swRun.phase === 'grading') setTimeout(function () {
      var sr = TD().swRun;
      if (!sr) return;
      swAnswerUnits(swSteps(swDoc(sr) || {}, sr.withEssay)).forEach(function (u) { if (!sr.grades[u.key] && !(sr.gradeJobs[u.key] && R.jobById(sr.gradeJobs[u.key]))) gradeEnqueue(u.key); });
    }, 4500);
    if (t.swRun) needDocs('sw', [t.swRun.docId]);
    if (t.run) needDocs('toeic', runDocIds(t.run));
    /* Rouverte sur les Bilans, la page montre directement l'examen interrompu (en pause). */
    if (U.screen === 'home' && t.run && t.run.startedAt) U.screen = 'express';
    else if (U.screen === 'home' && t.swRun && t.swRun.startedAt) U.screen = 'sw';
    setTimeout(function () { U.reattachDone = true; R.renderSoon(); }, 4000);
  });

  R.on('jobDone', function (ev) {
    if (!ev) return;
    var t = TD();
    if (ev.kind === 'toeic' && ev.result && ev.result.doc) {
      var m = ev.result.doc.module;
      if (ev.reattached && m) moduleDone(m, ev.job, ev.result);
    } else if (ev.kind === 'sw' && ev.reattached && ev.result) {
      swPrepDone(ev.job, ev.result);
    } else if (ev.kind === 'grade' && ev.reattached && ev.result && t.swRun) {
      var sr = t.swRun;
      Object.keys(sr.gradeJobs).forEach(function (k) { if (sr.gradeJobs[k] === ev.job) { setGrade(sr, k, ev.result.doc); swMaybeFinalize(); } });
    }
  });

  /* ══ Simulations pour le navigateur ═════════════════════════════════════ */

  function fallbackModule(module) {
    var lv = module === 'easy' ? 'A2' : (module === 'hard' ? 'B2' : 'B1');
    var p2 = function (i) {
      return { id: 's' + i, section: 'L', part: 2, topic: 'office', intro: '', speakers: [{ id: 'W1', role: 'colleague', gender: 'female', accent: 'en-GB' }, { id: 'M1', role: 'colleague', gender: 'male', accent: 'en-US' }],
        audio: [{ speaker: 'W1', text: 'Could you send me the agenda for tomorrow’s meeting?' }], documents: [], graphic: null,
        questions: [{ id: 'q1', stem: '', options: ['Sure, I’ll email it right away.', 'It was a long meeting.', 'Tomorrow is Friday.'], answer: 0, ability: 'L_gist_short', cefr: lv, features: [], evidence: 'I’ll email it right away.', explanationFr: 'Seule A répond à la demande.' }] };
    };
    var p5 = function (i) {
      return { id: 's' + i, section: 'R', part: 5, topic: 'office', intro: '', speakers: [], audio: [], documents: [], graphic: null,
        questions: [{ id: 'q1', stem: 'Please submit your expense report ------- Friday.', options: ['by', 'until', 'since', 'during'], answer: 0, ability: 'R_grammar', cefr: lv, features: [], evidence: '', explanationFr: '« by » : au plus tard.' }] };
    };
    var L = [], Rr = [], i;
    for (i = 1; i <= (module === 'stage1' ? 11 : 12); i++) L.push(p2(i));
    for (i = 1; i <= 10; i++) Rr.push(p5(100 + i));
    return { kind: 'toeic', module: module, center: 'B1', listening: L, reading: Rr };
  }

  function fetchJson(url) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('pas de fetch'));
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  R.fixture('toeic', function (p) {
    var m = p && /^(stage1|easy|hard)$/.test(p.module) ? p.module : 'stage1';
    return fetchJson('revizator/fixtures/toeic-' + m + '.json').then(function (d) { d.module = m; d.center = (p && p.center) || d.center; return d; }, function () { return fallbackModule(m); });
  });
  R.fixture('sw', function (p) {
    return fetchJson('revizator/fixtures/sw.json').then(function (d) {
      if (!(p && p.withEssay)) d.writing = arr(d.writing).filter(function (w) { return w.task !== 'essay'; });
      d.level = (p && p.level) || d.level;
      return d;
    }, function () {
      return { kind: 'sw', level: 'B1', speaking: [{ id: 'sp1', task: 'opinion', promptFr: 'Donnez votre opinion.', prompt: 'Do you prefer working in an office or from home? Why?', text: '', questions: [], info: null, prepSeconds: 45, speakSeconds: [60], scale: 5 }],
        writing: [{ id: 'wr1', task: 'email', promptFr: 'Répondez à l’e-mail.', prompt: 'Reply to the e-mail and ask two questions.', words: [], situation: '', email: { from: 'Sam', subject: 'Team lunch', body: 'Shall we organise a team lunch next week?' }, minutes: 10, scale: 4 }] };
    });
  });

  /* ══ Enregistrement ═════════════════════════════════════════════════════ */

  R.view('tests', {
    label: 'Bilans', icon: 'flag', order: 40, title: 'Bilans — mesurer votre niveau (format type TOEIC®)',
    render: renderView,
    after: function (host) {
      if (U.focusWrite) {
        U.focusWrite = false;
        var ta = host.querySelector('.rzt-sw-area');
        if (ta && document.activeElement !== ta) ta.focus({ preventScroll: true });
      }
      var dets = host.querySelectorAll('[data-rzt-rv]');
      for (var i = 0; i < dets.length; i++) {
        if (dets[i].__rzt) continue;
        dets[i].__rzt = true;
        dets[i].addEventListener('toggle', function () { U.rvOpen = U.rvOpen || {}; U.rvOpen[this.getAttribute('data-rzt-rv')] = this.open; });
      }
    },
    onShow: function (params) {
      var t = TD();
      if (params && params.id && historyById(params.id)) { U.screen = 'result'; U.resultId = params.id; return; }
      if (U.screen === 'result') return;
      if (t.run && t.run.startedAt) U.screen = 'express';
      else if (t.swRun && t.swRun.startedAt) U.screen = 'sw';
    },
    onHide: function () { examPause(); },
    keydown: keydown
  });

  R.homeCard({ id: 'tests', area: 'side', order: 70, html: function () {
    var t = TD();
    var e = lastOf('express');
    var h = ['<section class="rz-card rzt-home"><div class="rz-card-head"><span class="rz-card-title">Bilans</span>' + R.icon('flag') + '</div>'];
    if (t.run) {
      h.push('<div class="rzt-home-line">Un bilan express est en cours.</div><div>' + btn('rz-test-home-open', 'Reprendre le bilan ' + R.icon('arrow'), 'btn-primary') + '</div>');
    } else if (t.prep && t.prep.readyAt) {
      h.push('<div class="rzt-home-line">Votre bilan express est prêt : 27 minutes.</div><div>' + btn('rz-test-home-open', 'Commencer ' + R.icon('arrow'), 'btn-primary') + '</div>');
    } else if (t.prep) {
      var done = ['stage1', 'easy', 'hard'].filter(function (m) { return t.prep.docs[m]; }).length;
      h.push('<div class="rzt-home-line">Bilan express en préparation · ' + done + ' / 3</div>' + R.h.progress(done / 3, 'Préparation'));
    } else if (e) {
      var prev = t.history.filter(function (x) { return x.kind === 'express' && x.at < e.at; }).slice(-1)[0];
      var delta = prev ? e.total.score - prev.total.score : null;
      var days = Math.ceil((e.at + NEXT_EXPRESS_DAYS * 86400000 - Date.now()) / 86400000);
      h.push('<div class="rzt-home-score"><b>' + e.total.score + '</b><span> / 990</span>' + R.h.level(e.total.cefr) + '</div>'
        + '<div class="rzt-home-line rz-muted">' + esc(scoreRange(e.total.ci90)) + ' · ' + esc(frShort(e.at))
        + (delta != null ? ' · <span class="' + (delta >= 0 ? 'rzt-up' : 'rzt-down') + '">' + (delta >= 0 ? '↗ ' : '↘ ') + signed(delta) + '</span>' : '') + '</div>'
        + '<div class="rzt-home-line">' + esc(days > 0 ? 'Prochain bilan conseillé dans ' + nextLabel(days) + '.' : 'Un nouveau bilan est conseillé.') + '</div>'
        + '<div>' + btn('rz-test-home-open', days > 0 ? 'Voir les bilans' : 'Préparer un bilan', days > 0 ? 'btn-secondary' : 'btn-primary') + '</div>');
    } else {
      h.push('<div class="rzt-home-line">Faites votre premier bilan : 27 minutes pour situer votre écoute et votre lecture sur l’échelle 10-990.</div>'
        + '<div>' + btn('rz-test-home-open', 'Faire mon premier bilan ' + R.icon('arrow'), 'btn-primary') + '</div>');
    }
    h.push('<p class="rzt-mention is-small">' + esc(MENTION) + '</p></section>');
    return h.join('');
  } });
  R.act('rz-test-home-open', function () {
    var t = TD();
    U.screen = t.run ? 'express' : 'home';
    R.go('tests');
  });

  R.toeic = {
    CFG: CFG, estimateSection: estimateSection, combineTotal: combineTotal, routeStage2: routeStage2, weakPoints: weakPoints,
    kalman: kalman, calibrationOffset: calibrationOffset, estimateProductive: estimateProductive, thetaOfScore: thetaOfScore,
    cefrLabel: cefrLabel, pCorrect: pCorrect, difficulty: difficulty, MENTION: MENTION, ABILITIES: ABILITIES, PARTS: PARTS,
    /* Pour les tests : avancer l'horloge des minuteurs, lire l'état. */
    _skip: function (ms) { U.skew += ms; tick(); },
    _center: centerLevel,
    _tick: tick,
    _state: function () { return U; }
  };
})();
