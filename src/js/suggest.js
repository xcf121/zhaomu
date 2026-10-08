/**
 * 搜索词联想。
 *
 * 输入框里敲字 → 问当前引擎自己的联想接口 → 在搜索框下面列出来，方向键选、回车搜。
 *
 * 三条规矩：
 *   · **接口地址写死在下面那张表里，不进配置**。它是「哪家引擎」的属性，不是用户偏好；
 *     塞进配置反而会踩一个坑：config.js 的深合并对数组是整体替换，老配置里那份 engines
 *     会把新的默认数组整个盖掉 —— 于是升级上来的人联想静默失效，还很难查
 *   · **远端返回的一律当纯文本**（textContent，绝不拼 HTML）：百度 / B 站的联想里
 *     带着 em 高亮标记，照单全收就是把别人的标记塞进我们的 DOM
 *   · **只在扩展里能用**：这几个接口一个 CORS 头都不带，靠 manifest 的 host_permissions
 *     豁免；本地 python -m http.server 下必然被拦，和联网抓图标是同一个原因，别误判成 bug
 */

import { openPopover, closePopover, isPopoverOpen } from './popover.js';

/** 返回格式 → 解析函数。加一家引擎 = 下面表里加一行 + 这里认一种格式 */
const PARSERS = {
  /** Bing osjson / Google complete：["查询词", ["建议 1", "建议 2"]] */
  osjson(data) {
    const list = Array.isArray(data?.[1]) ? data[1] : [];
    return list.filter((item) => typeof item === 'string');
  },
  /** 百度 sugrec：{ g: [{ q: '建议' }] } */
  baidu(data) {
    const list = Array.isArray(data?.g) ? data.g : [];
    return list.map((item) => item?.q);
  },
  /** B 站 suggest：{ result: { tag: [{ term }] } } —— 取 term，name 那栏里带 HTML */
  bilibili(data) {
    const list = data?.result?.tag;
    return Array.isArray(list) ? list.map((item) => item?.term) : [];
  },
};

/**
 * 按引擎 id 查联想接口。表里没有的（GitHub）就是「这家没有」——
 * 不联想，也不报错，搜索框照常能用。
 */
const PROVIDERS = {
  baidu: {
    format: 'baidu',
    url: 'https://www.baidu.com/sugrec?prod=pc&json=1&wd=%s',
  },
  bing: {
    format: 'osjson',
    url: 'https://api.bing.com/osjson.aspx?query=%s',
  },
  google: {
    format: 'osjson',
    url: 'https://suggestqueries.google.com/complete/search?client=chrome&q=%s',
  },
  bilibili: {
    format: 'bilibili',
    url: 'https://s.search.bilibili.com/main/suggest?term=%s&main_ver=v1&jsonp=jsonp&highlight=',
  },
};

/** 敲字到发请求之间的等待。太短会把「天气」拆成两次请求，太长就没了「联想」的手感 */
const DEBOUNCE_MS = 200;
const TIMEOUT_MS = 4000;

/** 列表是给人扫一眼的，超过八条就开始像噪音 */
const MAX_ITEMS = 8;
const MAX_CHARS = 64;

/** 内存里记一份最近的查询结果：删掉一个字再敲回来是最常见的动作，不该再打一次接口 */
const CACHE_MAX = 80;

/** 有的接口会用 jsonp(...) 包一层，剥掉再解析 */
function parseLoose(text) {
  const trimmed = text.trim();
  const wrapped = /^[A-Za-z_$][\w$]*\(([\s\S]*)\);?$/.exec(trimmed);
  return JSON.parse(wrapped ? wrapped[1] : trimmed);
}

