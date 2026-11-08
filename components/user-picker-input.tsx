"use client";

import { useEffect, useId, useRef, useState } from "react";

export type UserPickerResult = { id: string; name: string; email: string; known?: boolean };

// A text input for an email address with people autocomplete from
// GET /api/users/search: type part of a name or email, pick with click or
// ↑/↓ + Enter/Tab. Picking fills the input with the person's email and calls
// `onPick`; Enter with no open suggestion calls `onSubmit` (so a typed full
// email still works). Used by the group member pickers and the share dialog.
export function UserPickerInput({
  value,
  onChange,
  onPick,
  onSubmit,
  placeholder,
  excludeIds,
  disabled,
  className
}: {
  value: string;
  onChange: (value: string) => void;
  onPick?: (user: UserPickerResult) => void;
  onSubmit?: () => void;
  placeholder?: string;
  excludeIds?: string[];
  disabled?: boolean;
  className?: string;
}) {
  const listId = useId();
  const [results, setResults] = useState<UserPickerResult[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Set after a pick so the effect doesn't re-open the list for the email we
  // just filled in.
  const suppressRef = useRef<string | null>(null);
  const exclude = (excludeIds ?? []).join(",");

  useEffect(() => {
    if (!open) return;
    if (suppressRef.current !== null && suppressRef.current === value) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: value.trim(), limit: "8" });
      if (exclude) params.set("exclude", exclude);
      fetch(`/api/users/search?${params}`, { cache: "no-store", signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (!Array.isArray(data?.users)) return;
          setResults(data.users);
          setActive(0);
        })
        .catch(() => {});
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [value, open, exclude]);

  const showList = open && results.length > 0 && suppressRef.current !== value;

  function pick(user: UserPickerResult) {
    suppressRef.current = user.email;
    onChange(user.email);
    setResults([]);
    setOpen(false);
    onPick?.(user);
  }

  return (
    <div className={`user-picker${className ? ` ${className}` : ""}`}>
      <input
        aria-activedescendant={showList ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        aria-controls={showList ? listId : undefined}
        aria-expanded={showList}
        autoComplete="off"
        disabled={disabled}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(event) => {
          suppressRef.current = null;
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (showList && event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => (index + 1) % results.length);
          } else if (showList && event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => (index - 1 + results.length) % results.length);
          } else if (showList && (event.key === "Enter" || event.key === "Tab") && results[active]) {
            event.preventDefault();
            pick(results[active]);
          } else if (showList && event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          } else if (event.key === "Enter") {
            event.preventDefault();
            onSubmit?.();
          }
        }}
        placeholder={placeholder}
        role="combobox"
        type="text"
        value={value}
      />
      {showList ? (
        <div className="mention-suggest mention-suggest-textarea" id={listId} role="listbox">
          {results.map((user, index) => (
            <button
              aria-selected={index === active}
              className={`mention-suggest-item${index === active ? " mention-suggest-item-active" : ""}`}
              id={`${listId}-${index}`}
              key={user.id}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(user);
              }}
              role="option"
              type="button"
            >
              <span className="mention-suggest-name">{user.name || user.email}</span>
              {user.name ? <span className="mention-suggest-email">{user.email}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
