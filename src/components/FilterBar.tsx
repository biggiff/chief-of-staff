import React from "react";

export function FilterBar({
  roleOpts,
  statusOpts,
  basePath,
  current,
  extra,
}: {
  roleOpts: { value: string; label: string }[];
  statusOpts: { value: string; label: string }[];
  basePath: string;
  current: Record<string, string | undefined>;
  extra?: React.ReactNode;
}) {
  return (
    <form method="GET" action={basePath} className="flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="block text-xs font-medium text-neutral-600 mb-1">Role</span>
        <select name="role" defaultValue={current.role ?? ""} className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm bg-white">
          <option value="">All roles</option>
          {roleOpts.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="block text-xs font-medium text-neutral-600 mb-1">Status</span>
        <select name="status" defaultValue={current.status ?? ""} className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm bg-white">
          <option value="">All statuses</option>
          {statusOpts.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      {extra}
      <button type="submit" className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100">
        Filter
      </button>
    </form>
  );
}
