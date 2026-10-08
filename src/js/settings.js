/**
 * 设置面板。
 *
 * 用原生 <dialog> + showModal()：焦点陷阱、Escape 关闭、背景 inert、顶层堆叠
 * 全是平台给的，不用自己写，也不参与页面上那套 z-index。
 *
 * 面板本身不直接改 DOM —— 它只写配置，然后由各模块订阅 onConfigChange 自己更新。
 * 这样「谁拥有什么」是清楚的，也不会出现两处代码抢着改同一个元素。
 */

import { patchConfig, replaceConfig, onConfigChange } from './config.js';
import { WIDGET_META, getWidgetIds, resetLayout, setEditing, isEditing } from './layout.js';
import { CLOCK_STYLES, isClockStyle } from './clock.js';
import { QUOTE_SOURCES, isQuoteSource } from './quote.js';
import { getStatus as getSyncStatus, listProviders } from './sync.js';
import { set as storageSet } from './storage.js';
import { initWallpaper, fileToWallpaper } from './wallpaper.js';
import { closeAll } from './layers.js';

const CHECK_SVG =
  '<svg class="menu-item__check" viewBox="0 0 14 14" aria-hidden="true">' +
  '<path d="M2.8 7.4 5.6 10.2 11.2 4.2" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const WALLPAPER_SOURCES = [
  { value: 'bing', name: 'Bing 每日一图' },
  { value: 'custom', name: '我上传的图片' },
  { value: 'none', name: '不用壁纸（纯渐变）' },
];

/** 上传原图的体积上限。压完只有一张 2560px 的图，再大的原图纯属白等 */
const MAX_WALLPAPER_FILE = 25 * 1024 * 1024;

/** 导入时 data URL 的长度上限。比程序自己写出来的宽松一点，但绝不放开到能顶爆存储 */
const MAX_WALLPAPER_CHARS = 3 * 1024 * 1024;
const MAX_ICON_CHARS = 256 * 1024;

const WALLPAPER_QUALITIES = [
  { value: '1920x1080', name: '1080p · 快' },
  { value: 'UHD', name: '4K · 更清晰' },
];

let cfg = null;
let el = {};

/* ------------------------------------------------------------------
 * 行构件：和页面上的下拉、列表共用 .menu-item / .row 那套样式
 * ------------------------------------------------------------------ */

function choiceRow(label, selected, onPick) {
  const btn = document.createElement('button');
  btn.className = 'menu-item';
  btn.type = 'button';
  btn.setAttribute('aria-selected', String(selected));

  const span = document.createElement('span');
  span.textContent = label;
  btn.append(span);
  if (selected) btn.insertAdjacentHTML('beforeend', CHECK_SVG);

  btn.addEventListener('click', onPick);
  return btn;
}

/**
 * 时钟样式那一行：左边样式名，右边一段示例 —— 用的就是**该样式真实的字体与观感**。
 * 做法是把同一个 data-clock-style 挂在按钮上：CSS 里那套 --clock-* 变量是继承的，
 * 所以示例文字自动拿到真实时钟的字体 / 字重 / 描边 / 发光，不用另写一套预览样式。
 */
function clockStyleRow(style, selected, onPick) {
  const btn = document.createElement('button');
  btn.className = 'menu-item menu-item--clock';
  btn.type = 'button';
  btn.setAttribute('aria-selected', String(selected));
  btn.dataset.clockStyle = style.value;

  const label = document.createElement('span');
  label.textContent = style.name;

  const side = document.createElement('span');
  side.className = 'menu-item__side';

  const sample = document.createElement('span');
  sample.className = 'clock-face clock-sample';
  sample.textContent = '08:30';
  sample.setAttribute('aria-hidden', 'true');   // 读屏念「零八三零」只会添乱
  side.append(sample);

  if (selected) side.insertAdjacentHTML('beforeend', CHECK_SVG);

  btn.append(label, side);
  btn.addEventListener('click', onPick);
  return btn;
}

function switchRow(label, checked, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'row row--switch';

  const span = document.createElement('span');
  span.className = 'row__label';
  span.textContent = label;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'switch';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));

  wrap.append(span, input);
  return wrap;
}

