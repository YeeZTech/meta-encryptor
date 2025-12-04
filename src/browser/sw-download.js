// Same-origin Service Worker to stream decrypted data as a downloadable attachment
// Frontend will post a MessagePort with an ID; SW responds to a fetch on /download/unsealed?id=ID
// and pipes chunks received via MessagePort into the Response stream with proper headers.

/* eslint-disable no-undef */
const downloads = new Map(); // id -> { port, name, size }

self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "DOWNLOAD_PORT" && event.ports && event.ports[0]) {
    const { id, name, size } = data;
    downloads.set(id, {
      port: event.ports[0],
      name: name || "download.bin",
      size: size || null,
    });
    try {
      event.ports[0].postMessage({ type: "ready", id });
    } catch (e) {
      // Ignore postMessage errors (port may already be closed)
    }
  }
});

function streamFromPort(meta) {
  // 处理文件名编码：避免 ISO-8859-1 编码错误
  // 对于包含非 ASCII 字符的文件名，需要特殊处理
  const headers = new Headers();
  headers.set("Content-Type", "application/octet-stream");

  // 安全地设置 Content-Disposition header
  // 检查文件名是否只包含可打印的 ASCII 字符（0x20-0x7E）和控制字符除外
  // 避免使用控制字符 \x00-\x1F，因为文件名不应该包含这些
  const isAscii = /^[\u0020-\u007E]*$/.test(meta.name);

  if (isAscii) {
    // 纯 ASCII 文件名，可以直接使用
    try {
      headers.set("Content-Disposition", `attachment; filename="${meta.name}"`);
    } catch (e) {
      // 如果仍然失败，使用 URL 编码
      const encoded = encodeURIComponent(meta.name);
      headers.set(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encoded}`
      );
    }
  } else {
    // 包含非 ASCII 字符，使用 RFC 5987 编码格式
    // 提供两个版本：ASCII 安全版本和 UTF-8 编码版本
    // 将非可打印 ASCII 字符替换为下划线
    const safeFilename = meta.name.replace(/[^\u0020-\u007E]/g, "_");
    const encodedFilename = encodeURIComponent(meta.name);
    try {
      headers.set(
        "Content-Disposition",
        `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
      );
    } catch (e) {
      // 如果设置失败，只使用 UTF-8 编码版本
      headers.set(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodedFilename}`
      );
    }
  }

  if (meta.size && Number.isFinite(meta.size)) {
    headers.set("Content-Length", String(meta.size));
  }
  return new Response(
    new ReadableStream({
      start(controller) {
        const port = meta.port;
        port.onmessage = (ev) => {
          const msg = ev.data || {};
          if (msg.type === "chunk") {
            let src = msg.data;
            if (src && !(src instanceof Uint8Array) && src.buffer) {
              src = new Uint8Array(
                src.buffer,
                src.byteOffset || 0,
                src.byteLength || src.length || 0
              );
            }
            // Create a fresh copy to ensure the buffer is not detached by transfer
            const chunk =
              src && src.byteLength ? new Uint8Array(src) : new Uint8Array();
            controller.enqueue(chunk);
          } else if (msg.type === "end") {
            controller.close();
            port.close();
          } else if (msg.type === "error") {
            controller.error(new Error(msg.message || "download error"));
            port.close();
          }
        };
        try {
          port.start && port.start();
        } catch (e) {
          // Ignore port start errors
        }
      },
      cancel() {
        try {
          meta.port.postMessage({ type: "cancel" });
        } catch (e) {
          // Ignore cancel message errors (port may already be closed)
        }
      },
    }),
    { headers }
  );
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // 拦截下载路径（固定路径，不需要前缀）
  if (
    url.pathname === "/download/unsealed" ||
    url.pathname.endsWith("/download/unsealed")
  ) {
    const id = url.searchParams.get("id");
    const meta = id && downloads.get(id);
    if (!meta) {
      event.respondWith(new Response("download id not found", { status: 404 }));
      return;
    }
    // one-shot, clean up after start
    downloads.delete(id);
    event.respondWith(streamFromPort(meta));
  }
});
