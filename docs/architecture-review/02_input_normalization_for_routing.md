# Etape 2 - Normalisation des entrees avant routing

## But
Comprendre comment Jarvis transforme l entree brute en entree exploitable par le moteur de routing.

## Normalisation texte
1. Nettoyage
- Conversion en texte ligne unique (suppression bruit de formatage).
- Reduction espaces et caracteres parasites.

2. Enrichissement contexte
- Fusion text + contextNote pour construire assistantInputText.

3. Normalisation canal
- channel normalise (format stable) avant usage dans thread/routing.

## Normalisation voix
1. Detection mode voix
- isVoiceRequest selon voiceTurnId et channel.

2. Selection mode de sortie voix
- resolveVoiceResponseMode (short, normal, detailed) selon clientContext + texte.

3. STT
- Local first option: HA STT prioritaire si active.
- Fallback OpenAI ou inverse selon scenario d erreur.
- Transcript final toujours normalize en single-paragraph text.

## Normalisation metier auxiliaire (pre-routing)
1. Multi-intent signal: score calcule avant le semantic router. Si score > seuil, le semantic router est desactive (fallback vers routeur LLM orchestrateur).

## Corrections post-router (ajustements targets LLM)
Apres que le routeur LLM a rendu ses targets, deux heuristiques lexicales corrigent les cas que le LLM gere mal:
1. Meteo locale: lexemes meteo + absence de ville explicite -> injecte la target `weather` (HA etats) + supprime les targets `search.*` (si requete mono-intent).
2. Meteo externe: meme lexemes + ville nommee ou structure externe -> injecte `search.news` a la place.
Ces heuristiques patchent la liste `validTargets` avant l execution, sans repasser par le LLM.

## Output de cette etape
Jarvis obtient un assistantInputText propre, contextualise, traceable, pret pour routing.

## References code
- src/routes/ingest.ts
- src/weather/deterministicWeatherReply.ts
