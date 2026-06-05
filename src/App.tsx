import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, FileText, Calendar, Mail, Upload, Loader2, Save, Download, AlertCircle, LogOut, X, Plus, Search, Pause, Play, Sparkles, History, Trash2, FolderOpen, Database, Edit, Share2, Check, Clock } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { initAuth, googleSignInRedirect, googleSignInPopup, logout, getAccessToken } from './lib/auth';
import type { User } from 'firebase/auth';
import { createGoogleDoc, createCalendarEvent, saveToDrive, uploadBlobToDrive, deleteDriveFile } from './lib/googleApi';
import { exportToTXT, exportToPDF, exportToDOCX } from './lib/export';
import { motion, AnimatePresence } from 'motion/react';
import { SavedSession, saveSession, getSessions, deleteSession, renameSession, QueuedDriveSync, addQueuedDriveSync, getQueuedDriveSyncs, deleteQueuedDriveSync } from './lib/indexedDbWrapper';
import { shareNote, getSharedNote } from './lib/firestoreService';
import { AudioTrimSlider } from './components/AudioTrimSlider';
import { ExportModal } from './components/ExportModal';
import { ErrorLogDrawer } from './components/ErrorLogDrawer';
import { detectSilence, trimAndCompressAudio } from './lib/audioUtils';
import { useErrorLog } from './hooks/useErrorLog';

type SummaryType = 'bulletPoints' | 'actionItems' | 'fullTranscript';

const highlightString = (text: string, query: string) => {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${query})`, 'gi'));
  return parts.map((part, i) => 
    part.toLowerCase() === query.toLowerCase() 
      ? <mark key={i} className="bg-yellow-500/50 text-white rounded px-0.5">{part}</mark>
      : part
  );
};

const highlightChildren = (children: React.ReactNode, query: string): React.ReactNode => {
  if (typeof children === 'string') {
    return renderTextWithTimestampsAndHighlights(children, query, (seconds: number) => {
      window.dispatchEvent(new CustomEvent('jump-to-audio-timestamp', { detail: seconds }));
    });
  }
  if (Array.isArray(children)) {
    return React.Children.map(children, child => highlightChildren(child, query));
  }
  if (React.isValidElement(children)) {
    return React.cloneElement(children as any, {
      ...(children.props as any),
      children: highlightChildren((children.props as any).children, query)
    });
  }
  return children;
};

const parseTimestampToSeconds = (ts: string): number => {
  const parts = ts.trim().split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
};

const renderTextWithTimestampsAndHighlights = (
  text: string,
  query: string,
  onTimestampClick: (sec: number) => void
): React.ReactNode => {
  if (!text) return text;
  const timestampRegex = /(\[(?:\d{1,2}:)?\d{2}:\d{2}\])/g;
  const tokens = text.split(timestampRegex);
  
  return tokens.map((token, index) => {
    if (timestampRegex.test(token)) {
      const stripped = token.slice(1, -1); // remove [ and ]
      const seconds = parseTimestampToSeconds(stripped);
      return (
        <button
          key={`ts-${index}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onTimestampClick(seconds);
          }}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25 hover:text-indigo-300 font-mono font-medium text-[11px] border border-indigo-500/20 shadow-sm align-middle mx-1 cursor-pointer transition-all hover:scale-105 active:scale-95"
          title={`Jump to ${stripped}`}
        >
          <span className="text-[10px]">⏱️</span>
          {stripped}
        </button>
      );
    }
    
    if (query) {
      const parts = token.split(new RegExp(`(${query})`, 'gi'));
      return parts.map((part, i) => 
        part.toLowerCase() === query.toLowerCase() 
          ? <mark key={`m-${index}-${i}`} className="bg-yellow-500/50 text-white rounded px-0.5">{part}</mark>
          : part
      );
    }
    
    return token;
  });
};

