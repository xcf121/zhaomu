/**
 * 组件布局：位置、显隐、编辑模式、拖拽与吸附。
 *
 * 坐标模型：每个组件在配置里存 x / y 两个 0–100 的**纯数字**，
 * 换算全部交给 CSS（见 style.css 的 .widget），这个模块只负责把数字写进 CSS 变量。
 * 好处是窗口缩放、分辨率变化、投屏切换都不需要 JS 参与。
 *
 * 拖拽期间的坐标一律用「相对 .stage 的像素」，松手时才换算成百分比存盘。
 * 这样吸附阈值是稳定的 8px，不会因为窗口大小变化而变得手感不同。
 */

import { patchConfig, onConfigChange, DEFAULT_CONFIG } from './config.js';
import { pushLayer, popLayer, closeAll } from './layers.js';

/** 组件清单。设置面板的开关列表也从这里生成，加组件只改这一处 */
export const WIDGET_META = {
  clock:     { name: '时钟' },
  search:    { name: '搜索框' },
  shortcuts: { name: '快捷方式' },
  weather:   { name: '天气' },
  credit:    { name: '壁纸版权' },
};

/** 吸附阈值：低于这个像素差就吸过去并显示辅助线 */
const SNAP_PX = 8;

const GRIP_SVG =
  '<svg viewBox="0 0 12 12" aria-hidden="true">' +
  '<path d="M4 2.5v7M8 2.5v7" stroke-width="1.4"/></svg>';

const CLOSE_SVG =
  '<svg viewBox="0 0 12 12" aria-hidden="true">' +
  '<path d="M3 3l6 6M9 3l-6 6" stroke-width="1.5"/></svg>';

const stage = document.getElementById('stage');
const guides = document.getElementById('guides');
const editBar = document.getElementById('editBar');
const widgets = new Map();

let editing = false;
let drag = null;

function collect() {
  if (!stage) return;
  for (const el of stage.querySelectorAll('.widget')) {
    const id = el.dataset.widget;
    if (id) widgets.set(id, el);
  }
}

export function getWidgetEl(id) {
  return widgets.get(id) ?? null;
}

export function getWidgetIds() {
  return [...widgets.keys()];
}

/** 0–100 之外的、以及 NaN 一律拉回来。NaN 会让 calc() 整体作废、组件全堆到左上角 */
function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(0, n));
}

/** 把配置写进 DOM。幂等，可以反复调 */
export function applyLayout(layout) {
  const conf = layout?.widgets ?? {};

  for (const [id, el] of widgets) {
    const item = conf[id] ?? {};
    el.style.setProperty('--x', String(clampPercent(item.x)));
    el.style.setProperty('--y', String(clampPercent(item.y)));

    if (item.visible === false) el.setAttribute('data-hidden', '1');
    else el.removeAttribute('data-hidden');
  }
}

/* ------------------------------------------------------------------
 * 编辑模式
 *
 * 为什么要「进模式」而不是随时可拖：平时组件里全是可交互的东西（输入框、链接、磁贴），
 * 随时可拖必然误触。进模式后组件内容一律 inert，拖拽才安全。
 * ------------------------------------------------------------------ */

export function isEditing() {
  return editing;
}

export function setEditing(on) {
  if (editing === on) return;

  if (on) {
    // 先把其它浮层关掉，否则它们会以「内容已 inert」的姿态卡在屏幕上
    closeAll();
    document.activeElement?.blur();   // inert 挡不住已经拿到手的键盘焦点
  }

  editing = on;
  document.body.classList.toggle('is-editing', on);

  for (const [id, widget] of widgets) {
    const content = widget.querySelector('.widget__content');
    if (!content) continue;
    // 快捷方式网格例外：磁贴本身要能拖，见 shortcuts.js
    if (on && id !== 'shortcuts') content.setAttribute('inert', '');
    else content.removeAttribute('inert');
  }

  if (editBar) editBar.hidden = !on;

  if (on) {
    pushLayer({
      id: 'editLayout',
      scope: [editBar],
      // 编辑态是「模式」不是浮层：点别处（比如伸手去拖组件、或点「+」开表单）都不能退出，
      // 否则一按下去就退出了，根本拖不动。只认「完成」按钮和 Escape。
      sticky: true,
      close: () => setEditing(false),
    });
  } else {
    popLayer('editLayout');
    renderGuides(null, null);
    endDrag(false);
  }

  // 广播出去，让快捷方式自己决定要不要变成可拖状态。用事件而不是互相 import，保持解耦。
  document.dispatchEvent(new CustomEvent('editmodechange', { detail: { editing: on } }));
}

