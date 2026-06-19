import { unsealStream } from './UnsealerBrowser.js';

// Map of pending download requests: id -> { url, privateKeyHex, name }
const pending = new Map();

self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  // Expect { type: 'DOWNLOAD_REQUEST', id, name, payload: { url, privateKeyHex } }
  if (data.type === 'DOWNLOAD_REQUEST' && data.id && data.payload) {
    const { id, name } = data;
    const { url, privateKeyHex } = data.payload || {};
    if (url) {
      pending.set(id, { url, privateKeyHex, name: name || 'download.bin' });
    }
  }
});

function makeDisposition(filename) {
  const headers = new Headers();
  headers.set('Content-Type', 'application/octet-stream');
  const isAscii = /^[\u0020-\u007E]*$/.test(filename);
  if (isAscii) {
    try {
      headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    } catch (e) {
      headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    }
  } else {
    const safeFilename = filename.replace(/[^\u0020-\u007E]/g, '_');
    const encodedFilename = encodeURIComponent(filename);
    try {
      headers.set('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
    } catch (e) {
      headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodedFilename}`);
    }
  }
  return headers;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/download/unsealed' || url.pathname.endsWith('/download/unsealed')) {
    const id = url.searchParams.get('id');
    const meta = id && pending.get(id);
    if (!meta) {
      event.respondWith(new Response('download id not found', { status: 404 }));
      return;
    }
    // one-shot: remove mapping
    pending.delete(id);

    const headers = makeDisposition(meta.name || 'download.bin');

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const resp = await fetch(meta.url);
          if (!resp.ok) {
            controller.error(new Error('upstream HTTP status ' + resp.status));
            return;
          }
          // Use unsealStream to push plaintext chunks into controller
          await unsealStream(resp, {
            privateKeyHex: meta.privateKeyHex,
            onChunk: async (plain) => {
              controller.enqueue(plain instanceof Uint8Array ? plain : new Uint8Array(plain));
            }
          });
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        // noop
      }
    });

    event.respondWith(new Response(stream, { headers }));
  }
});
