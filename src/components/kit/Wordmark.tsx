import { Link } from "@tanstack/react-router";

import { cn } from "@/lib/utils";

const LINES = ["TIC", "KET", "ERA"] as const;

type WordmarkProps = {
  size?: "sm" | "md" | "lg";
  className?: string;
  asLink?: boolean;
};

const SIZES = {
  sm: "size-[18px] text-[10px]",
  md: "size-[24px] text-[13px]",
  lg: "size-[34px] text-[19px]",
} as const;

export function Wordmark({ size = "md", className, asLink = true }: WordmarkProps) {
  const mark = (
    <span className={cn("inline-flex flex-col bg-paper", className)} aria-label="Ticketera">
      {LINES.map((line) => (
        <span key={line} className="flex">
          {line.split("").map((letter, index) => (
            <span
              key={`${line}-${index}`}
              className={cn(
                "flex items-center justify-center border border-carbon text-carbon leading-none",
                SIZES[size],
              )}
              style={{ marginLeft: index === 0 ? 0 : -1 }}
            >
              {letter}
            </span>
          ))}
        </span>
      ))}
    </span>
  );

  if (!asLink) return mark;

  return (
    <Link to="/" className="inline-block" aria-label="Ticketera — inicio">
      {mark}
    </Link>
  );
}
