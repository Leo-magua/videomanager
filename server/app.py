import os
import json
import hashlib
import logging
import mimetypes
import shutil
import subprocess
import urllib.parse
from pathlib import Path
from flask import Flask, request, send_file, send_from_directory, jsonify, abort
from moviepy.editor import VideoFileClip
import uuid
from datetime import timedelta

# 初始化 Flask：server/ 在仓库内，数据与 dist 均在项目根目录
app = Flask(__name__)

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SERVER_DIR)
DIST_DIR = os.path.join(BASE_DIR, 'dist')

# 工作区配置：保存常用素材文件夹，并自动加入路径白名单
EDITOR_CONFIG_FILE = os.path.join(BASE_DIR, '.video_editor.config.json')

# 配置文件上传路径和允许的格式
UPLOAD_FOLDER = 'uploads'
DOWNLOAD_FOLDER = 'download'
OUTPUT_FOLDER = 'output'
ALLOWED_EXTENSIONS = {'mp4', 'avi', 'mov', 'mkv'}

# 创建目录（如果不存在）
os.makedirs(os.path.join(BASE_DIR, UPLOAD_FOLDER), exist_ok=True)
os.makedirs(os.path.join(BASE_DIR, DOWNLOAD_FOLDER), exist_ok=True)
os.makedirs(os.path.join(BASE_DIR, OUTPUT_FOLDER), exist_ok=True)

# 每个视频对应一个 JSON 打点缓存（文件名 = 路径哈希，内容含绝对路径便于清理）
MARK_CACHE_DIR = os.path.join(BASE_DIR, '.mark_cache')
os.makedirs(MARK_CACHE_DIR, exist_ok=True)

# MoviePy 临时文件目录（避免落在 server/ 且便于清理）
MOVIEPY_TEMP_DIR = os.path.join(BASE_DIR, '.moviepy_temp')
os.makedirs(MOVIEPY_TEMP_DIR, exist_ok=True)
os.environ.setdefault('MOVIEPY_TEMP_DIR', MOVIEPY_TEMP_DIR)

logger = logging.getLogger(__name__)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['DOWNLOAD_FOLDER'] = DOWNLOAD_FOLDER
app.config['OUTPUT_FOLDER'] = OUTPUT_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 500000 * 1024 * 1024  # 500MB限制


def trust_any_path():
    """本地单机可设 VIDEO_EDITOR_TRUST_ANY_PATH=1 跳过白名单（勿在公网暴露服务时使用）"""
    v = os.environ.get('VIDEO_EDITOR_TRUST_ANY_PATH', '').strip().lower()
    return v in ('1', 'true', 'yes', 'on')


def sanitize_path_input(raw):
    """去掉首尾空白与成对引号，展开环境变量与用户目录（如 %USERPROFILE%、~）"""
    if raw is None:
        return ''
    s = str(raw).strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in '"\'':
        s = s[1:-1].strip()
    s = os.path.expandvars(os.path.expanduser(s))
    return s.strip()


def editor_config_path():
    return EDITOR_CONFIG_FILE


def load_editor_config():
    """读取 .video_editor.config.json（保留 export_settings 等扩展字段）。"""
    default = {'browse_folders': []}
    if not os.path.isfile(EDITOR_CONFIG_FILE):
        return default
    try:
        with open(EDITOR_CONFIG_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return default
        folders = data.get('browse_folders') or data.get('folder_paths') or []
        if not isinstance(folders, list):
            folders = []
        data['browse_folders'] = folders
        return data
    except (json.JSONDecodeError, OSError):
        return default


def save_editor_config(data):
    """原子写入配置"""
    tmp = EDITOR_CONFIG_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, EDITOR_CONFIG_FILE)


def _dedupe_folder_paths(paths):
    """去重并规范为绝对路径（仅保留存在的目录）"""
    seen = set()
    out = []
    for p in paths:
        if not p:
            continue
        n = resolve_user_path(str(p).strip())
        if not n or not os.path.isdir(n):
            continue
        key = os.path.normcase(_normalize_existing_path(n))
        if key not in seen:
            seen.add(key)
            out.append(_normalize_existing_path(n))
    return out


def get_config_browse_folders():
    """配置中的素材目录（绝对路径、存在、去重）"""
    return _dedupe_folder_paths(load_editor_config().get('browse_folders', []))


def resolve_user_path(raw):
    """
    解析用户输入的路径为绝对路径。
    相对路径一律相对于项目目录 BASE_DIR（避免依赖 Flask 启动时的 cwd）。
    """
    s = sanitize_path_input(raw)
    if not s:
        return ''
    if not os.path.isabs(s):
        s = os.path.join(BASE_DIR, s)
    try:
        return str(Path(s).resolve(strict=False))
    except (OSError, ValueError, RuntimeError):
        return os.path.normpath(os.path.abspath(s))


