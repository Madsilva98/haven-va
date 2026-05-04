import fs from "node:fs";

fs.mkdirSync("dist/prompts", { recursive: true });
for (const f of fs.readdirSync("src/prompts")) {
  if (f.endsWith(".md")) {
    fs.copyFileSync(`src/prompts/${f}`, `dist/prompts/${f}`);
    console.log(`copied: ${f}`);
  }
}
