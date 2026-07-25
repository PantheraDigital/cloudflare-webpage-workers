import { WorkerEntrypoint } from "cloudflare:workers";

/* Return Object
{
    Projects: [
    {
        title: "",
        link: "",
        imgSrc: "",
        imgDes: "",
        description: "MD",
        tags: [""],
    }
    ],
    Posts: [
    {
        title: "",
        intro: "MD",
        body: "MD",
        tags: [""],
    }
    ]
}
*/
/* Text File
    # Projects

    ## [Project Title](project link)
    ![img alt text](img link)
    project description
    [tags: tag1, tag2]

    # Posts

    ## Post Title
    intro
    <hr>
    body
    [tags: tag1, tag2]
*/
function parseContentText(text){
    if (!text) return {};

    const result = {};
    let section = "";
    let sectionArray = null;
    let entryIndex = -1;
    let validEntry = false;

    text.split("\n").forEach(line => {
        line = line.trim(); 
        if (line.startsWith("# ")){ // section
            section = line.substring(2);
            result[section] = [];
            sectionArray = result[section];
            entryIndex = -1;
            return;
        }

        const entry = (entryIndex !== -1) ? sectionArray[entryIndex] : null;
        if (section === "Projects"){
            if (line.startsWith("## ")) { // title
                line = line.substring(3);
                if (line.startsWith("[")){ // title is link
                    sectionArray.push({
                        title: line.substring(1, line.indexOf("]")),
                        link: line.substring(line.indexOf("(") + 1, line.length - 1),
                        description:""
                    });
                } else {
                    sectionArray.push({title: line, description:"", tags:[]});
                }
                entryIndex++;
                validEntry = true;
            } else if (entryIndex === -1 || !validEntry) {
                return;
            } else if (line.startsWith("!")){ // img
                entry.imgDes = line.substring(2, line.indexOf("]"));
                entry.imgSrc = line.substring(line.indexOf("(") + 1, line.length - 1);
            } else if (line.startsWith("[tags:")){ // tags
                let tags = line.substring(6, line.indexOf("]")).split(",");
                tags = tags.map(s => s.trim());
                entry.tags = tags;
                // finalize entry
                entry.description = entry.description.trim();
                validEntry = false;
            } else { // description
                entry.description = (entry.description) ? `${entry.description}\n${line}` : line;
            }
        } else if (section === "Posts"){
            if (line.startsWith("## ")) { // title
                line = line.substring(3);
                sectionArray.push({title: line, intro:"", tags:[]});
                entryIndex++;
                validEntry = true;
            } else if (entryIndex === -1 || !validEntry) {
                return;
            } else if (line.startsWith("[tags:")){ // tags
                let tags = line.substring(6, line.indexOf("]")).split(",");
                tags = tags.map(s => s.trim());
                entry.tags = tags;
                // finalize entry
                if (Object.hasOwn(entry, "body")) { entry.body = entry.body.trim(); }
                entry.intro = entry.intro.trim();
                validEntry = false;
            } else if (line === "<hr>"){ // switch to body
                entry.body = "";
            } else { // intro or body
                if (Object.hasOwn(entry, "body")){
                    entry.body = (entry.body) ? `${entry.body}\n${line}` : line;
                } else {
                    entry.intro = (entry.intro) ? `${entry.intro}\n${line}` : line;
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
    
    return {
        text: decodedText,
        commit: latestCommitSha
    };
}

// POST /webhook - Github Event use only, database update and render trigger
// fetchGitHubRawData - internal use only, resource retrieval from github 
export default class extends WorkerEntrypoint {
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === "POST") { 
            if (url.pathname !== "/webhook") {
                return new Response("Not Found", { status: 404 });
            }

            const signatureHeader = request.headers.get("X-Hub-Signature-256");
            const rawBody = await request.text();

            if (!this.env.WEBHOOK_SECRET || !(await verifySignature(this.env.WEBHOOK_SECRET, signatureHeader, rawBody))) {
                return new Response("Unauthorized Signature Check Failed", { status: 401 });
            }

            if (request.headers.get("X-GitHub-Event") === "ping") {
                return new Response("Accepted", { status: 202 });
            }

            if (request.headers.get("X-GitHub-Event") === "push") {
                const payload = JSON.parse(rawBody);
                const repoName = payload.repository.name;
                
                if (repoName === this.env.MD_REPO_NAME || repoName === this.env.HTML_REPO_NAME) {
                    this.ctx.waitUntil((async () => {
                        try {
                            if (repoName === this.env.MD_REPO_NAME) {
                                const currentCommit = await this.env.WEBPAGE_KV.get('json_commit');
                                const githubData = await fetchGitHubData(
                                    this.env.REPO_OWNER, this.env.MD_REPO_NAME, this.env.MD_PATH, this.env.GITHUB_TOKEN, 'MD pull failed');
                                
                                if (!currentCommit || githubData.commit !== currentCommit) {
                                    const githubText = JSON.stringify(parseContentText(githubData.text));
                                    
                                    await Promise.all([
                                        this.env.WEBPAGE_KV.put("json", githubText),
                                        this.env.WEBPAGE_KV.put("json_commit", githubData.commit)
                                    ]);

                                    console.log("Trigger render JSON");
                                    await this.env.WEB_PAGE_WORKER.fetch("https://internal/render", {
                                        method: "POST",
                                        headers: {
                                            "X-API-Key": this.env.INTERNAL_API_KEY || "",
                                            "Content-Type": "application/json"
                                        },
                                        body: githubText
                                    });
                                } else {console.log(`Skip JSON cache: github commit ${githubData.commit}, local commit ${currentCommit}`);}

                            } else if (repoName === this.env.HTML_REPO_NAME) {
                                const currentCommit = await this.env.WEBPAGE_KV.get('raw_html_commit');
                                const githubData = await fetchGitHubData(
                                    this.env.REPO_OWNER, this.env.HTML_REPO_NAME, this.env.HTML_PATH, this.env.GITHUB_TOKEN, 'HTML pull failed');
                                
                                if (!currentCommit || githubData.commit !== currentCommit) {
                                    await Promise.all([
                                        this.env.WEBPAGE_KV.put("raw_html", githubData.text),
                                        this.env.WEBPAGE_KV.put("raw_html_commit", githubData.commit)
                                    ]);
                                    
                                    console.log("Trigger render HTML");
                                    await this.env.WEB_PAGE_WORKER.fetch("https://internal/render", {
                                        method: "POST",
                                        headers: {
                                            "X-API-Key": this.env.INTERNAL_API_KEY || "",
                                            "Content-Type": "text/html"
                                        },
                                        body: githubData.text
                                    });
                                } else {console.log(`Skip HTML cache: github commit ${githubData.commit}, local commit ${currentCommit}`);}
                            }
                            console.log("Background compilation sync successful");
                        } catch (err) {
                            console.error("Background sync failed:", err.message);
                        }
                    })());

                    return new Response("Sync triggered in background", { status: 202 });
                }
            }

            return new Response("Event ignored", { status: 200 });
        }

        return new Response("Not Found", { status: 404 });
    }

    async fetchGitHubRawData(type) {
        const headers = (this.env.GITHUB_TOKEN) ? {"Authorization":`Bearer ${this.env.GITHUB_TOKEN}`} : {};
        if (type === "json") {
            const res = await fetch(`https://raw.githubusercontent.com/${this.env.REPO_OWNER}/${this.env.MD_REPO_NAME}/refs/heads/main/${this.env.MD_PATH}`, { headers });
            if (!res.ok) throw new Error(`MD pull failed: ${res.status}`);
            return JSON.stringify(parseContentText(await res.text()));
        } else if (type === "html") {
            const res = await fetch(`https://raw.githubusercontent.com/${this.env.REPO_OWNER}/${this.env.HTML_REPO_NAME}/refs/heads/main/${this.env.HTML_PATH}`, { headers });
            if (!res.ok) throw new Error(`HTML pull failed: ${res.status}`);
            return res.text();
        }
        return null;
    }
};