def get_allowed_roots():
    """可访问视频根目录：项目目录 + 环境变量 VIDEO_EDITOR_EXTRA_ROOTS（Windows 用 ; 或 , 分隔）"""
    roots = set()
    try:
        roots.add(str(Path(BASE_DIR).resolve(strict=False)))
    except (OSError, ValueError, RuntimeError):
        roots.add(os.path.realpath(BASE_DIR))

    extra = os.environ.get('VIDEO_EDITOR_EXTRA_ROOTS', '')
    sep = ';' if os.name == 'nt' else ':'
    for part in extra.replace(',', sep).split(sep):
        r = sanitize_path_input(part)
        if not r:
            continue
        if not os.path.isabs(r):
            r = os.path.join(BASE_DIR, r)
        if os.path.isdir(r):
            try:
                roots.add(str(Path(r).resolve(strict=False)))
            except (OSError, ValueError, RuntimeError):
                roots.add(os.path.realpath(r))
    for p in get_config_browse_folders():
        roots.add(_normalize_existing_path(p))
    return roots


def _normalize_existing_path(path):
    """将已存在或逻辑路径统一为用于比较的字符串。"""
    try:
        return str(Path(path).resolve(strict=False))
    except (OSError, ValueError, RuntimeError):
        try:
            return os.path.realpath(path)
        except OSError:
            return os.path.normpath(path)


def is_path_under_allowed(path):
    """路径必须在允许根目录之下。Windows 上用 normcase + 前缀判断，避免 commonpath 大小写问题。"""
    if trust_any_path():
        return True
    cand = _normalize_existing_path(path)
    roots = get_allowed_roots()
    for root in roots:
        root_res = _normalize_existing_path(root)
        if os.name == 'nt':
            c = os.path.normcase(cand)
            r = os.path.normcase(root_res)
            # 根目录本身或子路径
            if c == r or c.startswith(r.rstrip(os.sep) + os.sep):
                return True
        else:
            try:
                Path(cand).resolve(strict=False).relative_to(Path(root_res).resolve(strict=False))
                return True
            except ValueError:
                continue
    return False


def allowed_roots_message():
    roots = sorted(get_allowed_roots())
    return '；'.join(roots) if roots else '(无)'


def normalize_mark_video_path(raw):
    """解析并规范为绝对路径字符串，用于缓存键与校验。"""
    p = resolve_user_path(raw or '')
    if not p:
        return ''
    return _normalize_existing_path(p)


def mark_cache_file_path(video_path_norm):
    """每个视频唯一对应一个缓存文件（避免路径字符在文件名中非法）。"""
    h = hashlib.sha256(video_path_norm.encode('utf-8')).hexdigest()
    return os.path.join(MARK_CACHE_DIR, f'{h}.json')


def cleanup_orphan_mark_caches():
    """
    删除缓存：对应视频文件已不存在，或缓存损坏。
    在每次扫描素材列表（list / all-saved）完成后调用。
    """
    if not os.path.isdir(MARK_CACHE_DIR):
        return
    for name in os.listdir(MARK_CACHE_DIR):
        if not name.endswith('.json'):
            continue
        fp = os.path.join(MARK_CACHE_DIR, name)
        try:
            with open(fp, 'r', encoding='utf-8') as f:
                data = json.load(f)
            vp = data.get('video_path')
            if not isinstance(vp, str) or not vp.strip():
                os.remove(fp)
                continue
            if not os.path.isfile(vp):
                os.remove(fp)
        except (json.JSONDecodeError, OSError, TypeError):
            try:
                os.remove(fp)
            except OSError:
                pass


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def format_seconds(seconds):
    return str(timedelta(seconds=round(seconds))).replace(':', '-').replace('.', '_')


def _output_dir():
    return os.path.join(BASE_DIR, app.config['OUTPUT_FOLDER'])


def _segment_planned_filename(origin_name, ext, idx, start_time, end_time, batch_prefix, segment_name):
    """生成片段输出文件名（不含路径）。"""
    if segment_name:
        return f"{segment_name}.{ext}"
    start_format = format_seconds(start_time)
    end_format = format_seconds(end_time)
    if batch_prefix:
        return f"{batch_prefix}_片段{idx + 1}_{start_format}_to_{end_format}.{ext}"
    return f"{origin_name}_片段{idx + 1}_{start_format}_to_{end_format}.{ext}"


def _cleanup_moviepy_temp_for_basename(basename_without_ext):
    """清理 MoviePy 失败后残留的 TEMP_MPY_* 文件（server/ 或临时目录）。"""
    for folder in (SERVER_DIR, MOVIEPY_TEMP_DIR, _output_dir()):
        try:
            for name in os.listdir(folder):
                if name.startswith(f"{basename_without_ext}TEMP_MPY_") or (
                    'TEMP_MPY_' in name and basename_without_ext in name
                ):
                    fp = os.path.join(folder, name)
                    try:
                        os.remove(fp)
                    except OSError:
                        pass
        except OSError:
            pass


