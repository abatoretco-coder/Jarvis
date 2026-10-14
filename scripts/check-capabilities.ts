import fs from 'node:fs';
import path from 'node:path';

import { SUPPORTED_ACTIONS } from '../src/capabilities';
import { CAPABILITY_REGISTRY } from '../src/capabilities/capabilityRegistry';
import { ROUTER_EXPOSURE_BY_AGENT } from '../src/conversation/routerAgentCatalog';
import { SEMANTIC_ROUTES } from '../src/routing/semanticRouteCatalog';
import { MUSIC_ROUTING_MATRIX } from '../src/spotify/musicRoutingMatrix';

type CheckResult = {
  handledActionTypes: string[];
  supportedActionTypes: string[];
  missingInCapabilities: string[];
  extraInCapabilities: string[];
  architectureErrors: string[];
};

function uniqSorted(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function listExecutorFiles(executorsDir: string): string[] {
  if (!fs.existsSync(executorsDir)) return [];
  const entries = fs.readdirSync(executorsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => n.endsWith('.ts'))
    .filter((n) => !n.endsWith('.d.ts'))
    .map((n) => path.join(executorsDir, n));
}

function extractActionTypesFromFile(filePath: string): string[] {
  const src = fs.readFileSync(filePath, 'utf8');
  const out: string[] = [];

  // Heuristic: look for direct string comparisons on action.type.
  // Example patterns:
  //   action.type === 'weather.query'
  //   action.type !== 'todo.add_task'
  //   return action.type === "cast.command"
  const re = /\baction\.type\s*(?:===|!==|==|!=)\s*['"]([^'"]+)['"]/g;
  for (;;) {
    const m = re.exec(src);
    if (!m) break;
    const t = (m[1] ?? '').trim();
    if (t) out.push(t);
  }

  return out;
}

function runCheck(): CheckResult {
  const executorsDir = path.resolve(__dirname, '../src/executors');
  const files = listExecutorFiles(executorsDir);

  if (files.length === 0) {
    return {
      handledActionTypes: [],
      supportedActionTypes: uniqSorted([...SUPPORTED_ACTIONS]),
      missingInCapabilities: [],
      extraInCapabilities: [],
      architectureErrors: validateCapabilityArchitecture(),
    };
  }

  const handled = uniqSorted(files.flatMap(extractActionTypesFromFile));
  const supported = uniqSorted([...SUPPORTED_ACTIONS]);

  const handledSet = new Set(handled);
  const supportedSet = new Set(supported);

  const missingInCapabilities = handled.filter((t) => !supportedSet.has(t));
  const extraInCapabilities = supported.filter((t) => !handledSet.has(t));

  return {
    handledActionTypes: handled,
    supportedActionTypes: supported,
    missingInCapabilities,
    extraInCapabilities,
    architectureErrors: validateCapabilityArchitecture(),
  };
}

function validateCapabilityArchitecture(): string[] {
  const errors: string[] = [];
  const semanticKeys = new Set(SEMANTIC_ROUTES.map((route) => route.key));
  const capabilityKeys = new Set(
    CAPABILITY_REGISTRY.flatMap((capability) =>
      capability.routeKey ? [capability.routeKey] : []
    )
  );

  for (const route of SEMANTIC_ROUTES) {
    const matches = CAPABILITY_REGISTRY.filter(
      (capability) => capability.routeKey === route.key
    );
    if (matches.length !== 1) {
      errors.push(`semantic route ${route.key} has ${matches.length} capability projections`);
      continue;
    }
    const capability = matches[0]!;
    if (capability.action !== route.directRequest?.action) {
      errors.push(`action mismatch for ${route.key}`);
    }
    if (capability.plannerRequired !== (route.plannerRequired === true)) {
      errors.push(`planner policy mismatch for ${route.key}`);
    }
    if (route.highRisk === true && capability.effect === 'read') {
      errors.push(`high-risk route ${route.key} is incorrectly classified read-only`);
    }
  }

  for (const capability of CAPABILITY_REGISTRY) {
    if (capability.semanticLevel !== 'none' && !semanticKeys.has(capability.routeKey ?? '')) {
      errors.push(`semantic capability ${capability.routeKey ?? capability.action} has no route`);
    }
    if (!ROUTER_EXPOSURE_BY_AGENT[capability.agent]) {
      errors.push(`capability family ${capability.agent} has no routing exposure strategy`);
    }
  }

  for (const music of MUSIC_ROUTING_MATRIX) {
    if (music.semanticRouteKey && !capabilityKeys.has(music.semanticRouteKey)) {
      errors.push(`music route ${music.semanticRouteKey} is absent from the canonical catalog`);
    }
  }

  return uniqSorted(errors);
}

function main(): void {
  const res = runCheck();

  if (
    res.missingInCapabilities.length === 0 &&
    res.extraInCapabilities.length === 0 &&
    res.architectureErrors.length === 0
  ) {
    // eslint-disable-next-line no-console
    console.log(
      `OK: capability architecture is consistent (routes=${SEMANTIC_ROUTES.length}, catalog=${CAPABILITY_REGISTRY.length}, legacy_actions=${res.supportedActionTypes.length}).`
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.error('ERROR: capabilities/executors mismatch');
  if (res.missingInCapabilities.length) {
    // eslint-disable-next-line no-console
    console.error('Missing in SUPPORTED_ACTIONS (handled by executors but not advertised):');
    for (const t of res.missingInCapabilities) {
      // eslint-disable-next-line no-console
      console.error(`  - ${t}`);
    }
  }
  if (res.extraInCapabilities.length) {
    // eslint-disable-next-line no-console
    console.error('Extra in SUPPORTED_ACTIONS (advertised but not detected in executors):');
    for (const t of res.extraInCapabilities) {
      // eslint-disable-next-line no-console
      console.error(`  - ${t}`);
    }
  }
  if (res.architectureErrors.length) {
    // eslint-disable-next-line no-console
    console.error('Capability architecture drift:');
    for (const error of res.architectureErrors) {
      // eslint-disable-next-line no-console
      console.error(`  - ${error}`);
    }
  }

  process.exitCode = 1;
}

main();
