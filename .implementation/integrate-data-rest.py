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
edit('src/features/editor/Inspector.tsx', 'const KIND_COLOR = {', 'const KIND_COLOR = {\n'+''.join(f"  {k}: 'text-kind-database',\n" for k in kinds))
edit('src/features/editor/Palette.tsx',"'kvStore', 'objectStorage']",f"'kvStore', 'objectStorage', {kindstr}]")
edit('src/ui/icons.tsx','export const KIND_ICONS', 'export const KIND_ICONS') # locate declaration below
icons=(root/'src/ui/icons.tsx').read_text(encoding='utf-8')
idx=icons.index('export const KIND_ICONS')
brace=icons.index('= {',idx)+3
icons=icons[:brace]+'\n'+''.join(f'  {k}: DatabaseIcon,\n' for k in kinds)+icons[brace:]
(root/'src/ui/icons.tsx').write_text(icons,encoding='utf-8')
prepend('src/features/editor/Canvas.tsx',"import { isDataKind, DATA_SERVICES } from '../../domain/data-services';\n")
edit('src/features/editor/Canvas.tsx', '  if (!node) return \'\';', '  if (!node) return \'\';\n  if (isDataKind(node.kind)) return DATA_SERVICES[node.kind].label;')
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
