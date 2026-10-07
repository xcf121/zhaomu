/**
 * 天气卡片 + 城市搜索（Open-Meteo，免 Key）。
 *
 * 三条硬约束，都出自「新标签页会被高频打开」：
 * 1. 结果按 ttlMinutes（默认 10 分钟）缓存，没过期就只读缓存，一个请求都不发。
 * 2. 卡片先按配置里的城市名渲染出来 —— 它同时是「换城市」的入口，
 *    所以断网、接口挂掉时也必须能点、能开搜索框。
 * 3. 任何一步失败都只影响温度那一行，不抛异常、不动布局、不白屏。
 *
 * 不用 navigator.geolocation：新标签页弹定位授权太打扰（PROJECT.md 已定）。
 */

import { get, set } from './storage.js';
import { patchConfig } from './config.js';
import { openPopover, closePopover, isPopoverOpen } from './popover.js';

const CACHE_KEY = 'weather';
const FORECAST_API = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_API = 'https://geocoding-api.open-meteo.com/v1/search';
const FETCH_TIMEOUT_MS = 8000;
const SEARCH_DEBOUNCE_MS = 320;
const MAX_RESULTS = 6;

/* ------------------------------------------------------------------
 * WMO 天气码 → 中文描述 + 图标
 * 码值定义见 Open-Meteo 文档；同一档位的码给同一套说法，不逐条造词。
 * 图标写成数组表示「白天 / 夜间」两种，其余的昼夜共用一个。
 * ------------------------------------------------------------------ */

const UNKNOWN = ['未知', 'cloud'];

const CODE_MAP = {
  0:  ['晴',           ['sun', 'moon']],
  1:  ['晴间多云',      ['cloud-sun', 'cloud-moon']],
  2:  ['多云',         ['cloud-sun', 'cloud-moon']],
  3:  ['阴',           'cloud'],
  45: ['有雾',         'fog'],
  48: ['雾凇',         'fog'],
  51: ['小毛毛雨',      'drizzle'],
  53: ['毛毛雨',        'drizzle'],
  55: ['大毛毛雨',      'drizzle'],
  56: ['冻毛毛雨',      'sleet'],
  57: ['强冻毛毛雨',    'sleet'],
  61: ['小雨',         'rain'],
  63: ['中雨',         'rain'],
  65: ['大雨',         'rain'],
  66: ['冻雨',         'sleet'],
  67: ['强冻雨',        'sleet'],
  71: ['小雪',         'snow'],
  73: ['中雪',         'snow'],
  75: ['大雪',         'snow'],
  77: ['雪粒',         'snow'],
  80: ['阵雨',         'showers'],
  81: ['强阵雨',       'showers'],
  82: ['暴雨',         'showers'],
  85: ['阵雪',         'snow'],
  86: ['强阵雪',       'snow'],
  95: ['雷阵雨',       'thunder'],
  96: ['雷阵雨伴冰雹',  'thunder'],
  99: ['强雷暴伴冰雹',  'thunder'],
};

function describe(code, isDay) {
  const [text, icon] = CODE_MAP[code] ?? UNKNOWN;
  return { text, icon: Array.isArray(icon) ? icon[isDay ? 0 : 1] : icon };
}

/* ------------------------------------------------------------------
 * 图标：24×24 线性描边，笔触跟搜索框那个下拉箭头一致（1.6 圆头）。
 * 导出是为了能离线渲染成对照表看效果，页面本身只用到 iconSvg()。
 * ------------------------------------------------------------------ */

const STROKE = 1.6;

/** 云的主体，多个图标复用 */
const CLOUD = 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z';

/**
 * 同一朵云按不同比例复用。
 * transform 的 scale 会把描边一起缩掉，所以要反向补偿 stroke-width，
 * 否则小云比大云细一圈，一整套图标的粗细就不统一了。
 */
function cloud(scale, x, y) {
  return (
    `<path d="${CLOUD}" transform="translate(${x} ${y}) scale(${scale})" ` +
    `stroke-width="${(STROKE / scale).toFixed(2)}"/>`
  );
}

/** 六角雪花：一竖 + 两斜 */
function flake(x, y, r) {
  return (
    `<path d="M${x} ${y - r}V${y + r}` +
    `M${x - r * 0.87} ${y - r * 0.5}L${x + r * 0.87} ${y + r * 0.5}` +
    `M${x + r * 0.87} ${y - r * 0.5}L${x - r * 0.87} ${y + r * 0.5}"/>`
  );
}

