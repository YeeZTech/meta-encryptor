# Example 本地调试指南

## 前置

```bash
# 项目根目录
npm install
npm run build

# 生成 HTTPS 证书（仅首次，serve:example 需要）
openssl req -x509 -newkey rsa:2048 \
  -keyout private.key -out certificate.crt \
  -days 365 -nodes -subj "/CN=localhost"
```

## Vue3 宿主接入示例（推荐）

`npm run serve:example` **不是**为了打开 `example/browser/index.html`（该页面未维护）。  
它启动的是 `example/http/static-server.js`：**本地 HTTPS 文件服务器**，给 vue3 示例提供：

- 加密测试文件（`sealed_full.bin` 等，URL 路径在 `/example/browser/...`）
- 私钥配置（`keys.json`）
- `/api/gen` 等生成接口

vue3 通过 Vite 代理访问这些资源，**你实际使用的页面是 http://localhost:5173**。

```bash
# 终端 1：根目录 — 启动 HTTPS 后端（vue3 依赖它，与 browser 页面无关）
npm run serve:example

# 终端 2
cd example/vue3
npm install
npm run dev
```

访问：http://localhost:5173（不要访问 8088 上的 browser/index.html）

- Vite 通过 alias 引用 `src/index.browser.js`，由打包器处理依赖
- `/example`、`/api` 代理到 `https://localhost:8088`
- `UnsealDownloader.vue` 演示如何封装 `downloadUnsealed`

补丁说明见 [doc/integration-patches.md](../doc/integration-patches.md)。

## 生成测试文件

```bash
# serve:example 运行后访问
curl -k https://localhost:8088/api/gen
# 或浏览器打开该 URL，会在 example/browser/ 下生成 sealed_full.bin 与 keys.json
```

## 自动化测试

```bash
npm run test:node
npm run test:browser
```

## 目录说明

| 目录 | 作用 |
|------|------|
| `example/http/` | **本地 HTTPS 后端**（`serve:example` 启动的就是它） |
| `example/vue3/` | **Vue3 宿主接入示例（维护中）**，前端入口 |
| `example/browser/` | 仅存放测试数据（`sealed_full.bin`、`keys.json`）；`index.html` 为旧版页面，**未维护** |
