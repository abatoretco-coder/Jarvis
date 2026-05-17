/**
 * Builds the user message sent to the mail synthesis model.
 * The payload is a JSON object whose fields are documented in mailSynthesisUserTemplate.json.
 */
export function buildMailSynthesisUserPrompt(userText: string, executorResult: string): string {
  return JSON.stringify({ user_request: userText, executor_result: executorResult });
}
