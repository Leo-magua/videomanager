// 视频文件类型
export interface VideoFile {
  id: string;
  name: string;
  path: string;
  sourcePath: string;
  size: number;
  duration?: number;
  originName?: string;
  ext?: string;
  thumbnail?: string;
  /** 所属素材目录（用于树形分组） */
  folderPath?: string;
  folderLabel?: string;
}

// 标记点类型
export interface MarkPoint {
  id: string;
  videoId: string;
  videoName: string;
  timestamp: number;
  formattedTime: string;
  label: string;
  createdAt: number;
}

// 文件夹路径类型
export interface FolderPath {
  id: string;
  path: string;
  name: string;
}

export interface TimeSegment {
  id: string;
  startTime: number;
  endTime: number;
  segmentName: string;
}

export interface ClipOutputFile {
  filename: string;
  start_time: number;
  end_time: number;
  start_hms: string;
  end_hms: string;
  skipped?: boolean;
}

export interface FailedClipSegment {
  index: number;
  start_time?: number;
  end_time?: number;
  segment_name?: string;
  error?: string;
  reason?: string;
}

/** 剪辑导出编码器：gpu=NVENC，cpu=libx264，auto=跟随环境变量 */
export type ExportEncoder = 'auto' | 'gpu' | 'cpu';

export interface ExportSettings {
  encoder: ExportEncoder;
  nvenc_cq: number;
  ffmpeg_threads: number;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  encoder: 'gpu',
  nvenc_cq: 19,
  ffmpeg_threads: 2,
};

/** 队列中单片段状态 */
export type ClipSegmentTaskStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'invalid'
  | 'cancelled';

export interface ClipSegmentTask {
  index: number;
  start_time: number;
  end_time: number;
  segment_name: string;
  status: ClipSegmentTaskStatus;
  filename?: string;
  error?: string;
}

/** 队列任务状态 */
export type ClipJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface ClipJob {
  id: string;
  videoLabel: string;
  createdAt: number;
  status: ClipJobStatus;
  skipExisting: boolean;
  payload: {
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
    skip_existing?: boolean;
  };
  segments: ClipSegmentTask[];
  message?: string;
}

// 播放器状态
export interface PlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  playbackRate: number;
}
