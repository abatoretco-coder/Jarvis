/**
 * Semantic Route Catalog
 *
 * Définition de tous les routages disponibles (D0, E2, E1).
  * Phase 1C : 16 routes E2 (Spotify+Search+Weather) + 34 routes E1 (Spotify+Search+Todo+Mail) = 50 routes.
  * Phase 2 : activation progressive E1 live.
 *
 * Chaque route contient :
 * - key : identifiant unique
 * - level : D0 | E2 | E1
 * - examples : phrasing utilisateur (premier = canonique)
 * - deterministicResponses : fonction retournant réponses non-IA
 */

import type { SemanticRouteDefinition } from './semanticRouter.types';
import {
  SPOTIFY_PAUSE_RESPONSES,
  SPOTIFY_PLAY_RESPONSES,
  SPOTIFY_NEXT_RESPONSES,
  SPOTIFY_PREVIOUS_RESPONSES,
  SPOTIFY_NOW_PLAYING_RESPONSES,
  SPOTIFY_LIST_DEVICES_RESPONSES,
  SPOTIFY_CLEAR_QUEUE_RESPONSES,
  getSpotifyResponse,
} from './deterministic/spotifyResponses';

import {
  SEARCH_WEATHER_RESPONSES,
  SEARCH_LIVE_SPORT_RESPONSES,
  SEARCH_CURRENT_NEWS_RESPONSES,
  SEARCH_DEFINITION_RESPONSES,
  SEARCH_QUICK_LOOKUP_RESPONSES,
  getSearchResponse,
} from './deterministic/searchResponses';

import {
  TODO_LIST_TASKS_RESPONSES,
  TODO_LIST_TASKS_TODAY_RESPONSES,
  TODO_LIST_TASKS_TOMORROW_RESPONSES,
  TODO_LIST_TASKS_THIS_WEEK_RESPONSES,
  TODO_LIST_TASKS_OVERDUE_RESPONSES,
  TODO_LIST_LISTS_RESPONSES,
  getTodoResponse,
} from './deterministic/todoResponses';

import {
  MAIL_LIST_INBOX_RESPONSES,
  MAIL_LIST_INBOX_UNREAD_RESPONSES,
  getMailResponse,
} from './deterministic/mailResponses';

// ─────────────────────────────────────────────────────────────────────────────
// SPOTIFY — E2 Routes (7)
// ─────────────────────────────────────────────────────────────────────────────

export const SPOTIFY_E2_ROUTES: SemanticRouteDefinition[] = [
  {
    key: 'spotify.pause',
    level: 'E2',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'pause' },
    plannerRequired: false,
    examples: ['pause', 'pause la musique', 'arrête le son', 'coupe la musique', 'mets en pause'],
    deterministicResponses: () => SPOTIFY_PAUSE_RESPONSES,
    metadata: { category: 'music', latencyTarget: 40 },
  },
  {
    key: 'spotify.play',
    level: 'E2',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'play' },
    plannerRequired: false,
    examples: ['play', 'relance', 'mets le son', 'continuer', 'reprends'],
    deterministicResponses: () => SPOTIFY_PLAY_RESPONSES,
    metadata: { category: 'music', latencyTarget: 40 },
  },
  {
    key: 'spotify.next',
    level: 'E2',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'next' },
    plannerRequired: false,
    examples: ['suivant', 'morceau suivant', 'next', 'passe'],
    deterministicResponses: () => SPOTIFY_NEXT_RESPONSES,
    metadata: { category: 'music', latencyTarget: 40 },
  },
  {
    key: 'spotify.previous',
    level: 'E2',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'previous' },
    plannerRequired: false,
    examples: ['reviens au morceau précédent', 'morceau précédent', 'previous', 'avant'],
    deterministicResponses: () => SPOTIFY_PREVIOUS_RESPONSES,
    metadata: { category: 'music', latencyTarget: 40 },
  },
  {
    key: 'spotify.now_playing',
    level: 'E2',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'now_playing' },
    plannerRequired: false,
    examples: ['qu\'est-ce qui joue', 'quel morceau', 'qu\'est-ce qui joue actuellement', 'c\'est quoi le morceau'],
    deterministicResponses: () => SPOTIFY_NOW_PLAYING_RESPONSES,
    metadata: { category: 'music', latencyTarget: 45 },
  },
  {
    key: 'spotify.list_devices',
    level: 'E2',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'list_devices' },
    plannerRequired: false,
    examples: ['quels appareils', 'listes des speakers', 'appareils disponibles'],
    deterministicResponses: () => SPOTIFY_LIST_DEVICES_RESPONSES,
    metadata: { category: 'music', latencyTarget: 50 },
  },
  {
    key: 'spotify.clear_queue',
    level: 'E2',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'clear_queue' },
    plannerRequired: false,
    examples: ['vide la file', 'efface la file', 'clear queue'],
    deterministicResponses: () => SPOTIFY_CLEAR_QUEUE_RESPONSES,
    metadata: { category: 'music', latencyTarget: 40 },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH — E2 Routes (5)
