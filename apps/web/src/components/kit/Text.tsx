import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function DisplayHeading({
  children,
  className,
  rule = true,
  as: As = "h1",
}: {
  children: ReactNode;
  className?: string;
  rule?: boolean;
  as?: "h1" | "h2";
}) {
  return (
    <div className={cn("inline-block", className)}>
      <As className="text-[34px] leading-[1.08] sm:text-heading-lg md:text-display">{children}</As>
      {rule ? <div aria-hidden className="mt-4 h-[3px] w-full bg-sage" /> : null}
    </div>
  );
}

export function SectionTitle({
  children,
  className,
  as: As = "h2",
}: {
  children: ReactNode;
  className?: string;
  as?: "h2" | "h3";
}) {
  return (
    <As className={cn("text-[22px] leading-[1.2] sm:text-heading-sm md:text-heading", className)}>
      {children}
    </As>
  );
}

export function Lead({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-lead leading-[1.35] sm:text-subheading", className)}>{children}</p>;
}

export function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-body", className)}>{children}</p>;
}

export function MetaText({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("block text-body text-ash", className)}>{children}</span>;
}

export function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("block font-roboto text-caption tracking-[0.14em] uppercase", className)}>
      {children}
    </span>
  );
}

export function UrgencyTag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-body text-ember", className)}>{children}</span>;
}

export function Hairline({ className }: { className?: string }) {
  return <div aria-hidden className={cn("h-px w-full bg-carbon", className)} />;
}

export function SectionBand({
  children,
  tone = "paper",
  className,
  ...rest
}: { tone?: "paper" | "linen"; children: ReactNode } & ComponentProps<"section">) {
  return (
    <section
      {...rest}
      className={cn(tone === "linen" ? "bg-linen" : "bg-paper", "py-16 md:py-24", className)}
    >
      {children}
    </section>
  );
}
