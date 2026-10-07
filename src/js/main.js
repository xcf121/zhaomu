/**
 * 入口：读配置 → 装配各模块。
 * 时钟、搜索、快捷方式都是同步且无网络依赖的，先跑起来让页面立刻可用；
 * 壁纸是异步的，放到首帧之后，不阻塞界面出现。
 */

import { loadConfig } from './config.js';
import { driverName } from './storage.js';
import { initLayout } from './layout.js';
import { initSettings } from './settings.js';
import { initClock } from './clock.js';
import { initSearch } from './search.js';
import { initShortcuts } from './shortcuts.js';
import { initWallpaper } from './wallpaper.js';
import { initWeather } from './weather.js';

async function boot() {
  const cfg = await loadConfig();
  console.info(`[朝暮] 已启动，存储后端：${driverName}`);

  // 必须在首帧前跑完，否则会闪一下「所有组件都堆在中间」
  initLayout(cfg.layout);

  initClock();
  initSearch(cfg);
  initShortcuts(cfg.shortcuts);
  initSettings(cfg);

  // 界面先显示出来，壁纸随后淡入
  requestAnimationFrame(() => document.body.classList.remove('is-booting'));

  initWallpaper(cfg.wallpaper)
    .catch((err) => console.warn('[壁纸] 初始化异常：', err));

  // 天气自己管缓存与降级，失败也只是卡片上没有温度，不影响其它模块
  initWeather(cfg.weather)
    .catch((err) => console.warn('[天气] 初始化异常：', err));
}

boot().catch((err) => {
  console.error('[朝暮] 启动失败：', err);
  // 出错也要让界面可见，不能卡在 is-booting 的状态
  document.body.classList.remove('is-booting');
});
