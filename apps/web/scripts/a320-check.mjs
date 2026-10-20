// Logic checks for the A320neo model (src/world/airport/a320/check.ts), run in node through vite:
//   node scripts/a320-check.mjs
// Prints a table of the checks and exits non-zero if any fails.

import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let failed = 0;
try {
  const { runA320Checks } = await server.ssrLoadModule('/src/world/airport/a320/check.ts');
  const rows = runA320Checks();
  const w = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`);
    if (!r.ok) failed++;
  }
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${rows.length} checks passed`);
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