export function resetLayout() {
  return patchConfig({ layout: structuredClone(DEFAULT_CONFIG.layout) });
}

/* ------------------------------------------------------------------
 * 每个组件的编辑手柄（只在编辑态出现，所以由 JS 注入，不占 HTML）
 * ------------------------------------------------------------------ */

function buildChrome(id) {
  const widget = widgets.get(id);
  if (!widget || widget.querySelector('.widget__chrome')) return;

  const name = WIDGET_META[id]?.name ?? id;

  const chrome = document.createElement('div');
  chrome.className = 'widget__chrome';

  const grip = document.createElement('button');
  grip.className = 'widget__grip';
  grip.type = 'button';
  grip.tabIndex = -1;
  grip.setAttribute('aria-label', `拖动${name}`);
  grip.innerHTML = GRIP_SVG;

  const hide = document.createElement('button');
  hide.className = 'widget__hide';
  hide.type = 'button';
  hide.tabIndex = -1;
  hide.setAttribute('aria-label', `隐藏${name}`);
  hide.innerHTML = CLOSE_SVG;
  hide.addEventListener('click', () => {
    const nowHidden = widgets.get(id)?.hasAttribute('data-hidden');
    patchConfig({ layout: { widgets: { [id]: { visible: nowHidden } } } });
  });

  chrome.append(grip, hide);
  widget.append(chrome);
}

/* ------------------------------------------------------------------
 * 拖拽与吸附
 * ------------------------------------------------------------------ */

/** 组件在 stage 坐标系里的某条参考线 */
function collectRefs(axis, self) {
  const vertical = axis === 'x';
  const size = vertical ? stage.clientWidth : stage.clientHeight;
  const sr = stage.getBoundingClientRect();

  const refs = [
    { pos: 0, center: false },
    { pos: size / 2, center: true },
    { pos: size, center: false },
  ];

  for (const [, el] of widgets) {
    if (el === self || el.hasAttribute('data-hidden')) continue;   // 隐藏的不在最终画面上，不参与
    const r = el.getBoundingClientRect();
    const start = (vertical ? r.left - sr.left : r.top - sr.top);
    const len = vertical ? r.width : r.height;
    refs.push({ pos: start, center: false });
    refs.push({ pos: start + len / 2, center: true });
    refs.push({ pos: start + len, center: false });
  }

  return refs;
}

/**
 * 在一条轴上找最近的吸附。
 * 组件的三条边（起 / 中 / 末）分别和每条参考线比一次，取差值最小且在阈值内的。
 */
function snapAxis(raw, size, refs, travel) {
  const clamped = Math.min(Math.max(raw, 0), Math.max(0, travel));
  if (travel <= 1) return { pos: clamped, snapped: false };   // 组件比可用空间还大，这条轴没意义

  const edges = [raw, raw + size / 2, raw + size];
  let best = null;

  for (const ref of refs) {
    for (const edge of edges) {
      const delta = ref.pos - edge;
      if (Math.abs(delta) > SNAP_PX) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, ref };
    }
  }
  if (!best) return { pos: clamped, snapped: false };

  const pos = raw + best.delta;
  // 吸附可能把组件推出边界（比如把右边缘对齐到某个靠左组件的左边缘），那这次吸附作废
  if (pos < -0.5 || pos > travel + 0.5) return { pos: clamped, snapped: false };
  return { pos, snapped: true, ref: best.ref };
}

/** 像素 → 百分比。靠近 0/50/100 时写死整数，免得「居中」存成 49.9997 */
function toPercent(pos, travel) {
  if (travel <= 0) return 50;
  const pct = (pos / travel) * 100;
  const exact = [0, 50, 100].find((v) => Math.abs(pct - v) < 0.5);
  return exact ?? Math.round(pct * 100) / 100;
}

function renderGuides(xRef, yRef) {
  if (!guides) return;

  const frag = document.createDocumentFragment();
  for (const [axis, ref] of [['x', xRef], ['y', yRef]]) {
    if (!ref) continue;
    const line = document.createElement('i');
    line.className = `guide guide--${axis}${ref.center ? ' is-center' : ''}`;
    line.style.setProperty(axis === 'x' ? 'left' : 'top', `${ref.pos}px`);
    frag.append(line);
  }
  guides.replaceChildren(frag);
}

function onPointerMove(event) {
  if (!drag) return;
  drag.pointer.x = event.clientX;
  drag.pointer.y = event.clientY;
  drag.moved = true;
  updateDrag();
}

