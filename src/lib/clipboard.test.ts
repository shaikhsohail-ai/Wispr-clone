import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

function fakeDocument(execCommand: () => boolean) {
  const area = { value: '', setAttribute() {}, style: {} as Record<string, string>, select() {}, remove() {} };
  return {
    createElement: () => area,
    body: { appendChild() {} },
    execCommand,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyText', () => {
  it('uses the async clipboard API when it works', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal(
      'document',
      fakeDocument(() => false),
    );
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when writeText is refused', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw Object.assign(new Error('no gesture'), { name: 'NotAllowedError' });
        },
      },
    });
    vi.stubGlobal(
      'document',
      fakeDocument(() => true),
    );
    await expect(copyText('hello')).resolves.toBe(true);
  });

  it('reports failure when neither path can copy, so the caller can offer a Copy button', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw Object.assign(new Error('no gesture'), { name: 'NotAllowedError' });
        },
      },
    });
    vi.stubGlobal(
      'document',
      fakeDocument(() => false),
    );
    await expect(copyText('hello')).resolves.toBe(false);
  });
});
