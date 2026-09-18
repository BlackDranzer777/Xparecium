from pathlib import Path
p=Path('src/domain/types.ts');s=p.read_text(encoding='utf-8');s="import type { SupportKind, SupportNode } from './support-services';\n"+s;s=s.replace('  | JobKind;','  | JobKind | SupportKind;').replace('  | JobServiceNode','  | SupportNode\n  | JobServiceNode');s=s.replace("['cdn', 'waf', 'apiGateway'] as const", "['cdn', 'waf', 'apiGateway', 'websocket', 'rateLimiter', 'serviceMesh'] as const");p.write_text(s,encoding='utf-8')
p=Path('src/domain/defaults.ts');s=p.read_text(encoding='utf-8');s="import { SUPPORT_KINDS, SUPPORT_SERVICES, isSupportKind, supportDefaults } from './support-services';\nimport type { SupportNode } from './support-services';\n"+s
# Record mappings use generated entries with precise mapped types.
for name,expr in [('COMPONENT_LABELS','SUPPORT_SERVICES[k].label'),('COMPONENT_DESCRIPTIONS','SUPPORT_SERVICES[k].description'),('DEFAULT_CLOUD_PROFILE_BY_KIND',"`generic.${k}`")]:
 start=s.index('export const '+name);pos=s.index('{',s.index('=',start));s=s[:pos+1]+f'\n  ...Object.fromEntries(SUPPORT_KINDS.map(k => [k, {expr}])) as Record<SupportNode[\'kind\'], string>,'+s[pos+1:]
# makeNode has switch with prebuilt base
idx=s.index('export function makeNode');pos=s.index('  switch (kind)',idx);s=s[:pos]+"  if (isSupportKind(kind)) return { ...base, kind, settings: supportDefaults(kind) } as SupportNode;\n"+s[pos:]
p.write_text(s,encoding='utf-8')
p=Path('src/domain/schema.ts');s=p.read_text(encoding='utf-8');s="import { SUPPORT_SERVICES } from './support-services';\nimport type { SupportKind, SupportSettings } from './support-services';\n"+s
idx=s.index('export const architectureDocumentSchema');# insert function before arch node schema instead
pos=s.index('const dataSettingsSchema') if 'const dataSettingsSchema' in s else s.index('function dataSettingsSchema')
s=s[:pos]+'''function supportSettingsSchema<K extends SupportKind>(kind: K): z.ZodType<SupportSettings<K>> {
  const fields = SUPPORT_SERVICES[kind].fields as Record<string, NumericSetting>;
  return z.object(Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.integer ? finite(f.min, f.max).int() : finite(f.min, f.max)]))) as unknown as z.ZodType<SupportSettings<K>>;
}

'''+s[pos:]
# append branches adjacent existing generated data branches
pos=s.index("z.object({ ...nodeBase, kind: z.literal('documentDb')")
branches='\n  '.join("z.object({ ...nodeBase, kind: z.literal('%s'), settings: supportSettingsSchema('%s') }),"%(k,k) for k in ['websocket','notification','identity','rateLimiter','discovery','secrets','monitoring','serviceMesh'])
s=s[:pos]+branches+'\n  '+s[pos:];p.write_text(s,encoding='utf-8')
# Enum arrays used catalogs and storage cost
for file in ['src/catalogs/types.ts','src/storage/run-schema.ts']:
 p=Path(file);s=p.read_text(encoding='utf-8').replace("'eventStream', 'deadLetter', 'scheduler'", "'eventStream', 'deadLetter', 'scheduler', 'websocket', 'notification', 'identity', 'rateLimiter', 'discovery', 'secrets', 'monitoring', 'serviceMesh'")
 # job metric kind must remain its own domain
 s=s.replace("kind: z.enum(['eventStream', 'deadLetter', 'scheduler', 'websocket', 'notification', 'identity', 'rateLimiter', 'discovery', 'secrets', 'monitoring', 'serviceMesh'])", "kind: z.enum(['eventStream', 'deadLetter', 'scheduler'])")
 p.write_text(s,encoding='utf-8')
for file in ['src/features/editor/Palette.tsx','src/features/editor/Inspector.tsx','src/features/editor/Canvas.tsx']:
 p=Path(file);s=p.read_text(encoding='utf-8');s="import { SUPPORT_KINDS, SUPPORT_SERVICES, isSupportKind } from '../../domain/support-services';\n"+s
 pos=s.index('{',s.index('=',s.index('const KIND_COLOR')));s=s[:pos+1]+"\n  ...Object.fromEntries(SUPPORT_KINDS.map(k => [k, 'text-kind-edge'])) as Record<(typeof SUPPORT_KINDS)[number], string>,"+s[pos+1:]
 if file.endswith('Palette.tsx'):
  s=s.replace("{ title: 'Data'", "{ title: 'Shared services', kinds: SUPPORT_KINDS },\n  { title: 'Data'");s=s.replace('SUPPORT_KINDS, SUPPORT_SERVICES, isSupportKind','SUPPORT_KINDS')
 if file.endswith('Inspector.tsx'):
  s=s.replace("{isJobKind(node.kind)", "{isSupportKind(node.kind) && <ServiceSettingsForm node={node} description={SUPPORT_SERVICES[node.kind].description} fields={SUPPORT_SERVICES[node.kind].fields} />}\n      {isJobKind(node.kind)")
 if file.endswith('Canvas.tsx'):
  s=s.replace("if (isJobKind(node.kind))", "if (isSupportKind(node.kind)) return SUPPORT_SERVICES[node.kind].label;\n  if (isJobKind(node.kind))")
 p.write_text(s,encoding='utf-8')
p=Path('src/ui/icons.tsx');s=p.read_text(encoding='utf-8');pos=s.index('{',s.index('=',s.index('export const KIND_ICONS')));s=s[:pos+1]+"\n  websocket: ServerIcon, notification: QueueIcon, identity: WafIcon, rateLimiter: ApiGatewayIcon, discovery: DnsIcon, secrets: WafIcon, monitoring: DatabaseIcon, serviceMesh: LoadBalancerIcon,"+s[pos+1:];p.write_text(s,encoding='utf-8')
