/**
 * 每日一言。
 *
 * 两种来源：
 *   builtin  —— 内置句子库，零网络、断网也在（默认）
 *   hitokoto —— 一言 API（v1.hitokoto.cn），池子里拿现成的，后台补货
 *
 * **每打开一次新标签页换一句**，不是按天轮换：
 *   · 内置那档用「抽签袋」—— 60 句洗好排成一队，每次取队首，取空一袋才重洗，
 *     重洗时把上一句排除在外。于是 60 句会均匀地全部露一遍，也不会连着两次同一句
 *     （纯随机会：60 选 1 撞上刚刚那句的概率并不低）。袋子剩下的存在本地，
 *     跨标签页、跨浏览器重启都接着上一袋走
 *   · 联网那档从池子里取第一条（现成的，零等待），再在后台补一条回去；
 *     池子空了就先铺内置那句
 *
 * 代价是每开一次新标签页要读写一次本地存储 —— 这是「每次都是新的」的必要成本，
 * 不落盘的话每次打开都是同一句。
 *
 * 两条与壁纸 / 天气同一套的规矩：
 *   · **先读缓存**：联网那档永远先看池子里有没有，绝不等网络
 *   · **任何失败都只是退回内置句子**，绝不会空着 —— 内置那句是同步铺上去的
 */

import { get, set } from './storage.js';
import { onConfigChange } from './config.js';

export const QUOTE_SOURCES = [
  { value: 'builtin',  name: '内置精选' },
  { value: 'hitokoto', name: '一言（联网）' },
];

export const DEFAULT_QUOTE_SOURCE = 'builtin';

export function isQuoteSource(value) {
  return QUOTE_SOURCES.some((source) => source.value === value);
}

/**
 * 内置句子库。
 * 挑的都是短句（一行到两行放得下），出处只写能确定的那种 ——
 * 宁可少收几句，也不写一句「传说是某某说的」。
 */
