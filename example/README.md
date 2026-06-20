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

以下文件**不在 Git 仓库中**，需本地生成：

| 文件 | 生成方式 |
|------|----------|
| `example/browser/keys.json` | 复制 `keys.json.example` 并填入密钥，或调用 `/api/gen` |
| `example/browser/sealed_full.bin`、`plain.bin` | `curl -k https://localhost:8088/api/gen` |
| `test/fixtures/browser-unsealer-*` | `npm run gen:fixtures`（`test:browser` 会自动执行） |

```bash
# 示例数据（需 serve:example 运行中）
curl -k https://localhost:8088/api/gen

# 浏览器测试 fixture（需先 npm run build）
npm run gen:fixtures
```

## 自动化测试

```bash
npm run test:node    # 临时文件写入 test_tmp/w{N}/，Jest 钩子自动清理
npm run test:browser # 等价于 build + gen:fixtures + jest
npm run test:clean   # 清理 test_tmp/ 与根目录历史测试残留
```

## 目录说明

| 目录 | 作用 |
|------|------|
| `example/http/` | **本地 HTTPS 后端**（`serve:example` 启动的就是它） |
| `example/vue3/` | **Vue3 宿主接入示例（维护中）**，前端入口 |
| `example/browser/` | 本地测试数据目录（`keys.json.example` 为模板；`keys.json`、`*.bin` 本地生成）；`index.html` 为旧版页面，**未维护** |
| `test_tmp/` | Node 测试运行时临时目录（已 gitignore） |
