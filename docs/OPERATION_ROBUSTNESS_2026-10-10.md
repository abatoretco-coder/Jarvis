# Robustesse transversale des opérations — 2026-10-10

## Règle de contrat

Une réponse HTTP 2xx confirme la réception de la requête, pas nécessairement l'effet physique. Les réponses existantes restent compatibles et peuvent désormais inclure `operationStatus` :

- `succeeded` : l'état cible a été relu et confirmé ;
- `accepted` : le connecteur a accepté la commande, mais l'effet n'est pas encore prouvé ;
- `partial` : réservé aux opérations composées dont une partie seulement a abouti ;
- `uncertain` : la commande a pu être acceptée, mais la lecture de réconciliation n'a pas permis de conclure ;
- `failed` : l'exécution a été rejetée ou toutes les étapes ont échoué de manière certaine.

`status: "ok"` (maison) et `status: "success"` (musique) sont conservés pour les clients historiques. Les nouveaux clients utilisent `operationStatus` en complément. Les scènes exposent en plus `contractVersion: 2` et `outcome: confirmed | accepted | partial | failed | uncertain`; leur champ `status` historique reste présent.

## Idempotence des mutations

Les mutations `/v1/home/**` et `POST /v1/music/actions` acceptent `Idempotency-Key` (8 à 128 caractères ASCII sûrs). La portée associe l'identité authentifiée, la clé, la route, la méthode et l'empreinte canonique des paramètres pendant cinq minutes :

- deux requêtes identiques simultanées partagent une seule exécution et la seconde reçoit `Idempotent-Replay: true` ;
- une même clé avec des paramètres différents renvoie `409 idempotency_key_conflict` ;
- une réponse incertaine est conservée et n'est jamais rejouée automatiquement ;
- l'absence de clé reste temporairement tolérée pour les anciens clients et les parcours vocaux internes.

Le cache est volontairement borné à 2 048 entrées et conservé en mémoire. Il absorbe les doubles clics et retries réseau d'une instance, mais ne constitue pas une garantie durable entre plusieurs instances ou après redémarrage.

## Budgets de réconciliation

| Action | Fenêtre serveur indicative | Timeout client |
|---|---:|---:|
| Lumière / interrupteur | 10 × 300 ms | 12 s |
| Robot | 12 × 1 s | 22 s |
| Télévision au démarrage | 20 × 1 s | 32 s |
| Action maison générique | 8 × 500 ms | 15 s |
| Scène multi-étapes | bornée par ses étapes | 35 s |
| Spotify | réconciliation client | 60 s |

Un timeout de transport avant preuve d'acceptation reste un échec de transport. Un timeout de lecture après envoi devient `uncertain`, jamais un échec physique certain. Les clients ne réessayent pas automatiquement la mutation.

## Matrice de robustesse

| Parcours | Précondition | Action / preuve disponible | Échec et reprise | Résultat utilisateur |
|---|---|---|---|---|
| Conversation `/v1/ingest` | session et permission valides | identifiant de tour vocal, timeouts et chemins déterministes pour les capacités structurées | erreur explicite, nouvelle tentative bornée selon le connecteur | réponse ou erreur, sans fallback silencieux ajouté |
| Commande maison simple | équipement mappé, HA joignable, autorisation | appel de service ; relecture bornée pour lumière/switch, robot et TV | 502 si appel impossible ; 503 si état lisible mais non convergent | `succeeded` si confirmé, sinon `accepted` quand la preuve n'est pas disponible |
| Action rapide | même contrat que la commande sous-jacente | délégation au même exécuteur | mêmes codes et mêmes vérifications | état propagé à Desktop et Android |
| Scène | toutes les étapes valides avant exécution | préflight intégral, exécution parallèle, résultat par étape | `partial` si une partie échoue ; `failed` si aucune étape ne réussit | Desktop et Android ne transforment plus `partial` en succès complet |
| Nettoyage ciblé Xiaomi | pièces connues et connecteur disponible | acceptation du service `clean_rooms` | 409 si pièces indisponibles, 400 si inconnues, 502 si connecteur en échec | libellé « demande acceptée », pas « nettoyage confirmé » |
| Spotify direct | compte, scope et appareil disponibles | 204 Spotify puis rafraîchissement de situation | erreur 409 du connecteur ; réconciliation bornée côté client | `accepted`, puis confirmation par l'état de lecture ; avertissement si non-convergence |
| Réveil Spotify TV/PC/téléphone | cible logique disponible | orchestration et polling borné de Spotify Connect | erreurs dédiées de lancement ou timeout | aucun succès avant disponibilité de la cible Connect |
| Agenda multi-source | intégrations configurées | lectures parallèles avec résultat partiel déjà représenté | source en erreur isolée des autres | données partielles visibles plutôt qu'échec global |
| Mail / tâches | identité et provider valides | mutations synchrones via connecteur | erreurs du provider propagées | pas de changement dans cette passe ; preuve fonctionnelle à renforcer |
| Santé | dépendance configurée et sondable | cache TTL et sondes courtes selon le contrat santé | `degraded`, `unavailable`, `not_configured` | diagnostic distinct de la simple configuration |
| Audio / Bluetooth VM400 | bearer ou session locale, binaire hôte disponible | commandes système avec timeouts ; tentatives Bluetooth bornées | réponse d'erreur, diagnostic local conservé | pas d'action réelle durant les tests de cette passe |
| Desktop / Android | session OIDC valide | verrouillage des doubles actions par état `busy`, lecture du résultat d'opération | message d'erreur ou non-confirmation | distinction entre accepté, confirmé et partiel |
| Plex | service futur ou non présent dans les parcours audités | aucun nouveau contrat inventé | à traiter lors de l'intégration effective | hors correctifs de cette passe |

