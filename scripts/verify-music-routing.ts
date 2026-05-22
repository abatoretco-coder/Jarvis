import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { MUSIC_ROUTING_MATRIX } from '../src/spotify/musicRoutingMatrix';

type CommandResult = {
  command: string;
  ok: boolean;
  exitCode: number;
};

function runCommand(command: string): CommandResult {
  const result = spawnSync(command, {
    shell: true,
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });

  const exitCode = result.status ?? 1;
  return {
    command,
    ok: exitCode === 0,
    exitCode,
  };
}

function toMarkdownTable(): string {
  const header = [
    '| action | semantic_level | semantic_route | planner_required | explicit_contract | router_direct | music_planner |',
    '|---|---|---|---:|---:|---:|---:|',
  ];

  const rows = MUSIC_ROUTING_MATRIX.map((entry) => {
    return `| ${entry.action} | ${entry.semanticLevel} | ${entry.semanticRouteKey ?? '-'} | ${entry.plannerRequiredWhenSemantic ? 'yes' : 'no'} | ${entry.explicitContract ? 'yes' : 'no'} | ${entry.routerDirect ? 'yes' : 'no'} | ${entry.musicPlanner ? 'yes' : 'no'} |`;
  });

  return [...header, ...rows].join('\n');
}

function main(): void {
  const startedAt = new Date();
  const artifactsDir = join(process.cwd(), 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });

  const jestJsonPath = join(artifactsDir, 'music-routing-jest-results.json');

  const commands: CommandResult[] = [];
  commands.push(runCommand('npm run build'));
  commands.push(
    runCommand(
      `npm test -- --runTestsByPath tests/music-routing.business.test.ts tests/music-routing.matrix.test.ts --json --outputFile \"${jestJsonPath}\"`,
    ),
  );

  const overallOk = commands.every((step) => step.ok);

  const jestReport = (existsSync(jestJsonPath)
    ? JSON.parse(readFileSync(jestJsonPath, 'utf8'))
    : {
        numTotalTestSuites: 0,
        numPassedTestSuites: 0,
        numFailedTestSuites: 0,
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
      }) as {
    numTotalTestSuites: number;
    numPassedTestSuites: number;
    numFailedTestSuites: number;
    numTotalTests: number;
    numPassedTests: number;
    numFailedTests: number;
  };

  const finishedAt = new Date();
  const report = {
    scope: 'music-routing',
    generatedAt: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    overallOk,
    steps: commands,
    matrixSummary: {
      totalActions: MUSIC_ROUTING_MATRIX.length,
      e2: MUSIC_ROUTING_MATRIX.filter((entry) => entry.semanticLevel === 'E2').length,
      e1: MUSIC_ROUTING_MATRIX.filter((entry) => entry.semanticLevel === 'E1').length,
      none: MUSIC_ROUTING_MATRIX.filter((entry) => entry.semanticLevel === 'none').length,
    },
    jest: jestReport,
  };

  const jsonPath = join(artifactsDir, 'music-routing-verification-report.json');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const mdLines: string[] = [];
  mdLines.push('# Music Routing Verification Report');
  mdLines.push('');
  mdLines.push(`- generated_at: ${report.generatedAt}`);
  mdLines.push(`- duration_ms: ${report.durationMs}`);
  mdLines.push(`- overall_ok: ${report.overallOk ? 'yes' : 'no'}`);
  mdLines.push('');
  mdLines.push('## Steps');
  for (const step of commands) {
    mdLines.push(`- ${step.ok ? 'OK' : 'FAIL'} | ${step.command} | exit_code=${step.exitCode}`);
  }
  mdLines.push('');
  mdLines.push('## Tests');
  mdLines.push(`- suites: ${jestReport.numPassedTestSuites}/${jestReport.numTotalTestSuites} passed`);
  mdLines.push(`- tests: ${jestReport.numPassedTests}/${jestReport.numTotalTests} passed`);
  mdLines.push('');
  mdLines.push('## Routing Matrix');
  mdLines.push('');
  mdLines.push(toMarkdownTable());

  const mdPath = join(artifactsDir, 'music-routing-verification-report.md');
  writeFileSync(mdPath, `${mdLines.join('\n')}\n`, 'utf8');

  if (!overallOk) {
    process.exit(1);
  }
}

main();
