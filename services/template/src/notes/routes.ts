import { parseInput } from "@shared/commons/http";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Note } from "./repository.js";
import type { NotesService } from "./service.js";

const createNoteBody = z.strictObject({ text: z.string().trim().min(1).max(500) });
const noteParams = z.object({ id: z.uuid() });

function present(note: Note) {
  return { id: note.id, text: note.text, createdAt: note.createdAt.toISOString() };
}

/** Controlador HTTP: valida la entrada con Zod en el borde y delega en el servicio. */
export function registerNotesRoutes(app: FastifyInstance, notes: NotesService): void {
  app.post("/v1/notes", async (request, reply) => {
    const body = parseInput(createNoteBody, request.body);
    const note = await notes.create(body.text, request.id);
    return reply.status(201).send(present(note));
  });

  app.get("/v1/notes/:id", async (request) => {
    const { id } = parseInput(noteParams, request.params);
    return present(await notes.get(id));
  });
}
