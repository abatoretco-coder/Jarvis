import { SPOTIFY_CAPABILITY_REGISTRY_VERSION } from '../capabilityRegistry';
import systemPromptData from './musicAgentSystemPrompt.json';

type PromptSection = { id: string; lines: string[] };

const MUSIC_AGENT_SYSTEM_PROMPT_TEMPLATE = (systemPromptData.sections as PromptSection[])
  .map((s) => s.lines.join('\n'))
  .join('\n');

export function buildMusicAgentSystemPrompt(actionCatalog: string): string {
  return MUSIC_AGENT_SYSTEM_PROMPT_TEMPLATE
    .replace('{{CATALOG_VERSION}}', SPOTIFY_CAPABILITY_REGISTRY_VERSION)
    .replace('{{ACTION_CATALOG}}', actionCatalog);
}
