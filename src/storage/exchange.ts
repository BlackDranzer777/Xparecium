/**
 * JSON import and export.
 *
 * Export writes everything needed to reopen the project on another device and
 * still understand its saved results: the document, the project metadata, and
 * the immutable run snapshots. It deliberately excludes anything transient,
 * such as worker progress or the current selection.
 *
 * Import validates the file with Zod, enforces a size limit, and refuses a
 * schema version this build does not understand rather than guessing.
 */
import { DOCUMENT_SCHEMA_VERSION } from '../domain/types';
import type { ArchitectureDocument, Project } from '../domain/types';
import {
  EXPORT_FORMAT_VERSION,
  EXPORT_KIND,
  architectureDocumentSchema,
  parseImport,
  projectSchema,
} from '../domain/schema';
import type { ParseResult } from '../domain/schema';
import type { RunRecord } from './db';
import { runRecordSchema } from './run-schema';

export const APP_VERSION = '0.1.0';
/** Refuse anything larger than this. A real project is a few hundred kilobytes. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export interface ProjectExport {
  kind: typeof EXPORT_KIND;
  formatVersion: number;
  exportedAt: string;
  appVersion: string;
  project: Project;
  runs: RunRecord[];
}

export function buildExport(project: Project, runs: RunRecord[]): ProjectExport {
  return {
    kind: EXPORT_KIND,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    project,
    runs,
  };
}

export function exportToJson(project: Project, runs: RunRecord[]): string {
  return JSON.stringify(buildExport(project, runs), null, 2);
}

export interface ImportedProject {
  project: Project;
  runs: RunRecord[];
  notes: string[];
}

/**
 * Parse an exported file. Runs are validated independently: a run is a historical
 * record, so a run this build cannot fully understand is dropped with a note
 * rather than failing the whole import.
 */
export function importFromJson(text: string): ParseResult<ImportedProject> {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      message: `That file is ${(bytes / 1024 / 1024).toFixed(1)} MB, which is larger than the ${MAX_IMPORT_BYTES / 1024 / 1024} MB import limit.`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `That file is not valid JSON: ${(error as Error).message}` };
  }

  const envelope = parseImport(raw);
  if (!envelope.ok) return envelope;

  const notes: string[] = [];
  const runs: RunRecord[] = [];
  for (const candidate of envelope.value.runs) {
    const parsed = runRecordSchema.safeParse(candidate);
    if (parsed.success && parsed.data.projectId === envelope.value.project.id) {
      runs.push(parsed.data as RunRecord);
    } else {
      notes.push('Skipped a saved run because it was missing required fields, used an unsupported schema, or contained invalid data.');
    }
  }

  return {
    ok: true,
    value: { project: envelope.value.project as Project, runs, notes },
  };
}

/** Validate a bare architecture document, used when importing just a design. */
export function parseDocument(raw: unknown): ParseResult<ArchitectureDocument> {
  const parsed = architectureDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'That is not a valid Xparecium architecture document.',
      details: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  if (parsed.data.schemaVersion > DOCUMENT_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `That document uses schema version ${parsed.data.schemaVersion}; this build understands version ${DOCUMENT_SCHEMA_VERSION}.`,
    };
  }
  return { ok: true, value: parsed.data };
}

export function validateProjectShape(raw: unknown): ParseResult<Project> {
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: 'That project record is not valid.' };
  }
  return { ok: true, value: parsed.data as Project };
}
