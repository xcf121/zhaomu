/**
 * 图标获取。一条链路，前面拿不到才试后面的：
 *
 *   1. 用户自己传的图标（存在快捷方式配置里的 data URL）
 *   2. chrome 的 _favicon —— 读浏览器**本地**图标缓存，不发网络请求，最快
 *   3. 本地存下来的网络图标（iconCache，按 origin 存，带正/负缓存）
 *   4. 联网取：第三方图标服务（Cravatar → 0x3）→ 站点根目录的 /favicon.ico
 *      → 抓首页 HTML 认它声明的 <link rel="icon">
 *   5. 都拿不到 → 保留一开始就铺好的首字母色块
 *
 * 两条铁律（见 AGENTS.md）：
 *   · **先铺兜底、成功才替换** —— 色块一开始就在，任何一步失败都只是色块继续留着，
 *     绝不会出现破图。这里连 <img> 都是先 decode 成功才 append 进 DOM 的。
 *   · **任何网络请求先读缓存** —— 新标签页一天可能开几十次，不缓存等于每次开都在打接口。
 *     所以第 4 步的结果一律落盘，失败也记一条负缓存，免得对着打不开的站点反复重试。
 *
 * 为什么联网那一级把第三方服务排在站点自己前面：服务部署在国内、直连快，
 * 对没访问过的站点命中率也高；站点自己的 /favicon.ico 最权威，但也最常缺。
 * 只在「服务都没有 + 站点自己也没有」时，才落到首字母色块。
 */

import { get, set } from './storage.js';

/** 图标在页面上的显示尺寸，跟 .tile__img 的 CSS 保持一致 */
const ICON_DISPLAY_PX = 26;

/**
 * _favicon 会把本地缓存里的图画成你要求的尺寸，所以尺寸按「显示尺寸 × 屏幕像素比」
 * 往上一档取，高分屏才不糊。上限 128：再大只是把 16px 的原图硬放大，没有意义。
 */
const ICON_SIZES = [32, 64, 128];

const ICON_SIZE = (() => {
  const need = ICON_DISPLAY_PX * Math.min(window.devicePixelRatio || 1, 3);
  return ICON_SIZES.find((size) => size >= need) ?? ICON_SIZES[ICON_SIZES.length - 1];
})();

/** 自传图标统一压到 128px 方形画布 */
const ICON_BOX = 128;

/** 单次网络请求的超时。超了就当作拿不到，退回上一级兜底 */
const SERVICE_TIMEOUT_MS = 3500;     // 第三方图标服务，快了才有意义
const FAVICON_TIMEOUT_MS = 4000;
const HTML_TIMEOUT_MS = 5000;

/** 图标本身就不该大。超过这个体积的多半是 404 页面或者整站 logo，不值得存 */
const MAX_ICON_BYTES = 32 * 1024;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_HTML_CHARS = 512 * 1024;

const CACHE_KEY = 'iconCache';
const TTL_OK_MS = 30 * 24 * 3600e3;     // 站点图标很少变，存 30 天
const TTL_PENDING_MS = 10 * 60e3;       // 服务说「还在后台抓」，过 10 分钟再来
const TTL_FAIL_MS = 6 * 3600e3;         // 真失败才记 6 小时，站点补了图标不用等太久
const MAX_ENTRIES = 48;

/* ------------------------------------------------------------------
 * 基础工具
 * ------------------------------------------------------------------ */

/** 扩展环境下才能用 _favicon；直接用 http 打开页面时 chrome.runtime 不存在 */
const canUseFaviconApi =
  typeof chrome !== 'undefined' &&
  !!chrome.runtime &&
  typeof chrome.runtime.getURL === 'function' &&
  !!chrome.runtime.id;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function faviconUrl(pageUrl, size) {
  if (!canUseFaviconApi) return null;
  try {
    // 按官方文档的写法构造（URL + searchParams），比手拼查询串更稳
    const url = new URL(chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', pageUrl);
    url.searchParams.set('size', String(size));
    return url.toString();
  } catch {
    return null;
  }
}

function readAsDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/** 带超时的 fetch。任何一种失败（超时、断网、被拦）都只是返回 null */
async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    // 取图标不需要带 cookie，别顺手把用户的登录态发给对方
    return await fetch(url, { signal: ctrl.signal, credentials: 'omit', redirect: 'follow' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------
 * 上屏：解不出来就不上屏，底下永远有首字母接着
 * ------------------------------------------------------------------ */

async function showImage(icon, src) {
  const img = document.createElement('img');
  img.className = 'tile__img';
  img.alt = '';
  img.decoding = 'async';
  img.src = src;

  try {
    await img.decode();
  } catch {
    return false;                 // 坏图、格式不支持 —— 色块继续留着，用户看不到破图
  }

  icon.append(img);
  icon.classList.add('has-icon');
  return true;
}

async function showBytes(icon, bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'image/png' }));
  try {
    return await showImage(icon, url);
  } finally {
    URL.revokeObjectURL(url);     // 图已经解码进内存，URL 可以放了
  }
}