const BUILTIN = [
  { text: '山重水复疑无路，柳暗花明又一村。', from: '陆游《游山西村》' },
  { text: '长风破浪会有时，直挂云帆济沧海。', from: '李白《行路难》' },
  { text: '会当凌绝顶，一览众山小。', from: '杜甫《望岳》' },
  { text: '不畏浮云遮望眼，自缘身在最高层。', from: '王安石《登飞来峰》' },
  { text: '沉舟侧畔千帆过，病树前头万木春。', from: '刘禹锡《酬乐天扬州初逢席上见赠》' },
  { text: '莫道桑榆晚，为霞尚满天。', from: '刘禹锡《酬乐天咏老见示》' },
  { text: '但愿人长久，千里共婵娟。', from: '苏轼《水调歌头》' },
  { text: '竹杖芒鞋轻胜马，谁怕？一蓑烟雨任平生。', from: '苏轼《定风波》' },
  { text: '谁道人生无再少？门前流水尚能西。', from: '苏轼《浣溪沙》' },
  { text: '博观而约取，厚积而薄发。', from: '苏轼《稼说送张琥》' },
  { text: '且将新火试新茶，诗酒趁年华。', from: '苏轼《望江南》' },
  { text: '江上之清风，山间之明月。', from: '苏轼《前赤壁赋》' },
  { text: '落霞与孤鹜齐飞，秋水共长天一色。', from: '王勃《滕王阁序》' },
  { text: '海内存知己，天涯若比邻。', from: '王勃《送杜少府之任蜀州》' },
  { text: '千里之行，始于足下。', from: '《老子》' },
  { text: '天行健，君子以自强不息。', from: '《周易》' },
  { text: '不积跬步，无以至千里。', from: '《荀子·劝学》' },
  { text: '路漫漫其修远兮，吾将上下而求索。', from: '屈原《离骚》' },
  { text: '采菊东篱下，悠然见南山。', from: '陶渊明《饮酒》' },
  { text: '行到水穷处，坐看云起时。', from: '王维《终南别业》' },
  { text: '大漠孤烟直，长河落日圆。', from: '王维《使至塞上》' },
  { text: '潮平两岸阔，风正一帆悬。', from: '王湾《次北固山下》' },
  { text: '莫愁前路无知己，天下谁人不识君。', from: '高适《别董大》' },
  { text: '天生我材必有用，千金散尽还复来。', from: '李白《将进酒》' },
  { text: '大鹏一日同风起，扶摇直上九万里。', from: '李白《上李邕》' },
  { text: '生当作人杰，死亦为鬼雄。', from: '李清照《夏日绝句》' },
  { text: '何须浅碧深红色，自是花中第一流。', from: '李清照《鹧鸪天》' },
  { text: '纸上得来终觉浅，绝知此事要躬行。', from: '陆游《冬夜读书示子聿》' },
  { text: '问渠那得清如许？为有源头活水来。', from: '朱熹《观书有感》' },
  { text: '读书不觉已春深，一寸光阴一寸金。', from: '王贞白《白鹿洞二首》' },
  { text: '岁月不居，时节如流。', from: '孔融《论盛孝章书》' },
  { text: '老骥伏枥，志在千里。', from: '曹操《龟虽寿》' },
  { text: '志不立，天下无可成之事。', from: '王阳明《教条示龙场诸生》' },
  { text: '天下事有难易乎？为之，则难者亦易矣。', from: '彭端淑《为学》' },
  { text: '落红不是无情物，化作春泥更护花。', from: '龚自珍《己亥杂诗》' },
  { text: '春江潮水连海平，海上明月共潮生。', from: '张若虚《春江花月夜》' },
  { text: '桃李不言，下自成蹊。', from: '《史记·李将军列传》' },
  { text: '不飞则已，一飞冲天；不鸣则已，一鸣惊人。', from: '《史记·滑稽列传》' },
  { text: '静以修身，俭以养德。', from: '诸葛亮《诫子书》' },
  { text: '非淡泊无以明志，非宁静无以致远。', from: '诸葛亮《诫子书》' },
  { text: '知者不惑，仁者不忧，勇者不惧。', from: '《论语·子罕》' },
  { text: '岁寒，然后知松柏之后凋也。', from: '《论语·子罕》' },
  { text: '工欲善其事，必先利其器。', from: '《论语·卫灵公》' },
  { text: '苟日新，日日新，又日新。', from: '《礼记·大学》' },
  { text: '既然选择了远方，便只顾风雨兼程。', from: '汪国真《热爱生命》' },
  { text: '面朝大海，春暖花开。', from: '海子《面朝大海，春暖花开》' },
  { text: '黑夜给了我黑色的眼睛，我却用它寻找光明。', from: '顾城《一代人》' },
  { text: '此后如竟没有炬火，我便是唯一的光。', from: '鲁迅《热风》' },
  { text: '无穷的远方，无数的人们，都和我有关。', from: '鲁迅《这也是生活》' },
  { text: '其实地上本没有路，走的人多了，也便成了路。', from: '鲁迅《故乡》' },
  { text: '凡是过往，皆为序章。', from: '莎士比亚《暴风雨》' },
  { text: '我们都在阴沟里，但仍有人仰望星空。', from: '王尔德《温德米尔夫人的扇子》' },
  { text: '在隆冬，我终于知道，我身上有一个不可战胜的夏天。', from: '加缪《夏天集》' },
  { text: '生如夏花之绚烂，死如秋叶之静美。', from: '泰戈尔《飞鸟集》' },
  {
    text: '世界上只有一种真正的英雄主义，就是在认清生活真相之后依然热爱生活。',
    from: '罗曼·罗兰《米开朗基罗传》',
  },
  { text: '凡心所向，素履以往。', from: '七堇年《尘曲》' },
  { text: '生活不止眼前的苟且，还有诗和远方。', from: '高晓松' },
  { text: '种一棵树最好的时间是十年前，其次是现在。', from: '非洲谚语' },
  { text: '我们一路奋战，不是为了改变世界，而是为了不让世界改变我们。', from: '电影《熔炉》' },
  { text: '海到无边天作岸，山登绝顶我为峰。', from: '林则徐' },
];

