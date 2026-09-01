import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Hero a sangre completa: la imagen ocupa todo el ancho y el texto se lee
 * sobre un velo oscuro (scrim) en degradado, manteniendo el contraste alto.
 */
export function HeroMedia({
  imageUrl,
  alt,
  children,
  height = "tall",
  align = "bottom",
  className,
}: {
  imageUrl?: string | null;
  alt: string;
  children: ReactNode;
  height?: "tall" | "short";
  align?: "bottom" | "center";
  className?: string;
}) {
  return (
    <section
      className={cn(
        "relative isolate w-full overflow-hidden bg-carbon",
        height === "tall"
          ? "min-h-[74svh] md:min-h-[82svh]"
          : "min-h-[52svh] md:min-h-[60svh]",
        className,
      )}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={alt}
          className="absolute inset-0 -z-10 size-full object-cover object-center"
        />
      ) : null}

      {/* Scrim: vertical para legibilidad del bloque de texto + lateral suave. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-gradient-to-t from-carbon via-carbon/70 to-carbon/10"
      />
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-gradient-to-r from-carbon/80 via-carbon/20 to-transparent"
      />

      <div
        className={cn(
          "mx-auto flex h-full w-full max-w-[1240px] px-5 md:px-8",
          height === "tall" ? "min-h-[74svh] md:min-h-[82svh]" : "min-h-[52svh] md:min-h-[60svh]",
          align === "bottom" ? "items-end pb-14 pt-24 md:pb-20" : "items-center py-20",
        )}
      >
        <div className="w-full max-w-[720px] text-paper">{children}</div>
      </div>
    </section>
  );
}
