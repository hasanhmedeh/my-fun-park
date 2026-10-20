// Logic checks for the airfield's plan and pavement (src/world/airport/airfield-check.ts), run in
// node through vite:
//   node scripts/airfield-check.mjs
// Prints a table of the checks and exits non-zero if any fails.

import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let failed = 0;
try {
  const { runAirfieldChecks } = await server.ssrLoadModule('/src/world/airport/airfield-check.ts');
  const rows = runAirfieldChecks();
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
