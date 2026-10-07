/**
 * 浮层栈：全站只有这一个地方挂全局监听。
 *
 * 解决什么问题：设置模态、引擎下拉、天气面板、编辑模式各自都要响应 Escape、
 * 都要「点外面关掉」、都要在打开时拦掉全局快捷键。各挂各的 document 监听会互相打架
 * —— 一次 Escape 触发全部，`/` 还会把焦点从浮层里抢走。
 *
 * 关键细节：这里的 keydown 挂在**捕获阶段**。
 * document 上的同节点监听器用 stopPropagation 确实压不住（那是同一相位、同一个节点），
 * 但「document 捕获」在事件传播路径上早于「document 冒泡」，所以捕获阶段
 * stopPropagation 能真正拦掉后面所有冒泡监听。Escape 因此归浮层栈独占。
 *
 * 业务模块判断「有没有浮层开着」一律走 anyOpen()，不依赖监听器注册顺序。
 */

const stack = [];

function top() {
  return stack[stack.length - 1] ?? null;
}

/**
 * 打开一个浮层。重复 push 同一个 id 会被忽略（幂等，方便在 toggle 里直接调）。
 *
 * @param {object}    layer
 * @param {string}    layer.id         唯一标识
 * @param {Function}  layer.close      关掉自己的回调，必须幂等（自己内部再调 popLayer 也行）
 * @param {Element[]} [layer.scope]    算「层内」的元素。**必须包含触发器本身**，
 *                                     否则点一下触发器会「先关自己再开自己」，来回闪。
 * @param {boolean}   [layer.dismissible=true]  Escape 能不能关掉它
 * @param {boolean}   [layer.sticky=false]      「模式」而不是浮层：
 *                                     不参与 closeAll（开别的浮层不会把它顶掉），
 *                                     也不响应「点外部关闭」。编辑模式就是这样 ——
 *                                     它是常驻状态，只认自己的退出按钮和 Escape。
 *                                     少了这条，点「+」开个表单就会把编辑模式一起关掉。
 */
export function pushLayer({
  id,
  close,
  scope = [],
  dismissible = true,
  sticky = false,
}) {
  if (stack.some((layer) => layer.id === id)) return;
  stack.push({ id, close, scope, dismissible, sticky });
}

export function popLayer(id) {
  const index = stack.findIndex((layer) => layer.id === id);
  if (index >= 0) stack.splice(index, 1);
}

/**
 * 关掉所有**非 sticky** 的浮层，从最上层往下。
 * sticky 的（编辑模式）留着 —— 它就是被这条坑过：点「+」开表单时
 * closeAll 顺手把编辑模式也关了，于是表单开出来却已经不在编辑态。
 *
 * 先把要关的整体摘下来再逐个 close —— close 回调里通常还会调 popLayer，
 * 边遍历边改数组会漏掉元素。
 */
export function closeAll() {
  const closing = [];
  const kept = [];
  for (const layer of stack) (layer.sticky ? kept : closing).push(layer);

  stack.length = 0;
  stack.push(...kept);

  for (let i = closing.length - 1; i >= 0; i -= 1) {
    closing[i].close?.();
  }
}

export function anyOpen() {
  return stack.length > 0;
}

export function topLayerId() {
  return top()?.id ?? null;
}

export function isLayerOpen(id) {
  return stack.some((layer) => layer.id === id);
}

/* ------------------------------------------------------------------
 * 全局监听：一个 keydown + 一个 pointerdown，就这两个
 * ------------------------------------------------------------------ */

document.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Escape') return;

    const layer = top();
    if (!layer || !layer.dismissible) return;

    // 吃掉这次 Escape，别让它再去清空搜索框、或者触发别的模块
    event.preventDefault();
    event.stopPropagation();
    layer.close?.();
  },
  true, // 捕获阶段，抢在所有冒泡监听之前
);

document.addEventListener(
  'pointerdown',
  (event) => {
    const layer = top();
    if (!layer || !layer.dismissible || layer.sticky) return;

    const inside = layer.scope.some((el) => el && el.contains(event.target));
    if (inside) return;

    // 不 stopPropagation：点外面该干嘛还干嘛（比如点搜索框仍然要聚焦）
    layer.close?.();
  },
  true,
);
