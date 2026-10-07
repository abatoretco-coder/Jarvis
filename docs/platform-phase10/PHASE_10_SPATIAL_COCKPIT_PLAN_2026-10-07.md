# Phase 10 — Cockpit spatial Desktop et Android

Statut : **logiciel PC et Android livré — recette matérielle en attente** le 2026-10-07. Le contrat spatial writable, le catalogue de presets et le cockpit Desktop 2D/3D/liste sont actifs en préproduction PC. Android consomme désormais le même snapshot et les mêmes actions avec carte 2D tactile, navigation par pièce, liste accessible et confirmations de risque. La clôture physique reste conditionnée au téléphone USB et aux équipements Home Assistant réels.

## Preuve de validation PC — 2026-10-07

- runtime `pc-preprod` reconstruit et sain sur `127.0.0.1:8090` ; schéma applicatif 8 ;
- domicile « Appartement – Faubourg Saint-Martin » chargé avec six pièces et dix presets ;
- home-store writable amorcé sous `runtime/pc-preprod/data/homes` sans modifier le template ;
- application Windows Tauri reconstruite, empaquetée et lancée sur le PC ;
- cockpit contrôlé visuellement en 1400 × 900 : plan 2D, vue isométrique, liste, sélection de pièce et éditeur propriétaire ;
- conservation du mapping Home Assistant lors de l’édition couverte par un test de non-régression ;
- gate backend : lint, build, typecheck et 572 tests réussis ; gate Desktop : build Tauri et 97 tests réussis.

Cette preuve valide l’usage local sur PC ; elle ne vaut ni clôture de phase 10, ni publication Internet, ni validation du matériel physique.

## Résultat utilisateur

Jarvis devient le cockpit du domicile, pas seulement son interface conversationnelle. Un utilisateur autorisé peut choisir un domicile, parcourir ses pièces en 2D, 3D ou liste, consulter l’état des équipements et les commander. Jarvis Desktop offre en plus la configuration visuelle du plan, des presets et des mappings Home Assistant.

## Existant réutilisé

- `config/homes/<homeId>/home.json` décrit déjà le logement, ses niveaux, pièces, ouvertures, assets et espaces d’automatisation. Ce répertoire est un template en lecture seule dans le runtime PC actuel.
- Le logement courant possède `plan-2d.svg`, `plan-3d.obj` et `plan-3d.mtl`.
- `src/home/HomeCatalog.ts` charge le modèle et maintient des `deviceId` Jarvis indépendants des `entity_id` Home Assistant.
- `GET /v1/home` et `POST /v1/home/actions` exposent un snapshot autorisé et des commandes déterministes.
- Jarvis Desktop possède `src/home`, `HomeView.tsx` et une première carte 2D pilotable.
- Le control plane Desktop expose déjà l’inventaire Home Assistant et les équipements non mappés.

Cette phase étend ces responsabilités ; elle ne crée pas un second modèle domotique.

## Non-objectifs

- Construire un logiciel généraliste d’architecture intérieure ou un éditeur de maillage 3D.
- Dupliquer les intégrations matérielles ou le moteur d’automatisation de Home Assistant.
- Donner aux clients un accès direct à Home Assistant.
- Rechercher une parité pixel à pixel entre Desktop et Android.
- Rendre la 3D obligatoire pour piloter le logement.
- Introduire une plateforme SaaS multi-organisation.

## Architecture retenue

```text
templates RO ---- amorçage/migration ----> home-store runtime sauvegardé
                                               |
                                               v
                             HomeCatalog / validation / mapping HA
                                               |
                        +----------------------+----------------------+
                        |                                             |
                        v                                             v
              snapshot spatial autorisé                  actions déterministes
                   |             |                          registre / droits
                   v             v                              audit / HA
             Desktop 2D/3D   Android 2D/3D
```

Le backend possède le contrat et les invariants. Desktop et Android possèdent uniquement leur rendu, leur navigation et leurs interactions. La conversation, la carte et les fiches équipement convergent vers la même commande backend. Le dépôt fournit des templates immuables ; les modifications de l’utilisateur vivent dans un home-store runtime persistant et chiffré par la procédure de sauvegarde.

