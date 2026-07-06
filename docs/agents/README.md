# Agents Documentation Index

## Agent docs
- spotify-agent.md
- search-agent.md
- weather-agent.md
- todo-agent.md
- mail-agent.md
- executors-agent.md
- general-agent.md

## Global routing doc
- ../ROUTING_OVERVIEW.md
- ../PROACTIVE_CONTEXT_CACHE.md

Each agent file follows the same structure:
1. Detection
2. Routing path
3. Execution
4. Response construction

For warm-context behavior, use `../PROACTIVE_CONTEXT_CACHE.md` as the source of truth. Agent-specific docs describe live execution; proactive snapshots must stay read-only and must not alter routing priority.
