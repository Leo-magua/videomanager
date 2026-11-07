# 部署与开发

## 本机单机运行

1. 准备 Python 3.11+、ffmpeg 和 ffprobe。
2. 仓库根目录创建并激活 `.venv`，执行 `python -m pip install -r requirements.txt`。
3. 执行 `./scripts/start-coordinator.sh`。默认监听 8787，并打印手机配对码。
4. 面板目录执行 `npm ci && npm run dev`，或安装自行构建的 Android APK，再用局域网地址配对。

可选地将 `config/coordinator.env.example` 复制为 `config/coordinator.local.env`，调整端口、模式、数据目录。启动脚本会导出该文件中的配置；直接执行 `python app.py` 时应自行导出环境变量，它不会自动读取 `.env`。

首次启动创建演示资料与演示素材。真实素材在手机设置里登记存储目录后扫描，原文件留在原处。元数据默认在 `packages/coordinator/data/library.db`。

## Mac 调度 + Windows 存储

Mac 的本机配置使用 `VM_MODE=coordinator`，其余步骤与上面相同。Windows 上复制整个 `packages/connector` 目录即可：连接器自包含，不需要 SQLite，也不需要复制 Mac 的运行时数据。

```powershell
cd E:\vm_modules\connector
py -m pip install -r requirements.txt
.\run.bat
```

无配置时连接器打印配对码。手机设置中添加连接器时填连接器地址、配对码和要登记的目录。也可复制 `run.local.example.bat` 为 `run.local.bat`，填写自己的环境变量后通过 enrollment 接入。真实 token 只放在被忽略的本地文件里。

连接器默认端口 8788；调度中心与手机需要能访问它公布的地址。若自动检测的地址不通，可在本地配置中设置 `VM_CONNECTOR_BASE_URL` 为自己的局域网或 Tailscale 地址。设备间地址与端口必须可达。

## 独立处理器

复制 `packages/processor` 到可执行 ffmpeg 的机器，安装其 requirements，然后配置本机 `run.local.bat` 的调度中心 URL 和 enrollment token，运行 `run.bat`。处理器主动领取任务，不需要入站监听端口。确认 `ffmpeg -version` 和 `ffprobe -version` 可运行。

## 独立部署调度中心

通常直接保留整个仓库结构即可。若只复制 coordinator 目录，先运行 `./scripts/sync-shared.sh` 生成 `_vendor/shared_py`，再将 coordinator 一起复制。vendor 文件由源码生成，不在 Git 中重复维护。

## Android

面板需要 Node.js 22；原生工程需要 JDK 21 与 Android SDK Platform 34。

```bash
cd packages/panel
npm ci
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

Windows 使用 `gradlew.bat`。`local.properties` 中的 SDK 路径、调试签名、构建输出都由构建环境维护。调试 APK 的安装升级需使用同一签名。为访问可信 LAN / Tailscale 的 HTTP 服务，Android 工程允许明文 HTTP；不要直接暴露到公共互联网。

## 常见定位

- 配对失败：先访问调度中心 `/healthz`，检查使用手机可达的地址与当前终端的配对码。
- 目录离线：检查连接器 `/healthz`、公布地址、设备防火墙、心跳和登记根目录。
- HTTP 返回代理错误：本地地址应按自己的环境放入 `NO_PROXY` / `no_proxy`，不要让代理接管不可达的 LAN 地址。
- 提示连接器需更新：面板、调度中心与连接器应使用此仓库配套版本，尤其是新建、上传、移动接口。
- 无法剪辑 / 无缩略图：检查处理器是否在线，以及 ffmpeg / ffprobe 是否可执行。
- 删除 / 移动失败：检查文件占用、同名目标、存储边界；使用失败项重试，不要覆盖原文件。

## 验证命令

仓库根目录执行 `python3 scripts/check.py`，再执行 `npm --prefix packages/panel run build`。回归测试创建临时数据库和测试文件，不连接你的真实存储。历史原型不参与这些检查。
