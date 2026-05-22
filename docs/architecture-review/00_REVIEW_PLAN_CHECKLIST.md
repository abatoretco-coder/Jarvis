# Relecture Architecture Jarvis - Plan et Checklist

Objectif: relire ensemble l architecture complete de Jarvis, du signal entrant jusqu au retour adapte a la source (texte/voix).

## Etapes de relecture
- [x] Etape 1 - Sources d entree (texte, voix) et ingestion
- [x] Etape 2 - Normalisation des entrees avant routing
- [x] Etape 3 - Fonctionnement du routing (semantic + orchestrateur + fallback)
- [ ] Etape 4 - Orchestration par action: service appele + execution + construction de reponse
- [ ] Etape 5 - Reexpedition de la reponse vers la source
- [ ] Etape 6 - Adaptation finale selon source texte ou vocale

## Documents de travail (nouveaux)
1. 01_input_sources_and_ingestion.md
2. 02_input_normalization_for_routing.md
3. 03_routing_runtime_engine.md
4. 04_action_orchestration_service_and_response_build.md
5. 05_response_dispatch_to_source.md
6. 06_source_specific_rendering_text_vs_voice.md

## Documents existants a revoir et valider
- [ ] ROUTING_OVERVIEW.md
- [ ] AGENTS_DETECTION_EXECUTION_VIEW.md
- [ ] MUSIC_ACTION_EXECUTION_VIEW.md
- [ ] MUSIC_ROUTING_DECISION_MATRIX.md
- [ ] MUSIC_ROUTING_BUSINESS_MAP.md
- [ ] agents/spotify-agent.md
- [ ] agents/search-agent.md
- [ ] agents/weather-agent.md
- [ ] agents/todo-agent.md
- [ ] agents/mail-agent.md
- [ ] agents/executors-agent.md
- [ ] agents/general-agent.md

## Regle de validation
Quand on relit ensemble une section et que tu confirmes, on coche la case correspondante.
