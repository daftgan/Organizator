#!/usr/bin/env node
/* Essai de fumée du serveur Révizator (docs/REVIZATOR-SERVER.md).
 *
 *   REVIZATOR_PASSWORD=… node tools/revizator-server-smoke.mjs <url> <identifiant> [--skip-generate] [--allow-empty-save]
 *
 *   <url>          adresse du serveur, par exemple http://localhost:8080 ou https://revizator.daft-lab.fr
 *   <identifiant>  un compte du serveur (revizator-server user set <identifiant>) ; son mot de passe est lu
 *                  dans REVIZATOR_PASSWORD, sinon sur l'entrée standard (jamais sur la ligne de commande)
 *
 * Vérifie : santé, refus sans session, connexion (formulaire → cookie, API → jeton), mauvais mot de
 * passe refusé, page avec ses injections, WebSocket
 * (learnLoad / learnSave / learnChanged entre deux connexions, refus des types hors liste,
 * learnGenerate), fichiers de learning/ (cookie et /t/<jeton>/) et refus des traversées de chemin.
 *
 * Sans danger pour les données : learnSave réécrit learning.json tel que learnLoad l'a rendu (sauf
 * s'il n'existe pas encore : l'essai est alors sauté, sauf --allow-empty-save qui écrit {}), et le
 * document d'essai est supprimé à la fin. learnGenerate appelle Claude Code (genre « cardcheck »,
 * modèle haiku : quelques secondes, un appel bon marché) ; --skip-generate le saute.
 * Les deux sessions ouvertes par l'essai sont fermées à la fin (déconnexion). Les échecs volontaires
 * (mauvais jetons, mauvais mot de passe sur un compte inexistant) restent sous la limite de 10 par minute.
 * Node 18+ (fetch), 22+ conseillé (WebSocket global). Code de sortie : nombre d'échecs. */

import http from 'node:http';
import https from 'node:https';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const [base, login] = args.filter(a => !a.startsWith('--'));
if (!base || !login) {
  console.error('Usage : REVIZATOR_PASSWORD=… node tools/revizator-server-smoke.mjs <url> <identifiant> [--skip-generate] [--allow-empty-save]');
  process.exit(2);
}
async function readPassword() {
  if (process.env.REVIZATOR_PASSWORD) return process.env.REVIZATOR_PASSWORD;
  if (process.stdin.isTTY) process.stderr.write('Mot de passe de « ' + login + ' » (affiché) : ');
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (text.includes('\n')) break; }
  return text.split('\n')[0].replace(/\r$/, '');
}
let token = '';
const BASE = base.replace(/\/+$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
if (typeof WebSocket === 'undefined') {
  console.error('WebSocket global absent : Node 22 ou plus est nécessaire.');
  process.exit(2);
}

let failures = 0;
function check(ok, label, detail) {
  console.log((ok ? '  ok    ' : '  ÉCHEC ') + label + (!ok && detail !== undefined ? ' — ' + detail : ''));
  if (!ok) failures++;
}
const section = title => console.log('\n' + title);

/* Requête au chemin brut (fetch normaliserait « .. » avant l'envoi). */
function raw(path, headers = {}) {
  const url = new URL(BASE);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({ host: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), method: 'GET', path, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    // 101 : Node rend la main par « upgrade », pas par la réponse ; la connexion est aussitôt refermée.
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: '' }); });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('pas de réponse')));
    req.end();
  });
}

/* Une connexion au pont : appels { id, type, payload } et événements reçus. */
function connect(url, options) {
  return new Promise((resolve, reject) => {
    const ws = options ? new WebSocket(url, options) : new WebSocket(url);
    const pending = new Map();
    const events = [];
    const waiters = [];
    let seq = 0;
    ws.onmessage = m => {
      const msg = JSON.parse(m.data);
      if (msg.event) {
        events.push(msg);
        for (const w of waiters.slice()) if (w.test(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
        return;
      }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    };
    ws.onerror = e => reject(new Error('WebSocket : ' + (e.message || 'erreur')));
    ws.onopen = () => resolve({
      ws, events,
      call(type, payload = {}, timeout = 30000) {
        const id = ++seq;
        ws.send(JSON.stringify({ id, type, payload }));
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { pending.delete(id); rej(new Error('pas de réponse à ' + type)); }, timeout);
          pending.set(id, msg => { clearTimeout(timer); res(msg); });
        });
      },
      waitEvent(test, timeout = 5000) {
        const found = events.find(test);
        if (found) return Promise.resolve(found);
        return new Promise((res, rej) => {
          const w = { test, resolve: msg => { clearTimeout(timer); res(msg); } };
          const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('événement attendu non reçu')); }, timeout);
          waiters.push(w);
        });
      },
      close() { ws.close(); },
    });
  });
}

