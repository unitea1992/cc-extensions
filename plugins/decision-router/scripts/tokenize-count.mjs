import fs from "node:fs";

const url = process.argv[2];
const text = fs.readFileSync(0, "utf8");

try {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(700)
  });
  if (!response.ok) process.exit(1);
  const body = await response.json();
  if (!Array.isArray(body.tokens)) process.exit(1);
  console.log(JSON.stringify({ tokens: body.tokens.length }));
} catch {
  process.exit(1);
}
