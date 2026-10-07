# AGENTS.md

## 项目
浏览器起始页（Chrome/Edge MV3 扩展，覆盖新标签页）。

## 技术栈
- 原生 HTML / CSS / JS（ES Modules），**零构建、零依赖、无 npm**
- 扩展清单：Manifest V3
- 存储：`chrome.storage.local`；直接打开 HTML 时自动退回 `localStorage`
- 外部接口：Bing 每日壁纸、Open-Meteo（天气 / 地理编码）—— 均免 Key

## 目录
```
src/                  ← 扩展根目录，Chrome「加载已解压的扩展程序」指向这里
  manifest.json
  newtab.html
  css/style.css
  js/storage.js       存储层（chrome.storage.local，退回 localStorage）
  js/config.js        默认配置 + 深合并读写 + **写入串行化** + 变更订阅
  js/layers.js        浮层栈：**全站唯一挂全局监听的地方**（Escape / 点外部关闭）
  js/popover.js       统一浮层：定位 + 开关，引擎下拉 / 天气面板 / 磁贴表单共用
  js/icons.js         图标获取：自传图标 → _favicon → 自存缓存 → 联网抓 → 首字母色块
  js/layout.js        组件定位、显隐、编辑模式、拖拽吸附
  js/sortable.js      网格拖拽排序（占位块 + FLIP）
  js/settings.js      设置模态（原生 <dialog>）
  js/sync.js          云同步：只预留契约，**未实现**
  js/wallpaper.js     壁纸：Bing 每日一图 / 用户上传 / 不用（按天缓存 + 两层交叉淡入）
  js/clock.js         时钟 / 日期 / 问候语
  js/search.js        搜索框：引擎下拉 + 网址直跳（两者都开新标签页）
  js/shortcuts.js     快捷方式网格 + 增删改排序 + 右键编辑 + 图标上传（点击开新标签页）
  js/weather.js       天气卡片 + 城市搜索 + WMO 天气码图标
  js/main.js          入口，装配各模块
  icons/              扩展图标 16/32/48/128，由 tools/make-icons.py 生成，manifest 里引用
docs/TASKS.md         里程碑与任务
PROJECT.md            目标 / MVP / 关键决策
CHANGELOG.md          更新日志（一个版本一节）
tools/make-icons.py   扩展图标生成脚本：**纯标准库手写 PNG**（zlib + struct），不引 Pillow
tools/package.py      打包脚本：按 manifest 版本号打 dist/zhaomu-v<版本>.zip，manifest 在根
dist/                 打包产物，**不进版本库**（已 gitignore），发布时传到 GitHub Release
.preview/             测试壳页与截图的临时目录，**跑完即删**（已 gitignore）
```

## 命令
无构建命令。开发循环：
1. `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选 `src/`
2. 改完代码：扩展页点「重新加载」→ 按 `Ctrl+T` 看效果
   （只改 CSS/JS 时通常直接 `Ctrl+T` 刷新即可；改 `manifest.json` 必须重新加载）

想在普通标签页里调样式 / 开 DevTools，起个本地服务即可：
```
python -m http.server 8777 --directory src
# 然后开 http://127.0.0.1:8777/newtab.html
```

改扩展图标（`src/icons/` 里那四张，改了重跑即可）：

```
python tools/make-icons.py
```

打包发布（版本号只从 `src/manifest.json` 读，产物在 `dist/`）：

```
python tools/package.py
```

注意：**不能直接双击 `newtab.html`**。ES 模块在 `file://` 下会被 CORS 拦死，
`chrome.storage` 也不存在，脚本整个不执行。（已实测确认）

**测异步逻辑别开虚拟时钟。** `--virtual-time-budget` 会把 `setTimeout` 和网络等待一起快进，
带超时、带网络、带 `createImageBitmap` 的代码在里面测出来全是假结果 —— 本轮据此误判过两个
「bug」，换成真实时间跑全过。要无头 Chrome 按真实时间等，就用「一个慢子资源按住 load 事件」
那招（起个本地服务，挂一张 `src=/slow` 的图，`--dump-dom` 会等它加载完才抓 DOM）。

本地服务下**只能调样式和布局**，这几样必然失效，别误判成 bug：
- **壁纸永远出不来**。Bing 的图片带 `Access-Control-Allow-Origin: *`，但接口
  `HPImageArchive.aspx` 一个 CORS 头都不带，`fetch` 直接 `TypeError: Failed to fetch`，
  于是拿不到当日图片地址、`preload` 也不会跑、按天缓存同样写不进去。
  扩展里靠 `host_permissions` 才豁免。
