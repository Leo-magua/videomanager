import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Folder,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  FileVideo,
  Plus,
  Trash2,
  RefreshCw,
  FolderOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { VideoFile, FolderPath } from '@/types';

const PANEL_MIN_W = 220;
const PANEL_MAX_W = 560;

function pathBaseName(path: string): string {
  const items = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return items[items.length - 1] || path;
}

function parentDirOfFile(p: string): string {
  const s = p.replace(/[/\\]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i <= 0 ? '' : s.slice(0, i);
}

interface VideoGroup {
  key: string;
  label: string;
  items: VideoFile[];
}

function buildVideoGroups(
  videos: VideoFile[],
  scope: 'all' | string,
  folderConfig: FolderPath[]
): VideoGroup[] {
  const labelForConfiguredPath = (path: string) =>
    folderConfig.find((f) => f.path === path)?.name ?? pathBaseName(path);

  const sortNames = (a: VideoFile, b: VideoFile) => a.name.localeCompare(b.name, 'zh-CN');

  if (scope !== 'all') {
    return [
      {
        key: scope,
        label: labelForConfiguredPath(scope),
        items: [...videos].sort(sortNames),
      },
    ];
  }

  const m = new Map<string, VideoFile[]>();
  for (const v of videos) {
    const dir =
      (v.folderPath && v.folderPath.length > 0 ? v.folderPath : '') ||
      parentDirOfFile(v.sourcePath) ||
      '__ungrouped__';
    if (!m.has(dir)) m.set(dir, []);
    m.get(dir)!.push(v);
  }

  const out: VideoGroup[] = [];
  for (const [key, items] of m) {
    items.sort(sortNames);
    const label =
      key === '__ungrouped__'
        ? '未分组'
        : items[0]?.folderLabel ?? labelForConfiguredPath(key);
    out.push({ key, label, items });
  }
  out.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  return out;
}

interface FilePanelProps {
  isOpen: boolean;
  onToggle: () => void;
  panelWidth: number;
  onPanelWidthChange: (w: number) => void;
  videoListScope: 'all' | string;
  onVideoListScopeChange: (scope: 'all' | string) => void;
  folders: FolderPath[];
  videos: VideoFile[];
  selectedVideo: VideoFile | null;
  onAddFolder: (path: string) => void;
  onRemoveFolder: (path: string) => void;
  onSelectVideo: (video: VideoFile) => void;
  onRefreshAll: () => void;
  onOpenByPath: (path: string) => void;
  rootsHint: string;
}

export function FilePanel({
  isOpen,
  onToggle,
  panelWidth,
  onPanelWidthChange,
  videoListScope,
  onVideoListScopeChange,
  folders,
  videos,
  selectedVideo,
  onAddFolder,
  onRemoveFolder,
  onSelectVideo,
  onRefreshAll,
  onOpenByPath,
  rootsHint,
}: FilePanelProps) {
  const [newPath, setNewPath] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [directFilePath, setDirectFilePath] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});

  const videoGroups = useMemo(
    () => buildVideoGroups(videos, videoListScope, folders),
    [videos, videoListScope, folders]
  );

  useEffect(() => {
    setExpandedFolders((prev) => {
      const next = { ...prev };
      for (const g of videoGroups) {
        if (!(g.key in next)) next[g.key] = true;
      }
      return next;
    });
  }, [videoGroups]);

  const handleAddPath = useCallback(() => {
    if (newPath.trim()) {
      onAddFolder(newPath.trim());
      setNewPath('');
      setIsAdding(false);
    }
  }, [newPath, onAddFolder]);

  const handleOpenByPath = useCallback(() => {
    const path = directFilePath.trim();
    if (!path) return;
    onOpenByPath(path);
  }, [directFilePath, onOpenByPath]);

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

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const scopeOk =
    videoListScope === 'all' || folders.some((f) => f.path === videoListScope);
  const selectValue =
    videoListScope === 'all' || !scopeOk ? '__all__' : videoListScope;

  useEffect(() => {
    if (videoListScope !== 'all' && !folders.some((f) => f.path === videoListScope)) {
      onVideoListScopeChange('all');
    }
  }, [folders, videoListScope, onVideoListScopeChange]);

  return (
    <div
      className={cn(
        'relative flex flex-col shrink-0 bg-zinc-900 border-r border-zinc-800',
        !isOpen && 'w-12 transition-[width] duration-300 ease-in-out'
      )}
      style={
        isOpen
          ? {
              width: panelWidth,
              minWidth: PANEL_MIN_W,
              maxWidth: PANEL_MAX_W,
              transition: undefined,
            }
          : undefined
      }
    >
      {/* Header */}
      <div className="flex items-center justify-between h-14 px-3 border-b border-zinc-800 shrink-0">
        {isOpen && (
          <div className="flex items-center gap-2 min-w-0">
            <FolderOpen className="w-5 h-5 text-blue-400 shrink-0" />
            <span className="font-semibold text-zinc-100 truncate">文件列表</span>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          className="ml-auto text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 shrink-0"
        >
          {isOpen ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
        </Button>
      </div>

      {/* Content */}
      {isOpen && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <div className="p-3 border-b border-zinc-800 shrink-0 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-500 uppercase shrink-0">视频来源</span>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-zinc-400 hover:text-zinc-100"
                  onClick={onRefreshAll}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-zinc-400 hover:text-zinc-100"
                  onClick={() => setIsAdding(!isAdding)}
                >
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            <Select
              value={selectValue}
              onValueChange={(v) => {
                if (v === '__all__') onVideoListScopeChange('all');
                else onVideoListScopeChange(v);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full h-8 text-xs bg-zinc-800 border-zinc-700 text-zinc-100 shadow-none"
              >
                <SelectValue placeholder="选择目录" />
              </SelectTrigger>
              <SelectContent
                position="popper"
                className="bg-zinc-900 border-zinc-700 text-zinc-100 z-[80] max-h-[min(280px,var(--radix-select-content-available-height))]"
              >
                <SelectItem
                  value="__all__"
                  className="text-xs focus:bg-zinc-800 focus:text-zinc-100 cursor-pointer"
                >
                  全部（合并已保存目录）
                </SelectItem>
                {folders.map((folder) => (
                  <SelectItem
                    key={folder.id}
                    value={folder.path}
                    className="text-xs focus:bg-zinc-800 focus:text-zinc-100 cursor-pointer"
                  >
                    <span className="truncate">{folder.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {isAdding && (
              <div className="flex gap-2">
                <Input
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder="输入文件夹路径..."
                  className="h-8 text-sm bg-zinc-800 border-zinc-700 text-zinc-100 placeholder:text-zinc-500"
                  onKeyDown={(e) => e.key === 'Enter' && handleAddPath()}
                />
                <Button size="sm" className="h-8 px-2 shrink-0" onClick={handleAddPath}>
                  添加
                </Button>
              </div>
            )}

            <div>
              <span className="text-[10px] text-zinc-600 uppercase block mb-1">已保存目录（可移除）</span>
              <ScrollArea className="max-h-20">
                <div className="space-y-1 pr-2">
                  {folders.map((folder) => (
                    <div
                      key={folder.id}
                      className="flex items-center justify-between px-2 py-1 rounded-md bg-zinc-800/50 group"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Folder className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        <span className="text-xs text-zinc-300 truncate">{folder.name}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 shrink-0"
                        onClick={() => onRemoveFolder(folder.path)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                  {folders.length === 0 && (
                    <div className="text-xs text-zinc-500 py-1 text-center">暂无，点击 + 添加</div>
                  )}
                </div>
              </ScrollArea>
            </div>

            <p className="text-[11px] text-zinc-500 leading-relaxed">{rootsHint}</p>

            <div className="flex gap-2">
              <Input
                value={directFilePath}
                onChange={(e) => setDirectFilePath(e.target.value)}
                placeholder="单个视频完整路径"
                className="h-8 text-sm bg-zinc-800 border-zinc-700 text-zinc-100 placeholder:text-zinc-500"
                onKeyDown={(e) => e.key === 'Enter' && handleOpenByPath()}
              />
              <Button
                size="sm"
                variant="secondary"
                className="h-8 px-3 shrink-0 bg-zinc-700 text-zinc-100 hover:bg-zinc-600"
                onClick={handleOpenByPath}
              >
                打开
              </Button>
            </div>
          </div>

          <div className="flex-1 p-3 overflow-hidden flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <span className="text-xs font-medium text-zinc-500 uppercase">视频文件</span>
              <span className="text-xs text-zinc-600">{videos.length} 个</span>
            </div>
            <ScrollArea className="flex-1 min-h-0">
              <div className="space-y-0.5 pr-2">
                {videoGroups.map((group) => {
                  const open = expandedFolders[group.key] !== false;
                  return (
                    <div key={group.key} className="rounded-lg border border-zinc-800/80 bg-zinc-900/40">
                      <button
                        type="button"
                        className="flex w-full items-center gap-1.5 py-2 px-2 text-left text-sm text-zinc-200 hover:bg-zinc-800/60 rounded-t-lg"
                        onClick={() =>
                          setExpandedFolders((p) => ({ ...p, [group.key]: !open }))
                        }
                      >
                        {open ? (
                          <ChevronDown className="w-4 h-4 shrink-0 text-zinc-500" />
                        ) : (
                          <ChevronRight className="w-4 h-4 shrink-0 text-zinc-500" />
                        )}
                        <Folder className="w-4 h-4 shrink-0 text-amber-500/90" />
                        <span className="min-w-0 flex-1 truncate font-medium">{group.label}</span>
                        <span className="text-[10px] text-zinc-500 shrink-0 tabular-nums">
                          {group.items.length}
                        </span>
                      </button>
                      {open && (
                        <div className="border-t border-zinc-800/80 py-1 pl-2 pr-1 space-y-0.5">
                          {group.items.map((video) => (
                            <button
                              key={video.id}
                              type="button"
                              onClick={() => onSelectVideo(video)}
                              className={cn(
                                'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                                selectedVideo?.id === video.id
                                  ? 'bg-blue-600/20 border border-blue-500/30'
                                  : 'hover:bg-zinc-800/90 border border-transparent'
                              )}
                            >
                              <div className="w-8 h-8 rounded bg-zinc-800 flex items-center justify-center shrink-0">
                                <FileVideo className="w-4 h-4 text-zinc-500" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-medium text-zinc-200 truncate leading-tight">
                                  {video.name}
                                </p>
                                <p className="text-[10px] text-zinc-500">{formatFileSize(video.size)}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {videos.length === 0 && (
                  <div className="text-sm text-zinc-500 py-8 text-center">暂无视频文件</div>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      )}

      {!isOpen && (
        <div className="flex-1 flex flex-col items-center py-4 gap-4">
          <FolderOpen className="w-5 h-5 text-zinc-500" />
          <div className="w-6 h-px bg-zinc-800" />
          <FileVideo className="w-5 h-5 text-zinc-500" />
        </div>
      )}

      {isOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左侧面板宽度"
          className="absolute right-0 top-0 bottom-0 z-20 w-1 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60"
          onPointerDown={onResizePointerDown}
        />
      )}
    </div>
  );
}
