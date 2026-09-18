import { SERVER_HARDWARE_PROFILES } from '../domain/defaults';
import type { ArchitectureDocument, CloudAssignment } from '../domain/types';
import { serverProfileForHardware, serverProfileForSize } from './types';
import type { CloudCatalog, CloudProfileMatch, HardwareSize } from './types';

/**
 * Resolve editable server pricing at document boundaries, not just in one UI
 * handler: every `mutate`, and every document on its way in from storage or an
 * import file. Old preset-based boards follow their size; explicit manual
 * choices retain their rates. Never pass saved run snapshots here.
 *
 * Custom hardware follows too. It has no size class, so it is priced as the
 * smallest catalogued machine — same provider, same region — that fits the CPU
 * slots and memory typed in. Eight slots typed into a box that used to be a
 * Large is not a Large, and the estimate must not say it is. When nothing in
 * the catalog is big enough the component goes unpriced, which is the truth;
 * the provider and region are remembered so a later size that does exist finds
 * its way back.
 */
export function normaliseServerPricing(
  document: ArchitectureDocument,
  catalog: CloudCatalog | null,
  sizes: readonly HardwareSize[] = SERVER_HARDWARE_PROFILES,
): ArchitectureDocument {
  if (!catalog) return document;
  let changed = false;
  const nodes = document.nodes.map((node) => {
    if (node.kind !== 'server' || node.cloud.pricingMode === 'manual') return node;
    const reference = node.cloud.profileId ?? node.cloud.previousProfileId ?? null;
    if (!reference) return node;

    const match: CloudProfileMatch =
      node.settings.profile === 'custom'
        ? serverProfileForHardware(
            catalog,
            sizes,
            reference,
            node.settings.cpuSlots,
            node.settings.ramMb,
          )
        : serverProfileForSize(catalog, reference, node.settings.profile);
    if (match.outcome === 'keep') return node;

    const profileId = match.outcome === 'matched' ? match.profile.id : null;
    const previousProfileId = profileId ?? reference;
    if (
      profileId === node.cloud.profileId &&
      (node.cloud.previousProfileId === undefined ||
        node.cloud.previousProfileId === previousProfileId)
    ) {
      return node;
    }
    const cloud: CloudAssignment = { profileId, pricingMode: 'automatic', previousProfileId };
    changed = true;
    return { ...node, cloud };
  });
  return changed ? { ...document, nodes } : document;
}
