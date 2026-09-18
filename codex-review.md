# Resolution — Codex implementation, entry 070 (2026-09-15)

**All findings recorded in this review are resolved.** Codex implemented the
remaining interrupted-run correction after the user requested completion.

An interrupted Timed run uses the simulated time reached until the measurement
window is covered. Thus cancellation or an event limit at 600 ms reports 600 ms,
with the queue average 2.0 and throughput 5/s over that observed interval. A
completed run still reports 1,000 ms, average 1.5 and throughput 3/s for the
same three-request scenario. Interrupting cleanup at or after the boundary
preserves the covered interval. Live mode remains unchanged.

Six new regressions cover cancellation and event limits before, exactly at and
after the boundary. The two before-boundary tests failed before the fix and
passed afterward. Final checks: **428 unit tests in 22 files, 66 Chromium tests,
strict TypeScript checking and production build passed**. An independent
event-by-event check validated 492 intermediate results across nine retention
settings against observed queue transitions. See decisions.md entry 070.

The reviews below are preserved as history; their requests for changes are closed.

---

# Follow-up review — 2026-09-15 (resolved by entry 070)

**The two previous findings are resolved. One new interrupted-run issue needs a correction.**

The completed-run queue averages now independently reproduce as **0.5 / 0.9 / 0.9** for retention 0.5 / 2 / 60 seconds. README and the implementation plan correctly describe the released components. The new `endAt` accumulator handles the original cases correctly.

## P2 — Interrupted cleanup can report an interval it has not measured

Location: `src/simulation/engine.ts:888–890`, used by `result()` at lines 2287–2288.

`workloadOver()` returns true as soon as only housekeeping remains, even if its clock is still before the end of the arrival window and more expiries are pending inside that window. Cancelling or hitting an event limit then reports the full window. `timeAverage()` fills its unprocessed remainder with the current depth, ignoring those future expiries. This behavior was added in Claude's second entry numbered 068.

Exact reproduction:

- Three Users nodes, each 1 request/second for a 1-second Timed window; drain 10 seconds; request/response bytes 0.
- All three connect to one Application Server (0 ms CPU) → Message Queue → Worker. Queue → Dead-letter queue.
- Queue: 0 ms publish, message bytes 0, failure share 1, maximum attempts 1.
- Worker: 1 CPU slot, concurrency 1, 100 ms CPU. Dead-letter retention 0.5 seconds, replay disabled. Other settings default; links use `INSTANT`.
- Jobs enter the dead-letter queue at 100, 200 and 300 ms, and expire at 600, 700 and 800 ms.
- Step to the first expiry, then cancel. Also reproduce by setting the event limit to that count (52 events in this scenario).

| Result | Clock reached | Reported interval | Average depth | Expired jobs |
| --- | --- | --- | --- | --- |
| Completed | 800 ms; all depth changes handled | 1,000 ms | 1.5 | 3 |
| Cancelled after first expiry | 600 ms | **1,000 ms** | **2.0** | 1 |
| Event limit after first expiry | 600 ms | **1,000 ms** | **2.0** | 1 |

The completed run's 1.5 is correct over the full second. For the interrupted run, 2.0 is the observed average through **600 ms**, but it is incorrectly labeled as a measurement over **1,000 ms**. Its unprocessed expiries at 700 and 800 ms are still relevant to that claimed interval.

Required correction: only retain the full measurement window during interrupted housekeeping when that window has actually been covered. Otherwise report the observed interval, preserving the existing full-window behavior when cancellation/limits occur after the window. Add both cancellation and event-limit regressions with pending expiries **inside** the window. The current new test only places expiries after the window, so it misses this case. Keep genuine drain, Live, completed-run averages, pricing and persistence regressions passing.

## Follow-up verification

- Independent original queue reproductions: all three pass against observed depth transitions.
- `npx vitest run --maxWorkers=2`: **422 passed, 22 files**.
- Independent interruption probe: both cancel and event limit reproduce the new issue above.
- Full Chromium suite on verified-unused port 4193: **66 passed**, zero failed, skipped or flaky cases. Playwright built the current sources first with `npm run build`, including strict TypeScript checking; both passed. The preview stopped after the suite. Report: `C:/Users/divya/AppData/Local/Temp/aparecium-handoff-followup-20260915.json`.
- No application source or tests were changed during this review.

