/*
  Genere les icones de l'application installable Revizator (docs/REVIZATOR-SERVER.md § 5.3) :
  src/Organizator/wwwroot/icons/icon-192.png, icon-512.png et icon-maskable-512.png.
  Meme esprit que app.ico (tools/make-icon.ps1) : disque terracotta #c67139 sur fond creme #f5ead8,
  mais un « R » blanc en Caprasimo (la police des titres de la page). La version « maskable » garde
  le dessin dans la zone sure (cercle de 80 %) et remplit tout le carre de creme.

  Usage : node tools/make-pwa-icons.mjs   (Playwright et Chromium installes ; PLAYWRIGHT_BROWSERS_PATH au besoin)
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'src', 'Organizator', 'wwwroot');
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch (e) { pw = require(join(process.env.NODE_PATH || '/opt/node22/lib/node_modules', 'playwright')); }

const font = readFileSync(join(www, 'fonts', 'caprasimo-400-latin.woff2')).toString('base64');

/* disc : diametre du disque en part du cote ; round : coins arrondis du fond (0 pour maskable). */
function html(size, disc, round) {
  return `<!doctype html><html><head><style>
@font-face { font-family: Caprasimo; src: url(data:font/woff2;base64,${font}) format('woff2'); }
html, body { margin: 0; background: transparent; }
.bg { width: ${size}px; height: ${size}px; background: #f5ead8; border-radius: ${round * size}px; display: grid; place-items: center; }
.disc { width: ${disc * size}px; height: ${disc * size}px; border-radius: 50%; background: #c67139; display: grid; place-items: center;
  box-shadow: inset 0 -${size * 0.02}px 0 rgba(0,0,0,0.12); }
.r { font-family: Caprasimo; color: #fff; font-size: ${disc * size * 0.66}px; line-height: 1; transform: translate(${disc * size * 0.01}px, ${disc * size * 0.03}px); }
</style></head><body><div class="bg"><div class="disc"><span class="r">R</span></div></div></body></html>`;
}

const out = [
  { file: 'icon-192.png', size: 192, disc: 0.88, round: 0.22 },
  { file: 'icon-512.png', size: 512, disc: 0.88, round: 0.22 },
  { file: 'icon-maskable-512.png', size: 512, disc: 0.72, round: 0 }
];

const browser = await pw.chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const o of out) {
  await page.setViewportSize({ width: o.size, height: o.size });
  await page.setContent(html(o.size, o.disc, o.round));
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.bg').screenshot({ path: join(www, 'icons', o.file), omitBackground: true });
  console.log('icons/' + o.file);
}
await browser.close();
