import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Label({
  children,
  htmlFor,
}: {
  children: ReactNode;
  htmlFor?: string | undefined;
}) {
  return (
    <label htmlFor={htmlFor} className="mb-2 block font-roboto text-micro uppercase tracking-[0.12em] text-graphite">
      {children}
    </label>
  );
}

export function TextInput({ className, ...rest }: ComponentProps<"input">) {
  return (
    <input
      {...rest}
      className={cn(
        "w-full rounded-sharp border-0 bg-plaster px-4 py-3 text-body text-carbon outline-none focus:ring-2 focus:ring-sage",
        className,
      )}
    />
  );
}

export function TextArea({ className, ...rest }: ComponentProps<"textarea">) {
  return (
    <textarea
      {...rest}
      className={cn(
        "w-full rounded-sharp border-0 bg-plaster px-4 py-3 text-body text-carbon outline-none focus:ring-2 focus:ring-sage",
        className,
      )}
    />
  );
}

export function Select({ className, children, ...rest }: ComponentProps<"select">) {
  return (
    <select
      {...rest}
      className={cn(
        "w-full rounded-sharp border-0 bg-plaster px-4 py-3 text-body text-carbon outline-none focus:ring-2 focus:ring-sage",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <span className="mt-2 block text-body text-ash">{hint}</span> : null}
    </div>
  );
}