export const WEATHER_ICONS = {
  sun:
    '<circle cx="12" cy="12" r="4.1"/>' +
    '<path d="M12 3.6v2.4M12 18v2.4M3.6 12h2.4M18 12h2.4' +
    'M6.6 6.6 5 5M17.4 17.4 19 19M17.4 6.6 19 5M6.6 17.4 5 19"/>',

  moon: '<path d="M20.4 14.3A8.4 8.4 0 1 1 9.7 3.6a6.6 6.6 0 0 0 10.7 10.7Z"/>',

  cloud: cloud(0.92, 1, 2.1),

  // 太阳只画左上那截圆弧，避免和云交叉成一团乱线
  'cloud-sun':
    '<path d="M8.4 4.9A3.5 3.5 0 0 0 4.9 8.4"/>' +
    '<path d="M8.4 3.6V1.7M3.6 8.4H1.7M5 5 3.7 3.7"/>' +
    cloud(0.75, 4.2, 4.6),

  'cloud-moon':
    '<path d="M11.16 7.55A4.3 4.3 0 1 1 6.15 2.54a4.25 4.25 0 0 0 5.01 5.01Z"/>' +
    cloud(0.72, 5.6, 6.2),

  fog:
    cloud(0.78, 2.4, 0) +
    '<path d="M4.4 17.8h15.2M7 20.8h10"/>',

  drizzle:
    cloud(0.89, 1.2, 0.2) +
    '<path d="M8.6 18.4v2M15.4 18.4v2"/>',

  rain:
    cloud(0.89, 1.2, 0.2) +
    '<path d="M8.4 18.4 7.2 21.4M12.4 18.4l-1.2 3M16.4 18.4l-1.2 3"/>',

  showers:
    cloud(0.89, 1.2, 0.2) +
    '<path d="M8.2 18.6 6.6 21.2M12.6 18.6l-1.6 2.6M16.6 18.6l-1.6 2.6"/>',

  sleet:
    cloud(0.89, 1.2, 0.2) +
    '<path d="M8.6 18.4v3"/>' +
    flake(15.6, 19.9, 1.6),

  snow:
    cloud(0.89, 1.2, 0.2) +
    flake(8.2, 19.9, 1.6) +
    flake(15.8, 19.9, 1.6),

  thunder:
    cloud(0.85, 1.6, -1.4) +
    '<path d="M12.9 13.6 10.3 18h3.1l-2.3 4.4"/>',
};

function iconSvg(name) {
  const body = WEATHER_ICONS[name] ?? WEATHER_ICONS.cloud;
  return (
    `<svg class="weather__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${body}</svg>`
  );
}

/* ------------------------------------------------------------------
 * 网络
 * ------------------------------------------------------------------ */

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 城市名 → 候选地点列表（中文优先） */
async function geocode(keyword) {
  const params = new URLSearchParams({
    name: keyword,
    count: String(MAX_RESULTS),
    language: 'zh',
    format: 'json',
  });

  const data = await fetchJson(`${GEOCODE_API}?${params}`);
  return data?.results ?? [];
}

/** 当前天气 + 今日最高最低 */
async function fetchWeather(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '1',
  });

  const data = await fetchJson(`${FORECAST_API}?${params}`);
  if (!data?.current) throw new Error('Open-Meteo 返回结构不符合预期');
  return data;
}

/* ------------------------------------------------------------------
 * 模块
 * ------------------------------------------------------------------ */

