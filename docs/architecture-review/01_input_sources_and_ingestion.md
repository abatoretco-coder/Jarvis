# Etape 1 - Sources d entree et ingestion

## But
Comprendre comment Jarvis recoit une demande selon la source et sur quels endpoints elle arrive.

## Sources d entree
1. Texte direct
- Entree principale via POST /v1/ingest.
- Corps peut contenir text, threadId, clientContext, contextNote.

2. Voix (pipeline en 3 temps)
- STT: POST /v1/stt/:engineId convertit audio -> texte.
- Ingestion: le texte transcrit est envoye a POST /v1/ingest.
- TTS: POST /v1/tts convertit la reponse texte -> audio.

3. Contrat Spotify explicite
- Variante de POST /v1/ingest avec domain=spotify + action (+ slots).
- Branche officielle du workflow global (priorite metier explicite), pas une porte derobee.
- Raison: quand le client donne deja l action exacte, Jarvis n a pas besoin de deviner via le routeur.

## Workflow global d entree (ordre)
1. Requete recue sur /v1/ingest.
2. Si domain=spotify + action valide: execution spotify explicite (branche prioritaire officielle).
3. Sinon: chemin normal texte -> normalisation -> routing -> execution.
4. En mode voix: /v1/stt avant ingest, puis /v1/tts apres ingest.

## Proposition alternative (tout passer par le routeur)
1. Idee
- Supprimer la branche explicite spotify en entree.
- Forcer toute demande spotify a passer par le routeur (comme les autres domaines).

2. Statut actuel
- Non applique dans ce repository: la regle architecture active impose encore la priorite du contrat explicite spotify.

3. Impact attendu si on applique plus tard
- Plus d uniformite conceptuelle (une seule porte d entree logique).
- Moins de determinisme pour les clients qui envoient deja une action explicite.
- Latence potentiellement plus haute sur les commandes spotify simples (car etape routeur/planner supplementaire).

## Indices source et contexte
1. channel
- Priorite: clientContext.channel puis header x-client-channel.
- Utilise pour suivi de thread actif et comportement session.

2. voix
- Header x-voice-turn-id + channel voice declenchent le mode vocal.
- Le mode vocal influence formatage final de la reponse.

3. correlation
- correlation_id transporte pour tracing inter-etapes.

## Ce qui est fait des l entree
1. Validation schema de requete.
2. Verification configuration HA.
3. Resolution thread effectif (fenetre conversation active).
4. Initialisation traces/perf request.

## References code
- src/routes/ingest.ts
- src/conversation/voiceUx.ts
