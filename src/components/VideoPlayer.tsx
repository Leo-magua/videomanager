import { useRef, useState, useEffect, useCallback } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  SkipBack,
  SkipForward,
  Bookmark,
  Settings,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import type { VideoFile, MarkPoint } from '@/types';

interface VideoPlayerProps {
  video: VideoFile | null;
  marks: MarkPoint[];
  seekToTime: number | null;
  onTimeUpdate: (time: number) => void;
  onDurationChange: (duration: number) => void;
  onAddMark: (timestamp: number, formattedTime: string) => void;
  onSeekHandled: () => void;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function VideoPlayer({
  video,
  marks,
  seekToTime,
  onTimeUpdate,
  onDurationChange,
  onAddMark,
  onSeekHandled,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [showRateMenu, setShowRateMenu] = useState(false);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Format time to MM:SS or HH:MM:SS
  const formatTime = (time: number): string => {
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);
    const ms = Math.floor((time % 1) * 100);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  // Handle play/pause
  const togglePlay = useCallback(() => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
    }
  }, [isPlaying]);

  // Handle volume
  const toggleMute = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  }, [isMuted]);

  // Handle fullscreen
  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;

    try {
      if (!isFullscreen) {
        await containerRef.current.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (error) {
      console.error('Fullscreen error:', error);
    }
  }, [isFullscreen]);

  // Handle seek
  const handleSeek = useCallback((value: number[]) => {
    if (videoRef.current) {
      videoRef.current.currentTime = value[0];
      setCurrentTime(value[0]);
    }
  }, []);

  // Handle volume change
  const handleVolumeChange = useCallback((value: number[]) => {
    if (videoRef.current) {
      const newVolume = value[0];
      videoRef.current.volume = newVolume;
      setVolume(newVolume);
      setIsMuted(newVolume === 0);
    }
  }, []);

  // Handle playback rate
  const handleRateChange = useCallback((rate: number) => {
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
      setPlaybackRate(rate);
      setShowRateMenu(false);
    }
  }, []);

  // Add mark at current time
  const handleAddMark = useCallback(() => {
    if (videoRef.current && video) {
      const time = videoRef.current.currentTime;
      onAddMark(time, formatTime(time));
    }
  }, [onAddMark, video]);

  // Skip forward/backward
  const skip = useCallback((seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(
        0,
        Math.min(duration, videoRef.current.currentTime + seconds)
      );
    }
  }, [duration]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!video) return;

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'arrowleft':
          e.preventDefault();
          skip(e.shiftKey ? -10 : -5);
          break;
        case 'arrowright':
          e.preventDefault();
          skip(e.shiftKey ? 10 : 5);
          break;
        case 'm':
          e.preventDefault();
          handleAddMark();
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'arrowup':
          e.preventDefault();
          if (videoRef.current) {
            const newVolume = Math.min(1, volume + 0.1);
            videoRef.current.volume = newVolume;
            setVolume(newVolume);
          }
          break;
        case 'arrowdown':
          e.preventDefault();
          if (videoRef.current) {
            const newVolume = Math.max(0, volume - 0.1);
            videoRef.current.volume = newVolume;
            setVolume(newVolume);
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [video, togglePlay, skip, handleAddMark, toggleFullscreen, volume]);

  // Fullscreen change listener
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!videoRef.current || seekToTime === null) return;
    videoRef.current.currentTime = Math.max(0, seekToTime);
    setCurrentTime(Math.max(0, seekToTime));
    onSeekHandled();
  }, [seekToTime, onSeekHandled]);

  // Auto-hide controls
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    if (isPlaying) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  }, [isPlaying]);

  // Video event handlers
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    const handleTimeUpdate = () => {
      setCurrentTime(videoElement.currentTime);
      onTimeUpdate(videoElement.currentTime);
    };

    const handleDurationChange = () => {
      setDuration(videoElement.duration);
      onDurationChange(videoElement.duration);
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleVolumeChange = () => {
      setVolume(videoElement.volume);
      setIsMuted(videoElement.muted);
    };

    videoElement.addEventListener('timeupdate', handleTimeUpdate);
    videoElement.addEventListener('durationchange', handleDurationChange);
    videoElement.addEventListener('play', handlePlay);
    videoElement.addEventListener('pause', handlePause);
    videoElement.addEventListener('volumechange', handleVolumeChange);

    return () => {
      videoElement.removeEventListener('timeupdate', handleTimeUpdate);
      videoElement.removeEventListener('durationchange', handleDurationChange);
      videoElement.removeEventListener('play', handlePlay);
      videoElement.removeEventListener('pause', handlePause);
      videoElement.removeEventListener('volumechange', handleVolumeChange);
    };
  }, [onTimeUpdate, onDurationChange]);

  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
  }, [video?.id]);

  // Get marks for current video
  const currentVideoMarks = marks.filter((m) => m.videoId === video?.id);

  if (!video) {
    return (
      <div className="flex-1 flex items-center justify-center bg-black">
        <div className="text-center">
          <div className="w-24 h-24 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-4">
            <Play className="w-10 h-10 text-zinc-600" />
          </div>
          <p className="text-zinc-500 text-lg">选择视频开始播放</p>
          <p className="text-zinc-600 text-sm mt-2">从左侧文件列表选择一个视频</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 flex flex-col bg-black relative group"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      {/* Video Element */}
      <div className="flex-1 relative flex items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          src={video.path}
          className="max-w-full max-h-full"
          onClick={togglePlay}
          controls={false}
          playsInline
        />

        {/* Mark Indicators on Progress Bar */}
        <div className="absolute top-4 left-4 right-4 flex flex-wrap gap-2 pointer-events-none">
          {currentVideoMarks.map((mark) => (
            <div
              key={mark.id}
              className="px-2 py-1 rounded bg-black/70 text-xs text-white flex items-center gap-1"
            >
              <Bookmark className="w-3 h-3 text-amber-400" />
              <span>{mark.formattedTime}</span>
            </div>
          ))}
        </div>

        {/* Center Play Button (when paused) */}
        {!isPlaying && (
          <button
            onClick={togglePlay}
            className="absolute inset-0 flex items-center justify-center bg-black/30 transition-opacity"
          >
            <div className="w-20 h-20 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center hover:bg-white/30 transition-colors">
              <Play className="w-10 h-10 text-white ml-1" />
            </div>
          </button>
        )}
      </div>

      {/* Controls */}
      <div
        className={cn(
          'absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent transition-opacity duration-300',
          showControls ? 'opacity-100' : 'opacity-0'
        )}
      >
        {/* Progress Bar with Marks */}
        <div className="relative px-4 pt-6 pb-2">
          {/* Mark indicators on timeline */}
          <div className="absolute top-2 left-4 right-4 h-4 pointer-events-none">
            {currentVideoMarks.map((mark) => {
              const position = duration > 0 ? (mark.timestamp / duration) * 100 : 0;
              return (
                <div
                  key={mark.id}
                  className="absolute top-0 w-0.5 h-3 bg-amber-400 rounded-full"
                  style={{ left: `${position}%` }}
                  title={`${mark.label} - ${mark.formattedTime}`}
                />
              );
            })}
          </div>
          <Slider
            value={[currentTime]}
            max={duration || 100}
            step={0.01}
            onValueChange={handleSeek}
            className="cursor-pointer"
          />
        </div>

        {/* Control Buttons */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            {/* Play/Pause */}
            <Button
              variant="ghost"
              size="icon"
              onClick={togglePlay}
              className="text-white hover:bg-white/20"
            >
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </Button>

            {/* Skip Buttons */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => skip(-5)}
              className="text-white hover:bg-white/20"
            >
              <SkipBack className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => skip(5)}
              className="text-white hover:bg-white/20"
            >
              <SkipForward className="w-4 h-4" />
            </Button>

            {/* Volume */}
            <div className="flex items-center gap-2 group/volume">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleMute}
                className="text-white hover:bg-white/20"
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-5 h-5" />
                ) : (
                  <Volume2 className="w-5 h-5" />
                )}
              </Button>
              <div className="w-0 overflow-hidden group-hover/volume:w-24 transition-all">
                <Slider
                  value={[isMuted ? 0 : volume]}
                  max={1}
                  step={0.01}
                  onValueChange={handleVolumeChange}
                  className="w-20"
                />
              </div>
            </div>

            {/* Time Display */}
            <div className="text-white text-sm font-mono ml-2">
              <span>{formatTime(currentTime)}</span>
              <span className="text-white/50 mx-1">/</span>
              <span className="text-white/70">{formatTime(duration)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Add Mark Button */}
            <Button
              variant="ghost"
              onClick={handleAddMark}
              className="text-amber-400 hover:bg-amber-400/20 gap-2"
            >
              <Bookmark className="w-4 h-4" />
              <span className="text-sm">标记 (M)</span>
            </Button>

            {/* Playback Rate */}
            <div className="relative">
              <Button
                variant="ghost"
                onClick={() => setShowRateMenu(!showRateMenu)}
                className="text-white hover:bg-white/20 gap-1"
              >
                <Settings className="w-4 h-4" />
                <span className="text-sm">{playbackRate}x</span>
                <ChevronDown className="w-3 h-3" />
              </Button>
              {showRateMenu && (
                <div className="absolute bottom-full right-0 mb-2 bg-zinc-900 rounded-lg border border-zinc-700 py-1 min-w-[100px]">
                  {PLAYBACK_RATES.map((rate) => (
                    <button
                      key={rate}
                      onClick={() => handleRateChange(rate)}
                      className={cn(
                        'w-full px-3 py-1.5 text-sm text-left hover:bg-zinc-800 transition-colors',
                        playbackRate === rate ? 'text-blue-400' : 'text-zinc-300'
                      )}
                    >
                      {rate}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Fullscreen */}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleFullscreen}
              className="text-white hover:bg-white/20"
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
