// GitHub Actions Worker — Discord Username Sniper
// Static partitioning: no DB needed, each worker gets a unique slice
// Env: DISCORD_TOKEN, DISCORD_PASSWORD, WEBHOOK_URL, REPO_INDEX (0-4), MATRIX_INDEX (0-3)

const https = require('https');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_PASSWORD = process.env.DISCORD_PASSWORD;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const REPO_INDEX = parseInt(process.env.REPO_INDEX || '0');
const MATRIX_INDEX = parseInt(process.env.MATRIX_INDEX || '0');
const WORKER_ID = `w${REPO_INDEX}-${MATRIX_INDEX}`;
const TOTAL_WORKERS = 20; // 5 repos x 4 matrix
const GLOBAL_INDEX = REPO_INDEX * 4 + MATRIX_INDEX;
const CHECK_DELAY_MS = 800;

// Generate all 3L candidates: a-z first char, a-z0-9_. rest
function generateAllCandidates() {
    const alpha = 'abcdefghijklmnopqrstuvwxyz';
    const charset = 'abcdefghijklmnopqrstuvwxyz0123456789_.';
    const all = [];
    for (let a = 0; a < alpha.length; a++) {
        for (let b = 0; b < charset.length; b++) {
            for (let c = 0; c < charset.length; c++) {
                const u = alpha[a] + charset[b] + charset[c];
                if (u.endsWith('.') || u.includes('..')) continue;
                all.push(u);
            }
        }
    }
    return all;
}

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

async function checkUsername(username) {
    return httpRequest('https://discord.com/api/v9/unique-username/username-attempt-unauthed', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Origin': 'https://discord.com',
            'Referer': 'https://discord.com/register'
        }
    }, JSON.stringify({ username }));
}

async function claimUsername(username) {
    return httpRequest('https://discord.com/api/v9/users/@me', {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': DISCORD_TOKEN,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        }
    }, JSON.stringify({ username, password: DISCORD_PASSWORD }));
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

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h${m}m`;
}

async function main() {
    const allCandidates = generateAllCandidates();
    const total = allCandidates.length;
    const chunkSize = Math.ceil(total / TOTAL_WORKERS);
    const start = GLOBAL_INDEX * chunkSize;
    const end = Math.min(start + chunkSize, total);
    const myCandidates = allCandidates.slice(start, end);

    console.log(`[${WORKER_ID}] Slice: ${start}-${end} (${myCandidates.length} usernames out of ${total})`);

    const startTime = Date.now();
    let checked = 0;
    let found = [];
    let rateLimits = 0;
    let lastReportTime = Date.now();

    // Startup webhook
    await sendWebhook(null, [{
        title: `\u{1F680} ${WORKER_ID} Started`,
        color: 0x3498db,
        description: `Slice: \`${start}\`-\`${end}\` (${myCandidates.length} usernames)\nGlobal worker #${GLOBAL_INDEX}`,
        timestamp: new Date().toISOString()
    }]);

    for (let i = 0; i < myCandidates.length; i++) {
        const username = myCandidates[i];

        try {
            const res = await checkUsername(username);

            if (res.status === 200) {
                checked++;
                let parsed;
                try { parsed = JSON.parse(res.body); } catch(e) { parsed = {}; }

                if (parsed.taken === false) {
                    console.log(`[${WORKER_ID}] !!! AVAILABLE: ${username}`);
                    found.push(username);

                    await sendWebhook('@everyone', [{
                        title: '\u{1F389} USERNAME AVAILABLE!',
                        color: 0x00ff00,
                        description: `**\`${username}\`** is AVAILABLE!\nWorker: ${WORKER_ID}`,
                        timestamp: new Date().toISOString()
                    }]);

                    if (DISCORD_TOKEN && DISCORD_PASSWORD) {
                        const cr = await claimUsername(username);
                        if (cr.status === 200) {
                            console.log(`[${WORKER_ID}] !!!! CLAIMED: ${username}`);
                            await sendWebhook('@everyone', [{
                                title: '\u{1F451} USERNAME CLAIMED!',
                                color: 0xffd700,
                                description: `Successfully claimed **\`${username}\`**!`,
                                timestamp: new Date().toISOString()
                            }]);
                            return;
                        } else {
                            await sendWebhook(null, [{
                                title: '\u{26A0}\u{FE0F} Claim Failed',
                                color: 0xff0000,
                                description: `\`${username}\` — Status: ${cr.status}\n\`\`\`${cr.body.substring(0, 300)}\`\`\``,
                                timestamp: new Date().toISOString()
                            }]);
                        }
                    }
                }
            } else if (res.status === 429) {
                rateLimits++;
                let retryAfter = 5;
                try { const p = JSON.parse(res.body); if (p.retry_after) retryAfter = p.retry_after; } catch(e) {}
                console.log(`[${WORKER_ID}] 429 — wait ${retryAfter}s (RL #${rateLimits})`);
                await sleep(retryAfter * 1000 + 500);
                i--; // retry same
                continue;
            }
        } catch(e) {
            console.log(`[${WORKER_ID}] Error: ${e.message}`);
            await sleep(3000);
            i--;
            continue;
        }

        // Status report every 60s
        if (Date.now() - lastReportTime > 60000) {
            const elapsed = Date.now() - startTime;
            const pct = ((checked / myCandidates.length) * 100).toFixed(1);
            await sendWebhook(null, [{
                title: `\u{1F50D} ${WORKER_ID} Status`,
                color: 0x3498db,
                fields: [
                    { name: 'Checked', value: `${checked}/${myCandidates.length} (${pct}%)`, inline: true },
                    { name: 'Rate-Limits', value: `${rateLimits}`, inline: true },
                    { name: 'Found', value: `${found.length}`, inline: true },
                    { name: 'Uptime', value: formatDuration(elapsed), inline: true },
                    { name: 'Last', value: `\`${username}\``, inline: true }
                ],
                timestamp: new Date().toISOString()
            }]);
            lastReportTime = Date.now();
        }

        await sleep(CHECK_DELAY_MS);
    }

    // Done
    await sendWebhook(null, [{
        title: `\u{1F3C1} ${WORKER_ID} Complete`,
        color: 0x2ecc71,
        description: `Checked all ${myCandidates.length} usernames.\nFound: ${found.length}\nRate-Limits: ${rateLimits}\nUptime: ${formatDuration(Date.now() - startTime)}`,
        timestamp: new Date().toISOString()
    }]);
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
