import { useCallback, useEffect, useRef, useState } from 'react';
import { clipSegment, type BatchClipPayload } from '@/api/videoEditorClient';
import type { ClipJob, ClipJobStatus, ClipSegmentTask, ClipSegmentTaskStatus } from '@/types';

const STORAGE_KEY = 'video_editor_clip_queue';

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      /* ignore */
    }
  }
  return `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadJobs(): ClipJob[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ClipJob[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistJobs(jobs: ClipJob[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs.slice(0, 30)));
  } catch {
    /* ignore quota */
  }
}

function finalizeJobStatus(segments: ClipSegmentTask[]): ClipJobStatus {
  const pending = segments.filter((s) => s.status === 'pending' || s.status === 'running');
  if (pending.length) return 'running';
  const failed = segments.filter((s) => s.status === 'failed' || s.status === 'invalid');
  const ok = segments.filter((s) => s.status === 'done' || s.status === 'skipped');
  if (ok.length === 0) return 'failed';
  if (failed.length) return 'partial';
  return 'completed';
}

function jobSummary(segments: ClipSegmentTask[]): string {
  const done = segments.filter((s) => s.status === 'done').length;
  const skipped = segments.filter((s) => s.status === 'skipped').length;
  const failed = segments.filter((s) => s.status === 'failed').length;
  const invalid = segments.filter((s) => s.status === 'invalid').length;
  const parts = [`成功 ${done}`, skipped ? `跳过 ${skipped}` : '', failed ? `失败 ${failed}` : '', invalid ? `无效 ${invalid}` : '']
    .filter(Boolean);
  return parts.join('，');
}

export function useClipQueue() {
  const [jobs, setJobs] = useState<ClipJob[]>(() => loadJobs());
  const [panelOpen, setPanelOpen] = useState(() => loadJobs().length > 0);
  const [paused, setPaused] = useState(false);
  const [processing, setProcessing] = useState(false);
  const processingRef = useRef(false);
  const pausedRef = useRef(paused);
  const jobsRef = useRef(jobs);

  pausedRef.current = paused;
  jobsRef.current = jobs;

  useEffect(() => {
    persistJobs(jobs);
  }, [jobs]);

  const updateJob = useCallback((jobId: string, patch: Partial<ClipJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...patch } : j)));
  }, []);

  const updateSegment = useCallback(
    (jobId: string, index: number, patch: Partial<ClipSegmentTask>) => {
      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== jobId) return j;
          const segments = j.segments.map((s) => (s.index === index ? { ...s, ...patch } : s));
          return { ...j, segments };
        })
      );
    },
    []
  );

  const enqueue = useCallback(
    (input: {
      videoLabel: string;
      payload: BatchClipPayload;
      skipExisting: boolean;
    }): string => {
      const id = randomId();
      const segments: ClipSegmentTask[] = input.payload.time_segments.map((seg, index) => ({
        index,
        start_time: seg.start_time,
        end_time: seg.end_time,
        segment_name: seg.segment_name,
        status: 'pending' as ClipSegmentTaskStatus,
      }));
      const job: ClipJob = {
        id,
        videoLabel: input.videoLabel,
        createdAt: Date.now(),
        status: 'pending',
        skipExisting: input.skipExisting,
        payload: {
          ...input.payload,
          skip_existing: input.skipExisting,
        },
        segments,
      };
      setJobs((prev) => [job, ...prev]);
      setPanelOpen(true);
      return id;
    },
    []
  );

  const runProcessor = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    setProcessing(true);

    try {
      while (!pausedRef.current) {
        const list = jobsRef.current;
        const job = list.find(
          (j) => j.status === 'pending' || j.status === 'partial' || j.status === 'running'
        );
        if (!job) break;

        updateJob(job.id, { status: 'running' });

        for (const seg of job.segments) {
          if (pausedRef.current) break;
          if (seg.status !== 'pending' && seg.status !== 'failed' && seg.status !== 'running') continue;

          updateSegment(job.id, seg.index, { status: 'running', error: undefined });

          try {
            const res = await clipSegment({
              ...job.payload,
              segment_index: seg.index,
            });
            const st = res.status as ClipSegmentTaskStatus;
            if (st === 'done' || st === 'skipped') {
              updateSegment(job.id, seg.index, {
                status: st,
                filename: res.output?.filename,
                error: undefined,
              });
            } else if (st === 'invalid') {
              updateSegment(job.id, seg.index, {
                status: 'invalid',
                error: res.reason || res.error || '无效时间段',
              });
            } else {
              updateSegment(job.id, seg.index, {
                status: 'failed',
                error: res.error || '剪辑失败',
              });
            }
          } catch (e) {
            updateSegment(job.id, seg.index, {
              status: 'failed',
              error: e instanceof Error ? e.message : '剪辑失败',
            });
          }
        }

        setJobs((prev) => {
          const current = prev.find((j) => j.id === job.id);
          if (!current) return prev;
          let status: ClipJobStatus;
          if (pausedRef.current) {
            const left = current.segments.some(
              (s) => s.status === 'pending' || s.status === 'failed'
            );
            const hasOk = current.segments.some(
              (s) => s.status === 'done' || s.status === 'skipped'
            );
            status = left ? (hasOk ? 'partial' : 'pending') : finalizeJobStatus(current.segments);
          } else {
            status = finalizeJobStatus(current.segments);
          }
          const message = jobSummary(current.segments);
          return prev.map((j) => (j.id === job.id ? { ...j, status, message } : j));
        });

        if (pausedRef.current) break;
      }
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  }, [updateJob, updateSegment]);

  const start = useCallback(() => {
    setPaused(false);
    void runProcessor();
  }, [runProcessor]);

  const pause = useCallback(() => {
    setPaused(true);
  }, []);

  const enqueueAndStart = useCallback(
    (input: Parameters<typeof enqueue>[0]) => {
      const id = enqueue(input);
      setPaused(false);
      queueMicrotask(() => void runProcessor());
      return id;
    },
    [enqueue, runProcessor]
  );

  const retryJob = useCallback(
    (jobId: string) => {
      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== jobId) return j;
          return {
            ...j,
            status: 'pending',
            message: undefined,
            segments: j.segments.map((s) =>
              s.status === 'failed' || s.status === 'invalid'
                ? { ...s, status: 'pending' as ClipSegmentTaskStatus, error: undefined }
                : s
            ),
          };
        })
      );
      setPaused(false);
      queueMicrotask(() => void runProcessor());
    },
    [runProcessor]
  );

  const removeJob = useCallback((jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  }, []);

  const clearFinished = useCallback(() => {
    setJobs((prev) => prev.filter((j) => j.status !== 'completed' && j.status !== 'cancelled'));
  }, []);

  const cancelJob = useCallback((jobId: string) => {
    setJobs((prev) =>
      prev.map((j) => {
        if (j.id !== jobId) return j;
        return {
          ...j,
          status: 'cancelled',
          segments: j.segments.map((s) =>
            s.status === 'pending' || s.status === 'running'
              ? { ...s, status: 'cancelled' as ClipSegmentTaskStatus }
              : s
          ),
        };
      })
    );
  }, []);

  const pendingCount = jobs.filter((j) => j.status === 'pending' || j.status === 'partial').length;
  const activeCount = jobs.filter((j) => j.status === 'running').length;

  return {
    jobs,
    panelOpen,
    setPanelOpen,
    paused,
    processing,
    pendingCount,
    activeCount,
    enqueue,
    enqueueAndStart,
    start,
    pause,
    retryJob,
    removeJob,
    clearFinished,
    cancelJob,
  };
}
