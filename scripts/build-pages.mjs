import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "build", "pages");
const assetsDirectory = path.join(outputDirectory, "assets");

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(assetsDirectory, { recursive: true });
await cp(path.join(repositoryRoot, "site"), outputDirectory, { recursive: true });

await Promise.all([
  cp(
    path.join(repositoryRoot, "docs", "brand", "assets", "raster", "thunderclaw-character-transparent-1024.webp"),
    path.join(assetsDirectory, "thunderclaw-character.webp"),
  ),
  cp(
    path.join(repositoryRoot, "packages", "thunderbird-extension", "src", "icons", "thunderclaw-128.png"),
    path.join(assetsDirectory, "thunderclaw-128.png"),
  ),
]);

const faviconSizes = [16, 32, 48];
const faviconImages = await Promise.all(
  faviconSizes.map((size) => readFile(path.join(assetsDirectory, `favicon-${size}x${size}.png`))),
);
const faviconHeader = Buffer.alloc(6 + faviconImages.length * 16);
faviconHeader.writeUInt16LE(0, 0);
faviconHeader.writeUInt16LE(1, 2);
faviconHeader.writeUInt16LE(faviconImages.length, 4);

let faviconOffset = faviconHeader.length;
faviconImages.forEach((image, index) => {
  const entryOffset = 6 + index * 16;
  faviconHeader.writeUInt8(faviconSizes[index], entryOffset);
  faviconHeader.writeUInt8(faviconSizes[index], entryOffset + 1);
  faviconHeader.writeUInt8(0, entryOffset + 2);
  faviconHeader.writeUInt8(0, entryOffset + 3);
  faviconHeader.writeUInt16LE(1, entryOffset + 4);
  faviconHeader.writeUInt16LE(32, entryOffset + 6);
  faviconHeader.writeUInt32LE(image.length, entryOffset + 8);
  faviconHeader.writeUInt32LE(faviconOffset, entryOffset + 12);
  faviconOffset += image.length;
});

await writeFile(path.join(outputDirectory, "favicon.ico"), Buffer.concat([faviconHeader, ...faviconImages]));

console.log(`Built GitHub Pages site at ${path.relative(repositoryRoot, outputDirectory)}`);
