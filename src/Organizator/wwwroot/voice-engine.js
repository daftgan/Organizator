/* ═══════════════════════════════════════════════════════════════════════════
   Organizator — moteur de conversation vocale réutilisable (window.OrganizatorVoice)
   Micro ouvert en continu, fin de phrase détectée dans la page (VAD), Whisper sur le poste
   (transcription spéculative), conversation Claude de l'hôte (`voiceStart` / `voiceSay`, évènement
   `voice` phrase par phrase, phase `meta` du mode tutor), synthèse de chaque phrase (Kokoro `speak`
   → SAPI `voiceSpeak` → speechSynthesis), lecture WebAudio (donc retirée du micro par l'annulation
   d'écho, et analysée pour la bouche de l'avatar), barge-in avec ce qui a été réellement entendu.
   Aucun raccourci clavier, aucun réglage de l'application : tout passe par les options.

     var eng = OrganizatorVoice.create({
       container, avatar: { size } | false, language, whisperModel, sensitivity, keepAudio, detail,
       tts: { kokoroVoice, accent, speed, sapiVoice, sapiRate },
       conversation: { start: { …voiceStart }, greeting } | null,   (null : micro + Whisper seulement)
       texts: { noiseResume },
       onUserUtterance(text, info) → false pour ne pas envoyer, onSentence(text, { turn, index, replay? }),
       onReply({ turn, sentences, full }), onMeta(meta, { turn }), onReplyDone({ turn, full, heard }),
       onInterrupt({ turn, heard }), onPhase(phase, { text }), onNotice(notice | null, { kind }), onError(err)
     });
     eng.start() eng.stop() eng.destroy() eng.mute(b) eng.muted() eng.interrupt() eng.send(text, { hidden })
     eng.replay(text) eng.state() eng.setOptions(partial)
     En plus : eng.element (l'avatar monté), eng.downloadWhisper(), eng.feed(Float32Array) (essais).
     OrganizatorVoice.isJunk(text), .whisper() (dernier état Whisper connu), .tts() (dernier état Kokoro),
     .active() (le moteur démarré, s'il y en a un).
   Un seul AudioContext pour toute la page ; un seul moteur actif : en créer ou en démarrer un autre
   arrête le premier (qui passe en phase `idle`).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  if (!window.bridge) return;
  var bridge = window.bridge;

  /* ══ Constantes ═══════════════════════════════════════════════════════ */

  /* Détection de parole : trames de 20 ms. Pendant que l'avatar parle, le seuil monte de
     PLAY_BOOST_DB et il faut parler plus longtemps : l'écho résiduel ne doit pas le couper. */
  var FRAME_MS = 20;
  var ONSET_MS = 160, ONSET_PLAY_MS = 250, PLAY_BOOST_DB = 6;
  var PREROLL_MS = 300, SPEC_MS = 300, END_MS = 650, MIN_MS = 300, MAX_MS = 30000;
  var RESUME_MS = 80;
  var REST_MS = 1500;

  /* Ce que Whisper « entend » dans le silence ou le bruit : génériques de vidéos, didascalies. */
  var JUNK = [
    /sous-?titr/i, /merci d.avoir regard/i, /merci de (votre|nous avoir) (attention|regard)/i, /abonnez-?vous/i,
    /amara\.org/i, /thank(s| you) for watching/i, /^\s*[\[(♪*].*[\])♪*]\s*$/, /^\W*(musique|music|applaudissements|rires|silence)\W*$/i,
    /^[\s.…,!?-]*$/
  ];

  var TEXTS = {
    fr: { noiseResume: '(Ce n’était qu’un bruit, personne n’a parlé : reprends naturellement là où tu t’étais arrêté, sans te répéter.)' },
    en: { noiseResume: '(That was only a noise, nobody spoke: carry on naturally from where you stopped, without repeating yourself.)' }
  };

  var DEFAULTS = {
    container: null, avatar: {}, language: 'fr', whisperModel: 'base', sensitivity: 50, keepAudio: false, detail: false,
    tts: { kokoroVoice: '', accent: '', speed: 1, sapiVoice: '', sapiRate: 0 },
    conversation: null, texts: {}
  };

  /* ══ Utilitaires ══════════════════════════════════════════════════════ */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function noop() { /* rien */ }
  function msgOf(e) { return (e && e.message) || String(e || 'erreur inconnue'); }

  function isJunk(text) {
    var t = String(text || '').trim();
    if (t.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return true;
    return JUNK.some(function (re) { return re.test(t); });
  }

  function fmtSize(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' Ko';
    return Math.round(bytes / 1048576) + ' Mo';
  }

  function micError(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'accès refusé (Paramètres Windows › Confidentialité › Microphone).';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'aucun micro trouvé.';
    if (n === 'NotReadableError') return 'le micro est déjà pris par une autre application.';
    return msgOf(e);
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

  /* Plusieurs segments pour un même énoncé (pause longue au milieu) : une seule réponse Whisper,
     mots recalés dans le temps, débits recalculés ; les réponses d'origine restent dans `parts`. */
  function mergeStt(list) {
    if (list.length === 1) return list[0].r;
    var out = Object.assign({}, list[0].r);
    var offset = 0, words = [], speech = 0, dur = 0, artW = 0, hasWords = false;
    out.text = list.map(function (g) { return g.text; }).join(' ');
    list.forEach(function (g) {
      var r = g.r || {};
      var d = Number(r.duration) || g.seconds || 0;
      if (Array.isArray(r.words)) {
        hasWords = true;
        r.words.forEach(function (w) { words.push(Object.assign({}, w, { start: (Number(w.start) || 0) + offset, end: (Number(w.end) || 0) + offset })); });
      }
      var sp = Number(r.speechSeconds) || 0;
      speech += sp;
      if (r.articulationWpm) artW += r.articulationWpm * sp;
      offset += d; dur += d;
    });
    if (hasWords) out.words = words;
    out.duration = dur;
    if (speech) {
      out.speechSeconds = Math.round(speech * 100) / 100;
      if (hasWords) out.wpm = Math.round(words.length / speech * 60);
      if (artW) out.articulationWpm = Math.round(artW / speech);
    }
    out.parts = list.map(function (g) { return g.r; });
    return out;
  }

  /* ══ Son partagé ══════════════════════════════════════════════════════ */

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

  /* Un seul contexte pour toute la vie de la page : suspendu, il ne consomme rien. */
  var AUD = { ctx: null, outGain: null, outAnalyser: null, sink: null, timeBuf: null, freqBuf: null, workletReady: null };

  function ensureContext() {
    if (AUD.ctx) return AUD.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = AUD.ctx = new AC();
    AUD.outGain = ctx.createGain();
    AUD.outAnalyser = ctx.createAnalyser();
    AUD.outAnalyser.fftSize = 1024;
    AUD.outAnalyser.smoothingTimeConstant = 0.5;
    AUD.outGain.connect(AUD.outAnalyser);
    AUD.outAnalyser.connect(ctx.destination);
    AUD.timeBuf = new Float32Array(AUD.outAnalyser.fftSize);
    AUD.freqBuf = new Uint8Array(AUD.outAnalyser.frequencyBinCount);
    AUD.sink = ctx.createGain();
    AUD.sink.gain.value = 0;
    AUD.sink.connect(ctx.destination);
    if (ctx.audioWorklet && window.Blob && window.URL) {
      var url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      AUD.workletReady = ctx.audioWorklet.addModule(url).then(function () { URL.revokeObjectURL(url); return true; },
        function (e) { console.warn('[voice] AudioWorklet indisponible, ScriptProcessor en secours', e); return false; });
    } else {
      AUD.workletReady = Promise.resolve(false);
    }
    return ctx;
  }

  function resumeContext() {
    var ctx = ensureContext();
    if (ctx.state !== 'running') ctx.resume()['catch'](noop);
    return ctx;
  }

  /* ══ États partagés : Whisper et Kokoro ═══════════════════════════════ */

  var WH = { status: null, loading: null, dl: null };
  var TT = { status: null, loading: null };

  function whisperStatus(force) {
    if (WH.loading) return WH.loading;
    if (WH.status && !force) return Promise.resolve(WH.status);
    WH.loading = bridge.call('whisperStatus', {}, 15000).then(function (st) {
      WH.loading = null;
      if (st && st.models) WH.status = st;
      return WH.status;
    }, function () { WH.loading = null; return WH.status; });
    return WH.loading;
  }

  function ttsStatus(force) {
    if (TT.loading) return TT.loading;
    if (TT.status && !force) return Promise.resolve(TT.status);
    TT.loading = bridge.call('ttsStatus', {}, 15000).then(function (st) {
      TT.loading = null; TT.status = st || null; return TT.status;
    }, function () { TT.loading = null; TT.status = null; return null; });
    return TT.loading;
  }

  var active = null;

  /* ══ Avatar : dessin ══════════════════════════════════════════════════ */

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

  /* Amplitude et timbre de ce que joue l'avatar : l'ouverture suit l'énergie, la forme suit le
     spectre (graves : bouche ronde, aigus : bouche étirée). */
  function voiceShape(pl) {
    if (!pl) return { amp: 0, low: 0, high: 0 };
    if (pl.fallback) {
      var t = performance.now() / 1000;
      return { amp: 0.25 + 0.35 * Math.abs(Math.sin(t * 9.3) * Math.sin(t * 3.1 + 1)), low: 0.4, high: 0.3 };
    }
    var a = AUD.outAnalyser;
    a.getFloatTimeDomainData(AUD.timeBuf);
    var sum = 0, i;
    for (i = 0; i < AUD.timeBuf.length; i++) sum += AUD.timeBuf[i] * AUD.timeBuf[i];
    var rms = Math.sqrt(sum / AUD.timeBuf.length);
    a.getByteFrequencyData(AUD.freqBuf);
    var hz = AUD.ctx.sampleRate / a.fftSize;
    function band(f0, f1) {
      var s = 0, n = 0;
      for (var b = Math.floor(f0 / hz); b <= Math.ceil(f1 / hz) && b < AUD.freqBuf.length; b++) { s += AUD.freqBuf[b]; n++; }
      return n ? s / n / 255 : 0;
    }
    var low = band(150, 700), mid = band(700, 2000), high = band(2000, 6000);
    var tot = low + mid + high + 1e-6;
    return { amp: clamp(rms * 5, 0, 1), low: low / tot, high: high / tot };
  }

  /* Une image : m = humeur (speak | search | think | rest | user | listen), lvl = niveau du micro. */
  function drawFace(F, A, now, m, sh, lvl) {
    var dt = Math.min(0.1, (now - A.last) / 1000);
    A.last = now; A.t += dt;
    var t = A.t;

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
  }

  /* ══ Moteur ═══════════════════════════════════════════════════════════ */

  function mergeOpts(base, patch) {
    var out = Object.assign({}, base);
    Object.keys(patch || {}).forEach(function (k) {
      var v = patch[k];
      if ((k === 'tts' || k === 'texts') && v && typeof v === 'object') out[k] = Object.assign({}, base[k] || {}, v);
      else out[k] = v;
    });
    return out;
  }

  function create(options) {
    if (active) active._stopFromOther();

    var E = {
      opts: mergeOpts(DEFAULTS, options || {}),
      destroyed: false, started: false,
      phase: 'idle', phaseText: '', reported: '', reportedText: '', muted: false,
      conv: null, startSeq: 0,
      /* Réponse en cours : { turn, sentences, played, done, full } ; la file des phrases à dire. */
      reply: null, queue: [], playing: null, minTurn: 0, maxTurn: 0, ignoreTurns: {},
      pendingHeard: null, bargedIn: false,
      /* Énoncé en cours d'assemblage : transcriptions des segments pas encore envoyés. */
      parts: [],
      stream: null, source: null, vadNode: null,
      vad: null, micDb: -100, micLevel: 0, threshold: -50,
      ttsJobs: {}, kokoroFails: 0, warned: {},
      wrap: null, face: null, anim: null, raf: 0, restUntil: 0,
      notices: {},
      offs: []
    };
    var api = {};

    /* ·· Rappels ·· */

    function cb(name) {
      var fn = E.opts[name];
      if (typeof fn !== 'function') return undefined;
      try { return fn.apply(api, Array.prototype.slice.call(arguments, 1)); } catch (e) { console.error('[voice] ' + name, e); return undefined; }
    }

    function warnOnce(key, e) {
      if (E.warned[key]) return;
      E.warned[key] = true;
      console.warn('[voice] ' + key, e);
    }

    function texts() {
      var lang = String(E.opts.language || 'fr').slice(0, 2) === 'en' ? 'en' : 'fr';
      return Object.assign({}, TEXTS[lang], E.opts.texts || {});
    }

    /* ·· Phases ·· */

    function effectivePhase() {
      if (!E.started) return 'idle';
      if (E.muted && (E.phase === 'listening' || E.phase === 'user')) return 'muted';
      return E.phase;
    }

    function setPhase(phase, text) {
      E.phase = phase;
      E.phaseText = text || '';
      if (E.wrap) {
        E.wrap.setAttribute('data-phase', E.started ? phase : 'idle');
        E.wrap.classList.toggle('is-muted', E.muted);
      }
      var eff = effectivePhase();
      if (eff === E.reported && E.phaseText === E.reportedText) return;
      E.reported = eff; E.reportedText = E.phaseText;
      cb('onPhase', eff, { text: E.phaseText });
    }

    /* ·· Avis ·· */

    function notice(group, n) {
      if (!n && !E.notices[group]) return;
      E.notices[group] = n || null;
      if (n) { n.group = group; cb('onNotice', n, { kind: n.kind }); }
      else cb('onNotice', null, { kind: group });
    }

    /* ══ Conversation (hôte) ══════════════════════════════════════════════ */

    function startConversation() {
      var seq = ++E.startSeq;
      if (E.conv) {
        interrupt(false);
        var old = E.conv.id;
        bridge.call('voiceStop', { conversationId: old })['catch'](noop);
      }
      cancelQueue();
      E.conv = null; E.reply = null; E.pendingHeard = null; E.bargedIn = false;
      cancelParts();
      E.ignoreTurns = {}; E.minTurn = 0; E.maxTurn = 0;
      var c = E.opts.conversation;
      if (!c || !c.start) { setPhase('listening'); return Promise.resolve({ conversationId: null }); }
      setPhase('starting');
      return bridge.call('voiceStart', c.start, 60000).then(function (r) {
        if (seq !== E.startSeq || !E.started) {
          if (r && r.conversationId) bridge.call('voiceStop', { conversationId: r.conversationId })['catch'](noop);
          return { conversationId: null };
        }
        E.conv = { id: r.conversationId };
        notice('conversation', null);
        if (c.greeting) say(c.greeting, true)['catch'](noop);
        else setPhase('listening');
        return { conversationId: E.conv.id };
      }, function (e) {
        if (seq !== E.startSeq || !E.started) throw e;
        var msg = msgOf(e);
        setPhase('error', 'Conversation impossible : ' + msg);
        notice('conversation', { kind: 'conversation-failed', text: 'Conversation impossible : ' + msg, action: { label: 'Réessayer', run: function () { api.start(); } } });
        cb('onError', { kind: 'conversation', message: msg });
        throw e;
      });
    }

    /* Envoie ce que l'utilisateur a dit ; `hidden` : message de service (salut, reprise après un bruit). */
    function say(text, hidden) {
      if (!E.conv) {
        var err = new Error('la conversation n’a pas démarré.');
        if (E.phase !== 'error') setPhase('listening');
        cb('onError', { kind: 'reply', message: err.message });
        return Promise.reject(err);
      }
      var payload = { conversationId: E.conv.id, text: text };
      if (E.pendingHeard != null) payload.heard = E.pendingHeard;
      E.pendingHeard = null;
      var reply = E.reply = { turn: null, sentences: [], played: 0, done: false, full: '', hidden: !!hidden };
      setPhase('thinking');
      return bridge.call('voiceSay', payload, 30000).then(function (r) {
        var turn = r && r.turn;
        if (turn != null) E.maxTurn = Math.max(E.maxTurn, turn);
        if (E.reply === reply) { if (reply.turn == null) reply.turn = turn; }
        else if (turn != null) E.ignoreTurns[turn] = 1;
        return { turn: turn };
      }, function (e) {
        if (E.reply === reply) { E.reply = null; failReply(msgOf(e)); }
        throw e;
      });
    }

    function failReply(msg) {
      setPhase('listening');
      cb('onError', { kind: 'reply', message: msg });
    }

    function onVoice(p) {
      p = p || {};
      if (!E.started || !E.conv || p.conversationId !== E.conv.id) return;
      var turn = p.turn;
      if (turn != null) E.maxTurn = Math.max(E.maxTurn, turn);
      if (turn != null && (E.ignoreTurns[turn] || turn < E.minTurn)) return;
      var reply = E.reply;
      if (!reply || reply.done) return;
      if (reply.turn == null && turn != null) reply.turn = turn;
      else if (turn != null && reply.turn !== turn) return;

      if (p.phase === 'thinking') {
        if (!E.playing) setPhase('thinking');
      } else if (p.phase === 'tool') {
        if (!E.playing) setPhase('tool', p.text || '');
      } else if (p.phase === 'sentence') {
        var text = String(p.text || '').trim();
        if (!text) return;
        reply.sentences.push(text);
        reply.full = p.full ? String(p.full) : reply.sentences.join(' ');
        cb('onReply', { turn: reply.turn, sentences: reply.sentences.slice(), full: reply.full });
        enqueue({ text: text, turn: reply.turn, index: reply.sentences.length - 1 });
      } else if (p.phase === 'meta') {
        reply.meta = p.meta || {};
        cb('onMeta', reply.meta, { turn: reply.turn });
      } else if (p.phase === 'done') {
        reply.done = true;
        if (p.full) reply.full = String(p.full);
        pump();
      } else if (p.phase === 'error') {
        E.reply = null;
        stopPlayback(true); cancelQueue();
        failReply(p.error || 'la réponse a échoué.');
      }
    }

    /* Coupe la parole : silence en 80 ms, file vidée (synthèses Kokoro annulées), et l'hôte apprend
       ce qui a été réellement entendu (phrases jouées en entier, début de celle en cours au prorata). */
    function interrupt(startle) {
      var reply = E.reply;
      if (!reply) {
        if (E.playing && E.playing.replay) {
          stopPlayback(true); cancelQueue();
          if (startle && E.anim) E.anim.startleAt = performance.now();
          if (E.started && E.phase === 'speaking') setPhase('listening');
          return true;
        }
        return false;
      }
      var heard = heardOf(reply);
      stopPlayback(true);
      cancelQueue();
      if (reply.turn != null) { E.ignoreTurns[reply.turn] = 1; E.minTurn = Math.max(E.minTurn, reply.turn + 1); }
      else E.minTurn = Math.max(E.minTurn, E.maxTurn + 1);
      E.reply = null;
      if (E.conv) bridge.call('voiceInterrupt', { conversationId: E.conv.id, heard: heard })['catch'](noop);
      E.pendingHeard = heard;
      if (startle && E.anim) E.anim.startleAt = performance.now();
      if (E.phase !== 'user') setPhase('listening');
      cb('onInterrupt', { turn: reply.turn, heard: heard });
      cb('onReplyDone', { turn: reply.turn, full: reply.full || reply.sentences.join(' '), heard: heard });
      return true;
    }

    function heardOf(reply) {
      var parts = reply.sentences.slice(0, reply.played);
      var pl = E.playing;
      if (pl && pl.text && !pl.replay) {
        var frac = clamp(pl.elapsed() / Math.max(0.1, pl.dur), 0, 1);
        var words = pl.text.split(/\s+/);
        var n = Math.floor(words.length * frac);
        if (n > 0) parts.push(words.slice(0, n).join(' '));
      }
      return parts.join(' ');
    }

    /* ══ Synthèse et lecture ══════════════════════════════════════════════ */

    function enqueue(it) {
      it.state = 'wait'; it.buffer = null;
      E.queue.push(it);
      pump();
    }

    /* La phrase suivante se synthétise pendant que la précédente joue : deux d'avance au plus. */
    function pump() {
      if (E.destroyed) return;
      var ahead = 0, i, it;
      for (i = 0; i < E.queue.length; i++) if (E.queue[i].state === 'loading') ahead++;
      for (i = 0; i < E.queue.length && ahead < 2; i++) {
        it = E.queue[i];
        if (it.state === 'wait') { synth(it); ahead++; }
      }
      if (!E.playing && E.queue.length) {
        it = E.queue[0];
        if (it.state === 'ready') playItem(it);
        else if (it.state === 'failed') playFallback(it);
      }
      if (!E.playing && !E.queue.length) {
        if (E.reply && E.reply.done) finishReply();
        else if (!E.reply && E.started && E.phase === 'speaking') setPhase('listening');
      }
    }

    function gone(it) { return it.cancelled || E.destroyed || E.queue.indexOf(it) < 0; }

    function useKokoro() {
      var t = E.opts.tts || {};
      return !!(t.kokoroVoice && TT.status && TT.status.ready && E.kokoroFails < 2);
    }

    function synth(it) {
      it.state = 'loading';
      (TT.loading || Promise.resolve()).then(function () {
        if (gone(it)) return null;
        if (!useKokoro()) return synthSapi(it);
        return synthKokoro(it).then(function (buf) { E.kokoroFails = 0; return buf; }, function (e) {
          if (gone(it)) throw e;
          E.kokoroFails++;
          warnOnce('kokoro', e);
          return synthSapi(it);
        });
      }).then(function (buf) {
        if (!buf || gone(it)) return;
        it.buffer = buf; it.state = 'ready';
        pump();
      }, function (e) {
        if (gone(it)) return;
        warnOnce('voiceSpeak', e);
        it.state = 'failed';
        pump();
      });
    }

    function fetchDecode(url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('son introuvable (' + r.status + ')');
        return r.arrayBuffer();
      }).then(function (ab) { return ensureContext().decodeAudioData(ab); });
    }

    function concatBuffers(list) {
      if (list.length === 1) return list[0];
      var ctx = ensureContext(), len = 0, ch = 1;
      list.forEach(function (b) { len += b.length; ch = Math.max(ch, b.numberOfChannels); });
      var out = ctx.createBuffer(ch, len, list[0].sampleRate);
      for (var c = 0; c < ch; c++) {
        var data = out.getChannelData(c), o = 0;
        list.forEach(function (b) { data.set(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), o); o += b.length; });
      }
      return out;
    }

    /* Kokoro : l'hôte peut redécouper la phrase ; chaque morceau est chargé dès qu'il est annoncé
       (évènement tts), puis tout est mis bout à bout. */
    function synthKokoro(it) {
      var t = E.opts.tts || {};
      var job = it.job = uid('vt');
      it.decodes = {};
      E.ttsJobs[job] = it;
      return bridge.call('speak', { job: job, text: it.text, voice: t.kokoroVoice, speed: clamp(Number(t.speed) || 1, 0.7, 1.3) }, 60000).then(function (r) {
        delete E.ttsJobs[job]; it.job = null;
        if (gone(it)) return null;
        ((r && r.sentences) || []).forEach(function (s) { addDecode(it, s.index, s.url); });
        var keys = Object.keys(it.decodes).map(Number).sort(function (a, b) { return a - b; });
        if (!keys.length) throw new Error('Kokoro n’a rendu aucun son.');
        return Promise.all(keys.map(function (k) { return it.decodes[k]; })).then(concatBuffers);
      }, function (e) {
        delete E.ttsJobs[job]; it.job = null;
        throw e;
      });
    }

    function addDecode(it, index, url) {
      index = Number(index) || 0;
      if (!url || it.decodes[index]) return;
      it.decodes[index] = fetchDecode(url);
      it.decodes[index]['catch'](noop);
    }

    function onTts(ev) {
      if (!ev || !ev.job) return;
      var it = E.ttsJobs[ev.job];
      if (!it || it.cancelled) return;
      if (ev.phase === 'sentence' && ev.url) addDecode(it, ev.index, ev.url);
    }

    function synthSapi(it) {
      var t = E.opts.tts || {};
      return bridge.call('voiceSpeak', { text: it.text, voice: String(t.sapiVoice || ''), rate: clamp(parseInt(t.sapiRate, 10) || 0, -10, 10) }, 30000)
        .then(function (r) {
          if (gone(it)) return null;
          return ensureContext().decodeAudioData(bytesOf(r && r.audio).buffer);
        });
    }

    /* Vide la file ; une synthèse Kokoro en cours est annulée côté hôte (une seule à la fois là-bas :
       sinon la suivante attendrait la fin de celle-ci). */
    function cancelQueue() {
      E.queue.forEach(function (it) {
        it.cancelled = true;
        if (it.resolve) it.resolve(false);
      });
      E.queue = [];
      Object.keys(E.ttsJobs).forEach(function (job) {
        E.ttsJobs[job].cancelled = true;
        bridge.call('cancelSpeak', { job: job }, 15000)['catch'](noop);
      });
      E.ttsJobs = {};
    }

    function playItem(it) {
      var ctx = resumeContext();
      var src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = it.buffer;
      src.connect(g); g.connect(AUD.outGain);
      var t0 = ctx.currentTime;
      var pl = E.playing = {
        text: it.text, item: it, replay: !!it.replay, src: src, gain: g, dur: it.buffer.duration,
        elapsed: function () { return ctx.currentTime - t0; }
      };
      src.onended = function () { if (E.playing === pl) sentenceDone(); };
      src.start();
      showSentence(it);
    }

    /* Aucune synthèse de l'hôte : speechSynthesis, en dernier recours (son hors annulation d'écho,
       d'où le seuil de détection plus exigeant pendant qu'il joue — voir PLAY_BOOST_DB). */
    function playFallback(it) {
      var ss = window.speechSynthesis;
      var t0 = performance.now(), est = Math.max(0.8, it.text.length * 0.065);
      var pl = E.playing = {
        text: it.text, item: it, replay: !!it.replay, fallback: true, dur: est,
        elapsed: function () { return (performance.now() - t0) / 1000; }
      };
      showSentence(it);
      if (!ss || typeof SpeechSynthesisUtterance === 'undefined') {
        pl.timer = setTimeout(function () { if (E.playing === pl) sentenceDone(); }, est * 1000);
        return;
      }
      var u = new SpeechSynthesisUtterance(it.text);
      var t = E.opts.tts || {};
      var lang = String(E.opts.language || 'fr').slice(0, 2);
      u.lang = lang === 'en' ? (t.accent || 'en-US') : (lang === 'fr' ? 'fr-FR' : lang);
      var voice = ss.getVoices().filter(function (v) { return String(v.lang).toLowerCase().indexOf(u.lang.toLowerCase()) === 0; })[0]
        || ss.getVoices().filter(function (v) { return String(v.lang).toLowerCase().indexOf(lang) === 0; })[0];
      if (voice) u.voice = voice;
      u.rate = clamp((Number(t.speed) || 1) * (1 + (parseInt(t.sapiRate, 10) || 0) * 0.06), 0.5, 2);
      u.onend = function () { if (E.playing === pl) sentenceDone(); };
      /* Pas de voix du tout (synthèse refusée d'emblée) : le sous-titre reste le temps de la lire. */
      u.onerror = function () {
        if (E.playing !== pl) return;
        var left = est - pl.elapsed();
        if (left > 0.3) pl.timer = setTimeout(function () { if (E.playing === pl) sentenceDone(); }, left * 1000);
        else sentenceDone();
      };
      pl.utter = u;
      ss.speak(u);
    }

    function sentenceDone() {
      E.playing = null;
      var it = E.queue.shift();
      if (it && !it.replay && E.reply) E.reply.played++;
      if (it && it.resolve) it.resolve(true);
      pump();
    }

    function showSentence(it) {
      if (E.started && E.phase !== 'user') setPhase('speaking');
      kick();
      if (it.replay) cb('onSentence', it.text, { turn: null, index: 0, replay: true });
      else cb('onSentence', it.text, { turn: it.turn, index: it.index });
    }

    function finishReply() {
      var reply = E.reply;
      E.reply = null;
      if (E.phase !== 'user' && E.phase !== 'transcribing') setPhase('listening');
      cb('onReplyDone', { turn: reply.turn, full: reply.full || reply.sentences.join(' '), heard: null });
    }

    /* Fondu de 80 ms plutôt qu'une coupure sèche (pas de clic). */
    function stopPlayback(fade) {
      var pl = E.playing;
      E.playing = null;
      if (!pl) return;
      if (pl.fallback) {
        clearTimeout(pl.timer);
        try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* rien à couper */ }
        return;
      }
      try {
        var now = AUD.ctx.currentTime;
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

    function startAudio() {
      var ctx;
      try { ctx = resumeContext(); } catch (e) {
        notice('mic', { kind: 'audio-unavailable', text: 'Son indisponible dans cette fenêtre : ' + msgOf(e) });
        return;
      }
      resetVad();
      var md = navigator.mediaDevices;
      if (!md || !md.getUserMedia) {
        notice('mic', { kind: 'mic-unavailable', text: 'Pas d’accès au micro dans cette fenêtre : la conversation ne peut pas vous entendre.' });
        return;
      }
      md.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .then(function (stream) {
          if (!E.started || E.destroyed || E.stream) { stream.getTracks().forEach(function (t) { t.stop(); }); return null; }
          E.stream = stream;
          return AUD.workletReady.then(function (ok) {
            if (!E.started || E.stream !== stream) return;
            E.source = ctx.createMediaStreamSource(stream);
            if (ok) {
              E.vadNode = new AudioWorkletNode(ctx, 'organizator-vad', {
                numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
                processorOptions: { size: Math.round(ctx.sampleRate * FRAME_MS / 1000) }
              });
              E.vadNode.port.onmessage = function (ev) { onFrame(ev.data); };
            } else {
              E.vadNode = ctx.createScriptProcessor(1024, 1, 1);
              E.vadNode.onaudioprocess = function (ev) { onFrame(new Float32Array(ev.inputBuffer.getChannelData(0))); };
            }
            E.source.connect(E.vadNode);
            E.vadNode.connect(AUD.sink);
            notice('mic', null);
          });
        })['catch'](function (e) {
          if (!E.started) return;
          var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
          notice('mic', { kind: denied ? 'mic-denied' : 'mic-unavailable', text: 'Micro indisponible : ' + micError(e),
            action: { label: 'Réessayer', run: retryMic } });
          cb('onError', { kind: 'mic', message: micError(e) });
        });
    }

    function retryMic() { stopAudio(true); if (E.started) startAudio(); }

    function stopAudio(keepContext) {
      if (E.vadNode) {
        try { E.vadNode.disconnect(); } catch (e) { /* déjà débranché */ }
        if (E.vadNode.port) E.vadNode.port.onmessage = null;
        E.vadNode.onaudioprocess = null;
        E.vadNode = null;
      }
      if (E.source) { try { E.source.disconnect(); } catch (e) { /* déjà débranché */ } E.source = null; }
      if (E.stream) { E.stream.getTracks().forEach(function (t) { t.stop(); }); E.stream = null; }
      if (keepContext) return;
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* rien */ }
      if (AUD.ctx && AUD.ctx.state === 'running' && (!active || active === api)) AUD.ctx.suspend()['catch'](noop);
    }

    function resetVad() {
      E.vad = { floor: -65, above: 0, preroll: [], inSpeech: false, seg: null };
      E.micDb = -100; E.micLevel = 0;
    }

    /* Seuil = plancher de bruit + marge (la sensibilité la réduit), jamais sous un plancher absolu. */
    function thresholdDb(playing) {
      var sens = clamp(E.opts.sensitivity == null ? 50 : Number(E.opts.sensitivity) || 0, 0, 100);
      var margin = 18 - sens * 0.12;
      var t = Math.max(E.vad.floor + margin, -58 + (50 - sens) * 0.2);
      return playing ? t + PLAY_BOOST_DB : t;
    }

    function onFrame(buf) {
      if (!E.started || !E.vad || !buf || !buf.length) return;
      var rate = AUD.ctx.sampleRate;
      var ms = buf.length / rate * 1000;
      var sum = 0;
      for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      var db = 10 * Math.log10(sum / buf.length + 1e-12);
      var vad = E.vad;
      var playing = !!E.playing;
      var thr = thresholdDb(playing);
      E.micDb = db; E.threshold = thr;

      if (E.muted) { E.micLevel = 0; return; }
      E.micLevel = clamp((db - vad.floor) / 30, 0, 1);

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
        if (vad.above >= (playing || E.reply ? ONSET_PLAY_MS : ONSET_MS)) speechStart(ms);
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
      var vad = E.vad;
      var pre = Math.ceil(PREROLL_MS / ms) + Math.ceil(vad.above / ms);
      var frames = vad.preroll.slice(-pre);
      vad.preroll = [];
      vad.above = 0;
      vad.inSpeech = true;
      vad.seg = { frames: frames, ms: frames.length * ms, voiced: 0, run: 0, silence: 0, spec: null };
      /* Barge-in : l'utilisateur parle pendant que l'avatar parle ou réfléchit. */
      var hadReply = !!E.reply;
      if (interrupt(true) && hadReply) E.bargedIn = true;
      setPhase('user');
    }

    function noiseResume() {
      E.bargedIn = false;
      if (E.conv) say(texts().noiseResume, true)['catch'](noop);
    }

    function speechEnd() {
      var vad = E.vad, seg = vad.seg;
      vad.inSpeech = false; vad.seg = null; vad.above = 0;
      if (!seg) return;
      if (seg.voiced < MIN_MS) {
        cancelSpec(seg);
        /* Un bruit (toux, porte, écho) a coupé l'avatar sans que personne ne parle : il reprend. */
        if (!E.parts.length && E.bargedIn && E.pendingHeard != null && !E.reply) { noiseResume(); return; }
        if (!E.parts.length && !E.reply) setPhase('listening');
        else if (E.parts.length) setPhase('transcribing');
        flushParts();
        return;
      }
      var t;
      if (seg.spec && !seg.spec.cancelled) t = seg.spec;
      else t = transcribe(seg.frames);
      t.seconds = seg.ms / 1000;
      E.parts.push(t);
      setPhase('transcribing');
      if (E.anim) E.anim.nodAt = performance.now();
      flushParts();
    }

    function abortSegment() {
      if (!E.vad) return;
      if (E.vad.seg) cancelSpec(E.vad.seg);
      E.vad.inSpeech = false; E.vad.seg = null; E.vad.above = 0; E.vad.preroll = [];
    }

    function cancelParts() {
      E.parts.forEach(function (t) {
        if (t.cancelled) return;
        t.cancelled = true;
        bridge.call('cancelTranscribe', { job: t.job })['catch'](noop);
      });
      E.parts = [];
    }

    /* Transcription spéculative : lancée dès 300 ms de silence, gardée si la phrase est bien finie,
       abandonnée si la parole reprend. */
    function launchSpec(seg) { seg.spec = transcribe(seg.frames.slice()); }

    function cancelSpec(seg) {
      var sp = seg.spec;
      if (!sp) return;
      seg.spec = null;
      sp.cancelled = true;
      bridge.call('cancelTranscribe', { job: sp.job })['catch'](noop);
    }

    function transcribe(frames) {
      var job = uid('vj');
      var t = { job: job, cancelled: false, promise: null, seconds: 0 };
      if (!whisperReady()) {
        t.promise = Promise.resolve(null);
        var n = E.notices.whisper;
        if (n) cb('onNotice', Object.assign({}, n, { flash: true }), { kind: n.kind });
        return t;
      }
      var o = E.opts;
      t.promise = segmentWav(frames, AUD.ctx.sampleRate).then(function (data) {
        if (t.cancelled) return null;
        var p = { job: job, data: data, model: o.whisperModel || 'base', language: o.language || 'fr' };
        if (o.detail) p.detail = true;
        if (o.keepAudio) p.keep = true;
        return bridge.call('transcribe', p, 120000);
      }).then(function (r) { return r || null; })['catch'](function (e) {
        if (!t.cancelled && E.started) cb('onError', { kind: 'transcribe', message: msgOf(e) });
        return null;
      });
      return t;
    }

    /* L'énoncé part quand l'utilisateur s'est tu et que toutes ses transcriptions sont rendues. */
    function flushParts() {
      if (!E.parts.length) return;
      var parts = E.parts.slice();
      Promise.all(parts.map(function (t) { return t.promise; })).then(function (results) {
        if (!E.started || E.parts.length !== parts.length || E.parts[0] !== parts[0] || (E.vad && E.vad.inSpeech)) return;
        E.parts = [];
        var good = [];
        results.forEach(function (r, i) {
          var txt = r && String(r.text || '').trim();
          if (txt && !isJunk(txt)) good.push({ r: r, text: txt, seconds: parts[i].seconds });
        });
        var text = good.map(function (g) { return g.text; }).join(' ').replace(/\s+/g, ' ').trim();
        var barged = E.bargedIn;
        E.bargedIn = false;
        if (!text) {
          if (E.phase === 'transcribing') setPhase('listening');
          if (barged && E.pendingHeard != null && !E.reply) noiseResume();
          return;
        }
        if (E.reply) interrupt(false);
        var stt = mergeStt(good);
        var urls = good.map(function (g) { return g.r && g.r.url; }).filter(Boolean);
        var info = {
          seconds: Math.round(parts.reduce(function (s, t) { return s + (t.seconds || 0); }, 0) * 100) / 100,
          stt: stt, url: urls[0] || '', urls: urls, bargedIn: !!barged, heard: E.pendingHeard
        };
        if (cb('onUserUtterance', text, info) === false) {
          if (E.phase === 'transcribing') setPhase('listening');
          return;
        }
        say(text, false)['catch'](noop);
      });
    }

    /* ══ Whisper ══════════════════════════════════════════════════════════ */

    function whisperModelInfo() {
      var st = WH.status, id = E.opts.whisperModel || 'base';
      return st && st.models ? (st.models.filter(function (m) { return m.id === id; })[0] || null) : null;
    }

    function whisperReady() {
      var m = whisperModelInfo();
      return !!(m && m.downloaded);
    }

    function checkWhisper(warm) {
      if (!E.started) return;
      var m = whisperModelInfo();
      if (!WH.status) {
        notice('whisper', { kind: 'whisper-unavailable', text: 'Transcription indisponible dans cette fenêtre : la conversation ne peut pas vous entendre.' });
        return;
      }
      if (!m) {
        notice('whisper', { kind: 'whisper-unknown', text: 'Modèle Whisper « ' + (E.opts.whisperModel || 'base') + ' » inconnu.', model: E.opts.whisperModel });
        return;
      }
      if (!m.downloaded) {
        var dl = WH.dl && WH.dl.model === m.id ? WH.dl : null;
        notice('whisper', {
          kind: 'whisper-missing', model: m.id, size: m.size || 0,
          text: 'Pour vous entendre, la conversation a besoin du modèle Whisper « ' + m.label + ' » (' + fmtSize(m.size) + '), pas encore téléchargé sur ce poste.',
          action: dl ? null : { label: 'Télécharger', run: downloadWhisper },
          progress: dl ? (dl.total ? Math.floor(100 * dl.received / dl.total) : 0) : -1
        });
        return;
      }
      notice('whisper', null);
      if (warm) bridge.call('whisperWarm', { model: m.id })['catch'](noop);
    }

    function downloadWhisper() {
      var m = whisperModelInfo();
      if (!m) return Promise.resolve(WH.status);
      if (WH.dl && WH.dl.model === m.id) return WH.dl.promise;
      WH.dl = { model: m.id, received: 0, total: m.size || 0, promise: null };
      checkWhisper(false);
      WH.dl.promise = bridge.call('whisperDownload', { model: m.id }, 3600000).then(function (st) {
        WH.dl = null;
        if (st && st.models) WH.status = st;
        checkWhisper(true);
        return WH.status;
      }, function (e) {
        WH.dl = null;
        cb('onError', { kind: 'whisper', message: 'Téléchargement impossible : ' + msgOf(e) });
        checkWhisper(false);
        throw e;
      });
      WH.dl.promise['catch'](noop);
      return WH.dl.promise;
    }

    function onWhisper(p) {
      p = p || {};
      if (p.job || !p.model) return;
      if (p.phase === 'download') {
        WH.dl = Object.assign(WH.dl && WH.dl.model === p.model ? WH.dl : { promise: null }, { model: p.model, received: p.received || 0, total: p.total || 0 });
        checkWhisper(false);
      } else {
        whisperStatus(true).then(function () {
          if (WH.dl && WH.dl.model === p.model && !WH.dl.promise) WH.dl = null;
          checkWhisper(true);
        });
      }
    }

    /* ══ Kokoro : préchauffage ════════════════════════════════════════════ */

    function warmTts() {
      var t = E.opts.tts || {};
      if (!t.kokoroVoice) return;
      ttsStatus(true).then(function (st) {
        if (!st || !st.ready || !E.started) return;
        var accent = t.accent || (String(t.kokoroVoice).charAt(0) === 'b' ? 'en-GB' : 'en-US');
        bridge.call('ttsWarm', { accent: accent }, 30000)['catch'](noop);
      });
    }

    /* ══ Avatar : montage et boucle ═══════════════════════════════════════ */

    function mountAvatar() {
      var o = E.opts;
      if (!o.container || o.avatar === false) return;
      var wrap = E.wrap = document.createElement('div');
      wrap.className = 'vc-avatar-host';
      var size = o.avatar && o.avatar.size;
      if (size) { wrap.style.width = size + 'px'; wrap.style.height = size + 'px'; }
      wrap.setAttribute('data-phase', 'idle');
      wrap.innerHTML = faceSvg();
      o.container.appendChild(wrap);
      E.face = bindFace(wrap.querySelector('.vc-face'));
      E.anim = newAnim();
      E.restUntil = performance.now() + REST_MS;
      kick();
    }

    function unmountAvatar() {
      if (E.raf) { cancelAnimationFrame(E.raf); E.raf = 0; }
      if (E.wrap && E.wrap.parentNode) E.wrap.parentNode.removeChild(E.wrap);
      E.wrap = null; E.face = null; E.anim = null;
    }

    function kick() {
      if (!E.raf && E.face && !E.destroyed) E.raf = requestAnimationFrame(frame);
    }

    function mood() {
      if (E.playing) return 'speak';
      if (!E.started) return 'rest';
      if (E.phase === 'speaking') return 'speak';
      if (E.phase === 'tool') return 'search';
      if (E.phase === 'thinking' || E.phase === 'transcribing' || E.phase === 'starting') return 'think';
      if (E.muted) return 'rest';
      if (E.phase === 'user') return 'user';
      return 'listen';
    }

    function frame(now) {
      E.raf = 0;
      if (E.destroyed || !E.face || !E.anim) return;
      /* À l'arrêt, l'avatar rejoint sa pose de repos puis la boucle s'endort. */
      if (!E.started && !E.playing && now > E.restUntil) return;
      E.raf = requestAnimationFrame(frame);
      drawFace(E.face, E.anim, now, mood(), voiceShape(E.playing), E.micLevel || 0);
    }

    /* ══ API ══════════════════════════════════════════════════════════════ */

    api.start = function () {
      if (E.destroyed) return Promise.reject(new Error('moteur détruit'));
      if (active && active !== api) active._stopFromOther();
      active = api;
      var first = !E.started;
      E.started = true;
      if (first) {
        resetVad();
        startAudio();
        whisperStatus(true).then(function () { checkWhisper(true); });
        warmTts();
        kick();
      }
      var p = startConversation();
      p['catch'](noop);
      return p;
    };

    api.stop = function () {
      var was = E.started;
      E.startSeq++;
      stopPlayback(false);
      cancelQueue();
      E.reply = null; E.pendingHeard = null; E.bargedIn = false;
      abortSegment();
      cancelParts();
      if (E.conv) bridge.call('voiceStop', { conversationId: E.conv.id })['catch'](noop);
      E.conv = null;
      stopAudio(false);
      E.started = false;
      if (active === api) active = null;
      E.micLevel = 0;
      E.restUntil = performance.now() + REST_MS;
      kick();
      if (was) setPhase('idle');
    };

    api._stopFromOther = function () { api.stop(); };

    api.destroy = function () {
      if (E.destroyed) return;
      api.stop();
      E.destroyed = true;
      unmountAvatar();
      E.offs.forEach(function (off) { try { off(); } catch (e) { /* déjà retiré */ } });
      E.offs = [];
    };

    api.mute = function (on) {
      E.muted = on == null ? !E.muted : !!on;
      if (E.muted) {
        abortSegment();
        if (E.phase === 'user') { setPhase(E.parts.length ? 'transcribing' : 'listening'); return E.muted; }
      }
      setPhase(E.phase, E.phaseText);
      return E.muted;
    };

    api.muted = function () { return E.muted; };

    api.interrupt = function () { return interrupt(true); };

    api.send = function (text, opts) {
      text = String(text == null ? '' : text).trim();
      if (!text) return Promise.resolve({ turn: null });
      if (E.reply) interrupt(false);
      var p = say(text, !!(opts && opts.hidden));
      p['catch'](noop);
      return p;
    };

    /* Relit un texte avec la voix du moment ; coupe la réponse en cours s'il y en a une. */
    api.replay = function (text) {
      text = String(text == null ? '' : text).trim();
      if (!text || E.destroyed) return Promise.resolve(false);
      if (E.reply) interrupt(false);
      else if (E.playing || E.queue.length) { stopPlayback(true); cancelQueue(); }
      resumeContext();
      return new Promise(function (resolve) {
        enqueue({ text: text, replay: true, resolve: resolve });
      });
    };

    api.state = function () {
      return {
        phase: effectivePhase(), muted: E.muted, micLevel: E.micLevel, micDb: E.micDb, threshold: E.threshold,
        playing: !!E.playing, fallback: !!(E.playing && E.playing.fallback), replying: !!E.reply, conversationId: E.conv ? E.conv.id : null, started: E.started,
        tts: useKokoro() ? 'kokoro' : 'sapi', amp: E.anim ? E.anim.amp : 0, sampleRate: AUD.ctx ? AUD.ctx.sampleRate : 0
      };
    };

    api.setOptions = function (patch) {
      patch = patch || {};
      var before = E.opts;
      E.opts = mergeOpts(E.opts, patch);
      if ('whisperModel' in patch && patch.whisperModel !== before.whisperModel) checkWhisper(true);
      if ('tts' in patch) { E.kokoroFails = 0; if (E.started) warmTts(); }
      if (('container' in patch && patch.container !== before.container) || ('avatar' in patch)) {
        unmountAvatar();
        mountAvatar();
      }
      return api;
    };

    api.downloadWhisper = downloadWhisper;
    api.feed = function (buf) { onFrame(buf); };
    Object.defineProperty(api, 'element', { get: function () { return E.wrap; } });

    E.offs.push(bridge.on('voice', onVoice));
    E.offs.push(bridge.on('whisper', onWhisper));
    E.offs.push(bridge.on('tts', onTts));
    mountAvatar();
    ttsStatus(false);
    return api;
  }

  window.OrganizatorVoice = {
    create: create,
    active: function () { return active; },
    isJunk: isJunk,
    whisper: function () { return WH.status; },
    whisperStatus: whisperStatus,
    tts: function () { return TT.status; },
    ttsStatus: ttsStatus
  };
})();
