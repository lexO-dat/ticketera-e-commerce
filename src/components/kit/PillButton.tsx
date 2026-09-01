import { createLink } from "@tanstack/react-router";
import { forwardRef, type ComponentProps, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-button bg-sage px-5 py-2.5 text-center text-lead text-carbon transition-opacity disabled:opacity-40 disabled:pointer-events-none hover:opacity-90";

type PillProps = {
  children: ReactNode;
  /** @deprecated el punto decorativo se eliminó del sistema. */
  dot?: boolean;
  className?: string;
};

export function PillButton({
  children,
  dot: _dot,
  className,
  ...rest
}: PillProps & ComponentProps<"button">) {
  return (
    <button
      {...rest}
      className={cn(BASE, "shadow-pill", className)}
      style={{ boxShadow: "rgba(0, 0, 0, 0.25) 0px 0px 10px 0px" }}
    >
      <span>{children}</span>
    </button>
  );
}

const PillAnchor = forwardRef<
  HTMLAnchorElement,
  ComponentPropsWithoutRef<"a"> & { dot?: boolean }
>(({ children, dot: _dot, className, ...rest }, ref) => (
  <a
    ref={ref}
    {...rest}
    className={cn(BASE, className)}
    style={{ boxShadow: "rgba(0, 0, 0, 0.25) 0px 0px 10px 0px" }}
  >
    <span>{children}</span>
  </a>
));
PillAnchor.displayName = "PillAnchor";

export const PillLink = createLink(PillAnchor);

export function GhostButton({
  children,
  className,
  arrow = true,
  ...rest
}: { arrow?: boolean } & ComponentProps<"button">) {
  return (
    <button
      {...rest}
      className={cn(
        "inline-flex items-center gap-2 bg-transparent text-body text-carbon transition-opacity hover:opacity-60 disabled:opacity-40",
        className,
      )}
    >
      <span>{children}</span>
      {arrow ? <span aria-hidden>→</span> : null}
    </button>
  );
}

export function OutlineButton({ children, className, ...rest }: ComponentProps<"button">) {
  return (
    <button
      {...rest}
      className={cn(
        "inline-flex items-center gap-2 rounded-sharp border border-graphite px-4 py-2 text-body text-carbon transition-colors hover:bg-plaster disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

const OutlineAnchor = forwardRef<HTMLAnchorElement, ComponentPropsWithoutRef<"a">>(
  ({ children, className, ...rest }, ref) => (
    <a
      ref={ref}
      {...rest}
      className={cn(
        "inline-flex items-center gap-2 rounded-sharp border border-graphite px-4 py-2 text-body text-carbon transition-colors hover:bg-plaster",
        className,
      )}
    >
      {children}
    </a>
  ),
);
OutlineAnchor.displayName = "OutlineAnchor";

export const OutlineLink = createLink(OutlineAnchor);
