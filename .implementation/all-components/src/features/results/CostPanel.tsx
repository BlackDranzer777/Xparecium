/**
 * The cost breakdown.
 *
 * Three things are non-negotiable here: an unpriced charge is shown as
 * unpriced rather than as zero, illustrative rates are labelled as such, and
 * what is excluded is listed as prominently as what is included.
 */
import type { CostEstimate } from '../../pricing/pricing';
import { Badge, Callout, Collapsible } from '../../ui/primitives';

export function CostPanel({ cost }: { cost: CostEstimate }) {
  const byComponent = new Map<string, typeof cost.lines>();
  for (const line of cost.lines) {
    const existing = byComponent.get(line.nodeId);
    if (existing) existing.push(line);
    else byComponent.set(line.nodeId, [line]);
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl bg-surface-2 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <div className="ap-eyebrow">
              Estimated monthly cost
            </div>
            <div className="mt-0.5 font-mono text-[26px] leading-none text-ink">
              {cost.pricedLineCount === 0 && cost.unpricedLineCount > 0
                ? 'Unpriced' : `${cost.currency} ${cost.totalMonthly}`}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            {cost.hasIllustrativeRates ? (
              <Badge tone="warn">Illustrative rates</Badge>
            ) : cost.lines.some((l) => l.edited && !l.unpriced) ? (
              <Badge tone="accent">Edited rates</Badge>
            ) : (
              cost.pricedLineCount > 0 && (
                <Badge tone="good" title="Every priced rate was read from the provider's own machine-readable price list">
                  Verified rates
                </Badge>
              )
            )}
            {cost.unpricedLineCount > 0 && (
              <Badge tone="bad">{cost.unpricedLineCount} unpriced</Badge>
            )}
          </div>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
          Based on a {cost.hoursPerMonth}-hour month. {cost.projectionNote}
        </p>
      </div>

      {cost.warnings.map((warning, index) => (
        <Callout key={index} tone="warn">
          {warning}
        </Callout>
      ))}

      {cost.lines.length === 0 ? (
        <p className="text-[12px] text-ink-3">
          No component has a cloud profile, so there is nothing to price.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-line text-ink-3">
                <th className="py-2.5 pr-4 font-medium">Component</th>
                <th className="py-2.5 pr-4 font-medium">Charge</th>
                <th className="py-2.5 pr-4 font-medium">Quantity</th>
                <th className="py-2.5 pr-4 font-medium">Rate</th>
                <th className="py-2.5 pr-4 text-right font-medium">Monthly</th>
              </tr>
            </thead>
            <tbody>
              {cost.lines.map((line) => (
                <tr key={line.key} className="border-b border-line align-top">
                  <td className="py-2.5 pr-4">
                    <div className="text-ink">{line.nodeName}</div>
                    <div className="mt-0.5 text-[11px] text-ink-3">{line.profileLabel}</div>
                  </td>
                  <td className="py-2.5 pr-4">
                    <div className="text-ink-2">{line.chargeLabel}</div>
                    <div className="mt-1 max-w-[26rem] text-[11px] leading-relaxed text-ink-3">{line.basis}</div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">
                    {line.quantity}
                    <div className="mt-0.5 text-[11px] text-ink-3">{line.quantityUnit}</div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-2">
                    {line.rate ?? <span className="text-ink-3">—</span>}
                    <div className="mt-0.5 text-[11px] text-ink-3">{line.rateUnit}</div>
                    {line.edited && (
                      <div className="mt-0.5">
                        <Badge tone="accent">Edited</Badge>
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-right font-mono">
                    {line.monthly ? (
                      <span className="text-ink">{line.monthly}</span>
                    ) : (
                      <span title={line.unpricedReason ?? undefined} className="text-bad">
                        unpriced
                      </span>
                    )}
                    {!line.verified && !line.unpriced && !line.edited && line.profileId && (
                      <div className="mt-0.5 text-[11px] text-warn">illustrative</div>
                    )}
                    {line.verified && !line.unpriced && (
                      <div className="mt-0.5 text-[11px] text-ink-3" title={line.sourceUrl}>
                        verified {line.sourceCheckedAt}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-2">
        <Collapsible title="What is included" defaultOpen={false}>
          <ul className="list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-ink-3">
            {cost.included.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Collapsible>
        <Collapsible title="What is excluded" defaultOpen={false}>
          <ul className="list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-ink-3">
            {cost.excluded.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Collapsible>
      </div>

      <p className="text-[11px] leading-relaxed text-ink-3">
        Catalog published {cost.catalogPublishedAt}. Cost confidence is a separate question from
        performance confidence: a cost line can be exact arithmetic on a rate that is only a
        placeholder.
      </p>
    </div>
  );
}
