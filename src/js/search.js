/**
 * 搜索框。
 * 输入关键词 → 走当前搜索引擎；输入的是网址 → 直接跳过去。
 * 两种都**在新标签页打开**：起始页是张一次性的空白页，占着它没意义；
 * 而且搜索框留在原地，从结果页回来还能接着改词重搜。
 * 点左侧引擎名弹出下拉列表选择引擎，选择会被记住。
 */

import { patchConfig, onConfigChange } from './config.js';
import { anyOpen } from './layers.js';
import { togglePopover, closePopover, isPopoverOpen } from './popover.js';

const EXPLICIT_URL   = /^https?:\/\/\S+$/i;
const DOMAIN_LIKE    = /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i;
const LOCALHOST_LIKE = /^localhost(:\d+)?(\/\S*)?$/i;
const IP_LIKE        = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/\S*)?$/;

/** 判断输入是不是网址；是则补全协议返回，否则返回 null 表示该走搜索 */
function toUrl(raw) {
  const s = raw.trim();
  if (!s) return null;
  if (EXPLICIT_URL.test(s)) return s;
  if (/\s/.test(s)) return null;                       // 带空格的一律当搜索词
  if (DOMAIN_LIKE.test(s) || LOCALHOST_LIKE.test(s) || IP_LIKE.test(s)) return `https://${s}`;
  return null;
}

/** 焦点是不是落在某个可输入的地方（搜索框、天气面板的城市输入框…） */
function isEditing(el) {
  return Boolean(el) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

const CHECK_SVG =
  '<svg class="menu-item__check" viewBox="0 0 14 14" aria-hidden="true">' +
  '<path d="M2.8 7.4 5.6 10.2 11.2 4.2" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function initSearch(cfg) {
  const form = document.getElementById('searchForm');
  const input = document.getElementById('searchInput');
  const engineBtn = document.getElementById('engineBtn');
  const engineName = document.getElementById('engineName');
  const hint = document.getElementById('searchHint');
  const menu = document.getElementById('engineMenu');

  let engines = cfg.search.engines;
  let index = Math.max(0, engines.findIndex((e) => e.id === cfg.search.engineId));

  function renderEngine() {
    engineName.textContent = engines[index].name;
    input.placeholder = `在 ${engines[index].name} 搜索，或输入网址`;
  }

  function renderMenu() {
    const frag = document.createDocumentFragment();

    engines.forEach((engine, i) => {
      const btn = document.createElement('button');
      btn.className = 'menu-item';
      btn.type = 'button';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(i === index));

      const name = document.createElement('span');
      name.textContent = engine.name;

      btn.append(name);
      if (i === index) btn.insertAdjacentHTML('beforeend', CHECK_SVG);
      btn.addEventListener('click', () => chooseEngine(i));
      frag.append(btn);
    });

    menu.replaceChildren(frag);
  }

  function chooseEngine(i) {
    index = i;
    renderEngine();
    closePopover(menu);
    input.focus();          // 选完直接能打字，不用再点一次输入框

    patchConfig({ search: { engineId: engines[index].id } })
      .catch((err) => console.warn('[搜索] 保存引擎选择失败：', err));
  }

  function submit(event) {
    event.preventDefault();
    const raw = input.value.trim();
    if (!raw) return;

    const direct = toUrl(raw);
    const target = direct ?? engines[index].url.replace('%s', encodeURIComponent(raw));

    // 用 window.open 而不是 location.href：这里一定是用户手势（表单提交），
    // 浏览器不会当弹窗拦掉；走 location.href 则是把起始页本身导航走。
    // noopener 让新页面拿不到 window.opener。
    window.open(target, '_blank', 'noopener');
  }

  form.addEventListener('submit', submit);

  engineBtn.addEventListener('click', () => {
    if (!isPopoverOpen(menu)) renderMenu();   // 每次打开都重画，勾选状态永远是对的
    togglePopover(menu, { anchor: engineBtn, prefer: 'below-start' });
  });

  // 按 / 快速聚焦搜索框。
  // 三种情况不能抢：焦点已经在别的输入框里、有浮层开着（Escape 也由浮层栈独占，
  // 所以这里 Escape 同样要避让 —— 层开着时应该先关层，而不是清空搜索词）
  document.addEventListener('keydown', (event) => {
    const typing = event.target === input;
    if (event.key === '/' && !isEditing(event.target) && !anyOpen()) {
      event.preventDefault();
      input.focus();
      input.select();
    }
    if (event.key === 'Escape' && typing && !anyOpen()) {
      input.value = '';
    }
  });

  hint.addEventListener('click', () => input.focus());

  // 从搜索结果返回时清空上一次的输入，避免「怎么还留着刚才的词」
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) input.value = '';
  });

  // 引擎在别处被改了（设置面板、导入配置）就跟着换，下拉的勾选也才跟得上
  onConfigChange((next) => {
    engines = next.search.engines;
    index = Math.max(0, engines.findIndex((e) => e.id === next.search.engineId));
    renderEngine();
  });

  renderEngine();
  input.focus();
}
