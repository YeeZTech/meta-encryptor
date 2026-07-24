'use strict';
/**
 * Cross-process decrypt interrupt worker for Recoverable.spec.js.
 *
 * Protocol (stdout lines prefixed with WORKER_JSON:):
 *   { event: "ready" }
 *   { event: "started" }
 *   { event: "mid-decrypt", bytes }
 *   { event: "graceful-exit" }  — after pause (unpipe + ws.end) on SIGTERM
 *
 * Args: <configJsonPath>
 * Config: {
 *   sealedPath, outPath, contextPath,
 *   mode: "kill" | "graceful",
 *   midPlainBytes?: number,   // default 256KiB
 *   privateKey, publicKey
 * }
 *
 * Requires build/commonjs (npm run build).
 */
const fs = require('fs');

const meta = require('../../build/commonjs/index.node.cjs');
const {
  PipelineContextInFile,
  RecoverableReadStream,
  RecoverableWriteStream,
  Unsealer,
} = meta;

function emit(obj) {
  // eslint-disable-next-line no-console
  console.log('WORKER_JSON:' + JSON.stringify(obj));
}

function pauseDecryptPipeline(rs, unsealer, ws) {
  rs.unpipe(unsealer);
  unsealer.unpipe(ws);
  rs.destroy();
  unsealer.destroy();
  return new Promise((resolve, reject) => {
    ws.end((err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath || !fs.existsSync(configPath)) {
    throw new Error(`config not found: ${configPath}`);
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const midPlainBytes = cfg.midPlainBytes || 256 * 1024;
  const keyPair = {
    private_key: cfg.privateKey,
    public_key: cfg.publicKey,
  };

  for (const p of [cfg.outPath, cfg.contextPath, cfg.contextPath + '.tmp']) {
    try {
      fs.unlinkSync(p);
    } catch (_) {
      /* ignore */
    }
  }

  const context = new PipelineContextInFile(cfg.contextPath);
  await context.loadContext();

  let rs = new RecoverableReadStream(cfg.sealedPath, context);
  let unsealer = new Unsealer({ keyPair, context });
  let ws = new RecoverableWriteStream(cfg.outPath, context);

  let shuttingDown = false;
  let midEmitted = false;

  const gracefulShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await pauseDecryptPipeline(rs, unsealer, ws);
      emit({ event: 'graceful-exit' });
      process.exit(0);
    } catch (e) {
      emit({ event: 'graceful-exit-error', error: String(e) });
      process.exit(1);
    }
  };

  if (cfg.mode === 'graceful') {
    process.on('SIGTERM', () => {
      void gracefulShutdown();
    });
    process.on('SIGINT', () => {
      void gracefulShutdown();
    });
  }

  emit({ event: 'ready' });
  emit({ event: 'started' });

  const poll = setInterval(() => {
    if (midEmitted || shuttingDown) return;
    try {
      if (fs.existsSync(cfg.outPath)) {
        const bytes = fs.statSync(cfg.outPath).size;
        if (bytes >= midPlainBytes) {
          midEmitted = true;
          emit({ event: 'mid-decrypt', bytes });
        }
      }
    } catch (_) {
      /* ignore */
    }
  }, 20);

  const onError = (err) => {
    if (shuttingDown) return;
    emit({ event: 'error', error: String(err && err.message ? err.message : err) });
  };
  rs.on('error', onError);
  unsealer.on('error', onError);
  ws.on('error', onError);

  rs.pipe(unsealer).pipe(ws);

  await new Promise((resolve) => {
    ws.on('finish', () => {
      emit({ event: 'completed' });
      resolve();
    });
  });

  clearInterval(poll);

  if (cfg.mode === 'kill') {
    // Stay alive until parent SIGKILL (should normally be killed at mid-decrypt)
    await new Promise(() => {});
  }
}

main().catch((e) => {
  emit({ event: 'fatal', error: String(e && e.stack ? e.stack : e) });
  process.exit(1);
});
