"""Storage file operations, delegated to the owning connector when remote."""
from __future__ import annotations

import os
import ntpath
import requests
import config
import db
import filesystem
import nodes
import store
import tickets
import writes


def operate(storage_id: str, relative: str, delete: bool = False) -> dict:
    st = store.get_storage_row(storage_id)
    if not st:
        raise FileNotFoundError("存储不存在")
    # Validate on both ends; Windows paths are resolved only on the owning device.
    if not isinstance(relative, str):
        raise ValueError("路径不正确")
    relative = relative.replace("\\", "/").strip("/") if not relative.startswith(("/", "\\")) else relative
    if relative.startswith(("/", "\\")) or any(x == ".." or ":" in x for x in relative.split("/")):
        raise ValueError("路径超出存储目录")
    if delete and not relative:
        raise ValueError("不能删除存储根目录")
    node_id = st["node_id"]
    if node_id and node_id != nodes.LOOPBACK_ID:
        node = nodes.get_node(node_id)
        if not node or not nodes.is_online(node_id):
            raise OSError("存储设备离线，请连接后重试")
        ticket, _ = tickets.sign(node["stream_key"], node_id, storage_id, "", relative,
                                 purpose="delete" if delete else "browse")
        response = requests.request("DELETE" if delete else "GET",
                                    node["base_url"].rstrip("/") + "/files/entries",
                                    params={"ticket": ticket}, timeout=(5, 30))
        if response.status_code == 404:
            try:
                body = response.json()
            except ValueError:
                raise OSError("连接器需更新后才能浏览所有文件和删除文件")
            raise FileNotFoundError(body.get("error", {}).get("message", "文件或目录不存在"))
        try:
            body = response.json()
        except ValueError:
            raise OSError("连接器返回无效响应，请更新连接器")
        if not response.ok or not body.get("ok"):
            raise OSError(body.get("error", {}).get("message", "连接器文件操作失败"))
        result = body["data"]
    else:
        if not os.path.isdir(st["root_path"]):
            raise OSError("存储目录不可达，请连接存储设备后重试")
        if delete:
            filesystem.delete(st["root_path"], relative)
            result = {"removed": True}
        else:
            result = filesystem.browse(st["root_path"], relative)
    if delete:
        forget(storage_id, relative)
    return result


def forget(storage_id: str, relative: str) -> None:
    # A folder may be registered both on its own and inside a larger root.
    # Remove aliases on the same device so deleted files cannot remain as stale cards.
    source = store.get_storage_row(storage_id)
    path_module = ntpath if "\\" in source["root_path"] or (len(source["root_path"]) > 1 and source["root_path"][1] == ":") else os.path
    def identity(root, path):
        return path_module.normcase(path_module.normpath(path_module.join(root, path)))
    target = identity(source["root_path"], relative)
    owner = source["node_id"] or nodes.LOOPBACK_ID
    conn = db.get_conn()
    for st in list(conn.execute("SELECT * FROM storages")):
        if (st["node_id"] or nodes.LOOPBACK_ID) != owner:
            continue
        for row in list(conn.execute("SELECT id,file_path FROM media WHERE storage_id=?", (st["id"],))):
            if not row["file_path"]:
                continue
            candidate = identity(st["root_path"], row["file_path"])
            if candidate == target or candidate.startswith(target.rstrip(path_module.sep) + path_module.sep):
                writes.delete_media(row["id"])


def delete_media_file(media_id: str) -> bool:
    row = store.get_media_row(media_id)
    if not row:
        return False
    if row["file_path"] and row["has_file"]:
        if row["storage_id"]:
            # Missing files can still have stale library records.
            try:
                operate(row["storage_id"], row["file_path"], delete=True)
            except FileNotFoundError:
                pass
        else:
            path = config.resolve_asset(row["file_path"])
            if not path:
                raise ValueError("文件路径不正确")
            path = filesystem.resolve(config.DATA_DIR, row["file_path"])
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
    # operate() may already have removed the record.
    writes.delete_media(media_id)
    return True


