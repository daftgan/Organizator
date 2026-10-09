#!/usr/bin/env node
/* Essai de fumée du serveur Révizator (docs/REVIZATOR-SERVER.md).
 *
 *   node tools/revizator-server-smoke.mjs <url> <jeton> [--skip-generate] [--allow-empty-save]
 *
 *   <url>    adresse du serveur, par exemple http://localhost:8080 ou https://revizator.daft-lab.fr
 *   <jeton>  un jeton valide (revizator-server token new smoke), à révoquer ensuite
 *
 * Vérifie : santé, refus sans jeton, appairage et cookie, page avec ses injections, WebSocket
 * (learnLoad / learnSave / learnChanged entre deux connexions, refus des types hors liste,
 * learnGenerate), fichiers de learning/ (cookie et /t/<jeton>/) et refus des traversées de chemin.
 *
 * Sans danger pour les données : learnSave réécrit learning.json tel que learnLoad l'a rendu (sauf
 * s'il n'existe pas encore : l'essai est alors sauté, sauf --allow-empty-save qui écrit {}), et le
 * document d'essai est supprimé à la fin. learnGenerate appelle Claude Code (genre « cardcheck »,
 * modèle haiku : quelques secondes, un appel bon marché) ; --skip-generate le saute.
 * Les échecs successifs volontaires (mauvais jetons) restent sous la limite de 10 par minute.
 * Node 18+ (fetch), 22+ conseillé (WebSocket global). Code de sortie : nombre d'échecs. */

import http from 'node:http';
import https from 'node:https';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const [base, token] = args.filter(a => !a.startsWith('--'));
if (!base || !token) {
  console.error('Usage : node tools/revizator-server-smoke.mjs <url> <jeton> [--skip-generate] [--allow-empty-save]');
  process.exit(2);
}
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

  section('Refus sans jeton');
  const page = await fetch(BASE + '/', { redirect: 'manual' });
  const pageText = await page.text();
  check(page.status === 401 && !pageText.includes('bridge.js'), 'GET / sans cookie : page « appareil non appairé »', page.status);
  check((await fetch(BASE + '/learn/news.json')).status === 401, 'GET /learn/… sans cookie : 401');
  check((await fetch(BASE + '/t/mauvais-jeton/learn/news.json')).status === 401, 'GET /t/<mauvais jeton>/learn/… : 401');
  check(await upgrades('/api/ws', {}) === 401, 'WebSocket sans jeton : 401');
  check(await upgrades('/api/ws?token=mauvais', {}) === 401, 'WebSocket avec un mauvais jeton : 401');
  const badPair = await fetch(BASE + '/pair?token=mauvais', { redirect: 'manual' });
  check(badPair.status === 401 && !badPair.headers.get('set-cookie'), '/pair avec un mauvais jeton : 401, pas de cookie', badPair.status);

  section('Appairage et cookie');
  const pair = await fetch(BASE + '/pair?token=' + encodeURIComponent(token), { redirect: 'manual' });
  const setCookie = pair.headers.get('set-cookie') || '';
  check(pair.status === 302 && pair.headers.get('location') === '/', '/pair redirige vers /', pair.status + ' ' + pair.headers.get('location'));
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
    const leak = /"hash"|"tokens"|root:x:0|"data"\s*:/.test(r.body);
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
  console.log('\n' + (failures === 0 ? 'Tout est bon.' : failures + ' échec(s).'));
  process.exit(failures);
}

main().catch(e => { console.error('Erreur : ' + (e && e.stack || e)); process.exit(100); });
