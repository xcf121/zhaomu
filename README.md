# 朝暮 · 浏览器起始页

一个自己每天真的会用的浏览器新标签页：打开就是一张好看的每日壁纸，
一眼看到时间与天气，抬手就能搜索或点开常用站点。
「朝暮」= 一天开始（和结束）的地方。

![图标](src/icons/icon128.png)

## 功能

- **每日壁纸**：Bing 每日一图（国内区），按天缓存，可换成自己上传的图片（自动压到长边 2560px）。断网退回渐变背景，不白屏
- **时钟 / 日期 / 问候语**：按时间段变化的中文问候
- **天气**：Open-Meteo（免 Key），点卡片搜城市任意换，10 分钟缓存。不做定位授权 —— 新标签页弹授权太打扰
- **搜索**：百度 / Bing / Google / B站 / GitHub 五引擎下拉切换，输入网址直接跳转；搜索与跳转都默认在新标签页打开；输入框右侧可一键清空
- **快捷方式**：磁贴网格，点击新标签页打开；右键改名字 / 网址 / 上传本地图标；拖拽排序；末尾常驻「+」新增
- **图标获取**：自传图标 → 浏览器 `_favicon` 缓存 → 自存缓存 → 联网抓（Cravatar → 0x3 → 站点 favicon）→ 首字母色块兜底，任何失败都不出现破图
- **自由布局**：五个组件（时钟 / 搜索 / 快捷方式 / 天气 / 版权）都能拖动+ 吸附对齐，位置按百分比存储，任何窗口尺寸都不会跑出屏幕
- **配置**：本地存储，可导入导出 JSON（含自定义壁纸一键带走）

## 安装（Chrome / Edge）

从 [Releases](https://github.com/xcf121/zhaomu/releases) 下最新那版 zip，解压得到一个目录，
然后：

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 开启「开发者模式」→「加载已解压的扩展程序」→ 选解压出来的那个目录
3. `Ctrl+T` 就是它了

也可以直接克隆仓库，装载时选 `src/`。

## 更新与回退

- 版本号只在 `src/manifest.json` 里写一处，更新日志见 [CHANGELOG.md](CHANGELOG.md)
- **更新**：下新版 zip → 解压覆盖原目录 → 在 `chrome://extensions` 点「重新加载」。
  配置和快捷方式都在浏览器存储里，覆盖文件不会丢
- **回退**：去 Releases 下对应旧版本的 zip，同样覆盖 + 重新加载即可
- 每次发版打一个 tag（`v1.0.0` 这种）。想回到某个版本的源码：
  `git checkout v1.0.0`
- 打包：`python tools/package.py`，产物在 `dist/zhaomu-v<版本>.zip`，
  **manifest.json 在压缩包根目录**，解压即可装载

## 技术说明

- 原生 HTML / CSS / JS（ES Modules），**零构建、零依赖、无 npm**，改完刷新即见
- Manifest V3，存储用 `chrome.storage.local`
- 壁纸、天气、图标三个外部接口均免 Key，请求全部**先读缓存**（新标签页一天开几十次）
- 详细的项目档案见 [PROJECT.md](PROJECT.md)，里程碑与踩坑实录见 [docs/TASKS.md](docs/TASKS.md)，硬性约束见 [AGENTS.md](AGENTS.md)

## 目录

```
src/          ← 扩展根目录，装载时选这里
  manifest.json
  newtab.html
  css/style.css
  js/         ← 每个模块一个文件，见文件头注释
  icons/      ← 扩展图标（tools/make-icons.py 生成）
tools/        ← 图标生成、打包脚本（纯标准库 Python，零依赖）
dist/         ← 打包产物（已 gitignore，发布时传到 Release）
docs/         ← 任务清单与验证记录
PROJECT.md    ← 目标 / MVP / 关键决策
CHANGELOG.md  ← 更新日志
```

## License

MIT