## Modèle spatial minimal

Le schéma suivant sera ajouté de façon additive au modèle existant :

- domicile et niveau actifs ;
- pièce et polygone structurel ;
- appareil avec `deviceId`, `roomId`, `presetId` et mapping HA ;
- placement avec position 2D/3D, rotation et échelle ;
- présentation avec libellé, icône et asset optionnel ;
- capacités, état, disponibilité et niveau de risque fournis par le runtime ;
- scènes HA déclarées dans Jarvis avec portée, actions/capacités et niveau de risque, puis explicitement autorisées.

Le placement et le mapping matériel restent séparés. Le remplacement d’une ampoule modifie le mapping HA, pas le `deviceId`, les coordonnées, les droits ou le preset.

## Catalogue initial de presets

Le catalogue reste volontairement court :

1. lumière et lampe variable ;
2. prise commandée ;
3. télévision ou lecteur média ;
4. chauffage ;
5. chauffe-eau ;
6. aspirateur robot ;
7. volet ;
8. sonnette ;
9. caméra ;
10. capteur générique.

Chaque preset définit seulement les domaines/capacités compatibles, les contrôles UI attendus, une icône et éventuellement un asset visuel. Les valeurs de sécurité et les bornes d’action restent imposées par le backend.

## Lot 10A — Contrat et migration

### Travaux

- Versionner le schéma du domicile et valider les fichiers au chargement.
- Créer un home-store runtime distinct du montage `config` en lecture seule et amorcer le domicile existant de façon idempotente.
- Migrer automatiquement le format 1.1 sans supprimer les champs ou assets existants.
- Étendre le snapshot avec domiciles autorisés, niveaux, placements, presets et scènes.
- Ajouter des écritures administratives validées pour placement et mapping, avec concurrence optimiste et audit.
- Réutiliser l’inventaire Home Assistant du control plane pour proposer les entités compatibles.
- Définir des erreurs stables : version en conflit, preset incompatible, entité déjà mappée, pièce absente et appareil indisponible.
- Étendre la sauvegarde/restauration chiffrée au home-store et vérifier sa cohérence avec la base Jarvis.

### Vérification

- Fixtures 1.1 et nouvelle version chargées avec le même résultat fonctionnel.
- Rejet des chemins d’asset hors du répertoire du domicile et des identifiants non autorisés.
- Rejet des assets trop volumineux, formats non autorisés, références distantes et archives/pathnames traversant le répertoire du domicile.
- Tests de droits croisés entre propriétaire, membre, invité et plusieurs domiciles.
- Sauvegarde atomique et restauration du fichier précédent en cas d’échec d’écriture.
- Drill complet récupérant placements, mappings et assets avec la base et l’identité.

## Lot 10B — Desktop, cockpit et édition

### Parcours quotidien

- Choisir le domicile si plusieurs sont accessibles.
- Sélectionner une pièce depuis le plan, l’arborescence ou la recherche.
- Basculer 2D, 3D et liste en conservant la sélection.
- Ouvrir la fiche d’un équipement et utiliser ses contrôles autorisés.
- Déclencher une scène exposée et voir la convergence de l’état réel.
- Depuis la conversation, afficher la pièce ou l’équipement mentionné.

### Parcours propriétaire

- Entrer explicitement en mode édition.
- Choisir un preset, nommer l’équipement et le placer dans une pièce.
- L’associer à une entité Home Assistant filtrée par compatibilité.
- Prévisualiser les changements, enregistrer et relire le snapshot serveur.
- Modifier placement ou mapping sans perdre l’identité Jarvis.
- Gérer les assets et les métadonnées simples du domicile sans terminal.
- Importer uniquement des formats bornés, sans URL distante, script ou référence de texture extérieure au domicile.

### Contraintes UX