def _is_valid_output_video(path):
    """已存在的输出是否视为完成（>10KB，避免把失败残留当成功）。"""
    try:
        return os.path.isfile(path) and os.path.getsize(path) > 10 * 1024
    except OSError:
        return False


_NVENC_AVAILABLE_CACHE = None

DEFAULT_EXPORT_SETTINGS = {
    'encoder': 'gpu',
    'nvenc_cq': 19,
    'ffmpeg_threads': 2,
}


def _env_gpu_encode_enabled():
    """环境变量默认策略（仅 encoder=auto 时参考）；设 VIDEO_EDITOR_GPU_ENCODE=0 倾向 CPU。"""
    v = os.environ.get('VIDEO_EDITOR_GPU_ENCODE', '1').strip().lower()
    return v not in ('0', 'false', 'no', 'off')


def normalize_export_settings(raw):
    """校验导出设置：encoder 为 auto | gpu | cpu。"""
    if not isinstance(raw, dict):
        raw = {}
    enc = str(raw.get('encoder', DEFAULT_EXPORT_SETTINGS['encoder'])).strip().lower()
    if enc not in ('auto', 'gpu', 'cpu'):
        enc = DEFAULT_EXPORT_SETTINGS['encoder']
    try:
        cq = int(raw.get('nvenc_cq', DEFAULT_EXPORT_SETTINGS['nvenc_cq']))
    except (TypeError, ValueError):
        cq = DEFAULT_EXPORT_SETTINGS['nvenc_cq']
    cq = max(0, min(51, cq))
    try:
        threads = int(raw.get('ffmpeg_threads', DEFAULT_EXPORT_SETTINGS['ffmpeg_threads']))
    except (TypeError, ValueError):
        threads = DEFAULT_EXPORT_SETTINGS['ffmpeg_threads']
    threads = max(1, min(32, threads))
    return {'encoder': enc, 'nvenc_cq': cq, 'ffmpeg_threads': threads}


def load_export_settings():
    """优先读配置文件，其次环境变量补默认值。"""
    cfg = load_editor_config()
    stored = cfg.get('export_settings')
    base = normalize_export_settings(stored if isinstance(stored, dict) else {})
    if not isinstance(stored, dict):
        if os.environ.get('VIDEO_EDITOR_NVENC_CQ'):
            try:
                base['nvenc_cq'] = max(0, min(51, int(os.environ['VIDEO_EDITOR_NVENC_CQ'].strip())))
            except ValueError:
                pass
        if os.environ.get('VIDEO_EDITOR_FFMPEG_THREADS'):
            try:
                base['ffmpeg_threads'] = max(1, int(os.environ['VIDEO_EDITOR_FFMPEG_THREADS'].strip()))
            except ValueError:
                pass
        if not _env_gpu_encode_enabled():
            base['encoder'] = 'cpu'
    return base


def save_export_settings(settings):
    cfg = load_editor_config()
    cfg['export_settings'] = normalize_export_settings(settings)
    save_editor_config(cfg)


