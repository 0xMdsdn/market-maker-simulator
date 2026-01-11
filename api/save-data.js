// FILE 1: api/save-data.js
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const simulationData = req.body;
    const id = simulationData.id || `sim-${Date.now()}`;
    
    // Save the simulation data
    await kv.set(id, simulationData);
    
    // Add to list of simulations
    const simList = await kv.get('simulation-list') || [];
    if (!simList.find(s => s.id === id)) {
      simList.push({
        id,
        asset: simulationData.asset,
        timestamp: simulationData.timestamp
      });
      await kv.set('simulation-list', simList);
    }
    
    res.status(200).json({ success: true, id });
  } catch (error) {
    console.error('Error saving data:', error);
    res.status(500).json({ error: 'Failed to save data' });
  }
}