/* ------------------------------------------------------------------
 * 层级 2：_favicon（本地缓存，零网络）
 * ------------------------------------------------------------------ */

let genericIconPromise = null;

/**
 * 从没访问过、本地缓存里没有图标的站点，_favicon 会返回一张通用的地球图。
 * 它不如首字母色块好看，还会让一排磁贴看着全都一样。
 *
 * 判断办法：拿一个不可能存在的域名去请求同一个接口，那张图就是通用地球，
 * 再和真实结果逐字节比对。取不到参照图就返回 undefined，比对一律判为「不是通用图」，
 * 宁可显示地球也不误伤真实图标。
 *
 * 缓存的是 Promise 而不是结果 —— 磁贴是并发取图的，缓存结果会让他们各发一次请求。
 */
function loadGenericIcon() {
  if (!genericIconPromise) {
    genericIconPromise = (async () => {
      const url = faviconUrl('https://chrome-favicon-placeholder.invalid/', ICON_SIZE);
      if (!url) return undefined;
      try {
        return new Uint8Array(await (await fetch(url)).arrayBuffer());
      } catch {
        return undefined;
      }
    })();
  }
  return genericIconPromise;
}

function sameBytes(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function tryLocalFavicon(icon, pageUrl) {
  const src = faviconUrl(pageUrl, ICON_SIZE);
  if (!src) return false;

  try {
    const [res, generic] = await Promise.all([fetch(src), loadGenericIcon()]);
    if (!res.ok) return false;

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (sameBytes(bytes, generic)) return false;    // 通用地球，不如首字母

    return await showBytes(icon, bytes, 'image/png');
  } catch (err) {
    // 接口行为变了、fetch 被拦等：退回直接加载（_favicon 是扩展自己的地址，不受 CORS 限制）
    console.warn('[图标] _favicon 校验不可用，改用直接加载：', err.message);
    return await showImage(icon, src);
  }
}

/* ------------------------------------------------------------------
 * 本地缓存（网络图标）
 * ------------------------------------------------------------------ */

let cachePromise = null;
let cacheWrite = Promise.resolve();

async function readCache() {
  if (!cachePromise) {
    cachePromise = (async () => {
      const raw = await get(CACHE_KEY, null);
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    })();
  }
  return cachePromise;
}

async function readCached(origin) {
  const map = await readCache();
  const entry = map[origin];
  if (!entry || typeof entry !== 'object') return null;
  const ttl = entry.dataUrl ? TTL_OK_MS : (entry.pending ? TTL_PENDING_MS : TTL_FAIL_MS);
  if (Date.now() - (entry.at || 0) > ttl) return null;
  return entry;
}

async function writeCached(origin, entry) {
  const map = await readCache();
  map[origin] = { ...entry, at: Date.now() };

  // 超量就淘汰最老的，别让存储无限涨（chrome.storage.local 总共就 10MB）
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (map[a]?.at || 0) - (map[b]?.at || 0));
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[key];
  }

  // 串行化，和 config.js 一个思路：并发写会把前一次的改动整个盖掉
  cacheWrite = cacheWrite.then(() => set(CACHE_KEY, map)).catch(() => {});
  return cacheWrite;
}

/* ------------------------------------------------------------------
 * 层级 4：联网取
 * ------------------------------------------------------------------ */

/** 把响应读成 data URL，顺带卡体积。读不出来或者太大都返回 null */
async function readImageBlob(res) {
  // 图标不该大。超过这个体积的多半是 404 页面或者整站 logo，不值得存
  if (Number(res.headers.get('content-length') || 0) > MAX_ICON_BYTES) return null;

  const blob = await res.blob();
  if (!blob.size || blob.size > MAX_ICON_BYTES) return null;

  return await readAsDataUrl(blob);
}

/** 取一张图并转成 data URL。任何一种失败（超时、断网、不是图、太大）都只是 null */
async function fetchImage(url, ms) {
  const res = await fetchWithTimeout(url, ms);
  if (!res || !res.ok) return null;

  // 404 页面常常是 200 + text/html，靠 content-type 挡掉
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type && !type.startsWith('image/')) return null;

  return await readImageBlob(res);
}

