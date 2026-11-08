import { Caption, DisplayHeading, MetaText, SectionTitle } from "@/components/kit/Text";

export type { QueueView } from "@/lib/queue.functions";
import type { QueueView } from "@/lib/queue.functions";

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
        {view.state === "expired"
          ? "Tu turno terminó"
          : view.state === "prequeue"
            ? "La venta aún no abre"
            : "Estás en la fila"}
      </DisplayHeading>
      <SectionTitle className="text-graphite">{eventTitle}</SectionTitle>

      {view.state === "expired" ? (
        <MetaText>
          Tu ventana de compra venció o dejaste la fila. Recarga la página para volver a entrar
          (quedarás al final).
        </MetaText>
      ) : (
        <>
          <div className="grid gap-4">
            <div className="h-1 w-full bg-linen">
              <div
                className="h-1 bg-sage transition-all duration-700"
                style={{ width: `${progress}%` }}
              />
            </div>
            {view.state === "prequeue" ? (
              <span className="text-subheading">
                Al abrir la venta se sortea el orden entre quienes ya están esperando
                {view.opensAt ? ` (${new Date(view.opensAt).toLocaleString("es-CL")})` : ""}.
              </span>
            ) : (
              <div className="flex flex-wrap items-baseline justify-between gap-4">
                <span className="text-subheading">{view.ahead} personas antes que tú</span>
                <MetaText className="inline">Tiempo estimado: {eta(view.etaSeconds)}</MetaText>
              </div>
            )}
          </div>

          <div className="grid gap-2 rounded-card bg-plaster p-6">
            <MetaText>
              {view.message ??
                "Puedes recargar la página: tu turno se conserva. Cuando sea tu turno se abrirá la selección de asientos."}
            </MetaText>
            <MetaText>
              Al activarse tu turno tendrás {view.windowMinutes} minutos para elegir y pagar.
            </MetaText>
          </div>

          <MetaText>
            Tu posición: {view.position || "—"} · En espera: {view.totalInQueue}
          </MetaText>
        </>
      )}
    </div>
  );
}
