// Service Worker for streaming decrypted data to a native download
// Protocol:
// - Page posts message { type: 'DOWNLOAD_PORT', id, name, size, path } with a MessagePort
// - SW replies on that port with { type: 'ready' }
// - Page navigates to `${path}?id=${id}` to trigger download
// - Page sends { type: 'chunk', data: Uint8Array } and finally { type: 'end' } via the port
// - SW responds to the fetch with a ReadableStream that relays the chunks

/* global self */

const downloads = new Map(); // id -> { port, name, size, path, buffer, controller, ended }

function safeName(name) {
	try {
		const n = (name || 'download.bin').toString();
		// Very simple sanitization
		return n.replace(/[\r\n\\"']/g, '_');
	} catch {
		return 'download.bin';
	}
}

self.addEventListener('install', (event) => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
	const data = event.data || {};
	if (data && data.type === 'DOWNLOAD_PORT') {
		const id = data.id;
		const port = event.ports && event.ports[0];
		const name = data.name || 'download.bin';
		const size = data.size;
		const path = data.path || '/__download_and_unseal__';
		if (!id || !port || !path) return;

		const entry = {
			port,
			name: safeName(name),
			size: typeof size === 'number' && isFinite(size) ? size : undefined,
			path,
			buffer: [],
			controller: null,
			ended: false,
		};

		// Buffer incoming data until a fetch attaches a stream controller
		port.onmessage = (ev) => {
			const msg = ev.data || {};
			if (msg.type === 'chunk') {
				const u8 = msg.data;
				if (entry.controller) {
					try { entry.controller.enqueue(u8); } catch {}
				} else {
					entry.buffer.push(u8);
				}
			} else if (msg.type === 'end') {
				entry.ended = true;
				if (entry.controller) {
					try { entry.controller.close(); } catch {}
				}
			} else if (msg.type === 'cancel') {
				try { entry.controller?.error?.(new Error('cancelled')); } catch {}
				downloads.delete(id);
			}
		};

		downloads.set(id, entry);
		try { port.postMessage({ type: 'ready' }); } catch {}
	}
});

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	const id = url.searchParams.get('id');
	if (!id) return; // Not our request

	const entry = downloads.get(id);
	if (!entry) return; // Unknown id

	// Ensure path matches to avoid hijacking arbitrary paths
	if (url.pathname !== entry.path) {
		// Not the exact path, ignore
		return;
	}

	event.respondWith((async () => {
		// Build a streaming response
		const headers = new Headers({
			'Content-Type': 'application/octet-stream',
			'Content-Disposition': `attachment; filename="${entry.name}"`,
			'Cache-Control': 'no-store',
		});
		if (typeof entry.size === 'number') {
			headers.set('Content-Length', String(entry.size));
		}

		const stream = new ReadableStream({
			start(controller) {
				entry.controller = controller;
				// Flush buffered chunks
				if (entry.buffer && entry.buffer.length) {
					try { for (const chunk of entry.buffer) controller.enqueue(chunk); } catch {}
					entry.buffer = [];
				}
				if (entry.ended) {
					try { controller.close(); } catch {}
					downloads.delete(id);
				}
			},
			cancel() {
				try { entry.port?.postMessage?.({ type: 'cancel' }); } catch {}
				downloads.delete(id);
			},
		});

		// Clean up when stream closes later
		const response = new Response(stream, { status: 200, headers });
		return response;
	})());
});

