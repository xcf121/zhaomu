/**
 * 存储层。
 * 装成扩展时用 chrome.storage.local；直接用 file:// 打开页面时 chrome.storage 不存在，
 * 自动退回 localStorage —— 同一份代码两种环境都能跑，方便脱离扩展调试样式。
 * 上层模块只认 get / set，不关心跑在哪。
 */

const hasChromeStorage =
  typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;

export const driverName = hasChromeStorage ? 'chrome.storage.local' : 'localStorage';

export async function get(key, fallback = null) {
  try {
    if (hasChromeStorage) {
      const result = await chrome.storage.local.get(key);
      return result[key] ?? fallback;
    }
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (err) {
    console.warn(`[存储] 读取 "${key}" 失败：`, err);
    return fallback;
  }
}

export async function set(key, value) {
  try {
    if (hasChromeStorage) {
      await chrome.storage.local.set({ [key]: value });
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
    return true;
  } catch (err) {
    console.warn(`[存储] 写入 "${key}" 失败：`, err);
    return false;
  }
}