def _relative(path: str, allow_root: bool = False) -> str:
    import posixpath
    if not isinstance(path, str) or '\x00' in path:
        raise ValueError('路径不正确')
    value = path.replace('\\', '/')
    if value.startswith('/') or any(p == '..' or ':' in p for p in value.split('/')):
        raise ValueError('路径超出存储目录')
    value = posixpath.normpath(value).strip('/')
    if value == '.':
        value = ''
    if not value and not allow_root:
        raise ValueError('不能重命名或移动存储根目录')
    return value


def _perform_relocation(st, source: str, target: str) -> dict:
    node_id = st['node_id']
    if not node_id or node_id == nodes.LOOPBACK_ID:
        if not os.path.isdir(st['root_path']):
            raise OSError('存储目录不可达，请连接存储设备后重试')
        return filesystem.relocate(st['root_path'], source, target)
    node = nodes.get_node(node_id)
    if not node or not nodes.is_online(node_id):
        raise OSError('存储设备离线，请连接后重试')
    ticket, _ = tickets.sign(node['stream_key'], node_id, st['id'], '', source,
                             purpose='relocate', destination=target)
    response = requests.request('PATCH', node['base_url'].rstrip('/') + '/files/entries',
                                params={'ticket': ticket}, timeout=(5, 30))
    try:
        body = response.json()
    except ValueError:
        raise OSError('连接器需更新后才能重命名和移动文件')
    if not response.ok or not body.get('ok'):
        message = body.get('error', {}).get('message', '连接器文件操作失败')
        if response.status_code == 404:
            raise FileNotFoundError(message)
        raise OSError(message)
    return body['data']


def relocate(storage_id: str, relative: str, action: str, name=None, directory=None) -> dict:
    """Move within a registered root and keep all video identities/annotations."""
    import posixpath
    import time
    st = store.get_storage_row(storage_id)
    if not st:
        raise FileNotFoundError('存储不存在')
    source = _relative(relative)
    if action == 'rename':
        target = posixpath.join(posixpath.dirname(source), filesystem.validate_name(name))
    elif action == 'move':
        target = posixpath.join(_relative(directory, allow_root=True), posixpath.basename(source))
    else:
        raise ValueError('不支持的文件操作')
    if source == target:
        raise ValueError('名称或目标位置没有变化')
    if target.startswith(source + '/'):
        raise ValueError('不能将文件夹移动到自身或其子目录')
    path_module = ntpath if '\\' in st['root_path'] or (len(st['root_path']) > 1 and st['root_path'][1] == ':') else os.path
    def identity(root, path=''):
        return path_module.normcase(path_module.normpath(path_module.join(root, path)))
    def inside(child, parent):
        return child == parent or child.startswith(parent.rstrip(path_module.sep) + path_module.sep)
    old_path = path_module.normpath(path_module.join(st['root_path'], source))
    new_path = path_module.normpath(path_module.join(st['root_path'], target))
    old_abs, new_abs = identity(st['root_path'], source), identity(st['root_path'], target)
    if old_abs == new_abs:
        raise ValueError('名称或目标位置没有变化')
    owner = st['node_id'] or nodes.LOOPBACK_ID
    conn = db.get_conn()
    conn.execute('BEGIN IMMEDIATE')
    moved = False
    try:
        roots = [row for row in conn.execute('SELECT * FROM storages') if (row['node_id'] or nodes.LOOPBACK_ID) == owner]
        # Moving a registered root would break the connector's persistent root mapping.
        if any(inside(identity(row['root_path']), old_abs) for row in roots):
            raise ValueError('此文件夹包含单独登记的存储目录，请先在设置中移除对应登记')
        changes = []
        for root in roots:
            for row in conn.execute('SELECT * FROM media WHERE storage_id=?', (root['id'],)):
                if not row['file_path']:
                    continue
                original_path = path_module.normpath(path_module.join(root['root_path'], row['file_path']))
                original = path_module.normcase(original_path)
                if not inside(original, old_abs):
                    continue
                suffix = path_module.relpath(original_path, old_path)
                destination = new_path if suffix == '.' else path_module.join(new_path, suffix)
                # If an overlapping root no longer contains this alias, retain its
                # identity under the root in which the user performed the move.
                new_root = root if inside(path_module.normcase(destination), identity(root['root_path'])) else st
                new_rel = path_module.relpath(destination, new_root['root_path']).replace('\\', '/')
                new_name = posixpath.splitext(posixpath.basename(target))[0] if action == 'rename' and original == old_abs else row['name']
                changes.append((row['id'], new_root['id'], new_rel, posixpath.dirname(new_rel), new_name))
        result = _perform_relocation(st, source, target)
        moved = True
        if changes:
            rev, now = db.bump_revision(), int(time.time() * 1000)
            for mid, sid, rel, folder, label in changes:
                conn.execute('UPDATE media SET storage_id=?,file_path=?,folder=?,name=?,updated_at=?,updated_rev=? WHERE id=?',
                             (sid, rel, folder, label, now, rev, mid))
                conn.execute('UPDATE media SET parent_name=?,folder=?,updated_at=?,updated_rev=? WHERE parent_id=?',
                             (label, folder, now, rev, mid))
        conn.commit()
        return {'path': target, 'updated': len(changes)}
    except Exception:
        conn.rollback()
        if moved:
            # Restore the filesystem if the metadata transaction could not commit.
            _perform_relocation(st, target, source)
        raise


