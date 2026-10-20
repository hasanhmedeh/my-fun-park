// The A320 flight model's acceptance tests (src/aviation/sim-check.ts), run in node through vite:
//   node scripts/sim-check.mjs
// Prints a table of the checks with the numbers the model produced and exits non-zero if any fails.

import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let failed = 0;
try {
  const { runSimChecks } = await server.ssrLoadModule('/src/aviation/sim-check.ts');
  const t0 = performance.now();
  const rows = runSimChecks();
  const wn = Math.max(...rows.map((r) => r.name.length));
  const wv = Math.max(...rows.map((r) => r.value.length));
  for (const r of rows) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(wn)}  ${r.value.padEnd(wv)}  [${r.target}]`);
    if (!r.ok) failed++;
  }
  console.log(`\n${failed ? `${failed} of ${rows.length} check(s) failed` : `all ${rows.length} checks passed`} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
