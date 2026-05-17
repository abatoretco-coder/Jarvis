/**
 * Semantic Route Catalog
 *
 * Définition de tous les routages disponibles (D0, E2, E1).
 * Phase 0 : 20 routes E2 + structure pour expansion.
 * Phase 2+ : E1 routes + D0 (si applicable).
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
];

// ─────────────────────────────────────────────────────────────────────────────
// HA EXECUTORS — E2 Routes (placeholder Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

export const HA_E2_ROUTES: SemanticRouteDefinition[] = [
  // Phase 3: ajouter routes HA simples
];

// ─────────────────────────────────────────────────────────────────────────────
// MASTER CATALOG (Phase 0 : E2 seulement)
// ─────────────────────────────────────────────────────────────────────────────

export const SEMANTIC_ROUTES: SemanticRouteDefinition[] = [
  ...SPOTIFY_E2_ROUTES,      // 7
  ...SEARCH_E2_ROUTES,       // 5
  ...WEATHER_E2_ROUTES,      // 4
  ...TODO_E1_ROUTES,         // 6
  ...MAIL_E1_ROUTES,         // 2
  ...HA_E2_ROUTES,           // 0 (Phase 3)
  // Phase 2: E1 routes à ajouter ici
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
    ha_executor: getCatalogByAgent('ha_executor').length,
  };
  return {
    totalRoutes: SEMANTIC_ROUTES.length,
    byLevel,
    byAgent,
  };
}
