import fs from 'node:fs';
import path from 'node:path';

import { SUPPORTED_ACTIONS } from '../src/capabilities';

type CheckResult = {
  handledActionTypes: string[];
  supportedActionTypes: string[];
  missingInCapabilities: string[];
  extraInCapabilities: string[];
};

function uniqSorted(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function listExecutorFiles(executorsDir: string): string[] {
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
  };
}

function main(): void {
  const res = runCheck();

  if (res.missingInCapabilities.length === 0 && res.extraInCapabilities.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`OK: capabilities list matches executor-handled action types (count=${res.supportedActionTypes.length}).`);
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

  process.exitCode = 1;
}

main();
