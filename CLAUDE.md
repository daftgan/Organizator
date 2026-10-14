# Organizator — règles pour les sessions Claude

Le détail de l'architecture est dans `docs/ARCHITECTURE.md`, le contrat du serveur Révizator dans
`docs/REVIZATOR-SERVER.md`. Ce qui suit, ce sont les règles à appliquer à chaque fois.

## Toute nouvelle version doit arriver sur le téléphone

Le téléphone utilise Révizator par le serveur (`revizator.daft-lab.fr`), en application installée : un
service worker (`src/Organizator/wwwroot/sw.js`) garde en cache l'enveloppe de la page (HTML, CSS, JS).
Une fusion sur `main` est déployée seule (action Komodo `revizator-auto-deploy`), mais le téléphone ne
voit le nouveau code que si **le cache change de version à chaque déploiement**.

- La version du cache est `ServerConfig.ShellVersion` (`src/Revizator.Server/ServerConfig.cs`) : version
  du serveur **et commit construit**, injectée par `revizator-server.js` et lue par `app.js`
  (`sw.js?v=…`). Ne jamais la ramener à une constante (`1.0.0`) ni à la seule version de l'assembly :
  le téléphone garderait l'ancienne page.
- Un nouveau fichier de la page (JS, CSS, police, icône) qui doit marcher hors ligne s'ajoute à la liste
  `SHELL` de `sw.js`.
- Après chaque fusion qui touche `src/Organizator/wwwroot/`, `src/Revizator.Server/` ou un service
  partagé (`src/Organizator/Services/` lié par le `.csproj` du serveur) : vérifier (ou faire vérifier
  par la session « daft-lab remote », qui héberge le serveur) que `https://revizator.daft-lab.fr/api/health`
  renvoie le commit de `main`, et dire à l'utilisateur que la nouvelle version arrive au prochain
  lancement de l'application (elle se recharge d'elle-même dans les secondes qui suivent l'ouverture).
- La CI GitHub ne compile que l'application Windows : le serveur (`Revizator.Server`) n'est compilé
  qu'au déploiement. Une modification de `ServerBridge.cs`, `HttpRoutes.cs`, `ServerConfig.cs`… se relit
  donc avec soin, et le résultat du déploiement se vérifie.
