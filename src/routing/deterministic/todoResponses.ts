/**
 * Deterministic Responses — Todo
 *
 * Phrases TTS-friendly pour les actions Todo E2.
 * Stubs Phase 0 — intégrés avec synthesis LLM.
 */

export const TODO_LIST_TASKS_RESPONSES = ['Tu as des tâches à faire.'];
export const TODO_LIST_TASKS_TODAY_RESPONSES = ['Tâches du jour.'];
export const TODO_LIST_TASKS_TOMORROW_RESPONSES = ['Tâches de demain.'];
export const TODO_LIST_TASKS_THIS_WEEK_RESPONSES = ['Tâches de la semaine.'];
export const TODO_LIST_TASKS_OVERDUE_RESPONSES = ['Tu as des tâches en retard.'];
export const TODO_LIST_LISTS_RESPONSES = ['Voici tes listes.'];

export function getTodoResponse(action: string, params?: Record<string, any>): string {
  return 'Tâches récupérées.';
}
