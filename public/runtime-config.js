// Deployment properties are server-owned and independent of the UI language.
async function loadRuntimeConfig() {
  const response = await fetch('/api/runtime-config', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Runtime configuration unavailable');
  const config = await response.json();
  if (!['CNY', 'USD'].includes(config.currency) || typeof config.timeZone !== 'string'
      || !config.timeZone || !config.defaultPrices
      || !['customerUnitPrice', 'costUnitPrice'].every(key =>
        typeof config.defaultPrices[key] === 'string' && /^\d{1,10}(?:\.\d{1,10})?$/.test(config.defaultPrices[key]))) {
    throw new Error('Invalid runtime configuration');
  }
  new Intl.DateTimeFormat('en', { timeZone: config.timeZone }).format();
  return config;
}
export const runtimeConfig = await loadRuntimeConfig().catch(error => {
  // Do not silently guess a currency when the server config cannot be loaded.
  document.querySelector('#login-load-error').classList.remove('hidden');
  throw error;
});
