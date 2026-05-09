// api/user/get.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cookie = req.headers.cookie;
  if (!cookie) return res.status(401).json({ error: 'Session absente (no cookie)' });

  try {
    const response = await fetch('https://inventaire.io/api/user', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.5 (mathieu.egard@gmail.com)',
        'Cookie': cookie
      },
    });

    const responseText = await response.text();
    let data;
    try { data = JSON.parse(responseText); } catch (e) { data = { error: responseText }; }

    return res.status(response.status).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy User Crash', details: err.message });
  }
}