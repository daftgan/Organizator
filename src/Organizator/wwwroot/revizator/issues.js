/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — signaler un problème ou une idée (vue « issue »)
   Tout compte du serveur Révizator écrit ses signalements ici ; le serveur les garde (issues.json). Seul un
   administrateur les lance vers Claude Code, dans le cloud : une routine ouvre une session sur le dépôt
   d'Organizator, qui corrige ou ajoute ce qui est demandé et propose une pull request (rien n'est fusionné
   sans relecture). Les signalements de l'administrateur partent dès l'envoi ; ceux des autres comptes
   attendent qu'il les lise, puis les lance ou les écarte. Le serveur y joint le compte, sa version et son
   commit ; la page y ajoute la vue d'où l'on vient, sa propre version et l'appareil.
   Messages : issueStatus, issueSend ({ ref, title, text, view, page, device }), issueLaunch ({ id }),
   issueRemove ({ id }) — le serveur vérifie le droit d'administrer à chaque message.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R) return;
  var esc = R.esc;
  var U = R.ui.issue = R.ui.issue || { status: null, loading: false, error: '', title: '', text: '', ref: '', busy: '', sent: null, from: '', open: {}, remove: '' };

  function bridge() { return window.bridge; }
  function onServer() { var b = bridge(); return !!(b && (b.mode === 'server' || (b.remote && b.remote()) || b.isShim)); }
  function call(type, payload, ms) { return bridge().call(type, payload || {}, ms || 30000); }
  function admin() { return !!(U.status && U.status.admin); }
  function canLaunch() { return !!(U.status && U.status.canLaunch); }
  function max() { return (U.status && U.status.max) || 8000; }
  function fail(what) { return function (e) { U.busy = ''; R.toast(what + ' : ' + ((e && e.message) || 'échec')); R.render(); }; }

  function load() {
    if (!onServer() || U.loading) return;
    U.loading = true;
    call('issueStatus').then(function (s) { U.status = s || null; U.error = ''; },
      function (e) { U.error = (e && e.message) || 'indisponible'; /* serveur plus ancien : pas de vue */ })
      .then(function () { U.loading = false; R.render(); });
  }

  /* La vue d'où l'on vient (jointe au signalement) : celle qui était affichée quand on ouvre « Signaler ». */
  var current = '';
  R.on('loaded', function () { if (!current) current = R.viewId(); load(); });
  R.on('view', function (id) {
    if (id === 'issue' && current && current !== 'issue') U.from = current;
    current = id || '';
  });
  if (bridge() && bridge().on) bridge().on('remoteChanged', function () { U.status = null; U.sent = null; U.open = {}; });

  function when(ms) {
    var d = new Date(ms);
    return !ms || isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' · ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  function link(url, label) {
    return url ? '<a class="rzi-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>' : '';
  }

  /* ══ Rendu ══════════════════════════════════════════════════════════════ */

  function render() {
    var h = ['<div class="rzp-head"><div><div class="rz-kicker">' + R.icon('pen') + ' Signaler</div><h2 class="rz-section-title">Un problème, une idée ?</h2>'
      + '<div class="rz-sub">' + esc(!U.status || admin()
        ? 'Décrivez-le ici. Vos signalements partent à Claude Code, dans le cloud, qui travaille sur le code d’Organizator et propose une correction (pull request) ; ceux des autres comptes vous attendent ici.'
        : 'Décrivez-le ici : l’administrateur du serveur le lit et le confie à Claude Code, qui propose une correction.') + '</div></div>'
      + '<div class="rzp-filter"><button type="button" class="btn btn-ghost" data-act="rz-issue-refresh"' + (U.loading ? ' disabled' : '') + '>' + (U.loading ? 'Lecture…' : 'Actualiser') + '</button></div></div>'];
    if (!U.status) {
      if (!U.loading && !U.error) load();
      h.push(U.error ? '<div class="rz-callout">' + esc('Signalements indisponibles : ' + U.error) + '</div>' : '<div class="rz-card"><span class="rz-spin"></span> Lecture…</div>');
      return h.join('');
    }
    h.push(formHtml());
    if (admin()) {
      var others = pending().filter(function (i) { return !i.mine; });
      if (others.length) h.push(listHtml('À lire · des autres comptes', others, 'Lancez ceux qui méritent une correction : chacun ouvre une session de Claude Code sur votre compte Claude.'));
      h.push(listHtml('Vos signalements et ceux déjà lancés', issues().filter(function (i) { return i.mine || i.state !== 'pending'; }), ''));
    } else {
      h.push(listHtml('Vos signalements', issues(), 'En attente : l’administrateur ne l’a pas encore lu. Lancé : Claude Code y travaille ou y a travaillé.'));
    }
    return h.join('');
  }

  function issues() { return (U.status && U.status.issues) || []; }
  function pending() { return issues().filter(function (i) { return i.state === 'pending'; }); }

  function formHtml() {
    var n = U.text.length, over = n > max();
    var label = admin() ? (canLaunch() ? 'Envoyer à Claude Code' : 'Garder en attente') : 'Envoyer à l’administrateur';
    var h = ['<section class="rz-card rzi-card">'];
    if (U.sent) {
      var s = U.sent;
      h.push('<div class="rz-callout is-accent rzi-sent"><div><b>' + esc(s.id) + '</b> '
        + (s.state === 'sent'
          ? 'parti à Claude Code' + (s.sessionUrl ? ' : ' + link(s.sessionUrl, 'suivre la session') : '') + '.'
          : (s.error ? 'gardé, mais pas lancé : ' + esc(s.error) : admin() ? 'gardé en attente.' : 'envoyé à l’administrateur.'))
        + '</div><button type="button" class="btn btn-ghost" data-act="rz-issue-ok">OK</button></div>');
    }
    if (admin() && !canLaunch()) {
      h.push('<div class="rz-callout">Aucune routine Claude Code n’est réglée sur le serveur : les signalements restent en attente (deploy/README.md, « Signalements »).</div>');
    }
    h.push('<label class="rzi-field"><span>Titre <small>facultatif</small></span>'
      + '<input class="input" type="text" maxlength="120" data-role="rz-issue-title" data-focus-key="rzi-title" placeholder="Ex. le micro coupe au bout de 10 s" value="' + esc(U.title) + '"' + (U.busy ? ' disabled' : '') + '></label>');
    h.push('<label class="rzi-field"><span>Ce qui ne va pas, ou ce que vous voudriez</span>'
      + '<textarea class="input rzi-text" rows="7" data-role="rz-issue-text" data-focus-key="rzi-text" placeholder="Ce que vous faisiez, ce qui s’est passé, ce que vous attendiez…"' + (U.busy ? ' disabled' : '') + '>' + esc(U.text) + '</textarea></label>');
    h.push('<div class="rzi-foot"><span class="rzi-count' + (over ? ' is-over' : '') + '">' + n + ' / ' + max() + '</span>'
      + '<span class="rzi-joined">Joints d’office : votre compte, la version du serveur et de la page, ' + (U.from ? 'la vue « ' + esc(U.from) + ' », ' : '') + 'l’appareil.</span>'
      + '<button type="button" class="btn btn-primary" data-act="rz-issue-send"' + (U.busy || !U.text.trim() || over ? ' disabled' : '') + '>' + (U.busy === 'send' ? 'Envoi…' : label) + '</button></div>');
    h.push('</section>');
    return h.join('');
  }

  function listHtml(title, list, foot) {
    if (!list.length) return '';
    var h = ['<section class="rz-card rzi-card"><div class="rz-card-head"><span class="rz-card-title">' + esc(title) + '</span><span class="rz-card-meta">' + list.length + '</span></div><ul class="rzi-list">'];
    list.forEach(function (i) { h.push(itemHtml(i)); });
    h.push('</ul>' + (foot ? '<div class="rz-card-foot">' + esc(foot) + '</div>' : '') + '</section>');
    return h.join('');
  }

  function itemHtml(i) {
    var open = !!U.open[i.id], sent = i.state === 'sent';
    var meta = when(i.at) + (i.mine ? '' : ' · ' + i.login);
    var state = sent ? '<span class="rzi-state is-sent">lancé' + (i.sentBy && i.sentBy !== i.login ? ' par ' + esc(i.sentBy) : '') + '</span>' : '<span class="rzi-state">en attente</span>';
    var b = [];
    if (sent) b.push(link(i.sessionUrl, 'Session'));
    if (!sent && canLaunch()) b.push('<button type="button" class="btn btn-primary rzi-btn" data-act="rz-issue-launch" data-id="' + esc(i.id) + '"' + (U.busy ? ' disabled' : '') + '>' + (U.busy === 'launch:' + i.id ? 'Lancement…' : 'Lancer') + '</button>');
    if (admin() || !sent) {
      b.push(U.remove === i.id
        ? '<button type="button" class="btn rzi-danger" data-act="rz-issue-remove" data-id="' + esc(i.id) + '"' + (U.busy ? ' disabled' : '') + '>Confirmer</button><button type="button" class="btn btn-ghost rzi-btn" data-act="rz-issue-remove-cancel">Annuler</button>'
        : '<button type="button" class="btn btn-ghost rzi-btn" data-act="rz-issue-remove-arm" data-id="' + esc(i.id) + '">' + (sent ? 'Retirer' : 'Écarter') + '</button>');
    }
    return '<li class="rzi-item' + (open ? ' is-open' : '') + '"><button type="button" class="rzi-sum" data-act="rz-issue-toggle" data-id="' + esc(i.id) + '" aria-expanded="' + open + '">'
      + '<span class="rzi-id">' + esc(i.id) + '</span><span class="rzi-title">' + esc(i.title || '(sans titre)') + '</span>'
      + '<span class="rzi-meta">' + esc(meta) + '</span>' + state + '</button>'
      + (open ? '<div class="rzi-body">' + esc(i.text || '') + (i.view ? '<div class="rzi-from">Depuis la vue « ' + esc(i.view) + ' »</div>' : '') + '</div>' : '')
      + (b.length ? '<div class="rzi-actions">' + b.join('') + '</div>' : '') + '</li>';
  }

  /* ══ Accueil de l'administrateur : ce qui l'attend ══════════════════════ */

  R.homeCard({ id: 'issues', area: 'side', order: 85, html: function () {
    if (!admin()) return '';
    var n = pending().filter(function (i) { return !i.mine; }).length;
    if (!n) return '';
    return '<section class="rz-card rzi-home"><div class="rz-card-head"><span class="rz-card-title">Signalements</span>' + R.icon('pen') + '</div>'
      + '<div>' + n + ' signalement' + (n > 1 ? 's' : '') + ' d’autres comptes à lire.</div>'
      + '<button type="button" class="btn btn-ghost" data-act="rz-issue-go">Les lire</button></section>';
  } });

  /* ══ Actions ════════════════════════════════════════════════════════════ */

  R.act('rz-issue-refresh', function () { U.error = ''; load(); R.render(); });
  R.act('rz-issue-go', function () { R.go('issue'); });
  R.input('rz-issue-title', function (el) { U.title = el.value; });
  R.input('rz-issue-text', function (el) {
    var before = U.text.trim() === '' || U.text.length > max();
    U.text = el.value;
    if (before !== (U.text.trim() === '' || U.text.length > max())) R.renderSoon();
    else R.patch('.rzi-count', String(U.text.length) + ' / ' + max());
  });
  R.act('rz-issue-ok', function () { U.sent = null; R.render(); });
  R.act('rz-issue-toggle', function (el) { var id = el.getAttribute('data-id'); U.open[id] = !U.open[id]; R.render(); });

  R.act('rz-issue-send', function () {
    var text = U.text.trim();
    if (!text || U.busy) return;
    /* Même référence tant que le texte n'est pas parti : un renvoi après une réponse perdue ne crée pas de
       doublon (ni une seconde session de Claude Code). */
    if (!U.ref) U.ref = 'i' + R.uid();
    U.busy = 'send'; U.sent = null; R.render();
    var page = (window.REVIZATOR_SERVER && window.REVIZATOR_SERVER.version) || 'organizator';
    var standalone = !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    call('issueSend', {
      ref: U.ref, title: U.title.trim(), text: text, view: U.from || '', page: String(page),
      device: (standalone ? 'application installée · ' : '') + String(navigator.userAgent || '').slice(0, 140)
    }, 60000).then(function (r) {
      U.busy = '';
      U.sent = Object.assign({ id: 'Signalement' }, (r && r.issue) || {}, r && r.error ? { error: r.error } : {});
      if (r && r.status) U.status = r.status;
      U.title = ''; U.text = ''; U.ref = '';
      R.render();
    }, fail('Signalement non envoyé'));
  });

  R.act('rz-issue-launch', function (el) {
    var id = el.getAttribute('data-id');
    if (U.busy) return;
    U.busy = 'launch:' + id; R.render();
    call('issueLaunch', { id: id }, 60000).then(function (r) {
      U.busy = '';
      if (r && r.status) U.status = r.status;
      R.toast(id + ' lancé vers Claude Code.', r && r.issue && r.issue.sessionUrl ? { label: 'Session', run: function () { window.open(r.issue.sessionUrl, '_blank', 'noopener'); } } : undefined);
      R.render();
    }, fail(id + ' non lancé'));
  });

  R.act('rz-issue-remove-arm', function (el) { U.remove = el.getAttribute('data-id'); R.render(); });
  R.act('rz-issue-remove-cancel', function () { U.remove = ''; R.render(); });
  R.act('rz-issue-remove', function (el) {
    var id = el.getAttribute('data-id');
    U.busy = 'remove'; R.render();
    call('issueRemove', { id: id }).then(function (r) {
      U.busy = ''; U.remove = '';
      if (r && r.status) U.status = r.status;
      R.render();
    }, fail(id + ' non retiré'));
  });

  R.view('issue', {
    label: 'Signaler', icon: 'pen', order: 90, title: 'Signaler un problème ou une idée — l’administrateur le confie à Claude Code',
    nav: function () { return !!U.status; },
    render: render,
    onShow: function () { load(); }
  });

  /* ══ Simulation hors serveur (shim) ═════════════════════════════════════ */

  var SHIM = [
    { id: 'RZ-1', ref: 'x', login: 'lea', at: Date.now() - 3 * 3600e3, title: 'La dictée coupe sur Android', text: 'Quand je dicte une réponse longue, le micro s’arrête au bout de dix secondes.\nAndroid 15, Chrome.', view: 'tutor', state: 'pending', sentAt: 0, sentBy: '', sessionUrl: '', mine: false }
  ];
  function shimStatus() {
    return { enabled: true, canLaunch: true, admin: true, max: 8000, pending: SHIM.filter(function (i) { return i.state === 'pending'; }).length, issues: JSON.parse(JSON.stringify(SHIM)) };
  }
  function shimLaunch(i) { i.state = 'sent'; i.sentAt = Date.now(); i.sentBy = 'moi'; i.sessionUrl = 'https://claude.ai/code/session_shim' + i.id.slice(3); }
  R.shim('issueStatus', shimStatus);
  R.shim('issueSend', function (p) {
    var same = SHIM.filter(function (i) { return i.ref === p.ref; })[0];
    if (!same) {
      same = { id: 'RZ-' + (SHIM.length + 1), ref: p.ref, login: 'moi', at: Date.now(), title: p.title || String(p.text).split('\n')[0].slice(0, 120), text: p.text, view: p.view, state: 'pending', sentAt: 0, sentBy: '', sessionUrl: '', mine: true };
      shimLaunch(same);
      SHIM.unshift(same);
    }
    return { issue: JSON.parse(JSON.stringify(same)), status: shimStatus(), repeated: false };
  });
  R.shim('issueLaunch', function (p) {
    var i = SHIM.filter(function (x) { return x.id === p.id; })[0];
    if (!i) throw new Error('Aucun signalement « ' + p.id + ' ».');
    if (i.state === 'pending') shimLaunch(i);
    return { issue: JSON.parse(JSON.stringify(i)), status: shimStatus() };
  });
  R.shim('issueRemove', function (p) { SHIM = SHIM.filter(function (x) { return x.id !== p.id; }); return { status: shimStatus() }; });
})();
