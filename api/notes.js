// api/notes.js
// Replaces the localStorage-only saveCurrentNote()/deleteCurrentNote().

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { action, userId } = req.body || {};
    if (!action || !userId) return res.status(400).json({ error: 'Missing action or userId' });

    if (action === 'save') {
      const { noteId, title, body } = req.body;
      if (!title && !body) return res.status(400).json({ error: 'Write something first' });

      if (noteId) {
        const [existing] = await sql`SELECT user_id FROM notes WHERE id = ${noteId}`;
        if (!existing || existing.user_id !== userId) return res.status(404).json({ error: 'Note not found' });
        const [note] = await sql`
          UPDATE notes SET title = ${title || ''}, body = ${body || ''}, updated_at = now()
          WHERE id = ${noteId}
          RETURNING id, title, body, updated_at AS "updatedAt"
        `;
        return res.status(200).json({ note });
      } else {
        const [note] = await sql`
          INSERT INTO notes (user_id, title, body)
          VALUES (${userId}, ${title || ''}, ${body || ''})
          RETURNING id, title, body, updated_at AS "updatedAt"
        `;
        return res.status(200).json({ note });
      }
    }

    if (action === 'delete') {
      const { noteId } = req.body;
      const [existing] = await sql`SELECT user_id FROM notes WHERE id = ${noteId}`;
      if (!existing || existing.user_id !== userId) return res.status(404).json({ error: 'Note not found' });
      await sql`DELETE FROM notes WHERE id = ${noteId}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('NOTES ERROR:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