// ─────────────────────────────────────────────────────────────────────────────

export const SEARCH_E2_ROUTES: SemanticRouteDefinition[] = [
  {
    key: 'search.news.external_weather',
    level: 'E2',
    targetAgentId: 'search',
    directRequest: { domain: 'search.news', action: 'external_weather' },
    plannerRequired: false,
    examples: ['météo à Paris demain', 'quel temps à Florence samedi', 'prévisions à Londres', 'météo à Rome la semaine prochaine'],
    deterministicResponses: () => SEARCH_WEATHER_RESPONSES,
    metadata: { category: 'info', latencyTarget: 50 },
  },
  {
    key: 'search.news.live_sport',
    level: 'E2',
    targetAgentId: 'search',
    directRequest: { domain: 'search.news', action: 'live_sport' },
    plannerRequired: false,
    examples: ['qui a gagné le match', 'score PSG', 'résultats football', 'live sport'],
    deterministicResponses: () => SEARCH_LIVE_SPORT_RESPONSES,
    metadata: { category: 'info', latencyTarget: 60 },
  },
  {
    key: 'search.news.current_news',
    level: 'E2',
    targetAgentId: 'search',
    directRequest: { domain: 'search.news', action: 'current_news' },
    plannerRequired: false,
    examples: ['quelles sont les actus', 'les nouvelles du jour', 'actualité', 'news'],
    deterministicResponses: () => SEARCH_CURRENT_NEWS_RESPONSES,
    metadata: { category: 'info', latencyTarget: 60 },
  },
  {
    key: 'search.web.definition',
    level: 'E2',
    targetAgentId: 'search',
    directRequest: { domain: 'search.web', action: 'definition' },
    plannerRequired: false,
    examples: ['c\'est quoi', 'définition', 'explication rapide', 'qu\'est-ce que'],
    deterministicResponses: () => SEARCH_DEFINITION_RESPONSES,
    metadata: { category: 'info', latencyTarget: 50 },
  },
  {
    key: 'search.web.quick_lookup',
    level: 'E2',
    targetAgentId: 'search',
    directRequest: { domain: 'search.web', action: 'quick_lookup' },
    plannerRequired: false,
    examples: ['qui est cette personne', 'quand a lieu cet événement', 'où se trouve ce lieu', 'fais une recherche rapide'],
    deterministicResponses: () => SEARCH_QUICK_LOOKUP_RESPONSES,
    metadata: { category: 'info', latencyTarget: 50 },
  },
];

export const WEATHER_E2_ROUTES: SemanticRouteDefinition[] = [
  {
    key: 'weather.current_temperature',
    level: 'E2',
    targetAgentId: 'weather',
    directRequest: { domain: 'weather', action: 'current_temperature' },
    plannerRequired: false,
    examples: ['quelle température à la maison', 'il fait combien chez moi', 'température actuelle ici'],
    metadata: { category: 'smart_home', latencyTarget: 40 },
  },
  {
    key: 'weather.current_humidity',
    level: 'E2',
    targetAgentId: 'weather',
    directRequest: { domain: 'weather', action: 'current_humidity' },
    plannerRequired: false,
    examples: ['quel est le taux d humidité chez moi', 'humidité actuelle maison', 'hygrométrie du moment'],
    metadata: { category: 'smart_home', latencyTarget: 40 },
  },
  {
    key: 'weather.current_precipitation',
    level: 'E2',
    targetAgentId: 'weather',
    directRequest: { domain: 'weather', action: 'current_precipitation' },
    plannerRequired: false,
    examples: ['il pleut chez moi', 'chance de pluie actuellement maison', 'précipitations en ce moment ici'],
    metadata: { category: 'smart_home', latencyTarget: 40 },
  },
  {
    key: 'weather.current_conditions',
    level: 'E2',
    targetAgentId: 'weather',
    directRequest: { domain: 'weather', action: 'current_conditions' },
    plannerRequired: false,
    examples: ['quel temps fait il à la maison maintenant', 'conditions météo locales actuelles', 'météo locale du moment'],
    metadata: { category: 'smart_home', latencyTarget: 40 },
  },
];

