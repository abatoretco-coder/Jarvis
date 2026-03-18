import userTemplateData from './musicAgentUserTemplate.json';

const MUSIC_AGENT_USER_PROMPT_TEMPLATE = (userTemplateData.template_lines as string[]).join('\n');

export function buildMusicAgentUserTemplate(input: {
  userText: string;
  musicSituation: string;
  metadataJson: string;
}): string {
  return MUSIC_AGENT_USER_PROMPT_TEMPLATE
    .replace('{{MUSIC_SITUATION}}', input.musicSituation)
    .replace('{{USER_COMMAND}}', input.userText)
    .replace('{{REQUEST_METADATA}}', input.metadataJson);
}
