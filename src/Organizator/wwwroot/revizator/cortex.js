/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — le cortex (vue « cortex »)

   Des cartes mentales de ce que l'utilisateur veut savoir : un nœud racine (« Mon cortex »,
   « Bricolage », « Informatique »…) et des thèmes de plus en plus précis. Chaque nœud peut donner un
   cours d'anglais de fond (lesson.js, source « Mon cortex ») : l'agent du cours fait une recherche
   sur le nœud au lieu de lire l'actualité, puis le cours fait le nœud passe à « étudié » (ou « à
   approfondir » si le cours a été jugé difficile ou réussi à moins de 60 %).

   Deux façons de faire grandir une carte (réglage par carte) :
     • « propose » : l'agent propose — plan de départ d'une nouvelle carte, sous-thèmes à la demande,
       et après chaque cours les trois sujets suivants du cours deviennent des sous-nœuds. Les nœuds
       proposés sous un nœud pas encore étudié sont « à débloquer » : étudier leur parent les ouvre,
       un clic aussi ;
     • « manual » : l'utilisateur choisit seul ses nœuds ; rien n'est verrouillé.
   Réorganisation : après chaque modification à la main (ajout, renommage, suppression), si la carte
   l'a activée, l'agent rend la carte entière remise en ordre (doublons fusionnés, nœuds déplacés,
   intitulés harmonisés). La fusion ne perd jamais l'état d'un nœud ni ses cours.

   Agent : R.gen('cortex', { mode: create|expand|organize, map: { title, description }, nodes:
   [{ id, parent, title, status, origin }], node, request }) → { mode, nodes: [{ ref, parent, title,
   summaryFr, query }], merged: [{ from, into }], noteFr } (CortexGenre, LearningAgent.cs).

   Données (learning.json, sujet « en ») :
     cortex { current, maps: [{ id, title, description, mode: 'propose'|'manual', autoTidy, createdAt, updatedAt,
              nodes: [{ id, parent ('' pour la racine), title, summaryFr, query, status: 'locked'|'open'|'studied'|'deepen',
                        origin: 'seed'|'user'|'agent'|'lesson', order, lessons: [id de cours], at, studiedAt }] }] }
   API pour lesson.js : R.cortex.{ suggest(n), get(map, node), path(map, node), lessonParams(map, node, depth),
     lessonDone(entry, L), statusLabel(s) }
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R || !R.view) return;
  var esc = R.esc;

  var U = R.ui.cortex = {
    sel: {}, expanded: {}, zoom: 1, busy: {}, note: {}, error: {}, again: {},
    newOpen: false, newTitle: '', newDesc: '', newPlan: 'agent', add: '', rename: null, confirmDel: '', centered: ''
  };

  var STATUS = { locked: 'À débloquer', open: 'À étudier', studied: 'Étudié', deepen: 'À approfondir' };
  var RANK = { locked: 0, open: 1, deepen: 2, studied: 3 };
  var MODES = { propose: 'L’agent propose', manual: 'Je choisis moi-même' };
  var HUES = 8;                      /* couleurs de branche (cortex.css, .rzc-h0 … .rzc-h7) */
  var TIDY_MS = 2500;                /* réorganisation automatique : délai après la dernière modification */
  var NODE_ARC = 132;                /* écart visé entre deux feuilles voisines, en px */
  var SEED = [
    ['Histoire', 'Les grandes périodes, les civilisations et les événements qui ont façonné le monde.', 'world history key periods'],
    ['Philosophie', 'Les grandes questions, les courants et les penseurs, de l’Antiquité à aujourd’hui.', 'philosophy main ideas thinkers'],
    ['Sciences', 'Comprendre l’univers, le vivant, la matière et la méthode scientifique.', 'science explained basics'],
    ['Informatique', 'Comment marchent les ordinateurs, le web, la programmation et l’IA.', 'computing explained programming basics'],
    ['Arts et littérature', 'Peinture, musique, cinéma et grands livres, surtout du monde anglophone.', 'art literature history'],
    ['Bricolage et maison', 'Outils, techniques et savoir-faire pour entretenir et améliorer la maison.', 'DIY home improvement basics'],
    ['Économie et société', 'Argent, travail, institutions et grands débats de société.', 'economics society explained'],
    ['Monde anglophone', 'Cultures, institutions et vie quotidienne au Royaume-Uni, aux États-Unis et ailleurs.', 'English-speaking world culture']
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

  /* ══ Données ════════════════════════════════════════════════════════════ */

  function seedMap() {
    var now = Date.now(), id = R.uid('cxmap');
    var nodes = [{ id: 'root', parent: '', title: 'Mon cortex', summaryFr: 'Tout ce que vous voulez apprendre, en anglais.', query: '', status: 'open', origin: 'seed', order: 0, lessons: [], at: now }];
    SEED.forEach(function (s, i) {
      nodes.push({ id: R.uid('cn'), parent: 'root', title: s[0], summaryFr: s[1], query: s[2], status: 'open', origin: 'seed', order: i, lessons: [], at: now });
    });
    return { id: id, title: 'Mon cortex', description: '', mode: 'propose', autoTidy: true, createdAt: now, updatedAt: now, nodes: nodes };
  }

  function normNode(n, i) {
    n.id = str(n.id) || R.uid('cn');
    n.parent = str(n.parent);
    n.title = clip(n.title, 80) || 'Sans titre';
    n.summaryFr = str(n.summaryFr);
    n.query = str(n.query);
    if (!STATUS[n.status]) n.status = 'open';
    if (['seed', 'user', 'agent', 'lesson'].indexOf(n.origin) < 0) n.origin = 'user';
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
    if (!root) { root = normNode({ id: 'root', parent: '', title: map.title || 'Carte', origin: 'seed' }, 0); map.nodes.unshift(root); ids[root.id] = root; }
    root.parent = '';
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
    if (!MODES[m.mode]) m.mode = 'propose';
    m.autoTidy = m.autoTidy !== false;
    repair(m);
    return m;
  }

  var normalized = false;
  function store() {
    var c = obj(R.data.cortex);
    if (!c) c = R.data.cortex = { current: '', maps: [] };
    c.maps = arr(c.maps).filter(obj);
    if (!c.maps.length) { c.maps.push(seedMap()); normalized = false; R.save(); }
    if (!normalized) { c.maps.forEach(normMap); normalized = true; }
    if (!mapById(c.current, c)) c.current = c.maps[0].id;
    return c;
  }
  R.on('loaded', function () { normalized = false; });

  function maps() { return store().maps; }
  function mapById(id, c) { return arr((c || store()).maps).filter(function (m) { return m.id === id; })[0] || null; }
  function current() { var c = store(); return mapById(c.current, c); }
  function rootOf(map) { return map.nodes.filter(function (n) { return !n.parent; })[0]; }
  function node(map, id) { return map ? map.nodes.filter(function (n) { return n.id === id; })[0] || null : null; }
  function kids(map, id) {
    return map.nodes.filter(function (n) { return n.parent === id && n.parent; }).sort(function (a, b) { return a.order - b.order; });
  }
  function depth(map, n) { var d = 0; while (n && n.parent && d < 20) { n = node(map, n.parent); d++; } return d; }
  function pathOf(map, n) { var p = []; while (n && p.length < 20) { p.unshift(n); n = n.parent ? node(map, n.parent) : null; } return p; }
  function isUnder(map, n, ancestorId) { var p = n && node(map, n.parent); while (p) { if (p.id === ancestorId) return true; p = p.parent ? node(map, p.parent) : null; } return false; }
  /* Verrouillage : seulement quand l'agent propose. */
  function status(map, n) { return map.mode === 'manual' && n.status === 'locked' ? 'open' : n.status; }
  function studied(s) { return s === 'studied' || s === 'deepen'; }
  function branch(map, n) {
    var p = pathOf(map, n);
    if (p.length < 2) return -1;
    var k = kids(map, p[0].id);
    return Math.max(0, k.indexOf(p[1])) % HUES;
  }
  function touched(map) { map.updatedAt = Date.now(); R.save(); }

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
    var leafDepth = {};
    tree.forEach(function (t) { if (!t.ch.length && t.d > 0) leafDepth[t.d] = 1; });
    var radius = [0];
    var need = NODE_ARC * top.leaves / (2 * Math.PI);
    for (var d = 1; d <= maxD; d++) {
      var r = radius[d - 1] + (d === 1 ? 200 : 180);
      if (leafDepth[d] || d === maxD) r = Math.max(r, need);
      radius.push(r);
    }
    /* Une seule branche : la répartir sur un demi-cercle plutôt que tout autour. */
    function place(t, a0, a1) {
      var a = (a0 + a1) / 2;
      pos[t.n.id] = { x: t.d ? radius[t.d] * Math.cos(a) : 0, y: t.d ? radius[t.d] * Math.sin(a) : 0, a: a, d: t.d, t: t };
      var cur = a0;
      t.ch.forEach(function (c) {
        var span = (a1 - a0) * c.leaves / t.leaves;
        place(c, cur, cur + span);
        cur += span;
      });
    }
    place(top, -Math.PI / 2, 3 * Math.PI / 2);
    var xs = [], ys = [];
    Object.keys(pos).forEach(function (id) { xs.push(pos[id].x); ys.push(pos[id].y); });
    var pad = 130;
    var minX = Math.min.apply(null, xs) - pad, maxX = Math.max.apply(null, xs) + pad;
    var minY = Math.min.apply(null, ys) - 70, maxY = Math.max.apply(null, ys) + 70;
    Object.keys(pos).forEach(function (id) { pos[id].x -= minX; pos[id].y -= minY; });
    return { pos: pos, w: Math.round(maxX - minX), h: Math.round(maxY - minY), radius: radius, root: root, cx: -minX, cy: -minY };
  }

  /* ══ Agent ══════════════════════════════════════════════════════════════ */

  function agentOk() { return !!(window.bridge && (window.bridge.isShim || window.bridge.mode === 'server' || window.bridge.call)); }

  function runAgent(map, mode, opts) {
    opts = opts || {};
    if (U.busy[map.id]) { if (mode === 'organize') U.again[map.id] = true; return; }
    U.busy[map.id] = { mode: mode, node: opts.node || '', at: Date.now() };
    U.error[map.id] = '';
    var params = {
      mode: mode, map: { title: map.title, description: map.description },
      nodes: map.nodes.map(function (n) { return { id: n.id, parent: n.parent, title: n.title, status: n.status, origin: n.origin }; }),
      node: opts.node || '', request: opts.request || ''
    };
    R.render();
    R.gen('cortex', params).then(function (r) {
      delete U.busy[map.id];
      var m = mapById(map.id);
      if (!m) return;
      var n = apply(m, r && r.doc, opts.node || '');
      if (mode === 'create') U.centered = '';
      U.note[map.id] = str(r && r.doc && r.doc.noteFr) || (n ? plural(n, 'nouveau nœud', 'nouveaux nœuds') + '.' : 'Carte remise en ordre.');
      touched(m);
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
    if (!map.autoTidy) return;
    clearTimeout(timers[map.id]);
    timers[map.id] = setTimeout(function () { var m = mapById(map.id); if (m) runAgent(m, 'organize'); }, TIDY_MS);
  }
  function edited(map) { touched(map); schedule(map); }

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
       verrouillés sous un nœud pas encore étudié, quand l'agent propose. */
    map.nodes.forEach(function (n) {
      if (!fresh[n.id]) return;
      var p = node(map, n.parent);
      n.status = !p || !p.parent || studied(p.status) || map.mode === 'manual' ? 'open' : 'locked';
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

  /* ══ Modifications à la main ════════════════════════════════════════════ */

  function addChild(map, parentId, title) {
    title = clip(title, 80);
    var p = node(map, parentId);
    if (!title || !p) return null;
    var dup = kids(map, p.id).filter(function (k) { return key(k.title) === key(title); })[0];
    if (dup) { R.toast('« ' + dup.title + ' » existe déjà ici.'); return dup; }
    var sib = kids(map, p.id);
    var n = normNode({ id: R.uid('cn'), parent: p.id, title: title, status: 'open', origin: 'user', order: sib.length, at: Date.now() }, sib.length);
    map.nodes.push(n);
    U.expanded[expKey(map, p)] = true;
    edited(map);
    return n;
  }

  /* Supprimer un nœud : ses enfants remontent d'un cran. */
  function removeNode(map, id) {
    var n = node(map, id);
    if (!n || !n.parent) return;
    var at = n.order;
    kids(map, n.id).forEach(function (k, i) { k.parent = n.parent; k.order = at + 0.1 + i / 100; });
    map.nodes = map.nodes.filter(function (x) { return x !== n; });
    renumber(map);
    U.sel[map.id] = n.parent;
    edited(map);
  }

  function setStatus(map, n, s) {
    n.status = s;
    if (studied(s)) {
      n.studiedAt = n.studiedAt || Date.now();
      kids(map, n.id).forEach(function (k) { if (k.status === 'locked') k.status = 'open'; });
    }
    touched(map);
  }

  /* ══ Pour lesson.js ═════════════════════════════════════════════════════ */

  /* Ce qui se prête à un cours : d'abord ce qui demande un approfondissement, puis les nœuds ouverts
     jamais étudiés, du moins profond au plus profond, la carte courante en premier. */
  function suggest(n) {
    var cur = current(), out = [];
    var list = maps().slice().sort(function (a, b) { return (b === cur) - (a === cur) || num(b.updatedAt, 0) - num(a.updatedAt, 0); });
    list.forEach(function (m) {
      m.nodes.forEach(function (x) {
        if (!x.parent) return;
        var s = status(m, x);
        if (s === 'locked' || s === 'studied') return;
        var p = node(m, x.parent);
        out.push({ map: m, node: x, s: s, score: (s === 'deepen' ? 0 : 10) + depth(m, x) + (p && studied(p.status) ? -0.5 : 0) + (m === cur ? 0 : 3) + x.order / 100 });
      });
    });
    return out.sort(function (a, b) { return a.score - b.score; }).slice(0, n || 6);
  }

  function lessonParams(mapId, nodeId, depthWanted) {
    var m = mapById(mapId), n = node(m, nodeId);
    if (!n) return null;
    var p = pathOf(m, n), last = n.lessons.length ? lessonEntry(n.lessons[n.lessons.length - 1]) : null;
    return {
      map: m.id, node: n.id, mapTitle: m.title,
      path: p.map(function (x) { return x.title; }),
      summary: n.summaryFr,
      depth: depthWanted === 'deepen' || (depthWanted == null && studied(n.status)) ? 'deepen' : 'intro',
      previous: last ? clip(last.title + (arr(last.keywords).length ? ' (' + arr(last.keywords).slice(0, 5).join(', ') + ')' : ''), 280) : '',
      children: kids(m, n.id).map(function (k) { return k.title; }).slice(0, 12),
      studied: m.nodes.filter(function (x) { return x.parent && x !== n && studied(x.status); }).sort(function (a, b) { return num(b.studiedAt, 0) - num(a.studiedAt, 0); })
        .slice(0, 16).map(function (x) { return x.title; })
    };
  }
  function lessonEntry(id) { return arr(R.data.lessons).filter(function (l) { return l && l.id === id; })[0] || null; }

  /* Un cours du cortex terminé : le nœud est étudié (ou à approfondir), ses enfants s'ouvrent, et quand
     l'agent propose, les sujets suivants du cours deviennent des sous-nœuds. */
  function lessonDone(e, L) {
    var link = obj(e && e.cortex), m = link && mapById(link.map), n = m && node(m, link.node);
    if (!n) return;
    if (n.lessons.indexOf(e.id) < 0) n.lessons.push(e.id);
    var res = obj(e.result) || {};
    var hard = res.self === 'hard' || (res.score != null && num(res.score, 1) < 0.6);
    setStatus(m, n, hard ? 'deepen' : 'studied');
    n.studiedAt = Date.now();
    var added = 0;
    if (m.mode === 'propose' && L) {
      arr(L.nextTopics).slice(0, 3).forEach(function (t, i) {
        var title = clip(t.title, 80);
        if (!title || m.nodes.some(function (x) { return key(x.title) === key(title); })) return;
        m.nodes.push(normNode({ id: R.uid('cn'), parent: n.id, title: title, summaryFr: str(t.pitchFr), query: str(t.query), status: 'open', origin: 'lesson', order: kids(m, n.id).length + i, at: Date.now() }, 0));
        added++;
      });
      renumber(m);
    }
    U.sel[m.id] = n.id;
    U.note[m.id] = '« ' + n.title + ' » : ' + (hard ? 'à approfondir' : 'étudié') + (added ? ', ' + plural(added, 'nouveau sous-thème', 'nouveaux sous-thèmes') : '') + '.';
    if (added) edited(m); else touched(m);
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
    var h = ['<div class="rzc">'];
    h.push('<div class="rzc-head"><div><div class="rz-kicker">' + icon('node') + ' Le cortex</div><h1 class="rzc-title">Ce que vous voulez savoir</h1>'
      + '<p class="rzc-lead">Vos cartes des savoirs : choisissez un nœud, votre professeur fait une recherche approfondie et en tire un cours d’anglais. Chaque cours fait avancer la carte.</p></div></div>');
    h.push(mapsBarHtml(map));
    if (U.newOpen) h.push(newMapHtml());
    h.push('<div class="rzc-body">');
    h.push('<section class="rz-card rzc-board">' + toolbarHtml(map) + canvasHtml(map) + legendHtml() + '</section>');
    h.push('<aside class="rzc-side">' + panelHtml(map) + '</aside>');
    h.push('</div></div>');
    return h.join('');
  }

  function mapsBarHtml(map) {
    return '<div class="rzc-maps" role="tablist">' + maps().map(function (m) {
      var on = m === map, n = m.nodes.length - 1, done = m.nodes.filter(function (x) { return x.parent && studied(x.status); }).length;
      return '<button type="button" role="tab" aria-selected="' + on + '" class="rzc-map' + (on ? ' on' : '') + '" data-act="rz-cortex-map" data-id="' + esc(m.id) + '">'
        + '<span class="rzc-map-t">' + esc(m.title) + '</span><span class="rzc-map-m">' + esc(done + ' / ' + n) + '</span></button>';
    }).join('') + '<button type="button" class="btn btn-ghost rzc-map-new" data-act="rz-cortex-new">+ Nouvelle carte</button></div>';
  }

  function newMapHtml() {
    return '<section class="rz-card rzc-new"><div class="rz-card-head"><span class="rz-card-title">Nouvelle carte</span>'
      + '<button type="button" class="btn btn-ghost" data-act="rz-cortex-new">Fermer</button></div>'
      + '<label class="rzc-field"><span class="rzl-k">Domaine</span><input class="input" type="text" data-role="rz-cortex-new-title" data-focus-key="rzc-new-title" maxlength="80" placeholder="Le bricolage, l’informatique, la Rome antique, le jazz…" value="' + esc(U.newTitle) + '"></label>'
      + '<label class="rzc-field"><span class="rzl-k">Ce que vous voulez en savoir <span class="rz-muted">· facultatif</span></span><textarea class="input" rows="2" data-role="rz-cortex-new-desc" data-focus-key="rzc-new-desc" maxlength="600" placeholder="Ex. rénover mon appartement moi-même ; comprendre comment marche un ordinateur, jusqu’au code">' + esc(U.newDesc) + '</textarea></label>'
      + '<div class="rzc-field"><span class="rzl-k">Le point de départ</span>' + R.h.chips('rzc-plan', ['agent', 'empty'], U.newPlan, ['Plan proposé par l’agent', 'Carte vide, je la construis'], 'rz-cortex-new-plan') + '</div>'
      + '<div class="rz-row"><button type="button" class="btn btn-primary" data-act="rz-cortex-create">' + icon('spark') + ' Créer la carte</button>'
      + '<span class="rz-muted">' + esc(U.newPlan === 'agent' ? 'L’agent dresse 5 à 8 grands thèmes et leurs premiers sous-thèmes, en une minute environ.' : 'Vous ajoutez vous-même les thèmes, nœud par nœud.') + '</span></div></section>';
  }

  function toolbarHtml(map) {
    var busy = U.busy[map.id];
    var h = '<div class="rzc-tools"><div class="rzc-tools-l">'
      + R.h.chips('rzc-mode', ['propose', 'manual'], map.mode, [MODES.propose, MODES.manual], 'rz-cortex-mode')
      + '<label class="rzc-switch" title="Après chaque modification à la main, l’agent remet la carte en ordre : doublons, nœuds mal placés, intitulés."><input type="checkbox" data-role="rz-cortex-tidy"' + (map.autoTidy ? ' checked' : '') + '> Réorganisation automatique</label>'
      + '</div><div class="rzc-tools-r">'
      + '<button type="button" class="btn btn-ghost" data-act="rz-cortex-organize"' + (busy ? ' disabled' : '') + ' title="Demander à l’agent de remettre toute la carte en ordre">' + icon('replay') + ' Réorganiser</button>'
      + '<span class="rzc-zoom"><button type="button" class="btn btn-ghost" data-act="rz-cortex-zoom" data-z="-1" aria-label="Dézoomer">−</button><button type="button" class="btn btn-ghost" data-act="rz-cortex-zoom" data-z="0" title="Recentrer">' + Math.round(U.zoom * 100) + ' %</button><button type="button" class="btn btn-ghost" data-act="rz-cortex-zoom" data-z="1" aria-label="Zoomer">+</button></span>'
      + '</div></div>';
    if (busy) h += '<div class="rzc-status is-busy"><span class="rz-spin"></span> ' + esc({ create: 'L’agent dresse le plan de la carte…', expand: 'L’agent cherche des sous-thèmes…', organize: 'L’agent réorganise la carte…' }[busy.mode] || 'L’agent travaille…') + '</div>';
    else if (U.error[map.id]) h += '<div class="rzc-status is-error" role="alert">' + icon('cross') + ' ' + esc(U.error[map.id]) + '</div>';
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
        links.push('<path class="rzc-h' + branch(map, n) + (status(map, n) === 'locked' ? ' is-locked' : '') + '" d="M' + r1(Q.x) + ' ' + r1(Q.y) + 'C' + r1(c1x) + ' ' + r1(c1y) + ' ' + r1(c2x) + ' ' + r1(c2y) + ' ' + r1(P.x) + ' ' + r1(P.y) + '"></path>');
      }
      var s = n.parent ? status(map, n) : 'root';
      var hid = P.t.hidden;
      nodes.push('<button type="button" class="rzc-node is-' + s + ' rzc-h' + branch(map, n) + ' d' + Math.min(P.d, 3) + (id === sel ? ' on' : '') + '" style="left:' + r1(P.x) + 'px;top:' + r1(P.y) + 'px"'
        + ' data-act="rz-cortex-sel" data-id="' + esc(id) + '" aria-pressed="' + (id === sel) + '" title="' + esc((STATUS[s] ? STATUS[s] + ' · ' : '') + n.title + (n.summaryFr ? ' — ' + n.summaryFr : '')) + '">'
        + (s === 'studied' ? '<i class="rzc-badge is-ok">' + icon('check') + '</i>' : (s === 'deepen' ? '<i class="rzc-badge is-deep">↻</i>' : (s === 'locked' ? '<i class="rzc-badge is-lock">' + lockSvg() + '</i>' : '')))
        + '<span class="rzc-node-t">' + esc(n.title) + '</span>'
        + (hid ? '<span class="rzc-more">+' + hid + '</span>' : '') + '</button>');
    });
    return '<div class="rzc-canvas" data-rzc-canvas data-map="' + esc(map.id) + '"><div class="rzc-stage" style="width:' + L.w + 'px;height:' + L.h + 'px;zoom:' + U.zoom + '" data-cx="' + r1(L.cx) + '" data-cy="' + r1(L.cy) + '">'
      + '<svg class="rzc-links" width="' + L.w + '" height="' + L.h + '" aria-hidden="true"><g class="rzc-rings">' + ring + '</g>' + links.join('') + '</svg>'
      + nodes.join('') + '</div></div>';
  }
  function r1(v) { return Math.round(v * 10) / 10; }
  function lockSvg() { return '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>'; }

  function legendHtml() {
    return '<div class="rzc-legend"><span><i class="rzc-dot is-open"></i>À étudier</span><span><i class="rzc-dot is-studied"></i>Étudié</span><span><i class="rzc-dot is-deepen"></i>À approfondir</span><span><i class="rzc-dot is-locked"></i>À débloquer</span><span class="rz-muted">+N : sous-thèmes repliés, un clic les déplie</span></div>';
  }

  function panelHtml(map) {
    var root = rootOf(map), n = node(map, U.sel[map.id]) || root, s = n.parent ? status(map, n) : 'root', busy = U.busy[map.id];
    var h = ['<section class="rz-card rzc-panel">'];
    var p = pathOf(map, n);
    if (p.length > 1) h.push('<nav class="rzc-crumbs">' + p.slice(0, -1).map(function (x) { return '<button type="button" class="rzc-crumb" data-act="rz-cortex-sel" data-id="' + esc(x.id) + '">' + esc(x.title) + '</button>'; }).join('<span>›</span>') + '</nav>');
    if (U.rename === n.id) {
      h.push('<div class="rzc-rename"><input class="input" type="text" data-role="rz-cortex-rename" data-focus-key="rzc-rename" maxlength="80" value="' + esc(n.title) + '">'
        + '<button type="button" class="btn btn-primary" data-act="rz-cortex-rename-ok">OK</button><button type="button" class="btn btn-ghost" data-act="rz-cortex-rename">Annuler</button></div>');
    } else {
      h.push('<h2 class="rzc-panel-t">' + esc(n.title) + '</h2>');
    }
    if (STATUS[s]) h.push('<div class="rzc-panel-meta"><span class="rzc-st is-' + s + '">' + esc(STATUS[s]) + '</span>' + (n.lessons.length ? '<span class="rz-muted">' + esc(plural(n.lessons.length, 'cours', 'cours')) + '</span>' : '') + '</div>');
    if (n.summaryFr) h.push('<p class="rzc-panel-p">' + esc(n.summaryFr) + '</p>');
    else if (!n.parent) h.push('<p class="rzc-panel-p">' + esc(map.description || 'La racine de la carte. Ajoutez-y vos grands thèmes, ou demandez-en à l’agent.') + '</p>');

    if (n.parent) {
      var deep = studied(s);
      h.push('<div class="rzc-actions">');
      h.push('<button type="button" class="btn btn-primary rzc-cta" data-act="rz-cortex-lesson" data-depth="' + (deep ? 'deepen' : 'intro') + '">' + icon('spark') + ' ' + (deep ? 'Un cours pour approfondir' : 'Préparer le cours sur ce nœud') + '</button>');
      if (deep) h.push('<button type="button" class="btn btn-ghost" data-act="rz-cortex-lesson" data-depth="intro">Refaire un cours de découverte</button>');
      h.push('</div>');
      if (s === 'locked') h.push('<div class="rzc-hint">Ce nœud s’ouvrira quand « ' + esc(node(map, n.parent).title) + ' » sera étudié. Vous pouvez aussi <button type="button" class="btn btn-ghost rzc-inline" data-act="rz-cortex-status" data-s="open">le débloquer tout de suite</button>, ou préparer son cours directement.</div>');
      h.push('<div class="rzc-k">Où en êtes-vous ?</div>' + R.h.chips('rzc-st', ['open', 'studied', 'deepen'], s === 'locked' ? '' : s, ['À étudier', 'Étudié', 'À approfondir'], 'rz-cortex-status'));
    }

    var ch = kids(map, n.id);
    h.push('<div class="rzc-k">Sous-thèmes' + (ch.length ? ' · ' + ch.length : '') + '</div>');
    if (ch.length) {
      h.push('<ul class="rzc-kids">' + ch.map(function (k) {
        var ks = status(map, k);
        return '<li><button type="button" class="rzc-kid is-' + ks + '" data-act="rz-cortex-sel" data-id="' + esc(k.id) + '"><i class="rzc-dot is-' + ks + '"></i><span>' + esc(k.title) + '</span>'
          + (kids(map, k.id).length ? '<span class="rz-muted">' + kids(map, k.id).length + '</span>' : '') + '</button></li>';
      }).join('') + '</ul>');
    } else h.push('<div class="rz-muted">Aucun pour l’instant.</div>');
    h.push('<div class="rzc-add"><input class="input" type="text" data-role="rz-cortex-add" data-focus-key="rzc-add" maxlength="80" placeholder="' + esc(n.parent ? 'Un sous-thème : ex. « ' + exampleFor(n) + ' »' : 'Un grand thème : ex. « Cuisine », « Astronomie »') + '" value="' + esc(U.add) + '">'
      + '<button type="button" class="btn btn-secondary" data-act="rz-cortex-add">Ajouter</button></div>');
    h.push('<button type="button" class="btn btn-ghost rzc-propose" data-act="rz-cortex-expand"' + (busy ? ' disabled' : '') + '>' + icon('spark') + ' ' + (n.parent ? 'Proposer des sous-thèmes' : 'Proposer des grands thèmes') + '</button>');

    if (n.lessons.length) {
      h.push('<div class="rzc-k">Cours sur ce nœud</div><ul class="rzc-lessons">' + n.lessons.slice().reverse().map(function (id) {
        var e = lessonEntry(id);
        return e ? '<li><span>' + esc(R.fmtDayShort(e.day)) + '</span><b lang="en">' + esc(e.title) + '</b>' + (e.status === 'done' ? '' : ' <span class="rz-muted">· pas encore fait</span>') + '</li>' : '';
      }).join('') + '</ul>');
    }

    h.push('<div class="rzc-foot">');
    if (n.parent) {
      h.push('<button type="button" class="btn btn-ghost" data-act="rz-cortex-rename">Renommer</button>');
      h.push('<button type="button" class="btn btn-ghost rzc-danger" data-act="rz-cortex-del">' + esc(U.confirmDel === n.id ? 'Confirmer la suppression' : 'Supprimer') + '</button>');
    } else {
      h.push('<button type="button" class="btn btn-ghost" data-act="rz-cortex-rename">Renommer la carte</button>');
      if (maps().length > 1) h.push('<button type="button" class="btn btn-ghost rzc-danger" data-act="rz-cortex-del-map">' + esc(U.confirmDel === map.id ? 'Confirmer : supprimer la carte' : 'Supprimer la carte') + '</button>');
    }
    h.push('</div></section>');
    return h.join('');
  }
  function exampleFor(n) {
    var t = key(n.title);
    if (/histoire/.test(t)) return 'La Rome antique';
    if (/philo/.test(t)) return 'Le stoïcisme';
    if (/informatique|code|program/.test(t)) return 'Les réseaux';
    if (/bricolage|maison/.test(t)) return 'Poser du carrelage';
    if (/science/.test(t)) return 'L’évolution';
    return 'un sujet précis';
  }

  /* Au premier affichage d'une carte, on centre la racine ; ensuite, un nœud choisi hors de vue
     (depuis le panneau, après un cours) est ramené au centre. */
  function after(host) {
    var c = host.querySelector('[data-rzc-canvas]');
    if (!c) return;
    var mapId = c.getAttribute('data-map');
    if (U.centered !== mapId + ':' + U.zoom) {
      U.centered = mapId + ':' + U.zoom;
      var st = c.firstChild, cx = num(st.getAttribute('data-cx'), 0) * U.zoom, cy = num(st.getAttribute('data-cy'), 0) * U.zoom;
      c.scrollLeft = Math.max(0, cx - c.clientWidth / 2);
      c.scrollTop = Math.max(0, cy - c.clientHeight / 2);
    }
    var sel = c.querySelector('.rzc-node.on');
    if (!sel) return;
    var cr = c.getBoundingClientRect(), r = sel.getBoundingClientRect(), m = 24;
    if (r.left < cr.left + m || r.right > cr.right - m || r.top < cr.top + m || r.bottom > cr.bottom - m) {
      c.scrollLeft += (r.left + r.width / 2) - (cr.left + cr.width / 2);
      c.scrollTop += (r.top + r.height / 2) - (cr.top + cr.height / 2);
    }
  }

  R.view('cortex', {
    label: 'Cortex', icon: 'node', order: 15, title: 'Le cortex — vos cartes des savoirs, et des cours de fond',
    render: render, after: after,
    onShow: function (p) {
      if (p && p.map && mapById(p.map)) { store().current = p.map; if (p.node) U.sel[p.map] = p.node; }
    },
    keydown: function (e, el, role) {
      if (e.key !== 'Enter') return false;
      if (role === 'rz-cortex-add') { e.preventDefault(); doAdd(); return true; }
      if (role === 'rz-cortex-rename') { e.preventDefault(); doRename(); return true; }
      if (role === 'rz-cortex-new-title') { e.preventDefault(); doCreate(); return true; }
      return false;
    }
  });

  /* ══ Actions ════════════════════════════════════════════════════════════ */

  function attr(el, n) { return el && el.getAttribute ? el.getAttribute(n) : null; }
  function selected() { var m = current(); return { map: m, node: node(m, U.sel[m.id]) || rootOf(m) }; }

  R.act('rz-cortex-map', function (el) { store().current = attr(el, 'data-id'); U.rename = null; U.confirmDel = ''; U.add = ''; R.save(); R.render(); });
  R.act('rz-cortex-sel', function (el) {
    var m = current(), id = attr(el, 'data-id'), n = node(m, id);
    if (!n) return;
    if (U.sel[m.id] === id && kids(m, id).length && n.parent) {
      var k = expKey(m, n);
      U.expanded[k] = !isExpanded(m, n, depth(m, n));
    } else if (n.parent && kids(m, id).length) U.expanded[expKey(m, n)] = true;
    U.sel[m.id] = id; U.rename = null; U.confirmDel = ''; U.add = '';
    R.render();
  });
  R.act('rz-cortex-mode', function (el) {
    var m = current(), v = attr(el, 'data-value');
    if (!MODES[v]) return;
    m.mode = v;
    U.note[m.id] = v === 'manual' ? 'Vous choisissez vos nœuds : tout est ouvert, l’agent ne propose plus rien de lui-même.' : 'L’agent propose : sous-thèmes à la demande, et de nouveaux nœuds après chaque cours.';
    touched(m); R.render();
  });
  R.change('rz-cortex-tidy', function (el) { var m = current(); m.autoTidy = !!el.checked; touched(m); R.render(); });
  R.act('rz-cortex-organize', function () { runAgent(current(), 'organize'); });
  R.act('rz-cortex-zoom', function (el) {
    var z = +attr(el, 'data-z');
    U.zoom = z === 0 ? 1 : Math.max(0.4, Math.min(1.6, Math.round((U.zoom + z * 0.15) * 100) / 100));
    R.render();
  });
  R.act('rz-cortex-expand', function () {
    var s = selected();
    runAgent(s.map, s.node.parent ? 'expand' : (kids(s.map, s.node.id).length ? 'expand' : 'create'), { node: s.node.id });
  });
  R.input('rz-cortex-add', function (el) { U.add = el.value.slice(0, 80); });
  R.act('rz-cortex-add', function () { doAdd(); });
  function doAdd() {
    var s = selected(), t = U.add.trim();
    if (!t) { R.toast('Écrivez le sous-thème à ajouter.'); return; }
    var n = addChild(s.map, s.node.id, t);
    U.add = '';
    if (n) U.note[s.map.id] = '« ' + n.title + ' » ajouté' + (s.map.autoTidy ? ' ; la carte va être remise en ordre.' : '.');
    R.render();
  }
  R.act('rz-cortex-status', function (el) { var s = selected(); if (s.node.parent && STATUS[attr(el, 'data-s') || attr(el, 'data-value')]) setStatus(s.map, s.node, attr(el, 'data-s') || attr(el, 'data-value')); R.render(); });
  R.act('rz-cortex-rename', function () { var s = selected(); U.rename = U.rename === s.node.id ? null : s.node.id; R.render(); });
  R.act('rz-cortex-rename-ok', function () { doRename(); });
  function doRename() {
    var s = selected(), el = document.querySelector('[data-role="rz-cortex-rename"]'), t = clip(el ? el.value : '', 80);
    U.rename = null;
    if (t && t !== s.node.title) {
      s.node.title = t;
      if (!s.node.parent) { s.map.title = t; touched(s.map); } else edited(s.map);
    }
    R.render();
  }
  R.act('rz-cortex-del', function () {
    var s = selected();
    if (U.confirmDel !== s.node.id) { U.confirmDel = s.node.id; R.render(); return; }
    U.confirmDel = '';
    var t = s.node.title;
    removeNode(s.map, s.node.id);
    U.note[s.map.id] = '« ' + t + ' » supprimé ; ses sous-thèmes sont remontés d’un cran.';
    R.render();
  });
  R.act('rz-cortex-del-map', function () {
    var m = current(), c = store();
    if (U.confirmDel !== m.id) { U.confirmDel = m.id; R.render(); return; }
    U.confirmDel = '';
    c.maps = c.maps.filter(function (x) { return x !== m; });
    c.current = c.maps[0] ? c.maps[0].id : '';
    R.save(); R.render();
  });
  R.act('rz-cortex-lesson', function (el) {
    var s = selected();
    if (!s.node.parent) return;
    if (!R.lessonApi) { R.toast('Le module du cours n’est pas chargé.'); return; }
    R.lessonApi.pickCortex(s.map.id, s.node.id, attr(el, 'data-depth') === 'deepen' ? 'deepen' : 'intro');
  });

  R.act('rz-cortex-new', function () { U.newOpen = !U.newOpen; R.render(); });
  R.input('rz-cortex-new-title', function (el) { U.newTitle = el.value.slice(0, 80); });
  R.input('rz-cortex-new-desc', function (el) { U.newDesc = el.value.slice(0, 600); });
  R.act('rz-cortex-new-plan', function (el) { U.newPlan = attr(el, 'data-value') === 'empty' ? 'empty' : 'agent'; R.render(); });
  R.act('rz-cortex-create', function () { doCreate(); });
  function doCreate() {
    var t = clip(U.newTitle, 80);
    if (!t) { R.toast('Donnez un nom à la carte : le domaine que vous voulez explorer.'); return; }
    var now = Date.now(), c = store();
    var m = normMap({ id: R.uid('cxmap'), title: t, description: U.newDesc.trim(), mode: U.newPlan === 'agent' ? 'propose' : 'manual', autoTidy: true, createdAt: now, updatedAt: now,
      nodes: [{ id: 'root', parent: '', title: t, summaryFr: U.newDesc.trim(), status: 'open', origin: 'user', order: 0, at: now }] });
    c.maps.push(m);
    c.current = m.id;
    U.sel[m.id] = 'root';
    var plan = U.newPlan;
    U.newOpen = false; U.newTitle = ''; U.newDesc = ''; U.centered = '';
    R.save(true);
    if (plan === 'agent') runAgent(m, 'create', { node: 'root' });
    else { U.note[m.id] = 'Carte créée : ajoutez vos grands thèmes à droite.'; R.render(); }
  }

  /* ══ Carte d'accueil ════════════════════════════════════════════════════ */

  R.homeCard({ id: 'cortex', area: 'side', order: 30, html: function () {
    if (!R.profile.onboarded) return '';
    var m = current(), total = m.nodes.length - 1, done = m.nodes.filter(function (x) { return x.parent && studied(x.status); }).length;
    var next = suggest(3);
    var h = ['<section class="rz-card rzc-home"><div class="rz-card-head"><span class="rz-card-title">' + icon('node') + ' Le cortex</span><span class="rz-card-meta">' + esc(m.title + ' · ' + done + ' / ' + total) + '</span></div>'];
    h.push('<div class="rzc-home-bar" aria-hidden="true"><i style="width:' + (total ? Math.round(done / total * 100) : 0) + '%"></i></div>');
    if (next.length) h.push('<ul class="rzc-home-list">' + next.map(function (x) {
      return '<li><button type="button" class="rzc-kid is-' + x.s + '" data-act="rz-cortex-lesson-home" data-map="' + esc(x.map.id) + '" data-id="' + esc(x.node.id) + '" title="Préparer le cours sur ce nœud"><i class="rzc-dot is-' + x.s + '"></i><span>' + esc(x.node.title) + '</span><span class="rz-muted">' + esc(STATUS[x.s]) + '</span></button></li>';
    }).join('') + '</ul>');
    h.push('<button type="button" class="btn btn-ghost" data-act="rz-go" data-view="cortex">Ouvrir le cortex</button></section>');
    return h.join('');
  } });
  R.act('rz-cortex-lesson-home', function (el) { if (R.lessonApi) R.lessonApi.pickCortex(attr(el, 'data-map'), attr(el, 'data-id'), null); });

  /* ══ Simulation hors WebView2 ═══════════════════════════════════════════ */

  R.fixture('cortex', function (p) {
    var nodes = arr(p.nodes), mode = p.mode;
    var focus = nodes.filter(function (n) { return n.id === p.node; })[0];
    if (mode === 'create') {
      var themes = ['Les outils de base', 'Les matériaux', 'La sécurité', 'Les projets faciles'];
      var out = [];
      themes.forEach(function (t, i) {
        out.push({ ref: 'new' + (i + 1), parent: p.node || 'root', title: t, summaryFr: 'Ce qu’il faut savoir : ' + t.toLowerCase() + '.', query: t });
        out.push({ ref: 'new' + (i + 1) + 'a', parent: 'new' + (i + 1), title: t + ' : l’essentiel', summaryFr: '', query: t + ' basics' });
        out.push({ ref: 'new' + (i + 1) + 'b', parent: 'new' + (i + 1), title: t + ' : aller plus loin', summaryFr: '', query: t + ' advanced' });
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
