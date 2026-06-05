import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertCircle, Check, Trash2, X } from 'lucide-react';

interface ErrorLogDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  errorLogs: any[];
  clearErrors: () => void;
  removeError: (id: string) => void;
}

export function ErrorLogDrawer({
  isOpen,
  onClose,
  errorLogs,
  clearErrors,
  removeError
}: ErrorLogDrawerProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.6 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black z-40 cursor-pointer backdrop-blur-xs"
          />

          {/* Slide-out Panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 26, stiffness: 220 }}
            className="fixed top-0 right-0 h-full w-full sm:max-w-md bg-[#111215] border-l border-slate-800/80 p-6 shadow-2xl z-50 flex flex-col justify-between overflow-hidden text-slate-200"
          >
            <div className="flex flex-col h-full min-h-0">
              {/* Header */}
              <div className="flex justify-between items-center mb-5 border-b border-slate-800 pb-3 shrink-0">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-red-500" />
                  <h2 className="text-sm font-bold text-white uppercase tracking-wider">Лог ошибок API</h2>
                </div>
                <div className="flex items-center gap-2">
                  {errorLogs.length > 0 && (
                    <button
                      onClick={clearErrors}
                      className="text-[10px] bg-red-950/20 hover:bg-red-950/50 border border-red-900/30 text-red-400 px-2 py-1 rounded transition-colors uppercase font-bold cursor-pointer"
                    >
                      Очистить
                    </button>
                  )}
                  <button
                    onClick={onClose}
                    className="p-1 px-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Subheader Information Block */}
              <div className="bg-[#1D1214] border border-red-950/40 p-3 rounded-xl mb-4 text-[11px] text-red-300/80 leading-relaxed flex gap-2.5 items-start shrink-0 select-none">
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <p>Если запросы к серверу API завершаются сбоем (например, из-за превышения размера файла или таймаута модели), технические детали логируются здесь локально для диагностики.</p>
              </div>

              {/* Scrollable list of errors */}
              <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 -mr-2 space-y-3 min-h-0">
                {errorLogs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full py-12 text-slate-600 gap-3">
                    <Check className="w-10 h-10 opacity-30 text-emerald-400" />
                    <p className="text-xs uppercase tracking-widest font-bold text-slate-600">Ошибок не обнаружено</p>
                    <p className="text-[10px] text-slate-500 text-center max-w-[200px]">Отличная работа! Все API-запросы выполняются корректно.</p>
                  </div>
                ) : (
                  errorLogs.map((errorLog) => (
                    <div
                      key={errorLog.id}
                      className="flex flex-col gap-2 p-4 rounded-xl border bg-[#151719]/80 border-red-950/30 hover:border-red-900/40 hover:bg-[#1D1719]/30 transition-all text-left relative group/item"
                    >
                      <button
                        onClick={() => removeError(errorLog.id)}
                        title="Удалить запись"
                        className="absolute top-3 right-3 p-1 rounded bg-[#2D2024]/50 hover:bg-red-950 text-slate-400 hover:text-white transition-colors cursor-pointer opacity-0 group-hover/item:opacity-100"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>

                      <div className="pr-6">
                        <div className="text-xs font-bold text-red-400 leading-tight">
                          {errorLog.message}
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 text-[9px] text-slate-500 font-mono">
                          <span>🕒 {errorLog.timestamp}</span>
                          {errorLog.endpoint && (
                            <span className="bg-slate-900 border border-slate-800 text-slate-400 px-1 py-0.5 rounded leading-none">
                              {errorLog.endpoint}
                            </span>
                          )}
                          {errorLog.status && (
                            <span className="bg-red-950/35 border border-red-900/30 text-red-400 px-1 py-0.5 rounded leading-none font-bold">
                              HTTP {errorLog.status}
                            </span>
                          )}
                        </div>
                      </div>

                      {errorLog.technicalDetails && (
                        <div className="mt-2 pt-2 border-t border-slate-800/60">
                          <label className="text-[8px] uppercase tracking-wider text-slate-500 font-bold block mb-1">Технический стек / Ответ сервера:</label>
                          <pre className="text-[9.5px] font-mono text-slate-400 bg-slate-950 border border-slate-900 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-48 custom-scrollbar">
                            {errorLog.technicalDetails}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* Footer status bar */}
              <div className="mt-4 pt-4 border-t border-slate-800/80 flex justify-between items-center text-[9px] font-mono text-slate-500 shrink-0">
                <span>КОНТЕКСТ ОШИБОК: ЛОКАЛЬНЫЙ</span>
                <span className="text-red-400/80 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3 animate-pulse" /> Logs stored in memory
                </span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
