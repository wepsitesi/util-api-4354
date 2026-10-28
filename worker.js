// GitHub Actions Worker — Discord Username Sniper v3
// Static partitioning + progress persistence via GitHub API
// On 429: save progress to repo, exit immediately for fresh IP
// On restart: resume from saved progress

const https = require('https');
const { execSync } = require('child_process');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_PASSWORD = process.env.DISCORD_PASSWORD;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const GH_TOKEN = process.env.GH_PAT;
const REPO_INDEX = parseInt(process.env.REPO_INDEX || '0');
const MATRIX_INDEX = parseInt(process.env.MATRIX_INDEX || '0');
const WORKER_ID = `w${REPO_INDEX}-${MATRIX_INDEX}`;
const TOTAL_WORKERS = 20;
const GLOBAL_INDEX = REPO_INDEX * 4 + MATRIX_INDEX;
const CHECK_DELAY_MS = 800;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';

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

// Progress persistence via GitHub API
async function loadProgress() {
    if (!GH_TOKEN || !GITHUB_REPOSITORY) return 0;
    try {
        const res = await httpRequest(
            `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/progress/${WORKER_ID}.txt`,
            { method: 'GET', headers: { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'sniper' } }
        );
        if (res.status === 200) {
            const data = JSON.parse(res.body);
            const content = Buffer.from(data.content, 'base64').toString('utf-8').trim();
            return parseInt(content) || 0;
        }
    } catch(e) {}
    return 0;
}

async function saveProgress(index) {
    if (!GH_TOKEN || !GITHUB_REPOSITORY) return;
    try {
        // Get current SHA if exists
        let sha = null;
        const getRes = await httpRequest(
            `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/progress/${WORKER_ID}.txt`,
            { method: 'GET', headers: { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'sniper' } }
        );
        if (getRes.status === 200) {
            sha = JSON.parse(getRes.body).sha;
        }

        const payload = {
            message: `progress ${WORKER_ID}: ${index}`,
            content: Buffer.from(String(index)).toString('base64')
        };
        if (sha) payload.sha = sha;

        await httpRequest(
            `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/progress/${WORKER_ID}.txt`,
            { method: 'PUT', headers: { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'sniper' } },
            JSON.stringify(payload)
        );
    } catch(e) {
        console.log(`[${WORKER_ID}] Progress save error: ${e.message}`);
    }
}

async function main() {
    const allCandidates = generateAllCandidates();
    const total = allCandidates.length;
    const chunkSize = Math.ceil(total / TOTAL_WORKERS);
    const sliceStart = GLOBAL_INDEX * chunkSize;
    const sliceEnd = Math.min(sliceStart + chunkSize, total);
    const myCandidates = allCandidates.slice(sliceStart, sliceEnd);

    // Load progress
    const savedIndex = await loadProgress();
    const resumeFrom = Math.min(savedIndex, myCandidates.length);

    console.log(`[${WORKER_ID}] Slice: ${sliceStart}-${sliceEnd} (${myCandidates.length} total, resuming from ${resumeFrom})`);

    const startTime = Date.now();
    let checked = 0;
    let found = [];
    let lastReportTime = Date.now();

    await sendWebhook(null, [{
        title: `\u{1F680} ${WORKER_ID} Started`,
        color: 0x3498db,
        description: `Slice: ${myCandidates.length} usernames\nResuming from: #${resumeFrom}\nRemaining: ${myCandidates.length - resumeFrom}`,
        timestamp: new Date().toISOString()
    }]);

    for (let i = resumeFrom; i < myCandidates.length; i++) {
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
                            await saveProgress(i + 1);
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
                console.log(`[${WORKER_ID}] 429 at index ${i}. Saving progress and exiting.`);

                await saveProgress(i);

                await sendWebhook(null, [{
                    title: `\u{1F6D1} ${WORKER_ID} Rate-Limited`,
                    color: 0xf0b232,
                    fields: [
                        { name: 'Checked', value: `${checked} this run`, inline: true },
                        { name: 'Progress', value: `${i}/${myCandidates.length}`, inline: true },
                        { name: 'Found', value: `${found.length}`, inline: true }
                    ],
                    timestamp: new Date().toISOString()
                }]);

                process.exit(0);
            }
        } catch(e) {
            console.log(`[${WORKER_ID}] Error: ${e.message}`);
            await sleep(3000);
            continue;
        }

        // Status every 60s
        if (Date.now() - lastReportTime > 60000) {
            const pct = (((resumeFrom + checked) / myCandidates.length) * 100).toFixed(1);
            await sendWebhook(null, [{
                title: `\u{1F50D} ${WORKER_ID} Status`,
                color: 0x3498db,
                fields: [
                    { name: 'Progress', value: `${resumeFrom + checked}/${myCandidates.length} (${pct}%)`, inline: true },
                    { name: 'This Run', value: `${checked} checked`, inline: true },
                    { name: 'Found', value: `${found.length}`, inline: true },
                    { name: 'Last', value: `\`${username}\``, inline: true }
                ],
                timestamp: new Date().toISOString()
            }]);
            lastReportTime = Date.now();
            await saveProgress(i);
        }

        await sleep(CHECK_DELAY_MS);
    }

    await saveProgress(myCandidates.length);
    await sendWebhook(null, [{
        title: `\u{1F3C1} ${WORKER_ID} Complete`,
        color: 0x2ecc71,
        description: `All ${myCandidates.length} checked.\nFound: ${found.length}`,
        timestamp: new Date().toISOString()
    }]);
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
