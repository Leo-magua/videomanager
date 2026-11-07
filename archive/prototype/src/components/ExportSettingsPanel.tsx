import { useEffect, useState } from 'react';
import { Settings, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import type { ExportEncoder, ExportSettings } from '@/types';

interface ExportSettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: ExportSettings;
  gpuAvailable: boolean;
  onSave: (settings: ExportSettings) => Promise<void>;
}

const ENCODER_LABELS: Record<ExportEncoder, string> = {
  gpu: 'GPU（NVIDIA NVENC）',
  cpu: 'CPU（libx264）',
  auto: '自动（跟随环境变量）',
};

export function ExportSettingsPanel({
  open,
  onOpenChange,
  settings,
  gpuAvailable,
  onSave,
}: ExportSettingsPanelProps) {
  const [draft, setDraft] = useState<ExportSettings>(settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl"
        role="dialog"
        aria-labelledby="export-settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Settings className="h-4 w-4" />
            <span id="export-settings-title">剪辑编码设置</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-zinc-400 hover:text-zinc-100"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-4 px-4 py-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-zinc-400">硬件编码</span>
            {gpuAvailable ? (
              <Badge variant="secondary" className="bg-emerald-900/50 text-emerald-200">
                检测到 NVENC（如 RTX 4060）
              </Badge>
            ) : (
              <Badge variant="secondary" className="bg-amber-900/50 text-amber-200">
                未检测到 NVENC
              </Badge>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-zinc-300">编码器</label>
            <Select
              value={draft.encoder}
              onValueChange={(v) =>
                setDraft((prev) => ({ ...prev, encoder: v as ExportEncoder }))
              }
            >
              <SelectTrigger className="w-full border-zinc-700 bg-zinc-950 text-zinc-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ENCODER_LABELS) as ExportEncoder[]).map((key) => (
                  <SelectItem key={key} value={key} disabled={key === 'gpu' && !gpuAvailable}>
                    {ENCODER_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {draft.encoder === 'gpu' && !gpuAvailable && (
              <p className="text-xs text-amber-400">
                当前 FFmpeg 无 NVENC，请选 CPU 或安装带 NVENC 的 FFmpeg。
              </p>
            )}
            <p className="text-xs text-zinc-500">
              设置保存到项目目录 <code className="text-zinc-400">.video_editor.config.json</code>
              ，重编码保留源分辨率。
            </p>
          </div>

          <div
            className={`grid grid-cols-2 gap-3 ${
              draft.encoder === 'cpu' ? 'pointer-events-none opacity-50' : ''
            }`}
          >
            <div className="space-y-1.5">
              <label className="text-zinc-300">NVENC 画质 CQ</label>
              <Input
                type="number"
                min={0}
                max={51}
                value={draft.nvenc_cq}
                className="border-zinc-700 bg-zinc-950 text-zinc-100"
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    nvenc_cq: Math.min(51, Math.max(0, Number(e.target.value) || 0)),
                  }))
                }
              />
              <p className="text-xs text-zinc-500">越小画质越高，推荐 17–23</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-zinc-300">FFmpeg 线程数</label>
              <Input
                type="number"
                min={1}
                max={32}
                value={draft.ffmpeg_threads}
                className="border-zinc-700 bg-zinc-950 text-zinc-100"
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    ffmpeg_threads: Math.min(32, Math.max(1, Number(e.target.value) || 1)),
                  }))
                }
              />
              <p className="text-xs text-zinc-500">限制解码/封装占用</p>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <Button
            type="button"
            variant="secondary"
            className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={saving || (draft.encoder === 'gpu' && !gpuAvailable)}
            onClick={() => {
              setSaving(true);
              void onSave(draft)
                .then(() => onOpenChange(false))
                .finally(() => setSaving(false));
            }}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  );
}
