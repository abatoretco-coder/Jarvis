import type { AgentRouteEntry } from '../orchestratorRouter';
import type { MessageRecord } from '../repositories/MessageRepository';
import userTemplateData from './orchestratorUserTemplate.json';

export function buildOrchestratorUserPrompt(params: {
  text: string;
  agents: AgentRouteEntry[];
  summary?: string;
  recentMessages: MessageRecord[];
}): string {
  const parts: string[] = [];

  parts.push(userTemplateData.date_line.replace('{{DATE}}', new Date().toISOString().slice(0, 10)));

  if (params.summary?.trim()) {
    parts.push(userTemplateData.summary_line.replace('{{SUMMARY}}', params.summary.trim()));
  }

  if (params.recentMessages.length > 0) {
    const recent = params.recentMessages
      .slice(-3)
      .map((m) => {
        const decision = m.decisionMetadata;
        const context = [
          decision?.kind ? `domaine=${decision.kind}` : '',
          decision?.routeKey ? `route=${decision.routeKey}` : '',
          decision?.operationStatus ? `statut=${decision.operationStatus}` : '',
        ].filter(Boolean);
        return `${m.role === 'user' ? 'U' : 'A'}${context.length ? ` [${context.join(' ')}]` : ''}: ${m.content.slice(0, 240)}`;
      })
      .join('\n');
    parts.push(userTemplateData.recent_messages_line.replace('{{RECENT_MESSAGES}}', recent));
  }

  const agentList = params.agents
    .map((a) => `  ${a.routerId ?? a.agentId}: ${a.hint}`)
    .join('\n');
  parts.push(userTemplateData.agents_line.replace('{{AGENTS_LIST}}', agentList));

  parts.push(userTemplateData.user_message_line.replace('{{USER_TEXT}}', params.text));

  return parts.join('\n\n');
}
