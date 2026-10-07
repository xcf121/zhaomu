/**
 * 时钟 / 日期 / 问候语。
 * 时间每分钟更新一次（并对齐到整分钟），只有跨小时才重算问候，跨天才重算日期。
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function greetingFor(hour) {
  if (hour < 5)  return '夜深了';
  if (hour < 9)  return '早上好';
  if (hour < 12) return '上午好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  if (hour < 23) return '晚上好';
  return '夜深了';
}

export function initClock() {
  const timeEl = document.getElementById('clockTime');
  const dateEl = document.getElementById('clockDate');
  const greetEl = document.getElementById('clockGreeting');

  let lastDay = '';
  let lastHour = -1;

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
}
