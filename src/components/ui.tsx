import React from "react";

export function PageShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="px-5 py-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-neutral-500 mt-0.5">{subtitle}</p>}
        </div>
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-neutral-200 bg-white p-4 ${className}`}>{children}</div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  thriving: "bg-emerald-100 text-emerald-800",
  healthy: "bg-green-100 text-green-800",
  maintaining: "bg-sky-100 text-sky-800",
  needs_attention: "bg-amber-100 text-amber-800",
  critical: "bg-red-100 text-red-800",
  high: "bg-red-50 text-red-700 border border-red-200",
  medium: "bg-amber-50 text-amber-700 border border-amber-200",
  low: "bg-neutral-100 text-neutral-600",
  active: "bg-sky-100 text-sky-800",
  open: "bg-sky-100 text-sky-800",
  completed: "bg-green-100 text-green-800",
  paused: "bg-neutral-100 text-neutral-600",
  archived: "bg-neutral-100 text-neutral-500",
  captured: "bg-violet-100 text-violet-800",
  decided: "bg-green-100 text-green-800",
  not_connected: "bg-neutral-100 text-neutral-500",
};

export function Badge({ value }: { value: string }) {
  const cls = STATUS_COLORS[value] ?? "bg-neutral-100 text-neutral-600";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

export function Field({
  label,
  name,
  defaultValue = "",
  type = "text",
  required = false,
  placeholder = "",
}: {
  label: string;
  name: string;
  defaultValue?: string | number | null;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-neutral-600 mb-1">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue ?? ""}
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
      />
    </label>
  );
}

export function TextArea({
  label,
  name,
  defaultValue = "",
  rows = 2,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  rows?: number;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-neutral-600 mb-1">{label}</span>
      <textarea
        name={name}
        rows={rows}
        defaultValue={defaultValue ?? ""}
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
      />
    </label>
  );
}

export function Select({
  label,
  name,
  options,
  defaultValue,
  includeBlank,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  defaultValue?: string | null;
  includeBlank?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-neutral-600 mb-1">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue ?? ""}
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
      >
        {includeBlank !== undefined && <option value="">{includeBlank}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function PrimaryButton({
  children,
  type = "submit",
}: {
  children: React.ReactNode;
  type?: "submit" | "button";
}) {
  return (
    <button
      type={type}
      className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800"
    >
      {children}
    </button>
  );
}

export function GhostButton({ children }: { children: React.ReactNode }) {
  return (
    <button
      type="submit"
      className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
    >
      {children}
    </button>
  );
}

export function Disclosure({
  summary,
  children,
}: {
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <details className="rounded-xl border border-neutral-200 bg-white">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-neutral-800">
        {summary}
      </summary>
      <div className="px-4 pb-4 pt-1">{children}</div>
    </details>
  );
}

export const IMPORTANCE_OPTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export const ROLE_STATUS_OPTS = [
  { value: "thriving", label: "Thriving" },
  { value: "healthy", label: "Healthy" },
  { value: "maintaining", label: "Maintaining" },
  { value: "needs_attention", label: "Needs attention" },
  { value: "critical", label: "Critical" },
];
