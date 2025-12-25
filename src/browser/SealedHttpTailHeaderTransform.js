// Reorder a sealed file whose header sits at tail into a header-first stream for UnsealerBrowser
// Layout: [content][block_infos][header(64B)]
// header format (little-endian): magic(8) | version(8) | block_number(8) | item_number(8) | data_hash(32)
const HEADER_SIZE = 64;
const BLOCK_INFO_SIZE = 32; // each block info entry size
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB

function readUint64LE(buf, offset){
  // buf: Uint8Array
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if(dv.getBigUint64){
    return Number(dv.getBigUint64(offset, true));
  }
  // Fallback manual
  let val = 0;
  for(let i=0;i<8;i++) val += buf[offset+i] * 2**(8*i);
  return val;
}

async function fetchSealedHeaderFirst(url, opts={}){
  const { log = console.log, chunked=false, chunkSize=DEFAULT_CHUNK_SIZE } = opts;
  log('[TailHeader] HEAD 请求: ', url);
  let totalSize = null;
  try{
    const headResp = await fetch(url, {method:'HEAD'});
    if(headResp.ok){
      const sizeHeader = headResp.headers.get('Content-Length');
      if(sizeHeader) totalSize = Number(sizeHeader);
    }
  }catch(e){ /* ignore */ }
  // helper: parse total from Content-Range
  const parseTotal = (cr)=>{ if(!cr) return null; const m = /\/([0-9]+)$/.exec(cr); return m? Number(m[1]) : null; };
  // If missing, try suffix range to retrieve header and total
  let headerBuf = null;
  if(totalSize == null){
    log('[TailHeader] 无 Content-Length，使用后缀 Range 探测');
    const tailProbe = await fetch(url, { headers:{ Range: `bytes=-${HEADER_SIZE}` }});
    if(tailProbe.status === 206){
      totalSize = parseTotal(tailProbe.headers.get('Content-Range'));
      headerBuf = new Uint8Array(await tailProbe.arrayBuffer());
    }
  }
  // If still unknown, do a 0-0 probe to get total then fetch tail header
  if(totalSize == null){
    const probe = await fetch(url, { headers:{ Range: 'bytes=0-0' }});
    if(probe.status !== 206) throw new Error('无法获取 Content-Length');
    totalSize = parseTotal(probe.headers.get('Content-Range'));
  }
  log('[TailHeader] totalSize =', totalSize);
  if(!Number.isFinite(totalSize) || totalSize < HEADER_SIZE) throw new Error('文件大小异常');

  let headerStart = totalSize - HEADER_SIZE;
  if(!headerBuf){
    log('[TailHeader] 读取尾部 header range=', headerStart, '-', totalSize-1);
    const headerResp = await fetch(url, { headers:{ Range: `bytes=${headerStart}-${totalSize-1}` }});
    if(!(headerResp.status === 206 || headerResp.status === 200)) throw new Error('获取尾部 header 失败: HTTP '+headerResp.status);
    headerBuf = new Uint8Array(await headerResp.arrayBuffer());
  }
  if(headerBuf.length !== HEADER_SIZE) throw new Error('尾部 header 长度不符');
  const blockNumber = readUint64LE(headerBuf, 16);
  const contentSize = totalSize - HEADER_SIZE - BLOCK_INFO_SIZE * blockNumber;
  log('[TailHeader] blockNumber=', blockNumber, 'contentSize=', contentSize);
  if(contentSize <= 0) throw new Error('计算得到 contentSize <= 0');

  if(!chunked){
    const contentEnd = contentSize - 1;
    log('[TailHeader] 单次获取内容区 range=0-', contentEnd);
    const contentResp = await fetch(url, { headers:{ Range: `bytes=0-${contentEnd}` }});
    if(!(contentResp.status === 206 || contentResp.status === 200)) throw new Error('获取内容区失败: HTTP '+contentResp.status);
    if(!contentResp.body) throw new Error('内容区无 body');
    const reader = contentResp.body.getReader();
    let fetchedBytes = 0;
    const combinedStream = new ReadableStream({
      async start(controller){ controller.enqueue(headerBuf); },
      async pull(controller){
        const {done, value} = await reader.read();
        if(done){ log('[TailHeader] 内容区读取完成 fetchedBytes=', fetchedBytes); controller.close(); return; }
        fetchedBytes += value.length;
        if(fetchedBytes % (16*1024*1024) < value.length){ // 每 ~16MB 打点
          log('[TailHeader] 进度 fetched=', fetchedBytes, '/', contentSize);
        }
        controller.enqueue(value);
      },
      cancel(reason){ reader.cancel(reason); }
    });
    return new Response(combinedStream, { headers:{ 'Content-Type':'application/octet-stream' } });
  }

  // 分块模式
  log('[TailHeader] 分块模式 chunkSize=', chunkSize);
  let offset = 0;
  const combinedStream = new ReadableStream({
    headerSent:false,
    async pull(controller){
      if(!this.headerSent){ controller.enqueue(headerBuf); this.headerSent = true; return; }
      if(offset >= contentSize){ controller.close(); return; }
      const end = Math.min(offset + chunkSize - 1, contentSize - 1);
      const rangeHeader = `bytes=${offset}-${end}`;
      log('[TailHeader] 请求分块 range=', rangeHeader);
      const partResp = await fetch(url, { headers:{ Range: rangeHeader }});
      if(!(partResp.status === 206 || partResp.status === 200)) throw new Error('分块获取失败 HTTP '+partResp.status);
      const partBuf = new Uint8Array(await partResp.arrayBuffer());
      controller.enqueue(partBuf);
      offset = end + 1;
      if(offset % (16*1024*1024) < partBuf.length){
        log('[TailHeader] 进度 offset=', offset, '/', contentSize);
      }
    }
  });
  return new Response(combinedStream, { headers:{ 'Content-Type':'application/octet-stream' } });
}

export async function prepareSealedResponse(url, opts={}){
  try{
    return await fetchSealedHeaderFirst(url, opts);
  }catch(e){
    const { log = console.log } = opts;
    log('[TailHeader] 回退直接 fetch:', e.message);
    return await fetch(url, { cache:'no-store' });
  }
}