# Completion by Codex — entry 070 (2026-09-15)

The user asked Codex to finish the remaining follow-up. The interrupted-run
measurement issue is now fixed: early cancellation or an event limit uses the
clock reached; stopping later housekeeping preserves the covered measurement
window. Completed and Live behavior is preserved.

Changed `src/simulation/engine.ts`, added six regressions in
`tests/job-services.test.ts`, and updated the required documentation. The two
new before-boundary cases failed on the old behavior (1,000 ms instead of
600 ms), then passed with the fix. Boundary and later-stop cases also pass.

Final verification: **428 unit tests, 66 Chromium tests, strict TypeScript
checking and production build passed**. An independent 492-snapshot probe
confirmed queue averages and ledger durations across nine expiry settings.
`decisions.md` entry 070 records actual commands and results;
`codex-review.md` marks the findings resolved. No further handoff correction
is outstanding. Existing model limitations remain documented in `future.md`.

---

# Earlier handoff to Codex — entries 067 and 068 (2026-09-15)

Entry 067 fixed the four reproduced bugs. Codex's review (`codex-review.md`)
requested two changes; entry 068 makes them. Nothing was copied from
`.implementation/all-components`. No provider rate, catalog file or default
value changed in either entry. This file stops at the handoff; the independent
review is Codex's.

## Entry 068 — what changed and why

### P2 — the queue average ended too early

**Wrong in 067.** Once only housekeeping remained, every backlog depth
accumulator was frozen at `workEndMs` (the last event that moved work). But the
result is measured over `max(workEndMs, arrivalWindowMs)`. When work finished
before the arrival window did, a message waiting during the rest of the window
had none of that wait counted, and `timeAverage()` filled the gap with the
level *after* a later expiry — zero.

**Correction.**

| File | Change |
|---|---|
| `src/simulation/metrics.ts` | `freeze(time)` → `endAt(time)`: the accumulator is told where the measured interval ends. `advanceTo` integrates up to `min(time, endTime)`; `timeAverage(endTime)` clamps to the same end. A change before the end counts as ever; a change after it integrates the level that held up to the end and no further; level and peak still move. |
| `src/simulation/engine.ts` | At housekeeping-only detection, `backlog.depthAcc.endAt(this.measuredEndMs())` where `measuredEndMs() = max(workEndMs, arrivalWindowMs)` — final at that moment because housekeeping never creates work. `result()` uses `workloadOver()` (Timed, and either completed or housekeeping-only) to pick that interval, so a run cancelled or stopped at a limit *during* housekeeping is measured over the workload's interval, not the clock: the housekeeping was cut short, the workload was not. Otherwise unchanged: Live measures the clock; a genuinely cut-short run measures the time reached. |
| `tests/primitives.test.ts` | Accumulator test rewritten for `endAt`: change inside the interval → 0.5; after it → 0.9 (also when asked for a later end); never told → counts to whatever end is asked. |
| `tests/job-services.test.ts` | Codex's exact scenario (`oneDeadLetter`): expiry inside the interval (retention 0.5 s → 0.5), after it (2 s → 0.9), never within the drain (60 s → 0.9); plus a limit reached during housekeeping (three jobs, stop after the first of three expiries → same 1,000 ms interval, same 1.7 average, `expired: 1` vs `3`). The 067 checks stay: retention reproduction, genuine drain, drain too short, Live, bounded ten-job average. |

### P3 — stale release status

| File | Change |
|---|---|
| `README.md` | Closing line now says all thirty-one components are in the running application (entries 062–066) and points to the plan as history. Unit count 422. |
| `implementation-plan.md` | "Status: complete"; the stage table carries the status each stage reached (released / priced, with entry numbers); the staged copy is named a reference only; the delivered-per-component list and final gates are in the past tense; what remains outside the models points to future.md. Historical journal entries untouched. |
| `architecture.md`, `techniques.md` | ADR-011's amendment and the "Housekeeping is not workload" technique rewritten for `endAt`, naming the 067 error and the 068 correction. |
| `acceptance-audit.md`, `decisions.md` | Entry 068 lines with the actual results. |

## Reproduction results — before (067) and after (068)

Codex's engine scenario, run unchanged: Timed, 1 request/s for 1 s, drain 10 s;
Users (0 bytes) → Server (0 ms CPU) → Queue (0 ms publish, 0 bytes, failure
share 1, 1 attempt) → Worker (100 ms); Queue → Dead-letter queue (replay off);
`INSTANT` links. One job dead-lettered at 100 ms; all runs `completed`,
`simulatedMs` 1000.

| Retention | Job leaves the queue | Correct average | 067 reported | 068 reports |
|---|---|---|---|---|
| 0.5 s | 600 ms | 0.5 | **0** | **0.5** |
| 2 s | 2,100 ms (inside the drain, after the interval) | 0.9 | **0** | **0.9** |
| 60 s | never within the drain | 0.9 | 0.9 | 0.9 |

