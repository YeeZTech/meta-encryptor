import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-encryptor-pack-'));

function run(command, args, cwd = repoRoot) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function runNpm(args, cwd = repoRoot, npmExecPath = process.env.npm_execpath) {
  if (!npmExecPath) {
    throw new Error('Unable to locate the current npm CLI. Run this check with "npm run verify:pack".');
  }
  return run(process.execPath, [npmExecPath, ...args], cwd);
}

try {
  const packInfo = JSON.parse(runNpm(['pack', '--json', '--pack-destination', tempRoot]));
  const entry = packInfo[0];
  const names = new Set(entry.files.map((file) => file.path));
  for (const required of ['index.node.d.ts', 'index.browser.d.ts', 'LICENSE']) {
    if (!names.has(required)) throw new Error(`Published package is missing ${required}`);
  }

  const tarball = path.join(tempRoot, entry.filename);
  const consumer = path.join(tempRoot, 'consumer');
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: { '@yeez-tech/meta-encryptor': `file:${tarball}` },
  }, null, 2));
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);

  run(process.execPath, ['--input-type=module', '-e',
    "import { Sealer } from '@yeez-tech/meta-encryptor/node'; if (typeof Sealer !== 'function') process.exit(1);"
  ], consumer);
  run(process.execPath, ['-e',
    "const m=require('@yeez-tech/meta-encryptor/node'); if(typeof m.Sealer!=='function') process.exit(1);"
  ], consumer);

  fs.writeFileSync(path.join(consumer, 'browser-consumer.ts'), [
    "import { downloadUnsealed, HttpSealedFileStream } from '@yeez-tech/meta-encryptor/browser';",
    "void HttpSealedFileStream;",
    "void downloadUnsealed({ url: 'https://example.test/file', privateKey: '00', filename: 'x' });",
  ].join('\n'));
  fs.writeFileSync(path.join(consumer, 'node-consumer.ts'), [
    "import { Sealer, type KeyPair } from '@yeez-tech/meta-encryptor/node';",
    "const keyPair: KeyPair = { private_key: '00', public_key: '00' };",
    "void new Sealer({ keyPair });",
  ].join('\n'));
  fs.writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM'],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    files: ['browser-consumer.ts', 'node-consumer.ts'],
  }, null, 2));
  run(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], consumer);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
