import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const D = 'div';

const clipQueue = `import { useState } from 'react';
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
  pending: '\u7b49\u5f85',
  running: '\u526a\u8f91\u4e2d',
  completed: '\u5b8c\u6210',
  partial: '\u90e8\u5206\u5931\u8d25',
  failed: '\u5931\u8d25',
  cancelled: '\u5df2\u53d6\u6d88',
};

const SEG_STATUS: Record<ClipSegmentTaskStatus, string> = {
  pending: '\u5f85\u5904\u7406',
  running: '\u8fdb\u884c\u4e2d',
  done: '\u5b8c\u6210',
  skipped: '\u5df2\u8df3\u8fc7',
  failed: '\u5931\u8d25',
  invalid: '\u65e0\u6548',
  cancelled: '\u53d6\u6d88',
};

function formatSec(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (h > 0) return \`\${h}:\${String(m).padStart(2, '0')}:\${String(sec).padStart(2, '0')}\`;
  return \`\${m}:\${String(sec).padStart(2, '0')}\`;
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
    <${D}
      className={cn(
        'shrink-0 flex flex-col border-t border-zinc-800 bg-zinc-900/95 transition-[height] duration-200',
        open ? 'h-[min(42vh,360px)]' : 'h-10'
      )}
    >
      <${D} className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-medium text-zinc-200 hover:text-white"
          onClick={onToggle}
        >
          <ListOrdered className="h-4 w-4" />
          \u526a\u8f91\u4efb\u52a1\u961f\u5217
          {jobs.length > 0 && (
            <Badge variant="secondary" className="bg-zinc-800 text-zinc-300">
              {jobs.length}
            </Badge>
          )}
          {processing && !paused && <span className="text-xs text-emerald-400">\u5904\u7406\u4e2d\u2026</span>}
          {paused && processing && <span className="text-xs text-amber-400">\u5df2\u6682\u505c</span>}
          {!processing && waiting > 0 && (
            <span className="text-xs text-zinc-500">{waiting} \u4e2a\u5f85\u6267\u884c</span>
          )}
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>
        {open && (
          <${D} className="flex items-center gap-1">
            {paused || !processing ? (
              <Button
                size="sm"
                variant="secondary"
                className="h-7 bg-zinc-800 px-2"
                onClick={onStart}
                disabled={waiting === 0 && running === 0}
              >
                <Play className="mr-1 h-3 w-3" />
                \u5f00\u59cb
              </Button>
            ) : (
              <Button size="sm" variant="secondary" className="h-7 bg-zinc-800 px-2" onClick={onPause}>
                <Pause className="mr-1 h-3 w-3" />
                \u6682\u505c
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 px-2 text-zinc-400" onClick={onClearFinished}>
              \u6e05\u7a7a\u5df2\u5b8c\u6210
            </Button>
          </${D}>
        )}
      </${D}>

      {open && (
        <ScrollArea className="flex-1 px-3 pb-3">
          {jobs.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-500">
              \u6682\u65e0\u4efb\u52a1\u3002\u5728\u53f3\u4fa7\u70b9\u51fb\u300c\u52a0\u5165\u961f\u5217\u300d\u6216\u300c\u961f\u5217\u526a\u8f91\u300d\u6dfb\u52a0\u3002
            </p>
          ) : (
            <${D} className="space-y-2">
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
                  <${D}
                    key={job.id}
                    className="rounded-lg border border-zinc-800 bg-zinc-950/80 p-2"
                  >
                    <${D} className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setExpandedId(expanded ? null : job.id)}
                      >
                        <${D} className="truncate text-sm font-medium text-zinc-100">{job.videoLabel}</${D}>
                        <${D} className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                          <span>{STATUS_LABEL[job.status] ?? job.status}</span>
                          <span>
                            {done}/{total} \u6bb5
                          </span>
                          {job.message && <span className="text-zinc-400">{job.message}</span>}
                        </${D}>
                        <${D} className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                          <${D}
                            className={cn(
                              'h-full rounded-full transition-all',
                              job.status === 'failed'
                                ? 'bg-red-500'
                                : job.status === 'partial'
                                  ? 'bg-amber-500'
                                  : 'bg-emerald-500'
                            )}
                            style={{ width: \`\${total ? (done / total) * 100 : 0}%\` }}
                          />
                        </${D}>
                      </button>
                      <${D} className="flex shrink-0 gap-0.5">
                        {canRetry && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-zinc-400"
                            title="\u91cd\u8bd5\u5931\u8d25\u7247\u6bb5"
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
                            title="\u53d6\u6d88\u4efb\u52a1"
                            onClick={() => onCancelJob(job.id)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-zinc-500 hover:text-red-400"
                          title="\u79fb\u9664"
                          onClick={() => onRemoveJob(job.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </${D}>
                    </${D}>

                    {expanded && (
                      <${D} className="mt-2 max-h-40 space-y-1 overflow-auto border-t border-zinc-800 pt-2">
                        {job.segments.map((seg) => (
                          <${D}
                            key={seg.index}
                            className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-xs"
                          >
                            <span className="text-zinc-400">
                              \u7247\u6bb5 {seg.index + 1}{' '}
                              <span className="text-zinc-500">
                                {formatSec(seg.start_time)} \u2013 {formatSec(seg.end_time)}
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
                                    \u4e0b\u8f7d
                                  </a>
                                )}
                            </span>
                          </${D}>
                        ))}
                        {job.segments.some((s) => s.error) && (
                          <p className="text-[11px] text-red-400/90">
                            {job.segments
                              .filter((s) => s.error)
                              .map((s) => \`\u7247\u6bb5\${s.index + 1}: \${s.error}\`)
                              .join('\uFF1B')}
                          </p>
                        )}
                      </${D}>
                    )}
                  </${D}>
                );
              })}
            </${D}>
          )}
        </ScrollArea>
      )}
    </${D}>
  );
}
`;

