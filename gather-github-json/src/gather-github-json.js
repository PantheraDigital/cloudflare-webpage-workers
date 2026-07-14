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

async function fetchGitHubText(owner, path, errorMsg, githubToken) {
    const headers = (githubToken) ? {"Authorization":`token ${githubToken}`} : {};
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${path}`, { headers });
    if (!res.ok) throw new Error(`${errorMsg}: ${res.status}`);
    return await res.text();
}

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

            const payload = JSON.parse(rawBody);
            
            if (request.headers.get("X-GitHub-Event") === "ping") {
                return new Response("Accepted", { status: 202 });
            }

            if (request.headers.get("X-GitHub-Event") === "push") {
                const repoName = payload.repository.name;
                
                if (repoName === env.MD_REPO_NAME || repoName === env.HTML_REPO_NAME) {
                    ctx.waitUntil((async () => {
                        try {
                            if (repoName === env.MD_REPO_NAME) {
                                const githubData = githubTextToJSON(await fetchGitHubText(env.REPO_OWNER, env.MD_PATH, 'MD pull failed', env.GITHUB_TOKEN));
                                await env.WEBPAGE_KV.put("github_json", JSON.stringify(githubData));
                                await env.WEBPAGE_KV.put("html_render", "", { metadata: { fresh: false } });
                            } else if (repoName === env.HTML_REPO_NAME) {
                                const rawHtml = await fetchGitHubText(env.REPO_OWNER, env.HTML_PATH, 'HTML pull failed', env.GITHUB_TOKEN);
                                await env.WEBPAGE_KV.put("raw_layout_html", rawHtml);
                                await env.WEBPAGE_KV.put("html_render", "", { metadata: { fresh: false } });
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

        if (request.method === "GET") {
            const clientApiKey = request.headers.get("X-API-Key");
            if (!env.API_KEY || clientApiKey !== env.API_KEY) {
                return new Response("Unauthorized: Invalid or Missing API Key", { status: 401 });
            }

            const target = url.searchParams.get("pull");
            try {
                if (target === "json") {
                    const githubData = githubTextToJSON(await fetchGitHubText(env.REPO_OWNER, env.MD_PATH, 'MD pull failed'));
                    const dataStr = JSON.stringify(githubData);
                    ctx.waitUntil(
                        Promise.all([
                            env.WEBPAGE_KV.put("github_json", dataStr),
                            env.WEBPAGE_KV.put("html_render", "", { metadata: { fresh: false } })
                        ])
                    );
                    return new Response(dataStr, { headers: { "Content-Type": "application/json" } });
                }
                
                if (target === "html") {
                    const rawHtml = await fetchGitHubText(env.REPO_OWNER, env.HTML_PATH, 'HTML pull failed');
                    ctx.waitUntil(
                        Promise.all([
                            env.WEBPAGE_KV.put("raw_layout_html", rawHtml),
                            env.WEBPAGE_KV.put("html_render", "", { metadata: { fresh: false } })
                        ])
                    );
                    return new Response(rawHtml, { headers: { "Content-Type": "text/html" } });
                }
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), { status: 500 });
            }
        }

        return new Response("Not Found", { status: 404 });
    }
};
