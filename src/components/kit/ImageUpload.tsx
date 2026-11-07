import { useMutation } from "@tanstack/react-query";
import { useId } from "react";

import { adminUploadImage } from "@/lib/admin.functions";
import { GhostButton } from "./PillButton";
import { MetaText } from "./Text";

/**
 * Subida de imágenes al catálogo (media propia). El servidor valida el contenido real del
 * archivo y lo re-codifica a WebP sin metadatos; aquí solo se filtra por tipo para la UX.
 */
export function ImageUpload({
  imageUrl,
  onChange,
}: {
  imageUrl: string | null;
  onChange: (image: { id: string; url: string } | null) => void;
}) {
  const inputId = useId();
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return adminUploadImage({ data: form });
    },
    onSuccess: (image) => onChange({ id: image.id, url: image.url }),
  });

  return (
    <div className="grid gap-3">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt="Imagen actual"
          className="aspect-[16/9] w-full max-w-xs rounded-card object-cover"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <input
          id={inputId}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
          className="text-body"
          disabled={upload.isPending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
            event.target.value = "";
          }}
        />
        {imageUrl ? (
          <GhostButton arrow={false} onClick={() => onChange(null)}>
            <span className="underline">Quitar</span>
          </GhostButton>
        ) : null}
      </div>
      {upload.isPending ? <MetaText>Subiendo…</MetaText> : null}
      {upload.error ? <MetaText className="text-ember">{upload.error.message}</MetaText> : null}
      <MetaText>JPEG, PNG, WebP, AVIF o GIF · máx. 8 MB</MetaText>
    </div>
  );
}
