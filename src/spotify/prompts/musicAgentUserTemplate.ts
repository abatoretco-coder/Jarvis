export const MUSIC_AGENT_USER_PROMPT_TEMPLATE = [
  '{{MUSIC_SITUATION}}',
  '',
  'Commande: "{{USER_COMMAND}}"',
  '{{REQUEST_METADATA}}',
].join('\n');

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
