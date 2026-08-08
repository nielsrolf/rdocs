"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Sub-navigation for the full-page settings screens (topbar "Settings").
// Each section is its own route so pages stay server-rendered and deep-linkable:
//   /settings/agent — AI credentials, default model, MCP, skills, worker
//   /settings/forum — forum preferences (default quicktake audience)
const SECTIONS = [
  { href: "/settings/agent", label: "AI & credentials" },
  { href: "/settings/forum", label: "Forum" }
] as const;

export function SettingsNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Settings sections" className="settings-nav">
      {SECTIONS.map((section) => {
        const active = pathname === section.href || pathname.startsWith(`${section.href}/`);
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={`settings-nav-link${active ? " is-active" : ""}`}
            href={section.href}
            key={section.href}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
