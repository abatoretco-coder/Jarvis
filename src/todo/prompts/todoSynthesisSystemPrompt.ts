import systemPromptData from './todoSynthesisSystemPrompt.json';

type PromptSection = { id: string; lines: string[] };

export function buildTodoSynthesisSystemPrompt(): string {
  return (systemPromptData.sections as PromptSection[])
    .map((s) => s.lines.join(' '))
    .join(' ');
}
