// `surfer import` copies every top-level entry of configs/branding/<brand>/ except
// content/ as a file, so the msix/ folder (Windows tile artwork) fails it with
// EISDIR. The folders are moved aside for the import and copied into
// engine/browser/branding/<brand>/msix/ afterwards.
import { cpSync, existsSync, readdirSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const brandingDir = join(root, "configs", "branding");
const moved = readdirSync(brandingDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(brandingDir, entry.name, "msix")))
  .map((entry) => entry.name);

for (const brand of moved) {
  renameSync(join(brandingDir, brand, "msix"), join(brandingDir, `.${brand}-msix`));
}
let status;
try {
  status = spawnSync("surfer", ["import", ...process.argv.slice(2)], { stdio: "inherit", shell: true }).status;
} finally {
  for (const brand of moved) {
    renameSync(join(brandingDir, `.${brand}-msix`), join(brandingDir, brand, "msix"));
  }
}
if (status === 0) {
  for (const brand of moved) {
    const target = join(root, "engine", "browser", "branding", brand);
    if (existsSync(target)) {
      cpSync(join(brandingDir, brand, "msix"), join(target, "msix"), { recursive: true });
    }
  }
}
process.exit(status ?? 1);
