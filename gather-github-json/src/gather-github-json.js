/*
entryTitle: {
    link: "",
    imgSrc: "",
    imgDes: "",
    description: "MD",
    tags: [""],
}
*/
function githubTextToJSON(text){
    const result = {};
    let section = "";
    let entry = "";

    // parse text to JSON
    text.split("\n").forEach(line => {
        if (line.trim() === ""){ // empty line
            if (entry !== "" && result[section] && result[section][entry] && result[section][entry].description){
                result[section][entry].description += "\n";
            }
        } else if (line.startsWith("##")){ // title of new entry
            line = line.substring(2).trim();
            if (line.startsWith("[")){ // title is link
                entry = line.substring(1, line.indexOf("]"));
                if (section) {
                    result[section][entry] = {};
                    result[section][entry].link = line.substring(line.indexOf("(") + 1, line.length - 1);
                }
            } else {
                entry = line;
                if (section) result[section][entry] = {};
            }
        } 
        else if (line.startsWith("#")) { // title of new section
            section = line.substring(1).trim();
            result[section] = {};
            entry = "";
        } else if (line.startsWith("!")) { // img
            if (section && entry && result[section][entry]) {
                result[section][entry].imgDes = line.substring(2, line.indexOf("]"));
                result[section][entry].imgSrc = line.substring(line.indexOf("(") + 1, line.length - 1);
            }
        } else if (line.startsWith("[tags:")){ // tags
            let tags = line.substring(6, line.indexOf("]")).split(",");
            tags = tags.map(s => s.trim());
            if (section && entry && result[section][entry]) {
                result[section][entry].tags = tags;
            }
        } else { // description
            if (section && entry && result[section][entry]) {
                if (result[section][entry].description){
                    result[section][entry].description += "\n" + line;
                } else {
                    result[section][entry].description = line;
                }
            }
        }
    });
    return result;
}

// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#javascript-example
const encoder = new TextEncoder();
async function verifySignature(secret, header, payload) {
    let parts = header.split("=");
    let sigHex = parts[1];

    let algorithm = { name: "HMAC", hash: { name: 'SHA-256' } };

    let keyBytes = encoder.encode(secret);
    let extractable = false;
    let key = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        algorithm,
        extractable,
        [ "sign", "verify" ],
    );

    let sigBytes = hexToBytes(sigHex);
    let dataBytes = encoder.encode(payload);
    let equal = await crypto.subtle.verify(
        algorithm.name,
        key,
        sigBytes,
        dataBytes,
    );

    return equal;
}
function hexToBytes(hex) {
    let len = hex.length / 2;
    let bytes = new Uint8Array(len);

    let index = 0;
    for (let i = 0; i < hex.length; i += 2) {
        let c = hex.slice(i, i + 2);
        let b = parseInt(c, 16);
        bytes[index] = b;
        index += 1;
    }

    return bytes;
}

async function fetchGitHubRawText(owner, repo, path, githubToken, errorMsg) {
    const headers = (githubToken) ? {"Authorization":`token ${githubToken}`} : {};
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/main/${path}`, { headers });
    if (!res.ok) throw new Error(`${errorMsg}: ${res.status}`);
    return await res.text();
}
async function fetchGitHubData(owner, repo, path, githubToken, errorMsg) {
    const headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${githubToken}`,
        "User-Agent": "Cloudflare-Worker"
    };

    // https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#get-a-repository
    const contentUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const commitUrl = `https://api.github.com/repos/${owner}/${repo}/commits?path=${path}&per_page=1`;

    const [contentRes, commitRes] = await Promise.all([
        fetch(contentUrl, { headers: headers }),
        fetch(commitUrl, { headers: headers })
    ]);

    if (!contentRes.ok) {
        throw new Error(`GitHub Content API Status: ${contentRes.status}`);
    }
    if (!commitRes.ok) {
        throw new Error(`GitHub Commits API Status: ${commitRes.status}`);
    }

    const [contentJSON, commitJSON] = await Promise.all([
        contentRes.json(),
        commitRes.json()
    ]);

    const decodedText = decodeURIComponent(
        atob(contentJSON.content.replace(/\s/g, ''))
            .split('')
            .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
    );

    let latestCommitSha = null;
    if (Array.isArray(commitJSON) && commitJSON.length > 0) {
        latestCommitSha = commitJSON[0].sha;
    }
    console.log({
        text: decodedText,
        commit: latestCommitSha
    });
    return {
        text: decodedText,
        commit: latestCommitSha
    };
}

