/**
 * 云同步：**只预留接口，本轮不做实现**。
 *
 * 这里的价值在于把「将来的云同步长什么样」定下来，让设置面板和配置层现在就能
 * 按最终形状接线，以后接的时候不用返工。所有方法在本地实现下都是诚实的空操作 ——
 * 界面会明确显示「未接入」，不做任何假装在同步的 UI。
 *
 * 将来接 chrome.storage.sync 时（PROJECT.md 已定「不引后端，不做账号系统」）：
 *   1. 写一个实现下面 5 个方法的 provider；
 *   2. registerProvider(provider)；
 *   3. 把 config.sync.providerId 指过去。
 *
 * 实现时要处理的几件事（现在先记在这里，免得重新踩）：
 *   · 信封格式 { version, updatedAt, deviceId, data }
 *   · 按顶层域（search / shortcuts / layout / wallpaper）逐域比较 updatedAt，last-write-wins
 *   · weather 不进同步范围（它是本机坐标），sync 自身也不进（会自引用）
 *   · chrome.storage.sync 有配额：单条 8KB / 总计 100KB / 512 条。
 *     快捷方式攒多了信封可能要拆键，这是实现时第一个要处理的
 *   · 收到远端变更后要刷新页面上的组件，且不能打断用户正在进行的拖拽
 */

export const SYNC_STATE = {
  DISABLED: 'disabled',
  IDLE: 'idle',
  SYNCING: 'syncing',
  ERROR: 'error',
};

/**
 * provider 契约（5 个方法）：
 *   id            string
 *   label         string
 *   isAvailable() boolean           当前环境是否具备这个能力
 *   getStatus()   Promise<Status>   { available, enabled, account, lastSyncAt, state, message }
 *   pull()        Promise<Envelope|null>
 *   push(config)  Promise<{ ok, at?, reason? }>
 *   subscribe(fn) () => void        远端变化时回调
 */
const providers = new Map();

export function registerProvider(provider) {
  if (!provider?.id) throw new Error('同步实现必须提供 id');
  providers.set(provider.id, provider);
}

/* ---------- 本地实现：什么都不做，但把状态说清楚 ---------- */

const localProvider = {
  id: 'local',
  label: '本地存储',

  isAvailable: () => false,

  getStatus: async () => ({
    available: false,
    enabled: false,
    account: null,
    lastSyncAt: null,
    state: SYNC_STATE.DISABLED,
    message: '未接入云服务，配置只存在这台设备上',
  }),

  pull: async () => null,

  push: async () => ({ ok: false, reason: '云服务未接入' }),

  subscribe: () => () => {},
};

registerProvider(localProvider);

/* ---------- 对外接口 ---------- */

let activeId = 'local';

export function setProvider(id) {
  if (!providers.has(id)) {
    console.warn(`[同步] 没有 id 为 "${id}" 的实现，继续用本地`);
    return;
  }
  activeId = id;
}

export function getProvider() {
  return providers.get(activeId) ?? localProvider;
}

export function listProviders() {
  return [...providers.values()].map((p) => ({ id: p.id, label: p.label }));
}

export function isAvailable() {
  return getProvider().isAvailable();
}

export function getStatus() {
  return getProvider().getStatus();
}

export function pull() {
  return getProvider().pull();
}

export function push(config) {
  return getProvider().push(config);
}

export function subscribe(fn) {
  return getProvider().subscribe(fn);
}
