/**
 * 壁纸。三种来源：
 *   bing   —— Bing 每日一图，按天缓存
 *   custom —— 用户自己传的图，压好后存在配置里（data URL），零网络
 *   none   —— 不要壁纸，退回 body 上那层 CSS 渐变
 *
 * 两个要点：
 * 1. 新标签页一天可能被打开几十次，所以 Bing 的图**按天缓存**：同一天内再打开不发任何请求。
 * 2. 打开瞬间先用缓存（哪怕是昨天的）铺满屏，再去后台取当天的，避免中间空窗露出渐变。
 *    两层背景交叉淡入，换图时不闪。
 *
 * 任何一步失败都只是少一张图，页面继续用 CSS 渐变兜底，绝不白屏。
 */

import { get, set } from './storage.js';

const CACHE_KEY = 'wallpaper';
const BING_ENDPOINT = 'https://www.bing.com/HPImageArchive.aspx';
const IMAGE_TIMEOUT_MS = 15000;

/** 长边压到这么多像素；再大对壁纸没有肉眼可见的收益，只是白占存储 */
const WALLPAPER_MAX_EDGE = 2560;

/** 存进配置的 data URL 字符数上限（chrome.storage.local 总共 10MB，得留余量给别的） */
const WALLPAPER_MAX_CHARS = 1.6 * 1024 * 1024;

const layers = [document.getElementById('bgA'), document.getElementById('bgB')];
let activeLayer = -1;

/**
 * 每次 initWallpaper 都换一个号。设置里连点两下换来源时，前一次请求可能后回来，
 * 拿着旧结果去改一个已经不属于它的画面 —— 只认最新那一号，过期的直接丢掉。
 */
let generation = 0;

function isStale(token) {
  return token !== generation;
}

/** 本地日期串（不能用 toISOString，那是 UTC，晚上会跨错天） */
function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 交叉淡入到指定图片地址 */
function show(url) {
  const next = (activeLayer + 1) % layers.length;
  const el = layers[next];
  if (!el) return;

  el.style.backgroundImage = `url("${url}")`;
  el.classList.add('is-ready');
  document.body.classList.add('has-wallpaper');   // 有壁纸才启用压暗蒙版
  if (activeLayer >= 0) layers[activeLayer].classList.remove('is-ready');
  activeLayer = next;
}

/**
 * 撤掉壁纸，退回渐变。
 * 先让它淡出（is-ready 一去掉就开始 900ms 过渡），过渡走完再清 background-image ——
 * 直接清会「啪」地一下消失，没有淡出。
 */
function showNone() {
  for (const el of layers) {
    if (!el) continue;
    el.classList.remove('is-ready');
    setTimeout(() => {
      if (!el.classList.contains('is-ready')) el.style.backgroundImage = '';
    }, 950);
  }
  activeLayer = -1;
  document.body.classList.remove('has-wallpaper');
}

/** 预加载，确保图真的能下载下来再上屏（否则会看到渐变→图的突兀跳变） */
function preload(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = '';
      reject(new Error('图片加载超时'));
    }, IMAGE_TIMEOUT_MS);

    img.onload = () => { clearTimeout(timer); resolve(url); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('图片加载失败')); };
    img.src = url;
  });
}

function renderCredit(text) {
  const el = document.getElementById('credit');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('is-ready', Boolean(text));
}

async function fetchToday(cfg) {
  const params = new URLSearchParams({
    format: 'js',
    idx: '0',
    n: '1',
    mkt: cfg.market || 'zh-CN',
  });

  const res = await fetch(`${BING_ENDPOINT}?${params}`);
  if (!res.ok) throw new Error(`Bing 返回 ${res.status}`);

  const data = await res.json();
  const image = data?.images?.[0];
  if (!image?.urlbase) throw new Error('Bing 返回结构不符合预期');

  const size = cfg.quality === 'UHD' ? 'UHD' : '1920x1080';

  return {
    url: `https://www.bing.com${image.urlbase}_${size}.jpg&rf=LaDigue_${size}.jpg&pid=hp`,
    credit: image.copyright || '',
    title: image.title || '',
    date: todayKey(),
  };
}

