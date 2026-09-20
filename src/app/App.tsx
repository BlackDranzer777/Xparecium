/**
 * The Xparecium shell.
 *
 * The canvas fills the viewport. Everything else floats above it as a card and
 * can be put away: the palette and settings share one panel on the right, the
 * run controls sit in a bar along the bottom, results slide up over them, and
 * project management lives behind the menu button. The thing you are meant to
 * play with gets the screen.
 */
import { useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from '../features/editor/Canvas';
import { ControlBar } from '../features/editor/ControlBar';
import { Inspector } from '../features/editor/Inspector';
import { Palette } from '../features/editor/Palette';
import { ProjectsPanel } from '../features/projects/ProjectsPanel';
import { ResultsSheet } from '../features/results/ResultsPanel';
import {
  GridIcon,
  MenuToggleIcon,
  MoonIcon,
  RedoIcon,
  SunIcon,
  UndoIcon,
} from '../ui/icons';
import { Callout, Popover, SegmentedControl } from '../ui/primitives';
import { useEditor } from '../features/editor/store';
import { useTheme } from './theme';

type RightTab = 'components' | 'settings';

/* --------------------------------------------------------------- top left */

function SaveIndicator() {
  const status = useEditor((s) => s.saveStatus);
  const error = useEditor((s) => s.saveError);
  const storageOk = useEditor((s) => s.storageOk);

  const [dot, text, title] = !storageOk
    ? ['bg-warn', 'Not saving', error ?? 'This browser is not allowing local storage.']
    : status === 'error'
      ? ['bg-bad', 'Save failed', error ?? '']
      : status === 'saving'
        ? ['bg-ink-3', 'Saving', 'Writing to this browser’s storage']
        : status === 'pending'
          ? ['bg-ink-3', 'Unsaved', 'Changes will be saved in a moment']
          : status === 'saved'
            ? ['bg-ok', 'Saved', 'Saved in this browser']
            : ['bg-ink-3', '', ''];

  if (!text) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 pr-1" title={title}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      <span className="hidden text-[11.5px] text-ink-3 lg:inline">{text}</span>
    </span>
  );
}

function TopLeft() {
  const project = useEditor((s) => s.project);
  const renameProject = useEditor((s) => s.renameProject);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.undoStack.length > 0);
  const canRedo = useEditor((s) => s.redoStack.length > 0);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="pointer-events-auto absolute left-5 top-5 z-20 flex items-center gap-2">
      <div className="ap-card flex items-center gap-1 py-1 pl-1 pr-2 shadow-float">
        <div className="relative">
          <button
            type="button"
            className="ap-icon-btn"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-label="Projects, import and export"
            title={menuOpen ? 'Close the menu' : 'Projects, import and export'}
          >
            <MenuToggleIcon size={16} open={menuOpen} />
          </button>
          <Popover open={menuOpen} onClose={() => setMenuOpen(false)} placement="below">
            <ProjectsPanel onDone={() => setMenuOpen(false)} />
          </Popover>
        </div>

        <span className="select-none px-1 text-[14px] font-extrabold tracking-tight text-ink">
          <span className="text-accent">X</span>parecium
        </span>

        <span className="mx-1 h-5 w-px bg-line" aria-hidden />

        <label className="sr-only" htmlFor="project-name">
          Project name
        </label>
        <input
          id="project-name"
          className="w-[168px] rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13px] text-ink-2 transition-colors hover:border-line focus:border-accent focus:text-ink focus:outline-none"
          value={project?.name ?? ''}
          onChange={(e) => renameProject(e.target.value)}
          placeholder="Untitled project"
        />
        <SaveIndicator />
      </div>

      <div className="ap-card flex items-center p-1 shadow-float">
        <button
          type="button"
          className="ap-icon-btn disabled:opacity-30"
          onClick={undo}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
        >
          <UndoIcon size={16} />
        </button>
        <button
          type="button"
          className="ap-icon-btn disabled:opacity-30"
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo (Ctrl+Shift+Z)"
        >
          <RedoIcon size={16} />
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- top right */

