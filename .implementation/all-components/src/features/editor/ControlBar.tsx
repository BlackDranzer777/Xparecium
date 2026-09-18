/**
 * The floating control bar along the bottom of the canvas.
 *
 * It carries the four things you touch on every loop — start and stop the
 * simulation, how long, and which seed — plus a live read-out of the offered
 * load and a chip that opens the validation problems. Everything else lives in
 * the settings panel.
 */
import { useMemo, useState } from 'react';
import { formatNumber, formatRate } from '../../domain/units';
import { clientRequestRate, meanArrivalMultiplier } from '../../simulation/engine';
import type { ValidationIssue } from '../../simulation/routing';
import type { Workload } from '../../domain/types';
import { PlayIcon, StopIcon, WarningIcon, WaveIcon } from '../../ui/icons';
import { Callout, Field, NumberInput, Popover, SegmentedControl } from '../../ui/primitives';
import { analyseDocument, useEditor } from './store';

function InlineField({
  label,
  children,
}: {
  label: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = `control-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <label htmlFor={id} className="flex items-center gap-2">
      <span className="whitespace-nowrap text-[11.5px] text-ink-3">{label}</span>
      {children(id)}
    </label>
  );
}

function IssueList({ issues }: { issues: ValidationIssue[] }) {
  return (
    <ul className="max-h-[42vh] space-y-2 overflow-auto p-3">
      {issues.map((issue, index) => (
        <li
          key={`${issue.code}-${index}`}
          className={`rounded-lg px-3 py-2.5 text-[12px] leading-relaxed ${
            issue.severity === 'error' ? 'bg-bad-soft' : 'bg-warn-soft'
          }`}
        >
          <span
            className={`mr-1.5 font-semibold ${issue.severity === 'error' ? 'text-bad' : 'text-warn'}`}
          >
            {issue.severity === 'error' ? 'Cannot run:' : 'Note:'}
          </span>
          <span className="text-ink-2">{issue.message}</span>
          {issue.hint && <span className="mt-1.5 block text-ink-3">{issue.hint}</span>}
        </li>
      ))}
    </ul>
  );
}

const ARRIVAL_LABELS: Record<Workload['arrivalPattern'], string> = {
  constant: 'Steady',
  poisson: 'Random',
  ramp: 'Ramp',
  burst: 'Bursty',
};

const ARRIVAL_NOTES: Record<Workload['arrivalPattern'], string> = {
  constant: 'Evenly spaced. The same every run for the same seed.',
  poisson:
    'Independent arrivals: the same rate on average, but the spacing varies. This is the only pattern that draws random numbers, so two runs with different seeds will differ.',
  ramp: 'The rate moves steadily from the first multiple to the second across the run.',
  burst: 'A raised rate for part of every period, and the configured rate otherwise.',
};

function ArrivalPatternForm({
  workload,
  onChange,
  closedLoop,
}: {
  workload: Workload;
  onChange: (patch: Partial<Workload>) => void;
  closedLoop: boolean;
}) {
  const options = workload.arrivalOptions;
  const setOption = (patch: Partial<Workload['arrivalOptions']>) =>
    onChange({ arrivalOptions: { ...options, ...patch } });

  return (
    <>
      <h3 className="ap-eyebrow mb-2.5">Traffic shape</h3>
      <div className="mb-3">
        <SegmentedControl
          label="Arrival pattern"
          value={workload.arrivalPattern}
          onChange={(arrivalPattern) => onChange({ arrivalPattern })}
          options={(['constant', 'poisson', 'ramp', 'burst'] as const).map((value) => ({
            value,
            label: ARRIVAL_LABELS[value],
          }))}
        />
      </div>

      {workload.arrivalPattern === 'ramp' && (
        <>
          <Field label="Starts at" unit="× the rate">
            {(id) => (
              <NumberInput
                id={id}
                value={options.rampStartMultiplier}
                min={0.01}
                step={0.1}
                onCommit={(v) => setOption({ rampStartMultiplier: v })}
              />
            )}
          </Field>
          <Field label="Ends at" unit="× the rate">
            {(id) => (
              <NumberInput
                id={id}
                value={options.rampEndMultiplier}
                min={0.01}
                step={0.1}
                onCommit={(v) => setOption({ rampEndMultiplier: v })}
              />
            )}
          </Field>
        </>
      )}

      {workload.arrivalPattern === 'burst' && (
        <>
          <Field label="Every" unit="seconds">
            {(id) => (
              <NumberInput
                id={id}
                value={options.burstPeriodSeconds}
                min={0.001}
                step={1}
                onCommit={(v) => setOption({ burstPeriodSeconds: v })}
              />
            )}
          </Field>
          <Field label="Lasting" unit="seconds">
            {(id) => (
              <NumberInput
                id={id}
                value={options.burstDurationSeconds}
                min={0}
                step={0.5}
                onCommit={(v) => setOption({ burstDurationSeconds: v })}
              />
            )}
          </Field>
          <Field label="At" unit="× the rate">
            {(id) => (
              <NumberInput
                id={id}
                value={options.burstMultiplier}
                min={0.01}
                step={1}
                onCommit={(v) => setOption({ burstMultiplier: v })}
              />
            )}
          </Field>
        </>
      )}

      <Callout tone="accent" title={ARRIVAL_LABELS[workload.arrivalPattern]}>
        {ARRIVAL_NOTES[workload.arrivalPattern]}
        {workload.arrivalPattern !== 'constant' && (
          <>
            <br />
            Average across the run:{' '}
            <span className="font-mono text-ink">
              {formatNumber(meanArrivalMultiplier(workload), 2)}×
            </span>{' '}
            the configured rate.
          </>
        )}
        {closedLoop && (
          <>
            <br />
            Some of your users wait for their own answers, and set their own pace. This shape
            applies only to clients sending at a steady rate.
          </>
        )}
      </Callout>
    </>
  );
}

export function ControlBar() {
  const document = useEditor((s) => s.project?.document ?? null);
  const setWorkload = useEditor((s) => s.setWorkload);
  const select = useEditor((s) => s.select);
  const run = useEditor((s) => s.run);
  const stopSimulation = useEditor((s) => s.stopSimulation);
  const running = useEditor((s) => s.running);
  const live = useEditor((s) => s.live);
  const hasResult = useEditor((s) => s.latestRun !== null);
  const continuous = useEditor((s) => s.continuous);
  const setContinuous = useEditor((s) => s.setContinuous);
  const progress = useEditor((s) => s.progress);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [trafficOpen, setTrafficOpen] = useState(false);

  const routing = useMemo(() => analyseDocument(document), [document]);
  const errors = routing?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = routing?.issues.filter((i) => i.severity === 'warning') ?? [];

  const offered = useMemo(() => {
    if (!document || !routing) {
      return { rate: 0, clientId: null as string | null, anyClosed: false };
    }
    let rate = 0;
    let clientId: string | null = null;
    let anyClosed = false;
    for (const route of routing.routes) {
      const client = document.nodes.find((n) => n.id === route.clientId);
      if (client && client.kind === 'client') {
        rate += clientRequestRate(client);
        if (client.settings.mode === 'closed') anyClosed = true;
        clientId ??= client.id;
      }
    }
    return { rate, clientId, anyClosed };
  }, [document, routing]);

  if (!document) return null;
  const workload = document.workload;
  const expected = Math.round(
    offered.rate * workload.durationSeconds * meanArrivalMultiplier(workload),
  );
  const shaped = workload.arrivalPattern !== 'constant';
  const percent = Math.round((progress?.fraction ?? 0) * 100);

  return (
    <div className="ap-card relative overflow-hidden px-2 py-2 shadow-float">
      {running && !continuous && (
        <div
          className="absolute inset-x-0 top-0 h-[2px] bg-accent transition-[width] duration-150"
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Simulation progress"
        />
      )}

      <div className="flex items-center gap-2">
        <select aria-label="Simulation mode" className="ap-input w-[82px] text-[12px]"
          value={continuous ? 'live' : 'timed'} onChange={e => setContinuous(e.target.value === 'live')}>
          <option value="live">Live</option><option value="timed">Timed</option>
        </select>
        {/* One button for one state: the simulation is either running or it is
            not. It offers to stop only once there is something running to stop
            — on a canvas that has never been run, "Stop" would be a button for
            nothing. Stopping also cancels a run still in flight. */}
        {running || (live && hasResult && !continuous) ? (
          <button
            type="button"
            className="ap-btn-primary h-9 px-4"
            onClick={stopSimulation}
            title={running ? 'Stop processing. The last results stay on screen.' : 'Stop recalculating after edits.'}
          >
            <StopIcon size={12} />
            {running ? 'Stop simulation' : 'Stop updates'}
          </button>
        ) : (
          <button
            type="button"
            className="ap-btn-primary h-9 px-4"
            onClick={() => void run()}
            disabled={errors.length > 0}
            title={
              errors.length > 0
                ? 'Fix the problems on the canvas first'
                : 'Start the simulation. It keeps running and follows your changes (Ctrl+Enter)'
            }
          >
            <PlayIcon size={12} />
            Run simulation
          </button>
        )}

        <div className="mx-1 h-6 w-px bg-line" aria-hidden />

        <button
          type="button"
          onClick={() => {
            if (offered.clientId) select({ type: 'node', id: offered.clientId });
          }}
          disabled={!offered.clientId}
          title={
            offered.clientId
              ? 'Open the client settings to change the traffic'
              : 'No client is connected'
          }
          className="rounded-lg px-2.5 py-1 text-left transition-colors hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span className="block font-mono text-[13px] leading-tight text-ink">
            {offered.anyClosed ? `up to ${formatRate(offered.rate)}` : formatRate(offered.rate)}
          </span>
          <span className="block text-[10.5px] leading-tight text-ink-3">
            {offered.anyClosed
              ? 'users wait for their answers'
              : continuous ? 'offered · continuous' : `offered · ~${formatNumber(expected)} requests`}
          </span>
        </button>

        <div className="mx-1 h-6 w-px bg-line" aria-hidden />

        {(!continuous || workload.arrivalPattern === 'ramp') && <InlineField label={continuous ? "Ramp" : "For"}>
          {(id) => (
            <div className="w-[74px]">
              <NumberInput
                id={id}
                ariaLabel="Run duration in seconds"
                value={workload.durationSeconds}
                min={0.001}
                max={86_400}
                step={5}
                suffix="s"
                onCommit={(v) => setWorkload({ durationSeconds: v })}
              />
            </div>
          )}
        </InlineField>}

        {!continuous && <InlineField label="Drain">
          {(id) => (
            <div className="w-[74px]">
              <NumberInput
                id={id}
                ariaLabel="Drain time in seconds"
                value={workload.drainSeconds}
                min={0}
                max={86_400}
                step={5}
                suffix="s"
                onCommit={(v) => setWorkload({ drainSeconds: v })}
              />
            </div>
          )}
        </InlineField>}

        <InlineField label="Seed">
          {(id) => (
            <div className="w-[86px]">
              <NumberInput
                id={id}
                ariaLabel="Random seed"
                value={workload.seed}
                min={0}
                max={4_294_967_295}
                step={1}
                onCommit={(v) => setWorkload({ seed: Math.round(v) })}
              />
            </div>
          )}
        </InlineField>

        <div className="mx-1 h-6 w-px bg-line" aria-hidden />

        {/* Traffic shape lives behind a button rather than in the bar: three of
            the four patterns need numbers of their own, and the bar is the one
            piece of interface that has to stay readable at a glance. */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setTrafficOpen((v) => !v)}
            aria-expanded={trafficOpen}
            title="How the traffic is spread across the run"
            className={`ap-btn h-9 gap-1.5 px-2.5 ${
              shaped ? 'bg-accent-soft text-accent-ink' : 'border border-line text-ink-3'
            }`}
          >
            <WaveIcon size={14} />
            {ARRIVAL_LABELS[workload.arrivalPattern]}
          </button>
          <Popover
            open={trafficOpen}
            onClose={() => setTrafficOpen(false)}
            placement="above"
            className="w-[320px]"
          >
            <div className="p-3">
              <ArrivalPatternForm
                workload={workload}
                onChange={setWorkload}
                closedLoop={offered.anyClosed}
              />
            </div>
          </Popover>
        </div>

        {(errors.length > 0 || warnings.length > 0) && (
          <>
            <div className="mx-1 h-6 w-px bg-line" aria-hidden />
            <div className="relative">
              <button
                type="button"
                onClick={() => setIssuesOpen((v) => !v)}
                aria-expanded={issuesOpen}
                className={`ap-btn h-9 gap-1.5 px-2.5 ${
                  errors.length > 0
                    ? 'bg-bad-soft text-bad hover:bg-bad-soft'
                    : 'bg-warn-soft text-warn hover:bg-warn-soft'
                }`}
              >
                <WarningIcon size={14} />
                {errors.length > 0
                  ? `${errors.length} problem${errors.length === 1 ? '' : 's'}`
                  : `${warnings.length} note${warnings.length === 1 ? '' : 's'}`}
              </button>
              <Popover
                open={issuesOpen}
                onClose={() => setIssuesOpen(false)}
                align="right"
                placement="above"
                className="w-[380px]"
              >
                <IssueList issues={[...errors, ...warnings]} />
              </Popover>
            </div>
          </>
        )}

        {running && !continuous && (
          <span className="ml-1 font-mono text-[11px] text-ink-3">
            {formatNumber((progress?.simulatedMs ?? 0) / 1000, 1)} s ·{' '}
            {formatNumber(progress?.completed ?? 0)} done
          </span>
        )}
      </div>
    </div>
  );
}
