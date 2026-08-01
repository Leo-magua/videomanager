import requests
from requests.auth import HTTPBasicAuth
import os
import time
from urllib.parse import unquote, urlparse
import xml.etree.ElementTree as ET

# 1. 配置你的 PikPak WebDAV 信息
# 优先读环境变量；也支持在脚本同目录放 .env（KEY=VALUE 每行一条，.env 已在 .gitignore 中，勿提交）
def _load_dotenv(path):
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except OSError:
        pass


_load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

WEBDAV_URL = os.environ.get("PIKPAK_WEBDAV_URL", "https://dav.mypikpak.com")  # WebDAV 服务器地址
USERNAME = os.environ.get("PIKPAK_USERNAME", "")  # WebDAV 用户名
PASSWORD = os.environ.get("PIKPAK_PASSWORD", "")  # WebDAV 密码
LOCAL_SAVE_DIR = os.environ.get("PIKPAK_LOCAL_SAVE_DIR", "D:/Download")  # 本地保存目录

if not USERNAME or not PASSWORD:
    raise SystemExit("请先设置 PIKPAK_USERNAME / PIKPAK_PASSWORD（环境变量，或 testool/.env，参考 testool/.env.example）")
REQUEST_TIMEOUT = (30, 600)  # (连接超时, 读取超时)
MAX_RETRIES = 5  # 下载失败后最大重试次数
RETRY_BACKOFF_SECONDS = 3  # 重试等待基数（会按 attempt 递增）
CHUNK_SIZE = 8192

DAV_NS = {"d": "DAV:"}

# 创建本地保存目录
os.makedirs(LOCAL_SAVE_DIR, exist_ok=True)

# 设置认证和公共请求头
auth = HTTPBasicAuth(USERNAME, PASSWORD)
headers = {
    "Depth": "1"  # 用于 PROPFIND 请求，1表示仅当前目录
}


def _normalize_remote_path(href: str) -> str:
    """把 WebDAV href 转成网盘路径，例如 /folder/file.mp4"""
    path = urlparse(href).path if "://" in href else href
    path = unquote(path)
    if not path.startswith("/"):
        path = "/" + path
    return path


def _format_size(num_bytes):
    if num_bytes is None:
        return "-"
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(num_bytes)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.1f}{unit}" if unit != "B" else f"{int(size)}B"
        size /= 1024


def list_files(remote_path="/", verbose=True):
    """
    列出指定远程路径下一层的文件和文件夹（不递归）。
    返回条目列表，每项: {"path", "name", "is_dir", "size"}
    """
    if not remote_path.startswith("/"):
        remote_path = "/" + remote_path
    if not remote_path.endswith("/"):
        remote_path += "/"

    url = f"{WEBDAV_URL}{remote_path}"
    response = requests.request(
        "PROPFIND",
        url,
        auth=auth,
        headers=headers,
        timeout=REQUEST_TIMEOUT,
    )

    if response.status_code != 207:
        print(f"列出文件失败 [{remote_path}]，状态码: {response.status_code}")
        if verbose and response.text:
            print(response.text[:500])
        return []

    root = ET.fromstring(response.content)
    current = _normalize_remote_path(remote_path).rstrip("/") or "/"
    entries = []

    for resp in root.findall("d:response", DAV_NS):
        href_el = resp.find("d:href", DAV_NS)
        if href_el is None or not href_el.text:
            continue

        path = _normalize_remote_path(href_el.text)
        path_norm = path.rstrip("/") or "/"
        if path_norm == current:
            continue  # 跳过目录自身

        prop = resp.find("d:propstat/d:prop", DAV_NS)
        is_dir = False
        size = None
        display_name = os.path.basename(path_norm)

        if prop is not None:
            name_el = prop.find("d:displayname", DAV_NS)
            if name_el is not None and name_el.text:
                display_name = name_el.text
            is_dir = prop.find("d:resourcetype/d:collection", DAV_NS) is not None
            size_el = prop.find("d:getcontentlength", DAV_NS)
            if size_el is not None and size_el.text and size_el.text.isdigit():
                size = int(size_el.text)

        if is_dir and not path.endswith("/"):
            path = path + "/"

        entries.append(
            {
                "path": path,
                "name": display_name,
                "is_dir": is_dir,
                "size": size,
            }
        )

    entries.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))

    if verbose:
        print(f"成功连接到: {url}")
        print(f"\n目录: {remote_path}")
        print(f"{'类型':<6} {'大小':>10}  路径")
        print("-" * 60)
        if not entries:
            print("(空目录)")
        for item in entries:
            kind = "DIR" if item["is_dir"] else "FILE"
            print(f"{kind:<6} {_format_size(item['size']):>10}  {item['path']}")
        print(f"\n共 {len(entries)} 项（仅当前一层）")
    return entries


