/**
 * 默认配置与配置读写。
 * 配置整体存在一个 key 下，改动时做深合并，避免新增字段后老配置缺项。
 */

import { get, set } from './storage.js';

const CONFIG_KEY = 'config';

export const DEFAULT_CONFIG = {
  search: {
    engineId: 'bing',
    /**
     * 输入时要不要去问引擎自己的联想接口。
     * 接口地址与返回格式**写死在 js/suggest.js 里**，不进配置 —— 它是「哪家引擎」的属性，
     * 不是用户偏好；而且 config.js 的深合并对数组是整体替换，放进 engines 会让
     * 老配置里那份 engines 把新加的字段整个盖掉，升级上来的人静默失效。
     */
    suggest: true,
    engines: [
      { id: 'baidu',    name: '百度',   url: 'https://www.baidu.com/s?wd=%s' },
      { id: 'bing',     name: 'Bing',   url: 'https://www.bing.com/search?q=%s' },
      { id: 'google',   name: 'Google', url: 'https://www.google.com/search?q=%s' },
      { id: 'bilibili', name: 'B站',    url: 'https://search.bilibili.com/all?keyword=%s' },
      { id: 'github',   name: 'GitHub', url: 'https://github.com/search?q=%s' },
    ],
  },

  wallpaper: {
    source: 'bing',          // bing | custom（用户上传）| none
    quality: '1920x1080',    // 1920x1080（约 340KB，够快）| UHD（4K，约 3.6MB）
    market: 'zh-CN',         // 决定 Bing 返回的壁纸地区与中文介绍
    /**
     * 用户上传的壁纸：{ dataUrl, name, width, height }。
     * 放在配置里是为了「导出配置」能把它一起带走；代价是配置会变大
     * （已压到长边 2560px，实测 300KB～1.2MB），所以这里给它留了 10MB 配额里的一份。
     */
    custom: null,
  },

  weather: {
    city: '重庆',
    latitude: 29.56026,
    longitude: 106.55771,
    ttlMinutes: 10,          // 超过这个时长才重新请求
  },

  /**
   * 时钟。
   * style 决定字体与视觉风格，可选值见 js/clock.js 的 CLOCK_STYLES，
   * 观感全在 style.css 的 [data-clock-style=…] 那几条规则里 —— 这里只存一个 id。
   */
  clock: {
    style: 'classic',        // classic | bold | serif | mono | outline | glow
  },

  /**
   * 每日一言。**每打开一次新标签页换一句**（不是按天轮换，见 js/quote.js）。
   * builtin  —— 内置 60 句抽签袋，零网络、断网也在（默认）
   * hitokoto —— 一言 API（v1.hitokoto.cn），池子里取现成的、后台补货，拿不到就退回内置句子
   */
  quote: {
    source: 'builtin',       // builtin | hitokoto
  },

  // 初始种子，M4 做设置面板后由用户自由增删改
  shortcuts: [
    { name: 'GitHub',     url: 'https://github.com' },
    { name: '哔哩哔哩',   url: 'https://www.bilibili.com' },
    { name: '知乎',       url: 'https://www.zhihu.com' },
    { name: '掘金',       url: 'https://juejin.cn' },
    { name: 'MDN',        url: 'https://developer.mozilla.org' },
    { name: '微博',       url: 'https://weibo.com' },
    { name: '淘宝',       url: 'https://www.taobao.com' },
    { name: '网易云音乐', url: 'https://music.163.com' },
  ],

  /**
   * 组件布局。
   *
   * x / y 是 0–100 的**纯数字**（不带单位），含义是「组件在可用空间里的位置」：
   *   0 = 贴起始边，50 = 精确居中，100 = 贴结束边
   * 换算全部交给 CSS（见 style.css 的 .widget）：
   *   left: calc(var(--x) * 1%)          相对容器宽
   *   transform: translate(-x%, -y%)     相对自身宽
   * 两者相减正好是 x/100 × (容器宽 − 自身宽)，所以：
   *   · 任何窗口尺寸下都不可能跑到屏幕外，不需要额外的边界兜底
   *   · 窗口缩放时 JS 一行都不用跑
   * ⚠️ 正因如此，值必须是合法数字 —— x 传成 NaN 会让 calc() 整体作废、
   *    left 退回 auto，所有组件堆到左上角且改配置也救不回来。导入时必须校验。
   */
  layout: {
    widgets: {
      // 这几个值是拿真机重叠检测标定出来的（1920×1080 到 420×780 共 14 档尺寸），
      // 不是推算值 —— 组件高度不随窗口等比缩放，百分比定位必须实测。
      // 实测：1920×1080 到 480×720 共 13 档尺寸都不重叠；再窄（约 420px）
      // 快捷方式会折成三行把搜索框压住，那时只能手动拖开或「恢复默认布局」。
      // quote 另跑了 22 档（3840×2160 到 420×780，含 4K、竖屏、1280×620 这类扁窗口）：
      // 贴在左上角 0,0 与其它五个都不重叠 —— 它只跟时钟同一个横带，而时钟是居中的。
      clock:     { visible: true, x: 50,  y: 25  },
      quote:     { visible: true, x: 0,   y: 0   },
      search:    { visible: true, x: 50,  y: 50  },
      shortcuts: { visible: true, x: 50,  y: 74  },
      weather:   { visible: true, x: 100, y: 100 },
      credit:    { visible: true, x: 0,   y: 100 },
    },
  },

  /** 云同步：本轮只预留接口，providerId 恒为本地实现（见 js/sync.js） */
  sync: { providerId: 'local' },
};

