// DEX 字节码解析器：从 JAR (ZIP) 中提取 spider 类名
// 零外部依赖，CF Worker + Node.js 均可运行

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const IMAGE_MARKER = /[A-Za-z0]{8}\*\*/;

/**
 * 尝试解码 JAR 二进制（处理图片伪装 + base64 编码）
 * 返回真正的 JAR (ZIP) 数据，或 null
 */
export function decodeJarBytes(data: Uint8Array): Uint8Array | null {
  // 已经是 ZIP → 直接返回
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    return data;
  }

  // 转 Latin-1 文本做标记检测
  const text = new TextDecoder('latin1').decode(data);

  // 图片伪装：图片头 + [A-Za-z0]{8}** + base64(JAR)
  const match = IMAGE_MARKER.exec(text);
  if (match) {
    const b64 = text.substring(match.index + 10).trim();
    if (b64.length > 0) {
      try {
        const decoded = base64ToBinary(b64);
        if (decoded.length >= 4 && decoded[0] === 0x50 && decoded[1] === 0x4b) {
          return decoded;
        }
      } catch { /* not valid base64 */ }
    }
  }

  // 纯 base64（整个文件就是 base64 编码的 JAR）
  const trimmed = text.trim();
  if (trimmed.length > 100 && /^[A-Za-z0-9+/\s]+=*$/.test(trimmed.substring(0, 200))) {
    try {
      const decoded = base64ToBinary(trimmed);
      if (decoded.length >= 4 && decoded[0] === 0x50 && decoded[1] === 0x4b) {
        return decoded;
      }
    } catch { /* not valid base64 */ }
  }

  return null;
}

function base64ToBinary(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const ZIP_CENTRAL_DIR_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIR = 0x06054b50;

/**
 * 从 JAR (ZIP) 中提取 classes.dex
 * 通过 Central Directory 定位（兼容 Data Descriptor / streaming 模式）
 */
export async function extractDexFromJar(jarBytes: Uint8Array): Promise<Uint8Array | null> {
  const view = new DataView(jarBytes.buffer, jarBytes.byteOffset, jarBytes.byteLength);

  // 1. 从文件尾部找 End of Central Directory（倒序搜索签名）
  let eocdOffset = -1;
  for (let i = jarBytes.length - 22; i >= 0 && i >= jarBytes.length - 65557; i--) {
    if (view.getUint32(i, true) === ZIP_END_OF_CENTRAL_DIR) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return null;

  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  const centralDirEntries = view.getUint16(eocdOffset + 10, true);

  // 2. 遍历 Central Directory 找 classes.dex
  let cdOffset = centralDirOffset;
  for (let i = 0; i < centralDirEntries; i++) {
    if (cdOffset + 46 > jarBytes.length) break;
    if (view.getUint32(cdOffset, true) !== ZIP_CENTRAL_DIR_HEADER) break;

    const compressionMethod = view.getUint16(cdOffset + 10, true);
    const compressedSize = view.getUint32(cdOffset + 20, true);
    const uncompressedSize = view.getUint32(cdOffset + 24, true);
    const fileNameLen = view.getUint16(cdOffset + 28, true);
    const extraFieldLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);

    const fileName = new TextDecoder().decode(jarBytes.subarray(cdOffset + 46, cdOffset + 46 + fileNameLen));

    if (fileName === 'classes.dex') {
      // 从 Local File Header 计算数据偏移
      const lfhFileNameLen = view.getUint16(localHeaderOffset + 26, true);
      const lfhExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataOffset = localHeaderOffset + 30 + lfhFileNameLen + lfhExtraLen;
      const rawData = jarBytes.subarray(dataOffset, dataOffset + compressedSize);

      if (compressionMethod === 0) return rawData;

      if (compressionMethod === 8) {
        try {
          const ds = new DecompressionStream('deflate-raw');
          const writer = ds.writable.getWriter();
          const reader = ds.readable.getReader();

          const writePromise = writer.write(rawData).then(() => writer.close());
          const chunks: Uint8Array[] = [];
          let totalLen = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            totalLen += value.length;
          }
          await writePromise;

          const result = new Uint8Array(uncompressedSize || totalLen);
          let pos = 0;
          for (const chunk of chunks) {
            result.set(chunk, pos);
            pos += chunk.length;
          }
          return result;
        } catch {
          return null;
        }
      }
      return null;
    }

    cdOffset += 46 + fileNameLen + extraFieldLen + commentLen;
  }

  return null;
}

/**
 * 从 DEX 字节码中提取 spider 类名
 *
 * 筛选 Lcom/github/catvod/spider/Xxx;（排除 $ 内部类）
 * 返回 ["Xxx", "Yyy", ...]
 */
export function extractSpiderClasses(dexBytes: Uint8Array): string[] {
  const view = new DataView(dexBytes.buffer, dexBytes.byteOffset, dexBytes.byteLength);

  // 验证 magic
  if (dexBytes[0] !== 0x64 || dexBytes[1] !== 0x65 || dexBytes[2] !== 0x78 || dexBytes[3] !== 0x0a) {
    return [];
  }

  const stringIdsSize = view.getUint32(0x38, true);
  const stringIdsOff = view.getUint32(0x3c, true);
  const typeIdsOff = view.getUint32(0x44, true);
  const classDefsSize = view.getUint32(0x60, true);
  const classDefsOff = view.getUint32(0x64, true);

  const PREFIX = 'Lcom/github/catvod/spider/';
  const classes: string[] = [];

  for (let i = 0; i < classDefsSize; i++) {
    const classDefOff = classDefsOff + i * 32;
    const classIdx = view.getUint32(classDefOff, true);

    // type_id → string descriptor_idx
    const descriptorIdx = view.getUint32(typeIdsOff + classIdx * 4, true);
    if (descriptorIdx >= stringIdsSize) continue;

    // string_id → string_data_off
    const stringDataOff = view.getUint32(stringIdsOff + descriptorIdx * 4, true);
    if (stringDataOff >= dexBytes.length) continue;

    // 解码 string_data: ULEB128 长度 + MUTF-8 字节
    const str = readMutf8String(dexBytes, stringDataOff);
    if (!str) continue;

    // 筛选 Lcom/github/catvod/spider/Xxx;（排除内部类 $）
    if (str.startsWith(PREFIX) && str.endsWith(';') && !str.includes('$')) {
      const className = str.substring(PREFIX.length, str.length - 1);
      if (className && !className.includes('/')) {
        classes.push(className);
      }
    }
  }

  return classes;
}

function readMutf8String(data: Uint8Array, offset: number): string | null {
  // 跳过 ULEB128 长度
  let pos = offset;
  while (pos < data.length && (data[pos] & 0x80) !== 0) pos++;
  if (pos >= data.length) return null;
  pos++; // 跳过最后一个 ULEB128 字节

  // 读取到 null 终止符
  const start = pos;
  while (pos < data.length && data[pos] !== 0) pos++;
  if (pos === start) return null;

  try {
    return new TextDecoder('utf-8').decode(data.subarray(start, pos));
  } catch {
    return null;
  }
}
