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
                result[section][entry].imgDescription = line.substring(2, line.indexOf("]"));
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

async function fetchGithubData() {
    const owner = "PantheraDigital";
    const repo = "InfoDump";
    const branch = "main";
    const file = "README.md";

    const response = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file}`);
    if (!response.ok) throw new Error(`GitHub HTTP Status: ${response.status}`);
    
    const text = await response.text();
    return githubTextToJSON(text);
}

// The Worker entry point
export default {
    async fetch(request, env, ctx) {
        try {
            const data = await fetchGithubData();
            
            // Return the parsed JSON with correct Content-Type and CORS headers
            return new Response(JSON.stringify(data, null, 2), {
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*", // Allows your frontend web app to fetch this data
                },
            });
        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    }
};
