// input: MD text
// output: HTML text
import { marked } from 'marked'; // https://marked.js.org/
marked.use({
  breaks: true,
  gfm: true
});

function sanitizeMarkdown(str) {
  return str.replace(/\u00A0/g, ' ');
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Not a POST request. ", { status: 405 });
    }

    try {

      const contentType = request.headers.get("Content-Type") || "";

      if (contentType.includes("text/plain")){
        const rawData = await request.text();
        const textData = sanitizeMarkdown(rawData);
        const htmlResult = await marked.parse(textData);
        console.log("TEXT result", htmlResult);
        return new Response(htmlResult, {
          headers: { "Content-Type": "text/html; charset=UTF-8" }
        });
      } else if (contentType.includes("application/json")) {
        const jsonData = await request.json();

        for (const key in jsonData) {
          if (typeof jsonData[key] === 'string') {
            const cleanText = sanitizeMarkdown(jsonData[key]);
            jsonData[key] = await marked.parse(cleanText);
          }
        }
        console.log("JSON result", jsonData);
        return new Response(JSON.stringify(jsonData), {
          headers: { "Content-Type": "application/json; charset=UTF-8" }
        });
      }
      return new Response("Unsupported Media Type. ", { status: 415 });
    } catch (error) {
      return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
    }
  }
};

// /external_workers/mardown-to-html
// npx wrangler deploy --config /home/user-name/Documents/vscode-projects/WebPageMK2/external_workers/markdown-to-html/wrangler.jsonc
