/**
 * 时钟 / 日期 / 问候语。
 * 时间每分钟更新一次（并对齐到整分钟），只有跨小时才重算问候，跨天才重算日期。
 *
 * 视觉风格（字体 / 字重 / 描边 / 发光）由配置里的 clock.style 决定，
 * 这一层只负责把一个 data-clock-style 属性写到 .clock 上 —— 具体观感全在
 * style.css 的 [data-clock-style=…] 那几条规则里。所以加一个样式：
 * 在下面的 CLOCK_STYLES 加一行 + 在 CSS 里加一条规则，这里一行 JS 都不用动。
 */

import { onConfigChange } from './config.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 可选样式。value 同时是 CSS 里的 [data-clock-style="…"] 与配置里存的值，
 * 设置面板的选项列表也从这里生成 —— 加样式只改这一处 + 一条 CSS。
 */
export const CLOCK_STYLES = [
  { value: 'classic', name: '极简' },
  { value: 'bold',    name: '醒目' },
  { value: 'serif',   name: '衬线' },
  { value: 'mono',    name: '数码' },
  { value: 'outline', name: '描边' },
  { value: 'glow',    name: '微光' },
];

export const DEFAULT_CLOCK_STYLE = 'classic';

export function isClockStyle(value) {
  return CLOCK_STYLES.some((style) => style.value === value);
}

function greetingFor(hour) {
  if (hour < 5)  return '夜深了';
  if (hour < 9)  return '早上好';
  if (hour < 12) return '上午好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  if (hour < 23) return '晚上好';
  return '夜深了';
}

export function initClock(cfg = {}) {
  const clockEl = document.querySelector('.clock');
  const timeEl = document.getElementById('clockTime');
  const dateEl = document.getElementById('clockDate');
  const greetEl = document.getElementById('clockGreeting');

  let lastDay = '';
  let lastHour = -1;

  function applyStyle(style) {
    if (!clockEl) return;
    clockEl.dataset.clockStyle = isClockStyle(style) ? style : DEFAULT_CLOCK_STYLE;
  }

  function tick() {
    const now = new Date();

    timeEl.textContent =
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const day = now.toDateString();
    if (day !== lastDay) {
      lastDay = day;
      dateEl.textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAYS[now.getDay()]}`;
    }

    const hour = now.getHours();
    if (hour !== lastHour) {
      lastHour = hour;
      greetEl.textContent = greetingFor(hour);
    }
  }

  applyStyle(cfg.style);
  tick();

  // 对齐到下一个整分钟再进入每分钟节拍，避免每秒唤醒一次 CPU
  const now = new Date();
  setTimeout(() => {
    tick();
    setInterval(tick, 60_000);
  }, (60 - now.getSeconds()) * 1000);

  // 从别的标签页切回来时立刻校正，不等下一次节拍
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });

  // 设置面板里选样式 → 写配置 → 这里收到通知改属性
  onConfigChange((next) => applyStyle(next.clock?.style));
}