/** 去重、去掉跟输入一模一样的、限长限条数 */
function normalize(list, query) {
  const seen = new Set([query]);
  const out = [];

  for (const raw of list) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_CHARS || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

async function request(engine, query, signal) {
  const provider = PROVIDERS[engine.id];
  if (!provider) return [];

  const res = await fetch(provider.url.replace('%s', encodeURIComponent(query)), {
    signal,
    credentials: 'omit',   // 别把引擎那边的 cookie 捎给联想接口
  });
  if (!res.ok) throw new Error(`${engine.name} 联想返回 ${res.status}`);

  const data = parseLoose(await res.text());
  return normalize(PARSERS[provider.format]?.(data) ?? [], query);
}

/* ------------------------------------------------------------------
 * 接到输入框上
 * ------------------------------------------------------------------ */

/**
 * @param {object}   opts
 * @param {Element}  opts.input      输入框
 * @param {Element}  opts.anchor     浮层锚点，同时算「层内」（搜索表单本身）
 * @param {Element}  opts.panel      列表容器（.popover，必须有 id）
 * @param {Function} opts.getEngine  () => 当前引擎对象
 * @param {Function} opts.isUrlLike  (value) => 是不是网址；是就不联想（用户要的是直接跳）
 * @param {Function} opts.onPick     (query) => 搜这一条
 */
export function initSuggest({ input, anchor, panel, getEngine, isUrlLike, onPick }) {
  if (!input || !anchor || !panel) return { setEnabled() {}, close() {} };

  const cache = new Map();
  let enabled = true;
  let items = [];
  let active = -1;
  let debounce = 0;
  let controller = null;
  /** 同 wallpaper.js：只认最新那一号，先发的请求回来晚了不值一提 */
  let generation = 0;

  const isOpen = () => isPopoverOpen(panel);

  /** 作废在路上的请求。**每次关闭都要调** —— 否则请求回来会把刚关掉的列表又弹开 */
  function cancel() {
    generation += 1;
    controller?.abort();
    controller = null;
    clearTimeout(debounce);
  }

  /**
   * 触发器上的 aria-expanded 必须成对写：开时 true、关时 false。
   * 只写一半的话读屏软件会一直以为列表还开着（和浮层箭头那个坑同一个道理）。
   */
  function syncExpanded(on) {
    input.setAttribute('aria-expanded', String(on));
  }

  function close() {
    cancel();
    closePopover(panel);   // 关掉时走下面的 onClose，状态在那里一起收干净
  }

  function onClose() {
    cancel();
    active = -1;
    items = [];
    syncExpanded(false);
    input.removeAttribute('aria-activedescendant');
  }

  function setActive(next) {
    if (next === active) return;

    const prev = panel.children[active];
    prev?.classList.remove('is-active');
    prev?.setAttribute('aria-selected', 'false');

    active = next;
    const item = panel.children[active];
    if (!item) {
      active = -1;
      input.removeAttribute('aria-activedescendant');
      return;
    }

    item.classList.add('is-active');
    item.setAttribute('aria-selected', 'true');
    item.scrollIntoView({ block: 'nearest' });
    // 焦点始终留在输入框里，读屏软件靠这个属性知道当前选的是哪一条
    input.setAttribute('aria-activedescendant', item.id);
  }

  function render() {
    const frag = document.createDocumentFragment();

    items.forEach((text, i) => {
      const btn = document.createElement('button');
      btn.className = 'menu-item menu-item--suggest';
      btn.type = 'button';
      btn.id = panel.id + '-item-' + i;
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(i === active));

      const label = document.createElement('span');
      label.textContent = text;   // 远端的返回只当纯文本
      btn.append(label);

      // 按下就 preventDefault：点候选项不该把焦点从输入框抢走，
      // 否则光标掉出去，选完还得再点一次输入框（清空键那里踩过同一个坑）
      btn.addEventListener('mousedown', (event) => event.preventDefault());
      btn.addEventListener('click', () => pick(text));

      frag.append(btn);
    });

    panel.replaceChildren(frag);
  }

  function open() {
    if (isOpen()) return;

    // 和搜索框一样宽，看着才是「从输入框里长出来的」。必须在 openPopover 之前设 ——
    // 它内部要读 offsetWidth 定位
    panel.style.width = anchor.offsetWidth + 'px';
    openPopover(panel, { anchor, prefer: 'below-start', onClose });
    syncExpanded(true);
  }

  /** 有结果才开；一条都没有就安静地不显示（不像下拉，联想没必要说「没有」） */
  function show(list) {
    if (!list.length) {
      close();
      return;
    }
    items = list;
    active = -1;
    render();
    open();
  }

  function pick(query) {
    close();
    input.value = query;
    onPick?.(query);
  }

  /** 引擎 id 和查询词之间用一个不会出现在输入里的分隔符，避免两家引擎的键撞上 */
  function cacheKey(engine, query) {
    return engine.id + '\u0000' + query;
  }

  function remember(key, list) {
    cache.delete(key);
    cache.set(key, list);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  async function load(query) {
    const engine = getEngine?.();
    if (!engine || !PROVIDERS[engine.id]) {
      close();
      return;
    }

    const key = cacheKey(engine, query);
    if (cache.has(key)) {
      show(cache.get(key));
      return;
    }

    cancel();
    const mine = generation;
    // 用局部变量而不是共享的 controller：超时回调里要掐的是**这一次**的请求，
    // 读共享变量会掐到后来那一次上去
    const ctrl = new AbortController();
    controller = ctrl;
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
      const list = await request(engine, query, ctrl.signal);
      if (mine !== generation) return;
      remember(key, list);
      show(list);
    } catch (err) {
      if (mine !== generation) return;
      // 联想是锦上添花：拿不到就当没这回事，搜索框本身照常能用
      console.warn('[搜索] 联想失败：', err.message);
      close();
    } finally {
      clearTimeout(timer);
    }
  }

  function update() {
    const query = input.value.trim();
    if (!enabled || !query || isUrlLike?.(query)) {
      close();
      return;
    }

    clearTimeout(debounce);
    debounce = setTimeout(() => void load(query), DEBOUNCE_MS);
  }

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  // 点候选项走的是 mousedown-preventDefault，焦点不会掉，所以这里的 blur 一定是「真的走了」
  input.addEventListener('blur', close);

  input.addEventListener('keydown', (event) => {
    if (!isOpen()) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();   // 不然光标会跳到输入框末尾
      setActive(active + 1 >= items.length ? 0 : active + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(active - 1 < 0 ? items.length - 1 : active - 1);
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();   // 选中了就用选中那条搜；没选中则让表单照常提交
      pick(items[active]);
    }
    // Escape 归浮层栈独占（layers.js 在捕获阶段就拦掉了），这里收不到，也不该收
  });

  return {
    close,
    setEnabled(next) {
      enabled = next !== false;
      if (!enabled) close();
    },
  };
}