function infoRow(label, value) {
  const row = document.createElement('div');
  row.className = 'row';

  const l = document.createElement('span');
  l.className = 'row__label';
  l.textContent = label;

  const v = document.createElement('span');
  v.className = 'row__value';
  v.textContent = value;

  row.append(l, v);
  return row;
}

/* ------------------------------------------------------------------
 * 渲染
 * ------------------------------------------------------------------ */

function render() {
  if (!cfg) return;

  // 界面组件
  el.widgetToggles.replaceChildren(...Object.entries(WIDGET_META).map(([id, meta]) =>
    switchRow(meta.name, cfg.layout.widgets[id]?.visible !== false, (visible) => {
      patchConfig({ layout: { widgets: { [id]: { visible } } } });
    })));

  // 时钟样式
  el.clockChoices.replaceChildren(...CLOCK_STYLES.map((style) =>
    clockStyleRow(style, cfg.clock?.style === style.value, () => {
      patchConfig({ clock: { style: style.value } });
    })));

  // 每日一言
  el.quoteChoices.replaceChildren(...QUOTE_SOURCES.map((source) =>
    choiceRow(source.name, cfg.quote?.source === source.value, () => {
      patchConfig({ quote: { source: source.value } });
    })));
  el.quoteHint.textContent = cfg.quote?.source === 'hitokoto'
    ? '联网取自一言（hitokoto.cn）：每打开一次新标签页从池子里取一句，后台接着补货；'
      + '第一次会先用内置那句顶上。拿不到就继续用内置句子，不会空着。'
    : '内置 60 句：每打开一次新标签页换一句，一袋抽完才重洗，所以不会连着两次是同一句。'
      + '不发任何网络请求，断网也在。';

  // 搜索引擎
  const suggestOn = cfg.search?.suggest !== false;
  el.engineChoices.replaceChildren(
    ...cfg.search.engines.map((engine) =>
      choiceRow(engine.name, engine.id === cfg.search.engineId, () => {
        patchConfig({ search: { engineId: engine.id } });
      })),
    switchRow('输入时联想搜索词', suggestOn, (on) => {
      patchConfig({ search: { suggest: on } });
    }),
  );
  // 这句得说清楚：开了之后，输入框里敲的字是会发出去的
  el.searchSuggestHint.textContent = suggestOn
    ? '开启中：敲字时会去问当前引擎自己的联想接口（百度 / Bing / Google / B站 各用各的，'
      + 'GitHub 没有这个接口）。只发你正在敲的那几个字，不带别的信息；输入停顿一下才发一次。'
    : '已关闭：输入框里敲的字一个字都不发出去，按回车直接搜。';

  // 天气
  const weatherHidden = cfg.layout.widgets.weather?.visible === false;
  el.cityRow.replaceChildren(
    infoRow('当前城市', cfg.weather.city || '未设置'),
    infoRow('刷新间隔', `${cfg.weather.ttlMinutes || 10} 分钟`),
  );
  el.changeCity.disabled = weatherHidden;
  el.changeCity.textContent = weatherHidden ? '先显示天气组件' : '更换城市';

  // 壁纸
  el.wallpaperChoices.replaceChildren(
    ...WALLPAPER_SOURCES.map((s) =>
      choiceRow(s.name, cfg.wallpaper.source === s.value, () => changeWallpaper({ source: s.value }))),
    ...WALLPAPER_QUALITIES.map((q) =>
      choiceRow(q.name, cfg.wallpaper.quality === q.value, () => changeWallpaper({ quality: q.value }))),
  );
  renderCustomWallpaper();

  // 快捷方式
  el.shortcutCount.textContent = `${cfg.shortcuts.length} 个`;

  renderSync();
}

/**
 * 自定义壁纸那一行：缩略图 + 文件名 / 尺寸 / 大小。
 * 缩略图直接复用 data URL —— 图片本来就在内存里，不必再读一次存储。
 */
function renderCustomWallpaper() {
  const custom = cfg.wallpaper.custom;
  const has = typeof custom?.dataUrl === 'string' && custom.dataUrl.length > 0;

  el.wallpaperThumb.style.backgroundImage = has ? `url("${custom.dataUrl}")` : '';
  el.wallpaperThumb.classList.toggle('is-ready', has);
  el.wallpaperName.textContent = has
    ? `${custom.name || '自定义图片'} · ${custom.width}×${custom.height} · ${Math.round(custom.dataUrl.length / 1024)}KB`
    : '还没传过图片';
  el.wallpaperClear.disabled = !has;
}

