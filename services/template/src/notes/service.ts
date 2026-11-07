import { AppError, createEvent, newId } from "@shared/commons";
import { enqueueOutbox, withTransaction, type Pool } from "@shared/commons/db";
import { type Note, notesRepository } from "./repository.js";

export const SERVICE_SOURCE = "template";

/**
 * Lógica de negocio. El patrón que copia todo servicio: el cambio de estado y su evento se
 * escriben en la misma transacción (outbox); el relay publica el evento después.
 */
export function createNotesService(pool: Pool) {
  return {
    async create(text: string, correlationId?: string): Promise<Note> {
      return withTransaction(pool, async (client) => {
        const note = await notesRepository.insert(client, { id: newId(), text });
        await enqueueOutbox(
          client,
          createEvent({
            type: "NotaCreada",
            source: SERVICE_SOURCE,
            aggregateId: note.id,
            correlationId,
            data: { noteId: note.id },
          }),
        );
        return note;
      });
    },

    async get(id: string): Promise<Note> {
      const note = await notesRepository.findById(pool, id);
      if (!note) throw AppError.notFound("La nota no existe");
      return note;
    },
  };
}

export type NotesService = ReturnType<typeof createNotesService>;
