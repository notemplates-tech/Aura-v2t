import React, { useRef, useState, useEffect } from 'react';
import { Check, Wand2, Loader2 } from 'lucide-react';

interface AudioTrimSliderProps {
  audioDuration: number;
  trimStart: number;
  setTrimStart: (val: number) => void;
  trimEnd: number;
  setTrimEnd: (val: number) => void;
  onSmartTrim?: () => Promise<void>;
}

export const AudioTrimSlider: React.FC<AudioTrimSliderProps> = ({
  audioDuration,
  trimStart,
  setTrimStart,
  trimEnd,
  setTrimEnd,
  onSmartTrim,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeEnd = trimEnd || audioDuration;

  const [isDragging, setIsDragging] = useState<'start' | 'end' | null>(null);
  const [isSmartTrimming, setIsSmartTrimming] = useState(false);

  // Generate a predictable but cool-looking pseudo-waveform shape once
  const [waveformParts] = useState(() => {
    return Array.from({ length: 42 }, (_, i) => {
      // Sine elements combined with a bit of random noise for a gorgeous waveform shape
      const base = Math.abs(Math.sin((i / 42) * Math.PI * 3.5));
      const rand = Math.random() * 0.25;
      return Math.max(0.12, Math.min(0.95, base + rand));
    });
  });

  const handlePointerDown = (e: React.PointerEvent<any>, h: 'start' | 'end') => {
    e.preventDefault();
    setIsDragging(h);
    if (containerRef.current) {
      containerRef.current.setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const clientX = e.clientX;
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const percent = x / rect.width;
    const rawVal = percent * audioDuration;
    const val = Math.max(0, Math.min(rawVal, audioDuration));

    if (isDragging === 'start') {
      // Ensure trimStart doesn't cross trimEnd
      if (val < activeEnd - 0.1) {
        setTrimStart(parseFloat(val.toFixed(1)));
      } else {
        setTrimStart(parseFloat(Math.max(0, activeEnd - 0.2).toFixed(1)));
      }
    } else if (isDragging === 'end') {
      // Ensure trimEnd doesn't cross trimStart
      if (val > trimStart + 0.1) {
        setTrimEnd(parseFloat(val.toFixed(1)));
      } else {
        setTrimEnd(parseFloat(Math.min(audioDuration, trimStart + 0.2).toFixed(1)));
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging && containerRef.current) {
      containerRef.current.releasePointerCapture(e.pointerId);
    }
    setIsDragging(null);
  };

  const startPercent = audioDuration > 0 ? (trimStart / audioDuration) * 100 : 0;
  const endPercent = audioDuration > 0 ? (activeEnd / audioDuration) * 100 : 100;

  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  };

  return (
    <div className="space-y-3 p-4 bg-[#141517] border border-slate-800/80 rounded-xl" id="audio-trim-slider-container">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
          Интуитивный визуальный выбор диапазона
        </span>
        <div className="text-[10px] text-indigo-400 font-mono bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/15">
          Выбрано: <span className="font-bold text-slate-100">{(activeEnd - trimStart).toFixed(1)} с</span> из {audioDuration.toFixed(1)} с
        </div>
      </div>

      {/* Visual Workspace Track */}
      <div 
        ref={containerRef}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="relative h-14 bg-black/60 border border-slate-800 rounded-lg cursor-crosshair select-none touch-none"
        id="audio-trim-slider-track"
      >
        {/* Synthetic Waveform background bars */}
        <div className="absolute inset-0 flex items-center justify-between px-3 gap-[2px] opacity-20 pointer-events-none rounded-lg overflow-hidden">
          {waveformParts.map((h, i) => (
            <div 
              key={i} 
              className="flex-1 rounded-[1px] bg-slate-500"
              style={{ height: `${h * 100}%` }}
            />
          ))}
        </div>

        {/* Highlight track block for selected segment */}
        <div 
          className="absolute top-0 bottom-0 bg-gradient-to-r from-blue-500/15 via-indigo-500/15 to-purple-500/15 border-x border-indigo-500/40"
          style={{ left: `${startPercent}%`, right: `${100 - endPercent}%` }}
        >
          {/* Waveforms highlighted in selection */}
          <div className="absolute inset-0 flex items-center justify-between gap-[2px] px-3 pointer-events-none z-10 transition-all duration-300 rounded-lg overflow-hidden">
            {waveformParts.map((h, i) => {
              const barPercent = (i / waveformParts.length) * 100;
              const isInRange = barPercent >= startPercent && barPercent <= endPercent;
              return (
                <div 
                  key={i} 
                  className={`flex-1 rounded-[1px] transition-all duration-150 ${isInRange ? 'bg-gradient-to-t from-blue-400 to-indigo-400 opacity-80' : 'bg-transparent'}`}
                  style={{ height: `${h * 100}%` }}
                />
              );
            })}
          </div>
        </div>

        {/* Gray Out / Trimmed Out left portion */}
        <div 
          className="absolute left-0 top-0 bottom-0 bg-black/50 border-r border-slate-700/50 backdrop-blur-[0.5px] rounded-l-lg"
          style={{ width: `${startPercent}%` }}
        />

        {/* Gray Out / Trimmed Out right portion */}
        <div 
          className="absolute right-0 top-0 bottom-0 bg-black/50 border-l border-slate-700/50 backdrop-blur-[0.5px] rounded-r-lg"
          style={{ left: `${endPercent}%` }}
        />

        {/* Left Slider Grab handle */}
        <button 
          type="button"
          onPointerDown={(e) => handlePointerDown(e, 'start')}
          className={`absolute top-0 bottom-0 w-6 flex items-center justify-center -translate-x-1/2 cursor-ew-resize z-20 outline-none select-none transition-transform ${isDragging === 'start' ? 'scale-110' : 'hover:scale-105'}`}
          style={{ left: `${startPercent}%` }}
          id="trim-start-handle"
          title="Начало обрезки"
        >
          <div className="w-2.5 h-10 bg-gradient-to-b from-blue-500 to-indigo-600 rounded shadow-[0_0_12px_rgba(59,130,246,0.6)] border border-blue-400/30 flex items-center justify-center">
            {/* Visual handle rib */}
            <div className="w-[1px] h-4 bg-white/40 rounded-full" />
          </div>
          {/* Tooltip hovering over handle */}
          <div className="absolute -top-7 bg-[#0A0B0C] border border-blue-500/30 text-[9px] text-blue-300 px-1 py-0.5 rounded font-mono shadow-md select-none pointer-events-none flex items-center gap-1">
            <span>START:</span>
            <span className="font-bold text-white">{formatTime(trimStart)}</span>
          </div>
        </button>

        {/* Right Slider Grab handle */}
        <button 
          type="button"
          onPointerDown={(e) => handlePointerDown(e, 'end')}
          className={`absolute top-0 bottom-0 w-6 flex items-center justify-center -translate-x-1/2 cursor-ew-resize z-20 outline-none select-none transition-transform ${isDragging === 'end' ? 'scale-110' : 'hover:scale-105'}`}
          style={{ left: `${endPercent}%` }}
          id="trim-end-handle"
          title="Конец обрезки"
        >
          <div className="w-2.5 h-10 bg-gradient-to-b from-purple-500 to-pink-600 rounded shadow-[0_0_12px_rgba(168,85,247,0.6)] border border-purple-400/30 flex items-center justify-center">
            {/* Visual handle rib */}
            <div className="w-[1px] h-4 bg-white/40 rounded-full" />
          </div>
          {/* Tooltip hovering over handle */}
          <div className="absolute -top-7 bg-[#0A0B0C] border border-purple-500/30 text-[9px] text-purple-300 px-1 py-0.5 rounded font-mono shadow-md select-none pointer-events-none flex items-center gap-1">
            <span>END:</span>
            <span className="font-bold text-white">{formatTime(activeEnd)}</span>
          </div>
        </button>
      </div>

      {/* Mini Legend & quick presets */}
      <div className="flex justify-between items-center text-[10px] text-slate-500 font-mono">
        <span>{formatTime(0)}</span>
        <div className="flex gap-2 text-slate-400">
          {onSmartTrim && (
            <button 
              type="button"
              disabled={isSmartTrimming}
              onClick={async () => {
                setIsSmartTrimming(true);
                try {
                  await onSmartTrim();
                } catch (e) {
                  console.error(e);
                } finally {
                  setIsSmartTrimming(false);
                }
              }}
              className="flex items-center gap-1 hover:text-white hover:bg-slate-800/80 transition-all px-2 py-0.5 bg-indigo-500/10 text-indigo-400 rounded border border-indigo-500/20 disabled:opacity-50"
              title="Автоматическая обрезка тишины"
            >
              {isSmartTrimming ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
              Умная обрезка
            </button>
          )}
          <button 
            type="button"
            onClick={() => { setTrimStart(0); setTrimEnd(0); }}
            className="hover:text-white hover:bg-slate-800/80 transition-all px-2 py-0.5 bg-slate-900 rounded border border-slate-800"
          >
            Сбросить
          </button>
          {audioDuration > 30 && (
            <>
              <button 
                type="button"
                onClick={() => { setTrimStart(0); setTrimEnd(Math.min(30, audioDuration)); }}
                className="hover:text-white hover:bg-slate-800/80 transition-all px-2 py-0.5 bg-slate-900 rounded border border-slate-800"
              >
                Первые 30с
              </button>
              <button 
                type="button"
                onClick={() => { setTrimStart(Math.max(0, audioDuration - 60)); setTrimEnd(audioDuration); }}
                className="hover:text-white hover:bg-slate-800/80 transition-all px-2 py-0.5 bg-slate-900 rounded border border-slate-800"
              >
                Последние 60с
              </button>
            </>
          )}
        </div>
        <span>{formatTime(audioDuration)}</span>
      </div>
    </div>
  );
};