/* Vrai si le serveur accepte l'ouverture d'un WebSocket avec ces en-têtes (101), sans passer par WebSocket. */
async function upgrades(path, headers) {
  const res = await raw(path, Object.assign({
    Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  }, headers)).catch(e => ({ status: 0, body: e.message }));
  return res.status;
}

async function main() {
  console.log('Serveur : ' + BASE);

  section('Santé et CORS');
  const health = await fetch(BASE + '/api/health', { headers: { Origin: 'https://app.organizator' } });
  const h = await health.json().catch(() => null);
  check(health.status === 200 && h && h.ok === true && typeof h.version === 'string', 'GET /api/health rend { ok, version }', health.status + ' ' + JSON.stringify(h));
  check(health.headers.get('access-control-allow-origin') === 'https://app.organizator', 'CORS pour https://app.organizator', health.headers.get('access-control-allow-origin'));
  const other = await fetch(BASE + '/api/health', { headers: { Origin: 'https://evil.example' } });
  check(!other.headers.get('access-control-allow-origin'), 'pas de CORS pour une autre origine');

  const password = await readPassword();

  section('Refus sans session');
  const page = await fetch(BASE + '/', { redirect: 'manual' });
  const pageText = await page.text();
  check(page.status === 302 && page.headers.get('location') === '/login' && !pageText.includes('bridge.js'), 'GET / sans cookie : renvoi vers /login', page.status + ' ' + page.headers.get('location'));
  const loginPage = await fetch(BASE + '/login');
  const loginHtml = await loginPage.text();
  check(loginPage.status === 200 && /<form method="post" action="\/login">/.test(loginHtml) && !/<script/i.test(loginHtml), 'GET /login : formulaire sans script', loginPage.status);
  check((await fetch(BASE + '/learn/news.json')).status === 401, 'GET /learn/… sans cookie : 401');
  check((await fetch(BASE + '/t/mauvais-jeton/learn/news.json')).status === 401, 'GET /t/<mauvais jeton>/learn/… : 401');
  check(await upgrades('/api/ws', {}) === 401, 'WebSocket sans jeton : 401');
  check(await upgrades('/api/ws?token=mauvais', {}) === 401, 'WebSocket avec un mauvais jeton : 401');
  const oldPair = await fetch(BASE + '/pair?token=x', { redirect: 'manual' });
  check(oldPair.status === 200 && !oldPair.headers.get('set-cookie'), 'GET /pair?token=… : simple formulaire, aucune session', oldPair.status);
  check((await fetch(BASE + '/api/pair', { method: 'POST' })).status === 401, 'POST /api/pair sans jeton : 401');
  const wrongName = 'smoke-inconnu-' + Date.now().toString(36);
  const badApi = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: wrongName, password: 'mauvais-mot-de-passe' }) });
  const badApiBody = await badApi.json().catch(() => ({}));
  check(badApi.status === 401 && !badApiBody.token && /incorrect/.test(badApiBody.error || ''), 'POST /api/login avec un mauvais mot de passe : 401', badApi.status + ' ' + JSON.stringify(badApiBody));
  const badForm = await fetch(BASE + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ login: wrongName, password: 'mauvais-mot-de-passe' }) });
  check(badForm.status === 302 && badForm.headers.get('location') === '/login?e=bad' && !badForm.headers.get('set-cookie'), 'POST /login avec un mauvais mot de passe : retour au formulaire, pas de cookie', badForm.status + ' ' + badForm.headers.get('location'));
  const evilForm = await fetch(BASE + '/login', { method: 'POST', redirect: 'manual', headers: { Origin: 'https://evil.example' }, body: new URLSearchParams({ login, password }) });
  check(evilForm.status === 302 && !evilForm.headers.get('set-cookie'), 'POST /login depuis une autre origine : refusé', evilForm.status);

  section('Connexion');
  const apiLogin = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.organizator' }, body: JSON.stringify({ login, password, device: 'essai de fumée (API)' }) });
  const apiBody = await apiLogin.json().catch(() => ({}));
  check(apiLogin.status === 200 && typeof apiBody.token === 'string' && apiBody.token.length >= 40 && apiLogin.headers.get('access-control-allow-origin') === 'https://app.organizator',
    'POST /api/login (comme Organizator sur le PC) : jeton de session, CORS', apiLogin.status + ' ' + (apiBody.error || ''));
  token = apiBody.token || 'absent';
  const me = await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + token } });
  check(me.status === 200 && (await me.json()).login === login.toLowerCase(), 'GET /api/me avec le jeton : le compte', me.status);
  const pair = await fetch(BASE + '/login', { method: 'POST', redirect: 'manual', headers: { Origin: BASE }, body: new URLSearchParams({ login, password }) });
  const setCookie = pair.headers.get('set-cookie') || '';
  check(pair.status === 302 && pair.headers.get('location') === '/', 'POST /login (formulaire) redirige vers /', pair.status + ' ' + pair.headers.get('location'));
  check(/rz_token=/.test(setCookie) && /httponly/i.test(setCookie) && /samesite=lax/i.test(setCookie) && /max-age=34560000/i.test(setCookie),
    'cookie rz_token HttpOnly, SameSite=Lax, 400 jours', setCookie);
  if (BASE.startsWith('https:')) check(/secure/i.test(setCookie), 'cookie Secure en HTTPS', setCookie);
  const cookie = (setCookie.match(/rz_token=[^;]+/) || [''])[0];
  const index = await fetch(BASE + '/', { headers: { Cookie: cookie } });
  const html = await index.text();
  check(index.status === 200 && /<script src="revizator-server.js"><\/script>\s*<script src="bridge.js">/.test(html), 'GET / avec cookie : page, revizator-server.js avant bridge.js', index.status);
  check(html.includes('<link rel="manifest" href="manifest.webmanifest">') && html.includes('mobile.css') && /no-cache/.test(index.headers.get('cache-control') || ''),
    'manifeste et mobile.css injectés, Cache-Control: no-cache');
  const cfg = await (await fetch(BASE + '/revizator-server.js')).text();
  check(/window\.REVIZATOR_SERVER\s*=\s*\{\s*mode:\s*'revizator'/.test(cfg) && cfg.includes("wsUrl: '/api/ws'"), 'revizator-server.js généré', cfg.trim());
  check((await fetch(BASE + '/bridge.js')).status === 200, 'fichier statique de la page sans authentification (/bridge.js)');

  section('Appairage d’un téléphone');
  const pairApi = await fetch(BASE + '/api/pair', { method: 'POST', headers: { Authorization: 'Bearer ' + token, Origin: 'https://app.organizator' } });
  const pairBody = await pairApi.json().catch(() => ({}));
  check(pairApi.status === 200 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pairBody.code || '') && /^<svg/.test(pairBody.svg || '') && /\/pair\?c=/.test(pairBody.link || '')
    && pairApi.headers.get('access-control-allow-origin') === 'https://app.organizator', 'POST /api/pair (Organizator) : code, lien, QR code, CORS', pairApi.status + ' ' + JSON.stringify(pairBody).slice(0, 120));
  const pairCode = String(pairBody.code || 'ABCD-EFGH');
  const pairPage = await fetch(BASE + '/pair?c=' + pairCode.replace('-', ''));
  const pairHtml = await pairPage.text();
  check(pairPage.status === 200 && pairHtml.includes(pairCode) && !/<script/i.test(pairHtml) && !pairPage.headers.get('set-cookie'), 'GET /pair?c=… : bouton sans script, code non consommé', pairPage.status);
  const paired = await fetch(BASE + '/pair', { method: 'POST', redirect: 'manual', headers: { Origin: BASE }, body: new URLSearchParams({ code: pairCode.toLowerCase() }) });
  const pairedCookie = ((paired.headers.get('set-cookie') || '').match(/rz_token=[^;]+/) || [''])[0];
  check(paired.status === 302 && paired.headers.get('location') === '/' && pairedCookie.length > 20, 'POST /pair : session ouverte par le code', paired.status + ' ' + paired.headers.get('location'));
  check((await fetch(BASE + '/', { headers: { Cookie: pairedCookie } })).status === 200, 'GET / avec le cookie de l’appairage');
  const reused = await fetch(BASE + '/pair', { method: 'POST', redirect: 'manual', headers: { Origin: BASE }, body: new URLSearchParams({ code: pairCode }) });
  check(reused.status === 302 && reused.headers.get('location') === '/pair?e=bad' && !reused.headers.get('set-cookie'), 'code déjà servi : refusé', reused.status + ' ' + reused.headers.get('location'));
  await fetch(BASE + '/logout', { method: 'POST', redirect: 'manual', headers: { Cookie: pairedCookie, Origin: BASE } });
  check((await fetch(BASE + '/api/me', { headers: { Cookie: pairedCookie } })).status === 401, 'session de l’appairage fermée');

  section('WebSocket');
  const a = await connect(WS_BASE + '/api/ws?token=' + encodeURIComponent(token));
  check(true, 'connexion A (jeton dans l’URL, comme Organizator sur le PC)');
  let b;
  try {
    b = await connect(WS_BASE + '/api/ws', { headers: { Cookie: cookie, Origin: BASE } });
    check(true, 'connexion B (cookie, comme la page servie par le serveur)');
  } catch (e) {
    b = await connect(WS_BASE + '/api/ws?token=' + encodeURIComponent(token));
    console.log('  (WebSocket de Node sans en-têtes : connexion B par le jeton, cookie vérifié par une ouverture brute)');
  }
  check(await upgrades('/api/ws', { Cookie: cookie, Origin: BASE }) === 101, 'ouverture par le cookie (101)');
  check(await upgrades('/api/ws', { Cookie: cookie, Origin: 'https://evil.example' }) === 403, 'cookie depuis une autre origine : 403');

  const loaded = await a.call('learnLoad');
  check(loaded.ok && loaded.payload && 'data' in loaded.payload && typeof loaded.payload.rev === 'number', 'learnLoad', JSON.stringify(loaded).slice(0, 200));
  const data = loaded.ok ? loaded.payload.data : null;
  if (data === null && !flags.has('--allow-empty-save')) {
    console.log('  (learning.json absent : learnSave et learnChanged sautés, --allow-empty-save pour les essayer)');
  } else {
    const saved = await a.call('learnSave', { data: data || {} });
    check(saved.ok && typeof saved.payload.bytes === 'number', 'learnSave (même contenu)', JSON.stringify(saved).slice(0, 200));
    const changed = await b.waitEvent(e => e.event === 'learnChanged').catch(() => null);
    check(changed && typeof changed.payload.rev === 'number' && changed.payload.rev === saved.payload.rev && typeof changed.payload.at === 'number',
      'learnChanged { rev, at } reçu par l’autre connexion', JSON.stringify(changed));
    await new Promise(r => setTimeout(r, 300));
    check(!a.events.some(e => e.event === 'learnChanged'), 'pas de learnChanged pour la connexion qui a écrit');
    const again = await b.call('learnLoad');
    check(again.ok && JSON.stringify(again.payload.data) === JSON.stringify(data || {}), 'learnLoad depuis B rend le même contenu');
  }

  for (const type of ['saveData', 'startSession', 'getSessions', 'pickFolder', 'openPath', 'getUsage']) {
    const r = await a.call(type, { data: {} });
    check(!r.ok && /non disponible sur le serveur R/.test(r.error || ''), 'type refusé : ' + type, JSON.stringify(r));
  }
  const state = await a.call('getState');
  check(state.ok && state.payload.env.mode === 'revizator' && Array.isArray(state.payload.data.tasks) && state.payload.data.tasks.length === 0,
    'getState en mode serveur (données vides, env.mode)', JSON.stringify(state).slice(0, 200));
  const notify = await a.call('notify', { toasts: [] });
  check(notify.ok, 'notify rend {}');
  const voices = await a.call('voiceVoices');
  check(voices.ok && Array.isArray(voices.payload.voices), 'voiceVoices (liste vide sous Linux)');

  section('Fichiers de learning/');
  const docId = 'smoke-' + Date.now().toString(36);
  const doc = { id: docId, kind: 'exercise', smoke: true, note: 'essai de fumée, supprimé à la fin' };
  const put = await a.call('learnDocSave', { kind: 'exercise', id: docId, doc });
  check(put.ok, 'learnDocSave d’un document d’essai', JSON.stringify(put));
  const got = await a.call('learnDoc', { kind: 'exercise', id: docId });
  check(got.ok && got.payload.doc && got.payload.doc.smoke === true, 'learnDoc le relit');
  const rel = '/learn/exercises/' + docId + '.json';
  const byCookie = await fetch(BASE + rel, { headers: { Cookie: cookie } });
  check(byCookie.status === 200 && (await byCookie.json()).smoke === true, 'GET ' + rel + ' avec cookie', byCookie.status);
  check((await fetch(BASE + rel)).status === 401, 'le même sans cookie : 401');
  const byToken = await fetch(BASE + '/t/' + encodeURIComponent(token) + rel, { headers: { Origin: 'https://app.organizator' } });
  check(byToken.status === 200 && byToken.headers.get('access-control-allow-origin') === 'https://app.organizator', 'GET /t/<jeton>' + rel + ' (CORS)', byToken.status);
  const traversal = [
    '/learn/../learning.json', '/learn/..%2flearning.json', '/learn/%2e%2e/learning.json', '/learn/%2e%2e%2flearning.json',
    '/learn/exercises/../../tokens.json', '/learn/..\\learning.json', '/t/' + token + '/learn/..%2f..%2ftokens.json',
    '/t/' + token + '/tts/../../learning.json', '/..%2ftokens.json', '/%2e%2e/tokens.json', '/fonts/..%2f..%2findex.html',
    '/learn//etc/passwd', '/learn/.hidden', '/tts/%2fetc%2fpasswd',
  ];
  for (const path of traversal) {
    const r = await raw(path, { Cookie: cookie }).catch(e => ({ status: 0, body: e.message }));
    const leak = /"hash"|"tokens"|pbkdf2|root:x:0|"data"\s*:/.test(r.body);
    check(r.status >= 400 && !leak, 'traversée refusée : ' + path, r.status);
  }
  const del = await a.call('learnDocDelete', { kind: 'exercise', id: docId });
  check(del.ok && del.payload.removed === true, 'learnDocDelete du document d’essai');

  if (!flags.has('--skip-generate')) {
    section('Génération (Claude Code)');
    const job = 'smoke-' + Math.random().toString(36).slice(2, 10);
    const gen = await a.call('learnGenerate', {
      job, kind: 'cardcheck',
      params: { level: 'B1', card: { kind: 'word', front: 'to look forward to', back: 'avoir hâte de', example: 'I look forward to it.' },
        instruction: 'traduire', prompt: 'avoir hâte de', expected: ['to look forward to'], answer: 'look forward to' },
    }, 120000);
    check(gen.ok && gen.payload.job === job && gen.payload.doc && typeof gen.payload.doc.verdict === 'string', 'learnGenerate (cardcheck)', JSON.stringify(gen).slice(0, 300));
    const progress = await b.waitEvent(e => e.event === 'learn' && e.payload.job === job && e.payload.phase === 'done', 3000).catch(() => null);
    check(!!progress, 'événement learn (done) reçu par toutes les connexions');
    const jobs = await a.call('learnJobs');
    check(jobs.ok && jobs.payload.recent.some(j => j.job === job && j.ok), 'learnJobs le liste');
    const waited = await a.call('learnWait', { job });
    check(waited.ok && waited.payload.job === job, 'learnWait rend le résultat');
  }

  a.close();
  b.close();

  section('Déconnexion');
  const out = await fetch(BASE + '/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  check(out.status === 200 && (await out.json()).ok === true, 'POST /api/logout ferme la session du jeton');
  check((await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + token } })).status === 401, 'le jeton ne vaut plus rien');
  const outForm = await fetch(BASE + '/logout', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: BASE } });
  check(outForm.status === 302 && outForm.headers.get('location') === '/login?e=out', 'POST /logout (bouton de la page) renvoie vers /login', outForm.status);
  check((await fetch(BASE + '/', { redirect: 'manual', headers: { Cookie: cookie } })).status === 302, 'l’ancien cookie renvoie vers /login');
  console.log('\n' + (failures === 0 ? 'Tout est bon.' : failures + ' échec(s).'));
  process.exit(failures);
}

main().catch(e => { console.error('Erreur : ' + (e && e.stack || e)); process.exit(100); });