export const SPOTIFY_E1_ROUTES: SemanticRouteDefinition[] = [
  {
    key: 'spotify.search',
    level: 'E1',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'search' },
    plannerRequired: true,
    examples: ['cherche la chanson imagine', 'trouve l album random access memories', 'cherche une playlist focus'],
    metadata: { category: 'music', latencyTarget: 120 },
  },
  {
    key: 'spotify.search_and_play',
    level: 'E1',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'search_and_play' },
    plannerRequired: true,
    examples: ['mets du jazz', 'lance daft punk', 'joue la playlist chill'],
    metadata: { category: 'music', latencyTarget: 130 },
  },
  {
    key: 'spotify.queue_add',
    level: 'E1',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'queue_add' },
    plannerRequired: true,
    examples: ['ajoute ce morceau à la file', 'mets ce titre dans la queue', 'rajoute la chanson en attente'],
    metadata: { category: 'music', latencyTarget: 120 },
  },
  {
    key: 'spotify.transfer',
    level: 'E1',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'transfer' },
    plannerRequired: true,
    examples: ['mets la musique sur le salon', 'transfère sur mon téléphone', 'envoie sur le pc'],
    metadata: { category: 'music', latencyTarget: 110 },
  },
  {
    key: 'spotify.add_to_playlist',
    level: 'E1',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'add_to_playlist' },
    plannerRequired: true,
    examples: ['ajoute ce titre à ma playlist running', 'mets cette chanson dans favoris', 'ajoute au mix du soir'],
    metadata: { category: 'music', latencyTarget: 140 },
  },
  {
    key: 'spotify.volume_set',
    level: 'E1',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'volume_set' },
    plannerRequired: true,
    examples: ['mets le volume à 30', 'baisse le son à 20 pourcent', 'augmente le volume à 60'],
    metadata: { category: 'music', latencyTarget: 110 },
  },
];