export async function initWeather(cfg = {}) {
  const box = document.getElementById('weather');
  const pill = document.getElementById('weatherBtn');
  if (!box || !pill) return;

  const el = {
    icon: document.getElementById('weatherIcon'),
    temp: document.getElementById('weatherTemp'),
    city: document.getElementById('weatherCity'),
    range: document.getElementById('weatherRange'),
    panel: document.getElementById('weatherPanel'),
    input: document.getElementById('weatherInput'),
    results: document.getElementById('weatherResults'),
  };

  const state = {
    city: cfg.city || '未设置',
    latitude: cfg.latitude,
    longitude: cfg.longitude,
    ttlMs: (Number(cfg.ttlMinutes) || 10) * 60_000,
    data: null,
  };

  /* ---------- 渲染 ---------- */

  function render() {
    el.city.textContent = state.city;

    const cur = state.data?.current;
    if (!cur) {
      el.icon.innerHTML = '';
      el.temp.textContent = '--';
      el.range.textContent = '';
      pill.title = `${state.city} · 天气暂时取不到，点这里换个城市`;
      return;
    }

    const { text, icon } = describe(cur.weather_code, cur.is_day);
    const daily = state.data.daily ?? {};
    const lo = Math.round(daily.temperature_2m_min?.[0] ?? NaN);
    const hi = Math.round(daily.temperature_2m_max?.[0] ?? NaN);

    el.icon.innerHTML = iconSvg(icon);
    el.temp.textContent = `${Math.round(cur.temperature_2m)}°`;
    el.range.textContent = Number.isFinite(lo) && Number.isFinite(hi) ? `${lo}~${hi}°` : '';
    pill.title =
      `${state.city} · ${text} · 体感 ${Math.round(cur.apparent_temperature)}°` +
      ` · 湿度 ${cur.relative_humidity_2m}% · 风 ${cur.wind_speed_10m} km/h`;
  }

  /* ---------- 缓存 ---------- */

  /** 缓存里存了坐标：换过城市的老数据直接作废，免得张冠李戴 */
  async function readCache() {
    const c = await get(CACHE_KEY, null);
    if (!c || c.latitude !== state.latitude || c.longitude !== state.longitude) return null;
    return c;
  }

  async function refresh() {
    if (!Number.isFinite(state.latitude) || !Number.isFinite(state.longitude)) {
      console.warn('[天气] 配置里没有有效坐标，跳过请求');
      return;
    }

    try {
      const data = await fetchWeather(state.latitude, state.longitude);
      state.data = data;
      render();
      await set(CACHE_KEY, {
        latitude: state.latitude,
        longitude: state.longitude,
        fetchedAt: Date.now(),
        data,
      });
    } catch (err) {
      console.warn('[天气] 获取失败，沿用缓存或留空：', err.message);
    }
  }

  /* ---------- 城市搜索 ---------- */

  let timer = 0;
  let lastKeyword = '';
  const memo = new Map();     // 同一个词不重复打接口（退格再输入很常见）

  function setOpen(open) {
    if (open === isPopoverOpen(el.panel)) return;   // 幂等

    if (open) {
      openPopover(el.panel, {
        anchor: pill,
        prefer: 'above-end',   // 天气在右下角，面板往上弹、右对齐
        onClose: () => {
          el.input.value = '';
          el.results.replaceChildren();
          lastKeyword = '';
        },
      });
      el.input.focus();
      el.input.select();
    } else {
      closePopover(el.panel);
    }
  }

  function renderMessage(text) {
    const li = document.createElement('li');
    li.className = 'weather__msg';
    li.textContent = text;          // 一律 textContent，不拼 HTML
    el.results.replaceChildren(li);
  }

  function renderResults(list, keyword) {
    if (!list.length) {
      renderMessage(`没找到「${keyword}」`);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of list) {
      const li = document.createElement('li');

      const btn = document.createElement('button');
      btn.className = 'weather__result';
      btn.type = 'button';

      const name = document.createElement('span');
      name.className = 'weather__result-name';
      name.textContent = item.name;

      const meta = document.createElement('span');
      meta.className = 'weather__result-meta';
      // 直辖市的 admin1 就是 name 本身，重复就不显示
      meta.textContent = [item.admin1, item.country]
        .filter((s) => s && s !== item.name)
        .join(' · ');

      btn.append(name, meta);
      btn.addEventListener('click', () => selectCity(item));
      li.append(btn);
      frag.append(li);
    }
    el.results.replaceChildren(frag);
  }

  async function runSearch(keyword) {
    renderMessage('搜索中…');
    try {
      const list = await geocode(keyword);
      if (keyword !== lastKeyword) return;      // 期间又打了新词，这次结果作废
      memo.set(keyword, list);
      renderResults(list, keyword);
    } catch (err) {
      console.warn('[天气] 城市搜索失败：', err.message);
      if (keyword === lastKeyword) renderMessage('搜索失败，检查一下网络');
    }
  }

  function onInput() {
    const keyword = el.input.value.trim();
    lastKeyword = keyword;
    clearTimeout(timer);

    if (!keyword) {
      el.results.replaceChildren();
      return;
    }
    if (memo.has(keyword)) {
      renderResults(memo.get(keyword), keyword);
      return;
    }
    timer = setTimeout(() => runSearch(keyword), SEARCH_DEBOUNCE_MS);
  }

  async function selectCity(item) {
    state.city = item.name;
    state.latitude = item.latitude;
    state.longitude = item.longitude;
    state.data = null;

    setOpen(false);
    render();

    try {
      await patchConfig({
        weather: { city: item.name, latitude: item.latitude, longitude: item.longitude },
      });
    } catch (err) {
      console.warn('[天气] 保存城市失败：', err.message);
    }

    refresh();
  }

  /* ---------- 事件 ---------- */

  pill.addEventListener('click', () => setOpen(!isPopoverOpen(el.panel)));
  el.input.addEventListener('input', onInput);

  // Escape 与「点外部关闭」都交给 layers.js 统一分发，这里不再挂全局监听

  /* ---------- 启动：先渲染 → 有新鲜缓存就收工 → 否则后台刷新 ---------- */

  render();                       // 先用配置里的城市名把卡片立起来，绝不留空

  const cached = await readCache();
  if (cached) {
    state.data = cached.data;
    render();
    if (Date.now() - cached.fetchedAt < state.ttlMs) return;   // 还新鲜，零请求
  }

  await refresh();
}
