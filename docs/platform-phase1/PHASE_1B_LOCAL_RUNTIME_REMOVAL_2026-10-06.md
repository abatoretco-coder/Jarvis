# Phase 1B — retrait du runtime IA local

Date : 2026-10-06.

## Statut

Terminée. Cette tranche clôt avec la phase 1A la nouvelle **roadmap 1A — retrait du runtime IA local**.

## Périmètre livré

- suppression du client Ollama et des branches locales encore présentes dans le calendrier, les tâches, le mail, la musique, les résumés, Culture, le rendu et l'orchestrateur ;
- suppression du service Compose Ollama, de son volume GPU et de son réseau dédié sur le profil PC ;
- suppression de l'obligation Ollama sur les manifests PC et NAS ;
- profils `.env.pc` et `.env.nas` basculés sur `LLM_PROVIDER=openai` ;
- script de sélection PC/NAS réécrit pour valider OpenAI sans afficher les clés et sans lancer d'appel facturable lors du smoke test ;
- validation de déploiement mise à jour pour refuser tout provider autre qu'OpenAI ;
- suppression des anciens scripts de comparaison de modèles locaux ;
- documentation active du routeur sémantique corrigée pour son client embeddings OpenAI-only.

Les fichiers `.env.pc` et `.env.nas` restent ignorés par Git. Aucun secret n'est ajouté au dépôt.

## Hors périmètre volontaire

- OpenWakeWord est conservé ;
- Kokoro et Whisper Desktop étaient conservés dans cette tranche ; ils ont depuis été retirés par la phase 1D audio cloud ;
- les documents historiques de baseline restent intacts lorsqu'ils décrivent fidèlement l'état passé.

## Garanties

- aucune image, volume ou réseau Ollama n'est requis pour démarrer le graphe Compose PC ;
- aucun téléchargement de modèle n'est effectué par les scripts ;
- les commandes Home Assistant déterministes ne dépendent pas d'un modèle local ;
- le profil NAS est préparé mais n'est pas déployé dans cette tranche.
