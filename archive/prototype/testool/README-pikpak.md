# PikPak 网盘访问说明（给 Coding Agent）

本文档说明本仓库如何通过 **WebDAV** 访问 PikPak 网盘：浏览目录、确认路径、下载文件，以及核对本地文件是否已上传。

实现脚本：`testool/pikpak copy.PY`

---

## 1. 访问方式概览

| 项目 | 说明 |
|------|------|
| 协议 | WebDAV（HTTP Basic Auth） |
| 服务地址 | `https://dav.mypikpak.com`（可用环境变量 `PIKPAK_WEBDAV_URL` 覆盖） |
| 脚本 | `testool/pikpak copy.PY`（相对仓库根目录） |
| 默认本地下载目录 | `D:/Download`（由环境变量 `PIKPAK_LOCAL_SAVE_DIR` 控制） |
| 账号配置位置 | 环境变量 `PIKPAK_USERNAME` / `PIKPAK_PASSWORD`，或 `testool/.env`（参考 `testool/.env.example`，PikPak 设置页可查看） |
| 本地素材参考目录 | `<项目目录>\Download` |

**不要**臆造路径。先用 `list_files` / `check` 确认真实路径，再下载。

---

## 2. 依赖与运行环境

- Python 3（本机可用 `py -3`）
- 依赖包：`requests`（标准库已含 `xml.etree.ElementTree`）

PowerShell 下若中文路径乱码，先设置 UTF-8：

```powershell
chcp 65001 > $null
$env:PYTHONIOENCODING = "utf-8"
py -3 "testool\pikpak copy.PY"
```

---

## 3. 浏览目录（看有哪些路径）

脚本已实现 `list_files(remote_path)`：

- 使用 WebDAV `PROPFIND`，`Depth: 1`（**只列当前一层**，不递归）
- 成功时 HTTP 状态码为 `207`
- 返回列表，每项包含：`path` / `name` / `is_dir` / `size`
- 控制台会打印类型（`DIR` / `FILE`）、大小、完整远程路径

### 3.1 直接运行脚本（默认列根目录）

```powershell
chcp 65001 > $null
$env:PYTHONIOENCODING = "utf-8"
py -3 "testool\pikpak copy.PY"
```

默认行为：调用 `list_files("/")`，**不下载**。

### 3.2 在代码里列指定目录

```python
from importlib.machinery import SourceFileLoader

mod = SourceFileLoader(
    "pikpak_copy",
    r"testool\pikpak copy.PY",
).load_module()

# 根目录
mod.list_files("/")

# 某一层子目录（路径末尾建议带 /）
mod.list_files("/My Pack/")
mod.list_files("/素材/")
```

### 3.3 路径规则

- 远程路径以 `/` 开头，例如 `/example.mp4`、`/My Pack/xxx.mp4`
- 目录路径建议以 `/` 结尾，例如 `/My Pack/`
- 中文目录名可用，编码用 UTF-8
- URL 由 `WEBDAV_URL + remote_path` 拼接，例如：  
  `https://dav.mypikpak.com/My%20Pack/`

---

## 4. 下载文件

脚本函数：`download_file(remote_file_path, local_file_name)`

- 方法：HTTP `GET`
- 支持断点续传（`Range`）；若服务端未返回 `206`，会改为从头覆盖下载
- 失败会按 `MAX_RETRIES` 重试
- 本地保存：`LOCAL_SAVE_DIR / local_file_name`

### 示例

```python
from importlib.machinery import SourceFileLoader
import os

mod = SourceFileLoader(
    "pikpak_copy",
    r"testool\pikpak copy.PY",
).load_module()

# 1) 先确认路径存在
entries = mod.list_files("/")
# 或：mod.list_files("/My Pack/")

# 2) 再用 list_files 打印出的真实路径下载
remote_path = "/My Pack/example.mp4"
local_name = os.path.basename(remote_path)
mod.download_file(remote_path, local_name)
```

也可在脚本 `__main__` 里取消下载相关注释，填入真实路径后运行。

