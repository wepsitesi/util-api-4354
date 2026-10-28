// GitHub Actions Worker — Discord Username Sniper
// Fetches batch from coordinator, checks usernames, reports results, exits on RL
// Env: COORDINATOR_URL, DISCORD_TOKEN, DISCORD_PASSWORD, WEBHOOK_URL, WORKER_ID

const https = require('https');

const COORDINATOR_URL = process.env.COORDINATOR_URL || "https://discord-sniper-dashboard.pages.dev";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_PASSWORD = process.env.DISCORD_PASSWORD;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WORKER_ID = process.env.WORKER_ID || `gha-${process.env.GITHUB_RUN_ID || 'local'}-${process.env.MATRIX_INDEX || '0'}`;
const BATCH_SIZE = 20;
const CHECK_DELAY_MS = 500;

function httpRequest(url, options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

async function coordinatorAssign() {
    const res = await httpRequest(`${COORDINATOR_URL}/api/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ worker_id: WORKER_ID, batch_size: BATCH_SIZE }));
    return JSON.parse(res.body);
}

async function coordinatorReport(results, stats) {
    await httpRequest(`${COORDINATOR_URL}/api/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ worker_id: WORKER_ID, results, stats }));
}

async function checkUsername(username) {
    const res = await httpRequest('https://discord.com/api/v9/unique-username/username-attempt-unauthed', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Origin': 'https://discord.com',
            'Referer': 'https://discord.com/register'
        }
    }, JSON.stringify({ username }));
    return res;
}

async function claimUsername(username) {
    const res = await httpRequest('https://discord.com/api/v9/users/@me', {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': DISCORD_TOKEN,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        }
    }, JSON.stringify({ username, password: DISCORD_PASSWORD }));
    return res;
}

async function sendWebhook(content, embeds) {
    if (!WEBHOOK_URL) return;
    try {
        await httpRequest(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({ content: content || undefined, embeds: embeds || undefined }));
    } catch(e) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    console.log(`[*] Worker ${WORKER_ID} starting...`);
    
    let totalChecked = 0;
    let totalBatches = 0;
    let rateLimited = false;
    
    while (!rateLimited) {
        let batch;
        try {
            batch = await coordinatorAssign();
        } catch(e) {
            console.log(`[!] Coordinator error: ${e.message}`);
            await sleep(5000);
            continue;
        }
        
        if (!batch.candidates || batch.candidates.length === 0) {
            console.log('[*] No more candidates. All done!');
            await sendWebhook(null, [{
                title: '\u2705 Worker Complete',
                color: 0x2ecc71,
                description: `Worker **${WORKER_ID}** — no more candidates.\nChecked this session: ${totalChecked}`,
                timestamp: new Date().toISOString()
            }]);
            break;
        }
        
        console.log(`[*] Batch #${++totalBatches}: ${batch.candidates.length} usernames (${batch.remaining} remaining)`);
        
        const results = [];
        
        for (const username of batch.candidates) {
            try {
                const res = await checkUsername(username);
                
                if (res.status === 200) {
                    let parsed;
                    try { parsed = JSON.parse(res.body); } catch(e) { parsed = {}; }
                    
                    if (parsed.taken === false) {
                        console.log(`[!!!] AVAILABLE: ${username}`);
                        results.push({ username, status: 'available' });
                        
                        await sendWebhook('@everyone', [{
                            title: '\uD83C\uDF89 USERNAME AVAILABLE!',
                            color: 0x00ff00,
                            description: `**\`${username}\`** is AVAILABLE!\nWorker: ${WORKER_ID}`,
                            timestamp: new Date().toISOString()
                        }]);
                        
                        if (DISCORD_TOKEN && DISCORD_PASSWORD) {
                            const claimRes = await claimUsername(username);
                            if (claimRes.status === 200) {
                                console.log(`[!!!!] CLAIMED: ${username}`);
                                results[results.length - 1].status = 'claimed';
                                await sendWebhook('@everyone', [{
                                    title: '\uD83D\uDC51 USERNAME CLAIMED!',
                                    color: 0xffd700,
                                    description: `Successfully claimed **\`${username}\`**!`,
                                    timestamp: new Date().toISOString()
                                }]);
                            }
                        }
                    } else {
                        results.push({ username, status: 'taken' });
                        totalChecked++;
                    }
                } else if (res.status === 429) {
                    console.log(`[!] 429 — Rate Limited. Exiting.`);
                    results.push({ username, status: 'rate_limited' });
                    rateLimited = true;
                    break;
                } else {
                    results.push({ username, status: 'error' });
                }
            } catch(e) {
                console.log(`[!] Error: ${username}: ${e.message}`);
                results.push({ username, status: 'error' });
            }
            
            if (!rateLimited) await sleep(CHECK_DELAY_MS);
        }
        
        try {
            await coordinatorReport(results, { totalChecked, rateLimited });
        } catch(e) {
            console.log(`[!] Report error: ${e.message}`);
        }
    }
    
    console.log(`[*] Worker ${WORKER_ID} done. Checked: ${totalChecked}`);
    process.exit(rateLimited ? 1 : 0);
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
