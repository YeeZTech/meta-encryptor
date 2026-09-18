#!/usr/bin/env node
/**
 * Decrypt throughput benchmark (MB/s).
 *
 * Modes:
 *   dsft    — read .decrypting, write separate out (DSFT DecryptAction layout)
 *   inplace — read/write same sealed file
 *   both    — run dsft then inplace (default)
 *
 * Usage:
 *   node scripts/bench-decrypt-throughput.cjs
 *   node scripts/bench-decrypt-throughput.cjs --size-mb=200 --runs=3 --mode=both
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
  const opts = { sizeMb: 200, runs: 3, mode: 'both' };
  for (const arg of argv) {
    if (arg.startsWith('--size-mb=')) {
      opts.sizeMb = Math.max(1, Number(arg.slice('--size-mb='.length)) || 200);
    } else if (arg.startsWith('--runs=')) {
      opts.runs = Math.max(1, Number(arg.slice('--runs='.length)) || 3);
    } else if (arg.startsWith('--mode=')) {
      const m = arg.slice('--mode='.length);
      if (!['dsft', 'inplace', 'both'].includes(m)) {
        throw new Error(`invalid --mode=${m}; use dsft|inplace|both`);
      }
      opts.mode = m;
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

function recoverableDecrypt(sealedPath, outputPath, progressPath) {
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

async function runOnce(workDir, plainPath, sizeBytes, mode) {
  const base = path.join(workDir, `bench_${mode}`);
  const progressPath = base + '.progress';
  let sealedPath;
  let outputPath;

  if (mode === 'dsft') {
    sealedPath = base + '.decrypting';
    outputPath = base;
  } else {
    sealedPath = base + '.sealed';
    outputPath = sealedPath; // inplace
  }

  for (const p of [sealedPath, outputPath, progressPath, `${progressPath}.tmp`]) {
    rmIfExists(p);
  }

  const sealStart = process.hrtime.bigint();
  await sealPlain(plainPath, sealedPath);
  const sealMs = Number(process.hrtime.bigint() - sealStart) / 1e6;

  const decryptStart = process.hrtime.bigint();
  await recoverableDecrypt(sealedPath, outputPath, progressPath);
  const decryptMs = Number(process.hrtime.bigint() - decryptStart) / 1e6;

  const plainMd5 = await md5File(plainPath);
  const outMd5 = await md5File(outputPath);
  if (plainMd5 !== outMd5) {
    throw new Error(`[${mode}] MD5 mismatch: plain=${plainMd5} out=${outMd5}`);
  }

  const sizeMb = sizeBytes / (1024 * 1024);
  return {
    mode,
    sizeMb,
    sealMs,
    decryptMs,
    sealMbPerSec: sizeMb / (sealMs / 1000),
    decryptMbPerSec: sizeMb / (decryptMs / 1000),
    progressFileBytes: fs.existsSync(progressPath)
      ? fs.statSync(progressPath).size
      : 0,
  };
}

function summarize(label, results) {
  const avg = (key) => results.reduce((s, x) => s + x[key], 0) / results.length;
  const vals = (key) => results.map((r) => r[key]);
  console.log(`\n${label}`);
  console.log(
    `  Decrypt: avg ${avg('decryptMbPerSec').toFixed(2)} MB/s ` +
      `(min ${Math.min(...vals('decryptMbPerSec')).toFixed(2)}, ` +
      `max ${Math.max(...vals('decryptMbPerSec')).toFixed(2)})`
  );
  console.log(`  Decrypt wall: avg ${avg('decryptMs').toFixed(1)} ms`);
  console.log(`  Seal (setup): avg ${avg('sealMbPerSec').toFixed(2)} MB/s`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      'Usage: node scripts/bench-decrypt-throughput.cjs [--size-mb=N] [--runs=N] [--mode=dsft|inplace|both]'
    );
    process.exit(0);
  }

  const modes =
    opts.mode === 'both' ? ['dsft', 'inplace'] : [opts.mode];
  const sizeBytes = Math.floor(opts.sizeMb * 1024 * 1024);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-decrypt-bench-'));
  const plainPath = path.join(workDir, 'plain.dat');

  console.log('meta-encryptor decrypt throughput benchmark');
  console.log('─'.repeat(56));
  console.log(`Node ${process.version} | ${process.platform} ${process.arch}`);
  console.log(`Plain size: ${opts.sizeMb} MiB (${sizeBytes} bytes)`);
  console.log(`Runs: ${opts.runs} | Modes: ${modes.join(', ')}`);
  console.log(`Work dir: ${workDir}`);
  console.log('Generating plain file...');

  const genStart = process.hrtime.bigint();
  generateFile(plainPath, sizeBytes);
  const genMs = Number(process.hrtime.bigint() - genStart) / 1e6;
  console.log(`Plain file ready in ${genMs.toFixed(0)} ms\n`);

  const byMode = {};
  for (const mode of modes) {
    byMode[mode] = [];
    for (let i = 0; i < opts.runs; i++) {
      const label = `[${mode}] ${i + 1}/${opts.runs}`;
      process.stdout.write(`${label}... `);
      const r = await runOnce(workDir, plainPath, sizeBytes, mode);
      byMode[mode].push(r);
      console.log(
        `decrypt ${r.decryptMbPerSec.toFixed(2)} MB/s (${r.decryptMs.toFixed(0)} ms), ` +
          `seal ${r.sealMbPerSec.toFixed(2)} MB/s`
      );
    }
  }

  console.log('\n' + '─'.repeat(56));
  console.log('Summary (decrypt = plain MiB / wall time):');
  for (const mode of modes) {
    summarize(
      mode === 'dsft' ? 'DSFT dual-path (.decrypting → out)' : 'Inplace (same file)',
      byMode[mode]
    );
  }
  if (modes.includes('dsft') && modes.includes('inplace')) {
    const d = byMode.dsft.reduce((s, x) => s + x.decryptMbPerSec, 0) / byMode.dsft.length;
    const i = byMode.inplace.reduce((s, x) => s + x.decryptMbPerSec, 0) / byMode.inplace.length;
    const delta = ((i - d) / d) * 100;
    console.log(
      `\nInplace vs DSFT: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% ` +
        `(${i.toFixed(2)} vs ${d.toFixed(2)} MB/s)`
    );
  }
  console.log('MD5: OK (all runs)');
  console.log('─'.repeat(56));

  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (_) {}
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
