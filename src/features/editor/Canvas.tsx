import { SUPPORT_SERVICES, isSupportKind } from '../../domain/support-services';
import { isJobKind, JOB_SERVICES } from '../../domain/job-services';
import { isDataKind, DATA_SERVICES } from '../../domain/data-services';
/**
 * The architecture canvas.
 *
 * React Flow draws the graph, but it does not own it. The nodes and edges
 * handed to React Flow are derived from the architecture document on every
 * render; user gestures are translated back into document edits. That keeps a
 * single source of truth and makes undo, autosave and export trivially correct.
 *
 * The canvas fills the whole viewport. Every panel floats above it.
 *
 * After a run, each component shows its *own* result — a utilisation bar, a
 * status dot and one line of detail that belongs to that kind of component and
 * nothing else — and traffic is drawn moving along the connections it used.
 */
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  BaseEdge,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getBezierPath,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import type {
  Connection,
  Edge,
  EdgeProps,
  Node,
  NodeChange,
  NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { COMPONENT_LABELS } from '../../domain/defaults';
import type { ArchitectureDocument, ComponentKind } from '../../domain/types';
import { clientRequestRate } from '../../simulation/engine';
import type { ValidationIssue } from '../../simulation/routing';
import { formatNumber, formatRate } from '../../domain/units';
import { KIND_ICONS } from '../../ui/icons';
import { kindTintClass } from '../../ui/kind-style';
import { activeEdgeIds, nodeMetricsFrom } from '../results/node-metrics';
import type { NodeMetric } from '../results/node-metrics';
import { analyseDocument, useEditor } from './store';

/**
 * The node card is a fixed box: the framing maths and the CSS share these.
 * It grows by one row when a run has something to show for that component.
 */
const NODE_WIDTH = 212;
const NODE_HEIGHT = 88;
const NODE_HEIGHT_WITH_METRIC = 118;

// On a pastel card the status colours are the dark shades in both themes.
const TONE_DOT: Record<NodeMetric['tone'], string> = {
  ok: 'bg-ok-on-tint',
  warn: 'bg-warn-on-tint',
  bad: 'bg-bad-on-tint',
};

const TONE_BAR: Record<NodeMetric['tone'], string> = {
  ok: 'bg-ok-on-tint',
  warn: 'bg-warn-on-tint',
  bad: 'bg-bad-on-tint',
};

const TONE_TEXT: Record<NodeMetric['tone'], string> = {
  ok: 'text-ok-on-tint',
  warn: 'text-warn-on-tint',
  bad: 'text-bad-on-tint',
};

interface ComponentNodeData extends Record<string, unknown> {
  kind: ComponentKind;
  title: string;
  summary: string;
  hasError: boolean;
  hasWarning: boolean;
  metric: NodeMetric | null;
}

type ComponentNode = Node<ComponentNodeData, 'component'>;

/**
 * One connection point per side, all of them `source`. With
 * `ConnectionMode.Loose` a source handle also accepts an incoming connection,
 * so you can drag between any two edges of any two components without having
 * to find the one "correct" dot. Handle ids are unused: `onConnect` only needs
 * which node you started from and which you dropped on.
 */
const HANDLE_SIDES = [
  { id: 't', position: Position.Top },
  { id: 'r', position: Position.Right },
  { id: 'b', position: Position.Bottom },
  { id: 'l', position: Position.Left },
] as const;

/**
 * Whether a component's name says nothing its type does not already say.
 *
 * Covers the names the app gives components itself: the type label, and the
 * type label with the number that keeps two of them apart.
 */
function namesItsOwnType(name: string, kind: ComponentKind): boolean {
  const label = COMPONENT_LABELS[kind].toLowerCase();
  const trimmed = name.trim().toLowerCase();
  if (trimmed === label) return true;
  // Built rather than matched with a pattern: the label is data, and dropping
  // it into a regular expression would make its punctuation meaningful.
  const rest = trimmed.startsWith(`${label} `) ? trimmed.slice(label.length + 1) : null;
  return rest !== null && rest.length > 0 && /^\d+$/.test(rest);
}

const ComponentNodeView = memo(function ComponentNodeView({
  data,
  selected,
}: NodeProps<ComponentNode>) {
  const Glyph = KIND_ICONS[data.kind];
  const metric = data.metric;
  // The card wears its category's colour; the outline says how it is doing.
  const ring = data.hasError
    ? 'border-bad ring-2 ring-bad-soft'
    : selected
      ? 'border-accent ring-2 ring-accent-soft'
      : metric?.tone === 'bad'
        ? 'border-bad'
        : data.hasWarning
          ? 'border-warn'
          : 'border-outline';

  return (
    <div
      style={{ width: NODE_WIDTH, height: metric ? NODE_HEIGHT_WITH_METRIC : NODE_HEIGHT }}
      className={`relative flex flex-col overflow-hidden rounded-node border-2 px-3.5 py-3 text-ink-on-tint shadow-node transition-colors ${kindTintClass(data.kind)} ${ring}`}
    >
      {HANDLE_SIDES.map((side) => (
        <Handle key={side.id} id={side.id} type="source" position={side.position} />
      ))}

      {/* The status dot is the at-a-glance answer: is this component coping? */}
      {metric && (
        <span
          className={`absolute right-2.5 top-2.5 h-2 w-2 rounded-full ${TONE_DOT[metric.tone]}`}
          aria-hidden
        />
      )}

      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-ink-on-tint">
          <Glyph size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate pr-3 text-[13.5px] font-bold leading-tight text-ink-on-tint">
            {data.title}
          </div>
          {/* The type, unless the name already is the type — a component called
              "Application Server", or "Application Server 2", does not need
              APPLICATION SERVER printed under it. The icon says which kind it is
              either way, and renaming it to something of your own brings the
              line back. */}
          {!namesItsOwnType(data.title, data.kind) && (
            <div className="ap-eyebrow mt-1 text-ink-on-tint-2">{COMPONENT_LABELS[data.kind]}</div>
          )}
        </div>
      </div>

      <div className="mt-2.5 truncate font-mono text-[11px] leading-snug text-ink-on-tint-2">
        {metric ? metric.detail : data.summary}
      </div>

      {/* Holds the detail line and the bar at the same height on every card,
          whether or not the type line above is showing. */}
      <div className="flex-1" aria-hidden />

      {metric && (
        <div className="mt-2 flex items-center gap-2">
          {metric.utilisation !== null && (
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-tint-track">
              <div
                className={`h-full rounded-full ${TONE_BAR[metric.tone]}`}
                style={{ width: `${Math.min(100, Math.max(2, metric.utilisation * 100))}%` }}
              />
            </div>
          )}
          <span
            className={`shrink-0 font-mono text-[11px] font-semibold ${TONE_TEXT[metric.tone]} ${
              metric.utilisation === null ? 'flex-1' : ''
            }`}
          >
            {metric.headline}
          </span>
        </div>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------- edges */

interface FlowEdgeData extends Record<string, unknown> {
  label: string;
  /** Carried traffic in the run being shown. */
  carried: boolean;
  /** Draw packets moving along it right now. */
  flowing: boolean;
  failing: boolean;
}

/**
 * A connection, drawn as a curve, with packets travelling along it while a
 * simulation is running.
 *
 * The dots are three SVG circles following the same path with staggered start
 * times. `animateMotion` runs on the browser's own animation timeline, so it
 * costs nothing per frame in React and does not tie the picture to the
 * simulation's clock — which is a good thing, because simulated time runs
 * thousands of times faster than real time.
 *
 * Each circle follows the drawn line by reference — `<mpath>` pointing at the
 * `<path>` `BaseEdge` renders — rather than carrying its own copy of the
 * geometry in a `path` attribute. Dragging a component redraws the connections
 * touching it on every frame, and SMIL leaves the effect of rewriting a running
 * animation's own attributes up to the implementation. Chrome was measured to
 * carry on smoothly either way; `mpath` is the spelling that does not depend on
 * that, and it leaves the animation elements untouched by a drag entirely.
 */
const FlowEdge = memo(function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<Edge<FlowEdgeData>>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const stroke = data?.failing
    ? 'var(--bad)'
    : selected
      ? 'var(--accent)'
      : data?.carried
        ? 'var(--accent)'
        : 'var(--line-strong)';

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke,
          strokeWidth: selected ? 2.25 : data?.carried ? 1.75 : 1.5,
          opacity: data?.carried || selected || data?.failing ? 1 : 0.85,
        }}
      />
      {/* Rendered always and shown with opacity, rather than mounted and
          unmounted: an animateMotion that appears mid-animation starts from a
          cold clock, and remounting three of them per edge on every run is
          churn for no gain. */}
      {[0, 1, 2].map((index) => (
        <circle
          key={index}
          className="ap-packet"
          r={3.2}
          fill="var(--accent)"
          style={{ opacity: data?.flowing ? 1 : 0, transition: 'opacity 220ms ease' }}
        >
          <animateMotion dur="1.5s" repeatCount="indefinite" begin={`${index * 0.5}s`}>
            {/* href is the SVG 2 spelling; xlink:href is what older engines
                read. Both name the same path, and a browser that understands
                neither would simply show no dots. */}
            <mpath href={`#${id}`} xlinkHref={`#${id}`} />
          </animateMotion>
        </circle>
      ))}
      {/* The bandwidth and delay only appear on the connection you are looking
          at. Printed on every link they turned the diagram into a wall of
          repeated text, and the settings panel shows them in full anyway. */}
      {selected && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className="pointer-events-none absolute rounded-full border-[1.5px] border-outline bg-surface px-2 py-0.5 font-mono text-[10px] font-semibold text-ink shadow-card"
          >
            {data?.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const nodeTypes = { component: ComponentNodeView };
const edgeTypes = { flow: FlowEdge };

/* --------------------------------------------------------------- summaries */

/** What a component says about itself before anything has been run. */
function summarise(document: ArchitectureDocument, nodeId: string): string {
  const node = document.nodes.find((n) => n.id === nodeId);
  if (!node) return '';
  if (isSupportKind(node.kind)) return SUPPORT_SERVICES[node.kind].label;
  if (isJobKind(node.kind)) return JOB_SERVICES[node.kind].label;
  if (isDataKind(node.kind)) return DATA_SERVICES[node.kind].label;
  switch (node.kind) {
    case 'client':
      return `${formatRate(clientRequestRate(node))} offered`;
    case 'loadBalancer':
      return `${node.settings.policy === 'least-busy' ? 'least busy' : 'round robin'} · ${node.settings.serviceTimeMs} ms`;
    case 'server':
      return `${node.settings.cpuSlots} CPU · ${formatNumber(node.settings.ramMb / 1024, 1)} GB · ${node.settings.cpuMsPerRequest} ms/req`;
    case 'database':
      return `${node.settings.queryServiceTimeMs} ms · ${node.settings.maxConcurrentQueries} slots · ${node.settings.dataSizeGb} GB`;
    case 'cache':
      return `${formatNumber(node.settings.hitRate * 100, 0)}% hit · ${node.settings.lookupServiceTimeMs} ms · ${node.settings.capacityGb} GB`;
    case 'queue':
      return `holds ${formatNumber(node.settings.maxDepth)} · ${node.settings.publishServiceTimeMs} ms publish`;
    case 'dns':
      return `${formatNumber(node.settings.lookupShare * 100, 0)}% look up · ${node.settings.lookupServiceTimeMs} ms`;
    case 'cdn':
      return `${formatNumber(node.settings.hitRate * 100, 0)}% hit at the edge · ${node.settings.serviceTimeMs} ms`;
    case 'waf':
      return `blocks ${formatNumber(node.settings.blockRate * 100, 1)}% · ${node.settings.serviceTimeMs} ms`;
    case 'apiGateway':
      return node.settings.rateLimitPerSecond === null
        ? `no rate limit · ${node.settings.serviceTimeMs} ms`
        : `limit ${formatNumber(node.settings.rateLimitPerSecond)}/s · ${node.settings.serviceTimeMs} ms`;
    case 'serverless':
      return `${node.settings.memoryMb} MB · ${node.settings.cpuMsPerRequest} ms · up to ${formatNumber(node.settings.maxConcurrentInvocations)} at once`;
    case 'readReplica':
      return `${node.settings.maxConcurrentQueries} slots · ${node.settings.queryServiceTimeMs} ms read`;
    case 'kvStore':
      return `${formatNumber(node.settings.readShare * 100, 0)}% reads · ${node.settings.readServiceTimeMs}/${node.settings.writeServiceTimeMs} ms`;
    case 'objectStorage':
      return `${formatNumber(node.settings.storedGb)} GB kept · ${formatNumber(node.settings.writeShare * 100, 0)}% writes`;
    case 'pubsub':
      return `holds ${formatNumber(node.settings.maxDepth)} per listener · ${node.settings.publishServiceTimeMs} ms publish`;
  }
}

/**
 * Which side of each component a connection should leave from and arrive at.
 *
 * All four sides accept connections, but React Flow has to be told which pair
 * to draw between or it uses the first one it finds — which sends every line
 * out of the top of the node and arcs it over the diagram. Picking by geometry
 * gives the flat left-to-right routing a diagram like this wants, and it
 * re-picks as soon as a component is dragged somewhere else.
 */
function pickHandles(
  from: { x: number; y: number },
  to: { x: number; y: number },
  nodeHeight: number,
): { sourceHandle: string; targetHandle: string } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // Compare against the node's own size so a small vertical offset between two
  // components that are mostly side by side still routes horizontally.
  if (Math.abs(dx) / NODE_WIDTH >= Math.abs(dy) / nodeHeight) {
    return dx >= 0
      ? { sourceHandle: 'r', targetHandle: 'l' }
      : { sourceHandle: 'l', targetHandle: 'r' };
  }
  return dy >= 0
    ? { sourceHandle: 'b', targetHandle: 't' }
    : { sourceHandle: 't', targetHandle: 'b' };
}

function issueIndex(issues: ValidationIssue[]): {
  errorNodes: Set<string>;
  warnNodes: Set<string>;
  errorEdges: Set<string>;
} {
  const errorNodes = new Set<string>();
  const warnNodes = new Set<string>();
  const errorEdges = new Set<string>();
  for (const issue of issues) {
    for (const id of issue.nodeIds ?? []) {
      (issue.severity === 'error' ? errorNodes : warnNodes).add(id);
    }
    if (issue.severity === 'error') for (const id of issue.edgeIds ?? []) errorEdges.add(id);
  }
  return { errorNodes, warnNodes, errorEdges };
}

/* ---------------------------------------------------------------- framing */

/**
 * Frames the diagram in the part of the canvas that is actually visible.
 *
 * The canvas runs edge to edge, but the side panel and the results sheet sit on
 * top of parts of it. React Flow's own `fitView` centres in the full container,
 * which put components underneath them. This fits against the uncovered band
 * instead, and re-fits when a panel opens or closes or when the set of
 * components changes — but not while you drag, so it never fights with panning.
 */
function FitToVisibleArea({
  rightInset,
  topInset,
  bottomInset,
  nodeSignature,
  nodeHeight,
  positions,
}: {
  rightInset: number;
  topInset: number;
  bottomInset: number;
  /** Changes when components are added or removed, not when one is dragged. */
  nodeSignature: string;
  nodeHeight: number;
  positions: { x: number; y: number }[];
}) {
  const { setViewport } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // setViewport is silently dropped before React Flow has built its pan/zoom
  // instance, which is exactly when this effect first fires. Waiting for it is
  // the difference between the fit working and doing nothing at all.
  const panZoomReady = useStore((s) => s.panZoom !== null);

  // Read through a ref so a drag (which changes positions on every frame) does
  // not re-trigger the fit; only the signature and the insets do.
  const latest = useRef(positions);
  latest.current = positions;

  useEffect(() => {
    const nodes = latest.current;
    if (!panZoomReady || width === 0 || height === 0 || nodes.length === 0) return;

    const left = Math.min(...nodes.map((p) => p.x));
    const top = Math.min(...nodes.map((p) => p.y));
    const right = Math.max(...nodes.map((p) => p.x)) + NODE_WIDTH;
    const bottom = Math.max(...nodes.map((p) => p.y)) + nodeHeight;

    const visibleWidth = Math.max(240, width - rightInset);
    const visibleHeight = Math.max(200, height - topInset - bottomInset);

    const margin = Math.max(20, Math.min(56, visibleHeight * 0.14, visibleWidth * 0.08));
    const zoom = Math.min(
      1,
      (visibleWidth - margin * 2) / Math.max(1, right - left),
      (visibleHeight - margin * 2) / Math.max(1, bottom - top),
      2,
    );
    const safeZoom = Math.max(0.2, zoom);

    setViewport({
      zoom: safeZoom,
      x: visibleWidth / 2 - ((left + right) / 2) * safeZoom,
      y: topInset + visibleHeight / 2 - ((top + bottom) / 2) * safeZoom,
      // No transition: setViewport with a duration is silently dropped while
      // React Flow is still setting itself up, which is exactly when this first
      // runs. Framing the diagram instantly on load is the better behaviour
      // anyway.
    });
  }, [
    panZoomReady,
    rightInset,
    topInset,
    bottomInset,
    nodeSignature,
    nodeHeight,
    width,
    height,
    setViewport,
  ]);

  return null;
}

/* ------------------------------------------------------------------ canvas */

export function Canvas({
  rightInset = 0,
  topInset = 76,
  bottomInset = 96,
}: {
  /** Width covered by the side panel. */
  rightInset?: number;
  /** Height covered by the floating top bar. */
  topInset?: number;
  /** Height covered by the control bar and the results sheet. */
  bottomInset?: number;
}) {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const mutate = useEditor((s) => s.mutate);
  const select = useEditor((s) => s.select);
  const connect = useEditor((s) => s.connect);
  const deleteNode = useEditor((s) => s.deleteNode);
  const deleteEdge = useEditor((s) => s.deleteEdge);
  const beginUndoGroup = useEditor((s) => s.beginUndoGroup);
  const commitUndoGroup = useEditor((s) => s.commitUndoGroup);
  const latestRun = useEditor((s) => s.latestRun);
  const live = useEditor((s) => s.live);
  const running = useEditor((s) => s.running);

  const document = project?.document ?? null;
  const routing = useMemo(() => analyseDocument(document), [document]);
  const marks = useMemo(() => issueIndex(routing?.issues ?? []), [routing]);

  // The last result stays on the components until a newer one replaces it.
  // Blanking it the instant the design was edited emptied every card and
  // stopped the traffic for as long as the re-run took, which read as the
  // simulation having quit — and it never came back at all when the edit left
  // the design in a state that cannot be simulated. The results strip says
  // "Earlier configuration" while the numbers are behind the canvas, which is
  // where that belongs.
  const shownResult = latestRun?.result ?? null;
  const metrics = useMemo(() => nodeMetricsFrom(shownResult), [shownResult]);
  const carried = useMemo(() => activeEdgeIds(shownResult), [shownResult]);

  // Only an actively executing session animates. A completed timed run or a
  // reopened historical snapshot must not look like new work is happening.
  const flowing = running && live && shownResult?.status === 'running';

  const nodeSignature = useMemo(
    () => (document ? document.nodes.map((n) => n.id).join('|') : ''),
    [document],
  );
  const positions = useMemo(
    () => (document ? document.nodes.map((n) => n.position) : []),
    [document],
  );

  const nodeHeight = metrics.size > 0 ? NODE_HEIGHT_WITH_METRIC : NODE_HEIGHT;

  const nodes = useMemo<ComponentNode[]>(() => {
    if (!document) return [];
    return document.nodes.map((node) => ({
      id: node.id,
      type: 'component' as const,
      position: node.position,
      width: NODE_WIDTH,
      height: nodeHeight,
      // Every edit rebuilds these node objects, and React Flow throws away a
      // node's measured handle positions whenever it is handed a node without
      // `measured` — it assumes the node was re-initialised and waits to
      // measure it again. An edge whose endpoints have no handle positions
      // renders as nothing at all, so each edit unmounted every connection for
      // a frame and remounted it: the line flickered and its traffic restarted.
      // Declaring the size we already fix in CSS keeps the bounds alive.
      measured: { width: NODE_WIDTH, height: nodeHeight },
      selected: selection?.type === 'node' && selection.id === node.id,
      data: {
        kind: node.kind,
        title: node.name,
        summary: summarise(document, node.id),
        hasError: marks.errorNodes.has(node.id),
        hasWarning: marks.warnNodes.has(node.id),
        metric: metrics.get(node.id) ?? null,
      },
    }));
  }, [document, selection, marks, metrics, nodeHeight]);

  const edges = useMemo<Edge<FlowEdgeData>[]>(() => {
    if (!document) return [];
    const positionById = new Map(document.nodes.map((n) => [n.id, n.position]));
    return document.edges.map((edge) => {
      const from = positionById.get(edge.source);
      const to = positionById.get(edge.target);
      const sides = from && to ? pickHandles(from, to, nodeHeight) : null;
      return {
      id: edge.id,
      type: 'flow' as const,
      source: edge.source,
      target: edge.target,
      ...(sides ?? {}),
      selected: selection?.type === 'edge' && selection.id === edge.id,
      data: {
        label: `${edge.settings.bandwidthMbps} Mbps · ${edge.settings.propagationDelayMs} ms`,
        carried: carried.has(edge.id),
        // Only links that are part of a working route show traffic.
        flowing: flowing && !marks.errorEdges.has(edge.id),
        failing: marks.errorEdges.has(edge.id),
      },
      };
    });
  }, [document, selection, marks, carried, flowing, nodeHeight]);

  const onNodesChange = useCallback(
    (changes: NodeChange<ComponentNode>[]) => {
      const moves = changes.filter(
        (c): c is Extract<NodeChange<ComponentNode>, { type: 'position' }> =>
          c.type === 'position' && Boolean(c.position),
      );
      if (moves.length === 0) return;
      // Position updates are not individually undoable: one drag produces many
      // of them. The undo entry is captured on drag start instead.
      mutate(
        (draft) => {
          for (const move of moves) {
            const node = draft.nodes.find((n) => n.id === move.id);
            if (node && move.position) node.position = { ...move.position };
          }
        },
        { undoable: false },
      );
    },
    [mutate],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) connect(connection.source, connection.target);
    },
    [connect],
  );

  if (!document) return <div className="h-full w-full bg-canvas" />;

  return (
    <div className="ap-reveal-wash relative h-full w-full">
      <ReactFlow<ComponentNode, Edge<FlowEdgeData>>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeDragStart={beginUndoGroup}
        onNodeDragStop={commitUndoGroup}
        onNodeClick={(_, node) => select({ type: 'node', id: node.id })}
        onEdgeClick={(_, edge) => select({ type: 'edge', id: edge.id })}
        onPaneClick={() => select(null)}
        onNodesDelete={(deleted) => deleted.forEach((n) => deleteNode(n.id))}
        onEdgesDelete={(deleted) => deleted.forEach((e) => deleteEdge(e.id))}
        deleteKeyCode={['Delete', 'Backspace']}
        minZoom={0.2}
        maxZoom={1.75}
        proOptions={{ hideAttribution: false }}
        aria-label="Architecture canvas"
      >
        <FitToVisibleArea
          rightInset={rightInset}
          topInset={topInset}
          bottomInset={bottomInset}
          nodeSignature={nodeSignature}
          nodeHeight={nodeHeight}
          positions={positions}
        />
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--canvas-dot)" />
        <Controls
          showInteractive={false}
          position="bottom-left"
          style={{ marginBottom: 18, marginLeft: 18 }}
        />
      </ReactFlow>
    </div>
  );
}
