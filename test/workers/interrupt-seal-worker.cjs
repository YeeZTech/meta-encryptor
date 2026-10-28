'use strict';
/**
 * Cross-process seal interrupt worker for SealerResumeSigkill.spec.js
 * （与 interrupt-decrypt-worker.cjs 对称）。
 *
 * Protocol (stdout lines prefixed with WORKER_JSON:):
 *   { event: "ready" }
 *   { event: "started" }
 *   { event: "mid-seal", bytes }    — sealer 进度（已封装字节，含续传基线）越过 midSealedBytes
 *   { event: "completed" }
 *   { event: "graceful-exit" }      — SIGTERM 后暂停（unpipe + ws.end）
 *
 * Args: <configJsonPath>
 * Config: {
 *   srcPath, outPath, contextPath,
 *   mode: "kill" | "graceful",
 *   midSealedBytes?: number,  // default 256KiB
 *   transcodeLike?: boolean,  // 输入从源头读（不对齐分片）+ Sealer skipCommittedInput
 *   contextOptions?: { saveFrequency?, strongConsistency?, minSaveIntervalMs? },
 *   writeStreamOptions?: { maxInflightBytes?, highWaterMark? },
 *   privateKey, publicKey
 * }
 *
 * Requires build/commonjs (npm run build).
 */
const fs = require('fs');

const meta = require('../../build/commonjs/index.node.cjs');
const {
  PipelineContextInFile,
  RecoverableSourceStream,
  RecoverableWriteStream,
  Sealer,
} = meta;

function emit(obj) {
  // eslint-disable-next-line no-console
  console.log('WORKER_JSON:' + JSON.stringify(obj));
}

function pauseSealPipeline(rs, sealer, ws) {
  rs.unpipe(sealer);
  sealer.unpipe(ws);
  rs.destroy();
  sealer.destroy();
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
  const midSealedBytes = cfg.midSealedBytes || 256 * 1024;
  const keyPair = {
    private_key: cfg.privateKey,
    public_key: cfg.publicKey,
  };

  let shuttingDown = false;
  let midEmitted = false;

  const context = new PipelineContextInFile(cfg.contextPath, cfg.contextOptions || {});
  await context.loadContext({ sourcePath: cfg.srcPath, outputPath: cfg.outPath });

  const progressHandler = (_total, _items, _bytes, sealedBytes) => {
    if (midEmitted || shuttingDown) return;
    if (sealedBytes >= midSealedBytes) {
      midEmitted = true;
      emit({ event: 'mid-seal', bytes: sealedBytes });
    }
  };

  const rs = cfg.transcodeLike
    ? fs.createReadStream(cfg.srcPath, { highWaterMark: 100000 })
    : new RecoverableSourceStream(cfg.srcPath, context);
  const sealer = new Sealer({
    keyPair,
    context,
    progressHandler,
    skipCommittedInput: !!cfg.transcodeLike,
  });
  const ws = new RecoverableWriteStream(cfg.outPath, context, cfg.writeStreamOptions || undefined);

  const gracefulShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await pauseSealPipeline(rs, sealer, ws);
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
  }

  emit({ event: 'ready' });
  emit({ event: 'started' });

  const onError = (err) => {
    if (shuttingDown) return;
    emit({ event: 'error', error: String(err && err.message ? err.message : err) });
  };
  rs.on('error', onError);
  sealer.on('error', onError);
  ws.on('error', onError);

  rs.pipe(sealer).pipe(ws);

  await new Promise((resolve) => {
    ws.on('finish', () => {
      emit({ event: 'completed' });
      resolve();
    });
  });

  if (cfg.mode === 'kill') {
    // Stay alive until parent SIGKILL
    await new Promise(() => {});
  }
}

main().catch((e) => {
  emit({ event: 'fatal', error: String(e && e.stack ? e.stack : e) });
  process.exit(1);
});
