import fs from "node:fs";

fs.mkdirSync("dist/prompts", { recursive: true });
for (const f of fs.readdirSync("src/prompts")) {
  if (f.endsWith(".md")) {
    fs.copyFileSync(`src/prompts/${f}`, `dist/prompts/${f}`);
    console.log(`copied: ${f}`);
  }
}

fs.mkdirSync("dist/knowledge-base", { recursive: true });
fs.copyFileSync(
  "docs/knowledge-base/tidy-mailboxes-feedback-log.md",
  "dist/knowledge-base/tidy-mailboxes-feedback-log.md",
);
console.log("copied: tidy-mailboxes-feedback-log.md");
