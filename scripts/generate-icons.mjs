import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(rootDir, 'build');
const sourcePng = join(buildDir, 'icon.png');
const sourceSvg = join(buildDir, 'icon.svg');
const icnsPath = join(buildDir, 'icon.icns');
const icoPath = join(buildDir, 'icon.ico');

const icnsTypes = new Map([
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10']
]);
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icnsSizes = [16, 32, 64, 128, 256, 512, 1024];

function run(command, args) {
  execFileSync(command, args, { stdio: 'pipe' });
}

function resizePng(size, outputPath) {
  run('sips', ['-z', String(size), String(size), sourcePng, '--out', outputPath]);
}

function buildIcns(buffers) {
  const chunks = buffers.map(({ size, data }) => {
    const type = icnsTypes.get(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });

  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(totalLength, 4);
  return Buffer.concat([header, ...chunks]);
}

function buildIco(buffers) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(buffers.length, 4);

  const directory = Buffer.alloc(buffers.length * 16);
  let offset = header.length + directory.length;

  buffers.forEach(({ size, data }, index) => {
    const entryOffset = index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, entryOffset);
    directory.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    directory.writeUInt8(0, entryOffset + 2);
    directory.writeUInt8(0, entryOffset + 3);
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(data.length, entryOffset + 8);
    directory.writeUInt32LE(offset, entryOffset + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...buffers.map(({ data }) => data)]);
}

if (!existsSync(sourcePng)) {
  throw new Error(`Missing source PNG: ${sourcePng}`);
}

if (!existsSync(sourceSvg)) {
  throw new Error(`Missing source SVG: ${sourceSvg}`);
}

const tempDir = mkdtempSync(join(tmpdir(), 'coursecode-icon-'));

try {
  const icnsBuffers = icnsSizes.map((size) => {
    const pngPath = join(tempDir, `icon-${size}.png`);
    resizePng(size, pngPath);
    return { size, data: readFileSync(pngPath) };
  });

  const icoBuffers = icoSizes.map((size) => {
    const pngPath = join(tempDir, `icon-${size}.png`);
    resizePng(size, pngPath);
    return { size, data: readFileSync(pngPath) };
  });

  writeFileSync(icnsPath, buildIcns(icnsBuffers));
  writeFileSync(icoPath, buildIco(icoBuffers));
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
