// 聚合流程编排

import type { Storage } from './storage/interface';
import type { AppConfig, SourceEntry, SourcedConfig, MacCMSSourceEntry, LiveSourceEntry, TVBoxLive, SourceFetchResult, SourceHealthRecord } from './core/types';
import { fetchConfigs } from './core/fetcher';
import { mergeConfigs, cleanLocalRefs, cleanEmptyEntries } from './core/merger';
import { batchSiteSpeedTest, appendSpeedToName, filterUnreachableSites } from './core/speedtest';
import { macCMSToTVBoxSites, processMacCMSForLocal } from './core/maccms';
import { rewriteJarUrls } from './core/jar-proxy';
import { batchTestLiveSources, liveSourcesToTVBoxLives } from './core/live-source';
import { KV_MERGED_CONFIG, KV_MERGED_CONFIG_FULL, KV_SOURCE_URLS, KV_LAST_UPDATE, KV_MANUAL_SOURCES, KV_MACCMS_SOURCES, KV_LIVE_SOURCES, KV_BLACKLIST, KV_INLINE_PREFIX, KV_NAME_TRANSFORM, KV_SOURCE_HEALTH, KV_SPEED_TEST_ENABLED, KV_JAR_REGISTRY_ENABLED, KV_EDGE_PROXIES } from './core/config';
import { loadBlacklist, applyBlacklist, pruneBlacklist, saveBlacklist } from './core/blacklist';
import { transformSiteNames } from './core/cleaner';
import { parseConfigJson, type FetchProxyConfig } from './core/fetcher';
import { buildJarRegistry, assignJars, buildJarStorageAdapter } from './core/jar-registry';
import { scrapeSourceList, scrapeMacCMSSources, type ScrapeSourceConfig, type ScrapeMacCMSConfig } from './core/source-scraper';
import type { NameTransformConfig, JarAssignment, EdgeProxyConfig } from './core/types';

export async function runAggregation(storage: Storage, config: AppConfig): Promise<void> {
  const startTime = Date.now();
  console.log('[aggregation] Starting...');

  try {
    await _runAggregation(storage, config, startTime);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : '';
    console.error(`[aggregation] FATAL ERROR: ${msg}`);
    console.error(`[aggregation] Stack: ${stack}`);
    // 写入错误信息方便调试
    await storage.put(KV_LAST_UPDATE, `ERROR @ ${new Date().toISOString()}: ${msg}`);
  }
}

