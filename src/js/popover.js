/**
 * 统一浮层：引擎下拉、天气面板、「+」磁贴的表单共用同一套定位、开关与入场动画。
 *
 * 这是「风格不割裂」在行为层的落点 —— 三处浮层的行为完全一致，
 * 用户学一次就够了：点触发器开、点别处关、Escape 关、选项选中即关。
 *
 * 为什么不用 position: fixed —— .widget 上有 transform，fixed 后代的包含块会变成
 * 那个 widget 而不是视口，行为不可预期。这里统一用 absolute + 本地坐标换算。
 */

import { pushLayer, popLayer, closeAll } from './layers.js';

const OPEN = 'is-open';
const GAP = 8;        // 浮层与锚点的间距
const MARGIN = 12;    // 距视口边缘的最小留白

const onCloseMap = new WeakMap();

/** 浮层 → 它的触发器。关的时候要拿它把 aria-expanded 复位 */
const anchorMap = new WeakMap();

/**
 * 触发器上的 aria-expanded 必须成对写：开时 true、关时 false。
 * CSS 就是靠它转箭头的（`.search__engine[aria-expanded="true"] .search__chev`），
 * 只置 true 不复位的话，箭头打开过一次就永远朝上 —— 真实踩过这个坑。
 * 只动声明了 aria-haspopup 的元素：磁贴那种普通按钮不该带 aria-expanded。
 */
function setExpanded(anchor, on) {
  if (!anchor?.hasAttribute('aria-haspopup')) return;
  anchor.setAttribute('aria-expanded', String(on));
}

/** 抬升高度：要盖过所有兄弟组件（它们都是 1），又不至于压住辅助线和工具条 */
const RAISED = 20;

/**
 * 浮层打开时把它所在的组件抬到最上层。
 * 不抬的话，兄弟组件按 DOM 顺序压过来 —— 搜索组件的下拉会被后面的快捷方式网格盖住。
 */
function raiseHost(el, on) {
  const widget = el.closest('.widget');
  if (widget) widget.style.setProperty('--wz', on ? String(RAISED) : '0');
}

export function isPopoverOpen(el) {
  return el.classList.contains(OPEN);
}

/**
 * 定位：先按偏好算，再依次处理溢出。
 * 主轴放不下就翻到另一侧，两侧都放不下就夹进视口 ——
 * 这样组件被拖到屏幕最右边时，下拉也不会跑到屏幕外。
 */
function place(el, anchor, prefer) {
  const ar = anchor.getBoundingClientRect();

  // ⚠️ 顺序很关键：必须先显形再取 offsetParent。
  // display:none 的元素 offsetParent 是 null，先取会退化成 body，
  // 于是算出来的视口坐标被当成 widget 本地坐标用，整个浮层会偏到天边去。
  el.style.visibility = 'hidden';
  el.classList.add(OPEN);

  const container = el.offsetParent ?? document.body;
  const cr = container.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;

  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const [vertical, horizontal] = prefer.split('-');   // below|above + start|end

  let top = vertical === 'below' ? ar.bottom + GAP : ar.top - h - GAP;
  const other = vertical === 'below' ? ar.top - h - GAP : ar.bottom + GAP;
  const fitsHere = top >= MARGIN && top + h <= vh - MARGIN;
  const fitsOther = other >= MARGIN && other + h <= vh - MARGIN;
  if (!fitsHere && fitsOther) top = other;
  top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, vh - h - MARGIN));

  let left = horizontal === 'start' ? ar.left : ar.right - w;
  left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - w - MARGIN));

  el.style.left = `${Math.round(left - cr.left)}px`;
  el.style.top = `${Math.round(top - cr.top)}px`;
  el.style.visibility = '';
}

/**
 * @param {Element} el        浮层本体（必须有 id，浮层栈要用它做标识）
 * @param {object}  opts
 * @param {Element} opts.anchor    触发器
 * @param {string}  [opts.prefer]  'below-start' | 'above-start' | 'below-end' | 'above-end'
 * @param {Function} [opts.onClose]
 */
export function openPopover(el, { anchor, prefer = 'below-start', onClose } = {}) {
  if (isPopoverOpen(el)) return;

  // 同一时刻只留一个浮层：否则引擎下拉和天气面板会叠在一起
  closeAll();

  place(el, anchor ?? el, prefer);
  raiseHost(el, true);

  anchorMap.set(el, anchor);
  setExpanded(anchor, true);
  onCloseMap.set(el, onClose);

  pushLayer({
    id: el.id,
    // scope 必须含触发器：点触发器是「切换」，不能被当成点外部先关掉
    scope: [anchor, el].filter(Boolean),
    close: () => closePopover(el),
  });
}

export function closePopover(el) {
  if (!isPopoverOpen(el)) return;

  el.classList.remove(OPEN);
  el.style.removeProperty('left');
  el.style.removeProperty('top');
  raiseHost(el, false);
  popLayer(el.id);

  const anchor = anchorMap.get(el);
  anchorMap.delete(el);
  setExpanded(anchor, false);

  const onClose = onCloseMap.get(el);
  onCloseMap.delete(el);
  onClose?.();
}

export function togglePopover(el, opts) {
  if (isPopoverOpen(el)) closePopover(el);
  else openPopover(el, opts);
}