def _ffmpeg_has_encoder(encoder_name):
    global _NVENC_AVAILABLE_CACHE
    if encoder_name == 'h264_nvenc' and _NVENC_AVAILABLE_CACHE is not None:
        return _NVENC_AVAILABLE_CACHE
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        ok = False
    else:
        try:
            proc = subprocess.run(
                [ffmpeg, '-hide_banner', '-encoders'],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            text = (proc.stdout or '') + (proc.stderr or '')
            ok = encoder_name in text
        except (OSError, subprocess.TimeoutExpired):
            ok = False
    if encoder_name == 'h264_nvenc':
        _NVENC_AVAILABLE_CACHE = ok
    return ok


def gpu_encode_available():
    return _ffmpeg_has_encoder('h264_nvenc')


def _resolve_use_gpu(encoder_mode):
    if encoder_mode == 'cpu':
        return False
    if encoder_mode == 'gpu':
        return True
    return _env_gpu_encode_enabled()


def get_video_export_settings(override=None):
    """
    导出参数：可由前端/配置文件指定 encoder（gpu|cpu|auto）。
    保留源分辨率与重编码精度；仍会有少量 CPU 用于解码/封装。
    """
    opts = load_export_settings()
    if override:
        opts = normalize_export_settings({**opts, **override})

    threads = opts['ffmpeg_threads']
    use_gpu = _resolve_use_gpu(opts['encoder'])

    if use_gpu and gpu_encode_available():
        return {
            'codec': 'h264_nvenc',
            'audio_codec': 'aac',
            'ffmpeg_params': [
                '-rc', 'vbr',
                '-cq', str(opts['nvenc_cq']),
                '-preset', 'p7',
                '-pix_fmt', 'yuv420p',
            ],
            'encoder_label': 'gpu_nvenc',
            'ffmpeg_threads': threads,
            'requested_encoder': opts['encoder'],
        }
    return {
        'codec': 'libx264',
        'audio_codec': 'aac',
        'ffmpeg_params': ['-crf', '19', '-preset', 'medium'],
        'encoder_label': 'cpu_x264',
        'ffmpeg_threads': threads,
        'requested_encoder': opts['encoder'],
    }


def write_export_videofile(clip, output_path, export_override=None):
    """按配置写出片段；用户选 GPU 但 NVENC 失败时自动回退 libx264。"""
    settings = get_video_export_settings(export_override)
    common = {
        'audio_codec': settings['audio_codec'],
        'ffmpeg_params': list(settings['ffmpeg_params']),
        'threads': settings['ffmpeg_threads'],
        'logger': None,
    }
    try:
        clip.write_videofile(
            output_path,
            codec=settings['codec'],
            **common,
        )
        return settings['encoder_label']
    except Exception:
        if settings['encoder_label'] != 'gpu_nvenc':
            raise
        clip.write_videofile(
            output_path,
            codec='libx264',
            audio_codec='aac',
            ffmpeg_params=['-crf', '19', '-preset', 'medium'],
            threads=settings['ffmpeg_threads'],
            logger=None,
        )
        return 'cpu_x264_fallback'


def resolve_input_video_path(data):
    """
    根据请求体解析剪辑输入视频的绝对路径。
    video_storage: uploads | download | local
    """
    storage = (data.get('video_storage') or data.get('storage') or 'uploads').lower()
    if storage == 'local':
        local_path = resolve_user_path(data.get('local_path', ''))
        if not local_path:
            return None, '未提供本地视频路径'
        if not os.path.isfile(local_path):
            return None, '视频文件不存在'
        if not allowed_file(local_path):
            return None, '不支持的文件格式'
        if not is_path_under_allowed(local_path):
            return None, (
                '路径不在允许的目录范围内。当前允许的根：'
                + allowed_roots_message()
                + '。可将目录加入 .video_editor.config.json 的 browse_folders，或设置 VIDEO_EDITOR_EXTRA_ROOTS / VIDEO_EDITOR_TRUST_ANY_PATH=1'
            )
        return local_path, None
    if storage == 'download':
        folder = app.config['DOWNLOAD_FOLDER']
    else:
        folder = app.config['UPLOAD_FOLDER']
    filename = data.get('filename')
    if not filename:
        return None, '缺少视频文件名'
    # 防止路径穿越
    safe_name = os.path.basename(filename)
    full = os.path.join(BASE_DIR, folder, safe_name)
    full = os.path.realpath(full)
    expected_root = os.path.realpath(os.path.join(BASE_DIR, folder))
    try:
        if os.path.commonpath([full, expected_root]) != expected_root:
            return None, '非法文件路径'
    except ValueError:
        return None, '非法文件路径'
    if not os.path.isfile(full):
        return None, '视频文件不存在'
    return full, None


@app.route('/upload', methods=['POST'])
def upload_video():
    if 'file' not in request.files:
        return jsonify({'success': False, 'msg': '未选择文件'})

    file = request.files['file']
    if file.filename == '':
        return jsonify({'success': False, 'msg': '文件名为空'})

    # storage: upload（默认 uploads）| download（来自网络等，存入 download）
    storage = (request.form.get('storage') or 'upload').lower()
    if storage not in ('upload', 'download'):
        storage = 'upload'
    target_folder = app.config['DOWNLOAD_FOLDER'] if storage == 'download' else app.config['UPLOAD_FOLDER']
    video_storage = 'download' if storage == 'download' else 'uploads'

    if file and allowed_file(file.filename):
        file_ext = file.filename.rsplit('.', 1)[1].lower()
        filename = f"{uuid.uuid4()}.{file_ext}"
        file_path = os.path.join(BASE_DIR, target_folder, filename)
        file.save(file_path)

        with VideoFileClip(file_path) as clip:
            duration = clip.duration

        return jsonify({
            'success': True,
            'msg': '上传成功',
            'filename': filename,
            'video_storage': video_storage,
            'origin_name': file.filename.rsplit('.', 1)[0],
            'duration': round(duration, 2),
            'ext': file_ext
        })
    return jsonify({'success': False, 'msg': '不支持的文件格式'})


@app.route('/register-local', methods=['POST'])
def register_local_video():
    """使用服务器上已有视频路径，不复制到 uploads。"""
    data = request.get_json() or {}
    path = resolve_user_path(data.get('path') or '')
    if not path:
        return jsonify({'success': False, 'msg': '路径为空'})
    if not os.path.isfile(path):
        return jsonify({'success': False, 'msg': '文件不存在'})
    if not allowed_file(path):
        return jsonify({'success': False, 'msg': '不支持的文件格式'})
    if not is_path_under_allowed(path):
        return jsonify({
            'success': False,
            'msg': (
                '路径不在允许范围内。当前允许的根：'
                + allowed_roots_message()
                + '。也可编辑项目下 .video_editor.config.json 的 browse_folders，或设置 VIDEO_EDITOR_EXTRA_ROOTS / VIDEO_EDITOR_TRUST_ANY_PATH=1'
            ),
            'allowed_roots': list(sorted(get_allowed_roots())),
            'config_file': EDITOR_CONFIG_FILE,
        })
    try:
        with VideoFileClip(path) as clip:
            duration = clip.duration
    except Exception as e:
        return jsonify({'success': False, 'msg': f'无法读取视频：{e}'})

    origin = os.path.splitext(os.path.basename(path))[0]
    ext = path.rsplit('.', 1)[1].lower()
    return jsonify({
        'success': True,
        'msg': '已载入本地视频',
        'video_storage': 'local',
        'local_path': path,
        'origin_name': origin,
        'duration': round(duration, 2),
        'ext': ext
    })


@app.route('/api/videos/list', methods=['GET'])
def list_videos_in_dir():
    """列出某目录下的视频文件（不递归）。"""
    directory = resolve_user_path(request.args.get('directory', '') or '')
    if not directory:
        return jsonify({'success': False, 'msg': '请提供 directory 参数'}), 400
    if not os.path.isdir(directory):
        return jsonify({'success': False, 'msg': '目录不存在'}), 400
    if not is_path_under_allowed(directory):
        return jsonify({
            'success': False,
            'msg': (
                '目录不在允许的根路径下。当前允许的根：'
                + allowed_roots_message()
                + '。也可在项目目录 .video_editor.config.json 的 browse_folders 中添加该路径，或设置环境变量 / TRUST_ANY_PATH'
            ),
            'allowed_roots': list(sorted(get_allowed_roots())),
            'config_file': EDITOR_CONFIG_FILE,
        }), 400

    items = []
    try:
        for name in sorted(os.listdir(directory)):
            full = os.path.join(directory, name)
            if os.path.isfile(full) and allowed_file(name):
                items.append({
                    'name': name,
                    'path': full,
                    'size': os.path.getsize(full)
                })
    except OSError as e:
        return jsonify({'success': False, 'msg': str(e)}), 400

    cleanup_orphan_mark_caches()
    return jsonify({'success': True, 'directory': directory, 'videos': items})


@app.route('/api/config', methods=['GET'])
def get_editor_config_api():
    folders = get_config_browse_folders()
    return jsonify({
        'success': True,
        'browse_folders': folders,
        'config_path': EDITOR_CONFIG_FILE,
        'allowed_roots': list(sorted(get_allowed_roots())),
        'export_settings': load_export_settings(),
        'gpu_available': gpu_encode_available(),
    })


@app.route('/api/config/export', methods=['POST'])
def save_export_settings_api():
    """保存剪辑编码设置到 .video_editor.config.json（前端设置页调用）。"""
    data = request.get_json(silent=True) or {}
    saved = normalize_export_settings(data)
    save_export_settings(saved)
    return jsonify({
        'success': True,
        'export_settings': saved,
        'gpu_available': gpu_encode_available(),
        'msg': '编码设置已保存',
    })


@app.route('/api/config/folders', methods=['POST'])
def modify_editor_config_folders():
    data = request.get_json() or {}
    action = (data.get('action') or '').strip().lower()
    cfg = load_editor_config()
    folders = cfg.get('browse_folders', [])
    if not isinstance(folders, list):
        folders = []

    if action == 'add':
        resolved = resolve_user_path(data.get('path', ''))
        if not resolved:
            return jsonify({'success': False, 'msg': '路径为空'}), 400
        if not os.path.isdir(resolved):
            return jsonify({'success': False, 'msg': '目录不存在或不是文件夹'}), 400
        merged = folders + [resolved]
        cfg['browse_folders'] = _dedupe_folder_paths(merged)
        save_editor_config(cfg)
        return jsonify({'success': True, 'browse_folders': cfg['browse_folders'], 'msg': '已保存到配置'})

    if action == 'remove':
        raw = data.get('path', '')
        target = _normalize_existing_path(resolve_user_path(raw))
        if not target:
            return jsonify({'success': False, 'msg': '路径为空'}), 400
        tkey = os.path.normcase(target)
        new_list = []
        for x in folders:
            nx = _normalize_existing_path(resolve_user_path(str(x)))
            if nx and os.path.normcase(nx) != tkey:
                new_list.append(nx)
        cfg['browse_folders'] = _dedupe_folder_paths(new_list)
        save_editor_config(cfg)
        return jsonify({'success': True, 'browse_folders': cfg['browse_folders'], 'msg': '已从配置移除'})

    return jsonify({'success': False, 'msg': 'action 须为 add 或 remove'}), 400


@app.route('/api/videos/all-saved', methods=['GET'])
def list_all_saved_folder_videos():
    """合并列出配置中所有素材目录下的视频（一层，不递归）。"""
    folders = get_config_browse_folders()
    if not folders:
        return jsonify({'success': True, 'videos': [], 'folders': []})
    items = []
    seen = set()
    for folder in folders:
        if not is_path_under_allowed(folder):
            continue
        try:
            for name in sorted(os.listdir(folder)):
                full = os.path.join(folder, name)
                if not os.path.isfile(full) or not allowed_file(name):
                    continue
                key = os.path.normcase(_normalize_existing_path(full))
                if key in seen:
                    continue
                seen.add(key)
                items.append({
                    'name': name,
                    'path': full,
                    'size': os.path.getsize(full),
                    'folder': folder,
                    'folder_label': os.path.basename(folder.rstrip(os.sep)) or folder,
                })
        except OSError:
            continue
    cleanup_orphan_mark_caches()
    return jsonify({'success': True, 'videos': items, 'folders': folders})


@app.route('/api/marks', methods=['GET'])
def get_video_marks():
    """读取某视频路径对应的打点与片段缓存（视频已删除则返回空）。"""
    raw = request.args.get('path', '') or ''
    path = normalize_mark_video_path(raw)
    if not path:
        return jsonify({'success': False, 'msg': '请提供 path 参数'}), 400
    if not is_path_under_allowed(path):
        return jsonify({'success': False, 'msg': '路径不在允许范围内'}), 403
    if not os.path.isfile(path) or not allowed_file(path):
        return jsonify({'success': True, 'marks': [], 'segments': None})

    cache_fp = mark_cache_file_path(path)
    if not os.path.isfile(cache_fp):
        return jsonify({'success': True, 'marks': [], 'segments': None})
    try:
        with open(cache_fp, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return jsonify({'success': True, 'marks': [], 'segments': None})

    marks = data.get('marks') if isinstance(data.get('marks'), list) else []
    segs = data.get('segments')
    if segs is not None and not isinstance(segs, list):
        segs = None
    return jsonify({'success': True, 'marks': marks, 'segments': segs})


@app.route('/api/marks', methods=['POST'])
def save_video_marks():
    """保存某视频的打点与片段缓存。"""
    data = request.get_json(silent=True) or {}
    raw = data.get('path', '') or ''
    path = normalize_mark_video_path(raw)
    if not path:
        return jsonify({'success': False, 'msg': '路径为空'}), 400
    if not os.path.isfile(path):
        return jsonify({'success': False, 'msg': '视频文件不存在'}), 400
    if not allowed_file(path):
        return jsonify({'success': False, 'msg': '不支持的文件格式'}), 400
    if not is_path_under_allowed(path):
        return jsonify({'success': False, 'msg': '路径不在允许范围内'}), 403

    marks = data.get('marks', [])
    segments = data.get('segments')
    if not isinstance(marks, list):
        return jsonify({'success': False, 'msg': 'marks 须为数组'}), 400
    if segments is not None and not isinstance(segments, list):
        return jsonify({'success': False, 'msg': 'segments 须为数组或省略'}), 400

    payload = {
        'video_path': path,
        'marks': marks,
        'segments': segments,
    }
    cache_fp = mark_cache_file_path(path)
    tmp = cache_fp + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, cache_fp)
    except OSError as e:
        return jsonify({'success': False, 'msg': str(e)}), 500
    return jsonify({'success': True})


@app.route('/stream-video', methods=['GET'])
def stream_video():
    """按服务器路径流式输出视频（仅允许路径在白名单内）。"""
    raw = request.args.get('path', '')
    path = resolve_user_path(urllib.parse.unquote(raw))
    if not path:
        abort(400)
    if not os.path.isfile(path) or not allowed_file(path):
        abort(404)
    if not is_path_under_allowed(path):
        abort(403)
    mime, _ = mimetypes.guess_type(path)
    if not mime or not mime.startswith('video/'):
        ext = path.rsplit('.', 1)[-1].lower()
        mime = {
            'mp4': 'video/mp4',
            'webm': 'video/webm',
            'mov': 'video/quicktime',
            'mkv': 'video/x-matroska',
            'avi': 'video/x-msvideo',
        }.get(ext, 'application/octet-stream')
    return send_file(path, mimetype=mime, conditional=True)


def _process_single_segment(
    clip,
    duration,
    idx,
    segment,
    origin_name,
    ext,
    batch_prefix,
    export_override,
    skip_existing,
):
    """
    处理单个时间段。返回 status: done | skipped | invalid | failed，
    以及 output / error 等字段。
    """
    start_time = end_time = None
    segment_filename = ''
    try:
        start_time = float(segment.get('start_time', 0))
        end_time = float(segment.get('end_time', 0))
        segment_name = segment.get('segment_name', '').strip()

        if start_time < 0 or end_time > duration or start_time >= end_time:
            return {
                'status': 'invalid',
                'index': idx,
                'start_time': start_time,
                'end_time': end_time,
                'reason': '时间超出视频范围或开始≥结束',
            }

        segment_filename = _segment_planned_filename(
            origin_name, ext, idx, start_time, end_time, batch_prefix, segment_name
        )
        output_path = os.path.join(_output_dir(), segment_filename)
        base_stem = segment_filename.rsplit('.', 1)[0]
        _cleanup_moviepy_temp_for_basename(base_stem)

        if skip_existing and _is_valid_output_video(output_path):
            return {
                'status': 'skipped',
                'index': idx,
                'encoder': None,
                'output': {
                    'filename': segment_filename,
                    'start_time': start_time,
                    'end_time': end_time,
                    'start_hms': format_seconds(start_time),
                    'end_hms': format_seconds(end_time),
                    'skipped': True,
                },
            }

        if os.path.exists(output_path) and not skip_existing:
            segment_filename = f"{base_stem}_{uuid.uuid4()}.{ext}"
            output_path = os.path.join(_output_dir(), segment_filename)
            base_stem = segment_filename.rsplit('.', 1)[0]

        subclip = clip.subclip(start_time, end_time)
        try:
            seg_encoder = write_export_videofile(
                subclip, output_path, export_override=export_override
            )
        finally:
            subclip.close()

        if not _is_valid_output_video(output_path):
            raise RuntimeError('输出文件过小或不存在，编码可能未完成')

        return {
            'status': 'done',
            'index': idx,
            'encoder': seg_encoder,
            'output': {
                'filename': segment_filename,
                'start_time': start_time,
                'end_time': end_time,
                'start_hms': format_seconds(start_time),
                'end_hms': format_seconds(end_time),
            },
        }
    except Exception as e:
        logger.exception('片段 %s 剪辑失败', idx + 1)
        if segment_filename:
            _cleanup_moviepy_temp_for_basename(segment_filename.rsplit('.', 1)[0])
        failed_path = os.path.join(_output_dir(), segment_filename) if segment_filename else ''
        if failed_path and os.path.isfile(failed_path):
            try:
                os.remove(failed_path)
            except OSError:
                pass
        return {
            'status': 'failed',
            'index': idx,
            'start_time': start_time,
            'end_time': end_time,
            'segment_name': segment.get('segment_name', ''),
            'error': str(e),
        }


# 单片段剪辑（供任务队列逐段上报进度）
@app.route('/api/clip/segment', methods=['POST'])
def clip_one_segment():
    data = request.get_json(silent=True) or {}
    time_segments = data.get('time_segments', [])
    try:
        segment_index = int(data.get('segment_index', 0))
    except (TypeError, ValueError):
        return jsonify({'success': False, 'msg': 'segment_index 无效'}), 400
    if segment_index < 0 or segment_index >= len(time_segments):
        return jsonify({'success': False, 'msg': 'segment_index 超出范围'}), 400

    origin_name = data.get('origin_name')
    ext = data.get('ext')
    batch_prefix = data.get('batch_prefix', '').strip()
    export_override = data.get('export_settings')
    if export_override is not None and not isinstance(export_override, dict):
        return jsonify({'success': False, 'msg': 'export_settings 须为对象'}), 400
    skip_existing = bool(data.get('skip_existing'))

    input_path, err = resolve_input_video_path(data)
    if err:
        return jsonify({'success': False, 'msg': err})

    segment = time_segments[segment_index]
    with VideoFileClip(input_path) as clip:
        result = _process_single_segment(
            clip,
            clip.duration,
            segment_index,
            segment,
            origin_name,
            ext,
            batch_prefix,
            export_override,
            skip_existing,
        )

    return jsonify({'success': True, **result})


# 批量视频剪辑接口
@app.route('/batch-clip', methods=['POST'])
def batch_clip_video():
    data = request.get_json(silent=True) or {}
    origin_name = data.get('origin_name')
    ext = data.get('ext')
    time_segments = data.get('time_segments', [])
    batch_prefix = data.get('batch_prefix', '').strip()

    input_path, err = resolve_input_video_path(data)
    if err:
        return jsonify({'success': False, 'msg': err})
    if len(time_segments) == 0:
        return jsonify({'success': False, 'msg': '未选择任何剪辑时间段'})

    export_override = data.get('export_settings')
    if export_override is not None and not isinstance(export_override, dict):
        return jsonify({'success': False, 'msg': 'export_settings 须为对象'}), 400

    skip_existing = bool(data.get('skip_existing'))
    export_settings = get_video_export_settings(export_override)
    encoder_used = export_settings['encoder_label']

    with VideoFileClip(input_path) as clip:
        duration = clip.duration
        output_files = []
        skipped_files = []
        failed_segments = []
        invalid_segments = []

        for idx, segment in enumerate(time_segments):
            result = _process_single_segment(
                clip,
                duration,
                idx,
                segment,
                origin_name,
                ext,
                batch_prefix,
                export_override,
                skip_existing,
            )
            st = result.get('status')
            if result.get('encoder') == 'cpu_x264_fallback':
                encoder_used = 'cpu_x264_fallback'
            if st == 'invalid':
                invalid_segments.append({
                    'index': result['index'],
                    'start_time': result.get('start_time'),
                    'end_time': result.get('end_time'),
                    'reason': result.get('reason'),
                })
            elif st == 'skipped':
                out = result['output']
                skipped_files.append({
                    'index': idx,
                    'filename': out['filename'],
                    'start_time': out['start_time'],
                    'end_time': out['end_time'],
                })
                output_files.append(out)
            elif st == 'done':
                output_files.append(result['output'])
            elif st == 'failed':
                failed_segments.append({
                    'index': result['index'],
                    'start_time': result.get('start_time'),
                    'end_time': result.get('end_time'),
                    'segment_name': result.get('segment_name', ''),
                    'error': result.get('error'),
                })

    new_count = len([f for f in output_files if not f.get('skipped')])
    if len(output_files) == 0:
        detail = ''
        if failed_segments:
            detail = f'；失败 {len(failed_segments)} 段，请查看 failed_segments'
        return jsonify({
            'success': False,
            'msg': f'没有生成任何片段（无效 {len(invalid_segments)} 段，失败 {len(failed_segments)} 段）{detail}',
            'failed_segments': failed_segments,
            'invalid_segments': invalid_segments,
        })

    encoder_msg = {
        'gpu_nvenc': '（NVIDIA NVENC 硬件编码）',
        'cpu_x264': '（CPU libx264 编码）',
        'cpu_x264_fallback': '（NVENC 不可用，已回退 CPU）',
    }.get(encoder_used, '')

    msg_parts = [f'共 {len(output_files)}/{len(time_segments)} 个片段可用']
    if new_count:
        msg_parts.append(f'本次新编码 {new_count} 个')
    if skipped_files:
        msg_parts.append(f'跳过已有 {len(skipped_files)} 个')
    if failed_segments:
        msg_parts.append(f'失败 {len(failed_segments)} 个（可勾选「仅续剪缺失」重试）')
    if invalid_segments:
        msg_parts.append(f'无效 {len(invalid_segments)} 个')
    msg = '，'.join(msg_parts) + encoder_msg

    return jsonify({
        'success': True,
        'msg': msg,
        'encoder': encoder_used,
        'export_settings': normalize_export_settings(
            export_override if isinstance(export_override, dict) else load_export_settings()
        ),
        'gpu_available': gpu_encode_available(),
        'output_files': output_files,
        'failed_segments': failed_segments,
        'skipped_segments': skipped_files,
        'invalid_segments': invalid_segments,
        'total_requested': len(time_segments),
    })


@app.route('/download/<filename>')
def download_video(filename):
    file_path = os.path.join(BASE_DIR, app.config['OUTPUT_FOLDER'], filename)
    if os.path.exists(file_path):
        return send_file(file_path, as_attachment=True)
    return jsonify({'success': False, 'msg': '文件不存在'}), 404


@app.route('/api/allowed-roots', methods=['GET'])
def allowed_roots_info():
    """前端可提示用户当前允许浏览的根路径。"""
    return jsonify({
        'roots': list(get_allowed_roots())
    })


@app.route('/assets/<path:filename>')
def serve_vite_assets(filename):
    """Vite 构建的 JS/CSS。"""
    assets_dir = os.path.normpath(os.path.join(DIST_DIR, 'assets'))
    safe = os.path.normpath(os.path.join(assets_dir, filename))
    if not safe.startswith(assets_dir) or not os.path.isfile(safe):
        abort(404)
    rel = os.path.relpath(safe, assets_dir)
    if rel.startswith('..'):
        abort(404)
    return send_from_directory(assets_dir, rel)


@app.route('/')
def serve_spa_root():
    """单页应用入口（React dist）。"""
    index_path = os.path.join(DIST_DIR, 'index.html')
    if not os.path.isfile(index_path):
        return (
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>VideoEditor</title></head>'
            '<body style="font-family:sans-serif;padding:2rem">'
            '<p>未找到前端构建产物 <code>dist/index.html</code>。</p>'
            '<p>请在项目根目录执行：<code>npm run build</code> 后再启动本服务。</p>'
            '</body></html>',
            503,
            {'Content-Type': 'text/html; charset=utf-8'},
        )
    return send_from_directory(DIST_DIR, 'index.html')


@app.route('/<path:path>')
def spa_history_fallback(path):
    """避免前端 history 路由被 404；带后缀名的路径仍 404。"""
    if '.' in path.split('/')[-1]:
        abort(404)
    index_path = os.path.join(DIST_DIR, 'index.html')
    if not os.path.isfile(index_path):
        abort(503)
    return send_from_directory(DIST_DIR, 'index.html')


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '5000'))
    app.run(debug=True, host='0.0.0.0', port=port)
