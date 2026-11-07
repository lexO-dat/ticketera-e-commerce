import type { Queryable } from "@shared/commons/db";

export interface Note {
  id: string;
  text: string;
  createdAt: Date;
}

interface NoteRow {
  id: string;
  text: string;
  created_at: Date;
}

function toNote(row: NoteRow): Note {
  return { id: row.id, text: row.text, createdAt: row.created_at };
}

/** Acceso a datos: solo SQL parametrizado, sin lógica de negocio. */
export const notesRepository = {
  async insert(db: Queryable, note: { id: string; text: string }): Promise<Note> {
    const { rows } = await db.query<NoteRow>(
      "insert into notes (id, text) values ($1, $2) returning id, text, created_at",
      [note.id, note.text],
    );
    return toNote(rows[0]!);
  },

  async findById(db: Queryable, id: string): Promise<Note | undefined> {
    const { rows } = await db.query<NoteRow>(
      "select id, text, created_at from notes where id = $1",
      [id],
    );
    return rows[0] ? toNote(rows[0]) : undefined;
  },
};
