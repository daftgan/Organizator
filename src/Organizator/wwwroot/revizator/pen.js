/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — la correspondance (vue « Messages »)
   Une conversation écrite en anglais, au long cours, comme par messagerie, avec un correspondant qui a
   sa vie, ses goûts et ses opinions : un archétype au choix (PERSONAS) ou un personnage décrit par
   l'apprenant. Pour pratiquer l'écrit de façon informelle : on parle de tout, il donne son avis, raconte,
   lance des sujets (à la demande aussi : « Un sujet », avec un thème), cherche sur le web quand il faut
   décrire ou vérifier (sources sous sa réponse). Les corrections du dernier message de l'apprenant vont
   à part, en marge sous son message (fautes et tournures peu naturelles, au degré choisi : léger,
   normal, exigeant), avec, pour chacune, « + Carte » (révisions espacées) et « Demander à Oliver » ; les
   fautes vont au journal d'erreurs. « Faire le point » fait corriger à l'aveugle les messages écrits
   depuis le dernier point (genre grade) : niveau d'écrit, notes, priorité.

   Génération : R.gen('pen', { mode: open|reply|topic, persona: { name, about }, fix: light|normal|thorough,
   length: short|normal|long, web, level, lang: fr|en, memory, history: [{ role: me|them, text }] (30 derniers),
   message (reply : les messages de l'apprenant depuis la dernière réponse), theme (topic) })
   → { messages: [bulles], notes: [{ said, better, kind: error|style, why, category }], memory, topic, ideas, sources: [{ title, url }] }
   (hôte : PenGenre de LearningAgent.cs ; modèle penModel / penEffort ; WebSearch et WebFetch si web).
   La mémoire, réécrite à chaque réponse, porte ce qui sort de l'historique : la conversation peut durer des semaines.

   Données : R.data.pen = { threads: [{ id, persona, custom: { name, about } | null, fix, length, web, topic,
   createdAt, updatedAt, n (messages écrits en tout), preview, last: me|them, unread, words, pending: { job, mode,
   ids, at } | null, session: { startedAt, lastAt, minutes } | null, review: { at, n, level } | null }] } (index,
   fusionné entre appareils comme le reste de learning.json) ; la conversation dans le document pen/<id> :
   { id, msgs: [{ id, role: me|them, text, at, notes?, ideas?, sources?, carded? }] (1 500 au plus), memory, n,
   updatedAt, reviews: [{ at, grade, response }] }. Le document est relu quand l'index en sait plus que lui
   (écrit depuis un autre appareil). Une réponse arrivée après un rechargement est intégrée par jobDone.
   Séances : le temps de frappe et de lecture compte en minutes d'écrit (R.logSession, kind « pen »), une
   séance se clôt après 20 minutes sans rien écrire.
   Styles : pen.css (préfixe .rzm-).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R || !R.view) return;
  var esc = R.esc;
  var bridge = window.bridge;

  var KEEP = 1500;                 /* messages gardés par conversation */
  var SEND = 30;                   /* messages envoyés à l'agent (le reste : sa mémoire) */
  var MAX_THREADS = 40;
  var SESSION_GAP = 20 * 60000;    /* une séance se clôt après 20 minutes sans écrire */
  var TYPE_GAP = 60000;            /* deux frappes à moins d'une minute : du temps d'écriture */

  /* Les archétypes : la fiche française pour l'écran, le personnage en anglais pour le modèle. */
  var PERSONAS = [
    {
      id: 'maya', name: 'Maya', fem: true, age: 34, place: 'Londres', color: '#b4536a', fix: 'normal', length: 'normal',
      tagFr: 'Journaliste, curieuse et taquine',
      bioFr: 'Londonienne, journaliste culture et société. Elle a un avis sur tout, adore débattre et vous pousse à argumenter — avec un humour très britannique.',
      about: 'You are Maya, 34, a freelance journalist living in Hackney, East London, writing about culture, cities and social trends for magazines and a podcast. Grew up in Bristol; has a ginger cat called Biscuit; cycles everywhere; haunts markets, bookshops and small theatres; currently reading too many books at once. Personality: sharp, curious, warm under a layer of dry British irony; teases gently. Strong, well-argued opinions on books, films, TV, food, work culture, housing, tech and social media — loves a good debate, pushes back politely when she disagrees, and asks “but why?”. Writes in full sentences with British spelling and expressions (“brilliant”, “fancy”, “a bit”, “to be fair”, “cheers”), rare emojis.'
    },
    {
      id: 'jake', name: 'Jake', age: 27, place: 'San Diego', color: '#2f7fb0', fix: 'light', length: 'short',
      tagFr: 'Copain californien, décontracté',
      bioFr: 'Développeur web freelance et surfeur à San Diego. Sport, séries, jeux vidéo, food trucks : il écrit comme on parle, avec de l’argot américain, et il est très drôle.',
      about: 'You are Jake, 27, a freelance web developer and surfer in Ocean Beach, San Diego. Morning surf, afternoon code; obsessed with fish tacos, the NBA (Lakers fan, sadly), sci-fi series, video games, road trips and his rescue dog Nacho. Personality: laid-back, enthusiastic, very funny, a bit chaotic, says what he thinks spontaneously but is open to being convinced. Writes like he talks: casual American English and spelling, contractions, slang (“gonna”, “kinda”, “no way”, “dude”, “lol”, “low-key”), short bursts, the odd emoji. When he uses slang the learner might not know, he sometimes explains it in a few words.'
    },
    {
      id: 'eleanor', name: 'Eleanor', fem: true, age: 68, place: 'Oxford', color: '#5f7a4a', fix: 'thorough', length: 'long',
      tagFr: 'Professeure de lettres à la retraite',
      bioFr: 'Ancienne professeure de littérature à Oxford, jardinière passionnée. Élégante et cultivée — livres, histoire, musique, voyages —, elle aime la belle tournure et vous fera écrire mieux.',
      about: 'You are Eleanor, 68, a retired English literature teacher living in a cottage near Oxford. Widowed, two grown-up children, three grandchildren; tends an unruly garden (roses, a vegetable patch, a war with the slugs); sings in a choir; loves 19th-century novels, history, classical music, museums and travel — she spent a year in Provence long ago and still speaks a little French. Personality: articulate, kind, gently ironic, curious about everything, with nuanced opinions she defends with grace. Writes longer, carefully crafted messages, like letters, with impeccable grammar and British spelling, no emojis. She appreciates a well-turned phrase: when the learner writes something clumsy or bland, she sometimes offers a more elegant way to say it, in passing and with warmth.'
    },
    {
      id: 'priya', name: 'Priya', fem: true, age: 31, place: 'Toronto', color: '#b8741c', fix: 'normal', length: 'normal',
      tagFr: 'Ingénieure, rationnelle et curieuse de tout',
      bioFr: 'Ingénieure en IA à Toronto, née à Bangalore. Tech, science, startups, randonnée et cuisine épicée : elle aime les faits et les chiffres, et vous demandera toujours « why? ».',
      about: 'You are Priya, 31, a machine-learning engineer in Toronto, born and raised in Bangalore, moved to Canada for her master’s. Loves hiking and canoeing in Algonquin Park, board games, cooking very spicy food, science podcasts and terrible puns. Personality: rational, precise, curious, a bit nerdy and playful; sceptical of hype (including about AI), likes evidence and numbers, asks “why?” and “how do you know?”, enjoys thought experiments and surprising facts, and happily changes her mind when given a good argument. Writes clear, lively Canadian English, occasional emoji.'
    },
    {
      id: 'liam', name: 'Liam', age: 45, place: 'Dublin', color: '#2b8467', fix: 'normal', length: 'normal',
      tagFr: 'Chef et conteur irlandais',
      bioFr: 'Chef d’un petit restaurant à Dublin. Cuisine, voyages, rugby, musique : un conteur intarissable, chaleureux, plein d’anecdotes et d’expressions irlandaises.',
      about: 'You are Liam, 45, chef and owner of a small restaurant in Stoneybatter, Dublin. Grew up on a farm in County Clare; worked in kitchens in London, Lyon and Lisbon; married to Aoife, two teenage kids; plays the fiddle badly and follows rugby passionately. Personality: warm, generous, a born storyteller with endless anecdotes (customers, kitchen disasters, family, travels), opinionated about food and proud of Irish produce, laughs at himself. Writes in friendly Irish English with expressions (“grand”, “the craic”, “sound”, “giving out”, “your man”), which he explains if the learner seems lost; few emojis.'
    },
    {
      id: 'marcus', name: 'Marcus', age: 39, place: 'Manchester', color: '#6a58a6', fix: 'normal', length: 'normal',
      tagFr: 'Avocat du diable',
      bioFr: 'Avocat à Manchester, passionné de débats. Il prend volontiers le contre-pied de ce que vous dites pour vous faire argumenter — toujours fair-play, et bon perdant.',
      about: 'You are Marcus, 39, a barrister in Manchester, former university debating champion, Manchester City season-ticket holder, history and philosophy buff, amateur boxer. Your thing: you play devil’s advocate. Whatever position the learner takes, you often argue the other side — with real arguments, examples and the odd rhetorical question — to make them justify and develop their ideas in English; you say openly that you enjoy arguing the other side, and you concede gracefully when an argument convinces you. Also loves ethical dilemmas and “what if” questions. Respectful, witty, never mean or condescending. Writes structured, punchy British English, no emojis.'
    }
  ];
  var CUSTOM = { id: 'custom', name: 'Mon personnage', place: '', color: '#7d6d5c', fix: 'normal', length: 'normal', tagFr: 'Décrivez-le vous-même', bioFr: 'Un personnage sur mesure : son nom, sa vie, son caractère, ses passions, sa façon d’écrire.' };

  var THEMES = [
    ['', 'Surprise'], ['this week’s news', 'Actualité'], ['culture: books, films, series, music', 'Culture'],
    ['science and technology', 'Science et tech'], ['travel and places worth seeing', 'Voyages'], ['food and cooking', 'Cuisine'],
    ['a debate on a society question', 'Un débat'], ['a moral dilemma or a “would you rather”', 'Un dilemme'],
    ['memories and life stories', 'Souvenirs'], ['work and careers', 'Travail'], ['sport', 'Sport'], ['plans, dreams and the future', 'Projets']
  ];
  var FIXES = [['light', 'Léger'], ['normal', 'Normal'], ['thorough', 'Exigeant']];
  var FIX_HELP = { light: 'Seulement les fautes qui gênent ou qui reviennent.', normal: 'Les vraies fautes et les tournures peu naturelles.', thorough: 'Tout, jusqu’à la ponctuation et au style.' };
  var LENGTHS = [['short', 'Comme des SMS'], ['normal', 'Moyens'], ['long', 'Comme des lettres']];

  var U = R.ui.pen = R.ui.pen || {
    screen: 'list', id: '', drafts: {}, error: {}, confirm: '', gear: false, themes: false,
    pick: '', custom: { name: '', about: '' }, fix: '', length: '', web: true,
    review: { busy: '', error: '' }, fresh: {}, typedAt: 0, seenN: {}
  };
  var DOCS = {};                   /* id → { doc, loading, checkedN, error } */

  /* ══ Petites aides ═══════════════════════════════════════════════════ */

  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function str(v) { return v == null ? '' : String(v); }
  function clean(v, max) { return str(v).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max || 4000); }
  function plural(n, one, many) { return n + ' ' + (n > 1 ? (many || one + 's') : one); }
  function typo(html) { return String(html).replace(/« /g, '« ').replace(/ »/g, ' »').replace(/ ([?!:;])(?=[\s<&]|$)/g, ' $1'); }
  function coarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }
  /* Pour retrouver un extrait dans un texte sans changer les positions : casse et apostrophes seulement. */
  function same(s) { return str(s).toLowerCase().replace(/[‘’ʼ`]/g, '\'').replace(/[“”]/g, '"'); }
  function key(s) { return str(s).toLowerCase().replace(/[‘’ʼ`]/g, '\'').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim(); }
  function ago(ms) {
    var d = Date.now() - (+ms || 0);
    if (d < 90000) return 'à l’instant';
    if (d < 3600000) return 'il y a ' + Math.round(d / 60000) + ' min';
    if (d < 86400000) return 'il y a ' + Math.round(d / 3600000) + ' h';
    if (d < 7 * 86400000) return 'il y a ' + plural(Math.round(d / 86400000), 'jour');
    return new Date(+ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }
  function dayLabel(ms) {
    var d = new Date(+ms), t = new Date();
    var y = new Date(); y.setDate(y.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return 'Aujourd’hui';
    if (d.toDateString() === y.toDateString()) return 'Hier';
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function hhmm(ms) { return new Date(+ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
  function words(s) { return R.text && R.text.count ? R.text.count(s) : str(s).split(/\s+/).filter(Boolean).length; }

  /* ══ Données ═════════════════════════════════════════════════════════ */

  function store() {
    var d = R.data;
    if (!obj(d.pen)) d.pen = { threads: [] };
    if (!Array.isArray(d.pen.threads)) d.pen.threads = [];
    return d.pen;
  }
  function threads() {
    return store().threads.filter(function (t) { return obj(t) && t.id; }).sort(function (a, b) { return (+b.updatedAt || 0) - (+a.updatedAt || 0); });
  }
  function thread(id) { var l = store().threads; for (var i = 0; i < l.length; i++) if (l[i] && l[i].id === id) return l[i]; return null; }
  function current() { return U.id ? thread(U.id) : null; }

  function personaDef(id) { for (var i = 0; i < PERSONAS.length; i++) if (PERSONAS[i].id === id) return PERSONAS[i]; return id === 'custom' ? CUSTOM : PERSONAS[0]; }
  function nameOf(t) { return t && t.persona === 'custom' ? (clean(t.custom && t.custom.name, 30) || 'Mon correspondant') : personaDef(t && t.persona).name; }
  function colorOf(t) { return personaDef(t && t.persona).color; }
  /* Ce que le modèle reçoit du personnage. */
  function personaParam(t) {
    if (t.persona !== 'custom') { var p = personaDef(t.persona); return { name: p.name, about: p.about }; }
    var c = obj(t.custom) || {};
    return {
      name: nameOf(t),
      about: 'The learner described the character they want you to be (the description may be in French; you always write in English, and you fill in a coherent, vivid life around it): ' + clean(c.about, 1800)
    };
  }

  function avatar(t, big) {
    var n = nameOf(t);
    return '<span class="rzm-av' + (big ? ' is-big' : '') + '" style="--rzm-c:' + esc(colorOf(t)) + '" aria-hidden="true">' + esc(n.charAt(0).toUpperCase()) + '</span>';
  }
  function avatarOf(p) {
    return '<span class="rzm-av" style="--rzm-c:' + esc(p.color) + '" aria-hidden="true">' + (p.id === 'custom' ? R.icon('pen') : esc(p.name.charAt(0))) + '</span>';
  }

  function normDoc(d, id) {
    d = obj(d) || {};
    return { id: id, msgs: arr(d.msgs).filter(obj), memory: str(d.memory), n: +d.n || arr(d.msgs).length, updatedAt: +d.updatedAt || 0, reviews: arr(d.reviews).filter(obj) };
  }

  /* Le document d'une conversation : en cache s'il est à jour, sinon relu (l'index peut en savoir plus,
     écrit depuis un autre appareil). Un document absent du serveur est une conversation vide ; une lecture
     en échec ne remplace jamais une conversation par du vide. */
  function docOf(t) {
    var e = DOCS[t.id];
    if (e && e.doc && (+t.n || 0) <= e.checkedN) return e.doc;
    if (!e || !e.loading) load(t)['catch'](function () { /* affiché */ });
    return e && e.doc && !e.error ? e.doc : null;
  }
  function load(t) {
    var e = DOCS[t.id] = DOCS[t.id] || { doc: null, loading: false, checkedN: -1, error: '' };
    if (e.loading) return e.loading;
    var want = +t.n || 0;
    e.loading = bridge.call('learnDoc', { kind: 'pen', id: t.id }, 20000).then(function (r) {
      e.loading = false; e.error = '';
      var d = r && r.doc;
      /* Une conversation encore vide (pas encore écrite) ou plus récente que l'index : on la prend telle quelle. */
      if (d || !e.doc) e.doc = normDoc(d, t.id);
      e.checkedN = Math.max(want, e.doc.n);
      R.docPut('pen', t.id, e.doc);
      R.renderSoon();
      return e.doc;
    }, function (err) {
      e.loading = false;
      e.error = (err && err.message) || 'Lecture impossible.';
      R.renderSoon();
      throw err;
    });
    return e.loading;
  }
  function withDoc(t) {
    var e = DOCS[t.id];
    if (e && e.doc && !e.error && (+t.n || 0) <= e.checkedN) return Promise.resolve(e.doc);
    return load(t);
  }
  function saveDoc(t, d) {
    if (d.msgs.length > KEEP) d.msgs = d.msgs.slice(d.msgs.length - KEEP);
    d.updatedAt = Date.now();
    t.n = d.n;
    var e = DOCS[t.id] = DOCS[t.id] || { loading: false, error: '' };
    e.doc = d; e.checkedN = d.n; e.error = '';
    R.docSave('pen', t.id, d)['catch'](function (err) { R.toast('Correspondance : enregistrement impossible — ' + ((err && err.message) || 'erreur')); });
    R.save();
  }
  function push(d, m) { d.msgs.push(m); d.n = (+d.n || 0) + 1; return m; }

  /* ══ Séances : minutes d'écrit ═══════════════════════════════════════ */

  function addMinutes(t, minutes) {
    var now = Date.now(), s = obj(t.session);
    if (s && now - (+s.lastAt || 0) > SESSION_GAP) { flush(t); s = null; }
    if (!s) s = t.session = { startedAt: now, lastAt: now, minutes: 0 };
    s.minutes = (+s.minutes || 0) + minutes;
    s.lastAt = now;
  }
  function flush(t) {
    var s = obj(t.session);
    if (!s) return;
    t.session = null;
    if ((+s.minutes || 0) >= 1) {
      R.logSession({ kind: 'pen', ref: t.id, title: 'Correspondance · ' + nameOf(t), startedAt: s.startedAt, endedAt: s.lastAt, skillMinutes: { write: Math.round(s.minutes * 10) / 10 } });
    }
    R.save();
  }
  function flushStale() {
    var now = Date.now();
    store().threads.forEach(function (t) { if (obj(t) && obj(t.session) && now - (+t.session.lastAt || 0) > SESSION_GAP) flush(t); });
  }

  /* ══ Conversation ════════════════════════════════════════════════════ */

  function create() {
    var pick = U.pick || PERSONAS[0].id;
    var p = personaDef(pick);
    if (pick === 'custom' && !clean(U.custom.name, 30)) { R.toast('Donnez un nom à votre correspondant.'); return; }
    if (pick === 'custom' && clean(U.custom.about, 1800).length < 20) { R.toast('Décrivez votre correspondant en quelques phrases.'); return; }
    var now = Date.now();
    var t = {
      id: R.uid('pen').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30),
      persona: pick, custom: pick === 'custom' ? { name: clean(U.custom.name, 30), about: clean(U.custom.about, 1800) } : null,
      fix: U.fix || p.fix, length: U.length || p.length, web: U.web !== false,
      topic: '', createdAt: now, updatedAt: now, n: 0, preview: '', last: '', unread: false, words: 0, pending: null, session: null, review: null
    };
    if (t.id.length < 4) t.id = 'pen-' + now.toString(36);
    store().threads.push(t);
    var l = store().threads;
    if (l.length > MAX_THREADS) {
      var old = threads().slice(MAX_THREADS);
      old.forEach(function (x) { R.docDelete('pen', x.id)['catch'](function () { /* déjà parti */ }); });
      store().threads = l.filter(function (x) { return old.indexOf(x) < 0; });
    }
    var d = normDoc(null, t.id);
    DOCS[t.id] = { doc: d, loading: false, checkedN: 0, error: '' };
    U.custom = { name: '', about: '' }; U.fix = ''; U.length = ''; U.web = true;
    open(t.id);
    ask(t, d, 'open', {});
  }

  function open(id) {
    U.id = id; U.screen = 'chat'; U.gear = false; U.themes = false; U.confirm = '';
    var t = thread(id);
    if (t && t.unread) { t.unread = false; R.save(); }
    if (R.viewId() !== 'pen') R.go('pen'); else R.render();
    focusSoon();
  }

  /* Les messages de l'apprenant écrits depuis la dernière réponse (un envoi peut avoir échoué). */
  function unanswered(d) {
    var out = [];
    for (var i = d.msgs.length - 1; i >= 0 && d.msgs[i].role === 'me'; i--) out.unshift(d.msgs[i]);
    return out;
  }

  function send() {
    var t = current();
    if (!t || t.pending) return;
    var el = document.querySelector('[data-role="rz-pen-text"]');
    var text = clean(el ? el.value : U.drafts[t.id], 4000);
    if (!text) return;
    withDoc(t).then(function (d) {
      if (t.pending) return;
      push(d, { id: R.uid('pm'), role: 'me', text: text, at: Date.now() });
      t.words = (+t.words || 0) + words(text);
      t.last = 'me'; t.preview = text.slice(0, 140); t.updatedAt = Date.now();
      U.drafts[t.id] = '';
      var box = document.querySelector('[data-role="rz-pen-text"]');
      if (box) { box.value = ''; grow(box); }
      reply(t, d);
    }, function () { R.toast('La conversation n’a pas pu être lue : réessayez.'); });
  }

  function reply(t, d) {
    var mine = unanswered(d);
    if (!mine.length) { ask(t, d, d.msgs.length ? 'topic' : 'open', {}); return; }
    ask(t, d, 'reply', { message: mine.map(function (m) { return m.text; }).join('\n'), ids: mine.map(function (m) { return m.id; }) });
  }

  function ask(t, d, mode, extra) {
    var mine = mode === 'reply' ? extra.ids.length : 0;
    var before = d.msgs.slice(0, d.msgs.length - mine).slice(-SEND);
    var params = {
      mode: mode, persona: personaParam(t), fix: t.fix || 'normal', length: t.length || 'normal', web: t.web !== false,
      level: R.level('write').band, lang: R.explainLang() === 'en' ? 'en' : 'fr',
      memory: d.memory || '',
      history: before.map(function (m) { return { role: m.role === 'them' ? 'them' : 'me', text: str(m.text).slice(0, 2000) }; }),
      message: extra.message || '', theme: extra.theme || ''
    };
    var job = R.uid('rzpen');
    t.pending = { job: job, mode: mode, ids: extra.ids || [], theme: extra.theme || '', at: Date.now() };
    U.error[t.id] = '';
    saveDoc(t, d);
    R.render();
    scrollEnd();
    /* Le résultat passe par jobDone (aussi après un rechargement de la page) : rien à faire ici. */
    R.gen('pen', params, { job: job })['catch'](function () { /* jobDone */ });
  }

  function onDone(ev) {
    if (!ev || ev.kind !== 'pen') return;
    var t = null;
    store().threads.forEach(function (x) { if (obj(x) && obj(x.pending) && x.pending.job === ev.job) t = x; });
    if (!t) return;
    if (ev.error) { fail(t, ev.job, ev.error); return; }
    var res = obj(ev.result && ev.result.doc) || {};
    withDoc(t).then(function (d) { integrate(t, d, ev.job, res); }, function (e) { fail(t, ev.job, e); });
  }

  function integrate(t, d, job, res) {
    if (!obj(t.pending) || t.pending.job !== job) return;
    var p = t.pending;
    t.pending = null;
    var now = Date.now();
    var mine = d.msgs.filter(function (m) { return p.ids.indexOf(m.id) >= 0; });
    var notes = arr(res.notes).filter(function (n) { return n && n.said && n.better; });
    if (notes.length && mine.length) {
      notes.forEach(function (n) {
        var k = key(n.said), target = null;
        mine.forEach(function (m) { if (!target && key(m.text).indexOf(k) >= 0) target = m; });
        target = target || mine[mine.length - 1];
        target.notes = arr(target.notes).concat([{ said: str(n.said), better: str(n.better), kind: n.kind === 'style' ? 'style' : 'error', why: str(n.why), category: str(n.category) }]);
      });
      var errors = notes.filter(function (n) { return n.kind !== 'style'; });
      if (errors.length) {
        R.addErrors(errors.map(function (n) { return { type: 'error', category: n.category, original: n.said, correction: n.better, explanationFr: n.why }; }), { mode: 'write', ref: t.id });
      }
    }
    mine.forEach(function (m) { m.checked = true; });
    var bubbles = arr(res.messages).map(function (s) { return clean(s, 3000); }).filter(Boolean);
    if (!bubbles.length) bubbles = ['…'];
    var fresh = U.fresh[t.id] = {};
    bubbles.forEach(function (text, i) {
      var m = push(d, { id: R.uid('pm'), role: 'them', text: text, at: now + i });
      if (i === bubbles.length - 1) {
        if (arr(res.ideas).length) m.ideas = arr(res.ideas).slice(0, 3).map(function (s) { return str(s).slice(0, 120); });
        if (arr(res.sources).length) m.sources = arr(res.sources).slice(0, 4).filter(function (s) { return s && /^https:\/\//i.test(str(s.url)); });
      }
      fresh[m.id] = i;
    });
    d.memory = str(res.memory) || d.memory;
    if (res.topic) t.topic = str(res.topic).slice(0, 80);
    t.preview = bubbles[bubbles.length - 1].slice(0, 140);
    t.last = 'them';
    t.updatedAt = now;
    /* Le temps de lecture de sa réponse compte aussi (environ 180 mots par minute). */
    if (p.mode === 'reply') addMinutes(t, Math.min(3, words(bubbles.join(' ')) / 180));
    var watching = R.viewId() === 'pen' && U.screen === 'chat' && U.id === t.id && document.visibilityState !== 'hidden';
    t.unread = !watching;
    saveDoc(t, d);
    if (!watching) {
      var app = document.getElementById('app');
      var here = document.visibilityState !== 'hidden' && !!app && app.getAttribute('data-page') === 'revizator';
      if (here) R.toast(nameOf(t) + ' vous a répondu.', { label: 'Lire', run: function () { open(t.id); } });
      else R.notify(nameOf(t) + ' vous a répondu.', 'pen');
    }
    if (R.viewId() === 'pen') { R.renderSoon(); scrollEnd(); } else R.renderSoon();
  }

  function fail(t, job, e) {
    if (!obj(t.pending) || t.pending.job !== job) return;
    U.error[t.id] = { message: str(e && e.message) || 'Pas de réponse.', mode: t.pending.mode, theme: t.pending.theme || '' };
    t.pending = null;
    R.save();
    R.renderSoon();
  }

  function retry() {
    var t = current();
    if (!t || t.pending) return;
    var err = obj(U.error[t.id]) || {};
    withDoc(t).then(function (d) {
      if (unanswered(d).length) reply(t, d);
      else ask(t, d, d.msgs.length ? 'topic' : 'open', { theme: err.theme || '' });
    });
  }

  function cancel() {
    var t = current();
    if (!t || !t.pending) return;
    var job = t.pending.job;
    t.pending = null;
    R.cancel(job);
    R.save();
    R.render();
  }

  function topic(theme) {
    var t = current();
    if (!t || t.pending) return;
    U.themes = false;
    withDoc(t).then(function (d) {
      /* Des messages restés sans réponse partent avec : il répond, puis enchaîne. */
      if (unanswered(d).length) { reply(t, d); return; }
      ask(t, d, 'topic', { theme: theme });
    });
  }

  function remove(id) {
    var t = thread(id);
    if (!t) return;
    if (t.pending) R.cancel(t.pending.job);
    flush(t);
    store().threads = store().threads.filter(function (x) { return x !== t; });
    delete DOCS[id];
    R.docDelete('pen', id)['catch'](function () { /* déjà parti */ });
    U.screen = 'list'; U.id = ''; U.confirm = '';
    R.save();
    R.render();
    R.toast('Conversation avec ' + nameOf(t) + ' supprimée.');
  }

  /* ══ Faire le point : les messages depuis le dernier point, corrigés à l'aveugle ══ */

  function reviewText(t, d) {
    var from = obj(t.review) ? +t.review.n || 0 : 0;
    var start = Math.max(0, d.msgs.length - (d.n - from));
    var mine = d.msgs.slice(start).filter(function (m) { return m.role === 'me'; });
    if (words(mine.map(function (m) { return m.text; }).join(' ')) < 40) mine = d.msgs.filter(function (m) { return m.role === 'me'; }).slice(-25);
    return mine.slice(-25).map(function (m) { return str(m.text); }).join('\n').slice(0, 6000);
  }

  function review() {
    var t = current();
    if (!t || U.review.busy) return;
    withDoc(t).then(function (d) {
      var text = reviewText(t, d);
      if (words(text) < 40) { R.toast('Écrivez encore un peu (40 mots au moins) avant de faire le point.'); return; }
      U.review = { busy: t.id, error: '' };
      U.screen = 'review';
      R.render();
      var task = {
        id: t.id + ':review', kind: 'conversation',
        promptFr: 'Correspondance écrite informelle, par messagerie, avec ' + nameOf(t) + ' ; la réponse ci-dessous réunit les messages de l’apprenant, l’un après l’autre (registre familier attendu).',
        prompt: '', criteria: [], scale: 0, words: [0, 0], seconds: 0
      };
      R.gen('grade', { mode: 'write', rubric: 'lesson', task: task, response: text, metrics: null, level: R.level('write').band, targets: [] }, { job: R.uid('rzmrv') }).then(function (r) {
        var g = r && r.doc;
        var tt = thread(t.id);
        U.review = { busy: '', error: '' };
        if (!tt || !g) { R.renderSoon(); return; }
        withDoc(tt).then(function (dd) {
          dd.reviews = arr(dd.reviews).concat([{ at: Date.now(), grade: g, response: text }]).slice(-10);
          tt.review = { at: Date.now(), n: dd.n, level: str(g.levelEstimate) };
          if (g.levelEstimate) R.observeLevel('write', g.levelEstimate, R.productionWeight(text, 'write'));
          R.addGoodUses(g.goodUses, { mode: 'write', ref: tt.id });
          saveDoc(tt, dd);
          R.renderSoon();
        });
      }, function (e) {
        U.review = { busy: '', error: str(e && e.message) || 'Le point n’a pas pu être fait.' };
        R.renderSoon();
      });
    });
  }

  /* ══ Rendu ═══════════════════════════════════════════════════════════ */

  function render() {
    if (!R.isLoaded()) return '<div class="rzm"><div class="rz-muted"><span class="rz-spin"></span> Chargement…</div></div>';
    if ((U.screen === 'chat' || U.screen === 'review') && !current()) U.screen = 'list';
    if (U.screen === 'list' && !threads().length) U.screen = 'new';
    var html;
    if (U.screen === 'chat') html = chatHtml(current());
    else if (U.screen === 'review') html = reviewHtml(current());
    else if (U.screen === 'new') html = newHtml();
    else html = listHtml();
    return typo(html);
  }

  function listHtml() {
    var h = ['<div class="rzm">'];
    h.push('<div class="rzm-top"><div><h2 class="rzm-title">Correspondance</h2><p class="rzm-lead">Écrivez en anglais à des correspondants qui ont leur vie, leurs goûts et leurs opinions — comme par messagerie, aussi longtemps que vous voulez. Ils vous reprennent sur vos tournures, discrètement, sous chaque message.</p></div>'
      + '<button type="button" class="btn btn-primary" data-act="rz-pen-new">' + R.icon('pen') + ' Nouveau correspondant</button></div>');
    h.push('<section class="rz-card rzm-list">');
    threads().forEach(function (t) {
      var status = t.pending ? '<span class="rzm-typing-s">écrit…</span>' : esc(t.last === 'me' ? 'Vous : ' + t.preview : t.preview || '');
      h.push('<button type="button" class="rzm-row' + (t.unread ? ' is-unread' : '') + '" data-act="rz-pen-open" data-id="' + esc(t.id) + '">' + avatar(t)
        + '<span class="rzm-row-main"><span class="rzm-row-top"><b>' + esc(nameOf(t)) + '</b>' + (t.topic ? '<span class="rzm-row-topic">' + esc(t.topic) + '</span>' : '')
        + '<span class="rzm-row-time">' + esc(ago(t.updatedAt)) + '</span></span>'
        + '<span class="rzm-row-prev">' + status + '</span></span>'
        + (t.unread ? '<span class="rzm-dot" aria-label="Nouveau message"></span>' : '') + '</button>');
    });
    h.push('</section></div>');
    return h.join('');
  }

  function newHtml() {
    var pick = U.pick || PERSONAS[0].id, p = personaDef(pick);
    var fix = U.fix || p.fix, length = U.length || p.length;
    var h = ['<div class="rzm">'];
    h.push('<div class="rzm-top"><div>' + (threads().length ? '<button type="button" class="btn btn-ghost rzm-back" data-act="rz-pen-list">' + R.icon('back') + ' Mes conversations</button>' : '')
      + '<h2 class="rzm-title">' + (threads().length ? 'Nouveau correspondant' : 'Correspondance') + '</h2>'
      + '<p class="rzm-lead">Choisissez avec qui écrire. Vous parlerez de tout — votre journée, l’actualité, un film, une idée —, il aura ses avis et ses histoires, et ses corrections s’afficheront en marge de vos messages. Vous pourrez avoir plusieurs correspondants.</p></div></div>');
    h.push('<div class="rzm-personas" role="radiogroup" aria-label="Correspondants">');
    PERSONAS.concat([CUSTOM]).forEach(function (x) {
      var on = x.id === pick;
      h.push('<button type="button" role="radio" aria-checked="' + on + '" class="rzm-persona' + (on ? ' on' : '') + '" data-act="rz-pen-pick" data-id="' + esc(x.id) + '" style="--rzm-c:' + esc(x.color) + '">'
        + '<span class="rzm-persona-top">' + avatarOf(x) + '<span><b>' + esc(x.name) + '</b>' + (x.age ? '<small>' + x.age + ' ans · ' + esc(x.place) + '</small>' : '') + '</span></span>'
        + '<span class="rzm-persona-tag">' + esc(x.tagFr) + '</span><span class="rzm-persona-bio">' + esc(x.bioFr) + '</span></button>');
    });
    h.push('</div>');
    h.push('<section class="rz-card rzm-setup">');
    if (pick === 'custom') {
      h.push('<label class="rzm-field"><span>Son nom</span><input class="input" type="text" maxlength="30" data-role="rz-pen-custom" data-field="name" data-focus-key="rzm-custom-name" placeholder="Ex. Sophie" value="' + esc(U.custom.name) + '"></label>');
      h.push('<label class="rzm-field"><span>Qui est-ce ?</span><textarea class="input" rows="4" maxlength="1800" data-role="rz-pen-custom" data-field="about" data-focus-key="rzm-custom-about" placeholder="Âge, ville, métier, caractère, passions, opinions, façon d’écrire… Ex. Une Australienne de 40 ans, biologiste marine à Sydney, passionnée de plongée et de politique, très directe, qui écrit avec beaucoup d’humour.">' + esc(U.custom.about) + '</textarea></label>');
    }
    h.push(optionsHtml(fix, length, U.web !== false, 'rz-pen-opt'));
    h.push('<div class="rz-row rzm-setup-go"><button type="button" class="btn btn-primary rz-big" data-act="rz-pen-create">Commencer avec ' + esc(pick === 'custom' ? (clean(U.custom.name, 30) || 'mon personnage') : p.name) + '</button>'
      + '<span class="rz-muted">' + esc(pick === 'custom' ? 'C’est votre personnage qui écrit en premier.' : p.name + (p.fem ? ' vous écrit la première.' : ' vous écrit le premier.')) + '</span></div>');
    h.push('</section></div>');
    return h.join('');
  }

  function optionsHtml(fix, length, web, act) {
    function chips(name, list, cur) {
      return '<div class="rz-chips" role="radiogroup">' + list.map(function (o) {
        var on = o[0] === cur;
        return '<button type="button" role="radio" aria-checked="' + on + '" class="rz-chip' + (on ? ' on' : '') + '" data-act="' + act + '" data-name="' + name + '" data-value="' + esc(o[0]) + '">' + esc(o[1]) + '</button>';
      }).join('') + '</div>';
    }
    return '<div class="rzm-opts">'
      + '<div class="rzm-opt"><span class="rzm-opt-k">Corrections</span>' + chips('fix', FIXES, fix) + '<span class="rz-muted">' + esc(FIX_HELP[fix] || '') + '</span></div>'
      + '<div class="rzm-opt"><span class="rzm-opt-k">Ses messages</span>' + chips('length', LENGTHS, length) + '</div>'
      + '<div class="rzm-opt"><span class="rzm-opt-k">Recherche web</span>' + chips('web', [['on', 'Oui'], ['off', 'Non']], web ? 'on' : 'off')
      + '<span class="rz-muted">Pour parler d’actualité, décrire ou vérifier quelque chose ; ses réponses prennent alors un peu plus de temps.</span></div>'
      + '</div>';
  }

  function chatHtml(t) {
    var d = docOf(t), e = DOCS[t.id] || {};
    var name = nameOf(t);
    var h = ['<div class="rzm rzm-chat">'];
    h.push('<div class="rzm-chathead"><button type="button" class="btn btn-ghost rzm-back" data-act="rz-pen-list" aria-label="Mes conversations">' + R.icon('back') + '</button>'
      + avatar(t, true) + '<div class="rzm-who"><b>' + esc(name) + '</b><span class="rzm-who-s" data-rzm-status>' + esc(statusText(t)) + '</span></div>'
      + '<div class="rzm-head-acts">'
      + '<button type="button" class="btn btn-ghost' + (U.themes ? ' on' : '') + '" data-act="rz-pen-themes"' + (t.pending ? ' disabled' : '') + ' title="Lui demander de lancer un nouveau sujet">' + R.icon('spark') + '<span>Un sujet</span></button>'
      + '<button type="button" class="btn btn-ghost" data-act="rz-pen-review" title="Faire corriger vos derniers messages et estimer votre niveau à l’écrit">' + R.icon('chart') + '<span>Faire le point</span></button>'
      + '<button type="button" class="btn btn-ghost' + (U.gear ? ' on' : '') + '" data-act="rz-pen-gear" aria-label="Réglages de la conversation" title="Réglages de la conversation">' + gearIcon() + '</button>'
      + '</div></div>');
    if (U.themes) {
      h.push('<div class="rz-card rzm-drawer"><div class="rzm-drawer-k">Sur quoi ? ' + esc(name) + ' lance la conversation.</div><div class="rzm-themes">' + THEMES.map(function (x) {
        return '<button type="button" class="rzm-theme" data-act="rz-pen-topic" data-theme="' + esc(x[0]) + '">' + esc(x[1]) + '</button>';
      }).join('') + '</div></div>');
    }
    if (U.gear) {
      h.push('<div class="rz-card rzm-drawer">' + optionsHtml(t.fix || 'normal', t.length || 'normal', t.web !== false, 'rz-pen-set')
        + '<div class="rz-row rzm-drawer-foot"><span class="rz-muted">' + esc(plural(+t.words || 0, 'mot') + ' écrits depuis le ' + new Date(+t.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })
          + (obj(t.review) && t.review.level ? ' · dernier point : ' + t.review.level : '')) + '</span>'
        + '<button type="button" class="btn btn-ghost rzm-danger" data-act="rz-pen-delete">' + (U.confirm === t.id ? 'Confirmer : tout supprimer' : 'Supprimer la conversation') + '</button></div></div>');
    }
    h.push('<div class="rzm-log" data-rzm-log data-n="' + (d ? d.msgs.length : 0) + '">');
    if (!d) {
      h.push(e.error ? '<div class="rzm-state is-error">' + R.icon('cross') + ' ' + esc(e.error) + ' <button type="button" class="btn btn-ghost" data-act="rz-pen-reload">Réessayer</button></div>'
        : '<div class="rzm-state"><span class="rz-spin"></span> Lecture de la conversation…</div>');
    } else {
      if (d.msgs.length && d.n > d.msgs.length) h.push('<div class="rzm-day">Les messages plus anciens sont dans sa mémoire.</div>');
      var lastDay = '', lastThem = -1;
      d.msgs.forEach(function (m, i) { if (m.role === 'them') lastThem = i; });
      d.msgs.forEach(function (m, i) {
        var day = dayLabel(m.at);
        if (day !== lastDay) { h.push('<div class="rzm-day">' + esc(day) + '</div>'); lastDay = day; }
        var next = d.msgs[i + 1];
        var tail = !next || next.role !== m.role || dayLabel(next.at) !== day;
        h.push(m.role === 'me' ? mineHtml(t, m, tail) : theirHtml(t, m, tail, i === lastThem && !t.pending && i === d.msgs.length - 1));
      });
      if (t.pending) h.push('<div class="rzm-msg is-them is-tail"><div class="rzm-bubble rzm-typing" data-rzm-typing><span class="rzm-dots"><i></i><i></i><i></i></span></div></div>');
      var err = obj(U.error[t.id]);
      if (err && !t.pending) {
        h.push('<div class="rzm-state is-error" role="alert">' + R.icon('cross') + ' ' + esc(err.message)
          + ' <button type="button" class="btn btn-ghost" data-act="rz-pen-retry">Réessayer</button></div>');
      }
    }
    h.push('<div data-rzm-end></div></div>');
    h.push(composeHtml(t, d));
    h.push('</div>');
    return h.join('');
  }

  function statusText(t) {
    if (t.pending) {
      var j = R.jobById ? R.jobById(t.pending.job) : null;
      if (j && j.phase === 'tool') return 'cherche sur le web…';
      return 'écrit…';
    }
    var p = personaDef(t.persona);
    return t.topic ? t.topic : (t.persona === 'custom' ? 'votre correspondant' : p.tagFr.toLowerCase() + ' · ' + p.place);
  }

  function gearIcon() {
    return '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path></svg>';
  }

  /* Texte d'une bulle : paragraphes et retours à la ligne ; les extraits corrigés soulignés. */
  function textHtml(text, notes) {
    text = str(text);
    var marks = [];
    arr(notes).forEach(function (n, i) {
      var s = str(n.said).trim();
      if (!s) return;
      var at = same(text).indexOf(same(s));
      if (at < 0) return;
      var end = at + s.length;
      if (marks.some(function (m) { return at < m.end && end > m.at; })) return;
      marks.push({ at: at, end: end, i: i, kind: n.kind });
    });
    marks.sort(function (a, b) { return a.at - b.at; });
    var out = '', pos = 0;
    marks.forEach(function (m) {
      out += esc(text.slice(pos, m.at)) + '<mark class="rzm-mk is-' + (m.kind === 'style' ? 'style' : 'error') + '">' + esc(text.slice(m.at, m.end)) + '</mark>';
      pos = m.end;
    });
    out += esc(text.slice(pos));
    return out.split(/\n{2,}/).map(function (p) { return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; }).join('');
  }

  function mineHtml(t, m, tail) {
    var notes = arr(m.notes);
    var h = '<div class="rzm-msg is-me' + (tail ? ' is-tail' : '') + '"><div class="rzm-bubble" lang="en">' + textHtml(m.text, notes)
      + '<span class="rzm-time">' + esc(hhmm(m.at)) + (m.checked && !notes.length ? ' · ' + R.icon('check') : '') + '</span></div></div>';
    if (notes.length) {
      var errs = notes.filter(function (n) { return n.kind !== 'style'; }).length, styles = notes.length - errs;
      var label = [errs ? plural(errs, 'faute') : '', styles ? plural(styles, 'tournure') + ' à améliorer' : ''].filter(Boolean).join(' · ');
      h += '<details class="rzm-notes"' + (R.prefs.penNotes === 'folded' ? '' : ' open') + '><summary>' + R.icon('pen') + ' ' + esc(label) + '</summary>'
        + notes.map(function (n, i) {
          var carded = obj(m.carded) && m.carded[i];
          return '<div class="rzm-note is-' + (n.kind === 'style' ? 'style' : 'error') + '"><div class="rzm-note-pair"><span class="rzm-note-said" lang="en">' + esc(n.said) + '</span>' + R.icon('arrow')
            + '<span class="rzm-note-better" lang="en">' + esc(n.better) + '</span>' + (n.category ? '<span class="rz-cat">' + esc(R.categoryLabel(n.category)) + '</span>' : '') + '</div>'
            + (n.why ? '<div class="rzm-note-why">' + esc(n.why) + '</div>' : '')
            + '<div class="rzm-note-acts">'
            + (carded ? '<span class="rzm-note-done">' + R.icon('check') + ' Dans vos cartes</span>' : '<button type="button" class="rzm-link" data-act="rz-pen-card" data-msg="' + esc(m.id) + '" data-i="' + i + '">' + R.icon('cards') + ' + Carte</button>')
            + (R.prof && R.prof.available() ? '<button type="button" class="rzm-link" data-act="rz-pen-prof" data-msg="' + esc(m.id) + '" data-i="' + i + '">Demander à Oliver</button>' : '')
            + '</div></div>';
        }).join('') + '</details>';
    }
    return h;
  }

  function theirHtml(t, m, tail, last) {
    var fresh = U.fresh[t.id] && U.fresh[t.id][m.id];
    var h = '<div class="rzm-msg is-them' + (tail ? ' is-tail' : '') + (fresh != null ? ' is-new' : '') + '"' + (fresh != null ? ' style="--rzm-delay:' + (fresh * 0.45) + 's"' : '') + '>'
      + '<div class="rzm-bubble" lang="en">' + textHtml(m.text, null) + '<span class="rzm-time">' + esc(hhmm(m.at)) + '</span></div></div>';
    if (arr(m.sources).length) {
      h += '<div class="rzm-sources">' + R.icon('globe') + ' ' + m.sources.map(function (s) {
        var label = str(s.title) || str(s.url).replace(/^https:\/\/(www\.)?/, '').split('/')[0];
        return '<a href="' + esc(s.url) + '" data-act="open-url" data-url="' + esc(s.url) + '" title="' + esc(s.url) + '">' + esc(label) + '</a>';
      }).join(' · ') + '</div>';
    }
    if (last && arr(m.ideas).length) {
      h += '<div class="rzm-ideas" aria-label="Idées de réponse">' + m.ideas.map(function (x) {
        return '<button type="button" class="rzm-idea" data-act="rz-pen-idea" data-text="' + esc(x) + '" lang="en">' + esc(x) + '</button>';
      }).join('') + '</div>';
    }
    return h;
  }

  function composeHtml(t, d) {
    var draft = U.drafts[t.id] || '';
    var n = words(draft);
    return '<div class="rzm-compose">'
      + '<div class="rzm-compose-in"><textarea class="input" rows="1" lang="en" spellcheck="false" autocapitalize="sentences" autocorrect="off" autocomplete="off" data-role="rz-pen-text" data-focus-key="rzm-text-' + esc(t.id) + '" maxlength="4000" placeholder="Write to ' + esc(nameOf(t)) + '…"' + (d ? '' : ' disabled') + '>' + esc(draft) + '</textarea>'
      + (t.pending
        ? '<button type="button" class="btn btn-secondary rzm-send" data-act="rz-pen-cancel" title="Annuler sa réponse">' + R.icon('stop') + '</button>'
        : '<button type="button" class="btn btn-primary rzm-send" data-act="rz-pen-send" aria-label="Envoyer"' + (d ? '' : ' disabled') + '>' + sendIcon() + '</button>')
      + '</div><div class="rzm-compose-meta"><span data-rzm-count>' + (n ? esc(plural(n, 'mot')) : '') + '</span><span>'
      + (coarse() ? 'Astuce : coupez la correction automatique du clavier, pour que vos fautes restent les vôtres.' : 'Entrée pour envoyer · Maj+Entrée pour aller à la ligne · correcteur du navigateur coupé') + '</span></div></div>';
  }
  function sendIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 12 L20 4 L14 20 L11 13 Z" fill="currentColor"></path></svg>'; }

  function reviewHtml(t) {
    var d = docOf(t);
    var h = ['<div class="rzm rzm-review">'];
    h.push('<div class="rzm-top"><div><button type="button" class="btn btn-ghost rzm-back" data-act="rz-pen-back">' + R.icon('back') + ' Retour à la conversation</button>'
      + '<h2 class="rzm-title">Le point avec ' + esc(nameOf(t)) + '</h2>'
      + '<p class="rzm-lead">Vos derniers messages, relus d’un bloc par le correcteur, qui ne connaît pas votre niveau supposé : le niveau de votre écrit, ce qui est réussi, et la priorité pour la suite.</p></div></div>');
    if (U.review.busy === t.id) h.push('<div class="rz-card rzm-state"><span class="rz-spin"></span> Correction en cours… (quinze à trente secondes)</div>');
    else if (U.review.error) h.push('<div class="rz-card rzm-state is-error">' + R.icon('cross') + ' ' + esc(U.review.error) + ' <button type="button" class="btn btn-ghost" data-act="rz-pen-review">Réessayer</button></div>');
    var last = d && arr(d.reviews)[arr(d.reviews).length - 1];
    if (last && U.review.busy !== t.id) {
      h.push('<section class="rz-card"><div class="rz-card-head"><span class="rz-card-title">Point du ' + esc(new Date(last.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) + ' à ' + hhmm(last.at)) + '</span></div>'
        + R.h.feedback(last.grade, { response: last.response, mode: 'write' }) + '</section>');
      var older = arr(d.reviews).slice(0, -1).reverse();
      if (older.length) {
        h.push('<section class="rz-card"><div class="rz-card-head"><span class="rz-card-title">Points précédents</span></div><ul class="rzm-past">' + older.map(function (r) {
          return '<li><span>' + esc(new Date(r.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })) + '</span>' + (r.grade && r.grade.levelEstimate ? R.h.level(r.grade.levelEstimate) : '') + '</li>';
        }).join('') + '</ul></section>');
      }
    }
    h.push('</div>');
    return h.join('');
  }

  /* ══ Après le rendu ══════════════════════════════════════════════════ */

  function grow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight + 2, Math.round(window.innerHeight * 0.4)) + 'px';
  }
  function scrollEnd() {
    setTimeout(function () { var el = document.querySelector('[data-rzm-end]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'end' }); }, 40);
  }
  function focusSoon() {
    if (coarse()) return;
    setTimeout(function () { var el = document.querySelector('[data-role="rz-pen-text"]'); if (el && !el.disabled) el.focus(); }, 60);
  }

  function after(host) {
    var box = host.querySelector('[data-role="rz-pen-text"]');
    if (box) grow(box);
    var log = host.querySelector('[data-rzm-log]');
    var t = current();
    if (log && t) {
      var n = log.getAttribute('data-n') + (t.pending ? 'p' : '');
      if (U.seenN[t.id] !== n) { U.seenN[t.id] = n; scrollEnd(); }
      /* Les bulles nouvelles n'apparaissent en fondu qu'une fois. */
      if (U.fresh[t.id]) setTimeout(function () { delete U.fresh[t.id]; }, 3000);
      if (t.unread && document.visibilityState !== 'hidden') { t.unread = false; R.save(); }
    }
  }

  R.on('job', function (j) {
    if (!j || j.kind !== 'pen') return;
    var t = current();
    if (t && t.pending && t.pending.job === j.job) R.patch('[data-rzm-status]', esc(statusText(t)));
  });
  R.on('jobDone', onDone);
  /* Une séance se clôt d'elle-même après 20 minutes sans écrire : au chargement suivant au plus tard. */
  R.on('loaded', flushStale);
  setInterval(function () { if (R.isLoaded()) flushStale(); }, 5 * 60000);

  function unreadCount() { return R.isLoaded() ? threads().filter(function (t) { return t.unread; }).length : 0; }

  R.view('pen', {
    label: 'Messages', icon: 'pen', order: 32, title: 'Correspondance — écrire en anglais avec un correspondant, comme par messagerie',
    badge: function () { var n = unreadCount(); return n ? String(n) : ''; },
    render: render, after: after,
    onShow: function (p) {
      if (p && p.thread && thread(p.thread)) { U.id = p.thread; U.screen = 'chat'; }
      var t = current();
      if (U.screen === 'chat' && t && t.unread) { t.unread = false; R.save(); }
    },
    onHide: function () { U.gear = false; U.themes = false; },
    keydown: function (e, el, role) {
      var typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
      if (e.key === 'Escape' && (U.gear || U.themes)) { e.preventDefault(); U.gear = false; U.themes = false; R.render(); return true; }
      if (e.key === 'Escape' && !typing && U.screen === 'review') { e.preventDefault(); U.screen = 'chat'; R.render(); return true; }
      if (role === 'rz-pen-text' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse()) { e.preventDefault(); send(); return true; }
      return false;
    }
  });

  /* ══ Accueil ═════════════════════════════════════════════════════════ */

  R.homeCard({ id: 'pen', area: 'main', order: 35, html: function () {
    var l = threads(), t = l[0];
    var h = ['<section class="rz-card rzm-home"><div class="rz-card-head"><span class="rz-card-title">Correspondance</span>' + R.h.level(R.level('write').band, 'Écrit') + '</div>'];
    if (!t) {
      h.push('<p class="rzm-home-p">Écrivez en anglais à un correspondant qui a sa vie, ses goûts et ses opinions, comme par messagerie : il vous reprend sur vos tournures, discrètement.</p>');
      h.push('<div class="rzm-home-faces">' + PERSONAS.slice(0, 5).map(function (p) { return '<button type="button" class="rzm-home-face" data-act="rz-pen-start" data-id="' + esc(p.id) + '" title="' + esc(p.name + ' — ' + p.tagFr) + '">' + avatarOf(p) + '<span>' + esc(p.name) + '</span></button>'; }).join('') + '</div>');
      h.push('<div class="rz-row"><button type="button" class="btn btn-ghost" data-act="rz-pen-new">Choisir un correspondant ' + R.icon('arrow') + '</button></div>');
    } else {
      l.slice(0, 2).forEach(function (x) {
        h.push('<button type="button" class="rzm-row' + (x.unread ? ' is-unread' : '') + '" data-act="rz-pen-open" data-id="' + esc(x.id) + '">' + avatar(x)
          + '<span class="rzm-row-main"><span class="rzm-row-top"><b>' + esc(nameOf(x)) + '</b><span class="rzm-row-time">' + esc(ago(x.updatedAt)) + '</span></span>'
          + '<span class="rzm-row-prev">' + (x.pending ? '<span class="rzm-typing-s">écrit…</span>' : esc(x.last === 'me' ? 'Vous : ' + x.preview : x.preview || '')) + '</span></span>'
          + (x.unread ? '<span class="rzm-dot" aria-label="Nouveau message"></span>' : '') + '</button>');
      });
      h.push('<div class="rz-row"><button type="button" class="btn btn-ghost" data-act="rz-pen-all">Toutes les conversations ' + R.icon('arrow') + '</button></div>');
    }
    return typo(h.join('') + '</section>');
  } });

  /* ══ Actions ═════════════════════════════════════════════════════════ */

  function attr(el, n) { return el && el.getAttribute ? el.getAttribute(n) : null; }
  function msgOf(t, id) {
    var e = DOCS[t.id], d = e && e.doc;
    if (!d) return null;
    for (var i = 0; i < d.msgs.length; i++) if (d.msgs[i].id === id) return d.msgs[i];
    return null;
  }

  R.act('rz-pen-new', function () { U.screen = 'new'; if (R.viewId() !== 'pen') R.go('pen'); else { R.render(); window.scrollTo(0, 0); } });
  R.act('rz-pen-all', function () { U.screen = 'list'; R.go('pen'); });
  R.act('rz-pen-list', function () { U.screen = 'list'; U.gear = false; U.themes = false; R.render(); window.scrollTo(0, 0); });
  R.act('rz-pen-back', function () { U.screen = 'chat'; R.render(); });
  R.act('rz-pen-start', function (el) { U.pick = attr(el, 'data-id'); U.screen = 'new'; R.go('pen'); });
  R.act('rz-pen-pick', function (el) { U.pick = attr(el, 'data-id'); U.fix = ''; U.length = ''; R.render(); });
  R.act('rz-pen-opt', function (el) {
    var n = attr(el, 'data-name'), v = attr(el, 'data-value');
    if (n === 'fix') U.fix = v; else if (n === 'length') U.length = v; else if (n === 'web') U.web = v === 'on';
    R.render();
  });
  R.input('rz-pen-custom', function (el) { U.custom[attr(el, 'data-field') === 'about' ? 'about' : 'name'] = el.value; });
  R.act('rz-pen-create', create);
  R.act('rz-pen-open', function (el) { open(attr(el, 'data-id')); });
  R.act('rz-pen-send', send);
  R.act('rz-pen-cancel', cancel);
  R.act('rz-pen-retry', retry);
  R.act('rz-pen-reload', function () { var t = current(); if (t) { var e = DOCS[t.id]; if (e) e.error = ''; load(t)['catch'](function () { /* affiché */ }); R.render(); } });
  R.act('rz-pen-themes', function () { U.themes = !U.themes; U.gear = false; R.render(); });
  R.act('rz-pen-topic', function (el) { topic(attr(el, 'data-theme') || ''); });
  R.act('rz-pen-gear', function () { U.gear = !U.gear; U.themes = false; U.confirm = ''; R.render(); });
  R.act('rz-pen-set', function (el) {
    var t = current(), n = attr(el, 'data-name'), v = attr(el, 'data-value');
    if (!t) return;
    if (n === 'fix') t.fix = v; else if (n === 'length') t.length = v; else if (n === 'web') t.web = v === 'on';
    R.save(); R.render();
  });
  R.act('rz-pen-delete', function () {
    var t = current();
    if (!t) return;
    if (U.confirm !== t.id) { U.confirm = t.id; R.render(); return; }
    remove(t.id);
  });
  R.act('rz-pen-review', review);
  R.act('rz-pen-idea', function (el) {
    var t = current(), box = document.querySelector('[data-role="rz-pen-text"]');
    if (!t || !box) return;
    var idea = str(attr(el, 'data-text')).replace(/\s*(…|\.\.\.)\s*$/, ' ');
    box.value = (box.value.trim() ? box.value.replace(/\s*$/, ' ') : '') + idea;
    U.drafts[t.id] = box.value;
    grow(box);
    box.focus();
    try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) { /* champ masqué */ }
  });
  R.act('rz-pen-card', function (el) {
    var t = current(), m = t && msgOf(t, attr(el, 'data-msg')), i = +attr(el, 'data-i');
    var n = m && arr(m.notes)[i];
    if (!n) return;
    var c = R.cards.add({ kind: 'error', front: n.said, back: n.better, note: n.why }, { kind: 'pen', ref: t.id });
    m.carded = obj(m.carded) || {};
    m.carded[i] = true;
    saveDoc(t, DOCS[t.id].doc);
    R.toast(c ? 'Ajouté à vos cartes : « ' + n.better + ' ».' : 'Cette carte existe déjà.');
    R.render();
  });
  R.act('rz-pen-prof', function (el) {
    var t = current(), m = t && msgOf(t, attr(el, 'data-msg')), n = m && arr(m.notes)[+attr(el, 'data-i')];
    if (!n || !R.prof) return;
    R.prof.ask('Dans un message à mon correspondant, j’ai écrit « ' + n.said + ' » ; il me propose « ' + n.better + ' ». Pourquoi ? Pouvez-vous m’expliquer la règle, avec des exemples ?', m.text);
  });
  R.input('rz-pen-text', function (el) {
    var t = current();
    if (!t) return;
    U.drafts[t.id] = el.value.slice(0, 4000);
    grow(el);
    var now = Date.now();
    if (U.typedAt && now - U.typedAt < TYPE_GAP) addMinutes(t, (now - U.typedAt) / 60000);
    U.typedAt = now;
    var n = words(el.value);
    R.patch('[data-rzm-count]', n ? esc(plural(n, 'mot')) : '');
  });

  /* ══ Simulation (hors WebView2) ══════════════════════════════════════ */

  R.fixture('pen', function (p) {
    var msg = str(p.message), name = (p.persona && p.persona.name) || 'Maya';
    var notes = [];
    var since = /\b(since)\s+(\w+\s+(?:years?|months?|weeks?|days?))/i.exec(msg);
    if (since) notes.push({ said: since[0], better: 'for ' + since[2], kind: 'error', why: '« Depuis » + durée se dit « for », pas « since » (réservé au point de départ).', category: 'gram.for_since_ago' });
    if (/\bI am agree\b|\bI'm agree\b/i.test(msg)) notes.push({ said: (/\bI am agree\b|\bI'm agree\b/i.exec(msg) || [''])[0], better: 'I agree', kind: 'error', why: '« Agree » est un verbe : pas de « be » devant.', category: 'lex.false_friend' });
    if (/\bvery interesting\b/i.test(msg)) notes.push({ said: 'very interesting', better: 'fascinating', kind: 'style', why: 'Plus naturel et plus vivant qu’un « very » + adjectif.', category: 'lex.word_choice' });
    var messages = p.mode === 'open'
      ? ['Hi! I’m ' + name + ' — so nice to have a new pen pal. I’m writing this from my favourite café, where the barista has just drawn a slightly worried-looking swan in my latte.', 'Tell me a bit about you? And honestly — what’s the best thing that happened to you this week, however small?']
      : p.mode === 'topic'
        ? ['Totally random, but I’ve been thinking about this all day: if you could live in any city in the world for one year, all expenses paid, where would you go?', 'Mine would be Lisbon. The light there is unreal, and the custard tarts are a serious argument.']
        : ['Ha, I love that! ' + (msg.length > 80 ? 'You clearly have strong feelings about it.' : 'Short and sweet.'), 'Honestly, I’m not sure I agree though — I think it’s more complicated than that. What made you think so?'];
    return {
      messages: messages, notes: notes,
      memory: (p.memory ? p.memory + ' ' : '') + 'Learner wrote: ' + msg.slice(0, 80),
      topic: p.mode === 'topic' ? 'A year anywhere' : 'Getting to know each other',
      ideas: ['Actually, I think that…', 'That reminds me of…', 'Can I ask you something?'],
      sources: p.web && p.mode === 'topic' ? [{ title: 'Lisbon — Wikipedia', url: 'https://en.wikipedia.org/wiki/Lisbon' }] : []
    };
  });
})();
