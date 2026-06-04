// Resume des Legaly-Patterns-Roast-Workstreams.
// V_final (V2-Synthesis) ist 11:43:24 fertig + 8 Sub-Tickets created + approval_requested.
// Max hat 11:50:05 eine Korrektur „Auch Check Skript bauen" injiziert,
// aber die Sniper-Pause (25s) war zu, also kein V3 ausgelöst.
// Status='stuck' im Workstream. Wir starten jetzt V3 manuell, sodass die
// User-Korrektur in den finalen Plan einfließt.

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