def walk_remote(root_path="/", progress=True, stop_when_names=None):
    """
    递归遍历网盘（逐层 Depth=1），返回已扫到的文件条目列表。
    PikPak WebDAV 不支持 Depth=infinity / SEARCH，只能客户端递归。

    stop_when_names: 可选，文件名集合。一旦这些名字全部命中，提前结束扫描。
    会优先进入「目录名像目标文件名」的子目录，加快单文件查找。
    """
    if not root_path.startswith("/"):
        root_path = "/" + root_path
    if not root_path.endswith("/"):
        root_path += "/"

    wanted = {n.lower() for n in stop_when_names} if stop_when_names else None
    found_wanted = set()
    # 从目标文件名提取关键词，用于目录优先（去掉扩展名，按非字母数字切分）
    priority_tokens = set()
    if wanted:
        import re

        for name in wanted:
            stem = os.path.splitext(name)[0].lower()
            priority_tokens.add(stem)
            for tok in re.split(r"[^a-z0-9\u4e00-\u9fff]+", stem):
                if len(tok) >= 3:
                    priority_tokens.add(tok)

    queue = [root_path]
    seen_dirs = set()
    all_files = []
    dirs_visited = 0
    stopped_early = False

    def dir_priority(path):
        name = os.path.basename(path.rstrip("/")).lower()
        if not priority_tokens:
            return 1
        if any(tok in name for tok in priority_tokens):
            return 0
        return 1

    while queue:
        current = queue.pop(0)
        norm = current.rstrip("/") or "/"
        if norm in seen_dirs:
            continue
        seen_dirs.add(norm)

        entries = list_files(current, verbose=False)
        dirs_visited += 1
        file_count = sum(1 for e in entries if not e["is_dir"])
        dir_count = sum(1 for e in entries if e["is_dir"])
        if progress:
            print(
                f"[扫描] {current} -> {file_count} 文件, {dir_count} 子目录 "
                f"(已访目录 {dirs_visited}, 累计文件 {len(all_files) + file_count})"
            )

        child_dirs = []
        for item in entries:
            if item["is_dir"]:
                child_dirs.append(item["path"])
            else:
                all_files.append(item)
                if wanted is not None:
                    name_l = item["name"].lower()
                    if name_l in wanted:
                        found_wanted.add(name_l)
                        print(
                            f"[命中目标] {item['path']}  ({_format_size(item['size'])})"
                        )

        # 优先目录插到队列前面，其余追加后面
        child_dirs.sort(key=dir_priority)
        high = [d for d in child_dirs if dir_priority(d) == 0]
        low = [d for d in child_dirs if dir_priority(d) != 0]
        queue = high + queue + low

        if wanted is not None and found_wanted >= wanted:
            stopped_early = True
            if progress:
                print("已找到全部目标文件名，提前结束扫描。")
            break

    if progress:
        extra = "（提前结束）" if stopped_early else ""
        print(f"\n扫描完成{extra}：目录 {dirs_visited} 个，文件 {len(all_files)} 个")
    return all_files


def search_by_name(keyword, root_path="/", exact=False, progress=True):
    """
    按文件名在网盘中检索（客户端递归 + 本地匹配）。
    exact=True: 文件名完全相等（忽略大小写）
    exact=False: 文件名包含 keyword（忽略大小写）
    """
    keyword_l = keyword.lower()
    stop_names = {keyword} if exact else None
    matches = []
    for item in walk_remote(
        root_path=root_path,
        progress=progress,
        stop_when_names=stop_names,
    ):
        name_l = item["name"].lower()
        hit = name_l == keyword_l if exact else keyword_l in name_l
        if hit:
            matches.append(item)
            if not exact:
                print(
                    f"[命中] {item['path']}  ({_format_size(item['size'])})"
                )
    # exact 模式已在 walk 中打印命中；这里去重整理
    if exact:
        matches = [i for i in matches if i["name"].lower() == keyword_l]
    return matches


