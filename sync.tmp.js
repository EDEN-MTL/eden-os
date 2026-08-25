require('dotenv').config();
const { getGhlConfig } = require('./dist/shared/ghl');
const { syncGhl } = require('./dist/agents/forge/ads/sync');
(async () => {
  for (const clientId of ['matama-floors', '3-percent-east-coast']) {
    const cfg = await getGhlConfig(clientId);
    console.log('\n--- ' + clientId + ' ---');
    const n = await syncGhl(cfg.locationId, clientId, cfg.attributionPipelineName, cfg.apiKey);
    console.log('  imported:', n);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
