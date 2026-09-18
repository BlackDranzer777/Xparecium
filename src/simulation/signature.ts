/**
 * What a document says to the simulation.
 *
 * Two documents with the same signature must produce the same run. That is the
 * question the editor asks before re-running itself after an edit, so the
 * contents of this file are really a statement about what the engine reads:
 *
 *   - node positions are absent, because moving a component around the canvas
 *     cannot change a single number;
 *   - node names are absent, because they are labels;
 *   - rate overrides are present, because a run carries a cost estimate and
 *     changing a rate changes it.
 *
 * It lives beside the engine rather than in the editor so it can be tested
 * without a browser, and so it sits next to the code whose behaviour it claims
 * to summarise.
 */
import type { ArchitectureDocument } from '../domain/types';

export function simulationSignature(document: ArchitectureDocument): string {
  return JSON.stringify({
    nodes: document.nodes.map((n) => [n.id, n.kind, n.cloud.profileId, n.settings]),
    edges: document.edges.map((e) => [e.id, e.source, e.target, e.settings]),
    workload: document.workload,
    pricing: document.pricingOverrides,
  });
}
