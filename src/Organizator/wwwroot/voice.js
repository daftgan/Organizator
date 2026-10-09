/* ═══════════════════════════════════════════════════════════════════════════
   Organizator — mode Conversation
   Un interlocuteur à voix et à visage, mains libres : le micro reste ouvert, la fin de phrase
   est détectée dans la page (VAD), Whisper transcrit sur le poste, Claude répond phrase par
   phrase (évènement `voice`), chaque phrase est synthétisée par l'hôte (`voiceSpeak`) et jouée
   par WebAudio — donc retirée du micro par l'annulation d'écho, et analysée pour la bouche de
   l'avatar. Parler pendant qu'il parle lui coupe la parole (barge-in).
   S'accroche à l'application par window.organizatorApp (réglages, toast, data-act).
   Ctrl + Maj + C ouvre et ferme ; Échap ferme et coupe tout.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var app = window.organizatorApp;
  if (!app || !window.bridge) return;

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

  /* Détection de parole : trames de 20 ms. Pendant que l'avatar parle, le seuil monte de
     PLAY_BOOST_DB et il faut parler plus longtemps : l'écho résiduel ne doit pas le couper. */
  var FRAME_MS = 20;
  var ONSET_MS = 160, ONSET_PLAY_MS = 250, PLAY_BOOST_DB = 6;
  var PREROLL_MS = 300, SPEC_MS = 300, END_MS = 650, MIN_MS = 300, MAX_MS = 30000;
  var RESUME_MS = 80;

  /* Ce que Whisper « entend » dans le silence ou le bruit : génériques de vidéos, didascalies. */
  var JUNK = [
    /sous-?titr/i, /merci d.avoir regard/i, /merci de (votre|nous avoir) (attention|regard)/i, /abonnez-?vous/i,
    /amara\.org/i, /thank(s| you) for watching/i, /^\s*[\[(♪*].*[\])♪*]\s*$/, /^\W*(musique|music|applaudissements|rires|silence)\W*$/i,
    /^[\s.…,!?-]*$/
  ];

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

  /* phase : starting | listening | user | transcribing | thinking | tool | speaking | error.
     `muted` est à part : le micro coupé n'empêche pas l'avatar de finir sa phrase. */
  var V = {
    open: false, root: null, lastFocus: null,
    phase: 'starting', statusText: '', toolText: '', muted: false,
    drawer: '', notice: null,
    conv: null, startSeq: 0,
    /* Réponse en cours : { turn, sentences, played, done, entry } ; la file des phrases à dire. */
    reply: null, queue: [], playing: null, minTurn: 0, maxTurn: 0, ignoreTurns: {},
    pendingHeard: null,
    /* Énoncé de l'utilisateur en cours d'assemblage : transcriptions des segments pas encore envoyés. */
    parts: [],
    history: [],
    caption: '', captionDim: false, you: '',
    voices: null, voicesDefault: '', customModel: false,
    ctx: null, workletReady: null, stream: null, source: null, vadNode: null, sink: null,
    outGain: null, outAnalyser: null, timeBuf: null, freqBuf: null,
    vad: null, micDb: -100, micLevel: 0, threshold: -50,
    speechFallback: null,
    raf: 0, face: null, anim: null,
    dl: null
  };

  /* ══ Utilitaires ══════════════════════════════════════════════════════ */

  function S() { return app.settings(); }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function q(sel) { return V.root ? V.root.querySelector(sel) : null; }

  function topicOf(id) { return TOPICS.filter(function (t) { return t.id === id; })[0] || TOPICS[0]; }

  function fmtSize(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' Ko';
    return Math.round(bytes / 1048576) + ' Mo';
  }

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
      sensitivity: clamp(s.voiceSensitivity == null ? 50 : parseInt(s.voiceSensitivity, 10) || 0, 0, 100),
      language: s.voiceTopic === 'anglais' ? 'en' : (s.whisperLanguage || 'fr')
    };
  }

  function setSettings(patch) { app.setSettings(patch); }

  function isJunk(text) {
    var t = String(text || '').trim();
    if (t.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return true;
    return JUNK.some(function (re) { return re.test(t); });
  }

  function base64Bytes(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function bytesOf(b64) {
    var bin = atob(String(b64 || '')), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* WAV 16 kHz mono 16 bits, ce que Whisper lit (comme la dictée). */
  function wavBytes(samples, rate) {
    var n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (var i = 0, o = 44; i < n; i++, o += 2) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buf);
  }

  /* Trames du micro (au débit du contexte audio) → WAV 16 kHz en base64. */
  function segmentWav(frames, rate) {
    var n = 0, i;
    for (i = 0; i < frames.length; i++) n += frames[i].length;
    var all = new Float32Array(n), o = 0;
    for (i = 0; i < frames.length; i++) { all.set(frames[i], o); o += frames[i].length; }
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC || rate === 16000) return Promise.resolve(base64Bytes(wavBytes(all, rate)));
    var off = new OAC(1, Math.max(1, Math.ceil(n * 16000 / rate)), 16000);
    var buf = off.createBuffer(1, n, rate);
    buf.getChannelData(0).set(all);
    var src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    return off.startRendering().then(function (r) { return base64Bytes(wavBytes(r.getChannelData(0), 16000)); });
  }

  /* ══ Ouverture et fermeture ═══════════════════════════════════════════ */

  function openVoice() {
    if (V.open) return;
    V.open = true;
    V.lastFocus = document.activeElement;
    V.phase = 'starting'; V.muted = false; V.drawer = ''; V.notice = null;
    V.history = []; V.caption = ''; V.you = ''; V.parts = []; V.pendingHeard = null;
    V.reply = null; V.queue = []; V.playing = null; V.ignoreTurns = {}; V.minTurn = 0; V.maxTurn = 0;
    buildDom();
    document.documentElement.classList.add('vc-open');
    var btn = document.getElementById('voice-btn');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    startAudio();
    checkWhisper(true);
    loadVoices();
    startConversation(false);
    V.raf = requestAnimationFrame(frame);
    var close = q('[data-act="voice-close"]');
    if (close) close.focus();
  }

  function closeVoice() {
    if (!V.open) return;
    V.open = false;
    cancelAnimationFrame(V.raf); V.raf = 0;
    stopPlayback(false);
    V.queue = [];
    abortSegment();
    V.parts = [];
    stopAudio();
    if (V.conv) bridge.call('voiceStop', { conversationId: V.conv.id })['catch'](function () { /* déjà arrêtée */ });
    V.conv = null; V.reply = null; V.startSeq++;
    if (V.root) { V.root.remove(); V.root = null; }
    V.face = null;
    document.documentElement.classList.remove('vc-open');
    var btn = document.getElementById('voice-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (V.lastFocus && document.contains(V.lastFocus)) { try { V.lastFocus.focus(); } catch (e) { /* plus focusable */ } }
  }

  /* ══ Conversation (hôte) ══════════════════════════════════════════════ */

  /* Démarre — ou redémarre, sujet, interlocuteur ou modèle changés — une conversation neuve ;
     l'avatar salue de lui-même. */
  function startConversation(restart) {
    var seq = ++V.startSeq;
    var c = cfg();
    if (V.conv) {
      interrupt(false);
      bridge.call('voiceStop', { conversationId: V.conv.id })['catch'](function () { /* déjà arrêtée */ });
    }
    V.conv = null; V.reply = null; V.queue = []; V.pendingHeard = null; V.parts = [];
    V.caption = ''; V.you = '';
    if (restart) V.history.push({ role: 'sep', text: 'Nouvelle conversation · ' + topicOf(c.topic).label });
    setPhase('starting');
    renderTexts(); renderHistory();
    bridge.call('voiceStart', {
      model: c.model, effort: c.effort, persona: c.persona, topic: c.topic, instructions: c.instructions, web: c.web
    }, 60000).then(function (r) {
      if (seq !== V.startSeq || !V.open) {
        if (r && r.conversationId) bridge.call('voiceStop', { conversationId: r.conversationId })['catch'](function () { /* rien */ });
        return;
      }
      V.conv = { id: r.conversationId };
      setNotice(null, 'conv');
      say(GREETING, true);
    }, function (e) {
      if (seq !== V.startSeq || !V.open) return;
      setPhase('error', 'Conversation impossible : ' + e.message);
      setNotice({ kind: 'conv', text: 'Conversation impossible : ' + e.message, act: 'voice-restart', label: 'Réessayer' });
    });
  }

  function restartSoon() {
    clearTimeout(V.restartTimer);
    V.restartTimer = setTimeout(function () { if (V.open) startConversation(true); }, 500);
  }

  /* Envoie ce que l'utilisateur a dit ; `hidden` : message de service (salut d'ouverture). */
  function say(text, hidden) {
    if (!V.conv) {
      setPhase(V.phase === 'error' ? 'error' : 'listening', V.statusText);
      app.toast('La conversation n’a pas démarré : ↻ pour réessayer.');
      return;
    }
    var payload = { conversationId: V.conv.id, text: text };
    if (V.pendingHeard != null) payload.heard = V.pendingHeard;
    V.pendingHeard = null;
    if (!hidden) V.history.push({ role: 'user', text: text });
    var reply = V.reply = { turn: null, sentences: [], played: 0, done: false, entry: null };
    V.toolText = '';
    setPhase('thinking');
    renderHistory();
    bridge.call('voiceSay', payload, 30000).then(function (r) {
      var turn = r && r.turn;
      if (turn != null) V.maxTurn = Math.max(V.maxTurn, turn);
      if (V.reply === reply) { if (reply.turn == null) reply.turn = turn; }
      else if (turn != null) V.ignoreTurns[turn] = 1;
    }, function (e) {
      if (V.reply !== reply) return;
      V.reply = null;
      failReply(e.message);
    });
  }

  function failReply(msg) {
    setPhase('listening');
    app.toast('Conversation : ' + msg);
    V.history.push({ role: 'error', text: msg });
    renderHistory();
  }

  function onVoice(p) {
    p = p || {};
    if (!V.open || !V.conv || p.conversationId !== V.conv.id) return;
    var turn = p.turn;
    if (turn != null) V.maxTurn = Math.max(V.maxTurn, turn);
    if (turn != null && (V.ignoreTurns[turn] || turn < V.minTurn)) return;
    var reply = V.reply;
    if (!reply || reply.done) return;
    if (reply.turn == null && turn != null) reply.turn = turn;
    else if (turn != null && reply.turn !== turn) return;

    if (p.phase === 'thinking') {
      if (!V.playing) setPhase('thinking');
    } else if (p.phase === 'tool') {
      V.toolText = p.text || 'Je cherche…';
      if (!V.playing) setPhase('tool');
    } else if (p.phase === 'sentence') {
      var text = String(p.text || '').trim();
      if (!text) return;
      reply.sentences.push(text);
      if (!reply.entry) { reply.entry = { role: 'assistant', sentences: reply.sentences, heard: null }; V.history.push(reply.entry); }
      renderHistory();
      enqueue(text);
    } else if (p.phase === 'done') {
      reply.done = true;
      pump();
    } else if (p.phase === 'error') {
      V.reply = null;
      stopPlayback(true); V.queue = [];
      failReply(p.error || 'la réponse a échoué.');
    }
  }

  /* Coupe la parole à l'avatar : silence en 80 ms, file vidée, et l'hôte apprend ce qui a été
     réellement entendu (phrases jouées en entier, et le début de celle en cours au prorata). */
  function interrupt(startle) {
    var reply = V.reply;
    if (!reply) return false;
    var heard = heardOf(reply);
    stopPlayback(true);
    V.queue = [];
    if (reply.turn != null) { V.ignoreTurns[reply.turn] = 1; V.minTurn = Math.max(V.minTurn, reply.turn + 1); }
    else V.minTurn = Math.max(V.minTurn, V.maxTurn + 1);
    V.reply = null;
    if (reply.entry) reply.entry.heard = heard;
    if (V.conv) bridge.call('voiceInterrupt', { conversationId: V.conv.id, heard: heard })['catch'](function () { /* déjà finie */ });
    V.pendingHeard = heard;
    V.captionDim = true;
    if (startle && V.anim) V.anim.startleAt = performance.now();
    if (V.phase !== 'user') setPhase('listening');
    renderTexts(); renderHistory();
    return true;
  }

  function heardOf(reply) {
    var parts = reply.sentences.slice(0, reply.played);
    var pl = V.playing;
    if (pl && pl.text) {
      var frac = clamp(pl.elapsed() / Math.max(0.1, pl.dur), 0, 1);
      var words = pl.text.split(/\s+/);
      var n = Math.floor(words.length * frac);
      if (n > 0) parts.push(words.slice(0, n).join(' '));
    }
    return parts.join(' ');
  }

  /* ══ Synthèse et lecture ══════════════════════════════════════════════ */

  function enqueue(text) {
    V.queue.push({ text: text, state: 'wait', buffer: null });
    pump();
  }

  /* La phrase suivante se synthétise pendant que la précédente joue : deux d'avance au plus. */
  function pump() {
    var ahead = 0, i, it;
    for (i = 0; i < V.queue.length; i++) if (V.queue[i].state === 'loading') ahead++;
    for (i = 0; i < V.queue.length && ahead < 2; i++) {
      it = V.queue[i];
      if (it.state === 'wait') { synth(it); ahead++; }
    }
    if (!V.playing && V.queue.length) {
      it = V.queue[0];
      if (it.state === 'ready') playItem(it);
      else if (it.state === 'failed') playFallback(it);
    }
    if (!V.playing && !V.queue.length && V.reply && V.reply.done) finishReply();
  }

  function synth(it) {
    it.state = 'loading';
    var c = cfg();
    bridge.call('voiceSpeak', { text: it.text, voice: c.voice, rate: c.rate }, 30000).then(function (r) {
      if (V.queue.indexOf(it) < 0 || !V.ctx) return null;
      return V.ctx.decodeAudioData(bytesOf(r && r.audio).buffer);
    }).then(function (buf) {
      if (!buf || V.queue.indexOf(it) < 0) return;
      it.buffer = buf; it.state = 'ready';
      pump();
    })['catch'](function (e) {
      if (V.queue.indexOf(it) < 0) return;
      if (!V.ttsWarned) { V.ttsWarned = true; console.warn('[voice] voiceSpeak', e); }
      it.state = 'failed';
      pump();
    });
  }

  function playItem(it) {
    var ctx = V.ctx;
    var src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = it.buffer;
    src.connect(g); g.connect(V.outGain);
    var t0 = ctx.currentTime;
    var pl = V.playing = {
      text: it.text, src: src, gain: g, dur: it.buffer.duration,
      elapsed: function () { return ctx.currentTime - t0; }
    };
    src.onended = function () { if (V.playing === pl) sentenceDone(); };
    src.start();
    showSentence(it.text);
  }

  /* La synthèse de l'hôte a échoué : speechSynthesis, en dernier recours (son hors annulation d'écho,
     d'où un seuil de détection plus exigeant pendant qu'il joue — voir PLAY_BOOST_DB). */
  function playFallback(it) {
    var ss = window.speechSynthesis;
    var t0 = performance.now(), est = Math.max(0.8, it.text.length * 0.065);
    var pl = V.playing = {
      text: it.text, fallback: true, dur: est,
      elapsed: function () { return (performance.now() - t0) / 1000; }
    };
    showSentence(it.text);
    if (!ss || typeof SpeechSynthesisUtterance === 'undefined') {
      pl.timer = setTimeout(function () { if (V.playing === pl) sentenceDone(); }, est * 1000);
      return;
    }
    var u = new SpeechSynthesisUtterance(it.text);
    var lang = cfg().topic === 'anglais' ? 'en' : 'fr';
    u.lang = lang === 'en' ? 'en-US' : 'fr-FR';
    var voice = ss.getVoices().filter(function (v) { return String(v.lang).toLowerCase().indexOf(lang) === 0; })[0];
    if (voice) u.voice = voice;
    u.rate = clamp(1 + cfg().rate * 0.06, 0.5, 2);
    u.onend = function () { if (V.playing === pl) sentenceDone(); };
    /* Pas de voix du tout (synthèse refusée d'emblée) : le sous-titre reste le temps de la lire. */
    u.onerror = function () {
      if (V.playing !== pl) return;
      var left = est - pl.elapsed();
      if (left > 0.3) pl.timer = setTimeout(function () { if (V.playing === pl) sentenceDone(); }, left * 1000);
      else sentenceDone();
    };
    pl.utter = u;
    ss.speak(u);
  }

  function sentenceDone() {
    V.playing = null;
    V.queue.shift();
    if (V.reply) V.reply.played++;
    pump();
  }

  function showSentence(text) {
    V.caption = text; V.captionDim = false;
    if (V.phase !== 'user') setPhase('speaking');
    renderTexts();
  }

  function finishReply() {
    V.reply = null;
    V.captionDim = true;
    if (V.phase !== 'user' && V.phase !== 'transcribing') setPhase('listening');
    renderTexts();
  }

  /* Fondu de 80 ms plutôt qu'une coupure sèche (pas de clic). */
  function stopPlayback(fade) {
    var pl = V.playing;
    V.playing = null;
    if (!pl) return;
    if (pl.fallback) {
      clearTimeout(pl.timer);
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* rien à couper */ }
      return;
    }
    try {
      var now = V.ctx.currentTime;
      if (fade) {
        pl.gain.gain.setValueAtTime(pl.gain.gain.value, now);
        pl.gain.gain.linearRampToValueAtTime(0, now + 0.08);
        pl.src.stop(now + 0.09);
      } else {
        pl.src.stop();
      }
    } catch (e) { /* déjà arrêtée */ }
  }

  /* ══ Micro et détection de parole ═════════════════════════════════════ */

  var WORKLET = [
    'class OrganizatorVad extends AudioWorkletProcessor {',
    '  constructor(o) { super(); this.size = o.processorOptions.size; this.buf = new Float32Array(this.size); this.n = 0; }',
    '  process(inputs) {',
    '    var ch = inputs[0] && inputs[0][0];',
    '    if (ch) for (var i = 0; i < ch.length; i++) {',
    '      this.buf[this.n++] = ch[i];',
    '      if (this.n === this.size) { var out = this.buf.slice(0); this.port.postMessage(out, [out.buffer]); this.n = 0; }',
    '    }',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("organizator-vad", OrganizatorVad);'
  ].join('\n');

  function ensureContext() {
    if (V.ctx) return V.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = V.ctx = new AC();
    V.outGain = ctx.createGain();
    V.outAnalyser = ctx.createAnalyser();
    V.outAnalyser.fftSize = 1024;
    V.outAnalyser.smoothingTimeConstant = 0.5;
    V.outGain.connect(V.outAnalyser);
    V.outAnalyser.connect(ctx.destination);
    V.timeBuf = new Float32Array(V.outAnalyser.fftSize);
    V.freqBuf = new Uint8Array(V.outAnalyser.frequencyBinCount);
    V.sink = ctx.createGain();
    V.sink.gain.value = 0;
    V.sink.connect(ctx.destination);
    if (ctx.audioWorklet && window.Blob && window.URL) {
      var url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      V.workletReady = ctx.audioWorklet.addModule(url).then(function () { URL.revokeObjectURL(url); return true; },
        function (e) { console.warn('[voice] AudioWorklet indisponible, ScriptProcessor en secours', e); return false; });
    } else {
      V.workletReady = Promise.resolve(false);
    }
    return ctx;
  }

  function startAudio() {
    var ctx;
    try { ctx = ensureContext(); } catch (e) {
      setNotice({ kind: 'mic', text: 'Son indisponible dans cette fenêtre : ' + e.message });
      return;
    }
    if (ctx.state !== 'running') ctx.resume()['catch'](function () { /* reprise au prochain geste */ });
    resetVad();
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) {
      setNotice({ kind: 'mic', text: 'Pas d’accès au micro dans cette fenêtre : la conversation ne peut pas vous entendre.' });
      return;
    }
    md.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (stream) {
        if (!V.open) { stream.getTracks().forEach(function (t) { t.stop(); }); return null; }
        V.stream = stream;
        return V.workletReady.then(function (ok) {
          if (!V.open || V.stream !== stream) return;
          V.source = ctx.createMediaStreamSource(stream);
          if (ok) {
            V.vadNode = new AudioWorkletNode(ctx, 'organizator-vad', {
              numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
              processorOptions: { size: Math.round(ctx.sampleRate * FRAME_MS / 1000) }
            });
            V.vadNode.port.onmessage = function (ev) { onFrame(ev.data); };
          } else {
            V.vadNode = ctx.createScriptProcessor(1024, 1, 1);
            V.vadNode.onaudioprocess = function (ev) { onFrame(new Float32Array(ev.inputBuffer.getChannelData(0))); };
          }
          V.source.connect(V.vadNode);
          V.vadNode.connect(V.sink);
          setNotice(null, 'mic');
        });
      })['catch'](function (e) {
        if (!V.open) return;
        setNotice({ kind: 'mic', text: 'Micro indisponible : ' + (app.micError ? app.micError(e) : e.message), act: 'voice-mic-retry', label: 'Réessayer' });
      });
  }

  function stopAudio() {
    if (V.vadNode) {
      try { V.vadNode.disconnect(); } catch (e) { /* déjà débranché */ }
      if (V.vadNode.port) V.vadNode.port.onmessage = null;
      V.vadNode.onaudioprocess = null;
      V.vadNode = null;
    }
    if (V.source) { try { V.source.disconnect(); } catch (e) { /* déjà débranché */ } V.source = null; }
    if (V.stream) { V.stream.getTracks().forEach(function (t) { t.stop(); }); V.stream = null; }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* rien */ }
    /* Un seul contexte pour toute la vie de la page : suspendu, il ne consomme rien. */
    if (V.ctx && V.ctx.state === 'running') V.ctx.suspend()['catch'](function () { /* déjà suspendu */ });
  }

  function resetVad() {
    V.vad = {
      floor: -65, above: 0, preroll: [], inSpeech: false, seg: null
    };
    V.micDb = -100; V.micLevel = 0;
  }

  /* Seuil = plancher de bruit + marge (la sensibilité la réduit), jamais sous un plancher absolu. */
  function thresholdDb(playing) {
    var sens = cfg().sensitivity;
    var margin = 18 - sens * 0.12;
    var t = Math.max(V.vad.floor + margin, -58 + (50 - sens) * 0.2);
    return playing ? t + PLAY_BOOST_DB : t;
  }

  function onFrame(buf) {
    if (!V.open || !V.vad || !buf || !buf.length) return;
    var rate = V.ctx.sampleRate;
    var ms = buf.length / rate * 1000;
    var sum = 0;
    for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    var db = 10 * Math.log10(sum / buf.length + 1e-12);
    var vad = V.vad;
    var playing = !!V.playing;
    var thr = thresholdDb(playing);
    V.micDb = db; V.threshold = thr;

    if (V.muted) { V.micLevel = 0; return; }
    V.micLevel = clamp((db - vad.floor) / 30, 0, 1);

    if (!vad.inSpeech) {
      /* Plancher adaptatif : il descend vite, monte lentement (moyenne des trames calmes). */
      if (db < vad.floor) vad.floor += (db - vad.floor) * 0.1;
      else if (db < thr) vad.floor += (db - vad.floor) * 0.012;
      else vad.floor += (db - vad.floor) * 0.002;
      vad.floor = clamp(vad.floor, -95, -30);

      vad.preroll.push(buf);
      var keep = Math.ceil((PREROLL_MS + ONSET_PLAY_MS) / ms);
      if (vad.preroll.length > keep) vad.preroll.splice(0, vad.preroll.length - keep);

      if (db > thr) vad.above += ms;
      else vad.above = Math.max(0, vad.above - 2 * ms);
      if (vad.above >= (playing || V.reply ? ONSET_PLAY_MS : ONSET_MS)) speechStart(ms);
      return;
    }

    var seg = vad.seg;
    seg.frames.push(buf);
    seg.ms += ms;
    if (db > thr - 3) {
      seg.voiced += ms; seg.run += ms; seg.silence = 0;
      if (seg.spec && seg.run >= RESUME_MS) cancelSpec(seg);
    } else {
      seg.run = 0; seg.silence += ms;
      if (!seg.spec && seg.silence >= SPEC_MS && seg.voiced >= MIN_MS) launchSpec(seg);
    }
    if (seg.silence >= END_MS) speechEnd();
    else if (seg.ms >= MAX_MS) speechEnd();
  }

  function speechStart(ms) {
    var vad = V.vad;
    var pre = Math.ceil(PREROLL_MS / ms) + Math.ceil(vad.above / ms);
    var frames = vad.preroll.slice(-pre);
    vad.preroll = [];
    vad.above = 0;
    vad.inSpeech = true;
    vad.seg = { frames: frames, ms: frames.length * ms, voiced: 0, run: 0, silence: 0, spec: null };
    /* Barge-in : l'utilisateur parle pendant que l'avatar parle ou réfléchit. */
    if (V.reply && interrupt(true)) V.bargedIn = true;
    setPhase('user');
  }

  function speechEnd() {
    var vad = V.vad, seg = vad.seg;
    vad.inSpeech = false; vad.seg = null; vad.above = 0;
    if (!seg) return;
    if (seg.voiced < MIN_MS) {
      cancelSpec(seg);
      if (!V.parts.length && V.bargedIn && V.pendingHeard != null && !V.reply) {
        V.bargedIn = false;
        say('(Ce n’était qu’un bruit, personne n’a parlé : reprends naturellement là où tu t’étais arrêté, sans te répéter.)', true);
        return;
      }
      if (!V.parts.length && !V.reply) setPhase('listening');
      else if (V.parts.length) setPhase('transcribing');
      flushParts();
      return;
    }
    var p;
    if (seg.spec && !seg.spec.cancelled) p = seg.spec.promise;
    else p = transcribe(seg.frames).promise;
    V.parts.push(p);
    setPhase('transcribing');
    if (V.anim) V.anim.nodAt = performance.now();
    flushParts();
  }

  function abortSegment() {
    if (!V.vad) return;
    if (V.vad.seg) cancelSpec(V.vad.seg);
    V.vad.inSpeech = false; V.vad.seg = null; V.vad.above = 0; V.vad.preroll = [];
  }

  /* Transcription spéculative : lancée dès 300 ms de silence, gardée si la phrase est bien finie,
     abandonnée si la parole reprend. */
  function launchSpec(seg) {
    seg.spec = transcribe(seg.frames.slice());
  }

  function cancelSpec(seg) {
    var sp = seg.spec;
    if (!sp) return;
    seg.spec = null;
    sp.cancelled = true;
    bridge.call('cancelTranscribe', { job: sp.job })['catch'](function () { /* déjà finie */ });
  }

  function transcribe(frames) {
    var job = uid('vj');
    var t = { job: job, cancelled: false, promise: null };
    var c = cfg();
    if (!whisperReady()) {
      t.promise = Promise.resolve('');
      if (!t.cancelled) flashNotice();
      return t;
    }
    t.promise = segmentWav(frames, V.ctx.sampleRate).then(function (data) {
      if (t.cancelled) return '';
      return bridge.call('transcribe', { job: job, data: data, model: c.whisperModel, language: c.language }, 120000)
        .then(function (r) { return String((r && r.text) || '').trim(); });
    })['catch'](function (e) {
      if (!t.cancelled && V.open) app.toast('Transcription impossible : ' + e.message);
      return '';
    });
    return t;
  }

  /* L'énoncé part quand l'utilisateur s'est tu et que toutes ses transcriptions sont rendues. */
  function flushParts() {
    if (!V.parts.length) return;
    var parts = V.parts.slice();
    Promise.all(parts).then(function (texts) {
      if (!V.open || V.parts.length !== parts.length || V.parts[0] !== parts[0] || (V.vad && V.vad.inSpeech)) return;
      V.parts = [];
      var text = texts.filter(function (t) { return t && !isJunk(t); }).join(' ').replace(/\s+/g, ' ').trim();
      var barged = V.bargedIn;
      V.bargedIn = false;
      if (!text) {
        if (V.phase === 'transcribing') setPhase('listening');
        /* Un bruit (toux, porte, écho) a coupé l'avatar sans que personne ne parle : il reprend. */
        if (barged && V.pendingHeard != null && !V.reply) say('(Ce n’était qu’un bruit, personne n’a parlé : reprends naturellement là où tu t’étais arrêté, sans te répéter.)', true);
        return;
      }
      V.you = text;
      renderTexts();
      if (V.reply) interrupt(false);
      say(text, false);
    });
  }

  /* ══ Whisper : modèle de la conversation ══════════════════════════════ */

  function whisperModel() {
    var st = app.env().whisper;
    var id = cfg().whisperModel;
    return st && st.models ? (st.models.filter(function (m) { return m.id === id; })[0] || null) : null;
  }

  function whisperReady() {
    var m = whisperModel();
    return !!(m && m.downloaded);
  }

  function checkWhisper(warm) {
    var env = app.env();
    var m = whisperModel();
    if (!env.whisper) {
      setNotice({ kind: 'whisper', text: 'Transcription indisponible dans cette fenêtre : la conversation ne peut pas vous entendre.' });
      return;
    }
    if (!m) {
      setNotice({ kind: 'whisper', text: 'Modèle Whisper « ' + cfg().whisperModel + ' » inconnu : choisissez-en un dans ⚙.' });
      return;
    }
    if (!m.downloaded) {
      var dl = V.dl && V.dl.model === m.id ? V.dl : null;
      setNotice({
        kind: 'whisper',
        text: 'Pour vous entendre, la conversation a besoin du modèle Whisper « ' + m.label + ' » (' + fmtSize(m.size) + '), pas encore téléchargé sur ce poste.',
        act: dl ? '' : 'voice-download', label: 'Télécharger',
        progress: dl ? (dl.total ? Math.floor(100 * dl.received / dl.total) : 0) : -1
      });
      return;
    }
    setNotice(null, 'whisper');
    if (warm) bridge.call('whisperWarm', { model: m.id })['catch'](function () { /* redit à la transcription */ });
  }

  function downloadWhisper() {
    var m = whisperModel();
    if (!m || (V.dl && V.dl.model === m.id)) return;
    V.dl = { model: m.id, received: 0, total: m.size || 0 };
    checkWhisper(false);
    bridge.call('whisperDownload', { model: m.id }, 3600000).then(function (st) {
      V.dl = null;
      if (st && st.models) app.env().whisper = st;
      if (V.open) checkWhisper(true);
    }, function (e) {
      V.dl = null;
      app.toast('Téléchargement impossible : ' + e.message);
      if (V.open) checkWhisper(false);
    });
  }

  function onWhisper(p) {
    p = p || {};
    if (!V.open || p.job || !p.model) return;
    if (p.phase === 'download') {
      V.dl = { model: p.model, received: p.received || 0, total: p.total || 0 };
      checkWhisper(false);
    } else {
      bridge.call('whisperStatus', {}).then(function (st) {
        if (st && st.models) app.env().whisper = st;
        if (V.dl && V.dl.model === p.model) V.dl = null;
        if (V.open) { checkWhisper(true); if (V.drawer === 'settings') renderSettings(); }
      })['catch'](function () { /* état du démarrage */ });
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
    var c = cfg();
    var text = c.topic === 'anglais'
      ? 'Hello, I’m ' + c.persona + '. This is my voice.'
      : 'Bonjour, je suis ' + c.persona + '. Voici ma voix.';
    var btn = q('[data-act="voice-listen"]');
    if (btn) btn.disabled = true;
    ensureContext();
    if (V.ctx.state !== 'running') V.ctx.resume();
    bridge.call('voiceSpeak', { text: text, voice: c.voice, rate: c.rate }, 30000).then(function (r) {
      return V.ctx.decodeAudioData(bytesOf(r && r.audio).buffer);
    }).then(function (buf) {
      var src = V.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(V.outGain);
      src.start();
    })['catch'](function (e) {
      app.toast('Voix indisponible : ' + e.message);
    }).then(function () { if (btn) btn.disabled = false; });
  }

  /* ══ Phases, textes, avis ═════════════════════════════════════════════ */

  var STATUS = {
    starting: 'Je me prépare…', listening: 'Je vous écoute', user: 'Je vous écoute…', transcribing: 'Je réfléchis…',
    thinking: 'Je réfléchis…', tool: 'Je cherche…', speaking: 'Parlez pour m’interrompre', error: ''
  };

  function setPhase(phase, text) {
    V.phase = phase;
    V.statusText = text || '';
    if (V.root) {
      V.root.setAttribute('data-phase', phase);
      renderStatus();
      renderControls();
    }
  }

  function statusLabel() {
    if (V.muted) return 'Micro coupé · M pour le rouvrir';
    if (V.phase === 'tool') return V.toolText || STATUS.tool;
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
    if (hush) hush.disabled = !V.reply;
  }

  function setNotice(n, kind) {
    if (!n && kind && V.notice && V.notice.kind !== kind) return;
    V.notice = n;
    renderNotice();
  }

  function renderNotice() {
    var box = q('.vc-notice');
    if (!box) return;
    var n = V.notice;
    box.hidden = !n;
    if (!n) { box.innerHTML = ''; return; }
    box.innerHTML = '<span class="vc-notice-text">' + esc(n.text) + '</span>'
      + (n.progress >= 0 ? '<span class="vc-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + n.progress
        + '" aria-label="Téléchargement"><i style="width:' + n.progress + '%"></i></span><span class="vc-notice-pct">' + n.progress + ' %</span>' : '')
      + (n.act ? '<button type="button" class="btn btn-primary btn-small" data-act="' + esc(n.act) + '">' + esc(n.label) + '</button>' : '');
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
      + '<div class="vc-avatar">' + faceSvg() + '</div>'
      + '<div class="vc-status"><span class="vc-status-dot"></span><span class="vc-status-text"></span></div>'
      + '<p class="vc-caption" aria-live="polite"></p>'
      + '<p class="vc-you" aria-live="polite" hidden><span class="vc-you-label">Vous</span><span class="vc-you-text"></span></p>'
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
    V.face = bindFace(root.querySelector('.vc-face'));
    V.anim = newAnim();
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', trapFocus);
    setPhase(V.phase);
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
    if (V.drawer === 'settings') { loadVoices(); renderSettings(); }
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

    var wm = (app.env().whisper && app.env().whisper.models) || [];
    h.push(fieldHtml('Modèle Whisper de la conversation',
      '<select class="input set-select" id="vc-whisper" data-voice="whisper"' + (wm.length ? '' : ' disabled') + '>'
      + (wm.length ? '' : '<option>Transcription indisponible</option>')
      + wm.map(function (m) {
        return '<option value="' + esc(m.id) + '"' + (m.id === c.whisperModel ? ' selected' : '') + '>' + esc(m.label)
          + (m.id === 'base' ? ' — conseillé, le plus rapide' : '') + (m.downloaded ? '' : ' · à télécharger (' + fmtSize(m.size) + ')') + '</option>';
      }).join('') + '</select>',
      'Distinct de celui de la dictée (' + esc(s.whisperModel || 'small') + ') : ici, chaque phrase doit être transcrite en moins d’une seconde.', 'vc-whisper'));

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
      var patch = {};
      patch[k === 'rate' ? 'voiceRate' : 'voiceSensitivity'] = v;
      setSettings(patch);
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
    } else if (k === 'whisper') {
      setSettings({ voiceWhisperModel: el.value });
      checkWhisper(true);
    }
  }

  /* ══ Avatar ═══════════════════════════════════════════════════════════ */

  /* Un visage rond aux formes douces : tête en galet qui respire, une pousse de feuille, yeux,
     sourcils, joues, bouche dessinée à chaque image. Coordonnées centrées sur la tête. */
  function faceSvg() {
    function eye(side) {
      var x = side * 30;
      return '<g class="vc-eye-pos" data-eye="' + side + '" transform="translate(' + x + ',-10)">'
        + '<g class="vc-eye-lid"><ellipse class="vc-eye" rx="8.5" ry="11"></ellipse>'
        + '<circle class="vc-glint" cx="2.6" cy="-4.2" r="2.8"></circle><circle class="vc-glint" cx="-2.6" cy="3.6" r="1.2"></circle></g></g>';
    }
    return '<svg class="vc-face" viewBox="-140 -140 280 280" role="img" aria-label="Avatar de l’interlocuteur">'
      + '<circle class="vc-ring-track" r="120"></circle>'
      + '<circle class="vc-ring" r="120"></circle>'
      + '<ellipse class="vc-shadow" cx="0" cy="100" rx="50" ry="7"></ellipse>'
      + '<g class="vc-body">'
      + '<g class="vc-head">'
      + '<g class="vc-sprout"><path class="vc-stem" d="M0 -78 C -2 -90 2 -98 6 -104"></path>'
      + '<path class="vc-leaf" d="M6 -104 C 12 -122 34 -124 40 -116 C 32 -104 16 -100 6 -104 Z"></path>'
      + '<path class="vc-leaf vc-leaf-2" d="M3 -96 C -6 -110 -24 -110 -28 -103 C -20 -94 -6 -92 3 -96 Z"></path></g>'
      + '<path class="vc-skin" d=""></path>'
      + '<ellipse class="vc-sheen" cx="-28" cy="-44" rx="24" ry="12" transform="rotate(-24 -28 -44)"></ellipse>'
      + '<ellipse class="vc-cheek" cx="-46" cy="16" rx="13" ry="7.5"></ellipse>'
      + '<ellipse class="vc-cheek" cx="46" cy="16" rx="13" ry="7.5"></ellipse>'
      + eye(-1) + eye(1)
      + '<path class="vc-brow" data-brow="-1" d=""></path><path class="vc-brow" data-brow="1" d=""></path>'
      + '<path class="vc-mouth" d=""></path>'
      + '<path class="vc-tongue" d=""></path>'
      + '</g></g>'
      + '<g class="vc-dots"><circle r="6" cx="72" cy="-96"></circle><circle r="7.5" cx="92" cy="-108"></circle><circle r="9" cx="116" cy="-118"></circle></g>'
      + '<g class="vc-lens" transform="translate(84,-74)"><circle class="vc-lens-glass" r="17"></circle><path class="vc-lens-handle" d="M12 12 L26 26"></path>'
      + '<path class="vc-lens-shine" d="M-8 -6 A 10 10 0 0 1 2 -11"></path></g>'
      + '</svg>';
  }

  function bindFace(svg) {
    if (!svg) return null;
    function one(sel) { return svg.querySelector(sel); }
    return {
      svg: svg, ring: one('.vc-ring'), track: one('.vc-ring-track'), shadow: one('.vc-shadow'),
      body: one('.vc-body'), head: one('.vc-head'), skin: one('.vc-skin'), sprout: one('.vc-sprout'),
      eyes: [one('[data-eye="-1"]'), one('[data-eye="1"]')],
      lids: [one('[data-eye="-1"] .vc-eye-lid'), one('[data-eye="1"] .vc-eye-lid')],
      brows: [one('[data-brow="-1"]'), one('[data-brow="1"]')],
      mouth: one('.vc-mouth'), tongue: one('.vc-tongue'), dots: one('.vc-dots'), dotList: svg.querySelectorAll('.vc-dots circle'),
      lens: one('.vc-lens')
    };
  }

  function newAnim() {
    var now = performance.now();
    return {
      last: now, t: 0,
      blinkAt: now + 1500 + Math.random() * 2500, blinkDouble: false,
      gaze: { x: 0, y: 0 }, gazeTarget: { x: 0, y: 0 }, saccadeAt: now + 800,
      tilt: 0, nod: 0, lift: 0,
      open: 0, wide: 1, round: 0, amp: 0,
      brow: [0, 0], browTilt: [0, 0],
      ring: 0, ringR: 120,
      dots: 0, lens: 0, smile: 4,
      startleAt: 0, nodAt: 0
    };
  }

  function mood() {
    if (V.phase === 'speaking' || V.playing) return 'speak';
    if (V.phase === 'tool') return 'search';
    if (V.phase === 'thinking' || V.phase === 'transcribing' || V.phase === 'starting') return 'think';
    if (V.muted) return 'rest';
    if (V.phase === 'user') return 'user';
    return 'listen';
  }

  /* Amplitude et timbre de ce que joue l'avatar : l'ouverture suit l'énergie, la forme suit le
     spectre (graves : bouche ronde, aigus : bouche étirée). */
  function voiceShape() {
    var pl = V.playing;
    if (!pl) return { amp: 0, low: 0, high: 0 };
    if (pl.fallback) {
      var t = performance.now() / 1000;
      return { amp: 0.25 + 0.35 * Math.abs(Math.sin(t * 9.3) * Math.sin(t * 3.1 + 1)), low: 0.4, high: 0.3 };
    }
    var a = V.outAnalyser;
    a.getFloatTimeDomainData(V.timeBuf);
    var sum = 0, i;
    for (i = 0; i < V.timeBuf.length; i++) sum += V.timeBuf[i] * V.timeBuf[i];
    var rms = Math.sqrt(sum / V.timeBuf.length);
    a.getByteFrequencyData(V.freqBuf);
    var hz = V.ctx.sampleRate / a.fftSize;
    function band(f0, f1) {
      var s = 0, n = 0;
      for (var b = Math.floor(f0 / hz); b <= Math.ceil(f1 / hz) && b < V.freqBuf.length; b++) { s += V.freqBuf[b]; n++; }
      return n ? s / n / 255 : 0;
    }
    var low = band(150, 700), mid = band(700, 2000), high = band(2000, 6000);
    var tot = low + mid + high + 1e-6;
    return { amp: clamp(rms * 5, 0, 1), low: low / tot, high: high / tot };
  }

  function approach(cur, target, rate, dt) { return cur + (target - cur) * (1 - Math.exp(-rate * dt)); }

  function blobPath(t, energy) {
    var pts = [], n = 12;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2;
      var r = 82 + 1.0 * Math.sin(2 * a + t * 0.7) + 0.6 * Math.sin(3 * a - t * 0.5) + energy * 1.6 * Math.sin(4 * a + t * 6);
      var x = Math.cos(a) * r * 1.02, y = Math.sin(a) * r * (Math.sin(a) > 0 ? 1.0 : 0.96);
      pts.push([x, y + 4]);
    }
    /* Catmull-Rom fermé → courbes de Bézier. */
    var d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (var k = 0; k < n; k++) {
      var p0 = pts[(k - 1 + n) % n], p1 = pts[k], p2 = pts[(k + 1) % n], p3 = pts[(k + 2) % n];
      d += 'C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ' ' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) + ' '
        + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ' ' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) + ' '
        + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
    }
    return d + 'Z';
  }

  function frame(now) {
    if (!V.open) return;
    V.raf = requestAnimationFrame(frame);
    var F = V.face, A = V.anim;
    if (!F || !A) return;
    var dt = Math.min(0.1, (now - A.last) / 1000);
    A.last = now; A.t += dt;
    var t = A.t;
    var m = mood();
    var sh = voiceShape();

    /* Bouche : attaque rapide, relâche plus douce — pas de claquement. */
    A.amp = sh.amp > A.amp ? approach(A.amp, sh.amp, 28, dt) : approach(A.amp, sh.amp, 12, dt);
    var openT = m === 'speak' ? clamp((A.amp - 0.03) * 1.6, 0, 1) : (m === 'search' ? 0.12 : 0);
    A.open = approach(A.open, openT, 22, dt);
    A.wide = approach(A.wide, m === 'speak' ? 1 + 0.35 * sh.high - 0.45 * sh.low * A.open : (m === 'think' ? 0.62 : 1), 10, dt);
    A.round = approach(A.round, m === 'speak' ? clamp(sh.low * 1.4 - 0.3, 0, 1) : (m === 'search' ? 0.8 : 0), 10, dt);
    A.smile = approach(A.smile, m === 'think' ? 0.5 : (m === 'search' ? 0 : (m === 'rest' ? 3 : 5)), 4, dt);

    /* Regard : vers l'utilisateur à l'écoute, en l'air quand il réfléchit, en lecture quand il cherche. */
    if (now > A.saccadeAt) {
      A.saccadeAt = now + 600 + Math.random() * 2200;
      var jx = (Math.random() - 0.5) * 3, jy = (Math.random() - 0.5) * 2;
      if (m === 'think') A.gazeTarget = { x: 4 + jx * 0.5, y: -5 + jy * 0.5 };
      else if (m === 'search') A.gazeTarget = { x: Math.random() < 0.5 ? -3 : 3, y: 3 };
      else A.gazeTarget = { x: jx, y: jy + (m === 'user' ? 0.8 : 0) };
    }
    A.gaze.x = approach(A.gaze.x, A.gazeTarget.x, 14, dt);
    A.gaze.y = approach(A.gaze.y, A.gazeTarget.y, 14, dt);

    /* Clignements, parfois doublés. */
    var lid = 1;
    var bt = (now - A.blinkAt) / 1000;
    if (bt > 0) {
      if (bt < 0.15) lid = Math.abs(1 - 2 * (bt / 0.15)) * 0.92 + 0.08;
      else {
        A.blinkAt = now + (A.blinkDouble ? 180 : 2200 + Math.random() * 3800);
        A.blinkDouble = !A.blinkDouble && Math.random() < 0.18;
      }
    }
    if (m === 'rest') lid = Math.min(lid, 0.45);

    /* Sursaut quand on lui coupe la parole. */
    var st = A.startleAt ? (now - A.startleAt) / 1000 : 9;
    var startle = st < 0.7 ? Math.exp(-st * 6) * Math.sin(Math.min(1, st * 8) * Math.PI * 0.5 + 0.6) : 0;
    if (st < 0.25) lid = Math.max(lid, 1);

    /* Tête : inclinée et attentive à l'écoute (hochements au rythme de la voix de l'utilisateur). */
    var lvl = V.micLevel || 0;
    A.tilt = approach(A.tilt, m === 'listen' || m === 'user' ? -5 : (m === 'think' ? 4 : (m === 'search' ? -2 : 0)), 3, dt);
    A.nod = approach(A.nod, m === 'user' ? lvl * 4 * (0.6 + 0.4 * Math.sin(t * 7)) : 0, 8, dt);
    var nodAt = A.nodAt ? (now - A.nodAt) / 1000 : 9;
    var nodBump = nodAt < 0.6 ? Math.sin(nodAt / 0.6 * Math.PI * 2) * 3 * (1 - nodAt / 0.6) : 0;
    var breath = Math.sin(t * Math.PI * 2 / 4.2);
    var speakBob = m === 'speak' ? A.amp * 2.5 : 0;

    F.body.setAttribute('transform', 'translate(0 ' + (breath * -1.6 - startle * 7).toFixed(2) + ') scale(' + (1 + breath * 0.012 + startle * 0.05).toFixed(4) + ')');
    F.head.setAttribute('transform', 'rotate(' + (A.tilt + Math.sin(t * 0.9) * 0.8 + (m === 'speak' ? Math.sin(t * 2.3) * A.amp * 2 : 0)).toFixed(2)
      + ' 0 40) translate(0 ' + (A.nod + nodBump + speakBob).toFixed(2) + ')');
    F.skin.setAttribute('d', blobPath(t, m === 'speak' ? A.amp : lvl * 0.5));
    F.shadow.setAttribute('rx', (50 - breath * 2 + startle * 4).toFixed(1));
    F.sprout.setAttribute('transform', 'rotate(' + (Math.sin(t * 1.3) * 4 + (m === 'speak' ? Math.sin(t * 5) * A.amp * 8 : 0) - startle * 12).toFixed(2) + ' 0 -78)');

    var eyeScale = 1 + startle * 0.25 + (m === 'user' ? 0.04 : 0);
    for (var e = 0; e < 2; e++) {
      var side = e ? 1 : -1;
      F.eyes[e].setAttribute('transform', 'translate(' + (side * 30 + A.gaze.x).toFixed(2) + ' ' + (-10 + A.gaze.y).toFixed(2) + ')');
      F.lids[e].setAttribute('transform', 'scale(' + eyeScale.toFixed(3) + ' ' + (lid * eyeScale).toFixed(3) + ')');
    }

    /* Sourcils : intéressés à l'écoute, asymétriques en réflexion, froncés en recherche, levés au sursaut. */
    var bLift = [0, 0], bTilt = [0, 0];
    if (m === 'listen' || m === 'user') { bLift = [-3 - lvl * 3, -3 - lvl * 3]; bTilt = [-2, -2]; }
    else if (m === 'think') { bLift = [-6, 0]; bTilt = [-6, 4]; }
    else if (m === 'search') { bLift = [0, 0]; bTilt = [3, 3]; }
    else if (m === 'speak') { var em = A.amp > 0.55 ? -3 : 0; bLift = [em - 1, em - 1]; bTilt = [-1, -1]; }
    else if (m === 'rest') { bLift = [1, 1]; bTilt = [-3, -3]; }
    for (var b = 0; b < 2; b++) {
      A.brow[b] = approach(A.brow[b], bLift[b] - startle * 9, 9, dt);
      A.browTilt[b] = approach(A.browTilt[b], bTilt[b], 9, dt);
      var s2 = b ? 1 : -1, bx = s2 * 30 + A.gaze.x * 0.3, by = -32 + A.brow[b];
      var inner = by + A.browTilt[b] * 0.5, outer = by - A.browTilt[b] * 0.5;
      F.brows[b].setAttribute('d', 'M' + (bx - s2 * 11).toFixed(1) + ' ' + inner.toFixed(1) + ' Q' + bx.toFixed(1) + ' ' + (by - 4).toFixed(1)
        + ' ' + (bx + s2 * 11).toFixed(1) + ' ' + outer.toFixed(1));
    }

    /* Bouche : un contour fermé ; fermée, c'est un trait souriant, ouverte, une voyelle. */
    var mx = m === 'think' ? 7 : 0, my = 30;
    var o = A.open + startle * 0.35;
    var w = 17 * A.wide * (1 - A.round * 0.35);
    var smile = A.smile * (1 - o * 0.7);
    var k = 0.75 - A.round * 0.35;
    var cy = my - smile * 0.6;
    var top = my + smile * 0.5 - o * 4 - A.round * o * 4;
    var bot = my + smile * 0.5 + 2 + o * 30 + A.round * o * 4;
    var dM = 'M' + (mx - w).toFixed(1) + ' ' + cy.toFixed(1)
      + ' C' + (mx - w * k).toFixed(1) + ' ' + top.toFixed(1) + ' ' + (mx + w * k).toFixed(1) + ' ' + top.toFixed(1) + ' ' + (mx + w).toFixed(1) + ' ' + cy.toFixed(1)
      + ' C' + (mx + w * k).toFixed(1) + ' ' + bot.toFixed(1) + ' ' + (mx - w * k).toFixed(1) + ' ' + bot.toFixed(1) + ' ' + (mx - w).toFixed(1) + ' ' + cy.toFixed(1) + 'Z';
    F.mouth.setAttribute('d', dM);
    var tg = o > 0.25 ? (o - 0.25) : 0;
    F.tongue.setAttribute('d', tg ? 'M' + (mx - w * 0.45).toFixed(1) + ' ' + (bot - 4 - tg * 3).toFixed(1) + ' Q' + mx.toFixed(1) + ' ' + (bot - 12 * tg - 6).toFixed(1)
      + ' ' + (mx + w * 0.45).toFixed(1) + ' ' + (bot - 4 - tg * 3).toFixed(1) + ' Q' + mx.toFixed(1) + ' ' + (bot + 1).toFixed(1) + ' ' + (mx - w * 0.45).toFixed(1) + ' ' + (bot - 4 - tg * 3).toFixed(1) + 'Z' : '');

    /* Trois points (réflexion), loupe (recherche). */
    A.dots = approach(A.dots, m === 'think' ? 1 : 0, 8, dt);
    F.dots.style.opacity = A.dots.toFixed(3);
    for (var di = 0; di < F.dotList.length; di++) {
      var ph = Math.sin(t * 5 - di * 0.9);
      F.dotList[di].setAttribute('transform', 'translate(0 ' + (ph > 0 ? -ph * 5 : 0).toFixed(2) + ')');
    }
    A.lens = approach(A.lens, m === 'search' ? 1 : 0, 8, dt);
    F.lens.style.opacity = A.lens.toFixed(3);
    F.lens.setAttribute('transform', 'translate(' + (84 + Math.cos(t * 2.4) * 8).toFixed(1) + ' ' + (-74 + Math.sin(t * 4.8) * 4).toFixed(1) + ') rotate(' + (Math.sin(t * 2.4) * 10).toFixed(1) + ')');

    /* Anneau : il respire avec la voix de qui parle. */
    var ringE = m === 'speak' ? A.amp : (m === 'user' ? lvl : 0);
    A.ring = approach(A.ring, ringE, 14, dt);
    var r = 118 + A.ring * 9 + (m === 'listen' ? breath * 1.5 : 0);
    F.ring.setAttribute('r', r.toFixed(2));
    F.ring.style.strokeWidth = (4 + A.ring * 7).toFixed(2);
    F.ring.style.strokeDashoffset = m === 'think' || m === 'search' ? (-t * 60).toFixed(1) : '0';

    if (V.drawer === 'settings') drawMeter();
  }

  /* Vumètre des réglages : niveau du micro et seuil de déclenchement, sur -80 … -10 dB. */
  function drawMeter() {
    var lv = q('.vc-meter-level'), th = q('.vc-meter-thr');
    if (!lv || !th) return;
    function pos(db) { return clamp((db + 80) / 70, 0, 1); }
    lv.style.transform = 'scaleX(' + pos(V.micDb).toFixed(3) + ')';
    lv.classList.toggle('hot', V.micDb > V.threshold && !V.muted);
    th.style.left = (pos(V.threshold) * 100).toFixed(1) + '%';
  }

  /* ══ Clavier, focus, actions ══════════════════════════════════════════ */

  function typing(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }

  function toggleMute() {
    V.muted = !V.muted;
    if (V.muted) {
      abortSegment();
      if (V.phase === 'user') setPhase(V.parts.length ? 'transcribing' : 'listening');
    }
    renderStatus(); renderControls();
  }

  function hush() {
    if (interrupt(true)) setPhase('listening');
  }

  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'KeyC' || e.key === 'C' || e.key === 'c')) {
      e.preventDefault(); e.stopPropagation();
      if (V.open) closeVoice(); else app.onReady(openVoice);
      return;
    }
    if (!V.open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeVoice(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey || typing(e.target)) return;
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); e.stopPropagation(); toggleMute(); return; }
    if ((e.key === ' ' || e.code === 'Space') && (V.reply || e.target === document.body || !e.target.closest('button'))) {
      e.preventDefault(); e.stopPropagation(); hush();
    }
  }, true);

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
      checkWhisper(false);
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
    'voice-download': downloadWhisper,
    'voice-mic-retry': function () { stopAudio(); startAudio(); }
  });

  bridge.on('voice', onVoice);
  bridge.on('whisper', onWhisper);

  /* Exposé pour le débogage et les essais. */
  window.__organizatorVoice = {
    state: V, open: openVoice, close: closeVoice, interrupt: interrupt, isJunk: isJunk, thresholdDb: thresholdDb, feed: onFrame
  };
})();