- Aucun contrôle critique ne repose uniquement sur un objet 3D difficile à cibler.
- Toutes les opérations sont disponibles au clavier et via une vue en liste.
- Le mode consultation ne montre pas de poignées ou d’outils d’édition.
- Les commandes réversibles peuvent être optimistes ; elles se réconcilient toujours avec l’état HA.
- Les commandes sensibles utilisent la confirmation et l’authentification renforcée déjà définies.

## Lot 10C — Android, cockpit opérationnel

Statut logiciel : **terminé**. L’APK fournit la vue Domicile, la sélection tactile
des pièces, le fallback liste, les commandes compatibles et la réconciliation
périodique avec le backend. Il n’embarque aucune règle d’autorisation locale et
n’utilise plus de clé API de repli. Le build propre, le lint et 34 tests JVM sont
verts. L’installation, l’authentification et la reprise réseau restent à valider
sur le téléphone réel.

- Réutiliser le contrat spatial et les actions backend, sans logique d’autorisation locale concurrente.
- Livrer d’abord sélection du domicile, navigation par pièce, carte 2D, liste, fiches et scènes.
- Ajouter la consultation 3D seulement après mesure sur le téléphone réel.
- Conserver une interface tactile directe : appui pour action principale sûre, fiche pour réglages détaillés.
- Ne pas porter l’éditeur structurel complet ; le Desktop reste l’outil de configuration de référence.
- Valider installation, lancement, authentification, reprise réseau et absence de crash sur l’appareil USB.

## Lot 10D — 3D et matériel réel

- Évaluer le modèle OBJ existant et un format runtime compact sans remplacer les sources avant preuve de bénéfice.
- Charger la 3D à la demande et libérer ses ressources lorsqu’elle n’est plus affichée.
- Fixer des budgets mesurés sur les machines réelles plutôt que des objectifs théoriques.
- Mapper et tester lumière, TV, chauffage et robot depuis Desktop, Android et conversation.
- Tester changement externe dans Home Assistant, perte réseau, redémarrage HA et appareil indisponible.

## Tests et preuves attendues

- Backend : schéma, migration, ownership, IDOR, validation d’assets, concurrence, mapping et commandes.
- Desktop : tests composants, clavier, focus, reflow, erreurs, build Tauri et E2E avec backend réel hermétique.
- Android : tests JVM, tests UI ciblés, installation/lancement USB et journal sans crash fatal.
- Contrats : mêmes fixtures de snapshot et matrice de capacités pour Desktop et Android.
- Performance : ouverture 2D, ouverture 3D, mémoire et interaction mesurées sur le PC cible et le téléphone réel.
- Physique : preuves datées pour lumière, TV, chauffage et robot.

## Déploiement et retour arrière

- Les ajouts de schéma sont additifs pendant toute la phase.
- L’ancienne vue 2D reste utilisable tant que le nouveau cockpit n’a pas passé les tests réels.
- La 3D est contrôlée par une capacité/configuration locale et peut être désactivée sans retirer le pilotage.
- Toute écriture de configuration conserve la version précédente et exige une relecture serveur.
- Le home-store et ses assets font partie de la même génération logique de sauvegarde que la base Jarvis et l’identité ; un jeu incomplet n’est pas présenté comme restaurable.
- Aucun changement de phase 10 n’autorise la publication Internet du PC.

## Ordre d’exécution

1. 10A : contrat, migration, presets et écritures sûres.
2. 10B.1 : cockpit Desktop 2D/liste et fiches universelles.
3. 10B.2 : éditeur Desktop et mapping HA.
4. 10B.3 : rendu 3D Desktop et contexte conversationnel.
5. 10C : cockpit Android, smoke test USB puis 3D conditionnelle.
6. 10D : appareils réels, performance et revue de clôture.

## Critère de clôture

La phase est close lorsque Desktop et Android pilotent les quatre parcours physiques représentatifs, que Desktop configure un équipement complet sans édition manuelle de fichier, que la 2D/liste couvre intégralement le fallback 3D et que les droits produisent le même résultat depuis toutes les interfaces.
