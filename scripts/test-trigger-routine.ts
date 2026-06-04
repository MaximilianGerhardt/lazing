/**
 * Test-Script: Manueller Trigger der seed-Routinen ohne HTTP-Auth.
 * Nur für lokale Verifikation (Sprint 2 E). Nicht in Production.
 */
import { executeRoutine } from "../lib/routines/runner";

async function main() {
  const id = process.argv[2];
  if (!id) {
    process.stderr.write("usage: tsx scripts/test-trigger-routine.ts <routine-id>\n");
    process.exit(2);
  }
  const result = await executeRoutine(id, { trigger: "manual" });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.status === "failure" ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