def check_local_against_cloud(
    local_path,
    root_path="/",
    match_size=True,
    progress=True,
):
    """
    检查本地文件/目录下的视频是否已在网盘中。
    - local_path 为文件：只检查该文件
    - local_path 为目录：检查目录下一层常见视频文件（不递归本地子目录）
    比对规则：文件名（忽略大小写）；若 match_size=True 且双方都有大小，再比大小。
    """
    video_exts = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".ts", ".m4v"}

    if os.path.isfile(local_path):
        local_files = [local_path]
    elif os.path.isdir(local_path):
        local_files = [
            os.path.join(local_path, name)
            for name in os.listdir(local_path)
            if os.path.isfile(os.path.join(local_path, name))
            and os.path.splitext(name)[1].lower() in video_exts
        ]
    else:
        raise FileNotFoundError(f"本地路径不存在: {local_path}")

    print(f"本地待比对文件数: {len(local_files)}")
    print("开始扫描云端目录结构...")
    target_names = {os.path.basename(p) for p in local_files}
    remote_files = walk_remote(
        root_path=root_path,
        progress=progress,
        stop_when_names=target_names,
    )

    # name.lower() -> [remote entries]
    index = {}
    for item in remote_files:
        index.setdefault(item["name"].lower(), []).append(item)

    results = []
    for lp in sorted(local_files, key=lambda p: os.path.basename(p).lower()):
        name = os.path.basename(lp)
        local_size = os.path.getsize(lp)
        candidates = index.get(name.lower(), [])

        name_hits = candidates
        size_hits = [
            c
            for c in candidates
            if (not match_size) or c["size"] is None or c["size"] == local_size
        ]

        if size_hits:
            status = "uploaded"
            remotes = size_hits
        elif name_hits:
            status = "name_only"  # 同名但大小不一致
            remotes = name_hits
        else:
            status = "missing"
            remotes = []

        row = {
            "local_path": lp,
            "local_name": name,
            "local_size": local_size,
            "status": status,
            "remote_matches": remotes,
        }
        results.append(row)

        if status == "uploaded":
            remote_desc = ", ".join(
                f"{r['path']}({_format_size(r['size'])})" for r in remotes
            )
            print(f"[已上传] {name}  ->  {remote_desc}")
        elif status == "name_only":
            remote_desc = ", ".join(
                f"{r['path']}(云端{_format_size(r['size'])}/本地{_format_size(local_size)})"
                for r in remotes
            )
            print(f"[同名异大小] {name}  ->  {remote_desc}")
        else:
            print(f"[未找到] {name}  (本地 {_format_size(local_size)})")

    uploaded = sum(1 for r in results if r["status"] == "uploaded")
    name_only = sum(1 for r in results if r["status"] == "name_only")
    missing = sum(1 for r in results if r["status"] == "missing")
    print(
        f"\n汇总: 已上传 {uploaded} / 同名异大小 {name_only} / 未找到 {missing} "
        f"/ 合计 {len(results)}"
    )
    return results

def download_file(remote_file_path, local_file_name):
    url = f"{WEBDAV_URL}{remote_file_path}"
    local_path = os.path.join(LOCAL_SAVE_DIR, local_file_name)
    
    print(f"正在下载: {remote_file_path} -> {local_path}")
    for attempt in range(1, MAX_RETRIES + 1):
        existing_size = os.path.getsize(local_path) if os.path.exists(local_path) else 0
        request_headers = {}
        write_mode = "wb"
        if existing_size > 0:
            request_headers["Range"] = f"bytes={existing_size}-"
            write_mode = "ab"
            print(f"检测到已下载 {existing_size} 字节，尝试断点续传（第 {attempt}/{MAX_RETRIES} 次）")
        else:
            print(f"开始下载（第 {attempt}/{MAX_RETRIES} 次）")

        try:
            response = requests.get(
                url,
                auth=auth,
                headers=request_headers,
                stream=True,
                timeout=REQUEST_TIMEOUT
            )

            if response.status_code == 200 and existing_size > 0:
                # 服务端未按 Range 返回，改为从头覆盖下载，避免文件内容错位。
                print("服务端未返回 206，改为从头下载。")
                write_mode = "wb"

            if response.status_code in (200, 206):
                with open(local_path, write_mode) as f:
                    for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                        if chunk:
                            f.write(chunk)
                print(f"下载完成: {local_file_name}")
                return True

            if response.status_code == 416:
                print(f"文件已下载完成: {local_file_name}")
                return True

            print(f"下载失败，状态码: {response.status_code}")

        except requests.exceptions.RequestException as e:
            print(f"第 {attempt} 次下载异常: {e}")

        if attempt < MAX_RETRIES:
            wait_seconds = RETRY_BACKOFF_SECONDS * attempt
            print(f"{wait_seconds} 秒后重试...")
            time.sleep(wait_seconds)

    print(f"下载失败，已达到最大重试次数: {MAX_RETRIES}")
    return False

# 使用示例
if __name__ == "__main__":
    import sys

    # 用法:
    #   py -3 "pikpak copy.PY"                         # 默认列根目录（不下载）
    #   py -3 "pikpak copy.PY" list /My\ Pack/
    #   py -3 "pikpak copy.PY" search example.mp4
    #   py -3 "pikpak copy.PY" check "<本地文件或目录路径>"

    args = sys.argv[1:]
    if not args:
        list_files("/", verbose=True)
    elif args[0] == "list":
        path = args[1] if len(args) > 1 else "/"
        list_files(path, verbose=True)
    elif args[0] == "search":
        if len(args) < 2:
            print("用法: search <文件名关键词>")
            sys.exit(1)
        exact = "--exact" in args
        keyword = args[1]
        hits = search_by_name(keyword, exact=exact)
        print(f"\n搜索结束，命中 {len(hits)} 条")
    elif args[0] == "check":
        if len(args) < 2:
            print("用法: check <本地文件或目录路径>")
            sys.exit(1)
        check_local_against_cloud(args[1])
    else:
        print("未知命令。支持: list / search / check")
        sys.exit(1)
