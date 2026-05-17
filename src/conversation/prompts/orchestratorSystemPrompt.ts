import systemPromptData from './orchestratorSystemPrompt.json';

type PromptSection = { id: string; lines: string[] };

export function buildOrchestratorSystemPrompt(): string {
  return (systemPromptData.sections as PromptSection[])
    .map((s) => s.lines.join('\n'))
    .join('\n')
    .trim();
}
