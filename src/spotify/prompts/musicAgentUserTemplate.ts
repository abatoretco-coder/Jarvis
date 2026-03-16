export const MUSIC_AGENT_USER_PROMPT_TEMPLATE = [
  '{{MUSIC_SITUATION}}',
  '',
  'Commande utilisateur: "{{USER_COMMAND}}"',
  '',
  'Reponds avec un JSON (sans markdown) de la forme:',
  '  {"route":"spotify","reason":"...","request":{"domain":"spotify","action":"<action>","slots":{<slots>},"text":"<commande>"}}',
  '  Ajoute "understanding":{"entities":{"artist":"...","album":"...",...}} uniquement si un artiste/album/titre/playlist est explicitement mentionné.',
  'ou si non-musique:',
  '  {"route":"none","reason":"..."}',
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
