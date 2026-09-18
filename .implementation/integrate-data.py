from pathlib import Path
import json
root = Path(__file__).parent / 'all-components'
def edit(file, old, new, count=1):
    p=root/file
    s=p.read_text(encoding='utf-8')
    assert s.count(old)==count, (file, old[:70], s.count(old))
    p.write_text(s.replace(old,new),encoding='utf-8')
def prepend(file, text):
    p=root/file; p.write_text(text+p.read_text(encoding='utf-8'),encoding='utf-8')
kinds=['documentDb','wideColumn','searchIndex','warehouse','timeSeries']
labels=['Document database','Wide-column store','Search index','Data warehouse','Time-series database']
kindstr=', '.join(repr(k) for k in kinds)
prepend('src/domain/types.ts',"import type { DataKind, DataServiceNode } from './data-services';\n")
edit('src/domain/types.ts','DOCUMENT_SCHEMA_VERSION = 5','DOCUMENT_SCHEMA_VERSION = 6')
edit('src/domain/types.ts',"  | 'pubsub';","  | 'pubsub'\n  | DataKind;")
edit('src/domain/types.ts','interface NodeBase {','export interface NodeBase {')
edit('src/domain/types.ts','export type ArchNode =','export type ArchNode =\n  | DataServiceNode')
prepend('src/domain/defaults.ts',"import { DATA_SERVICES, dataDefaults } from './data-services';\n")
for k in kinds:
    edit('src/domain/defaults.ts','export const DEFAULT_CLOUD_PROFILE_BY_KIND: Record<ComponentKind, string | null> = {',f"export const DEFAULT_CLOUD_PROFILE_BY_KIND: Record<ComponentKind, string | null> = {{\n  {k}: 'generic.{k}',")
    edit('src/domain/defaults.ts','export const COMPONENT_LABELS: Record<ComponentKind, string> = {',f"export const COMPONENT_LABELS: Record<ComponentKind, string> = {{\n  {k}: DATA_SERVICES.{k}.label,")
    edit('src/domain/defaults.ts','export const COMPONENT_DESCRIPTIONS: Record<ComponentKind, string> = {',f"export const COMPONENT_DESCRIPTIONS: Record<ComponentKind, string> = {{\n  {k}: DATA_SERVICES.{k}.description,")
