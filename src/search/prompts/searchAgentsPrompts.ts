import promptsData from './searchAgentsPrompts.json';

type AgentPromptConfig = { system_prefix: string; format: string };
type Formats = Record<string, string>;

export function buildSearchAgentSystemPrompt(agentKey: string, dateStr: string): string {
  const agents = promptsData.agents as Record<string, AgentPromptConfig>;
  const formats = promptsData.formats as Formats;

  const agent = agents[agentKey] ?? agents['search.web']!;
  const prefix = agent.system_prefix.replace('{{DATE}}', dateStr);
  const format = formats[agent.format] ?? formats['strict']!;

  return prefix + format;
}
