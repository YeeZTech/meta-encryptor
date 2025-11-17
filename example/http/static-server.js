import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { createRequire } from 'module';
import ByteBufferPkg from 'bytebuffer';
import { pipeline } from 'stream';
import { promisify } from 'util';
import crypto from 'crypto';
const pipe = promisify(pipeline);

// Serve the repository root so that /example/browser/index.html can import ../../src/browser/*.js
const ROOT = path.resolve(process.cwd());
const BASE_PORT = Number(process.env.PORT) || 8088;

function send(res, code, headers, body){
  res.writeHead(code, headers); res.end(body);
}

function mime(file){
  if(file.endsWith('.html')) return 'text/html; charset=utf-8';
  if(file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if(file.endsWith('.css')) return 'text/css; charset=utf-8';
  if(file.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

const server = http.createServer(async (req, res)=>{
  console.log(`[req] ${req.method} ${req.url}`);
  const parsed = url.parse(req.url);
  let pathname = decodeURIComponent(parsed.pathname || '/');
  // health check
  if(req.method === 'GET' && (pathname === '/healthz' || pathname === '/.health')){
    res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-cache','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({ ok: true, root: ROOT }));
    return;
  }
  // API: generate sample sealed stream and keys
  if(req.method === 'GET' && pathname === '/api/gen'){
    const outDir = path.join(ROOT, 'example', 'browser');
    try{
      const builtPath = path.join(ROOT, 'build', 'commonjs', 'index.cjs');
      if(!fs.existsSync(builtPath)){
        return send(res, 500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, JSON.stringify({error:'build_missing', message:'build/commonjs/index.cjs not found. Please run `yarn build`.'}));
      }
      const require = createRequire(import.meta.url);
      const built = require(builtPath);
  const { Sealer, Unsealer, YPCCrypto } = built;

      const ByteBuffer = ByteBufferPkg.default || ByteBufferPkg; const LITTLE_ENDIAN = ByteBuffer.LITTLE_ENDIAN;
      const HeaderSize = 64; const BlockInfoSize = 32;
      const sk = YPCCrypto.generatePrivateKey();
      const pk = YPCCrypto.generatePublicKeyFromPrivateKey(sk);
      const keyPair = { private_key: sk.toString('hex'), public_key: pk.toString('hex') };
      if(!fs.existsSync(outDir)) fs.mkdirSync(outDir, {recursive:true});
      const sealedPath = path.join(outDir, 'sealed_full.bin');
      const streamPath = path.join(outDir, 'stream.bin');
      const keyPath = path.join(outDir, 'keys.json');

  // parse size param (bytes); default 1 MiB
      const query = new url.URL(req.url, `http://${req.headers.host}`).searchParams;
  const sizeParam = query.get('size');
  const targetBytes = Math.max(1, Number(sizeParam || (1024*1024)));

      // stream-seal to sealed_full.bin to avoid memory blow
      const ws = fs.createWriteStream(sealedPath);
      const baseLine = 'The quick brown fox jumps over the lazy dog. 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz\n';
      const unit = baseLine.repeat(1024); // ~ 1024 lines chunk base
      const unitBuf = Buffer.from(unit, 'utf8');
  const sealer = new Sealer({ keyPair });
  const plainHash = crypto.createHash('sha256');
      sealer.on('error', (e)=> console.error('[gen][sealer] error', e));
      sealer.pipe(ws);
      let generated = 0;
      while(generated < targetBytes){
        const remain = targetBytes - generated;
  const chunk = remain >= unitBuf.length ? unitBuf : unitBuf.subarray(0, remain);
  plainHash.update(chunk);
        sealer.write(chunk);
        generated += chunk.length;
        if(generated % (unitBuf.length * 64) === 0){
          await new Promise(r=>setImmediate(r));
        }
      }
      sealer.end();
      await new Promise((resolve)=> ws.on('finish', resolve));

      // Read header/footer to build stream.bin as [header][content]
  const stats = fs.statSync(sealedPath);
  console.log('[gen] sealed_full.bin size', stats.size, 'requested', targetBytes);
      if(stats.size <= HeaderSize) throw new Error('invalid sealed file size');
      const headerBuf = Buffer.alloc(HeaderSize);
      const fd = fs.openSync(sealedPath, 'r');
      try{
        fs.readSync(fd, headerBuf, 0, HeaderSize, stats.size - HeaderSize);
      } finally { fs.closeSync(fd); }
      const bb = ByteBuffer.wrap(headerBuf, LITTLE_ENDIAN);
      const block_number = bb.readUint64(16).toNumber();
      const contentSize = stats.size - HeaderSize - BlockInfoSize * block_number;
      if(contentSize <= 0) throw new Error('computed contentSize <= 0');

      // stream build stream.bin without loading all data
      const ws2 = fs.createWriteStream(streamPath);
      await new Promise((resolve, reject)=>{
        ws2.write(headerBuf, (err)=>{ if(err) reject(err); else resolve(); });
      });
      const rsContent = fs.createReadStream(sealedPath, { start: 0, end: contentSize - 1 });
      await pipe(rsContent, ws2);

      fs.writeFileSync(keyPath, JSON.stringify(keyPair, null, 2));

      const base = `${parsed.protocol||'http:'}//${req.headers.host}`;
      const data = {
        ok: true,
        keys: keyPair,
        files: {
          sealed_full: `${base}/example/browser/sealed_full.bin`,
          stream: `${base}/example/browser/stream.bin`,
          keys: `${base}/example/browser/keys.json`
        },
        size: { requestedBytes: targetBytes, sealedBytes: stats.size, contentBytes: contentSize },
        plain_sha256: plainHash.digest('hex')
      };
      return send(res, 200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, JSON.stringify(data));
    }catch(e){
      return send(res, 500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, JSON.stringify({error:'gen_failed', message: e.message}));
    }
  }

  // API: stream plain content of requested size for verification
  if(req.method === 'GET' && pathname === '/api/plain'){
    try{
      const query = new url.URL(req.url, `http://${req.headers.host}`).searchParams;
      const sizeParam = query.get('size');
      const targetBytes = Math.max(0, Number(sizeParam || 0));
      const unit = 'The quick brown fox jumps over the lazy dog. 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz\n';
      const unitBuf = Buffer.from(unit, 'utf8');
      let sent = 0;
      res.writeHead(200, {'Content-Type':'application/octet-stream','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});
      const writeChunk = async ()=>{
        while(sent < targetBytes){
          const remain = targetBytes - sent;
          const chunk = remain >= unitBuf.length ? unitBuf : unitBuf.subarray(0, remain);
          if(!res.write(chunk)){
            await new Promise(r=>res.once('drain', r));
          }
          sent += chunk.length;
        }
        res.end();
      };
      writeChunk();
      return;
    }catch(e){
      return send(res, 500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, JSON.stringify({ok:false, error:'plain_failed', message: e.message}));
    }
  }
  // API: unseal previously generated sealed_full.bin via Unsealer and stream plaintext
  if(req.method === 'GET' && pathname === '/api/unseal'){
    try{
      const outDir = path.join(ROOT, 'example', 'browser');
      const sealedPath = path.join(outDir, 'sealed_full.bin');
      const keyPath = path.join(outDir, 'keys.json');
      if(!fs.existsSync(sealedPath) || !fs.existsSync(keyPath)){
        return send(res, 400, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, JSON.stringify({ok:false, error:'missing_files', message:'sealed_full.bin 或 keys.json 不存在, 请先调用 /api/gen'}));
      }
      const require = createRequire(import.meta.url);
      const builtPath = path.join(ROOT, 'build', 'commonjs', 'index.cjs');
      const built = require(builtPath);
      const { Unsealer, SealedFileStream } = built;
      const keyPair = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      res.writeHead(200, {'Content-Type':'application/octet-stream','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});
      const sealedStream = new SealedFileStream(sealedPath);
      const unsealer = new Unsealer({ keyPair, progressHandler: (total, processed)=>{ if(processed === total){ console.log('[unseal] 完成 total='+total); } }});
      unsealer.on('error', (e)=>{ console.error('[unseal] error', e); try{ res.write(JSON.stringify({ok:false,error:e.message})); }catch(_){} res.end(); sealedStream.destroy(); });
      sealedStream.on('error', (e)=>{ console.error('[sealedStream] error', e); unsealer.destroy(e); });
      sealedStream.pipe(unsealer).pipe(res);
      return;
    }catch(e){
      return send(res, 500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, JSON.stringify({ok:false, error:'unseal_failed', message:e.message}));
    }
  }
  // API: clean generated files
  if(req.method === 'POST' && pathname === '/api/clean'){
    const outDir = path.join(ROOT, 'example', 'browser');
    const files = ['sealed_full.bin','stream.bin','keys.json'];
    const removed = [];
    for(const f of files){
      const p = path.join(outDir, f);
      try{ if(fs.existsSync(p)){ fs.unlinkSync(p); removed.push(f); } }catch(e){ /* ignore */ }
    }
    return send(res, 200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, JSON.stringify({ok:true, removed}));
  }

  if(pathname === '/') pathname = '/';
  const filePath = path.join(ROOT, pathname);
  const cors = {'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'};
  fs.stat(filePath, (err, stat)=>{
    if(err){
      return send(res, 404, {...cors}, 'Not Found');
    }
    if(stat.isDirectory()){
      const idx = path.join(filePath, 'index.html');
      if(fs.existsSync(idx)){
        const stream = fs.createReadStream(idx);
        res.writeHead(200, {...cors, 'Content-Type': mime(idx)});
        return stream.pipe(res);
      }
      return send(res, 403, {...cors}, 'Forbidden');
    }
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, {...cors, 'Content-Type': mime(filePath)});
    stream.pipe(res);
  });
});

function listenWithFallback(startPort, maxAttempts = 20){
  return new Promise((resolve, reject)=>{
    let port = startPort;
    const tryListen = () => {
      server.once('error', (err)=>{
        if(err && err.code === 'EADDRINUSE' && maxAttempts > 0){
          console.warn(`[static-server] Port ${port} in use, trying ${port+1}...`);
          maxAttempts -= 1; port += 1;
          setTimeout(()=> server.listen(port), 50);
        } else {
          reject(err);
        }
      });
      server.once('listening', ()=>{
        console.log(`[static-server] Serving ${ROOT} at http://localhost:${port}/`);
        resolve(port);
      });
      server.listen(port);
    };
    tryListen();
  });
}

listenWithFallback(BASE_PORT).catch(err=>{
  console.error('[static-server] Failed to start:', err?.message||err);
  process.exit(1);
});
