import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const src = join(__dirname, '../src/browser/sw-download.js');
const destDir = join(__dirname, '../build/browser');
const dest = join(destDir, 'sw-download.js');

if (!existsSync(destDir)) {
  mkdirSync(destDir, { recursive: true });
}

if (existsSync(src)) {
  copyFileSync(src, dest);
  console.log('[Build] Copied sw-download.js to build/browser/');
} else {
  console.warn('[Build] Source file not found:', src);
  process.exit(1);
}

