import type { ActionExecutionResult } from '../types';

export function buildDomainRephraseUserPrompt(result: ActionExecutionResult, sourceText: string): string {
  return [
    `Domaine: ${result.domain}`,
    `Action: ${result.actionKey}`,
    `Statut: ${result.status}`,
    'Texte source:',
    sourceText,
  ].join('\n');
}
