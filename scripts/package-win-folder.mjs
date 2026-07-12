import { rm } from "node:fs/promises";
import { packager } from "@electron/packager";

const outputDir = process.env.PACKAGE_OUT || "packaged";

await rm(outputDir, { recursive: true, force: true });

await packager({
  dir: ".",
  name: "报销单据管理",
  platform: "win32",
  arch: "x64",
  out: outputDir,
  overwrite: true,
  asar: false,
  prune: false,
  ignore: [
    /^\/\.git($|\/)/,
    /^\/\.claude($|\/)/,
    /^\/\.gitignore$/,
    /^\/src($|\/)/,
    /^\/public($|\/)/,
    /^\/scripts($|\/)/,
    /^\/data($|\/)/,
    /^\/release($|\/)/,
    /^\/packaged($|\/)/,
    /^\/dist-electron($|\/)/,
    /^\/node_modules($|\/)/,
    /^\/.*\.pdf$/,
    /^\/[^/]+\.md$/,
    /\.log$/,
    /^\/app\.py$/,
    /^\/start\.bat$/,
    /^\/package-lock\.json$/,
  ],
});

console.log(`Wrote Windows app to ${outputDir}/报销单据管理-win32-x64`);
