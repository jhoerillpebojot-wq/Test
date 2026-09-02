// api/events.js
// Replaces the localStorage-only addEventManual()/deleteEvent()/quickAddDeadline().

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { action, userId } = req.body || {};
    if (!action || !userId) return res.status(400).json({ error: 'Missing action or userId' });

    if (action === 'create') {
      const { title, date, note } = req.body;
      if (!title || !date) return res.status(400).json({ error: 'Add a title and a date' });
      const [event] = await sql`
        INSERT INTO events (user_id, title, event_date, note)
        VALUES (${userId}, ${title}, ${date}, ${note || ''})
        RETURNING id, title, event_date AS date, note
      `;
      return res.status(200).json({ event });
    }

    if (action === 'delete') {
      const { eventId } = req.body;
      const [existing] = await sql`SELECT user_id FROM events WHERE id = ${eventId}`;
      if (!existing || existing.user_id !== userId) return res.status(404).json({ error: 'Event not found' });
      await sql`DELETE FROM events WHERE id = ${eventId}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('EVENTS ERROR:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