edit('src/domain/defaults.ts','  switch (kind) {','  switch (kind) {\n'+''.join(f"    case '{k}': return {{ ...base, kind, settings: dataDefaults(kind) }};\n" for k in kinds))
prepend('src/domain/schema.ts',"import { DATA_SERVICES } from './data-services';\nimport type { DataKind, DataSettings, NumericSetting } from './data-services';\n")
edit('src/domain/schema.ts',"export const archNodeSchema =",'''function dataSettingsSchema<K extends DataKind>(kind: K): z.ZodType<DataSettings<K>> {
  const shape = Object.fromEntries(Object.entries(DATA_SERVICES[kind].fields).map(([key, spec]) => {
    const field: NumericSetting = spec;
    let value = z.number().finite().min(field.min).max(field.max);
    if (field.integer) value = value.int();
    return [key, value];
  }));
  return z.object(shape) as unknown as z.ZodType<DataSettings<K>>;
}

export const archNodeSchema =''')
edit('src/domain/schema.ts',"z.discriminatedUnion('kind', [", "z.discriminatedUnion('kind', [\n"+''.join(f"  z.object({{ ...nodeBase, kind: z.literal('{k}'), settings: dataSettingsSchema('{k}') }}),\n" for k in kinds))
edit('src/catalogs/types.ts',"        'queue', 'pubsub',",f"        'queue', 'pubsub', {kindstr},")
prepend('src/simulation/routing.ts',"import { DATA_KINDS, isDataKind } from '../domain/data-services';\n")
edit('src/simulation/routing.ts','export interface ServerBranch {','export interface ServerBranch {\n  dataServices: { nodeId: string; edgeId: string }[];')
edit('src/simulation/routing.ts','const SERVER_TARGETS: Partial<Record<ComponentKind, number>> = {','const SERVER_TARGETS: Partial<Record<ComponentKind, number>> = {\n'+''.join(f'  {k}: 1,\n' for k in kinds))
edit('src/simulation/routing.ts','    serverObjectStorageEdgeId: storageEdges[0]?.id ?? null,','    serverObjectStorageEdgeId: storageEdges[0]?.id ?? null,\n    dataServices: out.filter((e) => isDataKind(kindOf(graph, e.target) ?? "")).map((e) => ({ nodeId: e.target, edgeId: e.id })),')
edit('src/simulation/routing.ts',"const LEAF_KINDS: ComponentKind[] = [", "const LEAF_KINDS: ComponentKind[] = [...DATA_KINDS, ")
prepend('src/simulation/types.ts',"import type { DataKind } from '../domain/data-services';\n")
edit('src/simulation/types.ts',"  | 'function-throttled';","  | 'function-throttled'\n  | 'data-service-full';")
edit('src/simulation/types.ts','export const REJECTION_LABELS: Record<RejectionReason, string> = {',"export const REJECTION_LABELS: Record<RejectionReason, string> = {\n  'data-service-full': 'Data service waiting queue was full',")
edit('src/simulation/types.ts','export interface StationMetrics {','''export interface DataServiceMetrics {
  nodeId: string; name: string; kind: DataKind;
  reads: number; writes: number; completed: number; rejected: number;
  inFlight: number; waiting: number; utilisation: number; queuePeak: number;
  serviceMsTotal: number; waitMsTotal: number;
  details: Record<string, number>;
}

export interface StationMetrics {''')
edit('src/simulation/types.ts','  stations: StationMetrics[];','  stations: StationMetrics[];\n  dataServices?: DataServiceMetrics[];')
prepend('src/simulation/engine.ts',"import { isDataKind } from '../domain/data-services';\nimport type { DataServiceNode } from '../domain/data-services';\nimport { DataServiceModel } from './models/data-service';\nimport type { DataOperation } from './models/data-service';\n")
edit('src/simulation/engine.ts','type EventPayload =',"type EventPayload =\n  | { t: 'dataEnd'; nodeId: string; request: number }")
edit('src/simulation/engine.ts','interface CompiledBranch {', 'interface CompiledBranch {\n  dataServices: { nodeId: string; outChannel: string; inChannel: string }[];')
edit('src/simulation/engine.ts','interface RequestState {', 'interface RequestState {\n  dataIndex: number;\n  dataOperation: DataOperation | null;')
edit('src/simulation/engine.ts','  private readonly stations = new Map<string, StationModel>();','  private readonly stations = new Map<string, StationModel>();\n  private readonly dataServices = new Map<string, DataServiceModel>();')
edit('src/simulation/engine.ts','    for (const node of doc.nodes) {','    for (const node of doc.nodes) {\n      if (isDataKind(node.kind)) this.dataServices.set(node.id, new DataServiceModel(node as DataServiceNode, this.streams));')
edit('src/simulation/engine.ts','      serverId: branch.serverId,','      serverId: branch.serverId,\n      dataServices: branch.dataServices.map((s) => ({ nodeId: s.nodeId, outChannel: channelKey(s.edgeId, FORWARD), inChannel: channelKey(s.edgeId, REVERSE) })),')
edit('src/simulation/engine.ts',"      case 'arrival':", "      case 'dataEnd':\n        this.onDataEnd(event.nodeId, event.request);\n        break;\n      case 'arrival':")
# Two creation sites: a user request and a background worker job.
edit('src/simulation/engine.ts','      topicPublished: false,','      topicPublished: false,\n      dataIndex: 0, dataOperation: null,',2)
edit('src/simulation/engine.ts',"      case 'kvOp':",'''      case 'dataOp': {
        const call = branch?.dataServices[request.dataIndex];
        const model = call ? this.dataServices.get(call.nodeId) : undefined;
        if (model && request.dataOperation) {
          const accepted = model.admit(request.id, request.dataOperation, this.now,
            (id, ms) => this.scheduleData(model.node.id, id, ms));
          if (!accepted) this.rejectRequest(request, 'data-service-full');
        }
        return;
      }
      case 'dataResult':
        request.dataIndex++;
        request.dataOperation = null;
        this.trace(request, 'Data service response received');
        this.beginCpuSegment(request);
        return;
      case 'kvOp':''')
