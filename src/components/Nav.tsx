"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: { href: string; label: string }[] = [
  { href: "/chat", label: "Chat" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/roles", label: "Roles" },
  { href: "/projects", label: "Projects" },
  { href: "/tasks", label: "Tasks" },
  { href: "/ideas", label: "Ideas" },
  { href: "/checkin", label: "Check-in" },
  { href: "/briefing", label: "Briefing" },
  { href: "/decisions", label: "Decisions" },
  { href: "/integrations", label: "Integrations" },
  { href: "/settings", label: "Settings" },
];

export default function Nav() {
  const pathname = usePathname();
  if (pathname === "/login") return null;
  return (
    <aside className="w-full md:w-52 shrink-0 border-b md:border-b-0 md:border-r border-neutral-200 bg-white">
      <div className="px-4 py-4">
        <Link href="/chat" className="block">
          <div className="text-sm font-semibold tracking-tight">Chief of Staff</div>
          <div className="text-xs text-neutral-500">Your roles, managed</div>
        </Link>
      </div>
      <nav className="px-2 pb-4 flex md:block gap-1 overflow-x-auto">
        {LINKS.map((l) => {
          const active = pathname === l.href || pathname.startsWith(l.href + "/");
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`block whitespace-nowrap rounded-md px-3 py-2 text-sm ${
                active
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-700 hover:bg-neutral-100"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
