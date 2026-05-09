// api/lib/inventaire-api.ts
export const INVENTAIRE_API_BASE = 'https://inventaire.io/api';

export const getDefaultHeaders = (cookie?: string) => ({
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'InventaireMobileOverlay/1.2 (mathieu.egard@gmail.com)',
  ...(cookie ? { 'Cookie': cookie } : {}),
});