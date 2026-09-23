import { SUPPORT_SERVICES, isSupportKind } from '../../domain/support-services';
import { isJobKind, JOB_SERVICES } from '../../domain/job-services';
import { CHAIN_SERVICES, isChainKind } from '../../domain/chain-services';
import { ServiceSettingsForm } from './ServiceSettingsForm';
import { DATA_SERVICES, isDataKind } from '../../domain/data-services';
import type { DataServiceNode, NumericSetting } from '../../domain/data-services';
/**
 * The settings panel for whatever is selected.
 *
 * Basic settings are always visible; everything else is behind "Advanced", so
 * the starter example can be run without meeting a single unfamiliar field.
 * Every numeric control names its unit, and the short explanations say what a
 * setting actually does *in the model* rather than in general.
 */
import { useMemo } from 'react';
import {
  COMPONENT_DESCRIPTIONS,
  COMPONENT_LABELS,
  SERVER_HARDWARE_PROFILES,
} from '../../domain/defaults';
import type {
  ApiGatewaySettings,
  ArchEdge,
  ArchNode,
  CacheSettings,
  CdnSettings,
  ClientSettings,
  DatabaseSettings,
  DnsSettings,
  KvStoreSettings,
  LoadBalancerSettings,
  LoadBalancingPolicy,
  ObjectStorageSettings,
  PubSubSettings,
  QueueSettings,
  ReadReplicaSettings,
  ServerProfileId,
  ServerSettings,
  ServerlessSettings,
  WafSettings,
} from '../../domain/types';
import { formatMs, formatNumber, formatRate, transmissionMs } from '../../domain/units';
import { CHARGE_LABELS, profilesFor, serverProfileForHardware } from '../../catalogs/types';
import type { ChargeType, CloudProfile } from '../../catalogs/types';
import { clientRequestRate } from '../../simulation/engine';
import { KIND_ICONS, TrashIcon } from '../../ui/icons';
import {
  Badge,
  Callout,
  Collapsible,
  EmptyState,
  Field,
  NumberInput,
  Section,
  SegmentedControl,
  Toggle,
} from '../../ui/primitives';
import { useEditor } from './store';
import { kindIconClass } from '../../ui/kind-style';

function Intro({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 text-[12px] leading-relaxed text-ink-3">{children}</p>;
}

/* ------------------------------------------------------------ cloud profile */

function RateEditor({ profile, charge }: { profile: CloudProfile; charge: ChargeType }) {
  const overrides = useEditor((s) => s.project?.document.pricingOverrides ?? {});
  const setRateOverride = useEditor((s) => s.setRateOverride);
  const base = profile.charges[charge];
  if (!base) return null;

  const override = overrides[profile.id]?.[charge];
  const current = override !== undefined ? override : base.amount;
  const edited = override !== undefined;

  return (
    <div className="flex items-center gap-2 py-1">
      <span className="w-[104px] shrink-0 text-[11px] text-ink-3">{CHARGE_LABELS[charge]}</span>
      <input
        className="ap-input h-7 flex-1 py-0 font-mono text-[11.5px]"
        value={current ?? ''}
        placeholder="unpriced"
        aria-label={`${CHARGE_LABELS[charge]} rate per ${base.unit}`}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === '') setRateOverride(profile.id, charge, null);
          else if (/^\d+(\.\d*)?$/.test(raw)) setRateOverride(profile.id, charge, raw);
        }}
      />
      <span className="w-[74px] shrink-0 text-[10px] leading-tight text-ink-3">
        per {base.unit}
      </span>
      {edited && (
        <button
          type="button"
          className="text-[10px] text-accent hover:underline"
          onClick={() => setRateOverride(profile.id, charge, undefined)}
        >
          reset
        </button>
      )}
    </div>
  );
}