- **`_favicon` 不可用**（`chrome.runtime` 不存在）。联网抓图标里只有 Cravatar 能用 ——
  它带 `Access-Control-Allow-Origin: *`；0x3 和站点自己的 `/favicon.ico` 都没有 CORS 头，
  本地必然被拦。所以本地只能验证到第一条链路，后两条得装成扩展再看。

## 硬性约束（踩过的坑）
- **禁止内联脚本**：MV3 默认 CSP 为 `script-src 'self'`。不许写 `<script>...</script>` 内容，不许写 `onclick="..."` 等内联事件，一律 `addEventListener`。样式不受此限。
- **玻璃元素的祖先，永远不要碰 `opacity`**：祖先只要 `opacity < 1` 就会形成 backdrop root，
  `backdrop-filter` 只模糊到那一层为止，等于整块毛玻璃失效。`.stage` 的入场动画踩过这个坑 ——
  淡入的 700ms 里模糊全程不生效，要等 `opacity` 精确等于 1 才「啪」地一下变糊。
  要动就动 `transform`（不在触发条件里），实测验证过。元素**自身**的 `opacity` 是安全的。
  推论：编辑态里压暗「已隐藏」的组件**必须用 `::after` 蒙层**，不能用 opacity；
  `<dialog>` 的 `::backdrop` 因为和面板是兄弟不是祖先，所以不受这条限制。
- **只要挂一个全局监听**：所有浮层（引擎下拉、天气面板、磁贴表单、编辑模式）都注册进
  `js/layers.js`。各挂各的 `document` 监听会互相打架 —— 一次 Escape 触发全部。
  这个栈的 keydown 挂在**捕获阶段**，所以能真正拦掉后面所有冒泡监听。
- **「模式」和「浮层」要分开**：编辑模式注册时带 `sticky: true`，它不参与 `closeAll()`、
  也不响应点外部关闭。少了这条，点「+」开个表单就会把编辑模式一起关掉（真实踩过）。
- **写在触发器上的状态必须成对**：`popover.js` 会给触发器设 `aria-expanded`，CSS 拿它转箭头
  （`.search__engine[aria-expanded="true"] .search__chev`）。开的时候置了 `true`、
  关的时候忘了复位，箭头就打开过一次永远朝上 —— 真实踩过。凡是在同一个元素上「开时写、
  关时不写」的状态（属性、类名）都要按这条查一遍。
- **虚线框用 `outline` 不用 `border`**：border 会改变 `offsetWidth/offsetHeight`，
  按百分比重算位置时组件会跳一下，还会把拖拽缓存的尺寸搞错。
- **WAAPI 的 `el.animate()` 不受 CSS 的 `prefers-reduced-motion` 全局规则约束**，
  必须自己 `matchMedia` 判断并**根本不调用**（不是设成 0ms）。排序的 FLIP 就靠这条。
- **`patchConfig` 是读-改-写，必须走串行化队列**（`config.js` 里已实现）。
  并发调用会丢写 —— 拖拽保存和设置开关同时触发就能复现。
- **导入配置必须 sanitize**（`settings.js` 的 `sanitizeConfig`）：`x` 传成 `NaN` 会让
  `calc(NaN * 1%)` 整体作废、`left` 退回 `auto`，所有组件堆到左上角，
  而且**改配置也救不回来**，只能清存储。快捷方式的 url 也必须过 http/https 白名单。
- **新标签页会被高频打开**：任何网络请求都必须先读缓存（壁纸按天缓存、天气按 10 分钟缓存），否则每次开新标签都在打接口。
- **请求域名必须写进 `manifest.json` 的 `host_permissions`**，否则被 CORS 拦掉。
  快捷方式的图标要抓**任意站点**，所以清单里放开了 `http://*/*` 与 `https://*/*`；
  代价是本地 `python -m http.server` 下这条路径永远失败（没有 host_permissions 豁免），
  只会显示首字母色块 —— 别误判成 bug。
- **浮在组件里的东西一律 `absolute`，不能用 `fixed`**：`.widget` 上有 transform，
  它会成为 fixed 后代的包含块，`left/top` 于是被解释成「相对组件左上角」而不是视口。
  排序时抬起的磁贴踩过这个坑 —— 实测整体偏移 270, 522.6，正好等于组件原点，
  表现就是「一拖磁贴就飘到别的地方」。`popover.js` 里那条「浮层一律 absolute」是同一个原因。
  非要用绝对定位，就把包含块的 rect 减掉（`sortable.js` 的 `place()` 就是这么算的）。
