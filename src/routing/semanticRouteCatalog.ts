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
    directAction: 'pause',
    plannerRequired: false,
    examples: ['pause', 'pause la musique', 'arrête le son', 'coupe', 'mets en pause'],
    deterministicResponses: () => SPOTIFY_PAUSE_RESPONSES,
    metadata: { category: 'music', latencyTarget: 40 },
  },
  {
    key: 'spotify.play',
    level: 'E2',
    targetAgentId: 'spotify',
    directAction: 'play',
    plannerRequired: false,
    examples: ['play', 'relance', 'mets le son', 'continuer', 'reprends'],
    deterministicResponses: () => SPOTIFY_PLAY_RESPONSES,
    metadata: { category: 'music', latencyTarget: 40 },
  },
  {
    key: 'spotify.next',
    level: 'E2',
    targetAgentId: 'spotify',
    directAction: 'next',
    plannerRequired: false,
    examples: ['suivant', 'morceau suivant', 'next', 'passe'],
    deterministicResponses: () => SPOTIFY_NEXT_RESPONSES,
    metadata: { category: 'music', latencyTarget: 40 },
  },
  {
    key: 'spotify.previous',
    level: 'E2',
    targetAgentId: 'spotify',
    directAction: 'previous',
    plannerRequired: false,
    examples: ['retour', 'morceau précédent', 'previous', 'avant'],
    deterministicResponses: () => SPOTIFY_PREVIOUS_RESPONSES,
    metadata: { category: 'music', latencyTarget: 40 },
  },
  {
    key: 'spotify.now_playing',
    level: 'E2',
    targetAgentId: 'spotify',
    directAction: 'now_playing',
    plannerRequired: false,
    examples: ['qu\'est-ce qui joue', 'quel morceau', 'actuellement', 'c\'est quoi'],
    deterministicResponses: () => SPOTIFY_NOW_PLAYING_RESPONSES,
    metadata: { category: 'music', latencyTarget: 45 },
  },
  {
    key: 'spotify.list_devices',
    level: 'E2',
    targetAgentId: 'spotify',
    directAction: 'list_devices',
    plannerRequired: false,
    examples: ['quels appareils', 'listes des speakers', 'appareils disponibles'],
    deterministicResponses: () => SPOTIFY_LIST_DEVICES_RESPONSES,
    metadata: { category: 'music', latencyTarget: 50 },
  },
  {
    key: 'spotify.clear_queue',
    level: 'E2',
    targetAgentId: 'spotify',
    directAction: 'clear_queue',
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
    key: 'search.news.weather',
    level: 'E2',
    targetAgentId: 'search',
    directAction: 'weather',
    plannerRequired: false,
    examples: ['quel temps demain', 'météo', 'qu\'est-ce qu\'il fait dehors', 'prévisions'],
    deterministicResponses: () => SEARCH_WEATHER_RESPONSES,
    metadata: { category: 'info', latencyTarget: 50 },
  },
  {
    key: 'search.news.live_sport',
    level: 'E2',
    targetAgentId: 'search',
    directAction: 'live_sport',
    plannerRequired: false,
    examples: ['qui a gagné le match', 'score PSG', 'résultats football', 'live sport'],
    deterministicResponses: () => SEARCH_LIVE_SPORT_RESPONSES,
    metadata: { category: 'info', latencyTarget: 60 },
  },
  {
    key: 'search.news.current_news',
    level: 'E2',
    targetAgentId: 'search',
    directAction: 'current_news',
    plannerRequired: false,
    examples: ['quelles sont les actus', 'les nouvelles du jour', 'actualité', 'news'],
    deterministicResponses: () => SEARCH_CURRENT_NEWS_RESPONSES,
    metadata: { category: 'info', latencyTarget: 60 },
  },
  {
    key: 'search.web.definition',
    level: 'E2',
    targetAgentId: 'search',
    directAction: 'definition',
    plannerRequired: false,
    examples: ['c\'est quoi', 'définition', 'explication rapide', 'qu\'est-ce que'],
    deterministicResponses: () => SEARCH_DEFINITION_RESPONSES,
    metadata: { category: 'info', latencyTarget: 50 },
  },
  {
    key: 'search.web.quick_lookup',
    level: 'E2',
    targetAgentId: 'search',
    directAction: 'quick_lookup',
    plannerRequired: false,
    examples: ['qui est', 'quand', 'où est', 'lookup'],
    deterministicResponses: () => SEARCH_QUICK_LOOKUP_RESPONSES,
    metadata: { category: 'info', latencyTarget: 50 },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// TODO — E2 Routes (6)
// ─────────────────────────────────────────────────────────────────────────────

export const TODO_E2_ROUTES: SemanticRouteDefinition[] = [
  {
    key: 'todo.list_tasks',
    level: 'E2',
    targetAgentId: 'todo',
    directAction: 'list_tasks',
    plannerRequired: false,
    examples: ['mes tâches', 'quoi faire', 'ma todo list', 'liste tâches'],
    deterministicResponses: () => TODO_LIST_TASKS_RESPONSES,
    metadata: { category: 'productivity', latencyTarget: 45 },
  },
  {
    key: 'todo.list_tasks.today',
    level: 'E2',
    targetAgentId: 'todo',
    directAction: 'list_tasks_today',
    plannerRequired: false,
    examples: ['tâches du jour', 'à faire aujourd\'hui', 'le programme du jour'],
    deterministicResponses: () => TODO_LIST_TASKS_TODAY_RESPONSES,
    metadata: { category: 'productivity', latencyTarget: 45 },
  },
  {
    key: 'todo.list_tasks.tomorrow',
    level: 'E2',
    targetAgentId: 'todo',
    directAction: 'list_tasks_tomorrow',
    plannerRequired: false,
    examples: ['tâches demain', 'à faire demain', 'prévu demain'],
    deterministicResponses: () => TODO_LIST_TASKS_TOMORROW_RESPONSES,
    metadata: { category: 'productivity', latencyTarget: 45 },
  },
  {
    key: 'todo.list_tasks.this_week',
    level: 'E2',
    targetAgentId: 'todo',
    directAction: 'list_tasks_this_week',
    plannerRequired: false,
    examples: ['tâches de la semaine', 'cette semaine', 'à faire cette semaine'],
    deterministicResponses: () => TODO_LIST_TASKS_THIS_WEEK_RESPONSES,
    metadata: { category: 'productivity', latencyTarget: 45 },
  },
  {
    key: 'todo.list_tasks.overdue',
    level: 'E2',
    targetAgentId: 'todo',
    directAction: 'list_tasks_overdue',
    plannerRequired: false,
    examples: ['tâches en retard', 'urgent', 'overdue', 'en retard'],
    deterministicResponses: () => TODO_LIST_TASKS_OVERDUE_RESPONSES,
    metadata: { category: 'productivity', latencyTarget: 45 },
  },
  {
    key: 'todo.list_lists',
    level: 'E2',
    targetAgentId: 'todo',
    directAction: 'list_lists',
    plannerRequired: false,
    examples: ['mes listes', 'listes todo', 'liste des listes'],
    deterministicResponses: () => TODO_LIST_LISTS_RESPONSES,
    metadata: { category: 'productivity', latencyTarget: 40 },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// MAIL — E2 Routes (2)
// ─────────────────────────────────────────────────────────────────────────────

export const MAIL_E2_ROUTES: SemanticRouteDefinition[] = [
  {
    key: 'mail.list_inbox',
    level: 'E2',
    targetAgentId: 'mail',
    directAction: 'list_inbox',
    plannerRequired: false,
    examples: ['lis mes emails', 'mes mails', 'inbox', 'lis les mails'],
    deterministicResponses: () => MAIL_LIST_INBOX_RESPONSES,
    metadata: { category: 'communication', latencyTarget: 50 },
  },
  {
    key: 'mail.list_inbox.unread',
    level: 'E2',
    targetAgentId: 'mail',
    directAction: 'list_inbox_unread',
    plannerRequired: false,
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
  ...TODO_E2_ROUTES,         // 6
  ...MAIL_E2_ROUTES,         // 2
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