function TopRight({
  panelOpen,
  togglePanel,
}: {
  panelOpen: boolean;
  togglePanel: () => void;
}) {
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggle);

  return (
    <div className="pointer-events-auto absolute right-5 top-5 z-20">
      <div className="ap-card flex items-center p-1 shadow-float">
        <button
          type="button"
          className="ap-icon-btn"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
          title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
        >
          {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </button>
        <button
          type="button"
          className="ap-icon-btn"
          onClick={togglePanel}
          aria-pressed={panelOpen}
          aria-label={panelOpen ? 'Hide the side panel' : 'Show the side panel'}
          title={panelOpen ? 'Hide the side panel' : 'Show the side panel'}
        >
          <GridIcon size={16} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ right panel */

function SidePanel() {
  const selection = useEditor((s) => s.selection);
  const [tab, setTab] = useState<RightTab>('components');

  // Selecting something on the canvas is a request to see its settings.
  useEffect(() => {
    if (selection) setTab('settings');
  }, [selection]);

  return (
    <div className="pointer-events-auto absolute bottom-5 right-5 top-[72px] z-20 flex w-[324px] flex-col items-stretch">
      {/* Sizes to its content up to the available height, rather than always
          stretching: the palette is short, the settings form is long. */}
      <div className="ap-card flex max-h-full min-h-0 flex-col shadow-float">
        <div className="shrink-0 border-b border-line p-2.5">
          <SegmentedControl
            label="Side panel"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'components', label: 'Components' },
              { value: 'settings', label: 'Settings' },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {tab === 'components' ? <Palette /> : <Inspector />}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- toasts */

function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  const dismiss = useEditor((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-5 z-40 flex w-[420px] -translate-x-1/2 flex-col gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto ap-card overflow-hidden shadow-float">
          <Callout
            tone={toast.tone === 'error' ? 'bad' : toast.tone === 'success' ? 'good' : 'neutral'}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-ink">{toast.message}</div>
                {toast.details && toast.details.length > 0 && (
                  <ul className="mt-1.5 list-disc pl-4 text-[11px] text-ink-3">
                    {toast.details.slice(0, 5).map((detail, index) => (
                      <li key={index}>{detail}</li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                type="button"
                aria-label="Dismiss message"
                className="shrink-0 text-ink-3 transition-colors hover:text-ink"
                onClick={() => dismiss(toast.id)}
              >
                ×
              </button>
            </div>
          </Callout>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- app */

export default function App() {
  const initialise = useEditor((s) => s.initialise);
  const ready = useEditor((s) => s.ready);
  const catalogError = useEditor((s) => s.catalogError);
  const catalogNotes = useEditor((s) => s.catalogNotes);
  const bootError = useEditor((s) => s.bootError);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const run = useEditor((s) => s.run);

  const [panelOpen, setPanelOpen] = useState(true);

  // The results sheet grows and shrinks. Measuring the bottom stack rather than
  // guessing its height is what keeps the diagram framed in the space that is
  // actually free, so a component is always clickable after a run.
  const bottomStack = useRef<HTMLDivElement>(null);
  const [bottomInset, setBottomInset] = useState(96);
  useEffect(() => {
    const element = bottomStack.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => setBottomInset(element.getBoundingClientRect().height + 16);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    void initialise();
  }, [initialise]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        redo();
      } else if (key === 'enter') {
        event.preventDefault();
        void run();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo, run]);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <div className="text-center">
          <p className="text-[17px] font-semibold text-ink">Xparecium</p>
          <p className="mt-1.5 text-[12px] text-ink-3">Preparing your workspace…</p>
        </div>
      </div>
    );
  }

  const notices = [
    ...(catalogError ? [catalogError] : []),
    ...(bootError ? [bootError] : []),
    ...catalogNotes,
  ];

  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      <ReactFlowProvider>
        <Canvas rightInset={panelOpen ? 364 : 0} bottomInset={bottomInset} />
      </ReactFlowProvider>

      <TopLeft />
      <TopRight panelOpen={panelOpen} togglePanel={() => setPanelOpen((v) => !v)} />
      {panelOpen && <SidePanel />}

      {notices.length > 0 && (
        <div className="pointer-events-auto absolute left-5 top-[72px] z-20 w-[420px] space-y-2">
          {notices.map((notice) => (
            <div key={notice} className="ap-card overflow-hidden shadow-float">
              <Callout tone="warn">{notice}</Callout>
            </div>
          ))}
        </div>
      )}

      <div
        ref={bottomStack}
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-3 px-5 pb-5 ${
          panelOpen ? 'pr-[360px]' : ''
        }`}
      >
        <div className="pointer-events-auto w-full max-w-[1080px]">
          <ResultsSheet />
        </div>
        <div className="pointer-events-auto max-w-full overflow-x-auto">
          <ControlBar />
        </div>
      </div>

      <Toasts />
    </div>
  );
}
