import { useCallback, useRef, useState } from 'react';
import type { Toast, ToastAction, ToastKind } from '../components/Toasts';

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, kind: ToastKind = 'info', action?: ToastAction) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, message, kind, action }]);
      // A toast with a button stays longer so the user has time to press it.
      window.setTimeout(() => dismiss(id), action ? 10_000 : kind === 'error' ? 7000 : 3500);
    },
    [dismiss],
  );

  return { toasts, notify, dismiss };
}