---

## 5. Agent 推荐工作流

### 5.1 下载类任务

当用户要求「从 PikPak 取某个文件 / 看看网盘里有什么」时：

1. **读本 README** 与 `testool/pikpak copy.PY`，确认 WebDAV 配置仍有效。
2. **先列目录**：从 `/` 或用户指定父目录开始，`list_files` 看一层。
3. **按需下钻**：对目标 `DIR` 再 `list_files("/某目录/")`，仍只看一层。
4. **确认 FILE 路径** 后再调用 `download_file`。
5. **回报**：远程路径、本地保存路径、是否成功；失败时附状态码/异常信息。

不要默认全盘递归扫描；不要在未确认路径时盲目下载大文件。

### 5.2 本地 vs 云端核对（是否已上传）

当用户给本地文件/目录，问「这些有没有上传到网盘」时：

1. 使用 CLI：`check <本地路径>`（见第 10 节）。
2. 脚本会递归扫描云端（Depth=1 逐层），按**文件名**匹配；默认再比对**文件大小**。
3. 单文件查找会优先进入「目录名像目标文件名」的子目录，并在全部目标命中后**提前结束**。
4. 结果状态：
   - `uploaded`：同名且大小一致（视为已上传）
   - `name_only`：同名但大小不同
   - `missing`：未找到同名文件

注意：PikPak WebDAV **不支持**服务端 `SEARCH`，也不真正支持 `Depth: infinity`，全盘比对只能靠客户端递归，大网盘可能较慢。

---

## 6. 目录结构

网盘目录结构因人而异，请以实际 `list_files("/")` 输出为准，不要把历史快照写进文档或代码。

---

## 7. 关键 API 对照（WebDAV）

| 操作 | HTTP | 成功码 | 脚本入口 |
|------|------|--------|----------|
| 列目录 | `PROPFIND` + `Depth: 1` | `207` | `list_files(path)` |
| 递归摸目录 | 多次 Depth=1 | — | `walk_remote(path)` |
| 按文件名找 | 客户端递归匹配 | — | `search_by_name(name)` |
| 本地是否已上传 | 递归 + 文件名/大小 | — | `check_local_against_cloud(path)` |
| 下载文件 | `GET`（可带 `Range`） | `200` / `206` / `416` | `download_file(path, name)` |

认证：`HTTPBasicAuth(USERNAME, PASSWORD)`。

不支持：`SEARCH`（404）；`Depth: infinity` 实际不会深入子目录。

---

## 8. 安全注意

- WebDAV 账号密码通过环境变量 `PIKPAK_USERNAME` / `PIKPAK_PASSWORD` 提供，或写在 `testool/.env`（已在 .gitignore 中，**不要**提交，也不要写进脚本明文）。
- 下载大文件前先确认磁盘空间与 `LOCAL_SAVE_DIR`。

---

## 9. 快速自检

```powershell
chcp 65001 > $null
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUNBUFFERED = "1"
py -3 -u "testool\pikpak copy.PY" list /
```

预期：打印根目录下的 `DIR` / `FILE` 路径。

---

## 10. CLI 用法

```powershell
chcp 65001 > $null
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUNBUFFERED = "1"

# 列一层目录
py -3 -u "testool\pikpak copy.PY" list /
py -3 -u "testool\pikpak copy.PY" list "/My Pack/"

# 按文件名搜索（可加 --exact 精确匹配）
py -3 -u "testool\pikpak copy.PY" search example.mp4 --exact

# 检查本地文件/目录是否已在云端
py -3 -u "testool\pikpak copy.PY" check "<项目目录>\Download\example.mp4"
py -3 -u "testool\pikpak copy.PY" check "<项目目录>\Download"
```

### 核对逻辑示例

- 本地：`<项目目录>\Download\example.mp4`
- 脚本递归搜索云端同名文件并比对大小
- 大小一致 → `uploaded`（视为已上传）；仅同名 → `name_only`；未找到 → `missing`
