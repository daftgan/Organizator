/* ═══════════════════════════════════════════════════════════════════════════
   Révizator — service worker de l'application installable (docs/REVIZATOR-SERVER.md § 5.3)
   Enregistré par app.js, en mode serveur seulement, sous l'adresse sw.js?v=<version du serveur> :
   une nouvelle version du serveur change l'adresse, donc installe un nouveau service worker, dont le
   cache porte la version ; l'ancien cache est supprimé à l'activation.
   Ne met en cache que l'enveloppe de la page (HTML, CSS, JS, polices, icônes) pour un démarrage
   rapide. Jamais les données : /api, /learn, /tts, /t/, /pair passent toujours au réseau, sans copie.
   - page (navigation) et revizator-server.js : réseau d'abord (le cookie décide de la page servie),
     copie de secours hors ligne ;
   - autres fichiers : copie d'abord, relue en arrière-plan (une modification sans changement de
     version arrive au chargement suivant).
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

var VERSION = new URL(self.location.href).searchParams.get('v') || '0';
var CACHE = 'revizator-shell-' + VERSION;
var PREFIX = 'revizator-shell-';

/* Ce qui sert au premier affichage ; le reste se met en cache au fil des lectures. */
var SHELL = [
  'index.html', 'organic.css', 'fonts.css', 'app.css', 'voice.css', 'mobile.css',
  'revizator/revizator.css', 'revizator/exercise.css', 'revizator/lesson.css', 'revizator/test.css',
  'revizator/progress.css', 'revizator/tutor.css',
  'bridge.js', 'app.js', 'voice-engine.js', 'voice.js',
  'revizator/core.js', 'revizator/srs.js', 'revizator/items.js', 'revizator/exercise.js', 'revizator/lesson.js',
  'revizator/test.js', 'revizator/progress.js', 'revizator/tutor.js',
  'fonts/figtree-400-latin.woff2', 'fonts/figtree-600-latin.woff2', 'fonts/figtree-700-latin.woff2',
  'fonts/caprasimo-400-latin.woff2', 'manifest.webmanifest', 'icons/icon-192.png'
];

/* Chemins jamais mis en cache (données, médias, appairage). */
var PRIVATE = /^\/(api|learn|tts|t|pair)(\/|$)/;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    /* Un fichier manquant ne bloque pas l'installation. */
    return Promise.all(SHELL.map(function (u) {
      return fetch(u, { cache: 'no-cache' }).then(function (r) { if (r.ok) return c.put(u, r); })['catch'](function () { /* hors ligne */ });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; })
      .map(function (k) { return caches['delete'](k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin || PRIVATE.test(url.pathname)) return;
  /* Le service worker lui-même, et les fiches de simulation du shim (inutiles sur le serveur). */
  if (url.pathname === '/sw.js' || url.pathname.indexOf('/revizator/fixtures/') === 0) return;

  if (req.mode === 'navigate' || url.pathname === '/revizator-server.js') {
    /* La page : celle du serveur (appairé ou non), la copie seulement hors ligne. Seule la page
       appairée (200) est gardée ; elle l'est sous index.html, quelle que soit l'adresse demandée. */
    var key = req.mode === 'navigate' ? 'index.html' : 'revizator-server.js';
    e.respondWith(fetch(req).then(function (r) {
      if (r.ok && !r.redirected) {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put(key, copy); });
      }
      return r;
    })['catch'](function () {
      return caches.open(CACHE).then(function (c) { return c.match(key); }).then(function (m) { return m || Response.error(); });
    }));
    return;
  }

  /* Fichiers de la page : copie d'abord, relecture en arrière-plan. La recherche ignore ?… (aucun
     fichier de l'enveloppe n'en dépend). */
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (r) {
        if (r.ok && r.type === 'basic') c.put(req, r.clone());
        return r;
      });
      if (hit) { e.waitUntil(net['catch'](function () { /* hors ligne : la copie suffit */ })); return hit; }
      return net;
    });
  }));
});
