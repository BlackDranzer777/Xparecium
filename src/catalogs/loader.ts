/**
 * Loading versioned catalogs from the static host.
 *
 * Catalogs are plain JSON served next to the app. They are fetched once,
 * validated with Zod, and cached in IndexedDB so a later visit still works if
 * the network is unavailable. A catalog whose version is newer than this build
 * understands is refused with an explanation rather than partially read.
 */
import {
  CLOUD_CATALOG_SUPPORTED_VERSION,
  HARDWARE_CATALOG_SUPPORTED_VERSION,
  cloudCatalogSchema,
  hardwareCatalogSchema,
} from './types';
import type { CloudCatalog, HardwareCatalog } from './types';
import { readCatalog, writeCatalog } from '../storage/db';

export const CLOUD_CATALOG_URL = 'catalogs/cloud-profiles.v1.json';
export const HARDWARE_CATALOG_URL = 'catalogs/hardware.v1.json';

export interface CatalogBundle {
  cloud: CloudCatalog;
  hardware: HardwareCatalog;
  /** True when at least one catalog came from the local cache, not the network. */
  fromCache: boolean;
  notes: string[];
}

async function fetchJson(url: string): Promise<unknown> {
  const base = import.meta.env.BASE_URL ?? '/';
  const response = await fetch(`${base}${url}`.replace(/\/{2,}/g, '/'), { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Could not load ${url} (HTTP ${response.status}).`);
  }
  return response.json();
}

async function load<T>(
  url: string,
  cacheKey: string,
  parse: (raw: unknown) => T,
  supportedVersion: number,
  notes: string[],
): Promise<{ value: T; fromCache: boolean }> {
  try {
    const raw = await fetchJson(url);
    const value = parse(raw);
    await writeCatalog(cacheKey, supportedVersion, raw).catch(() => {
      // Caching is a convenience, never a requirement.
    });
    return { value, fromCache: false };
  } catch (error) {
    const cached = await readCatalog(cacheKey).catch(() => null);
    if (cached) {
      notes.push(
        `Loaded the ${cacheKey} catalog from this browser's cache because it could not be fetched: ${(error as Error).message}`,
      );
      return { value: parse(cached.payload), fromCache: true };
    }
    throw error;
  }
}

function parseCloud(raw: unknown): CloudCatalog {
  const parsed = cloudCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `The cloud pricing catalog is not valid: ${parsed.error.issues[0]?.message ?? 'unknown problem'}`,
    );
  }
  if (parsed.data.version > CLOUD_CATALOG_SUPPORTED_VERSION) {
    throw new Error(
      `The cloud pricing catalog is version ${parsed.data.version}, but this build of Xparecium understands version ${CLOUD_CATALOG_SUPPORTED_VERSION}.`,
    );
  }
  return parsed.data;
}

function parseHardware(raw: unknown): HardwareCatalog {
  const parsed = hardwareCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `The hardware catalog is not valid: ${parsed.error.issues[0]?.message ?? 'unknown problem'}`,
    );
  }
  if (parsed.data.version > HARDWARE_CATALOG_SUPPORTED_VERSION) {
    throw new Error(
      `The hardware catalog is version ${parsed.data.version}, but this build of Xparecium understands version ${HARDWARE_CATALOG_SUPPORTED_VERSION}.`,
    );
  }
  return parsed.data;
}

export async function loadCatalogs(): Promise<CatalogBundle> {
  const notes: string[] = [];
  const [cloud, hardware] = await Promise.all([
    load(CLOUD_CATALOG_URL, 'cloud-profiles', parseCloud, CLOUD_CATALOG_SUPPORTED_VERSION, notes),
    load(HARDWARE_CATALOG_URL, 'hardware', parseHardware, HARDWARE_CATALOG_SUPPORTED_VERSION, notes),
  ]);
  return {
    cloud: cloud.value,
    hardware: hardware.value,
    fromCache: cloud.fromCache || hardware.fromCache,
    notes,
  };
}
