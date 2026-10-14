import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from '@jest/globals';

const repositoryRoot = resolve(__dirname, '..');
const deploymentInputs = [
  '.env.example',
  'ops/pc/env/pc-preprod-full.env.example',
  'scripts/pc-runtime.ps1',
];

describe('production TTS configuration', () => {
  test.each(deploymentInputs)('%s keeps the native French masculine voice baseline', (path) => {
    const content = readFileSync(resolve(repositoryRoot, path), 'utf8');

    expect(content).toContain('OPENAI_TTS_VOICE=cedar');
    expect(content).toContain('prononciation francaise metropolitaine native, sans accent anglophone');
    expect(content).not.toContain('OPENAI_TTS_VOICE=ash');
  });
});
