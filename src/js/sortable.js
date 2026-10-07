/**
 * 网格拖拽排序。
 *
 * 用 Pointer Events 而不是 HTML5 拖放，因为网格里的磁贴是 <a href>：
 * 链接原生就可拖拽，HTML5 那套会被浏览器的链接拖拽抢走，还得额外 preventDefault 才压得住。
 *
 * 拖拽期间用「占位块 + 抬起元素」：
 *   · 被拖的元素改成 position: absolute 跟手（已经脱离文档流）
 *   · 原位置换成一个同尺寸的占位块，它随指针在网格里移动，指示落点
 *   · 其它元素用 FLIP（记 rect → 移动 → 再记 rect → 反向 transform → 归零）平滑让位
 * 松手时把占位块换回真身，再从 DOM 反查顺序。
 *
 * ⚠️ 抬起来的那一项**不能**用 position: fixed。
 * .widget 上有 transform，它会成为 fixed 后代的包含块，left/top 于是被解释成
 * 「相对组件左上角」而不是「相对视口」—— 磁贴会整体偏离指针整整一个组件原点的距离，
 * 拖起来就是「飘到别的地方去了」。改成 absolute 后包含块还是 .widget，
 * 但既然两边用同一个坐标系，把它的 rect 减掉就精确对齐了。
 * （popover.js 里「浮层一律 absolute」是同一条约束的第二次踩坑。）
 * 偏移量实测：拖动中磁贴左上角比指针多出 270, 522.6 —— 正是组件原点。
 */

/** ⚠️ WAAPI 的 animate() 不受 CSS 里那条 prefers-reduced-motion 全局规则约束，得自己判 */
const prefersReduced = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 让位动画的缓动，和 CSS 里的 --ease 保持一致 */
const EASE = 'cubic-bezier(0.2, 0.7, 0.3, 1)';

function centerOf(rect) {
  return [rect.left + rect.width / 2, rect.top + rect.height / 2];
}

export function makeSortable(grid, {
  itemSelector,
  handleFilter = () => true,
  enabled = () => false,
  onReorder,
}) {
  let session = null;

  grid.addEventListener('pointerdown', (event) => {
    if (!enabled() || session || event.button !== 0) return;

    const item = event.target.closest(itemSelector);
    if (!item || !grid.contains(item) || !handleFilter(item)) return;

    event.preventDefault();
    start(event, item);
  });

  function slots() {
    return [...grid.children].filter(
      (el) => el !== session?.item && el.matches(itemSelector),
    );
  }

  /** 抬起的那一项在包含块坐标系里的位置：视口坐标减去包含块自己的原点 */
  function place(cx, cy) {
    const { item, root, grabDX, grabDY } = session;
    const rr = root.getBoundingClientRect();
    item.style.left = `${cx - grabDX - rr.left}px`;
    item.style.top = `${cy - grabDY - rr.top}px`;
  }

  function start(event, item) {
    const r = item.getBoundingClientRect();
    // 必须在加 is-sorting（改成 absolute/fixed）之前取：定位一变 offsetParent 也就变了
    const root = item.offsetParent ?? document.body;

    const slot = document.createElement('div');
    slot.className = 'tile tile--slot';
    // 占位块给足和被拖磁贴一样大的尺寸，否则网格行高会缩一下、整排跟着跳
    slot.style.width = `${r.width}px`;
    slot.style.height = `${r.height}px`;
    grid.replaceChild(slot, item);

    // 记住原位，取消时放回去
    const originNext = slot.nextElementSibling;

    grid.append(item);                       // 脱离文档流（马上改成 absolute），放末尾不影响网格
    item.classList.add('is-sorting');
    item.style.width = `${r.width}px`;
    item.style.height = `${r.height}px`;

    session = {
      item, slot, originNext, root, moved: false,
      grabDX: event.clientX - r.left,
      grabDY: event.clientY - r.top,
    };
    place(event.clientX, event.clientY);

    try {
      item.setPointerCapture(event.pointerId);
    } catch { /* 合成事件没有真实指针，忽略 */ }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    // 拖到一半切走窗口 / 切标签页，pointerup 就收不到了，别让磁贴卡在抬起状态
    window.addEventListener('blur', onCancel);
  }

  function onMove(event) {
    if (!session) return;
    const { item, slot } = session;
    session.moved = true;

    place(event.clientX, event.clientY);

    // 滞回：指针还在占位块自己的矩形里就不重排，否则相邻两格之间会来回抖
    const r = slot.getBoundingClientRect();
    if (event.clientX >= r.left && event.clientX <= r.right
      && event.clientY >= r.top && event.clientY <= r.bottom) return;

    let best = null;
    let bestDist = Infinity;
    for (const el of slots()) {
      const [cx, cy] = centerOf(el.getBoundingClientRect());
      const d = (cx - event.clientX) ** 2 + (cy - event.clientY) ** 2;
      if (d < bestDist) { bestDist = d; best = el; }
    }
    if (!best) return;

    // 落在目标的前面还是后面：网格是行优先的，先看行再看列
    const tr = best.getBoundingClientRect();
    const after = event.clientY > tr.bottom
      || (event.clientY >= tr.top && event.clientX > tr.left + tr.width / 2);

    const next = after ? best.nextElementSibling : best;
    if (next === slot) return;                 // 位置没变
    moveSlot(next);
  }

  function moveSlot(next) {
    const { item, slot } = session;

    const before = new Map();
    for (const el of grid.children) {
      if (el !== item) before.set(el, el.getBoundingClientRect());
    }

    grid.insertBefore(slot, next);

    if (prefersReduced()) return;

    // FLIP：先把元素挪回旧位置，下一帧再让它滑过去
    for (const [el, r0] of before) {
      const r1 = el.getBoundingClientRect();
      const dx = r0.left - r1.left;
      const dy = r0.top - r1.top;
      if (!dx && !dy) continue;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 160, easing: EASE },
      );
    }
  }

  function onUp() {
    end(true);
  }

  function onCancel() {
    end(false);
  }

  function end(commit) {
    if (!session) return;
    const s = session;
    session = null;

    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onCancel);

    if (commit && s.moved) {
      const lifted = s.item.getBoundingClientRect();
      s.slot.replaceWith(s.item);

      // 从抬起的位置滑回落点，和其它让位动画是同一套手感
      if (!prefersReduced()) {
        const settled = s.item.getBoundingClientRect();
        const dx = lifted.left - settled.left;
        const dy = lifted.top - settled.top;
        if (dx || dy) {
          s.item.animate(
            [{ transform: `translate(${dx}px, ${dy}px) scale(1.06)` }, { transform: 'none' }],
            { duration: 180, easing: EASE },
          );
        }
      }
    } else {
      // 取消：先恢复占位块的原位，再把真身换回去
      if (s.originNext && grid.contains(s.originNext)) {
        grid.insertBefore(s.slot, s.originNext);
      } else {
        grid.append(s.slot);
      }
      s.slot.replaceWith(s.item);
    }

    s.item.classList.remove('is-sorting');
    s.item.style.cssText = '';                 // 清掉定位、宽高、left/top 等全部内联样式

    if (commit && s.moved) onReorder(slots());
  }

  /**
   * 从外部叫停正在进行的拖拽（回滚，不写盘）。
   * 退出编辑模式时必须调 —— 否则「模式退了、拖拽还在」，磁贴会留在抬起状态继续跟鼠标走，
   * 而且占位块永远留在网格里。这是实测到的真实故障。
   */
  return { cancel: () => end(false) };
}
