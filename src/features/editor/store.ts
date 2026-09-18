/**
 * The shared editor state.
 *
 * One Zustand store holds everything the interface needs: the open project,
 * the selection, the undo history, the catalogs, and the state of the current
 * run. React components subscribe to the slices they use.
 *
 * Two invariants matter most:
 *   - The architecture document is the single source of truth. React Flow's
 *     nodes and edges are derived from it, never the other way round.
 *   - A saved run is immutable. Editing the document sets `resultsStale` so the
 *     displayed results are visibly marked as belonging to an earlier design.
 */
import { create } from 'zustand';
import { DEFAULT_LIMITS, DOCUMENT_SCHEMA_VERSION } from '../../domain/types';
import type {
  ArchNode,
  ArchitectureDocument,
  ChargeType,
  ComponentKind,
  Project,
  Workload,
} from '../../domain/types';
import {
  COMPONENT_LABELS,
  buildTemplate,
  makeNode,
  normaliseComponentNames,
  unsupportedDocumentReason,
  upgradeDocument,
} from '../../domain/defaults';
import { edgeId, newId } from '../../domain/ids';
import { loadCatalogs } from '../../catalogs/loader';
import { normaliseServerPricing } from '../../catalogs/server-pricing';
import type { CloudCatalog, HardwareCatalog } from '../../catalogs/types';
import { estimateCost } from '../../pricing/pricing';
import type { CostEstimate } from '../../pricing/pricing';
import { validateAndResolve } from '../../simulation/routing';
import { simulationSignature } from '../../simulation/signature';
import type { RoutingResult } from '../../simulation/routing';
import type { ProgressUpdate, SimulationResult } from '../../simulation/types';
import { simulationClient } from '../../workers/client';
import {
  deleteProjectAndRuns,
  getProject,
  listProjects,
  listRuns,
  pruneRuns,
  putRun,
  putProjectAndRuns,
  storageAvailable,
} from '../../storage/db';
import type { ProjectRecord, RunRecord } from '../../storage/db';
import { createRunRecord, deepClone } from '../../storage/runs';
import { exportToJson, importFromJson } from '../../storage/exchange';


/**
 * Whether two documents would produce the same run.
 *
 * Results go stale when the design they describe has changed, and "changed"
 * has to mean *changed the numbers* — comparing whole documents marked results
 * stale for renaming a component or nudging it across the canvas, neither of
 * which the engine can see. Same rule as auto-run, from the same signature.
 */
function sameSimulation(a: ArchitectureDocument, b: ArchitectureDocument): boolean {
  return simulationSignature(a) === simulationSignature(b);
}

const LIVE_STORAGE_KEY = 'aparecium.live';
function readContinuous(): boolean {
  try { return localStorage.getItem('aparecium.mode') !== 'timed'; } catch { return true; }
}

