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

export default {
    async fetch(request, env, ctx) {

        const owner = "PantheraDigital";
        const repo = "InfoDump";
        const branch = "main";
        const path = "README.md";

        let latestCommit = -1;
        let kvCommit = -1;
        let lastError = "Unknown error occurred";


        const githubHeaders = {"User-Agent": "Cloudflare-Worker-InfoDump-Parser"};
        if (env.GITHUB_TOKEN) {
            githubHeaders["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
        }

        try{ // get latest commit of file from github
            const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?path=${path}&per_page=1`, {
                headers: githubHeaders
            });
            if (!response.ok) throw new Error(`GitHub API Status: ${response.status}`);

            const responseJSON = await response.json();
            if (responseJSON && Array.isArray(responseJSON) && responseJSON.length > 0) {
                latestCommit = responseJSON[0].sha;
            }
        } catch (error) {
            lastError = error.message;
            console.error("Failed get latest commit from GitHub:", error.message);
        }

        try{ // get last stored commit from KV
            kvCommit = await env.WEBPAGE_KV.get("github_json_commit");
        } catch(error) {
            lastError = error.message;
            console.error("Failed get commit from WEBPAGE_KV:", error.message);
        }

        if (kvCommit !== -1 && kvCommit !== null){ // use stored json if commit versions allow
            if ((latestCommit === -1) || (latestCommit !== -1 && kvCommit === latestCommit)) {
                try{
                    const kvJSON = await env.WEBPAGE_KV.get("github_json");
                    if (!kvJSON) throw new Error("Failed: WEBPAGE_KV.get('github_json')");
                    return new Response(kvJSON, {
                        headers: { "Content-Type": "application/json" }
                    });
                } catch (error) {
                    lastError = error.message;
                    console.error("Failed get json from WEBPAGE_KV:", error.message);
                }
            }
        }

        let githubData = null;
        try{ // get json data from github
            const response = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`);
            if (!response.ok) throw new Error(`GitHub HTTP Status: ${response.status}`);
            const text = await response.text();
            githubData = githubTextToJSON(text);
        } catch (error) {
            lastError = error.message;
            console.error("Failed get data from GitHub:", error.message);
        }

        if (githubData) {
            const stringifiedData = JSON.stringify(githubData);
            ctx.waitUntil(
                Promise.all([
                    env.WEBPAGE_KV.put("html_render_fresh", "false"),
                    env.WEBPAGE_KV.put("github_json_commit", latestCommit),
                    env.WEBPAGE_KV.put("github_json", stringifiedData)
                ]).catch(err => console.error("Failed set WEBPAGE_KV data from GitHub in waitUntil:", err.message))
            );

            return new Response(stringifiedData, {
                headers: { "Content-Type": "application/json" }
            });
        }

        try {
            const staleJSON = await env.WEBPAGE_KV.get("github_json");
            if (staleJSON) {
                return new Response(staleJSON, {
                    headers: { "Content-Type": "application/json" }
                });
            }
        } catch (_) { }

        return new Response(JSON.stringify({ error: lastError }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
};

