---
title: MacCMS 本地模式 API 代理（/api/:key 路由扩展）
status: implemented
date: 2026-05-05
---

## 问题

MacCMS 源在本地模式（Docker/Node.js 部署）下，TVBox 直接使用原始 MacCMS API URL。电视端因网络限制（DNS/防火墙/跨域）无法直接访问这些外部 MacCMS API，导致大量 MacCMS 源"无法使用"——分类加载失败、搜索无结果。

复现条件：
1. 聚合器运行在 Docker/Node.js（`workerBaseUrl` 未设置）
2. MacCMS 源的 API URL 为外部地址（如 `https://xxx.com/api.php/provide/vod`）
3. TVBox 配置源为 `http://192.168.31.18:5678/`
4. 电视端打开 MacCMS 源 → 分类为空 / 请求超时

## 根因分析

1. **`/api/:key` 代理路由仅 CF 模式挂载**（`routes.ts:721`）：
   ```typescript
   if (config.workerBaseUrl) {  // ← 本地模式不满足此条件
     app.all('/api/:key', async (c) => { ... });
   }
   ```

2. **`macCMSToTVBoxSites()` 本地模式用原始 URL**（`maccms.ts:63-64`）：
   ```typescript
   api: workerBaseUrl
     ? `${workerBaseUrl.replace(/\/$/, '')}/api/${entry.key}`
     : entry.api,  // ← 本地模式直接用原始 URL，电视端无法访问
   ```

3. **已有 `localBaseUrl` 机制未用于 MacCMS**：JAR 代理已使用 `localBaseUrl`（如 `http://192.168.31.18:5678`）作为代理基础 URL，但 MacCMS 代理未复用此机制。

## 方案

### 第一步：本地模式挂载 /api/:key 代理路由

在 `routes.ts` 中，将 `/api/:key` 路由从仅 CF 模式扩展到也覆盖本地模式（有 `localBaseUrl` 时）。

**改动**：`src/routes.ts`

将条件从 `if (config.workerBaseUrl)` 改为 `if (config.workerBaseUrl || config.localBaseUrl)`：

```typescript
// ─── MacCMS API 代理 ──────────────────────
if (config.workerBaseUrl || config.localBaseUrl) {
  app.all('/api/:key', async (c) => {
    const key = c.req.param('key');
    const raw = await storage.get(KV_MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    const source = sources.find((s) => s.key === key);

    if (!source) {
      return c.json({ error: 'Unknown MacCMS source' }, 404);
    }

    try {
      const targetUrl = new URL(source.api);
      const reqUrl = new URL(c.req.url);
      reqUrl.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));

      const resp = await fetch(targetUrl.toString(), {
        headers: { 'User-Agent': 'okhttp/3.12.0' },
      });
      const data = await resp.json();

      return c.json(data, 200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: msg }, 502);
    }
  });
}
```

注意：本地版增加 `User-Agent: okhttp/3.12.0` 请求头，模拟 TVBox 原生客户端，避免部分 MacCMS 站的 UA 校验拦截。

**验证**：`curl http://192.168.31.18:5678/api/<some-key>?ac=list` 返回 MacCMS 分类数据。

### 第二步：macCMSToTVBoxSites() 本地模式使用代理 URL

修改 `macCMSToTVBoxSites()`，当 `localBaseUrl` 可用时也使用代理 URL。

**改动**：`src/core/maccms.ts:46-70`

```typescript
export function macCMSToTVBoxSites(
  entries: MacCMSSourceEntry[],
  proxyBaseUrl?: string,  // workerBaseUrl || localBaseUrl
  speedMap?: Map<string, number>,
): TVBoxSite[] {
  return entries.map((entry) => {
    let name = entry.name;
    const speedMs = speedMap?.get(entry.key);
    if (speedMs != null) {
      const seconds = (speedMs / 1000).toFixed(1);
      name = `${name} [${seconds}s]`;
    }

    return {
      key: entry.key,
      name,
      type: 1,
      api: proxyBaseUrl
        ? `${proxyBaseUrl.replace(/\/$/, '')}/api/${entry.key}`
        : entry.api,
      searchable: 1,
      quickSearch: 1,
      filterable: 1,
    };
  });
}
```

