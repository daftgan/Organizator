/* ═══════════════════════════════════════════════════════════════════════════
   Organizator — mode Conversation (plein écran)
   Un interlocuteur à voix et à visage, mains libres, sur des sujets en français. Tout le son —
   micro, détection de parole, Whisper, conversation de l'hôte, synthèse, avatar, interruption —
   vient du moteur partagé (voice-engine.js, window.OrganizatorVoice) ; ce fichier n'est que l'écran :
   sujets, réglages, historique, sous-titres, avis.
   S'accroche à l'application par window.organizatorApp (réglages, toast, data-act).
   S'ouvre par window.OrganizatorVoiceOverlay.open() (depuis le Tuteur de Révizator) ; pas de bouton
   d'en-tête ni de raccourci global. Ouvert : Échap ferme et coupe tout, Espace lui coupe la parole,
   M coupe le micro.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var app = window.organizatorApp;
  if (!app || !window.bridge || !window.OrganizatorVoice) return;
  var OV = window.OrganizatorVoice;

  /* ══ Constantes ═══════════════════════════════════════════════════════ */

  var TOPICS = [
    { id: 'libre', label: 'Discussion libre' },
    { id: 'actu', label: 'Actualité & tech' },
    { id: 'culture', label: 'Histoire & culture' },
    { id: 'sciences', label: 'Sciences' },
    { id: 'philo', label: 'Philosophie' },
    { id: 'debat', label: 'Débat' },
    { id: 'anglais', label: 'Pratique de l’anglais' },
    { id: 'coach', label: 'Coaching & organisation' },
    { id: 'fiction', label: 'Livres, films, séries' },
    { id: 'impro', label: 'Jeu de rôle' }
  ];
  var TOPIC_HINTS = {
    debat: 'il prend le contre-pied', anglais: 'il parle anglais et reprend les fautes avec douceur', impro: 'improvisation'
  };

  /* Premier message, jamais affiché comme venant de l'utilisateur. */
  var GREETING = '(Début de la conversation : salue brièvement l’utilisateur et lance le sujet.)';
  var NOISE_RESUME = '(Ce n’était qu’un bruit, personne n’a parlé : reprends naturellement là où tu t’étais arrêté, sans te répéter.)';

  /* Sujet « anglais » : la voix naturelle Kokoro (si elle est installée), sinon la voix Windows choisie. */
  var KOKORO_EN = { voice: 'af_heart', accent: 'en-US' };

  var ICON = {
    face: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9.5" cy="12" r="7"></circle><path d="M7 10.2v.6M12 10.2v.6M7.2 14.3c1.3 1.2 3.3 1.2 4.6 0"></path><path d="M19 9.6a3.6 3.6 0 0 1 0 4.8M21.6 7.4a6.8 6.8 0 0 1 0 9.2"></path></svg>',
    mic: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"></path></svg>',
    micOff: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 9.3V5.5a3 3 0 0 0-5.7-1.3M9 9v2.5a3 3 0 0 0 4.9 2.3M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3.5M3 3l18 18"></path></svg>',
    hush: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"></path><path d="M16 9.5l5 5M21 9.5l-5 5"></path></svg>',
    history: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><path d="M8 9h8M8 13h5"></path></svg>',
    gear: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
    restart: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"></path><path d="M3.5 4v4.5H8"></path></svg>',
    close: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>',
    play: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 5l12 7-12 7z"></path></svg>'
  };

  /* ══ État ═════════════════════════════════════════════════════════════ */

  /* phase : starting | listening | user | transcribing | thinking | tool | speaking | error (du moteur ;
     « muted » y est rendu par V.muted, le micro coupé n'empêchant pas l'avatar de finir sa phrase). */
  var V = {
    open: false, root: null, lastFocus: null, eng: null,
    phase: 'starting', statusText: '', muted: false,
    drawer: '', notice: null, notices: {},
    entry: null, history: [],
    caption: '', captionDim: false, you: '', youLive: false, youFinal: '',
    voices: null, voicesDefault: '', customModel: false,
    raf: 0, restartTimer: 0
  };

  /* ══ Utilitaires ══════════════════════════════════════════════════════ */

  function S() { return app.settings(); }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function q(sel) { return V.root ? V.root.querySelector(sel) : null; }

  function topicOf(id) { return TOPICS.filter(function (t) { return t.id === id; })[0] || TOPICS[0]; }

  function fmtSize(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' Ko';
    return Math.round(bytes / 1048576) + ' Mo';
  }

  /* ══ Transcription en direct : le modèle de l'hôte (partagé avec le Tuteur) ══
     L'état du modèle sherpa-onnx de l'hôte (`asrStatus` : un seul, Parakeet v3, qui sert l'anglais et le
     français), son téléchargement (`asrDownload` avec l'id du modèle, progression par l'évènement `asr` dont
     `lang` est cet id) et sa suppression (`asrRemove`). Un hôte plus ancien rend un modèle par langue (ids
     'en', 'fr') : une ligne chacun. Les lignes de réglage (modelsHtml) portent data-asr-models : chaque
     changement les réécrit sur place, où qu'elles soient (overlay, Réglages). Clés de `dl` / `err` : l'id
     du modèle. */

  var BARGE = [
    { id: 'words', label: 'Quand je dis quelques mots', hint: 'conseillé' },
    { id: 'voice', label: 'Dès que je parle', hint: '' },
    { id: 'off', label: 'Jamais', hint: '' }
  ];
  var BARGE_HELP = {
    words: 'L’interlocuteur baisse la voix dès qu’il vous entend, et ne s’arrête que si vous dites vraiment quelque chose : une toux, un bruit ou l’écho de sa propre voix ne le coupent pas.',
    voice: 'Il se tait au premier son de votre voix : réactif, mais un bruit franc peut aussi le couper.',
    off: 'Il finit toujours sa phrase ; Espace (ou « Faire taire ») le coupe quand même.'
  };
  var ASR_LABELS = { en: 'Anglais', fr: 'Français' };

  var ASR = { st: null, asked: false, failed: '', dl: {}, err: {}, subs: [] };

  function asrNotify() {
    var html = asrModelsInner();
    Array.prototype.forEach.call(document.querySelectorAll('[data-asr-models]'), function (el) {
      if (el.getAttribute('data-html') !== html) { el.innerHTML = html; el.setAttribute('data-html', html); }
    });
    ASR.subs.slice().forEach(function (fn) { try { fn(ASR.st); } catch (e) { /* abonné fautif */ } });
  }

  function asrRefresh() {
    ASR.asked = true;
    /* Par le moteur quand il sait le faire : un seul état, partagé avec ses avis. */
    var p = typeof OV.asrStatus === 'function' ? OV.asrStatus(true).then(function (r) { if (!r) throw new Error('indisponible'); return r; })
      : bridge.call('asrStatus', {}, 15000);
    return p.then(function (r) {
      ASR.st = r || { models: [] };
      ASR.failed = '';
      (ASR.st.models || []).forEach(function (m) {
        if (m.downloading && !ASR.dl[m.id]) ASR.dl[m.id] = { received: m.received || 0, total: m.total || m.size || 0 };
        if (!m.downloading && ASR.dl[m.id] && ASR.dl[m.id].done) delete ASR.dl[m.id];
      });
      asrNotify();
      return ASR.st;
    }, function (e) {
      ASR.failed = (e && e.message) || 'indisponible';
      asrNotify();
      return null;
    });
  }

  function asrModels() {
    return ((ASR.st && ASR.st.models) || []).filter(function (m) { return m && m.id; });
  }

  /* Par id ('parakeet'), sinon le modèle qui sert la langue ('en' → parakeet). */
  function asrModel(key) {
    var all = asrModels();
    return all.filter(function (m) { return m.id === key; })[0]
      || all.filter(function (m) { return Array.isArray(m.langs) && m.langs.indexOf(key) >= 0; })[0] || null;
  }

  function asrKey(key) { var m = asrModel(key); return m ? m.id : String(key || ''); }

  function asrText(m) {
    if (typeof OV.asrModelText === 'function') return OV.asrModelText(m);
    return { name: m.label || m.id, langs: '', size: fmtSize(m.size) };
  }

  function asrDownload(lang) {
    lang = asrKey(lang);
    if (ASR.dl[lang] && !ASR.dl[lang].done) return Promise.resolve(false);
    var m = asrModel(lang);
    ASR.dl[lang] = { received: 0, total: (m && m.size) || 0 };
    delete ASR.err[lang];
    asrNotify();
    var p = typeof OV.downloadAsr === 'function' ? OV.downloadAsr(lang) : bridge.call('asrDownload', { lang: lang }, 3600000);
    return p.then(function (r) {
      /* L'hôte rend { ok: false, error } plutôt qu'une exception (404 : « modèle introuvable sur Hugging Face : … »). */
      if (r && r.ok === false) throw new Error(r.error || 'téléchargement impossible');
      if (ASR.err[lang]) { delete ASR.dl[lang]; return asrRefresh().then(function () { return false; }); }
      delete ASR.dl[lang];
      return asrRefresh().then(function () { return true; });
    }, function (e) {
      delete ASR.dl[lang];
      ASR.err[lang] = (e && e.message) || 'téléchargement impossible';
      asrNotify();
      return false;
    });
  }

  function asrRemove(lang) {
    lang = asrKey(lang);
    return bridge.call('asrRemove', { lang: lang }, 30000).then(function () {
      delete ASR.err[lang];
      return asrRefresh();
    }, function (e) {
      app.toast('Suppression impossible : ' + ((e && e.message) || 'erreur inconnue'));
    });
  }

  function asrPct(d) { return d && d.total ? clamp(Math.round(d.received / d.total * 100), 0, 100) : 0; }

  function asrModelsInner() {
    if (!ASR.st && !ASR.failed) return '<div class="asr-note">Lecture de l’état des modèles…</div>';
    if (ASR.failed) return '<div class="asr-note">Transcription en direct indisponible dans cette fenêtre : Whisper transcrit chaque phrase quand vous vous taisez.</div>';
    var models = asrModels();
    if (!models.length) return '<div class="asr-note">Aucun modèle de transcription en direct proposé par l’application.</div>';
    var rows = models.map(function (m) {
      var d = ASR.dl[m.id], err = ASR.err[m.id];
      var t = asrText(m);
      var name = ASR_LABELS[m.id] || t.name;
      /* « Parakeet v3 · anglais et français · ~650 Mo » */
      var meta = [Array.isArray(m.langs) ? t.langs : '', m.size ? t.size : ''].filter(Boolean).join(' · ');
      var state;
      if (d) {
        var pct = asrPct(d);
        state = '<span class="asr-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Téléchargement du modèle ' + esc(name) + '"><i style="width:' + pct + '%"></i></span>'
          + '<span class="wm-state">' + (d.total ? pct + ' %' : 'Téléchargement…') + '</span>';
      } else if (m.downloaded) {
        state = '<span class="wm-state is-ok">✓ Prêt</span>'
          + '<button type="button" class="btn btn-ghost wm-btn" data-act="asr-remove" data-lang="' + esc(m.id) + '" title="Libérer ' + esc(fmtSize(m.size)) + ' sur le disque">Supprimer</button>';
      } else {
        state = '<button type="button" class="btn btn-secondary wm-btn" data-act="asr-download" data-lang="' + esc(m.id) + '">Télécharger</button>';
      }
      return '<div class="wm-row asr-row" data-lang="' + esc(m.id) + '"><span class="wm-text"><span class="wm-name"><span class="asr-name">' + esc(name) + '</span>'
        + (meta ? ' <span class="wm-size">· ' + esc(meta).replace(/ (Mo|Ko)\b/g, '\u00a0$1') + '</span>' : '') + '</span>'
        + '<span class="wm-note">' + (err ? '<span class="asr-err">Échec : ' + esc(err) + '</span>'
          : (m.downloaded ? 'Vos phrases s’écrivent pendant que vous parlez ; l’aperçu se met à jour par à-coups, environ toutes les demi-secondes.'
            : (d ? 'Téléchargement en cours ; vous pouvez continuer à parler (Whisper prend le relais).'
              : 'Pas encore sur ce poste : Whisper transcrit à la fin de chaque phrase. Plus précis et robuste aux accents, ce modèle écrit vos phrases pendant que vous parlez.'))) + '</span></span>'
        + '<span class="wm-side">' + state + '</span></div>';
    }).join('');
    var rt = ASR.st.runtime;
    return rows + (rt && rt.downloaded === false ? '<div class="asr-note">Le moteur de reconnaissance (sherpa-onnx) se télécharge avec le modèle.</div>' : '');
  }

  /* Les lignes de modèles, à placer dans un réglage ; l'état est demandé à l'hôte à la première vue. */
  function asrModelsHtml() {
    if (!ASR.asked) setTimeout(asrRefresh, 0);
    var html = asrModelsInner();
    return '<div class="asr-models" data-asr-models data-html="' + esc(html) + '">' + html + '</div>';
  }

  bridge.on('asr', function (ev) {
    if (!ev || ev.session || !ev.lang) return;
    /* `lang` : l'id du modèle ('parakeet'), ou la langue d'un hôte plus ancien. */
    ev = Object.assign({}, ev, { lang: asrKey(ev.lang) });
    if (ev.phase === 'download') {
      ASR.dl[ev.lang] = { received: Number(ev.received) || 0, total: Number(ev.total) || (ASR.dl[ev.lang] && ASR.dl[ev.lang].total) || 0 };
      delete ASR.err[ev.lang];
      asrNotify();
    } else if (ev.phase === 'downloaded') {
      delete ASR.dl[ev.lang];
      asrRefresh().then(function () { asrReady(ev.lang); });
    } else if (ev.phase === 'download-failed') {
      delete ASR.dl[ev.lang];
      ASR.err[ev.lang] = ev.error || 'téléchargement impossible';
      asrNotify();
    }
  });

  /* Les réglages de la conversation, bornés : l'hôte peut être plus ancien que la page. */
  function cfg() {
    var s = S();
    return {
      model: String(s.voiceModel == null ? 'sonnet' : s.voiceModel).trim(),
      effort: String(s.voiceEffort == null ? 'low' : s.voiceEffort).trim(),
      voice: String(s.voiceVoice || ''),
      rate: clamp(parseInt(s.voiceRate, 10) || 0, -10, 10),
      persona: String(s.voicePersona || '').trim() || 'Alma',
      topic: topicOf(s.voiceTopic).id,
      instructions: String(s.voiceInstructions || ''),
      web: s.voiceWeb !== false,
      whisperModel: String(s.voiceWhisperModel || 'base'),
      sensitivity: clamp(s.voiceSensitivity == null ? 40 : parseInt(s.voiceSensitivity, 10) || 0, 0, 100),
      bargeIn: bargeOf(s.voiceBargeIn != null ? s.voiceBargeIn : storedBarge()),
      language: s.voiceTopic === 'anglais' ? 'en' : (s.whisperLanguage || 'fr')
    };
  }

  function bargeOf(v) { return BARGE.some(function (b) { return b.id === v; }) ? v : 'words'; }

  /* « Couper la parole » n'existe pas dans les réglages de l'hôte (saveSettings n'envoie que les champs qu'il
     connaît) : gardé dans les réglages de la page et, pour survivre au redémarrage, dans le stockage local. */
  var BARGE_KEY = 'organizator.voice.bargeIn';
  function storedBarge() { try { return localStorage.getItem(BARGE_KEY); } catch (e) { return null; } }
  function storeBarge(v) { try { localStorage.setItem(BARGE_KEY, v); } catch (e) { /* stockage refusé */ } }

  function setSettings(patch) { app.setSettings(patch); }

  function whisperState() { return OV.whisper() || app.env().whisper || null; }

  /* Ce que le moteur reçoit des réglages (sans le conteneur ni les rappels). */
  function engineSettings(c) {
    var en = c.topic === 'anglais';
    return {
      language: c.language, whisperModel: c.whisperModel, sensitivity: c.sensitivity, bargeIn: c.bargeIn, liveAsr: true,
      tts: { kokoroVoice: en ? KOKORO_EN.voice : '', accent: en ? KOKORO_EN.accent : '', speed: 1, sapiVoice: c.voice, sapiRate: c.rate },
      conversation: {
        start: { model: c.model, effort: c.effort, persona: c.persona, topic: c.topic, instructions: c.instructions, web: c.web },
        greeting: GREETING
      },
      texts: { noiseResume: NOISE_RESUME }
    };
  }

  /* ══ Ouverture et fermeture ═══════════════════════════════════════════ */

  /* Sensibilité recalibrée par le moteur (défaut 40) : l'ancien défaut 50 de l'hôte suit, une seule fois. */
  var SENS_KEY = 'organizator.voice.sensV';
  function migrateSensitivity() {
    try {
      if (localStorage.getItem(SENS_KEY)) return;
      localStorage.setItem(SENS_KEY, '2');
    } catch (e) { return; }
    if (S().voiceSensitivity == null || +S().voiceSensitivity === 50) setSettings({ voiceSensitivity: 40 });
  }

  function openVoice() {
    if (V.open) return;
    migrateSensitivity();
    V.open = true;
    V.lastFocus = document.activeElement;
    V.phase = 'starting'; V.statusText = ''; V.muted = false; V.drawer = ''; V.notice = null; V.notices = {};
    V.history = []; V.entry = null; V.caption = ''; V.captionDim = false; V.you = ''; V.youLive = false; V.youFinal = '';
    buildDom();
    document.documentElement.classList.add('vc-open');
    window.addEventListener('keydown', onKey, true);
    V.eng = OV.create(Object.assign(engineSettings(cfg()), {
      container: q('.vc-avatar'), avatar: {},
      onPhase: onPhase, onSentence: onSentence, onReply: onReply, onReplyDone: onReplyDone,
      onUserUtterance: onUserUtterance, onPartial: onPartial, onNotice: onNotice, onError: onError
    }));
    loadVoices();
    startConversation(false);
    var close = q('[data-act="voice-close"]');
    if (close) close.focus();
  }

  function closeVoice() {
    if (!V.open) return;
    V.open = false;
    clearTimeout(V.restartTimer);
    cancelAnimationFrame(V.raf); V.raf = 0;
    window.removeEventListener('keydown', onKey, true);
    if (V.eng) { V.eng.destroy(); V.eng = null; }
    if (V.root) { V.root.remove(); V.root = null; }
    document.documentElement.classList.remove('vc-open');
    if (V.lastFocus && document.contains(V.lastFocus)) { try { V.lastFocus.focus(); } catch (e) { /* plus focusable */ } }
  }

  /* Démarre — ou redémarre, sujet, interlocuteur ou modèle changés — une conversation neuve ;
     l'avatar salue de lui-même. */
  function startConversation(restart) {
    if (!V.eng) return;
    var c = cfg();
    V.entry = null; V.caption = ''; V.you = ''; V.youLive = false; V.youFinal = '';
    if (restart) V.history.push({ role: 'sep', text: 'Nouvelle conversation · ' + topicOf(c.topic).label });
    V.eng.setOptions(engineSettings(c));
    V.eng.start();
    renderTexts(); renderHistory();
  }

  function restartSoon() {
    clearTimeout(V.restartTimer);
    V.restartTimer = setTimeout(function () { if (V.open) startConversation(true); }, 500);
  }

  /* ══ Rappels du moteur ════════════════════════════════════════════════ */

  function onPhase(phase, info) {
    if (!V.open || phase === 'idle') return;
    V.muted = V.eng ? V.eng.muted() : false;
    V.phase = phase === 'muted' ? 'listening' : phase;
    V.statusText = (info && info.text) || '';
    if (V.root) V.root.setAttribute('data-phase', V.phase);
    renderStatus();
    renderControls();
  }

  function onSentence(text) {
    V.caption = text; V.captionDim = false;
    renderTexts();
  }

  function onReply(r) {
    if (!V.entry) { V.entry = { role: 'assistant', sentences: [], heard: null }; V.history.push(V.entry); }
    V.entry.sentences = r.sentences;
    renderHistory();
    renderControls();
  }

  function onReplyDone(r) {
    if (V.entry) V.entry.heard = r.heard;
    V.entry = null;
    V.captionDim = true;
    renderTexts(); renderHistory(); renderControls();
  }

  /* Ce que dit l'utilisateur, en direct (transcription en flux) : le sous-titre « Vous » se remplit, puis
     se fige à l'envoi (onUserUtterance) ; effacé (bruit écarté), il revient à la dernière phrase envoyée. */
  function onPartial(text) {
    if (!V.open) return;
    text = String(text || '').replace(/\s+/g, ' ').trim();
    V.youLive = !!text;
    V.you = text || V.youFinal;
    renderTexts();
  }

  function onUserUtterance(text) {
    V.you = V.youFinal = text;
    V.youLive = false;
    V.history.push({ role: 'user', text: text });
    renderTexts(); renderHistory();
    return true;
  }

  /* Les avis du moteur, par groupe : le plus important est affiché (l'invitation à télécharger le modèle
     en direct, non bloquante, passe après le micro, Whisper et la conversation). */
  var NOTICE_ORDER = ['mic', 'whisper', 'conversation', 'tts', 'asr'];
  function topNotice() {
    var k = Object.keys(V.notices).filter(function (g) { return V.notices[g]; });
    k.sort(function (a, b) { return (NOTICE_ORDER.indexOf(a) + 1 || 4.5) - (NOTICE_ORDER.indexOf(b) + 1 || 4.5); });
    return k.length ? V.notices[k[0]] : null;
  }

  function onNotice(n, info) {
    if (!n) {
      var g0 = info && info.kind;
      if (g0 && V.notices[g0]) { delete V.notices[g0]; V.notice = topNotice(); renderNotice(); }
      if (g0 === 'whisper') syncWhisper();
      if (g0 === 'asr') asrRefresh();
      return;
    }
    if (n.kind === 'whisper-unknown') n = Object.assign({}, n, { text: n.text.replace(/\.$/, '') + ' : choisissez-en un dans ⚙.' });
    var flash = n.flash;
    V.notices[n.group || n.kind || 'other'] = n;
    V.notice = topNotice();
    renderNotice();
    if (flash && V.notice === n) flashNotice();
    if (n.group === 'whisper' && V.drawer === 'settings') renderSettings();
  }

  /* Le modèle Whisper vient d'être téléchargé : les Réglages de l'application le savent aussi. */
  function syncWhisper() {
    var st = OV.whisper();
    if (st && st.models) app.env().whisper = st;
    if (V.drawer === 'settings') renderSettings();
  }

  function onError(err) {
    var msg = (err && err.message) || 'erreur inconnue';
    if (err && err.kind === 'reply') {
      app.toast('Conversation : ' + msg);
      V.history.push({ role: 'error', text: msg });
      renderHistory();
    } else if (err && err.kind === 'transcribe') {
      app.toast('Transcription impossible : ' + msg);
    } else if (err && err.kind !== 'conversation' && err.kind !== 'mic') {
      app.toast(msg);
    }
  }

  /* ══ Voix ═════════════════════════════════════════════════════════════ */

  function loadVoices() {
    if (V.voices) return;
    bridge.call('voiceVoices', {}, 15000).then(function (r) {
      V.voices = (r && r.voices) || [];
      V.voicesDefault = (r && r['default']) || '';
      if (V.drawer === 'settings') renderSettings();
    }, function () {
      V.voices = [];
      if (V.drawer === 'settings') renderSettings();
    });
  }

  function testVoice() {
    if (!V.eng) return;
    var c = cfg();
    var text = c.topic === 'anglais'
      ? 'Hello, I’m ' + c.persona + '. This is my voice.'
      : 'Bonjour, je suis ' + c.persona + '. Voici ma voix.';
    var btn = q('[data-act="voice-listen"]');
    if (btn) btn.disabled = true;
    V.eng.replay(text).then(function () {
      var b = q('[data-act="voice-listen"]');
      if (b) b.disabled = false;
    });
  }

  /* ══ Phases, textes, avis ═════════════════════════════════════════════ */

  var STATUS = {
    starting: 'Je me prépare…', listening: 'Je vous écoute', user: 'Je vous écoute…', transcribing: 'Je réfléchis…',
    thinking: 'Je réfléchis…', tool: 'Je cherche…', speaking: 'Parlez pour m’interrompre', error: ''
  };

  function statusLabel() {
    if (V.muted) return 'Micro coupé · M pour le rouvrir';
    if (V.phase === 'tool') return V.statusText || STATUS.tool;
    if (V.phase === 'error') return V.statusText || 'Un souci est survenu';
    return STATUS[V.phase] || '';
  }

  function renderStatus() {
    var el = q('.vc-status-text');
    if (el) el.textContent = statusLabel();
    if (V.root) V.root.classList.toggle('is-muted', V.muted);
  }

  function renderTexts() {
    var cap = q('.vc-caption');
    if (cap) {
      cap.textContent = V.caption;
      cap.classList.toggle('dim', V.captionDim);
    }
    var you = q('.vc-you');
    if (you) {
      you.hidden = !V.you;
      you.classList.toggle('live', V.youLive);
      var t = you.querySelector('.vc-you-text');
      if (t) t.textContent = V.you;
    }
  }

  function renderControls() {
    var mute = q('[data-act="voice-mute"]');
    if (mute) {
      mute.classList.toggle('on', V.muted);
      mute.setAttribute('aria-pressed', V.muted ? 'true' : 'false');
      mute.innerHTML = (V.muted ? ICON.micOff : ICON.mic) + '<span>' + (V.muted ? 'Micro coupé' : 'Micro ouvert') + '</span><kbd>M</kbd>';
    }
    var hush = q('[data-act="voice-hush"]');
    if (hush) { var st = V.eng && V.eng.state(); hush.disabled = !(st && (st.replying || st.playing)); }
  }

  function renderNotice() {
    var box = q('.vc-notice');
    if (!box) return;
    var n = V.notice;
    box.hidden = !n;
    if (!n) { box.innerHTML = ''; return; }
    var progress = n.progress == null ? -1 : n.progress;
    box.innerHTML = '<span class="vc-notice-text">' + esc(n.text) + '</span>'
      + (progress >= 0 ? '<span class="vc-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + progress
        + '" aria-label="Téléchargement"><i style="width:' + progress + '%"></i></span><span class="vc-notice-pct">' + progress + ' %</span>' : '')
      + (n.action ? '<button type="button" class="btn btn-primary btn-small" data-act="voice-notice-act">' + esc(n.action.label) + '</button>' : '');
  }

  /* Phrase prononcée alors que le modèle Whisper manque : l'avis clignote une fois. */
  function flashNotice() {
    var box = q('.vc-notice');
    if (!box || box.hidden) return;
    box.classList.remove('flash');
    void box.offsetWidth;
    box.classList.add('flash');
  }

  function renderHistory() {
    var list = q('.vc-history-list');
    if (!list) return;
    if (!V.history.length) {
      list.innerHTML = '<p class="vc-empty">La conversation s’écrira ici, au fil de vos échanges.</p>';
      return;
    }
    var name = cfg().persona;
    list.innerHTML = V.history.map(function (e) {
      if (e.role === 'sep') return '<div class="vc-sep"><span>' + esc(e.text) + '</span></div>';
      if (e.role === 'error') return '<div class="vc-msg vc-msg-error">' + esc(e.text) + '</div>';
      if (e.role === 'user') return '<div class="vc-msg vc-msg-user"><span class="vc-msg-who">Vous</span>' + esc(e.text) + '</div>';
      var full = e.sentences.join(' ');
      var body;
      if (e.heard == null) body = esc(full);
      else {
        var heard = e.heard;
        var rest = full.indexOf(heard) === 0 ? full.slice(heard.length) : full;
        body = esc(heard) + (rest.trim() ? ' <span class="vc-unheard" title="Non entendu : vous avez pris la parole">' + esc(rest.trim()) + '</span>' : '');
      }
      return '<div class="vc-msg vc-msg-bot' + (e.heard != null ? ' cut' : '') + '"><span class="vc-msg-who">' + esc(name) + '</span>' + body + '</div>';
    }).join('');
    list.scrollTop = list.scrollHeight;
  }

  /* ══ Rendu de l'écran ═════════════════════════════════════════════════ */

  function topicsHtml() {
    var cur = cfg().topic;
    return TOPICS.map(function (t) {
      var on = t.id === cur;
      return '<button type="button" class="vc-topic' + (on ? ' on' : '') + '" data-act="voice-topic" data-id="' + t.id
        + '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '"'
        + (TOPIC_HINTS[t.id] ? ' title="' + esc(t.label + ' — ' + TOPIC_HINTS[t.id]) + '"' : '') + '>' + esc(t.label) + '</button>';
    }).join('');
  }

  function buildDom() {
    var c = cfg();
    var root = V.root = document.createElement('div');
    root.className = 'vc-backdrop';
    root.setAttribute('data-phase', V.phase);
    root.innerHTML = ''
      + '<div class="vc" role="dialog" aria-modal="true" aria-labelledby="vc-name">'
      + '<header class="vc-bar">'
      + '<div class="vc-head"><span class="vc-name" id="vc-name">' + esc(c.persona) + '</span>'
      + '<span class="vc-sub">Conversation · ' + esc(topicOf(c.topic).label) + '</span></div>'
      + '<div class="vc-tools">'
      + '<button type="button" class="icon-btn" data-act="voice-restart" title="Nouvelle conversation" aria-label="Nouvelle conversation">' + ICON.restart + '</button>'
      + '<button type="button" class="icon-btn" data-act="voice-panel" data-panel="history" aria-expanded="false" title="Historique de la conversation" aria-label="Historique de la conversation">' + ICON.history + '</button>'
      + '<button type="button" class="icon-btn" data-act="voice-panel" data-panel="settings" aria-expanded="false" title="Réglages de la conversation" aria-label="Réglages de la conversation">' + ICON.gear + '</button>'
      + '<button type="button" class="icon-btn vc-close" data-act="voice-close" title="Fermer (Échap)" aria-label="Fermer la conversation">' + ICON.close + '</button>'
      + '</div></header>'
      + '<div class="vc-topics" role="radiogroup" aria-label="Sujet de la conversation">' + topicsHtml() + '</div>'
      + '<div class="vc-main">'
      + '<section class="vc-stage">'
      + '<div class="vc-avatar"></div>'
      + '<div class="vc-status"><span class="vc-status-dot"></span><span class="vc-status-text"></span></div>'
      + '<p class="vc-caption" aria-live="polite"></p>'
      + '<p class="vc-you" aria-live="polite" hidden><span class="vc-you-label">Vous</span><span class="vc-you-text"></span><span class="vc-you-dots" aria-hidden="true"><i></i><i></i><i></i></span></p>'
      + '<div class="vc-notice" role="alert" hidden></div>'
      + '<div class="vc-controls">'
      + '<button type="button" class="vc-ctl" data-act="voice-mute" aria-pressed="false"></button>'
      + '<button type="button" class="vc-ctl" data-act="voice-hush" title="Couper la parole (Espace)">' + ICON.hush + '<span>Couper la parole</span><kbd>Espace</kbd></button>'
      + '</div>'
      + '<p class="vc-hint">Parlez naturellement : je réponds quand vous marquez une pause, et vous pouvez me couper à tout moment.</p>'
      + '</section>'
      + '<aside class="vc-drawer" hidden>'
      + '<div class="vc-pane vc-history" data-pane="history" hidden><h2 class="vc-pane-title">Historique</h2><div class="vc-history-list"></div></div>'
      + '<div class="vc-pane vc-settings" data-pane="settings" hidden></div>'
      + '</aside>'
      + '</div></div>';
    document.body.appendChild(root);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', trapFocus);
    renderStatus(); renderControls();
    renderTexts(); renderNotice(); renderHistory();
  }

  function renderHead() {
    var c = cfg();
    var n = q('.vc-name'), sub = q('.vc-sub'), tp = q('.vc-topics');
    if (n) n.textContent = c.persona;
    if (sub) sub.textContent = 'Conversation · ' + topicOf(c.topic).label;
    if (tp) tp.innerHTML = topicsHtml();
  }

  function setDrawer(which) {
    V.drawer = V.drawer === which ? '' : which;
    var d = q('.vc-drawer');
    if (!d) return;
    d.hidden = !V.drawer;
    Array.prototype.forEach.call(V.root.querySelectorAll('[data-pane]'), function (p) { p.hidden = p.getAttribute('data-pane') !== V.drawer; });
    Array.prototype.forEach.call(V.root.querySelectorAll('[data-act="voice-panel"]'), function (b) {
      var on = b.getAttribute('data-panel') === V.drawer;
      b.classList.toggle('on', on);
      b.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    V.root.classList.toggle('with-drawer', !!V.drawer);
    if (V.drawer === 'settings') { loadVoices(); renderSettings(); if (!V.raf) V.raf = requestAnimationFrame(meterFrame); }
    if (V.drawer === 'history') renderHistory();
  }

  /* ·· Réglages ·· */

  function fieldHtml(label, control, help, id) {
    return '<div class="vc-field">'
      + '<label class="vc-label"' + (id ? ' for="' + id + '"' : '') + '>' + esc(label) + '</label>'
      + control + (help ? '<div class="vc-help">' + help + '</div>' : '') + '</div>';
  }

  function renderSettings() {
    var pane = q('.vc-settings');
    if (!pane) return;
    var c = cfg(), s = S();
    var h = ['<h2 class="vc-pane-title">Réglages</h2>'];
    h.push(fieldHtml('Prénom de l’interlocuteur',
      '<input class="input" id="vc-persona" type="text" data-voice="persona" maxlength="40" spellcheck="false" value="' + esc(c.persona) + '">',
      '', 'vc-persona'));

    var voices = V.voices;
    var vsel = '<select class="input set-select" id="vc-voice" data-voice="voice"' + (voices ? '' : ' disabled') + '>'
      + '<option value="">' + (voices ? 'Voix française par défaut' : 'Lecture des voix…') + '</option>'
      + (voices || []).map(function (v) {
        return '<option value="' + esc(v.id) + '"' + (v.id === c.voice ? ' selected' : '') + '>' + esc(v.name)
          + (v.lang ? ' · ' + esc(v.lang) : '') + '</option>';
      }).join('')
      + (c.voice && voices && !voices.some(function (v) { return v.id === c.voice; }) ? '<option value="' + esc(c.voice) + '" selected>' + esc(c.voice) + ' (absente)</option>' : '')
      + '</select>';
    h.push(fieldHtml('Voix', '<div class="vc-row">' + vsel
      + '<button type="button" class="btn btn-secondary btn-small" data-act="voice-listen">' + ICON.play + 'Écouter</button></div>', '', 'vc-voice'));

    h.push(fieldHtml('Débit',
      '<div class="vc-row"><input class="vc-range" id="vc-rate" type="range" min="-10" max="10" step="1" data-voice="rate" value="' + c.rate + '">'
      + '<output class="vc-out" data-out="rate">' + (c.rate > 0 ? '+' : '') + c.rate + '</output></div>', '', 'vc-rate'));

    /* Comme dans les Réglages : la liste du catalogue Claude, et « Autre… » pour un identifiant libre. */
    var msel = app.modelSelectHtml(c.model, V.customModel, 'voice-model', 'voice-model');
    var custom = msel.indexOf('value="' + app.customModel + '" selected') >= 0;
    h.push(fieldHtml('Modèle',
      '<div class="vc-row">' + msel + '</div>'
      + (custom
        ? '<input class="input vc-model-free" type="text" data-voice="model" spellcheck="false" placeholder="claude-sonnet-5" value="' + esc(c.model) + '">' : ''),
      'Sonnet répond vite et bien ; Haiku encore plus vite ; Opus et Fable réfléchissent davantage, au prix d’un délai.'));

    h.push(fieldHtml('Effort', '<div class="vc-row">' + app.effortSelectHtml(c.effort, 'voice-effort', 'voice-effort') + '</div>',
      'Low suffit à la conversation : chaque cran de plus retarde la première phrase.'));

    h.push('<div class="vc-field vc-field-inline"><div><div class="vc-label">Recherche web</div>'
      + '<div class="vc-help">L’interlocuteur peut chercher sur le web pour l’actualité ou un fait précis.</div></div>'
      + '<button type="button" class="switch' + (c.web ? ' on' : '') + '" data-act="voice-web" role="switch" aria-checked="' + (c.web ? 'true' : 'false')
      + '" aria-label="Recherche web"></button></div>');

    var ws = whisperState(), wm = (ws && ws.models) || [];
    h.push(fieldHtml('Modèle Whisper de la conversation',
      '<select class="input set-select" id="vc-whisper" data-voice="whisper"' + (wm.length ? '' : ' disabled') + '>'
      + (wm.length ? '' : '<option>Transcription indisponible</option>')
      + wm.map(function (m) {
        return '<option value="' + esc(m.id) + '"' + (m.id === c.whisperModel ? ' selected' : '') + '>' + esc(m.label)
          + (m.id === 'base' ? ' — conseillé, le plus rapide' : '') + (m.downloaded ? '' : ' · à télécharger (' + fmtSize(m.size) + ')') + '</option>';
      }).join('') + '</select>',
      'Distinct de celui de la dictée (' + esc(s.whisperModel || 'small') + ') : ici, chaque phrase doit être transcrite en moins d’une seconde.', 'vc-whisper'));

    h.push(fieldHtml('Transcription en direct', asrModelsHtml(),
      'Un seul modèle pour l’anglais et le français (' + (c.language === 'en' ? 'anglais' : 'français') + ' pour ce sujet) : votre phrase s’écrit pendant que vous parlez et part dès que vous vous taisez. Tout reste sur ce poste.'));

    h.push('<div class="vc-field"><div class="vc-label" id="vc-barge-l">Couper la parole</div>'
      + '<div class="vc-seg" role="radiogroup" aria-labelledby="vc-barge-l">' + BARGE.map(function (b) {
        var on = b.id === c.bargeIn;
        return '<button type="button" class="vc-seg-btn' + (on ? ' on' : '') + '" data-act="voice-barge" data-value="' + b.id + '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '">'
          + esc(b.label) + (b.hint ? ' <span class="vc-seg-hint">' + esc(b.hint) + '</span>' : '') + '</button>';
      }).join('') + '</div>'
      + '<div class="vc-help" data-out="barge">' + esc(BARGE_HELP[c.bargeIn]) + '</div></div>');

    h.push(fieldHtml('Sensibilité du micro',
      '<div class="vc-row"><input class="vc-range" id="vc-sens" type="range" min="0" max="100" step="1" data-voice="sensitivity" value="' + c.sensitivity + '">'
      + '<output class="vc-out" data-out="sensitivity">' + c.sensitivity + '</output></div>'
      + '<div class="vc-meter" aria-hidden="true"><i class="vc-meter-level"></i><b class="vc-meter-thr"></b></div>',
      'Parlez : la barre doit franchir le trait. S’il se déclenche tout seul (ventilateur, clavier), baissez-la.', 'vc-sens'));

    h.push(fieldHtml('Consignes',
      '<textarea class="input vc-instr" id="vc-instr" rows="4" data-voice="instructions" placeholder="Ex. : tutoie-moi ; sois bref ; pose-moi des questions.">'
      + esc(c.instructions) + '</textarea>',
      'Ajoutées à sa consigne de départ. Changer le prénom, le modèle, l’effort, la recherche web ou les consignes recommence la conversation.', 'vc-instr'));
    pane.innerHTML = h.join('');
  }

  var RESTARTS = { persona: 'voicePersona', instructions: 'voiceInstructions', model: 'voiceModel' };

  function onInput(e) {
    var el = e.target, k = el.getAttribute && el.getAttribute('data-voice');
    if (!k) return;
    if (k === 'rate' || k === 'sensitivity') {
      var v = parseInt(el.value, 10) || 0;
      var out = q('[data-out="' + k + '"]');
      if (out) out.textContent = (k === 'rate' && v > 0 ? '+' : '') + v;
      if (k === 'rate') { setSettings({ voiceRate: v }); if (V.eng) V.eng.setOptions({ tts: { sapiRate: v } }); }
      else { setSettings({ voiceSensitivity: v }); if (V.eng) V.eng.setOptions({ sensitivity: v }); }
    }
  }

  function onChange(e) {
    var el = e.target;
    var role = el.getAttribute && el.getAttribute('data-role');
    var k = el.getAttribute && el.getAttribute('data-voice');
    if (role === 'voice-model') {
      V.customModel = el.value === app.customModel;
      if (!V.customModel) { setSettings({ voiceModel: el.value }); restartSoon(); }
      renderSettings();
      if (V.customModel) { var free = q('.vc-model-free'); if (free) free.focus(); }
      return;
    }
    if (role === 'voice-effort') { setSettings({ voiceEffort: el.value }); restartSoon(); return; }
    if (!k) return;
    if (RESTARTS[k]) {
      var p = {};
      p[RESTARTS[k]] = k === 'persona' ? (el.value.trim() || 'Alma') : el.value.trim();
      if (S()[RESTARTS[k]] === p[RESTARTS[k]]) return;
      setSettings(p);
      if (k === 'persona') renderHead();
      restartSoon();
    } else if (k === 'voice') {
      setSettings({ voiceVoice: el.value });
      if (V.eng) V.eng.setOptions({ tts: { sapiVoice: el.value } });
    } else if (k === 'whisper') {
      setSettings({ voiceWhisperModel: el.value });
      if (V.eng) V.eng.setOptions({ whisperModel: el.value });
    }
  }

  /* Vumètre des réglages : niveau du micro et seuil de déclenchement, sur -80 … -10 dB. */
  function meterFrame() {
    V.raf = 0;
    if (!V.open || V.drawer !== 'settings' || !V.eng) return;
    V.raf = requestAnimationFrame(meterFrame);
    var lv = q('.vc-meter-level'), th = q('.vc-meter-thr');
    if (!lv || !th) return;
    var st = V.eng.state();
    function pos(db) { return clamp((db + 80) / 70, 0, 1); }
    lv.style.transform = 'scaleX(' + pos(st.micDb).toFixed(3) + ')';
    lv.classList.toggle('hot', st.micDb > st.threshold && !st.muted);
    th.style.left = (pos(st.threshold) * 100).toFixed(1) + '%';
  }

  /* ══ Clavier (seulement l'écran ouvert), focus, actions ═══════════════ */

  function typing(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }

  function toggleMute() {
    if (!V.eng) return;
    V.muted = V.eng.mute(!V.eng.muted());
    renderStatus(); renderControls();
  }

  function hush() {
    if (V.eng) V.eng.interrupt();
    renderControls();
  }

  function onKey(e) {
    if (!V.open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeVoice(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey || typing(e.target)) return;
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); e.stopPropagation(); toggleMute(); return; }
    if (e.key === ' ' || e.code === 'Space') {
      var st = V.eng && V.eng.state();
      if ((st && (st.replying || st.playing)) || e.target === document.body || !e.target.closest('button')) {
        e.preventDefault(); e.stopPropagation(); hush();
      }
    }
  }

  /* Le focus reste dans l'écran de conversation. */
  function trapFocus(e) {
    if (e.key !== 'Tab' || !V.root) return;
    var list = Array.prototype.filter.call(V.root.querySelectorAll('button, input, select, textarea, [tabindex]'), function (el) {
      return !el.disabled && el.offsetParent !== null && el.tabIndex >= 0;
    });
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  app.addActions({
    'voice-open': function () { app.onReady(openVoice); },
    'voice-close': closeVoice,
    'voice-mute': toggleMute,
    'voice-hush': hush,
    'voice-restart': function () { startConversation(true); },
    'voice-panel': function (el) { setDrawer(el.getAttribute('data-panel')); },
    'voice-topic': function (el) {
      var id = el.getAttribute('data-id');
      if (id === cfg().topic) return;
      setSettings({ voiceTopic: id });
      renderHead();
      startConversation(true);
    },
    'voice-web': function (el) {
      var on = !cfg().web;
      setSettings({ voiceWeb: on });
      el.classList.toggle('on', on);
      el.setAttribute('aria-checked', on ? 'true' : 'false');
      restartSoon();
    },
    'voice-listen': testVoice,
    'voice-barge': function (el) {
      var v = bargeOf(el.getAttribute('data-value'));
      setSettings({ voiceBargeIn: v });
      storeBarge(v);
      if (V.eng) V.eng.setOptions({ bargeIn: v });
      Array.prototype.forEach.call(V.root.querySelectorAll('[data-act="voice-barge"]'), function (b) {
        var on = b.getAttribute('data-value') === v;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      var help = q('[data-out="barge"]');
      if (help) help.textContent = BARGE_HELP[v];
    },
    'asr-download': function (el) {
      var lang = el.getAttribute('data-lang');
      asrDownload(lang).then(function (ok) { if (ok) asrReady(lang); });
    },
    'asr-remove': function (el) { asrRemove(el.getAttribute('data-lang')); },
    'voice-notice-act': function () {
      var n = V.notice;
      if (n && n.action && typeof n.action.run === 'function') n.action.run();
    }
  });

  /* Le modèle de transcription en direct vient d'arriver (les moteurs ouverts le reprennent d'eux-mêmes) : les abonnés le savent. */
  function asrReady(lang) {
    ASR.subs.slice().forEach(function (fn) { try { fn(ASR.st, lang); } catch (err) { /* abonné fautif */ } });
  }

  /* Partagé avec le Tuteur (revizator/tutor.js) : le modèle de transcription en direct et le choix « Couper la parole ». */
  window.OrganizatorLiveAsr = {
    modelsHtml: asrModelsHtml, refresh: asrRefresh, download: asrDownload, remove: asrRemove,
    status: function () { return ASR.st; }, model: asrModel,
    bargeOptions: BARGE, bargeHelp: BARGE_HELP, barge: bargeOf,
    subscribe: function (fn) { ASR.subs.push(fn); return function () { var i = ASR.subs.indexOf(fn); if (i >= 0) ASR.subs.splice(i, 1); }; }
  };

  window.OrganizatorVoiceOverlay = {
    open: function () { app.onReady(openVoice); },
    close: closeVoice,
    isOpen: function () { return V.open; }
  };

  /* Exposé pour le débogage et les essais. */
  window.__organizatorVoice = {
    state: V, open: openVoice, close: closeVoice, engine: function () { return V.eng; }, isJunk: OV.isJunk
  };
})();
