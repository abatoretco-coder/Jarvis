import systemPromptData from './weatherSystemPrompt.json';

type PromptSection = { id: string; lines: string[] };

export function buildWeatherSystemPrompt(): string {
  return (systemPromptData.sections as PromptSection[])
    .map((s) => s.lines.join(' '))
    .join(' ');
}
