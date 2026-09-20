/**
 * Project management: create, open, delete, import and export.
 *
 * This lives behind the menu button rather than taking permanent space, because
 * you touch it at the start and end of a session, not while you are working.
 * Renaming happens inline in the top bar instead.
 */
import { useRef, useState } from 'react';
import { TEMPLATES } from '../../domain/defaults';
import { DownloadIcon, TrashIcon, UploadIcon } from '../../ui/icons';
import { Badge, Callout, Section } from '../../ui/primitives';
import { useEditor } from '../editor/store';

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function ProjectsPanel({ onDone }: { onDone?: () => void }) {
  const projects = useEditor((s) => s.projects);
  const current = useEditor((s) => s.project);
  const createProject = useEditor((s) => s.createProject);
  const openProject = useEditor((s) => s.openProject);
  const removeProject = useEditor((s) => s.removeProject);
  const exportCurrent = useEditor((s) => s.exportCurrent);
  const importFile = useEditor((s) => s.importFile);
  const storageOk = useEditor((s) => s.storageOk);

  const [templateId, setTemplateId] = useState(TEMPLATES[0]!.id);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div className="max-h-[70vh] w-[340px] overflow-auto p-4">
      <div className="mb-5 border-b border-line pb-3">
        <div className="text-[13px] font-semibold text-ink">Xparecium</div>
        <div className="mt-0.5 text-[11.5px] text-ink-3">Reveal how your system works</div>
      </div>

      {!storageOk && (
        <div className="mb-4">
          <Callout tone="warn" title="Local storage is unavailable">
            This browser is not letting Xparecium save projects (private browsing often does this).
            You can still build and run — use Export before closing the tab.
          </Callout>
        </div>
      )}

      <Section title="New project" className="mb-5">
        <div className="flex gap-2">
          <select
            className="ap-select flex-1"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            aria-label="Template for a new project"
          >
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ap-btn-primary shrink-0"
            onClick={() => {
              void createProject(templateId);
              onDone?.();
            }}
          >
            Create
          </button>
        </div>
      </Section>

      <Section title="This project" className="mb-5">
        <div className="flex gap-2">
          <button type="button" className="ap-btn-ghost flex-1" onClick={exportCurrent}>
            <DownloadIcon size={14} />
            Export JSON
          </button>
          <button
            type="button"
            className="ap-btn-ghost flex-1"
            onClick={() => fileInput.current?.click()}
          >
            <UploadIcon size={14} />
            Import JSON
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            await importFile(await file.text());
            onDone?.();
          }}
        />
      </Section>

      <Section title="Saved in this browser">
        {projects.length === 0 && <p className="text-[12px] text-ink-3">Nothing saved yet.</p>}
        <ul className="space-y-1.5">
          {projects.map((project) => {
            const isCurrent = project.id === current?.id;
            return (
              <li
                key={project.id}
                className={`rounded-lg border px-3 py-2.5 transition-colors ${
                  isCurrent ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      void openProject(project.id);
                      onDone?.();
                    }}
                  >
                    <span className="block truncate text-[12.5px] font-medium text-ink">
                      {project.name}
                    </span>
                    <span className="block text-[11px] text-ink-3">
                      {project.document.nodes.length} components · saved{' '}
                      {relativeTime(project.updatedAt)}
                    </span>
                  </button>
                  {isCurrent ? (
                    <Badge tone="accent">Open</Badge>
                  ) : (
                    <button
                      type="button"
                      className="ap-icon-btn h-7 w-7 hover:text-bad"
                      aria-label={`Delete ${project.name}`}
                      onClick={() => setConfirmingId(project.id)}
                    >
                      <TrashIcon size={14} />
                    </button>
                  )}
                </div>

                {confirmingId === project.id && (
                  <div className="mt-2.5 flex items-center gap-2 border-t border-line pt-2.5">
                    <span className="flex-1 text-[11.5px] text-ink-2">
                      Delete this project and its runs?
                    </span>
                    <button
                      type="button"
                      className="ap-btn-danger h-7 px-2 text-[11.5px]"
                      onClick={() => {
                        setConfirmingId(null);
                        void removeProject(project.id);
                      }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      className="ap-btn-quiet h-7 px-2 text-[11.5px]"
                      onClick={() => setConfirmingId(null)}
                    >
                      Keep
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="ap-hint">
          Projects are stored in this browser only. They are not sent anywhere and are not synced
          between devices. Export a project to back it up or move it.
        </p>
      </Section>
    </div>
  );
}