async function renderSync() {
  const status = await getSyncStatus();
  const providers = listProviders().map((p) => p.label).join(' / ');
  el.syncStatus.replaceChildren(
    infoRow('状态', status.message),
    infoRow('实现', providers),
    infoRow('上次同步', status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : '—'),
  );
}

/* ------------------------------------------------------------------
 * 动作
 * ------------------------------------------------------------------ */

/** 改壁纸要连缓存一起清掉，否则今天之内换的画质不会生效（缓存按天命中） */
async function changeWallpaper(patch) {
  await storageSet('wallpaper', null);
  const next = await patchConfig({ wallpaper: patch });
  initWallpaper(next.wallpaper).catch((err) => console.warn('[壁纸] 重载失败：', err));
}

export function openSettings() {
  if (el.dialog?.open) return;
  // 编辑模式是 sticky 浮层，closeAll 不会关它，这里得显式退掉 ——
  // 否则设置面板会盖在一个还处于编辑态的页面上，退出时状态就对不上了
  if (isEditing()) setEditing(false);
  closeAll();          // 关掉天气面板 / 引擎下拉 / 磁贴表单
  render();
  el.dialog.showModal();
}

export function closeSettings() {
  if (el.dialog?.open) el.dialog.close();
}

/* ------------------------------------------------------------------
 * 导入 / 导出
 * ------------------------------------------------------------------ */

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 只认 data:image/... 的字符串，并卡住长度。
 * 导入是唯一能让外部数据进到存储里的入口，不卡长度的后果是直接顶爆存储配额。
 */
function cleanImage(value, maxChars) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('data:image/') || value.length > maxChars) return null;
  return value;
}

/**
 * 夹到 [lo, hi]。非数字一律用 fallback。
 *
 * ⚠️ 光判 Number.isFinite 不够：Number(null) === 0、Number('') === 0、Number(true) === 1，
 * 都是「有限数」。导入一份 y: null 的配置会让组件跑到最上边而不是回默认位置 ——
 * 不致命但完全不是用户的本意。所以先把这些「看着像数字其实不是」的值挡掉。
 */
function num(value, lo, hi, fallback) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 导入的配置一律先过这里。
 *
 * 不校验的话，x: NaN 会让 `calc(NaN * 1%)` 整体作废、left 退回 auto，
 * 所有组件堆到左上角，而且改配置也救不回来 —— 只能清存储重来。
 * 快捷方式的 url 也必须过白名单，挡掉 javascript: 这类。
 */
function sanitizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('不是有效的配置对象');
  }
  const out = {};
  const known = new Set(getWidgetIds());

  if (raw.layout?.widgets && typeof raw.layout.widgets === 'object') {
    const widgets = {};
    for (const [id, item] of Object.entries(raw.layout.widgets)) {
      if (!known.has(id) || !item || typeof item !== 'object') continue;   // 未知组件丢弃
      widgets[id] = {
        visible: item.visible !== false,
        x: num(item.x, 0, 100, 50),
        y: num(item.y, 0, 100, 50),
      };
    }
    if (Object.keys(widgets).length) out.layout = { widgets };
  }

  if (raw.search && typeof raw.search === 'object') {
    const search = {};
    if (Array.isArray(raw.search.engines)) {
      const engines = raw.search.engines
        .filter((e) => e && typeof e.id === 'string' && typeof e.name === 'string'
          && typeof e.url === 'string' && e.url.includes('%s') && isHttpUrl(e.url))
        .slice(0, 12)
        .map((e) => ({ id: e.id, name: e.name.slice(0, 20), url: e.url }));
      if (engines.length) search.engines = engines;
    }
    if (typeof raw.search.engineId === 'string') search.engineId = raw.search.engineId;
    if (typeof raw.search.suggest === 'boolean') search.suggest = raw.search.suggest;
    if (Object.keys(search).length) out.search = search;
  }

  if (raw.wallpaper && typeof raw.wallpaper === 'object') {
    const w = {};
    if (['bing', 'custom', 'none'].includes(raw.wallpaper.source)) {
      w.source = raw.wallpaper.source;
    }
    if (raw.wallpaper.quality === '1920x1080' || raw.wallpaper.quality === 'UHD') {
      w.quality = raw.wallpaper.quality;
    }
    if (typeof raw.wallpaper.market === 'string') w.market = raw.wallpaper.market.slice(0, 12);

    const custom = raw.wallpaper.custom;
    if (custom && typeof custom === 'object') {
      const dataUrl = cleanImage(custom.dataUrl, MAX_WALLPAPER_CHARS);
      // 图片不合法就整条丢掉：留着 source: 'custom' 但没有图，壁纸会退回渐变，
      // 而且「我上传的图片」那一项还会显示成选中，看着像坏了
      if (dataUrl) {
        w.custom = {
          dataUrl,
          name: typeof custom.name === 'string' ? custom.name.slice(0, 60) : '自定义壁纸',
          width: num(custom.width, 0, 20000, 0),
          height: num(custom.height, 0, 20000, 0),
        };
      } else if (w.source === 'custom') {
        w.source = 'bing';
      }
    }

    if (Object.keys(w).length) out.wallpaper = w;
  }

  if (raw.weather && typeof raw.weather === 'object') {
    const t = {};
    if (typeof raw.weather.city === 'string') t.city = raw.weather.city.slice(0, 40);
    if (Number.isFinite(Number(raw.weather.latitude))) {
      t.latitude = num(raw.weather.latitude, -90, 90, 0);
    }
    if (Number.isFinite(Number(raw.weather.longitude))) {
      t.longitude = num(raw.weather.longitude, -180, 180, 0);
    }
    if (Number.isFinite(Number(raw.weather.ttlMinutes))) {
      t.ttlMinutes = num(raw.weather.ttlMinutes, 1, 1440, 10);
    }
    if (Object.keys(t).length) out.weather = t;
  }

  // 时钟样式与一言来源都只认白名单里的值：写进一个不认识的 id 只会让 CSS 匹配不上，
  // 时钟退回默认字体、一言静默不联网 —— 不致命，但完全不是用户的本意
  if (raw.clock && typeof raw.clock === 'object' && isClockStyle(raw.clock.style)) {
    out.clock = { style: raw.clock.style };
  }

  if (raw.quote && typeof raw.quote === 'object' && isQuoteSource(raw.quote.source)) {
    out.quote = { source: raw.quote.source };
  }

  if (Array.isArray(raw.shortcuts)) {
    out.shortcuts = raw.shortcuts
      .filter((s) => s && typeof s.url === 'string' && isHttpUrl(s.url))
      .slice(0, 100)
      .map((s) => {
        const item = { name: String(s.name ?? '').slice(0, 24) || s.url, url: s.url };
        const icon = cleanImage(s.icon, MAX_ICON_CHARS);
        if (icon) item.icon = icon;
        return item;
      });
  }

  return out;
}

