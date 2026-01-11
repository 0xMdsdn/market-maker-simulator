// FILE 2: api/get-data.js
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const { id, list } = req.query;

  try {
    if (list === 'true') {
      // Return list of all simulations
      const simList = await kv.get('simulation-list') || [];
      return res.status(200).json({ simulations: simList });
    }

    if (id) {
      // Return specific simulation
      const data = await kv.get(id);
      if (!data) {
        return res.status(404).json({ error: 'Simulation not found' });
      }
      return res.status(200).json(data);
    }

    res.status(400).json({ error: 'Missing parameters' });
  } catch (error) {
    console.error('Error getting data:', error);
    res.status(500).json({ error: 'Failed to get data' });
  }
}
