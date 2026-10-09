/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — progrès (module U2)
   Vue « progress » : un tableau de bord sobre, en SVG fait main (aucune bibliothèque).
     · score estimé façon TOEIC dans le temps (tendance de Kalman et sa bande d'incertitude, points des bilans
       avec leur intervalle, scores officiels), oral et écrit 0-200 ;
     · niveau par compétence dans le temps (petits multiples, bandes CECRL en fond) ;
     · minutes par semaine et par compétence (barres empilées, objectif hebdomadaire) ;
     · régularité (jours actifs sur 12 semaines) ; révisions (cartes, mûres, rétention réelle) ;
     · points faibles du journal d'erreurs (tendance) ; oral récent (débit, réécoute) et capsules avant/après ;
     · temps total et repère « environ 200 heures de travail guidé par niveau ».
   Chaque graphique a une info-bulle au survol et au clavier, et sa table de données (« Voir les données »).
   Données lues : R.data.toeic, R.level(k).hist, R.data.sessions, R.data.cards / reviewLog, R.weakPoints,
   R.data.attempts, R.data.capsules (enregistrées par le tuteur, U3 ; montrées ici avant / après).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R) return;
  var esc = R.esc;
  var U = R.ui.progress = R.ui.progress || { period: 90, series: 'T' };

  var DAY = 86400000;
  /* Ordre fixe des compétences dans les graphiques (palette validée : voisins distincts, daltonisme compris). */
  var ORDER = ['write', 'read', 'speak', 'listen', 'lang'];
  var LABEL = { read: 'Lecture', listen: 'Écoute', write: 'Écrit', speak: 'Oral', lang: 'Langue et révisions', other: 'Non réparti' };
  var CUTS = {
    T: [['A2', 225], ['B1', 550], ['B2', 785], ['C1', 945]], L: [['A2', 110], ['B1', 275], ['B2', 400], ['C1', 490]],
    R: [['A2', 115], ['B1', 275], ['B2', 385], ['C1', 455]], S: [['A2', 90], ['B1', 120], ['B2', 160], ['C1', 180]], W: [['A2', 70], ['B1', 120], ['B2', 150], ['C1', 180]]
  };
  var MAX = { T: 990, L: 495, R: 495, S: 200, W: 200 };
  var SERIES_NAME = { T: 'Total', L: 'Écoute', R: 'Lecture' };
  var MENTION = 'format type TOEIC® · score estimé, non officiel — TOEIC est une marque déposée d’ETS, qui n’est pas associé à Révizator';

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function dayMs(key) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3], 12).getTime() : NaN; }
  function short(ms) { return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); }
  function longDate(ms) { return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }
  function fmtH(min) { return R.fmtMin(Math.round(min)); }
  function f1(x) { return String(Math.round(x * 10) / 10).replace('.', ','); }
  function plural(n, one, many) { return n + ' ' + (n > 1 ? (many || one + 's') : one); }
  function signed(n) { return (n > 0 ? '+' : (n < 0 ? '−' : '')) + Math.abs(n); }
  function tipAttr(lines) { return ' tabindex="0" data-rzp-tip="' + esc(lines.join('\n')) + '"'; }
  function px(v) { return Math.round(v * 10) / 10; }

  function tableHtml(caption, head, rows) {
    return '<details class="rzp-table"><summary>Voir les données</summary><div class="rzp-table-wrap"><table><caption>' + esc(caption) + '</caption><thead><tr>'
      + head.map(function (h) { return '<th scope="col">' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return i === 0 ? '<th scope="row">' + esc(c) + '</th>' : '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('')
      + '</tbody></table></div></details>';
  }

  function periodFrom() {
    var now = Date.now();
    if (U.period === 'all') {
      var first = num(R.data.createdAt, now);
      arr(R.data.sessions).forEach(function (s) { if (s.startedAt < first) first = s.startedAt; });
      arr(R.data.toeic && R.data.toeic.history).forEach(function (h) { if (h.at < first) first = h.at; });
      return Math.min(first, now - 28 * DAY);
    }
    return now - num(U.period, 90) * DAY;
  }

  /* ══ Score estimé façon TOEIC ═══════════════════════════════════════════ */

  function scoreData(series) {
    var t = R.data.toeic || {};
    var pts = arr(t.history).filter(function (h) { return h && h.kind === 'express' && h.total; }).map(function (h) {
      var m = series === 'T' ? h.total : h[series];
      var tr = h.trend && h.trend[series];
      return { at: h.at, id: h.id, score: m.score, ci: arr(m.ci90), trend: tr ? { mean: tr.mean, sd: tr.sd } : null };
    }).sort(function (a, b) { return a.at - b.at; });
    var off = [];
    var cal = t.calib || { L: [], R: [] };
    if (series === 'T') {
      arr(cal.L).forEach(function (l) {
        var r = arr(cal.R).filter(function (x) { return Math.abs(x.at - l.at) < 7 * DAY; })[0];
        if (r) off.push({ at: Math.max(l.at, r.at), score: l.official + r.official, detail: 'Listening ' + l.official + ' · Reading ' + r.official });
      });
    } else {
      arr(cal[series]).forEach(function (c) { off.push({ at: c.at, score: c.official, detail: (series === 'L' ? 'Listening ' : 'Reading ') + c.official }); });
    }
    return { pts: pts, off: off, now: t[series] || null };
  }

  function scoreChartHtml() {
    var series = U.series || 'T';
    var d = scoreData(series);
    var W = 1000, H = 250, ml = 44, mr = 16, mt = 14, mb = 28;
    var pw = W - ml - mr, ph = H - mt - mb;
    var from = periodFrom(), to = Date.now();
    var max = MAX[series];
    /* Échelle resserrée sur les données (avec de la marge), bornée à l'échelle officielle. */
    var vals = [];
    d.pts.forEach(function (p) { if (p.at >= from) { vals.push(p.score); p.ci.forEach(function (c) { vals.push(c); }); if (p.trend) { vals.push(p.trend.mean + 1.8 * p.trend.sd, p.trend.mean - 1.8 * p.trend.sd); } } });
    d.off.forEach(function (o) { if (o.at >= from) vals.push(o.score); });
    var step = max > 500 ? 100 : 50;
    var lo = vals.length ? Math.max(0, Math.floor((Math.min.apply(null, vals) - step / 2) / step) * step) : 0;
    var hi = vals.length ? Math.min(max, Math.ceil((Math.max.apply(null, vals) + step / 2) / step) * step) : max;
    if (hi - lo < 3 * step) { hi = Math.min(max, lo + 3 * step); lo = Math.max(0, hi - 3 * step); }
    var x = function (ms) { return ml + Math.max(0, Math.min(1, (ms - from) / Math.max(1, to - from))) * pw; };
    var y = function (v) { return mt + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * ph; };
    var g = [];
    g.push('<svg class="rzp-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Score estimé (' + SERIES_NAME[series] + ') dans le temps') + '">');
    /* Grille : les seuils CECRL officiels, plus 0 et le maximum. */
    var cutsIn = CUTS[series].filter(function (c) { return c[1] > lo && c[1] < hi; });
    var near = function (v) { return cutsIn.some(function (c) { return Math.abs(y(c[1]) - y(v)) < 16; }); };
    (near(lo) ? [] : [['', lo]]).concat(cutsIn).concat(near(hi) ? [] : [['', hi]]).forEach(function (c) {
      var yy = px(y(c[1]));
      g.push('<line class="rzp-grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + yy + '" y2="' + yy + '"></line>');
      g.push('<text class="rzp-tick" x="' + (ml - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + c[1] + '</text>');
      if (c[0]) g.push('<text class="rzp-cut" x="' + (W - mr - 4) + '" y="' + (yy - 4) + '" text-anchor="end">' + c[0] + '</text>');
    });
    /* Axe du temps : un repère par mois. */
    var m0 = new Date(from); m0.setDate(1); m0.setHours(12, 0, 0, 0); m0.setMonth(m0.getMonth() + 1);
    for (var k = 0; k < 40 && m0.getTime() <= to; k++) {
      var xm = px(x(m0.getTime()));
      g.push('<line class="rzp-xtick" x1="' + xm + '" x2="' + xm + '" y1="' + (mt + ph) + '" y2="' + (mt + ph + 4) + '"></line>'
        + '<text class="rzp-tick" x="' + xm + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(m0.toLocaleDateString('fr-FR', { month: 'short' })) + '</text>');
      m0.setMonth(m0.getMonth() + 1);
    }
    g.push('<line class="rzp-axis" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + (mt + ph) + '" y2="' + (mt + ph) + '"></line>');
    var tp = d.pts.filter(function (p) { return p.trend; });
    /* Bande d'incertitude de la tendance (90 %), prolongée jusqu'à aujourd'hui : elle s'élargit sans bilan. */
    if (tp.length) {
      var band = tp.map(function (p) { return { at: p.at, hi: p.trend.mean + 1.645 * p.trend.sd, lo: p.trend.mean - 1.645 * p.trend.sd, mean: p.trend.mean }; });
      var last = tp[tp.length - 1];
      var days = (to - last.at) / DAY;
      var sdNow = Math.sqrt(last.trend.sd * last.trend.sd + 16 * days * (series === 'T' ? 2 : 1));
      if (days > 1) band.push({ at: to, hi: last.trend.mean + 1.645 * sdNow, lo: last.trend.mean - 1.645 * sdNow, mean: last.trend.mean, ext: true });
      if (band.length === 1) band = [{ at: band[0].at - 2 * DAY, hi: band[0].hi, lo: band[0].lo, mean: band[0].mean }, { at: band[0].at + 2 * DAY, hi: band[0].hi, lo: band[0].lo, mean: band[0].mean }];
      var up = band.map(function (b) { return px(x(b.at)) + ',' + px(y(b.hi)); });
      var dn = band.slice().reverse().map(function (b) { return px(x(b.at)) + ',' + px(y(b.lo)); });
      g.push('<polygon class="rzp-band" points="' + up.concat(dn).join(' ') + '"></polygon>');
      var main = band.filter(function (b) { return !b.ext; });
      g.push('<polyline class="rzp-trend" points="' + main.map(function (b) { return px(x(b.at)) + ',' + px(y(b.mean)); }).join(' ') + '"></polyline>');
      if (band[band.length - 1].ext) {
        var a = main[main.length - 1];
        g.push('<line class="rzp-trend is-ext" x1="' + px(x(a.at)) + '" y1="' + px(y(a.mean)) + '" x2="' + px(x(to)) + '" y2="' + px(y(a.mean)) + '"></line>');
      }
    }
    /* Bilans : point et intervalle à 90 %. */
    d.pts.forEach(function (p) {
      if (p.at < from) return;
      var xx = px(x(p.at));
      if (p.ci.length === 2) g.push('<line class="rzp-ci" x1="' + xx + '" x2="' + xx + '" y1="' + px(y(p.ci[0])) + '" y2="' + px(y(p.ci[1])) + '"></line>');
      g.push('<circle class="rzp-pt" cx="' + xx + '" cy="' + px(y(p.score)) + '" r="5"></circle>');
    });
    /* Scores officiels : losanges à l'encre. */
    d.off.forEach(function (o) {
      if (o.at < from) return;
      var xx = px(x(o.at)), yy = px(y(o.score));
      g.push('<path class="rzp-off" d="M' + xx + ' ' + (yy - 7) + 'L' + (xx + 7) + ' ' + yy + 'L' + xx + ' ' + (yy + 7) + 'L' + (xx - 7) + ' ' + yy + 'Z"></path>');
    });
    /* Zones de survol : une colonne par repère (le pointeur vise une date, pas un point de 5 px). */
    var marks = d.pts.filter(function (p) { return p.at >= from; }).map(function (p) {
      return { at: p.at, lines: [p.score + ' / ' + max, 'Bilan express du ' + longDate(p.at), p.ci.length === 2 ? 'à 90 % : ' + p.ci[0] + '–' + p.ci[1] : '', p.trend ? 'tendance ≈ ' + p.trend.mean + ' ± ' + Math.round(1.645 * p.trend.sd) : ''].filter(Boolean) };
    }).concat(d.off.filter(function (o) { return o.at >= from; }).map(function (o) { return { at: o.at, lines: [o.score + ' / ' + max, 'Score officiel du ' + longDate(o.at), o.detail] }; }))
      .sort(function (a, b) { return a.at - b.at; });
    marks.forEach(function (mk, i) {
      var xa = i ? (x(marks[i - 1].at) + x(mk.at)) / 2 : ml, xb = i < marks.length - 1 ? (x(mk.at) + x(marks[i + 1].at)) / 2 : W - mr;
      g.push('<g class="rzp-hit"' + tipAttr(mk.lines) + '><rect x="' + px(xa) + '" y="' + mt + '" width="' + px(Math.max(6, xb - xa)) + '" height="' + ph + '"></rect>'
        + '<line x1="' + px(x(mk.at)) + '" x2="' + px(x(mk.at)) + '" y1="' + mt + '" y2="' + (mt + ph) + '"></line></g>');
    });
    g.push('</svg>');
    return { svg: g.join(''), d: d, series: series };
  }

  function productiveRowHtml() {
    var h = arr(R.data.toeic && R.data.toeic.history).filter(function (x) { return x.kind === 'sw'; });
    if (!h.length) return '<div class="rzp-sw-empty">Oral et écrit (0-200) : pas encore de bilan. ' + '<button type="button" class="btn btn-ghost rzp-link" data-act="rz-go" data-view="tests">Faire le bilan oral et écrit</button></div>';
    var tile = function (k, label) {
      var list = h.filter(function (x) { return x[k]; });
      if (!list.length) return '';
      var last = list[list.length - 1][k], prev = list.length > 1 ? list[list.length - 2][k] : null;
      var spark = '';
      if (list.length > 1) {
        var W = 120, H = 30;
        var xs = function (i) { return 4 + i / (list.length - 1) * (W - 8); }, ys = function (v) { return 4 + (1 - v / 200) * (H - 8); };
        spark = '<svg class="rzp-spark" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true"><polyline points="' + list.map(function (x, i) { return px(xs(i)) + ',' + px(ys(x[k].score)); }).join(' ') + '"></polyline>'
          + '<circle cx="' + px(xs(list.length - 1)) + '" cy="' + px(ys(last.score)) + '" r="3.5"></circle></svg>';
      }
      return '<div class="rzp-tile is-small"' + tipAttr([last.score + ' / 200', label + ' · ' + plural(list.length, 'bilan'), 'marge ' + last.range[0] + '–' + last.range[1]]) + '><div class="rzp-tile-k">' + esc(label) + ' · 0-200</div>'
        + '<div class="rzp-tile-v">' + (k === 'W' && last.capped ? '≥ 150' : last.score) + (prev ? ' <span class="rzp-delta ' + (last.score >= prev.score ? 'is-up' : 'is-down') + '">' + signed(last.score - prev.score) + '</span>' : '') + '</div>'
        + '<div class="rzp-tile-sub">' + R.h.level(last.cefr) + '</div>' + spark + '</div>';
    };
    return '<div class="rzp-sw-row">' + tile('S', 'Oral') + tile('W', 'Écrit') + '</div>';
  }

  function scoreCardHtml() {
    var c = scoreChartHtml(), d = c.d;
    var h = ['<section class="rz-card rzp-card rzp-score"><div class="rz-card-head"><span class="rz-card-title">Score estimé façon TOEIC®</span>'
      + R.h.chips('rzp-series', ['T', 'L', 'R'], c.series, ['Total', 'Écoute', 'Lecture'], 'rz-prog-series') + '</div>'];
    if (!d.pts.length && !d.off.length) {
      h.push(R.h.empty('Faites votre premier bilan', 'Le bilan express (27 minutes) estime votre score d’écoute et de lecture sur l’échelle 10-990. Refait toutes les 2 à 4 semaines, il trace votre progression ici.',
        '<button type="button" class="btn btn-primary" data-act="rz-go" data-view="tests">Préparer un bilan</button>'));
      h.push(productiveRowHtml());
      h.push('</section>');
      return h.join('');
    }
    var last = d.pts[d.pts.length - 1], first = d.pts[0];
    var tr = d.now;
    h.push('<div class="rzp-score-top"><div class="rzp-hero"><div class="rzp-hero-k">Tendance actuelle · ' + esc(SERIES_NAME[c.series]) + '</div><div class="rzp-hero-v">'
      + (tr ? '≈ ' + tr.mean : (last ? last.score : '—')) + '<span> / ' + MAX[c.series] + '</span></div>'
      + '<div class="rzp-hero-sub">' + (tr ? 'marge à 90 % : ± ' + Math.round(1.645 * tr.sd) : '') + (last && first && last !== first ? ' · ' + signed(last.score - first.score) + ' depuis le premier bilan (' + short(first.at) + ')' : '') + '</div></div>'
      + '<div class="rzp-legend" aria-hidden="true"><span><i class="rzp-lg-band"></i>Tendance et sa marge (90 %)</span><span><i class="rzp-lg-pt"></i>Bilan express et son intervalle</span><span><i class="rzp-lg-off"></i>Score officiel</span></div></div>');
    h.push('<div class="rzp-chart">' + c.svg + '</div>');
    h.push(tableHtml('Bilans et scores officiels', ['Date', 'Type', 'Score', 'Intervalle à 90 %', 'Tendance'], d.pts.map(function (p) {
      return [longDate(p.at), 'Bilan express', String(p.score), p.ci.length === 2 ? p.ci[0] + '–' + p.ci[1] : '', p.trend ? '≈ ' + p.trend.mean + ' ± ' + Math.round(1.645 * p.trend.sd) : ''];
    }).concat(d.off.map(function (o) { return [longDate(o.at), 'Score officiel', String(o.score), '', o.detail]; }))));
    h.push('<div class="rz-card-foot">Un bilan isolé a une marge d’environ ± 150 points sur 990 : c’est la tendance de plusieurs bilans qui montre une progression. Entre deux bilans, la marge s’élargit.</div>');
    h.push(productiveRowHtml());
    h.push('<p class="rzp-mention">' + esc(MENTION) + '</p></section>');
    return h.join('');
  }

  /* ══ Niveau par compétence (petits multiples) ═══════════════════════════ */

  function levelsCardHtml() {
    var from = periodFrom(), to = Date.now();
    var cells = ['read', 'listen', 'write', 'speak', 'lang'].map(function (k) {
      var l = R.level(k);
      var hist = arr(l.hist).map(function (p) { return { at: dayMs(p[0]), t: num(p[1], 0) }; }).filter(function (p) { return isFinite(p.at); });
      var before = hist.filter(function (p) { return p.at < from; }).slice(-1)[0];
      var pts = hist.filter(function (p) { return p.at >= from; });
      if (before) pts.unshift({ at: from, t: before.t, carried: true });
      if (!pts.length) pts = [{ at: to, t: l.theta }];
      var W = 260, H = 110, ml = 26, mr = 8, mt = 6, mb = 18;
      var pw = W - ml - mr, ph = H - mt - mb;
      var lo = Math.min.apply(null, pts.map(function (p) { return p.t; }).concat([l.theta])), hi = Math.max.apply(null, pts.map(function (p) { return p.t; }).concat([l.theta]));
      var y0 = Math.max(-2.5, Math.floor(lo - 0.6) + 0.5), y1 = Math.min(3.5, Math.ceil(hi + 0.6) - 0.5);
      if (y1 - y0 < 2) { y1 = Math.min(3.5, y0 + 2); if (y1 - y0 < 2) y0 = y1 - 2; }
      var x = function (ms) { return ml + Math.max(0, Math.min(1, (ms - from) / Math.max(1, to - from))) * pw; };
      var y = function (t) { return mt + (1 - (t - y0) / (y1 - y0)) * ph; };
      var g = ['<svg class="rzp-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(LABEL[k] + ' : niveau dans le temps') + '">'];
      /* Bandes CECRL : chaque niveau couvre son centre ± 0,5. */
      ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].forEach(function (name, i) {
        var c = i - 2, a = Math.max(y0, c - 0.5), b = Math.min(y1, c + 0.5);
        if (b <= a) return;
        g.push('<rect class="rzp-cefr' + (i % 2 ? ' is-alt' : '') + '" x="' + ml + '" width="' + pw + '" y="' + px(y(b)) + '" height="' + px(y(a) - y(b)) + '"></rect>');
        if (y(a) - y(b) > 11) g.push('<text class="rzp-tick" x="' + (ml - 5) + '" y="' + px((y(a) + y(b)) / 2 + 4) + '" text-anchor="end">' + name + '</text>');
      });
      if (pts.length > 1) g.push('<polyline class="rzp-sk-line sk-' + k + '" points="' + pts.map(function (p) { return px(x(p.at)) + ',' + px(y(p.t)); }).join(' ') + '"></polyline>');
      var lp = pts[pts.length - 1];
      g.push('<circle class="rzp-sk-pt sk-' + k + '" cx="' + px(x(lp.at)) + '" cy="' + px(y(lp.t)) + '" r="4.5"></circle>');
      g.push('<text class="rzp-tick" x="' + ml + '" y="' + (H - 4) + '">' + esc(short(from)) + '</text><text class="rzp-tick" x="' + (W - mr) + '" y="' + (H - 4) + '" text-anchor="end">aujourd’hui</text>');
      pts.filter(function (p) { return !p.carried; }).forEach(function (p) {
        g.push('<circle class="rzp-hitpt"' + tipAttr([R.band(p.t), LABEL[k] + ' · ' + longDate(p.at)]) + ' cx="' + px(x(p.at)) + '" cy="' + px(y(p.t)) + '" r="9"></circle>');
      });
      g.push('</svg>');
      var first = pts[0];
      var move = pts.length > 1 ? lp.t - first.t : 0;
      var moveTxt = pts.length > 1 ? (Math.abs(move) < 0.1 ? 'stable' : (move > 0 ? '↗ en hausse' : '↘ en baisse')) : 'une seule mesure';
      return { k: k, html: '<div class="rzp-sm"><div class="rzp-sm-head">' + R.h.skill(k) + R.h.level(l.band) + '</div>' + g.join('')
        + '<div class="rzp-sm-foot"><span>' + esc(moveTxt) + '</span><span>' + esc('confiance ' + l.conf + (l.n ? ' · ' + plural(l.n, 'mesure') : '')) + '</span></div></div>', l: l, pts: pts };
    });
    var rows = [];
    cells.forEach(function (c) { c.pts.filter(function (p) { return !p.carried; }).forEach(function (p) { rows.push([LABEL[c.k], longDate(p.at), R.band(p.t), f1(p.t)]); }); });
    return '<section class="rz-card rzp-card rzp-levels"><div class="rz-card-head"><span class="rz-card-title">Niveau par compétence</span><span class="rz-card-meta">bandes CECRL en fond</span></div>'
      + '<div class="rzp-sm-grid">' + cells.map(function (c) { return c.html; }).join('') + '</div>'
      + tableHtml('Niveau estimé par compétence', ['Compétence', 'Date', 'Niveau', 'Theta'], rows)
      + '<div class="rz-card-foot">Estimé au fil des exercices (pondérés par leur niveau), recalé par les bilans. Un niveau CECRL se gagne en mois, pas en jours : regardez la pente sur plusieurs semaines.</div></section>';
  }

  /* ══ Minutes par semaine (barres empilées) ══════════════════════════════ */

  function weeksData(n) {
    var start = R.weekStart(Date.now()) - (n - 1) * 7 * DAY;
    var out = [];
    for (var i = 0; i < n; i++) {
      var w = R.week(start + i * 7 * DAY + DAY);
      var by = { read: w.bySkill.read, listen: w.bySkill.listen, write: w.bySkill.write, speak: w.bySkill.speak, lang: w.bySkill.lang + w.bySkill.srs };
      var sum = ORDER.reduce(function (a, k) { return a + by[k]; }, 0);
      by.other = Math.max(0, w.minutes - sum);
      out.push({ from: w.from, by: by, minutes: Math.max(w.minutes, sum), done: w.done, goal: w.goal });
    }
    return out;
  }

  function minutesCardHtml() {
    var n = U.period === 30 ? 6 : (U.period === 'all' ? 26 : (U.period === 180 ? 26 : 12));
    var weeks = weeksData(n);
    var goalMin = R.profile.weeklyGoal * R.profile.defaultMinutes;
    var total = weeks.reduce(function (a, w) { return a + w.minutes; }, 0);
    var h = ['<section class="rz-card rzp-card rzp-minutes"><div class="rz-card-head"><span class="rz-card-title">Minutes par semaine</span><span class="rz-card-meta">' + esc(n + ' semaines · ' + fmtH(total)) + '</span></div>'];
    if (!total) {
      h.push(R.h.empty('Pas encore de séance', 'Chaque cours, série d’exercices, révision ou conversation avec le tuteur s’ajoute ici, par compétence.', '<button type="button" class="btn btn-primary" data-act="rz-go" data-view="home">Commencer une séance</button>'));
      return h.join('') + '</section>';
    }
    var W = 720, H = 220, ml = 40, mr = 10, mt = 12, mb = 26;
    var pw = W - ml - mr, ph = H - mt - mb;
    var maxV = Math.max(goalMin * 1.15, Math.max.apply(null, weeks.map(function (w) { return w.minutes; })) * 1.08, 30);
    var step = maxV > 400 ? 120 : (maxV > 200 ? 60 : 30);
    var y = function (v) { return mt + (1 - v / maxV) * ph; };
    var slot = pw / n, bw = Math.min(24, slot * 0.62);
    var g = ['<svg class="rzp-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Minutes par semaine et par compétence">'];
    for (var v = 0; v <= maxV; v += step) {
      g.push('<line class="rzp-grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + px(y(v)) + '" y2="' + px(y(v)) + '"></line><text class="rzp-tick" x="' + (ml - 6) + '" y="' + px(y(v) + 4) + '" text-anchor="end">' + (v >= 60 && v % 60 === 0 ? (v / 60) + ' h' : v) + '</text>');
    }
    weeks.forEach(function (w, i) {
      var cx = ml + slot * i + slot / 2, x0 = px(cx - bw / 2);
      var acc = 0;
      var segs = ORDER.concat(['other']).filter(function (k) { return w.by[k] > 0.05; });
      segs.forEach(function (k, si) {
        var v0 = acc, v1 = acc + w.by[k];
        acc = v1;
        var top = y(v1), bot = y(v0);
        var gap = si > 0 ? 2 : 0, isTop = si === segs.length - 1;
        var hgt = Math.max(0.5, bot - top - gap);
        if (isTop) {
          var r = Math.min(4, hgt, bw / 2);
          g.push('<path class="rzp-seg sk-' + k + '" d="M' + x0 + ' ' + px(bot - gap) + 'V' + px(top + r) + 'Q' + x0 + ' ' + px(top) + ' ' + px(+x0 + r) + ' ' + px(top) + 'H' + px(+x0 + bw - r) + 'Q' + px(+x0 + bw) + ' ' + px(top) + ' ' + px(+x0 + bw) + ' ' + px(top + r) + 'V' + px(bot - gap) + 'Z"></path>');
        } else {
          g.push('<rect class="rzp-seg sk-' + k + '" x="' + x0 + '" y="' + px(top) + '" width="' + px(bw) + '" height="' + px(hgt) + '"></rect>');
        }
      });
      var label = (i % (n > 13 ? 4 : 2) === 0 || i === n - 1) ? short(w.from) : '';
      if (label) g.push('<text class="rzp-tick" x="' + px(cx) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(i === n - 1 ? 'cette sem.' : label) + '</text>');
      var lines = [fmtH(w.minutes) + ' · ' + w.done + ' séance' + (w.done > 1 ? 's' : '') + ' sur ' + w.goal, 'Semaine du ' + longDate(w.from)];
      ORDER.concat(['other']).forEach(function (k) { if (w.by[k] > 0.05) lines.push(LABEL[k] + ' : ' + fmtH(w.by[k])); });
      g.push('<g class="rzp-hit"' + tipAttr(lines) + '><rect x="' + px(ml + slot * i) + '" y="' + mt + '" width="' + px(slot) + '" height="' + ph + '"></rect></g>');
      if (w.done >= w.goal) g.push('<circle class="rzp-goal-dot" cx="' + px(cx) + '" cy="' + px(Math.min(y(w.minutes) - 8, mt + ph - 4)) + '" r="3"></circle>');
    });
    g.push('<line class="rzp-goal" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + px(y(goalMin)) + '" y2="' + px(y(goalMin)) + '"></line>'
      + '<text class="rzp-goal-t" x="' + (W - mr - 2) + '" y="' + px(y(goalMin) - 5) + '" text-anchor="end">' + esc('repère : ' + R.profile.weeklyGoal + ' × ' + R.profile.defaultMinutes + ' min') + '</text>');
    g.push('<line class="rzp-axis" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + (mt + ph) + '" y2="' + (mt + ph) + '"></line></svg>');
    var reached = weeks.filter(function (w) { return w.done >= w.goal; }).length;
    var legend = '<div class="rzp-legend">' + ORDER.map(function (k) { return '<span><i class="rzp-sw sk-' + k + '"></i>' + esc(LABEL[k]) + '</span>'; }).join('')
      + (weeks.some(function (w) { return w.by.other > 0.05; }) ? '<span><i class="rzp-sw sk-other"></i>' + esc(LABEL.other) + '</span>' : '')
      + '<span><i class="rzp-lg-goal"></i>Objectif atteint</span></div>';
    h.push(legend + '<div class="rzp-chart">' + g.join('') + '</div>');
    h.push(tableHtml('Minutes par semaine', ['Semaine du', 'Total', 'Séances'].concat(ORDER.map(function (k) { return LABEL[k]; })), weeks.map(function (w) {
      return [short(w.from), fmtH(w.minutes), w.done + ' / ' + w.goal].concat(ORDER.map(function (k) { return fmtH(w.by[k]); }));
    })));
    h.push('<div class="rz-card-foot">Objectif de la semaine atteint ' + reached + ' fois sur ' + n + ' (' + R.profile.weeklyGoal + ' séances de 5 minutes ou plus). Mieux vaut 10 minutes que rien : c’est la régularité qui fait la mémoire.</div></section>');
    return h.join('');
  }

  /* ══ Régularité : 12 semaines × 7 jours ═════════════════════════════════ */

  function regularityCardHtml() {
    var byDay = {};
    arr(R.data.sessions).forEach(function (s) { var k = dayKey(s.startedAt); byDay[k] = (byDay[k] || 0) + num(s.minutes, 0); });
    var start = R.weekStart(Date.now()) - 11 * 7 * DAY;
    var today = dayKey(Date.now());
    var cw = 16, gap = 3, ml = 26, mt = 16;
    var W = ml + 12 * (cw + gap), H = mt + 7 * (cw + gap) + 2;
    var g = ['<svg class="rzp-svg rzp-heat-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Jours actifs sur 12 semaines">'];
    ['L', 'M', 'M', 'J', 'V', 'S', 'D'].forEach(function (d, i) { if (i % 2 === 0) g.push('<text class="rzp-tick" x="' + (ml - 6) + '" y="' + (mt + i * (cw + gap) + 12) + '" text-anchor="end">' + d + '</text>'); });
    var active = 0, rows = [], future = false;
    for (var wk = 0; wk < 12; wk++) {
      var ws = start + wk * 7 * DAY;
      if (wk % 3 === 0) g.push('<text class="rzp-tick" x="' + (ml + wk * (cw + gap)) + '" y="10">' + esc(short(ws + 3 * 3600000)) + '</text>');
      for (var d = 0; d < 7; d++) {
        var ms = ws + d * DAY + 12 * 3600000;
        var k = dayKey(ms);
        future = k > today;
        var m = byDay[k] || 0;
        if (m >= 5) active++;
        var lvl = future ? 'f' : (m <= 0 ? 0 : (m < 10 ? 1 : (m < 20 ? 2 : (m < 40 ? 3 : 4))));
        var tip = future ? '' : tipAttr([m ? fmtH(m) : 'aucune séance', new Date(ms).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })]);
        g.push('<rect class="rzp-cell l' + lvl + (k === today ? ' is-today' : '') + '"' + tip + ' x="' + (ml + wk * (cw + gap)) + '" y="' + (mt + d * (cw + gap)) + '" width="' + cw + '" height="' + cw + '" rx="3"></rect>');
        if (!future && m) rows.push([longDate(ms), fmtH(m)]);
      }
    }
    g.push('</svg>');
    var w = R.week();
    var scale = '<div class="rzp-heat-scale" aria-hidden="true"><span>moins</span>' + [0, 1, 2, 3, 4].map(function (l) { return '<i class="rzp-cell-sw l' + l + '"></i>'; }).join('') + '<span>plus</span></div>';
    return '<section class="rz-card rzp-card rzp-heat"><div class="rz-card-head"><span class="rz-card-title">Régularité</span><span class="rz-card-meta">12 semaines</span></div>'
      + '<div class="rzp-heat-body"><div class="rzp-chart is-heat">' + g.join('') + '</div><div class="rzp-heat-stats">'
      + '<div class="rzp-tile is-small"><div class="rzp-tile-k">Jours actifs</div><div class="rzp-tile-v">' + active + '<span> / 84</span></div></div>'
      + '<div class="rzp-tile is-small"><div class="rzp-tile-k">Cette semaine</div><div class="rzp-tile-v">' + w.done + '<span> / ' + w.goal + ' séances</span></div></div>'
      + scale + '</div></div>'
      + tableHtml('Minutes par jour', ['Jour', 'Minutes'], rows)
      + '<div class="rz-card-foot">Pas de série à ne pas briser : l’objectif est hebdomadaire. Une semaine manquée n’efface rien, la suivante repart.</div></section>';
  }

  /* ══ Révisions (cartes FSRS) ════════════════════════════════════════════ */

  function reviewsCardHtml() {
    var cards = arr(R.data.cards), log = arr(R.data.reviewLog);
    var h = ['<section class="rz-card rzp-card rzp-reviews"><div class="rz-card-head"><span class="rz-card-title">Révisions</span><span class="rz-card-meta">répétition espacée</span></div>'];
    if (!cards.length) {
      h.push(R.h.empty('Pas encore de cartes', 'Les mots, tournures et erreurs à retenir arrivent avec les cours et les corrections ; ils reviennent ensuite au bon moment.'));
      return h.join('') + '</section>';
    }
    var stab = function (c) { var f = c && c.fsrs || {}; return num(f.S != null ? f.S : f.stability, 0); };
    var state = function (c) { return String((c && c.fsrs && c.fsrs.state) || 'new'); };
    var mature = cards.filter(function (c) { return stab(c) >= 21; }).length;
    var learning = cards.filter(function (c) { var s = state(c); return s === 'learning' || s === 'relearning'; }).length;
    var fresh = cards.filter(function (c) { return state(c) === 'new'; }).length;
    var since = Date.now() - 30 * DAY;
    var seen = {}, recall = 0, nRev = 0;
    var sorted = log.slice().sort(function (a, b) { return num(a.at, 0) - num(b.at, 0); });
    var perDay = {};
    sorted.forEach(function (r) {
      var first = !seen[r.c];
      seen[r.c] = true;
      if (num(r.at, 0) < since) return;
      var k = dayKey(r.at);
      perDay[k] = (perDay[k] || 0) + 1;
      if (first) return;
      nRev++;
      if (num(r.g, 0) > 1) recall++;
    });
    var target = num(R.prefs.retention, 0.9);
    var ret = nRev >= 20 ? recall / nRev : null;
    h.push('<div class="rzp-tiles">'
      + '<div class="rzp-tile"><div class="rzp-tile-k">Cartes</div><div class="rzp-tile-v">' + cards.length + '</div><div class="rzp-tile-sub">' + fresh + ' nouvelles · ' + learning + ' en apprentissage</div></div>'
      + '<div class="rzp-tile"><div class="rzp-tile-k">Mûres</div><div class="rzp-tile-v">' + mature + '</div><div class="rzp-tile-sub">retenues 3 semaines et plus</div></div>'
      + '<div class="rzp-tile"><div class="rzp-tile-k">Rétention réelle</div><div class="rzp-tile-v">' + (ret == null ? '—' : Math.round(ret * 100) + ' %') + '</div>'
      + '<div class="rzp-meter" title="' + esc('objectif ' + Math.round(target * 100) + ' %') + '"><i style="width:' + ((ret == null ? 0 : ret) * 100).toFixed(1) + '%" class="' + (ret != null && ret < target - 0.05 ? 'is-low' : '') + '"></i><b style="left:' + (target * 100).toFixed(1) + '%"></b></div>'
      + '<div class="rzp-tile-sub">' + (ret == null ? 'il faut une vingtaine de révisions' : '30 jours · objectif ' + Math.round(target * 100) + ' % · ' + plural(nRev, 'révision')) + '</div></div></div>');
    var W = 720, H = 70, ml = 4, mr = 4, mt = 6, mb = 16;
    var days = [];
    for (var i = 29; i >= 0; i--) days.push(dayKey(Date.now() - i * DAY));
    var maxV = Math.max(5, Math.max.apply(null, days.map(function (k) { return perDay[k] || 0; })));
    var slot = (W - ml - mr) / 30, bw = Math.min(14, slot * 0.66);
    var g = ['<svg class="rzp-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Révisions par jour sur 30 jours">'];
    days.forEach(function (k, j) {
      var v = perDay[k] || 0, hh = v / maxV * (H - mt - mb);
      var x0 = ml + slot * j + (slot - bw) / 2;
      if (v) g.push('<rect class="rzp-rev-bar" x="' + px(x0) + '" y="' + px(H - mb - hh) + '" width="' + px(bw) + '" height="' + px(Math.max(1, hh)) + '" rx="2"></rect>');
      g.push('<g class="rzp-hit"' + tipAttr([plural(v, 'révision'), longDate(dayMs(k))]) + '><rect x="' + px(ml + slot * j) + '" y="0" width="' + px(slot) + '" height="' + H + '"></rect></g>');
    });
    g.push('<line class="rzp-axis" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + (H - mb) + '" y2="' + (H - mb) + '"></line>'
      + '<text class="rzp-tick" x="' + ml + '" y="' + (H - 3) + '">' + esc(short(dayMs(days[0]))) + '</text><text class="rzp-tick" x="' + (W - mr) + '" y="' + (H - 3) + '" text-anchor="end">aujourd’hui</text></svg>');
    h.push('<div class="rzp-sub-k">Révisions par jour · 30 jours</div><div class="rzp-chart">' + g.join('') + '</div>');
    h.push(tableHtml('Révisions par jour', ['Jour', 'Révisions'], days.filter(function (k) { return perDay[k]; }).map(function (k) { return [longDate(dayMs(k)), String(perDay[k])]; })));
    h.push('<div class="rz-card-foot">Rétention réelle : part des cartes retrouvées (Difficile, Bien ou Facile) parmi les révisions de cartes déjà vues. Bien au-dessous de l’objectif ? Des cartes trop dures ou trop nombreuses : mieux vaut en suspendre.</div></section>');
    return h.join('');
  }

  /* ══ Points faibles ═════════════════════════════════════════════════════ */

  function weakCardHtml() {
    var list = R.weakPoints(8);
    var h = ['<section class="rz-card rzp-card rzp-weak"><div class="rz-card-head"><span class="rz-card-title">Points faibles</span><span class="rz-card-meta">du plus actif au moins actif</span></div>'];
    if (!list.length) {
      h.push(R.h.empty('Aucune erreur relevée', 'Les corrections de vos écrits et de votre oral alimentent ce journal : il montre ce qui revient, et ce qui recule.'));
      return h.join('') + '</section>';
    }
    var now = Date.now();
    var max = Math.max.apply(null, list.map(function (w) { return w.count; }));
    h.push('<ol class="rzp-weak-list">' + list.map(function (w) {
      var recent = arr(w.examples).filter(function (e) { return num(e.at, 0) > now - 14 * DAY; }).length;
      var age = (now - num(w.lastSeen, now)) / DAY;
      var trend = recent >= 2 ? { t: 'fréquente ces jours-ci', c: 'is-up', a: '↗' } : (age > 21 ? { t: 'en recul', c: 'is-down', a: '↘' } : { t: 'stable', c: '', a: '→' });
      var ex = arr(w.examples)[0];
      return '<li class="rzp-weak-item"' + tipAttr([plural(w.count, 'occurrence'), w.label, 'vue pour la dernière fois le ' + longDate(w.lastSeen)]) + '><div class="rzp-weak-top"><span class="rzp-weak-label">' + esc(w.label) + '</span>'
        + '<span class="rzp-weak-trend ' + trend.c + '">' + trend.a + ' ' + esc(trend.t) + '</span><span class="rzp-weak-n">' + w.count + '</span></div>'
        + '<span class="rzp-weak-bar"><i style="width:' + (w.count / max * 100).toFixed(1) + '%"></i></span>'
        + (ex ? '<div class="rzp-weak-ex" lang="en"><span class="rz-fb-orig">' + esc(ex.original) + '</span>' + R.icon('arrow') + '<span class="rz-fb-corr">' + esc(ex.correction) + '</span></div>' : '') + '</li>';
    }).join('') + '</ol>');
    h.push('<div class="rzp-actions"><button type="button" class="btn btn-secondary" data-act="rz-go" data-view="exercises">S’exercer sur ces points ' + R.icon('arrow') + '</button></div></section>');
    return h.join('');
  }

  /* ══ Oral récent et capsules avant/après ════════════════════════════════ */

  function speakCardHtml() {
    var att = arr(R.data.attempts).filter(function (a) { return a && a.mode === 'speak' && a.metrics && num(a.metrics.wpm, 0) > 0; }).sort(function (a, b) { return a.at - b.at; });
    var h = ['<section class="rz-card rzp-card rzp-speak"><div class="rz-card-head"><span class="rz-card-title">Oral</span><span class="rz-card-meta">débit et réécoute</span></div>'];
    if (att.length) {
      var last = att.slice(-20);
      var W = 360, H = 120, ml = 58, mr = 10, mt = 8, mb = 10;
      var maxV = Math.max(150, Math.max.apply(null, last.map(function (a) { return a.metrics.wpm; })) + 10);
      var minV = Math.min(50, Math.min.apply(null, last.map(function (a) { return a.metrics.wpm; })) - 10);
      var x = function (i) { return ml + (last.length > 1 ? i / (last.length - 1) : 0.5) * (W - ml - mr); };
      var y = function (v) { return mt + (1 - (v - minV) / (maxV - minV)) * (H - mt - mb); };
      var g = ['<svg class="rzp-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Débit des dernières réponses orales">'];
      [[95, 'B1'], [120, 'B2']].forEach(function (r) { g.push('<line class="rzp-grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + px(y(r[0])) + '" y2="' + px(y(r[0])) + '"></line><text class="rzp-cut" x="' + (ml - 32) + '" y="' + px(y(r[0]) + 4) + '" text-anchor="end">' + r[1] + '</text><text class="rzp-tick" x="' + (ml - 4) + '" y="' + px(y(r[0]) + 4) + '" text-anchor="end">' + r[0] + '</text>'); });
      if (last.length > 1) g.push('<polyline class="rzp-wpm" points="' + last.map(function (a, i) { return px(x(i)) + ',' + px(y(a.metrics.wpm)); }).join(' ') + '"></polyline>');
      last.forEach(function (a, i) { g.push('<circle class="rzp-wpm-pt"' + tipAttr([a.metrics.wpm + ' mots/min', (a.task || 'Réponse orale') + ' · ' + longDate(a.at), plural(num(a.metrics.pauses, 0), 'pause')]) + ' cx="' + px(x(i)) + '" cy="' + px(y(a.metrics.wpm)) + '" r="' + (i === last.length - 1 ? 5 : 3.5) + '"></circle>'); });
      g.push('<line class="rzp-axis" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + (H - mb) + '" y2="' + (H - mb) + '"></line></svg>');
      var avg = function (l) { return Math.round(l.reduce(function (s, a) { return s + a.metrics.wpm; }, 0) / l.length); };
      var recentAvg = avg(att.slice(-5)), firstAvg = att.length >= 8 ? avg(att.slice(0, 5)) : null;
      h.push('<div class="rzp-speak-top"><div class="rzp-tile is-small"><div class="rzp-tile-k">Débit récent</div><div class="rzp-tile-v">' + recentAvg + '<span> mots/min</span></div>'
        + (firstAvg ? '<div class="rzp-tile-sub">' + signed(recentAvg - firstAvg) + ' depuis vos débuts</div>' : '') + '</div><div class="rzp-chart">' + g.join('') + '</div></div>');
      h.push('<ul class="rzp-att">' + att.slice(-5).reverse().map(function (a) {
        var key = 'rzp-att-' + a.id;
        return '<li><div class="rzp-att-head"><span class="rzp-att-task">' + esc(a.task || 'Réponse orale') + '</span><span class="rz-muted">' + esc(short(a.at)) + ' · ' + a.metrics.wpm + ' mots/min · ' + plural(num(a.metrics.pauses, 0), 'pause') + '</span></div>'
          + (a.url ? R.h.player(key, { label: 'Réécouter', small: true, speeds: false, source: function () { return R.audio(a.url, { key: key }); } }) : '')
          + (a.response ? '<div class="rzp-att-text" lang="en">' + esc(String(a.response).slice(0, 220)) + (String(a.response).length > 220 ? '…' : '') + '</div>' : '') + '</li>';
      }).join('') + '</ul>');
      h.push(tableHtml('Réponses orales', ['Date', 'Tâche', 'Débit (mots/min)', 'Pauses'], att.slice(-20).map(function (a) { return [longDate(a.at), a.task || '', String(a.metrics.wpm), String(num(a.metrics.pauses, 0))]; })));
      h.push('<div class="rz-card-foot">Repères de débit (mots par minute, d’après Tavakoli et al., 2020) : B1 ≈ 95, B2 ≈ 120. Au-delà de B2, la fluidité ne départage plus : c’est la justesse et la variété qui progressent.</div>');
    } else {
      h.push(R.h.empty('Pas encore de réponse orale', 'Les tâches orales des cours, des exercices et des bilans s’ajoutent ici, avec leur débit et l’enregistrement à réécouter.'));
    }
    h.push(capsuleHtml());
    h.push('</section>');
    return h.join('');
  }

  function capsuleHtml() {
    var caps = arr(R.data.capsules).filter(function (c) { return c && c.at; }).sort(function (a, b) { return a.at - b.at; });
    var h = ['<div class="rzp-caps"><div class="rzp-sub-k">' + R.icon('mic') + ' Capsule avant / après</div>'];
    var lastAt = caps.length ? caps[caps.length - 1].at : 0;
    var due = !caps.length || Date.now() - lastAt > 60 * DAY;
    var item = function (c, label) {
      var key = 'rzp-cap-' + c.id;
      var m = c.metrics || {};
      return '<div class="rzp-cap"><div class="rzp-cap-k">' + esc(label) + ' · ' + esc(longDate(c.at)) + '</div>'
        + (c.url ? R.h.player(key, { label: 'Écouter', small: true, speeds: false, source: function () { return R.audio(c.url, { key: key }); } }) : '<span class="rz-muted">enregistrement indisponible</span>')
        + (m.wpm ? '<div class="rz-muted">' + m.wpm + ' mots/min · ' + plural(num(m.pauses, 0), 'pause') + '</div>' : '') + '</div>';
    };
    if (caps.length >= 2) h.push('<div class="rzp-cap-pair">' + item(caps[0], 'Avant') + item(caps[caps.length - 1], 'Aujourd’hui') + '</div>');
    else if (caps.length === 1) h.push('<div class="rzp-cap-pair">' + item(caps[0], 'Première capsule') + '</div>');
    /* L'enregistrement se fait dans le tuteur (module U3, écran « capsule ») : ici, on montre et on y renvoie. */
    if (due) {
      h.push('<div class="rzp-cap-new"><p>' + esc(caps.length ? 'Il est temps de réenregistrer la même consigne : vous l’écouterez à côté de la précédente.' : 'Enregistrez-vous une minute sur une consigne fixe ; dans deux ou trois mois, vous referez la même et écouterez la différence.') + '</p>'
        + (caps.length && caps[0].prompt ? '<div class="rzp-cap-prompt" lang="en">' + esc(caps[0].prompt) + '</div>' : '')
        + '<button type="button" class="btn btn-primary" data-act="rz-tutor-capsule">' + R.icon('mic') + ' ' + esc(caps.length ? 'Enregistrer la nouvelle capsule' : 'Enregistrer ma première capsule') + '</button></div>');
    } else {
      h.push('<div class="rz-card-foot">Prochaine capsule conseillée à partir du ' + esc(longDate(lastAt + 60 * DAY)) + '. <button type="button" class="btn btn-ghost rzp-link" data-act="rz-tutor-capsule">Voir et comparer</button></div>');
    }
    return h.join('') + '</div>';
  }

  /* ══ Temps passé et repère des 200 heures ═══════════════════════════════ */

  function timeCardHtml() {
    var ss = arr(R.data.sessions);
    var total = ss.reduce(function (a, s) { return a + num(s.minutes, 0); }, 0);
    var since = Date.now() - 56 * DAY;
    var recent = ss.filter(function (s) { return s.startedAt >= since; }).reduce(function (a, s) { return a + num(s.minutes, 0); }, 0);
    var perWeek = recent / 8;
    var ratio = Math.min(1, total / (200 * 60));
    var yearsPerLevel = perWeek > 5 ? 200 * 60 / perWeek / 52 : null;
    return '<section class="rz-card rzp-card rzp-time"><div class="rz-card-head"><span class="rz-card-title">Temps passé</span></div>'
      + '<div class="rzp-tiles"><div class="rzp-tile"><div class="rzp-tile-k">Au total</div><div class="rzp-tile-v">' + esc(fmtH(total)) + '</div><div class="rzp-tile-sub">' + plural(ss.length, 'séance') + '</div></div>'
      + '<div class="rzp-tile"><div class="rzp-tile-k">Rythme · 8 semaines</div><div class="rzp-tile-v">' + esc(fmtH(perWeek)) + '<span> / semaine</span></div></div></div>'
      + '<div class="rzp-200"><div class="rzp-200-head"><span>Repère : environ 200 heures de travail guidé par niveau</span><b>' + Math.round(ratio * 100) + ' %</b></div>'
      + R.h.progress(ratio, 'Part des 200 heures', 'is-good')
      + '<p>' + esc('Il faut compter environ 200 heures de travail guidé pour passer d’un niveau CECRL au suivant (B1 → B2, par exemple). '
        + (yearsPerLevel ? 'À votre rythme actuel, cela représente environ ' + (yearsPerLevel < 1 ? Math.round(yearsPerLevel * 12) + ' mois' : f1(yearsPerLevel) + ' an' + (yearsPerLevel >= 2 ? 's' : '')) + ' par niveau. ' : '')
        + 'L’exposition libre — séries, lectures, travail en anglais — accélère beaucoup les choses.') + '</p></div></section>';
  }

  /* ══ Vue ════════════════════════════════════════════════════════════════ */

  function renderProgress() {
    var ss = arr(R.data.sessions);
    var total = ss.reduce(function (a, s) { return a + num(s.minutes, 0); }, 0);
    var active = {};
    ss.forEach(function (s) { if (num(s.minutes, 0) >= 5 && s.startedAt > Date.now() - 84 * DAY) active[dayKey(s.startedAt)] = 1; });
    var h = [];
    h.push('<div class="rzp-head"><div><div class="rz-kicker">' + R.icon('chart') + ' Progrès</div><h2 class="rz-section-title">Vos progrès</h2>'
      + '<div class="rz-sub">' + esc(ss.length ? fmtH(total) + ' de travail, ' + plural(ss.length, 'séance') + ', ' + plural(Object.keys(active).length, 'jour actif', 'jours actifs') + ' sur 12 semaines.' : 'Tout commence à la première séance : vos courbes se dessineront ici.') + '</div></div>'
      + '<div class="rzp-filter"><span class="rzp-filter-k">Période</span>' + R.h.chips('rzp-period', ['30', '90', '180', 'all'], String(U.period), ['1 mois', '3 mois', '6 mois', 'Tout'], 'rz-prog-period') + '</div></div>');
    if (!ss.length && !arr(R.data.toeic && R.data.toeic.history).length) {
      h.push('<div class="rz-callout is-accent rzp-start">Pour commencer : un <b>bilan express</b> situe votre niveau (27 minutes), puis le <b>cours du jour</b> fait travailler les quatre compétences. '
        + '<button type="button" class="btn btn-primary" data-act="rz-go" data-view="tests">Faire mon premier bilan</button></div>');
    }
    h.push(scoreCardHtml());
    h.push('<div class="rzp-grid">' + levelsCardHtml() + minutesCardHtml() + '</div>');
    h.push('<div class="rzp-grid3">' + regularityCardHtml() + reviewsCardHtml() + timeCardHtml() + '</div>');
    h.push('<div class="rzp-grid">' + weakCardHtml() + speakCardHtml() + '</div>');
    return h.join('');
  }

  R.act('rz-prog-period', function (el) { var v = el.getAttribute('data-value'); U.period = v === 'all' ? 'all' : +v; R.render(); });
  R.act('rz-prog-series', function (el) { U.series = el.getAttribute('data-value'); R.render(); });

  /* ── Info-bulle commune (survol et clavier) : texte posé par textContent ── */
  var tipEl = null;
  function tipShow(target, cx, cy) {
    var txt = target.getAttribute('data-rzp-tip');
    if (!txt) return;
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'rzp-tip'; tipEl.setAttribute('role', 'tooltip'); document.body.appendChild(tipEl); }
    while (tipEl.firstChild) tipEl.removeChild(tipEl.firstChild);
    txt.split('\n').forEach(function (line, i) { var d = document.createElement(i === 0 ? 'strong' : 'div'); d.textContent = line; tipEl.appendChild(d); });
    tipEl.style.display = 'block';
    var r = tipEl.getBoundingClientRect();
    var x = cx + 14, y = cy + 14;
    if (x + r.width > window.innerWidth - 8) x = cx - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = cy - r.height - 14;
    tipEl.style.left = Math.max(8, x) + 'px';
    tipEl.style.top = Math.max(8, y) + 'px';
  }
  function tipHide() { if (tipEl) tipEl.style.display = 'none'; }
  function tipTarget(e) { var t = e.target; return t && t.closest ? t.closest('[data-rzp-tip]') : null; }
  document.addEventListener('pointermove', function (e) { var t = tipTarget(e); if (t) tipShow(t, e.clientX, e.clientY); else tipHide(); }, { passive: true });
  document.addEventListener('focusin', function (e) {
    var t = tipTarget(e);
    if (!t) { tipHide(); return; }
    var r = t.getBoundingClientRect();
    tipShow(t, r.left + r.width / 2, r.top);
  });
  document.addEventListener('focusout', tipHide);
  window.addEventListener('scroll', tipHide, { passive: true });

  R.view('progress', {
    label: 'Progrès', icon: 'chart', order: 50, title: 'Progrès — score estimé, niveaux, régularité',
    render: renderProgress,
    onHide: tipHide
  });
})();
