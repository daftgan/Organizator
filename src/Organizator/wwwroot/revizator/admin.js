/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — administration du serveur (vue « admin »)
   Visible des seuls administrateurs du serveur Révizator (par défaut le premier compte créé ; d'autres par
   cette page ou par « revizator-server user admin <identifiant> on »). Le serveur vérifie le droit à chaque
   message : cacher l'onglet n'est qu'une commodité.
     · Personnes : la liste des comptes (pseudo, rôle, appareils connectés, dernière activité), ajouter une
       personne (identifiant et mot de passe, avec un générateur), changer un mot de passe (ses appareils se
       reconnectent), donner ou retirer le droit d'administrer, supprimer un compte (ses données restent sur
       le serveur, dans users/<identifiant>/) ;
     · Modèles de Révizator : les modèles et efforts de Claude Code pour le cours, les exercices et bilans, la
       correction, le tuteur et le correcteur des cartes — proposés (réglages de départ d'un nouveau compte) ou
       imposés à tous (le serveur les applique à chaque génération, quoi que demande la page).
   Messages : learnPolicy (tout compte), adminUsers, adminUserSet, adminUserRemove, adminUserAdmin,
   adminPolicySave ; événement learnPolicy quand un administrateur enregistre.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var R = window.Revizator;
  if (!R) return;
  var esc = R.esc;
  var U = R.ui.admin = R.ui.admin || { users: null, loading: false, error: '', form: { login: '', password: '', show: false }, created: null, pw: {}, remove: '', draft: null, custom: {}, busy: '' };

  function bridge() { return window.bridge; }
  function onServer() { var b = bridge(); return !!(b && (b.mode === 'server' || (b.remote && b.remote()) || b.isShim)); }
  function call(type, payload) { return bridge().call(type, payload || {}, 30000); }
  function fail(e) { U.busy = ''; R.toast('Administration : ' + ((e && e.message) || 'échec')); R.render(); }
  function date(v) { var d = typeof v === 'number' ? new Date(v) : new Date(String(v || '')); return isNaN(d) ? '—' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function ago(ms) {
    if (!ms) return 'jamais';
    var min = Math.round((Date.now() - ms) / 60000);
    if (min < 2) return 'à l’instant';
    if (min < 60) return 'il y a ' + min + ' min';
    var h = Math.round(min / 60);
    if (h < 24) return 'il y a ' + h + ' h';
    var d = Math.round(h / 24);
    return d < 30 ? 'il y a ' + d + ' j' : date(ms);
  }

  /* ══ Réglages de l'administrateur (pour tous) ═══════════════════════════ */

  function loadPolicy() {
    if (!onServer()) { R.policy = null; return; }
    call('learnPolicy').then(function (p) {
      R.policy = p || null;
      seedDefaults();
      R.render();
    }, function () { /* serveur plus ancien : pas d'administration */ });
  }

  /* Un compte neuf (premier lancement pas encore fait) part des modèles proposés par l'administrateur. */
  function seedDefaults() {
    var p = R.policy;
    if (!p || !p.models || !R.isLoaded() || R.profile.onboarded || R.prefs.policySeeded) return;
    R.models.fields().forEach(function (f) {
      if (p.models[f.key]) R.prefs[f.key] = p.models[f.key];
      if (f.effort && p.models[f.effort] != null) R.prefs[f.effort] = p.models[f.effort];
    });
    R.prefs.policySeeded = true;
    R.save();
  }

  R.on('loaded', loadPolicy);
  if (bridge() && bridge().on) {
    bridge().on('learnPolicy', function (p) {
      /* Le droit d'administrer ne vient jamais de l'événement (il part à tous les comptes). */
      R.policy = Object.assign({}, p || {}, { admin: !!(R.policy && R.policy.admin) });
      R.render();
    });
    bridge().on('remoteChanged', function () { R.policy = null; U.users = null; });
  }

  /* ══ Données de la vue ══════════════════════════════════════════════════ */

  function loadUsers() {
    if (U.loading) return;
    U.loading = true;
    call('adminUsers').then(function (r) { adopt(r); U.error = ''; }, function (e) { U.error = (e && e.message) || 'Liste indisponible.'; })
      .then(function () { U.loading = false; R.render(); });
  }

  function adopt(r) {
    if (!r) return;
    if (r.users) U.users = r.users;
    if (r.policy) {
      R.policy = Object.assign({}, r.policy, { admin: true });
      if (!U.draft) U.draft = draftOf(r.policy);
    }
  }

  function draftOf(p) { return { models: Object.assign({}, p.models || {}), imposed: !!p.imposed }; }

  /* ══ Rendu ══════════════════════════════════════════════════════════════ */

  function renderAdmin() {
    var h = ['<div class="rzp-head"><div><div class="rz-kicker">' + R.icon('shield') + ' Administration</div><h2 class="rz-section-title">Serveur Révizator</h2>'
      + '<div class="rz-sub">Les personnes qui ont un compte, et les modèles de Claude Code qu’utilise Révizator.</div></div>'
      + '<div class="rzp-filter"><button type="button" class="btn btn-ghost" data-act="rz-admin-refresh"' + (U.loading ? ' disabled' : '') + '>' + (U.loading ? 'Lecture…' : 'Actualiser') + '</button></div></div>'];
    if (!R.policy || !R.policy.admin) {
      h.push(R.h.empty('Réservé à l’administrateur', 'Cette page n’est ouverte qu’aux administrateurs du serveur Révizator.'));
      return h.join('');
    }
    if (!U.users) {
      if (!U.loading && !U.error) loadUsers();
      h.push(U.error ? '<div class="rz-callout rzb-warn">' + esc('Liste indisponible : ' + U.error) + ' <button type="button" class="btn btn-ghost" data-act="rz-admin-refresh">Réessayer</button></div>'
        : '<div class="rz-card rzb-wait"><span class="rz-spin"></span> Lecture des comptes…</div>');
      return h.join('');
    }
    h.push(usersHtml());
    h.push(addHtml());
    h.push(modelsHtml());
    return h.join('');
  }

  function usersHtml() {
    var h = ['<section class="rz-card rza-card"><div class="rz-card-head"><span class="rz-card-title">Personnes</span><span class="rz-card-meta">' + U.users.length + ' compte' + (U.users.length > 1 ? 's' : '') + '</span></div>'];
    h.push('<div class="rzb-table-wrap"><table class="rzb-table rza-table"><thead><tr><th scope="col">Compte</th><th scope="col">Rôle</th><th scope="col" class="rzb-opt">Appareils</th>'
      + '<th scope="col">Dernière activité</th><th scope="col" class="rzb-opt">Créé le</th><th scope="col"><span class="rza-sr">Actions</span></th></tr></thead><tbody>');
    U.users.forEach(function (u) {
      var name = u.name && u.name !== u.login ? '<span class="rza-pseudo">' + esc(u.name) + '</span>' : '';
      h.push('<tr class="' + (u.me ? 'is-me' : '') + '"><th scope="row" class="rza-who"><b>' + esc(u.login) + '</b>' + (u.me ? ' <span class="rzb-me">vous</span>' : '') + name + '</th>'
        + '<td>' + (u.admin ? '<span class="rza-badge">Admin</span>' : '<span class="rza-role">Membre</span>') + '</td>'
        + '<td class="rzb-opt" title="' + esc((u.devices || []).join('\n')) + '">' + (u.sessions ? u.sessions + ' connecté' + (u.sessions > 1 ? 's' : '') : '—') + '</td>'
        + '<td>' + esc(u.hasData ? ago(u.lastActivity) : 'pas encore venu') + '</td>'
        + '<td class="rzb-opt">' + esc(date(u.created)) + '</td>'
        + '<td class="rza-actions">' + actionsHtml(u) + '</td></tr>');
      if (U.pw[u.login] != null) {
        h.push('<tr class="rza-sub"><td colspan="6"><div class="rza-inline">'
          + '<label class="rza-lbl" for="rza-pw-' + esc(u.login) + '">Nouveau mot de passe de ' + esc(u.login) + '</label>'
          + '<input id="rza-pw-' + esc(u.login) + '" class="input" type="text" autocomplete="new-password" spellcheck="false" maxlength="200" data-role="rz-admin-pw" data-login="' + esc(u.login) + '" data-focus-key="rza-pw-' + esc(u.login) + '" value="' + esc(U.pw[u.login]) + '">'
          + '<button type="button" class="btn btn-ghost" data-act="rz-admin-pw-gen" data-login="' + esc(u.login) + '">Générer</button>'
          + '<button type="button" class="btn btn-primary" data-act="rz-admin-pw-save" data-login="' + esc(u.login) + '"' + (U.busy ? ' disabled' : '') + '>Enregistrer</button>'
          + '<button type="button" class="btn btn-ghost" data-act="rz-admin-pw-cancel" data-login="' + esc(u.login) + '">Annuler</button></div>'
          + '<div class="rz-set-help">' + esc(u.me ? 'Vos appareils, celui-ci compris, devront se reconnecter avec le nouveau mot de passe.' : 'Les appareils de ' + u.login + ' devront se reconnecter avec le nouveau mot de passe.') + '</div></td></tr>');
      }
    });
    h.push('</tbody></table></div>');
    h.push('<div class="rz-card-foot">Supprimer un compte ferme ses sessions ; ses données restent sur le serveur (users/&lt;identifiant&gt;/) et reviennent si le compte est recréé. Un administrateur voit cette page ; il ne voit jamais les cartes, les textes ni les enregistrements des autres.</div></section>');
    return h.join('');
  }

  function actionsHtml(u) {
    var b = [];
    b.push('<button type="button" class="btn btn-ghost rza-btn" data-act="rz-admin-pw-open" data-login="' + esc(u.login) + '">Mot de passe</button>');
    if (!u.me) {
      b.push('<button type="button" class="btn btn-ghost rza-btn" data-act="rz-admin-role" data-login="' + esc(u.login) + '" data-admin="' + (u.admin ? '0' : '1') + '"' + (U.busy ? ' disabled' : '') + '>'
        + (u.admin ? 'Retirer admin' : 'Rendre admin') + '</button>');
      b.push(U.remove === u.login
        ? '<button type="button" class="btn rza-danger" data-act="rz-admin-remove" data-login="' + esc(u.login) + '"' + (U.busy ? ' disabled' : '') + '>Confirmer la suppression</button>'
          + '<button type="button" class="btn btn-ghost rza-btn" data-act="rz-admin-remove-cancel">Annuler</button>'
        : '<button type="button" class="btn btn-ghost rza-btn rza-del" data-act="rz-admin-remove-arm" data-login="' + esc(u.login) + '">Supprimer</button>');
    }
    return b.join('');
  }

  function addHtml() {
    var f = U.form;
    var h = ['<section class="rz-card rza-card"><div class="rz-card-head"><span class="rz-card-title">Ajouter une personne</span></div>'];
    if (U.created) {
      h.push('<div class="rz-callout rzb-lead rza-created"><div>Compte <b>' + esc(U.created.login) + '</b> créé. Transmettez-lui son identifiant et son mot de passe'
        + (U.created.password ? ' : <code class="rza-code">' + esc(U.created.password) + '</code>' : '') + ' — il se connecte sur la page de ce serveur, depuis son téléphone ou depuis Organizator (Réglages › Révizator › Serveur Révizator).</div>'
        + '<button type="button" class="btn btn-ghost" data-act="rz-admin-created-ok">J’ai noté</button></div>');
    }
    h.push('<div class="rza-form">'
      + '<label class="rza-field"><span>Identifiant</span><input class="input" type="text" maxlength="40" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="lea" data-role="rz-admin-form" data-field="login" data-focus-key="rza-new-login" value="' + esc(f.login) + '"></label>'
      + '<label class="rza-field"><span>Mot de passe</span><input class="input" type="' + (f.show ? 'text' : 'password') + '" autocomplete="new-password" spellcheck="false" maxlength="200" data-role="rz-admin-form" data-field="password" data-focus-key="rza-new-password" value="' + esc(f.password) + '"></label>'
      + '<div class="rza-form-btns"><button type="button" class="btn btn-ghost" data-act="rz-admin-gen">Générer</button>'
      + '<button type="button" class="btn btn-primary" data-act="rz-admin-add"' + (U.busy ? ' disabled' : '') + '>' + (U.busy === 'add' ? 'Création…' : 'Créer le compte') + '</button></div></div>');
    h.push('<div class="rz-card-foot">Identifiant : lettres, chiffres, point, tiret ou souligné (40 au plus), en minuscules. Chacun a ses propres données et apparaît dans le Classement (il peut s’en retirer). Pas d’inscription libre : seuls les administrateurs créent des comptes.</div></section>');
    return h.join('');
  }

  function modelsHtml() {
    var d = U.draft || (U.draft = draftOf(R.policy));
    var p = R.policy || {};
    var h = ['<section class="rz-card rza-card"><div class="rz-card-head"><span class="rz-card-title">Modèles de Révizator</span>'
      + (p.changed ? '<span class="rz-card-meta">' + esc('modifiés le ' + date(p.changed) + (p.changedBy ? ' par ' + p.changedBy : '')) + '</span>' : '') + '</div>'];
    h.push(R.setField('Mode', R.h.chips('imposed', ['no', 'yes'], d.imposed ? 'yes' : 'no', ['Proposés · chacun peut changer', 'Imposés à tous'], 'rz-admin-imposed')));
    h.push('<div class="rz-set-help">' + esc(d.imposed
      ? 'Le serveur utilise ces modèles pour toutes les générations et pour le tuteur, quels que soient les réglages de chacun ; leurs Réglages les affichent sans pouvoir les changer.'
      : 'Ce sont les réglages de départ des nouveaux comptes ; chacun peut ensuite les changer dans Réglages › Révizator.') + '</div>');
    R.models.fields().forEach(function (f) {
      var v = String(d.models[f.key] || '');
      var custom = U.custom[f.key] || (v && !R.models.known(v));
      var ctl = R.models.select(v, U.custom[f.key], 'rz-admin-model', 'rza-model-' + f.key).replace('data-role="rz-admin-model"', 'data-role="rz-admin-model" data-field="' + f.key + '"');
      if (f.effort) ctl += R.models.effort(String(d.models[f.effort] || ''), 'rz-admin-effort', 'rza-effort-' + f.effort).replace('data-role="rz-admin-effort"', 'data-role="rz-admin-effort" data-field="' + f.effort + '"');
      h.push(R.setField(f.label, ctl));
      if (custom) h.push(R.setField('', '<input class="input set-cwd" type="text" data-role="rz-admin-model-text" data-field="' + f.key + '" data-focus-key="rza-model-text-' + f.key + '" spellcheck="false" placeholder="Identifiant de modèle, ex. sonnet" value="' + esc(v) + '">'));
      h.push('<div class="rz-set-help">' + esc(f.help) + '</div>');
    });
    var dirty = JSON.stringify(draftOf(p)) !== JSON.stringify(d);
    h.push('<div class="set-card-foot rza-save"><span>Toutes les générations passent par le compte Claude Code du serveur : un modèle plus gros coûte plus de quota.</span>'
      + '<button type="button" class="btn btn-ghost" data-act="rz-admin-models-defaults">Valeurs d’origine</button>'
      + '<button type="button" class="btn btn-primary" data-act="rz-admin-models-save"' + (dirty && !U.busy ? '' : ' disabled') + '>' + (U.busy === 'models' ? 'Enregistrement…' : 'Enregistrer') + '</button></div></section>');
    return h.join('');
  }

  /* ══ Actions ════════════════════════════════════════════════════════════ */

  function newPassword() {
    var alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var bytes = new Uint8Array(14);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) { out += alphabet[bytes[i] % alphabet.length]; if (i === 4 || i === 9) out += '-'; }
    return out;
  }

  R.act('rz-admin-refresh', function () { U.error = ''; loadUsers(); R.render(); });
  R.input('rz-admin-form', function (el) { U.form[el.getAttribute('data-field')] = el.value; });
  R.act('rz-admin-gen', function () { U.form.password = newPassword(); U.form.show = true; R.render(); });
  R.act('rz-admin-created-ok', function () { U.created = null; R.render(); });
  R.act('rz-admin-add', function () {
    var login = String(U.form.login || '').trim().toLowerCase(), password = String(U.form.password || '');
    if (!/^[a-z0-9._-]{1,40}$/.test(login)) { R.toast('Identifiant attendu : lettres, chiffres, point, tiret ou souligné (40 au plus).'); return; }
    if (!password) { R.toast('Mot de passe vide.'); return; }
    if ((U.users || []).some(function (u) { return u.login === login; })) { R.toast('« ' + login + ' » existe déjà : changez plutôt son mot de passe.'); return; }
    U.busy = 'add'; R.render();
    call('adminUserSet', { login: login, password: password }).then(function (r) {
      adopt(r); U.busy = '';
      U.created = { login: login, password: U.form.show ? password : '' };
      U.form = { login: '', password: '', show: false };
      R.board && R.board.refresh();
      R.render();
    }, fail);
  });

  R.act('rz-admin-pw-open', function (el) { U.pw[el.getAttribute('data-login')] = ''; R.render(); });
  R.act('rz-admin-pw-cancel', function (el) { delete U.pw[el.getAttribute('data-login')]; R.render(); });
  R.act('rz-admin-pw-gen', function (el) { U.pw[el.getAttribute('data-login')] = newPassword(); R.render(); });
  R.input('rz-admin-pw', function (el) { U.pw[el.getAttribute('data-login')] = el.value; });
  R.act('rz-admin-pw-save', function (el) {
    var login = el.getAttribute('data-login'), password = String(U.pw[login] || '');
    if (!password) { R.toast('Mot de passe vide.'); return; }
    U.busy = 'pw'; R.render();
    call('adminUserSet', { login: login, password: password }).then(function (r) {
      adopt(r); U.busy = ''; delete U.pw[login];
      R.toast('Mot de passe de ' + login + ' changé' + (r && r.closed ? ' : ' + r.closed + ' appareil' + (r.closed > 1 ? 's' : '') + ' à reconnecter.' : '.'));
      R.render();
    }, fail);
  });

  R.act('rz-admin-role', function (el) {
    var login = el.getAttribute('data-login'), admin = el.getAttribute('data-admin') === '1';
    U.busy = 'role'; R.render();
    call('adminUserAdmin', { login: login, admin: admin }).then(function (r) { adopt(r); U.busy = ''; R.render(); }, fail);
  });

  R.act('rz-admin-remove-arm', function (el) { U.remove = el.getAttribute('data-login'); R.render(); });
  R.act('rz-admin-remove-cancel', function () { U.remove = ''; R.render(); });
  R.act('rz-admin-remove', function (el) {
    var login = el.getAttribute('data-login');
    U.busy = 'remove'; R.render();
    call('adminUserRemove', { login: login }).then(function (r) {
      adopt(r); U.busy = ''; U.remove = '';
      R.toast('Compte ' + login + ' supprimé ; ses données restent sur le serveur.');
      R.board && R.board.refresh();
      R.render();
    }, fail);
  });

  R.act('rz-admin-imposed', function (el) { U.draft.imposed = el.getAttribute('data-value') === 'yes'; R.render(); });
  R.change('rz-admin-model', function (el) {
    var f = el.getAttribute('data-field');
    if (el.value === R.models.custom()) U.custom[f] = true;
    else { U.custom[f] = false; U.draft.models[f] = el.value; }
    R.render();
  });
  R.input('rz-admin-model-text', function (el) { U.draft.models[el.getAttribute('data-field')] = el.value.trim().slice(0, 80); R.renderSoon(); });
  R.change('rz-admin-effort', function (el) { U.draft.models[el.getAttribute('data-field')] = el.value; R.render(); });
  R.act('rz-admin-models-defaults', function () { U.draft.models = Object.assign({}, (R.policy && R.policy.defaults) || {}); U.custom = {}; R.render(); });
  R.act('rz-admin-models-save', function () {
    U.busy = 'models'; R.render();
    call('adminPolicySave', U.draft).then(function (p) {
      R.policy = Object.assign({}, p, { admin: true });
      U.draft = draftOf(p); U.custom = {}; U.busy = '';
      R.toast(p.imposed ? 'Modèles imposés à tous les comptes.' : 'Modèles proposés aux nouveaux comptes.');
      R.render();
    }, fail);
  });

  R.view('admin', {
    label: 'Admin', icon: 'shield', order: 95, title: 'Administration du serveur Révizator — personnes et modèles',
    nav: function () { return !!(R.policy && R.policy.admin); },
    render: renderAdmin,
    onShow: function () { U.users = null; U.error = ''; U.draft = null; loadUsers(); }
  });

  /* ══ Simulation hors serveur (shim) ═════════════════════════════════════ */

  var SHIM = {
    users: [
      { login: 'moi', created: '2026-05-02T10:00:00Z', changed: '2026-05-02T10:00:00Z', admin: true, flagged: false, sessions: 2, devices: ['moi · Organizator (PC)', 'moi · iPhone Safari'], name: 'Dagan', lastActivity: Date.now() - 3600e3, hasData: true, me: true },
      { login: 'lea', created: '2026-09-12T18:00:00Z', changed: '2026-09-12T18:00:00Z', admin: false, flagged: false, sessions: 1, devices: ['lea · Android Chrome'], name: 'Léa', lastActivity: Date.now() - 2 * 86400e3, hasData: true, me: false }
    ],
    policy: { models: { lessonModel: 'sonnet', lessonEffort: 'medium', genModel: 'sonnet', genEffort: 'low', gradeModel: 'sonnet', gradeEffort: 'medium', tutorModel: 'haiku', tutorEffort: '', longModel: 'sonnet', longEffort: 'low', cardModel: 'haiku', cardEffort: '', profModel: 'sonnet', profEffort: 'low', penModel: 'sonnet', penEffort: 'low' }, imposed: false, changed: '', changedBy: '',
      defaults: { lessonModel: 'sonnet', lessonEffort: 'medium', genModel: 'sonnet', genEffort: 'low', gradeModel: 'sonnet', gradeEffort: 'medium', tutorModel: 'haiku', tutorEffort: '', longModel: 'sonnet', longEffort: 'low', cardModel: 'haiku', cardEffort: '', penModel: 'sonnet', penEffort: 'low' } }
  };
  function shimList() { return { users: JSON.parse(JSON.stringify(SHIM.users)), policy: JSON.parse(JSON.stringify(SHIM.policy)) }; }
  R.shim('learnPolicy', function () { return Object.assign(JSON.parse(JSON.stringify(SHIM.policy)), { admin: true }); });
  R.shim('adminUsers', shimList);
  R.shim('adminUserSet', function (p) {
    var u = SHIM.users.filter(function (x) { return x.login === p.login; })[0];
    if (!u) SHIM.users.push({ login: p.login, created: new Date().toISOString(), changed: '', admin: false, sessions: 0, devices: [], name: '', lastActivity: null, hasData: false, me: false });
    return Object.assign(shimList(), { created: !u, closed: u ? u.sessions : 0 });
  });
  R.shim('adminUserRemove', function (p) { SHIM.users = SHIM.users.filter(function (x) { return x.login !== p.login; }); return shimList(); });
  R.shim('adminUserAdmin', function (p) { SHIM.users.forEach(function (x) { if (x.login === p.login) x.admin = !!p.admin; }); return shimList(); });
  R.shim('adminPolicySave', function (p) { SHIM.policy.models = Object.assign({}, p.models); SHIM.policy.imposed = !!p.imposed; SHIM.policy.changed = new Date().toISOString(); SHIM.policy.changedBy = 'moi'; return JSON.parse(JSON.stringify(SHIM.policy)); });
})();
