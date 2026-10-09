/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — rendu et correction des items d'exercice · module U1a
   Les quinze genres d'items de la spec §5.3 : choice, truefalse, gap, transform, translate, order, error_spot,
   dictation, partial_dictation, minimal_pair, stress, shadow, read_aloud, open_write, open_speak.
   Correction automatique tolérante (R.text.match, règle 33), feedback immédiat, « Ajouter aux cartes »,
   correction par Claude pour l'écrit et l'oral libres. Styles : exercise.css (préfixe .rzx-).

   ── API ───────────────────────────────────────────────────────────────────
     R.items.check(item, answer) → { verdict: 'exact'|'close'|'wrong', score: 0..1, expected, gaps?, align? }
       answer selon le genre : texte de l'option ou son indice (choice), 'true'|'false'|'not_given' (truefalse),
       texte ou liste de textes, un par trou (gap, partial_dictation), texte (transform, translate, error_spot,
       dictation), indices des fragments ou phrase (order), mot (minimal_pair), indice de syllabe (stress),
       transcription enrichie de R.stt ou texte (shadow, read_aloud), correction §5.6 (open_write, open_speak).
     R.items.html(setKey, item, index, state?) → HTML d'un item (l'état est gardé dans R.ui.items[setKey].answers[index])
     R.items.start(setKey, items, { onDone(summary), onAnswer(index, result, item), onChange(snapshot), level, skill,
                   type, ref, origin, resume: snapshot }) → série (un item à la fois, progression, navigation)
     R.items.seriesHtml(setKey) → l'item courant avec sa navigation, ou le bilan ; R.items.summaryHtml(setKey)
     R.items.state(setKey) ; R.items.summary(setKey) → { total, answered, exact, close, wrong, skipped, scored, score, activeMs, minutes, items }
     R.items.snapshot(setKey) → état sérialisable (reprise) ; R.items.go(setKey, i) / next / prev / finish
     R.items.keydown(e, el) → bool (Entrée vérifie puis passe à la suite, 1-9 choisit, ← → naviguent, Ctrl+Entrée envoie un écrit)
     R.items.cardSpec(setKey, index) → carte proposée pour un item (ou null) ; R.items.align(ref, hyp) ; R.items.normItem(item)
   Chaque réponse corrigée automatiquement appelle R.observe(compétence, niveau de la série, score) une fois (premier essai).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R) return;
  var esc = R.esc;
  var U = R.ui.items = R.ui.items || {};

  var KINDS = ['choice', 'truefalse', 'gap', 'transform', 'translate', 'order', 'error_spot', 'dictation', 'partial_dictation',
    'minimal_pair', 'stress', 'shadow', 'read_aloud', 'open_write', 'open_speak'];
  var CLICK = { choice: 1, truefalse: 1, minimal_pair: 1, stress: 1 };
  var TYPED = { gap: 1, transform: 1, translate: 1, error_spot: 1, dictation: 1, partial_dictation: 1 };
  var SPEECH = { shadow: 1, read_aloud: 1 };
  var OPEN = { open_write: 1, open_speak: 1 };
  var ALIAS = { mcq: 'choice', qcm: 'choice', multiple_choice: 'choice', true_false: 'truefalse', tf: 'truefalse', gap_fill: 'gap', cloze: 'gap',
    fill: 'gap', reorder: 'order', error: 'error_spot', minimal_pairs: 'minimal_pair', shadowing: 'shadow', write: 'open_write', speak: 'open_speak' };
  var KICKER = {
    choice: 'Choisissez la bonne réponse', gap: 'Complétez', transform: 'Transformez', translate: 'Traduisez en anglais',
    order: 'Remettez dans l’ordre', error_spot: 'Une erreur s’est glissée : corrigez-la', dictation: 'Dictée : écrivez ce que vous entendez',
    partial_dictation: 'Dictée à trous', minimal_pair: 'Quel mot entendez-vous ?', stress: 'Où est l’accent ?',
    shadow: 'Écoutez, puis répétez juste après la voix', read_aloud: 'Lisez à voix haute', open_write: 'À vous d’écrire', open_speak: 'À vous de parler'
  };
  var TF = [['true', 'Vrai', 'True'], ['false', 'Faux', 'False'], ['not_given', 'Non dit', 'Not given']];

  function arr(v) { return Array.isArray(v) ? v : []; }
  function s(v) { return v == null ? '' : String(v); }
  function round2(x) { return Math.round(x * 100) / 100; }
  function gapCount(p) { return (s(p).match(/_{2,}/g) || []).length; }
  function eqText(a, b) { return R.text.normLoose(a) === R.text.normLoose(b); }
  function scoreOf(v) { return v === 'exact' ? 1 : (v === 'close' ? 0.75 : 0); }
  function verdictOf(x) { return x >= 0.999 ? 'exact' : (x >= 0.6 ? 'close' : 'wrong'); }
  function splitBar(t) { return s(t).split(/\s*\|\s*/); }
  function tfNorm(v) {
    var t = s(v).toLowerCase().replace(/[_\s-]+/g, ' ').trim();
    if (/^(true|vrai|t|yes|oui|1)$/.test(t)) return 'true';
    if (/^(false|faux|f|no|non|0)$/.test(t)) return 'false';
    if (/^(not given|non dit|ng|nd|not mentioned|doesn t say)$/.test(t)) return 'not_given';
    return t.replace(/ /g, '_');
  }

  function normItem(it) {
    it = it || {};
    var o = {
      id: s(it.id), kind: s(it.kind).toLowerCase(), prompt: s(it.prompt), promptFr: s(it.promptFr), options: arr(it.options).map(s),
      answer: it.answer === true ? 'true' : (it.answer === false ? 'false' : s(it.answer)), accepted: arr(it.accepted).map(s).filter(Boolean),
      explanationFr: s(it.explanationFr), audioText: s(it.audioText), words: arr(it.words).map(s), seconds: Number(it.seconds) || 0,
      criteria: arr(it.criteria).map(s), modelAnswer: s(it.modelAnswer)
    };
    if (ALIAS[o.kind]) o.kind = ALIAS[o.kind];
    if (KINDS.indexOf(o.kind) < 0) o.kind = o.options.length ? 'choice' : 'gap';
    if (o.kind === 'gap' && o.options.length) o.kind = 'choice';            /* trou avec banque de mots */
    if (o.kind === 'truefalse') o.answer = tfNorm(o.answer);
    if (o.kind === 'choice' && o.options.length && !o.options.some(function (x) { return eqText(x, o.answer); }) && /^\d+$/.test(o.answer) && o.options[+o.answer] != null) o.answer = o.options[+o.answer];
    if (o.kind === 'minimal_pair' && !o.words.length && o.options.length) o.words = o.options.slice(0, 2);
    return o;
  }

  /* ── Alignement mot à mot (repli quand l'hôte n'en fournit pas) ── */
  function wordsOf(t) { return R.text.normLoose(t).split(' ').filter(Boolean); }
  function align(refText, hypText) {
    var a = wordsOf(refText), b = wordsOf(hypText), n = a.length, m = b.length, i, j;
    var D = [];
    for (i = 0; i <= n; i++) { D[i] = new Array(m + 1); D[i][0] = i; }
    for (j = 0; j <= m; j++) D[0][j] = j;
    for (i = 1; i <= n; i++) for (j = 1; j <= m; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    var ops = [];
    i = n; j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { ops.unshift({ op: a[i - 1] === b[j - 1] ? 'ok' : 'sub', ref: a[i - 1], hyp: b[j - 1] }); i--; j--; }
      else if (i > 0 && D[i][j] === D[i - 1][j] + 1) { ops.unshift({ op: 'del', ref: a[i - 1], hyp: '' }); i--; }
      else { ops.unshift({ op: 'ins', ref: '', hyp: b[j - 1] }); j--; }
    }
    var c = { ok: 0, sub: 0, del: 0, ins: 0 };
    ops.forEach(function (o) { c[o.op]++; });
    return { ops: ops, accuracy: n ? round2(c.ok / n) : 0, wer: n ? round2((c.sub + c.del + c.ins) / n) : (m ? 1 : 0) };
  }

  /* ══ Correction ═════════════════════════════════════════════════════════ */

  function checkGaps(it, answer) {
    var n = Math.max(1, gapCount(it.prompt));
    var vals = Array.isArray(answer) ? answer.map(s) : splitBar(answer);
    var parts = splitBar(it.answer);
    var acc = it.accepted.map(splitBar);
    if (parts.length !== n) {
      var whole = parts.join(' ');
      var v0 = R.text.match(vals.join(' '), whole, it.accepted.map(function (a) { return splitBar(a).join(' '); }));
      return { verdict: v0, score: scoreOf(v0), expected: whole, gaps: [] };
    }
    var gaps = [], total = 0;
    for (var i = 0; i < n; i++) {
      var cand = [parts[i]].concat(acc.map(function (a) { return a.length === n ? a[i] : null; }).filter(Boolean));
      var v = R.text.match(vals[i] || '', cand[0], cand.slice(1));
      gaps.push({ verdict: v, expected: parts[i] });
      total += scoreOf(v);
    }
    var sc = round2(total / n);
    return { verdict: verdictOf(sc), score: sc, expected: parts.join(' … '), gaps: gaps };
  }
  function joinFragments(list) { return list.join(' ').replace(/\s+([,.;:!?])/g, '$1').replace(/\s+/g, ' ').trim(); }
  function gradeScore(g, mode) {
    var sc = (g && g.scores) || {};
    var keys = ['task', 'coherence', 'range', 'accuracy'].concat(mode === 'speak' ? ['fluency'] : []);
    var t = 0;
    keys.forEach(function (k) { t += R.clamp(Number(sc[k]) || 0, 0, 5); });
    return round2(t / (keys.length * 5));
  }

  function check(item, answer) {
    var it = item && item.__n ? item : normItem(item);
    var k = it.kind, v, sc;
    switch (k) {
      case 'choice': {
        var a = typeof answer === 'number' ? it.options[answer] : answer;
        v = eqText(a, it.answer) ? 'exact' : 'wrong';
        return { verdict: v, score: scoreOf(v), expected: it.answer };
      }
      case 'truefalse':
        v = tfNorm(answer) === it.answer ? 'exact' : 'wrong';
        return { verdict: v, score: scoreOf(v), expected: it.answer };
      case 'gap': case 'partial_dictation':
        return checkGaps(it, answer);
      case 'transform': case 'translate': case 'error_spot': {
        v = R.text.match(answer, it.answer, it.accepted);
        if (k === 'error_spot' && v !== 'exact' && eqText(answer, it.prompt)) v = 'wrong';
        var al = align(it.answer, answer);
        return { verdict: v, score: scoreOf(v), expected: it.answer, wer: al.wer };
      }
      case 'order': {
        var text = Array.isArray(answer) ? joinFragments(answer.map(function (x) { return typeof x === 'number' ? it.options[x] : x; })) : s(answer);
        v = R.text.match(text, it.answer, it.accepted);
        return { verdict: v, score: scoreOf(v), expected: it.answer, text: text };
      }
      case 'dictation': {
        var ref = it.answer || it.audioText;
        var m = R.text.match(answer, ref, it.accepted);
        var dal = align(ref, answer);
        v = m === 'exact' || dal.wer === 0 ? 'exact' : (m === 'close' || dal.wer <= 0.2 ? 'close' : 'wrong');
        sc = v === 'exact' ? 1 : Math.max(0, 1 - dal.wer);
        if (m === 'close') sc = Math.max(sc, 0.8);
        return { verdict: v, score: round2(sc), expected: ref, wer: dal.wer, align: dal };
      }
      case 'minimal_pair':
        v = eqText(answer, it.answer) ? 'exact' : 'wrong';
        return { verdict: v, score: scoreOf(v), expected: it.answer };
      case 'stress': {
        var idx = typeof answer === 'number' ? answer : (/^\d+$/.test(s(answer)) ? +answer : it.options.map(function (o) { return o.toLowerCase(); }).indexOf(s(answer).toLowerCase()));
        v = String(idx) === String(+it.answer) ? 'exact' : 'wrong';
        return { verdict: v, score: scoreOf(v), expected: it.answer };
      }
      case 'shadow': case 'read_aloud': {
        var refT = k === 'shadow' ? (it.audioText || it.prompt) : (it.prompt || it.audioText);
        var stt = answer && typeof answer === 'object' ? answer : { text: s(answer) };
        var al2 = stt.alignment && arr(stt.alignment.ops).length ? stt.alignment : align(refT, stt.text);
        sc = round2(R.clamp(Number(al2.accuracy) || 0, 0, 1));
        return { verdict: sc >= 0.9 ? 'exact' : (sc >= 0.7 ? 'close' : 'wrong'), score: round2(sc), expected: refT, align: al2 };
      }
      case 'open_write': case 'open_speak': {
        if (!answer || typeof answer !== 'object') return { verdict: 'wrong', score: 0, expected: it.modelAnswer, pending: true };
        sc = gradeScore(answer, k === 'open_speak' ? 'speak' : 'write');
        return { verdict: sc >= 0.75 ? 'exact' : (sc >= 0.5 ? 'close' : 'wrong'), score: sc, expected: it.modelAnswer };
      }
    }
    return { verdict: 'wrong', score: 0, expected: it.answer };
  }

  /* ══ État ═══════════════════════════════════════════════════════════════ */

  function blank() {
    return { values: [], picked: null, order: [], checked: false, skipped: false, res: null, first: null, score: null, hint: false, self: false, carded: '',
      text: '', transcript: '', audioSeconds: 0, stt: null, grade: null, gradeJob: '', gradeErr: '', cardsAdded: 0, ask: null, retried: 0 };
  }
  function newSet(key, items, opts, series) {
    var now = Date.now();
    var set = { key: key, items: [], raw: [], answers: {}, index: 0, opts: opts || {}, startedAt: now, lastAt: now, activeMs: 0, done: false, series: !!series, notified: false };
    arr(items).forEach(function (it, i) { set.raw[i] = it; set.items[i] = mark(normItem(it)); });
    set.tfNG = set.items.some(function (it) { return it.kind === 'truefalse' && it.answer === 'not_given'; });
    return set;
  }
  function mark(it) { Object.defineProperty(it, '__n', { value: true, enumerable: false }); return it; }
  function ist(set, i) { return set.answers[i] || (set.answers[i] = blank()); }
  function touch(set) {
    var now = Date.now();
    set.activeMs += Math.min(Math.max(0, now - set.lastAt), 120000);
    set.lastAt = now;
  }
  function skillOf(set, it) {
    var k = it.kind, sk = set.opts.skill;
    if (k === 'dictation' || k === 'partial_dictation' || k === 'minimal_pair' || k === 'stress') return 'listen';
    if (k === 'shadow' || k === 'read_aloud' || k === 'open_speak') return 'speak';
    if (k === 'open_write') return 'write';
    if (sk === 'read' || sk === 'listen' || sk === 'write' || sk === 'lang') return sk;
    if (sk === 'speak') return k === 'choice' || k === 'truefalse' ? 'listen' : 'lang';
    if (sk === 'pron') return 'listen';
    return 'lang';
  }
  function levelOf(set, skill) {
    var l = set.opts.level;
    return l && R.thetaOf(l) != null ? l : R.level(skill).band;
  }
  function changed(set) {
    var fn = set.opts.onChange;
    if (fn) { try { fn(snapshot(set.key)); } catch (e) { if (window.console) console.error(e); } }
  }

  /* Une réponse corrigée : résultat affiché, compétence observée au premier essai, rappel du module. */
  function record(set, i, res) {
    var st = ist(set, i), it = set.items[i];
    st.res = res; st.checked = true;
    touch(set);
    if (st.first == null) {
      st.first = res.score; st.score = res.score;
      if (!OPEN[it.kind]) {
        var sk = skillOf(set, it);
        R.observe(sk, levelOf(set, sk), res.score, SPEECH[it.kind] ? 0.5 : 1);
      }
    }
    var fn = set.opts.onAnswer;
    if (fn) { try { fn(i, res, it); } catch (e) { if (window.console) console.error(e); } }
    changed(set);
  }

  function answerOf(set, i) {
    var it = set.items[i], st = ist(set, i);
    if (it.kind === 'gap' || it.kind === 'partial_dictation') {
      var n = Math.max(1, gapCount(it.prompt));
      var v = []; for (var g = 0; g < n; g++) v.push(st.values[g] || '');
      return v;
    }
    if (it.kind === 'order') return st.order.slice();
    return st.values[0] || '';
  }
  function filled(set, i) {
    var it = set.items[i], st = ist(set, i);
    if (it.kind === 'order') return st.order.length === it.options.length && it.options.length > 0;
    var a = answerOf(set, i);
    return Array.isArray(a) ? a.some(function (x) { return String(x).trim(); }) : !!String(a).trim();
  }
  function doCheck(set, i) {
    var it = set.items[i], st = ist(set, i);
    if (!it || st.checked) return false;
    if (it.kind === 'order' && !filled(set, i)) { R.toast('Placez tous les morceaux avant de vérifier.'); return false; }
    if (TYPED[it.kind] && !filled(set, i)) { R.toast('Écrivez une réponse, ou passez la question.'); return false; }
    record(set, i, check(it, answerOf(set, i)));
    return true;
  }

  /* ══ Rendu d'un item ════════════════════════════════════════════════════ */

  function da(set, i) { return ' data-set="' + esc(set.key) + '" data-idx="' + i + '"'; }
  function fk(set, i, g) { return 'rzi-' + set.key + '-' + i + '-' + (g || 0); }
  function pkey(set, i, sub) { return 'rzi-' + set.key + '-' + i + (sub ? '-' + sub : ''); }
  function voiceFor(i) { return { accent: i % 2 ? 'en-GB' : 'en-US', gender: Math.floor(i / 2) % 2 ? 'male' : 'female', n: Math.floor(i / 4) }; }
  function sayer(key, text, i) {
    return function () { var v = voiceFor(i); return R.tts.say(text, { key: key, accent: v.accent, gender: v.gender, n: v.n }); };
  }
  function blanks(h, fills) {
    var k = 0;
    return h.replace(/_{2,}/g, function () {
      var f = fills && fills[k++];
      return f ? '<span class="rzx-blank is-filled">' + esc(f) + '</span>' : '<span class="rzx-blank" aria-label="trou"></span>';
    });
  }
  function vcls(v) { return v === 'exact' ? 'is-right' : (v === 'close' ? 'is-close' : 'is-wrong'); }

  function itemHtml(set, i) {
    var it = set.items[i];
    if (!it) return '';
    var st = ist(set, i), k = it.kind, h = [];
    var kick = k === 'truefalse' ? (set.tfNG ? 'Vrai, faux ou non dit ?' : 'Vrai ou faux ?') : KICKER[k];
    h.push('<div class="rzx-it is-' + k + (st.checked ? ' is-checked ' + vcls(st.res && st.res.verdict) : '') + '" data-rzx-item="' + esc(set.key) + '" data-idx="' + i + '">');
    h.push('<div class="rzx-it-kicker">' + esc(kick) + '</div>');
    if (CLICK[k]) h.push(clickHtml(set, i, it, st));
    else if (TYPED[k]) h.push(typedHtml(set, i, it, st));
    else if (k === 'order') h.push(orderHtml(set, i, it, st));
    else if (SPEECH[k]) h.push(speechHtml(set, i, it, st));
    else if (k === 'open_write') h.push(writeHtml(set, i, it, st));
    else if (k === 'open_speak') h.push(speakHtml(set, i, it, st));
    if (st.checked && !OPEN[k]) h.push(fbHtml(set, i, it, st));
    h.push('</div>');
    return h.join('');
  }

  function clickHtml(set, i, it, st) {
    var k = it.kind, h = [];
    var opts;
    if (k === 'choice') {
      h.push('<div class="rzx-it-prompt" lang="en">' + blanks(esc(it.prompt), st.checked && gapCount(it.prompt) ? [it.answer] : null) + '</div>');
      if (it.promptFr) h.push('<div class="rzx-it-fr">' + esc(it.promptFr) + '</div>');
      opts = it.options.map(function (o, x) { return { value: String(x), label: o, right: eqText(o, it.answer) }; });
    } else if (k === 'truefalse') {
      h.push('<div class="rzx-it-prompt is-statement" lang="en">' + esc(it.prompt) + '</div>');
      var tf = it.options.length >= 2 ? it.options.map(function (o) { var n = tfNorm(o); var t = TF.filter(function (x) { return x[0] === n; })[0]; return t || [n, o, '']; }) : TF.slice(0, set.tfNG ? 3 : 2);
      opts = tf.map(function (t) { return { value: t[0], label: t[1], sub: t[2], right: t[0] === it.answer }; });
    } else if (k === 'minimal_pair') {
      h.push('<div class="rzx-it-listen">' + R.h.player(pkey(set, i), { label: 'Écouter', source: sayer(pkey(set, i), it.audioText || it.answer, i) }) + '</div>');
      opts = it.words.slice(0, 2).map(function (w) { return { value: w, label: w, right: eqText(w, it.answer), big: true }; });
    } else {
      h.push('<div class="rzx-it-word" lang="en">' + (st.checked ? stressed(it) : esc(it.prompt)) + '</div>');
      h.push('<div class="rzx-it-listen">' + R.h.player(pkey(set, i), { label: 'Écouter le mot', small: true, speeds: false, source: sayer(pkey(set, i), it.audioText || it.prompt, i) }) + '</div>');
      opts = it.options.map(function (o, x) { return { value: String(x), label: o, right: String(x) === String(+it.answer), syl: true }; });
    }
    h.push('<div class="rzx-opts' + (k === 'stress' ? ' is-syllables' : '') + (k === 'minimal_pair' ? ' is-pair' : '') + (k === 'truefalse' ? ' is-tf' : '') + '" role="group">');
    opts.forEach(function (o, x) {
      var cls = '';
      var picked = st.picked != null && String(st.picked) === o.value;
      if (st.checked) cls = o.right ? ' is-right' : (picked ? ' is-wrong' : ' is-dim');
      else if (picked) cls = ' is-picked';
      h.push('<button type="button" class="rzx-opt' + cls + (o.big ? ' is-big' : '') + '" data-act="rz-items-pick"' + da(set, i) + ' data-value="' + esc(o.value) + '"' + (st.checked ? ' disabled' : '') + '>'
        + '<span class="rzx-opt-k">' + (x + 1) + '</span><span class="rzx-opt-t"' + (k === 'truefalse' ? '' : ' lang="en"') + '>' + esc(o.label) + (o.sub ? ' <span class="rzx-opt-sub" lang="en">' + esc(o.sub) + '</span>' : '') + '</span></button>');
    });
    h.push('</div>');
    if (k === 'minimal_pair' && st.checked) {
      h.push('<div class="rzx-it-compare"><span class="rz-muted">Comparez :</span>' + it.words.slice(0, 2).map(function (w, x) {
        return R.h.player(pkey(set, i, 'w' + x), { label: w, small: true, speeds: false, source: sayer(pkey(set, i, 'w' + x), w, i + x + 1) });
      }).join('') + '</div>');
    }
    return h.join('');
  }
  function stressed(it) {
    return it.options.map(function (sy, x) { return String(x) === String(+it.answer) ? '<b class="rzx-stress">' + esc(sy.toUpperCase()) + '</b>' : esc(sy); }).join('<span class="rzx-syl-dot">·</span>');
  }

  function typedHtml(set, i, it, st) {
    var k = it.kind, h = [], ro = st.checked ? ' readonly' : '';
    var res = st.res;
    if (k === 'dictation' || k === 'partial_dictation') {
      h.push('<div class="rzx-it-listen">' + R.h.player(pkey(set, i), { label: 'Écouter', source: sayer(pkey(set, i), it.audioText || it.answer, i) })
        + (st.checked ? '' : '<span class="rz-muted">Réécoutez autant que nécessaire, ralentissez au besoin.</span>') + '</div>');
    }
    if (k === 'gap' || k === 'partial_dictation') {
      var segs = it.prompt.split(/_{2,}/);
      if (segs.length < 2) segs = [it.prompt + ' ', ''];
      h.push('<div class="rzx-it-prompt rzx-gapline" lang="en">');
      for (var g = 0; g < segs.length; g++) {
        h.push(esc(segs[g]));
        if (g < segs.length - 1) {
          var gr = res && res.gaps && res.gaps[g];
          var val = st.values[g] || '';
          h.push('<input class="input rzx-gap' + (gr ? ' ' + vcls(gr.verdict) : (res ? ' ' + vcls(res.verdict) : '')) + '" type="text" data-role="rz-items-text"' + da(set, i) + ' data-gap="' + g + '" data-focus-key="' + esc(fk(set, i, g)) + '"'
            + ' data-dict="off" autocomplete="off" spellcheck="false" lang="en" size="' + Math.max(8, val.length + 2) + '" value="' + esc(val) + '" aria-label="Trou ' + (g + 1) + '"' + ro + '>');
          if (gr && gr.verdict !== 'exact') h.push('<span class="rzx-gap-fix" lang="en">' + esc(gr.expected) + '</span>');
        }
      }
      h.push('</div>');
      if (it.promptFr && k === 'gap') h.push('<div class="rzx-it-fr">Indice : ' + esc(it.promptFr) + '</div>');
      return h.join('');
    }
    if (k === 'transform') {
      if (it.promptFr) h.push('<div class="rzx-it-task">' + esc(it.promptFr) + '</div>');
      h.push('<div class="rzx-it-prompt is-source" lang="en">' + esc(it.prompt) + '</div>');
    } else if (k === 'translate') {
      h.push('<div class="rzx-it-prompt is-fr" lang="fr">« ' + esc(it.promptFr || it.prompt) + ' »</div>');
    } else if (k === 'error_spot') {
      h.push('<div class="rzx-it-prompt is-faulty" lang="en">' + esc(it.prompt) + '</div>');
      if (it.promptFr) h.push('<div class="rzx-it-fr">' + esc(it.promptFr) + '</div>');
    }
    var value = st.values[0] != null ? st.values[0] : (k === 'error_spot' ? it.prompt : '');
    if (st.values[0] == null && k === 'error_spot') st.values[0] = value;
    var ph = { transform: 'Votre phrase…', translate: 'In English…', error_spot: 'Corrigez directement la phrase…', dictation: 'Écrivez la phrase entendue…' }[k];
    var cls = 'input rzx-line' + (res ? ' ' + vcls(res.verdict) : '');
    if (k === 'dictation') {
      h.push('<textarea class="' + cls + ' rzx-area" rows="2" data-role="rz-items-text"' + da(set, i) + ' data-gap="0" data-focus-key="' + esc(fk(set, i, 0)) + '" data-dict="off" spellcheck="false" lang="en" placeholder="' + esc(ph) + '"' + ro + '>' + esc(value) + '</textarea>');
    } else {
      h.push('<input class="' + cls + '" type="text" data-role="rz-items-text"' + da(set, i) + ' data-gap="0" data-focus-key="' + esc(fk(set, i, 0)) + '" data-dict="off" autocomplete="off" spellcheck="false" lang="en" placeholder="' + esc(ph) + '" value="' + esc(value) + '"' + ro + '>');
    }
    return h.join('');
  }

  function orderHtml(set, i, it, st) {
    var h = [];
    if (it.promptFr) h.push('<div class="rzx-it-task">' + esc(it.promptFr) + '</div>');
    if (it.prompt) h.push('<div class="rzx-it-prompt" lang="en">' + esc(it.prompt) + '</div>');
    h.push('<div class="rzx-order-built' + (st.res ? ' ' + vcls(st.res.verdict) : '') + '" aria-label="Votre phrase" lang="en">');
    if (!st.order.length) h.push('<span class="rz-muted">Cliquez les morceaux dans l’ordre (ou tapez leur numéro)…</span>');
    st.order.forEach(function (oi, pos) {
      h.push('<button type="button" class="rzx-frag is-used" data-act="rz-items-order-pop"' + da(set, i) + ' data-pos="' + pos + '"' + (st.checked ? ' disabled' : '') + ' title="Retirer">' + esc(it.options[oi]) + '</button>');
    });
    h.push('</div>');
    if (!st.checked) {
      h.push('<div class="rzx-order-pool" lang="en">');
      it.options.forEach(function (o, x) {
        if (st.order.indexOf(x) >= 0) return;
        h.push('<button type="button" class="rzx-frag" data-act="rz-items-order-add"' + da(set, i) + ' data-value="' + x + '"><span class="rzx-opt-k">' + (x + 1) + '</span>' + esc(o) + '</button>');
      });
      h.push('</div>');
    }
    return h.join('');
  }

  function speechHtml(set, i, it, st) {
    var k = it.kind, h = [];
    var ref = k === 'shadow' ? (it.audioText || it.prompt) : (it.prompt || it.audioText);
    var n = R.text.count(ref);
    if (k === 'shadow') {
      h.push('<div class="rzx-it-say" data-rz-say="' + esc(pkey(set, i)) + '" data-rz-idx="0" lang="en">' + esc(ref) + '</div>');
      if (it.promptFr) h.push('<div class="rzx-it-fr">' + esc(it.promptFr) + '</div>');
    } else {
      if (it.promptFr) h.push('<div class="rzx-it-task">' + esc(it.promptFr) + '</div>');
      h.push('<div class="rzx-it-read" lang="en">' + esc(ref) + '</div>');
    }
    h.push('<div class="rzx-it-row">');
    if (k === 'shadow') h.push(R.h.player(pkey(set, i), { label: 'Écouter', source: sayer(pkey(set, i), ref, i) }));
    h.push(R.h.rec(pkey(set, i, 'rec'), {
      maxMs: k === 'shadow' ? Math.max(6000, n * 800 + 3000) : Math.max(15000, n * 700 + 8000),
      label: k === 'shadow' ? 'Répéter' : 'Lire', againLabel: 'Recommencer', stt: { reference: ref },
      onResult: function (r) { onSpeech(set.key, i, r); }
    }));
    h.push('</div>');
    if (!st.stt) h.push('<div class="rzx-it-hint rz-muted">Espace démarre et termine l’enregistrement.' + (k === 'shadow' ? ' Écoutez d’abord, puis répétez en imitant le rythme.' : '') + '</div>');
    else h.push(speechResultHtml(it, st));
    return h.join('');
  }

  function speechResultHtml(it, st) {
    var res = st.res, al = (res && res.align) || { ops: [] }, stt = st.stt || {};
    var c = { ok: 0, sub: 0, del: 0, ins: 0 };
    var h = ['<div class="rzx-speech">'];
    h.push('<div class="rzx-speech-words" lang="en">');
    arr(al.ops).forEach(function (o) {
      c[o.op] = (c[o.op] || 0) + 1;
      if (o.op === 'ok') h.push('<span class="rzx-w is-ok">' + esc(o.ref) + '</span>');
      else if (o.op === 'del') h.push('<span class="rzx-w is-del" title="Mot omis ou non reconnu">' + esc(o.ref) + '</span>');
      else if (o.op === 'sub') h.push('<span class="rzx-w is-sub" title="Entendu : ' + esc(o.hyp) + '">' + esc(o.ref) + '<small>' + esc(o.hyp) + '</small></span>');
      else h.push('<span class="rzx-w is-ins" title="Mot en plus">+' + esc(o.hyp) + '</span>');
    });
    h.push('</div>');
    var stats = ['Précision <b>' + Math.round((res ? res.score : 0) * 100) + ' %</b>'];
    if (c.del) stats.push(c.del + ' mot' + (c.del > 1 ? 's' : '') + ' omis');
    if (c.sub) stats.push(c.sub + ' substitué' + (c.sub > 1 ? 's' : ''));
    if (stt.wpm) stats.push(Math.round(stt.wpm) + ' mots/min');
    if (arr(stt.pauses).length) stats.push(arr(stt.pauses).length + ' pause' + (arr(stt.pauses).length > 1 ? 's' : ''));
    h.push('<div class="rzx-speech-stats">' + stats.join(' · ') + '</div>');
    var unsure = arr(stt.words).filter(function (w) { return w && w.p != null && w.p < 0.5; }).map(function (w) { return w.text; }).slice(0, 8);
    if (unsure.length) h.push('<div class="rzx-speech-unsure">À vérifier (reconnus de justesse) : <span lang="en">' + esc(unsure.join(', ')) + '</span></div>');
    h.push('<div class="rzx-speech-note">Whisper peut lisser une erreur : un mot non reconnu est un vrai signal, un mot reconnu ne garantit pas la prononciation. Réécoutez-vous à côté du modèle.</div>');
    h.push('</div>');
    return h.join('');
  }

  function wordRange(t) {
    var m = /(\d+)\s*(?:à|-|–|to)\s*(\d+)\s*mots/i.exec(s(t));
    if (m) return [+m[1], +m[2]];
    m = /(\d+)\s*mots/i.exec(s(t));
    return m ? [Math.round(m[1] * 0.8), Math.round(m[1] * 1.2)] : [0, 0];
  }
  function criteriaHtml(it) {
    return it.criteria.length ? '<div class="rzx-crit">' + it.criteria.map(function (c) { return '<span class="rzx-crit-i">' + esc(c) + '</span>'; }).join('') + '</div>' : '';
  }
  function countLine(it, text) {
    var n = R.text.count(text), w = wordRange(it.promptFr);
    var ok = !w[1] || (n >= w[0] && n <= w[1]);
    return '<span class="' + (ok ? '' : 'is-off') + '">' + n + ' mot' + (n > 1 ? 's' : '') + (w[1] ? ' · attendu ' + w[0] + ' à ' + w[1] : '') + '</span>';
  }

  function writeHtml(set, i, it, st) {
    var h = [];
    h.push('<div class="rzx-it-task">' + esc(it.promptFr || it.prompt) + '</div>');
    h.push(criteriaHtml(it));
    if (!st.grade) {
      var busy = !!st.gradeJob;
      h.push('<textarea class="input rzx-write" rows="7" data-role="rz-items-write"' + da(set, i) + ' data-focus-key="' + esc(fk(set, i, 'w')) + '" data-dict="off" lang="en" spellcheck="false" placeholder="Écrivez en anglais, sans traducteur : c’est l’effort qui fait progresser."' + (busy ? ' readonly' : '') + '>' + esc(st.text) + '</textarea>');
      h.push('<div class="rzx-write-foot"><span class="rzx-count" data-rzx-count="' + esc(set.key + ':' + i) + '">' + countLine(it, st.text) + '</span>'
        + (it.seconds ? '<span class="rz-muted">Temps conseillé : ' + esc(R.fmtDur(it.seconds)) + '</span>' : '') + '</div>');
      if (busy) h.push(R.h.jobLine(st.gradeJob) || '<div class="rz-job"><span class="rz-spin"></span><span class="rz-job-text">Correction…</span></div>');
      else {
        if (st.gradeErr) h.push('<div class="rz-err-line">Correction impossible : ' + esc(st.gradeErr) + '</div>');
        h.push('<div class="rz-row"><button type="button" class="btn btn-primary" data-act="rz-items-send"' + da(set, i) + '>' + R.icon('check') + ' ' + (st.gradeErr ? 'Réessayer' : 'Envoyer pour correction') + ' <span class="rz-kbd">Ctrl + Entrée</span></button></div>');
      }
    } else {
      h.push('<details class="rzx-mine"><summary>Votre texte · ' + R.text.count(st.text) + ' mots</summary><div class="rzx-mine-text" lang="en">' + esc(st.text) + '</div></details>');
      h.push(R.h.feedback(st.grade, { response: st.text, mode: 'write', openCorrected: true }));
      h.push(gradeFoot(set, i, it, st, 'write'));
    }
    return h.join('');
  }

  function speakHtml(set, i, it, st) {
    var h = [];
    h.push('<div class="rzx-it-task">' + esc(it.promptFr || it.prompt) + '</div>');
    h.push(criteriaHtml(it));
    var secs = it.seconds || 60;
    h.push('<div class="rzx-it-row">' + R.h.rec(pkey(set, i, 'rec'), {
      maxMs: secs * 1000 + 3000, label: 'Parler · ' + R.fmtDur(secs), againLabel: 'Recommencer', stt: { keep: true },
      onResult: function (r) { onOpenSpeak(set.key, i, r); }
    }) + '</div>');
    if (!st.transcript && !st.grade) h.push('<div class="rzx-it-hint rz-muted">Prenez quelques secondes pour réfléchir, puis parlez sans vous arrêter. Espace démarre et termine.</div>');
    if (st.transcript) {
      h.push('<div class="rzx-transcript"><span class="rzx-transcript-k">Transcription</span><span lang="en">« ' + esc(st.transcript) + ' »</span></div>');
    }
    if (st.gradeJob) h.push(R.h.jobLine(st.gradeJob) || '<div class="rz-job"><span class="rz-spin"></span><span class="rz-job-text">Correction…</span></div>');
    else if (st.gradeErr) h.push('<div class="rz-err-line">Correction impossible : ' + esc(st.gradeErr) + '</div><div class="rz-row"><button type="button" class="btn btn-secondary" data-act="rz-items-regrade"' + da(set, i) + '>Réessayer la correction</button></div>');
    if (st.grade) {
      h.push(R.h.feedback(st.grade, { response: st.transcript, mode: 'speak' }));
      h.push(gradeFoot(set, i, it, st, 'speak'));
    }
    return h.join('');
  }

  /* Un retour de correction est toujours suivi d'une action : redire, réécrire, ou garder en cartes. */
  function gradeFoot(set, i, it, st, mode) {
    var g = st.grade, h = ['<div class="rzx-gfoot">'];
    if (g.redo) {
      h.push('<div class="rzx-redo"><span class="rzx-redo-k">' + (mode === 'speak' ? 'À redire' : 'À réécrire') + '</span><span class="rzx-redo-t" lang="en">' + esc(g.redo) + '</span>'
        + R.h.player(pkey(set, i, 'redo'), { label: 'Écouter', small: true, speeds: false, source: sayer(pkey(set, i, 'redo'), g.redo, i) }) + '</div>');
    }
    if (st.cardsAdded) h.push('<div class="rzx-gcards">' + R.icon('cards') + ' ' + st.cardsAdded + ' carte' + (st.cardsAdded > 1 ? 's' : '') + ' ajoutée' + (st.cardsAdded > 1 ? 's' : '') + ' à vos révisions (vos erreurs et les tournures utiles).</div>');
    h.push('<div class="rz-row">');
    if (mode === 'write') h.push('<button type="button" class="btn btn-secondary" data-act="rz-items-rewrite"' + da(set, i) + '>Réécrire mon texte</button>');
    if (it.modelAnswer) h.push('<details class="rzx-model"><summary>Voir une réponse modèle</summary><div class="rzx-model-text" lang="en">' + esc(it.modelAnswer) + '</div>'
      + R.h.player(pkey(set, i, 'model'), { label: 'Écouter le modèle', small: true, source: sayer(pkey(set, i, 'model'), it.modelAnswer, i) }) + '</details>');
    h.push('</div></div>');
    return h.join('');
  }

  function fbHtml(set, i, it, st) {
    var r = st.res;
    if (!r) return '';
    var k = it.kind, v = r.verdict, h = [];
    var head = v === 'exact' ? 'Juste !' : (v === 'close' ? 'Presque' : 'Pas tout à fait');
    if (st.self) head = 'Compté juste : votre réponse convient aussi';
    else if (st.ask && st.ask.ok) head = 'Juste, d’après Claude';
    if (SPEECH[k]) head = v === 'exact' ? 'Très clair !' : (v === 'close' ? 'Bien compris dans l’ensemble' : 'Plusieurs mots n’ont pas été reconnus');
    var tone = st.self || (st.ask && st.ask.ok) ? 'exact' : v;
    h.push('<div class="rzx-fb is-' + tone + '" role="status">');
    var pct = (k === 'partial_dictation' || k === 'dictation' || (k === 'gap' && r.gaps && r.gaps.length > 1)) && v !== 'exact' ? ' <span class="rzx-fb-pct">' + Math.round(r.score * 100) + ' %</span>' : '';
    h.push('<div class="rzx-fb-head">' + R.icon(tone === 'wrong' ? 'cross' : 'check') + '<span>' + esc(head) + '</span>' + pct + '</div>');
    if (v !== 'exact' && !SPEECH[k] && !st.self) {
      if (k === 'choice') h.push('<div class="rzx-fb-exp">Bonne réponse : <b lang="en">' + esc(it.answer) + '</b></div>');
      else if (k === 'truefalse') h.push('<div class="rzx-fb-exp">Bonne réponse : <b>' + esc((TF.filter(function (t) { return t[0] === it.answer; })[0] || [0, it.answer])[1]) + '</b></div>');
      else if (k === 'minimal_pair') h.push('<div class="rzx-fb-exp">C’était <b lang="en">« ' + esc(it.answer) + ' »</b>.</div>');
      else if (k === 'stress') h.push('<div class="rzx-fb-exp">Accent sur <b lang="en">« ' + esc(it.options[+it.answer] || '') + ' »</b>.</div>');
      else if (k === 'gap' || k === 'partial_dictation') {
        h.push('<div class="rzx-fb-exp">Réponse attendue : <b lang="en">' + esc(r.expected) + '</b></div>');
        if (k === 'partial_dictation' && it.audioText) h.push('<div class="rzx-fb-exp">La phrase : <span lang="en">' + esc(it.audioText) + '</span></div>');
      } else {
        h.push('<div class="rzx-fb-exp">Réponse attendue : <b lang="en">' + esc(r.expected) + '</b></div>');
        var mine = k === 'order' ? r.text : (st.values[0] || '');
        if (mine && R.text.norm(mine) !== R.text.norm(r.expected)) h.push('<div class="rz-diff rzx-fb-diff" lang="en">' + R.h.diff(mine, r.expected) + '</div>');
      }
    }
    if (it.explanationFr) h.push('<div class="rzx-fb-why">' + esc(it.explanationFr) + '</div>');
    if (st.ask && st.ask.grade && !st.ask.ok) h.push('<div class="rzx-fb-ask">' + R.h.feedback(st.ask.grade, { response: st.values[0] || '', mode: 'write' }) + '</div>');
    var acts = [];
    if (v !== 'exact' && (TYPED[k] || k === 'order') && !st.self && !(st.ask && st.ask.ok)) acts.push('<button type="button" class="btn btn-secondary btn-small" data-act="rz-items-retry"' + da(set, i) + '>Réessayer</button>');
    if (v !== 'exact' && (k === 'translate' || k === 'transform' || k === 'error_spot' || k === 'gap') && !st.self && !(st.ask && st.ask.ok)) acts.push('<button type="button" class="btn btn-ghost btn-small" data-act="rz-items-self"' + da(set, i) + ' title="Votre formulation est juste mais différente : comptez-la">Ma réponse convient aussi</button>');
    if (v === 'wrong' && (k === 'translate' || k === 'transform') && !st.ask && st.values[0]) acts.push('<button type="button" class="btn btn-ghost btn-small" data-act="rz-items-ask"' + da(set, i) + ' title="Claude vérifie votre phrase (quelques secondes)">Faire vérifier par Claude</button>');
    if (st.ask && st.ask.job) acts.push(R.h.jobLine(st.ask.job) || '<span class="rz-muted"><span class="rz-spin"></span> Vérification…</span>');
    if (st.ask && st.ask.error) acts.push('<span class="rz-err-line">' + esc(st.ask.error) + '</span>');
    if (cardSpecFor(set, i)) {
      if (st.carded === 'added') acts.push('<span class="rzx-carded">' + R.icon('check') + ' Ajoutée aux cartes</span>');
      else if (st.carded === 'dup') acts.push('<span class="rzx-carded">' + R.icon('cards') + ' Déjà dans vos cartes</span>');
      else acts.push('<button type="button" class="btn btn-ghost btn-small" data-act="rz-items-card"' + da(set, i) + '>' + R.icon('cards') + ' Ajouter aux cartes</button>');
    }
    if (acts.length) h.push('<div class="rzx-fb-actions">' + acts.join('') + '</div>');
    h.push('</div>');
    return h.join('');
  }

  /* ══ Cartes proposées ═══════════════════════════════════════════════════ */

  function fillBlanks(prompt, fills) {
    var k = 0;
    return s(prompt).replace(/_{2,}/g, function () { return fills[k++] || '___'; });
  }
  function cardKindFor(set) {
    var t = s(set.opts.type);
    if (t === 'lang.false_friends') return 'false_friend';
    if (t === 'lang.collocations' || t === 'lang.prepositions') return 'collocation';
    if (t === 'lang.tenses') return 'grammar';
    return 'phrase';
  }
  function cardSpecFor(set, i) {
    var it = set.items[i];
    if (!it) return null;
    var k = it.kind, parts = splitBar(it.answer);
    switch (k) {
      case 'choice':
        if (!gapCount(it.prompt)) return null;
        return { kind: cardKindFor(set), front: it.prompt, back: it.answer, example: /«|»/.test(it.prompt) ? '' : fillBlanks(it.prompt, [it.answer]), note: it.explanationFr };
      case 'gap':
        return { kind: cardKindFor(set), front: it.prompt + (it.promptFr ? (/^\s*\(/.test(it.promptFr) ? ' ' + it.promptFr : ' (' + it.promptFr + ')') : ''), back: parts.join(' / '), example: fillBlanks(it.prompt, parts), note: it.explanationFr };
      case 'partial_dictation':
        return { kind: 'phrase', front: it.prompt, back: parts.join(' / '), example: it.audioText, audioText: it.audioText, note: it.explanationFr };
      case 'transform':
        return { kind: 'grammar', front: (it.promptFr ? it.promptFr + ' — ' : '') + it.prompt, back: it.answer, example: it.answer, accepted: it.accepted, note: it.explanationFr };
      case 'translate':
        return it.promptFr ? { kind: 'phrase', front: it.promptFr, back: it.answer, example: it.answer, accepted: it.accepted, note: it.explanationFr } : null;
      case 'error_spot':
        return { kind: 'error', front: it.prompt, back: it.answer, example: '', accepted: it.accepted, note: it.explanationFr };
      case 'order':
        return it.promptFr ? { kind: 'phrase', front: it.promptFr, back: it.answer, example: it.answer, note: it.explanationFr } : null;
      case 'minimal_pair':
        return it.words.length >= 2 ? { kind: 'pronunciation', front: it.words.slice(0, 2).join(' / '), back: 'Paire minimale : ' + it.words.slice(0, 2).join(' ≠ '), example: '', audioText: it.words.slice(0, 2).join('. ') + '.', note: it.explanationFr } : null;
      case 'stress':
        return { kind: 'pronunciation', front: it.prompt, back: it.options.map(function (sy, x) { return String(x) === String(+it.answer) ? sy.toUpperCase() : sy; }).join(''), example: '', audioText: it.audioText || it.prompt, note: it.explanationFr };
    }
    return null;
  }
  function addCard(set, i) {
    var st = ist(set, i);
    var spec = cardSpecFor(set, i);
    if (!spec || !R.cards) return false;
    var c = R.cards.add(spec, { kind: set.opts.origin || 'exercise', ref: set.opts.ref || set.key });
    st.carded = c ? 'added' : 'dup';
    changed(set);
    return !!c;
  }

  /* ══ Oral et écrit libres ═══════════════════════════════════════════════ */

  function onSpeech(key, i, r) {
    var set = U[key];
    if (!set) return;
    var st = ist(set, i), it = set.items[i];
    if (!r || !r.stt) { st.gradeErr = 'transcription indisponible'; return; }
    st.stt = { text: s(r.stt.text), wpm: r.stt.wpm || 0, pauses: arr(r.stt.pauses).slice(0, 40), words: arr(r.stt.words).slice(0, 200).map(function (w) { return { text: w.text, p: w.p }; }), alignment: r.stt.alignment || null };
    st.checked = false;
    record(set, i, check(it, st.stt));
  }

  function onOpenSpeak(key, i, r) {
    var set = U[key];
    if (!set) return;
    var st = ist(set, i);
    var t = r && r.stt ? s(r.stt.text).trim() : '';
    st.grade = null; st.gradeErr = ''; st.checked = false;
    st.transcript = t;
    st.audioSeconds = r && r.audio ? r.audio.seconds || 0 : 0;
    st.stt = r && r.stt ? { wpm: r.stt.wpm || 0, pauses: arr(r.stt.pauses).length, uncertain: arr(r.stt.words).filter(function (w) { return w && w.p != null && w.p < 0.5; }).map(function (w) { return w.text; }).slice(0, 12), url: r.stt.url || '' } : null;
    if (R.text.count(t) < 3) { st.gradeErr = 'presque rien n’a été entendu — rapprochez-vous du micro et recommencez'; return; }
    gradeOpen(set, i, 'speak');
  }

  function gradeOpen(set, i, mode) {
    var it = set.items[i], st = ist(set, i);
    var response = mode === 'speak' ? st.transcript : st.text.trim();
    var job = R.uid('rzigr');
    st.gradeJob = job; st.gradeErr = '';
    var sk = mode === 'speak' ? 'speak' : 'write';
    var params = {
      mode: mode, rubric: 'lesson',
      task: { id: it.id || 'i' + (i + 1), kind: it.kind, promptFr: it.promptFr, prompt: it.prompt, criteria: it.criteria, scale: 0, words: mode === 'write' ? wordRange(it.promptFr) : [0, 0], seconds: it.seconds },
      response: response.slice(0, 6000),
      metrics: mode === 'speak' && st.stt ? { seconds: st.audioSeconds, wpm: st.stt.wpm, pauses: st.stt.pauses, uncertain: st.stt.uncertain } : null,
      level: levelOf(set, sk), targets: R.weakPoints(5).map(function (w) { return w.category; })
    };
    touch(set);
    R.gen('grade', params, { job: job }).then(function (r) {
      if (st.gradeJob !== job) return;
      st.gradeJob = '';
      applyGrade(set, i, r && r.doc, mode);
      R.render();
    }, function (e) {
      if (st.gradeJob !== job) return;
      st.gradeJob = ''; st.gradeErr = (e && e.message) || 'erreur inconnue';
      R.render();
    });
  }

  function applyGrade(set, i, g, mode) {
    var it = set.items[i], st = ist(set, i);
    if (!g) { st.gradeErr = 'réponse vide du correcteur'; return; }
    st.grade = g;
    var ref = set.opts.ref || set.key;
    R.addErrors(g.edits, { mode: mode, ref: ref });
    var n = 0;
    if (R.cards) {
      n += R.cards.addMany(R.cards.fromEdits(g.edits, 3), { kind: 'grade', ref: ref });
      n += R.cards.addMany(g.cards, { kind: 'grade', ref: ref });
    }
    st.cardsAdded = n;
    if (g.levelEstimate) R.observeLevel(mode === 'speak' ? 'speak' : 'write', g.levelEstimate);
    record(set, i, check(it, g));
  }

  function askClaude(set, i) {
    var it = set.items[i], st = ist(set, i);
    var answer = s(st.values[0]).trim();
    if (!answer) return;
    var job = R.uid('rziask');
    st.ask = { job: job };
    var task = it.kind === 'translate' ? 'Traduire en anglais : « ' + (it.promptFr || it.prompt) + ' »' : (it.promptFr || 'Transformer la phrase') + ' — phrase de départ : « ' + it.prompt + ' »';
    R.gen('grade', {
      mode: 'write', rubric: 'lesson',
      task: { id: it.id || 'i' + (i + 1), kind: it.kind, promptFr: task, prompt: 'Reference answer: ' + it.answer, criteria: ['Sens fidèle à la consigne', 'Grammaire et vocabulaire corrects'], scale: 0, words: [0, 0], seconds: 0 },
      response: answer, metrics: null, level: levelOf(set, skillOf(set, it)), targets: []
    }, { job: job }).then(function (r) {
      if (!st.ask || st.ask.job !== job) return;
      var g = r && r.doc;
      var errors = arr(g && g.edits).filter(function (e) { return e && e.type !== 'improvement'; });
      st.ask = { ok: !!g && !errors.length, grade: g };
      if (st.ask.ok) { st.score = 1; st.res = Object.assign({}, st.res, { verdict: 'exact', score: 1 }); }
      else R.addErrors(errors, { mode: 'write', ref: set.opts.ref || set.key });
      changed(set);
      R.render();
    }, function (e) {
      if (!st.ask || st.ask.job !== job) return;
      st.ask = { error: 'Vérification impossible : ' + ((e && e.message) || '') };
      R.render();
    });
  }

  /* ══ Série ══════════════════════════════════════════════════════════════ */

  function summary(key) {
    var set = U[key];
    if (!set) return null;
    var o = { total: set.items.length, answered: 0, exact: 0, close: 0, wrong: 0, skipped: 0, scored: 0, score: 0, activeMs: set.activeMs, minutes: 0, items: [] };
    var sum = 0;
    set.items.forEach(function (it, i) {
      var st = set.answers[i] || blank();
      var row = { idx: i, kind: it.kind, verdict: st.res ? (st.self || (st.ask && st.ask.ok) ? 'exact' : st.res.verdict) : '', score: st.score, skipped: !st.checked };
      if (st.checked && st.score != null) {
        o.answered++; o.scored++; sum += st.score;
        o[row.verdict] = (o[row.verdict] || 0) + 1;
      } else o.skipped++;
      o.items.push(row);
    });
    o.score = o.scored ? round2(sum / o.scored) : 0;
    o.minutes = Math.round(set.activeMs / 6000) / 10;
    return o;
  }

  function snapshot(key) {
    var set = U[key];
    if (!set) return null;
    var a = {};
    Object.keys(set.answers).forEach(function (i) {
      var st = set.answers[i];
      if (!st.checked && !st.skipped && !st.text && !st.values.length && !st.order.length) return;
      var it = set.items[i] || {};
      a[i] = {
        values: st.values.slice(0, 12).map(function (v) { return s(v).slice(0, 600); }), picked: st.picked, order: st.order.slice(), checked: st.checked, skipped: st.skipped,
        res: st.res ? { verdict: st.res.verdict, score: st.res.score, expected: s(st.res.expected).slice(0, 600), gaps: st.res.gaps || [], text: st.res.text || '', align: st.res.align ? { accuracy: st.res.align.accuracy, wer: st.res.align.wer, ops: arr(st.res.align.ops).slice(0, 120) } : null } : null,
        first: st.first, score: st.score, self: st.self, carded: st.carded, text: s(st.text).slice(0, 6000), transcript: s(st.transcript).slice(0, 4000),
        grade: OPEN[it.kind] ? st.grade : null, cardsAdded: st.cardsAdded, stt: SPEECH[it.kind] && st.stt ? { text: st.stt.text, wpm: st.stt.wpm, pauses: arr(st.stt.pauses).slice(0, 20), words: [] } : null,
        ask: st.ask && st.ask.ok ? { ok: true } : null
      };
    });
    return { index: set.index, answers: a, activeMs: Math.round(set.activeMs), done: set.done };
  }

  function start(key, items, opts) {
    var set = U[key] = newSet(key, items, opts, true);
    var snap = opts && opts.resume;
    if (snap && snap.answers) {
      Object.keys(snap.answers).forEach(function (i) { if (set.items[i]) set.answers[i] = Object.assign(blank(), snap.answers[i]); });
      set.index = R.clamp(Math.round(Number(snap.index) || 0), 0, Math.max(0, set.items.length - 1));
      set.activeMs = Number(snap.activeMs) || 0;
    }
    return set;
  }

  function finish(set) {
    if (!set) return;
    set.done = true;
    touch(set);
    R.tts.stopAll();
    if (set.notified) return;
    set.notified = true;
    var fn = set.opts.onDone;
    if (fn) { try { fn(summary(set.key)); } catch (e) { if (window.console) console.error(e); } }
  }

  function go(key, i) {
    var set = U[key];
    if (!set) return;
    R.tts.stopAll();
    touch(set);
    set.index = R.clamp(i, 0, Math.max(0, set.items.length - 1));
    changed(set);
    focusItem(set);
  }
  function next(key) {
    var set = U[key];
    if (!set) return;
    if (set.index >= set.items.length - 1) { finish(set); changed(set); return; }
    go(key, set.index + 1);
  }
  function focusItem(set) {
    setTimeout(function () {
      var root = document.querySelector('[data-rzx-series="' + String(set.key).replace(/["\\]/g, '\\$&') + '"]');
      if (!root) return;
      var el = root.querySelector('input.rzx-gap:not([readonly]), input.rzx-line:not([readonly]), textarea.rzx-area:not([readonly]), textarea.rzx-write:not([readonly])');
      if (el && document.activeElement !== el) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
      if (root.getBoundingClientRect && root.scrollIntoView) {
        var r = root.getBoundingClientRect();
        if (r.top < 0 || r.top > (window.innerHeight || 800) * 0.6) root.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }, 0);
  }

  function seriesHtml(key) {
    var set = U[key];
    if (!set) return '';
    if (set.done) return summaryHtml(key);
    var n = set.items.length, i = set.index, it = set.items[i];
    if (!it) return '';
    var st = ist(set, i);
    var h = ['<div class="rzx-series" data-rzx-series="' + esc(key) + '">'];
    h.push('<div class="rzx-series-top"><span class="rzx-series-n">Question ' + (i + 1) + ' / ' + n + '</span><span class="rzx-steps" role="group" aria-label="Questions">');
    set.items.forEach(function (x, j) {
      var a = set.answers[j];
      var v = a && a.checked ? (a.self || (a.ask && a.ask.ok) ? 'exact' : a.res && a.res.verdict) : (a && a.skipped ? 'skip' : '');
      h.push('<button type="button" class="rzx-step' + (j === i ? ' is-cur' : '') + (v ? ' is-' + v : '') + '" data-act="rz-items-go"' + da(set, j) + ' aria-label="Question ' + (j + 1) + '"' + (j === i ? ' aria-current="step"' : '') + '></button>');
    });
    h.push('</span></div>');
    h.push(itemHtml(set, i));
    h.push('<div class="rzx-series-nav">');
    h.push(i > 0 ? '<button type="button" class="btn btn-ghost" data-act="rz-items-prev"' + da(set, i) + '>' + R.icon('back') + ' Précédent</button>' : '<span></span>');
    h.push('<span class="rzx-series-right">');
    var last = i === n - 1;
    if (st.checked) {
      h.push('<button type="button" class="btn btn-primary rz-big" data-act="rz-items-next"' + da(set, i) + '>' + (last ? 'Voir le bilan' : 'Suivant') + ' ' + R.icon('arrow') + ' <span class="rz-kbd">Entrée</span></button>');
    } else {
      var busy = st.gradeJob || (R.recState(pkey(set, i, 'rec')).phase || 'idle') !== 'idle' && R.recState(pkey(set, i, 'rec')).phase !== 'done';
      h.push('<button type="button" class="btn btn-ghost" data-act="rz-items-skip"' + da(set, i) + (busy ? ' disabled' : '') + '>' + (last ? 'Passer et finir' : 'Passer') + '</button>');
      if (TYPED[it.kind]) h.push('<button type="button" class="btn btn-primary rz-big" data-act="rz-items-check"' + da(set, i) + '>Vérifier <span class="rz-kbd">Entrée</span></button>');
      if (it.kind === 'order') h.push('<button type="button" class="btn btn-secondary" data-act="rz-items-order-clear"' + da(set, i) + (st.order.length ? '' : ' disabled') + '>Effacer</button>'
        + '<button type="button" class="btn btn-primary rz-big" data-act="rz-items-check"' + da(set, i) + (filled(set, i) ? '' : ' disabled') + '>Vérifier <span class="rz-kbd">Entrée</span></button>');
    }
    h.push('</span></div></div>');
    return h.join('');
  }

  function summaryHtml(key) {
    var set = U[key];
    if (!set) return '';
    var sm = summary(key);
    var pct = Math.round(sm.score * 100);
    var h = ['<div class="rzx-series is-done" data-rzx-series-done="' + esc(key) + '">'];
    h.push('<div class="rzx-sum-head"><div class="rzx-sum-score' + (pct >= 80 ? ' is-good' : (pct >= 50 ? ' is-mid' : ' is-low')) + '"><b>' + pct + '</b><span>%</span></div>'
      + '<div class="rzx-sum-text"><div class="rzx-sum-title">' + esc(pct >= 85 ? 'Excellent travail !' : (pct >= 65 ? 'Bien joué.' : (pct >= 40 ? 'C’est en bonne voie.' : 'Une série difficile — c’est comme ça qu’on progresse.'))) + '</div>'
      + '<div class="rz-muted">' + sm.exact + ' juste' + (sm.exact > 1 ? 's' : '') + (sm.close ? ', ' + sm.close + ' presque' : '') + (sm.wrong ? ', ' + sm.wrong + ' à revoir' : '') + (sm.skipped ? ', ' + sm.skipped + ' passée' + (sm.skipped > 1 ? 's' : '') : '')
      + ' · ' + esc(R.fmtDur(sm.activeMs / 1000)) + '</div></div></div>');
    h.push('<ol class="rzx-sum-list">');
    set.items.forEach(function (it, i) {
      var row = sm.items[i];
      var label = it.kind === 'translate' ? it.promptFr : (it.kind === 'minimal_pair' ? it.words.join(' / ') : (it.prompt || it.promptFr || it.audioText));
      h.push('<li class="rzx-sum-item is-' + (row.skipped ? 'skip' : row.verdict) + '"><button type="button" class="rzx-sum-btn" data-act="rz-items-review"' + da(set, i) + '>'
        + '<span class="rzx-sum-mark">' + (row.skipped ? '–' : R.icon(row.verdict === 'wrong' ? 'cross' : 'check')) + '</span>'
        + '<span class="rzx-sum-label">' + esc(s(label).replace(/\s+/g, ' ').slice(0, 110)) + '</span>'
        + (row.score != null ? '<span class="rzx-sum-pts">' + Math.round(row.score * 100) + ' %</span>' : '') + '</button></li>');
    });
    h.push('</ol>');
    var missed = set.items.map(function (it, i) { return i; }).filter(function (i) {
      var st = set.answers[i];
      return st && st.checked && !st.carded && st.res && st.res.verdict !== 'exact' && !st.self && !(st.ask && st.ask.ok) && cardSpecFor(set, i);
    });
    if (missed.length) h.push('<div class="rz-callout is-accent rzx-sum-cards">' + R.icon('cards') + ' <span>' + missed.length + ' réponse' + (missed.length > 1 ? 's' : '') + ' à retenir : mettez-les en cartes, elles reviendront au bon moment.</span>'
      + '<button type="button" class="btn btn-secondary btn-small" data-act="rz-items-card-missed" data-set="' + esc(key) + '">Ajouter ' + (missed.length > 1 ? 'les ' + missed.length : 'la') + ' aux cartes</button></div>');
    h.push('</div>');
    return h.join('');
  }

  /* ══ Actions ════════════════════════════════════════════════════════════ */

  function ctx(el) {
    var set = U[el.getAttribute('data-set')];
    var i = +el.getAttribute('data-idx');
    if (!set || !set.items[i]) return null;
    return { set: set, i: i, it: set.items[i], st: ist(set, i) };
  }
  function readInputs(set, i) {
    var st = ist(set, i);
    var els = document.querySelectorAll('[data-role="rz-items-text"][data-set="' + String(set.key).replace(/["\\]/g, '\\$&') + '"][data-idx="' + i + '"]');
    for (var x = 0; x < els.length; x++) st.values[+els[x].getAttribute('data-gap') || 0] = els[x].value;
  }

  R.act('rz-items-pick', function (el) {
    var c = ctx(el);
    if (!c || c.st.checked) return;
    var v = el.getAttribute('data-value');
    c.st.picked = v;
    var ans = c.it.kind === 'choice' || c.it.kind === 'stress' ? +v : v;
    record(c.set, c.i, check(c.it, ans));
    R.render();
  });
  R.act('rz-items-check', function (el) {
    var c = ctx(el);
    if (!c) return;
    readInputs(c.set, c.i);
    if (doCheck(c.set, c.i)) R.render();
  });
  R.act('rz-items-next', function (el) { var c = ctx(el); if (c) { next(c.set.key); R.render(); } });
  R.act('rz-items-prev', function (el) { var c = ctx(el); if (c) { go(c.set.key, c.i - 1); R.render(); } });
  R.act('rz-items-go', function (el) { var c = ctx(el); if (c) { go(c.set.key, c.i); R.render(); } });
  R.act('rz-items-review', function (el) { var c = ctx(el); if (c) { c.set.done = false; go(c.set.key, c.i); R.render(); } });
  R.act('rz-items-skip', function (el) {
    var c = ctx(el);
    if (!c) return;
    if (!c.st.checked) c.st.skipped = true;
    next(c.set.key);
    R.render();
  });
  R.act('rz-items-retry', function (el) {
    var c = ctx(el);
    if (!c) return;
    var keep = { first: c.st.first, score: c.st.score, carded: c.st.carded, retried: c.st.retried + 1 };
    var fresh = blank();
    if (c.it.kind === 'error_spot') fresh.values = [c.st.values[0] || c.it.prompt];
    c.set.answers[c.i] = Object.assign(fresh, keep);
    touch(c.set);
    R.render();
    focusItem(c.set);
  });
  R.act('rz-items-self', function (el) {
    var c = ctx(el);
    if (!c || !c.st.res) return;
    c.st.self = true; c.st.score = 1;
    changed(c.set);
    R.render();
  });
  R.act('rz-items-ask', function (el) { var c = ctx(el); if (c) { askClaude(c.set, c.i); R.render(); } });
  R.act('rz-items-card', function (el) {
    var c = ctx(el);
    if (!c) return;
    var ok = addCard(c.set, c.i);
    R.toast(ok ? 'Carte ajoutée : elle reviendra dans vos révisions.' : 'Cette carte est déjà dans vos révisions.');
    R.render();
  });
  R.act('rz-items-card-missed', function (el) {
    var set = U[el.getAttribute('data-set')];
    if (!set) return;
    var n = 0;
    set.items.forEach(function (it, i) {
      var st = set.answers[i];
      if (st && st.checked && !st.carded && st.res && st.res.verdict !== 'exact' && !st.self && cardSpecFor(set, i)) { if (addCard(set, i)) n++; }
    });
    R.toast(n ? n + ' carte' + (n > 1 ? 's' : '') + ' ajoutée' + (n > 1 ? 's' : '') + ' à vos révisions.' : 'Ces cartes étaient déjà dans vos révisions.');
    R.render();
  });
  R.act('rz-items-order-add', function (el) {
    var c = ctx(el);
    if (!c || c.st.checked) return;
    var x = +el.getAttribute('data-value');
    if (c.st.order.indexOf(x) < 0) c.st.order.push(x);
    R.render();
  });
  R.act('rz-items-order-pop', function (el) {
    var c = ctx(el);
    if (!c || c.st.checked) return;
    c.st.order.splice(+el.getAttribute('data-pos'), 1);
    R.render();
  });
  R.act('rz-items-order-clear', function (el) { var c = ctx(el); if (c && !c.st.checked) { c.st.order = []; R.render(); } });
  R.act('rz-items-send', function (el) {
    var c = ctx(el);
    if (!c) return;
    var ta = document.querySelector('[data-focus-key="' + fk(c.set, c.i, 'w').replace(/["\\]/g, '\\$&') + '"]');
    if (ta) c.st.text = ta.value;
    if (R.text.count(c.st.text) < 5) { R.toast('Écrivez au moins une ou deux phrases avant d’envoyer.'); return; }
    gradeOpen(c.set, c.i, 'write');
    R.render();
  });
  R.act('rz-items-regrade', function (el) { var c = ctx(el); if (c && c.st.transcript) { gradeOpen(c.set, c.i, 'speak'); R.render(); } });
  R.act('rz-items-rewrite', function (el) {
    var c = ctx(el);
    if (!c) return;
    c.st.grade = null; c.st.checked = false; c.st.res = null;
    R.render();
    focusItem(c.set);
  });

  R.input('rz-items-text', function (el) {
    var c = ctx(el);
    if (!c || c.st.checked) return;
    c.st.values[+el.getAttribute('data-gap') || 0] = el.value.slice(0, 600);
  });
  R.input('rz-items-write', function (el) {
    var c = ctx(el);
    if (!c || c.st.gradeJob) return;
    c.st.text = el.value.slice(0, 6000);
    R.patch('[data-rzx-count="' + (c.set.key + ':' + c.i).replace(/["\\]/g, '\\$&') + '"]', countLine(c.it, c.st.text));
  });

  /* ══ Clavier ════════════════════════════════════════════════════════════ */

  function keydown(e, el) {
    if (e.altKey || e.metaKey) return false;
    var role = el && el.getAttribute ? el.getAttribute('data-role') : '';
    var c;
    if (role === 'rz-items-write') {
      if (e.key === 'Enter' && e.ctrlKey) { c = ctx(el); if (c && !c.st.gradeJob && !c.st.grade) { e.preventDefault(); c.st.text = el.value; if (R.text.count(c.st.text) >= 5) { gradeOpen(c.set, c.i, 'write'); R.render(); } else R.toast('Écrivez au moins une ou deux phrases avant d’envoyer.'); return true; } }
      return false;
    }
    if (e.ctrlKey) return false;
    if (role === 'rz-items-text') {
      if (e.key !== 'Enter' || (el.tagName === 'TEXTAREA' && e.shiftKey)) return false;
      c = ctx(el);
      if (!c) return false;
      e.preventDefault();
      if (!c.st.checked) { readInputs(c.set, c.i); if (doCheck(c.set, c.i)) { R.render(); keepFocus(el); } }
      else if (c.set.series && c.set.index === c.i) { next(c.set.key); R.render(); }
      return true;
    }
    var editable = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    if (editable) return false;
    if (el && el.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return false;
    var root = document.querySelector('#page-host [data-rzx-series]');
    if (!root) return false;
    var set = U[root.getAttribute('data-rzx-series')];
    if (!set || set.done) return false;
    var i = set.index, it = set.items[i], st = ist(set, i);
    if (!it) return false;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (st.checked) { next(set.key); R.render(); return true; }
      if (TYPED[it.kind] || it.kind === 'order') { if (doCheck(set, i)) R.render(); return true; }
      return true;
    }
    if (/^[1-9]$/.test(e.key) && !st.checked) {
      var x = +e.key - 1;
      if (CLICK[it.kind]) {
        var vals = it.kind === 'truefalse' ? (it.options.length >= 2 ? it.options.map(tfNorm) : TF.slice(0, set.tfNG ? 3 : 2).map(function (t) { return t[0]; }))
          : (it.kind === 'minimal_pair' ? it.words.slice(0, 2) : it.options.map(function (o, j) { return j; }));
        if (x >= vals.length) return false;
        e.preventDefault();
        st.picked = String(vals[x]);
        record(set, i, check(it, vals[x]));
        R.render();
        return true;
      }
      if (it.kind === 'order' && x < it.options.length && st.order.indexOf(x) < 0) { e.preventDefault(); st.order.push(x); R.render(); return true; }
      return false;
    }
    if (e.key === 'Backspace' && it.kind === 'order' && !st.checked && st.order.length) { e.preventDefault(); st.order.pop(); R.render(); return true; }
    if (e.key === 'ArrowRight' && (st.checked || st.skipped) && i < set.items.length - 1) { e.preventDefault(); go(set.key, i + 1); R.render(); return true; }
    if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); go(set.key, i - 1); R.render(); return true; }
    return false;
  }
  function keepFocus(el) {
    var key = el.getAttribute('data-focus-key');
    setTimeout(function () {
      var n = document.querySelector('[data-focus-key="' + String(key).replace(/["\\]/g, '\\$&') + '"]');
      if (n && document.activeElement !== n) { try { n.focus({ preventScroll: true }); } catch (e) { n.focus(); } }
    }, 0);
  }
  R.key(keydown);

  R.items = {
    check: function (item, answer) { return check(item, answer); },
    html: function (key, item, index, state) {
      var set = U[key] || (U[key] = newSet(key, [], {}, false));
      if (item && set.raw[index] !== item) { set.raw[index] = item; set.items[index] = mark(normItem(item)); }
      if (state && typeof state === 'object' && state !== set.answers[index]) set.answers[index] = Object.assign(blank(), state);
      set.tfNG = set.items.some(function (it) { return it && it.kind === 'truefalse' && it.answer === 'not_given'; });
      return itemHtml(set, index);
    },
    start: start, seriesHtml: seriesHtml, summaryHtml: summaryHtml, summary: summary, snapshot: snapshot,
    state: function (key) { return U[key] || null; },
    go: function (key, i) { go(key, i); }, next: next, prev: function (key) { var set = U[key]; if (set) go(key, set.index - 1); },
    finish: function (key) { finish(U[key]); },
    keydown: keydown, cardSpec: function (key, i) { var set = U[key]; return set ? cardSpecFor(set, i) : null; },
    align: align, normItem: normItem, KINDS: KINDS, gradeScore: gradeScore
  };
})();