Documentation bookkeeping: there are now two journal entries numbered 068. Preserve the append-only history; subsequent entries should use the next unused number and identify earlier entries by title when ambiguous.

---

# Original review of entry 067 — retained as history

The two findings below were corrected in the follow-up reviewed above.

Reviewed 2026-09-15 (Asia/Calcutta), against the current main application.

**Verdict: request changes.** The four original reproductions are addressed, but the Timed measurement fix introduces an incorrect queue-depth average in a case the new tests miss. A documentation cleanup is also incomplete. No application source or tests were changed during this review.

## P2 — Queue averages stop counting before the measurement window ends

Location: `src/simulation/engine.ts:868–870`, with `src/simulation/metrics.ts:189–192`.

The first housekeeping-only event freezes every backlog accumulator at `workEndMs`. The result is measured over `max(workEndMs, arrivalWindowMs)`, however. If work ends early, a message can wait during that remaining measurement time and have none of that wait counted. Subsequent expiry changes the accumulator's current level to zero; `timeAverage()` uses that later level to fill the gap after the freeze.

Exact engine reproduction (all settings not specified below use existing defaults):

- Timed: 1 request/second for 1 second, drain 10 seconds.
- Users → Application Server → Message Queue → Worker; Message Queue → Dead-letter queue.
- Users: request and response bytes 0. Publisher CPU time 0 ms.
- Message Queue: publish time 0 ms, message bytes 0, failure share 1, maximum attempts 1.
- Worker: CPU time 100 ms. Dead-letter replay disabled.
- All links: 1,000,000 Mbps, 0 ms propagation (`tests/helpers.ts`'s `INSTANT`).

One failed job arrives at the dead-letter queue at exactly 100 ms. All three runs finish successfully and report a 1,000 ms measurement window:

| Retention | Job leaves the queue | Correct average depth over 0–1,000 ms | Reported |
| --- | --- | --- | --- |
| 0.5 s | 600 ms | 0.5 | **0** |
| 2 s | 2,100 ms, after the measured interval | 0.9 | **0** |
| 60 s | Remains beyond the drain | 0.9 | 0.9 |

Verified by stepping the engine one event at a time and integrating the observed depth transitions over the result's measurement interval. The first case holds one message for 500 of the measured 1,000 ms; its average cannot be zero.

Required correction: integrate all depth changes inside the actual measurement interval, and exclude changes after that interval. Merely replacing the freeze argument with `max(workEndMs, arrivalWindowMs)` is insufficient: an expiry at 600 ms still needs to be counted before the 1,000 ms boundary. Add regressions for both expiry before and after that boundary, keeping the existing long-workload, genuine drain and Live checks.

## P3 — Release status still contradicts the handoff

`README.md:346` says the sixteen additions are not part of the running application. `implementation-plan.md:3–16` still marks work as staged/in progress and UI verification as pending. All 31 components are already released. Update the current status text; preserve historical journal entries. The handoff's claim that outdated status notes were corrected is not fully satisfied.

## Verification performed independently

- `npx vitest run --maxWorkers=2`: **419 passed, 22 files**.
- Full `npx playwright test --reporter=json`, with `APARECIUM_TEST_PORT=4192`: **66 passed**, zero failures, skipped cases or flaky cases.
- Port 4192 was verified unused first. Playwright built the current sources with `npm run build` before starting the preview, so strict TypeScript checking and the production build passed. The preview stopped when the suite ended.
- Browser coverage includes opening old IndexedDB queues and refusing future-version projects without overwriting them, plus the pricing and retention regressions.
- Independent pricing probe: 10 writes, 1 measured second, 1,024 bytes per point. One point/write bills 26.9107 GB/month and USD 13.46; 100 points/write bills 2,691.0720 GB/month and USD 1,345.54. Removing the new ledger field gives the same estimates through the historical fallback.
- Independent queue-depth probe: results in the table above. This is a confirmed failure outside the passing suite.
- Browser JSON report: `C:/Users/divya/AppData/Local/Temp/aparecium-handoff-review-20260915.json`.
- No provider prices were refreshed or externally reverified. Browser coverage is Chromium only.

After the corrections, update `claude-handoff.md` and append actual verification to `decisions.md` for another independent review.
