const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const files = process.argv.slice(2);
if (!files.length) throw new Error("Pass at least one HTML file.");
let failures = 0, checked = 0;
for (const file of files) {
  const html = fs.readFileSync(file, "utf8");
  const re = /<script\\b([^>]*)>([\\s\\S]*?)<\\/script\\s*>/gi;
  let match, index = 0;
  while ((match = re.exec(html))) {
    const attrs = match[1] || "", source = match[2] || "";
    const type = (attrs.match(/\\btype\\s*=\\s*["']?([^\\s"'>]+)/i) || [])[1] || "text/javascript";
    if (!source.trim() || !["module", "text/javascript", "application/javascript"].includes(type)) continue;
    checked++;
    const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: source, encoding: "utf8" });
    if (result.status !== 0) {
      failures++;
      process.stderr.write(file + " inline script #" + (++index) + " failed syntax check:\\n" + (result.stderr || result.stdout));
    }
  }
}
console.log("Checked " + checked + " inline JavaScript block(s); failures: " + failures + ".");
if (failures) process.exit(1);
