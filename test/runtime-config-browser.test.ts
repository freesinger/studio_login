import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/runtime-config.js', import.meta.url), 'utf8').replace(/\bexport /g, '');
const config = { currency: 'USD', timeZone: 'America/Los_Angeles', defaultPrices: { customerUnitPrice: '0.125', costUnitPrice: '0.0625' } };
function load(value: unknown, status = 200) {
  const showError = vi.fn();
  const result = runInNewContext(`(async () => { ${source}; return runtimeConfig; })()`, {
    AbortSignal,
    fetch: async () => new Response(JSON.stringify(value), { status }),
    document: { querySelector: () => ({ classList: { remove: showError } }) },
  }) as Promise<typeof config>;
  return { result, showError };
}
describe('browser deployment config', () => {
  it('uses the server currency and zone without guessing from browser locale', async () => {
    const { result, showError } = load(config);
    expect(await result).toEqual(config);
    expect(showError).not.toHaveBeenCalled();
  });
  it.each([null, {}, { ...config, currency: 'EUR' }, { ...config, timeZone: 'bad-zone' }, { ...config, defaultPrices: {} }])('fails closed for malformed config %j', async value => {
    const { result, showError } = load(value);
    await expect(result).rejects.toThrow();
    expect(showError).toHaveBeenCalledWith('hidden');
  });
  it('does not substitute CNY when config is unavailable', async () => {
    const { result, showError } = load(config, 503);
    await expect(result).rejects.toThrow('Runtime configuration unavailable');
    expect(showError).toHaveBeenCalledWith('hidden');
  });
});