async function _runAggregation(storage: Storage, config: AppConfig, startTime: number): Promise<void> {

  // Step 0: 自动抓取源（需配置 SCRAPE_SOURCE_URL 环境变量）
  if (config.scrapeSourceUrl && config.scrapeSourceReferer) {
    console.log('[aggregation] Step 0: Auto-scraping sources...');
    try {
      const scrapeCfg: ScrapeSourceConfig = { url: config.scrapeSourceUrl, referer: config.scrapeSourceReferer };
      const scraped = await scrapeSourceList(scrapeCfg);
      if (scraped.length > 0) {
        const existingRaw = await storage.get(KV_MANUAL_SOURCES);
        const existingSources: SourceEntry[] = existingRaw ? JSON.parse(existingRaw) : [];
        const existingUrls = new Set(existingSources.map(s => s.url));

        let added = 0;
        for (const source of scraped) {
          if (!existingUrls.has(source.url)) {
            existingSources.push(source);
            existingUrls.add(source.url);
            added++;
          }
        }

        if (added > 0) {
          await storage.put(KV_MANUAL_SOURCES, JSON.stringify(existingSources));
          console.log(`[aggregation] Auto-scraped: ${added} new sources added (total: ${existingSources.length})`);
        } else {
          console.log(`[aggregation] Auto-scrape: no new sources (${scraped.length} scraped, all exist)`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[aggregation] Auto-scrape failed (non-blocking): ${msg}`);
    }
  }

  // Step 0.5: MacCMS 资源站自动抓取（需配置 MACCMS_API_URL 环境变量）
  if (config.maccmsApiUrl && config.maccmsAesKey && config.maccmsAesIv) {
    console.log('[aggregation] Step 0.5: Auto-scraping MacCMS sources...');
    try {
      const maccmsCfg: ScrapeMacCMSConfig = { apiUrl: config.maccmsApiUrl, aesKey: config.maccmsAesKey, aesIv: config.maccmsAesIv };
      const scraped = await scrapeMacCMSSources(maccmsCfg);
      if (scraped.length > 0) {
        await storage.put(KV_MACCMS_SOURCES, JSON.stringify(scraped));
        console.log(`[aggregation] MacCMS auto-scraped: ${scraped.length} sources updated`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[aggregation] MacCMS auto-scrape failed (non-blocking): ${msg}`);
    }
  }

  // Step 1: 读取手动配置的源（含自动抓取合并后的）
  console.log('[aggregation] Step 1: Loading sources...');
  const raw = await storage.get(KV_MANUAL_SOURCES);
  const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];

  // 检查是否有 MacCMS 源（即使没有 config 源也可以继续）
  const macCMSRaw = await storage.get(KV_MACCMS_SOURCES);
  const hasMacCMS = macCMSRaw ? JSON.parse(macCMSRaw).length > 0 : false;

  if (sources.length === 0 && !hasMacCMS) {
    console.warn('[aggregation] No sources configured, nothing to do');
    return;
  }

  console.log(`[aggregation] ${sources.length} config sources configured`);
  await storage.put(KV_SOURCE_URLS, JSON.stringify(sources));

  // Step 1.5: 处理 MacCMS 源
  console.log('[aggregation] Step 1.5: Processing MacCMS sources...');
  const macCMSConfigs = await processMacCMSSources(storage, config);

  // Step 1.6: 处理直播源（admin 手动源 + 连通性测试 + 改写）
  console.log('[aggregation] Step 1.6: Processing live sources...');
  const extraLives = await processLiveSources(storage, config);

  // Step 1.8: 分离 inline:// 源，从 KV 直接加载
  const remoteSources = sources.filter(s => !s.url.startsWith('inline://'));
  const inlineSources = sources.filter(s => s.url.startsWith('inline://'));
  const inlineConfigs: SourcedConfig[] = [];

  for (const src of inlineSources) {
    const kvKey = src.url.replace('inline://', '');
    const raw = await storage.get(kvKey);
    if (raw) {
      const parsed = parseConfigJson(raw);
      if (parsed) {
        inlineConfigs.push({ sourceUrl: src.url, sourceName: src.name || 'Inline', config: parsed });
        console.log(`[aggregation] Loaded inline config: ${kvKey}`);
      } else {
        console.warn(`[aggregation] Failed to parse inline config: ${kvKey}`);
      }
    } else {
      console.warn(`[aggregation] Inline config not found in KV: ${kvKey}`);
    }
  }

  // Step 2: 批量 fetch 配置 JSON（本地模式可通过边缘代理回退）
  console.log('[aggregation] Step 2: Fetching configs...');
  let proxyConfig: FetchProxyConfig | undefined;
  if (!config.workerBaseUrl) {
    // 本地模式：读取边缘代理配置
    const edgeRaw = await storage.get(KV_EDGE_PROXIES);
    if (edgeRaw) {
      const edge: EdgeProxyConfig = JSON.parse(edgeRaw);
      const urls: string[] = [];
      if (edge.cf) urls.push(`${edge.cf}/fetch-proxy`);
      if (edge.vercel) urls.push(`${edge.vercel}/api/proxy`);
      if (urls.length > 0) {
        proxyConfig = { urls, token: config.adminToken };
        console.log(`[aggregation] Edge proxies configured: ${urls.join(', ')}`);
      }
    }
  }
  const { configs: sourcedConfigs, fetchResults } = await fetchConfigs(remoteSources, config.fetchTimeoutMs, proxyConfig);

  // 更新源健康状态
  await updateSourceHealth(storage, fetchResults);

  if (sourcedConfigs.length === 0 && inlineConfigs.length === 0 && macCMSConfigs.length === 0) {
    console.warn('[aggregation] No valid configs fetched and no MacCMS/inline sources, keeping previous cache');
    return;
  }

  // Step 3: 用 fetch 耗时筛选配置源
  let filteredConfigs: SourcedConfig[] = sourcedConfigs;

  const configsWithSpeed = sourcedConfigs.filter((c) => c.speedMs != null);
  if (configsWithSpeed.length > 0) {
    console.log('[aggregation] Step 3: Filtering configs by fetch speed...');
    filteredConfigs = sourcedConfigs.filter((c) => {
      if (c.speedMs == null) return true; // 没有测速数据的保留
      if (c.speedMs <= config.speedTimeoutMs) return true;
      console.log(`[aggregation] Filtered out ${c.sourceUrl}: ${c.speedMs}ms > ${config.speedTimeoutMs}ms`);
      return false;
    });

    if (filteredConfigs.length === 0) {
      console.warn('[aggregation] All configs failed speed filter, using all fetched configs');
      filteredConfigs = sourcedConfigs;
    } else {
      console.log(`[aggregation] ${filteredConfigs.length}/${sourcedConfigs.length} configs passed speed filter`);
    }
  } else {
    console.log('[aggregation] Step 3: No speed data available, skipping filter');
  }

  // Step 3.5: JAR 仓库分析（可选）
  let jarAssignment: JarAssignment | undefined;
  const jarRegistryEnabled = (await storage.get(KV_JAR_REGISTRY_ENABLED)) === 'true';
  if (jarRegistryEnabled) {
    console.log('[aggregation] Step 3.5: Building JAR registry...');
    try {
      const allConfigsForJar = [...filteredConfigs, ...inlineConfigs, ...macCMSConfigs];
      const saveJarBin = buildJarStorageAdapter(storage, !!config.workerBaseUrl);
      const result = await buildJarRegistry(allConfigsForJar, storage, config.fetchTimeoutMs, saveJarBin);
      if (result) {
        jarAssignment = assignJars(result.registry, allConfigsForJar);
        console.log(
          `[aggregation] JAR registry: global covers ${jarAssignment.stats.coveredByGlobal}, ` +
          `per-site ${jarAssignment.stats.coveredByPerSite}, orphaned ${jarAssignment.stats.orphaned}`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[aggregation] JAR registry failed, falling back to vote: ${msg}`);
    }
  } else {
    console.log('[aggregation] Step 3.5: JAR registry disabled, using vote-based spider selection');
  }

  // Step 4: 合并（包含 MacCMS 源）
  console.log('[aggregation] Step 4: Merging configs...');
  const allConfigs = [...filteredConfigs, ...inlineConfigs, ...macCMSConfigs];
  let merged = mergeConfigs(allConfigs, jarAssignment);

  // 将额外直播源注入到 merged.lives
  if (extraLives.length > 0) {
    merged.lives = [...(merged.lives || []), ...extraLives];
    console.log(`[aggregation] Injected ${extraLives.length} extra live sources`);
  }

  // Step 4.5: 黑名单过滤
  console.log('[aggregation] Step 4.5: Applying blacklist...');
  const blacklist = await loadBlacklist(storage);
  const hasBlacklist = blacklist.sites.length > 0 || blacklist.parses.length > 0 || blacklist.lives.length > 0;

  // 保存过滤前的完整配置（供配置编辑器显示已屏蔽项）
  await storage.put(KV_MERGED_CONFIG_FULL, JSON.stringify(merged));

  if (hasBlacklist) {
    // 自动清理黑名单中已不存在的条目（必须在过滤前比对，否则被屏蔽的条目会被误判为"过时"而清掉）
    const pruned = await pruneBlacklist(blacklist, merged);
    if (JSON.stringify(pruned) !== JSON.stringify(blacklist)) {
      await saveBlacklist(storage, pruned);
    }

    const { config: filtered, removedSites, removedParses, removedLives } = await applyBlacklist(merged, pruned);
    merged = filtered;
    console.log(`[aggregation] Blacklist removed: ${removedSites} sites, ${removedParses} parses, ${removedLives} lives`);
  } else {
    console.log('[aggregation] Step 4.5: No blacklist entries, skipping');
  }

  // Step 5: 清洗无效数据（空条目 + 本地引用）
  console.log('[aggregation] Step 5: Cleaning invalid entries...');
  merged = cleanEmptyEntries(merged);
  merged = cleanLocalRefs(merged);

  // Step 5.5: 名称定制（清洗推广文字 + 前缀后缀）
  const ntRaw = await storage.get(KV_NAME_TRANSFORM);
  const nameTransform: NameTransformConfig = ntRaw ? JSON.parse(ntRaw) : {};
  const hasTransform = nameTransform.prefix || nameTransform.suffix || nameTransform.promoReplacement || nameTransform.extraCleanPatterns?.length;
  if (hasTransform) {
    console.log('[aggregation] Step 5.5: Applying name transform...');
    merged = transformSiteNames(merged, nameTransform);
  } else {
    // 即使没有自定义配置，默认清洗推广文字也要执行
    console.log('[aggregation] Step 5.5: Cleaning promo text from site names...');
    merged = transformSiteNames(merged, {});
  }

  // Step 6: 站点测速 + 不可达过滤 + name 标记（CF 和 Node.js 统一）
  const speedTestRaw = await storage.get(KV_SPEED_TEST_ENABLED);
  const speedTestEnabled = speedTestRaw !== 'false'; // 默认启用

  if (!speedTestEnabled) {
    console.log('[aggregation] Step 6: Speed test disabled, skipping');
  } else if (merged.sites && merged.sites.length > 0) {
    console.log('[aggregation] Step 6: Site speed test + unreachable filtering...');
    const speedMap = await batchSiteSpeedTest(merged.sites, config.siteTimeoutMs);

    if (speedMap.size > 0) {
      // 过滤不可达站点（含安全阀）
      const { sites: filteredSites, filtered } = filterUnreachableSites(merged.sites, speedMap);
      merged.sites = filteredSites;

      // 本地模式追加延迟标签到站点名称
      if (!config.workerBaseUrl) {
        merged.sites = appendSpeedToName(merged.sites, speedMap);
      }
    }
  } else {
    console.log('[aggregation] Step 6: No sites to test');
  }

  // Step 7: JAR URL 改写（CF 用 workerBaseUrl，本地用 localBaseUrl）
  const jarBaseUrl = config.workerBaseUrl || config.localBaseUrl;
  if (jarBaseUrl) {
    console.log(`[aggregation] Step 7: Rewriting JAR URLs for proxy (${jarBaseUrl})...`);
    merged = await rewriteJarUrls(merged, jarBaseUrl, storage);
  } else {
    console.log('[aggregation] Step 7: Skipping JAR rewrite (no base URL)');
  }

  // Step 7.5: 注入图片代理前缀（CF 模式用自身，本地模式用边缘代理）
  if (config.workerBaseUrl) {
    merged.pic = `${config.workerBaseUrl.replace(/\/$/, '')}/img/`;
    console.log(`[aggregation] Step 7.5: Injected pic proxy: ${merged.pic}`);
  } else {
    const edgeRaw = await storage.get(KV_EDGE_PROXIES);
    if (edgeRaw) {
      const edge: EdgeProxyConfig = JSON.parse(edgeRaw);
      if (edge.cf) {
        merged.pic = `${edge.cf.replace(/\/$/, '')}/img/`;
        console.log(`[aggregation] Step 7.5: Injected pic proxy via edge: ${merged.pic}`);
      }
    }
  }

  // Step 8: 存入存储
  const mergedJson = JSON.stringify(merged);
  await storage.put(KV_MERGED_CONFIG, mergedJson);
  await storage.put(KV_LAST_UPDATE, new Date().toISOString());

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[aggregation] Done in ${elapsed}s. ` +
      `${merged.sites?.length} sites, ${merged.parses?.length} parses, ${merged.lives?.length} lives`,
  );
}

/**
 * 处理 MacCMS 源：
 * - CF 版（有 workerBaseUrl）：直接转换，API 指向代理路由
 * - 本地版（无 workerBaseUrl）：并发验证 + 过滤不可达站点 + 收集延迟
 */
async function processMacCMSSources(
  storage: Storage,
  config: AppConfig,
): Promise<SourcedConfig[]> {
  const raw = await storage.get(KV_MACCMS_SOURCES);
  const entries: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];

  if (entries.length === 0) {
    console.log('[aggregation] No MacCMS sources configured');
    return [];
  }

  console.log(`[aggregation] ${entries.length} MacCMS sources found`);

  let validEntries: MacCMSSourceEntry[];
  let speedMap: Map<string, number> | undefined;

  if (config.workerBaseUrl) {
    // CF 版：跳过验证，代理本身就是可用性保证
    console.log('[aggregation] CF mode: skipping MacCMS validation, using proxy URLs');
    validEntries = entries;
  } else {
    // 本地版：并发验证，过滤不可达站点，收集延迟
    console.log('[aggregation] Local mode: validating MacCMS sources...');
    const result = await processMacCMSForLocal(entries, config.siteTimeoutMs);
    validEntries = result.passed;
    speedMap = result.speedMap;
  }

  if (validEntries.length === 0) {
    console.warn('[aggregation] No valid MacCMS sources after processing');
    return [];
  }

  const sites = macCMSToTVBoxSites(validEntries, config.workerBaseUrl, speedMap);
  console.log(`[aggregation] Converted ${sites.length} MacCMS sources to TVBoxSites`);

  return [{
    sourceUrl: 'maccms://builtin',
    sourceName: 'MacCMS Sources',
    config: { sites },
  }];
}

/**
 * 处理直播源：
 * 1. CF 模式：从 juwanhezi.com 抓取 + admin 手动源 → 去重 → 连通性测试 → URL 改写
 * 2. 本地模式：admin 手动源 → 连通性测试 → name 追加延迟
 */
async function processLiveSources(
  storage: Storage,
  config: AppConfig,
): Promise<TVBoxLive[]> {
  // 读取 admin 手动直播源
  const raw = await storage.get(KV_LIVE_SOURCES);
  const allEntries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];

  if (allEntries.length === 0) {
    console.log('[aggregation] No extra live sources to process');
    return [];
  }

  console.log(`[aggregation] ${allEntries.length} manual live sources found`);

  // 去重（按 URL）
  const seen = new Set<string>();
  const uniqueEntries = allEntries.filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });

  console.log(`[aggregation] ${uniqueEntries.length} unique live sources after dedup`);

  // 4. 连通性测试
  const { passed, speedMap } = await batchTestLiveSources(uniqueEntries, config.siteTimeoutMs);

  if (passed.length === 0) {
    console.warn('[aggregation] No live sources passed connectivity test');
    return [];
  }

  // 5. 转为 TVBoxLive[]（CF: URL 改写 + KV 映射，本地: name 追加延迟）
  const lives = await liveSourcesToTVBoxLives(
    passed,
    config.workerBaseUrl,
    storage,
    speedMap,
  );

  console.log(`[aggregation] Produced ${lives.length} TVBoxLive entries`);
  return lives;
}