def create_entry(storage_id: str, relative: str, stream=None, expected_size=None) -> dict:
    import scanner
    import shutil
    import tempfile
    st = store.get_storage_row(storage_id)
    if not st:
        raise FileNotFoundError('存储不存在')
    relative = _relative(relative)
    filesystem.validate_name(relative.rsplit('/', 1)[-1])
    node_id = st['node_id']
    remote = node_id and node_id != nodes.LOOPBACK_ID
    purpose = 'upload-file' if stream is not None else 'mkdir'
    if remote:
        node = nodes.get_node(node_id)
        if not node or not nodes.is_online(node_id):
            raise OSError('存储设备离线，请连接后重试')
        ticket, _ = tickets.sign(node['stream_key'], node_id, storage_id, '', relative, purpose=purpose)
        url = node['base_url'].rstrip('/') + ('/files/content' if stream is not None else '/files/entries')
        # Spool large uploads to disk instead of retaining a video in RAM.
        with tempfile.TemporaryFile() as spool:
            if stream is not None:
                shutil.copyfileobj(stream, spool, 1024 * 1024)
                if expected_size is not None and spool.tell() != expected_size:
                    raise ValueError('上传中断，文件大小不完整，请重试')
                spool.seek(0)
            response = requests.request('PUT' if stream is not None else 'POST', url,
                                        params={'ticket': ticket}, data=spool if stream is not None else None,
                                        headers={'Content-Type': 'application/octet-stream'}, timeout=(5, 300))
        try:
            body = response.json()
        except ValueError:
            raise OSError('请先更新 Windows 连接器，才能新建文件夹和上传文件')
        if not response.ok or not body.get('ok'):
            raise OSError(body.get('error', {}).get('message', '文件操作失败，请检查连接器版本'))
        result = body['data']
    else:
        if not os.path.isdir(st['root_path']):
            raise OSError('存储目录不可达，请连接存储设备后重试')
        result = filesystem.upload(st['root_path'], relative, stream, expected_size) if stream is not None else filesystem.mkdir(st['root_path'], relative)
    if stream is not None and os.path.splitext(relative)[1].lower() in filesystem.VIDEO_EXTS:
        scanner.apply_scan_report(storage_id, [{'rel_path': relative, 'size': result['size']}], node_id=node_id)
    return result
