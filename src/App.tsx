import { useCallback, useEffect, useState } from 'react';
import { ListOrdered, Plus, Settings, Upload } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FilePanel } from '@/components/FilePanel';
import { ExportSettingsPanel } from '@/components/ExportSettingsPanel';
import { ClipQueuePanel } from '@/components/ClipQueuePanel';
import { MarkPanel } from '@/components/MarkPanel';
import { VideoPlayer } from '@/components/VideoPlayer';
import { useClipQueue } from '@/hooks/useClipQueue';
import {
  addBrowseFolder,
  batchClip,
  type BatchClipPayload,
  getAllowedRoots,
  getEditorConfig,
  getConfigBrowseFolders,
  getVideoMarks,
  listAllSavedVideos,
  listVideosInDirectory,
  loadExportSettingsFromStorage,
  persistExportSettingsToStorage,
  registerLocalVideo,
  removeBrowseFolder,
  saveExportSettings,
  saveVideoMarks,
  streamVideoUrl,
  uploadVideo,
  type ApiVideo,
} from '@/api/videoEditorClient';
import { downloadFileUrl } from '@/lib/api';
import {
  DEFAULT_EXPORT_SETTINGS,
  type ClipOutputFile,
  type ExportSettings,
  type FolderPath,
  type MarkPoint,
  type TimeSegment,
  type VideoFile,
} from '@/types';

/** 非 localhost 的 http://IP 不是安全上下文，浏览器不提供 crypto.randomUUID，首屏会白屏 */
function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      /* 部分环境仍可能抛错 */
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const makeSegment = (): TimeSegment => ({
  id: randomId(),
  startTime: 0,
  endTime: 0,
  segmentName: '',
});

/** 按时间排序后，相邻奇偶打点成对为片段（1–2、3–4…）；奇数个时最后一段拉到视频结尾 */
function segmentsFromMarks(marks: MarkPoint[], duration: number): TimeSegment[] {
  if (marks.length === 0) {
    return [{ id: randomId(), startTime: 0, endTime: duration > 0 ? duration : 0, segmentName: '' }];
  }
  const sorted = [...marks].sort((a, b) => a.timestamp - b.timestamp);
  const out: TimeSegment[] = [];
  for (let i = 0; i < sorted.length; i += 2) {
    const start = sorted[i]!.timestamp;
    const end =
      i + 1 < sorted.length ? sorted[i + 1]!.timestamp : duration > 0 ? duration : start;
    out.push({ id: randomId(), startTime: start, endTime: end, segmentName: '' });
  }
  return out;
}

const baseName = (path: string): string => {
  const items = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return items[items.length - 1] || path;
};

