# Aparecium acceptance audit

Audited on 2026-09-09 against the linked **System Simulator Plan**, using the
existing implementation as the starting point. The application and its later
canvas-focused redesign were preserved.

## Outcome

The 17 acceptance checks have passing automated coverage. As of decisions.md
entry 057 (2026-09-13), **303 unit tests and all 40 Chromium browser checks pass**
in fresh full runs. Type checking and the production build also passed.
The browser suite builds the production application first, including strict
TypeScript checking. (The figures at the time of the original audit were 68 and
15; the checks themselves are unchanged, and every later feature was added with
its own tests rather than by relaxing one of them.)

## Gaps corrected

- Pending edits are saved before switching projects. Failed saves retain the
  open project for export, and deleting during autosave cannot recreate it.
- Imported histories receive new run IDs and save in the same transaction as
  their project. They cannot take history away from the source project.
- Historical result, cost and catalog fields are validated before import.
  Future schemas or unreadable records are skipped with an explanation. Valid
  histogram overflow bounds survive export/import. The size limit counts bytes.
- Results retain the earlier-configuration label after reopening/importing or
  editing during a run. Switching projects detaches the active simulation.
- Worker crashes settle pending promises; the next run can use the fallback.
- Missing pricing catalogs produce unpriced component rows. Partial cost totals
  do not imply a complete bill or a valid percentage saving.
- Custom monthly running hours affect outbound usage projection as well as
  compute. Comparisons report billing-rate edits and flag payload changes.
- The five learning documents reflect these changes; info.md is now a brief
  introduction. See decisions.md entries 022 onward for actual chronology.

## Acceptance evidence

| Plan check | Verification |
|---|---|
| 1. Same input and seed give identical results | `tests/engine.test.ts`: byte-for-byte reproducibility with cache randomness. |
| 2. Light-load hand calculation | Engine test and starter browser test: mean response 39.877632 ms. |
| 3. Excess traffic queues/rejects/leaves work unfinished | Engine queue, memory and drain-window cases. |
| 4. More CPU improves a CPU-limited case | Engine CPU slot comparison. |
| 5. More RAM alone does not speed CPU | Engine identical-results RAM comparison. |
| 6. 100% cache hits remove database reads | Engine all-hit case. |
| 7. 0% cache hits route reads to database | Engine all-miss case. |
| 8. Misses include lookup overhead | Engine cache-overhead hand calculation. |
| 9. Larger messages take longer on constrained links | Engine payload/bandwidth and directional queue cases. |
| 10. Idle resources retain fixed costs | `tests/pricing.test.ts`: disconnected database provisioning and storage. |
| 11. Missing prices are unpriced | Pricing missing-rate cases and browser missing-catalog test. |
| 12. Billing units/projections are correct | Pricing decimals, monthly hours, usage-rate projection and override cases. |
| 13. Save/reload/export/import preserve projects | `tests/persistence.test.ts` and `e2e/persistence-regressions.spec.ts`: round trips, restored edits/history and separate imported IDs. |
| 14. Previous run inputs remain immutable | Snapshot unit test; browser stale labels and editing-during-run cases. |
| 15. Responsive cancellation and stale-message isolation | Starter browser cancellation/supersession; project-switch regression; `tests/worker-client.test.ts` crash recovery. |
| 16. Unsupported routes are explained | Engine routing cases, the edge-chain cases in `tests/edge.test.ts` (unconnected, ambiguous and looping hops; two DNS on one group of users), and starter browser invalid-design/undo workflow. |
| 17. Starter works without browser errors | `e2e/starter-workflow.spec.ts`, with console/page errors asserted empty. |

These checks establish behavior for their fixtures, not a guarantee for every
possible architecture. The simulation remains a simplified mathematical model.

## Scope and limits

The required browser-only stack, worker, catalogs, project management, editable
pricing, bounded history, sample journeys and comparison interface are present.
The existing four-component scope and deferred features remain as specified.

Provider prices remain explicitly **illustrative**, which the plan permits when
verification is unavailable. The audit read the official [AWS EC2 pricing
page](https://aws.amazon.com/ec2/pricing/on-demand/) and [Google Compute pricing
page](https://cloud.google.com/products/compute/pricing), but did not verify a
complete set of exact region/SKU/charge rows for the shipped catalog. No rates
were relabelled as verified.

Only Chromium is tested. Firefox, WebKit and a formal accessibility audit remain
unverified. Vite still reports a main bundle above its 500 kB warning threshold.
No public hosting or real cloud resources were created. Local storage and
simulation estimates retain the limitations described in README.md.

## Staged expansion verification

Entry 060: 346 unit tests pass. All 42 browser cases pass across a full run (41 passed, one new locator failure) and a final 10-case rerun. The last production build and strict type check pass. These are staged-copy results; the working application remains at entry 057 until final integration.

Entry 062: the staged sixteen kinds' shared code is in the main app behind a release gate; 396 unit tests and 42 browser tests pass, type checking and the production build pass. One of the sixteen, the Document database, is released and has its own browser test.

Entries 063–065: all sixteen staged kinds are released in the main app, each with its own browser case; 396 unit tests and 62 browser tests pass, type checking and the production build pass.

Entry 066: thirteen of the sixteen newest kinds carry verified AWS rates and three are unpriced with a stated reason; 410 unit tests and 62 browser tests pass, type checking, the production build and the catalog check pass.

Entry 067: four defects reproduced by Codex are fixed with regressions that fail before the fix — time-series ingestion billed per point, a Timed run's interval no longer stretched by retention housekeeping, older queues reopen with their failure and retry defaults, and a document from a newer build is refused unopened; 419 unit tests and 66 browser tests pass, type checking and the production build pass.

Entry 068: Codex's review of entry 067 found the dead-letter depth average ended at the last work event instead of the measured interval's end (0 instead of 0.5 and 0.9 in its three cases); corrected, with the three cases and a limit-during-housekeeping case as regressions, and the stale release status in README.md and implementation-plan.md rewritten; 422 unit tests and 66 browser tests pass, type checking and the production build pass.

Entry 070: Codex completed the interrupted-housekeeping correction. Cancellation and event limits before the measurement boundary use only time reached; stops at or after it preserve the full interval. Six new regressions cover before/exact/after boundary cases; the two early-stop cases failed before the fix. Final verification: 428 unit tests in 22 files, 66 Chromium tests, strict TypeScript checking and the production build passed. An independent 492-snapshot check across nine retention settings confirmed queue averages and ledger durations against observed transitions. The handoff review findings are resolved.
