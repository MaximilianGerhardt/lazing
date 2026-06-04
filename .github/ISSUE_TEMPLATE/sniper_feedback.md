---
name: Sniper feedback
about: Report a missing or broken mid-course-correction point in laz.ing
title: "[sniper] "
labels: sniper, ux
---

## Where did you want to intervene?

<!-- Which flow / page / agent run did you want to redirect mid-flight? e.g.
     "Workstream V3 spawned without showing the inject countdown" -->

## What did you try?

<!-- What did you do or expect to do? Inject a comment? Change Org-Filter? Cancel a swarm? -->

## What happened instead?

<!-- Auto-advanced without pause? Inject not picked up? Pause too short / too long? -->

## Was the cap respected?

- [ ] V5 hard cap held
- [ ] Re-Synth limit (3) held
- [ ] Sub-Plan-Roast (Phase RA) — does not apply yet
- [ ] Other: ____________

## Severity

- [ ] Architectural — sniper-hook missing in a long-running flow
- [ ] Bug — hook exists but ignored my input
- [ ] Friction — hook exists but UI lag / unclear / no countdown

## Suggested fix

<!-- Optional. Where in the code do you think the hook belongs?
     e.g. "server/agents/tier-orchestrator.ts after each spawn" -->
