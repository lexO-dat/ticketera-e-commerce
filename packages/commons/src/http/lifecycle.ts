import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";

export type ShutdownHook = () => Promise<unknown>;

export interface RunServiceOptions {
  app: FastifyInstance;
  host: string;
  port: number;
  logger: Logger;
  /** Recursos a cerrar después de dejar de atender (en orden inverso al registro). */
  onShutdown?: ShutdownHook[];
  shutdownTimeoutMs?: number;
}

/**
 * Arranca el servidor y apaga limpio con SIGTERM/SIGINT (ADR-01: contenedores desechables):
 * 1. `/health/ready` pasa a 503 para que el balanceador deje de enviar tráfico.
 * 2. Fastify deja de aceptar conexiones y espera las solicitudes en curso.
 * 3. Se cierran BD, Redis, broker, jobs (hooks en orden inverso).
 * Si no termina en `shutdownTimeoutMs`, sale con código 1.
 */
export async function runService(options: RunServiceOptions): Promise<void> {
  const { app, logger } = options;
  const hooks = [...(options.onShutdown ?? [])].reverse();
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "apagando servicio");
    const timer = setTimeout(() => {
      logger.error("apagado excedió el tiempo límite; forzando salida");
      process.exit(1);
    }, options.shutdownTimeoutMs ?? 10_000);
    timer.unref();

    app.acceptingTraffic = false;
    let exitCode = 0;
    try {
      await app.close();
    } catch (error) {
      exitCode = 1;
      logger.error({ err: error }, "error cerrando el servidor HTTP");
    }
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        exitCode = 1;
        logger.error({ err: error }, "error en hook de apagado");
      }
    }
    logger.info("servicio detenido");
    process.exit(exitCode);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "promesa rechazada sin manejar");
  });

  await app.listen({ host: options.host, port: options.port });
}
