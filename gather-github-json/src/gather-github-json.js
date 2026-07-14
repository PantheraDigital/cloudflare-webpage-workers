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

async function verifySignature(secret, header, textBody) {
    if (!header) return false;
    
    const encoder = new TextEncoder();
    const keyBuffer = encoder.encode(secret);
    const bodyBuffer = encoder.encode(textBody);
    
    const cryptoKey = await crypto.subtle.importKey(
        "raw", 
        keyBuffer, 
        { name: "HMAC", hash: "SHA-256" }, 
        false, 
        ["verify"]
    );
    
    const actualPart = header.startsWith("sha256=") ? header.slice(7) : header;
    const sigBytes = new Uint8Array(actualPart.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    
    return await crypto.subtle.verify("HMAC", cryptoKey, sigBytes, bodyBuffer);
}

async function fetchFromGitHub(env) {
    const owner = "PantheraDigital";
    const repo = "InfoDump";
    const branch = "main";
    const path = "README.md";
    
    const response = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`);
    if (!response.ok) throw new Error(`GitHub File retrieval failed Status: ${response.status}`);
    const text = await response.text();
    return githubTextToJSON(text);
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === "POST" && url.pathname === "/webhook") { 
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
                let readmeChanged = false;

                if (payload.commits && Array.isArray(payload.commits)) {
                    for (const commit of payload.commits) {
                        const fileDiff = [...(commit.added || []), ...(commit.modified || [])];
                        if (fileDiff.includes(env.PATH || "README.md")) {
                            readmeChanged = true;
                            break;
                        }
                    }
                }

                if (readmeChanged) {
                    try {
                        const githubData = await fetchFromGitHub(env);
                        const stringifiedData = JSON.stringify(githubData);
                        
                        await env.WEBPAGE_KV.put("github_json", stringifiedData);
                        await env.WEBPAGE_KV.put("html_render_fresh", "false"); 

                        return new Response(JSON.stringify({ status: "KV Cached Updated via Webhook" }), {
                            headers: { "Content-Type": "application/json" }
                        });
                    } catch (err) {
                        return new Response(`MD compilation failure: ${err.message}`, { status: 500 });
                    }
                }

                return new Response(JSON.stringify({ status: "No target file modifications detected" }), {
                    headers: { "Content-Type": "application/json" }
                });
            }
        }

        return new Response("Event ignored", { status: 200 });
    }
};

