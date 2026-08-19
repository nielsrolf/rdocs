"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// Sidebar navigation for the full-page settings screens (topbar "Settings").
// Top level: one route per section so pages stay server-rendered and
// deep-linkable. Within the active route, sub-links anchor-scroll to the
// section cards (their ids live on the `credentials-section` blocks) with a
// lightweight scroll-spy highlighting the section currently in view.
//   /settings/agent — AI credentials, default model, custom instructions,
//                     MCP, skills, self-hosted worker
//   /settings/forum — forum preferences (default quicktake audience)
//   /settings/notifications — Slack DM comment notifications
const SECTIONS: ReadonlyArray<{
  href: string;
  label: string;
  anchors: ReadonlyArray<{ id: string; label: string }>;
}> = [
  {
    href: "/settings/agent",
    label: "AI & credentials",
    anchors: [
      { id: "credentials", label: "AI credentials" },
      { id: "default-model", label: "Default model" },
      { id: "custom-instructions", label: "Custom instructions" },
      { id: "mcp", label: "Connect via MCP" },
      { id: "skills", label: "Agent skills" },
      { id: "self-hosted", label: "Self-hosted worker" }
    ]
  },
  { href: "/settings/forum", label: "Forum", anchors: [] },
  { href: "/settings/notifications", label: "Notifications", anchors: [] }
];

export function SettingsNav() {
  const pathname = usePathname() ?? "";
  const active = SECTIONS.find(
    (section) => pathname === section.href || pathname.startsWith(`${section.href}/`)
  );
  const [currentAnchor, setCurrentAnchor] = useState<string | null>(null);

  // Scroll-spy: the active sub-link is the last section whose top has scrolled
  // past the upper third of the viewport. Cheap enough to run on every scroll
  // tick for a handful of sections.
  useEffect(() => {
    const anchors = active?.anchors ?? [];
    if (anchors.length === 0) return;
    const update = () => {
      const threshold = window.innerHeight * 0.3;
      let current: string | null = anchors[0]?.id ?? null;
      for (const anchor of anchors) {
        const element = document.getElementById(anchor.id);
        if (!element) continue;
        if (element.getBoundingClientRect().top <= threshold) {
          current = anchor.id;
        }
      }
      setCurrentAnchor(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active]);

  return (
    <nav aria-label="Settings sections" className="settings-nav">
      {SECTIONS.map((section) => {
        const isActive = section === active;
        return (
          <div className="settings-nav-group" key={section.href}>
            <Link
              aria-current={isActive ? "page" : undefined}
              className={`settings-nav-link${isActive ? " is-active" : ""}`}
              href={section.href}
            >
              {section.label}
            </Link>
            {isActive && section.anchors.length > 0 ? (
              <div className="settings-nav-anchors">
                {section.anchors.map((anchor) => (
                  <a
                    className={`settings-nav-sublink${
                      currentAnchor === anchor.id ? " is-current" : ""
                    }`}
                    href={`#${anchor.id}`}
                    key={anchor.id}
                    onClick={(event) => {
                      const element = document.getElementById(anchor.id);
                      if (!element) return;
                      event.preventDefault();
                      element.scrollIntoView({ behavior: "smooth", block: "start" });
                      history.replaceState(null, "", `#${anchor.id}`);
                    }}
                  >
                    {anchor.label}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
