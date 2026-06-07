"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const COMPASS_LINKS: { href: string; label: string }[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/roles", label: "Roles" },
  { href: "/projects", label: "Projects" },
  { href: "/tasks", label: "Tasks" },
  { href: "/ideas", label: "Ideas" },
  { href: "/crossroads", label: "Crossroads" },
  { href: "/agreements", label: "Agreements" },
  { href: "/checkin", label: "Check-ins" },
  { href: "/briefing", label: "Briefings" },
  { href: "/observations", label: "Observations" },
  { href: "/review", label: "Review" },
  { href: "/integrations", label: "Integrations" },
  { href: "/settings", label: "Settings" },
];

/** Slim, always-present mobile bar: Scout on the left, one Compass door on the right. */
export default function MobileTopBar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  if (pathname === "/login") return null;

  return (
    <div className="md:hidden">
      <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 h-12">
        <Link href="/chat" className="text-sm font-semibold tracking-tight" onClick={() => setOpen(false)}>
          Scout
        </Link>
        <button
          onClick={() => setOpen((o) => !o)}
          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700"
          aria-expanded={open}
        >
          Compass
        </button>
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 z-50 border-b border-neutral-200 bg-white shadow-sm">
            <div className="px-3 py-2">
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                Compass
              </div>
              <div className="grid grid-cols-2 gap-1">
                {COMPASS_LINKS.map((l) => {
                  const active = pathname.startsWith(l.href);
                  return (
                    <Link
                      key={l.href}
                      href={l.href}
                      onClick={() => setOpen(false)}
                      className={`rounded-md px-3 py-2 text-sm ${
                        active ? "bg-neutral-900 text-white" : "text-neutral-700 hover:bg-neutral-100"
                      }`}
                    >
                      {l.label}
                    </Link>
                  );
                })}
              </div>
              <p className="px-2 pt-2 text-[11px] text-neutral-400">
                For review and correction — Scout keeps these updated for you.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
