// Same-origin Service Worker to stream decrypted data as a downloadable attachment
// Frontend will post a MessagePort with an ID; SW responds to a fetch on /example/browser/download/unsealed?id=ID
// and pipes chunks received via MessagePort into the Response stream with proper headers.

/* eslint-disable no-undef */
const downloads = new Map(); // id -> { port, name, size }

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'DOWNLOAD_PORT' && event.ports && event.ports[0]) {
    const { id, name, size } = data;
    downloads.set(id, { port: event.ports[0], name: name || 'download.bin', size: size || null });
    try { event.ports[0].postMessage({ type: 'ready', id }); } catch (e) {}
  }
});

function streamFromPort(meta){
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${meta.name}"`
  });
  if (meta.size && Number.isFinite(meta.size)) {
    headers.set('Content-Length', String(meta.size));
  }
  return new Response(new ReadableStream({
    start(controller){
      const port = meta.port;
      port.onmessage = (ev)=>{
        const msg = ev.data || {};
        if (msg.type === 'chunk'){
          let src = msg.data;
          if (src && !(src instanceof Uint8Array) && src.buffer){
            src = new Uint8Array(src.buffer, src.byteOffset||0, src.byteLength||src.length||0);
          }
          // Create a fresh copy to ensure the buffer is not detached by transfer
          const chunk = (src && src.byteLength) ? new Uint8Array(src) : new Uint8Array();
          controller.enqueue(chunk);
        } else if (msg.type === 'end'){
          controller.close();
          port.close();
        } else if (msg.type === 'error'){
          controller.error(new Error(msg.message||'download error'));
          port.close();
        }
      };
      try{ port.start && port.start(); }catch(e){}
    },
    cancel(){ try{ meta.port.postMessage({ type:'cancel' }); }catch(e){} }
  }), { headers });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/example/browser/download/unsealed'){
    const id = url.searchParams.get('id');
    const meta = id && downloads.get(id);
    if (!meta){
      event.respondWith(new Response('download id not found', { status: 404 }));
      return;
    }
    // one-shot, clean up after start
    downloads.delete(id);
    event.respondWith(streamFromPort(meta));
  }
});
