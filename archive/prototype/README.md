# VideoEditor_Kimi

一体化项目：**React（Vite）前端** + **Flask + MoviePy 后端**。构建后的页面由 Flask 在**同一地址**（默认 `http://127.0.0.1:5000`）提供，无需再开 Vite 预览端口。

## 首次 setup

```bash
cd <项目目录>
npm install
pip install -r requirements.txt
```

（建议使用虚拟环境：`python -m venv .venv` 后激活再 `pip install`。）

## 日常使用（单一地址）

```bash
npm start
```

等价于：先 `npm run build` 生成 `dist/`，再执行 `python server/app.py`。浏览器打开 **http://127.0.0.1:5000** 即可。

仅后端（已构建过前端）：

```bash
npm run server
```

若尚未构建，根路径会返回 503 提示先执行 `npm run build`。

## 前端热更新开发

需要改 UI 时：

1. 终端 A：`python server/app.py`（或 `npm run server`）
2. 终端 B：`npm run dev`（Vite 默认 5173，已代理到 5000）

此时用 **http://localhost:5173** 开发；联调完成后 `npm run build`，再用 **5000** 单端口交付。

## 目录说明

| 路径 | 说明 |
|------|------|
| `server/app.py` | Flask 应用：API + 托管 `dist/` |
| `dist/` | `npm run build` 输出（勿手改） |
| `uploads/`、`download/`、`output/` | 运行时自动创建 |
| `.video_editor.config.json` | 素材目录白名单（运行时生成） |

## 环境变量

- **`PORT`**：Flask 端口，默认 `5000`。
- **`VITE_API_BASE_URL`**：仅在前端构建时生效；**集成模式下留空**（与后端同源）。
- **`VITE_DEV_PROXY_TARGET`**：仅 `npm run dev` 时代理到 Flask。

与路径白名单相关的变量与旧版一致：`VIDEO_EDITOR_EXTRA_ROOTS`、`VIDEO_EDITOR_TRUST_ANY_PATH` 等。
