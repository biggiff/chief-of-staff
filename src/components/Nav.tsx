"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string };

const PRIMARY: Item[] = [{ href: "/chat", label: "Chat" }];
const OVERVIEW: Item[] = [{ href: "/dashboard", label: "Dashboard" }];
const BACKSTAGE: Item[] = [
  { href: "/roles", label: "Roles" },
  { href: "/projects", label: "Projects" },
  { href: "/tasks", label: "Tasks" },
  { href: "/ideas", label: "Ideas" },
  { href: "/crossroads", label: "Crossroads" },
  { href: "/agreements", label: "Working Agreements" },
  { href: "/checkin", label: "Check-ins" },
  { href: "/briefing", label: "Briefings" },
  { href: "/observations", label: "Observations" },
  { href: "/review", label: "Review" },
  { href: "/integrations", label: "Integrations" },
  { href: "/settings", label: "Settings" },
];

export default function Nav() {
  const pathname = usePathname();
  if (pathname === "/login") return null;

  const link = (l: Item, muted = false) => {
    const active = pathname === l.href || pathname.startsWith(l.href + "/");
    return (
      <Link
        key={l.href}
        href={l.href}
        className={`block whitespace-nowrap rounded-md px-3 py-2 text-sm ${
          active
            ? "bg-neutral-900 text-white"
            : muted
            ? "text-neutral-500 hover:bg-neutral-100"
            : "text-neutral-800 hover:bg-neutral-100"
        }`}
      >
        {l.label}
      </Link>
    );
  };

  const sectionLabel = (t: string) => (
    <div className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
      {t}
    </div>
  );

  return (
    <aside className="hidden md:flex md:flex-col md:w-56 shrink-0 border-r border-neutral-200 bg-white overflow-y-auto">
      <div className="px-4 py-4">
        <Link href="/chat" className="block">
          <div className="text-sm font-semibold tracking-tight">Scout</div>
          <div className="text-xs text-neutral-500">Your Chief of Staff</div>
        </Link>
      </div>

      <nav className="px-2 pb-6">
        <div>{PRIMARY.map((l) => link(l))}</div>

        {sectionLabel("Overview")}
        <div>{OVERVIEW.map((l) => link(l))}</div>

        {sectionLabel("Compass")}
        <div>{BACKSTAGE.map((l) => link(l, true))}</div>

        <p className="px-3 pt-3 text-[11px] leading-snug text-neutral-400">
          Scout keeps Compass updated for you. These pages are for review,
          correction, and transparency.
        </p>
      </nav>
    </aside>
  );
}