- **退出编辑模式必须把进行中的拖拽一并取消**（`sortable.cancel()` / `endDrag(false)`）。
  少了这条：Escape 已经退出编辑态，磁贴却还留在「被抬起」的状态继续跟着鼠标走，
  占位块也永远留在网格里（实测复现过）。`window.blur` 也要取消 —— 切走窗口就收不到 pointerup。
- **带 `display` 的类会盖掉 `[hidden]`**：`[hidden]` 是 UA 样式表里的 `display: none`，
  优先级低于类选择器。`.btn` 这种写了 `display: inline-flex` 的，必须再补一条
  `.btn[hidden] { display: none }`，否则 `el.hidden = true` 毫无效果。
  （`.edit-bar[hidden]` 那条是同一个坑的第一次。）
- **必须有离线/失败兜底**：网络挂了要退回渐变背景与占位文案，不能白屏。
- 外部资源拿不到时不能让布局塌掉（图片用固定尺寸容器 + `object-fit`）。
- **图标一律「先铺兜底、成功才替换」**：先把首字母色块渲染出来，图标只在**确认可用**
  之后才 append 进 DOM（`<img>` 要 `decode()` 成功才算数）。任何一步失败都只是色块继续留着，
  用户看不到破图。`js/icons.js` 那条链路的每一级都是这个形状。
- **图标获取的优先级写死在 `js/icons.js`**：自传图标 → `_favicon`（浏览器本地缓存，
  不发请求）→ 自己存过的网络图标 → 联网抓 → 首字母色块。
- **联网抓的次序：第三方服务 → 站点根目录 `/favicon.ico` → 页面声明的 `<link rel=icon>`**。
  两个服务都排在站点前面，是因为它们国内直连快、对没访问过的站点命中率也高；
  站点自己的图标最权威，但也最常缺。本地/内网地址不发去第三方（既没意义，也不该外泄内网主机名）。
  - **Cravatar** `https://cn.cravatar.com/favicon/api/index.php?url=<域名>` ——
    **只吃纯域名**，带上协议或路径直接 504（实测）。响应头 `X-Favicon-State` 会交代
    这张图是什么：`ready` 是真图标（实测和站点自己的 `/favicon.ico` 逐字节一致），
    `fallback` 是「我还没抓到，先给你一张占位图」。
  - **0x3** `https://0x3.com/icon?host=<域名>` —— 它**不返回 CORS 头**，只在扩展里靠
    `host_permissions` 才用得了；而且**拿不到图标时照样返回 200**，给的是一张固定的
    794 字节 SVG 链接图标（多个域名逐字节一致），必须比对后丢掉，否则一排站点全长一样。
- **「服务稍后再试」和「真的没有」要分开缓存**：新标签页一天开几十次，没缓存等于每次都在打接口。
  成功存 30 天；服务 5xx / 连不上 / 返回 `fallback` → 只存 10 分钟（`pending`）；
  真失败才存 6 小时。最多 48 条，超量淘汰最老的；单张超过 32KB 直接丢 ——
  那多半是 404 页面或者整站 logo。抓 HTML 时也要卡体积和超时。
  （Cravatar 对没缓存的域名一律先给 `fallback`、后台再去抓：实测第一次跑只有 3/8 个站点
  拿到图标，十分钟后再跑就是 8/8。要是按失败缓存 6 小时，冷启动的用户就得盯着首字母色块。）
- **_favicon 的通用地球图要识别出来丢掉**：它会把本地缓存里的图画成你要的尺寸，
  所以尺寸按「显示尺寸 × `devicePixelRatio`」往上一档取（32/64/128），高分屏才不糊。
  站点从没访问过时返回的是一张**通用地球图**，那还不如首字母色块 ——
  拿一个不存在的域名请求同一接口得到参照字节，逐字节比对，一致就丢弃。
  参照图取不到时一律判为「不是通用图」，宁可显示地球也不误伤真实图标。

## 布局模型（改之前先看这段）

五个组件（时钟 / 搜索框 / 快捷方式 / 天气 / 壁纸版权）都是 `.stage` 里绝对定位的 `.widget`。
位置存成 `--x` / `--y` 两个 **0–100 的纯数字**，换算全在 CSS 里：

```css
.widget {
  left: calc(var(--x) * 1%);                                    /* 相对容器宽 */
  transform: translate(calc(var(--x) * -1%), calc(var(--y) * -1%));  /* 相对自身宽 */
}
```

