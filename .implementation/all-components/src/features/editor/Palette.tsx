import { SUPPORT_KINDS } from '../../domain/support-services';
/**
 * The component palette: icon tiles grouped by category, with a search box.
 *
 * The long descriptions that used to sit under every entry now live in the
 * tile's tooltip and in the settings panel, where you read them once you have
 * actually placed the component. The palette itself stays scannable.
 */
import { useMemo, useState } from 'react';
import {
  COMPONENT_DESCRIPTIONS,
  COMPONENT_LABELS,
  TEMPLATES,
} from '../../domain/defaults';
import type { ComponentKind } from '../../domain/types';
import { KIND_ICONS, SearchIcon } from '../../ui/icons';
import { Section } from '../../ui/primitives';
import { useEditor } from './store';

/**
 * Grouped, now that there is enough to group.
 *
 * With four components the headings left half-empty rows and said nothing the
 * tile did not, so the palette was one flat grid. Six is the point where the
 * groups start doing work: they say what a component is *for* before you know
 * what it is called.
 */
const CATEGORIES: { title: string; kinds: ComponentKind[] }[] = [
  { title: 'Traffic', kinds: ['client'] },
  { title: 'Edge', kinds: ['dns', 'cdn', 'waf', 'apiGateway'] },
  { title: 'Compute', kinds: ['loadBalancer', 'server', 'serverless'] },
  { title: 'Shared services', kinds: SUPPORT_KINDS },
  { title: 'Data', kinds: ['database', 'readReplica', 'cache', 'kvStore', 'objectStorage', 'documentDb', 'wideColumn', 'searchIndex', 'warehouse', 'timeSeries'] },
  { title: 'Messaging', kinds: ['queue', 'pubsub', 'eventStream', 'deadLetter', 'scheduler'] },
];


const KIND_COLOR: Record<ComponentKind, string> = {
  ...Object.fromEntries(SUPPORT_KINDS.map(k => [k, 'text-kind-edge'])) as Record<(typeof SUPPORT_KINDS)[number], string>,
  eventStream: 'text-kind-queue',
  deadLetter: 'text-kind-queue',
  scheduler: 'text-kind-queue',
  documentDb: 'text-kind-database',
  wideColumn: 'text-kind-database',
  searchIndex: 'text-kind-database',
  warehouse: 'text-kind-database',
  timeSeries: 'text-kind-database',

  client: 'text-kind-client',
  loadBalancer: 'text-kind-balancer',
  server: 'text-kind-server',
  database: 'text-kind-database',
  cache: 'text-kind-cache',
  queue: 'text-kind-queue',
  dns: 'text-kind-edge',
  cdn: 'text-kind-edge',
  waf: 'text-kind-edge',
  apiGateway: 'text-kind-edge',
  serverless: 'text-kind-server',
  readReplica: 'text-kind-database',
  kvStore: 'text-kind-database',
  objectStorage: 'text-kind-database',
  pubsub: 'text-kind-queue',
};

function Tile({ kind, onAdd }: { kind: ComponentKind; onAdd: () => void }) {
  const Glyph = KIND_ICONS[kind];
  return (
    <button
      type="button"
      onClick={onAdd}
      title={COMPONENT_DESCRIPTIONS[kind]}
      className="flex h-[74px] flex-col items-center justify-center gap-1.5 rounded-xl border border-line bg-surface px-2 transition-colors hover:border-accent hover:bg-accent-soft"
    >
      <span className={KIND_COLOR[kind]}>
        <Glyph size={20} />
      </span>
      <span className="text-center text-[11.5px] font-medium leading-tight text-ink-2">
        {COMPONENT_LABELS[kind]}
      </span>
    </button>
  );
}

export function Palette() {
  const addComponent = useEditor((s) => s.addComponent);
  const mutate = useEditor((s) => s.mutate);
  const select = useEditor((s) => s.select);
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();

  const categories = useMemo(() => {
    if (!needle) return CATEGORIES;
    return CATEGORIES.map((category) => ({
      ...category,
      kinds: category.kinds.filter(
        (kind) =>
          COMPONENT_LABELS[kind].toLowerCase().includes(needle) ||
          COMPONENT_DESCRIPTIONS[kind].toLowerCase().includes(needle),
      ),
    })).filter((category) => category.kinds.length > 0);
  }, [needle]);
  const anyKinds = categories.some((c) => c.kinds.length > 0);

  const templates = useMemo(
    () =>
      needle
        ? TEMPLATES.filter(
            (t) =>
              t.name.toLowerCase().includes(needle) || t.summary.toLowerCase().includes(needle),
          )
        : TEMPLATES,
    [needle],
  );

  return (
    <div className="p-4">
      <div className="relative mb-5">
        <SearchIcon
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
        />
        <input
          className="ap-input pl-8"
          placeholder="Search components"
          aria-label="Search components"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="space-y-6">
        {categories.map((category) => (
          <Section key={category.title} title={category.title}>
            <div className="grid grid-cols-2 gap-2">
              {category.kinds.map((kind) => (
                <Tile key={kind} kind={kind} onAdd={() => addComponent(kind)} />
              ))}
            </div>
          </Section>
        ))}

        {!anyKinds && templates.length === 0 && (
          <p className="py-6 text-center text-[12px] text-ink-3">
            Nothing matches “{query}”.
          </p>
        )}

        {templates.length > 0 && (
          <Section title="Start over with">
            <div className="space-y-1.5">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  title={template.summary}
                  onClick={() => {
                    mutate((draft) => {
                      const next = template.build();
                      draft.nodes = next.nodes;
                      draft.edges = next.edges;
                      draft.workload = next.workload;
                    });
                    select(null);
                  }}
                  className="w-full rounded-lg border border-line px-3 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft"
                >
                  <span className="block text-[12.5px] font-medium text-ink">{template.name}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-ink-3">
                    {template.summary}
                  </span>
                </button>
              ))}
            </div>
            <p className="ap-hint">Replacing the canvas is a single undo step.</p>
          </Section>
        )}
      </div>
    </div>
  );
}
