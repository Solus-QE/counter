import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const WEB_DIR = dirname(new URL(import.meta.url).pathname);
const DIST_DIR = join(WEB_DIR, "dist");

mkdirSync(DIST_DIR, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(WEB_DIR, "src", "main.ts")],
  outdir: DIST_DIR,
  naming: "app.js",
  target: "browser",
  format: "esm",
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

copyFileSync(join(WEB_DIR, "index.html"), join(DIST_DIR, "index.html"));
copyFileSync(join(WEB_DIR, "styles.css"), join(DIST_DIR, "styles.css"));
writeFileSync(
  join(DIST_DIR, "favicon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#08090b" stroke="#38bdf8" stroke-width="2"/><ellipse cx="32" cy="32" rx="28" ry="10" fill="none" stroke="#a78bfa" stroke-width="1.6" transform="rotate(-28 32 32)"/><circle cx="48" cy="20" r="4" fill="#34d399"/><circle cx="16" cy="44" r="4" fill="#f43f5e"/></svg>`,
);

console.log(`Built COUNTERWHORL static bundle into ${DIST_DIR}`);
