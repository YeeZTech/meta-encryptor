/* Minimal SW placeholder for StreamSaver. The library can also inject its own SW; this file is here
   to keep the scope consistent and avoid cross-origin MITM.
*/
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { self.clients.claim(); });
// The StreamSaver library will handle the message channel with the page and pipe
// the stream through a MessagePort to the SW for native download handling.
