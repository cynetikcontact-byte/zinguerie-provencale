# ZP Tools — application de gestion

Chantiers, devis, commandes, facturation, planning, pointage et stock. Frontend JavaScript, PostgreSQL/Supabase, nginx et Coolify.

## Développement et vérification

Node.js 22 ou supérieur (CI : Node 24).

```sh
npm ci
npm run audit:local
node scripts/preview.cjs --demo
```

La prévisualisation est disponible sur `http://127.0.0.1:8765`. L'option `--demo` utilise uniquement des données fictives et désactive Supabase. Sans cette option, le serveur montre la page de connexion. Le build produit `dist/` avec les scripts externes nécessaires à la CSP.

Les tests couvrent notamment les projections des sept rôles, les écritures PostgreSQL avec contrôle de version, les factures figées, les stocks, les pointages, les sauvegardes ZIP et le rendu des vues. Les migrations sont exécutées dans une base PostgreSQL isolée PGlite ; aucun test n'écrit en production.

### Simulation des parcours

`npm run recette` lance une base PostgreSQL éphémère sur `http://127.0.0.1:8766`. Le bandeau permet de choisir un profil fictif et de simuler une coupure réseau. Le client utilise les vraies migrations et écrit uniquement dans cette base locale, qui est perdue à l'arrêt du processus. L'authentification est simulée ; cette commande ne valide pas Supabase Auth, les emails, les notifications externes ni l'application iOS. La messagerie et les fichiers font l'objet de tests séparés avec réponses de service simulées.

Les tests `journeys`, `journey-edges` et `journey-files-chat` enchaînent les opérations métier et vérifient les résultats relus au serveur : devis/commande/chantier, acompte/situations/solde, pause et clôture du pointage, congés, approvisionnement, missions, rapports, restauration, concurrence, révocation, reconnexion et pièces jointes. Les rendus des sept rôles sont aussi parcourus avec des données présentes et une base vide. Les nouveaux devis portent une référence provisoire jusqu’à la sauvegarde ; leur export et la préparation de leur email attendent la confirmation du serveur. Ce périmètre ne constitue pas une preuve de couverture de toutes les combinaisons possibles.

## Déploiement v8

Le `Dockerfile` construit les fichiers puis les sert avec nginx sur le port 80. `/health.json` expose la version du build. Le workflow GitHub vérifie les tests, le build Docker et les en-têtes HTTP.

Les migrations dans `supabase/migrations/` ciblent le schéma historique du projet. Elles ne sont pas un installateur pour une base Supabase vide. Vérifier les noms des politiques, les déclencheurs et les sauvegardes avant application. Ne jamais rejouer une migration déjà appliquée : le journal `zp_audit_events` en conserve l'identifiant.

1. Appliquer 001 à 004 dans l'ordre. Ces étapes ajoutent les API v8 et les protections préparatoires ; elles conservent temporairement le contrat des anciens clients.
2. Vérifier les correspondances entre identités Auth et profils actifs, puis tester les nouveaux clients sur un environnement de recette. Les liens vers un salarié ou un client sont explicites ; aucun rapprochement par nom ne doit activer un accès.
3. Coordonner la mise à jour du navigateur **et de toute application iOS**. L'ancien client accédant directement à `workspace` ne fonctionnera plus après 005.
4. Déployer la v8, puis appliquer 005 pendant la même fenêtre de bascule. Cette migration ferme l'accès direct au workspace et limite les fichiers au périmètre du compte. Appliquer ensuite 006, qui fournit au magasinier l'identifiant de réservation du chantier sans exposer son prix ou le contenu du devis. Puis appliquer 007 pour attribuer les références des nouveaux devis et commandes sous verrou serveur et éviter les doublons entre postes. Ne pas rejouer 001–004 déjà appliquées.
5. Vérifier la connexion, les sept rôles, une écriture autorisée, une écriture refusée, la révocation d'un accès, la lecture d'un fichier et une sauvegarde. Contrôler les en-têtes sur l'URL publique après le proxy.

Ne pas déclarer l'isolation des rôles effective tant que 005 n'est pas appliquée. Ne pas réactiver les inscriptions publiques pour résoudre un problème de connexion. Le serveur SMTP et la vérification de propriété des adresses historiques doivent être traités avant les nouvelles invitations. Les informations légales doivent être confirmées par l'entreprise avant émission d'une facture.

## Contrat pour les autres clients

- Lire via `zp_load_workspace()` ; l'identité et les données autorisées sont renvoyées ensemble.
- Détecter les changements de version ou de rôle via `zp_workspace_meta()`.
- Sauvegarder via `zp_save_workspace(expected_version, new_state, client_id)` ; conserver les modifications en attente en cas de conflit ou d'erreur.
- Utiliser les opérations dédiées pour la validation des factures, les comptes, les corrections de pointage et les restaurations. Ne pas écrire directement dans les tables protégées.
- Envoyer les fichiers dans `zp-files` sous `<auth.uid>/<dossier>/<année>/<uuid>.<extension>`, sans remplacement d'un objet existant. Conserver une référence `zpfile:<chemin>` et renouveler les URL signées à la lecture.

## Sauvegarde et reprise

Le snapshot métier contient le workspace. L'export ZIP v8 ajoute ses pièces jointes référencées, leurs empreintes SHA-256, les métadonnées des accès et les documents émis. Il **ne constitue pas une sauvegarde complète de Supabase** : Auth, mots de passe, messages, journal serveur et configuration ne sont pas restaurés par cet import. Les comptes actuels et les pièces émises restent conservés lors d'une restauration métier.

Prévoir séparément la sauvegarde externalisée de PostgreSQL, des objets Storage et de la configuration, ainsi qu'un exercice de reprise isolé. Les fichiers de production et les notes privées ne doivent jamais être ajoutés au dépôt.

Après 005, revenir au frontend v7 réouvrirait le problème de droits ou rendrait l'application inutilisable. Conserver un client v8 compatible et corriger en avant ; ne pas rétablir les anciens droits globaux comme simple procédure de retour arrière.

## Limites à recetter

La v8 renforce l'application existante. Le workspace reste un document partagé ; la normalisation du pointage, du stock et du planning en tables métier constitue une étape ultérieure. Les conflits portant sur le même champ nécessitent une résolution explicite. Le fonctionnement hors ligne complet, l'application iOS, la signature client, les règles de paie/congés propres à l'entreprise et le circuit de dépôt comptable doivent être recettés séparément. Les PDF issus du moteur HTML sont principalement des images ; ce format n'est pas Factur-X.