export default function App() {
  const [needsAuth, setNeedsAuth] = useState(false);
  const [skipAuth, setSkipAuth] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  
  const { errorLogs, addError, clearErrors, removeError, isOpen: isErrorLogOpen, setIsOpen: setIsErrorLogOpen } = useErrorLog();

  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const recordingIntervalRef = useRef<number | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobChunk[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | null>(null);
  
  const [summaryType, setSummaryType] = useState<SummaryType>('bulletPoints');
  const [detectedLanguage, setDetectedLanguage] = useState<string>('');
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  
  const [trimStart, setTrimStart] = useState<number>(0);
  const [trimEnd, setTrimEnd] = useState<number>(0);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  
  const [processingState, setProcessingState] = useState<{
    stage: 'idle' | 'uploading' | 'processing' | 'summarizing' | 'complete';
    progress: number;
  }>({ stage: 'idle', progress: 0 });
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<string>('');
  const [transcript, setTranscript] = useState<string>('');
  const [summary, setSummary] = useState<string>('');
  const [detailedAnalysis, setDetailedAnalysis] = useState<string>('');
  const [insightsTab, setInsightsTab] = useState<'summarized' | 'detailed'>('summarized');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [autoSaveToDrive, setAutoSaveToDrive] = useState(() => {
    return localStorage.getItem('autoSaveToDrive') === 'true';
  });
  
  const [isSavingDoc, setIsSavingDoc] = useState(false);
  const [isSavingCal, setIsSavingCal] = useState(false);
  const [isSavingDrive, setIsSavingDrive] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);

  useEffect(() => {
    let interval: number;
    if (isSavingDrive) {
      setSyncProgress(15);
      interval = window.setInterval(() => {
        setSyncProgress(prev => {
          if (prev >= 95) return prev;
          return prev + Math.floor(Math.random() * 12) + 4;
        });
      }, 180);
    } else {
      setSyncProgress(0);
    }
    return () => {
      if (interval) window.clearInterval(interval);
    };
  }, [isSavingDrive]);

  // Sentiment Analysis State
  const [sentiment, setSentiment] = useState<{
    score: number;
    label: string;
    emoji: string;
    explanation?: string;
  } | null>(null);

  // Voice/Text commands states
  const [customCommand, setCustomCommand] = useState<string>('');
  const [commandFeedback, setCommandFeedback] = useState<string>('');
  const [isListening, setIsListening] = useState(false);
  const speechRecognitionRef = useRef<any>(null);

  const [authError, setAuthError] = useState<string | null>(null);
  const [isRedirectLoading, setIsRedirectLoading] = useState(false);

  // State-based Toast Notifications
  const [notification, setNotification] = useState<{
    message: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  const triggerToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification(prev => prev?.message === message ? null : prev);
    }, 5500);
  };

  // Pending Sync state and functions
  const [queuedSyncs, setQueuedSyncs] = useState<QueuedDriveSync[]>([]);
  const [isRetryingSync, setIsRetryingSync] = useState(false);

  const loadQueuedSyncs = async () => {
    try {
      const list = await getQueuedDriveSyncs();
      setQueuedSyncs(list);
    } catch (err) {
      console.error("Failed to load sync queue:", err);
    }
  };

  const handleRetrySyncQueue = async () => {
    if (!navigator.onLine) {
      triggerToast("Вы все еще в офлайн-режиме. Подключитесь к сети для синхронизации!", "error");
      return;
    }
    setIsRetryingSync(true);
    let successCount = 0;
    try {
      const currentQueue = await getQueuedDriveSyncs();
      if (currentQueue.length === 0) {
        setIsRetryingSync(false);
        return;
      }
      for (const item of currentQueue) {
        try {
          await saveToDrive(item.content, item.title);
          await deleteQueuedDriveSync(item.id);
          successCount++;
        } catch (uploadErr) {
          console.error(`Failed to sync queued item ${item.id}:`, uploadErr);
          break;
        }
      }
      await loadQueuedSyncs();
      if (successCount > 0) {
        triggerToast(`Успешно синхронизировано элементов с Google Диском: ${successCount}`, "success");
      } else {
        triggerToast("Не удалось соскачать из локальной очереди. Проверьте разрешения доступа к Google Диску.", "error");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsRetryingSync(false);
    }
  };

  useEffect(() => {
    const handleOnlineStatus = () => {
      if (navigator.onLine) {
        getQueuedDriveSyncs().then(list => {
          if (list.length > 0 && !needsAuth && !skipAuth) {
            handleRetrySyncQueue();
          }
        });
      }
    };
    window.addEventListener('online', handleOnlineStatus);
    return () => {
      window.removeEventListener('online', handleOnlineStatus);
    };
  }, [needsAuth, skipAuth]);

  // Export Modal & Options States
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<'txt' | 'pdf' | 'docx'>('txt');
  const [exportIncludeMetadata, setExportIncludeMetadata] = useState(true);
  const [exportIncludeSummary, setExportIncludeSummary] = useState(true);
  const [exportIncludeTranscript, setExportIncludeTranscript] = useState(true);
  const [exportIncludeSentiment, setExportIncludeSentiment] = useState(true);
  const [exportIncludeKeywords, setExportIncludeKeywords] = useState(true);
  const [exportCustomTitle, setExportCustomTitle] = useState('Voice Note Export');
  const [previewText, setPreviewText] = useState('');

  // Local History (IndexedDB) states
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [storageEstimate, setStorageEstimate] = useState<{ usage: number; quota: number; percentage: number } | null>(null);
  const [simulateLimitRatio, setSimulateLimitRatio] = useState<number | null>(null);

  // Copy Share Link & Read-Only presentations
  const [isSharingLink, setIsSharingLink] = useState(false);
  const [copiedShareUrl, setCopiedShareUrl] = useState<string | null>(null);
  const [urlShareId, setUrlShareId] = useState<string | null>(null);
  const [sharedNote, setSharedNote] = useState<any>(null);
  const [isLoadingSharedNote, setIsLoadingSharedNote] = useState(false);
  const [sharedNoteError, setSharedNoteError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shareId = params.get('share');
    if (shareId) {
      setUrlShareId(shareId);
      importSharedNote(shareId);
    }
  }, []);

  const importSharedNote = async (id: string) => {
    setIsLoadingSharedNote(true);
    setSharedNoteError(null);
    try {
      const data = await getSharedNote(id);
      if (data) {
        setSharedNote(data);
      } else {
        setSharedNoteError("К сожалению, эта аудиозаметка не найдена или была удалена.");
      }
    } catch (err: any) {
      console.error("Shared note load failed:", err);
      setSharedNoteError("Не удалось загрузить аудиозаметку. Пожалуйста, проверьте интернет-соединение или повторите попытку позже.");
    } finally {
      setIsLoadingSharedNote(false);
    }
  };

  const handleShareLink = async () => {
    if (!result && !transcript && !summary) {
      triggerToast("Заметка пуста. Сначала обработайте или запишите аудиоматериал!", "error");
      return;
    }
    setIsSharingLink(true);
    try {
      const randomId = await shareNote({
        title: exportCustomTitle || 'Голосовая заметка',
        transcript: transcript || result || '',
        summary: summary || result || '',
        detailedAnalysis: detailedAnalysis || '',
        sentiment: sentiment || undefined,
        detectedLanguage: detectedLanguage || 'ru',
        tags: tags || []
      });
      const shareUrl = `${window.location.origin}${window.location.pathname}?share=${randomId}`;
      await navigator.clipboard.writeText(shareUrl);
      setCopiedShareUrl(shareUrl);
      triggerToast("Готово! Публичная ссылка скопирована в буфер обмена.", "success");
    } catch (err: any) {
      console.error("Public share failed:", err);
      triggerToast("Не удалось сгенерировать публичную ссылку.", "error");
    } finally {
      setIsSharingLink(false);
    }
  };

  const updateStorageEstimate = async () => {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const usage = estimate.usage || 0;
        const quota = estimate.quota || 1;
        const percentage = (usage / quota) * 100;
        setStorageEstimate({ usage, quota, percentage });
      } catch (err) {
        console.warn("Storage estimate failed", err);
      }
    }
  };

  const loadLocalSessions = async () => {
    try {
      const sessions = await getSessions();
      setSavedSessions(sessions);
      updateStorageEstimate();
    } catch (err: any) {
      console.error(err);
      triggerToast("Ошибка при чтении сохраненных сессий.", "error");
    }
  };

  useEffect(() => {
    loadLocalSessions();
    loadQueuedSyncs();
    updateStorageEstimate();
  }, []);

  const handleSaveCurrentSession = async (customTitleText?: string) => {
    if (!transcript && !summary && !result) {
      triggerToast("Нет данных для сохранения. Сначала сделайте запись или распознавание.", "error");
      return;
    }

    try {
      const finalTitle = (customTitleText || exportCustomTitle || 'Голосовая заметка').trim();
      const sessionData: Omit<SavedSession, 'id'> = {
        title: finalTitle,
        timestamp: new Date().toLocaleString('ru-RU', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }),
        transcript,
        summary,
        detailedAnalysis,
        sentiment,
        detectedLanguage,
        tags,
        recordingDuration,
        audioBlob: audioBlob || undefined
      };

      let newId: number;
      if (activeSessionId) {
        newId = await saveSession({ ...sessionData, id: activeSessionId });
        triggerToast(`Запись "${finalTitle}" успешно обновлена!`, "success");
      } else {
        newId = await saveSession(sessionData);
        setActiveSessionId(newId);
        triggerToast(`Запись "${finalTitle}" успешно сохранена в офлайн-архив!`, "success");
      }
      await loadLocalSessions();
    } catch (err: any) {
      console.error(err);
      triggerToast("Не удалось сохранить сессию локально.", "error");
    }
  };

  const handleLoadLocalSession = (session: SavedSession) => {
    try {
      setActiveSessionId(session.id);
      setTranscript(session.transcript || '');
      setSummary(session.summary || '');
      setDetailedAnalysis(session.detailedAnalysis || '');
      setSentiment(session.sentiment || null);
      setDetectedLanguage(session.detectedLanguage || '');
      setTags(session.tags || []);
      setRecordingDuration(session.recordingDuration || 0);
      setExportCustomTitle(session.title || 'Запись');
      setResult(session.summary || session.transcript || '');

      if (session.audioBlob) {
        setAudioBlob(session.audioBlob);
        setAudioUrl(URL.createObjectURL(session.audioBlob));
      } else {
        setAudioBlob(null);
        setAudioUrl(null);
      }

      setIsHistoryOpen(false);
      triggerToast(`Загружена запись: "${session.title}"`, "success");
    } catch (err: any) {
      console.error(err);
      triggerToast("Ошибка при загрузке сохраненной сессии.", "error");
    }
  };

  const handleDeleteLocalSession = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteSession(id);
      if (activeSessionId === id) {
        setActiveSessionId(null);
        // Clear current active state views to represent empty screen if desired, or keep showing but unlinked
      }
      await loadLocalSessions();
      triggerToast("Запись удалена из офлайн-архива.", "success");
    } catch (err: any) {
      console.error(err);
      triggerToast("Не удалось удалить запись.", "error");
    }
  };

  const handleRenameLocalSession = async (id: number, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newTitle = window.prompt("Введите новое название сессии:", currentTitle);
    if (newTitle === null) return;
    const trimmedTitle = newTitle.trim();
    if (!trimmedTitle) {
      triggerToast("Название не может быть пустым.", "error");
      return;
    }

    try {
      await renameSession(id, trimmedTitle);
      if (activeSessionId === id) {
        setExportCustomTitle(trimmedTitle);
      }
      await loadLocalSessions();
      triggerToast("Название записи успешно изменено!", "success");
    } catch (err: any) {
      console.error(err);
      triggerToast("Не удалось изменить название.", "error");
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleTimestampClick = (seconds: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = seconds;
      audioRef.current.play().catch(err => {
        console.warn("Failed to auto-play after jump:", err);
      });
      triggerToast(`Переход к ${formatDuration(seconds)}`, 'info');
    } else {
      triggerToast("Аудиопроигрыватель не загружен или не готов.", 'error');
    }
  };

  const getDetailedAnalysisFallback = () => {
    if (detailedAnalysis) return detailedAnalysis;
    if (!summary) return '';
    
    let derived = `### 🔍 СИСТЕМНЫЙ АНАЛИТИЧЕСКИЙ ОТЧЕТ\n`;
    derived += `**Дата обработки:** ${new Date().toLocaleString()}\n`;
    if (detectedLanguage) {
      derived += `**Обнаруженный язык:** ${detectedLanguage.toUpperCase()}\n`;
    }
    if (tags.length > 0) {
      derived += `**Теги и лексические группы:** ${tags.map(t => '`' + t + '`').join(', ')}\n`;
    }
    derived += `\n---\n\n`;
    
    derived += `### 🎯 ОСНОВНЫЕ КОНЦЕПТЫ И СВОДКА\n`;
    derived += `Ниже представлены результаты глубокого лингвистического анализа исходного аудиоматериала. Основные извлеченные разделы:\n\n`;
    derived += `${summary}\n\n`;
    
    if (sentiment) {
      const sentimentLabelRu = sentiment.label === 'positive' ? 'ПОЛОЖИТЕЛЬНЫЙ' : (sentiment.label === 'negative' ? 'ОТРИЦАТЕЛЬНЫЙ' : 'НЕЙТРАЛЬНЫЙ');
      derived += `### 🎭 СЕМАHТИЧЕСКИЙ АНАЛИЗ ЭМОЦИОНАЛЬНОГО ТОНА\n`;
      derived += `- **Преобладающее настроение:** ${sentimentLabelRu} ${sentiment.emoji || ''}\n`;
      derived += `- **Показатель интенсивности:** \`${sentiment.score > 0 ? '+' : ''}${sentiment.score.toFixed(2)}\` в диапазоне от -1.0 до 1.0\n`;
      if (sentiment.explanation) {
        derived += `- **Аналитическая оценка:** *${sentiment.explanation}*\n`;
      }
      derived += `\n`;
    }
    
    if (transcript) {
      derived += `\n---\n### 📊 SPEAKER & CONTENT DYNAMICS\n`;
      derived += `- **Общий объем транскрипции (слов):** ${transcript.split(/\s+/).filter(Boolean).length}\n`;
      derived += `- **Лингвистическая сложность:** Текст обработан с поддержкой терминологического словаря.\n`;
    }

    return derived;
  };

  const generateExportText = (opts: {
    title: string;
    includeMetadata: boolean;
    includeSummary: boolean;
    includeTranscript: boolean;
    includeSentiment: boolean;
    includeKeywords: boolean;
  }) => {
    let output = '';

    if (opts.includeMetadata) {
      output += `=========================================\n`;
      output += `${opts.title.toUpperCase()}\n`;
      output += `Дата: ${new Date().toLocaleString()}\n`;
      if (recordingDuration > 0) {
        output += `Длительность: ${formatDuration(recordingDuration)}\n`;
      }
      if (detectedLanguage) {
        output += `Язык: ${detectedLanguage.toUpperCase()}\n`;
      }
      output += `=========================================\n\n`;
    }

    if (opts.includeSentiment && sentiment) {
      const sentimentLabelRu = sentiment.label === 'positive' ? 'ПОЛОЖИТЕЛЬНЫЙ' : (sentiment.label === 'negative' ? 'ОТРИЦАТЕЛЬНЫЙ' : 'НЕЙТРАЛЬНЫЙ');
      output += `### АHАЛИЗ ЭМОЦИОНАЛЬНОГО ТОНА\n`;
      output += `Тон: ${sentimentLabelRu} ${sentiment.emoji || ''}\n`;
      output += `Оценка: ${sentiment.score > 0 ? '+' : ''}${sentiment.score.toFixed(2)} (от -1.0 до +1.0)\n`;
      if (sentiment.explanation) {
        output += `Анализ: ${sentiment.explanation}\n`;
      }
      output += `\n`;
    }

    if (opts.includeSummary && summary) {
      output += `### AI СВОДКА И ИНСАЙТЫ\n`;
      output += `${summary}\n\n`;
    }

    if (opts.includeTranscript && transcript) {
      output += `### ИСХОДНЫЙ ТРАHСКРИПТ\n`;
      output += `${transcript}\n\n`;
    }

    if (opts.includeKeywords && tags.length > 0) {
      output += `### КЛЮЧЕВЫЕ СЛОВА\n`;
      output += `${tags.join(', ')}\n\n`;
    }

    return output.trim();
  };

  // Click-to-seek audio listener for diarization timestamps
  useEffect(() => {
    const handleJumpEvent = (e: Event) => {
      const seconds = (e as CustomEvent).detail;
      if (audioRef.current) {
        audioRef.current.currentTime = seconds;
        audioRef.current.play().catch(err => {
          console.warn("Failed to auto-play after jump:", err);
        });
        triggerToast(`Переход к ${formatDuration(seconds)}`, 'info');
      } else {
        triggerToast("Аудиопроигрыватель не загружен или не готов.", 'error');
      }
    };

    window.addEventListener('jump-to-audio-timestamp', handleJumpEvent);
    return () => {
      window.removeEventListener('jump-to-audio-timestamp', handleJumpEvent);
    };
  }, []);

  // Keep preview text synchronized with active layout options
  useEffect(() => {
    const text = generateExportText({
      title: exportCustomTitle,
      includeMetadata: exportIncludeMetadata,
      includeSummary: exportIncludeSummary,
      includeTranscript: exportIncludeTranscript,
      includeSentiment: exportIncludeSentiment,
      includeKeywords: exportIncludeKeywords,
    });
    setPreviewText(text);
  }, [
    exportCustomTitle,
    exportIncludeMetadata,
    exportIncludeSummary,
    exportIncludeTranscript,
    exportIncludeSentiment,
    exportIncludeKeywords,
    summary,
    transcript,
    sentiment,
    tags,
    recordingDuration,
    detectedLanguage
  ]);

  const handleOpenExportModal = (format: 'txt' | 'pdf' | 'docx') => {
    setExportFormat(format);
    setIsExportModalOpen(true);
  };

  const handleExecuteExport = () => {
    const filename = exportCustomTitle.trim() || 'Transcription';
    if (exportFormat === 'pdf') {
      exportToPDF(previewText, filename);
    } else if (exportFormat === 'docx') {
      exportToDOCX(previewText, filename);
    } else {
      exportToTXT(previewText, filename);
    }
    setIsExportModalOpen(false);
  };

  useEffect(() => {
    initAuth(
      (currentUser) => {
        setUser(currentUser);
        setNeedsAuth(false);
      },
      () => {
        setUser(null);
        setNeedsAuth(false);
      }
    );
  }, []);

  useEffect(() => {
    let interval: number;
    if (processingState.stage === 'processing') {
      interval = window.setInterval(() => {
        setProcessingState(prev => {
          if (prev.progress >= 95) {
             return { stage: 'summarizing', progress: 0 };
          }
          return { ...prev, progress: prev.progress + 5 };
        });
      }, 1000);
    } else if (processingState.stage === 'summarizing') {
      interval = window.setInterval(() => {
        setProcessingState(prev => {
          if (prev.progress >= 95) return prev;
          return { ...prev, progress: prev.progress + 3 };
        });
      }, 500);
    }
    return () => clearInterval(interval);
  }, [processingState.stage]);

  useEffect(() => {
    const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognitionClass) {
      const rec = new SpeechRecognitionClass();
      rec.continuous = false;
      rec.interimResults = false;
      
      rec.onstart = () => {
        setIsListening(true);
        setCommandFeedback('🎙️ Слушаю... Произнесите команду.');
      };

      rec.onresult = (event: any) => {
        const transcriptResult = event.results[event.resultIndex][0].transcript;
        setCustomCommand(transcriptResult);
        setCommandFeedback(`🎤 Записано: "${transcriptResult}". Нажмите Enter или «Запуск» для выполнения!`);
      };

      rec.onerror = (event: any) => {
        console.error("Speech Recognition Error:", event.error);
        if (event.error === 'not-allowed') {
          setCommandFeedback('⚠️ Доступ к микрофону заблокирован. Пожалуйста, разрешите его в настройках браузера!');
        } else {
          setCommandFeedback(`⚠️ Ошибка распознавания речи: ${event.error}`);
        }
        setIsListening(false);
      };

      rec.onend = () => {
        setIsListening(false);
      };

      speechRecognitionRef.current = rec;
    }
  }, []);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    setAuthError(null);
    try {
      const result = await googleSignInPopup();
      setUser(result.user);
      setNeedsAuth(false);
      triggerToast("Успешно подключено к Google Cloud!", "success");
    } catch (err: any) {
      console.warn('Popup login failed, attempting redirect:', err);
      if (err?.code === 'auth/popup-blocked' || err?.message?.includes('popup-blocked') || err?.message?.includes('popup')) {
        setAuthError('popup-blocked');
      } else {
        setAuthError(err?.message || 'Login failed. Ensure Firebase is properly configured with Google OAuth.');
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLoginRedirect = async () => {
    setIsRedirectLoading(true);
    setAuthError(null);
    try {
      await googleSignInRedirect();
    } catch (err: any) {
      console.error('Redirect login failed:', err);
      setAuthError(err?.message || 'Redirect login failed. Ensure Firebase is properly configured with Google OAuth.');
    } finally {
      setIsRedirectLoading(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setNeedsAuth(false);
  };

  const drawWaveform = () => {
    if (!canvasRef.current || !analyserRef.current) return;
    const canvas = canvasRef.current;
    
    // Set actual canvas size to match display size for sharp rendering
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }
    }
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const analyser = analyserRef.current;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);
      
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ef4444'; // Tailwind red-500
      ctx.beginPath();
      
      const sliceWidth = canvas.width * 1.0 / bufferLength;
      let x = 0;
      
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * canvas.height / 2;
        
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        
        x += sliceWidth;
      }
      
      ctx.stroke();
    };
    
    draw();
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      // Audio setup for visualizer
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContextCtor) {
        const audioCtx = new AudioContextCtor();
        audioContextRef.current = audioCtx;
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        analyserRef.current = analyser;
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);
      }

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setTrimStart(0);
        setTrimEnd(0);
        setAudioDuration(recordingDuration);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setIsPaused(false);
      setRecordingDuration(0);
      recordingIntervalRef.current = window.setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);
      
      // We must start drawing slightly after the canvas is mounted (it gets mounted when isRecording becomes true)
      setTimeout(drawWaveform, 50);
    } catch (err) {
      console.error("Failed to start recording:", err);
      triggerToast("Could not access microphone. Please check system & browser permissions.", 'error');
    }
  };

  const togglePauseResume = () => {
    if (mediaRecorderRef.current) {
      if (isPaused) {
        mediaRecorderRef.current.resume();
        setIsPaused(false);
        audioContextRef.current?.resume();
        recordingIntervalRef.current = window.setInterval(() => {
          setRecordingDuration(prev => prev + 1);
        }, 1000);
      } else {
        mediaRecorderRef.current.pause();
        setIsPaused(true);
        audioContextRef.current?.suspend();
        if (recordingIntervalRef.current) {
          window.clearInterval(recordingIntervalRef.current);
          recordingIntervalRef.current = null;
        }
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setIsPaused(false);
      
      if (recordingIntervalRef.current) {
        window.clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }
      
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(console.error);
        audioContextRef.current = null;
      }

      // Stop all tracks to release mic
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setAudioBlob(file);
      setAudioUrl(URL.createObjectURL(file));
      setResult('');
      setTranscript('');
      setSummary('');
      setSentiment(null);
      setTrimStart(0);
      setTrimEnd(0);
      setAudioDuration(0);
    }
  };

  const handleSmartTrim = async () => {
    if (!audioBlob) return;
    try {
      const { start, end, duration } = await detectSilence(audioBlob);
      // Give a tiny padding (0.1s) if possible
      const safeStart = Math.max(0, start - 0.1);
      const safeEnd = Math.min(duration, end + 0.1);
      
      setTrimStart(parseFloat(safeStart.toFixed(1)));
      setTrimEnd(parseFloat(safeEnd.toFixed(1)));
    } catch (e) {
      console.error("Smart trim failed", e);
    }
  };

  const transcribeAndSummarize = async () => {
    if (!audioBlob) return;
    
    setIsProcessing(true);
    setResult('');
    setTranscript('');
    setSummary('');
    setDetailedAnalysis('');
    setSentiment(null);
    setProcessingState({ stage: 'uploading', progress: 5 });
    
    let driveFileIds: string[] = [];
    let uploadedLocalFileId = "";
    try {
      let uploadBlob = audioBlob;
      let uploadFileName = (audioBlob as any).name || 'recording.webm';
      let finalTrimStart = trimStart;
      let finalTrimEnd = trimEnd;
      let token = "";
      
      // Attempt client-side audio trimming and downsampling first to heavily shrink the file size!
      // This turns high-fidelity large audio files into much smaller mono WAVs, avoiding Google Drive requirements for most normal files.
      try {
        setProcessingState({ stage: 'uploading', progress: 10 });
        const compressed = await trimAndCompressAudio(audioBlob, trimStart, trimEnd);
        uploadBlob = compressed.blob;
        uploadFileName = 'recording.wav';
        // Since we've pre-trimmed the audio locally, send start and end as 0 to avoid double trimming on the server
        finalTrimStart = 0;
        finalTrimEnd = 0;
        setProcessingState({ stage: 'uploading', progress: 20 });
      } catch (e) {
        console.warn("Client-side audio preprocessing failed, using raw fallback:", e);
      }

      const isLargeFile = uploadBlob.size > 24 * 1024 * 1024; // 24MB threshold to use Google Drive chunks

      if (isLargeFile) {
        token = await getAccessToken() || "";
        
        if (token) {
          setProcessingState({ stage: 'uploading', progress: 25 });
          triggerToast("Запущена автоматическая нарезка по 50 МБ и загрузка на Google Диск в фоновом режиме...", "info");
          
          const chunkSize = 50 * 1024 * 1024; // 50MB slices as requested
          const chunks: Blob[] = [];
          let offset = 0;
          while (offset < uploadBlob.size) {
            chunks.push(uploadBlob.slice(offset, Math.min(uploadBlob.size, offset + chunkSize), uploadBlob.type));
            offset += chunkSize;
          }
          
          for (let i = 0; i < chunks.length; i++) {
            const chunkProgress = 25 + Math.round((i / chunks.length) * 65);
            setProcessingState({ stage: 'uploading', progress: chunkProgress });
            
            const chunkFileName = `chunk_${i + 1}_of_${chunks.length}_${uploadFileName}`;
            const fileId = await uploadBlobToDrive(chunks[i], chunkFileName);
            driveFileIds.push(fileId);
          }
          triggerToast("Все части успешно сохранены на Google Диск. Сервер начинает склейку и расшифровку...", "success");
        } else {
          // Direct Chunk Upload mode to completely bypass OAuth 403 blocks!
          setProcessingState({ stage: 'uploading', progress: 20 });
          triggerToast("Вход в Google не выполнен или недоступен. Переключаемся на безопасную нарезку по 10 МБ и безопасную загрузку на сервер...", "info");
          
          const chunkSize = 10 * 1024 * 1024; // 10MB chunks to easily bypass any 24MB network limits
          const chunks: Blob[] = [];
          let offset = 0;
          while (offset < uploadBlob.size) {
            chunks.push(uploadBlob.slice(offset, Math.min(uploadBlob.size, offset + chunkSize), uploadBlob.type));
            offset += chunkSize;
          }

          const uploadId = "upl-" + Date.now() + "-" + Math.random().toString(36).substring(2, 11);

          for (let i = 0; i < chunks.length; i++) {
            const chunkProgress = 20 + Math.round((i / chunks.length) * 60);
            setProcessingState({ stage: 'uploading', progress: chunkProgress });

            const fd = new FormData();
            fd.append("chunk", chunks[i], `chunk_${i}`);
            fd.append("uploadId", uploadId);
            fd.append("chunkIndex", i.toString());

            const uploadChunkRes = await fetch("/api/upload-chunk", {
              method: "POST",
              body: fd
            });

            if (!uploadChunkRes.ok) {
              const errBody = await uploadChunkRes.json().catch(() => ({}));
              throw new Error(errBody.error || `Ошибка при загрузке части ${i+1} из ${chunks.length}`);
            }
          }

          setProcessingState({ stage: 'uploading', progress: 85 });
          // Assemble
          const assembleRes = await fetch("/api/assemble-upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              uploadId,
              totalChunks: chunks.length,
              filename: uploadFileName
            })
          });

          if (!assembleRes.ok) {
            const errBody = await assembleRes.json().catch(() => ({}));
            throw new Error(errBody.error || "Ошибка при сборке файла на сервере");
          }

          const assembleData = await assembleRes.json();
          uploadedLocalFileId = assembleData.fileId;
          triggerToast("Большой файл успешно загружен по частям и собран на сервере. Начинается распознавание...", "success");
        }
      }

      const formData = new FormData();
      if (driveFileIds.length > 0) {
        formData.append('driveFileIds', JSON.stringify(driveFileIds));
        formData.append('accessToken', token);
        formData.append('originalFileName', (audioBlob as any).name || 'audio.mp3');
        formData.append('originalMimeType', audioBlob.type || 'audio/webm');
      } else if (uploadedLocalFileId) {
        formData.append('fileId', uploadedLocalFileId);
        formData.append('originalFileName', uploadFileName);
      } else {
        formData.append('file', uploadBlob, uploadFileName);
      }
      formData.append('summaryType', summaryType);
      if (customCommand.trim()) {
        formData.append('customCommand', customCommand);
      }
      if (finalTrimStart > 0) {
        formData.append('trimStart', finalTrimStart.toString());
      }
      if (finalTrimEnd > 0) {
        formData.append('trimEnd', finalTrimEnd.toString());
      }

      const data = await new Promise<any>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/transcribe');
        
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            // Keep progress scale in uploaded percentage, starting from 20% to account for preprocessing
            const percent = isLargeFile ? 90 + (e.loaded / e.total) * 10 : 20 + (e.loaded / e.total) * 80;
            if (percent < 100) {
              setProcessingState({ stage: 'uploading', progress: percent });
            }
          }
        };
        
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch (e: any) {
              const bodySnippet = xhr.responseText ? xhr.responseText.substring(0, 300) : '(empty)';
              console.error("Failed to parse JSON response from /api/transcribe:", e, "Response snippet:", bodySnippet);
              const errMsg = `Invalid response from server. Expected JSON, but received: ${bodySnippet}`;
              addError(errMsg, xhr.responseText, '/api/transcribe', xhr.status);
              reject(new Error(errMsg));
            }
          } else {
             let errorMsg = 'Failed to process audio';
             let errDetails = null;
             try {
                const errData = JSON.parse(xhr.responseText);
                errorMsg = errData.error || `Failed to process audio (HTTP ${xhr.status})`;
                errDetails = errData;
             } catch (e) {
                errorMsg = `Failed to process audio (HTTP ${xhr.status}): ${xhr.statusText || 'Unknown error. Server might be down or file too large.'}`;
                errDetails = xhr.responseText || xhr.statusText || 'No response details';
             }
             addError(errorMsg, errDetails, '/api/transcribe', xhr.status);
             reject(new Error(errorMsg));
          }
        };
        
        xhr.onerror = () => {
          const errMsg = 'Network error during audio upload/processing';
          addError(errMsg, 'The network request failed completely. The server might be down, or CORS blocked, or socket closed.', '/api/transcribe');
          reject(new Error(errMsg));
        };
        
        xhr.upload.onloadend = () => {
          // Once uploaded, transition to processing stage
          setProcessingState({ stage: 'processing', progress: 0 });
        };
        
        xhr.send(formData);
      });

      setProcessingState({ stage: 'complete', progress: 100 });
      setResult(data.result || '');
      setTranscript(data.transcript || data.result || '');
      setSummary(data.summary || data.result || '');
      setDetailedAnalysis(data.detailedAnalysis || '');
      if (data.sentiment) {
        setSentiment(data.sentiment);
      } else {
        setSentiment(null);
      }
      if (data.detectedLanguage) {
        setDetectedLanguage(data.detectedLanguage);
      }
      if (data.tags && Array.isArray(data.tags)) {
        setTags(data.tags);
      } else {
        setTags([]);
      }
      
      // Автосохранение сессии в локальный IndexedDB
      try {
        const finalTitle = (exportCustomTitle || 'Голосовая заметка').trim();
        const autoSavedId = await saveSession({
          title: finalTitle,
          timestamp: new Date().toLocaleString('ru-RU', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          }),
          transcript: data.transcript || data.result || '',
          summary: data.summary || data.result || '',
          detailedAnalysis: data.detailedAnalysis || '',
          sentiment: data.sentiment || null,
          detectedLanguage: data.detectedLanguage || '',
          tags: data.tags || [],
          recordingDuration: recordingDuration,
          audioBlob: audioBlob || undefined
        });
        setActiveSessionId(autoSavedId);
        await loadLocalSessions();
        triggerToast("Запись сохранена в локальный архив!", "success");
      } catch (dbErr) {
        console.error("Local auto-save failed in IndexedDB:", dbErr);
      }
      
      if (autoSaveToDrive && !needsAuth && !skipAuth) {
          handleSaveToDrive(true, data.result, data.tags || []);
      }
    } catch (err: any) {
      console.error(err);
      addError(err.message || 'Error occurred while processing. Please check server logs and configuration.', err, '/api/transcribe');
      triggerToast(err.message || 'Error occurred while processing. Please check server logs and configuration.', 'error');
      setProcessingState({ stage: 'idle', progress: 0 });
    } finally {
      setIsProcessing(false);
      setTimeout(() => {
          setProcessingState(prev => prev.stage === 'complete' ? { stage: 'idle', progress: 0 } : prev);
      }, 1000);

      // Clean up temporary chunks from Google Drive if they were uploaded
      if (driveFileIds.length > 0) {
        console.log(`Cleaning up ${driveFileIds.length} temporary file chunks from Google Drive...`);
        for (const fileId of driveFileIds) {
          deleteDriveFile(fileId).catch(deleteErr => {
            console.warn(`Unable to delete temporary Google Drive file ${fileId}:`, deleteErr);
          });
        }
      }
    }
  };

  const toggleSpeechRecognition = () => {
    if (!speechRecognitionRef.current) {
      setCommandFeedback("⚠️ Распознавание речи в браузере не поддерживается в этом фрейме. Попробуйте ввести команду вручную!");
      return;
    }

    if (isListening) {
      speechRecognitionRef.current.stop();
    } else {
      try {
        speechRecognitionRef.current.lang = 'ru-RU';
        speechRecognitionRef.current.start();
      } catch (err) {
        console.error(err);
        speechRecognitionRef.current.stop();
        setTimeout(() => {
          try {
            speechRecognitionRef.current.start();
          } catch (e) {
            setCommandFeedback("⚠️ Голосовой интерфейс занят. Повторите попытку через секунду!");
          }
        }, 200);
      }
    }
  };

  const handleExecuteCommand = async () => {
    const cmd = customCommand.trim().toLowerCase();
    if (!cmd) return;

    setCommandFeedback('');

    // 1. "clear active note" / "clear" / "reset"
    if (cmd.includes('clear active note') || cmd === 'clear' || cmd === 'reset' || cmd.includes('clear note') ||
        cmd.includes('очистить заметку') || cmd === 'очистить' || cmd === 'сброс' || cmd === 'сбросить' || cmd.includes('удалить заметку')) {
      setAudioUrl(null);
      setAudioBlob(null);
      setResult('');
      setTranscript('');
      setSummary('');
      setTags([]);
      setSentiment(null);
      setCustomCommand('');
      setCommandFeedback('✅ Действие: Транскрипция успешно очищена.');
      return;
    }

    // 2. "find [keyword]" or "search [keyword]" or "filter [keyword]"
    const searchMatch = cmd.match(/(?:find|search|filter|найти|искать|фильтр)\s+(?:for\s+)?(.*?)$/i);
    if (searchMatch && searchMatch[1]) {
      const keyword = searchMatch[1].trim();
      setSearchQuery(keyword);
      setCommandFeedback(`🔍 Действие: Поиск в транскрипте по запросу "${keyword}"...`);
      return;
    }

    // 3. "find my last file" / "find files" / "search file"
    if (cmd.includes('find my last file') || cmd.includes('find file') || cmd.includes('my last file') ||
        cmd.includes('найти мой последний файл') || cmd.includes('мой последний файл') || cmd.includes('найти файл')) {
      setSearchQuery('file');
      setCommandFeedback('📁 Действие: Поиск файлов... Применен фильтр «файл». Подключено к Google Диску.');
      return;
    }

    // 4. "select action items" / "action items" / "actions"
    if (cmd.includes('action items') || cmd.includes('actions') || cmd.includes('задачи') || cmd.includes('план действий') || cmd.includes('список задач')) {
      setSummaryType('actionItems');
      setCommandFeedback('📋 Действие: Изменен режим умной сводки на «Задачи».');
      if (audioBlob) {
        setCommandFeedback('📋 Действие: Изменен режим на «Задачи», запуск повторной генерации...');
        setTimeout(() => {
          transcribeAndSummarize();
        }, 800);
      }
      return;
    }

    // 5. "select concise" / "set concise" / "concise" / "bullet points" / "bullets"
    if (cmd.includes('concise') || cmd.includes('bullet points') || cmd.includes('bullets') || cmd.includes('bullet list') ||
        cmd.includes('кратко') || cmd.includes('тезисы') || cmd.includes('список') || cmd.includes('кратке резюме')) {
      setSummaryType('bulletPoints');
      setCommandFeedback('📝 Действие: Изменен режим умной сводки на «Кратко».');
      if (audioBlob) {
        setCommandFeedback('📝 Действие: Изменен режим на «Кратко», запуск повторной генерации...');
        setTimeout(() => {
          transcribeAndSummarize();
        }, 800);
      }
      return;
    }

    // 6. "set full" / "full transcript" / "full" / "transcribe"
    if (cmd.includes('full transcript') || cmd === 'full' || cmd === 'transcription' || cmd === 'transcribe' ||
        cmd.includes('полный транскрипт') || cmd === 'полный' || cmd === 'транскрипция' || cmd === 'транскрипт') {
      setSummaryType('fullTranscript');
      setCommandFeedback('📑 Действие: Изменен режим умной сводки на «Полный транскрипт».');
      if (audioBlob) {
        setCommandFeedback('📑 Действие: Изменен режим на «Полный транскрипт», запуск повторной генерации...');
        setTimeout(() => {
          transcribeAndSummarize();
        }, 800);
      }
      return;
    }

    // 7. "add tag [tag]" / "add keyword [tag]"
    const tagMatch = cmd.match(/(?:add tag|add keyword|tag|добавить тег|добавить ключевое слово|тег|ключевое слово)\s+(.*?)$/i);
    if (tagMatch && tagMatch[1]) {
      const tagValue = tagMatch[1].trim();
      if (tagValue) {
        if (!tags.includes(tagValue)) {
          setTags([...tags, tagValue]);
        }
        setCommandFeedback(`🏷️ Действие: Добавлено ключевое слово "${tagValue}".`);
        setCustomCommand('');
        return;
      }
    }

    // 8. Custom instructions for summarization (like 'Draft a meeting summary' or 'Summarize this note')
    if (cmd.includes('draft') || cmd.includes('summary') || cmd.includes('summarize') || cmd.includes('analyze') || cmd.includes('explain') || cmd.includes('translate') ||
        cmd.includes('составить') || cmd.includes('резюме') || cmd.includes('суммаризировать') || cmd.includes('анализировать') || cmd.includes('объяснить') || cmd.includes('перевести')) {
      if (!audioBlob) {
        setCommandFeedback('⚠️ Команда распознана, но аудиозаметка для обработки не загружена. Сначала запишите или загрузите медиафайл!');
        return;
      }
      setCommandFeedback(`🚀 Запуск пользовательской умной инструкции: "${customCommand}"...`);
      setTimeout(() => {
        transcribeAndSummarize();
      }, 500);
      return;
    }

    // 9. Default custom instruction run
    if (audioBlob) {
      setCommandFeedback(`🚀 Обработка аудио с пользовательской инструкцией: "${customCommand}"...`);
      setTimeout(() => {
        transcribeAndSummarize();
      }, 500);
    } else {
      setCommandFeedback('⚠️ Инструкция зафиксирована. Загрузите или запишите файл, затем нажмите «Выполнить команду», чтобы применить её.');
    }
  };

  const handleTagsChange = (action: 'add' | 'remove', tag?: string) => {
    if (action === 'add' && newTag.trim()) {
      if (!tags.includes(newTag.trim())) {
        setTags([...tags, newTag.trim()]);
      }
      setNewTag('');
    } else if (action === 'remove' && tag) {
      setTags(tags.filter(t => t !== tag));
    }
  };

  const getFullContentForExport = () => {
    const tagString = tags.length > 0 ? `\n\nKeywords: ${tags.join(', ')}` : '';
    return `${result}${tagString}`;
  };

  const handleSaveToDocs = async () => {
    if (!result) return;
    if (!user) {
      triggerToast("Пожалуйста, подключите Google Диск с помощью кнопки в шапке (справа) перед сохранением документов.", "info");
      return;
    }
    setIsSavingDoc(true);
    try {
      const contentToSave = getFullContentForExport();
      const docId = await createGoogleDoc(`Аудиозаметка - Сводка - ${new Date().toLocaleDateString()}`, contentToSave);
      triggerToast(`Документ успешно создан! ID документа: ${docId}`, 'success');
    } catch (err: any) {
      console.error(err);
      addError("Не удалось сохранить в Google Docs", err, "Google Docs API / Documents Create");
      triggerToast("Не удалось сохранить в Google Docs. Убедитесь, что вы предоставили необходимые разрешения.", 'error');
    } finally {
      setIsSavingDoc(false);
    }
  };

  const handleSaveToCalendar = async () => {
    if (!result) return;
    if (!user) {
      triggerToast("Пожалуйста, подключите Google Диск с помощью кнопки в шапке (справа) для интеграции с Google Календарем.", "info");
      return;
    }
    setIsSavingCal(true);
    try {
      const contentToSave = getFullContentForExport();
      await createCalendarEvent("Задачи к исполнению (Aura Voice AI)", contentToSave);
      triggerToast("Событие успешно создано в вашем основном Google Календаре!", 'success');
    } catch (err: any) {
      console.error(err);
      addError("Не удалось сохранить в Google Календарь", err, "Google Calendar API / Events Create");
      triggerToast("Не удалось сохранить в Google Календарь. Убедитесь, что вы предоставили необходимые разрешения.", 'error');
    } finally {
      setIsSavingCal(false);
    }
  };

  const handleSaveToDrive = async (isAuto = false, textToSave = result, tagsToSave = tags) => {
    if (!textToSave) return;
    if (!user) {
      if (!isAuto) {
        triggerToast("Пожалуйста, подключите Google Диск с помощью кнопки в шапке (справа) для сохранения файлов.", "info");
      }
      return;
    }
    setIsSavingDrive(true);
    const tagString = tagsToSave.length > 0 ? `\n\nKeywords: ${tagsToSave.join(', ')}` : '';
    const contentToSave = `${textToSave}${tagString}`;
    const fileTitle = `Аудиозаметка - ${new Date().toLocaleDateString()} - ${new Date().toLocaleTimeString().replace(/:/g, '-')}`;

    try {
      if (!navigator.onLine) {
        throw new Error("offline");
      }
      await saveToDrive(contentToSave, fileTitle);
      if (!isAuto) {
        triggerToast("Файл успешно сохранен на вашем Google Диске!", 'success');
      }
    } catch (err: any) {
      console.error(err);
      if (isAuto || err.message === "offline" || !navigator.onLine) {
        addError("Сохранение на Google Диск отложено (переход в офлайн-очередь)", err, "Google Drive API / Files Create");
        try {
          await addQueuedDriveSync(fileTitle, contentToSave);
          await loadQueuedSyncs();
          triggerToast("Запись добавлена в локальную очередь автосохранения Google Диска!", 'info');
        } catch (queueErr) {
          console.error("Failed to queue drive sync:", queueErr);
          addError("Не удалось поставить в очередь офлайн-синхронизации", queueErr, "IndexedDB QueueSync");
        }
      } else {
        addError("Не удалось сохранить на Google Диск (ошибка авторизации или разрешений)", err, "Google Drive API / Files Create");
        triggerToast("Не удалось сохранить на Google Диск. Убедитесь, что вы предоставили необходимые разрешения.", 'error');
      }
    } finally {
      setIsSavingDrive(false);
    }
  };

  type BlobChunk = Blob; // Type definition within scope

  if (needsAuth && !skipAuth) {
    return (
      <div className="h-screen w-screen bg-[#0A0B0C] flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#151719] rounded-2xl shadow-2xl p-8 space-y-8 text-center text-slate-200 border border-slate-800">
          <div className="mx-auto w-16 h-16 bg-red-600/10 text-red-500 border border-red-500/20 rounded-full flex items-center justify-center mb-6 shadow-[0_0_15px_rgba(220,38,38,0.1)]">
            <Mic className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white uppercase col-span-1">AURA VOICE AI</h1>
          <p className="text-slate-400 text-sm">Войдите в систему для синхронизации транскрипций с вашими Google Документами, Диском и Календарем.</p>
          
          {authError === 'popup-blocked' ? (
            <div className="bg-amber-500/10 text-amber-300 p-4 rounded-xl text-xs border border-amber-500/20 text-left space-y-2 animate-fadeIn">
              <div className="flex gap-2 items-start">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
                <div className="space-y-1">
                  <p className="font-bold uppercase tracking-wider text-[10px]">Всплывающее окно входа заблокировано</p>
                  <p>Браузер заблокировал всплывающее окно авторизации, поскольку это приложение запущено в режиме предварительного просмотра в iframe.</p>
                </div>
              </div>
              <div className="pt-2 border-t border-amber-500/10 space-y-2.5">
                <p className="text-[11px] text-slate-300">Выберите один из следующих вариантов, чтобы продолжить:</p>
                <div className="space-y-2">
                  <a 
                    href={window.location.href} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="block text-center bg-blue-600 hover:bg-blue-500 text-white font-bold py-2.5 px-3 rounded-lg text-xs uppercase tracking-wider transition-colors shadow-lg active:scale-95"
                  >
                    🚀 Открыть приложение в новой вкладке
                  </a>
                  <p className="text-[10px] text-slate-400 text-center">Открытие в новой вкладке полностью обходит ограничения iframe.</p>
                  
                  <div className="relative flex py-1 items-center">
                    <div className="flex-grow border-t border-slate-800"></div>
                    <span className="flex-shrink mx-2 text-slate-500 text-[9px] uppercase font-mono">Или</span>
                    <div className="flex-grow border-t border-slate-800"></div>
                  </div>

                  <button 
                    onClick={handleLoginRedirect}
                    disabled={isRedirectLoading}
                    className="w-full text-center bg-slate-800 hover:bg-slate-700 disabled:bg-slate-900 border border-slate-700 text-slate-200 font-bold py-2.5 px-3 rounded-lg text-xs uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5 active:scale-95"
                  >
                    {isRedirectLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : '🔄 Войти через перенаправление'}
                  </button>
                  <p className="text-[10px] text-slate-400 text-center">Перенаправляет текущую страницу в Google для безопасного входа.</p>
                </div>
              </div>
            </div>
          ) : authError ? (
            <div className="bg-red-500/10 text-red-400 p-4 rounded-xl text-xs border border-red-500/20 text-left flex gap-2 items-start justify-between">
              <div className="flex gap-2 items-start">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
                <p>{authError}</p>
              </div>
              <button onClick={() => setAuthError(null)} className="text-slate-400 hover:text-white shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div className="bg-[#1E2024] text-slate-300 p-4 rounded-xl text-xs border border-slate-700 shadow-inner">
              <div className="flex gap-2 items-start text-left">
                 <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-blue-500" />
                 <p>Примечание: Поскольку это приложение предварительного просмотра AI Studio, перед началом работы необходимо настроить Firebase Auth для входа через Google.</p>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <button 
              onClick={handleLogin}
              disabled={isLoggingIn || isRedirectLoading}
              className="w-full flex items-center justify-center gap-3 bg-white border border-transparent rounded-full px-6 py-3 text-xs font-bold text-black hover:bg-slate-200 transition-colors shadow-sm disabled:opacity-50 uppercase tracking-widest"
            >
              {isLoggingIn ? <Loader2 className="w-5 h-5 animate-spin p-0.5" /> : (
                <svg width="20" height="20" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                  <path fill="none" d="M0 0h48v48H0z"></path>
                </svg>
              )}
              Войти с помощью Google
            </button>
            <button 
              onClick={() => setSkipAuth(true)}
              className="w-full text-xs font-bold text-slate-400 hover:text-slate-200 transition-colors uppercase tracking-widest py-2"
            >
              Пропустить входить в систему
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (urlShareId) {
    return (
      <div className="min-h-screen w-full bg-[#0A0B0C] text-slate-100 flex flex-col justify-start items-center p-4 sm:p-8 font-sans selection:bg-purple-500/30 overflow-y-auto">
        <div className="w-full max-w-4xl bg-[#111214] border border-slate-800 rounded-3xl p-6 sm:p-10 shadow-2xl flex flex-col gap-6 relative overflow-hidden my-auto animate-fadeIn">
          {/* Decorative backdrop glow */}
          <div className="absolute -top-40 -left-40 w-80 h-80 rounded-full bg-purple-500/10 blur-[100px] pointer-events-none" />
          <div className="absolute -bottom-40 -right-40 w-80 h-80 rounded-full bg-blue-500/10 blur-[100px] pointer-events-none" />

          {/* Top Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 pb-6 border-b border-slate-800 z-10">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-purple-500/20 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-purple-400" />
              </div>
              <div>
                <h1 className="text-sm font-semibold tracking-wide text-slate-300 uppercase">Aura Voice AI</h1>
                <p className="text-[10px] text-slate-500 uppercase font-mono tracking-widest">Share Note Portal</p>
              </div>
            </div>
            <a
              href={`${window.location.origin}${window.location.pathname}`}
              className="text-[10px] px-3.5 py-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-bold rounded-xl transition-all shadow-md uppercase tracking-wider flex items-center gap-1.5 animate-fadeIn"
            >
              <Mic className="w-3.5 h-3.5" />
              Создать свою заметку
            </a>
          </div>

          {isLoadingSharedNote ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <Loader2 className="w-10 h-10 text-purple-500 animate-spin" />
              <p className="text-xs text-slate-400 uppercase font-mono tracking-wider">Загрузка общей аудиозаметки...</p>
            </div>
          ) : sharedNoteError ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
              <AlertCircle className="w-12 h-12 text-red-400" />
              <div className="space-y-1">
                <p className="text-sm font-bold text-slate-300 uppercase tracking-wide">Заметка недоступна</p>
                <p className="text-xs text-slate-500 max-w-md">{sharedNoteError}</p>
              </div>
              <a
                href={`${window.location.origin}${window.location.pathname}`}
                className="mt-2 text-xs bg-[#1E2024] hover:bg-slate-800 text-slate-300 border border-slate-700 rounded-xl px-4 py-2 font-bold transition-all uppercase tracking-wider"
              >
                Вернуться на главную
              </a>
            </div>
          ) : sharedNote ? (
            <div className="space-y-6 z-10">
              {/* Note Metadata */}
              <div className="space-y-2">
                <h2 className="text-2xl sm:text-3xl font-sans tracking-tight font-bold text-white leading-tight">
                  {sharedNote.title || 'Безымянная заметка'}
                </h2>
                <div className="flex flex-wrap items-center gap-3 text-slate-400 text-xs font-mono">
                  {sharedNote.createdAt && (
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5 text-slate-500" />
                      {new Date(sharedNote.createdAt.seconds * 1000).toLocaleString('ru-RU', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </span>
                  )}
                  {sharedNote.detectedLanguage && (
                    <span className="bg-slate-800 text-slate-300 px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider">
                      Язык: {sharedNote.detectedLanguage}
                    </span>
                  )}
                </div>
              </div>

              {/* Keyword tags */}
              {sharedNote.tags && sharedNote.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {sharedNote.tags.map((tag: string) => (
                    <span key={tag} className="text-[10px] bg-slate-900 border border-slate-800 text-purple-400 px-2.5 py-0.5 rounded font-medium">
                      #{tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Layout Columns / Content sections */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-8 pt-4 animate-fadeIn">
                {/* Detailed Summary / Structured note section */}
                <div className="md:col-span-7 space-y-6">
                  <div>
                    <h3 className="text-xs font-bold text-purple-400 uppercase tracking-widest font-mono mb-3 flex items-center gap-1.5 border-b border-slate-800/40 pb-1">
                      <Sparkles className="w-3.5 h-3.5" /> Умная сводка
                    </h3>
                    <div className="bg-[#151719] border border-slate-800/40 rounded-2xl p-5 md:p-6 text-slate-300 text-sm leading-relaxed font-sans prose prose-invert">
                      <Markdown remarkPlugins={[remarkGfm]}>
                        {sharedNote.summary || '*Сводка отсутствует*'}
                      </Markdown>
                    </div>
                  </div>

                  {sharedNote.detailedAnalysis && (
                    <div>
                      <h3 className="text-xs font-bold text-blue-400 uppercase tracking-widest font-mono mb-3 flex items-center gap-1.5 border-b border-slate-800/40 pb-1">
                        <FileText className="w-3.5 h-3.5" /> Подробный анализ
                      </h3>
                      <div className="bg-[#151719] border border-slate-800/40 rounded-2xl p-5 md:p-6 text-slate-300 text-sm leading-relaxed font-sans prose prose-invert">
                        <Markdown remarkPlugins={[remarkGfm]}>
                          {sharedNote.detailedAnalysis}
                        </Markdown>
                      </div>
                    </div>
                  )}
                </div>

                {/* Raw Transcript Column */}
                <div className="md:col-span-5 space-y-6">
                  <div>
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono mb-3 flex items-center gap-1.5 border-b border-slate-800/40 pb-1">
                      <Mic className="w-3.5 h-3.5" /> Полный транскрипт
                    </h3>
                    <div className="bg-[#151719]/50 border border-slate-800/20 max-h-[420px] overflow-y-auto rounded-2xl p-5 text-xs font-mono leading-relaxed text-slate-400 whitespace-pre-wrap flex flex-col gap-2 scrollbar-thin">
                      {sharedNote.transcript || '*Транскрипт пуст*'}
                    </div>
                  </div>

                  {sharedNote.sentiment && (
                    <div className="bg-gradient-to-br from-[#1E2024] to-[#151719] border border-slate-800 rounded-2xl p-5 space-y-3">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">Анализ тональности</p>
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{sharedNote.sentiment.emoji || '😐'}</span>
                        <div>
                          <p className="text-xs font-bold text-white uppercase tracking-wider">{sharedNote.sentiment.label || 'Нейтральный'}</p>
                          <p className="text-[10px] text-slate-500 font-mono">Тональность высказывания</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Quick action buttons */}
              <div className="flex flex-wrap justify-end gap-3 pt-6 border-t border-slate-800">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(
                      `=== ${sharedNote.title} ===\n\n[УМНАЯ СВОДКА]\n${sharedNote.summary}\n\n[ПОЛНЫЙ ТРАНСКРИПТ]\n${sharedNote.transcript}`
                    );
                    triggerToast("Весь контент заметки успешно скопирован в буфер обмена!", "success");
                  }}
                  className="text-xs bg-[#1E2024] hover:bg-slate-800 border border-slate-700 rounded-xl px-4 py-2 text-slate-300 font-bold transition-all uppercase tracking-wider flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5 text-slate-400" /> Копировать все
                </button>
              </div>
            </div>
          ) : null}

          {/* Brand footer */}
          <div className="mt-8 pt-4 border-t border-slate-800/40 text-center text-[9px] text-slate-600 font-mono tracking-widest uppercase">
            Aura Voice AI — Read-Only Voice Note Viewer
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-[#0A0B0C] text-slate-200 font-sans p-4 sm:p-6 flex flex-col overflow-hidden">
      <header className="flex justify-between items-center mb-6 sm:mb-8 shrink-0 relative z-10 max-w-[1400px] w-full mx-auto">
        <div className="flex items-center gap-3">
           <div className={`w-10 h-10 ${isRecording ? (isPaused ? 'bg-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.4)]' : 'bg-red-600 shadow-[0_0_15px_rgba(220,38,38,0.4)]') : 'bg-slate-800'} rounded-full flex items-center justify-center transition-colors`}>
            {isRecording ? (isPaused ? <Pause className="text-white w-4 h-4"/> : <div className="w-4 h-4 bg-white rounded-full animate-pulse"></div>) : <Mic className="text-white w-5 h-5"/>}
          </div>
          <div>
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-white uppercase">AURA VOICE AI</h1>
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-medium hidden sm:block">Профессиональный модуль транскрипции v2.4</p>
          </div>
        </div>
        <div className="flex gap-4 items-center">
          <div className="hidden sm:flex items-center gap-2 bg-[#151719] border border-slate-800 px-4 py-2 rounded-full">
            <div className="flex gap-2 mr-2 border-r border-slate-700 pr-4 items-center">
              <span className={`text-[10px] font-bold ${detectedLanguage ? 'text-white' : 'text-slate-500'}`}>ЯЗЫК: {detectedLanguage ? detectedLanguage.toUpperCase() : 'АВТО'}</span>
            </div>
            <div className="w-2 h-2 bg-green-500 rounded-full"></div>
            <span className="text-xs font-mono text-slate-400 tracking-wider">СИНХРОНИЗАЦИЯ: GOOGLE CLOUD</span>
          </div>
          <button 
            onClick={() => setIsHistoryOpen(true)} 
            className="bg-[#1E2024] hover:bg-slate-800 text-white px-4 py-2 rounded-full text-xs font-bold transition-all flex items-center gap-2 border border-slate-700 relative hover:border-slate-600 cursor-pointer"
          >
            <History className="w-4 h-4 text-blue-400" />
            <span className="hidden sm:inline uppercase">ИСТОРИЯ</span>
            {savedSessions.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-blue-600 text-[8px] font-bold text-white px-1.5 py-0.5 rounded-full flex items-center justify-center min-w-[16px] h-[16px]">
                {savedSessions.length}
              </span>
            )}
          </button>

          <button 
            onClick={() => setIsErrorLogOpen(true)} 
            className={`px-4 py-2 rounded-full text-xs font-bold transition-all flex items-center gap-2 border cursor-pointer relative ${errorLogs.length > 0 ? 'bg-red-500/10 hover:bg-red-500/20 border-red-500/30 text-red-400 animate-pulse-subtle' : 'bg-[#1E2024] hover:bg-slate-800 text-slate-400 border-slate-700'}`}
          >
            <AlertCircle className={`w-4 h-4 ${errorLogs.length > 0 ? 'text-red-400' : ''}`} />
            <span className="hidden sm:inline uppercase">ЛОГ ОШИБОК</span>
            {errorLogs.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-red-600 text-[8px] font-bold text-white px-1.5 py-0.5 rounded-full flex items-center justify-center min-w-[16px] h-[16px]">
                {errorLogs.length}
              </span>
            )}
          </button>
          
          {user ? (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-400 font-mono hidden md:inline truncate max-w-[150px]" title={user.email || ""}>
                {user.email || "Подключено"}
              </span>
              <button 
                onClick={handleLogout} 
                className="bg-red-950/40 hover:bg-red-900/40 text-red-400 border border-red-500/30 px-3 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap"
                title="Отключить Google Диск"
              >
                <LogOut className="w-4 h-4 shrink-0" />
                <span className="hidden sm:inline uppercase">ОТКЛЮЧИТЬ</span>
              </button>
            </div>
          ) : (
            <button 
              onClick={handleLogin} 
              disabled={isLoggingIn}
              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-full text-xs font-bold transition-all flex items-center gap-2 shadow-[0_0_12px_rgba(37,99,235,0.2)] cursor-pointer whitespace-nowrap"
            >
              {isLoggingIn ? (
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              ) : (
                <Plus className="w-4 h-4 shrink-0" />
              )}
              <span className="uppercase">ПОДКЛЮЧИТЬ GOOGLE ДИСК</span>
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0 overflow-y-auto lg:overflow-hidden pb-6 lg:pb-0 max-w-[1400px] w-full mx-auto align-top">
        
        <section className="col-span-1 lg:col-span-7 flex flex-col gap-6 min-h-0 shrink-0 lg:shrink overflow-y-auto lg:overflow-y-auto custom-scrollbar pr-1 lg:pr-2">
           {/* Record / Upload controls */}
           <div className="bg-[#151719] border border-slate-800 rounded-2xl p-6 flex flex-col shadow-inner shrink-0 relative">
              <div className="flex justify-between items-center mb-4">
                <span className="text-[10px] text-slate-500 uppercase tracking-widest">Поток ввода</span>
                {isRecording && <span className={`text-[10px] font-mono ${isPaused ? 'text-yellow-500' : 'text-red-500 animate-pulse'}`}>{isPaused ? 'ПАУЗА' : 'ИДЕТ ЗАПИСЬ...'} {formatDuration(recordingDuration)}</span>}
              </div>
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex-1 flex gap-2">
                  <button
                    onClick={isRecording ? stopRecording : startRecording}
                    className={`flex-1 flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-xs transition-all tracking-wide ${
                      isRecording 
                        ? 'bg-red-600 text-white shadow-[0_0_15px_rgba(220,38,38,0.4)]' 
                        : 'bg-white text-black hover:bg-slate-200'
                    }`}
                  >
                    {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    {isRecording ? 'ОСТАНОВИТЬ ЗАПИСЬ' : 'НАЧАТЬ ЗАПИСЬ'}
                  </button>
                  {isRecording && (
                    <button
                      onClick={togglePauseResume}
                      className="flex items-center justify-center gap-2 px-4 rounded-xl font-bold text-xs bg-[#1E2024] border border-slate-700 text-white transition-all tracking-wide hover:bg-slate-800"
                    >
                      {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                      {isPaused ? 'ПРОДОЛЖИТЬ' : 'ПАУЗА'}
                    </button>
                  )}
                </div>

                <label className="flex-1 flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-xs bg-[#1E2024] border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors cursor-pointer tracking-wide">
                  <Upload className="w-4 h-4" />
                  ЗАГРУЗИТЬ ФАЙЛ
                  <input type="file" accept="audio/*,video/*" className="hidden" onChange={handleFileUpload} />
                </label>
              </div>
              
              {isRecording && (
                <div className="mt-4 bg-[#0A0B0C] rounded-xl overflow-hidden h-16 w-full relative border border-slate-800">
                  <canvas ref={canvasRef} className="w-full h-full absolute inset-0 z-10"></canvas>
                  <div className="absolute inset-x-0 top-1/2 h-[1px] bg-red-500/20 z-0"></div>
                </div>
              )}

              {audioUrl && !isRecording && (
                <div className="mt-4 bg-[#1E2024] p-4 rounded-xl border border-slate-700 space-y-4 shadow-sm">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <audio ref={audioRef} src={audioUrl} controls className="w-full h-8" onLoadedMetadata={(e) => setAudioDuration(e.currentTarget.duration)} />
                    </div>
                    <button onClick={() => { setAudioUrl(null); setAudioBlob(null); setResult(''); setTranscript(''); setSummary(''); setSentiment(null); setTrimStart(0); setTrimEnd(0); setAudioDuration(0); }} className="text-[10px] uppercase font-bold text-red-400 hover:text-red-300 tracking-wider">ОЧИСТИТЬ</button>
                  </div>
                  
                  {audioDuration > 0 && (
                    <div className="space-y-4">
                      {/* Visual Range Slider component */}
                      <AudioTrimSlider 
                        audioDuration={audioDuration}
                        trimStart={trimStart}
                        setTrimStart={setTrimStart}
                        trimEnd={trimEnd}
                        setTrimEnd={setTrimEnd}
                        onSmartTrim={handleSmartTrim}
                      />

                      {/* Precise timing adjustments */}
                      <div className="grid grid-cols-2 gap-4 text-xs">
                        <div className="flex flex-col gap-1.5 p-3 bg-slate-900/40 border border-slate-850 rounded-xl">
                          <label className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">Точное начало (сек)</label>
                          <div className="flex gap-2">
                            <input 
                              type="number" 
                              min="0" 
                              max={trimEnd > 0 ? trimEnd - 0.1 : audioDuration} 
                              step="0.1" 
                              value={trimStart || 0} 
                              onChange={e => setTrimStart(parseFloat(e.target.value) || 0)} 
                              className="bg-[#0A0B0C] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-slate-200 outline-none w-full font-mono text-sm focus:border-blue-500/50" 
                              placeholder="0" 
                            />
                          </div>
                        </div>
                        <div className="flex flex-col gap-1.5 p-3 bg-slate-900/40 border border-slate-850 rounded-xl">
                          <label className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">Точный конец (сек)</label>
                          <div className="flex gap-2">
                            <input 
                              type="number" 
                              min={trimStart > 0 ? trimStart + 0.1 : 0.1} 
                              max={audioDuration} 
                              step="0.1" 
                              value={trimEnd || parseFloat(audioDuration.toFixed(1))} 
                              onChange={e => setTrimEnd(parseFloat(e.target.value) || 0)} 
                              className="bg-[#0A0B0C] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-slate-200 outline-none w-full font-mono text-sm focus:border-purple-500/50" 
                              placeholder={audioDuration.toFixed(1)} 
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Крупная кнопка Транскрибировать */}
                  <button
                    onClick={transcribeAndSummarize}
                    disabled={isProcessing}
                    className="w-full py-4 bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:via-indigo-500 hover:to-purple-500 text-white text-sm font-bold rounded-xl transition-all shadow-[0_4px_22px_rgba(79,70,229,0.35)] hover:shadow-[0_4px_32px_rgba(79,70,229,0.55)] active:scale-[0.98] flex items-center justify-center gap-3 disabled:opacity-50 tracking-wider uppercase border border-indigo-500/30"
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin text-white" />
                        <span>ПОДГОТОВКА И ОБРАБОТКА...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-5 h-5 text-yellow-300 animate-pulse" />
                        <span>Транскрибировать аудио с Aura AI</span>
                      </>
                    )}
                  </button>
                </div>
              )}
           </div>
           
           {/* Result feed */}
           <div className="bg-[#151719] border border-slate-800 rounded-2xl p-6 flex flex-col lg:flex-1 shrink-0 lg:min-h-0 overflow-hidden shadow-inner">
              <div className="flex flex-col gap-4 mb-4 shrink-0">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wide">ИНТЕЛЛЕКТУАЛЬНЫЙ ТРАНСКРИПТ</h3>
                  {isProcessing && <span className="text-[10px] text-green-500 font-mono flex items-center gap-2 tracking-wide"><Loader2 className="w-3 h-3 animate-spin"/> ОБРАБОТКА...</span>}
                </div>
                {result && !isProcessing && (
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Search className="h-4 w-4 text-slate-500" />
                    </div>
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Поиск в тексте..."
                      className="w-full bg-[#1E2024] border border-slate-700 rounded-lg pl-10 pr-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-slate-500 transition-colors"
                    />
                  </div>
                )}
              </div>
              <div className={`flex-1 flex flex-col min-h-0 ${result && !isProcessing ? 'overflow-y-auto lg:overflow-hidden' : 'overflow-y-auto pr-2 custom-scrollbar'}`}>
                {isProcessing ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-12 px-6 max-w-md mx-auto w-full gap-6 animate-fadeIn">
                    {/* Live Aura AI Pulse Animation */}
                    <div className="flex flex-col items-center justify-center bg-[#1E2024]/40 border border-slate-800 rounded-2xl p-6 w-full gap-3 shadow-inner">
                      <div className="flex items-end gap-1.5 h-12 justify-center px-4">
                        <div className="w-1.5 h-6 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms', animationDuration: '0.8s' }} />
                        <div className="w-1.5 h-10 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '150ms', animationDuration: '0.9s' }} />
                        <div className="w-1.5 h-12 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '300ms', animationDuration: '0.7s' }} />
                        <div className="w-1.5 h-8 bg-pink-500 rounded-full animate-bounce" style={{ animationDelay: '450ms', animationDuration: '1.0s' }} />
                        <div className="w-1.5 h-5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '600ms', animationDuration: '0.82s' }} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 bg-indigo-500 rounded-full animate-ping" />
                        <span className="text-[10px] text-indigo-400 font-mono tracking-widest uppercase font-bold">ОБРАБОТКА ПОТОКА AURA VOICE AI</span>
                      </div>
                    </div>

                    {/* Step-by-Step Flow */}
                    <div className="w-full space-y-4">
                      {/* Step 1: Uploading */}
                      <div className={`p-3.5 rounded-xl border transition-all duration-300 ${
                        processingState.stage === 'uploading' 
                          ? 'bg-blue-500/5 border-blue-500/20 shadow-md' 
                          : (processingState.stage !== 'idle' ? 'bg-green-500/5 border-green-500/20' : 'bg-slate-900/40 border-slate-800')
                      }`}>
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2.5">
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold leading-none ${
                               processingState.stage === 'uploading' 
                                 ? 'bg-blue-500 text-white animate-pulse' 
                                 : (processingState.stage !== 'idle' ? 'bg-green-500/20 text-green-400' : 'bg-slate-800 text-slate-500')
                            }`}>
                              {processingState.stage !== 'idle' && processingState.stage !== 'uploading' ? (
                                <Check className="w-3.5 h-3.5" />
                              ) : (
                                <span>1</span>
                              )}
                            </div>
                            <span className={`text-[11px] font-bold tracking-wide transition-colors ${
                              processingState.stage === 'uploading' 
                                ? 'text-white' 
                                : (processingState.stage !== 'idle' ? 'text-green-400' : 'text-slate-500')
                            }`}>
                              Загрузка медиафайла на сервер
                            </span>
                          </div>
                          <span className={`text-[10px] font-mono font-bold ${
                            processingState.stage === 'uploading' ? 'text-blue-400' : (processingState.stage !== 'idle' ? 'text-green-400 font-medium' : 'text-slate-600')
                          }`}>
                            {processingState.stage === 'uploading' ? Math.round(processingState.progress) + '%' : (processingState.stage !== 'idle' ? 'ГОТОВО' : 'ОЖИДАНИЕ')}
                          </span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                          <div 
                            className={`h-full transition-all duration-300 ease-out ${processingState.stage === 'uploading' ? 'bg-blue-500' : 'bg-green-500'}`}
                            style={{ width: processingState.stage === 'uploading' ? `${processingState.progress}%` : (processingState.stage !== 'idle' ? '100%' : '0%') }}
                          />
                        </div>
                      </div>

                      {/* Step 2: Transcribing */}
                      <div className={`p-3.5 rounded-xl border transition-all duration-300 ${
                        processingState.stage === 'processing' 
                          ? 'bg-purple-500/5 border-purple-500/20 shadow-md' 
                          : (processingState.stage === 'summarizing' || processingState.stage === 'complete' ? 'bg-green-500/5 border-green-500/20' : 'bg-slate-900/40 border-slate-800')
                      }`}>
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2.5">
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold leading-none ${
                               processingState.stage === 'processing' 
                                 ? 'bg-purple-500 text-white animate-pulse' 
                                 : (processingState.stage === 'summarizing' || processingState.stage === 'complete' ? 'bg-green-500/20 text-green-400' : 'bg-slate-800 text-slate-500')
                            }`}>
                              {(processingState.stage === 'summarizing' || processingState.stage === 'complete') ? (
                                <Check className="w-3.5 h-3.5" />
                              ) : (
                                <span>2</span>
                              )}
                            </div>
                            <span className={`text-[11px] font-bold tracking-wide transition-colors ${
                              processingState.stage === 'processing' 
                                ? 'text-white' 
                                : (processingState.stage === 'summarizing' || processingState.stage === 'complete' ? 'text-green-400' : 'text-slate-500')
                            }`}>
                              Распознавание и разделение спикеров
                            </span>
                          </div>
                          <span className={`text-[10px] font-mono font-bold ${
                            processingState.stage === 'processing' ? 'text-purple-400' : (processingState.stage === 'summarizing' || processingState.stage === 'complete' ? 'text-green-400 font-medium' : 'text-slate-600')
                          }`}>
                            {processingState.stage === 'processing' ? Math.round(processingState.progress) + '%' : (processingState.stage === 'summarizing' || processingState.stage === 'complete' ? 'ГОТОВО' : 'ОЖИДАНИЕ')}
                          </span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                          <div 
                            className={`h-full transition-all duration-300 ease-out ${processingState.stage === 'processing' ? 'bg-purple-500' : (processingState.stage === 'summarizing' || processingState.stage === 'complete' ? 'bg-green-500' : 'bg-slate-700')}`}
                            style={{ width: processingState.stage === 'processing' ? `${processingState.progress}%` : (processingState.stage === 'summarizing' || processingState.stage === 'complete' ? '100%' : '0%') }}
                          />
                        </div>
                      </div>

                      {/* Step 3: Summarization */}
                      <div className={`p-3.5 rounded-xl border transition-all duration-300 ${
                        processingState.stage === 'summarizing' 
                          ? 'bg-yellow-500/5 border-yellow-500/20 shadow-md' 
                          : (processingState.stage === 'complete' ? 'bg-green-500/5 border-green-500/20' : 'bg-slate-900/40 border-slate-800')
                      }`}>
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2.5">
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold leading-none ${
                               processingState.stage === 'summarizing' 
                                 ? 'bg-yellow-500 text-black animate-pulse' 
                                 : (processingState.stage === 'complete' ? 'bg-green-500/20 text-green-400' : 'bg-slate-800 text-slate-500')
                            }`}>
                              {processingState.stage === 'complete' ? (
                                <Check className="w-3.5 h-3.5" />
                              ) : (
                                <span>3</span>
                              )}
                            </div>
                            <span className={`text-[11px] font-bold tracking-wide transition-colors ${
                              processingState.stage === 'summarizing' 
                                ? 'text-white' 
                                : (processingState.stage === 'complete' ? 'text-green-400' : 'text-slate-500')
                            }`}>
                              Сводка и аналитика ИИ Gemini
                            </span>
                          </div>
                          <span className={`text-[10px] font-mono font-bold ${
                            processingState.stage === 'summarizing' ? 'text-yellow-400' : (processingState.stage === 'complete' ? 'text-green-400 font-medium' : 'text-slate-600')
                          }`}>
                            {processingState.stage === 'summarizing' ? Math.round(processingState.progress) + '%' : (processingState.stage === 'complete' ? 'ГОТОВО' : 'ОЖИДАНИЕ')}
                          </span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                          <div 
                            className={`h-full transition-all duration-300 ease-out ${processingState.stage === 'summarizing' ? 'bg-yellow-500' : (processingState.stage === 'complete' ? 'bg-green-500' : 'bg-slate-700')}`}
                            style={{ width: processingState.stage === 'summarizing' ? `${processingState.progress}%` : (processingState.stage === 'complete' ? '100%' : '0%') }}
                          />
                        </div>
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-500 text-center max-w-sm leading-relaxed tracking-wide mt-2">
                      Применяются передовые модели ИИ Google Gemini для распознавания речи, дифференциации спикеров по голосу и формирования детальной аналитики.
                    </p>
                  </div>
                ) : false ? (
                  <div />
                ) : result ? (
                   <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-6 min-h-0 h-full pb-2">
                     {/* Left Pane: Raw Transcript */}
                     <div className="flex flex-col bg-[#1A1C1E]/30 border border-slate-800/80 rounded-xl p-4 lg:p-5 h-[400px] lg:h-full overflow-hidden">
                       <div className="flex justify-between items-center mb-3 pb-2 border-b border-slate-800/50 shrink-0">
                         <h4 className="text-xs font-bold text-blue-400 uppercase tracking-wider flex items-center gap-1.5">
                           <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse"></span>
                           Распознанный текст
                         </h4>
                         <span className="text-[9px] font-mono text-slate-500 tracking-wide uppercase">
                           Оригинальный аудиоряд
                         </span>
                       </div>
                       <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar prose prose-invert prose-slate max-w-none text-xs text-slate-300 prose-headings:text-sm prose-headings:text-white prose-a:text-blue-400 gap-y-2">
                         <Markdown 
                           remarkPlugins={[remarkGfm]}
                           components={{
                             p: ({ children }: any) => <p>{highlightChildren(children, searchQuery)}</p>,
                             li: ({ children }: any) => <li>{highlightChildren(children, searchQuery)}</li>,
                             h1: ({ children }: any) => <h1>{highlightChildren(children, searchQuery)}</h1>,
                             h2: ({ children }: any) => <h2>{highlightChildren(children, searchQuery)}</h2>,
                             h3: ({ children }: any) => <h3>{highlightChildren(children, searchQuery)}</h3>,
                             h4: ({ children }: any) => <h4>{highlightChildren(children, searchQuery)}</h4>,
                             span: ({ children }: any) => <span>{highlightChildren(children, searchQuery)}</span>,
                             td: ({ children }: any) => <td>{highlightChildren(children, searchQuery)}</td>,
                           }}
                         >
                           {transcript}
                         </Markdown>
                       </div>
                     </div>

                     {/* Right Pane: AI-Generated Summary */}
                     <div className="flex flex-col bg-[#1A1C1E]/30 border border-slate-800/80 rounded-xl p-4 lg:p-5 h-[400px] lg:h-full overflow-hidden">
                       <div className="flex justify-between items-center mb-3 pb-2 border-b border-slate-800/50 shrink-0">
                         <h4 className="text-xs font-bold text-purple-400 uppercase tracking-wider flex items-center gap-1.5">
                           <span className="w-1.5 h-1.5 bg-purple-500 rounded-full"></span>
                           Обзор ИИ и Сводка
                         </h4>
                         <span className="text-[9px] font-mono text-slate-500 tracking-wide uppercase">
                           <div className="flex bg-[#1E2024]/90 p-0.5 rounded-lg border border-slate-800/80 items-center justify-center -my-1 shrink-0 select-none">
                              <button
                                onClick={() => setInsightsTab('summarized')}
                                className={`px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider rounded-md transition-all ${
                                  insightsTab === 'summarized'
                                    ? 'bg-purple-600/90 text-white shadow-md shadow-purple-500/10'
                                    : 'text-slate-400 hover:text-slate-200'
                                }`}
                              >
                                Краткий обзор
                              </button>
                              <button
                                onClick={() => setInsightsTab('detailed')}
                                className={`px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider rounded-md transition-all ${
                                  insightsTab === 'detailed'
                                    ? 'bg-purple-600/90 text-white shadow-md shadow-purple-500/10'
                                    : 'text-slate-400 hover:text-slate-200'
                                }`}
                              >
                                Детальный анализ
                              </button>
                            </div>
                         </span>
                       </div>
                       <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar prose prose-invert prose-slate max-w-none text-xs text-slate-300 prose-headings:text-sm prose-headings:text-white prose-a:text-blue-400 gap-y-2">
                          {/* Sentiment Analysis block */}
                          {sentiment && (
                            <div className="mb-4 shrink-0 flex items-center justify-between gap-3 bg-[#1E2024]/85 border border-slate-800 rounded-xl p-3 animate-fadeIn shadow-sm not-prose">
                              <div className="flex items-center gap-3">
                                <span className="text-2xl leading-none select-none" role="img" aria-label="sentiment emoji">
                                  {sentiment.emoji || (sentiment.label === 'positive' ? '😊' : sentiment.label === 'negative' ? '😢' : '😐')}
                                </span>
                                <div>
                                  <div className="flex items-center flex-wrap gap-2 text-left">
                                    <span className="text-[11px] font-bold text-white uppercase tracking-wider">
                                      Тональность: <span className={
                                        sentiment.label === 'positive' ? 'text-emerald-400' :
                                        sentiment.label === 'negative' ? 'text-rose-400' : 'text-amber-400'
                                      }>{sentiment.label === 'positive' ? 'ПОЛОЖИТЕЛЬНАЯ' : sentiment.label === 'negative' ? 'ОТРИЦАТЕЛЬНАЯ' : 'НЕЙТРАЛЬНАЯ'}</span>
                                    </span>
                                    <span className="text-[9px] bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded font-mono text-slate-300">
                                      Оценка: {sentiment.score > 0 ? "+" + sentiment.score.toFixed(2) : sentiment.score.toFixed(2)}
                                    </span>
                                  </div>
                                  {sentiment.explanation && (
                                    <p className="text-[10px] text-slate-400 mt-1 leading-normal italic text-left">
                                      "{sentiment.explanation}"
                                    </p>
                                  )}
                                </div>
                              </div>

                              {/* Mini visual gauge */}
                              <div className="hidden sm:flex flex-col items-center gap-1 w-20 shrink-0">
                                <div className="w-full h-1.5 bg-slate-900/40 rounded-full overflow-hidden border border-slate-800 relative">
                                  <div 
                                    className={`h-full rounded-full transition-all duration-1000 ${
                                      sentiment.label === 'positive' ? 'bg-emerald-500' :
                                      sentiment.label === 'negative' ? 'bg-rose-500' : 'bg-amber-500'
                                    }`}
                                    style={{ width: `${Math.min(100, Math.max(0, (sentiment.score + 1) * 50))}%` }}
                                  />
                                </div>
                                <span className="text-[8px] font-mono text-slate-500 uppercase tracking-widest text-center animate-pulse">
                                  {sentiment.score >= 0.25 ? 'Положительный' : sentiment.score <= -0.25 ? 'Отрицательный' : 'Нейтральный'}
                                </span>
                              </div>
                            </div>
                          )}

                         <Markdown 
                           remarkPlugins={[remarkGfm]}
                           components={{
                             p: ({ children }: any) => <p>{highlightChildren(children, searchQuery)}</p>,
                             li: ({ children }: any) => <li>{highlightChildren(children, searchQuery)}</li>,
                             h1: ({ children }: any) => <h1>{highlightChildren(children, searchQuery)}</h1>,
                             h2: ({ children }: any) => <h2>{highlightChildren(children, searchQuery)}</h2>,
                             h3: ({ children }: any) => <h3>{highlightChildren(children, searchQuery)}</h3>,
                             h4: ({ children }: any) => <h4>{highlightChildren(children, searchQuery)}</h4>,
                             span: ({ children }: any) => <span>{highlightChildren(children, searchQuery)}</span>,
                             td: ({ children }: any) => <td>{highlightChildren(children, searchQuery)}</td>,
                           }}
                         >
                           {insightsTab === 'summarized' ? summary : getDetailedAnalysisFallback()}
                         </Markdown>
                       </div>
                     </div>
                   </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-slate-700 gap-4 py-12 lg:py-0">
                    <Mic className="w-8 h-8 opacity-50"/>
                    <p className="text-xs uppercase tracking-widest font-medium opacity-50">Канал транскрипции неактивен</p>
                  </div>
                )}
              </div>
           </div>
        </section>

        <section className="col-span-1 lg:col-span-5 flex flex-col gap-6 min-h-0 shrink-0 lg:shrink overflow-y-auto lg:overflow-y-auto custom-scrollbar pr-1 lg:pr-2">
            {/* Summarization Tools */}
            <div className="bg-[#1E2024] border border-slate-700 rounded-2xl p-6 flex flex-col gap-4 shrink-0 shadow-lg">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
                <h3 className="text-sm font-bold text-white tracking-wide uppercase">РЕЖИМЫ УМНОЙ СВОДКИ</h3>
                <div className="flex gap-1 overflow-x-auto custom-scrollbar pb-2 sm:pb-0">
                  {(['bulletPoints', 'actionItems', 'fullTranscript'] as const).map(type => (
                    <button
                      key={type}
                      onClick={() => setSummaryType(type)}
                      className={`px-3 py-1 text-[10px] font-bold rounded-md whitespace-nowrap transition-colors uppercase tracking-wider ${
                        summaryType === type 
                          ? 'bg-blue-600 text-white' 
                          : 'bg-[#2D3035] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {type === 'bulletPoints' ? 'КРАТКО' : type === 'actionItems' ? 'ЗАДАЧИ' : 'ПОЛНЫЙ'}
                    </button>
                  ))}
                </div>
              </div>
              
              <button
                onClick={transcribeAndSummarize}
                disabled={isProcessing || !audioBlob}
                className="w-full py-3 bg-slate-800 rounded-xl text-xs font-bold text-white hover:bg-slate-700 flex items-center justify-center gap-2 disabled:opacity-50 transition-colors tracking-wide uppercase border border-slate-700 hover:border-slate-600"
              >
                {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                <span>{isProcessing ? 'СОСТАВЛЕНИЕ СВОДКИ...' : 'ПЕРЕГЕНЕРИРОВАТЬ СВОДКУ'}</span>
              </button>
           </div>

           {/* Voice-to-Text command console */}
           <div className="bg-[#1E2024] border border-slate-700 rounded-2xl p-6 flex flex-col gap-4 shrink-0 shadow-lg relative overflow-hidden">
              {isListening && (
                <div className="absolute inset-0 border border-blue-500/30 rounded-2xl pointer-events-none animate-pulse" />
              )}
              <div className="flex justify-between items-center">
                <h3 className="text-sm font-bold text-white tracking-wide uppercase flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-blue-500 animate-pulse' : 'bg-slate-400'}`}></div>
                  Голосовые и Текстовые Команды
                </h3>
                <span className="text-[9px] font-mono text-slate-500 tracking-wider">АКТИВНЫЙ РЕЖИМ</span>
              </div>
              
              <div className="relative">
                <input
                  type="text"
                  value={customCommand}
                  onChange={(e) => setCustomCommand(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleExecuteCommand();
                    }
                  }}
                  placeholder="Например: 'очистить', 'кратко', 'найти задачи'..."
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-4 pr-10 py-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
                />
                <button
                  onClick={toggleSpeechRecognition}
                  title={isListening ? "Остановить запись" : "Начать говорить"}
                  className={`absolute right-2.5 top-2.5 p-1 rounded-lg transition-colors ${
                    isListening 
                      ? 'bg-blue-500 text-white animate-pulse' 
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  <Mic className="w-4 h-4" />
                </button>
              </div>

              {commandFeedback && (
                <div className="text-[11px] font-mono p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-300 animate-fadeIn">
                  {commandFeedback}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleExecuteCommand}
                  disabled={!customCommand.trim() || isProcessing}
                  className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 text-white disabled:text-slate-500 rounded-xl text-xs font-bold transition-all tracking-wide uppercase flex items-center justify-center gap-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Выполнить команду
                </button>
                {customCommand && (
                  <button
                    onClick={() => { setCustomCommand(''); setCommandFeedback(''); }}
                    className="px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-colors uppercase"
                  >
                    Сбросить
                  </button>
                )}
              </div>

              <div className="text-[9px] text-slate-400 tracking-wide space-y-1 bg-[#151719]/40 p-2.5 rounded-lg border border-slate-800">
                <p className="font-bold text-[10px] text-slate-400 mb-1 uppercase tracking-widest flex items-center gap-1">🗣️ Примеры голосовых команд:</p>
                <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-[8.5px] text-slate-500 font-mono">
                  <div>✨ "составить резюме встречи"</div>
                  <div>🔍 "найти [слово]"</div>
                  <div>📊 "показать задачи"</div>
                  <div>❌ "очистить заметку"</div>
                  <div>📝 "сделать полный транскрипт"</div>
                  <div>🏷️ "тег [слово]"</div>
                </div>
              </div>
            </div>

            {/* Keywords & Tags Editor */}
            <div className="bg-[#1E2024] border border-slate-700 rounded-2xl p-6 flex flex-col gap-4 shrink-0 shadow-lg">
             <h3 className="text-sm font-bold text-white tracking-wide uppercase">КЛЮЧЕВЫЕ СЛОВА</h3>
             <div className="flex flex-wrap gap-2">
               {tags.map(tag => (
                 <div key={tag} className="flex items-center gap-1 bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px] font-medium border border-slate-700">
                   {tag}
                   <button onClick={() => handleTagsChange('remove', tag)} className="hover:text-red-400 transition-colors cursor-pointer">
                     <X className="w-3 h-3" />
                   </button>
                 </div>
               ))}
             </div>
             <div className="flex gap-2">
               <input
                 type="text"
                 value={newTag}
                 onChange={(e) => setNewTag(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && handleTagsChange('add')}
                 placeholder="Добавить ключевое слово..."
                 className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
               />
               <button
                 onClick={() => handleTagsChange('add')}
                 disabled={!newTag.trim()}
                 className="bg-blue-600 text-white px-3 py-2 rounded-lg text-xs font-bold hover:bg-blue-500 disabled:opacity-50 transition-colors cursor-pointer"
               >
                 ADD
               </button>
             </div>
           </div>

           {/* Integrations */}
           <div className="lg:flex-1 bg-[#151719] border border-slate-800 rounded-2xl p-6 flex flex-col gap-4 shrink-0 lg:min-h-0 lg:overflow-hidden shadow-inner">
              <h3 className="text-sm font-bold text-slate-400 mb-2 uppercase tracking-wide">ЭКСПОРТ И СИНХРОНИЗАЦИЯ</h3>
              
              <div className="flex gap-2">
                <button
                  onClick={() => handleOpenExportModal('txt')}
                  disabled={!result}
                  className="flex-1 py-1.5 bg-[#2D3035] text-slate-300 rounded font-bold hover:bg-slate-705 disabled:opacity-50 flex items-center justify-center gap-1 uppercase tracking-wider text-[10px] border border-slate-700 cursor-pointer"
                >
                  <Download className="w-3 h-3"/> TXT
                </button>
                <button
                  onClick={() => handleOpenExportModal('pdf')}
                  disabled={!result}
                  className="flex-1 py-1.5 bg-[#2D3035] text-slate-300 rounded font-bold hover:bg-slate-705 disabled:opacity-50 flex items-center justify-center gap-1 uppercase tracking-wider text-[10px] border border-slate-700 cursor-pointer"
                >
                  <Download className="w-3 h-3"/> PDF
                </button>
                <button
                  onClick={() => handleOpenExportModal('docx')}
                  disabled={!result}
                  className="flex-1 py-1.5 bg-[#2D3035] text-slate-300 rounded font-bold hover:bg-slate-705 disabled:opacity-50 flex items-center justify-center gap-1 uppercase tracking-wider text-[10px] border border-slate-700 cursor-pointer"
                >
                  <Download className="w-3 h-3"/> DOCX
                </button>
              </div>
              
              {/* Публичная ссылка (Share Link) */}
              <div className="flex flex-col gap-2 p-3 bg-[#1E2024] rounded-xl border border-slate-800">
                <div className="flex items-center justify-between select-none">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-purple-500/20 rounded-lg flex items-center justify-center">
                       <Share2 className="w-4 h-4 text-purple-400" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-white">Поделиться записью</p>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider">Создать публичную веб-ссылку</p>
                    </div>
                  </div>
                  <button
                    onClick={handleShareLink}
                    disabled={isSharingLink || !result}
                    className="text-[10px] px-3 py-1.5 bg-[#2D3035] text-purple-400 rounded font-bold hover:bg-purple-900/30 disabled:opacity-50 flex items-center gap-1 uppercase tracking-wider transition-colors border border-transparent hover:border-purple-500/30 cursor-pointer"
                  >
                     {isSharingLink ? <><Loader2 className="w-3 h-3 animate-spin"/> СОЗДАНИЕ...</> : 'СКОПИРОВАТЬ ССЫЛКУ'}
                  </button>
                </div>
                {copiedShareUrl && (
                  <div className="flex items-center justify-between bg-[#0B0C0E] border border-purple-500/20 rounded-lg p-2 text-[10px] text-purple-300 animate-fadeIn gap-2 mt-1">
                    <span className="truncate flex-1 font-mono text-[9px]">{copiedShareUrl}</span>
                    <span className="text-green-400 text-[9px] uppercase font-bold tracking-wider flex items-center gap-0.5 shrink-0">
                      <Check className="w-3 h-3 text-green-400" /> СКОПИРОВАНО!
                    </span>
                  </div>
                )}
              </div>

              {/* Локальное хранилище (IndexedDB) */}
              {(() => {
                const isStorageLimitReaching = (storageEstimate && (storageEstimate.percentage >= 80 || (storageEstimate.quota - storageEstimate.usage) < 100 * 1024 * 1024)) || (simulateLimitRatio !== null && simulateLimitRatio >= 80);
                return (
                  <div className={`flex flex-col gap-2.5 p-3 rounded-xl border transition-all duration-300 ${isStorageLimitReaching ? 'bg-amber-950/15 border-amber-600/60 shadow-[0_0_12px_rgba(217,119,6,0.15)]' : 'bg-[#1E2024] border-slate-800'}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${isStorageLimitReaching ? 'bg-amber-500/20' : 'bg-blue-500/20'}`}>
                           <Database className={`w-5 h-5 transition-colors ${isStorageLimitReaching ? 'text-amber-400' : 'text-blue-400'}`} />
                        </div>
                        <div>
                          <p className="text-xs font-bold text-white flex items-center gap-1.5">
                            Локальный архив
                            {isStorageLimitReaching && (
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                            )}
                          </p>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider">Локальное сохранение (IndexedDB)</p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleSaveCurrentSession()}
                        disabled={!result}
                        className={`text-[10px] px-3 py-1.5 rounded font-bold disabled:opacity-50 flex items-center gap-1 uppercase tracking-wider transition-all border border-transparent font-semibold cursor-pointer ${
                          isStorageLimitReaching 
                            ? 'bg-amber-600 hover:bg-amber-500 text-white'
                            : 'bg-[#2D3035] text-blue-400 hover:bg-blue-900/35 hover:border-blue-500/30'
                        }`}
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>{activeSessionId ? 'ОБНОВИТЬ СЕССИЮ' : 'СОХРАНИТЬ ЛОКАЛЬНО'}</span>
                      </button>
                    </div>

                    {/* Storage info & simulation option */}
                    <div className="border-t border-slate-800/60 pt-2.5 mt-0.5 flex flex-col gap-2">
                      <div className="flex items-center justify-between text-[9px] font-mono text-slate-500">
                        <div className="flex items-center gap-1">
                          <span>ПАМЯТЬ:</span>
                          <span className={isStorageLimitReaching ? 'text-amber-400 font-bold' : 'text-slate-300'}>
                            {storageEstimate 
                              ? `${(storageEstimate.usage / (1024 * 1024)).toFixed(1)} МБ / ${(storageEstimate.quota / (1024 * 1024)).toFixed(0)} МБ`
                              : 'Загрузка...'
                            }
                            {simulateLimitRatio !== null && ` (Симуляция: ${simulateLimitRatio}%)`}
                          </span>
                        </div>
                        
                        <button 
                          onClick={() => setSimulateLimitRatio(prev => prev === null ? 92 : null)}
                          className={`text-[8px] font-semibold px-1.5 py-0.5 rounded transition-all cursor-pointer ${
                            simulateLimitRatio !== null 
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold' 
                              : 'bg-slate-850 hover:bg-slate-750 text-slate-400 border border-slate-800/60'
                          }`}
                        >
                          {simulateLimitRatio !== null ? 'ОТМЕНИТЬ СИМУЛЯЦИЮ' : 'ТЕСТ ЛИМИТА'}
                        </button>
                      </div>

                      <div className="h-1 w-full bg-slate-900 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full transition-all duration-500 ${isStorageLimitReaching ? 'bg-amber-500' : 'bg-blue-500'}`} 
                          style={{ width: `${Math.min(100, simulateLimitRatio !== null ? simulateLimitRatio : (storageEstimate?.percentage || 0))}%` }} 
                        />
                      </div>

                      {isStorageLimitReaching && (
                        <div className="bg-amber-950/20 border border-amber-600/30 rounded-lg p-2.5 flex flex-col gap-2 animate-fadeIn select-none mt-1">
                          <div className="flex items-start gap-2">
                            <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                            <div className="text-[10px] text-amber-200 leading-relaxed">
                              <p className="font-bold mb-0.5">Достигнут лимит свободного места!</p>
                              <p>Накопленные аудиофайлы и сессии занимают практически весь выделенный объём памяти в вашем браузере.</p>
                            </div>
                          </div>
                          
                          <div className="text-[9.5px] text-amber-300 bg-amber-950/30 border border-amber-800/40 rounded p-1.5 italic font-mono">
                            💡 Совет: Откройте архив ваших локальных записей и очистите старые или ненужные сессии для освобождения пространства в IndexedDB.
                          </div>

                          <button
                            onClick={() => setIsHistoryOpen(true)}
                            className="w-full text-center py-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 text-[10px] font-bold rounded uppercase tracking-wider border border-amber-500/30 hover:border-amber-500/50 transition-all cursor-pointer"
                          >
                            Открыть архив и очистить записи
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
              
              {/* Google Docs */}
              <div className="flex items-center justify-between p-3 bg-[#1E2024] rounded-xl border border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-blue-500/20 rounded-lg flex items-center justify-center">
                     <FileText className="w-5 h-5 text-blue-500" />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white">Google Docs</p>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider font-medium">Сохранить запись встречи</p>
                  </div>
                </div>
                <button
                  onClick={handleSaveToDocs}
                  disabled={isSavingDoc || !result}
                  className="text-[10px] px-3 py-1.5 bg-[#2D3035] text-blue-400 rounded font-bold hover:bg-blue-900/30 disabled:opacity-50 flex items-center gap-1 uppercase tracking-wider transition-colors border border-transparent hover:border-blue-500/30"
                >
                  {isSavingDoc ? <><Loader2 className="w-3 h-3 animate-spin"/> СОХРАНЕНИЕ...</> : 'СОХРАНИТЬ В DOCS'}
                </button>
              </div>

              {/* Google Calendar */}
              <div className="flex items-center justify-between p-3 bg-[#1E2024] rounded-xl border border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-red-500/20 rounded-lg flex items-center justify-center">
                     <Calendar className="w-5 h-5 text-red-500" />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white">Google Calendar</p>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Запланировать встречу</p>
                  </div>
                </div>
                <button
                  onClick={handleSaveToCalendar}
                  disabled={isSavingCal || !result}
                  className="text-[10px] px-3 py-1.5 bg-[#2D3035] text-red-400 rounded font-bold hover:bg-red-900/30 disabled:opacity-50 flex items-center gap-1 uppercase tracking-wider transition-colors border border-transparent hover:border-red-500/30"
                >
                   {isSavingCal ? <><Loader2 className="w-3 h-3 animate-spin"/> ЗАПИСЬ...</> : 'ДОБАВИТЬ В КАЛЕНДАРЬ'}
                </button>
              </div>

              {/* Google Drive */}
              <div className="flex flex-col gap-2 p-3 bg-[#1E2024] rounded-xl border border-slate-800">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-green-500/20 rounded-lg flex items-center justify-center">
                       <Save className="w-5 h-5 text-green-500" />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-bold text-white">Google Drive</p>
                        {queuedSyncs.length > 0 && (
                          <div className="flex items-center gap-1 bg-amber-500/10 text-amber-500 border border-amber-500/20 px-1.5 py-0.5 rounded-full text-[9px] font-mono font-bold animate-pulse" title="Элементы, ожидающие синхронизации в Google Drive">
                            <Clock className="w-2.5 h-2.5" />
                            <span>{queuedSyncs.length}</span>
                          </div>
                        )}
                      </div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider">Сохранить в папку</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleSaveToDrive()}
                    disabled={isSavingDrive || !result}
                    className="text-[10px] px-3 py-1.5 bg-[#2D3035] text-green-405 rounded font-bold hover:bg-green-905/30 disabled:opacity-50 flex items-center gap-1 uppercase tracking-wider transition-colors border border-transparent hover:border-green-550/30"
                  >
                     {isSavingDrive ? <><Loader2 className="w-3 h-3 animate-spin"/> СОХРАНЕНИЕ...</> : 'СОХРАНИТЬ В DRIVE'}
                  </button>
                </div>
                
                {/* Auto-save Toggle */}
                <div className="flex items-center justify-between pt-2 mt-1 border-t border-slate-800">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Автосохранение при готовности</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleSaveToDrive()}
                      disabled={isSavingDrive || !result}
                      className="text-[9px] px-2 py-1 bg-[#2D3035] text-green-400 border border-transparent hover:border-green-500/30 rounded font-bold hover:bg-green-900/10 disabled:opacity-50 transition-colors uppercase tracking-wider flex items-center gap-1 shrink-0"
                      title="Forced immediate sync current content to Google Drive"
                    >
                      {isSavingDrive ? (
                        <>
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                          СИНХРОНИЗАЦИЯ...
                        </>
                      ) : (
                        "SYNC NOW / СИНХРОНИЗИРОВАТЬ"
                      )}
                    </button>
                    <button 
                      onClick={() => {
                          const nextValue = !autoSaveToDrive;
                          setAutoSaveToDrive(nextValue);
                          localStorage.setItem('autoSaveToDrive', String(nextValue));
                      }}
                      className={`relative inline-flex h-4 w-8 items-center rounded-full transition-colors ${autoSaveToDrive ? 'bg-green-500' : 'bg-slate-700'}`}
                    >
                      <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${autoSaveToDrive ? 'translate-x-4' : 'translate-x-1'}`} />
                    </button>
                  </div>
                </div>

                {/* Progress bar container */}
                {isSavingDrive && (
                  <div className="mt-2 pt-2 border-t border-slate-800/60 space-y-1.5 animate-fadeIn">
                    <div className="flex justify-between items-center text-[9px] font-mono uppercase tracking-wider text-green-400">
                      <span className="flex items-center gap-1">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        Резервное копирование...
                      </span>
                      <span className="font-bold">{syncProgress}%</span>
                    </div>
                    <div className="h-1 bg-slate-950 rounded-full overflow-hidden w-full">
                      <div 
                        className="h-full bg-green-500 rounded-full transition-all duration-300 ease-out" 
                        style={{ width: `${syncProgress}%` }}
                      ></div>
                    </div>
                  </div>
                )}

                {/* Pending Drive Sync Queue Count and Trigger */}
                {queuedSyncs.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-slate-800 flex items-center justify-between text-[10px] text-amber-500 animate-fadeIn bg-amber-500/5 p-2 rounded-lg border border-amber-500/10">
                    <span className="flex items-center gap-1.5 font-bold">
                      <Clock className="w-3.5 h-3.5 text-amber-500 animate-spin" style={{ animationDuration: '4s' }} />
                      ОЧЕРЕДЬ СИНХРОНИЗАЦИИ: {queuedSyncs.length}
                    </span>
                    <button
                      onClick={handleRetrySyncQueue}
                      disabled={isRetryingSync}
                      className="text-[9px] px-2.5 py-1 bg-yellow-500/20 text-yellow-300 font-bold border border-yellow-500/30 rounded hover:bg-yellow-500/30 disabled:opacity-50 transition-colors uppercase tracking-wider flex items-center gap-1 shrink-0"
                    >
                      {isRetryingSync ? (
                        <>
                          <Loader2 className="w-2.5 h-2.5 animate-spin animate-spin" />
                          СИНХРОНИЗАЦИЯ...
                        </>
                      ) : (
                        "СИНХРОНИЗИРОВАТЬ СЕЙЧАС"
                      )}
                    </button>
                  </div>
                )}
              </div>

              <div className="hidden lg:flex shrink-0 mt-auto items-center justify-between text-[10px] text-slate-500 font-mono border-t border-slate-800 pt-4 tracking-widest">
                <span>ПАПКА: /DRIVE/ВСТРЕЧИ/2026/</span>
                <span className="text-slate-400">ГОТОВ</span>
              </div>
            </div>
          </section>
      </main>
      
      <footer className="mt-6 hidden lg:flex justify-between items-center px-2 shrink-0 max-w-[1400px] w-full mx-auto relative z-10">
        <div className="flex gap-6 text-[10px] text-slate-500 font-medium tracking-widest">
          <span className="flex items-center gap-2"><div className="w-1 h-1 bg-green-500 rounded-full"></div> СИСТЕМА OK</span>
          <span className="flex items-center gap-2"><div className="w-1 h-1 bg-slate-500 rounded-full"></div> ЗАДЕРЖКА: 42МС</span>
          <span className="flex items-center gap-2"><div className="w-1 h-1 bg-slate-500 rounded-full"></div> ШИФРОВАНИЕ: AES-256</span>
        </div>
        <div className="text-[10px] text-slate-600 font-mono tracking-widest">
          © 2026 AURA INTELLIGENCE. ВСЕ ДАННЫЕ ЗАЩИЩЕНЫ.
        </div>
      </footer>

      {/* Export Preview & Options Modal */}
      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        exportCustomTitle={exportCustomTitle}
        setExportCustomTitle={setExportCustomTitle}
        exportFormat={exportFormat}
        setExportFormat={setExportFormat}
        exportIncludeMetadata={exportIncludeMetadata}
        setExportIncludeMetadata={setExportIncludeMetadata}
        exportIncludeSentiment={exportIncludeSentiment}
        setExportIncludeSentiment={setExportIncludeSentiment}
        exportIncludeSummary={exportIncludeSummary}
        setExportIncludeSummary={setExportIncludeSummary}
        exportIncludeTranscript={exportIncludeTranscript}
        setExportIncludeTranscript={setExportIncludeTranscript}
        exportIncludeKeywords={exportIncludeKeywords}
        setExportIncludeKeywords={setExportIncludeKeywords}
        previewText={previewText}
        setPreviewText={setPreviewText}
        handleExecuteExport={handleExecuteExport}
        generateExportText={generateExportText}
        triggerToast={triggerToast}
        sentiment={sentiment}
        summary={summary}
        transcript={transcript}
        tags={tags}
      />


      {/* Toast Notifications */}
      <AnimatePresence>
        {notification && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="fixed bottom-6 right-6 z-[9999] max-w-sm w-full bg-[#151719] border border-slate-800 rounded-xl p-4 shadow-2xl flex gap-3 items-start animate-fadeIn"
          >
            <div className={`p-1.5 rounded-lg ${
              notification.type === 'success' 
                ? 'bg-green-500/10 text-green-400' 
                : notification.type === 'error' 
                ? 'bg-red-500/10 text-red-400' 
                : 'bg-blue-500/10 text-blue-400'
            }`}>
              <AlertCircle className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                {notification.type === 'success' ? 'Успешно' : notification.type === 'error' ? 'Ошибка' : 'Уведомление'}
              </p>
              <p className="text-xs text-white leading-relaxed mt-0.5">{notification.message}</p>
            </div>
            <button 
              onClick={() => setNotification(null)}
              className="p-0.5 text-slate-500 hover:text-white transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Offline Local History Drawer */}
      <AnimatePresence>
        {isHistoryOpen && (
          <>
            {/* Backdrop overlay */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.6 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsHistoryOpen(false)}
              className="fixed inset-0 bg-black z-40 cursor-pointer backdrop-blur-xs"
            />

            {/* Slide-out Panel */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 26, stiffness: 220 }}
              className="fixed top-0 right-0 h-full w-full sm:max-w-md bg-[#111215] border-l border-slate-800/80 p-6 shadow-2xl z-50 flex flex-col justify-between overflow-hidden"
            >
              <div className="flex flex-col h-full min-h-0">
                {/* Header */}
                <div className="flex justify-between items-center mb-5 border-b border-slate-800 pb-3 shrink-0">
                  <div className="flex items-center gap-2">
                    <Database className="w-5 h-5 text-blue-400" />
                    <h2 className="text-sm font-bold text-white uppercase tracking-wider">Локальная история записей</h2>
                  </div>
                  <button 
                    onClick={() => setIsHistoryOpen(false)}
                    className="p-1 px-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Database Information Block */}
                <div className="bg-[#151719] border border-slate-800 p-3 rounded-xl mb-4 text-[11px] text-slate-400 leading-relaxed flex gap-2.5 items-start shrink-0 select-none">
                  <AlertCircle className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                  <p>Транскрипции и аудиофайлы хранятся исключительно во внутреннем репозитории браузера (IndexedDB) и полностью доступны офлайн.</p>
                </div>

                {/* Scrollable list of items */}
                <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 -mr-2 space-y-3 min-h-0">
                  {savedSessions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full py-12 text-slate-600 gap-3">
                      <FolderOpen className="w-10 h-10 opacity-30 text-slate-400" />
                      <p className="text-xs uppercase tracking-widest font-bold text-slate-600">Локальный архив пуст</p>
                      <p className="text-[10px] text-slate-500 text-center max-w-[200px]">Создайте свою первую запись, и она появится в этом списке автоматически.</p>
                    </div>
                  ) : (
                    savedSessions.map((session) => {
                      const isActive = activeSessionId === session.id;
                      return (
                        <div 
                          key={session.id}
                          className={`group relative flex flex-col gap-2 p-4 rounded-xl border transition-all cursor-pointer text-left ${
                            isActive 
                              ? 'bg-blue-950/20 border-blue-500/50 shadow-md' 
                              : 'bg-[#151719]/80 border-slate-800 hover:border-slate-700 hover:bg-[#1C1E22]'
                          }`}
                          onClick={() => handleLoadLocalSession(session)}
                        >
                          <div className="flex justify-between items-start gap-4">
                            <div className="min-w-0 flex-1">
                              <h3 className={`text-xs font-bold truncate ${isActive ? 'text-blue-400' : 'text-white'}`}>
                                {session.title}
                              </h3>
                              <span className="text-[9px] text-slate-500 font-mono block mt-1">
                                📅 {session.timestamp}
                              </span>
                            </div>
                            {/* Actions Group */}
                            <div className="flex items-center gap-1 opacity-80 sm:opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                              <button
                                onClick={(e) => handleRenameLocalSession(session.id, session.title, e)}
                                title="Переименовать"
                                className="p-1 rounded bg-[#2D3035] hover:bg-[#3d424b] text-slate-300 hover:text-white transition-colors cursor-pointer"
                              >
                                <Edit className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={(e) => handleDeleteLocalSession(session.id, e)}
                                title="Удалить"
                                className="p-1 rounded bg-red-950/45 hover:bg-red-950 text-red-400 hover:text-white transition-colors border border-red-950 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Metadata Badges */}
                          <div className="flex flex-wrap gap-1 mt-1">
                            {session.recordingDuration > 0 && (
                              <span className="text-[8.5px] font-mono bg-slate-900 border border-slate-800 text-slate-400 px-1.5 py-0.5 rounded leading-none flex items-center gap-1">
                                {formatDuration(session.recordingDuration)}
                              </span>
                            )}
                            {session.detectedLanguage && (
                              <span className="text-[8.5px] font-mono bg-slate-900 border border-slate-800 text-slate-300 px-1.5 py-0.5 rounded leading-none uppercase">
                                {session.detectedLanguage}
                              </span>
                            )}
                            {session.sentiment && (
                              <span className="text-[8.5px] font-mono bg-slate-900 border border-slate-800 text-slate-300 px-1.5 py-0.5 rounded leading-none">
                                {session.sentiment.emoji} {session.sentiment.label === 'positive' ? 'ПОЗ' : session.sentiment.label === 'negative' ? 'НЕГ' : 'НЕЙТР'}
                              </span>
                            )}
                            {session.audioBlob && (
                              <span className="text-[8.5px] font-mono bg-blue-950 border border-blue-900/40 text-blue-400 px-1.5 py-0.5 rounded leading-none uppercase font-bold tracking-wider">
                                AUDIO
                              </span>
                            )}
                          </div>

                          {/* Tags Preview */}
                          {session.tags && session.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1 pr-12 line-clamp-1">
                              {session.tags.slice(0, 3).map((tag) => (
                                <span key={tag} className="text-[8px] bg-slate-900/50 border border-slate-800 text-slate-500 px-1.5 py-0.5 rounded leading-none font-medium">
                                  #{tag}
                                </span>
                              ))}
                              {session.tags.length > 3 && (
                                <span className="text-[8px] text-slate-600 font-bold">+{session.tags.length - 3}</span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Footer status bar */}
                <div className="mt-4 pt-4 border-t border-slate-800/80 flex justify-between items-center text-[9px] font-mono text-slate-500 shrink-0">
                  <span>ОФЛАЙН-ХРАНИЛИЩЕ: АКТИВНО</span>
                  <span className="text-slate-400 flex items-center gap-1">
                    <Database className="w-3 h-3 text-blue-400 animate-pulse" /> IndexedDB Active
                  </span>
                </div>
              </div>
            </motion.div>
          </>
        )}

        <ErrorLogDrawer
        isOpen={isErrorLogOpen}
        onClose={() => setIsErrorLogOpen(false)}
        errorLogs={errorLogs}
        clearErrors={clearErrors}
        removeError={removeError}
      />
      </AnimatePresence>
    </div>
  );
}
