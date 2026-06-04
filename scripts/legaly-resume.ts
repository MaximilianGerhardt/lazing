// Resume of the Legaly-patterns roast workstream.
// V_final (V2 synthesis) finished at 11:43:24 + 8 sub-tickets created + approval_requested.
// Max injected a correction "Auch Check Skript bauen" at 11:50:05,
// but the sniper pause (25s) had closed, so no V3 was triggered.
// Status='stuck' in the workstream. We now start V3 manually so the
// user correction flows into the final plan.

import { runIterateResume } from '@/server/agents/tier-orchestrator';

const WS_ID = 'WS-01KQF2RR4VJ7KQQXY51PWM55JX';

async function main() {
  console.log('[1/1] runIterateResume (blocking, läuft 1-3min)…');
  try {
    const res = await runIterateResume(WS_ID);
    console.log('\n=== DONE ===');
    console.log(JSON.stringify(res, null, 2).slice(0, 1000));
  } catch (err) {
    console.error('\n=== FAIL ===');
    console.error((err as Error)?.stack ?? err);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
