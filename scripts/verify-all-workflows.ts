#!/usr/bin/env tsx
/**
 * CI-Gate: verifiziert alle 5 produktiven Workflow-FSM (Welle 3b).
 *
 * Run: `pnpm verify:workflows`
 * Exit-Code 1 bei findings.
 */

import { WORKFLOW_REGISTRY } from '@/lib/workflows/registry';
import { verifyFsm } from '@/lib/workflows/fsm-verifier';

let exitCode = 0;

console.log('# Workflow-FSM-Verification\n');

for (const [id, workflow] of Object.entries(WORKFLOW_REGISTRY)) {
  const result = verifyFsm(workflow);
  if (!result.hasFindings) {
    console.log(`✓ ${id} (${result.reachable.length} states reachable)`);
    continue;
  }
  exitCode = 1;
  console.error(`\n✗ ${id} — findings:`);
  if (result.unreachable.length > 0) {
    console.error(`  unreachable: ${result.unreachable.join(', ')}`);
  }
  if (result.deadlocks.length > 0) {
    console.error(`  deadlocks:   ${result.deadlocks.join(', ')}`);
  }
  if (result.raceConditions.length > 0) {
    for (const r of result.raceConditions) {
      console.error(
        `  race:        ${r.stateA} <-> ${r.stateB} on key '${r.sharedKey}'`,
      );
    }
  }
}

if (exitCode === 0) {
  console.log('\nAll workflows verified clean.');
} else {
  console.error('\nVerification failed.');
}
process.exit(exitCode);
