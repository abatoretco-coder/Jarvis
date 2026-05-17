export function enrichWithContextNote(userText: string, contextNote?: string): string {
  const note = contextNote?.trim();
  if (!note) return userText;
  return `Contexte d actualite: ${note}. Question utilisateur: ${userText}`;
}

export function getPersistableUserText(userText: string): string {
  return userText;
}
