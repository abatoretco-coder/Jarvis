/**
 * Builds the user message sent to the todo synthesis model.
 * The payload is a JSON object whose fields are documented in todoSynthesisUserTemplate.json.
 */
export function buildTodoSynthesisUserPrompt(userText: string, executorResult: string): string {
  return JSON.stringify({ user_request: userText, executor_result: executorResult });
}
