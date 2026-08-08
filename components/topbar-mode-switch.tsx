"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Studio / Forum switch shown in the topbar next to the brand mark, always
// visible (signed-in or not). Studio is the classic document dashboard ("/"),
// Forum is the LessWrong-style reading mode ("/forum"). Active state comes
// from the pathname so the switch doubles as a "where am I" indicator.
export function TopbarModeSwitch() {
  const pathname = usePathname() ?? "/";
  const onForum = pathname === "/forum" || pathname.startsWith("/forum/");

  return (
    <nav aria-label="App mode" className="topbar-mode-switch">
      <Link
        aria-current={onForum ? undefined : "page"}
        className={`topbar-mode-link${onForum ? "" : " is-active"}`}
        href="/"
      >
        Studio
      </Link>
      <Link
        aria-current={onForum ? "page" : undefined}
        className={`topbar-mode-link${onForum ? " is-active" : ""}`}
        href="/forum"
      >
        Forum
      </Link>
    </nav>
  );
}
