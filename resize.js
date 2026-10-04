#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const decodeHeic = require("heic-decode");

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".tif",
  ".tiff",
  ".bmp",
  ".avif",
  ".heic",
  ".heif",
]);

const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);

const DEFAULTS = {
  maxWidth: 1920,
  maxHeight: 1920,
  quality: 82,
  concurrency: 4,
};

function printHelp() {
  console.log(`Resize images for the web and save them as JPG.

Usage:
  node resize.js <input-folder> [options]

The output folder is created next to the input folder.
Its name is the input folder name plus "-output".
Example: photos  ->  photos-output

Options:
  --max-width <px>    Longest horizontal size. Default: ${DEFAULTS.maxWidth}
  --max-height <px>   Longest vertical size. Default: ${DEFAULTS.maxHeight}
  --quality <1-100>   JPG quality. Default: ${DEFAULTS.quality}
  --concurrency <n>   Images processed at once. Default: ${DEFAULTS.concurrency}
  --help              Show this help

Images already smaller than the limit are not enlarged.
Transparency becomes a white background, because JPG has no alpha.
HEIC and HEIF photos are included and saved as JPG.
`);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, input: null };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--max-width" || arg === "--max-height" || arg === "--quality" || arg === "--concurrency") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value)) {
        throw new Error(`${arg} needs a number`);
      }
      if (arg === "--max-width") options.maxWidth = value;
      if (arg === "--max-height") options.maxHeight = value;
      if (arg === "--quality") options.quality = value;
      if (arg === "--concurrency") options.concurrency = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  options.input = positional[0] || null;
  if (positional.length > 1) {
    throw new Error("Pass one input folder only");
  }
  return options;
}

function validateOptions(options) {
  if (!Number.isInteger(options.maxWidth) || options.maxWidth < 1) {
    throw new Error("--max-width must be a positive integer");
  }
  if (!Number.isInteger(options.maxHeight) || options.maxHeight < 1) {
    throw new Error("--max-height must be a positive integer");
  }
  if (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100) {
    throw new Error("--quality must be an integer from 1 to 100");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
}

async function collectImages(rootDir) {
  const images = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) images.push(fullPath);
    }
  }

  await walk(rootDir);
  images.sort((a, b) => a.localeCompare(b));
  return images;
}

function outputPathFor(inputRoot, outputRoot, sourcePath, usedNames) {
  const relativeDir = path.dirname(path.relative(inputRoot, sourcePath));
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  let fileName = `${stem}.jpg`;
  let index = 1;
  let key = path.join(relativeDir, fileName).toLowerCase();

  while (usedNames.has(key)) {
    fileName = `${stem}-${index}.jpg`;
    index += 1;
    key = path.join(relativeDir, fileName).toLowerCase();
  }
  usedNames.add(key);
  return path.join(outputRoot, relativeDir, fileName);
}

let heicQueue = Promise.resolve();

function decodeHeicFile(buffer) {
  const task = heicQueue.then(() => decodeHeic({ buffer }));
  heicQueue = task.then(
    () => {},
    () => {},
  );
  return task;
}

async function decodeHeicPixels(sourcePath) {
  const buffer = await fs.readFile(sourcePath);
  return decodeHeicFile(buffer);
}

function openImage(sourcePath, decodedHeic) {
  if (!decodedHeic) {
    return sharp(sourcePath, { failOn: "none" });
  }

  const { width, height, data } = decodedHeic;
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
    failOn: "none",
  });
}

async function resizeOne(sourcePath, destinationPath, options) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const before = (await fs.stat(sourcePath)).size;
  const ext = path.extname(sourcePath).toLowerCase();
  const decodedHeic = HEIC_EXTENSIONS.has(ext) ? await decodeHeicPixels(sourcePath) : null;

  await openImage(sourcePath, decodedHeic)
    .rotate()
    .resize({
      width: options.maxWidth,
      height: options.maxHeight,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({
      quality: options.quality,
      mozjpeg: true,
      progressive: true,
      chromaSubsampling: "4:2:0",
    })
    .toFile(destinationPath);

  const after = (await fs.stat(destinationPath)).size;
  return { before, after };
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(workers);
  return results;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 0; i < units.length; i += 1) {
    unit = units[i];
    if (value < 1024 || i === units.length - 1) break;
    value /= 1024;
  }
  return `${value.toFixed(1)} ${unit}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.input) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }
  validateOptions(options);

  const inputRoot = path.resolve(options.input);
  const inputStat = await fs.stat(inputRoot).catch(() => null);
  if (!inputStat || !inputStat.isDirectory()) {
    throw new Error(`Input folder not found: ${inputRoot}`);
  }

  const outputRoot = path.join(path.dirname(inputRoot), 'output', path.basename(inputRoot));
  if (path.resolve(outputRoot) === inputRoot) {
    throw new Error("Output folder would be the same as the input folder");
  }

  const images = await collectImages(inputRoot);
  if (images.length === 0) {
    console.log(`No images found in ${inputRoot}`);
    return;
  }

  await fs.mkdir(outputRoot, { recursive: true });
  const usedNames = new Set();
  const jobs = images.map((sourcePath) => ({
    sourcePath,
    destinationPath: outputPathFor(inputRoot, outputRoot, sourcePath, usedNames),
  }));
  let savedBytes = 0;
  let failures = 0;

  console.log(`Input:  ${inputRoot}`);
  console.log(`Output: ${outputRoot}`);
  console.log(`Files:  ${images.length}`);
  console.log(`Limit:  ${options.maxWidth}x${options.maxHeight}, quality ${options.quality}`);

  await mapPool(jobs, options.concurrency, async ({ sourcePath, destinationPath }) => {
    const label = path.relative(inputRoot, sourcePath);
    try {
      const { before, after } = await resizeOne(sourcePath, destinationPath, options);
      savedBytes += before - after;
      console.log(`ok  ${label}  ${formatBytes(before)} -> ${formatBytes(after)}`);
    } catch (error) {
      failures += 1;
      console.error(`err ${label}  ${error.message}`);
    }
  });

  if (failures > 0) {
    throw new Error(`${failures} image(s) failed`);
  }
  console.log(`Done. Size change: ${formatBytes(Math.abs(savedBytes))} ${savedBytes >= 0 ? "smaller" : "larger"}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