### 第三步：aggregator.ts 调用处传入 proxyBaseUrl

修改 `processMacCMSSources()` 中调用 `macCMSToTVBoxSites()` 时传入 `workerBaseUrl || localBaseUrl`。

**改动**：`src/aggregator.ts:441`

```typescript
const proxyBaseUrl = config.workerBaseUrl || config.localBaseUrl;
const sites = macCMSToTVBoxSites(validEntries, proxyBaseUrl, speedMap);
```

**验证**：聚合后 `merged.sites` 中的 MacCMS 站 api 字段为 `http://192.168.31.18:5678/api/<key>` 而非原始外部 URL。

## 改动范围

- `src/routes.ts`：`/api/:key` 路由条件扩展 + 加 UA 头
- `src/core/maccms.ts`：`macCMSToTVBoxSites()` 参数名从 `workerBaseUrl` 改为 `proxyBaseUrl`
- `src/aggregator.ts`：调用处传入 `workerBaseUrl || localBaseUrl`

## 风险点

1. **本地聚合器网络限制**：如果聚合器 Docker 容器本身也无法访问外部 MacCMS API（如处于同一受限网络），代理仍会失败。对策：边缘代理回退（配置 CF/Vercel edge proxy 后，`/api/:key` 可进一步通过边缘函数中转）。
2. **并发压力**：所有 MacCMS 请求经过聚合器中转，增加聚合器负载。对策：已有 `Cache-Control: max-age=300` 5 分钟缓存；TVBox 侧也有页面缓存。
3. **参数名变更**：`macCMSToTVBoxSites()` 参数从 `workerBaseUrl` 改为 `proxyBaseUrl`，需确认无其他调用点。
4. **UA 校验**：部分 MacCMS 站对 UA 有严格校验，添加 `okhttp/3.12.0` 可解决大部分。极端情况可能需要源级 UA 配置。

## 验证方式

1. **编译验证**：`npx tsc --noEmit` 通过
2. **路由功能验证**：
   - `curl http://192.168.31.18:5678/api/<key>?ac=list` → 返回分类 JSON
   - `curl http://192.168.31.18:5678/api/<key>?ac=detail&t=1&pg=1` → 返回视频列表
3. **TVBox 端验证**：
   - 源设为 `http://192.168.31.18:5678/`
   - 打开 MacCMS 源 → 分类正常加载
   - 点击分类 → 视频列表正常
   - 搜索 → 有结果
4. **回归验证**：CF 版部署不受影响（仍走原有逻辑）

## 讨论记录

- 本地 JAR 代理已有先例：`routes.ts:812` 的 `else if (config.localBaseUrl)` 分支，`aggregator.ts:367` 的 `jarBaseUrl = config.workerBaseUrl || config.localBaseUrl`
- 选择直接在聚合器本体做代理而非配置边缘函数回退，原因：聚合器所在 Docker 通常有正常外网出口（已验证可下载 MacCMS 源数据），电视端受限更多
- 不考虑在 TVBox 侧增加代理逻辑——应该在数据源层面解决，保持客户端简单

## 执行记录

- 2026-05-05：按方案完成三处改动
  - `src/routes.ts`：`/api/:key` 路由条件从 `if (config.workerBaseUrl)` 扩展为 `if (config.workerBaseUrl || config.localBaseUrl)`，fetch 追加 `User-Agent: okhttp/3.12.0`
  - `src/core/maccms.ts`：`macCMSToTVBoxSites()` 参数 `workerBaseUrl` 重命名为 `proxyBaseUrl`，注释同步更新
  - `src/aggregator.ts:441`：调用处改为传 `config.workerBaseUrl || config.localBaseUrl`
- `npx tsc --noEmit` 通过
