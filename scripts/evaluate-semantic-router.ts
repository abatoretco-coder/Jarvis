import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { analyzeMultiIntentLikelihood } from '../src/routing/multiIntentLikelihood';
import {
  ROUTING_CONFIG_HASH,
  ROUTING_CONFIG_VERSION,
  SEMANTIC_ROUTER_CONFIG_HASH,
} from '../src/routing/deterministic/config/routingDeterministicConfig';
import { trySemanticRouter } from '../src/routing/semanticRouter';

type EvalCase = {
  text: string;
  expectedTop1: string;
  expectedAccepted?: boolean;
  note?: string;
};

function parseArgs(argv: string[]): { file: string } {
  const fileArgIndex = argv.findIndex((arg) => arg === '--file');
  if (fileArgIndex >= 0 && argv[fileArgIndex + 1]) {
    return { file: resolve(argv[fileArgIndex + 1]!) };
  }
  return { file: resolve('eval/routing/semantic-eval-v1.jsonl') };
}

function parseEvalFile(filePath: string): EvalCase[] {
  const content = readFileSync(filePath, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parsed = JSON.parse(line) as Partial<EvalCase>;
      if (!parsed.text || !parsed.expectedTop1) {
        throw new Error(`Invalid case at line ${index + 1}`);
      }
      return {
        text: parsed.text,
        expectedTop1: parsed.expectedTop1,
        expectedAccepted: parsed.expectedAccepted,
        note: parsed.note,
      };
    });
}

async function main(): Promise<void> {
  const { file } = parseArgs(process.argv.slice(2));
  const cases = parseEvalFile(file);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required to evaluate semantic routing.');
  }

  const embeddingConfig = {
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.SEMANTIC_ROUTER_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? '5000'),
  };
  const options = {
    acceptScore: Number(process.env.SEMANTIC_ROUTER_ACCEPT_SCORE ?? '0.84'),
    minMargin: Number(process.env.SEMANTIC_ROUTER_MIN_MARGIN ?? '0.08'),
    multiIntentThreshold: Number(process.env.SEMANTIC_ROUTER_MULTI_INTENT_THRESHOLD ?? '0.5'),
  };

  let passed = 0;
  const failures: Array<Record<string, unknown>> = [];

  console.log(`Semantic eval file: ${file}`);
  console.log(`Routing config: ${ROUTING_CONFIG_VERSION} ${ROUTING_CONFIG_HASH.slice(0, 12)}`);
  console.log(`Semantic config hash: ${SEMANTIC_ROUTER_CONFIG_HASH.slice(0, 12)}`);
  console.log(`Cases: ${cases.length}`);

  for (const testCase of cases) {
    const multiIntent = analyzeMultiIntentLikelihood(testCase.text);
    const result = await trySemanticRouter({
      userText: testCase.text,
      embeddingConfig,
      options,
      multiIntentLikelihood: multiIntent.score,
    });

    const acceptedMatches = testCase.expectedAccepted === undefined || result.accepted === testCase.expectedAccepted;
    const top1Matches = result.top1Intent === testCase.expectedTop1;

    if (acceptedMatches && top1Matches) {
      passed += 1;
      continue;
    }

    failures.push({
      text: testCase.text,
      note: testCase.note,
      expectedTop1: testCase.expectedTop1,
      actualTop1: result.top1Intent,
      expectedAccepted: testCase.expectedAccepted,
      actualAccepted: result.accepted,
      decision: result.decision,
      top1Score: result.top1Score,
      top2Score: result.top2Score,
      margin: result.margin,
      multiIntentScore: multiIntent.score,
    });
  }

  console.log(`Passed: ${passed}/${cases.length}`);
  if (failures.length > 0) {
    console.log('Failures:');
    for (const failure of failures) {
      console.log(JSON.stringify(failure));
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