fs.writeFileSync(path.join(root, 'src/components/ClipQueuePanel.tsx'), clipQueue, 'utf8');
console.log('wrote ClipQueuePanel.tsx');

const appPath = path.join(root, 'src/App.tsx');
let app = fs.readFileSync(appPath, 'utf8');

const rep = (from, to) => {
  if (app.includes(from)) app = app.split(from).join(to);
};

rep("'????????...'", "'允许根路径加载中...'");
rep('`????????${roots.join', '`允许访问根：${roots.join');
rep("'?????????'", "'当前没有可用根路径'");
rep("'?????'", "'初始化失败'");
rep("'??????'", "'刷新列表失败'");
rep("'??????'", "'无有效时间段'");
rep("'????????????????????'", "'已加入任务队列，点击底部面板「开始」执行'");
rep("'????????????????'", "'已开始队列剪辑，可在底部查看进度'");
rep("'???????'", "'编码设置已保存'");
rep("'??'", "'自动'");
rep('??????? ? Kimi UI', '视频剪辑工作台 · Kimi UI');
rep('?????? download', '来自网络存入 download');
rep("'????'", "'上传失败'");
rep('            ??\n', '            添加\n');
rep('            ????\n', '            上传视频\n');
rep('?? {encoderBadge}', '编码 {encoderBadge}');
rep('            ????\n            {clipQueue', '            任务队列\n            {clipQueue');
rep("'?????'", "'目录已保存'");
rep("'????'", "'添加失败'");
rep("'?????'", "'已加载视频'");
rep("'????'", "'加载失败'");
rep("'????'", "'刷新失败'");
rep('`?? ${marks.length', '`标记 ${marks.length');
rep("'??????'", "'请先添加打点'");
rep('`??? ${marks.length} ????? ${next.length} ??????`', '`已根据 ${marks.length} 个打点生成 ${next.length} 个剪辑时间段`');
rep("'????'", "'部分完成'");
rep("'??????'", "'批量剪辑完成'");
rep("'????'", "'剪辑失败'");
rep("'????????'", "'正在重试失败片段'");
rep(".join('?')", ".join('、')");
rep('??????${nums}?`', '失败片段：${nums}）`');

app = app.replace(
  /\/\*\* \? localhost[\s\S]*?\*\//,
  '/** 非 localhost 的 http://IP 不是安全上下文，浏览器不提供 crypto.randomUUID，首屏会白屏 */'
);
app = app.replace('/* ????????? */', '/* 部分环境仍可能抛错 */');
app = app.replace(
  /\/\*\* \?{5,}1\?2[\s\S]*?\*\//,
  '/** 按时间排序后，相邻奇偶打点成对为片段（1–2、3–4…）；奇数个时最后一段拉到视频结尾 */'
);
app = app.replace(
  /\/\*\* \?{5,}[\s\S]*?\/\/\s*\*\//,
  '/** 视频列表范围：合并全部已保存目录，或单个目录 */'
);
app = app.replace(
  /\/\*\* \?{5,}[\s\S]*?marksHydrated/,
  '/** 当前视频的打点已从服务端加载完毕，避免用空状态覆盖磁盘缓存 */\n  const [marksHydrated'
);

const bad = 'motion' + 'less-overlay';
app = app.split(bad).join(D);

fs.writeFileSync(appPath, app, 'utf8');
console.log('patched App.tsx');