function CloudSection({ node }: { node: ArchNode }) {
  const catalog = useEditor((s) => s.cloudCatalog);
  const hardware = useEditor((s) => s.hardwareCatalog);
  const mutate = useEditor((s) => s.mutate);
  const options = useMemo(
    () => (catalog ? profilesFor(catalog, node.kind) : []),
    [catalog, node.kind],
  );
  const selected = options.find((p) => p.id === node.cloud.profileId) ?? null;
  const rateEdits = useEditor((s) => s.project?.document.pricingOverrides[node.cloud.profileId ?? '']);
  const edited = Object.values(rateEdits ?? {}).some((value) => value !== undefined);

  const setProfile = (profileId: string | null) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target) target.cloud = {
        profileId,
        pricingMode: 'manual',
        ...(profileId ? { previousProfileId: profileId } : {}),
      };
    });

  // Changing the Resource profile now moves the cloud profile with it, so the
  // two cannot drift apart by themselves. They can still be put out of step by
  // hand — by picking a machine of a different size from this list, or by
  // editing the hardware fields into Custom — and when that happens the panel
  // says so rather than quietly reporting a price for the wrong machine.
  const size =
    node.kind === 'server' && node.settings.profile !== 'custom' ? node.settings.profile : null;
  const mismatched =
    size !== null && selected?.sizeClass !== undefined && selected.sizeClass !== size
      ? selected
      : null;
  const sizeLabel = (id: string) =>
    (hardware?.profiles ?? SERVER_HARDWARE_PROFILES).find((p) => p.id === id)?.label ?? id;

  // A machine with no cloud profile at all, where one of the right size exists.
  const unassignedFor =
    size !== null && node.cloud.profileId === null
      ? (options.find((p) => p.sizeClass === size) ?? null)
      : null;

  // Custom hardware: which catalogued machine it is being priced as, if any.
  // Recomputed here purely to explain what the store already decided.
  const custom = node.kind === 'server' && node.settings.profile === 'custom' ? node.settings : null;
  const customFit =
    custom && catalog && node.cloud.pricingMode !== 'manual'
      ? serverProfileForHardware(
          catalog,
          hardware?.profiles ?? SERVER_HARDWARE_PROFILES,
          node.cloud.profileId ?? node.cloud.previousProfileId ?? null,
          custom.cpuSlots,
          custom.ramMb,
        )
      : null;

  if (!catalog) {
    return (
      <Callout tone="warn">
        The pricing catalog could not be loaded, so no cloud profiles are available.
      </Callout>
    );
  }

  return (
    <>
      <Field
        label="Cloud profile"
        hint="Sets the rates used for the cost estimate. It does not change performance."
      >
        {(id) => (
          <select
            id={id}
            className="ap-select"
            value={node.cloud.profileId ?? ''}
            onChange={(e) => setProfile(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">Not assigned (no rates)</option>
            {options.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.providerName} — {profile.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      {mismatched && (
        <div className="mb-4">
          <Callout tone="warn" title="Hardware and price do not match">
            This component is set to <span className="font-medium text-ink">{sizeLabel(size!)}</span>{' '}
            hardware, but the rates above are for a{' '}
            <span className="font-medium text-ink">{sizeLabel(mismatched.sizeClass!)}</span> machine.
            These rates were selected manually. Use matching rates to price the simulated size.
            <button type="button" className="ap-btn mt-2" onClick={() => mutate((draft) => {
              const target = draft.nodes.find((n) => n.id === node.id);
              if (target) target.cloud.pricingMode = 'automatic';
            })}>Use matching rates</button>
          </Callout>
        </div>
      )}

      {custom && node.cloud.pricingMode === 'manual' && selected && (
        <div className="mb-4">
          <Callout title="Custom hardware, rates chosen by hand">
            These rates stay until you change them. Nothing here checks that they describe a
            machine with {formatNumber(custom.cpuSlots)} CPU slots and{' '}
            {formatNumber(custom.ramMb)} MB.
          </Callout>
        </div>
      )}

      {customFit?.outcome === 'matched' && customFit.fitted && customFit.floor && (
        <div className="mb-4">
          <Callout tone="warn" title="Bigger than anything in the catalog — this price is a floor">
            {formatNumber(custom!.cpuSlots)} CPU slots and {formatNumber(custom!.ramMb)} MB is more
            than the largest machine catalogued here, a{' '}
            <span className="font-medium text-ink">{sizeLabel(customFit.fitted.id)}</span> (
            {customFit.fitted.cpuSlots} slots, {formatNumber(customFit.fitted.ramMb)} MB). It is
            priced as that machine, so the estimate is{' '}
            <span className="font-medium text-ink">at least</span> this much — the real charge
            for hardware this size is higher. Unpriced would have made a bigger machine look
            cheaper, which is the one thing an estimate must not do.
          </Callout>
        </div>
      )}

      {customFit?.outcome === 'matched' && customFit.fitted && !customFit.floor && (
        <div className="mb-4">
          <Callout title="Priced as the smallest machine that fits">
            {formatNumber(custom!.cpuSlots)} CPU slots and {formatNumber(custom!.ramMb)} MB fit
            inside a <span className="font-medium text-ink">{sizeLabel(customFit.fitted.id)}</span>{' '}
            ({customFit.fitted.cpuSlots} slots, {formatNumber(customFit.fitted.ramMb)} MB), so
            the rates above are for{' '}
            <span className="font-medium text-ink">{customFit.profile.label}</span>. Change the
            numbers and the machine follows.
          </Callout>
        </div>
      )}

      {customFit?.outcome === 'none' && (
        <div className="mb-4">
          <Callout tone="warn" title="This component is unpriced">
            The provider and region it was using have no server machines in the catalog at all,
            so there is nothing to price it as. Unpriced is not free. Pick rates by hand above.
          </Callout>
        </div>
      )}

      {unassignedFor && (
        <div className="mb-4">
          <Callout tone="warn" title="This component is unpriced">
            No rates are assigned, so its cost is reported as unpriced and left out of the total.
            Unpriced is not free. This also happens by itself when a Resource profile has no
            machine of that size in the provider and region the component was using — the rates
            are cleared rather than left describing a machine nobody selected.
          </Callout>
        </div>
      )}

      {selected && (
        <div className="rounded-lg border border-line p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11.5px] text-ink-2">{selected.regionName}</span>
            <Badge tone={selected.verified ? 'good' : 'warn'}>
              {edited ? 'Edited' : selected.verified ? 'Verified' : Object.values(selected.charges).some((c) => c.amount !== null) ? 'Illustrative' : 'Unpriced'}
            </Badge>
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-ink-3">{selected.priceNote}</p>
          <div className="mb-3 border-t border-line pt-2">
            {(Object.keys(CHARGE_LABELS) as ChargeType[]).map((charge) => <RateEditor key={charge} profile={selected} charge={charge} />)}
          </div>
          <p className="text-[10px] leading-relaxed text-ink-3">
            Rates in {catalog.currency}. {selected.priceCheckedAt ? `Checked ${selected.priceCheckedAt}.` : 'No rate retrieval date.'}{' '}
            {selected.priceSourceUrl ? (
              <a
                className="text-accent hover:underline"
                href={selected.priceSourceUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Source
              </a>
            ) : (
              'No source URL.'
            )}
          </p>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ clients */

function ClientSettingsForm({ node }: { node: ArchNode & { kind: 'client' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<ClientSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'client') Object.assign(target.settings, changes);
    });

  const s = node.settings;
  const derived = (s.activeUsers * s.actionsPerUserPerMinute) / 60;
  const effective = clientRequestRate(node);
  const closed = s.mode === 'closed';
  const overridden = !closed && s.requestRateOverridePerSecond !== null;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.client}</Intro>

      <div className="mb-4">
        <SegmentedControl
          label="How users decide when to send the next request"
          value={s.mode}
          onChange={(mode) => patch({ mode })}
          options={[
            {
              value: 'open',
              label: 'Steady rate',
              title: 'Requests arrive at a rate, whether or not earlier ones came back',
            },
            {
              value: 'closed',
              label: 'Wait and think',
              title: 'Each user waits for its own response, thinks, then sends the next',
            },
          ]}
        />
      </div>

      <Field label="Active users" unit="people">
        {(id) => (
          <NumberInput
            id={id}
            value={s.activeUsers}
            min={0}
            step={10}
            onCommit={(v) => patch({ activeUsers: v })}
          />
        )}
      </Field>
      {closed ? (
        <Field
          label="Think time"
          unit="ms"
          hint="Average pause between receiving one response and sending the next."
        >
          {(id) => (
            <NumberInput
              id={id}
              value={s.thinkTimeMs}
              min={0}
              step={500}
              onCommit={(v) => patch({ thinkTimeMs: v })}
            />
          )}
        </Field>
      ) : (
        <Field label="Actions per user" unit="per minute">
          {(id) => (
            <NumberInput
              id={id}
              value={s.actionsPerUserPerMinute}
              min={0}
              step={1}
              onCommit={(v) => patch({ actionsPerUserPerMinute: v })}
            />
          )}
        </Field>
      )}

      <div className="mb-4">
        {closed ? (
          <Callout tone="accent" title="The rate is an outcome, not a setting">
            {formatNumber(s.activeUsers)} users, each waiting for its own answer and then
            pausing about {formatNumber(s.thinkTimeMs)} ms. With instant answers they would
            settle at <span className="font-mono text-ink">{formatRate(effective)}</span>; the
            real figure is measured during the run and is lower once the pace settles, though a
            run only a few think times long starts faster, because nobody has thought yet.
            <br />
            There can never be more requests in flight than there are users, so a system that
            slows down is asked for less — which is what a real crowd does.
          </Callout>
        ) : (
          <Callout tone="accent" title="One action equals one request">
            {formatNumber(s.activeUsers)} × {formatNumber(s.actionsPerUserPerMinute)} ÷ 60 ={' '}
            <span className="font-mono text-ink">{formatRate(derived)}</span>
            {overridden && (
              <>
                {' '}
                — but the advanced override is on, so the run will use{' '}
                <span className="font-mono text-ink">{formatRate(effective)}</span>.
              </>
            )}
            <br />
            Requests are generated at a steady rate and do not wait for earlier responses.
            Individual user sessions are not modelled.
          </Callout>
        )}
      </div>

      <Collapsible title="Advanced" defaultOpen={overridden}>
        {!closed && (
          <div className="mb-4">
            <Toggle
              checked={overridden}
              label="Set the request rate directly"
              onChange={(checked) =>
                patch({ requestRateOverridePerSecond: checked ? Number(derived.toFixed(3)) : null })
              }
            />
          </div>
        )}
        {overridden && (
          <Field label="Request rate" unit="requests per second">
            {(id) => (
              <NumberInput
                id={id}
                value={s.requestRateOverridePerSecond ?? 0}
                min={0}
                step={1}
                onCommit={(v) => patch({ requestRateOverridePerSecond: v })}
              />
            )}
          </Field>
        )}
        <Field label="Request payload" unit="bytes" hint="Sent from the client to the server.">
          {(id) => (
            <NumberInput
              id={id}
              value={s.requestBytes}
              min={0}
              step={100}
              onCommit={(v) => patch({ requestBytes: v })}
            />
          )}
        </Field>
        <Field
          label="Response payload"
          unit="bytes"
          hint="Sent back to the client. This is what outbound transfer pricing measures."
        >
          {(id) => (
            <NumberInput
              id={id}
              value={s.responseBytes}
              min={0}
              step={1000}
              onCommit={(v) => patch({ responseBytes: v })}
            />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

/* ----------------------------------------------------------- load balancers */

function LoadBalancerSettingsForm({ node }: { node: ArchNode & { kind: 'loadBalancer' } }) {
  const mutate = useEditor((s) => s.mutate);
  const document = useEditor((s) => s.project?.document ?? null);
  const patch = (changes: Partial<LoadBalancerSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'loadBalancer') Object.assign(target.settings, changes);
    });

  const s = node.settings;
  const behind = (document?.edges ?? []).filter((e) => e.source === node.id).length;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.loadBalancer}</Intro>

      <Field
        label="How it picks a server"
        hint="Round robin takes each server in turn. Least busy sends to whichever server is holding the fewest requests."
      >
        {(id) => (
          <select
            id={id}
            className="ap-select"
            value={s.policy}
            onChange={(e) => patch({ policy: e.target.value as LoadBalancingPolicy })}
          >
            <option value="round-robin">Round robin</option>
            <option value="least-busy">Least busy</option>
          </select>
        )}
      </Field>

      <Field
        label="Average time to forward a request"
        unit="ms"
        hint="What the balancer itself costs. It does not compute an answer."
      >
        {(id) => (
          <NumberInput
            id={id}
            value={s.serviceTimeMs}
            min={0}
            step={0.1}
            onCommit={(v) => patch({ serviceTimeMs: v })}
          />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          {behind === 0
            ? 'Nothing is connected behind this balancer yet. Connect it to one or more Application Servers.'
            : `Requests are spread across the ${behind} server${behind === 1 ? '' : 's'} connected to it.`}{' '}
          Its service time and concurrency limit are charged once, on the way in; the response
          passes back through without queueing again. Health checks, connection reuse, sticky
          sessions and retries are not modelled.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Maximum concurrent requests" unit="slots">
          {(id) => (
            <NumberInput
              id={id}
              value={s.maxConcurrentRequests}
              min={1}
              step={64}
              onCommit={(v) => patch({ maxConcurrentRequests: Math.round(v) })}
            />
          )}
        </Field>
        <Field
          label="Waiting queue limit"
          unit="requests"
          hint="Requests beyond this are rejected before they ever reach a server."
        >
          {(id) => (
            <NumberInput
              id={id}
              value={s.queueLimit}
              min={0}
              step={64}
              onCommit={(v) => patch({ queueLimit: Math.round(v) })}
            />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

/* ------------------------------------------------------------------ servers */

function ServerSettingsForm({ node }: { node: ArchNode & { kind: 'server' } }) {
  const mutate = useEditor((s) => s.mutate);
  const hardware = useEditor((s) => s.hardwareCatalog);
  const profiles = hardware?.profiles ?? SERVER_HARDWARE_PROFILES;

  const patch = (changes: Partial<ServerSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'server') Object.assign(target.settings, changes);
    });

  /**
   * Editing a hardware field by hand switches the profile to Custom. The store
   * re-prices the machine in the same change, as the smallest catalogued one
   * that fits the numbers now on it — eight CPU slots typed into a box that was
   * a Large is not a Large, and must not be billed as one. Rates chosen by hand
   * are left alone, and the panel says so.
   */
  const patchHardware = (changes: Partial<ServerSettings>) =>
    patch({ ...changes, profile: 'custom' as ServerProfileId });

  /**
   * Change the machine, and let its price come with it.
   *
   * A Resource profile used to set capacity and leave the cloud profile alone,
   * on the reasoning that rewriting a cost choice would be presumptuous. In
   * practice it meant upgrading to Large kept the price of a Medium, and the
   * estimate described a machine that was no longer selected — which is worse
   * than presumptuous, it is wrong. The price now follows the size, within the
   * provider and region already chosen; see `serverProfileForSize` for the
   * three outcomes and why a provider is never crossed.
   *
   * Only the three hardware fields are touched. CPU work per request, the
   * concurrency limit and the memory charged per request belong to the
   * software, not to the box, and survive a change of box untouched.
   */
  const applyProfile = (id: ServerProfileId) => {
    if (id === 'custom') {
      // The numbers do not change, so the price does not either — but it is
      // now the price of a fitted machine rather than of a named size.
      patchHardware({});
      return;
    }
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;

    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (!target || target.kind !== 'server') return;
      Object.assign(target.settings, {
        profile: id,
        cpuSlots: profile.cpuSlots,
        ramMb: profile.ramMb,
        baselineMemoryMb: profile.baselineMemoryMb,
      });
      // The store resolves the price in the same undoable document change.
      target.cloud.pricingMode = 'automatic';
    });
  };

  const s = node.settings;
  const capacity = s.cpuMsPerRequest > 0 ? (s.cpuSlots * 1000) / s.cpuMsPerRequest : Infinity;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.server}</Intro>

      <Field
        label="Resource profile"
        hint="The machine: CPU slots, memory and baseline memory, and the cloud rates that go with that size in the provider and region already chosen. It never changes your application settings."
      >
        {(id) => (
          <select
            id={id}
            className="ap-select"
            value={s.profile}
            onChange={(e) => applyProfile(e.target.value as ServerProfileId)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} — {p.description}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="Modelled compute capacity">
          {s.cpuSlots} CPU slot{s.cpuSlots === 1 ? '' : 's'} × 1000 ms ÷ {s.cpuMsPerRequest} ms per
          request ={' '}
          <span className="font-mono text-ink">
            {Number.isFinite(capacity) ? formatRate(capacity) : 'unlimited'}
          </span>{' '}
          at best{s.autoscaleEnabled ? <>{' '}per instance, so{' '}
            <span className="font-mono text-ink">
              {Number.isFinite(capacity) ? formatRate(capacity * s.maxInstances) : 'unlimited'}
            </span>{' '}with all {s.maxInstances} running</> : null}. A CPU slot is a deliberately simplified stand-in for usable compute capacity,
          not a core count.
        </Callout>
      </div>

      <div className="mb-4">
        <Collapsible title="Auto scaling" defaultOpen={s.autoscaleEnabled} badge={s.autoscaleEnabled ? <Badge tone="accent">On</Badge> : null}>
          <p className="mb-3 text-[12px] leading-relaxed text-ink-3">
            Adds machines when this server gets busy and removes them when it is quiet. Every few
            seconds it compares its CPU use with the target: at twice the target it wants twice the
            machines. A new machine is paid for from the moment it starts, but only takes requests
            after it has warmed up.
          </p>
          <div className="mb-4">
            <Toggle
              checked={s.autoscaleEnabled}
              onChange={(on) => patch({ autoscaleEnabled: on })}
              label="Scale this server automatically"
            />
          </div>
          {s.autoscaleEnabled && (
            <>
              <Field label="Fewest instances" hint="Always running, even with no traffic — and always billed.">
                {(id) => (
                  <NumberInput id={id} value={s.minInstances} min={1} max={1000} step={1}
                    onCommit={(v) => patch({ minInstances: Math.round(v), maxInstances: Math.max(Math.round(v), s.maxInstances) })} />
                )}
              </Field>
              <Field label="Most instances" hint="The ceiling. Past it, requests wait or are refused as on one machine.">
                {(id) => (
                  <NumberInput id={id} value={s.maxInstances} min={1} max={1000} step={1}
                    onCommit={(v) => patch({ maxInstances: Math.max(Math.round(v), s.minInstances) })} />
                )}
              </Field>
              <Field label="Target CPU use (0–1)" hint="Lower keeps more spare room for a sudden rush, and costs more.">
                {(id) => (
                  <NumberInput id={id} value={s.targetCpuShare} min={0.05} max={1} step={0.05}
                    onCommit={(v) => patch({ targetCpuShare: Math.min(1, Math.max(0.05, v)) })} />
                )}
              </Field>
              <Field label="Warm-up time" unit="s" hint="From starting a machine to it taking requests. A virtual machine takes a minute or more; a container, tens of seconds.">
                {(id) => (
                  <NumberInput id={id} value={s.instanceWarmupSeconds} min={0} max={3600} step={1}
                    onCommit={(v) => patch({ instanceWarmupSeconds: Math.max(0, v) })} />
                )}
              </Field>
              <Field label="Check every" unit="s" hint="How often it looks at CPU use and decides. In a Timed run, scaling happens while traffic arrives.">
                {(id) => (
                  <NumberInput id={id} value={s.scaleCheckSeconds} min={0.1} max={3600} step={1}
                    onCommit={(v) => patch({ scaleCheckSeconds: Math.max(0.1, v) })} />
                )}
              </Field>
            </>
          )}
        </Collapsible>
      </div>

      <Collapsible title="Advanced" badge={s.profile === 'custom' ? <Badge>Custom</Badge> : null}>
        <Field label="CPU slots" unit="parallel requests computing">
          {(id) => (
            <NumberInput
              id={id}
              value={s.cpuSlots}
              min={1}
              step={1}
              onCommit={(v) => patchHardware({ cpuSlots: Math.round(v) })}
            />
          )}
        </Field>
        <Field label="Memory capacity" unit="MB">
          {(id) => (
            <NumberInput
              id={id}
              value={s.ramMb}
              min={1}
              step={256}
              onCommit={(v) => patchHardware({ ramMb: v })}
            />
          )}
        </Field>
        <Field
          label="CPU work per request"
          unit="ms"
          hint="Belongs to your application, not the machine. Split evenly across the compute segments between downstream calls."
        >
          {(id) => (
            <NumberInput
              id={id}
              value={s.cpuMsPerRequest}
              min={0}
              step={1}
              onCommit={(v) => patch({ cpuMsPerRequest: v })}
            />
          )}
        </Field>
        <Field
          label="Application concurrency limit"
          unit="requests held open"
          hint="Includes requests that are only waiting on a database or cache."
        >
          {(id) => (
            <NumberInput
              id={id}
              value={s.concurrencyLimit}
              min={1}
              step={8}
              onCommit={(v) => patch({ concurrencyLimit: Math.round(v) })}
            />
          )}
        </Field>
        <Field label="Baseline memory" unit="MB" hint="Used before any request is served.">
          {(id) => (
            <NumberInput
              id={id}
              value={s.baselineMemoryMb}
              min={0}
              step={32}
              onCommit={(v) => patchHardware({ baselineMemoryMb: v })}
            />
          )}
        </Field>
        <Field label="Memory per admitted request" unit="MB">
          {(id) => (
            <NumberInput
              id={id}
              value={s.memoryPerRequestMb}
              min={0}
              step={1}
              onCommit={(v) => patch({ memoryPerRequestMb: v })}
            />
          )}
        </Field>
        <Field
          label="Memory per queued request"
          unit="MB"
          hint="Explicit assumption: a request that is only waiting still costs this much memory."
        >
          {(id) => (
            <NumberInput
              id={id}
              value={s.memoryPerQueuedRequestMb}
              min={0}
              step={0.1}
              onCommit={(v) => patch({ memoryPerQueuedRequestMb: v })}
            />
          )}
        </Field>
        <Field
          label="Waiting queue limit"
          unit="requests"
          hint="Requests beyond this, or beyond the memory budget, are rejected."
        >
          {(id) => (
            <NumberInput
              id={id}
              value={s.queueLimit}
              min={0}
              step={10}
              onCommit={(v) => patch({ queueLimit: Math.round(v) })}
            />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

/* ---------------------------------------------------------------- databases */

function DatabaseSettingsForm({ node }: { node: ArchNode & { kind: 'database' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<DatabaseSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'database') Object.assign(target.settings, changes);
    });
  const s = node.settings;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.database}</Intro>

      <Field
        label="Stored data"
        unit="GB"
        hint="Used for storage cost only. It does not change query time in this version, because no model connects the two."
      >
        {(id) => (
          <NumberInput
            id={id}
            value={s.dataSizeGb}
            min={0}
            step={10}
            onCommit={(v) => patch({ dataSizeGb: v })}
          />
        )}
      </Field>
      <Field
        label="Queries that only read"
        unit="%"
        hint="The rest write. Reads can go to a Read Replica connected to the server; writes always come here, and are copied to every replica."
      >
        {(id) => (
          <NumberInput
            id={id}
            value={Math.round(s.readShare * 1000) / 10}
            min={0}
            max={100}
            step={5}
            onCommit={(v) => patch({ readShare: v / 100 })}
          />
        )}
      </Field>
      <Field label="Average query service time" unit="ms">
        {(id) => (
          <NumberInput
            id={id}
            value={s.queryServiceTimeMs}
            min={0}
            step={1}
            onCommit={(v) => patch({ queryServiceTimeMs: v })}
          />
        )}
      </Field>
      <Field label="Maximum concurrent queries" unit="slots">
        {(id) => (
          <NumberInput
            id={id}
            value={s.maxConcurrentQueries}
            min={1}
            step={1}
            onCommit={(v) => patch({ maxConcurrentQueries: Math.round(v) })}
          />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          One database read happens per uncached request or cache miss. Query planning, indexes,
          transactions and replication are not modelled: the service time above is the whole story.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Waiting queue limit" unit="queries">
          {(id) => (
            <NumberInput
              id={id}
              value={s.queueLimit}
              min={0}
              step={10}
              onCommit={(v) => patch({ queueLimit: Math.round(v) })}
            />
          )}
        </Field>
        <Field label="Query request size" unit="bytes">
          {(id) => (
            <NumberInput
              id={id}
              value={s.queryRequestBytes}
              min={0}
              step={64}
              onCommit={(v) => patch({ queryRequestBytes: v })}
            />
          )}
        </Field>
        <Field label="Query result size" unit="bytes">
          {(id) => (
            <NumberInput
              id={id}
              value={s.queryResultBytes}
              min={0}
              step={512}
              onCommit={(v) => patch({ queryResultBytes: v })}
            />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

/* ------------------------------------------------------------------- caches */

function CacheSettingsForm({ node }: { node: ArchNode & { kind: 'cache' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<CacheSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'cache') Object.assign(target.settings, changes);
    });
  const s = node.settings;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.cache}</Intro>

      <Field
        label="Assumed hit rate"
        unit="%"
        hint="Fixed. Populating the cache does not raise it in this version."
      >
        {(id) => (
          <NumberInput
            id={id}
            value={Math.round(s.hitRate * 1000) / 10}
            min={0}
            max={100}
            step={5}
            onCommit={(v) => patch({ hitRate: v / 100 })}
          />
        )}
      </Field>
      <Field label="Average lookup service time" unit="ms">
        {(id) => (
          <NumberInput
            id={id}
            value={s.lookupServiceTimeMs}
            min={0}
            step={0.1}
            onCommit={(v) => patch({ lookupServiceTimeMs: v })}
          />
        )}
      </Field>
      <Field
        label="Capacity"
        unit="GB"
        hint="Used for configuration and pricing. It does not change the hit rate."
      >
        {(id) => (
          <NumberInput
            id={id}
            value={s.capacityGb}
            min={0}
            step={1}
            onCommit={(v) => patch({ capacityGb: v })}
          />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          A hit is drawn from the rate above using the run seed. A miss goes to the database and,
          if cache population is on, writes the value back — the server waits for that write before
          answering. Individual keys, expiry and eviction are not modelled.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Maximum concurrent lookups" unit="slots">
          {(id) => (
            <NumberInput
              id={id}
              value={s.maxConcurrentLookups}
              min={1}
              step={8}
              onCommit={(v) => patch({ maxConcurrentLookups: Math.round(v) })}
            />
          )}
        </Field>
        <Field label="Waiting queue limit" unit="lookups">
          {(id) => (
            <NumberInput
              id={id}
              value={s.queueLimit}
              min={0}
              step={50}
              onCommit={(v) => patch({ queueLimit: Math.round(v) })}
            />
          )}
        </Field>
        <div className="mb-4">
          <Toggle
            checked={s.populateOnMiss}
            label="Write the value back to the cache after a miss"
            onChange={(v) => patch({ populateOnMiss: v })}
          />
        </div>
        <Field
          label="Cache write service time"
          unit="ms"
          hint="The documented simplified write cost."
        >
          {(id) => (
            <NumberInput
              id={id}
              value={s.populateServiceTimeMs}
              min={0}
              step={0.1}
              onCommit={(v) => patch({ populateServiceTimeMs: v })}
            />
          )}
        </Field>
        <Field
          label="Lookup request size"
          unit="bytes"
          hint="Also used for the short reply on a miss and for the write acknowledgement."
        >
          {(id) => (
            <NumberInput
              id={id}
              value={s.lookupRequestBytes}
              min={0}
              step={64}
              onCommit={(v) => patch({ lookupRequestBytes: v })}
            />
          )}
        </Field>
        <Field label="Lookup result size" unit="bytes" hint="Returned on a hit.">
          {(id) => (
            <NumberInput
              id={id}
              value={s.lookupResultBytes}
              min={0}
              step={512}
              onCommit={(v) => patch({ lookupResultBytes: v })}
            />
          )}
        </Field>
        <Field label="Cache write size" unit="bytes">
          {(id) => (
            <NumberInput
              id={id}
              value={s.populateBytes}
              min={0}
              step={512}
              onCommit={(v) => patch({ populateBytes: v })}
            />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

/* -------------------------------------------------------------------- links */

/* ------------------------------------------------------------------ queues */

function QueueSettingsForm({ node }: { node: ArchNode & { kind: 'queue' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<QueueSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'queue') Object.assign(target.settings, changes);
    });
  const s = node.settings;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.queue}</Intro>

      <Field
        label="Maximum depth"
        unit="messages"
        hint="How much work may be waiting. A publish beyond this fails, which is what makes a consumer that cannot keep up visible."
      >
        {(id) => (
          <NumberInput
            id={id}
            value={s.maxDepth}
            min={0}
            step={1000}
            onCommit={(v) => patch({ maxDepth: Math.round(v) })}
          />
        )}
      </Field>
      <Field
        label="Publish service time"
        unit="ms"
        hint="How long the broker takes to accept one message. The publisher waits for this and nothing more."
      >
        {(id) => (
          <NumberInput
            id={id}
            value={s.publishServiceTimeMs}
            min={0}
            step={0.1}
            onCommit={(v) => patch({ publishServiceTimeMs: v })}
          />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          The server publishes, waits only for the broker to take the message, and answers its
          own caller. The Application Server connected behind this queue takes messages off it
          whenever it has room for another, and everything it does — CPU, memory, its own cache
          and database — is accounted for exactly as it would be for a server handling users.
          <br />
          Retries, dead-letter queues, ordering guarantees, partitions and more than one
          consumer are not modelled in this version.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Message size" unit="bytes" hint="What one message costs on the wire.">
          {(id) => (
            <NumberInput
              id={id}
              value={s.messageBytes}
              min={0}
              step={100}
              onCommit={(v) => patch({ messageBytes: v })}
            />
          )}
        </Field>
        <Field
          label="Concurrent publishes"
          unit="slots"
          hint="How many messages the broker can be accepting at once."
        >
          {(id) => (
            <NumberInput
              id={id}
              value={s.maxConcurrentPublishes}
              min={1}
              step={64}
              onCommit={(v) => patch({ maxConcurrentPublishes: Math.round(v) })}
            />
          )}
        </Field>
        <Field
          label="Publish waiting limit"
          unit="requests"
          hint="How many publishes may wait for a free broker slot before one is refused."
        >
          {(id) => (
            <NumberInput
              id={id}
              value={s.publishQueueLimit}
              min={0}
              step={256}
              onCommit={(v) => patch({ publishQueueLimit: Math.round(v) })}
            />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

function DnsSettingsForm({ node }: { node: ArchNode & { kind: 'dns' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<DnsSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'dns') Object.assign(target.settings, changes);
    });
  const s = node.settings;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.dns}</Intro>

      <Field
        label="Requests that need a lookup"
        unit="%"
        hint="The rest already have the answer cached on the user's machine. An assumption: set it from your record's TTL and how often users come back."
      >
        {(id) => (
          <NumberInput
            id={id}
            value={Math.round(s.lookupShare * 1000) / 10}
            min={0}
            max={100}
            step={1}
            onCommit={(v) => patch({ lookupShare: v / 100 })}
          />
        )}
      </Field>
      <Field label="Average lookup time" unit="ms">
        {(id) => (
          <NumberInput
            id={id}
            value={s.lookupServiceTimeMs}
            min={0}
            step={1}
            onCommit={(v) => patch({ lookupServiceTimeMs: v })}
          />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          DNS sits beside the path, not in it. A request that needs a lookup asks the DNS first,
          waits for the answer, then sets off; every other request goes straight away. The lookup
          adds latency to those requests only, and each one is a billed query.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Maximum concurrent lookups" unit="slots">
          {(id) => (
            <NumberInput
              id={id}
              value={s.maxConcurrentLookups}
              min={1}
              step={8}
              onCommit={(v) => patch({ maxConcurrentLookups: Math.round(v) })}
            />
          )}
        </Field>
        <Field label="Waiting queue limit" unit="lookups">
          {(id) => (
            <NumberInput
              id={id}
              value={s.queueLimit}
              min={0}
              step={50}
              onCommit={(v) => patch({ queueLimit: Math.round(v) })}
            />
          )}
        </Field>
        <Field label="Query size" unit="bytes">
          {(id) => (
            <NumberInput
              id={id}
              value={s.queryBytes}
              min={0}
              step={16}
              onCommit={(v) => patch({ queryBytes: v })}
            />
          )}
        </Field>
        <Field label="Answer size" unit="bytes">
          {(id) => (
            <NumberInput
              id={id}
              value={s.answerBytes}
              min={0}
              step={16}
              onCommit={(v) => patch({ answerBytes: v })}
            />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

function CdnSettingsForm({ node }: { node: ArchNode & { kind: 'cdn' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<CdnSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'cdn') Object.assign(target.settings, changes);
    });
  const s = node.settings;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.cdn}</Intro>

      <Field
        label="Assumed hit rate"
        unit="%"
        hint="Fixed. Nothing here models what is being asked for, so the share answered at the edge is your assumption."
      >
        {(id) => (
          <NumberInput
            id={id}
            value={Math.round(s.hitRate * 1000) / 10}
            min={0}
            max={100}
            step={5}
            onCommit={(v) => patch({ hitRate: v / 100 })}
          />
        )}
      </Field>
      <Field label="Average service time" unit="ms" hint="Spent on every request, hit or miss.">
        {(id) => (
          <NumberInput
            id={id}
            value={s.serviceTimeMs}
            min={0}
            step={0.5}
            onCommit={(v) => patch({ serviceTimeMs: v })}
          />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          A hit is drawn from the rate above using the run seed and answered here: it never
          reaches anything behind the CDN. A miss goes through to your servers and the answer
          comes back this way. Every request is billed; only the misses cost you compute.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Maximum concurrent requests" unit="slots">
          {(id) => (
            <NumberInput
              id={id}
              value={s.maxConcurrentRequests}
              min={1}
              step={8}
              onCommit={(v) => patch({ maxConcurrentRequests: Math.round(v) })}
            />
          )}
        </Field>
        <Field label="Waiting queue limit" unit="requests">
          {(id) => (
            <NumberInput
              id={id}
              value={s.queueLimit}
              min={0}
              step={50}
              onCommit={(v) => patch({ queueLimit: Math.round(v) })}
            />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

function WafSettingsForm({ node }: { node: ArchNode & { kind: 'waf' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<WafSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'waf') Object.assign(target.settings, changes);
    });
  const s = node.settings;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.waf}</Intro>

      <Field
        label="Requests blocked"
        unit="%"
        hint="An assumption about your traffic, not a detection model. Set it to what your own logs say."
      >
        {(id) => (
          <NumberInput
            id={id}
            value={Math.round(s.blockRate * 1000) / 10}
            min={0}
            max={100}
            step={0.5}
            onCommit={(v) => patch({ blockRate: v / 100 })}
          />
        )}
      </Field>
      <Field label="Average inspection time" unit="ms" hint="Spent on every request, allowed or blocked.">
        {(id) => (
          <NumberInput
            id={id}
            value={s.serviceTimeMs}
            min={0}
            step={0.1}
            onCommit={(v) => patch({ serviceTimeMs: v })}
          />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          Every request is inspected, then a share is refused using the run seed. A blocked
          request is counted as rejected and never reaches anything behind the firewall, so
          everything behind it sees that much less load.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Maximum concurrent requests" unit="slots">
          {(id) => (
            <NumberInput
              id={id}
              value={s.maxConcurrentRequests}
              min={1}
              step={8}
              onCommit={(v) => patch({ maxConcurrentRequests: Math.round(v) })}
            />
          )}
        </Field>
        <Field label="Waiting queue limit" unit="requests">
          {(id) => (
            <NumberInput
              id={id}
              value={s.queueLimit}
              min={0}
              step={50}
              onCommit={(v) => patch({ queueLimit: Math.round(v) })}
            />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

function ApiGatewaySettingsForm({ node }: { node: ArchNode & { kind: 'apiGateway' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<ApiGatewaySettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'apiGateway') Object.assign(target.settings, changes);
    });
  const s = node.settings;
  const limited = s.rateLimitPerSecond !== null;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.apiGateway}</Intro>

      <div className="mb-4">
        <Toggle
          checked={limited}
          label="Enforce a rate limit"
          onChange={(v) => patch({ rateLimitPerSecond: v ? 1000 : null })}
        />
      </div>
      {limited && (
        <>
          <Field
            label="Requests let through"
            unit="per second"
            hint="Above this steady rate, requests are refused rather than queued."
          >
            {(id) => (
              <NumberInput
                id={id}
                value={s.rateLimitPerSecond ?? 0}
                min={0}
                step={100}
                onCommit={(v) => patch({ rateLimitPerSecond: v })}
              />
            )}
          </Field>
          <Field
            label="Burst allowance"
            unit="requests"
            hint="How far a short burst may run ahead of the steady rate before refusals start."
          >
            {(id) => (
              <NumberInput
                id={id}
                value={s.burstCapacity}
                min={0}
                step={10}
                onCommit={(v) => patch({ burstCapacity: Math.round(v) })}
              />
            )}
          </Field>
        </>
      )}
      <Field label="Average service time" unit="ms" hint="Routing, authentication and forwarding, on every request.">
        {(id) => (
          <NumberInput
            id={id}
            value={s.serviceTimeMs}
            min={0}
            step={0.5}
            onCommit={(v) => patch({ serviceTimeMs: v })}
          />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          The limit is a token bucket: it refills at the steady rate and holds at most the burst
          allowance. A request that finds no token is refused on the spot and counted as
          throttled. The gateway forwards; it never computes.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Maximum concurrent requests" unit="slots">
          {(id) => (
            <NumberInput
              id={id}
              value={s.maxConcurrentRequests}
              min={1}
              step={8}
              onCommit={(v) => patch({ maxConcurrentRequests: Math.round(v) })}
            />
          )}
        </Field>
        <Field label="Waiting queue limit" unit="requests">
          {(id) => (
            <NumberInput
              id={id}
              value={s.queueLimit}
              min={0}
              step={50}
              onCommit={(v) => patch({ queueLimit: Math.round(v) })}
            />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

function ServerlessSettingsForm({ node }: { node: ArchNode & { kind: 'serverless' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<ServerlessSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'serverless') Object.assign(target.settings, changes);
    });
  const s = node.settings;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.serverless}</Intro>

      <Field label="CPU work per invocation" unit="ms" hint="The same figure an Application Server uses.">
        {(id) => (
          <NumberInput id={id} value={s.cpuMsPerRequest} min={0} step={1} onCommit={(v) => patch({ cpuMsPerRequest: v })} />
        )}
      </Field>
      <Field label="Memory per invocation" unit="MB" hint="Sets the billing rate: the provider charges per gigabyte-second alive.">
        {(id) => (
          <NumberInput id={id} value={s.memoryMb} min={1} step={128} onCommit={(v) => patch({ memoryMb: v })} />
        )}
      </Field>
      <Field label="Concurrency limit" unit="invocations" hint="Account-wide. Above it, requests are refused on the spot; a function never queues.">
        {(id) => (
          <NumberInput id={id} value={s.maxConcurrentInvocations} min={1} step={100} onCommit={(v) => patch({ maxConcurrentInvocations: Math.round(v) })} />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          Every invocation computes at once, with no CPU slots to share. Its bill is wall-clock
          time, waiting on a database included, times the memory above. A share of invocations
          pay a cold start first, drawn with the run seed.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Invocations that start cold" unit="%" hint="An assumption: steady traffic keeps instances warm, bursts do not.">
          {(id) => (
            <NumberInput id={id} value={Math.round(s.coldStartShare * 1000) / 10} min={0} max={100} step={1} onCommit={(v) => patch({ coldStartShare: v / 100 })} />
          )}
        </Field>
        <Field label="Cold start time" unit="ms">
          {(id) => (
            <NumberInput id={id} value={s.coldStartMs} min={0} step={50} onCommit={(v) => patch({ coldStartMs: v })} />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

function ReadReplicaSettingsForm({ node }: { node: ArchNode & { kind: 'readReplica' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<ReadReplicaSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'readReplica') Object.assign(target.settings, changes);
    });
  const s = node.settings;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.readReplica}</Intro>

      <Field label="Average read service time" unit="ms">
        {(id) => (
          <NumberInput id={id} value={s.queryServiceTimeMs} min={0} step={0.5} onCommit={(v) => patch({ queryServiceTimeMs: v })} />
        )}
      </Field>
      <Field label="Time to apply one write" unit="ms" hint="Every write to the database is copied here and takes this long to apply. It shares the slots below with reads.">
        {(id) => (
          <NumberInput id={id} value={s.applyServiceTimeMs} min={0} step={0.5} onCommit={(v) => patch({ applyServiceTimeMs: v })} />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          Connect the Database to this replica, and the server to it. The share of the
          database's queries that are reads go here instead, round-robin across replicas.
          Writes still go to the database, then to every replica; nobody waits for that,
          so a replica that cannot keep up falls behind rather than slowing anyone.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Maximum concurrent queries" unit="slots">
          {(id) => (
            <NumberInput id={id} value={s.maxConcurrentQueries} min={1} step={4} onCommit={(v) => patch({ maxConcurrentQueries: Math.round(v) })} />
          )}
        </Field>
        <Field label="Waiting queue limit" unit="reads" hint="Reads beyond it are rejected. Writes being applied never are.">
          {(id) => (
            <NumberInput id={id} value={s.queueLimit} min={0} step={50} onCommit={(v) => patch({ queueLimit: Math.round(v) })} />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

function KvStoreSettingsForm({ node }: { node: ArchNode & { kind: 'kvStore' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<KvStoreSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'kvStore') Object.assign(target.settings, changes);
    });
  const s = node.settings;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.kvStore}</Intro>

      <Field label="Operations that read" unit="%" hint="The rest write. Reads and writes are billed at different rates.">
        {(id) => (
          <NumberInput id={id} value={Math.round(s.readShare * 1000) / 10} min={0} max={100} step={5} onCommit={(v) => patch({ readShare: v / 100 })} />
        )}
      </Field>
      <Field label="Average read service time" unit="ms">
        {(id) => (
          <NumberInput id={id} value={s.readServiceTimeMs} min={0} step={0.5} onCommit={(v) => patch({ readServiceTimeMs: v })} />
        )}
      </Field>
      <Field label="Average write service time" unit="ms">
        {(id) => (
          <NumberInput id={id} value={s.writeServiceTimeMs} min={0} step={0.5} onCommit={(v) => patch({ writeServiceTimeMs: v })} />
        )}
      </Field>
      <Field label="Stored data" unit="GB" hint="Used for storage cost only.">
        {(id) => (
          <NumberInput id={id} value={s.storedGb} min={0} step={10} onCommit={(v) => patch({ storedGb: v })} />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          Every request through the server does one operation here, read or write, drawn with
          the run seed. A cache hit answers a read, so only writes go through on a hit. Joins,
          indexes and consistency are not modelled.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Maximum concurrent requests" unit="slots" hint="A managed store scales itself; lower this to model one you run.">
          {(id) => (
            <NumberInput id={id} value={s.maxConcurrentRequests} min={1} step={100} onCommit={(v) => patch({ maxConcurrentRequests: Math.round(v) })} />
          )}
        </Field>
        <Field label="Waiting queue limit" unit="requests">
          {(id) => (
            <NumberInput id={id} value={s.queueLimit} min={0} step={100} onCommit={(v) => patch({ queueLimit: Math.round(v) })} />
          )}
        </Field>
        <Field label="Record size" unit="bytes" hint="On the wire, read or written.">
          {(id) => (
            <NumberInput id={id} value={s.itemBytes} min={0} step={256} onCommit={(v) => patch({ itemBytes: v })} />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

function ObjectStorageSettingsForm({ node }: { node: ArchNode & { kind: 'objectStorage' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<ObjectStorageSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'objectStorage') Object.assign(target.settings, changes);
    });
  const s = node.settings;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.objectStorage}</Intro>

      <Field label="Operations that write" unit="%" hint="An upload. The rest read an object.">
        {(id) => (
          <NumberInput id={id} value={Math.round(s.writeShare * 1000) / 10} min={0} max={100} step={5} onCommit={(v) => patch({ writeShare: v / 100 })} />
        )}
      </Field>
      <Field label="Object size" unit="bytes" hint="Carried on the wire each way it goes: to the server on a read, from it on a write.">
        {(id) => (
          <NumberInput id={id} value={s.objectBytes} min={0} step={10_000} onCommit={(v) => patch({ objectBytes: v })} />
        )}
      </Field>
      <Field label="Stored data" unit="GB" hint="Used for storage cost only.">
        {(id) => (
          <NumberInput id={id} value={s.storedGb} min={0} step={100} onCommit={(v) => patch({ storedGb: v })} />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          Every request through the server reads or writes one object, drawn with the run
          seed. Reads and writes take different times and are billed at different rates;
          what is kept is billed by the gigabyte-month.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Average read time" unit="ms">
          {(id) => (
            <NumberInput id={id} value={s.getServiceTimeMs} min={0} step={1} onCommit={(v) => patch({ getServiceTimeMs: v })} />
          )}
        </Field>
        <Field label="Average write time" unit="ms">
          {(id) => (
            <NumberInput id={id} value={s.putServiceTimeMs} min={0} step={1} onCommit={(v) => patch({ putServiceTimeMs: v })} />
          )}
        </Field>
        <Field label="Maximum concurrent requests" unit="slots">
          {(id) => (
            <NumberInput id={id} value={s.maxConcurrentRequests} min={1} step={100} onCommit={(v) => patch({ maxConcurrentRequests: Math.round(v) })} />
          )}
        </Field>
        <Field label="Waiting queue limit" unit="requests">
          {(id) => (
            <NumberInput id={id} value={s.queueLimit} min={0} step={100} onCommit={(v) => patch({ queueLimit: Math.round(v) })} />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

function PubSubSettingsForm({ node }: { node: ArchNode & { kind: 'pubsub' } }) {
  const mutate = useEditor((s) => s.mutate);
  const patch = (changes: Partial<PubSubSettings>) =>
    mutate((draft) => {
      const target = draft.nodes.find((n) => n.id === node.id);
      if (target && target.kind === 'pubsub') Object.assign(target.settings, changes);
    });
  const s = node.settings;

  return (
    <>
      <Intro>{COMPONENT_DESCRIPTIONS.pubsub}</Intro>

      <Field label="Backlog per listener" unit="messages" hint="Each subscriber has its own. A full one drops its copy; the publisher is never told.">
        {(id) => (
          <NumberInput id={id} value={s.maxDepth} min={0} step={100} onCommit={(v) => patch({ maxDepth: Math.round(v) })} />
        )}
      </Field>
      <Field label="Publish service time" unit="ms" hint="What the publisher waits for: the broker taking the event.">
        {(id) => (
          <NumberInput id={id} value={s.publishServiceTimeMs} min={0} step={0.5} onCommit={(v) => patch({ publishServiceTimeMs: v })} />
        )}
      </Field>

      <div className="mb-4">
        <Callout tone="accent" title="What is modelled">
          Connect every listener behind the topic: each gets its own copy of every event and
          works through its own backlog. The publisher answers its caller as soon as the
          broker has the event. Ordering and replay are not modelled.
        </Callout>
      </div>

      <Collapsible title="Advanced">
        <Field label="Message size" unit="bytes">
          {(id) => (
            <NumberInput id={id} value={s.messageBytes} min={0} step={256} onCommit={(v) => patch({ messageBytes: v })} />
          )}
        </Field>
        <Field label="Concurrent publishes" unit="slots">
          {(id) => (
            <NumberInput id={id} value={s.maxConcurrentPublishes} min={1} step={16} onCommit={(v) => patch({ maxConcurrentPublishes: Math.round(v) })} />
          )}
        </Field>
        <Field label="Publish waiting limit" unit="publishes">
          {(id) => (
            <NumberInput id={id} value={s.publishQueueLimit} min={0} step={50} onCommit={(v) => patch({ publishQueueLimit: Math.round(v) })} />
          )}
        </Field>
      </Collapsible>
    </>
  );
}

function EdgeSettingsForm({ edge }: { edge: ArchEdge }) {
  const mutate = useEditor((s) => s.mutate);
  const document = useEditor((s) => s.project?.document ?? null);
  const source = document?.nodes.find((n) => n.id === edge.source);
  const target = document?.nodes.find((n) => n.id === edge.target);

  const patch = (changes: Partial<ArchEdge['settings']>) =>
    mutate((draft) => {
      const found = draft.edges.find((e) => e.id === edge.id);
      if (found) Object.assign(found.settings, changes);
    });

  const sample = 100_000;
  return (
    <>
      <Intro>
        A one-way delay and a bandwidth, applied separately in each direction. Request traffic and
        response traffic are accounted for on their own channel.
      </Intro>

      <div className="mb-4 rounded-lg bg-surface-2 px-3 py-2.5 text-[12px] text-ink-2">
        {source?.name ?? edge.source} <span className="text-ink-3">→</span>{' '}
        {target?.name ?? edge.target}
      </div>

      <Field
        label="One-way propagation delay"
        unit="ms"
        hint="Applied in each direction, so a round trip costs twice this."
      >
        {(id) => (
          <NumberInput
            id={id}
            value={edge.settings.propagationDelayMs}
            min={0}
            step={1}
            onCommit={(v) => patch({ propagationDelayMs: v })}
          />
        )}
      </Field>
      <Field label="Bandwidth" unit="Mbps">
        {(id) => (
          <NumberInput
            id={id}
            value={edge.settings.bandwidthMbps}
            min={0.001}
            step={10}
            onCommit={(v) => patch({ bandwidthMbps: v })}
          />
        )}
      </Field>

      <Callout tone="accent" title="Transfer time">
        A {formatNumber(sample / 1000)} KB message takes{' '}
        <span className="font-mono text-ink">
          {formatMs(transmissionMs(sample, edge.settings.bandwidthMbps), 3)}
        </span>{' '}
        to transmit, plus {formatMs(edge.settings.propagationDelayMs)} of propagation. Only one
        message transmits per direction at a time; the rest queue. There is no congestion control
        and no packet-level behaviour.
      </Callout>
    </>
  );
}

/* ----------------------------------------------------------------- assembly */

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const document = useEditor((s) => s.project?.document ?? null);
  const mutate = useEditor((s) => s.mutate);
  const deleteNode = useEditor((s) => s.deleteNode);
  const deleteEdge = useEditor((s) => s.deleteEdge);

  if (!document) return null;

  if (!selection) {
    return (
      <EmptyState title="Nothing selected">
        Click a component or a connection on the canvas to change its settings. To connect two
        components, drag from a dot on the edge of one to the other.
      </EmptyState>
    );
  }

  if (selection.type === 'edge') {
    const edge = document.edges.find((e) => e.id === selection.id);
    if (!edge) return <EmptyState title="That connection no longer exists." />;
    return (
      <div className="p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-ink">Network connection</h3>
          <button
            type="button"
            className="ap-icon-btn hover:text-bad"
            aria-label="Delete this connection"
            title="Delete this connection"
            onClick={() => deleteEdge(edge.id)}
          >
            <TrashIcon size={15} />
          </button>
        </div>
        <EdgeSettingsForm edge={edge} />
      </div>
    );
  }

  const node = document.nodes.find((n) => n.id === selection.id);
  if (!node) return <EmptyState title="That component no longer exists." />;
  const Glyph = KIND_ICONS[node.kind];

  return (
    <div className="p-4">
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <span className={kindIconClass(node.kind)}>
              <Glyph size={16} />
            </span>
            <span className="ap-eyebrow">{COMPONENT_LABELS[node.kind]}</span>
          </span>
          <button
            type="button"
            className="ap-icon-btn hover:text-bad"
            aria-label={`Delete ${node.name}`}
            title={`Delete ${node.name}`}
            onClick={() => deleteNode(node.id)}
          >
            <TrashIcon size={15} />
          </button>
        </div>
        <label htmlFor="component-name" className="sr-only">
          Name
        </label>
        <input
          id="component-name"
          className="ap-input text-[14px] font-semibold"
          value={node.name}
          onChange={(e) =>
            mutate((draft) => {
              const target = draft.nodes.find((n) => n.id === node.id);
              if (target) target.name = e.target.value.slice(0, 60) || target.name;
            })
          }
        />
      </div>

      {node.kind === 'client' && <ClientSettingsForm node={node} />}
      {node.kind === 'loadBalancer' && <LoadBalancerSettingsForm node={node} />}
      {node.kind === 'server' && <ServerSettingsForm node={node} />}
      {node.kind === 'database' && <DatabaseSettingsForm node={node} />}
      {node.kind === 'cache' && <CacheSettingsForm node={node} />}
      {node.kind === 'queue' && <QueueSettingsForm node={node} />}
      {node.kind === 'dns' && <DnsSettingsForm node={node} />}
      {node.kind === 'cdn' && <CdnSettingsForm node={node} />}
      {node.kind === 'waf' && <WafSettingsForm node={node} />}
      {node.kind === 'apiGateway' && <ApiGatewaySettingsForm node={node} />}
      {node.kind === 'serverless' && <ServerlessSettingsForm node={node} />}
      {node.kind === 'readReplica' && <ReadReplicaSettingsForm node={node} />}
      {node.kind === 'kvStore' && <KvStoreSettingsForm node={node} />}
      {node.kind === 'objectStorage' && <ObjectStorageSettingsForm node={node} />}
      {node.kind === 'pubsub' && <PubSubSettingsForm node={node} />}
      {isSupportKind(node.kind) && <ServiceSettingsForm node={node} description={SUPPORT_SERVICES[node.kind].description} fields={SUPPORT_SERVICES[node.kind].fields} />}
      {isJobKind(node.kind) && <ServiceSettingsForm node={node} {...JOB_SERVICES[node.kind]} />}
      {node.kind === 'workflow' && <WorkflowSteps workflowId={node.id} />}
      {isChainKind(node.kind) && <ServiceSettingsForm node={node} description={CHAIN_SERVICES[node.kind].description} fields={CHAIN_SERVICES[node.kind].fields} />}
      {node.kind === 'queue' && <ServiceSettingsForm node={node} description="Retries: failed attempts can try again. Exhausted jobs go to a connected Dead-letter queue; otherwise they are counted as failed." fields={{
        processingFailureShare: { label: 'Worker failure share (0–1)', value: 0, min: 0, max: 1, help: 'Sampled before downstream work. Dependency failures also trigger retries.' },
        maxAttempts: { label: 'Maximum attempts per job', value: 3, min: 1, max: 100, integer: true },
        retryDelayMs: { label: 'Wait between attempts', value: 100, min: 0, max: 86400000, unit: 'ms' },
      }} />}
      {isDataKind(node.kind) && <DataSettingsForm node={node as DataServiceNode} />}

      {node.kind !== 'client' && (
        <div className="mt-6 border-t border-line pt-5">
          <Section title="Cloud and cost">
            <CloudSection node={node} />
          </Section>
        </div>
      )}
    </div>
  );
}

/**
 * A workflow's steps are the workers it is connected to, in the order the
 * connections were drawn. Saying so here is the only way to see the order.
 */
function WorkflowSteps({ workflowId }: { workflowId: string }) {
  const document = useEditor((s) => s.project?.document);
  if (!document) return null;
  const steps = document.edges
    .filter((e) => e.source === workflowId)
    .map((e) => document.nodes.find((n) => n.id === e.target))
    .filter((n): n is ArchNode => !!n && (n.kind === 'server' || n.kind === 'serverless'));
  return (
    <div className="mb-4 mt-2">
      <p className="ap-label">Steps, in order</p>
      {steps.length === 0 ? (
        <p className="ap-hint">No steps yet. Connect this workflow to an Application Server or a Function for each step.</p>
      ) : (
        <ol className="space-y-1.5">
          {steps.map((step, i) => (
            <li key={step.id} className="flex items-center gap-2 text-[12.5px] text-ink">
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-outline text-[11px] font-bold text-surface">{i + 1}</span>
              {step.name}
            </li>
          ))}
        </ol>
      )}
      <p className="ap-hint">The order is the order the connections were drawn. To change it, delete a connection and draw it again.</p>
    </div>
  );
}

function DataSettingsForm({ node }: { node: DataServiceNode }) {
  const mutate = useEditor((s) => s.mutate);
  const definition = DATA_SERVICES[node.kind];
  return <>
    <Intro>{definition.description}</Intro>
    <p className="text-xs text-ink-3">Examples: {definition.examples}. Editable model; no vendor speed assumptions.</p>
    {Object.entries(definition.fields).map(([key, spec]) => {
      const field: NumericSetting = spec;
      return <Field key={key} label={field.label} unit={field.unit} hint={field.help}>
        {(id) => <NumberInput id={id} value={(node.settings as Record<string, number>)[key]!}
          min={field.min} max={field.max} step={field.integer ? 1 : 0.001}
          onCommit={(value) => mutate((draft) => {
            const target = draft.nodes.find((n) => n.id === node.id);
            if (target && isDataKind(target.kind)) Object.assign(target.settings, { [key]: field.integer ? Math.round(value) : value });
          })} />}
      </Field>;
    })}
  </>;
}
