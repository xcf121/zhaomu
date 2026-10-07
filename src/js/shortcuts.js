/**
 * 快捷方式网格。
 *
 * 图标怎么来：全交给 js/icons.js 那条链路（自传图标 → _favicon 本地缓存 → 自己存过的
 * 网络图标 → 联网抓 → 首字母色块），这里只负责先铺好首字母兜底再把图标挂上去。
 *
 * 用 <a href> 而不是 JS 点击跳转，是为了让中键 / Ctrl+点击开新标签这类
 * 浏览器原生行为直接可用，不用自己再实现一遍。
 *
 * 两条入口，任何时候都能用（不必先进编辑模式）：
 *   · 网格末尾常驻的「+」磁贴 → 新增
 *   · 右键任意磁贴 → 改名字 / 改网址 / 换图标 / 删除
 * 编辑模式（设置里的「调整图标」）额外提供：拖拽排序、磁贴右上角的删除徽标。
 * 编辑态里链接不跳转 —— 在网格上拦掉 click。
 */

import { patchConfig, onConfigChange } from './config.js';
import { openPopover, closePopover, isPopoverOpen } from './popover.js';
import { makeSortable } from './sortable.js';
import { makeIconElement, attachIcon, fileToIconDataUrl } from './icons.js';

const MAX_SHORTCUTS = 60;

/** 自传图标的原图上限。压完只有 128px，再大的原图没有意义 */
const MAX_ICON_FILE = 4 * 1024 * 1024;

/** 补全协议 + 白名单校验。用户填 github.com 这种也能用 */
export function normalizeUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  const full = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const url = new URL(full);
    // 只认 http/https：挡掉 javascript:、data: 这类
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/* ---------- 磁贴 ---------- */

function createTile(item, index) {
  const url = normalizeUrl(item.url);
  if (!url) return null;

  const tile = document.createElement('a');
  tile.className = 'tile';
  tile.href = url;
  // 默认就在新标签页打开：起始页本身是个一次性的空白页，占着它没意义。
  // 中键 / Ctrl+点击也仍然是新标签页，浏览器原生行为不用自己实现。
  tile.target = '_blank';
  tile.rel = 'noopener';
  tile.title = `${String(item.name || url)}\n右键可修改`;   // 名称被省略号截断时，悬停能看到全称
  // 排序靠这个身份标识把 DOM 顺序映射回配置数组
  tile.dataset.index = String(index);

  const icon = makeIconElement(item.name);

  const name = document.createElement('span');
  name.className = 'tile__name';
  name.textContent = String(item.name || url);

  // 删除徽标：用 span 而不是 button —— <a> 里不允许嵌交互内容，
  // span 不是「交互内容」，这样嵌套是合法的。点击由网格统一代理。
  const del = document.createElement('span');
  del.className = 'tile__del';
  del.title = '删除';

  tile.append(icon, name, del);

  // 异步取图标：成功才把它显出来，在那之前一直是底下那个首字母色块
  attachIcon(icon, url, item.icon);
  return tile;
}

function createAddTile() {
  const btn = document.createElement('button');
  btn.className = 'tile tile--add';
  btn.type = 'button';
  btn.title = '添加快捷方式';

  const icon = document.createElement('span');
  icon.className = 'tile__icon';
  icon.innerHTML =
    '<svg class="tile__plus" viewBox="0 0 20 20" aria-hidden="true">' +
    '<path d="M10 5.5v9M5.5 10h9"/></svg>';

  const name = document.createElement('span');
  name.className = 'tile__name';
  name.textContent = '添加';

  btn.append(icon, name);
  return btn;
}

/* ---------- 模块 ---------- */

