"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

// Studio / Forum switch shown in the topbar next to the brand mark, always
// visible (signed-in or not). Studio is the classic document dashboard ("/"),
// Forum is the LessWrong-style reading mode ("/forum"). Active state comes
// from the pathname so the switch doubles as a "where am I" indicator.
export function TopbarModeSwitch() {
  const pathname = usePathname() ?? "/";
  const onForum = pathname === "/forum" || pathname.startsWith("/forum/");

  // Studio density: Studio routes render at a compact root font size
  // (`html.studio-scale` in globals.css); the forum stays at 100%. The inline
  // script in app/layout.tsx sets the class before first paint; this effect
  // keeps it in sync across client-side navigations between the two modes.
  useEffect(() => {
    document.documentElement.classList.toggle("studio-scale", !onForum);
  }, [onForum]);

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