/**
 * 更新源健康状态：读取历史 → merge 本次 fetch 结果 → 写回
 */
async function updateSourceHealth(storage: Storage, fetchResults: SourceFetchResult[]): Promise<void> {
  if (fetchResults.length === 0) return;

  const now = new Date().toISOString();

  // 读取历史健康记录
  const raw = await storage.get(KV_SOURCE_HEALTH);
  const oldRecords: SourceHealthRecord[] = raw ? JSON.parse(raw) : [];
  const oldMap = new Map(oldRecords.map(r => [r.url, r]));

  // 本次参与 fetch 的 URL 集合
  const fetchedUrls = new Set(fetchResults.map(r => r.url));

  // Merge 逻辑
  const newRecords: SourceHealthRecord[] = [];

  for (const fr of fetchResults) {
    const old = oldMap.get(fr.url);

    if (fr.status === 'ok') {
      newRecords.push({
        url: fr.url,
        name: fr.name,
        latestStatus: 'ok',
        consecutiveFailures: 0,
        lastSuccessTime: now,
        lastFailTime: old?.lastFailTime,
        lastFailReason: old?.lastFailReason,
        lastSpeedMs: fr.speedMs,
      });
    } else {
      newRecords.push({
        url: fr.url,
        name: fr.name,
        latestStatus: fr.status,
        consecutiveFailures: (old?.consecutiveFailures ?? 0) + 1,
        lastSuccessTime: old?.lastSuccessTime,
        lastFailTime: now,
        lastFailReason: fr.errorMessage,
        lastSpeedMs: old?.lastSpeedMs,
      });
    }
  }

  // 保留未参与本次 fetch 的历史记录（源可能被临时排除但还在列表中）
  // 但已被用户删除的源不应保留——这由 fetchResults 只包含当前源列表来保证
  // 如果老记录的 URL 不在本次 fetch 中，丢弃（源已被删除）
  // 注：inline:// 源不经过 fetcher，不会出现在 fetchResults 中，也不需要追踪

  const failCount = newRecords.filter(r => r.consecutiveFailures > 0).length;
  if (failCount > 0) {
    console.log(`[aggregation] Source health: ${newRecords.length - failCount} ok, ${failCount} failing`);
  }

  await storage.put(KV_SOURCE_HEALTH, JSON.stringify(newRecords));
}
