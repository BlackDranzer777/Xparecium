/** Short, collision-resistant ids for projects, nodes, edges and runs. */
export function newId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14).padEnd(12, '0');
  return `${prefix}_${rand}`;
}

export function edgeId(source: string, target: string): string {
  return `e_${source}__${target}`;
}
