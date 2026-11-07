import { useCallback } from 'react';
import {
  Bookmark,
  ChevronRight,
  ChevronLeft,
  Clock3,
  Download,
  Scissors,
  Plus,
  Trash2,
  Wand2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ClipOutputFile, MarkPoint, TimeSegment } from '@/types';

const PANEL_MIN_W = 260;
const PANEL_MAX_W = 640;

interface MarkPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  panelWidth: number;
  onPanelWidthChange: (w: number) => void;
  marks: MarkPoint[];
  segments: TimeSegment[];
  batchPrefix: string;
  outputFiles: ClipOutputFile[];
  canClip: boolean;
  onUseMark: (markId: string) => void;
  onRemoveMark: (markId: string) => void;
  onAddSegment: () => void;
  /** 按当前打点列表重新生成全部剪辑时间段（会覆盖现有片段） */
  onGenerateSegmentsFromMarks: () => void;
  onRemoveSegment: (segmentId: string) => void;
  onSegmentChange: (
    segmentId: string,
    field: 'startTime' | 'endTime' | 'segmentName',
    value: string
  ) => void;
  onBatchPrefixChange: (value: string) => void;
  skipExistingClips: boolean;
  onSkipExistingClipsChange: (value: boolean) => void;
  onBatchClip: () => void;
  onEnqueueClip: () => void;
  onQueueClip: () => void;
  /** 生成下载链接（需与 api 基址一致） */
  downloadHrefFor: (filename: string) => string;
}

