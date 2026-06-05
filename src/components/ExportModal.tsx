import React from 'react';
import { Download, X } from 'lucide-react';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  exportCustomTitle: string;
  setExportCustomTitle: (val: string) => void;
  exportFormat: 'txt' | 'pdf' | 'docx';
  setExportFormat: (val: 'txt' | 'pdf' | 'docx') => void;
  exportIncludeMetadata: boolean;
  setExportIncludeMetadata: (val: boolean) => void;
  exportIncludeSentiment: boolean;
  setExportIncludeSentiment: (val: boolean) => void;
  exportIncludeSummary: boolean;
  setExportIncludeSummary: (val: boolean) => void;
  exportIncludeTranscript: boolean;
  setExportIncludeTranscript: (val: boolean) => void;
  exportIncludeKeywords: boolean;
  setExportIncludeKeywords: (val: boolean) => void;
  previewText: string;
  setPreviewText: (val: string) => void;
  handleExecuteExport: () => void;
  generateExportText: (opts: any) => string;
  triggerToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  sentiment: any;
  summary: string;
  transcript: string;
  tags: string[];
}

export function ExportModal({
  isOpen,
  onClose,
  exportCustomTitle,
  setExportCustomTitle,
  exportFormat,
  setExportFormat,
  exportIncludeMetadata,
  setExportIncludeMetadata,
  exportIncludeSentiment,
  setExportIncludeSentiment,
  exportIncludeSummary,
  setExportIncludeSummary,
  exportIncludeTranscript,
  setExportIncludeTranscript,
  exportIncludeKeywords,
  setExportIncludeKeywords,
  previewText,
  setPreviewText,
  handleExecuteExport,
  generateExportText,
  triggerToast,
  sentiment,
  summary,
  transcript,
  tags
}: ExportModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div className="bg-[#151719] border border-slate-800 rounded-2xl w-full max-w-3xl flex flex-col max-h-[90vh] overflow-hidden shadow-2xl relative">

        {/* Modal Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-800/80 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-blue-500/10 text-blue-400 rounded-lg">
              <Download className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white uppercase tracking-wider">Настройка экспорта документа</h3>
              <p className="text-[10px] text-slate-500 uppercase tracking-widest font-mono">Выбор формата, предварительный просмотр текста и редактирование метаданных</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 px-2.5 bg-slate-900 border border-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors text-xs flex items-center justify-center"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Modal Content - Split layout */}
        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-12 gap-6 min-h-0">

          {/* Left Column: Toggles & Options */}
          <div className="md:col-span-5 flex flex-col gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Название документа / Имя файла</label>
              <input
                type="text"
                value={exportCustomTitle}
                onChange={(e) => setExportCustomTitle(e.target.value)}
                className="w-full bg-slate-900/60 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500 transition-colors"
                placeholder="Введите имя готового файла"
              />
            </div>

            <div className="space-y-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Целевой формат экспорта</span>
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => setExportFormat('txt')}
                  className={`py-2 rounded-xl text-xs font-bold font-mono border transition-all ${
                    exportFormat === 'txt'
                      ? 'bg-blue-600 border-blue-500 text-white shadow-[0_0_10px_rgba(37,99,235,0.2)]'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800/50'
                  }`}
                >
                  .TXT
                </button>
                <button
                  onClick={() => setExportFormat('pdf')}
                  className={`py-2 rounded-xl text-xs font-bold font-mono border transition-all ${
                    exportFormat === 'pdf'
                      ? 'bg-blue-600 border-blue-500 text-white shadow-[0_0_10px_rgba(37,99,235,0.2)]'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800/50'
                  }`}
                >
                  .PDF
                </button>
                <button
                  onClick={() => setExportFormat('docx')}
                  className={`py-2 rounded-xl text-xs font-bold font-mono border transition-all ${
                    exportFormat === 'docx'
                      ? 'bg-blue-600 border-blue-500 text-white shadow-[0_0_10px_rgba(37,99,235,0.2)]'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800/50'
                  }`}
                >
                  .DOCX
                </button>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-800 space-y-3">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Включить разделы контента</span>

              {/* Toggle list */}
              <div className="space-y-2">
                <label className="flex items-center justify-between p-2.5 bg-slate-900/40 border border-slate-800 hover:bg-slate-900/70 rounded-xl transition-all cursor-pointer">
                  <div className="flex flex-col text-left">
                    <span className="text-xs font-medium text-slate-300">Заголовок файла и метаданные</span>
                    <span className="text-[9px] text-slate-500">Дата, длительность, язык</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={exportIncludeMetadata}
                    onChange={(e) => setExportIncludeMetadata(e.target.checked)}
                    className="rounded bg-slate-950 border-slate-800 text-blue-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                  />
                </label>

                {sentiment && (
                  <label className="flex items-center justify-between p-2.5 bg-slate-900/40 border border-slate-800 hover:bg-slate-900/70 rounded-xl transition-all cursor-pointer">
                    <div className="flex flex-col text-left">
                      <span className="text-xs font-medium text-slate-300">Анализ тональности</span>
                      <span className="text-[9px] text-slate-500">Общее настроение, оценка, эмодзи</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={exportIncludeSentiment}
                      onChange={(e) => setExportIncludeSentiment(e.target.checked)}
                      className="rounded bg-slate-950 border-slate-800 text-blue-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                    />
                  </label>
                )}

                {summary && (
                  <label className="flex items-center justify-between p-2.5 bg-slate-900/40 border border-slate-800 hover:bg-slate-900/70 rounded-xl transition-all cursor-pointer">
                    <div className="flex flex-col text-left">
                      <span className="text-xs font-medium text-slate-300">Резюме и Сводка ИИ</span>
                      <span className="text-[9px] text-slate-500">Ключевые моменты или список задач</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={exportIncludeSummary}
                      onChange={(e) => setExportIncludeSummary(e.target.checked)}
                      className="rounded bg-slate-950 border-slate-800 text-blue-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                    />
                  </label>
                )}

                {transcript && (
                  <label className="flex items-center justify-between p-2.5 bg-slate-900/40 border border-slate-800 hover:bg-slate-900/70 rounded-xl transition-all cursor-pointer">
                    <div className="flex flex-col text-left">
                      <span className="text-xs font-medium text-slate-300">Распознанный текст</span>
                      <span className="text-[9px] text-slate-500">Распознанные реплики участников</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={exportIncludeTranscript}
                      onChange={(e) => setExportIncludeTranscript(e.target.checked)}
                      className="rounded bg-slate-950 border-slate-800 text-blue-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                    />
                  </label>
                )}

                {tags.length > 0 && (
                  <label className="flex items-center justify-between p-2.5 bg-slate-900/40 border border-slate-800 hover:bg-slate-900/70 rounded-xl transition-all cursor-pointer">
                    <div className="flex flex-col text-left">
                      <span className="text-xs font-medium text-slate-300">Выделенные ключевые слова</span>
                      <span className="text-[9px] text-slate-500">Список извлеченных тегов и тем</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={exportIncludeKeywords}
                      onChange={(e) => setExportIncludeKeywords(e.target.checked)}
                      className="rounded bg-slate-950 border-slate-800 text-blue-500 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                    />
                  </label>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Interactive Text Preview */}
          <div className="md:col-span-7 flex flex-col gap-2 min-h-[300px] md:min-h-0">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                📝 Предварительный просмотр готового документа
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(previewText);
                    triggerToast("Copied preview text to clipboard!", 'success');
                  }}
                  className="text-[9px] bg-[#1E2024] hover:bg-slate-800 text-slate-300 rounded px-2.5 py-1 uppercase tracking-wide transition-colors font-semibold"
                  title="Copy to clipboard"
                >
                  Копировать всё
                </button>
                <button
                  onClick={() => {
                    const regenerated = generateExportText({
                      title: exportCustomTitle,
                      includeMetadata: exportIncludeMetadata,
                      includeSummary: exportIncludeSummary,
                      includeTranscript: exportIncludeTranscript,
                      includeSentiment: exportIncludeSentiment,
                      includeKeywords: exportIncludeKeywords,
                    });
                    setPreviewText(regenerated);
                  }}
                  className="text-[9px] bg-slate-950 border border-slate-800 hover:bg-[#1E2024] text-slate-400 rounded px-2.5 py-1 uppercase tracking-wide transition-colors font-semibold"
                  title="Discard local edits and reload options"
                >
                  Сбросить
                </button>
              </div>
            </div>

            <div className="flex-1 relative border border-slate-800 bg-[#0A0B0C] rounded-xl flex flex-col min-h-0">
              <textarea
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
                className="flex-1 w-full p-4 bg-transparent text-slate-300 font-mono text-[11px] leading-relaxed resize-none focus:outline-none min-h-[250px] custom-scrollbar"
                placeholder="Предварительный просмотр пуст, так как не выбраны разделы."
              />
              <div className="absolute bottom-2 right-2.5 bg-slate-900/85 backdrop-blur-sm border border-slate-800/50 rounded-md px-2 py-1 text-[9px] font-mono text-slate-500 uppercase tracking-widest select-none">
                {previewText.length} симв. | {previewText.split(/\s+/).filter(Boolean).length} слов
              </div>
            </div>
            <p className="text-[9px] text-slate-500 italic text-left">
              💡 Совет: Вы можете редактировать текст прямо в поле выше перед экспортом документа.
            </p>
          </div>

        </div>

        {/* Modal Footer */}
        <div className="p-5 border-t border-slate-800/80 bg-slate-950/40 flex items-center justify-end gap-3 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 hover:border-slate-700 rounded-xl text-xs font-bold uppercase tracking-wider transition-colors"
          >
            Отмена
          </button>
          <button
            onClick={handleExecuteExport}
            disabled={!previewText.trim()}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-900 border border-transparent disabled:border-slate-800 text-white disabled:text-slate-500 shadow-lg shadow-blue-500/10 hover:shadow-blue-500/25 rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 active:scale-95"
          >
            <Download className="w-3.5 h-3.5" /> Экспортировать (.{exportFormat.toUpperCase()})
          </button>
        </div>

      </div>
    </div>
  );
}
