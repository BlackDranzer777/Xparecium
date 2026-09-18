/**
 * Every colour is a CSS custom property so the light and dark themes stay in
 * step: a component names a role ("surface", "ink-2", "accent"), never a hue.
 * The two value sets live in src/app/styles.css.
 *
 * Deliberately no opacity modifiers on these (`bg-accent/10` would not work
 * with plain hex vars). Where a tint is needed there is an explicit `-soft`
 * colour instead, which also lets the dark theme pick a tint that actually
 * reads on a dark ground rather than a washed-out one.
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-3': 'var(--surface-3)',
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        'ink-3': 'var(--ink-3)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-soft': 'var(--accent-soft)',
        'accent-ink': 'var(--accent-ink)',
        ok: 'var(--ok)',
        'ok-soft': 'var(--ok-soft)',
        warn: 'var(--warn)',
        'warn-soft': 'var(--warn-soft)',
        bad: 'var(--bad)',
        'bad-soft': 'var(--bad-soft)',
        'kind-client': 'var(--kind-client)',
        'kind-balancer': 'var(--kind-balancer)',
        'kind-server': 'var(--kind-server)',
        'kind-database': 'var(--kind-database)',
        'kind-cache': 'var(--kind-cache)',
        'kind-queue': 'var(--kind-queue)',
        'kind-edge': 'var(--kind-edge)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        float: 'var(--shadow-float)',
        node: 'var(--shadow-node)',
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Cascadia Mono', 'Consolas', 'monospace'],
      },
      borderRadius: {
        card: '12px',
      },
    },
  },
  plugins: [],
};