export const SEARCH_DEEP_E1_ROUTES: SemanticRouteDefinition[] = [
  {
    key: 'search.deep.analysis',
    level: 'E1',
    targetAgentId: 'search',
    directRequest: { domain: 'search.deep', action: 'analysis' },
    plannerRequired: true,
    examples: ['analyse les causes de la crise énergétique', 'fais une analyse complète de ce sujet', 'explique en profondeur cette problématique'],
    metadata: { category: 'info', latencyTarget: 220 },
  },
  {
    key: 'search.deep.history',
    level: 'E1',
    targetAgentId: 'search',
    directRequest: { domain: 'search.deep', action: 'history' },
    plannerRequired: true,
    examples: ['raconte l historique du f35', 'donne le contexte historique de l otan', 'histoire de la ville de florence'],
    metadata: { category: 'info', latencyTarget: 220 },
  },
  {
    key: 'search.deep.comparison',
    level: 'E1',
    targetAgentId: 'search',
    directRequest: { domain: 'search.deep', action: 'comparison' },
    plannerRequired: true,
    examples: ['compare f22 et f35', 'différences entre react et vue', 'comparaison entre deux modèles'],
    metadata: { category: 'info', latencyTarget: 220 },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// TODO — E2 Routes (6)
// ─────────────────────────────────────────────────────────────────────────────

export const TODO_E1_ROUTES: SemanticRouteDefinition[] = [
  {
    key: 'todo.list_tasks',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'list_tasks' },
    plannerRequired: true,
    examples: ['mes tâches', 'quoi faire', 'ma todo list', 'liste tâches'],
    deterministicResponses: () => TODO_LIST_TASKS_RESPONSES,
    metadata: { category: 'productivity', latencyTarget: 45 },
  },
  {
    key: 'todo.list_tasks.today',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'list_tasks', slots: { period: 'today' } },
    plannerRequired: true,
    examples: ['tâches du jour', 'à faire aujourd\'hui', 'le programme du jour'],
    deterministicResponses: () => TODO_LIST_TASKS_TODAY_RESPONSES,
    metadata: { category: 'productivity', latencyTarget: 45 },
  },
  {
    key: 'todo.list_tasks.tomorrow',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'list_tasks', slots: { period: 'tomorrow' } },
    plannerRequired: true,
    examples: ['tâches demain', 'à faire demain', 'prévu demain'],
    deterministicResponses: () => TODO_LIST_TASKS_TOMORROW_RESPONSES,
    metadata: { category: 'productivity', latencyTarget: 45 },
  },
  {
    key: 'todo.list_tasks.this_week',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'list_tasks', slots: { period: 'this_week' } },
    plannerRequired: true,
    examples: ['tâches de la semaine', 'cette semaine', 'à faire cette semaine'],
    deterministicResponses: () => TODO_LIST_TASKS_THIS_WEEK_RESPONSES,
    metadata: { category: 'productivity', latencyTarget: 45 },
  },
  {
    key: 'todo.list_tasks.overdue',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'list_tasks', slots: { period: 'overdue' } },
    plannerRequired: true,
    examples: ['tâches en retard', 'urgent', 'overdue', 'en retard'],
    deterministicResponses: () => TODO_LIST_TASKS_OVERDUE_RESPONSES,
    metadata: { category: 'productivity', latencyTarget: 45 },
  },
  {
    key: 'todo.list_lists',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'list_lists' },
    plannerRequired: true,
    examples: ['mes listes', 'listes todo', 'liste des listes'],
    deterministicResponses: () => TODO_LIST_LISTS_RESPONSES,
    metadata: { category: 'productivity', latencyTarget: 40 },
  },
  {
    key: 'todo.add_task',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'add_task' },
    plannerRequired: true,
    examples: ['ajoute acheter du pain demain', 'crée une tâche appeler maman', 'note une tâche pour ce soir'],
    metadata: { category: 'productivity', latencyTarget: 90 },
  },
  {
    key: 'todo.complete_task',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'complete_task' },
    plannerRequired: true,
    examples: ['marque la tâche ménage comme faite', 'tâche terminée pour devis', 'valide la tâche rendez-vous'],
    metadata: { category: 'productivity', latencyTarget: 90 },
  },
  {
    key: 'todo.delete_task',
    level: 'E1',
    targetAgentId: 'todo',
    highRisk: true,
    directRequest: { domain: 'todo', action: 'delete_task' },
    plannerRequired: true,
    examples: ['supprime la tâche acheter du lait', 'efface la tâche de demain', 'retire cette tâche'],
    metadata: { category: 'productivity', latencyTarget: 90 },
  },
  {
    key: 'todo.update_task',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'update_task' },
    plannerRequired: true,
    examples: ['déplace la tâche à demain', 'change le titre de la tâche', 'mets la tâche en priorité haute'],
    metadata: { category: 'productivity', latencyTarget: 95 },
  },
  {
    key: 'todo.create_list',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'create_list' },
    plannerRequired: true,
    examples: ['crée une liste vacances', 'nouvelle liste courses', 'ajoute une liste travail'],
    metadata: { category: 'productivity', latencyTarget: 90 },
  },
  {
    key: 'todo.delete_list',
    level: 'E1',
    targetAgentId: 'todo',
    highRisk: true,
    directRequest: { domain: 'todo', action: 'delete_list' },
    plannerRequired: true,
    examples: ['supprime la liste courses', 'efface la liste archives', 'retire cette liste todo'],
    metadata: { category: 'productivity', latencyTarget: 90 },
  },
  {
    key: 'todo.add_checklist_item',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'add_checklist_item' },
    plannerRequired: true,
    examples: ['ajoute préparer les documents à la checklist', 'nouvel élément de checklist', 'rajoute un point à cette tâche'],
    metadata: { category: 'productivity', latencyTarget: 95 },
  },
  {
    key: 'todo.complete_checklist_item',
    level: 'E1',
    targetAgentId: 'todo',
    directRequest: { domain: 'todo', action: 'complete_checklist_item' },
    plannerRequired: true,
    examples: ['coche le point appeler le client', 'marque cet item checklist comme fait', 'valide cet élément de liste'],
    metadata: { category: 'productivity', latencyTarget: 95 },
  },
  {
    key: 'todo.delete_checklist_item',
    level: 'E1',
    targetAgentId: 'todo',
    highRisk: true,
    directRequest: { domain: 'todo', action: 'delete_checklist_item' },
    plannerRequired: true,
    examples: ['supprime cet item de checklist', 'efface le point envoyer le mail', 'retire cet élément de tâche'],
    metadata: { category: 'productivity', latencyTarget: 95 },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// MAIL — E2 Routes (2)
// ─────────────────────────────────────────────────────────────────────────────

export const MAIL_E1_ROUTES: SemanticRouteDefinition[] = [
  {
    key: 'mail.list_inbox',
    level: 'E1',
    targetAgentId: 'mail',
    directRequest: { domain: 'mail', action: 'list_inbox' },
    plannerRequired: true,
    examples: ['lis mes emails', 'mes mails', 'inbox', 'lis les mails'],
    deterministicResponses: () => MAIL_LIST_INBOX_RESPONSES,
    metadata: { category: 'communication', latencyTarget: 50 },
  },
  {
    key: 'mail.list_inbox.unread',
    level: 'E1',
    targetAgentId: 'mail',
    directRequest: { domain: 'mail', action: 'list_inbox', slots: { unread_only: true } },
    plannerRequired: true,
    examples: ['mails non lus', 'emails non lus', 'nouveaux mails', 'non lus'],
    deterministicResponses: () => MAIL_LIST_INBOX_UNREAD_RESPONSES,
    metadata: { category: 'communication', latencyTarget: 50 },
  },
  {
    key: 'mail.search_emails',
    level: 'E1',
    targetAgentId: 'mail',
    directRequest: { domain: 'mail', action: 'search_emails' },
    plannerRequired: true,
    examples: ['cherche mes mails de thomas', 'retrouve le mail du devis', 'recherche les emails sur le contrat'],
    metadata: { category: 'communication', latencyTarget: 120 },
  },
  {
    key: 'mail.send_email',
    level: 'E1',
    targetAgentId: 'mail',
    highRisk: true,
    directRequest: { domain: 'mail', action: 'send_email' },
    plannerRequired: true,
    examples: ['envoie un mail à marie', 'rédige et envoie ce message', 'envoie un email avec ce sujet'],
    metadata: { category: 'communication', latencyTarget: 140 },
  },
  {
    key: 'mail.reply_email',
    level: 'E1',
    targetAgentId: 'mail',
    highRisk: true,
    directRequest: { domain: 'mail', action: 'reply_email' },
    plannerRequired: true,
    examples: ['réponds à ce mail', 'réponds à thomas sur le devis', 'fais une réponse à cet email'],
    metadata: { category: 'communication', latencyTarget: 140 },
  },
  {
    key: 'mail.forward_email',
    level: 'E1',
    targetAgentId: 'mail',
    highRisk: true,
    directRequest: { domain: 'mail', action: 'forward_email' },
    plannerRequired: true,
    examples: ['transfère ce mail à claire', 'fais suivre cet email', 'forward ce message à l équipe'],
    metadata: { category: 'communication', latencyTarget: 140 },
  },
  {
    key: 'mail.mark_read',
    level: 'E1',
    targetAgentId: 'mail',
    directRequest: { domain: 'mail', action: 'mark_read' },
    plannerRequired: true,
    examples: ['marque ce mail comme lu', 'passe cet email en lu', 'mettre le message en lu'],
    metadata: { category: 'communication', latencyTarget: 100 },
  },
  {
    key: 'mail.mark_unread',
    level: 'E1',
    targetAgentId: 'mail',
    directRequest: { domain: 'mail', action: 'mark_unread' },
    plannerRequired: true,
    examples: ['marque ce mail comme non lu', 'remets ce message en non lu', 'passe cet email en non lu'],
    metadata: { category: 'communication', latencyTarget: 100 },
  },
  {
    key: 'mail.trash_email',
    level: 'E1',
    targetAgentId: 'mail',
    highRisk: true,
    directRequest: { domain: 'mail', action: 'trash_email' },
    plannerRequired: true,
    examples: ['mets ce mail à la corbeille', 'supprime cet email', 'jette ce message'],
    metadata: { category: 'communication', latencyTarget: 100 },
  },
  {
    key: 'mail.flag_email',
    level: 'E1',
    targetAgentId: 'mail',
    directRequest: { domain: 'mail', action: 'flag_email' },
    plannerRequired: true,
    examples: ['marque ce mail important', 'flag cet email', 'ajoute un drapeau sur ce message'],
    metadata: { category: 'communication', latencyTarget: 100 },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// HA EXECUTORS — E1 Routes (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

export const HA_E1_ROUTES: SemanticRouteDefinition[] = [
  {
    key: 'executor.greeting',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'greeting' },
    plannerRequired: true,
    examples: ['salut jarvis', 'bonjour', 'hello assistant maison'],
    metadata: { category: 'smart_home', latencyTarget: 80 },
  },
  {
    key: 'executor.help',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'help' },
    plannerRequired: true,
    examples: ['aide moi avec les commandes', 'qu est ce que tu peux faire', 'montre les commandes disponibles'],
    metadata: { category: 'smart_home', latencyTarget: 85 },
  },
  {
    key: 'executor.status',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'status' },
    plannerRequired: true,
    examples: ['etat de la maison', 'status maison', 'resume des capteurs'],
    metadata: { category: 'smart_home', latencyTarget: 90 },
  },
  {
    key: 'executor.timer',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'timer' },
    plannerRequired: true,
    examples: ['mets un minuteur de dix minutes', 'lance un timer de cinq minutes', 'demarre un compte a rebours'],
    metadata: { category: 'smart_home', latencyTarget: 90 },
  },
  {
    key: 'executor.note',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'note' },
    plannerRequired: true,
    examples: ['prends une note', 'note que le colis arrive demain', 'ajoute un memo'],
    metadata: { category: 'smart_home', latencyTarget: 95 },
  },
  {
    key: 'executor.scene_set',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'scene_set' },
    plannerRequired: true,
    examples: ['active la scene cinema', 'mets la scene nuit', 'scene detente dans le salon'],
    metadata: { category: 'smart_home', latencyTarget: 95 },
  },
  {
    key: 'executor.media_play_pause',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'media_play_pause' },
    plannerRequired: true,
    examples: ['mets la tele en pause', 'reprends la lecture media', 'play pause multimedia'],
    metadata: { category: 'smart_home', latencyTarget: 90 },
  },
  {
    key: 'executor.media_next',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'media_next' },
    plannerRequired: true,
    examples: ['morceau suivant sur le media player', 'piste suivante', 'episode suivant'],
    metadata: { category: 'smart_home', latencyTarget: 90 },
  },
  {
    key: 'executor.media_previous',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'media_previous' },
    plannerRequired: true,
    examples: ['revient au media precedent', 'piste precedente', 'episode precedent'],
    metadata: { category: 'smart_home', latencyTarget: 90 },
  },
  {
    key: 'executor.volume_up',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'volume_up' },
    plannerRequired: true,
    examples: ['augmente le volume', 'monte le son du salon', 'plus fort'],
    metadata: { category: 'smart_home', latencyTarget: 85 },
  },
  {
    key: 'executor.volume_down',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'volume_down' },
    plannerRequired: true,
    examples: ['baisse le volume', 'moins fort', 'diminue le son'],
    metadata: { category: 'smart_home', latencyTarget: 85 },
  },
  {
    key: 'executor.mute',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'mute' },
    plannerRequired: true,
    examples: ['coupe le son', 'mute le media player', 'mets en sourdine'],
    metadata: { category: 'smart_home', latencyTarget: 85 },
  },
  {
    key: 'executor.unmute',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'unmute' },
    plannerRequired: true,
    examples: ['remets le son', 'unmute le media player', 'enleve la sourdine'],
    metadata: { category: 'smart_home', latencyTarget: 85 },
  },
  {
    key: 'executor.climate_set',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'climate_set' },
    plannerRequired: true,
    examples: ['mets le chauffage a vingt et un', 'regle la clim a vingt quatre', 'change la temperature du salon'],
    metadata: { category: 'smart_home', latencyTarget: 100 },
  },
  {
    key: 'executor.lock',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'lock' },
    plannerRequired: true,
    examples: ['verrouille la porte entree', 'active la serrure', 'ferme la porte connectee'],
    metadata: { category: 'smart_home', latencyTarget: 95 },
  },
  {
    key: 'executor.unlock',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'unlock' },
    plannerRequired: true,
    examples: ['deverrouille la porte entree', 'ouvre la serrure connectee', 'retire le verrou'],
    metadata: { category: 'smart_home', latencyTarget: 95 },
  },
  {
    key: 'executor.vacuum_start',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'vacuum_start' },
    plannerRequired: true,
    examples: ['demarre l aspirateur robot', 'lance le robot aspirateur', 'commence le nettoyage robot'],
    metadata: { category: 'smart_home', latencyTarget: 95 },
  },
  {
    key: 'executor.vacuum_stop',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'vacuum_stop' },
    plannerRequired: true,
    examples: ['arrete l aspirateur robot', 'stop le robot', 'interromps le nettoyage robot'],
    metadata: { category: 'smart_home', latencyTarget: 95 },
  },
  {
    key: 'executor.cover_open',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'cover_open' },
    plannerRequired: true,
    examples: ['ouvre les volets', 'remonte le store du salon', 'ouvre les stores'],
    metadata: { category: 'smart_home', latencyTarget: 95 },
  },
  {
    key: 'executor.cover_close',
    level: 'E1',
    targetAgentId: 'executors',
    directRequest: { domain: 'executors', action: 'cover_close' },
    plannerRequired: true,
    examples: ['ferme les volets', 'descends le store du salon', 'ferme les stores'],
    metadata: { category: 'smart_home', latencyTarget: 95 },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// MASTER CATALOG (Phase 1C : E2 + E1 — 50 routes)
// ─────────────────────────────────────────────────────────────────────────────

export const SEMANTIC_ROUTES: SemanticRouteDefinition[] = [
  ...SPOTIFY_E2_ROUTES,      // 7
  ...SEARCH_E2_ROUTES,       // 5
  ...WEATHER_E2_ROUTES,      // 4
  ...SPOTIFY_E1_ROUTES,
  ...SEARCH_DEEP_E1_ROUTES,
  ...TODO_E1_ROUTES,
  ...MAIL_E1_ROUTES,
  ...HA_E1_ROUTES,
];

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Récupère toutes les routes d'un niveau spécifique.
 */
export function getCatalogByLevel(level: 'D0' | 'E2' | 'E1'): SemanticRouteDefinition[] {
  return SEMANTIC_ROUTES.filter((r) => r.level === level);
}

/**
 * Récupère toutes les routes d'un agent spécifique.
 */
export function getCatalogByAgent(agentId: string): SemanticRouteDefinition[] {
  return SEMANTIC_ROUTES.filter((r) => r.targetAgentId === agentId);
}

/**
 * Cherche une route par sa clé.
 */
export function findRouteByKey(key: string): SemanticRouteDefinition | undefined {
  return SEMANTIC_ROUTES.find((r) => r.key === key);
}

/**
 * Récupère la réponse déterministe pour une route E2.
 */
export function getRouteDeterministicResponse(route: SemanticRouteDefinition): string {
  if (!route.deterministicResponses) {
    return 'Action effectuée.';
  }
  const responses = route.deterministicResponses();
  return responses.length > 0 ? responses[Math.floor(Math.random() * responses.length)] : 'Action effectuée.';
}

/**
 * Statistiques du catalogue.
 */
export function getCatalogStats() {
  const byLevel = {
    D0: getCatalogByLevel('D0').length,
    E2: getCatalogByLevel('E2').length,
    E1: getCatalogByLevel('E1').length,
  };
  const byAgent = {
    spotify: getCatalogByAgent('spotify').length,
    search: getCatalogByAgent('search').length,
    todo: getCatalogByAgent('todo').length,
    mail: getCatalogByAgent('mail').length,
    executors: getCatalogByAgent('executors').length,
  };
  return {
    totalRoutes: SEMANTIC_ROUTES.length,
    byLevel,
    byAgent,
  };
}
