"""Browse/delete entries inside an explicitly registered storage root."""
from __future__ import annotations

import os
import shutil
import stat

VIDEO_EXTS = {'.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi'}


def resolve(root: str, relative: str, allow_root: bool = False) -> str:
    if not isinstance(relative, str) or '\x00' in relative:
        raise ValueError('路径不正确')
    relative = relative.replace('\\', '/')
    parts = relative.split('/')
    if relative.startswith('/') or any(p == '..' or ':' in p for p in parts):
        raise ValueError('路径超出存储目录')
    parts = [p for p in parts if p and p != '.']
    if not parts and not allow_root:
        raise ValueError('不能删除存储根目录')
    base = os.path.realpath(root)
    target = os.path.join(base, *parts)
    # Reject symlinks/junctions rather than following them for destructive operations.
    current = base
    for part in parts:
        current = os.path.join(current, part)
        if os.path.islink(current) or (hasattr(os.path, 'isjunction') and os.path.isjunction(current)):
            raise ValueError('不支持操作符号链接或目录联接')
    if os.path.commonpath([base, os.path.realpath(target)]) != base:
        raise ValueError('路径超出存储目录')
    return target


def browse(root: str, relative: str = '') -> dict:
    target = resolve(root, relative, allow_root=True)
    entries = []
    with os.scandir(target) as children:
        for entry in children:
            if entry.name.startswith('.vm-upload-'):
                continue
            if entry.is_symlink() or (hasattr(os.path, 'isjunction') and os.path.isjunction(entry.path)):
                continue
            try:
                info = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            directory = stat.S_ISDIR(info.st_mode)
            if not directory and not stat.S_ISREG(info.st_mode):
                continue
            rel = os.path.relpath(entry.path, os.path.realpath(root)).replace('\\', '/')
            entries.append({'name': entry.name, 'path': rel,
                            'kind': 'directory' if directory else 'file',
                            'isVideo': not directory and os.path.splitext(entry.name)[1].lower() in VIDEO_EXTS,
                            'size': 0 if directory else info.st_size})
    entries.sort(key=lambda e: (e['kind'] != 'directory', e['name'].casefold()))
    return {'path': relative, 'entries': entries,
            'directoryCount': sum(e['kind'] == 'directory' for e in entries),
            'fileCount': sum(e['kind'] == 'file' for e in entries)}


def delete(root: str, relative: str) -> None:
    target = resolve(root, relative)
    if os.path.isdir(target):
        shutil.rmtree(target)
    else:
        os.unlink(target)


def validate_name(name: str) -> str:
    # Use names that are valid on both Windows and macOS.
    if not isinstance(name, str) or not name or name in ('.', '..') or name != name.strip() or name.endswith('.'):
        raise ValueError('请输入有效名称，不能以空格或点结尾')
    if any(ord(c) < 32 or c in '<>:"/\\|?*' for c in name):
        raise ValueError('名称不能包含 / \\ : * ? " < > | 或控制字符')
    if name.split('.')[0].upper() in {'CON','PRN','AUX','NUL',*(f'COM{i}' for i in range(1,10)),*(f'LPT{i}' for i in range(1,10))}:
        raise ValueError('该名称是系统保留名称')
    return name


def _rename_exclusive(source: str, target: str) -> None:
    """Fail on collisions, including a destination created after validation."""
    import ctypes
    import errno
    import sys
    if sys.platform == 'win32':
        os.rename(source, target)  # Windows never replaces an existing target.
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        result = libc.renamex_np(os.fsencode(source), os.fsencode(target), 4)  # RENAME_EXCL
    elif hasattr(libc, 'renameat2'):
        result = libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1)  # RENAME_NOREPLACE
    else:
        raise OSError('此系统不支持安全移动文件')
    if result != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise FileExistsError('目标目录中已存在同名文件或文件夹')
        if code == errno.EXDEV:
            raise OSError('目标跨越磁盘，请选择同一磁盘内的文件夹')
        raise OSError(code, os.strerror(code))


def relocate(root: str, relative: str, destination: str) -> dict:
    source = resolve(root, relative)
    target = resolve(root, destination)
    validate_name(os.path.basename(target))
    if not os.path.exists(source):
        raise FileNotFoundError('文件或目录不存在')
    if os.path.normcase(source) == os.path.normcase(target):
        raise ValueError('名称或目标位置没有变化')
    if os.path.isdir(source) and os.path.commonpath([source, target]) == source:
        raise ValueError('不能将文件夹移动到自身或其子目录')
    if not os.path.isdir(os.path.dirname(target)):
        raise FileNotFoundError('目标文件夹不存在')
    if os.path.lexists(target):
        raise FileExistsError('目标目录中已存在同名文件或文件夹')
    _rename_exclusive(source, target)
    return {'path': os.path.relpath(target, os.path.realpath(root)).replace('\\', '/')}


def mkdir(root: str, relative: str) -> dict:
    target = resolve(root, relative)
    validate_name(os.path.basename(target))
    os.mkdir(target)  # Existing files/directories are never replaced.
    return {'path': relative}


def upload(root: str, relative: str, stream, expected_size=None) -> dict:
    """Publish a complete upload atomically; no partial file and no overwrite."""
    import tempfile
    target = resolve(root, relative)
    validate_name(os.path.basename(target))
    if os.path.lexists(target):
        raise FileExistsError('目标目录中已存在同名文件或文件夹')
    if not os.path.isdir(os.path.dirname(target)):
        raise FileNotFoundError('目标文件夹不存在')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=os.path.dirname(target), prefix='.vm-upload-', delete=False) as output:
            temporary = output.name
            size = 0
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                size += len(chunk)
            if expected_size is not None and size != expected_size:
                raise ValueError('上传中断，文件大小不完整，请重试')
        _rename_exclusive(temporary, target)
        return {'path': relative, 'size': size}
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
