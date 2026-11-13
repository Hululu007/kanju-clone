# 看剧AI 风格影视目录站（复刻版）

这是一个用 [Craft Anything](https://github.com/storytold/craft-anything) 对照参考站点
（kanju32.com）复刻出来的**纯前端影视目录界面**，用于个人浏览与学习前端实现。

## 说明

- **纯静态前端**：只用 Vite 打包，没有后端、没有数据库、没有播放能力。
- **示例数据**：`src/data.js` 里是手写的示例片单（标题、分类、题材、年份、更新角标），
  **不包含任何真实片源、播放地址或抓取内容**。
- **海报是自绘 SVG**：没有复制原站图片资源，卡片封面用渐变+光斑占位，
  需要真图时可以把 `src/shell.js` 的 `posterSrc()` 换成自己的图片地址。
- 播放页只有播放器占位框与剧集列表，点击"播放"不会有视频。

## 功能

| 页面 | 路径 | 内容 |
| --- | --- | --- |
| 首页 | `/` | 居中 LOGO、AI 搜索框（快速/智能）、本周追剧周历、四栏分类、海报横轨 |
| 片单 | `/playlists/` | 片单卡片列表 |
| 播放历史 | `/library/history/` | 历史空状态 / 列表 |
| 会话记录 | `/library/sessions/` | 会话空状态 |
| 应用下载 | `/download/` | 下载页 |
| 播放页 | `/player/?id=xxx` | 简介、剧集列表、播放器占位 |

交互：关键词搜索过滤、分类切换、周历按日期筛片、海报轨横向滚动、
侧栏历史/收藏切换、主题切换（深色/浅色）、分享、Toast 提示；
响应式：1440 / 768 / 390 三档，窄屏切换为顶部栏 + 底部标签栏。

## 本地开发

```bash
npm install
npm run dev      # 开发预览
npm run build    # 产出 dist/
npm run preview  # 预览构建结果
```

部署到子路径（如 GitHub Pages 的项目页）时指定 base：

```bash
BASE_PATH=/kanju-clone/ npm run build
```

## 部署（GitHub Pages）

站点通过 `gh-pages` 分支发布：

```bash
BASE_PATH=/kanju-clone/ npm run build
# 把 dist/ 推送到 gh-pages 分支即可
```

## 目录结构

```
index.html                 # 首页入口
playlists/ download/ player/  # 其余页面入口
library/history/ library/sessions/
src/
  base.js                  # BASE_PATH 前缀工具（子路径部署用）
  data.js                  # 示例片单数据
  icons.js                 # 内联 SVG 图标
  shell.js                 # 布局外壳：侧栏 / 导航 / 海报卡 / Toast
  styles.css               # 全部样式（深色 + 浅色主题、响应式）
  pages/                   # 每个页面的渲染逻辑
vite.config.js             # 多页入口 + base 配置
```

## 声明

界面布局参考自公开可访问的参考站点，仅作前端实现练习；
站名、片名等文字仅用于界面占位，与任何片方、平台无关联。
