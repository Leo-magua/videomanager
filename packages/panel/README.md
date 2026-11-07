# 手机与 Web 面板

React + TypeScript + Vite，使用 Capacitor 打包 Android。当前版本 1.1.8。

```bash
npm ci
npm run dev
# 发布构建
npm run build
npx cap sync android
```

`src/sections/` 是素材库、演员、详情、片段、设置页面；`src/components/VideoPlayer.tsx` 是播放器；`src/store/library.tsx` 管缓存与同步；`src/lib/` 包含网络传输、选择手势、排序和播放范围逻辑。

评分排序保存在设备本地，作用于素材列表及同目录播放选集。真实文件操作在线执行；资料修改由缓存和 Outbox 支持离线回放。

[根目录说明](../../README.md) · [Android 构建步骤](../../docs/deployment.md#android)