function readLivePreference(): boolean {
  try {
    // On by default: the point of the editor is the loop, and waiting for a
    // button press between every change is friction with nothing to show for it.
    return localStorage.getItem(LIVE_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** How long to wait after the last edit before running, in milliseconds. */
const AUTO_RUN_DELAY_MS = 450;

const UNDO_LIMIT = 60;
const RUNS_KEPT = 25;
const AUTOSAVE_DELAY_MS = 600;

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface Selection {
  type: 'node' | 'edge';
  id: string;
}

export interface Toast {
  id: string;
  tone: 'info' | 'error' | 'success';
  message: string;
  details?: string[];
}

interface EditorState {
  ready: boolean;
  storageOk: boolean;
  bootError: string | null;

  cloudCatalog: CloudCatalog | null;
  hardwareCatalog: HardwareCatalog | null;
  catalogError: string | null;
  catalogNotes: string[];

  projects: ProjectRecord[];
  project: Project | null;

  selection: Selection | null;
  showAdvanced: boolean;
  undoStack: ArchitectureDocument[];
  redoStack: ArchitectureDocument[];

  saveStatus: SaveStatus;
  saveError: string | null;

  running: boolean;
  /** True while the run in flight was started by the editor, not by a person. */
  runningAutomatic: boolean;
  /** Follow meaningful edits automatically until Stop. */
  live: boolean;
  /** Live advances continuously; Timed computes a finite comparison run. */
  continuous: boolean;
  setContinuous: (value: boolean) => void;
  progress: ProgressUpdate | null;
  currentRunId: string | null;
  runError: string | null;
  runs: RunRecord[];
  latestRun: RunRecord | null;
  compareRunId: string | null;
  resultsStale: boolean;

  toasts: Toast[];

  initialise: () => Promise<void>;
  createProject: (templateId: string, name?: string) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  renameProject: (name: string) => void;
  removeProject: (id: string) => Promise<void>;

  mutate: (fn: (draft: ArchitectureDocument) => void, options?: { undoable?: boolean }) => void;
  beginUndoGroup: () => void;
  commitUndoGroup: () => void;
  undo: () => void;
  redo: () => void;

  select: (selection: Selection | null) => void;
  setShowAdvanced: (value: boolean) => void;
  addComponent: (kind: ComponentKind) => void;
  deleteNode: (id: string) => void;
  deleteEdge: (id: string) => void;
  connect: (source: string, target: string) => void;
  setWorkload: (patch: Partial<Workload>) => void;
  setRateOverride: (profileId: string, charge: ChargeType, value: string | null | undefined) => void;

  run: (options?: { automatic?: boolean }) => Promise<void>;
  /** Stop the simulation: no more automatic re-runs, and cancel any in flight. */
  stopSimulation: () => void;
  /** Put the result now on screen into the history, so Compare can hold on to it. */
  keepLatestRun: () => Promise<void>;
  cancelRun: () => void;
  setCompareRun: (id: string | null) => void;

  exportCurrent: () => void;
  importFile: (text: string) => Promise<void>;

  pushToast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
}

// ---------------------------------------------------------------- utilities

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let autoRunTimer: ReturnType<typeof setTimeout> | null = null;

/** Remember across reloads whether the simulation was left running. */
function rememberLive(value: boolean): void {
  try {
    localStorage.setItem(LIVE_STORAGE_KEY, value ? 'on' : 'off');
  } catch {
    // Not remembering the preference is not worth failing over.
  }
}
let pendingUndoSnapshot: ArchitectureDocument | null = null;

function nowStamp(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function uniqueName(document: ArchitectureDocument, kind: ComponentKind): string {
  const base = COMPONENT_LABELS[kind];
  const used = new Set(document.nodes.map((n) => n.name));
  if (!used.has(base)) return base;
  for (let i = 2; i < 500; i += 1) {
    const candidate = `${base} ${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** Place a new component somewhere visible and not on top of another one. */
function freePosition(document: ArchitectureDocument): { x: number; y: number } {
  const step = 60;
  for (let i = 0; i < 200; i += 1) {
    const x = 120 + (i % 6) * 180;
    const y = 90 + Math.floor(i / 6) * 130;
    const clash = document.nodes.some(
      (n) => Math.abs(n.position.x - x) < step && Math.abs(n.position.y - y) < step,
    );
    if (!clash) return { x, y };
  }
  return { x: 120, y: 90 };
}

function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------------- store

export const useEditor = create<EditorState>((set, get) => {
  let saveChain = Promise.resolve();

  function scheduleSave(): void {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    set({ saveStatus: 'pending' });
    autosaveTimer = setTimeout(() => {
      void saveNow();
    }, AUTOSAVE_DELAY_MS);
  }

  /**
   * Queue a run for shortly after the last edit.
   *
   * Debounced, because a single change to a number can arrive as several
   * keystrokes, and skipped entirely when the design cannot be simulated —
   * otherwise every half-finished edit would raise an error the user is
   * already being told about by the problems chip. Skipping leaves the last
   * result and its traffic on screen rather than blanking the canvas: the
   * simulation is still live, it just cannot advance until the problem is
   * fixed, and the problems chip is what says so.
   */
  function scheduleAutoRun(): void {
    if (autoRunTimer) clearTimeout(autoRunTimer);
    if (!get().live) return;
    autoRunTimer = setTimeout(() => {
      autoRunTimer = null;
      const document = get().project?.document;
      if (!document) return;
      if (validateAndResolve(document).hasErrors) return;
      void get().run({ automatic: true });
    }, AUTO_RUN_DELAY_MS);
  }

  async function saveNow(): Promise<boolean> {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = null;
    const project = get().project;
    if (!project) return true;
    const runs = get().runs.filter((run) => run.projectId === project.id);
    if (!get().storageOk) {
      // Nothing to save to, but the work stays in memory and can be exported.
      set({ saveStatus: 'error', saveError: 'This browser is not allowing local storage.' });
      return false;
    }
    set({ saveStatus: 'saving' });
    try {
      // Serialize writes to prevent an older snapshot overtaking a newer one.
      const write = saveChain.then(() => putProjectAndRuns(project, runs));
      saveChain = write.catch(() => {});
      await write;
      const projects = await listProjects();
      set({ projects });
      if (get().project === project) set({ saveStatus: 'saved', saveError: null });
      return true;
    } catch (error) {
      // A failed save must never discard in-memory work.
      if (get().project === project) set({
        saveStatus: 'error',
        saveError: `Could not save: ${(error as Error).message}. Your work is still here; use Export to keep a copy.`,
      });
      return false;
    }
  }

  function detachRun(): void {
    simulationClient.cancel();
    pendingUndoSnapshot = null;
    set({ running: false, currentRunId: null, progress: null, runError: null });
  }

  /**
   * Open the most recent project this build can read. One saved by a newer
   * Aparecium is refused by `openProject` and left alone, so the next one is
   * tried; a fresh starter is created only when nothing saved can be opened.
   */
  async function openFirstReadable(projects: ProjectRecord[]): Promise<void> {
    for (const candidate of projects) {
      await get().openProject(candidate.id);
      if (get().project) return;
    }
    await get().createProject('starter', 'My first system');
  }

  async function prepareToLeave(): Promise<boolean> {
    // Keep the current project available for export if its save fails.
    while (get().project && get().saveStatus !== 'saved') {
      if (!(await saveNow())) {
        get().pushToast({ tone: 'error', message: 'Could not save this project. It is still open; export a copy before leaving.' });
        return false;
      }
    }
    detachRun();
    return true;
  }

  return {
    ready: false,
    storageOk: false,
    bootError: null,

    cloudCatalog: null,
    hardwareCatalog: null,
    catalogError: null,
    catalogNotes: [],

    projects: [],
    project: null,

    selection: null,
    showAdvanced: false,
    undoStack: [],
    redoStack: [],

    saveStatus: 'idle',
    saveError: null,

    running: false,
    runningAutomatic: false,
    live: readLivePreference(),
    continuous: readContinuous(),
    setContinuous(value) {
      get().stopSimulation();
      set({ continuous: value });
      try { localStorage.setItem('aparecium.mode', value ? 'live' : 'timed'); } catch { /* memory only */ }
    },
    progress: null,
    currentRunId: null,
    runError: null,
    runs: [],
    latestRun: null,
    compareRunId: null,
    resultsStale: false,

    toasts: [],

    // ------------------------------------------------------------- lifecycle

    async initialise() {
      const storageOk = await storageAvailable();
      set({ storageOk });

      try {
        const bundle = await loadCatalogs();
        set({
          cloudCatalog: bundle.cloud,
          hardwareCatalog: bundle.hardware,
          catalogNotes: bundle.notes,
          catalogError: null,
        });
      } catch (error) {
        set({
          catalogError: `Could not load the pricing catalog: ${(error as Error).message} Simulation still works; cost estimates are unavailable.`,
        });
      }

      let projects: ProjectRecord[] = [];
      if (storageOk) {
        try {
          projects = await listProjects();
        } catch (error) {
          set({ bootError: `Could not read saved projects: ${(error as Error).message}` });
        }
      }
      set({ projects });

      await openFirstReadable(projects);
      set({ ready: true });
    },

    async createProject(templateId, name) {
      if (!(await prepareToLeave())) return;
      const project: Project = {
        id: newId('proj'),
        name: name ?? `Untitled ${nowStamp()}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        document: buildTemplate(templateId),
      };
      set({
        project,
        selection: null,
        undoStack: [],
        redoStack: [],
        runs: [],
        latestRun: null,
        compareRunId: null,
        resultsStale: false,
        runError: null,
        saveStatus: 'pending',
      });
      await saveNow();
    },

    async openProject(id) {
      if (!(await prepareToLeave())) return;
      const record = await getProject(id).catch(() => null);
      if (!record) {
        get().pushToast({ tone: 'error', message: 'That project could not be opened.' });
        return;
      }
      // A project saved by a newer Aparecium is refused here, before anything
      // is upgraded, replaced or written back. It stays in storage as it is,
      // and whatever was open stays open.
      const unsupported = unsupportedDocumentReason(record.document);
      if (unsupported) {
        get().pushToast({ tone: 'error', message: `"${record.name}" was not opened. ${unsupported}` });
        return;
      }
      const runs = await listRuns(id, RUNS_KEPT).catch(() => []);
      detachRun();
      // A document saved before a default name changed still carries the old
      // one. Translating it here means the whole app says one thing, including
      // on boards that already exist.
      const restored = normaliseComponentNames(upgradeDocument(record.document));
      const document = normaliseServerPricing(restored, get().cloudCatalog);
      set({
        project: {
          id: record.id,
          name: record.name,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          document,
        },
        selection: null,
        undoStack: [],
        redoStack: [],
        runs,
        latestRun: runs[0] ?? null,
        compareRunId: runs[1]?.id ?? null,
        resultsStale: !!runs[0] && !sameSimulation(document, runs[0].inputDocument),
        runError: null,
        saveStatus: 'saved',
        saveError: null,
      });
      if (document !== restored) scheduleSave();
    },

    renameProject(name) {
      const project = get().project;
      if (!project) return;
      set({ project: { ...project, name, updatedAt: Date.now() } });
      scheduleSave();
    },

    async removeProject(id) {
      if (get().project?.id === id) {
        if (autosaveTimer) clearTimeout(autosaveTimer);
        autosaveTimer = null;
        detachRun();
        await saveChain;
      }
      try {
        await deleteProjectAndRuns(id);
      } catch (error) {
        get().pushToast({
          tone: 'error',
          message: `Could not delete that project: ${(error as Error).message}`,
        });
        return;
      }
      const projects = await listProjects().catch(() => []);
      set({ projects });
      if (get().project?.id === id) {
        set({ project: null });
        await openFirstReadable(projects);
      }
    },

    // -------------------------------------------------------------- editing

    mutate(fn, options) {
      const project = get().project;
      if (!project) return;
      const previous = project.document;
      let draft = deepClone(previous);
      fn(draft);
      draft = normaliseServerPricing(draft, get().cloudCatalog);
      draft.schemaVersion = DOCUMENT_SCHEMA_VERSION;

      const undoable = options?.undoable !== false;
      const undoStack = undoable
        ? [...get().undoStack, previous].slice(-UNDO_LIMIT)
        : get().undoStack;

      const changed = simulationSignature(previous) !== simulationSignature(draft);

      set({
        project: { ...project, document: draft, updatedAt: Date.now() },
        undoStack,
        redoStack: undoable ? [] : get().redoStack,
        // Dragging a component does not change what was simulated, so the
        // results it is showing are still about this design.
        resultsStale: changed && get().latestRun !== null,
      });
      scheduleSave();
      if (changed) scheduleAutoRun();
    },

    beginUndoGroup() {
      const project = get().project;
      if (!project) return;
      pendingUndoSnapshot = project.document;
    },

    commitUndoGroup() {
      const snapshot = pendingUndoSnapshot;
      pendingUndoSnapshot = null;
      if (!snapshot) return;
      const current = get().project?.document;
      if (!current || current === snapshot) return;
      set({
        undoStack: [...get().undoStack, snapshot].slice(-UNDO_LIMIT),
        redoStack: [],
      });
    },

    undo() {
      const { undoStack, redoStack, project } = get();
      const previous = undoStack[undoStack.length - 1];
      if (!previous || !project) return;
      // Stepping back through history is a change to the design like any
      // other: it decides staleness the same way, and a running simulation
      // picks it up without being asked. Undoing the edit that broke a design
      // is exactly when somebody wants it to start working again.
      const changed = !sameSimulation(project.document, previous);
      set({
        project: { ...project, document: previous, updatedAt: Date.now() },
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, project.document].slice(-UNDO_LIMIT),
        resultsStale: changed && get().latestRun !== null,
      });
      scheduleSave();
      if (changed) scheduleAutoRun();
    },

    redo() {
      const { undoStack, redoStack, project } = get();
      const next = redoStack[redoStack.length - 1];
      if (!next || !project) return;
      const changed = !sameSimulation(project.document, next);
      set({
        project: { ...project, document: next, updatedAt: Date.now() },
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack, project.document].slice(-UNDO_LIMIT),
        resultsStale: changed && get().latestRun !== null,
      });
      scheduleSave();
      if (changed) scheduleAutoRun();
    },

    select(selection) {
      set({ selection });
    },

    setShowAdvanced(value) {
      set({ showAdvanced: value });
    },

    addComponent(kind) {
      const project = get().project;
      if (!project) return;
      const id = newId(kind);
      const name = uniqueName(project.document, kind);
      const position = freePosition(project.document);
      get().mutate((draft) => {
        draft.nodes.push(makeNode(kind, id, name, position));
      });
      set({ selection: { type: 'node', id } });
    },

    deleteNode(id) {
      get().mutate((draft) => {
        draft.nodes = draft.nodes.filter((n) => n.id !== id);
        draft.edges = draft.edges.filter((e) => e.source !== id && e.target !== id);
      });
      if (get().selection?.id === id) set({ selection: null });
    },

    deleteEdge(id) {
      get().mutate((draft) => {
        draft.edges = draft.edges.filter((e) => e.id !== id);
      });
      if (get().selection?.id === id) set({ selection: null });
    },

    connect(source, target) {
      const project = get().project;
      if (!project || source === target) return;
      const document = project.document;
      if (document.edges.some((e) => e.source === source && e.target === target)) return;

      const sourceNode = document.nodes.find((n) => n.id === source);
      const targetNode = document.nodes.find((n) => n.id === target);
      if (!sourceNode || !targetNode) return;

      // A client-to-server hop crosses the internet; everything else is
      // assumed to be inside one datacentre. Both are editable afterwards.
      const external = sourceNode.kind === 'client' || targetNode.kind === 'client';
      const settings = external
        ? { propagationDelayMs: 12, bandwidthMbps: 200 }
        : { propagationDelayMs: 0.4, bandwidthMbps: 1000 };

      const id = edgeId(source, target);
      get().mutate((draft) => {
        draft.edges.push({ id, source, target, settings });
      });
      set({ selection: { type: 'edge', id } });
    },

    setWorkload(patch) {
      get().mutate((draft) => {
        draft.workload = { ...draft.workload, ...patch };
      });
    },

    setRateOverride(profileId, charge, value) {
      get().mutate((draft) => {
        const current = { ...(draft.pricingOverrides[profileId] ?? {}) };
        if (value === undefined) delete current[charge];
        else current[charge] = value;
        if (Object.keys(current).length === 0) delete draft.pricingOverrides[profileId];
        else draft.pricingOverrides[profileId] = current;
      });
    },

    // ------------------------------------------------------------------ run

    /**
     * Keep the current live result.
     *
     * A running simulation produces a new result after every change, and they
     * replace each other rather than piling up — history is for the runs a
     * person chose to hold on to, and Compare is useless if the baseline is
     * buried under twenty previews. This is how a preview becomes one of those.
     */
    async keepLatestRun() {
      const { latestRun, project } = get();
      if (!latestRun || !project || !latestRun.automatic) return;
      const kept = { ...deepClone(latestRun), id: newId('run'), automatic: false };
      const previousKept = get().runs.find((r) => r.id !== kept.id && !r.automatic) ?? null;
      set({
        latestRun: kept,
        runs: [kept, ...get().runs.filter((r) => r.id !== kept.id)].slice(0, RUNS_KEPT),
        compareRunId: previousKept?.id ?? null,
      });
      if (!get().storageOk) return;
      try {
        await putRun(kept);
        await pruneRuns(project.id, RUNS_KEPT);
      } catch (error) {
        get().pushToast({
          tone: 'error',
          message: `That result could not be saved: ${(error as Error).message}`,
        });
      }
    },

    stopSimulation() {
      if (autoRunTimer) clearTimeout(autoRunTimer);
      autoRunTimer = null;
      rememberLive(false);
      set({ live: false });
      // Stopping stops everything, including a run that is still going. A long
      // one is exactly the case where somebody wants the button to work.
      if (get().running) simulationClient.cancel();
    },

    async run(options) {
      const { project, cloudCatalog, continuous } = get();
      if (!project) return;
      const automatic = options?.automatic === true;

      // Pressing Run starts the simulation as well as performing one. Only a
      // person can start it; an automatic re-run is the simulation continuing,
      // and must not restart one that was deliberately stopped.
      if (!automatic && !get().live) {
        rememberLive(true);
        set({ live: true });
      }

      // A newer run supersedes an older one inside the worker client, so there
      // is no early return here: the last edit must always be the one that
      // ends up on screen.
      if (autoRunTimer) {
        clearTimeout(autoRunTimer);
        autoRunTimer = null;
      }

      set({ running: true, runningAutomatic: automatic, progress: null, runError: null });

      const documentSnapshot = deepClone(project.document);
      const previewId = newId('run');
      const catalog: CloudCatalog = cloudCatalog ?? {
        catalogId: 'cloud-profiles', version: 1, currency: 'USD', publishedAt: 'unavailable',
        notice: 'No usable pricing catalog.', profiles: [],
      };
      let expectedRunId: string | null = null;
      const handle = simulationClient.run(documentSnapshot, DEFAULT_LIMITS, (progress) => {
        if (expectedRunId && get().currentRunId === expectedRunId) set({ progress });
      }, { continuous, onSnapshot: result => {
        if (!expectedRunId || get().currentRunId !== expectedRunId || !get().live) return;
        const preview = createRunRecord({ projectId: project.id, automatic: true,
          label: `${nowStamp()} — live snapshot`, document: documentSnapshot, catalog, result,
          cost: estimateCost({ document: documentSnapshot, catalog, usage: result.usage }),
        });
        preview.id = previewId;
        set({ latestRun: preview, resultsStale: !sameSimulation(get().project!.document, documentSnapshot) });
      } });
      expectedRunId = handle.runId;
      set({ currentRunId: handle.runId });

      let result: SimulationResult;
      try {
        result = await handle.result;
      } catch (error) {
        if (get().currentRunId !== handle.runId) return; // superseded, ignore
        set({
          running: false,
          runningAutomatic: false,
          currentRunId: null,
          live: false,
          runError: (error as Error).message,
        });
        return;
      }

      // A result that arrives after a newer run started is stale: drop it.
      if (get().currentRunId !== handle.runId) return;

      let cost: CostEstimate | null = null;
      if (cloudCatalog) {
        try {
          cost = estimateCost({
            document: documentSnapshot,
            catalog: cloudCatalog,
            usage: result.status === 'invalid' ? null : result.usage,
          });
        } catch (error) {
          set({ runError: `Cost estimate failed: ${(error as Error).message}` });
        }
      }

      if (result.status === 'invalid') {
        set({
          running: false,
          currentRunId: null,
          progress: null,
          live: false,
          runError: result.statusReason ?? 'The architecture could not be simulated.',
        });
        return;
      }

      const record =
        cloudCatalog && cost
          ? createRunRecord({
              projectId: project.id,
              automatic,
              label: `${nowStamp()} — ${result.status}`,
              document: documentSnapshot,
              catalog: cloudCatalog,
              result,
              cost,
            })
          : createRunRecord({
              projectId: project.id,
              automatic,
              label: `${nowStamp()} — ${result.status}`,
              document: documentSnapshot,
              catalog: {
                catalogId: 'cloud-profiles',
                version: 0,
                currency: 'USD',
                publishedAt: 'unavailable',
                notice: 'The pricing catalog was unavailable for this run.',
                profiles: [],
              } as CloudCatalog,
              result,
              cost: estimateCost({ document: documentSnapshot, usage: result.usage,
                catalog: { catalogId: 'cloud-profiles', version: 1, currency: 'USD',
                  publishedAt: 'unavailable', notice: 'No usable pricing catalog.', profiles: [] } }),
            });

      // History is what the Compare tab draws on, so it holds the runs a
      // person asked for. An automatic run is a live preview: it sits at the
      // head and the next one takes its place, instead of burying the baseline
      // someone actually wanted to compare against.
      const existing = get().runs;
      const head = existing[0];
      const kept = head?.automatic ? existing.slice(1) : existing;
      const previousKept = kept.find((r) => r.id !== record.id) ?? null;

      set({
        running: false,
        runningAutomatic: false,
        currentRunId: null,
        progress: null,
        latestRun: record,
        runs: [record, ...kept].slice(0, RUNS_KEPT),
        compareRunId: previousKept?.id ?? null,
        resultsStale: !sameSimulation(get().project!.document, documentSnapshot),
        ...(continuous || result.status === 'incomplete' ? { live: false } : {}),
      });

      if (get().storageOk && !automatic) {
        try {
          await putRun(record);
          await pruneRuns(project.id, RUNS_KEPT);
        } catch (error) {
          get().pushToast({
            tone: 'error',
            message: `The run finished but could not be saved: ${(error as Error).message}`,
          });
        }
      }
    },

    cancelRun() {
      if (!get().running) return;
      simulationClient.cancel();
    },

    setCompareRun(id) {
      set({ compareRunId: id });
    },

    // -------------------------------------------------------- import/export

    exportCurrent() {
      const { project, runs, latestRun } = get();
      if (!project) return;
      const safe = project.name.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'aparecium-project';
      const snapshots = latestRun && !runs.some(r => r.id === latestRun.id)
        ? [latestRun, ...runs].slice(0, RUNS_KEPT) : runs;
      download(`${safe}.aparecium.json`, exportToJson(project, snapshots));
      get().pushToast({ tone: 'success', message: `Exported "${project.name}".` });
    },

    async importFile(text) {
      const parsed = importFromJson(text);
      if (!parsed.ok) {
        get().pushToast({
          tone: 'error',
          message: parsed.message,
          ...(parsed.details ? { details: parsed.details } : {}),
        });
        return;
      }
      // Import as a new project so an existing one is never overwritten.
      if (!(await prepareToLeave())) return;
      const imported = parsed.value;
      const newProjectId = newId('proj');
      const project: Project = {
        ...imported.project,
        id: newProjectId,
        name: `${imported.project.name} (imported)`,
        document: normaliseServerPricing(
          normaliseComponentNames(upgradeDocument(imported.project.document)), get().cloudCatalog,
        ),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const runs = imported.runs.map((run) => ({ ...run, id: newId('run'), projectId: newProjectId }))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, RUNS_KEPT);

      set({
        project,
        runs,
        latestRun: runs[0] ?? null,
        compareRunId: runs[1]?.id ?? null,
        selection: null,
        undoStack: [],
        redoStack: [],
        resultsStale: !!runs[0] && !sameSimulation(project.document, runs[0].inputDocument),
        saveStatus: 'saving',
        saveError: null,
      });

      if (get().storageOk) {
        try {
          await putProjectAndRuns(project, runs);
          set({ projects: await listProjects(), saveStatus: 'saved' });
        } catch (error) {
          set({ saveStatus: 'error', saveError: `Imported data could not be saved: ${(error as Error).message}. Export to keep a copy.` });
          get().pushToast({
            tone: 'error',
            message: `Imported into this session, but saving failed: ${(error as Error).message}`,
          });
        }
      } else set({ saveStatus: 'error', saveError: 'Local storage is unavailable. Export to keep a copy.' });
      get().pushToast({
        tone: 'success',
        message: `Imported "${project.name}" with ${runs.length} saved run(s).`,
        ...(imported.notes.length > 0 ? { details: imported.notes } : {}),
      });
    },

    // --------------------------------------------------------------- toasts

    pushToast(toast) {
      const id = newId('toast');
      set({ toasts: [...get().toasts, { ...toast, id }] });
      setTimeout(() => get().dismissToast(id), toast.tone === 'error' ? 12_000 : 5_000);
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
  };
});

// ----------------------------------------------------------------- selectors

export function useDocument(): ArchitectureDocument | null {
  return useEditor((s) => s.project?.document ?? null);
}

export function useSelectedNode(): ArchNode | null {
  return useEditor((s) => {
    if (!s.project || s.selection?.type !== 'node') return null;
    return s.project.document.nodes.find((n) => n.id === s.selection!.id) ?? null;
  });
}

/** Validation runs on every render of the panels that show it; it is cheap. */
export function analyseDocument(document: ArchitectureDocument | null): RoutingResult | null {
  if (!document) return null;
  return validateAndResolve(document);
}