/**
 * 直接同步更新，**不套 requestAnimationFrame**。
 * 指针事件本来就是「每帧至多一次」（浏览器会先合并高频事件再派发），再套一层 rAF 没有收益；
 * 而 rAF 在无头环境、后台标签页里会停摆，套上去反而让整个拖拽卡死不动。
 */
function updateDrag() {
  const sr = stage.getBoundingClientRect();
  // 永远从指针的原始位置推导，绝不在上一帧的吸附结果上累加 —— 否则会一点点漂移
  const rawL = drag.pointer.x - drag.grabDX - sr.left;
  const rawT = drag.pointer.y - drag.grabDY - sr.top;

  const sx = snapAxis(rawL, drag.w, drag.refsX, drag.travelX);
  const sy = snapAxis(rawT, drag.h, drag.refsY, drag.travelY);
  drag.pos = { x: sx.pos, y: sy.pos };

  drag.widget.style.setProperty('--x', String(toPercent(sx.pos, drag.travelX)));
  drag.widget.style.setProperty('--y', String(toPercent(sy.pos, drag.travelY)));

  renderGuides(sx.snapped ? sx.ref : null, sy.snapped ? sy.ref : null);
}

function onPointerUp() {
  endDrag(true);
}

function onPointerCancel() {
  endDrag(false);
}

/**
 * @param {boolean} commit true = 落盘；false = 回滚到拖动前（取消、Esc、窗口尺寸变了）
 */
function endDrag(commit) {
  if (!drag) return;
  const d = drag;
  drag = null;

  d.widget.classList.remove('is-dragging');
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  renderGuides(null, null);

  if (!commit || !d.moved) {
    d.widget.style.setProperty('--x', d.startX);
    d.widget.style.setProperty('--y', d.startY);
    if (!commit) return;
  }
  if (!d.moved) return;   // 只是点了一下没拖，不必白写一次配置

  patchConfig({
    layout: {
      widgets: {
        [d.id]: {
          x: toPercent(d.pos.x, d.travelX),
          y: toPercent(d.pos.y, d.travelY),
        },
      },
    },
  }).catch((err) => console.warn('[布局] 保存位置失败：', err));
}

function onPointerDown(event, id, widget) {
  if (!editing || event.button !== 0 || drag) return;
  // 隐藏按钮和磁贴有自己的行为，别抢它们的指针
  if (event.target.closest('.widget__hide, .tile')) return;

  const sr = stage.getBoundingClientRect();
  const r = widget.getBoundingClientRect();
  const w = widget.offsetWidth;      // offsetWidth 不受 transform 影响，比 rect 稳
  const h = widget.offsetHeight;
  const availW = stage.clientWidth;

  drag = {
    id,
    widget,
    w,
    h,
    travelX: availW - w,
    travelY: stage.clientHeight - h,
    grabDX: event.clientX - r.left,
    grabDY: event.clientY - r.top,
    startX: widget.style.getPropertyValue('--x'),
    startY: widget.style.getPropertyValue('--y'),
    startLeft: r.left - sr.left,
    startTop: r.top - sr.top,
    refsX: collectRefs('x', widget),
    refsY: collectRefs('y', widget),
    pointer: { x: event.clientX, y: event.clientY },
    pos: null,
    moved: false,
  };
  drag.pos = { x: drag.startLeft, y: drag.startTop };

  widget.classList.add('is-dragging');
  // 指针捕获让手指/鼠标移出窗口还能继续收 move。
  // 合成事件（自动化测试）没有真实指针，这里会抛 NotFoundError，所以兜一下 ——
  // 没有捕获也能正常拖，只是移出窗口后会断。
  try {
    widget.setPointerCapture(event.pointerId);
  } catch { /* 没有活动指针，忽略 */ }
  event.preventDefault();

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}

/* ------------------------------------------------------------------
 * 初始化
 * ------------------------------------------------------------------ */

export function initLayout(layout) {
  collect();
  applyLayout(layout);

  for (const id of widgets.keys()) buildChrome(id);

  for (const [id, widget] of widgets) {
    widget.addEventListener('pointerdown', (event) => onPointerDown(event, id, widget));
  }

  document.getElementById('editDone')?.addEventListener('click', () => setEditing(false));

  // 拖拽中窗口尺寸一变，之前缓存的参考线和可用空间全失效了，直接取消这次拖拽
  window.addEventListener('resize', () => {
    if (drag) endDrag(false);
  });

  // 配置从别处变了（设置面板的开关、导入、恢复默认）就跟着重画
  onConfigChange((next) => applyLayout(next.layout));
}