/** 深合并：只覆盖对象，数组整体替换 */
function mergeDeep(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch ?? base;
  if (typeof base !== 'object' || base === null) return patch ?? base;
  if (typeof patch !== 'object' || patch === null) return patch ?? base;

  const out = { ...base };
  for (const key of Object.keys(patch)) {
    out[key] = key in base ? mergeDeep(base[key], patch[key]) : patch[key];
  }
  return out;
}

export async function loadConfig() {
  const stored = await get(CONFIG_KEY, null);
  return stored ? mergeDeep(DEFAULT_CONFIG, stored) : structuredClone(DEFAULT_CONFIG);
}

/* ------------------------------------------------------------------
 * 写入
 * ------------------------------------------------------------------ */

const listeners = new Set();

/**
 * 订阅配置变化（写入成功后回调，拿到的永远是合并后的完整配置）。
 * @returns {() => void} 退订函数
 */
export function onConfigChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(config) {
  for (const fn of listeners) {
    try {
      fn(config);
    } catch (err) {
      // 一个订阅者出错不能连带影响其它订阅者和写入本身
      console.warn('[配置] 订阅回调出错：', err);
    }
  }
}

/**
 * 写入串行化。
 *
 * patchConfig 是「读-改-写」三步，本身没有锁：两次调用并发时，后一次会读到前一次
 * 落盘之前的旧值，把前一次的改动整个盖掉。拖拽保存和设置开关同时触发就会丢写。
 * 用一条 promise 链把写入排队，每次读到的都是上一次写完的结果。
 */
let writeChain = Promise.resolve();

/** 局部更新配置，返回合并后的完整配置 */
export function patchConfig(patch) {
  const run = writeChain.then(async () => {
    const current = await loadConfig();
    const next = mergeDeep(current, patch);
    await set(CONFIG_KEY, next);
    emit(next);
    return next;
  });

  // 链上挂一个吞掉异常的版本：一次写入失败不能让后续写入全部短路
  writeChain = run.catch(() => {});
  return run;
}

/** 整份覆盖（导入 / 恢复默认用）。同样走串行化，避免和 patch 抢 */
export function replaceConfig(config) {
  const run = writeChain.then(async () => {
    const next = mergeDeep(DEFAULT_CONFIG, config ?? {});
    await set(CONFIG_KEY, next);
    emit(next);
    return next;
  });

  writeChain = run.catch(() => {});
  return run;
}