/** Bing 每日一图：先铺缓存（哪怕是昨天的），再后台取当天的 */
async function showBing(cfg, token) {
  const cached = await get(CACHE_KEY, null);
  if (isStale(token)) return null;

  // 1) 有缓存就先铺上，先有画面再追求正确
  if (cached?.url) {
    show(cached.url);
    renderCredit(cached.credit);
    if (cached.date === todayKey()) return cached;   // 就是今天的，收工，零请求
  }

  // 2) 缓存过期或不存在 → 取当天的
  try {
    const fresh = await fetchToday(cfg);
    if (isStale(token)) return cached ?? null;
    await preload(fresh.url);
    if (isStale(token)) return cached ?? null;
    show(fresh.url);
    renderCredit(fresh.credit);
    await set(CACHE_KEY, fresh);
    return fresh;
  } catch (err) {
    console.warn('[壁纸] 获取当日壁纸失败，沿用缓存或渐变兜底：', err.message);
    return cached ?? null;
  }
}

/** 用户自己传的图：直接从配置里取，不发任何请求 */
async function showCustom(cfg, token) {
  const custom = cfg.custom;
  const url = typeof custom?.dataUrl === 'string' ? custom.dataUrl : '';

  // 说了用自定义图但图没了（比如导入了别人导出的配置，图片没跟着走）——
  // 退回渐变并说清楚，而不是留着一张白屏或者上一次的图
  if (!url) {
    if (!isStale(token)) {
      showNone();
      renderCredit('');
    }
    return null;
  }

  try {
    await preload(url);
  } catch {
    console.warn('[壁纸] 自定义壁纸读不出来，退回渐变');
    return null;
  }
  if (isStale(token)) return null;

  show(url);
  renderCredit(custom.name || '自定义壁纸');
  return { url, credit: custom.name || '', date: todayKey(), custom: true };
}

/**
 * @param {object} cfg config.wallpaper
 * @returns {Promise<object|null>} 最终上屏的壁纸记录，全失败时为 null
 */
export function initWallpaper(cfg = {}) {
  generation += 1;
  const token = generation;

  return run(cfg, token).catch((err) => {
    console.warn('[壁纸] 初始化异常：', err);
    return null;
  });
}

async function run(cfg, token) {
  const source = cfg.source === 'custom' || cfg.source === 'none' ? cfg.source : 'bing';

  if (source === 'none') {
    if (!isStale(token)) {
      showNone();
      renderCredit('');
    }
    return null;
  }

  return source === 'custom' ? showCustom(cfg, token) : showBing(cfg, token);
}

/* ------------------------------------------------------------------
 * 用户上传
 * ------------------------------------------------------------------ */

function readAsDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

function pack(dataUrl, name, width, height) {
  return {
    dataUrl,
    name: String(name || '自定义壁纸').slice(0, 60),
    width,
    height,
  };
}

/**
 * 用户上传的图片 → 可以直接当壁纸用的 data URL。
 *
 * 缩放 + 压缩是必须的：原图动辄十几 MB，直接塞进配置会顶爆存储配额，
 * 而且每开一次新标签页都要重新解析一遍那么大的字符串。
 */
export async function fileToWallpaper(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, WALLPAPER_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);

    // 截图、线稿这类平色图 JPEG 会糊出可见的色块边，尺寸和体积都还合适就直接留原图
    if (scale === 1 && file.type === 'image/png' && file.size <= WALLPAPER_MAX_CHARS * 0.75) {
      const raw = await readAsDataUrl(file);
      if (raw && raw.length <= WALLPAPER_MAX_CHARS) {
        return pack(raw, file.name, width, height);
      }
    }

    // 照片走 JPEG，质量一档一档往下退，直到体积达标为止
    let dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    for (const quality of [0.78, 0.68, 0.58]) {
      if (dataUrl.length <= WALLPAPER_MAX_CHARS) break;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    if (dataUrl.length > WALLPAPER_MAX_CHARS) throw new Error('图片压缩后还是太大');

    return pack(dataUrl, file.name, width, height);
  } finally {
    bitmap.close?.();
  }
}
