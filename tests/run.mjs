/*
 * Runs every suite and exits non-zero if any of them fail.
 *
 * Suites run one at a time: each drives a real browser at real speed, and
 * running them together would make the timing-sensitive assertions flaky.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

const run = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(here, file)], { stdio: 'inherit' });
  child.on('close', (code) => resolve(code === 0));
});

let failed = 0;
for (const suite of suites) {
  if (!(await run(suite))) failed++;
}

console.log(failed
  ? `\n${failed} of ${suites.length} suite(s) failed`
  : `\nall ${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
