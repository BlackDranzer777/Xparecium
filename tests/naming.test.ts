import { describe, expect, it } from 'vitest';
import {
  COMPONENT_LABELS,
  TEMPLATES,
  buildTemplate,
  normaliseComponentNames,
} from '../src/domain/defaults';
import type { ArchitectureDocument, ComponentKind } from '../src/domain/types';

/**
 * One component, one name.
 *
 * The starter templates used to seed a server called "App server" while its
 * type was "Application Server", so the same component answered to two names
 * depending on where you read it. These tests hold the product to one.
 */

function documentWith(names: { kind: ComponentKind; name: string }[]): ArchitectureDocument {
  const base = buildTemplate('starter');
  return {
    ...base,
    nodes: names.map((entry, index) => ({
      ...base.nodes.find((node) => node.kind === entry.kind)!,
      id: `n_${index}`,
      name: entry.name,
    })),
    edges: [],
  };
}

describe('component naming', () => {
  it('no template uses a second name for the application server', () => {
    for (const template of TEMPLATES) {
      const document = buildTemplate(template.id);
      for (const node of document.nodes) {
        expect(node.name).not.toMatch(/app server/i);
      }
      expect(template.summary).not.toMatch(/\bapp servers?\b/i);
    }
  });

  it('template servers are named after the type they are', () => {
    const starter = buildTemplate('starter');
    const server = starter.nodes.find((node) => node.kind === 'server');
    expect(server?.name).toBe(COMPONENT_LABELS.server);

    const pool = buildTemplate('load-balanced')
      .nodes.filter((node) => node.kind === 'server')
      .map((node) => node.name);
    expect(pool).toEqual([
      `${COMPONENT_LABELS.server} 1`,
      `${COMPONENT_LABELS.server} 2`,
      `${COMPONENT_LABELS.server} 3`,
      `${COMPONENT_LABELS.server} 4`,
    ]);
  });

  it('translates the old default name in a document that was saved with it', () => {
    const document = documentWith([
      { kind: 'server', name: 'App server' },
      { kind: 'server', name: 'App server 2' },
    ]);
    const names = normaliseComponentNames(document).nodes.map((node) => node.name);
    expect(names).toEqual([COMPONENT_LABELS.server, `${COMPONENT_LABELS.server} 2`]);
  });

  it('does not rename a component onto a name the board already uses', () => {
    const document = documentWith([
      { kind: 'server', name: 'App server' },
      { kind: 'server', name: COMPONENT_LABELS.server },
    ]);
    const names = normaliseComponentNames(document).nodes.map((node) => node.name);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain(COMPONENT_LABELS.server);
    expect(names).toContain(`${COMPONENT_LABELS.server} 2`);
  });

  it('leaves a name someone chose themselves alone', () => {
    const document = documentWith([
      { kind: 'server', name: 'App servers, plural' },
      { kind: 'server', name: 'Checkout API' },
      { kind: 'database', name: 'App server' },
    ]);
    const names = normaliseComponentNames(document).nodes.map((node) => node.name);
    expect(names).toEqual(['App servers, plural', 'Checkout API', 'App server']);
  });

  it('returns the document untouched when there is nothing to translate', () => {
    const document = buildTemplate('starter');
    expect(normaliseComponentNames(document)).toBe(document);
  });
});