// POST /webhook - Github Event use only, database update and render trigger
// GET - internal use only, resource retrieval from github 
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === "POST") { 
            if (url.pathname !== "/webhook") {
                return new Response("Not Found", { status: 404 });
            }

            const signatureHeader = request.headers.get("X-Hub-Signature-256");
            const rawBody = await request.text();

            if (!env.WEBHOOK_SECRET || !(await verifySignature(env.WEBHOOK_SECRET, signatureHeader, rawBody))) {
                return new Response("Unauthorized Signature Check Failed", { status: 401 });
            }

            if (request.headers.get("X-GitHub-Event") === "ping") {
                return new Response("Accepted", { status: 202 });
            }

            if (request.headers.get("X-GitHub-Event") === "push") {
                const payload = JSON.parse(rawBody);
                const repoName = payload.repository.name;
                
                if (repoName === env.MD_REPO_NAME || repoName === env.HTML_REPO_NAME) {
                    ctx.waitUntil((async () => {
                        try {
                            if (repoName === env.MD_REPO_NAME) {
                                const currentCommit = await env.WEBPAGE_KV.get('json_commit');
                                const githubData = await fetchGitHubData(
                                    env.REPO_OWNER, env.MD_REPO_NAME, env.MD_PATH, env.GITHUB_TOKEN, 'MD pull failed');
                                
                                if (!currentCommit || githubData.commit !== currentCommit) {
                                    const githubText = JSON.stringify(githubTextToJSON(githubData.text));
                                    
                                    await Promise.all([
                                        env.WEBPAGE_KV.put("json", githubText),
                                        env.WEBPAGE_KV.put("json_commit", githubData.commit)
                                    ]);

                                    await env.WEB_PAGE_WORKER.fetch("https://internal/render", {
                                        method: "POST",
                                        headers: {
                                            "X-API-Key": env.INTERNAL_API_KEY || "",
                                            "Content-Type": "application/json"
                                        },
                                        body: githubText
                                    });
                                }
                            } else if (repoName === env.HTML_REPO_NAME) {
                                const currentCommit = await env.WEBPAGE_KV.get('raw_html_commit');
                                const githubData = await fetchGitHubData(
                                    env.REPO_OWNER, env.HTML_REPO_NAME, env.HTML_PATH, env.GITHUB_TOKEN, 'HTML pull failed');
                                
                                if (!currentCommit || githubData.commit !== currentCommit) {
                                    await Promise.all([
                                        env.WEBPAGE_KV.put("raw_html", githubData.text),
                                        env.WEBPAGE_KV.put("raw_html_commit", githubData.commit)
                                    ]);
                                    
                                    await env.WEB_PAGE_WORKER.fetch("https://internal/render", {
                                        method: "POST",
                                        headers: {
                                            "X-API-Key": env.INTERNAL_API_KEY || "",
                                            "Content-Type": "text/html"
                                        },
                                        body: githubData.text
                                    });
                                }
                            }
                            console.log("Background compilation sync successful.");
                        } catch (err) {
                            console.error("Background sync failed:", err.message);
                        }
                    })());

                    return new Response("Sync triggered in background", { status: 202 });
                }
            }

            return new Response("Event ignored", { status: 200 });
        }

        if (request.method === "GET" && url.hostname === "internal") {
            const clientApiKey = request.headers.get("X-API-Key");
            if (!env.INTERNAL_API_KEY || clientApiKey !== env.INTERNAL_API_KEY) {
                return new Response("Unauthorized: Invalid or Missing API Key", { status: 401 });
            }

            const target = url.searchParams.get("pull");
            try {
                if (target === "json") {
                    const githubData = githubTextToJSON(await fetchGitHubRawText(
                        env.REPO_OWNER, env.MD_PATH, env.GITHUB_TOKEN, 'MD pull failed'));
                    const dataStr = JSON.stringify(githubData);
                    return new Response(dataStr, { headers: { "Content-Type": "application/json" } });
                }
                
                if (target === "html") {
                    const rawHtml = await fetchGitHubRawText(
                        env.REPO_OWNER, env.HTML_PATH, env.GITHUB_TOKEN, 'HTML pull failed');
                    return new Response(rawHtml, { headers: { "Content-Type": "text/html" } });
                }
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), { status: 500 });
            }
        }

        return new Response("Not Found", { status: 404 });
    }
};