两者相减正好是 `x/100 × (容器宽 − 自身宽)`，于是 `0` 贴起始边、`50` 精确居中、`100` 贴结束边，
**任何窗口尺寸下都不可能跑到屏幕外**，而且窗口缩放时 JS 一行都不用跑。

拖拽在 `js/layout.js`：拖动时按像素算，松手才换算成百分比存盘。
吸附阈值 8px，吸附对象是「屏幕中线 + 其它可见组件的中线/左右边缘/上下边缘」。

**已知退化**：窗口窄到约 480px 以下时快捷方式会折行变高，默认位置可能压到搜索框。
不做自动避让，靠手动拖或「恢复默认布局」。实测 1920×1080 到 480×720 共 13 档尺寸都不重叠。

## 当前状态

**v1.0.0 已发布**（2026-10-07）。M1–M5 已完成。M5 交付（图标与壁纸）：

- **图标联网获取** —— 本地缓存里没有就按 Cravatar → 0x3 → 站点 `/favicon.ico` →
  抓首页 HTML 认 `<link rel=icon>` 依次试。带超时与三级缓存，四秒拿不到就先用首字母色块
- **右键编辑磁贴** —— 改名字、改网址、上传本地图片当图标、删除。任何时候可用，不必先进编辑模式
- **「+」磁贴修好了** —— 以前那个分支写在 `editing` 判断后面，平时点它毫无反应
- **自定义壁纸** —— 设置里上传本地图片（压到长边 2560px 存进配置），可随时移除换回 Bing
- **排序拖拽修好了** —— 拖动时磁贴会飘走、Esc 退出编辑态后磁贴还在跟着鼠标走，两个 bug 都修了
- **点击一律开新标签页** —— 磁贴走 `target=_blank` + `rel=noopener`，搜索与网址直跳走
  `window.open(..., '_blank', 'noopener')`。起始页是张一次性的空白页，占着它没意义，
  留在原地还能从结果页回来接着改词重搜
- **扩展图标** —— `tools/make-icons.py` 生成 16/32/48/128：圆角方块铺页面那层兜底渐变，
  上面一轮白朝阳压着地平线。改图标就改脚本里的形状参数再跑一次

M4 交付：

- **搜索引擎下拉** —— 点引擎名弹列表、当前项打勾，选完焦点自动回到输入框
- **设置面板**（右上角齿轮，原生 `<dialog>`）—— 组件显隐、搜索引擎、天气城市、壁纸源/画质、
  快捷方式摘要、配置导入导出、恢复默认、云同步占位
- **编辑模式** —— 设置里点「调整布局」进入。组件出现虚线框 + 拖拽手柄 + 隐藏按钮；
  拖动有中线与组件对齐的吸附提示；被隐藏的组件显示为压暗占位，点 ✕ 能恢复
- **快捷方式管理** —— 网格末尾常驻「+」磁贴（就地填名称和网址）；
  编辑态里可拖拽排序、点红色徽标删除
- **云同步** —— 只预留了契约（`js/sync.js`），设置里明确显示「未接入」，**没有任何假 UI**

### 人工确认过的（无头环境测不了）

1. 毛玻璃模糊生效 —— 并据此修掉了「首帧先是透明玻璃、随后才变毛玻璃」的问题
2. `_favicon` 能取到站点图标 —— 据此把尺寸改成按 `devicePixelRatio` 取档，并加上通用地球图识别
3. 编辑态里拖拽排序会出问题（磁贴飘走、Esc 后仍在排序模式）—— 据此定位到
   `position: fixed` 被 `.widget` 的 transform 劫持，以及退出编辑模式没取消排序会话

### 仍未验证（需要装上扩展肉眼确认）

- 拖拽手感、吸附辅助线的实际观感、毛玻璃在各浮层上是否一致
- `_favicon` 走「字节校验 → 丢弃通用地球」，以及联网抓图标在**真实站点**上的成功率。
  本地 http 服务下这条路径必然失败（没有 host_permissions 豁免），只能在装成扩展后看
- 真实按 Escape 关闭设置模态（`<dialog>` 的原生行为，合成事件触发不了，只能人工确认）
- 编辑态里「已隐藏」组件用 `::after` 蒙层压暗的实际观感
- 右键菜单的手感、上传图标 / 壁纸时选文件的流程、自定义壁纸在大屏上的清晰度

（无头 Chrome 加载不了扩展，Chrome 137+ 收紧了 `--load-extension`。）

1.0.0 的打包与发布流程见 [README.md](README.md) 的「更新与回退」和 `tools/package.py`。

下一步：M6 打磨（键盘快捷键、入场动效、分辨率适配与离线演练）。详见 `docs/TASKS.md`。
