import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

// Exercise the real component's event handlers without a DOM or provider calls.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as Array<{ current: unknown }>, stateIndex: 0, refIndex: 0 }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  const replacements = {
    useState: (initial: unknown) => {
      const i = hooks.stateIndex++;
      if (!(i in hooks.states)) hooks.states[i] = typeof initial === 'function' ? initial() : initial;
      return [hooks.states[i], (value: unknown) => { hooks.states[i] = typeof value === 'function' ? value(hooks.states[i]) : value; }];
    },
    useRef: (initial: unknown) => hooks.refs[hooks.refIndex++] ?? (hooks.refs[hooks.refIndex - 1] = { current: initial }),
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
    useEffect: () => {},
  };
  return { ...actual, ...replacements, default: { ...actual, ...replacements } };
});
vi.mock('@/components/ui', () => ({ Button: 'button', ModalFrame: 'dialog', ModalTitle: 'h3' }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn() }) }));

import { MultiVoiceCharacterModal } from '@/components/doclist/MultiVoiceCharacterModal';
import { acknowledgeGeminiPreviewQuota, hasAcknowledgedGeminiPreviewQuota, GEMINI_VOICE_AUDITION_URL } from '@/lib/client/gemini-preview-consent';

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'props' in value) return text((value as Node).props.children);
  return typeof value === 'string' ? value : '';
}
const render = (workerMode: 'drama-gemini-tts' | 'multi-voice' = 'drama-gemini-tts') => {
  hooks.stateIndex = hooks.refIndex = 0;
  return nodes(MultiVoiceCharacterModal({ documentId: 'doc', profileId: 'profile', isOpen: true, workerMode, onClose: vi.fn(), onComplete: vi.fn() }));
};
const button = (tree: Node[], label: string) => tree.find(n => n.type === 'button' && text(n.props.children) === label)!;
const click = async (node: Node) => { await (node.props.onClick as () => Promise<void> | void)(); };

beforeEach(() => {
  hooks.states = [];
  hooks.refs = [];
  hooks.states[0] = { schemaVersion: 1, status: 'complete', profileId: 'profile', entries: {
    Narrator: { name: 'Narrator', description: 'Narrates', sampleText: 'Hello', importance: 'main', voiceId: 'Kore' },
  } };
  hooks.states[2] = ['Kore', 'Puck'].map(id => ({ id, displayName: id, gender: 'unknown', pitch: 'unknown', type: 'prebuilt', model: null }));
  const values = new Map<string, string>();
  vi.stubGlobal('window', { sessionStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'fixture stops before audio' }) }));
});

describe('Gemini voice previews require an explicit quota decision', () => {
  it('changing the assigned voice and requesting another recommendation never synthesize', async () => {
    let tree = render();
    await click(button(tree, 'Recommend another'));
    expect(fetch).not.toHaveBeenCalled();
    const select = tree.find(n => n.type === 'select' && nodes(n.props.children).some(c => text(c.props.children) === 'Select a Gemini voice'))!;
    (select.props.onChange as (event: unknown) => void)({ target: { value: 'Puck' } });
    tree = render();
    expect(fetch).not.toHaveBeenCalled();
    expect(tree.find(n => n.type === 'dialog')?.props.open).toBe(false);
  });
  it('blocks the first play, cancellation spends nothing, and confirmation permits one request', async () => {
    await click(button(render(), '▶'));
    const tree = render();
    expect(tree.find(n => n.type === 'dialog')?.props.open).toBe(true);
    expect(text(tree[0])).toContain('1 of those 10 uses');
    expect(tree.some(n => n.type === 'a' && n.props.href === GEMINI_VOICE_AUDITION_URL)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    await click(button(tree, 'Cancel'));
    expect(hasAcknowledgedGeminiPreviewQuota()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await click(button(render(), '▶'));
    await click(button(render(), 'Play preview using API quota'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(hasAcknowledgedGeminiPreviewQuota()).toBe(true);
    expect(render().find(n => n.type === 'dialog')?.props.open).toBe(false);
  });
  it('remembered consent permits later explicit previews, never automatic assignment playback', async () => {
    acknowledgeGeminiPreviewQuota();
    await click(button(render(), '▶'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(render().find(n => n.type === 'dialog')?.props.open).toBe(false);
  });
  it('does not show a Gemini quota warning for Kokoro previews', async () => {
    await click(button(render('multi-voice'), '▶'));
    expect(fetch).toHaveBeenCalledWith('/api/tts/preview', expect.anything());
    expect(render('multi-voice').find(n => n.type === 'dialog')?.props.open).toBe(false);
  });
  it('fails closed when session storage is unavailable', () => {
    vi.stubGlobal('window', { get sessionStorage() { throw new Error('blocked'); } });
    expect(hasAcknowledgedGeminiPreviewQuota()).toBe(false);
    expect(() => acknowledgeGeminiPreviewQuota()).not.toThrow();
  });
});
