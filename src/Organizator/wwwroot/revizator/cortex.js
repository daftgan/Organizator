/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — le cortex (vue « cortex »)

   Des cartes mentales de ce que l'utilisateur veut savoir. Une carte commence vide : sa racine
   seule (« Mon cortex »). Les grands nœuds arrivent au fil de l'eau, ajoutés à la main ou nés d'une
   discussion avec l'agent. Chaque nœud peut donner un cours d'anglais de fond (lesson.js, source
   « Mon cortex ») : l'agent du cours fait une recherche sur le nœud au lieu de lire l'actualité, puis
   le cours fait passe le nœud à « étudié » (ou « à approfondir » si le cours a été jugé difficile ou
   réussi à moins de 60 %).

   Programmes : l'agent, à côté de la carte, est une discussion où l'utilisateur demande un programme (« du début
   de l'humanité à la fin ») ; l'agent propose une suite ordonnée d'étapes (Préhistoire, Antiquité,
   Moyen Âge…), avec des sous-étapes au besoin, qu'on rediscute (« plus court », « ajoute l'Égypte »)
   avant de l'ajouter à la carte. Un programme est un nœud (kind « program ») dont les enfants sont
   les étapes (kind « step »), dans l'ordre ; les cours en proposent l'étape suivante. On peut aussi
   rediscuter un programme déjà dans la carte : l'agent rend la révision, appliquée en gardant l'état
   et les cours des étapes conservées.

   Réglages › Révizator › Cortex : réorganisation automatique (après chaque modification à la main,
   l'agent remet la carte en ordre : doublons fusionnés, nœuds déplacés, intitulés harmonisés), sujets
   suivants des cours ajoutés en sous-nœuds (hors programme), et « Réinitialiser le cortex » (cartes,
   discussions, versions et corbeille effacées).

   Vue : la carte mentale (molette pour zoomer, glisser pour déplacer), le nœud choisi dans une petite
   carte posée dessus (cours, état, ajout, renommage, suppression), et l'agent à côté.

   Versions : chaque modification enregistre une version de la carte (libellé, auteur, heure) dans un
   document à part, learning\cortex\<id de la carte>.json (100 versions au plus). Annuler (Ctrl+Z),
   Rétablir (Ctrl+Y), et « Historique » pour revenir à n'importe laquelle (ce retour est lui-même une
   version). Une carte supprimée va à la corbeille, d'où on la restaure.

   Grand écran : la vue occupe toute la fenêtre (Échap pour en sortir).

   Agent : R.gen('cortex', { mode: create|expand|organize|chat, map: { title, description }, nodes:
   [{ id, parent, title, status, origin, kind }], node, request, history, message, draft })
     create|expand|organize → { mode, nodes: [{ ref, parent, title, summaryFr, query }], merged, noteFr }
     chat → { mode, reply, proposal: { action: none|new|revise, target, attach, title, summaryFr, query,
              steps: [{ ref, parent, title, summaryFr, query }] }, followUps }   (CortexGenre, LearningAgent.cs)

   Données (learning.json, sujet « en ») :
     cortex { v, current, trash: [{ map, at }], maps: [{ id, title, description, createdAt, updatedAt, chat: [{ role: 'user'|'agent', text, at, proposal?, applied?, followUps? }],
              nodes: [{ id, parent ('' pour la racine), title, summaryFr, query, status: 'open'|'studied'|'deepen',
                        origin: 'seed'|'user'|'agent'|'lesson', kind: ''|'program'|'step', order, lessons: [id de cours],
                        at, studiedAt }] }] }
     prefs.cortexTidy, prefs.cortexGrow (vrai par défaut)
     document cortex/<id de carte> { map, index, versions: [{ id, at, label, by: 'user'|'agent'|'lesson', snap }] }
   API pour lesson.js : R.cortex.{ suggest(n), get(map, node), path(map, node), status(map, node),
     lessonParams(map, node, depth), lessonDone(entry, L), statusLabel(s) }
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R || !R.view) return;
  var esc = R.esc;

  var U = R.ui.cortex = {
    sel: {}, expanded: {}, zoom: 1, busy: {}, note: {}, error: {}, again: {},
    newOpen: false, newTitle: '', newDesc: '', add: '', rename: null, confirmDel: '', centered: '',
    full: false, chatText: '', chatBusy: {}, chatError: {}, focusOff: {}, popOff: {}, hist: {}, trashOpen: false, histOpen: false,
    reveal: false, scrollMemo: null, resetArm: false
  };

  var STATUS = { open: 'À étudier', studied: 'Étudié', deepen: 'À approfondir' };
  var RANK = { open: 1, deepen: 2, studied: 3 };
  var BY = { user: 'vous', agent: 'l’agent', lesson: 'un cours' };
  var HUES = 8;                      /* couleurs de branche (cortex.css, .rzc-h0 … .rzc-h7) */
  var TIDY_MS = 2500;                /* réorganisation automatique : délai après la dernière modification */
  var ZOOM_MIN = 0.3, ZOOM_MAX = 2;
  var NODE_ARC = 132;                /* écart visé entre deux voisins d'un même anneau, en px */
  var FAN = Math.PI;                 /* éventail des enfants d'un nœud (hors racine) : un demi-tour au plus */
  var MAX_VERSIONS = 100;
  var CHAT_KEEP = 40;                /* messages gardés par carte */
  var CHAT_SEND = 12;                /* messages repris à chaque tour */
  var EXAMPLES = [
    'Un programme qui va du début de l’humanité à la fin',
    'Apprendre le bricolage, des bases à la rénovation',
    'Comprendre l’informatique, du transistor à l’IA',
    'Les grands philosophes, dans l’ordre'
  ];

  /* ══ Utilitaires ════════════════════════════════════════════════════════ */

  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function str(v) { return v == null ? '' : String(v); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function icon(n) { return R.icon(n); }
  function plural(n, one, many) { return n + ' ' + (n > 1 ? (many || one + 's') : one); }
  function key(s) { return R.text.norm(str(s)).replace(/^(les?|la|l'|un|une|des|the|a|an)\s+/, ''); }
  function clip(s, n) { s = str(s).trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
  function copy(v) { return JSON.parse(JSON.stringify(v)); }
  function when(ms) {
    var d = new Date(ms), today = R.today() === R.dayOf(ms);
    return (today ? 'aujourd’hui' : R.fmtDayShort(R.dayOf(ms))) + ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  /* Texte de l'agent : paragraphes et **gras**, rien d'autre. */
  function prose(t) {
    return str(t).split(/\n{2,}/).map(function (p) {
      return '<p>' + esc(p).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  /* ══ Données ════════════════════════════════════════════════════════════ */

  function emptyMap(title, description) {
    var now = Date.now();
    return {
      id: R.uid('cxmap'), title: title || 'Mon cortex', description: description || '', createdAt: now, updatedAt: now, chat: [],
      nodes: [{ id: 'root', parent: '', title: title || 'Mon cortex', summaryFr: '', query: '', status: 'open', origin: 'user', kind: '', order: 0, lessons: [], at: now }]
    };
  }

  function normNode(n, i) {
    n.id = str(n.id) || R.uid('cn');
    n.parent = str(n.parent);
    n.title = clip(n.title, 80) || 'Sans titre';
    n.summaryFr = str(n.summaryFr);
    n.query = str(n.query);
    if (!STATUS[n.status]) n.status = 'open';   /* « locked » (première version) compris */
    if (['seed', 'user', 'agent', 'lesson'].indexOf(n.origin) < 0) n.origin = 'user';
    if (['program', 'step'].indexOf(n.kind) < 0) n.kind = '';
    n.order = num(n.order, i);
    n.lessons = arr(n.lessons);
    return n;
  }

  /* Une carte saine : une seule racine, pas d'orphelin, pas de cycle. */
  function repair(map) {
    map.nodes = arr(map.nodes).filter(obj).map(normNode);
    var ids = {};
    map.nodes = map.nodes.filter(function (n) { if (ids[n.id]) return false; ids[n.id] = n; return true; });
    var roots = map.nodes.filter(function (n) { return !n.parent || !ids[n.parent]; });
    var root = roots.filter(function (n) { return !n.parent; })[0] || roots[0];
    if (!root) { root = normNode({ id: 'root', parent: '', title: map.title || 'Carte', origin: 'user' }, 0); map.nodes.unshift(root); ids[root.id] = root; }
    root.parent = '';
    root.kind = '';
    map.nodes.forEach(function (n) {
      if (n === root) return;
      if (!n.parent || !ids[n.parent]) { n.parent = root.id; return; }
      var seen = {}, p = n;
      while (p && p.parent) {
        if (seen[p.id]) { n.parent = root.id; break; }
        seen[p.id] = 1;
        p = ids[p.parent];
      }
    });
    return map;
  }

  function normMap(m) {
    m.id = str(m.id) || R.uid('cxmap');
    m.title = clip(m.title, 80) || 'Carte';
    m.description = str(m.description);
    delete m.mode; delete m.autoTidy;
    m.chat = arr(m.chat).filter(obj).slice(-CHAT_KEEP);
    repair(m);
    return m;
  }

  /* v2 : le cortex commence vide. Les huit thèmes de départ de la v1, jamais touchés (ni cours, ni
     sous-thème, ni état), sont retirés une fois. */
  function migrate(c) {
    if (c.v >= 2) return;
    c.maps.forEach(function (m) {
      var used = {};
      arr(m.nodes).forEach(function (n) { if (n && n.parent) used[n.parent] = 1; });
      m.nodes = arr(m.nodes).filter(function (n) {
        return !(n && n.origin === 'seed' && n.parent && !used[n.id] && !arr(n.lessons).length && (n.status || 'open') === 'open');
      });
    });
    c.v = 2;
    R.save();
  }

  var normalized = false;
  function store() {
    var c = obj(R.data.cortex);
    if (!c) { c = R.data.cortex = { v: 2, current: '', maps: [], trash: [] }; }
    c.maps = arr(c.maps).filter(obj);
    c.trash = arr(c.trash).filter(function (t) { return obj(t) && obj(t.map); }).slice(-10);
    if (!c.maps.length) { c.maps.push(emptyMap()); c.v = 2; normalized = false; R.save(); }
    if (!normalized) { migrate(c); c.maps.forEach(normMap); normalized = true; }
    if (!mapById(c.current, c)) c.current = c.maps[0].id;
    return c;
  }
  R.on('loaded', function () { normalized = false; U.hist = {}; });

  function maps() { return store().maps; }
  function mapById(id, c) { return arr((c || store()).maps).filter(function (m) { return m.id === id; })[0] || null; }
  function current() { var c = store(); return mapById(c.current, c); }
  function rootOf(map) { return map.nodes.filter(function (n) { return !n.parent; })[0]; }
  function node(map, id) { return map ? map.nodes.filter(function (n) { return n.id === id; })[0] || null : null; }
  function kids(map, id) {
    return map.nodes.filter(function (n) { return n.parent === id && n.parent; }).sort(function (a, b) { return a.order - b.order; });
  }
  function descendants(map, id) { var out = []; kids(map, id).forEach(function (k) { out.push(k); out = out.concat(descendants(map, k.id)); }); return out; }
  function depth(map, n) { var d = 0; while (n && n.parent && d < 20) { n = node(map, n.parent); d++; } return d; }
  function pathOf(map, n) { var p = []; while (n && p.length < 20) { p.unshift(n); n = n.parent ? node(map, n.parent) : null; } return p; }
  function isUnder(map, n, ancestorId) { var p = n && node(map, n.parent); while (p) { if (p.id === ancestorId) return true; p = p.parent ? node(map, p.parent) : null; } return false; }
  function programOf(map, n) { var p = pathOf(map, n); for (var i = p.length - 1; i >= 0; i--) if (p[i].kind === 'program') return p[i]; return null; }
  function status(map, n) { return n.status; }
  function pref(k) { return R.prefs[k] !== false; }
  function studied(s) { return s === 'studied' || s === 'deepen'; }
  function branch(map, n) {
    var p = pathOf(map, n);
    if (p.length < 2) return -1;
    var k = kids(map, p[0].id);
    return Math.max(0, k.indexOf(p[1])) % HUES;
  }
  function isEmpty(map) { return map.nodes.length <= 1; }

  /* ══ Versions ═══════════════════════════════════════════════════════════ */

  function snapOf(map) { return copy({ title: map.title, description: map.description, nodes: map.nodes }); }

  /* L'historique d'une carte, lu une fois. L'état à l'ouverture est pris tout de suite (pour pouvoir
     annuler la première modification) ; à la lecture, les versions faites entre-temps suivent les anciennes. */
  function hist(map) {
    var H = U.hist[map.id];
    if (H) return H;
    H = U.hist[map.id] = { map: map.id, index: 0, loaded: false,
      versions: [{ id: R.uid('cv'), at: Date.now(), label: 'État de départ', by: 'user', snap: snapOf(map), opening: true }] };
    function done(d) {
      var old = arr(d && d.versions).filter(function (v) { return obj(v) && obj(v.snap); });
      var newer = H.versions.slice(0, H.index + 1).filter(function (v) { return !v.opening; });
      if (old.length) {
        var oldIndex = Math.max(0, Math.min(num(d.index, old.length - 1), old.length - 1));
        H.versions = old.slice(0, oldIndex + 1).concat(newer).slice(-MAX_VERSIONS);
      } else {
        H.versions = H.versions.slice(0, H.index + 1);
        H.versions.forEach(function (v) { delete v.opening; });
      }
      H.index = H.versions.length - 1;
      H.loaded = true;
      if (!old.length || newer.length) saveHist(H);
      R.renderSoon();
    }
    R.doc('cortex', map.id).then(done, function () { done(null); });
    return H;
  }

  var histTimers = {};
  function saveHist(H) {
    clearTimeout(histTimers[H.map]);
    histTimers[H.map] = setTimeout(function () {
      R.docSave('cortex', H.map, { map: H.map, index: H.index, versions: H.versions })['catch'](function (e) {
        if (window.console) console.warn('Historique du cortex non enregistré : ' + (e && e.message));
      });
    }, 800);
  }

  /* Une version de plus : ce qui suivait la version courante (rétablir) est abandonné. */
  function commit(map, label, by) {
    var H = hist(map);
    H.versions = H.versions.slice(0, H.index + 1);
    H.versions.push({ id: R.uid('cv'), at: Date.now(), label: clip(label || 'Modification', 120), by: BY[by] ? by : 'user', snap: snapOf(map) });
    if (H.versions.length > MAX_VERSIONS) H.versions = H.versions.slice(-MAX_VERSIONS);
    H.index = H.versions.length - 1;
    if (H.loaded) saveHist(H);
  }

  function restoreSnap(map, snap) {
    var s = copy(snap);
    map.title = s.title || map.title; map.description = str(s.description);
    map.nodes = arr(s.nodes);
    repair(map);
    if (!node(map, U.sel[map.id])) U.sel[map.id] = rootOf(map).id;
    map.updatedAt = Date.now();
    R.save();
  }

  function undo(map) {
    var H = hist(map);
    if (H.index <= 0) { R.toast('Rien à annuler.'); return; }
    var v = H.versions[H.index];
    H.index--;
    restoreSnap(map, H.versions[H.index].snap);
    saveHist(H);
    U.note[map.id] = 'Annulé : ' + v.label + '.';
    R.render();
  }
  function redo(map) {
    var H = hist(map);
    if (H.index >= H.versions.length - 1) { R.toast('Rien à rétablir.'); return; }
    H.index++;
    restoreSnap(map, H.versions[H.index].snap);
    saveHist(H);
    U.note[map.id] = 'Rétabli : ' + H.versions[H.index].label + '.';
    R.render();
  }
  function restoreVersion(map, id) {
    var H = hist(map), v = H.versions.filter(function (x) { return x.id === id; })[0];
    if (!v) return;
    restoreSnap(map, v.snap);
    commit(map, 'Retour à la version du ' + when(v.at) + ' (' + v.label + ')', 'user');
    U.note[map.id] = 'Carte revenue à la version du ' + when(v.at) + '.';
    R.render();
  }

  /* Toute modification passe par ici : date, sauvegarde, version. */
  function touched(map, label, by) {
    map.updatedAt = Date.now();
    R.save();
    commit(map, label, by || 'user');
  }

  /* ══ Mise en page radiale ═══════════════════════════════════════════════ */

  function expKey(map, n) { return map.id + ':' + n.id; }
  function onSelPath(map, n) {
    var s = node(map, U.sel[map.id]);
    return !!s && (s.id === n.id || isUnder(map, s, n.id));
  }
  function isExpanded(map, n, d) {
    var k = U.expanded[expKey(map, n)];
    if (k != null) return k;
    return d < 2 || onSelPath(map, n);
  }

  function layout(map) {
    var root = rootOf(map), pos = {}, tree = [];
    function build(n, d) {
      var ch = isExpanded(map, n, d) ? kids(map, n.id) : [];
      var t = { n: n, d: d, ch: [], hidden: ch.length ? 0 : kids(map, n.id).length };
      t.ch = ch.map(function (c) { return build(c, d + 1); });
      t.leaves = t.ch.length ? t.ch.reduce(function (a, c) { return a + c.leaves; }, 0) : 1;
      tree.push(t);
      return t;
    }
    var top = build(root, 0);
    var maxD = tree.reduce(function (a, t) { return Math.max(a, t.d); }, 0);
    /* Les angles d'abord : chaque sous-arbre a une part proportionnelle à ses feuilles, et les enfants
       d'un nœud (hors racine) se déploient en éventail autour de lui, sur un demi-tour au plus. */
    var ang = {};
    function angles(t, a0, a1) {
      ang[t.n.id] = { a: (a0 + a1) / 2, d: t.d, t: t };
      var span = a1 - a0, mid = (a0 + a1) / 2;
      if (t.d > 0 && span > FAN) { a0 = mid - FAN / 2; a1 = mid + FAN / 2; span = FAN; }
      var cur = a0;
      t.ch.forEach(function (c) {
        var part = span * c.leaves / t.leaves;
        angles(c, cur, cur + part);
        cur += part;
      });
    }
    angles(top, -Math.PI / 2, 3 * Math.PI / 2);
    /* Puis les rayons : assez grands pour que deux voisins d'un même anneau ne se chevauchent pas. */
    var radius = [0];
    for (var d = 1; d <= maxD; d++) {
      var on = Object.keys(ang).filter(function (id) { return ang[id].d === d; }).map(function (id) { return ang[id].a; }).sort(function (x, y) { return x - y; });
      var gap = 2 * Math.PI;
      for (var i = 1; i < on.length; i++) gap = Math.min(gap, on[i] - on[i - 1]);
      if (on.length > 1) gap = Math.min(gap, 2 * Math.PI - (on[on.length - 1] - on[0]));
      radius.push(Math.max(radius[d - 1] + (d === 1 ? 200 : 180), on.length > 1 ? NODE_ARC / Math.max(gap, 0.05) : 0));
    }
    Object.keys(ang).forEach(function (id) {
      var A = ang[id];
      pos[id] = { x: A.d ? radius[A.d] * Math.cos(A.a) : 0, y: A.d ? radius[A.d] * Math.sin(A.a) : 0, a: A.a, d: A.d, t: A.t };
    });
    var xs = [], ys = [];
    Object.keys(pos).forEach(function (id) { xs.push(pos[id].x); ys.push(pos[id].y); });
    var padX = 130, padY = 70;
    var minX = Math.min.apply(null, xs) - padX, maxX = Math.max.apply(null, xs) + padX;
    var minY = Math.min.apply(null, ys) - padY, maxY = Math.max.apply(null, ys) + padY;
    Object.keys(pos).forEach(function (id) { pos[id].x -= minX; pos[id].y -= minY; });
    return { pos: pos, w: Math.round(maxX - minX), h: Math.round(maxY - minY), radius: radius, root: root, cx: -minX, cy: -minY };
  }

  /* ══ Agent : carte (create, expand, organize) ═══════════════════════════ */

  function nodesParam(map) {
    return map.nodes.map(function (n) { return { id: n.id, parent: n.parent, title: n.title, status: n.status, origin: n.origin, kind: n.kind }; });
  }

  function runAgent(map, mode, opts) {
    opts = opts || {};
    if (U.busy[map.id]) { if (mode === 'organize') U.again[map.id] = true; return; }
    U.busy[map.id] = { mode: mode, node: opts.node || '', at: Date.now() };
    U.error[map.id] = '';
    var params = { mode: mode, map: { title: map.title, description: map.description }, nodes: nodesParam(map), node: opts.node || '', request: opts.request || '' };
    R.render();
    R.gen('cortex', params).then(function (r) {
      delete U.busy[map.id];
      var m = mapById(map.id);
      if (!m) return;
      var n = apply(m, r && r.doc, opts.node || '');
      if (mode === 'create') U.centered = '';
      U.note[map.id] = str(r && r.doc && r.doc.noteFr) || (n ? plural(n, 'nouveau nœud', 'nouveaux nœuds') + '.' : 'Carte remise en ordre.');
      touched(m, { create: 'Plan de départ par l’agent', expand: 'Sous-thèmes proposés par l’agent', organize: 'Réorganisation par l’agent' }[mode] || 'Modification par l’agent', 'agent');
      R.renderSoon();
      if (U.again[map.id]) { delete U.again[map.id]; schedule(m); }
    }, function (e) {
      delete U.busy[map.id];
      U.error[map.id] = str(e && e.message) || 'L’agent n’a pas répondu.';
      R.renderSoon();
    });
  }

  /* Réorganisation automatique, après la dernière modification à la main. */
  var timers = {};
  function schedule(map) {
    if (!pref('cortexTidy')) return;
    clearTimeout(timers[map.id]);
    timers[map.id] = setTimeout(function () { var m = mapById(map.id); if (m && !isEmpty(m)) runAgent(m, 'organize'); }, TIDY_MS);
  }
  function edited(map, label) { touched(map, label, 'user'); schedule(map); }

  /* La réponse de l'agent, fusionnée dans la carte. Rend le nombre de nœuds ajoutés. */
  function apply(map, doc, focus) {
    doc = obj(doc) || {};
    var mode = str(doc.mode) || 'organize', out = arr(doc.nodes).filter(obj), now = Date.now();
    var root = rootOf(map), ids = {}, added = 0, newMax = mode === 'organize' ? 4 : 60;
    out.forEach(function (o) {
      var ref = str(o.ref);
      if (!ref || ids[ref]) return;
      if (node(map, ref)) ids[ref] = ref;
      else if (added < newMax && str(o.title).trim()) { ids[ref] = R.uid('cn'); added++; }
    });
    if (mode === 'organize') arr(doc.merged).forEach(function (m) { merge(map, str(m.from), ids[str(m.into)] || str(m.into)); });
    var fresh = {}, created = 0;
    out.forEach(function (o, i) {
      var id = ids[str(o.ref)];
      if (!id) return;
      var n = node(map, id);
      var pid = str(o.parent) ? (ids[str(o.parent)] || (node(map, str(o.parent)) ? str(o.parent) : '')) : '';
      if (!n) {
        if (!pid || pid === id) pid = mode === 'expand' && node(map, focus) ? focus : root.id;
        n = normNode({ id: id, parent: pid, title: o.title, summaryFr: o.summaryFr, query: o.query, status: 'open', origin: 'agent', order: mode === 'organize' ? i : 1000 + i, at: now }, i);
        map.nodes.push(n);
        fresh[id] = 1; created++;
        return;
      }
      if (n === root) { if (!n.summaryFr) n.summaryFr = str(o.summaryFr); return; }
      if (mode === 'organize') {
        var p = node(map, pid);
        if (p && p !== n && !isUnder(map, p, n.id)) n.parent = pid;
        if (str(o.title).trim()) n.title = clip(o.title, 80);
        n.order = i;
      }
      if (str(o.summaryFr) && (mode === 'organize' || !n.summaryFr)) n.summaryFr = str(o.summaryFr);
      if (str(o.query) && (mode === 'organize' || !n.query)) n.query = str(o.query);
    });
    repair(map);
    /* Nouveaux nœuds : à la suite de leurs frères (sauf en réorganisation, où l'ordre rendu vaut) ;
       verrouillés sous un nœud pas encore étudié, quand l'agent propose ; étapes s'ils sont dans un programme. */
    map.nodes.forEach(function (n) {
      if (!fresh[n.id]) return;
      n.status = 'open';
      if (programOf(map, n)) n.kind = 'step';
      if (mode !== 'organize') {
        var sib = kids(map, n.parent).filter(function (s) { return !fresh[s.id]; });
        n.order = (sib.length ? sib[sib.length - 1].order + 1 : 0) + n.order - 1000;
      }
    });
    renumber(map);
    if (mode === 'expand' && focus) U.expanded[map.id + ':' + focus] = true;
    return created;
  }

  function renumber(map) {
    var by = {};
    map.nodes.forEach(function (n) { (by[n.parent] = by[n.parent] || []).push(n); });
    Object.keys(by).forEach(function (p) { by[p].sort(function (a, b) { return a.order - b.order; }).forEach(function (n, i) { n.order = i; }); });
  }

  /* Fusion : les enfants et les cours de `from` passent à `into`, qui garde l'état le plus avancé. */
  function merge(map, fromId, intoId) {
    var from = node(map, fromId), into = node(map, intoId);
    if (!from || !into || from === into || !from.parent || isUnder(map, into, from.id)) return;
    map.nodes.forEach(function (n) { if (n.parent === from.id) n.parent = into.id; });
    from.lessons.forEach(function (l) { if (into.lessons.indexOf(l) < 0) into.lessons.push(l); });
    if (RANK[from.status] > RANK[into.status]) into.status = from.status;
    if (!into.summaryFr) into.summaryFr = from.summaryFr;
    map.nodes = map.nodes.filter(function (n) { return n !== from; });
    if (U.sel[map.id] === from.id) U.sel[map.id] = into.id;
  }

  /* ══ Agent : la discussion des programmes ═══════════════════════════════ */

  /* Le dernier programme proposé et pas encore ajouté : l'agent le révise plutôt que d'en refaire un. */
  function draftOf(map) {
    for (var i = map.chat.length - 1; i >= 0; i--) {
      var m = map.chat[i];
      if (m.role !== 'agent' || !obj(m.proposal) || m.proposal.action === 'none') continue;
      return m.applied || m.dismissed || m.proposal.action !== 'new' ? null : m;
    }
    return null;
  }
  function chatFocus(map) {
    if (U.focusOff[map.id]) return null;
    var n = node(map, U.sel[map.id]);
    return n && n.parent ? n : null;
  }

  function sendChat(map, text) {
    text = str(text).trim().slice(0, 2000);
    if (!text || U.chatBusy[map.id]) return;
    var draft = draftOf(map), focus = chatFocus(map);
    var history = map.chat.slice(-CHAT_SEND).map(function (m) { return { role: m.role, text: m.text }; });
    map.chat.push({ role: 'user', text: text, at: Date.now() });
    map.chat = map.chat.slice(-CHAT_KEEP);
    R.save();
    U.chatText = ''; U.chatBusy[map.id] = true; U.chatError[map.id] = '';
    R.render();
    R.gen('cortex', {
      mode: 'chat', map: { title: map.title, description: map.description }, nodes: nodesParam(map), node: focus ? focus.id : '',
      history: history, message: text,
      draft: draft ? { title: draft.proposal.title, attach: draft.proposal.attach, steps: draft.proposal.steps.map(function (s) { return { ref: s.ref, parent: s.parent, title: s.title }; }) } : null
    }).then(function (r) {
      delete U.chatBusy[map.id];
      var m = mapById(map.id), d = obj(r && r.doc) || {};
      if (!m) return;
      var prop = obj(d.proposal);
      if (prop && prop.action === 'revise' && !node(m, prop.target)) prop.action = 'none';
      if (draft && prop && prop.action === 'new') draft.dismissed = true;
      m.chat.push({ role: 'agent', text: str(d.reply), at: Date.now(), proposal: prop && prop.action !== 'none' ? prop : null, followUps: arr(d.followUps).slice(0, 3) });
      m.chat = m.chat.slice(-CHAT_KEEP);
      R.save();
      R.renderSoon();
      scrollChat();
    }, function (e) {
      delete U.chatBusy[map.id];
      U.chatError[map.id] = str(e && e.message) || 'L’agent n’a pas répondu.';
      R.renderSoon();
    });
    scrollChat();
  }
  function scrollChat() { setTimeout(function () { var el = document.querySelector('[data-rzc-chat]'); if (el) el.scrollTop = el.scrollHeight; }, 30); }

  /* Un programme proposé, ajouté à la carte (nouveau) ou appliqué au programme existant (révision). */
  function applyProposal(map, msg) {
    var p = obj(msg && msg.proposal);
    if (!p) return;
    var prog, label;
    if (p.action === 'revise' && node(map, p.target)) { prog = reviseProgram(map, node(map, p.target), p); label = 'Programme « ' + prog.title + ' » modifié avec l’agent'; }
    else { prog = createProgram(map, p); label = 'Programme « ' + prog.title + ' » ajouté'; }
    msg.applied = true;
    renumber(map);
    repair(map);
    U.sel[map.id] = prog.id;
    U.expanded[expKey(map, prog)] = true;
    U.centered = '';
    U.note[map.id] = label + ' : ' + plural(descendants(map, prog.id).length, 'étape') + '.';
    touched(map, label, 'agent');
    R.render();
  }

  function stepsInto(map, prog, steps, keep) {
    var ids = {}, now = Date.now();
    steps.forEach(function (s) { ids[s.ref] = keep && keep[s.ref] ? s.ref : R.uid('cn'); });
    steps.forEach(function (s, i) {
      var id = ids[s.ref], parent = s.parent && ids[s.parent] ? ids[s.parent] : prog.id;
      var n = keep && keep[s.ref];
      if (n) {
        n.parent = parent; n.title = clip(s.title, 80) || n.title; n.order = i; n.kind = 'step';
        if (s.summaryFr) n.summaryFr = str(s.summaryFr);
        if (s.query) n.query = str(s.query);
      } else {
        map.nodes.push(normNode({ id: id, parent: parent, title: s.title, summaryFr: s.summaryFr, query: s.query, status: 'open', origin: 'agent', kind: 'step', order: i, at: now }, i));
      }
    });
  }

  function createProgram(map, p) {
    var root = rootOf(map), at = node(map, p.attach) || root;
    var prog = normNode({ id: R.uid('cn'), parent: at.id, title: p.title, summaryFr: p.summaryFr, query: p.query, status: 'open', origin: 'agent', kind: 'program', order: kids(map, at.id).length, at: Date.now() }, 0);
    map.nodes.push(prog);
    stepsInto(map, prog, arr(p.steps), null);
    U.expanded[expKey(map, at)] = true;
    return prog;
  }

  /* Révision : les étapes rendues avec leur ref gardent leur état et leurs cours ; les étapes absentes
     sont retirées, sauf celles qui ont déjà des cours (rangées à la fin). */
  function reviseProgram(map, prog, p) {
    var keep = {};
    descendants(map, prog.id).forEach(function (n) { keep[n.id] = n; });
    var kept = {};
    arr(p.steps).forEach(function (s) { if (keep[s.ref]) kept[s.ref] = 1; });
    map.nodes = map.nodes.filter(function (n) { return !keep[n.id] || kept[n.id] || n.lessons.length; });
    var orphans = Object.keys(keep).filter(function (id) { return !kept[id] && keep[id].lessons.length; });
    prog.title = clip(p.title, 80) || prog.title;
    if (p.summaryFr) prog.summaryFr = str(p.summaryFr);
    if (p.query) prog.query = str(p.query);
    prog.kind = 'program';
    stepsInto(map, prog, arr(p.steps), keep);
    orphans.forEach(function (id, i) { var n = node(map, id); if (n) { n.parent = prog.id; n.order = 900 + i; } });
    return prog;
  }

  /* ══ Modifications à la main ════════════════════════════════════════════ */

  function addChild(map, parentId, title) {
    title = clip(title, 80);
    var p = node(map, parentId);
    if (!title || !p) return null;
    var dup = kids(map, p.id).filter(function (k) { return key(k.title) === key(title); })[0];
    if (dup) { R.toast('« ' + dup.title + ' » existe déjà ici.'); return dup; }
    var sib = kids(map, p.id);
    var n = normNode({ id: R.uid('cn'), parent: p.id, title: title, status: 'open', origin: 'user', kind: programOf(map, p) ? 'step' : '', order: sib.length, at: Date.now() }, sib.length);
    map.nodes.push(n);
    U.expanded[expKey(map, p)] = true;
    edited(map, 'Ajout de « ' + n.title + ' »');
    return n;
  }

  /* Supprimer un nœud seul (ses enfants remontent d'un cran) ou avec toute sa branche. */
  function removeNode(map, id, branchToo) {
    var n = node(map, id);
    if (!n || !n.parent) return 0;
    var gone = 1;
    if (branchToo) {
      var drop = {};
      descendants(map, n.id).forEach(function (d) { drop[d.id] = 1; gone++; });
      map.nodes = map.nodes.filter(function (x) { return !drop[x.id]; });
    } else {
      var at = n.order;
      kids(map, n.id).forEach(function (k, i) { k.parent = n.parent; k.order = at + 0.1 + i / 100; });
    }
    map.nodes = map.nodes.filter(function (x) { return x !== n; });
    renumber(map);
    U.sel[map.id] = n.parent;
    edited(map, 'Suppression de « ' + n.title + ' »' + (branchToo && gone > 1 ? ' et de ' + plural(gone - 1, 'sous-thème') : ''));
    return gone;
  }

  function setStatus(map, n, s) {
    n.status = s;
    if (studied(s)) n.studiedAt = n.studiedAt || Date.now();
  }

  /* ══ Pour lesson.js ═════════════════════════════════════════════════════ */

  /* L'étape suivante d'un programme : la première pas encore étudiée, dans l'ordre de lecture
     (une période, puis ses sous-étapes, puis la période suivante). */
  function nextStep(map, prog) {
    return descendants(map, prog.id).filter(function (x) { return !studied(x.status); })[0] || null;
  }

  /* Ce qui se prête à un cours : ce qui demande un approfondissement, l'étape suivante de chaque
     programme, puis les nœuds ouverts jamais étudiés (hors programmes), la carte courante en premier. */
  function suggest(n) {
    var cur = current(), out = [];
    var list = maps().slice().sort(function (a, b) { return (b === cur) - (a === cur) || num(b.updatedAt, 0) - num(a.updatedAt, 0); });
    list.forEach(function (m) {
      var bonus = m === cur ? 0 : 3;
      m.nodes.forEach(function (x) {
        if (!x.parent) return;
        var s = status(m, x), prog = programOf(m, x);
        if (x.kind === 'program') {
          var nx = nextStep(m, x);
          if (nx) out.push({ map: m, node: nx, s: status(m, nx), score: 2 + bonus + nx.order / 100 });
          return;
        }
        if (prog) { if (s === 'deepen') out.push({ map: m, node: x, s: s, score: 1 + bonus }); return; }
        if (s === 'studied') return;
        var p = node(m, x.parent);
        out.push({ map: m, node: x, s: s, score: (s === 'deepen' ? 0 : 10) + depth(m, x) + (p && studied(p.status) ? -0.5 : 0) + bonus + x.order / 100 });
      });
    });
    var seen = {};
    return out.sort(function (a, b) { return a.score - b.score; }).filter(function (x) {
      var k = x.map.id + ':' + x.node.id;
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    }).slice(0, n || 6);
  }

  function lessonParams(mapId, nodeId, depthWanted) {
    var m = mapById(mapId), n = node(m, nodeId);
    if (!n) return null;
    var p = pathOf(m, n), last = n.lessons.length ? lessonEntry(n.lessons[n.lessons.length - 1]) : null;
    var out = {
      map: m.id, node: n.id, mapTitle: m.title,
      path: p.map(function (x) { return x.title; }),
      summary: n.summaryFr,
      depth: depthWanted === 'deepen' || (depthWanted == null && studied(n.status)) ? 'deepen' : 'intro',
      previous: last ? clip(last.title + (arr(last.keywords).length ? ' (' + arr(last.keywords).slice(0, 5).join(', ') + ')' : ''), 280) : '',
      children: kids(m, n.id).map(function (k) { return k.title; }).slice(0, 12),
      studied: m.nodes.filter(function (x) { return x.parent && x !== n && studied(x.status); }).sort(function (a, b) { return num(b.studiedAt, 0) - num(a.studiedAt, 0); })
        .slice(0, 16).map(function (x) { return x.title; })
    };
    var prog = programOf(m, n);
    if (prog && prog !== n) {
      var steps = descendants(m, prog.id), i = steps.indexOf(n);
      out.program = prog.title; out.step = i + 1; out.steps = steps.length;
      out.prevStep = i > 0 ? steps[i - 1].title : '';
      out.nextStep = i >= 0 && i < steps.length - 1 ? steps[i + 1].title : '';
    }
    return out;
  }
  function lessonEntry(id) { return arr(R.data.lessons).filter(function (l) { return l && l.id === id; })[0] || null; }

  /* Un cours du cortex terminé : le nœud est étudié (ou à approfondir), ses enfants s'ouvrent, et quand
     l'agent propose (hors programme, qui a déjà sa suite), les sujets suivants du cours deviennent des sous-nœuds. */
  function lessonDone(e, L) {
    var link = obj(e && e.cortex), m = link && mapById(link.map), n = m && node(m, link.node);
    if (!n) return;
    if (n.lessons.indexOf(e.id) < 0) n.lessons.push(e.id);
    var res = obj(e.result) || {};
    var hard = res.self === 'hard' || (res.score != null && num(res.score, 1) < 0.6);
    setStatus(m, n, hard ? 'deepen' : 'studied');
    n.studiedAt = Date.now();
    var added = 0;
    if (pref('cortexGrow') && L && !programOf(m, n)) {
      arr(L.nextTopics).slice(0, 3).forEach(function (t, i) {
        var title = clip(t.title, 80);
        if (!title || m.nodes.some(function (x) { return key(x.title) === key(title); })) return;
        m.nodes.push(normNode({ id: R.uid('cn'), parent: n.id, title: title, summaryFr: str(t.pitchFr), query: str(t.query), status: 'open', origin: 'lesson', order: kids(m, n.id).length + i, at: Date.now() }, 0));
        added++;
      });
      renumber(m);
    }
    U.sel[m.id] = n.id; U.reveal = true; U.popOff[m.id] = false;
    var prog = programOf(m, n), nx = prog && nextStep(m, prog);
    U.note[m.id] = '« ' + n.title + ' » : ' + (hard ? 'à approfondir' : 'étudié') + (added ? ', ' + plural(added, 'nouveau sous-thème', 'nouveaux sous-thèmes') : '')
      + (prog ? (nx ? ' ; prochaine étape : « ' + nx.title + ' »' : ' ; programme « ' + prog.title + ' » terminé !') : '') + '.';
    touched(m, 'Cours terminé : « ' + n.title + ' »', 'lesson');
    if (added) schedule(m);
  }

  R.cortex = {
    suggest: suggest,
    get: function (mapId, nodeId) { var m = mapById(mapId); return m ? { map: m, node: node(m, nodeId) } : null; },
    path: function (mapId, nodeId) { var m = mapById(mapId), n = node(m, nodeId); return n ? pathOf(m, n).map(function (x) { return x.title; }) : []; },
    status: function (mapId, nodeId) { var m = mapById(mapId), n = node(m, nodeId); return n ? status(m, n) : ''; },
    lessonParams: lessonParams,
    lessonDone: lessonDone,
    statusLabel: function (s) { return STATUS[s] || ''; }
  };

  /* ══ Rendu ══════════════════════════════════════════════════════════════ */

  function render() {
    var map = current();
    hist(map);
    var h = ['<div class="rzc' + (U.full ? ' is-full' : '') + '">'];
    if (!U.full) {
      h.push('<div class="rzc-head"><div><div class="rz-kicker">' + icon('node') + ' Le cortex</div><h1 class="rzc-title">Ce que vous voulez savoir</h1>'
        + '<p class="rzc-lead">Vos cartes des savoirs, construites au fil de l’eau avec l’agent. Chaque nœud donne un cours d’anglais de fond, et chaque cours fait avancer la carte.</p></div></div>');
    }
    h.push(mapsBarHtml(map));
    if (U.newOpen) h.push(newMapHtml());
    if (U.trashOpen) h.push(trashHtml());
    h.push('<div class="rzc-body">');
    h.push('<section class="rz-card rzc-board">' + toolbarHtml(map) + '<div class="rzc-wrap">' + canvasHtml(map) + popHtml(map) + (U.histOpen ? historyHtml(map) : '') + '</div>' + legendHtml() + '</section>');
    h.push('<aside class="rzc-side">' + chatHtml(map) + '</aside>');
    h.push('</div></div>');
    return h.join('');
  }

  function mapsBarHtml(map) {
    var c = store();
    return '<div class="rzc-maps" role="tablist">' + maps().map(function (m) {
      var on = m === map, n = m.nodes.length - 1, done = m.nodes.filter(function (x) { return x.parent && studied(x.status); }).length;
      return '<button type="button" role="tab" aria-selected="' + on + '" class="rzc-map' + (on ? ' on' : '') + '" data-act="rz-cortex-map" data-id="' + esc(m.id) + '">'
        + '<span class="rzc-map-t">' + esc(m.title) + '</span><span class="rzc-map-m">' + esc(n ? done + ' / ' + n : 'vide') + '</span></button>';
    }).join('') + '<button type="button" class="btn btn-ghost rzc-map-new" data-act="rz-cortex-new">+ Nouvelle carte</button>'
      + (c.trash.length ? '<button type="button" class="btn btn-ghost rzc-map-new" data-act="rz-cortex-trash">Corbeille · ' + c.trash.length + '</button>' : '') + '</div>';
  }

  function newMapHtml() {
    return '<section class="rz-card rzc-new"><div class="rz-card-head"><span class="rz-card-title">Nouvelle carte</span>'
      + '<button type="button" class="btn btn-ghost" data-act="rz-cortex-new">Fermer</button></div>'
      + '<label class="rzc-field"><span class="rzl-k">Domaine</span><input class="input" type="text" data-role="rz-cortex-new-title" data-focus-key="rzc-new-title" maxlength="80" placeholder="Le bricolage, l’informatique, l’histoire, le jazz…" value="' + esc(U.newTitle) + '"></label>'
      + '<div class="rz-row"><button type="button" class="btn btn-primary" data-act="rz-cortex-create">Créer la carte</button>'
      + '<span class="rz-muted">Elle commence vide : demandez ensuite un programme à l’agent.</span></div></section>';
  }

  function trashHtml() {
    var c = store();
    return '<section class="rz-card rzc-new"><div class="rz-card-head"><span class="rz-card-title">Corbeille</span><button type="button" class="btn btn-ghost" data-act="rz-cortex-trash">Fermer</button></div>'
      + (c.trash.length ? '<ul class="rzc-lessons">' + c.trash.slice().reverse().map(function (t) {
        return '<li class="rzc-trash-row"><span>Supprimée ' + esc(when(t.at)) + '</span><b>' + esc(t.map.title) + '</b><span class="rz-muted">' + esc(plural(arr(t.map.nodes).length - 1, 'nœud')) + '</span>'
          + '<button type="button" class="btn btn-secondary" data-act="rz-cortex-untrash" data-id="' + esc(t.map.id) + '">Restaurer</button></li>';
      }).join('') + '</ul>' : '<div class="rz-muted">La corbeille est vide.</div>') + '</section>';
  }

  /* Barre d'outils : annuler, rétablir, historique, grand écran. Le reste vient de l'agent. */
  function toolbarHtml(map) {
    var busy = U.busy[map.id], H = hist(map);
    var h = '<div class="rzc-tools"><div class="rzc-tools-l">'
      + '<button type="button" class="rzc-tool" data-act="rz-cortex-undo"' + (H.index > 0 ? '' : ' disabled') + ' title="Annuler (Ctrl+Z)' + (H.versions[H.index] && H.index > 0 ? ' : ' + esc(H.versions[H.index].label) : '') + '" aria-label="Annuler">↶</button>'
      + '<button type="button" class="rzc-tool" data-act="rz-cortex-redo"' + (H.index < H.versions.length - 1 ? '' : ' disabled') + ' title="Rétablir (Ctrl+Y)" aria-label="Rétablir">↷</button>'
      + '<button type="button" class="rzc-tool is-text' + (U.histOpen ? ' on' : '') + '" data-act="rz-cortex-hist" title="Toutes les versions de la carte">' + icon('clock') + ' Historique</button>'
      + '</div><div class="rzc-tools-r">'
      + (busy ? '<span class="rzc-busy"><span class="rz-spin"></span> ' + esc({ create: 'L’agent dresse le plan…', expand: 'L’agent cherche des sous-thèmes…', organize: 'L’agent remet la carte en ordre…' }[busy.mode] || 'L’agent travaille…') + '</span>' : '')
      + '<button type="button" class="rzc-tool is-text" data-act="rz-cortex-full" title="' + (U.full ? 'Quitter le grand écran (Échap)' : 'Grand écran') + '">' + (U.full ? '⤡ Quitter' : '⤢ Grand écran') + '</button>'
      + '</div></div>';
    if (U.error[map.id]) h += '<div class="rzc-status is-error" role="alert">' + icon('cross') + ' ' + esc(U.error[map.id]) + '</div>';
    else if (U.note[map.id]) h += '<div class="rzc-status">' + icon('check') + ' ' + esc(U.note[map.id]) + '</div>';
    return h;
  }

  function canvasHtml(map) {
    var L = layout(map), sel = U.sel[map.id] || L.root.id;
    var links = [], nodes = [];
    var ring = L.radius.slice(1).map(function (r) { return '<circle cx="' + L.cx + '" cy="' + L.cy + '" r="' + Math.round(r) + '"></circle>'; }).join('');
    Object.keys(L.pos).forEach(function (id) {
      var P = L.pos[id], n = P.t.n;
      if (n.parent && L.pos[n.parent]) {
        var Q = L.pos[n.parent], rm = (L.radius[P.d - 1] + L.radius[P.d]) / 2;
        var c1x = Q.d ? L.cx + rm * Math.cos(Q.a) : Q.x, c1y = Q.d ? L.cy + rm * Math.sin(Q.a) : Q.y;
        var c2x = L.cx + rm * Math.cos(P.a), c2y = L.cy + rm * Math.sin(P.a);
        links.push('<path class="rzc-h' + branch(map, n) + '" d="M' + r1(Q.x) + ' ' + r1(Q.y) + 'C' + r1(c1x) + ' ' + r1(c1y) + ' ' + r1(c2x) + ' ' + r1(c2y) + ' ' + r1(P.x) + ' ' + r1(P.y) + '"></path>');
      }
      var s = n.parent ? n.status : 'root';
      var hid = P.t.hidden;
      var par = n.parent && node(map, n.parent), num1 = n.kind === 'step' && par && par.kind === 'program' ? (n.order + 1) + '. ' : '';
      nodes.push('<button type="button" class="rzc-node is-' + s + (n.kind ? ' is-' + n.kind : '') + ' rzc-h' + branch(map, n) + ' d' + Math.min(P.d, 3) + (id === sel ? ' on' : '') + '" style="left:' + r1(P.x) + 'px;top:' + r1(P.y) + 'px"'
        + ' data-act="rz-cortex-sel" data-id="' + esc(id) + '" aria-pressed="' + (id === sel) + '" title="' + esc((n.kind === 'program' ? 'Programme · ' : '') + (STATUS[s] ? STATUS[s] + ' · ' : '') + n.title + (n.summaryFr ? ' — ' + n.summaryFr : '')) + '">'
        + (s === 'studied' ? '<i class="rzc-badge is-ok">' + icon('check') + '</i>' : (s === 'deepen' ? '<i class="rzc-badge is-deep">↻</i>' : ''))
        + (n.kind === 'program' ? '<span class="rzc-prog-k">Programme</span>' : '')
        + '<span class="rzc-node-t">' + esc(num1 + n.title) + '</span>'
        + (hid ? '<span class="rzc-more">+' + hid + '</span>' : '') + '</button>');
    });
    var empty = isEmpty(map) ? '<div class="rzc-empty"><div class="rzc-empty-t">Votre cortex est vide</div>'
      + '<p>Dites à l’agent, à droite, ce que vous voulez apprendre : il vous propose un programme, étape par étape, que vous rediscutez avant de l’ajouter.</p>'
      + '<div class="rzc-examples">' + EXAMPLES.slice(0, 2).map(function (x) { return '<button type="button" class="rzc-ex" data-act="rz-cortex-ask" data-text="' + esc(x) + '">' + esc(x) + '</button>'; }).join('') + '</div></div>' : '';
    return '<div class="rzc-canvas" data-rzc-canvas data-map="' + esc(map.id) + '"><div class="rzc-stage" style="width:' + L.w + 'px;height:' + L.h + 'px;zoom:' + U.zoom + '" data-cx="' + r1(L.cx) + '" data-cy="' + r1(L.cy) + '">'
      + '<svg class="rzc-links" width="' + L.w + '" height="' + L.h + '" aria-hidden="true"><g class="rzc-rings">' + ring + '</g>' + links.join('') + '</svg>'
      + nodes.join('') + '</div>' + empty + '</div>';
  }
  function r1(v) { return Math.round(v * 10) / 10; }

  function legendHtml() {
    return '<div class="rzc-legend"><span><i class="rzc-dot is-open"></i>À étudier</span><span><i class="rzc-dot is-studied"></i>Étudié</span><span><i class="rzc-dot is-deepen"></i>À approfondir</span>'
      + '<span class="rz-muted">Molette : zoom · glisser : déplacer · +N : sous-thèmes repliés</span></div>';
  }

  /* Le nœud choisi, dans une petite carte posée sur la carte mentale : le cours, l'état, et les retouches. */
  function popHtml(map) {
    var n = node(map, U.sel[map.id]);
    if (!n || U.popOff[map.id]) return '';
    var s = n.status, prog = programOf(map, n), ch = kids(map, n.id);
    var h = ['<div class="rzc-pop" role="dialog" aria-label="' + esc(n.title) + '"><button type="button" class="rzc-pop-x" data-act="rz-cortex-pop-close" aria-label="Fermer">✕</button>'];
    var p = pathOf(map, n);
    if (p.length > 1) h.push('<nav class="rzc-crumbs">' + p.slice(0, -1).map(function (x) { return '<button type="button" class="rzc-crumb" data-act="rz-cortex-sel" data-id="' + esc(x.id) + '">' + esc(x.title) + '</button>'; }).join('<span>›</span>') + '</nav>');
    if (U.rename === n.id) {
      h.push('<div class="rzc-rename"><input class="input" type="text" data-role="rz-cortex-rename" data-focus-key="rzc-rename" maxlength="80" value="' + esc(n.title) + '">'
        + '<button type="button" class="btn btn-primary" data-act="rz-cortex-rename-ok">OK</button></div>');
    } else h.push((n.kind === 'program' ? '<div class="rzc-k">Programme</div>' : '') + '<div class="rzc-pop-t">' + esc(n.title) + '</div>');
    if (n.summaryFr) h.push('<p class="rzc-panel-p">' + esc(n.summaryFr) + '</p>');

    if (n.kind === 'program') {
      var nx = nextStep(map, n), all = descendants(map, n.id), done = all.filter(function (x) { return studied(x.status); }).length;
      h.push('<div class="rzc-prog"><div class="rzc-home-bar" aria-hidden="true"><i style="width:' + (all.length ? Math.round(done / all.length * 100) : 0) + '%"></i></div><span class="rz-muted">' + esc(done + ' / ' + all.length + ' étapes étudiées') + '</span></div>');
      if (nx) h.push('<button type="button" class="btn btn-primary rzc-cta" data-act="rz-cortex-lesson" data-id="' + esc(nx.id) + '" data-depth="intro">' + icon('spark') + ' Étape suivante : ' + esc(nx.title) + '</button>');
      else if (all.length) h.push('<div class="rzc-hint">Programme terminé. Demandez à l’agent de le prolonger, ou approfondissez une étape.</div>');
    } else if (n.parent) {
      var deep = studied(s);
      h.push('<button type="button" class="btn btn-primary rzc-cta" data-act="rz-cortex-lesson" data-depth="' + (deep ? 'deepen' : 'intro') + '">' + icon('spark') + ' ' + (deep ? 'Un cours pour approfondir' : 'Préparer le cours') + '</button>');
      if (prog) h.push('<div class="rz-muted rzc-pop-step">Étape ' + (descendants(map, prog.id).indexOf(n) + 1) + ' sur ' + descendants(map, prog.id).length + ' de « ' + esc(prog.title) + ' »</div>');
      h.push(R.h.chips('rzc-st', ['open', 'studied', 'deepen'], s, ['À étudier', 'Étudié', 'À approfondir'], 'rz-cortex-status'));
    } else {
      h.push('<p class="rzc-panel-p">' + esc(ch.length ? 'La racine de « ' + map.title + ' » : ' + plural(ch.length, 'grand thème') + '.' : 'La racine de la carte, encore vide.') + '</p>');
    }
    if (n.lessons.length) h.push('<div class="rz-muted rzc-pop-step">' + esc(plural(n.lessons.length, 'cours fait', 'cours faits') + ' sur ce nœud') + '</div>');

    h.push('<div class="rzc-add"><input class="input" type="text" data-role="rz-cortex-add" data-focus-key="rzc-add" maxlength="80" placeholder="' + esc(n.kind === 'program' ? 'Ajouter une étape' : (n.parent ? 'Ajouter un sous-thème' : 'Ajouter un grand thème')) + '" value="' + esc(U.add) + '">'
      + '<button type="button" class="btn btn-secondary" data-act="rz-cortex-add" aria-label="Ajouter">+</button></div>');

    h.push('<div class="rzc-foot">');
    h.push('<button type="button" class="btn btn-ghost" data-act="rz-cortex-discuss">' + icon('chat') + ' En parler à l’agent</button>');
    h.push('<button type="button" class="btn btn-ghost" data-act="rz-cortex-rename">Renommer</button>');
    if (n.parent) {
      var nk = descendants(map, n.id).length;
      if (U.confirmDel === n.id) {
        h.push('<span class="rzc-confirm">Supprimer ?'
          + (nk ? ' <button type="button" class="btn btn-ghost rzc-danger" data-act="rz-cortex-del" data-branch="1">Avec ' + esc(plural(nk, 'sous-thème')) + '</button><button type="button" class="btn btn-ghost rzc-danger" data-act="rz-cortex-del">Le nœud seul</button>'
            : ' <button type="button" class="btn btn-ghost rzc-danger" data-act="rz-cortex-del">Oui</button>')
          + '<button type="button" class="btn btn-ghost" data-act="rz-cortex-del-cancel">Non</button></span>');
      } else h.push('<button type="button" class="btn btn-ghost rzc-danger" data-act="rz-cortex-del-ask">Supprimer</button>');
    } else {
      h.push('<button type="button" class="btn btn-ghost rzc-danger" data-act="rz-cortex-del-map">' + esc(U.confirmDel === map.id ? 'Confirmer : à la corbeille' : 'Supprimer la carte') + '</button>');
    }
    h.push('</div></div>');
    return h.join('');
  }

  /* La discussion avec l'agent : messages, programmes proposés (aperçu, ajout, révision), relances. */
  function chatHtml(map) {
    var focus = chatFocus(map), busy = U.chatBusy[map.id];
    var h = ['<section class="rz-card rzc-chat"><div class="rzc-chat-head">' + icon('chat') + ' L’agent<span class="rz-muted">' + esc(map.title) + '</span></div>'];
    h.push('<div class="rzc-chat-log" data-rzc-chat>');
    if (!map.chat.length) {
      h.push('<div class="rzc-msg is-agent"><div class="rzc-bubble"><p>Bonjour ! Dites-moi ce que vous voulez apprendre, aussi largement que vous voulez : je vous propose un <b>programme</b>, une suite d’étapes dans l’ordre, chacune un cours d’anglais. On le rediscute ensemble, puis vous l’ajoutez à votre cortex.</p></div></div>');
      h.push('<div class="rzc-examples">' + EXAMPLES.map(function (x) { return '<button type="button" class="rzc-ex" data-act="rz-cortex-ask" data-text="' + esc(x) + '">' + esc(x) + '</button>'; }).join('') + '</div>');
    }
    var last = map.chat.length - 1;
    map.chat.forEach(function (m, i) {
      if (m.role === 'user') { h.push('<div class="rzc-msg is-user"><div class="rzc-bubble">' + prose(m.text) + '</div></div>'); return; }
      h.push('<div class="rzc-msg is-agent"><div class="rzc-bubble">' + prose(m.text) + (obj(m.proposal) ? proposalHtml(map, m, i) : '') + '</div></div>');
      if (i === last && !busy && arr(m.followUps).length) h.push('<div class="rzc-examples">' + m.followUps.map(function (x) { return '<button type="button" class="rzc-ex" data-act="rz-cortex-ask" data-text="' + esc(x) + '">' + esc(x) + '</button>'; }).join('') + '</div>');
    });
    if (busy) h.push('<div class="rzc-msg is-agent"><div class="rzc-bubble rzc-typing"><span class="rz-spin"></span> L’agent réfléchit…</div></div>');
    if (U.chatError[map.id]) h.push('<div class="rzc-status is-error" role="alert">' + icon('cross') + ' ' + esc(U.chatError[map.id]) + '</div>');
    h.push('</div>');
    h.push('<div class="rzc-chat-foot">');
    if (focus) h.push('<div class="rzc-focus">À propos de : <b>' + esc(focus.title) + '</b>' + (focus.kind === 'program' ? ' (programme)' : '') + ' <button type="button" class="btn btn-ghost rzc-inline" data-act="rz-cortex-unfocus" title="Parler de toute la carte">✕</button></div>');
    h.push('<div class="rzc-chat-in"><textarea class="input" rows="2" data-role="rz-cortex-chat" data-focus-key="rzc-chat" maxlength="2000" placeholder="' + esc(draftOf(map) ? 'Rediscutez le programme : « plus court », « ajoute l’Égypte »…' : 'Ex. un programme qui va du début de l’humanité à la fin') + '"' + (busy ? ' disabled' : '') + '>' + esc(U.chatText) + '</textarea>'
      + '<button type="button" class="btn btn-primary" data-act="rz-cortex-send"' + (busy ? ' disabled' : '') + '>Envoyer</button></div>');
    if (map.chat.length) h.push('<div class="rzc-chat-meta"><button type="button" class="btn btn-ghost rzc-inline" data-act="rz-cortex-chat-clear">Effacer la discussion</button></div>');
    h.push('</div></section>');
    return h.join('');
  }

  function proposalHtml(map, m, i) {
    var p = m.proposal, steps = arr(p.steps), byParent = {};
    steps.forEach(function (s) { (byParent[s.parent || ''] = byParent[s.parent || ''] || []).push(s); });
    function list(parent) {
      var l = byParent[parent] || [];
      if (!l.length) return '';
      return '<ol>' + l.map(function (s) { return '<li><b>' + esc(s.title) + '</b>' + (s.summaryFr ? '<span>' + esc(s.summaryFr) + '</span>' : '') + list(s.ref) + '</li>'; }).join('') + '</ol>';
    }
    var target = p.action === 'revise' ? node(map, p.target) : null, attach = node(map, p.attach);
    var h = '<div class="rzc-proposal' + (m.applied ? ' is-applied' : '') + (m.dismissed ? ' is-dismissed' : '') + '">'
      + '<div class="rzc-proposal-k">' + (p.action === 'revise' ? 'Révision du programme' : 'Programme proposé') + ' · ' + esc(plural(steps.length, 'étape')) + (attach && attach.parent ? ' · sous « ' + esc(attach.title) + ' »' : '') + '</div>'
      + '<div class="rzc-proposal-t">' + esc(p.title) + '</div>' + (p.summaryFr ? '<div class="rz-muted">' + esc(p.summaryFr) + '</div>' : '')
      + list('');
    if (m.applied) h += '<div class="rzc-proposal-done">' + icon('check') + ' ' + (p.action === 'revise' ? 'Appliqué au programme' : 'Ajouté à votre cortex') + '</div>';
    else if (m.dismissed) h += '<div class="rz-muted">Remplacé par une version plus récente.</div>';
    else h += '<div class="rz-row"><button type="button" class="btn btn-primary" data-act="rz-cortex-apply" data-i="' + i + '">' + (p.action === 'revise' ? 'Appliquer à « ' + esc(target ? target.title : p.title) + ' »' : 'Ajouter au cortex') + '</button></div>';
    return h + '</div>';
  }

  /* Toutes les versions de la carte, dans un volet posé sur la carte mentale. */
  function historyHtml(map) {
    var H = hist(map);
    var h = ['<div class="rzc-hist"><div class="rzc-hist-head"><span class="rzc-k">Historique de « ' + esc(map.title) + ' »</span><button type="button" class="rzc-pop-x" data-act="rz-cortex-hist" aria-label="Fermer">✕</button></div>'];
    if (!H.loaded && H.versions.length < 2) h.push('<div class="rz-muted"><span class="rz-spin"></span> Lecture de l’historique…</div>');
    h.push('<ol class="rzc-versions">' + H.versions.map(function (v, i) { return { v: v, i: i }; }).reverse().map(function (x) {
      var cur = x.i === H.index, later = x.i > H.index;
      return '<li class="' + (cur ? 'on' : '') + (later ? ' is-after' : '') + '"><div class="rzc-v-l"><b>' + esc(x.v.label) + '</b><span class="rz-muted">' + esc(when(x.v.at) + ' · ' + (BY[x.v.by] || 'vous') + ' · ' + plural(arr(x.v.snap && x.v.snap.nodes).length - 1, 'nœud')) + '</span></div>'
        + (cur ? '<span class="rzc-tag">actuelle</span>' : '<button type="button" class="btn btn-ghost" data-act="rz-cortex-restore" data-id="' + esc(x.v.id) + '">Revenir ici</button>') + '</li>';
    }).join('') + '</ol>');
    return h.join('') + '</div>';
  }

  /* Zoom à la molette (sous le pointeur) et déplacement en faisant glisser le fond. Le zoom change le style
     de la scène sans rendu complet. */
  function bindCanvas(c) {
    if (c.__rzc) return;
    c.__rzc = true;
    c.addEventListener('wheel', function (e) {
      var st = c.firstChild;
      if (!st || !st.style) return;
      e.preventDefault();
      var z0 = U.zoom, z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z0 * Math.exp(-e.deltaY * 0.0015)));
      if (z === z0) return;
      var r = c.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      var ux = (c.scrollLeft + mx) / z0, uy = (c.scrollTop + my) / z0;
      U.zoom = z;
      st.style.zoom = z;
      c.scrollLeft = ux * z - mx;
      c.scrollTop = uy * z - my;
    }, { passive: false });
    var drag = null;
    c.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || (e.target.closest && e.target.closest('button, a, input, textarea'))) return;
      drag = { x: e.clientX, y: e.clientY, l: c.scrollLeft, t: c.scrollTop };
      c.classList.add('is-drag');
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* pointeur perdu */ }
    });
    c.addEventListener('pointermove', function (e) {
      if (!drag) return;
      c.scrollLeft = drag.l - (e.clientX - drag.x);
      c.scrollTop = drag.t - (e.clientY - drag.y);
    });
    function end() { drag = null; c.classList.remove('is-drag'); }
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  /* Au premier affichage d'une carte, on centre la racine ; ensuite, un nœud choisi hors de vue est ramené au centre. */
  function after(host) {
    document.documentElement.classList.toggle('rzc-noscroll', !!U.full);
    var c = host.querySelector('[data-rzc-canvas]');
    if (!c) return;
    bindCanvas(c);
    var mapId = c.getAttribute('data-map');
    if (U.centered !== mapId + ':' + U.full) {
      U.centered = mapId + ':' + U.full;
      var st = c.firstChild, cx = num(st.getAttribute('data-cx'), 0) * U.zoom, cy = num(st.getAttribute('data-cy'), 0) * U.zoom;
      c.scrollLeft = Math.max(0, cx - c.clientWidth / 2);
      c.scrollTop = Math.max(0, cy - c.clientHeight / 2);
    } else if (U.scrollMemo && U.scrollMemo.map === mapId) {
      c.scrollLeft = U.scrollMemo.l; c.scrollTop = U.scrollMemo.t;
    }
    c.addEventListener('scroll', function () { U.scrollMemo = { map: mapId, l: c.scrollLeft, t: c.scrollTop }; }, { passive: true });
    var sel = c.querySelector('.rzc-node.on');
    if (sel && U.reveal) {
      U.reveal = false;
      var cr = c.getBoundingClientRect(), r = sel.getBoundingClientRect(), m = 24;
      if (r.left < cr.left + m || r.right > cr.right - m || r.top < cr.top + m || r.bottom > cr.bottom - m) {
        c.scrollLeft += (r.left + r.width / 2) - (cr.left + cr.width / 2);
        c.scrollTop += (r.top + r.height / 2) - (cr.top + cr.height / 2);
      }
    }
    var log = host.querySelector('[data-rzc-chat]');
    if (log && log.getAttribute('data-n') !== String(current().chat.length)) { log.setAttribute('data-n', String(current().chat.length)); log.scrollTop = log.scrollHeight; }
  }

  R.view('cortex', {
    label: 'Cortex', icon: 'node', order: 15, title: 'Le cortex — vos cartes des savoirs, et des cours de fond',
    render: render, after: after,
    onShow: function (p) {
      if (p && p.map && mapById(p.map)) { store().current = p.map; if (p.node) U.sel[p.map] = p.node; }
    },
    onHide: function () { if (U.full) { U.full = false; document.documentElement.classList.remove('rzc-noscroll'); } },
    keydown: function (e, el, role) {
      var typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (e.key === 'Escape' && !typing) {
        var cm = current();
        if (U.histOpen) { e.preventDefault(); U.histOpen = false; R.render(); return true; }
        if (U.full) { e.preventDefault(); U.full = false; R.render(); return true; }
        if (node(cm, U.sel[cm.id]) && !U.popOff[cm.id]) { e.preventDefault(); U.popOff[cm.id] = true; R.render(); return true; }
      }
      if (!typing && (e.ctrlKey || e.metaKey) && !e.altKey) {
        var k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(current()); return true; }
        if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(current()); return true; }
      }
      if (e.key !== 'Enter') return false;
      if (role === 'rz-cortex-chat' && !e.shiftKey) { e.preventDefault(); sendChat(current(), el.value); return true; }
      if (role === 'rz-cortex-add') { e.preventDefault(); doAdd(); return true; }
      if (role === 'rz-cortex-rename') { e.preventDefault(); doRename(); return true; }
      if (role === 'rz-cortex-new-title') { e.preventDefault(); doCreate(); return true; }
      return false;
    }
  });

  /* ══ Actions ════════════════════════════════════════════════════════════ */

  function attr(el, n) { return el && el.getAttribute ? el.getAttribute(n) : null; }
  function selected() { var m = current(); return { map: m, node: node(m, U.sel[m.id]) || rootOf(m) }; }

  R.act('rz-cortex-map', function (el) { store().current = attr(el, 'data-id'); U.rename = null; U.confirmDel = ''; U.add = ''; U.histOpen = false; R.save(); R.render(); });
  R.act('rz-cortex-sel', function (el) {
    var m = current(), id = attr(el, 'data-id'), n = node(m, id);
    if (!n) return;
    if (U.sel[m.id] === id && kids(m, id).length && n.parent) {
      var k = expKey(m, n);
      U.expanded[k] = !isExpanded(m, n, depth(m, n));
    } else if (n.parent && kids(m, id).length) U.expanded[expKey(m, n)] = true;
    U.reveal = true;
    U.sel[m.id] = id; U.rename = null; U.confirmDel = ''; U.add = ''; U.focusOff[m.id] = false; U.popOff[m.id] = false; U.histOpen = false;
    R.render();
  });
  R.act('rz-cortex-undo', function () { undo(current()); });
  R.act('rz-cortex-redo', function () { redo(current()); });
  R.act('rz-cortex-restore', function (el) { restoreVersion(current(), attr(el, 'data-id')); });
  R.act('rz-cortex-full', function () { U.full = !U.full; R.render(); });
  R.act('rz-cortex-hist', function () { U.histOpen = !U.histOpen; R.render(); });
  R.act('rz-cortex-pop-close', function () { U.popOff[current().id] = true; U.rename = null; U.confirmDel = ''; R.render(); });
  R.act('rz-cortex-expand', function () {
    var s = selected();
    runAgent(s.map, s.node.parent ? 'expand' : (kids(s.map, s.node.id).length ? 'expand' : 'create'), { node: s.node.id });
  });
  R.input('rz-cortex-add', function (el) { U.add = el.value.slice(0, 80); });
  R.act('rz-cortex-add', function () { doAdd(); });
  function doAdd() {
    var s = selected(), t = U.add.trim();
    if (!t) { R.toast('Écrivez ce que vous voulez ajouter.'); return; }
    var n = addChild(s.map, s.node.id, t);
    U.add = '';
    if (n) U.note[s.map.id] = '« ' + n.title + ' » ajouté' + (pref('cortexTidy') ? ' ; la carte va être remise en ordre.' : '.');
    R.render();
  }
  R.act('rz-cortex-status', function (el) {
    var s = selected(), v = attr(el, 'data-s') || attr(el, 'data-value');
    if (!s.node.parent || !STATUS[v] || s.node.status === v) return;
    setStatus(s.map, s.node, v);
    touched(s.map, '« ' + s.node.title + ' » : ' + STATUS[v].toLowerCase());
    R.render();
  });
  R.act('rz-cortex-rename', function () { var s = selected(); U.rename = U.rename === s.node.id ? null : s.node.id; R.render(); });
  R.act('rz-cortex-rename-ok', function () { doRename(); });
  function doRename() {
    var s = selected(), el = document.querySelector('[data-role="rz-cortex-rename"]'), t = clip(el ? el.value : '', 80);
    U.rename = null;
    if (t && t !== s.node.title) {
      var was = s.node.title;
      s.node.title = t;
      if (!s.node.parent) { s.map.title = t; touched(s.map, 'Carte renommée : « ' + t + ' »'); } else edited(s.map, '« ' + was + ' » renommé « ' + t + ' »');
    }
    R.render();
  }
  R.act('rz-cortex-del-ask', function () { U.confirmDel = selected().node.id; R.render(); });
  R.act('rz-cortex-del-cancel', function () { U.confirmDel = ''; R.render(); });
  R.act('rz-cortex-del', function (el) {
    var s = selected(), t = s.node.title, branchToo = attr(el, 'data-branch') === '1';
    U.confirmDel = '';
    var gone = removeNode(s.map, s.node.id, branchToo);
    U.note[s.map.id] = '« ' + t + ' » supprimé' + (branchToo && gone > 1 ? ' avec ' + plural(gone - 1, 'sous-thème') : '') + '. ↶ Annuler pour le récupérer.';
    R.render();
  });
  R.act('rz-cortex-del-map', function () {
    var m = current(), c = store();
    if (U.confirmDel !== m.id) { U.confirmDel = m.id; R.render(); return; }
    U.confirmDel = '';
    c.trash.push({ map: copy(m), at: Date.now() });
    c.trash = c.trash.slice(-10);
    c.maps = c.maps.filter(function (x) { return x !== m; });
    c.current = c.maps[0] ? c.maps[0].id : '';
    R.save(); R.toast('« ' + m.title + ' » est à la corbeille.', { label: 'Restaurer', run: function () { untrash(m.id); } });
    R.render();
  });
  function untrash(id) {
    var c = store(), t = c.trash.filter(function (x) { return x.map.id === id; })[0];
    if (!t) return;
    c.trash = c.trash.filter(function (x) { return x !== t; });
    var m = normMap(t.map);
    if (mapById(m.id)) m.id = R.uid('cxmap');
    c.maps.push(m); c.current = m.id;
    if (!c.trash.length) U.trashOpen = false;
    U.note[m.id] = '« ' + m.title + ' » restaurée.';
    R.save(); R.render();
  }
  R.act('rz-cortex-trash', function () { U.trashOpen = !U.trashOpen; R.render(); });
  R.act('rz-cortex-untrash', function (el) { untrash(attr(el, 'data-id')); });
  R.act('rz-cortex-lesson', function (el) {
    var s = selected(), id = attr(el, 'data-id') || s.node.id;
    if (!node(s.map, id) || !node(s.map, id).parent) return;
    if (!R.lessonApi) { R.toast('Le module du cours n’est pas chargé.'); return; }
    U.full = false;
    R.lessonApi.pickCortex(s.map.id, id, attr(el, 'data-depth') === 'deepen' ? 'deepen' : 'intro');
  });

  /* Discussion */
  R.input('rz-cortex-chat', function (el) { U.chatText = el.value.slice(0, 2000); });
  R.act('rz-cortex-send', function () { var el = document.querySelector('[data-role="rz-cortex-chat"]'); sendChat(current(), el ? el.value : U.chatText); });
  R.act('rz-cortex-ask', function (el) { sendChat(current(), attr(el, 'data-text')); });
  R.act('rz-cortex-apply', function (el) { var m = current(), msg = m.chat[+attr(el, 'data-i')]; if (msg) applyProposal(m, msg); });
  R.act('rz-cortex-discuss', function () { U.focusOff[current().id] = false; R.render(); setTimeout(function () { var t = document.querySelector('[data-role="rz-cortex-chat"]'); if (t) t.focus(); }, 30); });
  R.act('rz-cortex-unfocus', function () { U.focusOff[current().id] = true; R.render(); });
  R.act('rz-cortex-chat-clear', function () { var m = current(); m.chat = []; R.save(); R.render(); });

  R.act('rz-cortex-new', function () { U.newOpen = !U.newOpen; U.trashOpen = false; R.render(); });
  R.input('rz-cortex-new-title', function (el) { U.newTitle = el.value.slice(0, 80); });
  R.input('rz-cortex-new-desc', function (el) { U.newDesc = el.value.slice(0, 600); });
  R.act('rz-cortex-create', function () { doCreate(); });
  function doCreate() {
    var t = clip(U.newTitle, 80);
    if (!t) { R.toast('Donnez un nom à la carte : le domaine que vous voulez explorer.'); return; }
    var c = store(), m = normMap(emptyMap(t, U.newDesc.trim()));
    c.maps.push(m);
    c.current = m.id;
    U.sel[m.id] = 'root'; U.popOff[m.id] = true;
    U.newOpen = false; U.newTitle = ''; U.newDesc = ''; U.centered = '';
    U.note[m.id] = 'Carte créée. Demandez un programme à l’agent, à droite.';
    R.save(true);
    R.render();
  }

  /* ══ Réglages › Révizator › Cortex ═════════════════════════════════════ */

  /* Tout effacer : cartes, discussions, corbeille, et l'historique de chaque carte (documents à part).
     Les cours déjà faits restent dans « Cours précédents ». */
  function resetAll() {
    var c = store(), ids = c.maps.map(function (m) { return m.id; }).concat(c.trash.map(function (t) { return t.map.id; }));
    ids.forEach(function (id) { R.docDelete('cortex', id)['catch'](function () { /* déjà absent */ }); clearTimeout(histTimers[id]); clearTimeout(timers[id]); });
    R.data.cortex = null;
    normalized = false;
    U.hist = {}; U.sel = {}; U.expanded = {}; U.note = {}; U.error = {}; U.chatError = {}; U.popOff = {}; U.focusOff = {};
    U.histOpen = false; U.trashOpen = false; U.newOpen = false; U.centered = ''; U.scrollMemo = null; U.zoom = 1; U.resetArm = false;
    store();
    R.save(true);
    R.toast('Cortex réinitialisé : il repart vide.');
    R.render();
  }

  R.settingsSection({
    id: 'cortex', order: 30,
    html: function () {
      var c = store(), n = c.maps.reduce(function (a, m) { return a + m.nodes.length - 1; }, 0);
      var chips = function (k, labels) {
        var cur = pref(k) ? 'true' : 'false';
        return '<div class="rz-chips" role="radiogroup">' + [['true', labels[0]], ['false', labels[1]]].map(function (o) {
          var on = o[0] === cur;
          return '<button type="button" role="radio" aria-checked="' + on + '" class="rz-chip' + (on ? ' on' : '') + '" data-act="rz-cortex-pref" data-name="' + k + '" data-value="' + o[0] + '">' + esc(o[1]) + '</button>';
        }).join('') + '</div>';
      };
      var h = ['<div class="set-card"><div class="set-card-head"><span class="set-card-title">Cortex</span></div>'];
      h.push('<div class="rz-set-help">Vos cartes des savoirs et les programmes discutés avec l’agent, d’où partent les cours de fond.</div>');
      h.push(R.setField('Ranger la carte', chips('cortexTidy', ['Automatiquement', 'Jamais'])));
      h.push('<div class="rz-set-help">Après chaque modification à la main, l’agent remet la carte en ordre : doublons fusionnés, nœuds mal placés déplacés, intitulés harmonisés. Chaque passage compte dans votre quota Claude Code.</div>');
      h.push(R.setField('Après un cours', chips('cortexGrow', ['Ajouter ses sujets suivants à la carte', 'Ne rien ajouter'])));
      h.push(R.setField('Effacer', (U.resetArm
        ? '<div class="rz-row"><button type="button" class="btn btn-primary rzc-danger-btn" data-act="rz-cortex-reset">Oui, effacer tout le cortex</button><button type="button" class="btn btn-ghost" data-act="rz-cortex-reset-cancel">Annuler</button></div>'
        : '<button type="button" class="btn btn-secondary" data-act="rz-cortex-reset">Réinitialiser le cortex</button>')));
      h.push('<div class="rz-set-help">' + esc('Efface ' + plural(c.maps.length, 'carte') + ' (' + plural(n, 'nœud') + '), les discussions avec l’agent, l’historique des versions et la corbeille. Le cortex repart vide. Les cours déjà faits restent dans « Cours précédents ». Irréversible.') + '</div>');
      return h.join('') + '</div>';
    }
  });
  R.act('rz-cortex-pref', function (el) {
    var k = attr(el, 'data-name');
    if (k !== 'cortexTidy' && k !== 'cortexGrow') return;
    R.prefs[k] = attr(el, 'data-value') === 'true';
    R.save(); R.render();
  });
  R.act('rz-cortex-reset', function () { if (!U.resetArm) { U.resetArm = true; R.render(); return; } resetAll(); });
  R.act('rz-cortex-reset-cancel', function () { U.resetArm = false; R.render(); });

  /* ══ Carte d'accueil ════════════════════════════════════════════════════ */

  R.homeCard({ id: 'cortex', area: 'side', order: 30, html: function () {
    if (!R.profile.onboarded) return '';
    var m = current(), total = m.nodes.length - 1, done = m.nodes.filter(function (x) { return x.parent && studied(x.status); }).length;
    var next = suggest(3);
    var h = ['<section class="rz-card rzc-home"><div class="rz-card-head"><span class="rz-card-title">' + icon('node') + ' Le cortex</span><span class="rz-card-meta">' + esc(total ? m.title + ' · ' + done + ' / ' + total : 'vide') + '</span></div>'];
    if (!total) h.push('<p class="rz-muted">Demandez un programme à l’agent — « du début de l’humanité à la fin », « le bricolage » — et vos cours suivront ses étapes.</p>');
    else h.push('<div class="rzc-home-bar" aria-hidden="true"><i style="width:' + Math.round(done / total * 100) + '%"></i></div>');
    if (next.length) h.push('<ul class="rzc-home-list">' + next.map(function (x) {
      var prog = programOf(x.map, x.node);
      return '<li><button type="button" class="rzc-kid is-' + x.s + '" data-act="rz-cortex-lesson-home" data-map="' + esc(x.map.id) + '" data-id="' + esc(x.node.id) + '" title="Préparer le cours sur ce nœud"><i class="rzc-dot is-' + x.s + '"></i><span>' + esc(x.node.title) + '</span><span class="rz-muted">' + esc(prog ? prog.title : STATUS[x.s]) + '</span></button></li>';
    }).join('') + '</ul>');
    h.push('<button type="button" class="btn btn-ghost" data-act="rz-go" data-view="cortex">' + (total ? 'Ouvrir le cortex' : 'Commencer mon cortex') + '</button></section>');
    return h.join('');
  } });
  R.act('rz-cortex-lesson-home', function (el) { if (R.lessonApi) R.lessonApi.pickCortex(attr(el, 'data-map'), attr(el, 'data-id'), null); });

  /* ══ Simulation hors WebView2 ═══════════════════════════════════════════ */

  R.fixture('cortex', function (p) {
    var nodes = arr(p.nodes), mode = p.mode;
    var focus = nodes.filter(function (n) { return n.id === p.node; })[0];
    if (mode === 'chat') {
      var msg = str(p.message).toLowerCase(), draft = obj(p.draft);
      if (/court|moins/.test(msg) && draft) {
        return { mode: 'chat', reply: 'Voici une version plus courte, en six grandes étapes.', followUps: ['Ajoute plus sur l’Égypte', 'Parfait, merci'],
          proposal: { action: 'new', target: '', attach: '', title: draft.title, summaryFr: 'Version courte.', query: 'history of humanity', steps: arr(draft.steps).filter(function (s) { return !s.parent; }).slice(0, 6).map(function (s) { return { ref: s.ref, parent: '', title: s.title, summaryFr: '', query: s.title }; }) } };
      }
      if (focus && focus.kind === 'program') {
        var kept = nodes.filter(function (n) { return n.parent === focus.id; }).map(function (n) { return { ref: n.id, parent: '', title: n.title, summaryFr: '', query: n.title }; });
        kept.splice(2, 0, { ref: 'new1', parent: '', title: 'L’Égypte ancienne', summaryFr: 'Pharaons, pyramides et Nil.', query: 'ancient Egypt' });
        return { mode: 'chat', reply: 'J’ai ajouté une étape sur l’Égypte ancienne, juste après la Préhistoire.', followUps: [], proposal: { action: 'revise', target: focus.id, attach: '', title: focus.title, summaryFr: '', query: '', steps: kept } };
      }
      var eras = [['La Préhistoire', ['Les premiers humains', 'La révolution néolithique']], ['L’Antiquité', ['La Mésopotamie', 'La Grèce antique', 'Rome']], ['Le Moyen Âge', ['Les grandes invasions', 'La féodalité']],
        ['La Renaissance', []], ['Les Temps modernes', ['Les grandes découvertes', 'Les Lumières']], ['L’époque contemporaine', ['La révolution industrielle', 'Les guerres mondiales']], ['Le monde d’aujourd’hui', []], ['Les futurs possibles', []]];
      var steps = [];
      eras.forEach(function (e, i) {
        steps.push({ ref: 'new' + (i + 1), parent: '', title: e[0], summaryFr: 'Une grande période de l’histoire humaine.', query: e[0] });
        e[1].forEach(function (t, j) { steps.push({ ref: 'new' + (i + 1) + '_' + j, parent: 'new' + (i + 1), title: t, summaryFr: '', query: t }); });
      });
      return { mode: 'chat', reply: 'Je vous propose de suivre l’histoire de l’humanité dans l’ordre chronologique, en huit grandes étapes, des premiers humains aux futurs possibles. Les périodes les plus riches sont découpées en sous-étapes, pour qu’un cours ne survole pas tout.',
        followUps: ['Fais-le plus court', 'Ajoute plus sur l’Égypte', 'Commence plutôt au Big Bang'],
        proposal: { action: 'new', target: '', attach: '', title: 'L’histoire de l’humanité', summaryFr: 'Des premiers humains à demain, dans l’ordre.', query: 'history of humanity', steps: steps } };
    }
    if (mode === 'create') {
      var themes = ['Les outils de base', 'Les matériaux', 'La sécurité', 'Les projets faciles'];
      var out = [];
      themes.forEach(function (t, i) {
        out.push({ ref: 'new' + (i + 1), parent: p.node || 'root', title: t, summaryFr: 'Ce qu’il faut savoir : ' + t.toLowerCase() + '.', query: t });
        out.push({ ref: 'new' + (i + 1) + 'a', parent: 'new' + (i + 1), title: t + ' : l’essentiel', summaryFr: '', query: t + ' basics' });
      });
      return { mode: mode, nodes: out, merged: [], noteFr: 'Voici un plan de départ en quatre grands thèmes.' };
    }
    if (mode === 'expand') {
      var base = focus ? focus.title : 'Thème';
      return { mode: mode, nodes: ['Les origines', 'Les idées clés', 'Les grandes figures'].map(function (t, i) {
        return { ref: 'new' + (i + 1), parent: p.node, title: t + ' — ' + base, summaryFr: 'Un sous-thème de « ' + base + ' ».', query: base + ' ' + t };
      }), merged: [], noteFr: 'Trois sous-thèmes proposés pour « ' + base + ' ».' };
    }
    return { mode: 'organize', nodes: nodes.map(function (n) { return { ref: n.id, parent: n.parent, title: n.title.charAt(0).toUpperCase() + n.title.slice(1), summaryFr: '', query: '' }; }), merged: [], noteFr: 'Intitulés harmonisés.' };
  });
})();
