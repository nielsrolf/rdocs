import { useEffect, useRef } from "react";

// Accessibility helper for modal dialogs: closes on Escape and moves focus to
// the dialog when it opens (so keyboard users land inside it and Escape works
// without first clicking). Attach the returned ref to the dialog element and
// give it tabIndex={-1}.
export function useDialogDismiss<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", handler);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return ref;
}