export default function App() {
  const [folders, setFolders] = useState<FolderPath[]>([]);
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<VideoFile | null>(null);
  const [marks, setMarks] = useState<MarkPoint[]>([]);
  const [segments, setSegments] = useState<TimeSegment[]>([makeSegment()]);
  const [batchPrefix, setBatchPrefix] = useState('');
  const [outputFiles, setOutputFiles] = useState<ClipOutputFile[]>([]);
  const [rootsHint, setRootsHint] = useState('允许根路径加载中...');
  const [seekToTime, setSeekToTime] = useState<number | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [leftOpen, setLeftOpen] = useState(true);
  /** 视频列表范围：全部已保存目录，或单个浏览目录 */
  const [videoListScope, setVideoListScope] = useState('all' as 'all' | string);
  const [leftPanelWidth, setLeftPanelWidth] = useState(288);
  const [rightOpen, setRightOpen] = useState(true);
  const [rightPanelWidth, setRightPanelWidth] = useState(320);
  const [saveToDownload, setSaveToDownload] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  /** 当前视频打点已从服务端加载，避免空状态覆盖磁盘缓存 */
  const [marksHydrated, setMarksHydrated] = useState(false);
  const [videoStorage, setVideoStorage] = useState<'uploads' | 'download' | 'local'>('uploads');
  const [filename, setFilename] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [originName, setOriginName] = useState('');
  const [ext, setExt] = useState('mp4');
  const [exportSettingsOpen, setExportSettingsOpen] = useState(false);
  const [exportSettings, setExportSettings] = useState<ExportSettings>(() => ({
    ...DEFAULT_EXPORT_SETTINGS,
    ...loadExportSettingsFromStorage(),
  }));
  const [gpuAvailable, setGpuAvailable] = useState(false);
  const [skipExistingClips, setSkipExistingClips] = useState(true);

  const clipQueue = useClipQueue();

  const toVideo = useCallback((item: ApiVideo): VideoFile => {
    const videoExt = item.name.includes('.') ? item.name.split('.').pop() || '' : '';
    const videoName = item.name.includes('.') ? item.name.slice(0, item.name.lastIndexOf('.')) : item.name;
    const folderPath = item.folder?.trim() || undefined;
    return {
      id: item.path,
      name: item.name,
      sourcePath: item.path,
      path: streamVideoUrl(item.path),
      size: item.size,
      originName: videoName,
      ext: videoExt,
      folderPath,
      folderLabel: item.folder_label?.trim() || (folderPath ? baseName(folderPath) : undefined),
    };
  }, []);

  const applyCurrentVideo = useCallback(
    (
      video: VideoFile,
      duration: number,
      source: { storage: 'uploads' | 'download' | 'local'; filename?: string; localPath?: string }
    ) => {
      setSelectedVideo(video);
      setVideoDuration(duration);
      setMarksHydrated(false);
      setMarks([]);
      setSegments([{ ...makeSegment(), endTime: duration }]);
      setOutputFiles([]);
      setSeekToTime(null);
      setVideoStorage(source.storage);
      setFilename(source.filename || '');
      setLocalPath(source.localPath || '');
      setOriginName(video.originName || '');
      setExt(video.ext || 'mp4');
    },
    []
  );

  const refreshRoots = useCallback(async () => {
    try {
      const roots = await getAllowedRoots();
      setRootsHint(roots.length ? `允许访问根：${roots.join(' | ')}` : '当前没有可用根路径');
    } catch {
      setRootsHint('当前没有可用根路径');
    }
  }, []);

  const loadVideosForScope = useCallback(
    async (scope: 'all' | string) => {
      if (scope === 'all') {
        const list = await listAllSavedVideos();
        setVideos(list.map(toVideo));
        return;
      }
      const list = await listVideosInDirectory(scope);
      const label = baseName(scope);
      setVideos(
        list.map((item) => ({
          ...toVideo(item),
          folderPath: scope,
          folderLabel: label,
        }))
      );
    },
    [toVideo]
  );

  const refreshFoldersAndVideos = useCallback(async () => {
    const browseFolders = await getConfigBrowseFolders();
    setFolders(browseFolders.map((path) => ({ id: path, path, name: baseName(path) })));
    await loadVideosForScope(videoListScope);
  }, [videoListScope, loadVideosForScope]);

  useEffect(() => {
    void refreshRoots();
  }, [refreshRoots]);

  useEffect(() => {
    void getEditorConfig()
      .then(({ export_settings, gpu_available }) => {
        setExportSettings(export_settings);
        setGpuAvailable(gpu_available);
        persistExportSettingsToStorage(export_settings);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshFoldersAndVideos().catch((e) => toast.error(e instanceof Error ? e.message : '初始化失败'));
  }, [refreshFoldersAndVideos]);

  useEffect(() => {
    if (!selectedVideo) {
      setMarksHydrated(false);
      return;
    }
    setMarksHydrated(false);
    let cancelled = false;
    const sp = selectedVideo.sourcePath;
    const durHint = selectedVideo.duration ?? 0;
    void (async () => {
      try {
        const { marks: loadedMarks, segments: loadedSegs } = await getVideoMarks(sp);
        if (cancelled) return;
        setMarks(loadedMarks);
        if (loadedSegs && loadedSegs.length > 0) {
          setSegments(loadedSegs);
        } else {
          setSegments(segmentsFromMarks(loadedMarks, durHint));
        }
      } catch {
        if (!cancelled) {
          setMarks([]);
          setSegments([{ ...makeSegment(), endTime: durHint > 0 ? durHint : 0 }]);
        }
      } finally {
        if (!cancelled) setMarksHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedVideo?.sourcePath]);

  useEffect(() => {
    if (!marksHydrated) return;
    const path = selectedVideo?.sourcePath;
    if (!path) return;
    const t = window.setTimeout(() => {
      void saveVideoMarks(path, marks, segments).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(t);
  }, [marks, segments, selectedVideo?.sourcePath, marksHydrated]);

  const addFolder = async (path: string) => {
    await addBrowseFolder(path);
    await refreshFoldersAndVideos();
    await refreshRoots();
  };

  const removeFolder = async (path: string) => {
    await removeBrowseFolder(path);
    const nextScope = videoListScope === path ? 'all' : videoListScope;
    if (nextScope !== videoListScope) setVideoListScope('all');
    const browseFolders = await getConfigBrowseFolders();
    setFolders(browseFolders.map((p) => ({ id: p, path: p, name: baseName(p) })));
    try {
      await loadVideosForScope(nextScope);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '刷新列表失败');
    }
    await refreshRoots();
  };

  const openByPath = async (path: string) => {
    const res = await registerLocalVideo(path);
    const video: VideoFile = {
      id: res.local_path,
      name: `${res.origin_name}.${res.ext}`,
      sourcePath: res.local_path,
      path: streamVideoUrl(res.local_path),
      size: 0,
      originName: res.origin_name,
      ext: res.ext,
      duration: res.duration,
    };
    applyCurrentVideo(video, res.duration, { storage: 'local', localPath: res.local_path });
  };

  const uploadFile = async (file: File | null) => {
    if (!file) return;
    const res = await uploadVideo(file, saveToDownload ? 'download' : 'upload');
    const sourcePath = `${res.video_storage === 'download' ? 'download' : 'uploads'}/${res.filename}`;
    const video: VideoFile = {
      id: sourcePath,
      name: `${res.origin_name}.${res.ext}`,
      sourcePath,
      path: streamVideoUrl(sourcePath),
      size: file.size,
      originName: res.origin_name,
      ext: res.ext,
      duration: res.duration,
    };
    applyCurrentVideo(video, res.duration, { storage: res.video_storage, filename: res.filename });
  };

  const buildClipPayload = useCallback((): BatchClipPayload | null => {
    if (!selectedVideo) return null;
    const valid = segments
      .map((s) => ({
        start_time: Math.max(0, s.startTime),
        end_time: Math.min(videoDuration || Number.MAX_SAFE_INTEGER, s.endTime),
        segment_name: s.segmentName.trim(),
      }))
      .filter((s) => s.end_time > s.start_time);
    if (!valid.length) return null;
    return {
      origin_name: originName,
      ext,
      time_segments: valid,
      batch_prefix: batchPrefix.trim(),
      video_storage: videoStorage,
      export_settings: exportSettings,
      skip_existing: skipExistingClips,
      ...(videoStorage === 'local' ? { local_path: localPath } : { filename }),
    };
  }, [
    selectedVideo,
    segments,
    videoDuration,
    originName,
    ext,
    batchPrefix,
    videoStorage,
    exportSettings,
    skipExistingClips,
    localPath,
    filename,
  ]);

  const syncOutputFromJob = useCallback(
    (videoLabel: string) => {
      const job = clipQueue.jobs.find(
        (j) =>
          j.videoLabel === videoLabel &&
          (j.status === 'completed' || j.status === 'partial')
      );
      if (!job) return;
      const files = job.segments
        .filter((s) => (s.status === 'done' || s.status === 'skipped') && s.filename)
        .map((s) => ({
          filename: s.filename!,
          start_time: s.start_time,
          end_time: s.end_time,
          start_hms: '',
          end_hms: '',
          skipped: s.status === 'skipped',
        }));
      if (files.length) setOutputFiles(files);
    },
    [clipQueue.jobs]
  );

  useEffect(() => {
    if (selectedVideo?.name) syncOutputFromJob(selectedVideo.name);
  }, [clipQueue.jobs, selectedVideo?.name, syncOutputFromJob]);

  const clip = async () => {
    const payload = buildClipPayload();
    if (!payload) throw new Error('无有效时间段');
    const result = await batchClip(payload);
    setOutputFiles(result.output_files);
    return result;
  };

  const enqueueClip = () => {
    const payload = buildClipPayload();
    if (!payload || !selectedVideo) {
      toast.error('无有效时间段');
      return;
    }
    clipQueue.enqueue({
      videoLabel: selectedVideo.name,
      payload,
      skipExisting: skipExistingClips,
    });
    toast.success('已加入任务队列，点击底部面板「开始」执行');
  };

  const queueClip = () => {
    const payload = buildClipPayload();
    if (!payload || !selectedVideo) {
      toast.error('无有效时间段');
      return;
    }
    clipQueue.enqueueAndStart({
      videoLabel: selectedVideo.name,
      payload,
      skipExisting: skipExistingClips,
    });
    toast.success('已开始队列剪辑，可在底部查看进度');
  };

  const handleSaveExportSettings = async (next: ExportSettings) => {
    const { export_settings, gpu_available } = await saveExportSettings(next);
    setExportSettings(export_settings);
    setGpuAvailable(gpu_available);
    persistExportSettingsToStorage(export_settings);
    toast.success('编码设置已保存');
  };

  const encoderBadge =
    exportSettings.encoder === 'gpu'
      ? 'GPU'
      : exportSettings.encoder === 'cpu'
        ? 'CPU'
        : '自动';

  return (
    <div className="h-screen w-screen flex flex-col bg-zinc-950 overflow-hidden">
      <Toaster position="top-center" theme="dark" />
      <header className="h-14 border-b border-zinc-800 bg-zinc-900/95 px-4 flex items-center justify-between">
        <div className="text-sm font-semibold text-zinc-100">视频剪辑工作台 · Kimi UI</div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-400 flex items-center gap-1">
            <input type="checkbox" checked={saveToDownload} onChange={(e) => setSaveToDownload(e.target.checked)} />
            来自网络存入 download
          </label>
          <input
            id="file-input"
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) =>
              void uploadFile(e.target.files?.[0] || null).catch((err) =>
                toast.error(err instanceof Error ? err.message : '上传失败')
              )
            }
          />
          <Button
            variant="secondary"
            className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
            onClick={() => document.getElementById('file-input')?.click()}
          >
            <Plus className="mr-1 h-4 w-4" />
            添加
          </Button>
          <Button onClick={() => document.getElementById('file-input')?.click()}>
            <Upload className="mr-1 h-4 w-4" />
            上传视频
          </Button>
          <Button
            variant="secondary"
            className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
            onClick={() => setExportSettingsOpen(true)}
          >
            <Settings className="mr-1 h-4 w-4" />
            编码 {encoderBadge}
          </Button>
          <Button
            variant="secondary"
            className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
            onClick={() => clipQueue.setPanelOpen((v) => !v)}
          >
            <ListOrdered className="mr-1 h-4 w-4" />
            上传视频
            {clipQueue.jobs.length > 0 && (
              <span className="ml-1 text-emerald-400">({clipQueue.jobs.length})</span>
            )}
          </Button>
        </div>
      </header>

      <ExportSettingsPanel
        open={exportSettingsOpen}
        onOpenChange={setExportSettingsOpen}
        settings={exportSettings}
        gpuAvailable={gpuAvailable}
        onSave={handleSaveExportSettings}
      />

      <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 w-full flex-1 overflow-hidden">
        <FilePanel
          isOpen={leftOpen}
          onToggle={() => setLeftOpen((v) => !v)}
          panelWidth={leftPanelWidth}
          onPanelWidthChange={setLeftPanelWidth}
          videoListScope={videoListScope}
          onVideoListScopeChange={setVideoListScope}
          folders={folders}
          videos={videos}
          selectedVideo={selectedVideo}
          onAddFolder={(path) =>
            void addFolder(path)
              .then(() => toast.success('目录已保存'))
              .catch((e) => toast.error(e instanceof Error ? e.message : '添加失败'))
          }
          onRemoveFolder={(path) =>
            void removeFolder(path)
              .then(() => toast.success('目录已移除'))
              .catch((e) => toast.error(e instanceof Error ? e.message : '移除失败'))
          }
          onSelectVideo={(video) =>
            void openByPath(video.sourcePath)
              .then(() => toast.success('已加载视频'))
              .catch((e) => toast.error(e instanceof Error ? e.message : '加载失败'))
          }
          onRefreshAll={() =>
            void refreshFoldersAndVideos().catch((e) => toast.error(e instanceof Error ? e.message : '刷新失败'))
          }
          onOpenByPath={(path) =>
            void openByPath(path)
              .then(() => toast.success('已加载视频'))
              .catch((e) => toast.error(e instanceof Error ? e.message : '加载失败'))
          }
          rootsHint={rootsHint}
        />
        <VideoPlayer
          video={selectedVideo}
          marks={marks}
          seekToTime={seekToTime}
          onTimeUpdate={() => undefined}
          onDurationChange={setVideoDuration}
          onAddMark={(timestamp, formattedTime) => {
            if (!selectedVideo) return;
            const newMark: MarkPoint = {
              id: randomId(),
              videoId: selectedVideo.sourcePath,
              videoName: selectedVideo.name,
              timestamp,
              formattedTime,
              label: `标记 ${marks.length + 1}`,
              createdAt: Date.now(),
            };
            setMarks((prev) => [...prev, newMark]);
            setSegments((prev) => {
              const next = [...prev];
              const idx = Math.floor(marks.length / 2);
              while (idx >= next.length) next.push(makeSegment());
              if (marks.length % 2 === 0) next[idx] = { ...next[idx], startTime: timestamp };
              else next[idx] = { ...next[idx], endTime: timestamp };
              return next;
            });
          }}
          onSeekHandled={() => setSeekToTime(null)}
        />
        <MarkPanel
          isOpen={rightOpen}
          onToggle={() => setRightOpen((v) => !v)}
          panelWidth={rightPanelWidth}
          onPanelWidthChange={setRightPanelWidth}
          marks={marks}
          segments={segments}
          batchPrefix={batchPrefix}
          outputFiles={outputFiles}
          canClip={!!selectedVideo && !isSubmitting && !clipQueue.processing}
          downloadHrefFor={downloadFileUrl}
          onUseMark={(markId) => {
            const index = marks.findIndex((m) => m.id === markId);
            if (index < 0) return;
            const mark = marks[index];
            setSeekToTime(mark.timestamp);
            setSegments((prev) => {
              const next = [...prev];
              const idx = Math.floor(index / 2);
              while (idx >= next.length) next.push(makeSegment());
              if (index % 2 === 0) next[idx] = { ...next[idx], startTime: mark.timestamp };
              else next[idx] = { ...next[idx], endTime: mark.timestamp };
              return next;
            });
          }}
          onRemoveMark={(markId) => {
            setMarks((prev) => prev.filter((m) => m.id !== markId));
          }}
          onAddSegment={() => setSegments((prev) => [...prev, makeSegment()])}
          onGenerateSegmentsFromMarks={() => {
            if (marks.length === 0) {
              toast.error('无有效时间段');
              return;
            }
            const next = segmentsFromMarks(marks, videoDuration);
            setSegments(next);
            toast.success(`已根据 ${marks.length} 个打点生成 ${next.length} 个剪辑时间段`);
          }}
          onRemoveSegment={(segmentId) =>
            setSegments((prev) => (prev.length <= 1 ? prev : prev.filter((s) => s.id !== segmentId)))
          }
          onSegmentChange={(segmentId, field, value) =>
            setSegments((prev) =>
              prev.map((s) => {
                if (s.id !== segmentId) return s;
                if (field === 'segmentName') return { ...s, segmentName: value };
                const num = Number.parseFloat(value);
                return { ...s, [field]: Number.isFinite(num) ? num : 0 };
              })
            )
          }
          onBatchPrefixChange={setBatchPrefix}
          skipExistingClips={skipExistingClips}
          onSkipExistingClipsChange={setSkipExistingClips}
          onEnqueueClip={enqueueClip}
          onQueueClip={queueClip}
          onBatchClip={() => {
            setIsSubmitting(true);
            void clip()
              .then((result) => {
                if (!result) return;
                const failed = result.failed_segments?.length ?? 0;
                if (failed > 0) {
                  const nums = result.failed_segments!.map((f) => f.index + 1).join('、');
                  toast.warning(`${result.msg || '部分完成'}，失败片段：${nums}）`, {
                    duration: 8000,
                  });
                } else {
                  toast.success(result.msg || '批量剪辑完成');
                }
              })
              .catch((e) => toast.error(e instanceof Error ? e.message : '剪辑失败'))
              .finally(() => setIsSubmitting(false));
          }}
        />
        </div>
        <ClipQueuePanel
        open={clipQueue.panelOpen}
        onToggle={() => clipQueue.setPanelOpen((v) => !v)}
        jobs={clipQueue.jobs}
        processing={clipQueue.processing}
        paused={clipQueue.paused}
        onStart={clipQueue.start}
        onPause={clipQueue.pause}
        onRetryJob={(id) => {
          clipQueue.retryJob(id);
          toast.info('正在重试失败片段');
        }}
        onRemoveJob={clipQueue.removeJob}
        onClearFinished={clipQueue.clearFinished}
        onCancelJob={clipQueue.cancelJob}
      />
      </div>
    </div>
  );
}
