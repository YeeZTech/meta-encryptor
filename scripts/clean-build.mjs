import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const buildDir = path.resolve(root, 'build');
if (path.dirname(buildDir) !== path.resolve(root)) {
  throw new Error(`Refusing to clean unexpected build directory: ${buildDir}`);
}
fs.rmSync(buildDir, { recursive: true, force: true });