Limit during housekeeping (3 requests/s, retention 1 s; jobs dead-lettered at
100 / 433 / 767 ms, expiring at 1,100 / 1,433 / 1,767 ms; event limit set to
stop after the first expiry): full run 1,000 ms, average 1.7, `expired: 3`; cut
run `incomplete`, 1,000 ms, average 1.7, `expired: 1`. Under 067 the full run's
average was 1.0 (accumulators ended at 767 ms).

Unchanged from 067 (re-run): stream with no consumer, retention 0.01 s vs 5 s →
both 1,000 ms and 10/s, the 5 s case still `expired: 10`; slow worker draining
a stream → 3,005 ms; drain too short → 1,500 ms; Live stepped to 2,000 ms → 2,000.

## Commands run and their actual outcomes

| Command | Outcome |
|---|---|
| `npx tsc --noEmit` | passes (after each change) |
| `npx vitest run` | **422 passed, 22 files** (419 → 422: 3 new in `job-services`, 1 rewritten in `primitives`) |
| `npx vitest run tests/job-services.test.ts` | 21 passed |
| `npx vitest run tests/primitives.test.ts` | 13 passed |
| `npm run build` | succeeds; the usual "chunks larger than 500 kB" advisory |
| `npx playwright test` (full, fresh build; stale :4173 preview killed first) | **66 passed** — no browser test changed, but the engine did |
| *reverted to 067 behaviour* (`freeze` semantics, `endAt(workEndMs)`, completed-only interval) → `vitest tests/job-services.test.ts tests/primitives.test.ts` | 4 failed as intended: inside-interval 0 vs 0.5; after-interval 0 vs 0.9; limit-during-housekeeping 1.0 vs 1.7; accumulator 0.9 vs 0.5. 30 passed. Sources then restored (verified by grep). |
| `npm run prices:check` | **not run** — no catalog, rate or refresh-script change in 067 or 068 |

## Remaining concerns or limitations

- **Two moments in one result.** A Timed result's interval and its time-averages
  describe `[0, max(workEndMs, arrivalWindowMs)]`; retained and expired counts
  describe the state after the drain's housekeeping, which still runs. The
  results sheet does not yet show the housekeeping's end time (future.md).
- **`endAt` is applied only to backlog depth accumulators** (`QueueModel`,
  `DeadLetterModel`, `StreamBacklog`), the only accumulators `jobMaintenance`
  touches. Another maintenance path updating another accumulator would need it.
- **Housekeeping-only detection** relies on two invariants that hold today and
  are stated in a comment in `step()`: `maintenanceAt` has exactly one entry per
  pending `jobMaintenance` event, and no `jobMaintenance` handler schedules
  work. If either changed, `measuredEndMs()` could be told too early.
- **A limit hit during housekeeping** now reports the workload's interval with
  status `incomplete` and the generic "covers only part of the configured
  duration" reason. The interval and averages are honest for the workload; the
  reason text is the existing generic one and does not say that only the
  housekeeping was cut short.
- **Monitoring ingestion** still bills `requests × recordBytes` from the canvas
  (identical today to measured bytes); the time-series store bills measured
  bytes. Listed in future.md.
- **Start-up fallback** (067): if the most recent saved project cannot be
  opened, the next readable one opens, else a starter is created; the refused
  project shows in the list with no reason beyond the toast (future.md).
- Chromium only.

## Entry 067 — kept for reference

Files: `src/simulation/models/data-service.ts`, `src/simulation/types.ts`,
`src/simulation/engine.ts`, `src/simulation/metrics.ts`, `src/pricing/pricing.ts`,
`src/storage/run-schema.ts`, `src/domain/defaults.ts`,
`src/features/editor/store.ts`; tests in `second-sixteen-pricing`,
`job-services`, `primitives`, `persistence`, and browser specs `data-services`,
`remaining-components`, `persistence-regressions`.

1. **Time-series ingestion** — engine measures `ingestedBytesByNodeId` (bytes the
   writes carried); pricing bills those, with a canvas fallback
   (writes × points × bytes) for runs saved before the field. 100 points/write:
   USD 13.46 → USD 1,345.54 (1 point unchanged at 13.46). Both saved-run shapes
   validate. Confirmed independently by Codex.
2. **Timed measurement** — `workEndMs`; interval `max(workEndMs,
   arrivalWindowMs)`; retention 5 s: 5,905 ms → 1,000 ms. Corrected in 068 as
   above.
3. **Older queues** — `upgradeDocument` fills `processingFailureShare` /
   `maxAttempts` / `retryDelayMs` (0 / 3 / 100), keeps explicit values; browser
   test seeds a version-5 record. Confirmed by Codex.
4. **Newer documents** — `unsupportedDocumentReason`; `openProject` refuses
   before upgrading, replacing or saving; `upgradeDocument` throws as backstop;
   start-up and delete open the first readable project. Browser test seeds a
   version-999 record. Confirmed by Codex.
