// Node.js 入口

import { serve } from '@hono/node-server';
import * as cron from 'node-cron';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import { createApp } from './routes';
import { runAggregation } from './aggregator';
import {
  DEFAULT_SPEED_TIMEOUT_MS,
  DEFAULT_SITE_TIMEOUT_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  KV_CRON_INTERVAL,
  DEFAULT_CRON_INTERVAL,
} from './core/config';
import type { Storage } from './storage/interface';
import type { AppConfig } from './core/types';

// 加载 .env
dotenv.config();

// ─── 存储初始化（SQLite → JSON 降级）───────────────────

function createStorage(): Storage {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

  // 尝试 SQLite
  try {
    const { SQLiteStorage } = require('./storage/sqlite');
    const dbPath = path.join(dataDir, 'tvbox.db');
    const storage = new SQLiteStorage(dbPath);
    console.log(`[storage] SQLite initialized: ${dbPath}`);
    return storage;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[storage] SQLite unavailable (${msg}), falling back to JSON file`);
  }

  // 降级到 JSON
  const { JsonFileStorage } = require('./storage/json-file');
  const jsonPath = path.join(dataDir, 'tvbox-data.json');
  console.log(`[storage] JSON file storage: ${jsonPath}`);
  return new JsonFileStorage(jsonPath);
}

// ─── 配置 ────────────────────────────────────────────────

function buildConfig(port: number): AppConfig {
  const lanIp = getLocalIp();
  const baseUrl = process.env.BASE_URL || `http://${lanIp || 'localhost'}:${port}`;
  return {
    adminToken: process.env.ADMIN_TOKEN,
    refreshToken: process.env.REFRESH_TOKEN,
    speedTimeoutMs: parseInt(process.env.SPEED_TIMEOUT_MS || '') || DEFAULT_SPEED_TIMEOUT_MS,
    siteTimeoutMs: parseInt(process.env.SITE_TIMEOUT_MS || '') || DEFAULT_SITE_TIMEOUT_MS,
    fetchTimeoutMs: parseInt(process.env.FETCH_TIMEOUT_MS || '') || DEFAULT_FETCH_TIMEOUT_MS,
    cronSchedule: process.env.CRON_SCHEDULE || '0 5 * * *',
    localBaseUrl: baseUrl.replace(/\/$/, ''),
    // 自动抓取（环境变量驱动）
    scrapeSourceUrl: process.env.SCRAPE_SOURCE_URL,
    scrapeSourceReferer: process.env.SCRAPE_SOURCE_REFERER,
    maccmsApiUrl: process.env.MACCMS_API_URL,
    maccmsAesKey: process.env.MACCMS_AES_KEY,
    maccmsAesIv: process.env.MACCMS_AES_IV,
  };
}

// ─── 启动 ────────────────────────────────────────────────

/** 将间隔分钟数转换为 cron 表达式 */
function intervalToCron(minutes: number): string {
  switch (minutes) {
    case 60:   return '0 */1 * * *';
    case 180:  return '0 */3 * * *';
    case 360:  return '0 */6 * * *';
    case 720:  return '0 */12 * * *';
    case 1440: return '0 5 * * *';
    default:   return '0 5 * * *';
  }
}

/** 间隔分钟数转可读文本 */
function intervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  if (minutes < 1440) return `${minutes / 60}h`;
  return `${minutes / 1440}d`;
}

async function main() {
  const storage = createStorage();
  const port = parseInt(process.env.PORT || '') || 5678;
  const config = buildConfig(port);

  let refreshRunning = false;
  const AGGREGATION_TIMEOUT_MS = 300_000; // 聚合整体超时 5 分钟

  const runWithGuard = async () => {
    if (refreshRunning) {
      console.log('[aggregation] Already running, skipping');
      return;
    }
    refreshRunning = true;
    try {
      await Promise.race([
        runAggregation(storage, config),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Aggregation timed out')), AGGREGATION_TIMEOUT_MS),
        ),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[aggregation] Error: ${msg}`);
    } finally {
      refreshRunning = false;
    }
  };

  // 动态 cron 管理
  let currentTask: cron.ScheduledTask | null = null;
  let currentSchedule = '';

  function scheduleCron(cronExpr: string) {
    if (currentTask) {
      currentTask.stop();
    }
    currentSchedule = cronExpr;
    currentTask = cron.schedule(cronExpr, () => {
      console.log(`[cron] Triggered at ${new Date().toISOString()}`);
      runWithGuard();
    });
    console.log(`[cron] Scheduled: ${cronExpr}`);
  }

  // 读取 KV 中的间隔设置，否则用环境变量/默认值
  const storedInterval = await storage.get(KV_CRON_INTERVAL);
  let initialSchedule: string;
  let intervalMin: number;

  if (storedInterval) {
    intervalMin = parseInt(storedInterval) || DEFAULT_CRON_INTERVAL;
    initialSchedule = intervalToCron(intervalMin);
  } else {
    initialSchedule = config.cronSchedule || '0 5 * * *';
    intervalMin = DEFAULT_CRON_INTERVAL;
  }

  scheduleCron(initialSchedule);

  const app = createApp({
    storage,
    config,
    triggerRefresh: runWithGuard,
    onCronIntervalChange: (intervalMinutes: number) => {
      const newCron = intervalToCron(intervalMinutes);
      console.log(`[cron] Interval changed to ${intervalLabel(intervalMinutes)} (${newCron})`);
      scheduleCron(newCron);
    },
  });

  const lanIp = getLocalIp();

  serve({ fetch: app.fetch, port }, (info) => {
    console.log('');
    console.log('  TVBox Source Aggregator');
    console.log(`  > Local:   http://localhost:${info.port}/`);
    if (lanIp) {
      console.log(`  > Network: http://${lanIp}:${info.port}/`);
    }
    console.log(`  > Admin:   http://${lanIp || 'localhost'}:${info.port}/admin`);
    console.log(`  > Status:  http://${lanIp || 'localhost'}:${info.port}/status`);
    console.log(`  > Cron:    ${currentSchedule} (every ${intervalLabel(intervalMin)})`);
    console.log('');
    console.log(`  TVBox 填入地址: http://${lanIp || 'localhost'}:${info.port}/`);
    console.log('');
  });
}

function getLocalIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

main();
