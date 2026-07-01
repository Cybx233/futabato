# 开发者文档

欢迎为本项目贡献代码。本文档说明项目结构、架构要点与本地开发流程。

## 目录结构

```
/
├── manifest.json   # MV3 配置：扩展名、权限、入口注册
├── background.js   # service worker：监听工具栏点击，转发 toggle 消息
├── content.js      # 核心：漫画阅读器全部逻辑（UI、图片处理、翻页）
├── icons/          # 扩展图标 (16/48/128px)
├── README.md
├── LICENSE
└── CONTRIBUTING.md # 本文件
```

## 各文件职责

### `manifest.json`
Manifest V3 配置。`host_permissions` 与 `content_scripts.matches` 均限定为 `https://mp.weixin.qq.com/*`，确保脚本只在公众号页面注入。content script 在 `document_idle` 时机运行。

### `background.js`
Service worker，职责很轻：
1. 监听 `chrome.action.onClicked`。
2. 若当前标签是公众号文章页，向其发送 `{ action: 'toggle' }` 消息。
3. 若 content script 尚未注入（标签是在安装扩展前打开的），`sendMessage` 会抛错，此时显示橙色 `!` 角标提示用户刷新。

### `content.js`
阅读器核心，整体是一个 IIFE，内部用模块模式定义 `ReaderController` 单例。关键设计：

- **Shadow DOM 隔离**：阅读器 UI 挂在 `attachShadow({ mode: 'closed' })` 下，与公众号页面样式彻底隔离。
- **样式内联**：所有 CSS 由 `_getCSS()` 以字符串返回并注入 Shadow Root。**不要重新引入外部 CSS 文件**（历史上的 `reader.css` 已删除，因为它未被引用）。
- **图片两阶段过滤**：
  - 第一阶段 `filterImages`：按 `data-w` 过滤过小图片，并对尾部图片做退化检测（`_applyTailDetection`），剔除文末缩略图。
  - 第二阶段 `_postLoadFilter`：图片加载拿到自然尺寸后，按高度与高宽比二次过滤，剔除横幅、头像等非漫画图。
- **特殊图识别**（`_markSpecialImages`）：横向比 > `PANORAMA_RATIO` 标记为全景图（放宽显示），竖向比 > `STRIP_RATIO` 标记为长条图（弹出提示）。
- **方向感知**：RTL / LTR 切换会同时影响翻页方向、点击区映射、进度条填充方向。
- **跨页偏移**：`toggleOffset` 在首页插入空白占位，用于重新对齐左右页。
- **配置集中**：所有可调参数在文件顶部 `CONFIG` 对象，需要调参改这里即可。

调试：把文件顶部 `var DEBUG = false;` 改为 `true`，可在控制台看到 `[ComicReader]` 日志。

## 本地开发

1. `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选仓库根目录。
2. 改完代码后，在该扩展卡片上点「刷新」图标，然后刷新公众号文章页即可生效。
3. 调试 content script：在公众号文章页打开 DevTools，阅读器 DOM 在 Shadow Root 内（Elements 面板需开启显示 Shadow DOM）。
4. 调试 service worker：扩展卡片上的「Service Worker」链接可打开其专属 DevTools。

## 约定

- **无构建、无依赖**：保持纯原生 JS，不引入打包工具或第三方库。
- **样式内联**：新增样式一律加进 `_getCSS()`，不要新增独立 CSS 文件。
- **避免硬编码本地路径**：代码与文档中不要出现 `/Users/...` 之类的绝对路径。
- **兼容性**：面向现代 Chromium（MV3），无需支持旧浏览器。

## License

贡献的代码按 [GPL-3.0](LICENSE) 协议授权，与项目主体一致。