/* ------------------------------------------------------------------
 * 抽取：内置那 60 句怎么轮
 * ------------------------------------------------------------------ */

/** 抽签袋的落盘位置 */
const BAG_KEY = 'quoteBag';

/** Fisher–Yates 洗牌。exclude 是上一句，洗之前就把它拿掉，交界处才不会连着重复 */
function shuffledIndexes(size, exclude) {
  const list = [];
  for (let i = 0; i < size; i += 1) if (i !== exclude) list.push(i);

  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** 存储里的东西一律不可信（可能被手改，也可能是旧版本写的），过滤后再用 */
function readBag(raw, size) {
  const bag = Array.isArray(raw?.bag)
    ? raw.bag.filter((n) => Number.isInteger(n) && n >= 0 && n < size)
    : [];
  const last = Number.isInteger(raw?.last) && raw.last >= 0 && raw.last < size ? raw.last : -1;
  return { bag, last };
}

/**
 * 抽下一句。纯函数：给上一次的状态，返回这一句的下标与新状态 —— 好测，也好复用。
 * @returns {{ index: number, state: { bag: number[], last: number } }}
 */
export function nextIndex(rawState, size = BUILTIN.length) {
  const { bag, last } = readBag(rawState, size);
  const queue = bag.length ? bag : shuffledIndexes(size, last);
  if (!queue.length) return { index: 0, state: { bag: [], last: 0 } };

  const index = queue[0];
  return { index, state: { bag: queue.slice(1), last: index } };
}

/* ------------------------------------------------------------------
 * 联网那一档
 * ------------------------------------------------------------------ */

const HITOKOTO_ENDPOINT = 'https://v1.hitokoto.cn/';

/** 句子池的落盘位置 */
const POOL_KEY = 'quotePool';

const REQUEST_TIMEOUT_MS = 5000;

/** 取到的句子最长多少字。太长会把左上角那块撑成一大片，也不像「一言」了 */
const MAX_CHARS = 48;

/**
 * 池子里最多囤几条。
 *
 * 显示只认池子里现成的那条（**绝不等网络**），取走之后后台补一条回去。换来两件事：
 * 显示永远不等网络，也永远不会「先闪一下内置句子、再换成联网来的」；
 * 以及爆发时合并请求 —— 两轮补货之间隔着 REFILL_GAP_MS，
 * 一口气开十个标签页最多也只打一轮。
 *
 * **一次只补一条**，不是不想批：一言对短时间内的重复请求返回的是**同一句**
 * （实测并发三条、串行三条，回来的逐字一致），批量补货拿不到几份不同的句子。
 * 于是稳态下大致就是「开一次新标签页补一次」—— 想每次都是新的，这一条请求省不掉，
 * 池子的价值在「不等网络」与「爆发合并」，不在省请求。
 */
const POOL_SIZE = 3;

/** 两轮补货之间至少隔这么久 —— 连点十几个标签页时，最多也只打一轮 */
const REFILL_GAP_MS = 20e3;

/**
 * 失败后多久才再试。**不能每次开新标签页都重试** ——
 * 服务挂了的时候那就是一天几十次无效请求。这半小时里先用内置句子。
 */
const RETRY_AFTER_FAIL_MS = 30 * 60e3;

/** 池子同样过滤一遍再用 */
function readPool(raw) {
  const items = Array.isArray(raw?.items)
    ? raw.items.filter((q) => q && typeof q.text === 'string' && q.text)
    : [];
  return {
    items: items.slice(-POOL_SIZE),
    at: Number.isFinite(raw?.at) ? raw.at : 0,
    fail: raw?.fail === true,
  };
}

/** 一言的 from / from_who 常常是包含关系（「毛泽东语录」/「毛泽东」），去重后再拼 */
function sourceOf(data) {
  const work = String(data?.from ?? '').trim();
  const who = String(data?.from_who ?? '').trim();
  if (work && who) return work.includes(who) ? work : `${who} · ${work}`;
  return work || who;
}

async function fetchHitokoto() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    // 多个 c 是「或」：文学 / 诗词 / 哲学各来一点，避开段子和歌词
    const url = `${HITOKOTO_ENDPOINT}?c=d&c=i&c=k&encode=json` +
                `&min_length=4&max_length=${MAX_CHARS}`;
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`一言返回 ${res.status}`);

    const data = await res.json();
    const text = String(data?.hitokoto ?? '').trim();
    if (!text) throw new Error('一言返回了空句子');
    return { text, from: sourceOf(data) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------
 * 模块
 * ------------------------------------------------------------------ */

export function initQuote(cfg = {}) {
  const textEl = document.getElementById('quoteText');
  const fromEl = document.getElementById('quoteFrom');
  if (!textEl || !fromEl) return;

  let source = isQuoteSource(cfg.source) ? cfg.source : DEFAULT_QUOTE_SOURCE;
  /** 同 wallpaper.js：快速换来源时先发的那次不该后写回存储，只认最新那一号 */
  let generation = 0;

  function render(quote) {
    textEl.textContent = quote.text;
    fromEl.textContent = quote.from ? `—— ${quote.from}` : '';
  }

  /** 内置那句：读一次袋、取一条、把剩下的写回去 —— 下次开标签页就是下一句 */
  async function showBuiltin(token) {
    const { index, state } = nextIndex(await get(BAG_KEY, null));
    if (token !== generation) return;
    render(BUILTIN[index]);
    await set(BAG_KEY, state);
  }

  /**
   * 后台补货。**绝不阻塞显示** —— 屏幕上那条已经在了，这里失败也只是池子少一条。
   * @param {number} token 生成号，作废的那次别写回存储
   * @param {object} pool  刚取走一条之后的池子状态（at / fail 用来算退避）
   */
  async function refill(token, pool) {
    if (pool.items.length >= POOL_SIZE) return;                                    // 池子满着
    if (Date.now() - pool.at < (pool.fail ? RETRY_AFTER_FAIL_MS : REFILL_GAP_MS)) return;

    try {
      const quote = await fetchHitokoto();
      if (token !== generation) return;
      // 撞上池子里已经有的那句就不放了：一句新话是这一档的全部意义
      if (pool.items.some((q) => q.text === quote.text)) return;
      await set(POOL_KEY, { items: [...pool.items, quote], at: Date.now(), fail: false });
    } catch (err) {
      // 一条都没拿到：记一笔失败，半小时内不再打扰服务
      console.warn('[每日一言] 取一言失败，继续用内置句子：', err.message);
      await set(POOL_KEY, { ...pool, at: Date.now(), fail: true });
    }
  }

  /** 换一句。开页面、换来源都走这里 */
  async function refresh() {
    const token = (generation += 1);

    if (source === 'builtin') {
      await showBuiltin(token);
      return;
    }

    const pool = readPool(await get(POOL_KEY, null));
    if (token !== generation) return;

    const [head, ...rest] = pool.items;
    if (head) {
      render(head);                                   // 池子里现成的，零等待
      await set(POOL_KEY, { ...pool, items: rest });
      if (token !== generation) return;
      void refill(token, { ...pool, items: rest });
      return;
    }

    // 池子空着（第一次用，或者服务一直拿不到）：先用内置那句顶上，再去补货
    await showBuiltin(token);
    if (token !== generation) return;
    void refill(token, { ...pool, items: [] });
  }

  void refresh();

  // 换来源就重新抽一句（同一份配置变两下也只会走一次真正的切换）
  onConfigChange((next) => {
    const wanted = isQuoteSource(next.quote?.source) ? next.quote.source : DEFAULT_QUOTE_SOURCE;
    if (wanted === source) return;
    source = wanted;
    void refresh();
  });
}