## Dix risques prioritaires

1. **Faux succès Home Assistant** — corrigé pour les transitions fiables : l'état est relu avec une fenêtre bornée.
2. **Scène partielle affichée comme complète** — corrigé dans Desktop et Android.
3. **Commande Spotify acceptée mais lecture inchangée** — corrigé : réconciliation client et avertissement après épuisement.
4. **Nettoyage ciblé présenté comme démarré** — corrigé : il est maintenant présenté comme accepté tant que l'état du robot ne le confirme pas.
5. **Idempotence serveur sur les commandes maison/musique** — corrigée pour une instance et une fenêtre de cinq minutes ; la durabilité multi-instance reste hors périmètre.
6. **Budgets de timeout empilés** — alignés par famille d'action ; les connecteurs tiers peuvent toujours dépasser ces fenêtres sans preuve exploitable.
7. **Perte d'une opération en cours lors d'un redémarrage** — risque restant pour les opérations longues sans identifiant persistant.
8. **Preuve hétérogène sur mail, agenda et tâches** — risque restant : certaines mutations prouvent l'objet créé, d'autres seulement l'acceptation du provider.
9. **Audio/Bluetooth synchrone et long** — risque restant : les timeouts existent, mais pas de suivi durable pour les opérations les plus longues.
10. **Dérive de contrat entre quatre clients/dépôts** — réduit par les champs optionnels et les tests de compatibilité ; une spécification partagée versionnée reste souhaitable.

## Correctifs livrés dans cette passe

1. Vérification post-commande bornée pour les états lumière/switch, robot et TV.
2. Propagation de `accepted` / `succeeded` dans les réponses maison et musique sans casser les champs existants.
3. Propagation des scènes partielles jusqu'aux interfaces Desktop et Android.
4. Réconciliation Spotify observable : un état qui ne converge pas n'est plus silencieusement présenté comme réussi.
5. Libellé honnête du nettoyage ciblé Xiaomi : acceptation distincte du démarrage confirmé.
6. Agrégation v2 des scènes : confirmation, acceptation, succès partiel, échec total et incertitude sont distincts.
7. Déduplication serveur bornée, y compris pour les doubles requêtes simultanées et les réponses incertaines.
8. Budgets clients/serveur différenciés pour lumière, robot, télévision, Spotify et scènes.

## Limites et suite minimale

- Ne pas appliquer la même vérification à toutes les commandes : un bouton, une télécommande ou un ajout en file n'ont pas toujours un état cible fiable.
- Persister l'idempotence dans un stockage partagé uniquement si Jarvis devient multi-instance ou si une garantie au-delà d'un redémarrage devient nécessaire.
- Pour les opérations dépassant quelques secondes, introduire un identifiant d'opération et une lecture d'état seulement lorsqu'un vrai besoin apparaît (audio/Bluetooth long, orchestration multi-appareils).
- Aucun test de cette passe ne pilote un périphérique réel ; toutes les preuves sont simulées aux frontières HTTP/clients.

## Avant / après

Avant, l'acceptation HTTP de HA ou Spotify devenait souvent « exécuté » dans l'interface. Une scène HTTP 200 pouvait être partielle sans que les clients le montrent. Après, les contrats existants restent lisibles par les anciens clients, tandis que Desktop et Android distinguent la réception, la confirmation d'état et l'exécution partielle.
