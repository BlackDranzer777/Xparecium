import type { ArchNode } from '../../domain/types';
import type { ServiceField } from '../../domain/job-services';
import { Field, NumberInput } from '../../ui/primitives';
import { useEditor } from './store';

export function ServiceSettingsForm({ node, description, fields }: {
  node: ArchNode;
  description: string;
  fields: Record<string, ServiceField>;
}) {
  const mutate = useEditor((s) => s.mutate);
  const values = node.settings as unknown as Record<string, unknown>;
  const set = (key: string, value: string | number | boolean) => mutate((draft) => {
    const target = draft.nodes.find((n) => n.id === node.id);
    if (target?.kind === node.kind) Object.assign(target.settings, { [key]: value });
  });
  return <>
    <p className="mb-4 text-xs leading-relaxed text-ink-3">{description}</p>
    {Object.entries(fields).map(([key, field]) => <Field key={key} label={field.label}
      unit={'unit' in field ? field.unit : undefined} hint={field.help}>
      {(id) => 'toggle' in field ? <input id={id} type="checkbox" checked={values[key] === true} onChange={(e) => set(key, e.target.checked)} />
        : 'options' in field ? <select id={id} className="ap-select" value={String(values[key])} onChange={(e) => set(key, e.target.value)}>
          {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        : <NumberInput id={id} value={Number(values[key])} min={field.min} max={field.max} step={field.integer ? 1 : 0.001}
          onCommit={(value) => set(key, field.integer ? Math.round(value) : value)} />}
    </Field>)}
  </>;
}
