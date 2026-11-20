// The index of the engine exports what its consumers import, and nothing more (REV-46). The bench
// runs with no type check: a name that it imports and that the index lost would fail only when it
// starts. This test reads the imports of each consumer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as engine from '../src/index.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** The values that a file imports from the index of the engine. Types are erased: tsc checks them. */
function importedValues(file: string): string[] {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const names: string[] = [];
  for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'(@kento\/engine|[./]*packages\/engine\/src\/index\.ts)'/g)) {
    if (match[1]) continue;
    for (const part of match[2]!.split(',')) {
      const name = part.trim();
      if (name && !name.startsWith('type ')) names.push(name.split(/\s+as\s+/)[0]!);
    }
  }
  return names;
}

const CONSUMERS = ['eval/martian/run.ts', 'eval/rejected/run.ts', 'apps/runner/src/job.ts', 'apps/runner/test/runner.test.ts'];

test('the index exports every value that the bench and the runner import from it', () => {
  for (const file of CONSUMERS) {
    const names = importedValues(file);
    assert.ok(names.length > 0, `${file} imports nothing from the engine: the pattern of this test is out of date`);
    const missing = names.filter((name) => !(name in engine));
    assert.deepEqual(missing, [], `${file} imports names that the index of the engine does not export`);
  }
});

test('every value of the index has a consumer', () => {
  const used = new Set(CONSUMERS.flatMap(importedValues));
  const unused = Object.keys(engine).filter((name) => !used.has(name));
  assert.deepEqual(unused, []);
});
