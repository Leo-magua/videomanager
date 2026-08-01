import { apiFetch, readJson, streamVideoUrl } from '@/lib/api';
import type {
  ClipOutputFile,
  ExportEncoder,
  ExportSettings,
  FailedClipSegment,
  MarkPoint,
  TimeSegment,
} from '@/types';
import { DEFAULT_EXPORT_SETTINGS } from '@/types';

const EXPORT_SETTINGS_STORAGE_KEY = 'video_editor_export_settings';

function normalizeExportSettings(raw: unknown): ExportSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_EXPORT_SETTINGS };
  const o = raw as Record<string, unknown>;
  let encoder = String(o.encoder ?? DEFAULT_EXPORT_SETTINGS.encoder).toLowerCase() as ExportEncoder;
  if (encoder !== 'auto' && encoder !== 'gpu' && encoder !== 'cpu') {
    encoder = DEFAULT_EXPORT_SETTINGS.encoder;
  }
  const nvenc_cq = Number(o.nvenc_cq);
  const ffmpeg_threads = Number(o.ffmpeg_threads);
  return {
    encoder,
    nvenc_cq: Number.isFinite(nvenc_cq) ? Math.max(0, Math.min(51, nvenc_cq)) : DEFAULT_EXPORT_SETTINGS.nvenc_cq,
    ffmpeg_threads: Number.isFinite(ffmpeg_threads)
      ? Math.max(1, Math.min(32, ffmpeg_threads))
      : DEFAULT_EXPORT_SETTINGS.ffmpeg_threads,
  };
}

export function loadExportSettingsFromStorage(): ExportSettings | null {
  try {
    const raw = localStorage.getItem(EXPORT_SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    return normalizeExportSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function persistExportSettingsToStorage(settings: ExportSettings): void {
  localStorage.setItem(EXPORT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export interface ApiVideo {
  name: string;
  path: string;
  size: number;
  /** 素材所在根目录（仅 /api/videos/all-saved 返回） */
  folder?: string;
  folder_label?: string;
}

export interface ApiResult {
  success: boolean;
  msg?: string;
}

export async function getAllowedRoots(): Promise<string[]> {
  const data = await readJson<{ roots: string[] }>(await apiFetch('/api/allowed-roots'));
  return data.roots ?? [];
}

export interface EditorConfigResponse {
  browse_folders: string[];
  export_settings?: ExportSettings;
  gpu_available?: boolean;
}

export async function getEditorConfig(): Promise<{
  browse_folders: string[];
  export_settings: ExportSettings;
  gpu_available: boolean;
}> {
  const data = await readJson<EditorConfigResponse>(await apiFetch('/api/config'));
  return {
    browse_folders: data.browse_folders ?? [],
    export_settings: { ...DEFAULT_EXPORT_SETTINGS, ...data.export_settings },
    gpu_available: data.gpu_available ?? false,
  };
}

export async function getConfigBrowseFolders(): Promise<string[]> {
  const { browse_folders } = await getEditorConfig();
  return browse_folders;
}

export async function saveExportSettings(
  settings: ExportSettings
): Promise<{ export_settings: ExportSettings; gpu_available: boolean }> {
  const data = await readJson<{
    success: boolean;
    msg?: string;
    export_settings?: ExportSettings;
    gpu_available?: boolean;
  }>(
    await apiFetch('/api/config/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
  );
  if (!data.success) throw new Error(data.msg || '保存编码设置失败');
  return {
    export_settings: { ...DEFAULT_EXPORT_SETTINGS, ...data.export_settings },
    gpu_available: data.gpu_available ?? false,
  };
}

export async function listAllSavedVideos(): Promise<ApiVideo[]> {
  const data = await readJson<{ success: boolean; videos: ApiVideo[] }>(
    await apiFetch('/api/videos/all-saved')
  );
  if (!data.success) throw new Error('加载素材失败');
  return data.videos ?? [];
}

export async function getVideoMarks(
  path: string
): Promise<{ marks: MarkPoint[]; segments: TimeSegment[] | null }> {
  const query = new URLSearchParams({ path }).toString();
  const data = await readJson<{
    success: boolean;
    marks?: MarkPoint[];
    segments?: TimeSegment[] | null;
    msg?: string;
  }>(await apiFetch(`/api/marks?${query}`));
  if (!data.success) throw new Error(data.msg || '读取打点失败');
  return { marks: data.marks ?? [], segments: data.segments ?? null };
}

export async function saveVideoMarks(
  path: string,
  marks: MarkPoint[],
  segments: TimeSegment[]
): Promise<void> {
  const res = await readJson<{ success: boolean; msg?: string }>(
    await apiFetch('/api/marks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, marks, segments }),
    })
  );
  if (!res.success) throw new Error(res.msg || '保存打点失败');
}

export async function listVideosInDirectory(directory: string): Promise<ApiVideo[]> {
  const query = new URLSearchParams({ directory }).toString();
  const data = await readJson<{ success: boolean; msg?: string; videos: ApiVideo[] }>(
    await apiFetch(`/api/videos/list?${query}`)
  );
  if (!data.success) throw new Error(data.msg || '扫描失败');
  return data.videos ?? [];
}

export async function addBrowseFolder(path: string): Promise<void> {
  const res = await readJson<ApiResult>(
    await apiFetch('/api/config/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', path }),
    })
  );
  if (!res.success) throw new Error(res.msg || '添加失败');
}

export async function removeBrowseFolder(path: string): Promise<void> {
  const res = await readJson<ApiResult>(
    await apiFetch('/api/config/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', path }),
    })
  );
  if (!res.success) throw new Error(res.msg || '移除失败');
}

