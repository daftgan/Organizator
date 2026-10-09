/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — le tuteur vocal (module U3)
   Une conversation en anglais. Deux façons de la mener :
     · mains libres (par défaut, R.prefs.tutorLive) : le moteur vocal partagé (voice-engine.js,
       window.OrganizatorVoice) écoute en continu, détecte la fin de phrase, transcrit (en direct par
       Parakeet v3 s'il est téléchargé — la bulle de l'apprenant se remplit pendant qu'il parle —, sinon
       Whisper local ; les mesures Whisper arrivent alors après coup, onUtteranceDetail),
       envoie à une session Claude persistante en mode tuteur (voiceStart mode 'tutor') et lit la réponse
       phrase par phrase (Kokoro, sinon SAPI) ; on peut couper la parole au tuteur. Avatar en tête du chat.
       Traduction, aide et reformulation arrivent avec la phase « meta » de chaque réponse ;
     · tour par tour (repli) : l'apprenant parle (Espace) ou écrit ; le tuteur (Claude, R.gen('tutor'),
       modèle rapide) répond par écrit et à voix haute (R.tts.say).
   Dans les deux cas, il reformule discrètement une phrase fautive (recast) et relance par une question ;
   à la fin, un bilan R.gen('tutor', { end: true }) (trois erreurs corrigées et expliquées, trois tournures
   à réemployer, un retour en français, le niveau). Et la capsule « avant / après » : la même consigne
   orale tous les deux ou trois mois. L'écran de choix ouvre aussi la conversation en français, tous
   sujets (window.OrganizatorVoiceOverlay, voice.js).

   Écrans de la vue « tutor » (R.ui.tutor.screen) :
     pick (choix du scénario, accueil de la vue) · chat (conversation) · summary (bilan) ·
     history (conversations gardées) · open (une conversation relue) · capsule
   Données (R.data, propriété de ce module) :
     tutor.chats[]   (30 au plus, rognées par le noyau)
       { id, at, scenario: { id, title, tutorRole, learnerGoal, setting }, name, voice: { accent, gender, n },
         level, lesson: { id, title, summaryFr } | null,
         turns: [{ role: 'user'|'tutor', text, at, recast: { said, better } | null, url,
                   typed, unsure: [mot], seconds, wpm, sttMs,      (réplique de l'apprenant)
                   fr, tip, ms, end, live, cut, heard }],          (réplique du tuteur ; cut : coupée,
                                                                     heard = ce qui en a été entendu)
         summary: { errors: [{ said, better, explanationFr, category }], phrases: [string], feedbackFr, levelEstimate } | null,
         endedAt, closed, applied, logged, cardsAdded }
     tutor.pendingCards[]  cartes gardées tant que R.cards n'existe pas (versées dès qu'il paraît)
     tutor.voiceOff        true : les réponses ne sont pas lues d'office
     capsules[]  { id, at, prompt, url, text, metrics: { seconds, speechSeconds, wpm, articulationWpm, words, pauses, longPauses, unsure } }
   Actions : rz-tutor-* ; saisie : rz-tutor-text (Entrée envoie), rz-tutor-voice ; micros : rzv-mic, rzv-cap.
   Préférences (R.prefs) : tutorLive (mains libres, défaut true), tutorSensitivity (0..100, défaut 40),
     tutorBargeIn ('words' | 'voice' | 'off', défaut 'words' : couper la parole au tuteur).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R || !R.view) return;
  var esc = R.esc;
  var bridge = window.bridge;

  var REC_KEY = 'rzv-mic', CAP_KEY = 'rzv-cap';
  var HISTORY_TURNS = 12, BILAN_TURNS = 40, REC_MAX_MS = 90000, CAP_MAX_MS = 90000, CAP_EVERY_DAYS = 60, UNSURE_P = 0.5;
  var LEVELS_OK = ['A2', 'B1', 'B1+', 'B2', 'B2+', 'C1'];
  var CAPSULE_PROMPT = 'Present yourself and your job in one minute.';
  var CAPSULE_PROMPT_FR = 'Présentez-vous et présentez votre travail, en une minute environ.';

  var T = R.ui.tutor = {
    screen: 'pick', chatId: '', openId: '', pending: null, error: null, fr: {}, draft: '', toEnd: false,
    focusText: false, newKey: '', blobs: {}, capJust: '', capNote: '', news: null, newsAt: 0, micNote: '',
    dismissEnd: '', recChat: '', warmAt: 0
  };

  /* ══ Scénarios ══════════════════════════════════════════════════════════
     Le rôle, l'objectif et le cadre partent en anglais vers le tuteur (il joue en anglais) ;
     l'apprenant les lit en français. */
  var SCENARIOS = [
    { id: 'free', icon: 'chat', hue: 'speak', title: 'Conversation libre', name: 'Emma',
      roleFr: 'une Londonienne curieuse, qui parle de tout', goalFr: 'Parler de ce que vous voulez, quelques minutes, sans vous arrêter.', minutes: '5-15 min',
      tutorRole: 'Emma, a friendly and curious English tutor from London who enjoys chatting about anything',
      learnerGoal: 'Talk freely about topics the learner chooses and keep the conversation going for a few minutes',
      setting: 'An informal chat over coffee. Let the learner choose the topics and follow their lead; share a little about yourself too.',
      voice: { accent: 'en-GB', gender: 'female', n: 0 },
      phrases: ['Let me think…', 'What I mean is…', 'That reminds me of…', 'How about you?'],
      open: ['Hi, I’m Emma! Lovely to meet you. What would you like to talk about today?', 'Bonjour, je suis Emma ! Ravie de vous rencontrer. De quoi aimeriez-vous parler aujourd’hui ?'],
      follow: [['Why does that matter to you?', 'Pourquoi est-ce important pour vous ?'], ['Can you give me an example?', 'Vous pouvez me donner un exemple ?'],
        ['How did you get into that?', 'Comment vous y êtes-vous mis ?'], ['What would you change about it?', 'Qu’est-ce que vous y changeriez ?'], ['And what are you looking forward to this week?', 'Et qu’attendez-vous avec impatience cette semaine ?']] },
    { id: 'news', icon: 'read', hue: 'read', title: 'Parlons de l’actu du jour', name: 'Tom',
      roleFr: 'un collègue qui lit la presse tous les matins', goalFr: 'Résumer une nouvelle avec vos mots, puis donner votre avis, arguments à l’appui.', minutes: '5-10 min',
      tutorRole: 'Tom, a well-read colleague who loves discussing the news',
      learnerGoal: 'Summarise a news story in their own words and give an opinion with reasons',
      setting: 'A coffee-break discussion about today’s news. Ask the learner to summarise the story first, then discuss causes, consequences and opinions.',
      voice: { accent: 'en-GB', gender: 'male', n: 0 },
      phrases: ['Apparently…', 'According to the article…', 'What struck me is…', 'I’m not sure I agree.'],
      open: ['Morning! Have you seen the news today? Which story caught your eye?', 'Bonjour ! Vous avez vu les infos aujourd’hui ? Quelle nouvelle a retenu votre attention ?'],
      follow: [['What do you think will happen next?', 'Que va-t-il se passer ensuite, d’après vous ?'], ['Who is affected the most, in your view?', 'Qui est le plus touché, selon vous ?'],
        ['Is it the same in France?', 'C’est pareil en France ?'], ['Do you agree with the decision?', 'Vous êtes d’accord avec cette décision ?']] },
    { id: 'smalltalk', icon: 'sun', hue: 'write', title: 'Small talk', name: 'Lucy',
      roleFr: 'une collègue du bureau de Londres, à la machine à café', goalFr: 'Faire la conversation — week-end, projets, météo — et relancer par des questions.', minutes: '5 min',
      tutorRole: 'Lucy, a friendly colleague from the London office, met at the coffee machine',
      learnerGoal: 'Keep a light conversation going (weekend, plans, weather) and ask questions back',
      setting: 'The office kitchen on a Monday morning, a few minutes before a meeting. Keep it light, short and natural.',
      voice: { accent: 'en-GB', gender: 'female', n: 1 },
      phrases: ['How was your weekend?', 'Not bad at all, thanks.', 'Any plans for…?', 'Lovely weather, isn’t it?'],
      open: ['Oh, hi! Good morning. How was your weekend?', 'Oh, salut ! Bonjour. Comment s’est passé votre week-end ?'],
      follow: [['Oh nice! Did you do anything special?', 'Sympa ! Vous avez fait quelque chose de spécial ?'], ['Any plans for the holidays?', 'Des projets pour les vacances ?'],
        ['How’s the new project going?', 'Comment avance le nouveau projet ?'], ['Have you tried the new café downstairs?', 'Vous avez essayé le nouveau café en bas ?']] },
    { id: 'standup', icon: 'clock', hue: 'lang', title: 'Stand-up meeting', name: 'Sarah',
      roleFr: 'cheffe d’une équipe de développement internationale', goalFr: 'Dire ce que vous avez fait hier, ce que vous faites aujourd’hui et ce qui vous bloque ; répondre aux questions.', minutes: '5 min',
      tutorRole: 'Sarah, team lead of an international software team, running the daily stand-up',
      learnerGoal: 'Report what they did yesterday, what they will do today and any blockers; answer follow-up questions',
      setting: 'The daily stand-up on a video call at 9:30. The learner is a developer on the team. Ask short follow-up questions about deadlines, blockers and who can help.',
      voice: { accent: 'en-US', gender: 'female', n: 0 },
      phrases: ['Yesterday I worked on…', 'Today I’m going to…', 'I’m blocked by…', 'It should be done by…'],
      open: ['Morning, everyone! Let’s get started. What did you work on yesterday?', 'Bonjour à tous ! On commence. Sur quoi avez-vous travaillé hier ?'],
      follow: [['Great. And what’s the plan for today?', 'Très bien. Et quel est le programme aujourd’hui ?'], ['Is anything blocking you?', 'Quelque chose vous bloque ?'],
        ['When do you think it’ll be ready?', 'Quand pensez-vous que ce sera prêt ?'], ['Do you need help from anyone on the team?', 'Vous avez besoin de l’aide de quelqu’un de l’équipe ?']] },
    { id: 'interview', icon: 'target', hue: 'listen', title: 'Entretien d’embauche', name: 'James',
      roleFr: 'recruteur dans une entreprise tech britannique', goalFr: 'Présenter votre parcours, raconter un projet dont vous êtes fier, poser une question sur le poste.', minutes: '10-15 min',
      tutorRole: 'James, hiring manager at a UK tech company, interviewing the learner for a senior developer role',
      learnerGoal: 'Present their background, describe a project they are proud of and ask a question about the job',
      setting: 'A video job interview. Friendly but probing: one question at a time, ask for concrete examples (situation, task, action, result).',
      voice: { accent: 'en-GB', gender: 'male', n: 1 },
      phrases: ['I’ve been working as… for…', 'One project I’m proud of is…', 'The main challenge was…', 'Could you tell me more about…?'],
      open: ['Hello, thanks for joining us today. Could you start by telling me a little about yourself?', 'Bonjour, merci d’être là aujourd’hui. Pouvez-vous commencer par vous présenter un peu ?'],
      follow: [['Tell me about a project you’re proud of.', 'Parlez-moi d’un projet dont vous êtes fier.'], ['What was the hardest part, and how did you deal with it?', 'Quelle a été la partie la plus difficile, et comment l’avez-vous gérée ?'],
        ['Why do you want to join us?', 'Pourquoi voulez-vous nous rejoindre ?'], ['Do you have any questions for me?', 'Avez-vous des questions pour moi ?']] },
    { id: 'client', icon: 'speak', hue: 'speak', title: 'Client mécontent', name: 'Mr Davis',
      roleFr: 'un client dont l’application est tombée hier', goalFr: 'Garder votre calme, vous excuser, expliquer ce qui s’est passé et ce que vous allez faire.', minutes: '5-10 min',
      tutorRole: 'Mr Davis, an unhappy client whose production app went down yesterday for two hours',
      learnerGoal: 'Stay calm, apologise, explain what happened and what will be done, in polite professional language',
      setting: 'A phone call. The client is annoyed but reasonable and calms down if the learner handles it well; he wants explanations, a timeline and guarantees.',
      voice: { accent: 'en-US', gender: 'male', n: 0 },
      phrases: ['I’m really sorry about…', 'Let me explain what happened.', 'We’ve already…', 'I’ll keep you posted.'],
      open: ['Hello. Look, I’m not happy at all. Our app was down for two hours yesterday. What happened?', 'Bonjour. Écoutez, je ne suis pas content du tout. Notre application a été coupée deux heures hier. Que s’est-il passé ?'],
      follow: [['And how do I know it won’t happen again?', 'Et comment savoir que ça ne se reproduira pas ?'], ['My customers were furious. What are you going to do about it?', 'Mes clients étaient furieux. Qu’allez-vous faire ?'],
        ['When will you send me a full report?', 'Quand m’enverrez-vous un rapport complet ?'], ['Fine. Who should I call next time?', 'Bon. Qui dois-je appeler la prochaine fois ?']] },
    { id: 'codereview', icon: 'pen', hue: 'read', title: 'Revue de code, expliquer un bug', name: 'Priya',
      roleFr: 'développeuse senior qui relit votre pull request', goalFr: 'Expliquer votre changement, le bug corrigé et sa cause ; défendre ou ajuster vos choix.', minutes: '5-10 min',
      tutorRole: 'Priya, a senior engineer reviewing the learner’s pull request',
      learnerGoal: 'Explain what the change does, the bug it fixes and its root cause; defend or adjust technical choices',
      setting: 'A code review call about a pull request that fixes a bug. Ask why and how, about edge cases, tests and naming. Technical vocabulary is welcome.',
      voice: { accent: 'en-US', gender: 'female', n: 1 },
      phrases: ['This PR fixes…', 'The root cause was…', 'I went with… because…', 'Good catch, I’ll…'],
      open: ['Hi! I’ve had a look at your pull request. Can you walk me through what it does?', 'Salut ! J’ai regardé votre pull request. Vous pouvez m’expliquer ce qu’elle fait ?'],
      follow: [['What was the root cause of the bug?', 'Quelle était la cause du bug ?'], ['How did you test it?', 'Comment l’avez-vous testé ?'],
        ['What happens if the list is empty?', 'Que se passe-t-il si la liste est vide ?'], ['Why did you choose this approach rather than a simple retry?', 'Pourquoi cette approche plutôt qu’une simple nouvelle tentative ?']] },
    { id: 'travel', icon: 'globe', hue: 'lang', title: 'Voyage au Royaume-Uni', name: 'Fiona',
      roleFr: 'les gens croisés en voyage : réception d’hôtel, guichet de gare, pub', goalFr: 'Vous débrouiller poliment : arriver à l’hôtel, acheter un billet de train, commander au pub.', minutes: '10 min',
      tutorRole: 'the people the learner meets while travelling in the UK: a hotel receptionist, a ticket office clerk, a pub landlord',
      learnerGoal: 'Get by politely: check in at a hotel, buy a train ticket, order food and drinks at a pub',
      setting: 'A trip to the UK in three scenes: the reception of a small hotel in Edinburgh, then the ticket office at King’s Cross, then a pub in York. Move to the next scene when one is done, and say so.',
      voice: { accent: 'en-GB', gender: 'female', n: 1 },
      variants: [
        { id: 'hotel', label: 'Hôtel', name: 'Fiona', roleFr: 'réceptionniste d’un petit hôtel d’Édimbourg', tutorRole: 'Fiona, the receptionist of a small hotel in Edinburgh',
          setting: 'Checking in at a hotel in Edinburgh in the evening; there is a small problem with the booking (the room type).', voice: { accent: 'en-GB', gender: 'female', n: 1 },
          open: ['Good evening, welcome to the Thistle Hotel! Do you have a reservation?', 'Bonsoir, bienvenue au Thistle Hotel ! Vous avez une réservation ?'] },
        { id: 'station', label: 'Gare', name: 'Guichet', roleFr: 'le guichet de la gare de King’s Cross, à Londres', tutorRole: 'a ticket office clerk at London King’s Cross station',
          setting: 'Buying a train ticket to York; ask about times, platforms, return tickets, railcards and delays.', voice: { accent: 'en-GB', gender: 'male', n: 0 },
          open: ['Hello there, where are you travelling to today?', 'Bonjour, vous allez où aujourd’hui ?'] },
        { id: 'pub', label: 'Pub', name: 'Dave', roleFr: 'patron d’un pub animé de York', tutorRole: 'Dave, the landlord of a busy pub in York',
          setting: 'Ordering drinks and food at the bar on a Friday evening, with a bit of small talk with the landlord.', voice: { accent: 'en-GB', gender: 'male', n: 1 },
          open: ['Evening! What can I get you?', 'Bonsoir ! Qu’est-ce que je vous sers ?'] }
      ],
      phrases: ['Could I have…, please?', 'I’ve booked a room under the name…', 'Is there a direct train to…?', 'Could you say that again, please?'],
      open: ['Good evening, welcome to the Thistle Hotel! Do you have a reservation?', 'Bonsoir, bienvenue au Thistle Hotel ! Vous avez une réservation ?'],
      follow: [['Lovely. Could I see your passport, please?', 'Parfait. Puis-je voir votre passeport, s’il vous plaît ?'], ['Would you like a single or a return ticket?', 'Vous voulez un aller simple ou un aller-retour ?'],
        ['Anything else for you?', 'Autre chose ?'], ['Is this your first time in the UK?', 'C’est votre première fois au Royaume-Uni ?']] },
    { id: 'debate', icon: 'flag', hue: 'listen', title: 'Débat', name: 'Alex',
      roleFr: 'contradicteur aimable, qui prend toujours l’avis opposé', goalFr: 'Défendre une opinion avec des raisons et des exemples ; être d’accord, pas d’accord, concéder poliment.', minutes: '10 min',
      tutorRole: 'Alex, a friendly sparring partner who always takes the opposite view',
      learnerGoal: 'Defend an opinion with reasons and examples; agree, disagree and concede politely',
      setting: 'A friendly debate. Suggest a topic (remote work, AI at work, cars in city centres…) or take the learner’s; argue the other side, then concede good points.',
      voice: { accent: 'en-US', gender: 'male', n: 1 },
      phrases: ['I see your point, but…', 'On the other hand…', 'For example…', 'Fair enough.'],
      open: ['Here’s a topic for us: working from home is better than working in an office. I’ll argue against it. What’s your view?', 'Voici un sujet : le télétravail vaut mieux que le bureau. Je défendrai l’inverse. Quel est votre avis ?'],
      follow: [['But don’t you miss your colleagues?', 'Mais vos collègues ne vous manquent pas ?'], ['Can you give me an example?', 'Vous avez un exemple ?'],
        ['Isn’t that a bit too optimistic?', 'N’est-ce pas un peu trop optimiste ?'], ['Fair enough. So what would be a good compromise?', 'D’accord. Alors quel serait un bon compromis ?']] }
  ];

  /* ══ Utilitaires ════════════════════════════════════════════════════════ */

  function arr(v) { return Array.isArray(v) ? v : []; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function clean(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 600); }
  function noop() { /* sans importance */ }
  function plural(n, one, many) { return n + ' ' + (n > 1 ? (many || one + 's') : one); }
  function secs(ms) { return String(Math.round(num(ms, 0) / 100) / 10).replace('.', ',') + ' s'; }
  function clock(s) { s = Math.max(0, Math.round(num(s, 0))); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }
  function round1(v) { return Math.round(num(v, 0) * 10) / 10; }
  /* Typographie française à l'affichage : insécables autour des guillemets et avant ? ! : ; (rien ne coupe « mot »). */
  function typo(html) { return String(html).replace(/« /g, '«\u00a0').replace(/ »/g, '\u00a0»').replace(/ ([?!:;])(?=[\s<&]|$)/g, '\u00a0$1'); }
  function normWord(w) { return String(w || '').toLowerCase().replace(/[‘’ʼ`]/g, '\'').replace(/[^a-z0-9']+/g, '').replace(/^'+|'+$/g, ''); }
  function dayLong(ms) { return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }
  function ago(ms) {
    var d = Date.now() - num(ms, 0);
    if (d < 90000) return 'à l’instant';
    if (d < 3600000) return 'il y a ' + Math.round(d / 60000) + ' min';
    if (d < 86400000 && R.dayOf(ms) === R.today()) return 'il y a ' + Math.round(d / 3600000) + ' h';
    var days = Math.round((new Date(R.today()).getTime() - new Date(R.dayOf(ms)).getTime()) / 86400000);
    if (days <= 1) return 'hier';
    if (days < 7) return 'il y a ' + days + ' jours';
    return 'le ' + new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  function scenarioById(id) {
    var base = String(id || '').split(':')[0];
    for (var i = 0; i < SCENARIOS.length; i++) if (SCENARIOS[i].id === base) return SCENARIOS[i];
    return null;
  }
  function variantOf(id) {
    var sc = scenarioById(id), v = String(id || '').split(':')[1];
    if (!sc || !v) return null;
    return arr(sc.variants).filter(function (x) { return x.id === v; })[0] || null;
  }
  function scOf(chat) { return scenarioById(chat && chat.scenario && chat.scenario.id) || SCENARIOS[0]; }

  function tutorData() {
    var t = R.data.tutor;
    if (!Array.isArray(t.chats)) t.chats = [];
    return t;
  }
  function chats() { return tutorData().chats; }
  function chatById(id) { var l = chats(); for (var i = 0; i < l.length; i++) if (l[i] && l[i].id === id) return l[i]; return null; }
  function current() { return T.chatId ? chatById(T.chatId) : null; }
  function userTurns(chat) { return arr(chat && chat.turns).filter(function (t) { return t && t.role === 'user'; }); }
  function resumable(chat) { return !!chat && !chat.summary && !chat.closed && userTurns(chat).length > 0; }
  function lastResumable() {
    var l = chats().filter(resumable).sort(function (a, b) { return lastAt(b) - lastAt(a); });
    return l[0] || null;
  }
  function lastAt(chat) { var t = arr(chat.turns); return t.length ? num(t[t.length - 1].at, chat.at) : num(chat.at, 0); }
  function talked() { return chats().filter(function (c) { return userTurns(c).length > 0; }).sort(function (a, b) { return lastAt(b) - lastAt(a); }); }
  function removeChat(id) { var t = tutorData(); t.chats = t.chats.filter(function (c) { return c && c.id !== id; }); }
  /* Une conversation ouverte puis laissée sans un mot de l'apprenant ne mérite pas d'être gardée. */
  function dropEmpty(except) {
    var t = tutorData();
    t.chats = t.chats.filter(function (c) { return c && (c.id === except || userTurns(c).length > 0 || c.summary); });
  }

  function speakLevel() {
    var b = String(R.level('speak').band || 'B1');
    if (LEVELS_OK.indexOf(b) >= 0) return b;
    b = b.replace('+', '');
    if (LEVELS_OK.indexOf(b) >= 0) return b;
    return b === 'C2' ? 'C1' : (b === 'A1' ? 'A2' : 'B1');
  }
  function helpLang() { return R.explainLang() === 'en' ? 'en' : 'fr'; }
  function voiceOf(chat) { return (chat && chat.voice) || scOf(chat).voice; }
  function nameOf(chat) { return (chat && chat.name) || scOf(chat).name; }
  function initialOf(chat) { var n = nameOf(chat).replace(/^(Mr|Mrs|Ms|Dr)\.?\s+/, ''); return n.charAt(0).toUpperCase() || 'T'; }

  function todayLesson() {
    var d = R.today();
    var l = arr(R.data.lessons).filter(function (x) { return x && x.id && x.day === d; })
      .sort(function (a, b) { return num(b.createdAt, 0) - num(a.createdAt, 0); });
    return l[0] || null;
  }

  function warm(chat) {
    if (!bridge) return;
    var v = voiceOf(chat);
    if (R.tts.ready()) bridge.call('ttsWarm', { accent: v.accent === 'en-GB' ? 'en-GB' : 'en-US' }, 15000)['catch'](noop);
    if (Date.now() - T.warmAt > 240000) {
      T.warmAt = Date.now();
      bridge.call('whisperWarm', { model: R.prefs.whisperModel || 'small' }, 15000)['catch'](noop);
    }
  }

  /* Les titres du jour (menu RSS de l'hôte, gardé 30 min) : de quoi parler d'actualité sans cours. */
  function headlines() {
    if (T.news && Date.now() - T.newsAt < 1800000) return Promise.resolve(T.news);
    if (!bridge) return Promise.resolve([]);
    return bridge.call('learnNews', {}, 15000).then(function (r) {
      T.news = arr(r && r.items).slice(0, 6).map(function (i) { return clean(i.title, 160) + (i.source ? ' (' + clean(i.source, 40) + ')' : ''); }).filter(Boolean);
      T.newsAt = Date.now();
      return T.news;
    }, function () { return []; });
  }

  /* Ce qu'un professeur saurait de l'apprenant, plus la mémoire courte des dernières conversations. */
  function tutorContext(chat) {
    var L = [R.context('tutor')];
    var prev = talked().filter(function (c) { return c.id !== chat.id; }).slice(0, 3);
    if (prev.length) {
      L.push('Conversations récentes avec le tuteur (pour vous en souvenir, sans les répéter) :');
      prev.forEach(function (c) {
        var s = c.summary;
        var errs = s ? arr(s.errors).slice(0, 2).map(function (e) { return '« ' + e.said + ' » → « ' + e.better + ' »'; }).join(' ; ') : '';
        L.push('- ' + R.dayOf(c.at) + ', ' + clean(c.scenario && c.scenario.title, 80) + (s && s.levelEstimate ? ' (niveau ' + s.levelEstimate + ')' : '')
          + (s && s.feedbackFr ? ' : ' + clean(s.feedbackFr, 160) : '') + (errs ? ' — erreurs : ' + errs : ''));
      });
    }
    return L.join('\n').slice(0, 8000);
  }

  function unsureWords(list) {
    var out = [];
    arr(list).forEach(function (w) {
      if (!w) return;
      var p = num(w.pMin != null ? w.pMin : w.p, 1);
      var k = normWord(w.text);
      if (p < UNSURE_P && k && out.indexOf(k) < 0 && out.length < 30) out.push(k);
    });
    return out;
  }
  function markUnsure(text, unsure) {
    var set = arr(unsure);
    if (!set.length) return esc(text);
    return String(text || '').split(/(\s+)/).map(function (tok) {
      if (!tok.trim() || set.indexOf(normWord(tok)) < 0) return esc(tok);
      return '<u class="rzv-unsure" title="Mot peu sûr : Whisper a hésité — articulez-le bien">' + esc(tok) + '</u>';
    }).join('');
  }

  /* Minutes passées par compétence : le temps actif (pauses de plus de 3 min écartées), partagé entre
     l'écoute (le temps de lecture des réponses) et la production (orale ou écrite selon les répliques). */
  function minutesOf(chat) {
    var ts = [num(chat.at, 0)].concat(arr(chat.turns).map(function (t) { return num(t.at, 0); }).filter(Boolean));
    var ms = 0;
    for (var i = 1; i < ts.length; i++) ms += Math.max(0, Math.min(ts[i] - ts[i - 1], 180000));
    var total = ms / 60000 + 0.3;
    var tutorWords = 0, spoken = 0, typed = 0;
    arr(chat.turns).forEach(function (t) {
      if (t.role === 'tutor') tutorWords += R.text.count(t.text);
      else if (t.typed) typed++; else spoken++;
    });
    var listen = Math.min(total * 0.6, tutorWords / 140);
    var prod = Math.max(0, total - listen);
    var out = { listen: round1(listen), speak: spoken + typed ? round1(prod * spoken / (spoken + typed)) : 0 };
    if (typed) out.write = round1(prod * typed / (spoken + typed));
    return out;
  }

  function statsOf(chat) {
    var u = userTurns(chat), spoken = u.filter(function (t) { return !t.typed; });
    var words = 0, secsSum = 0;
    u.forEach(function (t) { words += R.text.count(t.text); });
    spoken.forEach(function (t) { secsSum += num(t.seconds, 0); });
    var spokenWords = 0;
    spoken.forEach(function (t) { spokenWords += R.text.count(t.text); });
    /* Débit : celui que mesure l'hôte sur le signal (wpm de chaque réplique), sinon mots / durée. */
    var measured = spoken.map(function (t) { return num(t.wpm, 0); }).filter(function (v) { return v > 0; });
    var m = minutesOf(chat);
    return {
      turns: u.length, spoken: spoken.length, typed: u.length - spoken.length, words: words,
      wpm: measured.length ? Math.round(measured.reduce(function (a, b) { return a + b; }, 0) / measured.length) : (secsSum > 2 ? Math.round(spokenWords / secsSum * 60) : 0),
      minutes: Math.max(1, Math.round(num(m.speak, 0) + num(m.listen, 0) + num(m.write, 0)))
    };
  }

  /* ══ Lecture à voix haute ═══════════════════════════════════════════════ */

  function sayKey(chat, i) { return 'rzv-t-' + chat.id + '-' + i; }
  function speakTurn(chat, i) {
    var t = chat && chat.turns[i];
    if (!t || t.role !== 'tutor' || !t.text) return null;
    var v = voiceOf(chat);
    return R.tts.say(t.text, { accent: v.accent, gender: v.gender, n: v.n || 0, key: sayKey(chat, i) });
  }
  function sayText(text, chat) {
    if (chat && liveOn(chat)) { liveReplay(text); return null; }
    var v = chat ? voiceOf(chat) : { accent: 'en-GB', gender: 'female', n: 0 };
    return R.tts.say(String(text || ''), { accent: v.accent, gender: v.gender, n: v.n || 0, key: 'rzv-phrase' });
  }
  function lastTutorIdx(chat) {
    var t = arr(chat && chat.turns);
    for (var i = t.length - 1; i >= 0; i--) if (t[i].role === 'tutor') return i;
    return -1;
  }
  function isPlaying(key) { var p = R.players[key]; return !!p && (p.state === 'playing' || p.state === 'loading'); }
  function anyPlaying() { return Object.keys(R.players).some(isPlaying); }

  /* ══ Conversation : ouverture, tours, fin ══════════════════════════════ */

  var ticker = null;
  function startTicker() {
    if (ticker) return;
    ticker = setInterval(function () {
      if (!T.pending) { clearInterval(ticker); ticker = null; return; }
      R.patch('[data-rzv-wait]', esc(secs(Date.now() - T.pending.startedAt)));
    }, 500);
  }

  function setScreen(s) {
    if (T.screen === 'capsule' && s !== 'capsule') { T.capJust = ''; T.capNote = ''; R.recReset(CAP_KEY); }
    /* Hors de l'écran de conversation, le moteur mains libres se tait et rend le micro. */
    if (s !== 'chat') pauseLive();
    T.screen = s;
  }

  function startChat(scId, variantId) {
    var sc = scenarioById(scId) || SCENARIOS[0];
    var va = variantId ? arr(sc.variants).filter(function (v) { return v.id === variantId; })[0] : null;
    if (T.pending && !T.pending.end) cancelPending(true);
    R.tts.stopAll();
    stopLive();
    dropEmpty();
    var chat = {
      id: R.uid('tc'), at: Date.now(),
      scenario: {
        id: sc.id + (va ? ':' + va.id : ''), title: sc.title + (va ? ' · ' + va.label : ''),
        tutorRole: va ? va.tutorRole : sc.tutorRole, learnerGoal: sc.learnerGoal, setting: va ? va.setting : sc.setting
      },
      name: va ? va.name : sc.name, voice: (va && va.voice) || sc.voice,
      level: speakLevel(), lesson: null, turns: [], summary: null, endedAt: 0
    };
    chats().push(chat);
    T.chatId = chat.id; setScreen('chat');
    T.error = null; T.draft = ''; T.micNote = ''; T.fr = {}; T.dismissEnd = '';
    T.pending = { chatId: chat.id, job: '', end: false, startedAt: Date.now(), preparing: true };
    startTicker();
    warm(chat);
    R.save();
    if (R.viewId() !== 'tutor') R.go('tutor'); else R.render();
    prepare(chat).then(function () {
      if (!T.pending || T.pending.chatId !== chat.id || !T.pending.preparing) return;
      T.pending = null;
      /* Mains libres : le rendu démarre le moteur (ensureLive), qui fait ouvrir la conversation au tuteur. */
      if (liveMode()) { delete L.hold[chat.id]; R.render(); }
      else ask(chat, false);
    });
  }

  /* Le cours du jour (s'il existe) est connu du tuteur dans tous les scénarios ; l'actualité sans cours
     part des titres du jour. */
  function prepare(chat) {
    var l = todayLesson();
    var lp = !l ? Promise.resolve(null) : R.doc('lesson', l.id).then(function (doc) {
      return { id: l.id, title: clean((doc && doc.title) || l.title, 200), summaryFr: clean(doc && doc.summaryFr, 700) };
    }, function () { return { id: l.id, title: clean(l.title, 200), summaryFr: '' }; });
    return lp.then(function (lesson) {
      chat.lesson = lesson && lesson.title ? lesson : null;
      if (scOf(chat).id !== 'news') return null;
      if (chat.lesson) {
        chat.scenario.setting += ' Start from the topic of today’s lesson, which the learner has studied: “' + chat.lesson.title + '”.';
        return null;
      }
      return headlines().then(function (list) {
        if (list.length) chat.scenario.setting += ' Today’s headlines (let the learner pick one): ' + list.join(' · ') + '.';
      });
    })['catch'](noop);
  }

  function paramsOf(chat, end) {
    var s = chat.scenario || {};
    return {
      scenario: { id: String(s.id || ''), title: String(s.title || ''), tutorRole: String(s.tutorRole || ''), learnerGoal: String(s.learnerGoal || ''), setting: String(s.setting || '') },
      history: historyOf(chat, HISTORY_TURNS),
      level: speakLevel(),
      lesson: chat.lesson ? { title: chat.lesson.title, summaryFr: chat.lesson.summaryFr || '' } : null,
      end: !!end,
      lang: helpLang(),
      explain: R.profile.explain || 'auto'
    };
  }

  /* Le fil tel que l'apprenant l'a vécu : une réplique coupée compte pour ce qu'il en a entendu. */
  function spokenText(t) {
    if (t.role === 'tutor' && t.cut) { var h = clean(t.heard, 1500); return h ? h + ' [interrupted]' : '[interrupted before speaking]'; }
    return String(t.text || '');
  }
  function historyOf(chat, n) {
    return arr(chat.turns).slice(-n).map(function (t) { return { role: t.role === 'tutor' ? 'tutor' : 'user', text: spokenText(t) }; })
      .filter(function (h) { return h.text; });
  }

  /* Le bilan ne reçoit que les douze dernières répliques en historique (limite de l'hôte) : le début de
     la conversation, jusqu'à BILAN_TURNS répliques en tout, part dans le contexte, en tête. */
  function endContext(chat) {
    var all = arr(chat.turns);
    var older = all.slice(Math.max(0, all.length - BILAN_TURNS), Math.max(0, all.length - HISTORY_TURNS));
    if (!older.length) return tutorContext(chat);
    var lines = older.map(function (t) { return (t.role === 'tutor' ? 'Tutor: ' : 'Learner: ') + clean(spokenText(t), 360); });
    var head = 'Début de cette conversation (' + plural(older.length, 'réplique') + ' avant la partie « Conversation jusqu’ici » ; le bilan porte sur toute la conversation) :';
    var body = lines.join('\n');
    if (body.length > 4800) body = '…\n' + body.slice(body.length - 4800).replace(/^[^\n]*\n/, '');
    return (head + '\n' + body + '\n\n' + tutorContext(chat)).slice(0, 7900);
  }

  function ask(chat, end) {
    var job = R.uid('rzvt');
    var t0 = Date.now();
    var params = paramsOf(chat, end);
    chat.level = params.level;
    T.pending = { chatId: chat.id, job: job, end: !!end, startedAt: t0 };
    T.error = null;
    T.toEnd = true;
    startTicker();
    R.gen('tutor', params, { job: job, context: end ? endContext(chat) : tutorContext(chat) }).then(function (r) {
      if (!T.pending || T.pending.job !== job) return;
      T.pending = null;
      receive(chat.id, (r && r.doc) || {}, Date.now() - t0, !!end);
    }, function (e) {
      if (!T.pending || T.pending.job !== job) return;
      T.pending = null;
      T.error = { chatId: chat.id, end: !!end, message: clean(e && e.message, 300) || 'erreur inconnue' };
      T.toEnd = true;
      R.render();
    });
    R.render();
  }

  function receive(chatId, doc, ms, end) {
    var chat = chatById(chatId);
    if (!chat) return;
    var reply = clean(doc.reply, 1500);
    if (!reply && !end) {
      T.error = { chatId: chatId, end: false, message: 'sa réponse était vide' };
      R.render();
      return;
    }
    var turns = chat.turns;
    applyRecast(turns[turns.length - 1], doc.recast);
    if (reply) turns.push({ role: 'tutor', text: reply, at: Date.now(), recast: null, url: '', fr: clean(doc.replyFr, 1800), tip: clean(doc.tipFr, 400), ms: Math.round(ms), end: !!doc.end });
    var idx = turns.length - 1;
    if (end) {
      chat.summary = normSummary(doc.summary);
      chat.endedAt = Date.now();
      chat.closed = true;
      applySummary(chat);
      if (T.chatId === chat.id && T.screen === 'chat') { setScreen('summary'); T.toTop = true; }
    }
    T.newKey = chat.id + ':' + idx;
    T.toEnd = true;
    R.save();
    var here = R.viewId() === 'tutor' && T.chatId === chat.id && (T.screen === 'chat' || T.screen === 'summary');
    if (reply && here && !tutorData().voiceOff && !R.rec.busy()) speakTurn(chat, idx);
    R.render();
  }

  /* Comme l'hôte : une reformulation ne vaut que pour une phrase présente dans la dernière réplique. */
  function applyRecast(last, rc) {
    rc = rc || {};
    var better = clean(rc.better, 600), said = clean(rc.said, 600);
    if (!last || last.role !== 'user' || !better) return false;
    var inLast = !said || (' ' + R.text.norm(last.text) + ' ').indexOf(' ' + R.text.norm(said) + ' ') >= 0;
    if (!inLast || R.text.norm(better) === R.text.norm(said) || R.text.norm(better) === R.text.norm(last.text)) return false;
    last.recast = { said: said || last.text, better: better };
    return true;
  }

  /* Le bilan réel peut relever plus de trois erreurs (quatre dans l'essai de H2) : les trois premières sont
     affichées et mises en cartes, les suivantes repliées ; toutes vont au journal d'erreurs. */
  function normSummary(s) {
    s = s || {};
    var lv = clean(s.levelEstimate, 8).toUpperCase();
    return {
      errors: arr(s.errors).filter(function (e) { return e && (clean(e.said) || clean(e.better)); }).slice(0, 5).map(function (e) {
        return { said: clean(e.said, 300), better: clean(e.better, 300), explanationFr: clean(e.explanationFr, 400), category: clean(e.category, 40) || 'gram.other' };
      }),
      phrases: arr(s.phrases).map(function (p) { return clean(p, 160); }).filter(Boolean).slice(0, 3),
      feedbackFr: clean(s.feedbackFr, 1500),
      levelEstimate: R.thetaOf(lv) == null ? '' : lv
    };
  }

  /* Le bilan nourrit le modèle de l'apprenant une seule fois : journal d'erreurs, niveau à l'oral, séance. */
  function applySummary(chat) {
    if (chat.applied || !chat.summary) return;
    chat.applied = true;
    var s = chat.summary;
    if (s.errors.length) {
      R.addErrors(s.errors.map(function (e) {
        return { type: 'error', category: e.category, original: e.said, correction: e.better, explanationFr: e.explanationFr };
      }), { mode: 'speak', ref: chat.id });
    }
    if (s.levelEstimate) {
      var spoken = userTurns(chat).filter(function (t) { return !t.typed; }).length;
      if (spoken) R.observeLevel('speak', s.levelEstimate, R.clamp(spoken / 6, 0.3, 1.2));
      else R.observeLevel('write', s.levelEstimate, 0.4);
    }
    logChat(chat);
  }

  function logChat(chat) {
    if (chat.logged || !userTurns(chat).length) return;
    chat.logged = true;
    R.logSession({ kind: 'tutor', ref: chat.id, title: 'Tuteur · ' + clean(chat.scenario && chat.scenario.title, 120), startedAt: chat.at, endedAt: chat.endedAt || Date.now(), skillMinutes: minutesOf(chat) });
  }

  function cancelPending(silent) {
    var p = T.pending;
    if (!p) return;
    T.pending = null;
    if (p.job) R.cancel(p.job);
    var chat = chatById(p.chatId);
    if (!silent && !p.end && chat) T.error = { chatId: p.chatId, end: false, cancelled: true, message: 'Réponse annulée.' };
    if (!silent) R.render();
  }

  function sendText() {
    var chat = current();
    if (!chat || T.pending || chat.summary) return;
    var el = document.querySelector('[data-focus-key="rzv-text"]');
    var text = clean((el && el.value) || T.draft, 1000);
    if (!text) return;
    R.tts.stopAll();
    if (liveOn(chat)) { sendLiveText(chat, text, el); return; }
    chat.turns.push({ role: 'user', text: text, at: Date.now(), recast: null, url: '', typed: true });
    chat.closed = false;
    T.newKey = chat.id + ':' + (chat.turns.length - 1);
    T.draft = '';
    if (el) el.value = '';
    T.focusText = true;
    R.save();
    ask(chat, false);
  }

  function onRecStart() { T.recChat = T.chatId; T.micNote = ''; var c = current(); if (c) warm(c); }

  function onVoice(r) {
    R.recReset(REC_KEY);
    var chat = chatById(T.recChat || T.chatId);
    T.recChat = '';
    if (!chat || chat.summary) return;
    var stt = (r && r.stt) || {};
    var text = clean(stt.text, 1500);
    if (!text) { T.micNote = 'Aucune parole reconnue. Rapprochez-vous du micro, ou écrivez plutôt.'; return; }
    T.micNote = '';
    var audio = (r && r.audio) || {};
    var turn = {
      role: 'user', text: text, at: Date.now(), recast: null, url: String(stt.url || ''),
      unsure: unsureWords(stt.words), seconds: round1(audio.seconds), wpm: Math.round(num(stt.wpm, 0)), sttMs: Math.round(num(stt.ms, 0))
    };
    chat.turns.push(turn);
    chat.closed = false;
    var idx = chat.turns.length - 1;
    if (!turn.url && audio.url) T.blobs[chat.id + ':' + idx] = audio.url;
    T.newKey = chat.id + ':' + idx;
    T.error = null;
    R.save();
    if (!T.pending) ask(chat, false);
  }

  function endChat(chat) {
    chat = chat || current();
    if (!chat) return;
    if (T.pending && !T.pending.end) cancelPending(true);
    R.tts.stopAll();
    stopLive();
    T.chatId = chat.id;
    if (!userTurns(chat).length) { removeChat(chat.id); T.chatId = ''; setScreen('pick'); R.save(); R.render(); return; }
    setScreen('chat');
    ask(chat, true);
  }

  function quitChat() {
    var chat = current();
    if (T.pending) cancelPending(true);
    R.tts.stopAll();
    stopLive();
    if (chat) {
      if (!userTurns(chat).length) removeChat(chat.id);
      else { chat.closed = true; chat.endedAt = chat.endedAt || Date.now(); logChat(chat); }
      R.save();
    }
    T.error = null;
    setScreen('pick');
    R.render();
  }

  function backToPick() {
    var chat = current();
    R.tts.stopAll();
    if (T.pending && chat && !userTurns(chat).length) cancelPending(true);
    if (chat && !userTurns(chat).length && !(T.pending && T.pending.chatId === chat.id)) { removeChat(chat.id); T.chatId = ''; T.error = null; R.save(); }
    setScreen('pick');
    R.render();
  }

  /* ══ Mains libres : le moteur vocal partagé ═════════════════════════════
     Un moteur (window.OrganizatorVoice.create, voice-engine.js) par conversation ouverte à l'écran : il
     écoute en continu, transcrit chaque phrase de l'apprenant (Whisper, en anglais, avec le détail des
     mots et le son gardé), la confie à la session Claude du tuteur (voiceStart mode 'tutor') et lit la
     réponse phrase par phrase. Ce module ne fait que tenir le fil : chaque phrase entendue devient une
     réplique de l'apprenant, chaque réponse une réplique du tuteur, remplie au fil des phrases ; la phase
     « meta » apporte la traduction, l'aide, la reformulation et la proposition de conclure.
     L'avatar vit dans un élément propre au module (L.stage), jamais réécrit par le rendu : le rendu
     laisse une place vide [data-rzv-slot] où after() le replace. */

  var L = {
    eng: null, chatId: '', stage: null, phase: 'idle', phaseText: '', caption: '', notices: {}, error: '', muted: false,
    turns: {}, sentAt: 0, meter: null, hold: {}, sapi: null, sapiAsked: false,
    partial: '', draft: null, byId: {}, waiting: [], test: null, testTimer: 0, setMeter: 0
  };
  var GREETING = '(The learner has just joined. Open the conversation in character: greet them briefly and ask your first question.)';
  var RESUMING = '(The learner is back after a short pause. Answer their last message, in character.)';
  var NOISE = '(That was only background noise, not the learner. Carry on naturally.)';
  var PHASES = {
    starting: ['Joining…', 'Le tuteur arrive'], listening: ['I’m listening', 'Parlez quand vous voulez'], user: ['I’m listening…', 'Il vous entend'],
    transcribing: ['Got it…', 'Transcription de votre phrase'], thinking: ['Thinking…', 'Le tuteur réfléchit'], tool: ['Thinking…', 'Le tuteur réfléchit'],
    speaking: ['Speaking', 'Coupez-lui la parole quand vous voulez'], muted: ['Microphone off', 'Micro coupé : M pour le rouvrir'],
    error: ['Something went wrong', 'Un souci avec la conversation'], idle: ['Paused', 'Conversation en pause']
  };

  function liveAvailable() { return !!(window.OrganizatorVoice && typeof window.OrganizatorVoice.create === 'function'); }
  function livePref() { return !R.isLoaded() || R.prefs.tutorLive !== false; }
  function liveMode() { return livePref() && liveAvailable(); }
  function liveOn(chat) { return !!L.eng && !!chat && L.chatId === chat.id; }
  function sensitivity() { return R.clamp(Math.round(num(R.prefs.tutorSensitivity, 40)), 0, 100); }
  function liveAsr() { return window.OrganizatorLiveAsr || null; }
  function bargeIn() { var v = R.prefs.tutorBargeIn; return v === 'voice' || v === 'off' ? v : 'words'; }

  /* Une voix SAPI anglaise (repli quand Kokoro manque) : l'accent du scénario, puis n'importe quel anglais. */
  function askSapi() {
    if (L.sapiAsked || !bridge) return;
    L.sapiAsked = true;
    bridge.call('voiceVoices', {}, 15000).then(function (r) {
      L.sapi = arr(r && r.voices);
      if (L.eng) { var c = chatById(L.chatId); if (c) try { L.eng.setOptions({ tts: ttsOf(c) }); } catch (e) { /* moteur arrêté */ } }
    }, function () { L.sapi = []; });
  }
  function sapiFor(v) {
    var l = arr(L.sapi), acc = String(v.accent || 'en-US').toLowerCase();
    var en = l.filter(function (x) { return /^en/i.test(String(x.lang || '')); });
    var same = en.filter(function (x) { return String(x.lang || '').toLowerCase().replace('_', '-') === acc; });
    var pool = same.length ? same : en;
    var g = pool.filter(function (x) { return String(x.gender || '').toLowerCase() === v.gender; });
    var pick = (g.length ? g : pool)[0];
    return pick ? String(pick.id || '') : '';
  }
  function ttsOf(chat) {
    var v = voiceOf(chat);
    var kokoro = R.tts.engine() === 'kokoro' ? R.tts.voice(v.accent, v.gender, v.n || 0) : '';
    return { kokoroVoice: kokoro, accent: v.accent === 'en-GB' ? 'en-GB' : 'en-US', speed: R.clamp(num(R.prefs.speed, 1), 0.7, 1.3), sapiVoice: sapiFor(v), sapiRate: 0 };
  }

  function stageEl() {
    if (L.stage) return L.stage;
    var el = document.createElement('div');
    el.className = 'rzv-live';
    el.setAttribute('data-phase', 'starting');
    el.innerHTML = '<div class="rzv-live-ava"><div class="rzv-live-mount"></div><span class="rzv-live-ph" aria-hidden="true"></span></div>'
      + '<div class="rzv-live-main"><div class="rzv-live-state"><span class="rzv-live-dot" aria-hidden="true"></span><span class="rzv-live-label" lang="en"></span>'
      + '<span class="rzv-live-sub"></span><span class="rzv-live-meter" title="Niveau du micro" aria-hidden="true"><i></i></span></div>'
      + '<div class="rzv-live-cap" lang="en" aria-live="polite"></div><div class="rzv-live-notice" hidden></div></div>';
    L.stage = el;
    return el;
  }
  function mountOf() { return stageEl().querySelector('.rzv-live-mount'); }

  /* Les avis du moteur, par groupe (micro, Whisper, conversation) : le premier présent est affiché. */
  function currentNotice() {
    var k = Object.keys(L.notices).filter(function (g) { return L.notices[g] && L.notices[g].text; });
    var order = ['mic', 'whisper', 'conversation'];
    k.sort(function (a, b) { return (order.indexOf(a) + 1 || 9) - (order.indexOf(b) + 1 || 9); });
    return k.length ? L.notices[k[0]] : null;
  }
  function onNotice(n, info) {
    var g = (n && (n.group || n.kind)) || (info && info.kind) || 'other';
    if (n && n.text) L.notices[g] = n; else delete L.notices[g];
    updateStage();
  }
  function noticeAction(n) {
    if (!n) return null;
    var a = n.action;
    if (typeof a === 'function') return { label: n.actionLabel || 'Corriger', run: a };
    if (a && typeof a.run === 'function') return { label: a.label || 'Corriger', run: a.run };
    if (n.kind === 'whisper-missing' && !(n.progress >= 0)) return { label: 'Télécharger', run: downloadWhisper };
    return null;
  }
  function downloadWhisper() {
    if (L.eng && typeof L.eng.downloadWhisper === 'function') return L.eng.downloadWhisper();
    if (bridge) return bridge.call('whisperDownload', { model: R.prefs.whisperModel || 'small' }, 3600000);
    return null;
  }

  /* L'état de l'avatar, le sous-titre, l'avis : écrits sur place, sans rendu de la vue. */
  function updateStage() {
    var el = stageEl(), chat = chatById(L.chatId) || current();
    var held = !L.eng;
    var ph = held ? (L.error ? 'error' : 'idle') : (L.muted && (L.phase === 'listening' || L.phase === 'muted') ? 'muted' : L.phase);
    var lab = PHASES[ph] || PHASES.listening;
    el.setAttribute('data-phase', ph);
    el.classList.toggle('is-held', held);
    var q = function (s) { return el.querySelector(s); };
    q('.rzv-live-label').textContent = lab[0];
    q('.rzv-live-sub').textContent = chat ? nameOf(chat) + ' · ' + lab[1] : lab[1];
    q('.rzv-live-ph').textContent = chat ? initialOf(chat) : 'T';
    var cap = q('.rzv-live-cap');
    var capText = held ? '' : (ph === 'speaking' || ph === 'thinking' || ph === 'tool' ? L.caption : '');
    if (cap.textContent !== capText) cap.textContent = capText;
    var box = q('.rzv-live-notice');
    var n = L.error ? { kind: 'error', text: L.error } : currentNotice();
    var html = '';
    if (n && n.text) {
      var act = n.kind === 'error' ? null : noticeAction(n);
      var prog = n.progress >= 0 && !/\d+ %/.test(n.text) ? ' Téléchargement : ' + n.progress + ' %.' : '';
      html = '<span>' + esc(n.text + prog) + '</span>' + (act ? '<button type="button" class="btn btn-primary" data-act="rz-tutor-live-notice">' + esc(act.label) + '</button>' : '')
        + (n.kind === 'error' ? '<button type="button" class="btn btn-secondary" data-act="rz-tutor-live-resume">' + R.icon('replay') + ' Relancer</button>' : '');
    } else if (held && chat && !chat.summary) {
      html = '<span>' + esc(L.error ? '' : 'Le micro est fermé. Reprenez quand vous voulez : il se souvient de la conversation.') + '</span>'
        + '<button type="button" class="btn btn-primary" data-act="rz-tutor-live-resume">' + R.icon('mic') + ' Reprendre la conversation</button>';
    }
    if (box.getAttribute('data-html') !== html) { box.innerHTML = typo(html); box.setAttribute('data-html', html); }
    box.hidden = !html;
    box.classList.toggle('is-warn', !!(n && n.text));
  }

  function startMeter() {
    if (L.meter) return;
    L.meter = setInterval(function () {
      var e = L.eng;
      if (!e) { stopMeter(); return; }
      var st = null;
      try { st = e.state(); } catch (err) { return; }
      var lv = R.clamp(num(st && st.micLevel, 0), 0, 1);
      var i = L.stage && L.stage.querySelector('.rzv-live-meter i');
      if (i) i.style.transform = 'scaleX(' + Math.max(0.04, lv).toFixed(3) + ')';
      if (st && !!st.muted !== L.muted) { L.muted = !!st.muted; updateStage(); R.render(); }
    }, 90);
  }
  function stopMeter() { if (L.meter) { clearInterval(L.meter); L.meter = null; } }

  function stopLive() {
    var e = L.eng;
    L.eng = null;
    stopMeter();
    L.phase = 'idle'; L.phaseText = ''; L.caption = ''; L.notices = {}; L.muted = false; L.turns = {};
    L.byId = {}; L.waiting = [];
    setDraft('');
    if (e) { try { if (typeof e.destroy === 'function') e.destroy(); else e.stop(); } catch (err) { /* déjà arrêté */ } }
    if (L.stage) updateStage();
  }
  /* Quitter l'écran ou la page : le moteur s'arrête, et ne repart qu'à la demande (Reprendre). */
  function pauseLive() {
    if (!L.eng) return;
    L.hold[L.chatId] = true;
    stopLive();
  }

  /* Le moteur démarre de lui-même quand l'écran de conversation s'affiche en mains libres (sauf pause demandée). */
  function ensureLive() {
    var chat = current();
    if (T.screen !== 'chat' || !chat || chat.summary || T.pending || !liveMode() || R.viewId() !== 'tutor') return;
    if (L.hold[chat.id] || L.error && L.chatId === chat.id) { if (!L.eng) { L.chatId = chat.id; updateStage(); } return; }
    if (liveOn(chat)) return;
    startLive(chat);
    /* Le rendu en cours a été écrit sans moteur : boutons du pupitre et « Réécouter » à remettre à jour. */
    if (L.eng) setTimeout(function () { if (liveOn(current()) && T.screen === 'chat') R.render(); }, 0);
  }

  function startLive(chat) {
    stopLive();
    R.tts.stopAll();
    askSapi();
    L.chatId = chat.id; L.error = ''; L.phase = 'starting'; L.turns = {};
    delete L.hold[chat.id];
    var turns = arr(chat.turns), last = turns[turns.length - 1];
    var params = paramsOf(chat, false);
    chat.level = params.level;
    var greeting = !turns.length ? GREETING : (last.role === 'user' ? RESUMING : null);
    var eng = null;
    var mine = function () { return L.eng === eng && !!eng; };
    try {
      eng = window.OrganizatorVoice.create({
        container: mountOf(), avatar: { size: 112 }, language: 'en', whisperModel: R.prefs.whisperModel || 'small',
        sensitivity: sensitivity(), keepAudio: true, detail: true, tts: ttsOf(chat), liveAsr: true, bargeIn: bargeIn(),
        conversation: {
          start: {
            mode: 'tutor', model: R.prefs.tutorModel || 'haiku', effort: '', name: 'Tuteur · ' + clean(chat.scenario && chat.scenario.title, 80),
            tutor: { scenario: params.scenario, level: params.level, lang: params.lang, explain: params.explain, lesson: params.lesson, context: tutorContext(chat), history: historyOf(chat, 30) }
          },
          greeting: greeting
        },
        texts: { noiseResume: NOISE },
        onUserUtterance: function (text, info) { return mine() ? liveUser(text, info || {}) : false; },
        onPartial: function (text) { if (mine()) setDraft(text); },
        onUtteranceDetail: function (id, stt, x) { liveDetail(id, stt || {}, x || {}); },
        onSentence: function (text, info) { if (mine()) liveSentence(text, info || {}); },
        onReply: function (r) { if (mine()) liveReply(r || {}); },
        onMeta: function (meta, info) { if (mine()) liveMeta(meta || {}, info || {}); },
        onReplyDone: function (r) { if (mine()) liveDone(r || {}); },
        onInterrupt: function (r) { if (mine()) liveInterrupt(r || {}); },
        onPhase: function (p, info) {
          if (!mine()) return;
          L.phase = String(p || 'listening'); L.phaseText = clean(info && info.text, 200);
          if (L.phase === 'listening' || L.phase === 'user' || L.phase === 'idle') L.caption = '';
          updateStage();
        },
        onNotice: function (n, info) { if (mine()) onNotice(n, info); },
        onError: function (err) { if (mine()) liveError(err); }
      });
    } catch (e) {
      L.error = 'Le moteur vocal n’a pas pu démarrer : ' + (clean(e && e.message, 200) || 'erreur inconnue');
      updateStage();
      return;
    }
    L.eng = eng;
    L.sentAt = Date.now();
    startMeter();
    updateStage();
    var p;
    try { p = eng.start(); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(noop, function (e) {
      if (!mine()) return;
      L.error = 'La conversation n’a pas pu démarrer : ' + (clean(e && e.message, 200) || 'erreur inconnue');
      var dead = L.eng; L.eng = null; stopMeter();
      try { if (dead) dead.destroy(); } catch (err) { /* déjà arrêté */ }
      updateStage();
    });
  }

  /* Les erreurs du moteur : un tour sans réponse se dit dans l'avis (la conversation continue) ;
     une conversation qui n'a pas pu démarrer arrive aussi par l'avis « conversation ». */
  function liveError(err) {
    var kind = err && err.kind, msg = clean((err && (err.message || err.error)) || err, 300) || 'erreur inconnue';
    if (kind === 'conversation') return;
    var label = kind === 'transcribe' ? 'Transcription impossible : ' : (kind === 'reply' ? 'Le tuteur n’a pas pu répondre : ' : '');
    onNotice({ kind: 'turn-error', group: 'turn', text: label + msg + ' Redites votre phrase, ou écrivez-la.' });
    clearTimeout(L.errTimer);
    L.errTimer = setTimeout(function () { onNotice(null, { kind: 'turn' }); }, 9000);
  }

  function resumeLive() {
    var chat = current();
    if (!chat || chat.summary) return;
    L.error = '';
    delete L.hold[chat.id];
    startLive(chat);
    R.render();
  }

  function liveChat() { var c = chatById(L.chatId); return c && !c.summary ? c : null; }
  function liveKey(chat, idx) { return chat.id + ':' + idx; }

  /* La phrase en train d'être dite (transcription en flux) : une bulle « en cours » au bout du fil, tenue
     hors du rendu (comme l'avatar) et mise à jour sur place ; '' l'efface (bruit écarté). Elle se fige
     quand la phrase part : liveUser crée alors la vraie réplique. */
  function draftEl() {
    if (L.draft) return L.draft;
    var el = document.createElement('div');
    el.className = 'rzv-turn is-user is-draft';
    el.innerHTML = '<span class="rzv-ava is-me" aria-hidden="true">Vous</span><div class="rzv-col"><div class="rzv-bubble">'
      + '<div class="rzv-said" lang="en"></div>'
      + '<div class="rzv-umeta"><span class="rzv-umeta-k rzv-live-k"><span class="rzv-dots" aria-hidden="true"><i></i><i></i><i></i></span>en direct</span></div>'
      + '</div></div>';
    L.draft = el;
    return el;
  }
  function placeDraft(host) {
    if (!L.partial) { if (L.draft && L.draft.parentNode) L.draft.parentNode.removeChild(L.draft); return; }
    var thread = (host || document).querySelector('.rzv-s-chat .rzv-thread');
    if (!thread) return;
    var el = draftEl(), fresh = el.parentNode !== thread || thread.lastElementChild !== el;
    var said = el.querySelector('.rzv-said');
    if (said.textContent !== L.partial) said.textContent = L.partial;
    if (fresh) {
      thread.appendChild(el);
      var sec = thread.closest('.rzv-chat');
      if (sec && sec.getBoundingClientRect) {
        var y = window.scrollY + sec.getBoundingClientRect().bottom - window.innerHeight + 24;
        if (y > window.scrollY + 4) { try { window.scrollTo({ top: y, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, y); } }
      }
    }
  }
  function setDraft(text) {
    L.partial = clean(text, 1500);
    if (L.partial && !liveChat()) L.partial = '';
    placeDraft(null);
  }

  function liveUser(text, info) {
    var chat = liveChat();
    text = clean(text, 1500);
    L.partial = '';
    if (!chat || !text) { placeDraft(null); return false; }
    var stt = info.stt || {};
    var turn = {
      role: 'user', text: text, at: Date.now(), recast: null, url: String(info.url || stt.url || ''),
      unsure: unsureWords(stt.words), seconds: round1(info.seconds), wpm: Math.round(num(stt.wpm, 0)), sttMs: Math.round(num(stt.ms, 0)), live: true
    };
    /* Transcription en flux : le texte part tout de suite à Claude ; Whisper mesure ensuite (mots douteux,
       débit, réécoute) et onUtteranceDetail complète cette réplique — son texte, lui, reste celui envoyé. */
    if (info.source === 'stream') turn.src = 'stream';
    if (info.id != null && !info.stt) { L.byId[info.id] = turn; L.waiting.push(turn); }
    chat.turns.push(turn);
    chat.closed = false;
    L.sentAt = Date.now();
    T.newKey = liveKey(chat, chat.turns.length - 1);
    T.toEnd = true;
    R.save();
    R.render();
    return undefined;
  }

  function liveDetail(id, stt, x) {
    var turn = L.byId[id];
    if (!turn) return;
    delete L.byId[id];
    L.waiting = L.waiting.filter(function (t) { return t !== turn; });
    var url = String(x.url || stt.url || '');
    if (url) turn.url = url;
    var unsure = unsureWords(stt.words);
    if (unsure.length || Array.isArray(stt.words)) turn.unsure = unsure;
    if (!(turn.seconds > 0)) turn.seconds = round1(num(stt.duration, 0));
    if (num(stt.wpm, 0) > 0) turn.wpm = Math.round(stt.wpm);
    else if (!turn.wpm && turn.seconds > 0) turn.wpm = Math.round(R.text.count(turn.text) / turn.seconds * 60);
    if (num(stt.ms, 0) > 0) turn.sttMs = Math.round(stt.ms);
    R.save();
    if (R.viewId() === 'tutor') R.render();
  }

  function sendLiveText(chat, text, el) {
    chat.turns.push({ role: 'user', text: text, at: Date.now(), recast: null, url: '', typed: true, live: true });
    chat.closed = false;
    T.newKey = liveKey(chat, chat.turns.length - 1);
    T.draft = '';
    if (el) el.value = '';
    T.focusText = true;
    T.toEnd = true;
    L.sentAt = Date.now();
    try { L.eng.send(text); } catch (e) { L.error = 'Message non envoyé : ' + clean(e && e.message, 200); updateStage(); }
    R.save();
    R.render();
  }

  /* La réplique du tuteur pour un tour du moteur : créée à la première phrase, complétée ensuite. */
  function liveTurn(chat, turn, text) {
    var idx = L.turns[turn];
    if (idx != null && chat.turns[idx]) return idx;
    chat.turns.push({ role: 'tutor', text: text || '', at: Date.now(), recast: null, url: '', fr: '', tip: '', ms: 0, end: false, live: true });
    idx = L.turns[turn] = chat.turns.length - 1;
    T.newKey = liveKey(chat, idx);
    T.toEnd = true;
    return idx;
  }
  function patchLiveText(chat, idx) {
    var t = chat.turns[idx];
    var el = document.querySelector('[data-rzv-live="' + liveKey(chat, idx) + '"]');
    if (el && t) el.innerHTML = sayHtml(t);
  }

  function liveReply(r) {
    var chat = liveChat();
    if (!chat || r.turn == null) return;
    var text = clean(r.full || arr(r.sentences).join(' '), 1500);
    if (!text) return;
    var known = L.turns[r.turn] != null;
    var idx = liveTurn(chat, r.turn, text);
    chat.turns[idx].text = text;
    R.save();
    if (known) patchLiveText(chat, idx); else R.render();
  }

  function liveSentence(text, info) {
    var chat = liveChat();
    L.caption = clean(text, 600);
    updateStage();
    if (!chat || info.turn == null) return;
    var idx = liveTurn(chat, info.turn, clean(text, 1500));
    var t = chat.turns[idx];
    if (!t.ms) { t.ms = Math.max(1, Date.now() - L.sentAt); R.render(); }
  }

  function liveMeta(meta, info) {
    var chat = liveChat();
    if (!chat || info.turn == null || L.turns[info.turn] == null) return;
    var idx = L.turns[info.turn], t = chat.turns[idx];
    t.fr = clean(meta.replyFr, 1800);
    t.tip = clean(meta.tipFr, 400);
    t.end = !!meta.end;
    if (t.end) T.dismissEnd = '';
    applyRecast(chat.turns[idx - 1], meta.recast);
    R.save();
    R.render();
  }

  function liveDone(r) {
    var chat = liveChat();
    L.caption = '';
    updateStage();
    if (!chat || r.turn == null || L.turns[r.turn] == null) return;
    var t = chat.turns[L.turns[r.turn]];
    var full = clean(r.full, 1500);
    if (full) t.text = full;
    if (r.heard != null && !t.cut) { t.cut = true; t.heard = clean(r.heard, 1500); }
    R.save();
    R.render();
  }

  function liveInterrupt(r) {
    var chat = liveChat();
    L.caption = '';
    updateStage();
    if (!chat || r.turn == null || L.turns[r.turn] == null) return;
    var t = chat.turns[L.turns[r.turn]];
    t.cut = true;
    t.heard = clean(r.heard, 1500);
    R.save();
    R.render();
  }

  function liveMute() {
    if (!L.eng) return;
    var m = true;
    try { m = !L.eng.muted(); L.eng.mute(m); } catch (e) { /* moteur arrêté */ }
    L.muted = m;
    updateStage();
    R.render();
  }
  function liveReplay(text) {
    if (!L.eng || !text) return;
    try { L.eng.replay(String(text)); } catch (e) { /* moteur arrêté */ }
  }
  function liveHush() { if (L.eng) try { L.eng.interrupt(); } catch (e) { /* moteur arrêté */ } }

  function setLive(on) {
    var chat = current();
    if (on && !liveAvailable()) { R.toast('Le moteur vocal n’est pas disponible dans cette fenêtre : restez en tour par tour.'); return; }
    R.prefs.tutorLive = !!on;
    R.save();
    R.tts.stopAll();
    if (!on) stopLive();
    else if (chat) { delete L.hold[chat.id]; L.error = ''; }
    R.render();
  }

  /* ══ Cartes ═════════════════════════════════════════════════════════════ */

  /* Cartes : R.cards (srs.js) — addMany(specs, { kind: 'tutor', ref }) → nombre ajouté (doublons écartés). */
  function cardsApi() { return R.cards && typeof R.cards.addMany === 'function' ? R.cards : null; }
  /* Une carte de production par erreur (forme de R.cards.fromEdits : la phrase fautive au recto, la bonne au
     verso, l'explication en note) et une par tournure à réemployer. */
  function cardsOf(chat) {
    var s = chat.summary || { errors: [], phrases: [] };
    var title = clean(chat.scenario && chat.scenario.title, 80);
    var out = s.errors.slice(0, 3).filter(function (e) { return e.said && e.better && R.text.norm(e.said) !== R.text.norm(e.better); }).map(function (e) {
      return { kind: 'error', front: e.said, back: e.better, example: '', audioText: e.better, note: e.explanationFr };
    });
    s.phrases.forEach(function (p) {
      out.push({ kind: 'phrase', front: p, back: 'Tournure à réemployer — ' + title, example: '', audioText: p, note: '' });
    });
    return out;
  }
  function addCards(chat) {
    if (!chat || !chat.summary || chat.cardsAdded) return;
    var cards = cardsOf(chat);
    if (!cards.length) { R.toast('Rien à mettre en cartes dans ce bilan.'); return; }
    var api = cardsApi();
    if (api) {
      var n = 0;
      try { n = num(api.addMany(cards, { kind: 'tutor', ref: chat.id }), 0); } catch (e) { R.toast('Cartes impossibles à créer : ' + (e && e.message)); return; }
      R.toast(n ? plural(n, 'carte ajoutée', 'cartes ajoutées') + ' à vos révisions.' : 'Ces cartes étaient déjà dans vos révisions.');
    } else {
      var t = tutorData();
      t.pendingCards = arr(t.pendingCards).concat(cards.map(function (c) { c.ref = chat.id; return c; })).slice(-200);
      R.toast('Cartes gardées : elles rejoindront vos révisions dès que la vue Cartes sera prête.');
    }
    chat.cardsAdded = true;
    R.save();
    R.render();
  }
  function flushPendingCards() {
    if (!R.isLoaded()) return;
    var t = tutorData(), api = cardsApi();
    if (!api || !arr(t.pendingCards).length) return;
    try {
      t.pendingCards.slice().forEach(function (c) { api.addMany([c], { kind: 'tutor', ref: c.ref || '' }); });
      t.pendingCards = [];
      R.save();
    } catch (e) { if (window.console) console.error('[revizator] tuteur, cartes', e); }
  }

  /* ══ Capsule avant / après ═════════════════════════════════════════════ */

  function capsules() { return arr(R.data.capsules).slice().sort(function (a, b) { return num(a.at, 0) - num(b.at, 0); }); }
  function capUrl(c) { return (c && (c.url || T.blobs['cap:' + c.id])) || ''; }
  function onCapsule(r) {
    var stt = (r && r.stt) || {};
    var audio = (r && r.audio) || {};
    var text = clean(stt.text, 3000);
    if (!text) { T.capNote = 'Aucune parole reconnue : recommencez, un peu plus près du micro.'; return; }
    T.capNote = '';
    var words = R.text.count(text);
    var pauses = arr(stt.pauses);
    var m = {
      seconds: round1(audio.seconds), speechSeconds: round1(stt.speechSeconds), wpm: Math.round(num(stt.wpm, 0)),
      articulationWpm: Math.round(num(stt.articulationWpm, 0)), words: words, pauses: pauses.length,
      longPauses: pauses.filter(function (p) { return num(p && p.seconds, 0) >= 1; }).length, unsure: unsureWords(stt.words).length
    };
    if (!m.wpm && m.seconds) m.wpm = Math.round(words / m.seconds * 60);
    var list = R.data.capsules;
    var just = T.capJust ? list.filter(function (c) { return c && c.id === T.capJust; })[0] : null;
    var cap = { id: just ? just.id : R.uid('cap'), at: Date.now(), prompt: CAPSULE_PROMPT, url: String(stt.url || ''), text: text, metrics: m };
    if (just) list[list.indexOf(just)] = cap; else list.push(cap);
    if (!cap.url && audio.url) T.blobs['cap:' + cap.id] = audio.url;
    T.capJust = cap.id;
    if (!just) R.logSession({ kind: 'tutor', ref: cap.id, title: 'Capsule avant / après', startedAt: Date.now() - Math.round(num(audio.seconds, 60) * 1000) - 30000, endedAt: Date.now(), skillMinutes: { speak: round1(num(audio.seconds, 60) / 60 + 0.5) } });
    R.save();
    R.toast(just ? 'Capsule remplacée par ce nouvel enregistrement.' : 'Capsule enregistrée : rendez-vous dans deux ou trois mois pour comparer.');
  }

  /* ══ Rendu : bulles ═════════════════════════════════════════════════════ */

  /* Une réplique coupée : la partie entendue, puis le reste barré et estompé (comme le mode Conversation). */
  function sayHtml(t) {
    var text = String(t.text || '');
    if (!t.cut) return esc(text);
    var heard = String(t.heard || '');
    var n = 0;
    if (heard && text.indexOf(heard) === 0) n = heard.length;
    else if (heard) {
      var words = R.text.count(heard), re = /\S+\s*/g, m;
      while (words > 0 && (m = re.exec(text))) { n = m.index + m[0].length; words--; }
    }
    var rest = text.slice(n);
    return esc(text.slice(0, n)) + (rest.trim() ? '<span class="rzv-unheard" title="Coupé : vous ne l’avez pas entendu">' + esc(rest) + '</span>' : '');
  }

  function tutorTurnHtml(chat, t, i) {
    var key = sayKey(chat, i), k = chat.id + ':' + i;
    var on = !!T.fr[k];
    var live = liveOn(chat);
    var h = '<div class="rzv-turn is-tutor' + (T.newKey === k ? ' is-new' : '') + (t.cut ? ' is-cut' : '') + '"><span class="rzv-ava" aria-hidden="true">' + esc(initialOf(chat)) + '</span><div class="rzv-col"><div class="rzv-bubble">'
      + '<div class="rzv-who"><span>' + esc(nameOf(chat)) + '</span>' + (t.cut ? '<span class="rzv-cutk" title="Vous lui avez coupé la parole">' + R.icon('cross') + 'coupé</span>' : '')
      + (t.ms ? '<span class="rzv-lat" title="Temps de réponse du tuteur">' + esc(secs(t.ms)) + '</span>' : '') + '</div>'
      + '<div class="rzv-say" data-rz-say="' + esc(key) + '" data-rz-idx="0" data-rzv-live="' + esc(k) + '" lang="en">' + sayHtml(t) + '</div>'
      + (on && t.fr ? '<div class="rzv-fr" lang="fr">' + esc(t.fr) + '</div>' : '')
      + (t.tip ? '<div class="rzv-tip">' + R.icon('spark') + '<span>' + esc(t.tip) + '</span></div>' : '')
      + '<div class="rzv-tools">' + (live
        ? '<button type="button" class="rzv-link" data-act="rz-tutor-replay" data-i="' + i + '" title="Réécouter avec la voix du tuteur">' + R.icon('replay') + 'Réécouter</button>'
        : R.h.player(key, { small: true, speeds: false, label: 'Réécouter', source: function () { return speakTurn(chat, i); } }))
      + (t.fr ? '<button type="button" class="rzv-link" data-act="rz-tutor-tr" data-chat="' + esc(chat.id) + '" data-i="' + i + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + R.icon('lang') + (on ? 'Masquer la traduction' : 'Traduire') + '</button>' : '')
      + '</div></div></div></div>';
    return h;
  }

  function recastHtml(rc) {
    return '<div class="rzv-recast" title="' + esc('Vous avez dit : « ' + rc.said + ' »') + '"><span class="rzv-recast-k">Plus naturel</span>'
      + '<span class="rzv-recast-t" lang="en">' + R.h.diff(rc.said, rc.better) + '</span>'
      + '<button type="button" class="rzv-icon" data-act="rz-tutor-phrase" data-text="' + esc(rc.better) + '" title="Écouter la reformulation" aria-label="Écouter la reformulation">' + R.icon('speak') + '</button></div>';
  }

  function userTurnHtml(chat, t, i) {
    var k = chat.id + ':' + i;
    var url = t.url || T.blobs[k] || '';
    var pkey = 'rzv-u-' + chat.id + '-' + i;
    var meta = t.typed
      ? '<span class="rzv-umeta-k">' + R.icon('pen') + 'écrit</span>'
      : '<span class="rzv-umeta-k">' + R.icon('mic') + esc(clock(t.seconds)) + (t.wpm ? ' · ' + esc(t.wpm) + ' mots/min' : '') + '</span>'
        + (t.sttMs ? '<span class="rzv-lat" title="Temps de transcription (Whisper, sur ce poste)">' + (t.src === 'stream' ? 'mesuré en ' : 'transcrit en ') + esc(secs(t.sttMs)) + '</span>' : '')
        + (L.waiting.indexOf(t) >= 0 ? '<span class="rzv-lat is-wait" title="Whisper mesure votre phrase (mots douteux, débit) : la réponse n’attend pas">' + R.icon('mic') + 'mesure…</span>' : '');
    return '<div class="rzv-turn is-user' + (T.newKey === k ? ' is-new' : '') + '"><span class="rzv-ava is-me" aria-hidden="true">Vous</span><div class="rzv-col"><div class="rzv-bubble">'
      + '<div class="rzv-said" lang="en">' + markUnsure(t.text, t.unsure) + '</div>'
      + '<div class="rzv-umeta">' + meta + (url ? R.h.player(pkey, { small: true, speeds: false, label: 'Me réécouter', source: function () { return R.audio(url, { key: pkey }); } }) : '') + '</div>'
      + '</div>' + (t.recast && t.recast.better ? recastHtml(t.recast) : '') + '</div></div>';
  }

  function turnsHtml(chat) {
    return arr(chat.turns).map(function (t, i) { return t.role === 'tutor' ? tutorTurnHtml(chat, t, i) : userTurnHtml(chat, t, i); }).join('');
  }

  function waitHtml(chat, p) {
    return '<div class="rzv-turn is-tutor is-wait"><span class="rzv-ava" aria-hidden="true">' + esc(initialOf(chat)) + '</span><div class="rzv-col"><div class="rzv-bubble">'
      + '<div class="rzv-wait"><span class="rzv-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>' + (p.preparing ? 'Le tuteur arrive…' : 'Le tuteur réfléchit…') + '</span>'
      + '<span class="rzv-wait-t" data-rzv-wait>' + esc(secs(Date.now() - p.startedAt)) + '</span></div>'
      + '<button type="button" class="rzv-link" data-act="rz-tutor-cancel">' + R.icon('cross') + 'Annuler</button></div></div></div>';
  }

  /* Une réponse qui n'est pas venue (échec, annulation, page rechargée) : la réplique de l'apprenant reste,
     on peut réessayer ou la reprendre au clavier. */
  function stuckHtml(chat, err) {
    var turns = arr(chat.turns);
    var lastUser = turns.length && turns[turns.length - 1].role === 'user';
    var msg = err ? (err.cancelled ? 'Réponse annulée.' : 'Le tuteur n’a pas pu répondre : ' + err.message + '.')
      : (turns.length ? 'La réponse du tuteur a été interrompue.' : 'Le tuteur n’a pas encore ouvert la conversation.');
    return '<div class="rzv-turn is-tutor is-error"><span class="rzv-ava" aria-hidden="true">!</span><div class="rzv-col"><div class="rzv-bubble">'
      + '<div class="rzv-err-t">' + esc(msg) + '</div>' + (lastUser ? '<div class="rzv-err-sub">Votre réplique est gardée.</div>' : '')
      + '<div class="rz-row"><button type="button" class="btn btn-primary" data-act="rz-tutor-retry">' + R.icon('replay') + ' Réessayer</button>'
      + (lastUser ? '<button type="button" class="btn btn-secondary" data-act="rz-tutor-withdraw">' + R.icon('pen') + ' Modifier ma réplique</button>' : '')
      + '</div></div></div></div>';
  }

  /* ══ Rendu : écrans ═════════════════════════════════════════════════════ */

  function scCardHtml(sc, i, lesson) {
    var news = '';
    if (sc.id === 'news') {
      news = '<div class="rzv-sc-news">' + (lesson ? R.icon('book') + '<span>D’après votre cours : « ' + esc(lesson.title) + ' »</span>' : R.icon('globe') + '<span>D’après les titres du jour</span>') + '</div>';
    }
    var vars = arr(sc.variants).length ? '<div class="rzv-sc-vars">' + sc.variants.map(function (v) {
      return '<button type="button" class="rz-chip" data-act="rz-tutor-start" data-id="' + esc(sc.id) + '" data-variant="' + esc(v.id) + '" title="' + esc('Seulement la scène : ' + v.label) + '">' + esc(v.label) + '</button>';
    }).join('') + '</div>' : '';
    return '<div class="rzv-sc' + (sc.id === 'news' && lesson ? ' is-featured' : '') + '" data-act="rz-tutor-start" data-id="' + esc(sc.id) + '" role="button" tabindex="0" aria-label="' + esc('Commencer : ' + sc.title) + '">'
      + '<div class="rzv-sc-top"><span class="rzv-ic rzv-hue-' + esc(sc.hue) + '">' + R.icon(sc.icon) + '</span><span class="rz-kbd" title="Raccourci clavier">' + (i + 1) + '</span></div>'
      + '<div class="rzv-sc-title">' + esc(sc.title) + '</div>'
      + '<div class="rzv-sc-role">Avec <b>' + esc(sc.name) + '</b>, ' + esc(sc.roleFr) + '.</div>'
      + '<div class="rzv-sc-goal">' + esc(sc.goalFr) + '</div>' + news + vars
      + '<div class="rzv-sc-foot"><span class="rzv-sc-min">' + R.icon('clock') + esc(sc.minutes) + '</span><span class="rzv-sc-go">Commencer ' + R.icon('arrow') + '</span></div></div>';
  }

  /* La conversation en français, tous sujets : le mode Conversation plein écran (voice.js). */
  function frCardHtml() {
    return '<div class="rzv-sc is-fr" data-act="rz-tutor-fr" role="button" tabindex="0" aria-label="Ouvrir la conversation en français, tous sujets">'
      + '<div class="rzv-sc-top"><span class="rzv-ic rzv-hue-lang">' + R.icon('chat') + '</span><span class="rzv-fr-tag" lang="fr">FR</span></div>'
      + '<div class="rzv-sc-title">Conversation en français · tous sujets</div>'
      + '<div class="rzv-sc-role">Un interlocuteur à avatar, en français : actualité, sciences, culture, débat, organisation…</div>'
      + '<div class="rzv-sc-goal">Mains libres, plein écran, sans bilan : pour réfléchir à voix haute ou souffler entre deux séances.</div>'
      + '<div class="rzv-sc-foot"><span class="rzv-sc-min">' + R.icon('mic') + 'Plein écran</span><span class="rzv-sc-go">Ouvrir ' + R.icon('arrow') + '</span></div></div>';
  }

  function headHtml(kicker, title, lead, side) {
    return '<div class="rzv-head"><div class="rzv-head-main"><div class="rz-kicker">' + kicker + '</div><h2 class="rzv-h2">' + esc(title) + '</h2>'
      + (lead ? '<p class="rzv-lead">' + lead + '</p>' : '') + '</div>' + (side ? '<div class="rzv-head-side">' + side + '</div>' : '') + '</div>';
  }

  function resumeHtml(c) {
    var n = userTurns(c).length;
    return '<div class="rz-callout is-accent rzv-resume"><div class="rzv-resume-t">' + R.icon('chat') + '<span><b>Conversation en cours</b> — ' + esc(c.scenario.title) + ' · ' + esc(plural(n, 'réplique')) + ' · ' + esc(ago(lastAt(c))) + '</span></div>'
      + '<div class="rz-row"><button type="button" class="btn btn-primary" data-act="rz-tutor-resume" data-id="' + esc(c.id) + '">Reprendre ' + R.icon('arrow') + '</button>'
      + '<button type="button" class="btn btn-secondary" data-act="rz-tutor-endid" data-id="' + esc(c.id) + '">Terminer et voir le bilan</button></div></div>';
  }

  function pickHtml() {
    var lv = R.level('speak');
    var lesson = todayLesson();
    var nChats = talked().length;
    var side = R.h.level(lv.band, 'Oral')
      + '<button type="button" class="btn btn-secondary" data-act="rz-tutor-history">' + R.icon('clock') + ' Historique' + (nChats ? ' · ' + nChats : '') + '</button>'
      + '<button type="button" class="btn btn-secondary" data-act="rz-tutor-capsule">' + R.icon('speak') + ' Capsule avant / après</button>';
    var h = [headHtml(R.icon('chat') + ' Tuteur · anglais oral', 'Parler avec le tuteur',
      'Vous parlez, il vous répond à voix haute, reformule discrètement vos phrases et vous relance. À la fin, un bilan : trois erreurs, trois tournures à réemployer, votre niveau.', side)];
    var rc = lastResumable();
    if (rc) h.push(resumeHtml(rc));
    h.push('<div class="rzv-pick"><div class="rzv-scs" role="list">' + SCENARIOS.map(function (sc, i) { return scCardHtml(sc, i, lesson); }).join('') + frCardHtml() + '</div>');
    h.push('<aside class="rzv-pick-side">' + knowHtml(lesson) + capTeaserHtml() + recentHtml() + '</aside></div>');
    return h.join('');
  }

  function knowHtml(lesson) {
    return '<section class="rz-card rzv-know"><div class="rz-card-head"><span class="rz-card-title">Bon à savoir</span></div><ul class="rzv-tips">'
      + '<li>Il ne vous coupe pas pour corriger : une reformulation discrète apparaît sous votre phrase, et le bilan reprend l’essentiel.</li>'
      + '<li>Demandez-lui, en français ou en anglais : « quel est le cours d’aujourd’hui ? » — ' + (lesson ? 'il connaît « ' + esc(lesson.title) + ' ».' : 'pas encore de cours aujourd’hui.') + '</li>'
      + (liveMode()
        ? '<li>Mains libres : parlez quand vous voulez, il vous écoute en continu ; coupez-lui la parole, il s’arrête. <span class="rz-kbd">Espace</span> le fait taire, <span class="rz-kbd">M</span> coupe le micro.</li>'
        : '<li><span class="rz-kbd">Espace</span> pour parler, encore pour terminer ; « Écrire plutôt » quand vous ne pouvez pas parler.</li>')
      + '<li>Le son reste sur ce poste (Whisper) ; seule la transcription part vers le tuteur.</li></ul></section>';
  }

  function capTeaserHtml() {
    var caps = capsules();
    var last = caps[caps.length - 1];
    var body = !caps.length
      ? 'Une minute pour vous présenter, la même consigne tous les deux ou trois mois : en réécoutant la première et la dernière, vous entendez vos progrès.'
      : plural(caps.length, 'capsule') + ', la dernière ' + ago(last.at) + '. ' + (Date.now() - last.at >= CAP_EVERY_DAYS * 86400000 ? 'C’est le moment d’en enregistrer une nouvelle.' : 'Prochaine conseillée à partir du ' + dayLong(last.at + CAP_EVERY_DAYS * 86400000) + '.');
    return '<section class="rz-card rzv-capteaser"><div class="rz-card-head"><span class="rz-card-title">Capsule avant / après</span></div>'
      + '<p class="rzv-p">' + esc(body) + '</p>'
      + '<div><button type="button" class="btn btn-secondary" data-act="rz-tutor-capsule">' + R.icon('mic') + (caps.length ? ' Voir et comparer' : ' Enregistrer ma première capsule') + '</button></div></section>';
  }

  function recentHtml() {
    var l = talked().slice(0, 3);
    if (!l.length) return '';
    return '<section class="rz-card rzv-recent"><div class="rz-card-head"><span class="rz-card-title">Dernières conversations</span></div>'
      + l.map(function (c) { return histRowHtml(c, true); }).join('')
      + '<div class="rz-card-foot"><button type="button" class="btn btn-ghost" data-act="rz-tutor-history">Tout l’historique ' + R.icon('arrow') + '</button></div></section>';
  }

  function histRowHtml(c, compact) {
    var sc = scOf(c);
    var n = userTurns(c).length;
    var lv = c.summary && c.summary.levelEstimate;
    var status = c.summary ? '' : (resumable(c) ? ' · en cours' : ' · sans bilan');
    return '<div class="rzv-hrow"><span class="rzv-ic rzv-hue-' + esc(sc.hue) + '">' + R.icon(sc.icon) + '</span>'
      + '<div class="rzv-hrow-main"><div class="rzv-hrow-t">' + esc(c.scenario.title) + '</div><div class="rzv-hrow-s">' + esc(ago(lastAt(c)) + ' · ' + plural(n, 'réplique') + (compact ? '' : ' · ' + statsOf(c).minutes + ' min') + status) + '</div></div>'
      + (lv ? R.h.level(lv) : '')
      + (resumable(c) ? '<button type="button" class="btn btn-secondary" data-act="rz-tutor-resume" data-id="' + esc(c.id) + '">Reprendre</button>' : '')
      + '<button type="button" class="btn btn-ghost" data-act="rz-tutor-open" data-id="' + esc(c.id) + '">Rouvrir</button></div>';
  }

  function micBlocked(chat) {
    var ph = R.recState(REC_KEY).phase;
    if (ph === 'recording' || ph === 'starting' || ph === 'processing') return false;
    return !!T.pending || !chat || !!chat.summary || R.rec.busy();
  }

  function modesHtml(live, p) {
    var rec = R.recState(REC_KEY).phase;
    var lock = !!p || rec === 'recording' || rec === 'starting' || rec === 'processing';
    var can = liveAvailable();
    var btn = function (on, mode, label, title, dis) {
      return '<button type="button" class="' + (on ? 'on' : '') + '" data-act="rz-tutor-mode" data-mode="' + mode + '" aria-pressed="' + (on ? 'true' : 'false') + '" title="' + esc(title) + '"' + (dis ? ' disabled' : '') + '>' + label + '</button>';
    };
    return '<div class="rzv-modes" role="group" aria-label="Façon de converser">'
      + btn(live, 'live', R.icon('mic') + 'Mains libres', can ? 'Il écoute en continu ; vous pouvez lui couper la parole' : 'Moteur vocal indisponible dans cette fenêtre', !can || (lock && !live))
      + btn(!live, 'turn', R.icon('chat') + 'Tour par tour', 'Espace pour parler, encore pour terminer', lock && !live)
      + '</div>';
  }

  function liveDockHtml(chat, endBar) {
    var muted = L.muted;
    var hint = '<span class="rzv-live-hint">Parlez quand vous voulez, il vous écoute · <span class="rz-kbd">Espace</span> le faire taire · <span class="rz-kbd">M</span> micro · <span class="rz-kbd">R</span> réécouter · <span class="rz-kbd">T</span> traduire · <span class="rz-kbd">Échap</span> sortir</span>';
    return '<div class="rzv-dock is-live">' + endBar
      + '<div class="rzv-dock-row">' + modesHtml(true, null)
      + '<div class="rzv-live-ctl">'
      + '<button type="button" class="btn btn-secondary" data-act="rz-tutor-hush" title="Faire taire le tuteur (Espace)"' + (L.eng ? '' : ' disabled') + '>' + R.icon('stop') + ' Faire taire</button>'
      + '<button type="button" class="btn ' + (muted ? 'btn-primary' : 'btn-secondary') + ' rzv-mute" data-act="rz-tutor-mute" aria-pressed="' + (muted ? 'true' : 'false') + '" title="' + (muted ? 'Rouvrir le micro (M)' : 'Couper le micro (M)') + '"' + (L.eng ? '' : ' disabled') + '>' + R.icon('mic') + (muted ? ' Micro coupé' : ' Micro ouvert') + '</button>'
      + '</div></div>'
      + '<div class="rzv-hint">' + hint + '</div>'
      + '<div class="rzv-write"><input class="input" type="text" data-role="rz-tutor-text" data-focus-key="rzv-text" placeholder="Écrire plutôt… (Entrée envoie)" maxlength="1000" lang="en" autocomplete="off" value="' + esc(T.draft) + '">'
      + '<button type="button" class="btn btn-secondary" data-act="rz-tutor-send"' + (L.eng ? '' : ' disabled') + '>' + R.icon('arrow') + ' Envoyer</button></div></div>';
  }

  function dockHtml(chat, p, err) {
    if (p && p.end) {
      return '<div class="rzv-dock is-ending"><div class="rzv-ending"><span class="rz-spin"></span><span>Le tuteur prépare votre bilan…</span><span class="rzv-wait-t" data-rzv-wait>' + esc(secs(Date.now() - p.startedAt)) + '</span></div>'
        + '<button type="button" class="btn btn-ghost" data-act="rz-tutor-cancel">Annuler</button></div>';
    }
    if (err && err.end) {
      return '<div class="rzv-dock is-ending"><div class="rzv-err-t">Le bilan n’a pas pu être préparé : ' + esc(err.message) + '.</div>'
        + '<div class="rz-row rzv-center"><button type="button" class="btn btn-primary" data-act="rz-tutor-retry">' + R.icon('replay') + ' Réessayer</button>'
        + '<button type="button" class="btn btn-secondary" data-act="rz-tutor-continue">Continuer la conversation</button>'
        + '<button type="button" class="btn btn-ghost" data-act="rz-tutor-quit">Quitter sans bilan</button></div></div>';
    }
    var ph = R.recState(REC_KEY).phase;
    var mine = ph === 'recording' || ph === 'starting' || ph === 'processing';
    var busy = !mine && R.rec.busy();
    var blocked = micBlocked(chat);
    var turns = arr(chat.turns), lt = turns[turns.length - 1];
    var endBar = !p && lt && lt.role === 'tutor' && lt.end && T.dismissEnd !== chat.id
      ? '<div class="rzv-endbar">' + R.icon('flag') + '<span>' + esc(nameOf(chat)) + ' propose de conclure.</span><button type="button" class="btn btn-primary" data-act="rz-tutor-end">Terminer et voir le bilan</button><button type="button" class="btn btn-ghost" data-act="rz-tutor-dismiss">Continuer</button></div>' : '';
    if (liveMode() && (!p || p.preparing)) return liveDockHtml(chat, endBar);
    var hint = busy ? esc('Le micro est pris par une autre prise de son (dictée, exercice) : terminez-la, ou écrivez plutôt.')
      : (p ? esc('Le tuteur réfléchit… Vous pourrez répondre dès qu’il aura parlé.')
        : (T.micNote ? esc(T.micNote) : '<span class="rz-kbd">Espace</span> pour parler, encore pour terminer · 90 s au plus · <span class="rz-kbd">R</span> réécouter · <span class="rz-kbd">T</span> traduire'));
    return '<div class="rzv-dock">' + endBar + modesHtml(false, p)
      + '<div class="rzv-mic' + (blocked ? ' is-blocked' : '') + '">' + R.h.rec(REC_KEY, { maxMs: REC_MAX_MS, label: 'Parler', againLabel: 'Parler', stt: { keep: true }, disabled: blocked, onStart: onRecStart, onResult: onVoice }) + '</div>'
      + '<div class="rzv-hint' + (busy || T.micNote ? ' is-warn' : '') + '">' + hint + '</div>'
      + '<div class="rzv-write"><input class="input" type="text" data-role="rz-tutor-text" data-focus-key="rzv-text" placeholder="Écrire plutôt… (Entrée envoie)" maxlength="1000" lang="en" autocomplete="off" value="' + esc(T.draft) + '">'
      + '<button type="button" class="btn btn-secondary" data-act="rz-tutor-send"' + (p ? ' disabled' : '') + '>' + R.icon('arrow') + ' Envoyer</button></div></div>';
  }

  function asideHtml(chat) {
    var sc = scOf(chat), va = variantOf(chat.scenario.id);
    var ms = arr(chat.turns).filter(function (t) { return t.role === 'tutor' && t.ms; }).map(function (t) { return t.ms; });
    var avg = ms.length ? ms.reduce(function (a, b) { return a + b; }, 0) / ms.length : 0;
    return '<aside class="rzv-aside">'
      + '<section class="rz-card rzv-brief"><div class="rz-kicker">' + R.icon('target') + ' Votre objectif</div><p class="rzv-p">' + esc(sc.goalFr) + '</p>'
      + '<div class="rzv-brief-role">Avec <b>' + esc(nameOf(chat)) + '</b>, ' + esc(va && va.roleFr ? va.roleFr : sc.roleFr) + '.</div>'
      + (chat.lesson ? '<div class="rzv-brief-lesson">' + R.icon('book') + '<span>Cours du jour : « ' + esc(chat.lesson.title) + ' »</span></div>' : '') + '</section>'
      + '<section class="rz-card rzv-phr"><div class="rz-kicker">' + R.icon('spark') + ' Pour vous lancer</div><div class="rzv-phrases">'
      + sc.phrases.map(function (ph) { return '<button type="button" class="rz-phrase rzv-phrase" data-act="rz-tutor-phrase" data-text="' + esc(ph) + '" title="Écouter" lang="en">' + R.icon('speak') + esc(ph) + '</button>'; }).join('')
      + '</div></section>'
      + '<section class="rz-card rzv-opts">' + (liveMode()
        ? '<div class="rzv-note">Mains libres : le micro reste ouvert pendant la conversation ; le son est transcrit sur ce poste (en direct avec Parakeet v3, sinon Whisper), seule la transcription part vers le tuteur. Sensibilité du micro, coupure de parole et transcription en direct se règlent dans ⚙ › Révizator.</div>'
        : '<label class="rzv-toggle"><input type="checkbox" data-role="rz-tutor-voice"' + (tutorData().voiceOff ? '' : ' checked') + '><span>Lire les réponses à voix haute</span></label>')
      + '<div class="rzv-note">Whisper peut lisser vos fautes : la transcription montre ce qu’il a compris ; les mots soulignés sont ceux dont il doute.</div>'
      + (avg ? '<div class="rzv-note">Temps de réponse moyen du tuteur : ' + esc(secs(avg)) + '.</div>' : '') + '</section>'
      + '</aside>';
  }

  function chatHtml(chat) {
    var sc = scOf(chat);
    var n = userTurns(chat).length;
    var p = T.pending && T.pending.chatId === chat.id ? T.pending : null;
    var err = T.error && T.error.chatId === chat.id ? T.error : null;
    var turns = arr(chat.turns);
    var live = liveMode() && !(p && p.end) && !(err && err.end);
    var stuck = !live && !p && (err ? !err.end : (!turns.length || turns[turns.length - 1].role === 'user'));
    var h = [];
    h.push('<div class="rzv-chathead"><button type="button" class="btn btn-ghost rzv-back" data-act="rz-tutor-back" title="Revenir aux scénarios (Échap) : la conversation reste ouverte">' + R.icon('back') + ' Scénarios</button>'
      + '<div class="rzv-chathead-t"><span class="rzv-ic rzv-hue-' + esc(sc.hue) + '">' + R.icon(sc.icon) + '</span><div><div class="rzv-chat-title">' + esc(chat.scenario.title) + '</div>'
      + '<div class="rzv-chat-sub">Avec ' + esc(nameOf(chat)) + ' · ' + esc(plural(n, 'réplique')) + ' · niveau visé ' + esc(chat.level || speakLevel()) + '</div></div></div>'
      + '<div class="rzv-chathead-r">' + (n ? '<button type="button" class="btn btn-secondary" data-act="rz-tutor-end"' + (p && p.end ? ' disabled' : '') + '>' + R.icon('check') + ' Terminer</button>'
        : '<button type="button" class="btn btn-secondary" data-act="rz-tutor-quit">Quitter</button>') + '</div></div>');
    h.push('<div class="rzv-layout"><section class="rzv-chat' + (live ? ' is-live' : '') + '">');
    if (live) h.push('<div class="rzv-live-slot" data-rzv-slot></div>');
    h.push('<div class="rzv-thread" aria-live="polite">' + turnsHtml(chat)
      + (p && !p.end ? waitHtml(chat, p) : '') + (stuck ? stuckHtml(chat, err) : '')
      + (live && !p && !turns.length ? '<div class="rzv-live-empty">' + esc(nameOf(chat)) + ' ouvre la conversation. Répondez à voix haute quand vous voulez — et coupez-lui la parole si besoin : il s’arrête et vous écoute.</div>' : '')
      + '</div>');
    h.push(dockHtml(chat, p, err));
    h.push('</section>' + asideHtml(chat) + '</div>');
    return h.join('');
  }

  function summaryBodyHtml(chat, compact) {
    var s = chat.summary;
    var errs = s.errors.slice(0, 3), more = s.errors.slice(3), phrases = s.phrases;
    var words = ['', 'Une erreur', 'Deux erreurs', 'Trois erreurs'];
    var errHtml = function (e) {
      return '<li><div class="rz-fb-pair"><span class="rz-fb-orig" lang="en">' + esc(e.said) + '</span>' + R.icon('arrow') + '<span class="rz-fb-corr" lang="en">' + esc(e.better) + '</span>'
        + '<button type="button" class="rzv-icon" data-act="rz-tutor-phrase" data-text="' + esc(e.better) + '" title="Écouter la bonne version" aria-label="Écouter la bonne version">' + R.icon('speak') + '</button></div>'
        + '<div class="rz-fb-why">' + esc(e.explanationFr) + ' <span class="rz-cat">' + esc(R.categoryLabel(e.category)) + '</span></div></li>';
    };
    var h = [];
    if (s.feedbackFr) h.push('<div class="rz-callout is-accent rzv-feedback">' + esc(s.feedbackFr) + '</div>');
    h.push('<div class="rzv-sumgrid"><section class="rz-card rzv-errs"><div class="rz-card-head"><span class="rz-card-title">' + esc(errs.length ? words[errs.length] + ' à retenir' : 'Erreurs') + '</span>'
      + (errs.length ? '<span class="rz-card-meta">notées dans votre journal</span>' : '') + '</div>'
      + (errs.length ? '<ol class="rzv-errlist">' + errs.map(errHtml).join('') + '</ol>' : '<div class="rz-fb-none">' + R.icon('check') + ' Aucune erreur relevée : bravo.</div>')
      + (more.length ? '<details class="rz-fb-more rzv-more"><summary>' + esc(more.length > 1 ? more.length + ' autres erreurs relevées' : 'Une autre erreur relevée') + '</summary><ol class="rzv-errlist" start="4">' + more.map(errHtml).join('') + '</ol></details>' : '')
      + (errs.length && !compact ? '<div class="rz-card-foot">Redites chaque phrase corrigée à voix haute, juste après l’avoir écoutée.</div>' : '') + '</section>');
    h.push('<section class="rz-card rzv-phrs"><div class="rz-card-head"><span class="rz-card-title">Tournures à réemployer</span></div>'
      + (phrases.length ? '<ul class="rzv-phrlist">' + phrases.map(function (p) {
        return '<li><button type="button" class="rzv-icon" data-act="rz-tutor-phrase" data-text="' + esc(p) + '" title="Écouter" aria-label="Écouter">' + R.icon('speak') + '</button><span lang="en">' + esc(p) + '</span></li>';
      }).join('') + '</ul>' : '<div class="rz-muted">Aucune tournure proposée.</div>')
      + (!compact ? '<div class="rz-card-foot">Placez-les dans votre prochaine conversation : c’est en les réemployant qu’elles restent.</div>' : '') + '</section></div>');
    return h.join('');
  }

  function cardsBtnHtml(chat) {
    var n = cardsOf(chat).length;
    if (!n) return '';
    return chat.cardsAdded
      ? '<button type="button" class="btn btn-secondary" disabled>' + R.icon('check') + ' Cartes ajoutées</button>'
      : '<button type="button" class="btn btn-primary rz-big" data-act="rz-tutor-cards" data-id="' + esc(chat.id) + '">' + R.icon('cards') + ' Mettre en cartes · ' + n + '</button>';
  }

  function summaryHtml(chat) {
    var s = chat.summary;
    var st = statsOf(chat);
    var lt = lastTutorIdx(chat);
    var h = [];
    h.push('<div class="rzv-subhead"><button type="button" class="btn btn-ghost rzv-back" data-act="rz-tutor-pick">' + R.icon('back') + ' Scénarios</button></div>');
    h.push(headHtml(R.icon('flag') + ' Bilan · ' + esc(chat.scenario.title), 'Bilan de la conversation',
      esc('Avec ' + nameOf(chat) + ', ' + ago(chat.endedAt || lastAt(chat)) + '.'), s.levelEstimate ? R.h.level(s.levelEstimate, 'Niveau de cette conversation') : ''));
    h.push('<div class="rzv-stats">'
      + statHtml(st.minutes, 'min de conversation') + statHtml(st.turns, st.turns > 1 ? 'répliques' : 'réplique')
      + statHtml(st.words, 'mots de votre part') + (st.wpm ? statHtml(st.wpm, 'mots/min à l’oral') : statHtml(st.typed, st.typed > 1 ? 'répliques écrites' : 'réplique écrite')) + '</div>');
    if (lt >= 0) {
      var t = chat.turns[lt];
      h.push('<div class="rzv-lastword"><span class="rzv-ava" aria-hidden="true">' + esc(initialOf(chat)) + '</span><span class="rzv-say" data-rz-say="' + esc(sayKey(chat, lt)) + '" data-rz-idx="0" lang="en">' + esc(t.text) + '</span>'
        + R.h.player(sayKey(chat, lt), { small: true, speeds: false, label: 'Écouter', source: function () { return speakTurn(chat, lt); } }) + '</div>');
    }
    h.push(summaryBodyHtml(chat, false));
    h.push('<div class="rzv-actions">' + cardsBtnHtml(chat)
      + '<button type="button" class="btn btn-secondary" data-act="rz-tutor-start" data-id="' + esc(String(chat.scenario.id).split(':')[0]) + '"' + (variantOf(chat.scenario.id) ? ' data-variant="' + esc(variantOf(chat.scenario.id).id) + '"' : '') + '>' + R.icon('replay') + ' Refaire ce scénario</button>'
      + '<button type="button" class="btn btn-secondary" data-act="rz-tutor-open" data-id="' + esc(chat.id) + '">' + R.icon('read') + ' Revoir la conversation</button>'
      + '<button type="button" class="btn btn-ghost" data-act="rz-tutor-pick">Autre scénario ' + R.icon('arrow') + '</button></div>');
    if (!cardsApi() && arr(tutorData().pendingCards).length) h.push('<div class="rz-muted rzv-pendnote">' + esc(plural(tutorData().pendingCards.length, 'carte gardée', 'cartes gardées') + ' en attente : elles rejoindront vos révisions dès que la vue Cartes sera prête.') + '</div>');
    return h.join('');
  }

  function statHtml(v, label) { return '<div class="rzv-stat"><b>' + esc(v) + '</b><span>' + esc(label) + '</span></div>'; }

  function historyHtml() {
    var l = talked();
    var h = ['<div class="rzv-subhead"><button type="button" class="btn btn-ghost rzv-back" data-act="rz-tutor-pick">' + R.icon('back') + ' Scénarios</button></div>'];
    h.push(headHtml(R.icon('clock') + ' Tuteur · historique', 'Vos conversations', esc('Les 30 dernières sont gardées sur ce poste, avec vos enregistrements : rouvrez-en une pour la relire et vous réécouter.'), ''));
    if (!l.length) {
      h.push(R.h.empty('Aucune conversation pour l’instant', 'Choisissez un scénario : le tuteur ouvre la conversation, vous n’avez qu’à répondre.',
        '<button type="button" class="btn btn-primary" data-act="rz-tutor-pick">Choisir un scénario</button>'));
      return h.join('');
    }
    h.push('<section class="rz-card rzv-hist">' + l.map(function (c) { return histRowHtml(c, false); }).join('') + '</section>');
    return h.join('');
  }

  function openHtml(chat) {
    var h = ['<div class="rzv-subhead"><button type="button" class="btn btn-ghost rzv-back" data-act="rz-tutor-history">' + R.icon('back') + ' Historique</button></div>'];
    h.push(headHtml(R.icon('read') + ' Tuteur · ' + esc(chat.scenario.title), 'Conversation du ' + new Date(chat.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }),
      esc('Avec ' + nameOf(chat) + ' · ' + plural(userTurns(chat).length, 'réplique') + ' · ' + statsOf(chat).minutes + ' min'),
      chat.summary && chat.summary.levelEstimate ? R.h.level(chat.summary.levelEstimate, 'Niveau') : ''));
    if (resumable(chat)) {
      h.push('<div class="rz-callout is-accent rzv-resume"><div class="rzv-resume-t">' + R.icon('chat') + '<span>Cette conversation n’est pas terminée.</span></div><div class="rz-row">'
        + '<button type="button" class="btn btn-primary" data-act="rz-tutor-resume" data-id="' + esc(chat.id) + '">Reprendre ' + R.icon('arrow') + '</button>'
        + '<button type="button" class="btn btn-secondary" data-act="rz-tutor-endid" data-id="' + esc(chat.id) + '">Terminer et voir le bilan</button></div></div>');
    } else if (!chat.summary && userTurns(chat).length) {
      h.push('<div class="rz-callout rzv-resume"><div class="rzv-resume-t">' + R.icon('flag') + '<span>Conversation close sans bilan.</span></div><div class="rz-row">'
        + '<button type="button" class="btn btn-primary" data-act="rz-tutor-endid" data-id="' + esc(chat.id) + '">Faire le bilan</button></div></div>');
    }
    if (chat.summary) h.push(summaryBodyHtml(chat, true) + '<div class="rzv-actions">' + cardsBtnHtml(chat) + '</div>');
    h.push('<section class="rzv-chat is-static"><div class="rzv-thread is-static">' + turnsHtml(chat) + '</div></section>');
    return h.join('');
  }

  function capMetricsHtml(c, ref) {
    var m = c.metrics || {};
    var row = function (label, v, unit, delta, better) {
      var d = '';
      if (ref && delta != null && delta !== 0) d = '<span class="rzv-delta ' + ((better > 0) === (delta > 0) ? 'is-good' : 'is-bad') + '">' + (delta > 0 ? '+' : '−') + esc(Math.abs(delta)) + '</span>';
      return '<div class="rzv-mrow"><span>' + esc(label) + '</span><b>' + esc(v) + (unit ? ' ' + esc(unit) : '') + '</b>' + d + '</div>';
    };
    var r = ref ? (ref.metrics || {}) : null;
    return '<div class="rzv-metrics">'
      + row('Durée', clock(m.seconds), '', null)
      + row('Débit', num(m.wpm, 0), 'mots/min', r ? num(m.wpm, 0) - num(r.wpm, 0) : null, 1)
      + row('Mots', num(m.words, 0), '', r ? num(m.words, 0) - num(r.words, 0) : null, 1)
      + row('Pauses d’une seconde ou plus', num(m.longPauses, 0), '', r ? num(m.longPauses, 0) - num(r.longPauses, 0) : null, -1)
      + row('Mots peu sûrs', num(m.unsure, 0), '', r ? num(m.unsure, 0) - num(r.unsure, 0) : null, -1)
      + '</div>';
  }

  function capColHtml(c, label, ref) {
    var url = capUrl(c), key = 'rzv-cap-' + c.id;
    return '<section class="rz-card rzv-capcol"><div class="rz-card-head"><span class="rz-card-title">' + esc(label) + '</span><span class="rz-card-meta">' + esc(dayLong(c.at)) + '</span></div>'
      + (url ? R.h.player(key, { small: true, speeds: false, label: 'Réécouter', source: function () { return R.audio(url, { key: key }); } }) : '<div class="rz-muted">Enregistrement indisponible sur ce poste.</div>')
      + capMetricsHtml(c, ref)
      + (c.text ? '<details class="rz-fb-more"><summary>Ce que Whisper a compris</summary><p class="rzv-captext" lang="en">' + esc(c.text) + '</p></details>' : '') + '</section>';
  }

  function capsuleHtml() {
    var caps = capsules();
    var first = caps[0], last = caps[caps.length - 1];
    var just = T.capJust ? caps.filter(function (c) { return c.id === T.capJust; })[0] : null;
    var h = ['<div class="rzv-subhead"><button type="button" class="btn btn-ghost rzv-back" data-act="rz-tutor-pick">' + R.icon('back') + ' Scénarios</button></div>'];
    h.push(headHtml(R.icon('mic') + ' Tuteur · capsule', 'Capsule avant / après',
      esc('Tous les deux à trois mois, la même consigne, une minute. En réécoutant la première et la dernière côte à côte, vous entendez ce qui a changé : le débit, les hésitations, l’aisance.'), ''));
    var due = !last || Date.now() - last.at >= CAP_EVERY_DAYS * 86400000;
    h.push('<section class="rz-card rzv-capcard"><div class="rz-kicker">' + R.icon('target') + ' La consigne, toujours la même</div>'
      + '<div class="rzv-capprompt" lang="en">' + esc(CAPSULE_PROMPT) + '</div><div class="rzv-p">' + esc(CAPSULE_PROMPT_FR) + ' Qui vous êtes, ce que vous faites, un projet récent, ce qui vous plaît dans ce métier.</div>'
      + (!due && !just ? '<div class="rzv-note">Dernière capsule le ' + esc(dayLong(last.at)) + ' : la suivante est conseillée à partir du ' + esc(dayLong(last.at + CAP_EVERY_DAYS * 86400000)) + '. Vous pouvez en enregistrer une quand même.</div>' : '')
      + '<div class="rzv-mic">' + R.h.rec(CAP_KEY, { maxMs: CAP_MAX_MS, label: 'Enregistrer ma capsule', againLabel: 'Refaire ma capsule', stt: { keep: true }, onResult: onCapsule }) + '</div>'
      + '<div class="rzv-hint' + (T.capNote ? ' is-warn' : '') + '">' + (T.capNote ? esc(T.capNote) : '<span class="rz-kbd">Espace</span> pour commencer et terminer · une minute environ, 90 s au plus') + '</div>'
      + (just ? '<div class="rzv-capjust">' + R.icon('check') + '<span>Capsule du ' + esc(dayLong(just.at)) + ' gardée' + (just.metrics && just.metrics.wpm ? ' — ' + esc(just.metrics.wpm) + ' mots/min, ' + esc(clock(just.metrics.seconds)) : '') + '. « Refaire ma capsule » la remplace.</span></div>' : '')
      + '</section>');
    if (!caps.length) {
      h.push(R.h.empty('Pas encore de capsule', 'Enregistrez la première aujourd’hui : c’est votre point de départ.'));
    } else if (caps.length === 1) {
      h.push('<div class="rzv-capgrid">' + capColHtml(first, 'Votre première capsule', null)
        + '<section class="rz-card rzv-capcol is-empty"><div class="rz-card-head"><span class="rz-card-title">La prochaine</span></div><p class="rzv-p">' + esc('À partir du ' + dayLong(first.at + CAP_EVERY_DAYS * 86400000) + ' : vous la comparerez à celle-ci, côte à côte.') + '</p></section></div>');
    } else {
      var dw = num(last.metrics && last.metrics.wpm, 0) - num(first.metrics && first.metrics.wpm, 0);
      var days = Math.max(1, Math.round((last.at - first.at) / 86400000));
      h.push('<div class="rzv-capsum">' + esc('En ' + plural(days, 'jour') + ' : ' + (dw ? (dw > 0 ? '+' : '−') + Math.abs(dw) + ' mots/min de débit' : 'même débit') + '.') + '</div>');
      h.push('<div class="rzv-capgrid">' + capColHtml(first, 'Avant · la première', null) + capColHtml(last, 'Après · la dernière', first) + '</div>');
      if (caps.length > 2) h.push('<div class="rz-muted">' + esc(plural(caps.length, 'capsule') + ' en tout ; la comparaison met en regard la première et la dernière.') + '</div>');
    }
    return h.join('');
  }

  /* ══ Vue et carte d'accueil ════════════════════════════════════════════ */

  R.view('tutor', {
    label: 'Tuteur', icon: 'chat', order: 30, title: 'Parler anglais avec le tuteur, à voix haute',
    render: function () {
      if (T.screen === 'chat' || T.screen === 'summary') {
        var c = current();
        if (!c) T.screen = 'pick';
        else if (T.screen === 'chat' && c.summary && !(T.pending && T.pending.chatId === c.id)) T.screen = 'summary';
        else if (T.screen === 'summary' && !c.summary) T.screen = 'chat';
      }
      if (T.screen === 'open' && !chatById(T.openId)) T.screen = 'history';
      var s = T.screen, html;
      if (s === 'chat') html = chatHtml(current());
      else if (s === 'summary') html = summaryHtml(current());
      else if (s === 'history') html = historyHtml();
      else if (s === 'open') html = openHtml(chatById(T.openId));
      else if (s === 'capsule') html = capsuleHtml();
      else html = pickHtml();
      return typo('<div class="rzv rzv-s-' + esc(s) + '">' + html + '</div>');
    },
    after: function (host) {
      /* L'avatar mains libres : replacé dans sa place si le rendu l'a recréée, puis le moteur démarré au besoin. */
      var slot = host.querySelector('[data-rzv-slot]');
      if (slot) {
        var st = stageEl();
        if (st.parentNode !== slot) slot.appendChild(st);
        ensureLive();
        updateStage();
      }
      placeDraft(host);
      if (T.toTop) { T.toTop = false; T.toEnd = false; window.scrollTo(0, 0); }
      /* Une nouvelle réplique : la page descend jusqu'au pupitre (jamais vers le haut). */
      if (T.toEnd) {
        var sec = host.querySelector('.rzv-s-chat .rzv-chat');
        if (sec && sec.getBoundingClientRect) {
          var y = window.scrollY + sec.getBoundingClientRect().bottom - window.innerHeight + 24;
          if (y > window.scrollY + 4) { try { window.scrollTo({ top: y, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, y); } }
        }
        T.toEnd = false;
      }
      if (T.focusText) {
        var f = host.querySelector('[data-focus-key="rzv-text"]');
        if (f) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
        T.focusText = false;
      }
      T.newKey = '';
    },
    onShow: function (params) {
      flushPendingCards();
      if (params && params.id) {
        var c = chatById(params.id);
        if (c) { if (resumable(c)) { T.chatId = c.id; setScreen('chat'); T.toEnd = true; } else { T.openId = c.id; setScreen('open'); } }
      }
    },
    onHide: function () { R.tts.stopAll(); pauseLive(); },
    keydown: function (e, el, role) {
      var ov = window.OrganizatorVoiceOverlay;
      if (ov && typeof ov.isOpen === 'function' && ov.isOpen()) return false;
      var typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (role === 'rz-tutor-text' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); return true; }
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      var s = T.screen;
      if (s === 'chat' && liveMode() && !T.pending) {
        var lc = current();
        if (lc && !lc.summary && liveKeydown(e, el, typing, lc)) return true;
      }
      if (e.key === 'Escape') {
        if (typing) { el.blur(); return true; }
        if (anyPlaying()) { R.tts.stopAll(); return true; }
        var cancelBtn = document.querySelector('#page-host [data-act="rz-rec-cancel"]');
        if (cancelBtn) { cancelBtn.click(); return true; }
        if (s === 'chat') { backToPick(); return true; }
        if (s === 'open') { setScreen('history'); R.render(); return true; }
        if (s !== 'pick') { setScreen('pick'); R.render(); return true; }
        return false;
      }
      if (typing) return false;
      if (s === 'pick') {
        if (/^[1-9]$/.test(e.key) && SCENARIOS[+e.key - 1]) { e.preventDefault(); startChat(SCENARIOS[+e.key - 1].id); return true; }
        if (e.key === 'Enter' && el && el.classList && el.classList.contains('rzv-sc')) {
          e.preventDefault();
          if (el.getAttribute('data-act') === 'rz-tutor-fr') openFrench(); else startChat(el.getAttribute('data-id'));
          return true;
        }
        return false;
      }
      if (s === 'chat') {
        var chat = current();
        if (e.key === ' ' || e.code === 'Space') { if (micBlocked(chat)) { e.preventDefault(); return true; } return false; }
        var li = lastTutorIdx(chat);
        if ((e.key === 'r' || e.key === 'R') && li >= 0) {
          e.preventDefault();
          if (isPlaying(sayKey(chat, li))) R.players[sayKey(chat, li)].stop(); else speakTurn(chat, li);
          return true;
        }
        if ((e.key === 't' || e.key === 'T') && li >= 0 && chat.turns[li].fr) {
          e.preventDefault();
          var k = chat.id + ':' + li;
          T.fr[k] = !T.fr[k];
          R.render();
          return true;
        }
        return false;
      }
      if (s === 'summary' && e.key === 'Enter') {
        var c = current();
        e.preventDefault();
        if (c && !c.cardsAdded && cardsOf(c).length) addCards(c); else { setScreen('pick'); R.render(); }
        return true;
      }
      return false;
    }
  });

  /* Raccourcis du chat en mains libres : Espace fait taire, M coupe le micro, R réécoute, T traduit,
     Échap sort (le moteur s'arrête ; la conversation reste ouverte). */
  function liveKeydown(e, el, typing, chat) {
    if (e.key === 'Escape') {
      if (typing) { el.blur(); return true; }
      backToPick();
      return true;
    }
    if (typing) return false;
    var li = lastTutorIdx(chat);
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (L.eng && L.chatId === chat.id) liveHush(); else resumeLive();
      return true;
    }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); liveMute(); return true; }
    if ((e.key === 'r' || e.key === 'R') && li >= 0) { e.preventDefault(); if (liveOn(chat)) liveReplay(chat.turns[li].text); else speakTurn(chat, li); return true; }
    if ((e.key === 't' || e.key === 'T') && li >= 0 && chat.turns[li].fr) {
      e.preventDefault();
      var k = chat.id + ':' + li;
      T.fr[k] = !T.fr[k];
      R.render();
      return true;
    }
    return false;
  }

  function openFrench() {
    var ov = window.OrganizatorVoiceOverlay;
    if (!ov || typeof ov.open !== 'function') { R.toast('La conversation en français n’est pas disponible dans cette fenêtre.'); return; }
    R.tts.stopAll();
    pauseLive();
    ov.open();
  }

  function quickScenarios() {
    var ids = [];
    if (todayLesson()) ids.push('news');
    var last = talked()[0];
    if (last) ids.push(scOf(last).id);
    ['smalltalk', 'standup', 'news', 'interview'].forEach(function (id) { ids.push(id); });
    var out = [];
    ids.forEach(function (id) { if (out.indexOf(id) < 0 && out.length < 3) out.push(id); });
    return out.map(scenarioById);
  }

  R.homeCard({ id: 'tutor', area: 'main', order: 30, html: function () {
    var rc = lastResumable();
    var last = talked()[0];
    var lesson = todayLesson();
    var h = ['<section class="rz-card rzv-home"><div class="rz-card-head"><span class="rz-card-title">Parler avec le tuteur</span>' + R.h.level(R.level('speak').band, 'Oral') + '</div>'];
    h.push('<p class="rzv-p">Une conversation en anglais, à voix haute' + (liveMode() ? ' et mains libres' : ' et tour par tour') + ' : il reformule discrètement vos phrases et vous relance. Bilan à la fin.</p>');
    if (rc) {
      h.push('<div class="rzv-home-resume">' + R.icon('chat') + '<span>En cours : <b>' + esc(rc.scenario.title) + '</b> · ' + esc(plural(userTurns(rc).length, 'réplique')) + '</span>'
        + '<button type="button" class="btn btn-primary" data-act="rz-tutor-resume" data-id="' + esc(rc.id) + '">Reprendre</button></div>');
    }
    h.push('<div class="rzv-quick">' + quickScenarios().map(function (sc) {
      var sub = sc.id === 'news' && lesson ? 'D’après « ' + lesson.title + ' »' : 'Avec ' + sc.name + ', ' + sc.roleFr;
      return '<button type="button" class="rzv-qbtn" data-act="rz-tutor-start" data-id="' + esc(sc.id) + '"><span class="rzv-ic rzv-hue-' + esc(sc.hue) + '">' + R.icon(sc.icon) + '</span>'
        + '<span class="rzv-qbtn-t"><b>' + esc(sc.title) + '</b><small>' + esc(sub) + '</small></span></button>';
    }).join('') + '</div>');
    if (last) {
      var lv = last.summary && last.summary.levelEstimate;
      h.push('<div class="rzv-home-last"><span>Dernier échange : <b>' + esc(last.scenario.title) + '</b>, ' + esc(ago(lastAt(last))) + '</span>' + (lv ? R.h.level(lv) : '')
        + '<button type="button" class="btn btn-ghost" data-act="rz-tutor-open" data-id="' + esc(last.id) + '">Rouvrir</button></div>');
    }
    h.push('<div class="rzv-home-foot"><button type="button" class="btn btn-ghost" data-act="rz-tutor-pick">Tous les scénarios ' + R.icon('arrow') + '</button>'
      + '<button type="button" class="btn btn-ghost" data-act="rz-tutor-capsule">' + R.icon('mic') + ' Capsule avant / après</button></div></section>');
    return typo(h.join(''));
  } });

  /* ══ Actions ════════════════════════════════════════════════════════════ */

  function goTutor() { if (R.viewId() !== 'tutor') R.go('tutor'); else { window.scrollTo(0, 0); R.render(); } }

  R.act('rz-tutor-start', function (el, e) {
    if (e && e.stopPropagation) e.stopPropagation();
    startChat(el.getAttribute('data-id'), el.getAttribute('data-variant') || '');
  });
  R.act('rz-tutor-pick', function () { R.tts.stopAll(); setScreen('pick'); goTutor(); });
  R.act('rz-tutor-back', backToPick);
  R.act('rz-tutor-resume', function (el) {
    var c = chatById(el.getAttribute('data-id'));
    if (!c) return;
    if (L.chatId !== c.id) stopLive();
    delete L.hold[c.id]; L.error = '';
    T.chatId = c.id; T.error = null; T.fr = {}; T.toEnd = true;
    setScreen('chat');
    warm(c);
    goTutor();
  });
  R.act('rz-tutor-endid', function (el) {
    var c = chatById(el.getAttribute('data-id'));
    if (!c) return;
    c.closed = false;
    endChat(c);
    if (R.viewId() !== 'tutor') R.go('tutor');
  });
  R.act('rz-tutor-end', function () { endChat(current()); });
  R.act('rz-tutor-quit', quitChat);
  R.act('rz-tutor-continue', function () { var c = current(); if (c) c.closed = false; T.error = null; R.render(); });
  R.act('rz-tutor-dismiss', function () { T.dismissEnd = T.chatId; R.render(); });
  R.act('rz-tutor-send', sendText);
  R.act('rz-tutor-cancel', function () { cancelPending(false); });
  R.act('rz-tutor-retry', function () {
    var err = T.error;
    var c = chatById(err ? err.chatId : T.chatId);
    if (!c || T.pending) return;
    T.error = null;
    ask(c, !!(err && err.end));
  });
  R.act('rz-tutor-withdraw', function () {
    var c = current();
    if (!c) return;
    var t = c.turns[c.turns.length - 1];
    if (t && t.role === 'user') { c.turns.pop(); T.draft = t.text; T.focusText = true; delete T.blobs[c.id + ':' + c.turns.length]; }
    T.error = null;
    R.save();
    R.render();
  });
  R.act('rz-tutor-tr', function (el) {
    var k = el.getAttribute('data-chat') + ':' + el.getAttribute('data-i');
    T.fr[k] = !T.fr[k];
    R.render();
  });
  R.act('rz-tutor-phrase', function (el) { sayText(el.getAttribute('data-text'), current() || chatById(T.openId)); });
  R.act('rz-tutor-cards', function (el) { addCards(chatById(el.getAttribute('data-id'))); });
  R.act('rz-tutor-fr', function (el, e) { if (e && e.stopPropagation) e.stopPropagation(); openFrench(); });
  R.act('rz-tutor-mode', function (el) { setLive(el.getAttribute('data-mode') === 'live'); });
  R.act('rz-tutor-hush', liveHush);
  R.act('rz-tutor-mute', liveMute);
  R.act('rz-tutor-live-resume', resumeLive);
  R.act('rz-tutor-live-notice', function () {
    var a = noticeAction(currentNotice());
    if (a) { try { a.run(); } catch (e) { R.toast('Impossible : ' + clean(e && e.message, 200)); } }
  });
  R.act('rz-tutor-replay', function (el) {
    var c = current(), i = +el.getAttribute('data-i');
    var t = c && c.turns[i];
    if (t) { if (liveOn(c)) liveReplay(t.text); else speakTurn(c, i); }
  });
  R.act('rz-tutor-set-live', function () {
    R.prefs.tutorLive = !(R.prefs.tutorLive !== false);
    if (R.prefs.tutorLive === false) stopLive();
    R.save();
    R.render();
  });
  R.act('rz-tutor-set-barge', function (el) {
    var v = el.getAttribute('data-value');
    R.prefs.tutorBargeIn = v === 'voice' || v === 'off' ? v : 'words';
    if (L.eng) try { L.eng.setOptions({ bargeIn: bargeIn() }); } catch (e) { /* moteur arrêté */ }
    R.save();
    R.render();
  });
  /* Le curseur : la valeur part au moteur à chaque cran, sans rendu (le vumètre la suit en direct). */
  R.input('rz-tutor-sens', function (el) {
    R.prefs.tutorSensitivity = R.clamp(Math.round(num(el.value, 40)), 0, 100);
    var out = document.querySelector('[data-rzv-sens-out]');
    if (out) out.textContent = String(R.prefs.tutorSensitivity);
    [L.eng, L.test].forEach(function (e) { if (e) try { e.setOptions({ sensitivity: sensitivity() }); } catch (err) { /* moteur arrêté */ } });
    R.save();
  });
  R.act('rz-tutor-sens-test', function () { if (L.test) stopMicTest(); else startMicTest(); });

  /* ── Vumètre des réglages ──
     Le niveau du micro et le seuil de déclenchement (eng.state().micDb / threshold, sur -80 … -10 dB) du
     moteur en marche (la conversation mains libres, l'overlay) ; sinon « Tester le micro » ouvre un moteur
     sans conversation ni transcription, 30 s au plus. Le tout s'arrête quand les réglages se ferment. */
  function meterEngine() {
    var OV = window.OrganizatorVoice;
    var a = OV && typeof OV.active === 'function' ? OV.active() : null;
    return a || L.test || null;
  }
  function startMicTest() {
    var OV = window.OrganizatorVoice;
    if (L.test || !OV || typeof OV.create !== 'function' || (typeof OV.active === 'function' && OV.active())) return;
    try {
      L.test = OV.create({
        container: null, avatar: false, language: 'en', whisperModel: R.prefs.whisperModel || 'small', sensitivity: sensitivity(),
        conversation: null, liveAsr: false, bargeIn: 'off',
        onUserUtterance: function () { return false; }, onNotice: noop, onError: noop, onPhase: noop
      });
      var p = L.test.start();
      Promise.resolve(p).then(noop, function (e) { R.toast('Micro indisponible : ' + clean(e && e.message, 200)); stopMicTest(); });
    } catch (e) {
      L.test = null;
      R.toast('Micro indisponible : ' + clean(e && e.message, 200));
    }
    clearTimeout(L.testTimer);
    L.testTimer = setTimeout(stopMicTest, 30000);
    sensMeterSoon();
    sensMeterFrame();
  }
  function stopMicTest() {
    clearTimeout(L.testTimer);
    var e = L.test;
    L.test = null;
    if (e) try { e.destroy(); } catch (err) { /* déjà arrêté */ }
    sensMeterFrame();
  }
  function sensMeterSoon() {
    if (L.setMeter) return;
    L.setMeter = setInterval(sensMeterFrame, 80);
  }
  function sensMeterFrame() {
    var box = document.querySelector('[data-rzv-sens-meter]');
    if (!box) { clearInterval(L.setMeter); L.setMeter = 0; if (L.test) stopMicTest(); return; }
    var e = meterEngine(), st = null;
    if (e) try { st = e.state(); } catch (err) { st = null; }
    var on = !!(st && st.micDb != null && st.micDb > -100 && !st.muted);
    var pos = function (db) { return R.clamp((num(db, -80) + 80) / 70, 0, 1); };
    var lv = box.querySelector('.rzv-sens-lvl'), th = box.querySelector('.rzv-sens-thr');
    box.classList.toggle('is-off', !on);
    if (lv) {
      lv.style.transform = 'scaleX(' + (on ? pos(st.micDb) : 0).toFixed(3) + ')';
      lv.classList.toggle('is-hot', on && st.micDb > st.threshold);
    }
    if (th) { th.hidden = !(st && st.threshold != null); if (st && st.threshold != null) th.style.left = (pos(st.threshold) * 100).toFixed(1) + '%'; }
    var state = document.querySelector('[data-rzv-sens-state]');
    if (state) {
      var txt = on ? 'Parlez : la barre doit franchir le trait. Si elle le passe sans que vous parliez (ventilateur, clavier), baissez la sensibilité.'
        : (L.test ? 'Ouverture du micro…' : 'Le vumètre s’anime pendant une conversation, ou le temps d’un essai.');
      var t = state.querySelector('span');
      if (t && t.textContent !== txt) t.textContent = txt;
      var b = state.querySelector('[data-act="rz-tutor-sens-test"]');
      if (b) {
        var other = !L.test && !!meterEngine();
        b.hidden = other;
        var lab = L.test ? 'Arrêter l’essai' : 'Tester le micro';
        if (b.textContent !== lab) b.textContent = lab;
      }
    }
  }

  /* Réglages › Révizator : la section du tuteur. */
  var BARGE_LABELS = { words: 'Quand je dis quelques mots (conseillé)', voice: 'Dès que je parle', off: 'Jamais' };
  var BARGE_HELP = {
    words: 'Le tuteur baisse la voix dès qu’il vous entend, et ne s’arrête que si vous dites vraiment quelque chose : une toux, un bruit ou l’écho de sa propre voix ne le coupent pas.',
    voice: 'Il se tait au premier son de votre voix : réactif, mais un bruit franc peut aussi le couper.',
    off: 'Il finit toujours sa phrase ; Espace (« Faire taire ») le coupe quand même.'
  };
  R.settingsSection({ id: 'tutor', order: 30, html: function () {
    var app = window.organizatorApp;
    var field = function (label, ctl) { return app && app.setFieldHtml ? app.setFieldHtml(label, ctl) : '<div class="set-field"><div class="set-field-label">' + esc(label) + '</div><div class="set-field-control">' + ctl + '</div></div>'; };
    var on = R.prefs.tutorLive !== false;
    var sw = app && app.switchHtml ? app.switchHtml(on, 'rz-tutor-set-live', 'Tuteur mains libres')
      : '<button type="button" class="switch' + (on ? ' on' : '') + '" data-act="rz-tutor-set-live" role="switch" aria-checked="' + on + '" aria-label="Tuteur mains libres"></button>';
    var sens = sensitivity(), barge = bargeIn(), asr = liveAsr();
    setTimeout(function () { sensMeterSoon(); sensMeterFrame(); }, 0);
    return '<div class="set-card rzv-set"><div class="set-card-head"><span class="set-card-title">Tuteur</span></div>'
      + field('Tuteur mains libres', sw)
      + '<div class="rz-set-help">Le tuteur écoute en continu, répond phrase par phrase et se tait dès que vous parlez. Désactivé : tour par tour (Espace pour parler, encore pour terminer). La bascule existe aussi dans la conversation.</div>'
      + field('Couper la parole', R.h.chips('tutorBargeIn', ['words', 'voice', 'off'], barge, ['words', 'voice', 'off'].map(function (k) { return BARGE_LABELS[k]; }), 'rz-tutor-set-barge'))
      + '<div class="rz-set-help">' + esc(BARGE_HELP[barge]) + '</div>'
      + field('Sensibilité du micro', '<input class="rzv-sens-range" type="range" min="0" max="100" step="1" value="' + sens + '" data-role="rz-tutor-sens" data-focus-key="rz-tutor-sens" aria-label="Sensibilité du micro">'
        + '<output class="rzv-sens-out" data-rzv-sens-out>' + sens + '</output>')
      + '<div class="rzv-sens-meter is-off" data-rzv-sens-meter aria-hidden="true"><i class="rzv-sens-lvl"></i><b class="rzv-sens-thr" hidden></b></div>'
      + '<div class="rzv-sens-state" data-rzv-sens-state><span>Le vumètre s’anime pendant une conversation, ou le temps d’un essai.</span>'
      + '<button type="button" class="btn btn-ghost wm-btn" data-act="rz-tutor-sens-test">Tester le micro</button></div>'
      + '<div class="rz-set-help">Plus haute, il entend une voix douce ou lointaine, mais aussi davantage le bruit ambiant ; plus basse, il ignore le bruit, il faut parler plus franchement. 40 convient à la plupart des pièces.</div>'
      + '<div class="rzv-set-sub">Transcription en direct</div>'
      + (asr ? asr.modelsHtml() : '<div class="asr-note">Indisponible dans cette fenêtre : Whisper transcrit chaque phrase quand vous vous taisez.</div>')
      + '<div class="rz-set-help">Un seul modèle pour l’anglais et le français, plus précis que Whisper et robuste aux accents : votre phrase s’écrit pendant que vous parlez et part au tuteur, ponctuée, dès que vous vous taisez ; Whisper mesure ensuite, sans faire attendre, les mots douteux et le débit. Tout reste sur ce poste.</div>'
      + '<div class="set-card-foot">Sans modèle en direct, la conversation utilise le même Whisper que l’oral (ci-dessous) ; les réponses viennent du modèle « Tuteur » des agents.</div></div>';
  } });
  R.act('rz-tutor-history', function () { R.tts.stopAll(); setScreen('history'); goTutor(); });
  R.act('rz-tutor-open', function (el) {
    var c = chatById(el.getAttribute('data-id'));
    if (!c) return;
    R.tts.stopAll();
    T.openId = c.id;
    setScreen('open');
    goTutor();
  });
  R.act('rz-tutor-capsule', function () { R.tts.stopAll(); setScreen('capsule'); goTutor(); });

  R.input('rz-tutor-text', function (el) { T.draft = el.value.slice(0, 1000); });
  R.change('rz-tutor-voice', function (el) {
    tutorData().voiceOff = !el.checked;
    if (!el.checked) R.tts.stopAll();
    R.save();
    R.render();
  });

  /* Quitter la page Révizator : le moteur se tait et rend le micro. */
  R.on('pagehide', function () { pauseLive(); });

  R.on('loaded', function () {
    flushPendingCards();
    if (T.chatId && !chatById(T.chatId)) { T.chatId = ''; T.pending = null; T.error = null; if (T.screen === 'chat' || T.screen === 'summary') T.screen = 'pick'; }
  });

  /* ══ Simulation hors WebView2 ═══════════════════════════════════════════
     Un tuteur de démonstration : il ouvre selon le scénario, reformule les fautes typiques d'un
     francophone (règles ci-dessous), relance, parle du cours du jour si on le lui demande, propose de
     conclure au bout de huit répliques et rend un bilan tiré des fautes relevées. */
  var FIX_RULES = [
    [/\b(I am|I'm|I’m) agree\b/i, 'I agree', 'gram.verb_pattern', '« agree » est un verbe : I agree, sans « am ».'],
    [/\bI work here since\b/i, 'I’ve worked here since', 'gram.tense.duration', 'Une situation qui dure encore : present perfect, pas le présent.'],
    [/\bsince (two|three|four|five|six|ten|\d+) (years|months|weeks|days)\b/i, 'for $1 $2', 'gram.for_since_ago', 'Une durée se dit avec « for » ; « since » donne un point de départ.'],
    [/\byesterday I (fix|work|finish|start|test|deploy)\b/i, 'yesterday I $1ed', 'gram.tense.pp_past', 'Hier : prétérit (fixed, worked…).'],
    [/\bdiscuss about\b/i, 'discuss', 'gram.verb_pattern', '« discuss » se construit sans préposition.'],
    [/\binformations\b/i, 'information', 'gram.countable', '« information » est indénombrable : jamais de s.'],
    [/\badvices\b/i, 'advice', 'gram.countable', '« advice » est indénombrable : some advice, a piece of advice.'],
    [/\b(he|she|it) don't\b/i, '$1 doesn’t', 'gram.agreement', 'Troisième personne : does not, contracté en doesn’t.'],
    [/\bdepends? of\b/i, 'depends on', 'gram.preposition', 'On dit « depend on ».'],
    [/\bexplain me\b/i, 'explain to me', 'gram.verb_pattern', 'explain something to someone.'],
    [/\b(I|we) did a mistake\b/i, '$1 made a mistake', 'lex.collocation', 'Une erreur, on la « make ».'],
    [/\bassist(ed)? to\b/i, 'attend', 'lex.false_friend', '« assister à » se dit attend ; assist veut dire aider.'],
    [/\bin the same time\b/i, 'at the same time', 'gram.preposition', 'On dit « at the same time ».'],
    [/\bmore (easy|cheap|fast|big)\b/i, '$1er', 'gram.comparative', 'Adjectif court : -er (easier, cheaper…).']
  ];
  function capFirst(s, like) { return /^[A-Z]/.test(like || '') ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function fixErrors(text) {
    var better = String(text || ''), errors = [];
    FIX_RULES.forEach(function (r) {
      var m = r[0].exec(better);
      if (!m) return;
      var fixed = m[0].replace(r[0], r[1]).replace(/(easy|big)er\b/i, function (w) { return w.toLowerCase() === 'easyer' ? 'easier' : 'bigger'; });
      fixed = capFirst(fixed, m[0]);
      errors.push({ said: m[0], better: fixed, explanationFr: r[3], category: r[2] });
      better = better.slice(0, m.index) + fixed + better.slice(m.index + m[0].length);
    });
    return { better: better, errors: errors };
  }
  var ACKS = [['I see.', 'Je vois.'], ['That’s interesting.', 'C’est intéressant.'], ['Oh, really?', 'Ah bon ?'], ['Good point.', 'Bonne remarque.'], ['Right.', 'D’accord.']];

  function fakeTutor(params) {
    params = params || {};
    var sid = params.scenario && params.scenario.id;
    var sc = scenarioById(sid) || SCENARIOS[0], va = variantOf(sid);
    var hist = arr(params.history);
    var users = hist.filter(function (x) { return x && x.role === 'user'; });
    var lastMsg = hist.length && hist[hist.length - 1].role === 'user' ? String(hist[hist.length - 1].text || '') : '';
    var out = { reply: '', replyFr: '', recast: { said: '', better: '' }, tipFr: '', end: false, summary: { errors: [], phrases: [], feedbackFr: '', levelEstimate: '' } };
    if (params.end) {
      var errs = [];
      users.forEach(function (u) { fixErrors(u.text).errors.forEach(function (e) { if (errs.length < 3 && !errs.some(function (x) { return x.said === e.said; })) errs.push(e); }); });
      out.reply = 'Thanks, that was a really good conversation! Here’s a short summary of how it went.';
      out.replyFr = 'Merci, c’était une très bonne conversation ! Voici un petit bilan.';
      out.end = true;
      out.summary = {
        errors: errs, phrases: sc.phrases.slice(0, 3),
        feedbackFr: 'Vous avez tenu ' + plural(users.length, 'réplique') + ' et répondu à chaque question : c’est l’essentiel. '
          + (errs.length ? 'Revoyez les ' + (errs.length > 1 ? errs.length + ' points' : 'point') + ' ci-dessous, puis redites les phrases corrigées.' : 'Aucune faute relevée : tentez un niveau de langue plus riche la prochaine fois.')
          + ' Pensez à relancer, vous aussi, par une question.',
        levelEstimate: params.level || 'B1'
      };
      return out;
    }
    if (!hist.length) {
      var o = (va && va.open) || sc.open;
      if (sc.id === 'news' && params.lesson && params.lesson.title) o = ['Morning! I’ve just read about “' + params.lesson.title + '”. Can you sum it up for me in a few words?', 'Bonjour ! Je viens de lire « ' + params.lesson.title + ' ». Vous pouvez me le résumer en quelques mots ?'];
      out.reply = o[0]; out.replyFr = o[1];
      return out;
    }
    var fx = fixErrors(lastMsg);
    if (fx.errors.length) out.recast = { said: lastMsg, better: fx.better };
    var k = users.length;
    if (/\b(lesson|cours)\b/i.test(lastMsg)) {
      if (params.lesson && params.lesson.title) { out.reply = 'Today’s lesson is about “' + params.lesson.title + '”. Would you like to talk about it?'; out.replyFr = 'Le cours d’aujourd’hui porte sur « ' + params.lesson.title + ' ». Voulez-vous qu’on en parle ?'; }
      else { out.reply = 'There’s no lesson yet today — you can prepare one on the home page. Shall we keep chatting?'; out.replyFr = 'Pas encore de cours aujourd’hui : vous pouvez en préparer un depuis l’accueil. On continue ?'; }
    } else {
      var a = ACKS[k % ACKS.length], f = sc.follow[Math.max(0, k - 1) % sc.follow.length];
      out.reply = a[0] + ' ' + f[0]; out.replyFr = a[1] + ' ' + f[1];
    }
    if (R.text.count(lastMsg) < 6) out.tipFr = 'Développez un peu : une raison, un exemple, un détail.';
    if (k >= 8) { out.end = true; out.reply += ' We’re nearly out of time — shall we wrap up?'; out.replyFr += ' Nous arrivons au bout du temps : on conclut ?'; }
    return out;
  }
  /* Réponses réelles de l'hôte (agent H2, haiku, scène « Hôtel ») : fixtures/tutor.json (un tour) et
     tutor-end.json (le bilan). Lues seulement dans le navigateur ; on leur applique les règles de l'hôte
     (reformulation et erreurs gardées seulement si l'apprenant a bien dit la phrase). */
  var REAL = null;
  function realDocs() {
    if (REAL || typeof window.fetch !== 'function') return Promise.resolve(REAL);
    var get = function (u) { return window.fetch(u).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }); };
    return Promise.all([get('revizator/fixtures/tutor.json'), get('revizator/fixtures/tutor-end.json')]).then(function (l) { REAL = { turn: l[0], end: l[1] }; return REAL; });
  }
  function saidIn(said, texts) {
    var k = ' ' + R.text.norm(said) + ' ';
    return !!R.text.norm(said) && texts.some(function (t) { return (' ' + R.text.norm(t) + ' ').indexOf(k) >= 0; });
  }
  function shimTutor(params) {
    var synth = fakeTutor(params);
    var hist = arr(params && params.history);
    var users = hist.filter(function (x) { return x && x.role === 'user'; }).map(function (x) { return String(x.text || ''); });
    if (!params || !params.scenario || params.scenario.id !== 'travel:hotel' || !users.length || (!params.end && users.length !== 1)) return synth;
    return realDocs().then(function (real) {
      var doc = real && (params.end ? real.end : real.turn);
      if (!doc) return synth;
      doc = JSON.parse(JSON.stringify(doc));
      if (doc.recast && doc.recast.said && !saidIn(doc.recast.said, users.slice(-1))) doc.recast = synth.recast;
      if (params.end && doc.summary) {
        doc.summary.errors = arr(doc.summary.errors).filter(function (e) { return saidIn(e.said, users); });
        if (!doc.summary.errors.length) doc.summary.errors = synth.summary.errors;
      }
      return doc;
    }, function () { return synth; });
  }
  R.fixture('tutor', shimTutor);
  R.tutor = { scenarios: SCENARIOS, fake: fakeTutor, fixErrors: fixErrors };
})();