edit('src/simulation/engine.ts','    const cacheAnswered = branch.cacheId !== null && request.cacheHit;', '''    const call = branch.dataServices[request.dataIndex];
    if (call) {
      const model = this.dataServices.get(call.nodeId)!;
      request.dataOperation = model.prepare(this.now);
      this.trace(request, `Calling ${model.node.name}`, request.dataOperation.write ? 'write' : 'read');
      this.send(call.outChannel, request, 'dataOp', request.dataOperation.requestBytes);
      return;
    }
    const cacheAnswered = branch.cacheId !== null && request.cacheHit;''')
edit('src/simulation/engine.ts','  private respond(request: RequestState): void {', '''  private scheduleData(nodeId: string, id: number, ms: number): void {
    this.queue.push(this.now + ms, { t: 'dataEnd', nodeId, request: id });
  }

  private onDataEnd(nodeId: string, id: number): void {
    const model = this.dataServices.get(nodeId);
    const operation = model?.finish(id, this.now, (nextId, ms) => this.scheduleData(nodeId, nextId, ms));
    const request = this.requests.get(id);
    if (!request || !operation) return;
    const call = this.branchOf(request)?.dataServices[request.dataIndex];
    if (call) this.send(call.inChannel, request, 'dataResult', operation.responseBytes);
  }

  private respond(request: RequestState): void {''')
edit('src/simulation/engine.ts','  let calls = 0;','  let calls = branch.dataServices.length;')
edit('src/simulation/engine.ts','    const waitByStageMs: Record<WaitStage, number> = {','    const dataServices = [...this.dataServices.values()].map((s) => s.snapshot(measuredMs));\n    const waitByStageMs: Record<WaitStage, number> = {')
edit('src/simulation/engine.ts',"database: sum(stations.filter((s) => s.kind === 'database').map((s) => s.waitMsTotal)),", "database: sum(stations.filter((s) => s.kind === 'database').map((s) => s.waitMsTotal)) + sum(dataServices.map((s) => s.waitMsTotal)),")
edit('src/simulation/engine.ts','      stations,','      stations,\n      dataServices,')
edit('src/simulation/engine.ts','        requestsByNodeId: Object.fromEntries([','        requestsByNodeId: Object.fromEntries([\n          ...dataServices.map((s) => [s.nodeId, s.reads + s.writes] as const),')
edit('src/simulation/engine.ts','        writesByNodeId: Object.fromEntries(\n          [...this.stations.values()]', '        writesByNodeId: Object.fromEntries([\n          ...dataServices.map((s) => [s.nodeId, s.writes] as const),\n          ...[...this.stations.values()]')
edit('src/simulation/engine.ts','            .map((st) => [st.nodeId, st.writes] as const),\n        ),','            .map((st) => [st.nodeId, st.writes] as const),\n        ]),')
edit('src/simulation/models/link.ts',"  | 'topicAck';","  | 'topicAck'\n  | 'dataOp'\n  | 'dataResult';")
edit('src/simulation/models/data-service.ts','this.queueAcc.max','this.queueAcc.peak')
for file in ['src/features/editor/Palette.tsx','src/features/editor/Canvas.tsx','src/features/editor/Inspector.tsx']:
    edit(file,'const KIND_COLOR: Record<ComponentKind, string> = {','const KIND_COLOR: Record<ComponentKind, string> = {\n'+''.join(f"  {k}: 'text-kind-database',\n" for k in kinds))