/** rel 属性里认 icon / shortcut icon / apple-touch-icon，但不认 mask-icon 这类 */
function isIconRel(rel) {
  return /(^|\s)(icon|apple-touch-icon)(\s|$)/i.test(rel);
}

/**
 * 抓首页 HTML，找站点自己声明的图标地址。
 * DOMParser 不执行脚本、也不会去加载里面的资源，解析不可信 HTML 是安全的。
 */
async function declaredIconUrl(pageUrl) {
  const res = await fetchWithTimeout(pageUrl, HTML_TIMEOUT_MS);
  if (!res || !res.ok) return null;

  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type && !type.includes('html')) return null;
  if (Number(res.headers.get('content-length') || 0) > MAX_HTML_BYTES) return null;

  const html = (await res.text()).slice(0, MAX_HTML_CHARS);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 以最终地址为基准：可能整站 301 到了别的主机
  const base = res.url || pageUrl;

  for (const el of doc.querySelectorAll('link[href]')) {
    if (!isIconRel(el.getAttribute('rel') || '')) continue;
    const href = (el.getAttribute('href') || '').trim();
    if (!href) continue;
    try {
      const abs = new URL(href, base);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') return abs.href;
    } catch { /* 坏 href，看下一个 */ }
  }
  return null;
}

/* ---------- 第三方图标服务 ---------- */

/** 只认域名：带上协议或路径，Cravatar 直接返回 504（实测） */
function hostOf(pageUrl) {
  try {
    return new URL(pageUrl).hostname;
  } catch {
    return null;
  }
}

/** 本地地址不发去第三方：服务不认识它，也没必要把内网主机名告诉别人 */
function isLocalHost(host) {
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.includes(':')                        // IPv6 字面量
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);     // IPv4 字面量
}

const cravatarUrl = (host) =>
  `https://cn.cravatar.com/favicon/api/index.php?url=${encodeURIComponent(host)}`;

const ox3Url = (host) => `https://0x3.com/icon?host=${encodeURIComponent(host)}`;

/**
 * 问 Cravatar 要图标。
 *
 * 它用 X-Favicon-State 交代这张图是什么：
 *   ready    → 站点真图标（实测和站点自己的 /favicon.ico 逐字节一致）
 *   fallback → **它手上还没有**，先甩一张通用占位图，同时去后台抓（X-Favicon-Queue）
 * 所以 fallback 不能当成功，也不能当失败 —— 它是「过一会儿再来」。
 * 拿不到这个头（服务改版、被中间层剥掉）时一律当作真图标，宁可显示也不误伤。
 *
 * @returns {Promise<{dataUrl: string}|{retrySoon: true}|null>}
 */
async function fetchCravatar(host) {
  const res = await fetchWithTimeout(cravatarUrl(host), SERVICE_TIMEOUT_MS);

  // 连不上、超时、5xx：这是**服务这边**的问题，不是「这个站点没有图标」，
  // 所以算「过一会儿再来」，不能按失败缓存 6 小时。
  // （实测它抖起来会整站返回 504 Gateway Time-out，此时所有站点都会走到这里。）
  if (!res) return { retrySoon: true };
  if (!res.ok) return res.status >= 500 ? { retrySoon: true } : null;

  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type && !type.startsWith('image/')) return null;

  const state = (res.headers.get('x-favicon-state') || '').trim().toLowerCase();
  if (state && state !== 'ready') return { retrySoon: true };

  const dataUrl = await readImageBlob(res);
  return dataUrl ? { dataUrl } : null;
}

let placeholderPromise = null;

/**
 * 0x3 的参照占位图。
 * 它比 Cravatar 糙：**拿不到图标时照样返回 200**，内容是一张固定的 SVG 链接图标
 * （实测 794 字节，随便编几个域名逐字节完全一致）。不比对的话，
 * 一排没抓到的站点会全部变成同一个图标 —— 那还不如首字母色块。
 * 缓存的是 Promise，别让每个磁贴各探一次。
 */
function loadIconPlaceholder() {
  if (!placeholderPromise) {
    placeholderPromise = fetchImage(ox3Url('icon-placeholder-probe.invalid'), SERVICE_TIMEOUT_MS);
  }
  return placeholderPromise;
}

/**
 * 问第三方服务要图标。
 * @returns {Promise<{dataUrl: string|null, retrySoon: boolean}>}
 *          retrySoon = 服务说「正在后台抓，过一会儿再来」
 */