export interface RegisterLocalResult {
  local_path: string;
  origin_name: string;
  duration: number;
  ext: string;
}

export async function registerLocalVideo(path: string): Promise<RegisterLocalResult> {
  const data = await readJson<
    ApiResult & Partial<RegisterLocalResult>
  >(
    await apiFetch('/register-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  );
  if (!data.success || data.local_path == null) throw new Error(data.msg || '打开失败');
  return {
    local_path: data.local_path,
    origin_name: data.origin_name ?? '',
    duration: data.duration ?? 0,
    ext: data.ext ?? 'mp4',
  };
}

export interface UploadVideoResult {
  filename: string;
  video_storage: 'uploads' | 'download';
  origin_name: string;
  duration: number;
  ext: string;
}

export async function uploadVideo(file: File, storage: 'upload' | 'download'): Promise<UploadVideoResult> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('storage', storage);
  const data = await readJson<ApiResult & Partial<UploadVideoResult>>(
    await apiFetch('/upload', { method: 'POST', body: fd })
  );
  if (!data.success || !data.filename || !data.video_storage) {
    throw new Error(data.msg || '上传失败');
  }
  return {
    filename: data.filename,
    video_storage: data.video_storage,
    origin_name: data.origin_name ?? '',
    duration: data.duration ?? 0,
    ext: data.ext ?? 'mp4',
  };
}

export interface BatchClipPayload {
  origin_name: string;
  ext: string;
  time_segments: Array<{
    start_time: number;
    end_time: number;
    segment_name: string;
  }>;
  batch_prefix: string;
  video_storage: 'uploads' | 'download' | 'local';
  filename?: string;
  local_path?: string;
  export_settings?: ExportSettings;
  /** 为 true 时跳过 output 里已存在且完整的同名片段（用于续剪） */
  skip_existing?: boolean;
}

export interface BatchClipResult {
  output_files: ClipOutputFile[];
  failed_segments?: FailedClipSegment[];
  skipped_segments?: Array<{ index: number; filename: string }>;
  invalid_segments?: FailedClipSegment[];
  total_requested?: number;
  encoder?: string;
  msg?: string;
}

export interface ClipSegmentResult {
  success: boolean;
  status: 'done' | 'skipped' | 'invalid' | 'failed';
  index: number;
  output?: ClipOutputFile;
  error?: string;
  reason?: string;
  msg?: string;
}

export async function clipSegment(
  payload: BatchClipPayload & { segment_index: number }
): Promise<ClipSegmentResult> {
  const res = await readJson<ApiResult & ClipSegmentResult>(
    await apiFetch('/api/clip/segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
  if (!res.success) throw new Error(res.msg || '片段剪辑失败');
  return res;
}

export async function batchClip(payload: BatchClipPayload): Promise<BatchClipResult> {
  const res = await readJson<ApiResult & BatchClipResult>(
    await apiFetch('/batch-clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
  if (!res.success) throw new Error(res.msg || '剪辑失败');
  return {
    output_files: res.output_files ?? [],
    failed_segments: res.failed_segments,
    skipped_segments: res.skipped_segments,
    invalid_segments: res.invalid_segments,
    total_requested: res.total_requested,
    encoder: res.encoder,
    msg: res.msg,
  };
}

export { streamVideoUrl };
