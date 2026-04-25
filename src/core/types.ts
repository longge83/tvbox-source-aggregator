// TVBox JSON 配置完整类型定义

export interface TVBoxSite {
  key: string;
  name?: string;
  type: number; // 0=XML, 1=JSON, 3=JAR, 4=Remote
  api: string;
  searchable?: number; // 0|1
  quickSearch?: number; // 0|1
  filterable?: number; // 0|1
  playUrl?: string;
  playerType?: number; // -1|0|1|2|10
  jar?: string; // per-site JAR override
  ext?: string | Record<string, unknown>;
  categories?: string[];
  click?: string;
  style?: string;
}

export interface TVBoxParse {
  name: string;
  url: string;
  type?: number; // 0=sniffer, 1=JSON, 2=JSON extended, 3=aggregated, 4=super
  ext?: string | Record<string, unknown>;
}

export interface TVBoxLiveChannel {
  name: string;
  urls: string[];
}

export interface TVBoxLiveGroup {
  group: string;
  channels: TVBoxLiveChannel[];
}

export interface TVBoxLive {
  name?: string;
  type?: number; // 0=M3U/TXT, 3=JAR/Python
  url?: string;
  api?: string;
  jar?: string;
  epg?: string;
  ua?: string;
  header?: Record<string, string>;
  playerType?: number;
  ext?: string | Record<string, unknown>;
}

export interface TVBoxRule {
  host?: string;
  hosts?: string[];
  rule?: string[];
  filter?: string[];
  regex?: string[];
  script?: string[];
}

export interface TVBoxDoh {
  name: string;
  url: string;
}

export interface TVBoxConfig {
  spider?: string;
  jarCache?: boolean | string;
  wallpaper?: string;
  pic?: string; // 图片代理前缀，TVBox 客户端加载图片时自动拼接
  sites?: TVBoxSite[];
  parses?: TVBoxParse[];
  lives?: TVBoxLive[];
  hosts?: string[];
  rules?: TVBoxRule[];
  doh?: TVBoxDoh[];
  ads?: string[];
  flags?: string[];
}

// MacCMS 源条目
export interface MacCMSSourceEntry {
  key: string;    // TVBox site key，如 "hongniuzy"
  name: string;   // 显示名，如 "红牛资源站"
  api: string;    // 原始 API，如 "https://www.hongniuzy2.com/api.php/provide/vod/from/hnm3u8/at/json/"
}

// 直播源条目
export interface LiveSourceEntry {
  name: string;
  url: string;
}

// 源条目
export interface SourceEntry {
  name: string;
  url: string;
  configKey?: string; // AES ECB 解密密钥（来自 URL 的 ;pk; 后缀）
}

// 内部处理用：带来源标记的配置
export interface SourcedConfig {
  sourceUrl: string;
  sourceName: string;
  config: TVBoxConfig;
  speedMs?: number; // 配置 URL 响应时间
}

// 名称定制配置
export interface NameTransformConfig {
  prefix?: string;
  suffix?: string;
  promoReplacement?: string;
  extraCleanPatterns?: string[];
}

// JSON 导入结果
export interface ImportResult {
  type: 'multi' | 'single';
  added: number;
  duplicates: number;
  sources: string[];
}

// 单次 fetch 结果（内部传递，不持久化）
export type SourceFetchStatus = 'ok' | 'http_error' | 'decode_error' | 'parse_error' | 'timeout' | 'network_error';

export interface SourceFetchResult {
  url: string;
  name: string;
  status: SourceFetchStatus;
  errorMessage?: string;
  speedMs?: number;
}

// 持久化的源健康记录
export interface SourceHealthRecord {
  url: string;
  name: string;
  latestStatus: SourceFetchStatus;
  consecutiveFailures: number;
  lastSuccessTime?: string;
  lastFailTime?: string;
  lastFailReason?: string;
  lastSpeedMs?: number;
}

// 平台无关的应用配置
export interface AppConfig {
  adminToken?: string;
  refreshToken?: string;
  speedTimeoutMs: number;
  siteTimeoutMs: number;
  fetchTimeoutMs: number;
  cronSchedule?: string;
  workerBaseUrl?: string;  // CF 版设置，如 "https://tvbox.example.com"；本地不设置
  localBaseUrl?: string;   // Node.js 版设置，如 "http://192.168.1.100:5678"；用于 JAR 代理
  // 自动抓取配置（环境变量驱动，未配置则不启用）
  scrapeSourceUrl?: string;
  scrapeSourceReferer?: string;
  maccmsApiUrl?: string;
  maccmsAesKey?: string;
  maccmsAesIv?: string;
}

// 边缘函数代理配置
export interface EdgeProxyConfig {
  cf?: string;      // CF Worker URL，如 "https://tvbox.rio.edu.kg"
  vercel?: string;  // Vercel 代理 URL，如 "https://fetch.riowang.win"
}

// JAR 仓库：单个 JAR 的元数据
export interface JarMeta {
  url: string;
  md5: string | null;
  classes: string[];       // DEX 中提取的 spider 类名 ["Ali","Bili",...]
  sizeBytes?: number;
  lastFetchedAt: string;   // ISO
  status: 'ok' | 'fetch_failed' | 'parse_failed';
  errorMessage?: string;
}

// JAR 仓库：完整索引（序列化存 KV）
export interface JarRegistry {
  version: 1;
  updatedAt: string;
  jars: Record<string, JarMeta>; // key = JAR URL
}

// JAR 分配结果（纯计算，不持久化）
export interface JarAssignment {
  globalSpiderUrl: string | null;
  globalSpiderFull: string | null;
  siteJarMap: Map<string, string>;   // dedupKey(key|api) → 完整 spider 字符串
  orphanedKeys: Set<string>;         // dedupKey 集合，类找不到的站点
  stats: {
    totalType3: number;
    coveredByGlobal: number;
    coveredByPerSite: number;
    orphaned: number;
    urlBasedApi: number;
  };
}
