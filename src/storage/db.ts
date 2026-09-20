/**
 * Local persistence.
 *
 * Everything lives in this browser, in IndexedDB, through Dexie. There is no
 * server, no account and no sync. Three collections:
 *
 *   projects  - the editable architecture documents,
 *   runs      - immutable snapshots of what was simulated and what came out,
 *   catalogs  - cached copies of the static catalog files.
 *
 * A run must never change when its project is edited, so a run stores its own
 * deep copy of the document, the seed, the engine version and the catalog rows
 * it used.
 */
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { ArchitectureDocument, Project } from '../domain/types';
import type { CloudProfile } from '../catalogs/types';
import type { SimulationResult } from '../simulation/types';
import type { CostEstimate } from '../pricing/pricing';

export const STORAGE_SCHEMA_VERSION = 1;

export interface ProjectRecord extends Project {
  schemaVersion: number;
}

export interface CatalogSnapshot {
  catalogId: string;
  version: number;
  publishedAt: string;
  currency: string;
  profiles: CloudProfile[];
}

export interface RunRecord {
  id: string;
  projectId: string;
  createdAt: number;
  label: string;
  /**
   * True when the editor started this run by itself after an edit. Automatic
   * runs are shown but not kept: only the runs a person asked for become
   * history worth comparing against. Absent on records written before auto-run
   * existed, which is why every read treats it as optional.
   */
  automatic?: boolean;
  schemaVersion: number;
  engineVersion: string;
  seed: number;
  /** Deep copy of the exact document that was simulated. Never mutated. */
  inputDocument: ArchitectureDocument;
  /** The catalog rows actually used, kept so an old run stays readable. */
  catalogSnapshot: CatalogSnapshot;
  result: SimulationResult;
  cost: CostEstimate;
}

export interface CatalogRecord {
  id: string;
  version: number;
  cachedAt: number;
  payload: unknown;
}

class XpareciumDatabase extends Dexie {
  projects!: Table<ProjectRecord, string>;
  runs!: Table<RunRecord, string>;
  catalogs!: Table<CatalogRecord, string>;

  constructor() {
    // The on-disk name predates the rename to Xparecium and stays as it is:
    // changing it would hide every project people have already saved.
    super('aparecium');
    // Version 1 of the on-disk schema. Future versions add a .version(n)
    // block with an .upgrade() so existing data is migrated, never dropped.
    this.version(1).stores({
      projects: 'id, name, updatedAt',
      runs: 'id, projectId, createdAt',
      catalogs: 'id',
    });
  }
}

export const db = new XpareciumDatabase();

/** True when IndexedDB is usable. Private-mode browsers can refuse it. */
export async function storageAvailable(): Promise<boolean> {
  try {
    await db.open();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ catalogs

export async function writeCatalog(id: string, version: number, payload: unknown): Promise<void> {
  await db.catalogs.put({ id, version, cachedAt: Date.now(), payload });
}

export async function readCatalog(id: string): Promise<CatalogRecord | null> {
  return (await db.catalogs.get(id)) ?? null;
}

// ------------------------------------------------------------------ projects

export async function listProjects(): Promise<ProjectRecord[]> {
  const all = await db.projects.toArray();
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  return (await db.projects.get(id)) ?? null;
}

export async function putProject(project: Project): Promise<void> {
  await db.projects.put({ ...project, schemaVersion: STORAGE_SCHEMA_VERSION });
}

/** A project snapshot and its history either all save or none do, including retries. */
export async function putProjectAndRuns(project: Project, runs: RunRecord[]): Promise<void> {
  await db.transaction('rw', db.projects, db.runs, async () => {
    await putProject(project);
    await db.runs.bulkPut(runs);
  });
}

export async function renameProject(id: string, name: string): Promise<void> {
  await db.projects.update(id, { name, updatedAt: Date.now() });
}

/**
 * Deleting a project must also delete its runs, and either both happen or
 * neither does. Dexie gives us a real IndexedDB transaction for that.
 */
export async function deleteProjectAndRuns(id: string): Promise<void> {
  await db.transaction('rw', db.projects, db.runs, async () => {
    await db.runs.where('projectId').equals(id).delete();
    await db.projects.delete(id);
  });
}

// ---------------------------------------------------------------------- runs

export async function listRuns(projectId: string, limit = 25): Promise<RunRecord[]> {
  const rows = await db.runs.where('projectId').equals(projectId).toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function putRun(run: RunRecord): Promise<void> {
  await db.runs.put(run);
}

export async function deleteRun(id: string): Promise<void> {
  await db.runs.delete(id);
}

/** Keep the newest `keep` runs for a project and drop the rest. */
export async function pruneRuns(projectId: string, keep = 25): Promise<void> {
  const rows = await listRuns(projectId, Number.MAX_SAFE_INTEGER);
  const doomed = rows.slice(keep).map((r) => r.id);
  if (doomed.length > 0) await db.runs.bulkDelete(doomed);
}
