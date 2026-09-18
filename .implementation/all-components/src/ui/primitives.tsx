/**
 * Shared interface pieces.
 *
 * Three rules run through all of these: every numeric control states its unit,
 * every control has a real label tied to its input, and colour is a role
 * ("accent", "bad") rather than a hue, so both themes work without any
 * component knowing which is active.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';
import { ChevronDownIcon } from './icons';

/* ---- Layout ------------------------------------------------------------ */

export function CardHeader({
  title,
  actions,
}: {
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
      <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
      {actions && <div className="flex items-center gap-0.5">{actions}</div>}
    </header>
  );
}

export function Section({
  title,
  children,
  className = '',
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      {title && <h3 className="ap-eyebrow mb-2.5">{title}</h3>}
      {children}
    </section>
  );
}

export function Collapsible({
  title,
  defaultOpen = false,
  children,
  badge,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  badge?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <span className="text-[12px] font-medium text-ink-2">{title}</span>
        <span className="flex items-center gap-2">
          {badge}
          <ChevronDownIcon
            size={14}
            className={`text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </button>
      {open && <div className="border-t border-line px-3 py-3">{children}</div>}
    </div>
  );
}

/** Tabs that look like one control. Used for the right card and the results. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            title={option.title ?? undefined}
            onClick={() => onChange(option.value)}
            className={`rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors ${
              selected
                ? 'bg-surface text-ink shadow-card'
                : 'text-ink-2 hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A small anchored panel that closes on outside click or Escape. */
/**
 * A panel anchored to whatever wraps it, rendered into the document body.
 *
 * The portal is not decoration. A popover positioned inside its trigger is at
 * the mercy of every ancestor's `overflow`, and the control bar has two of them:
 * `overflow-hidden` on the card itself, which keeps the progress bar inside its
 * rounded corners, and `overflow-x-auto` on the wrapper that lets a narrow
 * window scroll the bar sideways. Between them the problems popover was clipped
 * out of existence — it was in the DOM, and nobody could see it. There is no CSS
 * that opts out of an ancestor's clipping, so the panel has to leave the subtree
 * entirely and be positioned against the anchor by hand.
 *
 * The anchor is the element that contains this component, which is the trigger's
 * own wrapper at every call site.
 */
export function Popover({
  open,
  onClose,
  children,
  align = 'left',
  placement = 'below',
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'left' | 'right';
  /** Which side of the anchor to open on. */
  placement?: 'above' | 'below';
  className?: string;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useEffect(() => {
    if (!open) return;

    const place = () => {
      const anchor = marker.current?.parentElement;
      if (!anchor) return;
      const box = anchor.getBoundingClientRect();
      const gap = 8;
      setStyle({
        position: 'fixed',
        ...(placement === 'above'
          ? { bottom: window.innerHeight - box.top + gap }
          : { top: box.bottom + gap }),
        ...(align === 'right'
          ? { right: Math.max(gap, window.innerWidth - box.right) }
          : { left: Math.max(gap, box.left) }),
        maxHeight: placement === 'above' ? box.top - gap * 2 : window.innerHeight - box.bottom - gap * 2,
      });
    };

    place();
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    // Capture phase, so a click on a trigger elsewhere still closes this first.
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, onClose, align, placement]);

  // The marker stays in the tree so the anchor can be found; it draws nothing.
  return (
    <>
      <span ref={marker} className="hidden" aria-hidden />
      {open &&
        style &&
        createPortal(
          <div
            ref={ref}
            style={style}
            className={`ap-card z-50 overflow-auto shadow-float ${className}`}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

/* ---- Form controls ----------------------------------------------------- */

export function Field({
  label,
  unit,
  hint,
  children,
}: {
  label: string;
  unit?: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="mb-4">
      <label htmlFor={id} className="ap-label">
        {label}
        {unit && <span className="ml-1 font-normal text-ink-3">({unit})</span>}
      </label>
      {children(id)}
      {hint && <p className="ap-hint">{hint}</p>}
    </div>
  );
}

/**
 * A number input that lets you type freely — an empty box, a trailing decimal
 * point — and only commits a valid number to the model, on blur or Enter.
 */
export function NumberInput({
  id,
  value,
  onCommit,
  min,
  max,
  step,
  disabled,
  suffix,
  ariaLabel,
}: {
  id?: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  suffix?: string;
  /** Overrides the visible label where that label is deliberately terse. */
  ariaLabel?: string;
}) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  useEffect(
    () => () => {
      if (liveTimer.current) clearTimeout(liveTimer.current);
    },
    [],
  );

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    let next = parsed;
    if (min !== undefined && next < min) next = min;
    if (max !== undefined && next > max) next = max;
    setText(String(next));
    if (next !== value) onCommit(next);
  };

  const extra: Record<string, unknown> = {};
  if (min !== undefined) extra.min = min;
  if (max !== undefined) extra.max = max;
  if (step !== undefined) extra.step = step;
  if (ariaLabel !== undefined) extra['aria-label'] = ariaLabel;

  const input = (
    <input
      id={id}
      type="number"
      className={`ap-input font-mono ${suffix ? 'pr-12' : ''}`}
      value={text}
      disabled={disabled}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        // Commit as you type, so the rest of the app can react without waiting
        // for the field to lose focus. Only values that are already complete
        // and in range are sent: half-typed input like "" or "1." would
        // otherwise be clamped to the minimum and fight the person typing.
        if (liveTimer.current) clearTimeout(liveTimer.current);
        const parsed = Number(raw);
        const inProgress = raw.trim() === '' || raw.endsWith('.') || raw.endsWith('-');
        const inRange =
          (min === undefined || parsed >= min) && (max === undefined || parsed <= max);
        if (!inProgress && Number.isFinite(parsed) && inRange && parsed !== value) {
          liveTimer.current = setTimeout(() => onCommit(parsed), 300);
        }
      }}
      onBlur={(e) => {
        focused.current = false;
        if (liveTimer.current) clearTimeout(liveTimer.current);
        commit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      {...extra}
    />
  );

  if (!suffix) return input;
  return (
    <div className="relative">
      {input}
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-ink-3">
        {suffix}
      </span>
    </div>
  );
}

export function Toggle({
  id,
  checked,
  onChange,
  label,
}: {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-line-strong bg-surface accent-accent"
      />
      {label}
    </label>
  );
}

/* ---- Display ----------------------------------------------------------- */

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  good: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  accent: 'bg-accent-soft text-accent-ink',
};

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`ap-tag ${BADGE_TONES[tone]}`} title={title}>
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: Tone;
}) {
  const valueTone =
    tone === 'bad'
      ? 'text-bad'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'good'
          ? 'text-ok'
          : 'text-ink';
  return (
    <div className="rounded-lg border border-line px-3.5 py-3">
      <div className="ap-eyebrow">{label}</div>
      <div className={`mt-1.5 font-mono text-[19px] leading-none ${valueTone}`}>
        {value}
        {unit && <span className="ml-1 text-[11px] font-sans text-ink-3">{unit}</span>}
      </div>
      {hint && <div className="mt-2 text-[11px] leading-relaxed text-ink-3">{hint}</div>}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 py-12 text-center">
      <p className="text-[13px] font-medium text-ink-2">{title}</p>
      {children && (
        <div className="max-w-xs text-[12px] leading-relaxed text-ink-3">{children}</div>
      )}
    </div>
  );
}

const CALLOUT_TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  good: 'bg-ok-soft text-ink-2',
  warn: 'bg-warn-soft text-ink-2',
  bad: 'bg-bad-soft text-ink-2',
  accent: 'bg-accent-soft text-ink-2',
};

const CALLOUT_TITLES: Record<Tone, string> = {
  neutral: 'text-ink',
  good: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  accent: 'text-accent-ink',
};

export function Callout({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone;
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-lg px-3 py-2.5 text-[12px] leading-relaxed ${CALLOUT_TONES[tone]}`}>
      {title && <div className={`mb-1 font-semibold ${CALLOUT_TITLES[tone]}`}>{title}</div>}
      <div>{children}</div>
    </div>
  );
}
