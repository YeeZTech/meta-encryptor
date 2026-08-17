#!/usr/bin/env node
/**
 * Temporary benchmark — DSFT-style decrypt throughput (MB/s).
 * Exercises PipelineContextInFile atomic save during Recoverable decrypt.
 *
 * Usage:
 *   node scripts/bench-decrypt-throughput.cjs
 *   node scripts/bench-decrypt-throughput.cjs --size-mb=200 --runs=3
 *
 * Remove this script when no longer needed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { Sealer } = require('../src/node/Sealer.js');
const { Unsealer } = require('../src/node/Unsealer.js');
const { PipelineContextInFile } = require('../src/node/PipelineConext.js');
const {
  RecoverableReadStream,
  RecoverableWriteStream,
} = require('../src/node/Recoverable.js');

const KEY_PAIR = {
  private_key:
    '60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8',
  public_key:
    '731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca',
};

function parseArgs(argv) {
  const opts = { sizeMb: 100, runs: 1 };
  for (const arg of argv) {
    if (arg.startsWith('--size-mb=')) {
      opts.sizeMb = Math.max(1, Number(arg.slice('--size-mb='.length)) || 100);
    } else if (arg.startsWith('--runs=')) {
      opts.runs = Math.max(1, Number(arg.slice('--runs='.length)) || 1);
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

function generateFile(filePath, sizeBytes) {
  const chunk = Buffer.alloc(64 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = i % 256;
  const fd = fs.openSync(filePath, 'w');
  try {
    let written = 0;
    while (written < sizeBytes) {
      const n = Math.min(chunk.length, sizeBytes - written);
      fs.writeSync(fd, n === chunk.length ? chunk : chunk.subarray(0, n));
      written += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    fs.createReadStream(filePath)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function sealPlain(plainPath, sealedPath) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(plainPath);
    const ws = fs.createWriteStream(sealedPath);
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(new Sealer({ keyPair: KEY_PAIR })).pipe(ws);
  });
}

/** Same path layout as dianshu-file-transfer DecryptAction. */
function dsftStyleDecrypt(sealedPath, outputPath, progressPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const context = new PipelineContextInFile(progressPath);
      await context.loadContext();

      const rs = new RecoverableReadStream(sealedPath, context);
      const unsealer = new Unsealer({ keyPair: KEY_PAIR, context });
      const ws = new RecoverableWriteStream(outputPath, context);

      for (const s of [rs, unsealer, ws]) s.on('error', reject);
      rs.pipe(unsealer).pipe(ws);
      ws.on('finish', resolve);
    } catch (err) {
      reject(err);
    }
  });
}

function rmIfExists(p) {
  try {
    fs.unlinkSync(p);
  } catch (_) {}
}

async function runOnce(workDir, plainPath, sizeBytes) {
  const base = path.join(workDir, 'bench_out');
  const sealedPath = base + '.decrypting';
  const outputPath = base;
  const progressPath = base + '.progress';

  for (const p of [sealedPath, outputPath, progressPath, `${progressPath}.tmp`]) {
    rmIfExists(p);
  }

  const sealStart = process.hrtime.bigint();
  await sealPlain(plainPath, sealedPath);
  const sealMs = Number(process.hrtime.bigint() - sealStart) / 1e6;

  const decryptStart = process.hrtime.bigint();
  await dsftStyleDecrypt(sealedPath, outputPath, progressPath);
  const decryptMs = Number(process.hrtime.bigint() - decryptStart) / 1e6;

  const plainMd5 = await md5File(plainPath);
  const outMd5 = await md5File(outputPath);
  if (plainMd5 !== outMd5) {
    throw new Error(`MD5 mismatch: plain=${plainMd5} out=${outMd5}`);
  }

  const sizeMb = sizeBytes / (1024 * 1024);
  const decryptMbPerSec = sizeMb / (decryptMs / 1000);
  const sealMbPerSec = sizeMb / (sealMs / 1000);

  let progressSaves = 0;
  if (fs.existsSync(progressPath)) {
    progressSaves = 1;
  }

  return {
    sizeMb,
    sealMs,
    decryptMs,
    sealMbPerSec,
    decryptMbPerSec,
    progressFileBytes: fs.existsSync(progressPath)
      ? fs.statSync(progressPath).size
      : 0,
    progressSaves,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: node scripts/bench-decrypt-throughput.cjs [--size-mb=N] [--runs=N]`);
    process.exit(0);
  }

  const sizeBytes = Math.floor(opts.sizeMb * 1024 * 1024);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-decrypt-bench-'));
  const plainPath = path.join(workDir, 'plain.dat');

  console.log('meta-encryptor decrypt throughput benchmark');
  console.log('─'.repeat(56));
  console.log(`Node ${process.version} | ${process.platform} ${process.arch}`);
  console.log(`Plain size: ${opts.sizeMb} MiB (${sizeBytes} bytes)`);
  console.log(`Runs: ${opts.runs}`);
  console.log(`Work dir: ${workDir}`);
  console.log('Generating plain file...');

  const genStart = process.hrtime.bigint();
  generateFile(plainPath, sizeBytes);
  const genMs = Number(process.hrtime.bigint() - genStart) / 1e6;
  console.log(`Plain file ready in ${genMs.toFixed(0)} ms\n`);

  const results = [];
  for (let i = 0; i < opts.runs; i++) {
    const label = opts.runs > 1 ? `Run ${i + 1}/${opts.runs}` : 'Run';
    process.stdout.write(`${label}... `);
    const r = await runOnce(workDir, plainPath, sizeBytes);
    results.push(r);
    console.log(
      `decrypt ${r.decryptMbPerSec.toFixed(2)} MB/s (${r.decryptMs.toFixed(0)} ms), ` +
        `seal ${r.sealMbPerSec.toFixed(2)} MB/s`
    );
  }

  const avg = (arr, key) => arr.reduce((s, x) => s + x[key], 0) / arr.length;

  console.log('\n' + '─'.repeat(56));
  console.log('Summary (decrypt = plain MiB / wall time):');
  if (opts.runs === 1) {
    const r = results[0];
    console.log(`  Decrypt throughput: ${r.decryptMbPerSec.toFixed(2)} MB/s`);
    console.log(`  Decrypt wall time:  ${r.decryptMs.toFixed(1)} ms`);
    console.log(`  Seal throughput:    ${r.sealMbPerSec.toFixed(2)} MB/s (setup)`);
    console.log(`  Progress file size: ${r.progressFileBytes} bytes`);
  } else {
    console.log(
      `  Decrypt throughput: avg ${avg(results, 'decryptMbPerSec').toFixed(2)} MB/s ` +
        `(min ${Math.min(...results.map((r) => r.decryptMbPerSec)).toFixed(2)}, ` +
        `max ${Math.max(...results.map((r) => r.decryptMbPerSec)).toFixed(2)})`
    );
    console.log(`  Decrypt wall time:  avg ${avg(results, 'decryptMs').toFixed(1)} ms`);
    console.log(`  Seal throughput:    avg ${avg(results, 'sealMbPerSec').toFixed(2)} MB/s (setup)`);
  }
  console.log('  MD5: OK (all runs)');
  console.log('─'.repeat(56));

  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (_) {}
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
