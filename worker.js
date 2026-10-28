// GitHub Actions Worker — Discord Username Sniper v4
// 1 worker per repo, exit instantly on 429, persist progress, resume on next run

const https = require('https');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_PASSWORD = process.env.DISCORD_PASSWORD;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const GH_TOKEN = process.env.GH_PAT;
const REPO_INDEX = parseInt(process.env.REPO_INDEX || '0');
const WORKER_ID = `w${REPO_INDEX}`;
const TOTAL_WORKERS = 5; // 1 per repo
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const CHECK_DELAY_MS = 600;

function generateAllCandidates() {
    const alpha = 'abcdefghijklmnopqrstuvwxyz';
    const charset = 'abcdefghijklmnopqrstuvwxyz0123456789_.';
    const all = [];
    for (let a = 0; a < alpha.length; a++)
        for (let b = 0; b < charset.length; b++)
            for (let c = 0; c < charset.length; c++) {
                const u = alpha[a] + charset[b] + charset[c];
                if (!u.endsWith('.') && !u.includes('..')) all.push(u);
            }
    return all;
}

function httpReq(url, opts, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, opts, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

const discordHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*', 'Origin': 'https://discord.com', 'Referer': 'https://discord.com/register'
};

async function checkUsername(u) {
    return httpReq('https://discord.com/api/v9/unique-username/username-attempt-unauthed',
        { method: 'POST', headers: discordHeaders }, JSON.stringify({ username: u }));
}

async function claimUsername(u) {
    return httpReq('https://discord.com/api/v9/users/@me', {
        method: 'PATCH', headers: { ...discordHeaders, 'Authorization': DISCORD_TOKEN }
    }, JSON.stringify({ username: u, password: DISCORD_PASSWORD }));
}

async function webhook(content, embeds) {
    if (!WEBHOOK_URL) return;
    try { await httpReq(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ content: content || undefined, embeds: embeds || undefined }));
    } catch(e) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function loadProgress() {
    if (!GH_TOKEN || !GITHUB_REPOSITORY) return 0;
    try {
        const r = await httpReq(`https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/progress/${WORKER_ID}.txt`,
            { method: 'GET', headers: { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'sniper' } });
        if (r.status === 200) {
            const d = JSON.parse(r.body);
            return parseInt(Buffer.from(d.content, 'base64').toString().trim()) || 0;
        }
    } catch(e) {}
    return 0;
}

async function saveProgress(index) {
    if (!GH_TOKEN || !GITHUB_REPOSITORY) return;
    try {
        let sha = null;
        const g = await httpReq(`https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/progress/${WORKER_ID}.txt`,
            { method: 'GET', headers: { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'sniper' } });
        if (g.status === 200) sha = JSON.parse(g.body).sha;
        const payload = { message: `p ${WORKER_ID}: ${index}`, content: Buffer.from(String(index)).toString('base64') };
        if (sha) payload.sha = sha;
        await httpReq(`https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/progress/${WORKER_ID}.txt`,
            { method: 'PUT', headers: { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'sniper' } },
            JSON.stringify(payload));
    } catch(e) { console.log(`[${WORKER_ID}] save err: ${e.message}`); }
}

async function main() {
    const all = generateAllCandidates();
    const chunk = Math.ceil(all.length / TOTAL_WORKERS);
    const start = REPO_INDEX * chunk;
    const end = Math.min(start + chunk, all.length);
    const mine = all.slice(start, end);

    const saved = await loadProgress();
    const resume = Math.min(saved, mine.length);
    const remaining = mine.length - resume;

    console.log(`[${WORKER_ID}] v4 | slice ${start}-${end} | resume from ${resume} | ${remaining} remaining`);

    if (remaining <= 0) {
        await webhook(null, [{ title: `\u{2705} ${WORKER_ID} DONE`, color: 0x2ecc71, description: 'All candidates checked.', timestamp: new Date().toISOString() }]);
        return;
    }

    await webhook(null, [{ title: `\u{1F680} ${WORKER_ID} Online`, color: 0x3498db,
        description: `Resuming from #${resume}\nRemaining: ${remaining}/${mine.length}`, timestamp: new Date().toISOString() }]);

    let checked = 0, found = [];
    const t0 = Date.now();

    for (let i = resume; i < mine.length; i++) {
        const u = mine[i];
        try {
            const r = await checkUsername(u);
            if (r.status === 200) {
                checked++;
                let p; try { p = JSON.parse(r.body); } catch(e) { p = {}; }
                if (p.taken === false) {
                    found.push(u);
                    console.log(`[${WORKER_ID}] AVAILABLE: ${u}`);
                    await webhook('@everyone', [{ title: '\u{1F389} AVAILABLE!', color: 0x00ff00,
                        description: `**\`${u}\`**\nWorker: ${WORKER_ID}`, timestamp: new Date().toISOString() }]);
                    if (DISCORD_TOKEN && DISCORD_PASSWORD) {
                        const cr = await claimUsername(u);
                        if (cr.status === 200) {
                            await webhook('@everyone', [{ title: '\u{1F451} CLAIMED!', color: 0xffd700,
                                description: `**\`${u}\`** claimed!`, timestamp: new Date().toISOString() }]);
                            await saveProgress(i + 1);
                            return;
                        } else {
                            await webhook(null, [{ title: '\u{26A0}\u{FE0F} Claim fail', color: 0xff0000,
                                description: `\`${u}\` — ${cr.status}\n\`\`\`${cr.body.substring(0,200)}\`\`\``, timestamp: new Date().toISOString() }]);
                        }
                    }
                }
            } else if (r.status === 429) {
                console.log(`[${WORKER_ID}] 429 at i=${i}, checked=${checked}. Saving & exiting.`);
                await saveProgress(i);
                const pct = ((i / mine.length) * 100).toFixed(1);
                await webhook(null, [{ title: `\u{1F6D1} ${WORKER_ID} RL→exit`, color: 0xf0b232,
                    fields: [
                        { name: 'Progress', value: `${i}/${mine.length} (${pct}%)`, inline: true },
                        { name: 'This run', value: `${checked}`, inline: true },
                        { name: 'Found', value: `${found.length}`, inline: true }
                    ], timestamp: new Date().toISOString() }]);
                process.exit(0);
            }
        } catch(e) {
            console.log(`[${WORKER_ID}] err: ${e.message}`);
            await sleep(3000);
            continue;
        }

        // Status every 5min
        if (checked > 0 && checked % 50 === 0) {
            const pct = ((i / mine.length) * 100).toFixed(1);
            await webhook(null, [{ title: `\u{1F50D} ${WORKER_ID}`, color: 0x3498db,
                fields: [
                    { name: 'Progress', value: `${i}/${mine.length} (${pct}%)`, inline: true },
                    { name: 'This run', value: `${checked}`, inline: true },
                    { name: 'Found', value: `${found.length}`, inline: true }
                ], timestamp: new Date().toISOString() }]);
            await saveProgress(i);
        }
        await sleep(CHECK_DELAY_MS);
    }

    await saveProgress(mine.length);
    await webhook(null, [{ title: `\u{1F3C1} ${WORKER_ID} Complete`, color: 0x2ecc71,
        description: `All ${mine.length} checked. Found: ${found.length}`, timestamp: new Date().toISOString() }]);
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