async function fetchFromServices(pageUrl) {
  const host = hostOf(pageUrl);
  if (!host || isLocalHost(host)) return { dataUrl: null, retrySoon: false };

  const cravatar = await fetchCravatar(host);
  if (cravatar?.dataUrl) return { dataUrl: cravatar.dataUrl, retrySoon: false };

  // 0x3：不吭声，只能拿参照图逐字符比对（data URL 相同就等于字节相同）
  const ox3 = await fetchImage(ox3Url(host), SERVICE_TIMEOUT_MS);
  if (ox3) {
    const placeholder = await loadIconPlaceholder();
    if (ox3 !== placeholder) return { dataUrl: ox3, retrySoon: false };
  }

  return { dataUrl: null, retrySoon: Boolean(cravatar?.retrySoon) };
}

/** @returns {Promise<{dataUrl: string|null, retrySoon: boolean}>} */
async function fetchNetworkIcon(pageUrl) {
  const origin = originOf(pageUrl);
  if (!origin) return { dataUrl: null, retrySoon: false };

  // ① 第三方图标服务：国内直连快，没访问过的站点也常有
  const service = await fetchFromServices(pageUrl);
  if (service.dataUrl) return service;

  // ② 回头问站点自己：根目录的 /favicon.ico，绝大多数站点都有，一次请求就够
  const direct = await fetchImage(new URL('/favicon.ico', origin).href, FAVICON_TIMEOUT_MS);
  if (direct) return { dataUrl: direct, retrySoon: false };

  // ③ 再退一步：认这个页面自己声明的 <link rel="icon">
  const declared = await declaredIconUrl(pageUrl);
  const fromLink = declared ? await fetchImage(declared, FAVICON_TIMEOUT_MS) : null;
  return { dataUrl: fromLink, retrySoon: service.retrySoon };
}

/* ------------------------------------------------------------------
 * 对外的两件事：造一个带兜底的图标元素、往上挂图标
 * ------------------------------------------------------------------ */

/** 取首个字符做兜底头像；中文取第一个字，英文取首字母大写 */
function firstChar(name) {
  const chars = [...String(name ?? '').trim()];
  return chars.length ? chars[0].toUpperCase() : '·';
}

/** 名称 → 0~359 的色相，保证同名同色 */
function hueOf(name) {
  const s = String(name ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) % 360;
  }
  return h;
}

/** 首字母色块。**先铺它**，后面的图标成功了才盖上去 */
export function makeIconElement(name) {
  const icon = document.createElement('span');
  icon.className = 'tile__icon';

  const letter = document.createElement('span');
  letter.className = 'tile__letter';
  letter.textContent = firstChar(name);
  letter.style.setProperty('--hue', hueOf(name));

  icon.append(letter);
  return icon;
}

/**
 * 把图标挂到 makeIconElement 造出来的元素上。异步，失败了什么都不做。
 *
 * @param {Element} icon       makeIconElement 的产物
 * @param {string}  [pageUrl]  站点地址，用来取它的图标
 * @param {string}  [custom]   用户自传的图标（data URL），有它就只用它
 */
export async function attachIcon(icon, pageUrl, custom) {
  if (custom) {
    await showImage(icon, custom);
    return;
  }

  const origin = originOf(pageUrl);
  if (!origin) return;

  // ② 浏览器本地图标缓存
  if (await tryLocalFavicon(icon, pageUrl)) return;

  // ③ 自己存过的网络图标
  const cached = await readCached(origin);
  if (cached?.dataUrl) {
    await showImage(icon, cached.dataUrl);
    return;
  }
  if (cached) return;                        // 负缓存还没过期，别再打接口

  // ④ 联网。打不开、超时都只是退回色块
  const { dataUrl, retrySoon } = await fetchNetworkIcon(pageUrl);
  // 「服务正在后台抓」和「真的没有」要分开记：前者十分钟后就该重来，
  // 按失败缓存 6 小时的话，冷启动的用户会盯着首字母色块看半天
  const miss = retrySoon ? { pending: true } : { failed: true };

  if (!dataUrl) {
    await writeCached(origin, miss);
    return;
  }

  const ok = await showImage(icon, dataUrl);
  await writeCached(origin, ok ? { dataUrl } : miss);
}

/**
 * 用户上传的图片 → 统一的 128px 方形 PNG（data URL）。
 * 非正方形的等比缩放后居中留白，透明通道保留。
 */
export async function fileToIconDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, ICON_BOX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = ICON_BOX;
    canvas.height = ICON_BOX;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, (ICON_BOX - w) / 2, (ICON_BOX - h) / 2, w, h);

    return canvas.toDataURL('image/png');
  } finally {
    bitmap.close?.();
  }
}
