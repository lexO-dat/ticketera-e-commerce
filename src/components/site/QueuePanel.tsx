import { Caption, DisplayHeading, MetaText, SectionTitle } from "@/components/kit/Text";

export type QueueView = {
  state: "waiting" | "active" | "expired";
  position: number;
  ahead: number;
  totalInQueue: number;
  etaSeconds: number;
  expiresAt: string | null;
  windowMinutes: number;
  message: string | null;
};

function eta(seconds: number) {
  if (seconds <= 0) return "menos de un minuto";
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (min === 0) return `${sec} segundos`;
  return `${min} min ${String(sec).padStart(2, "0")} s`;
}

export function QueuePanel({ view, eventTitle }: { view: QueueView; eventTitle: string }) {
  const progress =
    view.totalInQueue > 0
      ? Math.min(100, Math.max(2, ((view.totalInQueue - view.ahead) / view.totalInQueue) * 100))
      : 100;

  return (
    <div className="mx-auto grid max-w-[720px] gap-8 py-16">
      <Caption className="text-graphite">Fila virtual</Caption>
      <DisplayHeading>
        {view.state === "expired" ? "Tu ventana expiró" : "Estás en la fila"}
      </DisplayHeading>
      <SectionTitle className="text-graphite">{eventTitle}</SectionTitle>

      {view.state === "expired" ? (
        <MetaText>
          El tiempo para completar tu compra terminó. Recarga la página para volver a la fila.
        </MetaText>
      ) : (
        <>
          <div className="grid gap-4">
            <div className="h-1 w-full bg-linen">
              <div className="h-1 bg-sage transition-all duration-700" style={{ width: `${progress}%` }} />
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <span className="text-subheading">{view.ahead} personas antes que tú</span>
              <MetaText className="inline">Tiempo estimado: {eta(view.etaSeconds)}</MetaText>
            </div>
          </div>

          <div className="grid gap-2 rounded-card bg-plaster p-6">
            <MetaText>
              {view.message ??
                "No cierres esta ventana. Cuando sea tu turno se abrirá la selección de asientos automáticamente."}
            </MetaText>
            <MetaText>
              Al activarse tu turno tendrás {view.windowMinutes} minutos para elegir y pagar.
            </MetaText>
          </div>

          <MetaText>
            Posición inicial en la fila: {view.position} · Total en fila: {view.totalInQueue}
          </MetaText>
        </>
      )}
    </div>
  );
}
