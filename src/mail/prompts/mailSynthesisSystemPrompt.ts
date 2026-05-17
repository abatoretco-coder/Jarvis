import systemPromptData from './mailSynthesisSystemPrompt.json';

type PromptSection = { id: string; lines: string[] };

export function buildMailSynthesisSystemPrompt(): string {
  return (systemPromptData.sections as PromptSection[])
    .map((s) => s.lines.join(' '))
    .join(' ');
}
