import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const publicDir = path.join(root, "public");

await mkdir(publicDir, { recursive: true });
await cp(path.join(root, "node_modules/pdfjs-dist/cmaps"), path.join(publicDir, "cmaps"), { recursive: true });
await cp(path.join(root, "node_modules/pdfjs-dist/standard_fonts"), path.join(publicDir, "standard_fonts"), { recursive: true });

console.log("PDF.js assets prepared.");
