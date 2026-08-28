import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from '@jest/globals';

describe('runtime branch CI contract', () => {
  test('targets canonical main for pushes and pull requests', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    expect(workflow.match(/branches:\s*\[main\]/gu)).toHaveLength(2);
    expect(workflow).not.toMatch(/branches:\s*\[master\]/u);
  });
});
