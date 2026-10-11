/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — classement (vue « board »)
   Le petit côté compétitif : sur un serveur Révizator à plusieurs comptes, chacun voit où il en est par
   rapport aux autres. Le serveur calcule tout (learnBoard, src/Revizator.Server/Leaderboard.cs) et ne rend
   que des agrégats par semaine — points, minutes, jours actifs, séances, cartes révisées, niveau estimé — et
   les scores des bilans express : jamais une carte, un texte ni une erreur d'un autre compte.
     · tableau du classement sur la période (4 semaines, 12 semaines, 6 mois), avec l'écart au suivant ;
     · courbes comparées, une par joueur : points cumulés, points par semaine, minutes par semaine, niveau ;
     · carte « Classement » sur l'accueil (votre rang cette semaine, le podium) ;
     · Réglages › Révizator › Classement : pseudo, et se retirer du classement.
   Points (les mêmes pour tous, calculés par le serveur) : 1 par minute de travail (90 au plus par jour),
   10 par jour actif (5 minutes ou plus), 5 par séance de l'objectif hebdomadaire quand il est atteint.
   Couleurs : vous en premier (bleu), puis les autres par ordre alphabétique ; au-delà de quatre joueurs,
   les courbes suivantes sont grises, toutes nommées en bout de ligne (palette vérifiée, daltonisme compris).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R) return;
  var esc = R.esc;
  var U = R.ui.board = R.ui.board || { weeks: 12, metric: 'cumul', data: null, loading: false, error: '', at: 0 };

  var FETCH_WEEKS = 26;
  var STALE_MS = 60000;
  var SLOTS = 4;
  var METRICS = {
    cumul: { label: 'Points cumulés', short: 'Points cumulés' },
    points: { label: 'Points par semaine', short: 'Points' },
    minutes: { label: 'Minutes par semaine', short: 'Minutes' },
    level: { label: 'Niveau estimé', short: 'Niveau' }
  };
  var LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function px(v) { return Math.round(v * 10) / 10; }
  function plural(n, one, many) { return n + ' ' + (n > 1 ? (many || one + 's') : one); }
  function short(ms) { return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); }
  function fmtMin(m) { return R.fmtMin(Math.round(m)); }
  function fmtPts(n) { return Math.round(n).toLocaleString('fr-FR') + ' pts'; }
  function tipAttr(lines) { return ' tabindex="0" data-rzp-tip="' + esc(lines.join('\n')) + '"'; }

  /* ══ Données ════════════════════════════════════════════════════════════ */

  function available() { return !!(window.bridge && (window.bridge.mode === 'server' || (window.bridge.remote && window.bridge.remote()) || window.bridge.isShim)); }

  function load(force) {
    if (U.loading || !available()) return;
    if (!force && U.at && Date.now() - U.at < STALE_MS) return;
    U.loading = true;
    U.at = Date.now();
    window.bridge.call('learnBoard', { weeks: FETCH_WEEKS }, 20000).then(function (d) {
      U.data = d && Array.isArray(d.players) ? d : null;
      U.error = U.data ? '' : 'Réponse inattendue du serveur.';
    }, function (e) {
      U.error = (e && e.message) || 'Classement indisponible.';
    }).then(function () {
      U.loading = false;
      U.at = Date.now();
      R.render();
    });
  }
  R.board = { refresh: function () { load(true); } };

  /* Après une sauvegarde (pseudo changé, séance finie), le classement suivant relit le serveur. */
  R.on('saved', function () { U.at = Math.min(U.at, Date.now() - STALE_MS + 3000); });

  /* Joueurs de la période : agrégats, rang, couleur (vous d'abord, puis par nom — jamais selon le rang). */
  function players(n) {
    var d = U.data;
    if (!d) return [];
    var weeks = arr(d.weeks);
    n = Math.min(n, weeks.length);
    var list = arr(d.players).map(function (p) {
      var w = arr(p.weeks).slice(-n);
      var sum = function (k, from, to) { return w.slice(from || 0, to == null ? w.length : to).reduce(function (a, x) { return a + num(x && x[k], 0); }, 0); };
      var thetas = w.map(function (x) { return x && x.theta; }).filter(function (t) { return t != null && isFinite(t); });
      return {
        name: String(p.name || '?'), me: !!p.me, hidden: !!p.hidden, since: num(p.since, 0), theta: num(p.theta, 0),
        weeks: w, points: sum('points'), prevPoints: sum('points', 0, w.length - 1), minutes: sum('minutes'), days: sum('days'), cards: sum('cards'),
        thisWeek: num(w.length && w[w.length - 1].points, 0), goalWeeks: w.filter(function (x) { return x && x.sessions >= x.goal; }).length,
        delta: thetas.length > 1 ? thetas[thetas.length - 1] - thetas[0] : 0,
        toeic: arr(p.toeic).length ? arr(p.toeic)[arr(p.toeic).length - 1] : null
      };
    });
    var others = list.filter(function (p) { return !p.me; }).sort(function (a, b) { return a.name.localeCompare(b.name, 'fr'); });
    var me = list.filter(function (p) { return p.me; });
    me.concat(others).forEach(function (p, i) { p.slot = i < SLOTS ? i : -1; });
    var rank = function (key) {
      list.slice().sort(function (a, b) { return b[key] - a[key] || b.minutes - a.minutes || a.name.localeCompare(b.name, 'fr'); })
        .forEach(function (p, i) { p[key + 'Rank'] = i + 1; });
    };
    rank('points'); rank('prevPoints'); rank('thisWeek');
    return list.sort(function (a, b) { return a.pointsRank - b.pointsRank; });
  }

  function band(theta) { return R.band(theta); }
  function swatch(p) { return '<i class="rzb-sw ' + slotCls(p) + '" aria-hidden="true"></i>'; }
  function slotCls(p) { return p.slot >= 0 ? 'rzb-c' + p.slot : 'rzb-cx'; }
  function nameHtml(p) { return esc(p.name) + (p.me ? ' <span class="rzb-me">vous</span>' : ''); }
  function periodLabel(n) { return n === 4 ? '4 dernières semaines' : n === 12 ? '12 dernières semaines' : '6 derniers mois'; }

  /* ══ Tableau ════════════════════════════════════════════════════════════ */

  function move(p) {
    var d = p.prevPointsRank - p.pointsRank;
    if (!p.prevPoints && !p.points) return '';
    if (d > 0) return '<span class="rzb-move is-up" title="' + esc('Gagne ' + plural(d, 'place') + ' cette semaine') + '">▲' + d + '</span>';
    if (d < 0) return '<span class="rzb-move is-down" title="' + esc('Perd ' + plural(-d, 'place') + ' cette semaine') + '">▼' + (-d) + '</span>';
    return '<span class="rzb-move" title="Même place que la semaine dernière">=</span>';
  }

  function medal(rank) { return rank <= 3 ? '<span class="rzb-medal rzb-m' + rank + '" aria-label="' + rank + (rank === 1 ? 'er' : 'e') + '">' + rank + '</span>' : '<span class="rzb-rank">' + rank + '</span>'; }

  function chaseHtml(list) {
    var me = list.filter(function (p) { return p.me; })[0];
    if (!me || list.length < 2) return '';
    if (me.pointsRank === 1) {
      var second = list[1];
      var lead = Math.round(me.points - second.points);
      return '<div class="rz-callout rzb-lead rzb-chase">' + R.icon('trophy') + '<span>Vous menez, avec <b>' + esc(fmtPts(lead)) + '</b> d’avance sur ' + esc(second.name) + '. Gardez le rythme !</span></div>';
    }
    var ahead = list[me.pointsRank - 2];
    var gap = Math.max(1, Math.round(ahead.points - me.points + 1));
    var mins = Math.max(5, Math.ceil(gap / 1.5 / 5) * 5);
    return '<div class="rz-callout is-accent rzb-chase">' + R.icon('target') + '<span>Encore <b>' + esc(fmtPts(gap)) + '</b> pour passer devant ' + esc(ahead.name)
      + ' : environ ' + esc(fmtMin(mins)) + ' de travail de plus, mieux en plusieurs jours.</span>'
      + '<button type="button" class="btn btn-primary" data-act="rz-go" data-view="home">Faire une séance</button></div>';
  }

  function tableHtml(list, n) {
    var h = ['<section class="rz-card rzb-card"><div class="rz-card-head"><span class="rz-card-title">Classement</span><span class="rz-card-meta">' + esc(periodLabel(n)) + '</span></div>'];
    h.push('<div class="rzb-table-wrap"><table class="rzb-table"><thead><tr>'
      + '<th scope="col" class="rzb-col-rank">#</th><th scope="col">Joueur</th><th scope="col" class="is-num">Points</th><th scope="col" class="is-num" title="Points depuis lundi">Semaine</th>'
      + '<th scope="col" class="is-num rzb-opt">Temps</th><th scope="col" class="is-num rzb-opt">Jours actifs</th><th scope="col" class="is-num rzb-opt" title="Semaines où l’objectif de séances est atteint">Objectif</th>'
      + '<th scope="col" class="is-num rzb-opt">Cartes</th><th scope="col">Niveau</th></tr></thead><tbody>');
    list.forEach(function (p) {
      var dl = Math.round(p.delta * 100) / 100;
      h.push('<tr class="' + (p.me ? 'is-me' : '') + '">'
        + '<td class="rzb-col-rank">' + medal(p.pointsRank) + (list.length > 1 ? move(p) : '') + '</td>'
        + '<th scope="row" class="rzb-name">' + swatch(p) + '<span>' + nameHtml(p) + '</span></th>'
        + '<td class="is-num rzb-pts">' + esc(Math.round(p.points).toLocaleString('fr-FR')) + '</td>'
        + '<td class="is-num">' + esc(Math.round(p.thisWeek).toLocaleString('fr-FR')) + '</td>'
        + '<td class="is-num rzb-opt">' + esc(fmtMin(p.minutes)) + '</td>'
        + '<td class="is-num rzb-opt">' + p.days + '</td>'
        + '<td class="is-num rzb-opt">' + p.goalWeeks + '/' + n + '</td>'
        + '<td class="is-num rzb-opt">' + esc(Math.round(p.cards).toLocaleString('fr-FR')) + '</td>'
        + '<td class="rzb-level">' + R.h.level(band(p.theta)) + (Math.abs(dl) >= 0.05 ? '<span class="rzb-delta ' + (dl > 0 ? 'is-up' : 'is-down') + '" title="' + esc('Évolution du niveau estimé sur la période') + '">' + (dl > 0 ? '↗' : '↘') + '</span>' : '')
        + (p.toeic ? '<span class="rzb-toeic" title="' + esc('Dernier bilan express (score estimé façon TOEIC®, non officiel), le ' + new Date(p.toeic.at).toLocaleDateString('fr-FR')) + '">≈ ' + p.toeic.score + '</span>' : '') + '</td>'
        + '</tr>');
    });
    h.push('</tbody></table></div>');
    var rules = U.data && U.data.rules || {};
    h.push('<div class="rz-card-foot">Points : 1 par minute de travail (' + num(rules.dailyCap, 90) + ' au plus par jour), ' + num(rules.dayPoints, 10) + ' par jour actif (5 minutes ou plus), '
      + num(rules.goalPoints, 5) + ' par séance de l’objectif de la semaine quand il est atteint. La régularité paie plus que les marathons.</div></section>');
    return h.join('');
  }

  /* ══ Courbes ════════════════════════════════════════════════════════════ */

  function seriesOf(p, metric) {
    var acc = 0;
    return p.weeks.map(function (w) {
      if (!w) return null;
      if (metric === 'cumul') { acc += num(w.points, 0); return acc; }
      if (metric === 'points') return num(w.points, 0);
      if (metric === 'minutes') return num(w.minutes, 0);
      return w.theta == null ? null : num(w.theta, null);
    });
  }

  function fmtValue(metric, v) {
    if (v == null) return '—';
    if (metric === 'minutes') return fmtMin(v);
    if (metric === 'level') return band(v) + ' (' + String(Math.round(v * 100) / 100).replace('.', ',') + ')';
    return fmtPts(v);
  }

  function chartHtml(list, n) {
    var metric = METRICS[U.metric] ? U.metric : 'cumul';
    var starts = arr(U.data.weeks).slice(-n);
    /* Sur téléphone, un dessin plus étroit : textes lisibles sans zoom. */
    var narrow = !!(window.matchMedia && window.matchMedia('(max-width: 600px)').matches);
    var W = narrow ? 350 : 1000, H = narrow ? 260 : 280, ml = narrow ? 40 : 52, mr = narrow ? 66 : 132, mt = 16, mb = 30;
    var pw = W - ml - mr, ph = H - mt - mb;
    var series = list.map(function (p) { return { p: p, v: seriesOf(p, metric) }; });
    var vals = [];
    series.forEach(function (s) { s.v.forEach(function (v) { if (v != null) vals.push(v); }); });
    var lo, hi, ticks = [];
    if (metric === 'level') {
      lo = Math.floor(Math.min.apply(null, vals.length ? vals : [0]) - 0.3);
      hi = Math.ceil(Math.max.apply(null, vals.length ? vals : [1]) + 0.3);
      if (hi - lo < 2) hi = lo + 2;
      for (var t = lo; t <= hi; t++) if (t >= -2 && t <= 3) ticks.push([t, LEVELS[t + 2]]);
    } else {
      lo = 0;
      var max = Math.max.apply(null, vals.concat([metric === 'minutes' ? 60 : 50]));
      var step = niceStep(max / 4);
      hi = Math.ceil(max / step) * step;
      for (var v = 0; v <= hi + 1e-9; v += step) ticks.push([v, metric === 'minutes' ? fmtMin(v) : Math.round(v).toLocaleString('fr-FR')]);
    }
    var x = function (i) { return ml + (n > 1 ? i / (n - 1) : 0.5) * pw; };
    var y = function (v) { return mt + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / Math.max(1e-9, hi - lo)) * ph; };
    var g = ['<svg class="rzp-svg rzb-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(METRICS[metric].label + ' par joueur, ' + periodLabel(n)) + '">'];
    ticks.forEach(function (tk) {
      var yy = px(y(tk[0]));
      g.push('<line class="rzp-grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + yy + '" y2="' + yy + '"></line>'
        + '<text class="rzp-tick" x="' + (ml - 8) + '" y="' + (yy + 4) + '" text-anchor="end">' + esc(tk[1]) + '</text>');
    });
    var every = narrow ? (n <= 4 ? 1 : n <= 13 ? 4 : 8) : (n <= 6 ? 1 : n <= 13 ? 2 : 4);
    starts.forEach(function (ms, i) {
      if ((n - 1 - i) % every) return;
      var xx = px(x(i));
      g.push('<line class="rzp-xtick" x1="' + xx + '" x2="' + xx + '" y1="' + (mt + ph) + '" y2="' + (mt + ph + 4) + '"></line>'
        + '<text class="rzp-tick" x="' + xx + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(i === n - 1 ? 'cette sem.' : short(ms)) + '</text>');
    });
    g.push('<line class="rzp-axis" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + (mt + ph) + '" y2="' + (mt + ph) + '"></line>');
    /* Les gris d'abord, vous en dernier : votre courbe passe au-dessus des autres. */
    var order = series.slice().sort(function (a, b) { return (a.p.me ? 1 : 0) - (b.p.me ? 1 : 0) || b.p.slot - a.p.slot; });
    var ends = [];
    order.forEach(function (s) {
      var pts = [];
      s.v.forEach(function (v, i) { if (v != null) pts.push([px(x(i)), px(y(v))]); });
      if (!pts.length) return;
      var cls = slotCls(s.p) + (s.p.me ? ' is-me' : '');
      if (pts.length > 1) g.push('<polyline class="rzb-line ' + cls + '" points="' + pts.map(function (q) { return q.join(','); }).join(' ') + '"></polyline>');
      var last = pts[pts.length - 1];
      g.push('<circle class="rzb-dot ' + cls + '" cx="' + last[0] + '" cy="' + last[1] + '" r="4.5"></circle>');
      ends.push({ p: s.p, x: last[0], y: last[1] });
    });
    /* Noms en bout de courbe, écartés de 15 px au moins pour ne pas se chevaucher. */
    ends.sort(function (a, b) { return a.y - b.y; });
    for (var k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 15) ends[k].y = ends[k - 1].y + 15;
    var over = ends.length ? ends[ends.length - 1].y - (mt + ph) : 0;
    if (over > 0) ends.forEach(function (e) { e.y -= over; });
    ends.forEach(function (e) {
      g.push('<text class="rzb-end' + (e.p.me ? ' is-me' : '') + '" x="' + (W - mr + 10) + '" y="' + px(e.y + 4) + '">' + esc(clip(e.p.name, narrow ? 9 : 16)) + '</text>');
    });
    /* Survol : une colonne par semaine, toutes les valeurs de la semaine dans l'info-bulle. */
    starts.forEach(function (ms, i) {
      var xa = i ? (x(i - 1) + x(i)) / 2 : ml, xb = i < n - 1 ? (x(i) + x(i + 1)) / 2 : W - mr;
      var rows = series.map(function (s) { return { p: s.p, v: s.v[i] }; }).sort(function (a, b) { return num(b.v, -1e9) - num(a.v, -1e9); });
      var lines = ['Semaine du ' + new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })].concat(rows.map(function (r) { return r.p.name + (r.p.me ? ' (vous)' : '') + ' : ' + fmtValue(metric, r.v); }));
      g.push('<g class="rzp-hit"' + tipAttr(lines) + '><rect x="' + px(xa) + '" y="' + mt + '" width="' + px(Math.max(6, xb - xa)) + '" height="' + ph + '"></rect>'
        + '<line x1="' + px(x(i)) + '" x2="' + px(x(i)) + '" y1="' + mt + '" y2="' + (mt + ph) + '"></line></g>');
    });
    g.push('</svg>');

    var legend = '<div class="rzp-legend rzb-legend">' + list.slice().sort(function (a, b) { return (a.slot < 0 ? 99 : a.slot) - (b.slot < 0 ? 99 : b.slot) || a.name.localeCompare(b.name, 'fr'); })
      .map(function (p) { return '<span>' + swatch(p) + esc(p.name) + (p.me ? ' (vous)' : '') + '</span>'; }).join('') + '</div>';
    var head = ['Semaine'].concat(list.map(function (p) { return p.name; }));
    var rows = starts.map(function (ms, i) { return [short(ms)].concat(series.map(function (s) { return fmtValue(metric, s.v[i]); })); });
    var keys = Object.keys(METRICS);
    return '<section class="rz-card rzp-card rzb-chart"><div class="rz-card-head"><span class="rz-card-title">Courbes comparées</span>'
      + R.h.chips('rzb-metric', keys, metric, keys.map(function (k) { return METRICS[k].short; }), 'rz-board-metric') + '</div>'
      + legend + g.join('')
      + dataTable(METRICS[metric].label + ' — ' + periodLabel(n), head, rows)
      + '<div class="rz-card-foot">' + esc(metric === 'level'
        ? 'Niveau estimé de chacun (toutes compétences, la langue comptant pour moitié), à la fin de chaque semaine : il se recale au fil des exercices et des bilans.'
        : metric === 'cumul' ? 'Les points s’additionnent semaine après semaine : la pente, c’est le rythme. Une courbe qui se redresse rattrape les autres.'
          : 'Survolez une semaine pour comparer les valeurs de chacun.') + '</div></section>';
  }

  function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log(Math.max(raw, 1)) / Math.LN10));
    var f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function dataTable(caption, head, rows) {
    return '<details class="rzp-table"><summary>Voir les données</summary><div class="rzp-table-wrap"><table><caption>' + esc(caption) + '</caption><thead><tr>'
      + head.map(function (h) { return '<th scope="col">' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return i === 0 ? '<th scope="row">' + esc(c) + '</th>' : '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('')
      + '</tbody></table></div></details>';
  }

  /* ══ Vue ════════════════════════════════════════════════════════════════ */

  function renderBoard() {
    load(false);
    var n = U.weeks;
    var h = [];
    h.push('<div class="rzp-head"><div><div class="rz-kicker">' + R.icon('trophy') + ' Classement</div><h2 class="rz-section-title">Qui progresse le plus ?</h2>'
      + '<div class="rz-sub">Votre travail face à celui des autres comptes de ce serveur Révizator.</div></div>'
      + '<div class="rzp-filter"><span class="rzp-filter-k">Période</span>' + R.h.chips('rzb-period', ['4', '12', '26'], String(n), ['4 semaines', '12 semaines', '6 mois'], 'rz-board-period')
      + '<button type="button" class="btn btn-ghost rzb-refresh" data-act="rz-board-refresh" title="Relire le classement"' + (U.loading ? ' disabled' : '') + '>' + (U.loading ? 'Lecture…' : 'Actualiser') + '</button></div></div>');
    if (!available()) {
      h.push(R.h.empty('Classement indisponible', 'Le classement réunit les comptes d’un serveur Révizator : connectez-vous à un serveur dans Réglages › Révizator.'));
      return h.join('');
    }
    if (!U.data) {
      h.push(U.error ? '<div class="rz-callout rzb-warn">' + esc('Classement indisponible : ' + U.error) + ' <button type="button" class="btn btn-ghost" data-act="rz-board-refresh">Réessayer</button></div>'
        : '<div class="rz-card rzb-wait"><span class="rz-spin"></span> Lecture du classement…</div>');
      return h.join('');
    }
    if (U.error) h.push('<div class="rz-callout rzb-warn">' + esc('Dernière lecture impossible (' + U.error + ') : le classement affiché peut dater un peu.') + '</div>');
    var list = players(n);
    var me = list.filter(function (p) { return p.me; })[0];
    if (me && me.hidden) {
      h.push('<div class="rz-callout">Vous êtes retiré du classement : les autres ne vous voient pas. <button type="button" class="btn btn-ghost" data-act="rz-board-show">M’y faire apparaître</button></div>');
    }
    if (list.length < 2) {
      h.push(R.h.empty('Seul en piste pour l’instant',
        'Le classement compare les comptes de ce serveur. Invitez vos proches : chacun a son compte (revizator-server user set <identifiant>) et ses propres données, et vous verrez vos courbes côte à côte.'));
      if (list.length) h.push(tableHtml(list, n));
      return h.join('');
    }
    h.push(chaseHtml(list));
    h.push(podiumHtml(list));
    h.push(tableHtml(list, n));
    h.push(chartHtml(list, n));
    return h.join('');
  }

  function podiumHtml(list) {
    var week = list.slice().sort(function (a, b) { return a.thisWeekRank - b.thisWeekRank; }).slice(0, 3);
    if (!week.some(function (p) { return p.thisWeek > 0; })) return '';
    var order = [week[1], week[0], week[2]].filter(Boolean);
    return '<section class="rz-card rzb-podium" aria-label="Podium de la semaine"><div class="rz-card-head"><span class="rz-card-title">Podium de la semaine</span>'
      + '<span class="rz-card-meta">depuis lundi</span></div><div class="rzb-steps">' + order.map(function (p) {
        return '<div class="rzb-step rzb-step' + p.thisWeekRank + (p.me ? ' is-me' : '') + '"><div class="rzb-step-name">' + swatch(p) + nameHtml(p) + '</div>'
          + '<div class="rzb-step-pts">' + esc(fmtPts(p.thisWeek)) + '</div><div class="rzb-step-block">' + p.thisWeekRank + '</div></div>';
      }).join('') + '</div></section>';
  }

  R.act('rz-board-period', function (el) { U.weeks = Math.max(1, Math.min(FETCH_WEEKS, +el.getAttribute('data-value') || 12)); R.render(); });
  R.act('rz-board-metric', function (el) { U.metric = el.getAttribute('data-value'); R.render(); });
  R.act('rz-board-refresh', function () { load(true); R.render(); });
  R.act('rz-board-show', function () { R.profile.boardHidden = false; R.save(true); U.at = 0; R.render(); });

  R.view('board', {
    label: 'Classement', icon: 'trophy', order: 55, title: 'Classement — votre progression face aux autres comptes du serveur',
    nav: available,
    render: renderBoard,
    onShow: function () { load(true); }
  });

  /* ══ Carte de l'accueil ═════════════════════════════════════════════════ */

  R.homeCard({ id: 'board', area: 'side', order: 75, html: function () {
    if (!available()) return '';
    load(false);
    if (!U.data) return '';
    var list = players(1);
    var me = list.filter(function (p) { return p.me; })[0];
    if (!me || list.length < 2) return '';
    var week = list.slice().sort(function (a, b) { return a.thisWeekRank - b.thisWeekRank; });
    var rows = week.slice(0, 3);
    if (rows.indexOf(me) < 0) rows.push(me);
    var ahead = me.thisWeekRank > 1 ? week[me.thisWeekRank - 2] : null;
    var foot = ahead ? 'Encore ' + fmtPts(Math.max(1, Math.round(ahead.thisWeek - me.thisWeek + 1))) + ' pour passer devant ' + ahead.name + '.'
      : me.thisWeek > 0 ? 'Vous menez cette semaine. Tenez bon jusqu’à dimanche !' : 'Personne n’a encore marqué cette semaine : à vous de lancer la course.';
    return '<section class="rz-card rzb-home"><div class="rz-card-head"><span class="rz-card-title">' + R.icon('trophy') + ' Classement</span><span class="rz-card-meta">cette semaine</span></div>'
      + '<ol class="rzb-home-list">' + rows.map(function (p) {
        return '<li class="' + (p.me ? 'is-me' : '') + '"><span class="rzb-home-rank">' + p.thisWeekRank + '</span>' + swatch(p) + '<span class="rzb-home-name">' + nameHtml(p) + '</span><b>' + esc(fmtPts(p.thisWeek)) + '</b></li>';
      }).join('') + '</ol>'
      + '<div class="rz-card-foot">' + esc(foot) + ' <button type="button" class="btn btn-ghost rzp-link" data-act="rz-go" data-view="board">Voir le classement</button></div></section>';
  } });

  /* ══ Réglages ═══════════════════════════════════════════════════════════ */

  R.settingsSection({ id: 'board', order: 60, html: function () {
    var p = R.profile;
    var field = R.setField;
    return '<div class="set-card"><div class="set-card-head"><span class="set-card-title">Classement</span></div>'
      + field('Pseudo', '<input class="input set-cwd" type="text" maxlength="24" data-role="rz-board-name" data-focus-key="rz-set-board-name" placeholder="Votre identifiant de connexion" value="' + esc(p.boardName || '') + '">')
      + field('Apparaître', R.h.chips('boardHidden', ['no', 'yes'], p.boardHidden ? 'yes' : 'no', ['Dans le classement', 'Retiré du classement'], 'rz-board-hide'))
      + '<div class="set-card-foot">Les autres comptes du serveur voient votre pseudo, vos points, votre temps de travail par semaine et votre niveau estimé — jamais vos cartes, vos textes ni vos erreurs. Retiré, vous voyez toujours le classement, sans y figurer.</div></div>';
  } });

  R.input('rz-board-name', function (el) {
    R.profile.boardName = String(el.value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24);
    R.save();
  });
  R.act('rz-board-hide', function (el) { R.profile.boardHidden = el.getAttribute('data-value') === 'yes'; R.save(true); U.at = 0; R.render(); });

  /* ══ Simulation hors serveur (shim) ═════════════════════════════════════ */

  R.shim('learnBoard', function (p) {
    var n = Math.max(1, Math.min(26, num(p && p.weeks, 12)));
    var DAY = 86400000, now = Date.now();
    var monday = new Date(now); monday.setHours(0, 0, 0, 0); monday = monday.getTime() - ((monday.getDay() + 6) % 7) * DAY;
    var weeks = [];
    for (var i = n - 1; i >= 0; i--) weeks.push(monday - i * 7 * DAY);
    var profile = R.profile;
    var seed = function (k) { var s = 0; for (var j = 0; j < k.length; j++) s = (s * 31 + k.charCodeAt(j)) % 9973; return s; };
    var fake = function (name, base, slope, theta0, me) {
      var r = seed(name);
      return {
        name: name, me: me, since: weeks[0], theta: theta0 + slope * n / 20, totalMinutes: 0,
        weeks: weeks.map(function (w, i) {
          var m = Math.max(0, Math.round(base + slope * 40 * i / n + 35 * Math.sin((i + r) * 1.7)));
          var days = Math.min(7, Math.round(m / 25)), sessions = Math.round(m / 18);
          return { points: m + 10 * days + (sessions >= 4 ? 20 : 0), minutes: m, days: days, sessions: sessions, goal: 4, cards: Math.round(m * 2.4), theta: Math.round((theta0 + slope * i / 20) * 100) / 100 };
        }),
        toeic: [{ at: now - 20 * DAY, score: Math.round(600 + theta0 * 120) }]
      };
    };
    return {
      now: now, me: 'moi', weeks: weeks, rules: { dailyCap: 90, dayPoints: 10, goalPoints: 5 },
      players: [fake(profile.boardName || 'moi', 80, 0.6, 0.3, true), fake('Léa', 110, 0.2, 0.9, false), fake('Hugo', 50, 1, -0.4, false), fake('Camille', 70, 0.4, 0.1, false)]
    };
  });
})();
