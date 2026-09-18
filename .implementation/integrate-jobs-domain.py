from pathlib import Path
import json
root=Path(__file__).parent/'all-components'
def r(file,a,b,count=1):
 p=root/file;s=p.read_text(encoding='utf-8');assert s.count(a)==count,(file,a[:70],s.count(a));p.write_text(s.replace(a,b),encoding='utf-8')
def pre(file,s):
 p=root/file;p.write_text(s+p.read_text(encoding='utf-8'),encoding='utf-8')
pre('src/domain/types.ts',"import type { JobKind, JobServiceNode } from './job-services';\n")
r('src/domain/types.ts','  | DataKind;','  | DataKind\n  | JobKind;')
r('src/domain/types.ts','export type ArchNode =','export type ArchNode =\n  | JobServiceNode')
r('src/domain/types.ts','export interface QueueSettings {','export interface QueueSettings {\n  processingFailureShare: number;\n  maxAttempts: number;\n  retryDelayMs: number;')
pre('src/domain/defaults.ts',"import { JOB_SERVICES, DEFAULT_EVENT_STREAM, DEFAULT_DEAD_LETTER, DEFAULT_SCHEDULER } from './job-services';\n")
r('src/domain/defaults.ts','export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {','export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {\n  processingFailureShare: 0, maxAttempts: 3, retryDelayMs: 100,')
items=[('eventStream','DEFAULT_EVENT_STREAM'),('deadLetter','DEFAULT_DEAD_LETTER'),('scheduler','DEFAULT_SCHEDULER')]
for k,default in items:
 r('src/domain/defaults.ts','export const COMPONENT_LABELS: Record<ComponentKind, string> = {',f'export const COMPONENT_LABELS: Record<ComponentKind, string> = {{\n  {k}: JOB_SERVICES.{k}.label,')
 r('src/domain/defaults.ts','export const COMPONENT_DESCRIPTIONS: Record<ComponentKind, string> = {',f'export const COMPONENT_DESCRIPTIONS: Record<ComponentKind, string> = {{\n  {k}: JOB_SERVICES.{k}.description,')
 r('src/domain/defaults.ts','export const DEFAULT_CLOUD_PROFILE_BY_KIND: Record<ComponentKind, string | null> = {',f"export const DEFAULT_CLOUD_PROFILE_BY_KIND: Record<ComponentKind, string | null> = {{\n  {k}: 'generic.{k}',")
 r('src/domain/defaults.ts','  switch (kind) {',f"  switch (kind) {{\n    case '{k}': return {{ ...base, kind, settings: {{ ...{default} }} }};")
pre('src/domain/schema.ts',"import { JOB_SERVICES } from './job-services';\nimport type { JobKind, EventStreamSettings, DeadLetterSettings, SchedulerSettings } from './job-services';\n")
r('src/domain/schema.ts','export const queueSettingsSchema = z.object({','export const queueSettingsSchema = z.object({\n  processingFailureShare: finite(0, 1).default(0),\n  maxAttempts: z.number().int().min(1).max(100).default(3),\n  retryDelayMs: finite(0, 86400000).default(100),')
r('src/domain/schema.ts','export const archNodeSchema =', '''function jobSettingsSchema<K extends JobKind>(kind: K): z.ZodType<{
  eventStream: EventStreamSettings; deadLetter: DeadLetterSettings; scheduler: SchedulerSettings;
}[K]> {
  const shape = Object.fromEntries(Object.entries(JOB_SERVICES[kind].fields).map(([key, field]) => {
    if ('toggle' in field) return [key, z.boolean()];
    if ('options' in field) return [key, z.enum(field.options.map((o) => o.value) as [string, ...string[]])];
    let schema = z.number().finite().min(field.min).max(field.max);
    if (field.integer) schema = schema.int();
    return [key, schema];
  }));
  return z.object(shape) as unknown as z.ZodType<{ eventStream: EventStreamSettings; deadLetter: DeadLetterSettings; scheduler: SchedulerSettings }[K]>;
}

export const archNodeSchema =''')
r('src/domain/schema.ts',"z.discriminatedUnion('kind', [", "z.discriminatedUnion('kind', [\n"+''.join(f"  z.object({{ ...nodeBase, kind: z.literal('{k}'), settings: jobSettingsSchema('{k}') }}),\n" for k,_ in items))
for f in ['src/catalogs/types.ts','src/storage/run-schema.ts']:
 r(f,"'documentDb', 'wideColumn', 'searchIndex', 'warehouse', 'timeSeries'", "'documentDb', 'wideColumn', 'searchIndex', 'warehouse', 'timeSeries', 'eventStream', 'deadLetter', 'scheduler'", 2 if f.endswith('run-schema.ts') else 1)
# Above also widened the data-service result enum; keep it restricted to actual data models.
r('src/storage/run-schema.ts',"dataServices: z.array(z.object({ nodeId: text, name: text, kind: z.enum(['documentDb', 'wideColumn', 'searchIndex', 'warehouse', 'timeSeries', 'eventStream', 'deadLetter', 'scheduler'])", "dataServices: z.array(z.object({ nodeId: text, name: text, kind: z.enum(['documentDb', 'wideColumn', 'searchIndex', 'warehouse', 'timeSeries'])")
for f in ['src/features/editor/Palette.tsx','src/features/editor/Canvas.tsx','src/features/editor/Inspector.tsx']:
 anchor='const KIND_COLOR = {' if f.endswith('Inspector.tsx') else 'const KIND_COLOR: Record<ComponentKind, string> = {'
 r(f,anchor,anchor+''.join(f"\n  {k}: 'text-kind-queue'," for k,_ in items))
r('src/features/editor/Palette.tsx',"{ title: 'Messaging', kinds: ['queue', 'pubsub'] }", "{ title: 'Messaging', kinds: ['queue', 'pubsub', 'eventStream', 'deadLetter', 'scheduler'] }")
r('src/ui/icons.tsx','  queue: QueueIcon,','  queue: QueueIcon,\n  eventStream: PubSubIcon,\n  deadLetter: QueueIcon,\n  scheduler: ServerlessIcon,')
pre('src/features/editor/Canvas.tsx',"import { isJobKind, JOB_SERVICES } from '../../domain/job-services';\n")
r('src/features/editor/Canvas.tsx',"  if (!node) return '';", "  if (!node) return '';\n  if (isJobKind(node.kind)) return JOB_SERVICES[node.kind].label;")
pre('src/features/editor/Inspector.tsx',"import { isJobKind, JOB_SERVICES } from '../../domain/job-services';\nimport { ServiceSettingsForm } from './ServiceSettingsForm';\n")
r('src/features/editor/Inspector.tsx',"      {node.kind === 'pubsub' && <PubSubSettingsForm node={node} />}", "      {node.kind === 'pubsub' && <PubSubSettingsForm node={node} />}\n      {isJobKind(node.kind) && <ServiceSettingsForm node={node} {...JOB_SERVICES[node.kind]} />}\n      {node.kind === 'queue' && <ServiceSettingsForm node={node} description=\"Retries: failed attempts can try again. Exhausted jobs go to a connected Dead-letter queue; otherwise they are counted as failed.\" fields={{\n        processingFailureShare: { label: 'Worker failure share (0–1)', value: 0, min: 0, max: 1, help: 'Sampled before downstream work. Dependency failures also trigger retries.' },\n        maxAttempts: { label: 'Maximum attempts per job', value: 3, min: 1, max: 100, integer: true },\n        retryDelayMs: { label: 'Wait between attempts', value: 100, min: 0, max: 86400000, unit: 'ms' },\n      }} />}")