export function initShortcuts(shortcuts = []) {
  const box = document.getElementById('shortcuts');
  const form = document.getElementById('tileForm');
  if (!box || !form) return;

  const el = {
    name: document.getElementById('tileName'),
    url: document.getElementById('tileUrl'),
    error: document.getElementById('tileError'),
    save: document.getElementById('tileSave'),
    cancel: document.getElementById('tileCancel'),
    remove: document.getElementById('tileDelete'),
    preview: document.getElementById('tileIconPreview'),
    iconUpload: document.getElementById('tileIconUpload'),
    iconReset: document.getElementById('tileIconReset'),
    iconFile: document.getElementById('tileIconFile'),
  };

  let list = shortcuts;
  let editing = false;
  let formIndex = -1;        // -1 = 新增，≥0 = 编辑已有那条
  let pendingIcon;           // undefined = 没动过，null = 明确要恢复成站点图标，字符串 = 新传的图标

  /** 只有内容真的变了才重画 —— 否则排序保存后会被自己的订阅打断，FLIP 动画白做 */
  function sameList(a, b) {
    return a.length === b.length
      && a.every((x, i) => x.name === b[i].name && x.url === b[i].url && x.icon === b[i].icon);
  }

  function render() {
    const frag = document.createDocumentFragment();
    list.forEach((item, i) => {
      const tile = createTile(item, i);
      if (tile) frag.append(tile);
    });
    frag.append(createAddTile());
    box.replaceChildren(frag);
    box.classList.toggle('is-editable', editing);
  }

  function save(next) {
    return patchConfig({ shortcuts: next.slice(0, MAX_SHORTCUTS) });
  }

  /* ---------- 两条入口：点「+」新增、右键磁贴编辑 ---------- */

  /**
   * 编辑态里的点击统一在这里处理。
   *
   * 必须只有一个处理器：早先分成「捕获拦跳转」+「冒泡开表单」两个，
   * 结果捕获那个 stopPropagation 把「+」的点击也吞掉了，表单永远打不开。
   * 现在按目标分派，各走各的。
   */
  box.addEventListener('click', (event) => {
    // 「+」是常驻入口，不在编辑态也该能添加 —— 以前这个分支写在 editing 判断后面，
    // 于是平时点「+」毫无反应（右键菜单也是这次一并补上的）
    if (event.target.closest('.tile--add')) {
      event.preventDefault();
      openForm(-1);
      return;
    }

    if (!editing) return;          // 平时点磁贴就是普通跳转，不拦

    event.preventDefault();
    event.stopPropagation();

    if (event.target.closest('.tile__del')) {
      const tile = event.target.closest('.tile');
      const index = Number(tile?.dataset.index);
      if (Number.isInteger(index)) {
        save(list.filter((_, i) => i !== index))
          .catch((err) => console.warn('[快捷方式] 删除失败：', err));
      }
    }
  }, true);

  // 右键磁贴 = 编辑它。任何时候都能用，不必先进编辑模式
  box.addEventListener('contextmenu', (event) => {
    const add = event.target.closest('.tile--add');
    const tile = event.target.closest('.tile');
    if (!add && !tile) return;

    event.preventDefault();
    if (add) {
      openForm(-1);
      return;
    }
    const index = Number(tile.dataset.index);
    if (Number.isInteger(index)) openForm(index);
  });

  // 编辑态里关掉链接的原生拖拽，免得和排序抢
  box.addEventListener('dragstart', (event) => {
    if (editing) event.preventDefault();
  });

  const sortable = makeSortable(box, {
    itemSelector: '.tile',
    handleFilter: (tile) => !tile.classList.contains('tile--add'),
    enabled: () => editing,
    onReorder: (ordered) => {
      // 从 DOM 顺序反查回配置数组：每个磁贴记着渲染时的下标
      const next = ordered
        .map((tile) => list[Number(tile.dataset.index)])
        .filter(Boolean);
      if (next.length !== list.length) return;   // 对不上就放弃，别把数据搞坏
      save(next).catch((err) => console.warn('[快捷方式] 排序保存失败：', err));
    },
  });

  document.addEventListener('editmodechange', (event) => {
    editing = Boolean(event.detail?.editing);
    box.classList.toggle('is-editable', editing);
    if (!editing) {
      // 退出编辑模式必须把进行中的拖拽一并收掉。少了这句：Escape 退出了编辑态，
      // 磁贴却还留在「已被抬起」的状态继续跟着鼠标走，占位块也永远留在网格里（实测复现过）。
      sortable.cancel();
      closePopover(form);
    }
  });

  /* ---------- 添加 / 编辑表单 ---------- */

  /** 表单里的图标预览：自传图标优先，否则按网址取站点图标，再不行就是首字母 */
  function renderPreview() {
    const custom = pendingIcon === undefined
      ? (formIndex >= 0 ? list[formIndex]?.icon : null)
      : pendingIcon;
    const url = normalizeUrl(el.url.value);
    const name = el.name.value.trim() || url || '';

    const icon = makeIconElement(name);
    el.preview.replaceChildren(icon);
    el.iconReset.hidden = !custom;

    if (custom) attachIcon(icon, null, custom);
    else if (url) attachIcon(icon, url, null);
  }

  function openForm(index = -1) {
    formIndex = index;
    const item = index >= 0 ? list[index] : null;
    pendingIcon = undefined;

    el.name.value = item?.name ?? '';
    el.url.value = item?.url ?? '';
    el.error.textContent = '';
    el.save.textContent = index >= 0 ? '保存' : '添加';
    el.remove.hidden = index < 0;
    renderPreview();

    // 锚在对应的磁贴上：右键哪个就贴着哪个弹，「+」就贴在「+」上
    const anchor = (index >= 0 && box.querySelector(`.tile[data-index="${index}"]`))
      || box.querySelector('.tile--add')
      || box;

    // 表单可能正为另一个磁贴开着：先关掉再开，才会重新填内容、重新贴到新锚点上
    // （openPopover 自己是幂等的，重复调用直接返回，不会重新定位）
    closePopover(form);
    openPopover(form, { anchor, prefer: 'below-start' });
    el.name.focus();
    if (item) el.name.select();
  }

  function submitForm() {
    const url = normalizeUrl(el.url.value);
    if (!url) {
      el.error.textContent = '网址看起来不对，检查一下';
      el.url.focus();
      return;
    }

    const name = el.name.value.trim() || url.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // 图标只在这一条上改动，没碰过就沿用原来的
    const icon = pendingIcon === undefined
      ? (formIndex >= 0 ? list[formIndex]?.icon : null)
      : pendingIcon;

    const entry = icon ? { name, url, icon } : { name, url };

    const next = list.slice();
    if (formIndex >= 0) {
      next[formIndex] = entry;
    } else {
      if (next.length >= MAX_SHORTCUTS) {
        el.error.textContent = `最多 ${MAX_SHORTCUTS} 个`;
        return;
      }
      next.push(entry);
    }

    save(next)
      .then(() => closePopover(form))
      .catch((err) => {
        console.warn('[快捷方式] 保存失败：', err);
        el.error.textContent = '保存失败，看看控制台';
      });
  }

  /* ---------- 图标：上传 / 恢复成站点图标 ---------- */

  el.iconUpload?.addEventListener('click', () => el.iconFile?.click());

  el.iconFile?.addEventListener('change', async () => {
    const file = el.iconFile.files?.[0];
    el.iconFile.value = '';                 // 允许连续选同一个文件
    if (!file) return;

    if (file.size > MAX_ICON_FILE) {
      el.error.textContent = '图片太大，换一张（4MB 以内）';
      return;
    }

    el.error.textContent = '正在处理…';
    try {
      // 统一压成 128px 方形 PNG 再存，原图多大都不影响配置体积
      pendingIcon = await fileToIconDataUrl(file);
    } catch {
      el.error.textContent = '这张图读不出来，换一张试试（SVG 暂不支持）';
      return;
    }
    el.error.textContent = '';
    renderPreview();
  });

  el.iconReset?.addEventListener('click', () => {
    pendingIcon = null;                     // 明确表示「改回站点自己的图标」
    renderPreview();
  });

  // 名字 / 网址 改完（失焦或回车）才刷新预览：改的过程中不刷，
  // 免得每敲一个字就重新去取一次站点图标
  for (const input of [el.name, el.url]) {
    input?.addEventListener('change', renderPreview);
  }

  /* ---------- 保存 / 删除 / 取消 ---------- */

  el.remove?.addEventListener('click', () => {
    if (formIndex < 0) return;
    save(list.filter((_, i) => i !== formIndex))
      .then(() => closePopover(form))
      .catch((err) => {
        console.warn('[快捷方式] 删除失败：', err);
        el.error.textContent = '删除失败，看看控制台';
      });
  });

  // 表单里回车即提交；Escape 关掉由浮层栈统一处理
  for (const input of [el.name, el.url]) {
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitForm();
      }
    });
  }
  el.save?.addEventListener('click', submitForm);
  el.cancel?.addEventListener('click', () => closePopover(form));

  onConfigChange((next) => {
    if (!sameList(list, next.shortcuts)) {
      list = next.shortcuts;
      render();
    }
  });

  render();
  return { openForm, isFormOpen: () => isPopoverOpen(form) };
}
