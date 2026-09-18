from pathlib import Path
root=Path(__file__).parent/'all-components'
def r(file,a,b,count=1):
 p=root/file;s=p.read_text(encoding='utf-8');assert s.count(a)==count,(file,a[:80],s.count(a));p.write_text(s.replace(a,b),encoding='utf-8')
r('src/simulation/routing.ts','export interface ServerBranch {','export interface ServerBranch {\n  streamId: string | null;\n  serverStreamEdgeId: string | null;')
r('src/simulation/routing.ts','const SERVER_TARGETS: Partial<Record<ComponentKind, number>> = {','const SERVER_TARGETS: Partial<Record<ComponentKind, number>> = {\n  eventStream: 1,')
r('src/simulation/routing.ts','    serverObjectStorageEdgeId: storageEdges[0]?.id ?? null,',"    serverObjectStorageEdgeId: storageEdges[0]?.id ?? null,\n    streamId: ofKind('eventStream')[0]?.target ?? null,\n    serverStreamEdgeId: ofKind('eventStream')[0]?.id ?? null,")
r('src/simulation/routing.ts',"  const isTopic = kindOf(graph, sourceId) === 'pubsub';", "  const source = graph.nodesById.get(sourceId)!;\n  const isTopic = source.kind === 'pubsub' || source.kind === 'eventStream';")
r('src/simulation/routing.ts','  const otherEdges = out.filter((e) => !isCompute(kindOf(graph, e.target)));', '''  const deadLetters = source.kind === 'queue' ? out.filter((e) => kindOf(graph, e.target) === 'deadLetter') : [];
  if (deadLetters.length > 1) {
    issues.push({ severity: 'error', code: 'route/dlq-ambiguous', message: 'A Message Queue can send exhausted jobs to one Dead-letter queue.', nodeIds: [sourceId], edgeIds: deadLetters.map((e) => e.id) });
    return null;
  }
  const otherEdges = out.filter((e) => !isCompute(kindOf(graph, e.target)) && !deadLetters.includes(e));''')
r('src/simulation/routing.ts','  if (serverEdges.length === 0) {', '''  if (serverEdges.length === 0 && (source.kind === 'eventStream' || (source.kind === 'deadLetter' && !source.settings.replayEnabled))) return [];
  if (serverEdges.length === 0) {''')
r('src/simulation/routing.ts','for (const next of [branch.queueId, branch.pubsubId])', 'for (const next of [branch.queueId, branch.pubsubId, branch.streamId])')
r('src/simulation/routing.ts',"        if (kind === 'queue' || kind === 'pubsub') stack.push(next.target);", "        if (kind === 'queue' || kind === 'pubsub' || kind === 'eventStream') stack.push(next.target);")
r('src/simulation/routing.ts','    for (const consumer of graph.outgoing.get(current) ?? []) {','    for (const consumer of graph.outgoing.get(current) ?? []) {\n      if (kindOf(graph, consumer.target) === \'deadLetter\') stack.push(consumer.target);')
r('src/simulation/routing.ts','  if (clients.length === 0) {',"  if (clients.length === 0 && !doc.nodes.some((n) => n.kind === 'scheduler')) {")
r('src/simulation/routing.ts','  // ---- Balancers nobody sends to', '''  // Scheduled work has its own source and totals; it invokes one compute node.
  for (const scheduler of doc.nodes.filter((n) => n.kind === 'scheduler')) {
    const out = graph.outgoing.get(scheduler.id) ?? [];
    const first = out[0];
    if (out.length !== 1 || !first || !isCompute(kindOf(graph, first.target))) {
      issues.push({ severity: 'error', code: 'route/scheduler-target', message: `"${scheduler.name}" needs one connection to an Application Server or Function.`, nodeIds: [scheduler.id], edgeIds: out.map((e) => e.id) });
      continue;
    }
    const branch = resolveServerBranch(graph, first.target, first.id, issues);
    if (branch) routes.push({ clientId: scheduler.id, loadBalancerId: null, clientEdgeId: first.id,
      edgeChain: [], entryEdgeId: first.id, dnsId: null, dnsEdgeId: null, branches: [branch] });
  }
  for (const node of doc.nodes.filter((n) => n.kind === 'deadLetter')) {
    const bad = (graph.incoming.get(node.id) ?? []).filter((e) => kindOf(graph, e.source) !== 'queue');
    if (bad.length) issues.push({ severity: 'error', code: 'route/dlq-source', message: 'A Dead-letter queue receives exhausted jobs from a Message Queue.', nodeIds: [node.id], edgeIds: bad.map((e) => e.id) });
  }

  // ---- Balancers nobody sends to''')
r('src/simulation/routing.ts',"if (node.kind !== 'queue' && node.kind !== 'pubsub') continue;", "if (node.kind !== 'queue' && node.kind !== 'pubsub' && node.kind !== 'eventStream' && node.kind !== 'deadLetter') continue;")
