/**
 * Builds the user message sent to the weather synthesis model.
 * The payload is a JSON object whose fields are documented in weatherUserTemplate.json.
 */
export function buildWeatherUserPrompt(userText: string, weather: unknown): string {
  return JSON.stringify({ user_text: userText, weather });
}
