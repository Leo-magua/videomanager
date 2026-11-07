import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  ListOrdered,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { ClipJob, ClipSegmentTaskStatus } from '@/types';
import { downloadFileUrl } from '@/lib/api';

const STATUS_LABEL: Record<string, string> = {
  pending: '等待',
  running: '剪辑中',
  completed: '完成',
  partial: '部分失败',
  failed: '失败',
  cancelled: '已取消',
};

const SEG_STATUS: Record<ClipSegmentTaskStatus, string> = {
  pending: '待处理',
  running: '进行中',
  done: '完成',
  skipped: '已跳过',
  failed: '失败',
  invalid: '无效',
  cancelled: '取消',
};

function formatSec(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

interface ClipQueuePanelProps {
  open: boolean;
  onToggle: () => void;
  jobs: ClipJob[];
  processing: boolean;
  paused: boolean;
  onStart: () => void;
  onPause: () => void;
  onRetryJob: (jobId: string) => void;
  onRemoveJob: (jobId: string) => void;
  onClearFinished: () => void;
  onCancelJob: (jobId: string) => void;
}

export function ClipQueuePanel({
  open,
  onToggle,
  jobs,
  processing,
  paused,
  onStart,
  onPause,
  onRetryJob,
  onRemoveJob,
  onClearFinished,
  onCancelJob,
}: ClipQueuePanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const running = jobs.filter((j) => j.status === 'running').length;
  const waiting = jobs.filter((j) => j.status === 'pending' || j.status === 'partial').length;

  return (
    <div
      className={cn(
        'shrink-0 flex flex-col border-t border-zinc-800 bg-zinc-900/95 transition-[height] duration-200',
        open ? 'h-[min(42vh,360px)]' : 'h-10'
      )}
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-medium text-zinc-200 hover:text-white"
          onClick={onToggle}
        >
          <ListOrdered className="h-4 w-4" />
          剪辑任务队列
          {jobs.length > 0 && (
            <Badge variant="secondary" className="bg-zinc-800 text-zinc-300">
              {jobs.length}
            </Badge>
          )}
          {processing && !paused && <span className="text-xs text-emerald-400">处理中…</span>}
          {paused && processing && <span className="text-xs text-amber-400">已暂停</span>}
          {!processing && waiting > 0 && (
            <span className="text-xs text-zinc-500">{waiting} 个待执行</span>
          )}
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>
        {open && (
          <div className="flex items-center gap-1">
            {paused || !processing ? (
              <Button
                size="sm"
                variant="secondary"
                className="h-7 bg-zinc-800 px-2"
                onClick={onStart}
                disabled={waiting === 0 && running === 0}
              >
                <Play className="mr-1 h-3 w-3" />
                开始
              </Button>
            ) : (
              <Button size="sm" variant="secondary" className="h-7 bg-zinc-800 px-2" onClick={onPause}>
                <Pause className="mr-1 h-3 w-3" />
                暂停
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 px-2 text-zinc-400" onClick={onClearFinished}>
              清空已完成
            </Button>
          </div>
        )}
      </div>

      {open && (
        <ScrollArea className="flex-1 px-3 pb-3">
          {jobs.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-500">
              暂无任务。在右侧点击「加入队列」或「队列剪辑」添加。
            </p>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => {
                const done = job.segments.filter(
                  (s) => s.status === 'done' || s.status === 'skipped'
                ).length;
                const total = job.segments.length;
                const expanded = expandedId === job.id;
                const canRetry = job.segments.some(
                  (s) => s.status === 'failed' || s.status === 'invalid'
                );

                return (
                  <div
                    key={job.id}
                    className="rounded-lg border border-zinc-800 bg-zinc-950/80 p-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setExpandedId(expanded ? null : job.id)}
                      >
                        <div className="truncate text-sm font-medium text-zinc-100">{job.videoLabel}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                          <span>{STATUS_LABEL[job.status] ?? job.status}</span>
                          <span>
                            {done}/{total} 段
                          </span>
                          {job.message && <span className="text-zinc-400">{job.message}</span>}
                        </div>
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all',
                              job.status === 'failed'
                                ? 'bg-red-500'
                                : job.status === 'partial'
                                  ? 'bg-amber-500'
                                  : 'bg-emerald-500'
                            )}
                            style={{ width: `${total ? (done / total) * 100 : 0}%` }}
                          />
                        </div>
                      </button>
                      <div className="flex shrink-0 gap-0.5">
                        {canRetry && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-zinc-400"
                            title="重试失败片段"
                            onClick={() => onRetryJob(job.id)}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {(job.status === 'pending' || job.status === 'running') && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-zinc-400"
                            title="取消任务"
                            onClick={() => onCancelJob(job.id)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-zinc-500 hover:text-red-400"
                          title="移除"
                          onClick={() => onRemoveJob(job.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    {expanded && (
                      <div className="mt-2 max-h-40 space-y-1 overflow-auto border-t border-zinc-800 pt-2">
                        {job.segments.map((seg) => (
                          <div
                            key={seg.index}
                            className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-xs"
                          >
                            <span className="text-zinc-400">
                              片段 {seg.index + 1}{' '}
                              <span className="text-zinc-500">
                                {formatSec(seg.start_time)} – {formatSec(seg.end_time)}
                              </span>
                            </span>
                            <span className="flex shrink-0 items-center gap-2">
                              <span
                                className={cn(
                                  seg.status === 'done' && 'text-emerald-400',
                                  seg.status === 'skipped' && 'text-zinc-400',
                                  seg.status === 'failed' && 'text-red-400',
                                  seg.status === 'running' && 'text-blue-400',
                                  seg.status === 'pending' && 'text-zinc-500'
                                )}
                              >
                                {SEG_STATUS[seg.status]}
                              </span>
                              {seg.filename &&
                                (seg.status === 'done' || seg.status === 'skipped') && (
                                  <a
                                    href={downloadFileUrl(seg.filename)}
                                    className="text-blue-400 hover:underline"
                                    download
                                  >
                                    下载
                                  </a>
                                )}
                            </span>
                          </div>
                        ))}
                        {job.segments.some((s) => s.error) && (
                          <p className="text-[11px] text-red-400/90">
                            {job.segments
                              .filter((s) => s.error)
                              .map((s) => `片段${s.index + 1}: ${s.error}`)
                              .join('；')}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      )}
    </div>
  );
}