export function MarkPanel({
  isOpen,
  onToggle,
  panelWidth,
  onPanelWidthChange,
  marks,
  segments,
  batchPrefix,
  outputFiles,
  canClip,
  onUseMark,
  onRemoveMark,
  onAddSegment,
  onGenerateSegmentsFromMarks,
  onRemoveSegment,
  onSegmentChange,
  onBatchPrefixChange,
  skipExistingClips,
  onSkipExistingClipsChange,
  onBatchClip,
  onEnqueueClip,
  onQueueClip,
  downloadHrefFor,
}: MarkPanelProps) {
  const toInput = (value: number) =>
    String(Math.max(0, Number.isFinite(value) ? value : 0));

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = panelWidth;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        onPanelWidthChange(Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, startW + dx)));
      };
      const onUp = (ev: PointerEvent) => {
        target.releasePointerCapture(ev.pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [panelWidth, onPanelWidthChange]
  );

  return (
    <div
      className={cn(
        'relative flex flex-col shrink-0 bg-zinc-900 border-l border-zinc-800',
        !isOpen && 'w-12 transition-[width] duration-300 ease-in-out'
      )}
      style={
        isOpen
          ? {
              width: panelWidth,
              minWidth: PANEL_MIN_W,
              maxWidth: PANEL_MAX_W,
            }
          : undefined
      }
    >
      {isOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧面板宽度"
          className="absolute left-0 top-0 bottom-0 z-20 w-1 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60"
          onPointerDown={onResizePointerDown}
        />
      )}

      <div className="flex items-center justify-between h-14 px-3 border-b border-zinc-800 shrink-0">
        {!isOpen && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggle}
            className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
          >
            <ChevronLeft className="w-5 h-5" />
          </Button>
        )}
        {isOpen && (
          <>
            <div className="flex items-center gap-2 min-w-0 pl-1">
              <Bookmark className="w-5 h-5 text-amber-400 shrink-0" />
              <span className="font-semibold text-zinc-100 truncate">剪辑工具区</span>
              <Badge variant="secondary" className="ml-2 bg-zinc-800 text-zinc-300 shrink-0">
                {marks.length}
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggle}
              className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 shrink-0"
            >
              <ChevronRight className="w-5 h-5" />
            </Button>
          </>
        )}
      </div>

      {isOpen && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <div className="p-3 border-b border-zinc-800 text-xs text-zinc-400 shrink-0">
            快捷键：空格 播放/暂停，M 打点。奇数打点填开始，偶数打点填结束。
          </div>

          <ScrollArea className="flex-1 p-3 min-h-0">
            <div className="space-y-3">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-zinc-500">打点记录</span>
                  <Badge variant="secondary" className="bg-zinc-800 text-zinc-300">
                    {marks.length}
                  </Badge>
                </div>
                <div className="space-y-1.5">
                  {marks.length === 0 && (
                    <p className="py-2 text-center text-xs text-zinc-500">暂无打点，按 M 开始标记</p>
                  )}
                  {marks.map((mark, index) => (
                    <div
                      key={mark.id}
                      className="flex w-full items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/80 px-2 py-1.5 text-xs hover:border-blue-500/50"
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center justify-between text-left"
                        onClick={() => onUseMark(mark.id)}
                      >
                        <span className="text-zinc-400 shrink-0">#{index + 1}</span>
                        <span className="font-mono text-zinc-200 truncate">{mark.formattedTime}</span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-zinc-500 hover:text-red-400"
                        aria-label="删除此打点"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveMark(mark.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="mb-2 flex items-center justify-between gap-1">
                  <span className="text-xs uppercase tracking-wide text-zinc-500">剪辑时间段</span>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2 bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
                      onClick={onGenerateSegmentsFromMarks}
                      disabled={marks.length === 0}
                      title="按打点顺序两两成对：第1–2、3–4… 生成开始/结束时间"
                    >
                      <Wand2 className="mr-1 h-3.5 w-3.5" />
                      从打点生成
                    </Button>
                    <Button size="sm" className="h-7 px-2" onClick={onAddSegment}>
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      添加
                    </Button>
                  </div>
                </div>
                {marks.length > 0 && (
                  <p className="mb-2 text-[11px] leading-snug text-zinc-500">
                    共 {marks.length} 个打点 → 可生成 {Math.ceil(marks.length / 2)} 段
                    {marks.length % 2 === 1 ? '（末段结束时间用视频总长）' : ''}
                  </p>
                )}

                <div className="space-y-2">
                  {segments.map((segment, index) => (
                    <div
                      key={segment.id}
                      className="rounded-md border border-zinc-700 bg-zinc-800/70 p-2"
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs text-zinc-300">片段 {index + 1}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-zinc-500 hover:text-red-400"
                          onClick={() => onRemoveSegment(segment.id)}
                          disabled={segments.length <= 1}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          value={toInput(segment.startTime)}
                          onChange={(e) =>
                            onSegmentChange(segment.id, 'startTime', e.target.value)
                          }
                          placeholder="开始秒数"
                          className="h-8 bg-zinc-900 border-zinc-700 text-zinc-100"
                        />
                        <Input
                          value={toInput(segment.endTime)}
                          onChange={(e) =>
                            onSegmentChange(segment.id, 'endTime', e.target.value)
                          }
                          placeholder="结束秒数"
                          className="h-8 bg-zinc-900 border-zinc-700 text-zinc-100"
                        />
                      </div>
                      <Input
                        value={segment.segmentName}
                        onChange={(e) =>
                          onSegmentChange(segment.id, 'segmentName', e.target.value)
                        }
                        placeholder="单段自定义名称（可选）"
                        className="mt-2 h-8 bg-zinc-900 border-zinc-700 text-zinc-100"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </ScrollArea>

          <div className="space-y-2 border-t border-zinc-800 p-3 shrink-0">
            <Input
              value={batchPrefix}
              onChange={(e) => onBatchPrefixChange(e.target.value)}
              placeholder="批量文件名前缀（可选）"
              className="h-8 bg-zinc-800 border-zinc-700 text-zinc-100"
            />
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={skipExistingClips}
                onChange={(e) => onSkipExistingClipsChange(e.target.checked)}
              />
              跳过已生成片段（续剪缺失的）
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="secondary"
                className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
                onClick={onEnqueueClip}
                disabled={!canClip}
              >
                加入队列
              </Button>
              <Button type="button" onClick={onQueueClip} disabled={!canClip}>
                <Scissors className="mr-2 h-4 w-4" />
                队列剪辑
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="w-full text-zinc-400 hover:text-zinc-200"
              onClick={onBatchClip}
              disabled={!canClip}
            >
              立即剪辑（不经过队列）
            </Button>

            {outputFiles.length > 0 && (
              <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
                <div className="mb-2 flex items-center gap-1 text-xs text-zinc-300">
                  <Download className="h-3.5 w-3.5" />
                  已生成 {outputFiles.length} 个片段
                </div>
                <div className="max-h-36 space-y-1 overflow-auto">
                  {outputFiles.map((file) => (
                    <a
                      key={file.filename}
                      href={downloadHrefFor(file.filename)}
                      className="block truncate rounded px-2 py-1 text-xs text-blue-400 hover:bg-zinc-800"
                      download
                    >
                      {file.filename}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!isOpen && (
        <div className="flex-1 flex flex-col items-center py-4 gap-4">
          <Bookmark className="w-5 h-5 text-zinc-500" />
          <div className="w-6 h-px bg-zinc-800" />
          <Clock3 className="w-5 h-5 text-zinc-500" />
        </div>
      )}
    </div>
  );
}
