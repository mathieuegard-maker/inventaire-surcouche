// api/items/get-by-users.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { users } = req.query;
  const cookie = req.headers.cookie;

  try {
    const url = `https://inventaire.io/api/items/by-users?users=${encodeURIComponent(users as string)}&limit=1000`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.5 (mathieu.egard@gmail.com)',
        ...(cookie ? { 'Cookie': cookie } : {})
      },
    });

    const responseText = await response.text();
    let data;
    try { data = JSON.parse(responseText); } catch (e) { data = { error: responseText }; }

    return res.status(response.status).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Items Crash', details: err.message });
  }
}