edit('src/features/editor/Palette.tsx',"'kvStore', 'objectStorage']",f"'kvStore', 'objectStorage', {kindstr}]")
edit('src/ui/icons.tsx','export const KIND_ICONS', 'export const KIND_ICONS') # locate declaration below
icons=(root/'src/ui/icons.tsx').read_text(encoding='utf-8')
idx=icons.index('export const KIND_ICONS')
brace=icons.index('= {',idx)+3
icons=icons[:brace]+'\n'+''.join(f'  {k}: DatabaseIcon,\n' for k in kinds)+icons[brace:]
(root/'src/ui/icons.tsx').write_text(icons,encoding='utf-8')
prepend('src/features/editor/Canvas.tsx',"import { isDataKind, DATA_SERVICES } from '../../domain/data-services';\n")
edit('src/features/editor/Canvas.tsx','function summarise(node: ArchNode): string {','function summarise(node: ArchNode): string {\n  if (isDataKind(node.kind)) return DATA_SERVICES[node.kind].label;')
prepend('src/features/editor/Inspector.tsx',"import { DATA_SERVICES, isDataKind } from '../../domain/data-services';\nimport type { DataServiceNode, NumericSetting } from '../../domain/data-services';\n")
edit('src/features/editor/Inspector.tsx',"      {node.kind === 'pubsub' && <PubSubSettingsForm node={node} />}","      {node.kind === 'pubsub' && <PubSubSettingsForm node={node} />}\n      {isDataKind(node.kind) && <DataSettingsForm node={node as DataServiceNode} />}")
with (root/'src/features/editor/Inspector.tsx').open('a',encoding='utf-8') as f:
    f.write('''
function DataSettingsForm({ node }: { node: DataServiceNode }) {
  const update = useEditor((s) => s.updateNode);
  const definition = DATA_SERVICES[node.kind];
  return <>
    <Intro>{definition.description}</Intro>
    <p className="text-xs text-ink-3">Examples: {definition.examples}. Editable model; no vendor speed assumptions.</p>
    {Object.entries(definition.fields).map(([key, spec]) => {
      const field: NumericSetting = spec;
      return <Field key={key} label={field.label} unit={field.unit} hint={field.help}>
        {(id) => <NumberInput id={id} value={(node.settings as Record<string, number>)[key]!}
          min={field.min} max={field.max} step={field.integer ? 1 : 'any'}
          onCommit={(value) => update(node.id, (draft) => {
            if (isDataKind(draft.kind)) Object.assign(draft.settings, { [key]: field.integer ? Math.round(value) : value });
          })} />}
      </Field>;
    })}
  </>;
}
''')
prepend('src/pricing/pricing.ts',"import { isDataKind } from '../domain/data-services';\nimport type { DataServiceNode } from '../domain/data-services';\n")
edit('src/pricing/pricing.ts',"      if (node.kind === 'database') {", "      if (isDataKind(node.kind)) {\n        gb = new Decimal((node as DataServiceNode).settings.storedGb);\n        basis = `${gb} GB provisioned for the whole month.`;\n      } else if (node.kind === 'database') {")
edit('src/storage/run-schema.ts',"    'function-throttled']), number)","    'function-throttled', 'data-service-full']), number)")
edit('src/storage/run-schema.ts',"'cache', 'queue', 'pubsub']),",f"'cache', 'queue', 'pubsub', {kindstr}]),")
edit('src/storage/run-schema.ts','  stations: z.array(',f'''  dataServices: z.array(z.object({{ nodeId: text, name: text, kind: z.enum([{kindstr}]),
    ...numbers(['reads', 'writes', 'completed', 'rejected', 'inFlight', 'waiting', 'utilisation', 'queuePeak', 'serviceMsTotal', 'waitMsTotal']),
    details: z.record(number) }})).max(400).default([]),
  stations: z.array(''')
