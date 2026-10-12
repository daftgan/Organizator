/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — le professeur (Oliver), toujours à portée de clic
   Un petit personnage dans le coin de la page Révizator, sur toutes les vues : un clic ouvre un panneau
   compact (une bulle ancrée dans le coin sur PC, une feuille à mi-hauteur sur le téléphone) où l'on
   discute avec lui. On lui demande d'expliquer ce qui est à l'écran, un mot, une règle, ou ce qu'on veut ;
   il répond par écrit et à voix haute (français et anglais, chacun avec sa voix), de plusieurs manières
   à la demande (« Plus simple », « Des exemples », « Autrement »…), et propose une série d'exercices sur
   ce dont on a parlé, lancée en un clic (R.exercise.launch). Sélectionner un passage de la page fait
   paraître une info-bulle « Demander à Oliver ». Masqué pendant un bilan (conditions d'examen) et une
   conversation avec le tuteur.

   Génération : R.gen('prof', { lang, depth, level, way, screen: { view, text }, selection, history })
   → { reply, speech: [{ lang, text }], examples: [{ en, fr }], followUps, exercise: { offer, skill, type,
   minutes, focus, titleFr } } (hôte : ProfGenre de LearningAgent.cs ; modèle profModel / profEffort).
   Préférences (R.prefs) : profEnabled (le professeur existe ou non), profLang (auto | fr | mix | en),
   profLevel (auto | a2 | b1 | b2 | c1 : profondeur des explications et anglais du professeur), profVoice
   (réponses lues à voix haute). Discussion gardée dans R.data.prof.chat (60 messages au plus).
   Le panneau vit hors de #page-host (dans <body>) : le rendu de la page ne le réécrit jamais ; ses
   parties se mettent à jour sur place. Styles : prof.css (préfixe .rzf-).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R || !R.view) return;
  var esc = R.esc;
  var bridge = window.bridge;

  var P = R.ui.prof = R.ui.prof || {
    open: false, busy: false, job: '', error: '', draft: '', gear: false, screen: true, selection: '',
    rec: null, recPhase: 'idle', recMs: 0, recLevel: 0, unread: false, speakingId: '', mood: 'rest', big: false
  };

  var NAME = 'Oliver';
  var MAX_MSGS = 60;
  var BIG_KEY = 'organizator.revizator.prof.big';
  /* Vues où il se retire : un bilan en cours (conditions d'examen), une conversation avec le tuteur. */
  var HIDE_WHEN = '.rzt-exam, .rzv-chathead';

  var LANGS = [['fr', 'FR', 'En français'], ['mix', 'Mix', 'Anglais et français mêlés'], ['en', 'EN', 'In English']];
  var DEPTHS = [['auto', 'Adapté à mon niveau'], ['a2', 'Facile · A2'], ['b1', 'Intermédiaire · B1'], ['b2', 'Avancé · B2'], ['c1', 'Expert · C1']];
  var WAYS = [
    /* [ id, bouton (fr), bouton (en), ce que dit l'apprenant (fr), (en) ] */
    ['simpler', 'Plus simple', 'Simpler', 'Plus simple, s’il vous plaît.', 'Simpler, please.'],
    ['example', 'Des exemples', 'Examples', 'Donnez-moi des exemples.', 'Can you give me some examples?'],
    ['other', 'Autrement', 'Another way', 'Pouvez-vous l’expliquer autrement ?', 'Can you explain it another way?'],
    ['image', 'Une image', 'A picture', 'Une image pour le retenir ?', 'Is there an image to help me remember?'],
    ['deeper', 'Plus en détail', 'In more depth', 'Allons plus loin.', 'Let’s go deeper.'],
    ['check', 'Testez-moi', 'Test me', 'Testez-moi pour voir si j’ai compris.', 'Test me to see if I got it.'],
    ['exercise', 'Des exercices', 'Exercises', 'Proposez-moi des exercices là-dessus.', 'Could you suggest some exercises on this?']
  ];
  var SKILL_LABELS = { read: 'Lecture', listen: 'Écoute', write: 'Écrit', speak: 'Oral', lang: 'Langue', pron: 'Prononciation' };

  function arr(v) { return Array.isArray(v) ? v : []; }
  function store() {
    var d = R.data;
    if (!d.prof || typeof d.prof !== 'object') d.prof = { chat: [] };
    if (!Array.isArray(d.prof.chat)) d.prof.chat = [];
    return d.prof;
  }
  function chat() { return store().chat; }
  function enabled() { return R.isLoaded() && R.prefs.profEnabled !== false; }
  /* Langue de la discussion : le choix de l'apprenant, sinon celle des explications de Révizator. */
  function lang() {
    var l = R.isLoaded() ? R.prefs.profLang : 'auto';
    if (l === 'fr' || l === 'en' || l === 'mix') return l;
    var e = R.isLoaded() ? R.explainLang() : 'fr';
    return e === 'en' ? 'en' : (e === 'mixed' ? 'mix' : 'fr');
  }
  function t(fr, en) { return lang() === 'en' ? en : fr; }
  function wayDef(id) { for (var i = 0; i < WAYS.length; i++) if (WAYS[i][0] === id) return WAYS[i]; return null; }

  /* ══ Avatar : un professeur dessiné (cheveux grisonnants, lunettes, moustache, veste) ══════════ */

  function faceSvg(cls) {
    return '<svg class="rzf-face ' + (cls || '') + '" viewBox="0 0 120 120" aria-hidden="true">'
      + '<circle class="rzf-bg" cx="60" cy="60" r="58"></circle>'
      + '<g class="rzf-body">'
      + '<path class="rzf-jacket" d="M10 120 C 12 100 26 92 44 89 L 60 104 L 76 89 C 94 92 108 100 110 120 Z"></path>'
      + '<path class="rzf-shirt" d="M47 89 L 60 104 L 73 89 L 68 86 L 52 86 Z"></path>'
      + '<path class="rzf-tie" d="M57 93 L 63 93 L 61.5 97 L 64 112 L 60 116 L 56 112 L 58.5 97 Z"></path>'
      + '<path class="rzf-lapel" d="M44 89 L 54 99 L 50 106 L 41 92 Z"></path><path class="rzf-lapel" d="M76 89 L 66 99 L 70 106 L 79 92 Z"></path>'
      + '<rect class="rzf-neck" x="52" y="72" width="16" height="17" rx="6"></rect>'
      + '</g>'
      + '<g class="rzf-head">'
      + '<ellipse class="rzf-ear" cx="35" cy="55" rx="4.5" ry="7"></ellipse><ellipse class="rzf-ear" cx="85" cy="55" rx="4.5" ry="7"></ellipse>'
      + '<path class="rzf-skin" d="M36 50 C 36 30 46 22 60 22 C 74 22 84 30 84 50 C 84 68 74 82 60 82 C 46 82 36 68 36 50 Z"></path>'
      + '<path class="rzf-hair" d="M34 52 C 30 34 40 17 60 17 C 80 17 91 32 86 52 C 84 44 82 38 78 34 C 70 36 58 33 50 27 C 46 33 40 37 38 44 C 37 47 36 50 34 52 Z"></path>'
      + '<path class="rzf-temple" d="M35 50 C 35 44 37 40 39 38 L 40 50 Z"></path><path class="rzf-temple" d="M85 50 C 85 44 83 40 81 38 L 80 50 Z"></path>'
      + '<g class="rzf-eyes">'
      + '<g class="rzf-eye" data-eye="l"><ellipse cx="50" cy="51" rx="2.8" ry="3.2"></ellipse><circle class="rzf-glint" cx="51" cy="50" r="0.9"></circle></g>'
      + '<g class="rzf-eye" data-eye="r"><ellipse cx="70" cy="51" rx="2.8" ry="3.2"></ellipse><circle class="rzf-glint" cx="71" cy="50" r="0.9"></circle></g>'
      + '</g>'
      + '<path class="rzf-brow" data-brow="l" d="M43 42 Q 50 39 56 41.5"></path><path class="rzf-brow" data-brow="r" d="M64 41.5 Q 70 39 77 42"></path>'
      + '<g class="rzf-glasses"><circle cx="50" cy="51" r="8.5"></circle><circle cx="70" cy="51" r="8.5"></circle>'
      + '<path d="M58.5 50.5 Q 60 49 61.5 50.5"></path><path d="M41.5 50 L 36 48"></path><path d="M78.5 50 L 84 48"></path></g>'
      + '<path class="rzf-nose" d="M60 54 Q 57 61.5 59 63 Q 60.5 63.8 62 63"></path>'
      + '<ellipse class="rzf-cheek" cx="45" cy="63" rx="5" ry="2.6"></ellipse><ellipse class="rzf-cheek" cx="75" cy="63" rx="5" ry="2.6"></ellipse>'
      + '<path class="rzf-mouth" d="M53 71 Q 60 74 67 71 Q 60 74 53 71 Z"></path>'
      + '<path class="rzf-moustache" d="M51.5 68.5 C 54 65.2 58 65.6 60 67 C 62 65.6 66 65.2 68.5 68.5 C 65.5 68 62.5 68.6 60 69.2 C 57.5 68.6 54.5 68 51.5 68.5 Z"></path>'
      + '</g>'
      + '</svg>';
  }

  /* Animation de l'avatar du panneau : clignements, regard, tête, bouche qui suit la parole (le son
     des voix n'est pas analysé : une ouverture rythmée, irrégulière, qui ne s'arrête qu'avec la voix). */
  var ANIM = { raf: 0, last: 0, t: 0, blinkAt: 0, open: 0, tilt: 0, gx: 0, gy: 0, brow: 0, nextSyl: 0, sylT: 0 };
  function animStart() { if (!ANIM.raf) { ANIM.last = performance.now(); ANIM.raf = requestAnimationFrame(frame); } }
  function animStop() { if (ANIM.raf) cancelAnimationFrame(ANIM.raf); ANIM.raf = 0; }
  function approach(cur, target, rate, dt) { return cur + (target - cur) * (1 - Math.exp(-rate * dt)); }
  function frame(now) {
    ANIM.raf = 0;
    var svg = ROOT && ROOT.querySelector('.rzf-avatar .rzf-face');
    if (!svg || !P.open || document.hidden) return;
    var dt = Math.min(0.1, (now - ANIM.last) / 1000);
    ANIM.last = now; ANIM.t += dt;
    var m = P.mood;
    /* Bouche : des « syllabes » de 90 à 220 ms, d'ouverture variable, pendant la parole. */
    var target = 0;
    if (m === 'speak') {
      if (now > ANIM.nextSyl) { ANIM.sylT = 0.35 + Math.random() * 0.65; ANIM.nextSyl = now + 90 + Math.random() * 130; if (Math.random() < 0.12) ANIM.sylT = 0.05; }
      target = ANIM.sylT;
    }
    ANIM.open = approach(ANIM.open, target, m === 'speak' ? 26 : 12, dt);
    /* Regard et tête : en l'air quand il réfléchit, vers vous quand il écoute. */
    var gxT = m === 'think' ? 1.4 : Math.sin(ANIM.t * 0.37) * 0.6, gyT = m === 'think' ? -1.6 : (m === 'listen' ? 0.2 : Math.sin(ANIM.t * 0.23) * 0.4);
    ANIM.gx = approach(ANIM.gx, gxT, 6, dt); ANIM.gy = approach(ANIM.gy, gyT, 6, dt);
    var tiltT = m === 'think' ? -5 : (m === 'listen' ? 4 + Math.sin(ANIM.t * 2.2) * 1.5 : Math.sin(ANIM.t * 0.6) * 1.2);
    ANIM.tilt = approach(ANIM.tilt, tiltT, 4, dt);
    ANIM.brow = approach(ANIM.brow, m === 'think' || m === 'listen' ? 1 : (m === 'speak' ? 0.35 + ANIM.open * 0.4 : 0), 6, dt);
    /* Clignements, parfois doublés. */
    var lid = 1;
    if (!ANIM.blinkAt) ANIM.blinkAt = now + 1800;
    var bt = (now - ANIM.blinkAt) / 1000;
    if (bt > 0) {
      if (bt < 0.16) lid = Math.max(0.1, Math.abs(1 - 2 * (bt / 0.16)));
      else ANIM.blinkAt = now + (Math.random() < 0.15 ? 220 : 2400 + Math.random() * 3200);
    }
    var head = svg.querySelector('.rzf-head');
    var breathe = Math.sin(ANIM.t * 1.6) * 0.6;
    head.setAttribute('transform', 'rotate(' + ANIM.tilt.toFixed(2) + ' 60 80) translate(0 ' + breathe.toFixed(2) + ')');
    var eyes = svg.querySelectorAll('.rzf-eye');
    for (var i = 0; i < eyes.length; i++) {
      var cx = i ? 70 : 50;
      eyes[i].setAttribute('transform', 'translate(' + (ANIM.gx + cx).toFixed(2) + ' ' + (ANIM.gy + 51).toFixed(2) + ') scale(1 ' + lid.toFixed(2) + ') translate(' + (-cx) + ' -51)');
    }
    var lift = (ANIM.brow * 2.4).toFixed(2);
    svg.querySelector('[data-brow="l"]').setAttribute('transform', 'translate(0 -' + lift + ')');
    svg.querySelector('[data-brow="r"]').setAttribute('transform', 'translate(0 -' + lift + ')');
    /* Bouche : lèvre du haut fixe sous la moustache, lèvre du bas qui descend ; sourire au repos. */
    var o = ANIM.open * 7, smile = m === 'think' ? 0.5 : 2.6, w = 7 - ANIM.open * 1.6;
    var d = 'M' + (60 - w).toFixed(1) + ' 71 Q 60 ' + (71 + smile * 0.5).toFixed(1) + ' ' + (60 + w).toFixed(1) + ' 71'
      + ' Q 60 ' + (71 + smile + o).toFixed(1) + ' ' + (60 - w).toFixed(1) + ' 71 Z';
    svg.querySelector('.rzf-mouth').setAttribute('d', d);
    ANIM.raf = requestAnimationFrame(frame);
  }
  function setMood(m) {
    P.mood = m;
    if (ROOT) ROOT.setAttribute('data-mood', m);
    patchStatus();
    if (P.open) animStart();
  }

  /* ══ Montage : hors du rendu de la page ═══════════════════════════════ */

  var ROOT = null, TIP = null;
  function mount() {
    if (ROOT) return;
    try { P.big = localStorage.getItem(BIG_KEY) === '1'; } catch (e) { /* stockage refusé */ }
    ROOT = document.createElement('div');
    ROOT.className = 'rzf';
    ROOT.hidden = true;
    ROOT.setAttribute('data-mood', 'rest');
    ROOT.innerHTML = '<button type="button" class="rzf-fab" data-act="rz-prof-open" aria-label="Demander au professeur" title="Une question ? Demandez à ' + NAME + ', votre professeur">'
      + faceSvg('is-mini') + '<span class="rzf-fab-dot" hidden></span></button>'
      + '<section class="rzf-panel" role="dialog" aria-label="' + NAME + ', votre professeur d’anglais" hidden>'
      + '<div class="rzf-grab" data-act="rz-prof-big" title="Agrandir ou réduire"></div>'
      + '<header class="rzf-head"><div class="rzf-avatar">' + faceSvg('') + '</div>'
      + '<div class="rzf-who"><b>' + NAME + '</b><span class="rzf-status" data-rzf-status></span></div>'
      + '<div class="rzf-head-btns" data-rzf-headbtns></div></header>'
      + '<div class="rzf-bar" data-rzf-bar></div>'
      + '<div class="rzf-log" data-rzf-log aria-live="polite"></div>'
      + '<div class="rzf-foot"><div data-rzf-chips></div>'
      + '<div class="rzf-input"><textarea class="rzf-text" rows="1" data-role="rz-prof-draft" data-focus-key="rz-prof-draft" data-dict="off" placeholder="Posez votre question…" aria-label="Votre question"></textarea>'
      + '<span data-rzf-mic></span>'
      + '<button type="button" class="rzf-send" data-act="rz-prof-send" aria-label="Envoyer" title="Envoyer (Entrée)">' + sendIcon() + '</button></div></div>'
      + '</section>';
    document.body.appendChild(ROOT);
    TIP = document.createElement('button');
    TIP.type = 'button';
    TIP.className = 'rzf-tip';
    TIP.hidden = true;
    TIP.innerHTML = faceSvg('is-tiny') + '<span>Demander à ' + NAME + '</span>';
    document.body.appendChild(TIP);

    var ta = ROOT.querySelector('.rzf-text');
    /* Les raccourcis de la page (Entrée, Espace, 1 à 4…) ne doivent pas voir la frappe du panneau. */
    ta.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    ta.addEventListener('input', autoGrow);
    ROOT.querySelector('.rzf-panel').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    TIP.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    TIP.addEventListener('click', function () {
      var text = TIP.getAttribute('data-text') || '';
      hideTip();
      if (text) explainSelection(text);
    });
    bindSelection();
  }

  function sendIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 12 L20 4 L14 20 L11 13 Z" fill="currentColor"></path></svg>'; }
  function speakerIcon(on) {
    return '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"></path>'
      + (on ? '<path d="M16 8.5a4.5 4.5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>'
        : '<path d="M16.5 9.5l5 5M21.5 9.5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>') + '</svg>';
  }
  function svgIcon(path) { return '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>'; }
  var ICON = {
    gear: svgIcon('<circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"></path>'),
    fresh: svgIcon('<path d="M12 5v14M5 12h14"></path>'),
    big: svgIcon('<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"></path>'),
    small: svgIcon('<path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7"></path>'),
    close: svgIcon('<path d="M6 6l12 12M18 6L6 18"></path>'),
    mic: svgIcon('<rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3"></path>'),
    stop: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"></rect></svg>',
    play: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"></path><path d="M16 8.5a4.5 4.5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>',
    screen: svgIcon('<rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8M12 16v4"></path>'),
    quote: svgIcon('<path d="M7 7h4v4H8c0 2 1 3 3 3M15 7h4v4h-3c0 2 1 3 3 3"></path>')
  };

  /* ══ Visibilité ═══════════════════════════════════════════════════════ */

  function onRevizatorPage() {
    var app = document.getElementById('app');
    return !!app && app.getAttribute('data-page') === 'revizator';
  }
  function hiddenByView() {
    var host = document.getElementById('page-host');
    return !!(host && host.querySelector(HIDE_WHEN));
  }
  function sync() {
    if (!R.isLoaded()) { if (ROOT) ROOT.hidden = true; hideTip(); return; }
    mount();
    var show = enabled() && onRevizatorPage() && !hiddenByView();
    if (!show) {
      if (!ROOT.hidden) { ROOT.hidden = true; hideTip(); if (P.open) close(true); stopSpeaking(); }
      return;
    }
    ROOT.hidden = false;
    ROOT.classList.toggle('is-big', !!P.big);
    var dot = ROOT.querySelector('.rzf-fab-dot');
    if (dot) dot.hidden = !P.unread;
    /* La vue a pu changer : « À l'écran : … » suit. */
    if (P.open) renderChips();
  }

  function open(focus) {
    if (!enabled()) return;
    mount();
    P.open = true; P.unread = false;
    ROOT.classList.add('is-open');
    ROOT.querySelector('.rzf-panel').hidden = false;
    ROOT.querySelector('.rzf-fab').hidden = true;
    hideTip();
    renderAll();
    scrollLog(true);
    animStart();
    if (focus !== false && !coarse()) { var ta = ROOT.querySelector('.rzf-text'); if (ta) ta.focus(); }
  }
  function close(silent) {
    if (!ROOT) return;
    P.open = false; P.gear = false;
    ROOT.classList.remove('is-open');
    ROOT.querySelector('.rzf-panel').hidden = true;
    ROOT.querySelector('.rzf-fab').hidden = false;
    if (P.rec) micCancel();
    stopSpeaking();
    animStop();
    if (!silent) { var b = ROOT.querySelector('.rzf-fab'); if (b && !coarse()) b.focus(); }
  }
  function coarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }

  /* ══ Rendu (sur place, par morceaux) ══════════════════════════════════ */

  function renderAll() { if (!ROOT) return; patchStatus(); renderHeadBtns(); renderBar(); renderLog(); renderChips(); renderMic(); syncDraft(); }

  function patchStatus() {
    var el = ROOT && ROOT.querySelector('[data-rzf-status]');
    if (!el) return;
    var s = P.recPhase === 'recording' ? t('vous écoute…', 'is listening…')
      : (P.recPhase === 'processing' ? t('transcrit ce que vous avez dit…', 'is transcribing…')
        : (P.busy ? t('réfléchit…', 'is thinking…') : (P.mood === 'speak' ? t('parle…', 'is speaking…') : t('votre professeur d’anglais', 'your English teacher'))));
    el.textContent = s;
  }

  function renderHeadBtns() {
    var el = ROOT.querySelector('[data-rzf-headbtns]');
    var voice = R.prefs.profVoice !== false;
    el.innerHTML = '<button type="button" class="rzf-ibtn' + (voice ? ' on' : '') + '" data-act="rz-prof-voice" aria-pressed="' + voice + '" title="' + (voice ? 'Réponses lues à voix haute (couper)' : 'Réponses écrites seulement (lire à voix haute)') + '">' + speakerIcon(voice) + '</button>'
      + '<button type="button" class="rzf-ibtn' + (P.gear ? ' on' : '') + '" data-act="rz-prof-gear" aria-expanded="' + !!P.gear + '" title="Niveau et réglages du professeur">' + ICON.gear + '</button>'
      + '<button type="button" class="rzf-ibtn" data-act="rz-prof-new" title="Nouvelle discussion">' + ICON.fresh + '</button>'
      + '<button type="button" class="rzf-ibtn is-desk" data-act="rz-prof-big" title="' + (P.big ? 'Réduire le panneau' : 'Agrandir le panneau') + '">' + (P.big ? ICON.small : ICON.big) + '</button>'
      + '<button type="button" class="rzf-ibtn" data-act="rz-prof-close" title="Fermer (Échap)">' + ICON.close + '</button>';
  }

  function renderBar() {
    var el = ROOT.querySelector('[data-rzf-bar]');
    var l = lang(), auto = !/^(fr|en|mix)$/.test(R.prefs.profLang || '');
    var h = '<div class="rzf-seg" role="radiogroup" aria-label="Langue des explications">' + LANGS.map(function (x) {
      var on = x[0] === l;
      return '<button type="button" role="radio" aria-checked="' + on + '" class="' + (on ? 'on' : '') + '" data-act="rz-prof-lang" data-value="' + x[0] + '" title="' + esc(x[2]) + '">' + esc(x[1]) + '</button>';
    }).join('') + '</div>';
    h += '<span class="rzf-level" title="Niveau du professeur">' + esc(depthLabel()) + '</span>';
    if (P.gear) {
      h += '<div class="rzf-gear">'
        + '<div class="rzf-gear-k">Niveau du professeur</div>'
        + '<div class="rzf-chips">' + DEPTHS.map(function (x) {
          var on = (R.prefs.profLevel || 'auto') === x[0];
          return '<button type="button" class="rzf-chip' + (on ? ' on' : '') + '" data-act="rz-prof-depth" data-value="' + x[0] + '" aria-pressed="' + on + '">' + esc(x[1]) + '</button>';
        }).join('') + '</div>'
        + '<div class="rzf-gear-help">Plus le niveau monte, plus les explications vont loin (nuances, exceptions, termes exacts) et plus son anglais est riche.</div>'
        + '<div class="rzf-gear-row"><button type="button" class="rzf-chip" data-act="rz-prof-lang" data-value="auto"' + (auto ? ' aria-pressed="true"' : '') + '>Langue selon mon niveau</button>'
        + '<button type="button" class="rzf-link" data-act="rz-settings">Tous les réglages…</button></div>'
        + '</div>';
    }
    el.innerHTML = h;
  }
  function depthLabel() {
    var v = R.prefs.profLevel || 'auto';
    for (var i = 0; i < DEPTHS.length; i++) if (DEPTHS[i][0] === v) return v === 'auto' ? 'Niveau ' + R.globalBand() : DEPTHS[i][1];
    return '';
  }

  function md(text) {
    var inline = function (s) {
      return esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(«“])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
    };
    return String(text || '').split(/\n{2,}/).map(function (block) {
      var lines = block.split('\n');
      if (lines.every(function (l) { return /^\s*[-•*]\s+/.test(l); })) {
        return '<ul>' + lines.map(function (l) { return '<li>' + inline(l.replace(/^\s*[-•*]\s+/, '')) + '</li>'; }).join('') + '</ul>';
      }
      return '<p>' + lines.map(function (l) { return /^\s*[-•]\s+/.test(l) ? '• ' + inline(l.replace(/^\s*[-•]\s+/, '')) : inline(l); }).join('<br>') + '</p>';
    }).join('');
  }

  function welcomeHtml() {
    var starters = lang() === 'en'
      ? ['Can you explain what’s on my screen?', 'Present perfect or simple past?', 'What are my weak points?', 'Suggest some exercises for me.']
      : ['Expliquez-moi ce qui est à l’écran.', 'Present perfect ou prétérit ?', 'Quels sont mes points faibles ?', 'Proposez-moi des exercices.'];
    return '<div class="rzf-msg is-prof is-welcome"><div class="rzf-bubble">'
      + md(t('Bonjour ! Je suis **' + NAME + '**, votre professeur d’anglais. Demandez-moi d’expliquer ce que vous voyez à l’écran, un mot, une règle — ce que vous voulez. Je peux l’expliquer de plusieurs manières, et vous préparer des exercices là-dessus.\n\nAstuce : sélectionnez un passage de la page, puis « Demander à ' + NAME + ' ».',
        'Hello! I’m **' + NAME + '**, your English teacher. Ask me to explain what’s on your screen, a word, a rule — anything you like. I can explain it in several ways, and prepare exercises on it.\n\nTip: select some text on the page, then “Demander à ' + NAME + '”.'))
      + '</div><div class="rzf-follow">' + starters.map(function (s) {
        return '<button type="button" class="rzf-chip" data-act="rz-prof-ask" data-text="' + esc(s) + '">' + esc(s) + '</button>';
      }).join('') + '</div></div>';
  }

  function msgHtml(m, last) {
    if (m.role === 'user') {
      return '<div class="rzf-msg is-user"><div class="rzf-bubble">'
        + (m.sel ? '<div class="rzf-quote">' + ICON.quote + '<span>' + esc(m.sel) + '</span></div>' : '')
        + esc(m.text).replace(/\n/g, '<br>') + '</div></div>';
    }
    var speaking = P.speakingId === m.id && P.mood === 'speak';
    var h = '<div class="rzf-msg is-prof" data-id="' + esc(m.id) + '"><div class="rzf-bubble">' + md(m.text);
    if (arr(m.examples).length) {
      h += '<ul class="rzf-ex">' + m.examples.map(function (x) {
        return '<li><span lang="en">' + esc(x.en) + '</span>' + (x.fr ? '<small>' + esc(x.fr) + '</small>' : '') + '</li>';
      }).join('') + '</ul>';
    }
    h += '<div class="rzf-tools"><button type="button" class="rzf-say' + (speaking ? ' on' : '') + '" data-act="rz-prof-say" data-id="' + esc(m.id) + '">'
      + (speaking ? ICON.stop + '<span>' + t('Arrêter', 'Stop') + '</span>' : ICON.play + '<span>' + t('Écouter', 'Listen') + '</span>') + '</button></div>';
    h += '</div>';
    var x = m.exercise;
    if (x && x.offer) {
      var meta = [SKILL_LABELS[x.skill] || '', x.type && R.exercise ? R.exercise.typeLabel(x.type) : t('Série sur mesure', 'Custom set'), (x.minutes || 10) + ' min'].filter(Boolean).join(' · ');
      h += '<div class="rzf-offer' + (x.state ? ' is-' + esc(x.state) : '') + '">'
        + '<div class="rzf-offer-k">' + t('Exercices proposés', 'Suggested exercises') + '</div>'
        + '<div class="rzf-offer-t">' + esc(x.titleFr || t('Une série sur ce point', 'A set on this point')) + '</div>'
        + '<div class="rzf-offer-meta">' + esc(meta) + '</div>'
        + '<div class="rzf-offer-focus">' + esc(x.focus) + '</div>';
      if (x.state === 'launched') h += '<div class="rzf-offer-done">' + t('Série en préparation : elle s’ouvre dans l’onglet Exercices.', 'Being prepared: it opens in the Exercises tab.') + '</div>';
      else if (x.state === 'declined') h += '<div class="rzf-offer-done">' + t('Laissée de côté.', 'Set aside.') + ' <button type="button" class="rzf-link" data-act="rz-prof-ex-go" data-id="' + esc(m.id) + '">' + t('La préparer quand même', 'Prepare it anyway') + '</button></div>';
      else {
        h += '<div class="rzf-offer-btns"><button type="button" class="btn btn-primary" data-act="rz-prof-ex-go" data-id="' + esc(m.id) + '">' + t('Préparer la série', 'Prepare the set') + '</button>'
          + '<button type="button" class="btn btn-ghost" data-act="rz-prof-ex-no" data-id="' + esc(m.id) + '">' + t('Pas maintenant', 'Not now') + '</button></div>';
      }
      h += '</div>';
    }
    if (last && arr(m.followUps).length && !P.busy) {
      h += '<div class="rzf-follow">' + m.followUps.map(function (s) {
        return '<button type="button" class="rzf-chip" data-act="rz-prof-ask" data-text="' + esc(s) + '">' + esc(s) + '</button>';
      }).join('') + '</div>';
    }
    return h + '</div>';
  }

  function renderLog() {
    var el = ROOT.querySelector('[data-rzf-log]');
    var c = chat(), h = [];
    if (!c.length) h.push(welcomeHtml());
    var lastProf = -1;
    for (var i = c.length - 1; i >= 0; i--) if (c[i].role === 'prof') { lastProf = i; break; }
    c.forEach(function (m, i) { h.push(msgHtml(m, i === lastProf && i === c.length - 1)); });
    if (P.busy) {
      h.push('<div class="rzf-msg is-prof is-typing"><div class="rzf-bubble"><span class="rzf-dots"><i></i><i></i><i></i></span>'
        + '<span class="rzf-typing-t">' + esc(NAME + ' ' + t('réfléchit…', 'is thinking…')) + '</span>'
        + '<button type="button" class="rzf-link" data-act="rz-prof-cancel">' + t('Annuler', 'Cancel') + '</button></div></div>');
    } else if (P.error) {
      h.push('<div class="rzf-err">' + esc(P.error) + ' <button type="button" class="rzf-link" data-act="rz-prof-retry">' + t('Réessayer', 'Try again') + '</button></div>');
    }
    el.innerHTML = h.join('');
  }
  function scrollLog(force) {
    var el = ROOT && ROOT.querySelector('[data-rzf-log]');
    if (!el) return;
    var near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (force || near) el.scrollTop = el.scrollHeight;
  }
  /* Une nouvelle réponse : on montre son début, pas sa fin (on la lit de haut en bas). */
  function scrollToMsg(id) {
    var el = ROOT && ROOT.querySelector('[data-rzf-log]');
    var m = el && el.querySelector('.rzf-msg[data-id="' + id + '"]');
    if (!m) { scrollLog(true); return; }
    var prev = m.previousElementSibling;
    el.scrollTop = Math.max(0, (prev || m).offsetTop - 8);
  }

  function renderChips() {
    var el = ROOT.querySelector('[data-rzf-chips]');
    var h = [];
    var ctx = [];
    var view = viewLabel();
    if (view) {
      ctx.push('<button type="button" class="rzf-ctx' + (P.screen ? ' on' : '') + '" data-act="rz-prof-screen" aria-pressed="' + !!P.screen + '" title="'
        + (P.screen ? 'Oliver voit ce qui est à l’écran (cliquer pour ne plus le lui montrer)' : 'Montrer à Oliver ce qui est à l’écran') + '">'
        + ICON.screen + '<span>' + esc(t('À l’écran : ', 'On screen: ') + view) + '</span></button>');
    }
    if (P.selection) {
      ctx.push('<span class="rzf-ctx on is-sel">' + ICON.quote + '<span>« ' + esc(P.selection.length > 40 ? P.selection.slice(0, 40) + '…' : P.selection) + ' »</span>'
        + '<button type="button" data-act="rz-prof-unsel" aria-label="Retirer la sélection">×</button></span>');
    }
    if (ctx.length) h.push('<div class="rzf-ctxs">' + ctx.join('') + '</div>');
    if (chat().some(function (m) { return m.role === 'prof'; })) {
      h.push('<div class="rzf-ways" role="group" aria-label="Demander une autre explication">' + WAYS.map(function (w) {
        return '<button type="button" class="rzf-chip is-way" data-act="rz-prof-way" data-way="' + w[0] + '"' + (P.busy ? ' disabled' : '') + '>' + esc(lang() === 'en' ? w[2] : w[1]) + '</button>';
      }).join('') + '</div>');
    }
    el.innerHTML = h.join('');
  }

  function renderMic() {
    var el = ROOT.querySelector('[data-rzf-mic]');
    var ph = P.recPhase;
    if (ph === 'recording' || ph === 'starting') {
      el.innerHTML = '<button type="button" class="rzf-mic on" data-act="rz-prof-mic" title="Terminer et envoyer" aria-label="Terminer et envoyer">' + ICON.stop
        + '<span class="rzf-mic-lvl"><i style="transform:scaleY(' + Math.max(0.12, P.recLevel || 0).toFixed(2) + ')"></i></span></button>';
    } else if (ph === 'processing') {
      el.innerHTML = '<span class="rzf-mic is-busy"><span class="rz-spin"></span></span>';
    } else {
      el.innerHTML = '<button type="button" class="rzf-mic" data-act="rz-prof-mic" title="Parler à ' + NAME + ' (micro)" aria-label="Parler au micro"' + (P.busy ? ' disabled' : '') + '>' + ICON.mic + '</button>';
    }
    var ta = ROOT.querySelector('.rzf-text');
    if (ta) {
      ta.placeholder = ph === 'recording' ? t('Parlez, puis touchez ■…', 'Speak, then tap ■…') : t('Posez votre question…', 'Ask your question…');
      ta.setAttribute('data-dict-lang', lang() === 'en' ? 'en' : 'fr');
    }
    var send = ROOT.querySelector('.rzf-send');
    if (send) send.disabled = !!P.busy;
  }
  function syncDraft() {
    var ta = ROOT.querySelector('.rzf-text');
    if (ta && ta.value !== P.draft) { ta.value = P.draft; autoGrow(); }
  }
  function autoGrow() {
    var ta = ROOT && ROOT.querySelector('.rzf-text');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
  }

  /* ══ Ce qui est à l'écran ═════════════════════════════════════════════ */

  function viewLabel() {
    var tab = document.querySelector('#page-bar .rz-tab.on span, .rz-tabs .rz-tab.on span');
    return tab ? String(tab.textContent || '').trim() : '';
  }
  /* Le texte visible de la vue, sans le bandeau de connexion ni les boutons : assez pour que le
     professeur sache de quoi on parle (une question, un texte, une correction). */
  function screenText() {
    var host = document.getElementById('page-host');
    var root = host && host.querySelector('.rz');
    if (!root) return '';
    var clone = root.cloneNode(true);
    var drop = clone.querySelectorAll('[data-rz-conn], button, svg, script, style, .rz-tabs, [aria-hidden="true"]');
    for (var i = 0; i < drop.length; i++) if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
    var text = String(clone.textContent || '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
    return text.slice(0, 3000);
  }

  /* ══ Discussion ═══════════════════════════════════════════════════════ */

  function push(m) {
    var c = chat();
    c.push(m);
    if (c.length > MAX_MSGS) c.splice(0, c.length - MAX_MSGS);
    store().at = Date.now();
    R.save();
  }

  function send() {
    var ta = ROOT && ROOT.querySelector('.rzf-text');
    var text = String(ta ? ta.value : P.draft).trim();
    if (!text) return;
    ask(text, '');
  }

  function ask(text, way) {
    if (P.busy || !enabled()) return;
    text = String(text || '').trim().slice(0, 2000);
    var w = wayDef(way);
    if (!text && w) text = lang() === 'en' ? w[4] : w[3];
    if (!text) return;
    stopSpeaking();
    var sel = P.selection;
    push({ id: R.uid('pfu'), role: 'user', text: text, way: way || '', sel: sel, at: Date.now() });
    P.selection = '';
    P.draft = '';
    if (ROOT) { var ta = ROOT.querySelector('.rzf-text'); if (ta) { ta.value = ''; autoGrow(); } }
    generate(way || '', sel);
  }

  function generate(way, sel) {
    var c = chat();
    var params = {
      lang: lang(), depth: R.prefs.profLevel || 'auto', level: R.globalBand(), way: way,
      screen: P.screen ? { view: viewLabel(), text: screenText() } : null,
      selection: sel || '',
      history: c.slice(-16).map(function (m) { return { role: m.role, text: m.role === 'user' && m.sel ? m.text + ' [passage : « ' + m.sel + ' »]' : m.text }; })
    };
    var job = P.job = R.uid('rzprof');
    P.busy = true; P.error = '';
    warmFr();
    setMood('think');
    if (ROOT) { renderLog(); renderChips(); renderMic(); scrollLog(true); }
    R.gen('prof', params, { job: job }).then(function (r) {
      if (P.job !== job) return;
      P.job = ''; P.busy = false;
      var d = (r && r.doc) || {};
      var m = {
        id: R.uid('pfp'), role: 'prof', text: String(d.reply || '').trim() || '…', at: Date.now(),
        speech: arr(d.speech), examples: arr(d.examples), followUps: arr(d.followUps),
        exercise: d.exercise && d.exercise.offer ? { offer: true, skill: d.exercise.skill, type: d.exercise.type, minutes: d.exercise.minutes, focus: d.exercise.focus, titleFr: d.exercise.titleFr, state: '' } : null
      };
      push(m);
      if (!P.open) { P.unread = true; sync(); }
      setMood('rest');
      if (ROOT) { renderLog(); renderChips(); renderMic(); scrollToMsg(m.id); }
      if (R.prefs.profVoice !== false && P.open) speak(m);
    }, function (e) {
      if (P.job !== job) return;
      P.job = ''; P.busy = false;
      P.error = (e && e.message) || t('Le professeur n’a pas pu répondre.', 'The teacher could not answer.');
      setMood('rest');
      if (ROOT) { renderLog(); renderChips(); renderMic(); scrollLog(true); }
    });
  }

  /* Réessayer : la dernière question repart telle quelle (elle est déjà dans la discussion). */
  function retry() {
    var c = chat(), last = c[c.length - 1];
    if (!last || last.role !== 'user' || P.busy) return;
    generate(last.way || '', last.sel || '');
  }
  function cancel() {
    if (!P.busy) return;
    var job = P.job;
    P.job = ''; P.busy = false; P.error = '';
    if (job) R.cancel(job);
    setMood('rest');
    renderLog(); renderChips(); renderMic();
  }

  function explainSelection(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!text) return;
    P.selection = text;
    open(false);
    var q = lang() === 'en' ? 'Can you explain this?' : 'Pouvez-vous m’expliquer ce passage ?';
    if (text.split(' ').length <= 3) q = lang() === 'en' ? 'What does “' + text + '” mean, and how do I use it?' : 'Que veut dire « ' + text + ' », et comment l’employer ?';
    ask(q, '');
  }

  function newChat() {
    var c = chat();
    if (!c.length) return;
    var saved = c.slice();
    cancel();
    stopSpeaking();
    store().chat = [];
    P.error = ''; P.selection = '';
    R.save();
    renderAll();
    R.toast('Nouvelle discussion avec ' + NAME + '.', { label: 'Annuler', run: function () { store().chat = saved; R.save(); if (ROOT) renderAll(); } });
  }

  function msgById(id) { var c = chat(); for (var i = 0; i < c.length; i++) if (c[i].id === id) return c[i]; return null; }

  function launchExercise(id) {
    var m = msgById(id), x = m && m.exercise;
    if (!x || !R.exercise) return;
    var job = R.exercise.launch({ skill: x.skill, type: x.type, minutes: x.minutes, focus: x.focus, topic: '' });
    if (job === null) return; /* une série est déjà en préparation : exercise.js l'a dit */
    x.state = 'launched';
    push({ id: R.uid('pfp'), role: 'prof', text: t('C’est parti : je vous prépare « ' + (x.titleFr || 'la série') + ' ». Elle s’ouvre d’elle-même dans l’onglet **Exercices** (une demi-minute environ). Revenez me voir si une question vous pose problème !',
      'Here we go: I’m preparing “' + (x.titleFr || 'the set') + '”. It opens by itself in the **Exercises** tab (about thirty seconds). Come back if a question gives you trouble!'), at: Date.now(), speech: [], examples: [], followUps: [] });
    R.save();
    renderLog(); scrollLog(true);
    /* Sur un petit écran, le panneau cède la place à la série. */
    if (window.innerWidth <= 600) close(true);
  }

  /* ══ Voix : les voix naturelles de Révizator pour l'anglais (Kokoro) et le français (Tom) ════════
     Tom (67 Mo) se télécharge depuis Réglages › Voix, ou de lui-même en arrière-plan à la première phrase
     française. Sans voix naturelles, ou tant que Tom n'est pas là, le français passe par une voix de
     l'appareil (speechSynthesis). */

  var FR_VOICE = 'fr_tom';
  /* frUntil : la voix française a échoué (en téléchargement, serveur pas à jour) ; on n'y revient qu'après. */
  var SAY = { token: 0, utter: null, frUntil: 0, frTold: false };
  function plain(text) { return String(text || '').replace(/\*\*?|`/g, '').replace(/^\s*[-•]\s+/gm, '').replace(/\n+/g, ' ').trim(); }

  function speak(m) {
    stopSpeaking();
    var segs = arr(m.speech).filter(function (s) { return s && s.text; });
    if (!segs.length) segs = [{ lang: lang() === 'en' ? 'en' : 'fr', text: plain(m.text).slice(0, 1200) }];
    var token = ++SAY.token, i = 0;
    P.speakingId = m.id;
    setMood('speak');
    renderLog();
    (function next() {
      if (token !== SAY.token) return;
      if (i >= segs.length) { finish(); return; }
      var s = segs[i++];
      (s.lang === 'en' ? sayEn(s.text) : sayFr(s.text, token)).then(next, next);
    })();
    function finish() {
      if (token !== SAY.token) return;
      P.speakingId = '';
      setMood('rest');
      if (ROOT && P.open) renderLog();
    }
  }
  function sayEn(text) {
    try {
      var pl = R.tts.say(text, { key: 'rzf-say', accent: 'en-GB', gender: 'male' });
      return pl && pl.done ? pl.done : Promise.resolve();
    } catch (e) { return Promise.resolve(); }
  }
  function sayFr(text, token) {
    if (R.tts.engine() !== 'kokoro' || Date.now() < SAY.frUntil) return sayFrDevice(text);
    try {
      var pl = R.tts.say(text, { key: 'rzf-say', voice: FR_VOICE, engine: 'kokoro' });
      return pl.done.then(function (p) {
        if (!p || p.state !== 'error' || token !== SAY.token) return null;
        /* Voix française indisponible (en téléchargement, serveur pas à jour) : la voix de l'appareil pendant
           deux minutes, puis on réessaie ; on dit pourquoi une fois. */
        SAY.frUntil = Date.now() + 120000;
        if (!SAY.frTold) {
          SAY.frTold = true;
          R.toast(/se télécharge/.test(p.error || '') ? p.error + ' En attendant, ' + NAME + ' parle français avec la voix de l’appareil.'
            : 'Voix française naturelle indisponible (' + (p.error || 'synthèse impossible') + ') : ' + NAME + ' parle français avec la voix de l’appareil. Voir Réglages › Révizator › Voix.');
          R.tts.refresh();
        }
        return sayFrDevice(text);
      });
    } catch (e) { return sayFrDevice(text); }
  }
  /* Pendant que le professeur réfléchit, l'hôte prépare la voix française (et son complément au besoin). */
  function warmFr() {
    if (lang() === 'en' || R.prefs.profVoice === false || R.tts.engine() !== 'kokoro' || Date.now() < SAY.frUntil) return;
    bridge.call('ttsWarm', { accent: 'fr-FR' }, 15000)['catch'](function () { /* redit à la synthèse */ });
  }
  function frVoice() {
    var ss = window.speechSynthesis;
    if (!ss) return null;
    var list = [];
    try { list = ss.getVoices().filter(function (v) { return /^fr([-_]|$)/i.test(v.lang); }); } catch (e) { list = []; }
    if (!list.length) return null;
    var score = function (v) {
      var n = String(v.name || '');
      return (/fr[-_]FR/i.test(v.lang) ? 4 : 0) + (/natural|neural|online|premium|enhanced/i.test(n) ? 3 : 0) + (/google/i.test(n) ? 1 : 0)
        + (/paul|henri|thomas|daniel|remy|rémy|nicolas|denise|vivienne|amélie/i.test(n) ? 1 : 0);
    };
    return list.sort(function (a, b) { return score(b) - score(a); })[0];
  }
  function sayFrDevice(text) {
    return new Promise(function (res) {
      var ss = window.speechSynthesis;
      if (!ss || typeof SpeechSynthesisUtterance === 'undefined') { res(); return; }
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'fr-FR';
      var v = frVoice();
      if (v) u.voice = v;
      var done = false;
      var end = function () { if (done) return; done = true; clearTimeout(guard); res(); };
      /* Filet : certains moteurs n'annoncent jamais la fin. */
      var guard = setTimeout(end, 3000 + text.length * 110);
      u.onend = end; u.onerror = end;
      SAY.utter = u;
      try { ss.speak(u); } catch (e) { end(); }
    });
  }
  function stopSpeaking() {
    SAY.token++;
    var pl = R.players && R.players['rzf-say'];
    if (pl && pl.state !== 'ended') { try { pl.stop(true); } catch (e) { /* déjà arrêté */ } }
    if (SAY.utter && window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) { /* rien à arrêter */ } }
    SAY.utter = null;
    var was = P.speakingId;
    P.speakingId = '';
    if (P.mood === 'speak') setMood('rest');
    if (was && ROOT && P.open) renderLog();
  }

  /* ══ Micro : on parle au professeur (Whisper, dans la langue de la discussion) ══════════════ */

  function micToggle() {
    if (P.recPhase === 'recording') { micStop(); return; }
    if (P.recPhase !== 'idle' || P.busy) return;
    if (R.rec.busy()) { R.toast('Le micro est déjà pris par un enregistrement en cours.'); return; }
    stopSpeaking();
    P.recPhase = 'starting'; P.recMs = 0; P.recLevel = 0;
    renderMic(); patchStatus();
    Promise.resolve(R.rec.start({
      maxMs: 90000,
      onTick: function (ms, level) {
        P.recMs = ms; P.recLevel = level;
        var bar = ROOT && ROOT.querySelector('.rzf-mic-lvl i');
        if (bar) bar.style.transform = 'scaleY(' + Math.max(0.12, level || 0).toFixed(2) + ')';
      },
      onLimit: function () { micStop(); }
    })).then(function (rec) {
      if (P.recPhase !== 'starting') { try { rec.cancel(); } catch (e) { /* déjà arrêté */ } return; }
      P.rec = rec; P.recPhase = 'recording';
      setMood('listen');
      renderMic();
    }, function (e) {
      P.recPhase = 'idle';
      renderMic(); patchStatus();
      R.toast('Micro indisponible : ' + ((e && e.message) || 'accès refusé') + '.');
    });
  }
  function micStop() {
    var rec = P.rec;
    if (!rec) return;
    P.rec = null; P.recPhase = 'processing';
    setMood('think');
    renderMic();
    var l = lang();
    Promise.resolve(rec.stop()).then(function (a) {
      return bridge.call('transcribe', { job: R.uid('rzfstt'), data: a.data, model: R.prefs.whisperModel || 'small', language: l === 'en' ? 'en' : (l === 'fr' ? 'fr' : 'auto') }, 600000);
    }).then(function (r) {
      P.recPhase = 'idle';
      setMood('rest');
      renderMic();
      var text = String((r && r.text) || '').trim();
      if (text) ask(text, '');
      else R.toast(t('Je n’ai rien entendu : réessayez, ou écrivez votre question.', 'I didn’t hear anything: try again, or type your question.'));
    }, function (e) {
      P.recPhase = 'idle';
      setMood('rest');
      renderMic();
      var msg = (e && e.message) || '';
      if (!/annulé|rien d’enregistré/.test(msg)) R.toast('Transcription impossible : ' + msg);
    });
  }
  function micCancel() {
    var rec = P.rec;
    P.rec = null; P.recPhase = 'idle';
    if (rec) { try { rec.cancel(); } catch (e) { /* déjà arrêté */ } }
    if (P.mood === 'listen') setMood('rest');
    if (ROOT) renderMic();
  }

  /* ══ L'info-bulle de la sélection ═════════════════════════════════════ */

  var selTimer = 0;
  function bindSelection() {
    var check = function () {
      clearTimeout(selTimer);
      selTimer = setTimeout(placeTip, 260);
    };
    document.addEventListener('mouseup', check);
    document.addEventListener('touchend', check, { passive: true });
    document.addEventListener('selectionchange', function () { if (!TIP.hidden || coarse()) check(); });
    document.addEventListener('keyup', function (e) { if (e.shiftKey) check(); });
    window.addEventListener('scroll', hideTip, { capture: true, passive: true });
    window.addEventListener('resize', hideTip);
  }
  function hideTip() { if (TIP && !TIP.hidden) { TIP.hidden = true; TIP.removeAttribute('data-text'); } }
  function placeTip() {
    if (!TIP || !ROOT || ROOT.hidden) { hideTip(); return; }
    var sel = window.getSelection ? window.getSelection() : null;
    var text = sel ? String(sel.toString() || '').replace(/\s+/g, ' ').trim() : '';
    if (!sel || sel.isCollapsed || text.length < 2 || text.length > 400) { hideTip(); return; }
    var node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode);
    var host = document.getElementById('page-host');
    if (!node || !host || !host.contains(node) || (node.closest && node.closest('input, textarea, [contenteditable]'))) { hideTip(); return; }
    var rect;
    try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) { rect = null; }
    if (!rect || (!rect.width && !rect.height)) { hideTip(); return; }
    TIP.setAttribute('data-text', text);
    TIP.hidden = false;
    var w = TIP.offsetWidth || 170, h = TIP.offsetHeight || 34;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    /* Au doigt, le menu du téléphone s'affiche au-dessus de la sélection : la bulle passe dessous. */
    var top = coarse() || rect.top < h + 14 ? rect.bottom + 10 : rect.top - h - 10;
    TIP.style.left = Math.round(left) + 'px';
    TIP.style.top = Math.round(Math.min(window.innerHeight - h - 8, top)) + 'px';
  }

  /* ══ Actions ══════════════════════════════════════════════════════════ */

  R.act('rz-prof-open', function () { open(); });
  R.act('rz-prof-close', function () { close(); });
  R.act('rz-prof-send', function () { send(); });
  R.act('rz-prof-ask', function (el) { ask(el.getAttribute('data-text'), ''); });
  R.act('rz-prof-way', function (el) { ask('', el.getAttribute('data-way')); });
  R.act('rz-prof-retry', function () { retry(); });
  R.act('rz-prof-cancel', function () { cancel(); });
  R.act('rz-prof-new', function () { newChat(); });
  R.act('rz-prof-mic', function () { micToggle(); });
  R.act('rz-prof-screen', function () { P.screen = !P.screen; renderChips(); });
  R.act('rz-prof-unsel', function () { P.selection = ''; renderChips(); });
  R.act('rz-prof-gear', function () { P.gear = !P.gear; renderHeadBtns(); renderBar(); });
  R.act('rz-prof-big', function () {
    P.big = !P.big;
    try { localStorage.setItem(BIG_KEY, P.big ? '1' : '0'); } catch (e) { /* stockage refusé : pour cette fois */ }
    if (ROOT) { ROOT.classList.toggle('is-big', P.big); renderHeadBtns(); scrollLog(); }
  });
  R.act('rz-prof-voice', function () {
    R.prefs.profVoice = R.prefs.profVoice === false;
    R.save();
    if (!R.prefs.profVoice) stopSpeaking();
    renderHeadBtns();
  });
  R.act('rz-prof-lang', function (el) {
    R.prefs.profLang = el.getAttribute('data-value') || 'auto';
    R.save();
    renderAll();
  });
  R.act('rz-prof-depth', function (el) {
    R.prefs.profLevel = el.getAttribute('data-value') || 'auto';
    R.save();
    renderBar();
  });
  R.act('rz-prof-say', function (el) {
    var id = el.getAttribute('data-id');
    if (P.speakingId === id) { stopSpeaking(); return; }
    var m = msgById(id);
    if (m) speak(m);
  });
  R.act('rz-prof-ex-go', function (el) { launchExercise(el.getAttribute('data-id')); });
  R.act('rz-prof-ex-no', function (el) {
    var m = msgById(el.getAttribute('data-id'));
    if (m && m.exercise) { m.exercise.state = 'declined'; R.save(); renderLog(); }
  });
  /* Réglages › Révizator › Professeur : les valeurs vrai / faux restent des booléens. */
  R.act('rz-prof-pref', function (el) {
    var f = el.getAttribute('data-name'), v = el.getAttribute('data-value');
    if (!/^prof(Enabled|Voice|Lang|Level)$/.test(f)) return;
    R.prefs[f] = v === 'true' ? true : (v === 'false' ? false : v);
    R.save();
    if (f === 'profVoice' && v === 'false') stopSpeaking();
    R.render();
    sync();
    if (ROOT && P.open) renderAll();
  });
  R.input('rz-prof-draft', function (el) { P.draft = el.value; });

  /* ══ Réglages › Révizator ═════════════════════════════════════════════ */

  R.settingsSection({
    id: 'prof', order: 20,
    html: function () {
      var p = R.prefs;
      var chips = function (name, values, labels) {
        var cur = String(p[name] == null ? '' : p[name]);
        return '<div class="rz-chips" role="radiogroup">' + values.map(function (v, i) {
          var on = String(v) === cur;
          return '<button type="button" role="radio" aria-checked="' + on + '" class="rz-chip' + (on ? ' on' : '') + '" data-act="rz-prof-pref" data-name="' + name + '" data-value="' + esc(String(v)) + '">' + esc(labels[i]) + '</button>';
        }).join('') + '</div>';
      };
      var h = ['<div class="set-card"><div class="set-card-head"><span class="set-card-title">Professeur</span></div>'];
      h.push('<div class="rz-set-help">' + esc(NAME + ', un professeur toujours à portée de clic, dans le coin de la page : il explique ce qui est à l’écran ou ce que vous voulez, de plusieurs manières, à l’écrit et à voix haute, et vous propose des exercices sur ce dont vous avez parlé.') + '</div>');
      h.push(R.setField('Afficher le professeur', chips('profEnabled', ['true', 'false'], ['Oui', 'Non'])));
      h.push(R.setField('Langue des explications', chips('profLang', ['auto', 'fr', 'mix', 'en'], ['Selon mon niveau', 'Français', 'Mélange anglais-français', 'Anglais'])));
      h.push(R.setField('Niveau du professeur', chips('profLevel', DEPTHS.map(function (x) { return x[0]; }), DEPTHS.map(function (x) { return x[1]; }))));
      h.push('<div class="rz-set-help">Le niveau règle la profondeur des explications (de « une idée à la fois » à « explications de linguiste ») et l’anglais qu’il emploie. « Adapté à mon niveau » suit votre niveau estimé.</div>');
      h.push(R.setField('Réponses à voix haute', chips('profVoice', ['true', 'false'], ['Oui', 'Non, à l’écrit seulement'])));
      var st = R.tts.status(), fr = R.tts.ready()
        ? (st.model && st.model.french ? 'Le français a sa voix naturelle (Tom).' : 'Sa voix naturelle française (Tom, 67 Mo) se télécharge depuis la carte Voix ci-dessus, ou d’elle-même à sa première réponse en français.')
        : 'Avec les voix naturelles (ci-dessus), il parle aussi français avec une voix naturelle ; sans elles, avec une voix de l’appareil.';
      h.push('<div class="set-card-foot">L’anglais est lu par les voix naturelles de Révizator (voix britannique masculine). ' + esc(fr) + ' Chaque réponse compte dans le quota Claude Code ; son modèle se règle dans « Agents (Claude Code) » ci-dessus.</div></div>');
      return h.join('');
    }
  });

  /* ══ Branchements ═════════════════════════════════════════════════════ */

  R.on('render', sync);
  R.on('loaded', sync);
  R.on('reloaded', function () { sync(); if (ROOT && P.open) renderAll(); });
  R.on('pagehide', function () { if (ROOT) { ROOT.hidden = true; hideTip(); if (P.open) close(true); } stopSpeaking(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && P.open) animStart(); });

  /* ══ Simulation hors WebView2 ═════════════════════════════════════════ */

  R.fixture('prof', function (p) {
    var hist = arr(p.history), last = hist.length ? String(hist[hist.length - 1].text || '') : '';
    var en = p.lang === 'en', mix = p.lang === 'mix';
    var wantEx = p.way === 'exercise' || /exerci/i.test(last);
    var reply = en
      ? 'Use the **present perfect** (*have + past participle*) when the past action still matters **now**, with no finished time: *I’ve lost my keys* (I still can’t find them).\n\nUse the **simple past** for a **finished time**: *I lost my keys yesterday*.\n\n- Trap for French speakers: *“I have seen him yesterday”* is wrong — *yesterday* is finished.\n- Quick test: can you add *yesterday*, *in 2019*, *last week*? Then it’s the simple past.\n\nYour turn: *I ___ (never / be) to Scotland.*'
      : (mix
        ? 'Use the **present perfect** when the past still matters **now**: *I’ve lost my keys.*\n\nAutrement dit : l’action est passée, mais c’est son **résultat présent** qui compte. Avec un moment terminé (*yesterday*, *in 2019*), c’est le **prétérit** : *I lost my keys yesterday.*\n\n- Le piège du francophone : « j’ai vu » ne se traduit pas toujours par *I have seen*.\n\nYour turn: *I ___ (never / be) to Scotland.*'
        : 'On emploie le **present perfect** (*have + participe passé*) quand l’action passée compte encore **maintenant**, sans moment terminé : *I’ve lost my keys* (je ne les ai toujours pas).\n\nAvec un **moment terminé** (*yesterday*, *in 2019*, *last week*), c’est le **prétérit** : *I lost my keys yesterday.*\n\n- Le piège : « j’ai vu » ne se traduit pas toujours par *I have seen* ; *“I have seen him yesterday”* est faux.\n- Le test : pouvez-vous ajouter *hier* ? Alors c’est le prétérit.\n\nÀ vous : *I ___ (never / be) to Scotland.*');
    if (p.way === 'simpler') reply = en ? 'Simple rule: **finished time → simple past**. **No time, result now → present perfect**.\n\n*I ate* (yesterday). *I’ve eaten* (so I’m not hungry now).' : 'Règle simple : **moment fini → prétérit**. **Pas de moment, résultat maintenant → present perfect**.\n\n*I ate* (hier). *I’ve eaten* (donc je n’ai plus faim).';
    if (wantEx) reply = en ? 'Good idea! A short set will make it stick: choosing between the two tenses, with time markers and a few traps.\n\nShall I prepare **10 minutes on present perfect vs simple past**?' : 'Bonne idée ! Une courte série va l’ancrer : choisir entre les deux temps, avec des marqueurs de temps et quelques pièges.\n\nVoulez-vous que je vous prépare **10 minutes sur present perfect ou prétérit** ?';
    return {
      reply: reply,
      speech: en ? [{ lang: 'en', text: plain(reply).slice(0, 400) }]
        : (mix ? [{ lang: 'en', text: 'Use the present perfect when the past still matters now.' }, { lang: 'fr', text: 'Autrement dit, c’est le résultat présent qui compte.' }, { lang: 'en', text: 'I’ve lost my keys.' }]
          : [{ lang: 'fr', text: plain(reply).split('.').slice(0, 2).join('.') + '.' }, { lang: 'en', text: 'I’ve lost my keys. I lost my keys yesterday.' }]),
      examples: wantEx ? [] : [{ en: 'I’ve finished the report.', fr: 'J’ai fini le rapport (il est prêt).' }, { en: 'I finished the report on Monday.', fr: 'J’ai fini le rapport lundi.' }],
      followUps: en ? ['What about “for” and “since”?', 'Why “I’ve been” and not “I was”?'] : ['Et avec « for » et « since » ?', 'Pourquoi « I’ve been » et pas « I was » ?', 'Donnez-moi un exemple au travail.'],
      exercise: wantEx
        ? { offer: true, skill: 'lang', type: 'lang.tenses', minutes: 10, focus: 'Present perfect ou prétérit : marqueurs de temps (yesterday, ever, never, since, for, ago), le piège « I have seen him yesterday », phrases du travail.', titleFr: 'Present perfect ou prétérit' }
        : { offer: false, skill: '', type: '', minutes: 0, focus: '', titleFr: '' }
    };
  });
})();