function exportConfig() {
  const payload = {
    app: '起始页',
    version: 1,
    exportedAt: new Date().toISOString(),
    config: cfg,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `起始页配置-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importConfig(file) {
  let raw;
  try {
    const parsed = JSON.parse(await file.text());
    raw = sanitizeConfig(parsed?.config ?? parsed);   // 也接受直接就是一个配置对象
  } catch (err) {
    console.warn('[设置] 导入失败：', err);
    el.importHint.textContent = `导入失败：${err.message}`;
    return;
  }

  await replaceConfig(raw);
  location.reload();   // 整份配置都换了，重新加载最干净，不会留下半套状态
}

/* ------------------------------------------------------------------
 * 初始化
 * ------------------------------------------------------------------ */

export function initSettings(initial) {
  cfg = initial;

  el = {
    dialog: document.getElementById('settings'),
    openBtn: document.getElementById('settingsBtn'),
    closeBtn: document.getElementById('settingsClose'),
    widgetToggles: document.getElementById('widgetToggles'),
    clockChoices: document.getElementById('clockChoices'),
    quoteChoices: document.getElementById('quoteChoices'),
    quoteHint: document.getElementById('quoteHint'),
    engineChoices: document.getElementById('engineChoices'),
    searchSuggestHint: document.getElementById('searchSuggestHint'),
    cityRow: document.getElementById('cityRow'),
    changeCity: document.getElementById('changeCity'),
    wallpaperChoices: document.getElementById('wallpaperChoices'),
    wallpaperThumb: document.getElementById('wallpaperThumb'),
    wallpaperName: document.getElementById('wallpaperName'),
    wallpaperHint: document.getElementById('wallpaperHint'),
    wallpaperUpload: document.getElementById('wallpaperUpload'),
    wallpaperClear: document.getElementById('wallpaperClear'),
    wallpaperFile: document.getElementById('wallpaperFile'),
    shortcutCount: document.getElementById('shortcutCount'),
    syncStatus: document.getElementById('syncStatus'),
    adjustLayout: document.getElementById('adjustLayout'),
    resetLayoutBtn: document.getElementById('resetLayout'),
    editShortcuts: document.getElementById('editShortcuts'),
    exportBtn: document.getElementById('exportConfig'),
    importBtn: document.getElementById('importConfig'),
    importFile: document.getElementById('importFile'),
    resetConfig: document.getElementById('resetConfig'),
    importHint: document.getElementById('importHint'),
  };

  if (!el.dialog) return;

  el.openBtn.addEventListener('click', openSettings);
  el.closeBtn.addEventListener('click', closeSettings);

  // 点遮罩关闭：<dialog> 的点击目标是 dialog 自己时说明点在了 ::backdrop 上
  el.dialog.addEventListener('click', (event) => {
    if (event.target === el.dialog) closeSettings();
  });

  // 关掉后把焦点还给齿轮，键盘用户不会掉到页面开头
  el.dialog.addEventListener('close', () => {
    el.importHint.textContent = '导入会覆盖当前的搜索引擎、壁纸、天气、快捷方式与布局。';
    el.openBtn.focus();
  });

  el.changeCity.addEventListener('click', () => {
    closeSettings();
    document.getElementById('weatherBtn')?.click();
  });

  el.adjustLayout.addEventListener('click', () => {
    closeSettings();
    setEditing(true);
  });

  el.editShortcuts.addEventListener('click', () => {
    closeSettings();
    setEditing(true);
  });

  el.resetLayoutBtn.addEventListener('click', () => resetLayout());

  // 上传自定义壁纸：压好之后连来源一起切过去，不用再点一下「我上传的图片」
  el.wallpaperUpload.addEventListener('click', () => el.wallpaperFile.click());
  el.wallpaperFile.addEventListener('change', async () => {
    const file = el.wallpaperFile.files?.[0];
    el.wallpaperFile.value = '';        // 允许连续选同一个文件
    if (!file) return;

    if (file.size > MAX_WALLPAPER_FILE) {
      el.wallpaperHint.textContent = '图片太大了，换一张（25MB 以内）';
      return;
    }

    el.wallpaperHint.textContent = '正在处理…';
    try {
      const custom = await fileToWallpaper(file);
      await changeWallpaper({ source: 'custom', custom });
      el.wallpaperHint.textContent = `已换成 ${custom.name}（${custom.width}×${custom.height}）`;
    } catch (err) {
      console.warn('[设置] 壁纸读取失败：', err);
      el.wallpaperHint.textContent = '这张图读不出来，换一张试试（SVG 暂不支持）';
    }
  });

  el.wallpaperClear.addEventListener('click', () => {
    const patch = { custom: null };
    // 正用着它才需要顺手切回 Bing，不然会停在「自定义但没有图」的渐变上
    if (cfg.wallpaper.source === 'custom') patch.source = 'bing';
    changeWallpaper(patch);
    el.wallpaperHint.textContent = '已移除自定义壁纸';
  });

  el.exportBtn.addEventListener('click', exportConfig);
  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', () => {
    const file = el.importFile.files?.[0];
    if (file) importConfig(file);
    el.importFile.value = '';   // 允许连续导入同一个文件
  });
  el.resetConfig.addEventListener('click', async () => {
    await replaceConfig({});
    location.reload();
  });

  // 配置从别处变了（比如选了新引擎）就重画一遍，面板里的勾选永远是对的
  onConfigChange((next) => {
    cfg = next;
    if (el.dialog.open) render();
  });
}
