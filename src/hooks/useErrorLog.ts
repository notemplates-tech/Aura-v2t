import { useState, useCallback } from 'react';

export interface ErrorLogEntry {
  id: string;
  message: string;
  timestamp: string;
  technicalDetails?: string;
  endpoint?: string;
  status?: number;
}

export function useErrorLog() {
  const [errorLogs, setErrorLogs] = useState<ErrorLogEntry[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  const addError = useCallback((message: string, details?: any, endpoint?: string, status?: number) => {
    let technicalDetails = '';
    if (details) {
      if (typeof details === 'string') {
        technicalDetails = details;
      } else if (details instanceof Error) {
        technicalDetails = `${details.message}\n${details.stack || ''}`;
      } else {
        try {
          technicalDetails = JSON.stringify(details, null, 2);
        } catch (e) {
          technicalDetails = String(details);
        }
      }
    }

    const newError: ErrorLogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      message,
      timestamp: new Date().toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      technicalDetails,
      endpoint,
      status,
    };

    setErrorLogs(prev => [newError, ...prev]);
  }, []);

  const clearErrors = useCallback(() => {
    setErrorLogs([]);
  }, []);

  const removeError = useCallback((id: string) => {
    setErrorLogs(prev => prev.filter(err => err.id !== id));
  }, []);

  return {
    errorLogs,
    addError,
    clearErrors,
    removeError,
    isOpen,
    setIsOpen,
  };
}
