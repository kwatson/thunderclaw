import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");

let requestNumber = 0;

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw.toString("utf8"));
    const serializedMessages = JSON.stringify(body.messages ?? []);
    requestNumber += 1;

    const evidence = {
      requestNumber,
      path: req.url,
      model: body.model ?? null,
      roles: Array.isArray(body.messages) ? body.messages.map((message) => message?.role ?? null) : [],
      toolsFieldPresent: Object.hasOwn(body, "tools"),
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      toolChoiceFieldPresent: Object.hasOwn(body, "tool_choice"),
      personalityCanaryPresent: serializedMessages.includes("THUNDERBIRD_PERSONALITY_CANARY_7F3A"),
      memoryCanaryPresent: serializedMessages.includes("THUNDERBIRD_MEMORY_CANARY_91C2"),
      emailFixturePresent: serializedMessages.includes("We did the migration and it went pretty good"),
    };
    await writeFile(`/evidence/provider-request-${String(requestNumber).padStart(3, "0")}.json`, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

    const upstream = await fetch(`https://api.deepseek.com${req.url}`, {
      method: req.method,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: raw,
    });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  } catch {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "capture proxy failed" } }));
  }
});

server.listen(18888, "0.0.0.0");
