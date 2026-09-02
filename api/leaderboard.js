// api/leaderboard.js
// Replaces the fake npcClassmates + Object.values(db) leaderboard logic.
// Pulls real students straight from Postgres, ranked by total XP
// (level * xpMax + current xp, matching the frontend's own XP math).

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const rows = await sql`
      SELECT u.id, u.name, us.initials, us.level, us.xp, us.xp_max AS "xpMax", us.streak
      FROM users u
      JOIN user_state us ON us.user_id = u.id
      WHERE u.role = 'student'
      ORDER BY ((us.level - 1) * us.xp_max + us.xp) DESC
      LIMIT 50
    `;
    const leaderboard = rows.map(r => ({
      id: r.id,
      name: r.name,
      initials: r.initials,
      xp: (r.level - 1) * r.xpMax + r.xp,
      streak: r.streak
    }));
    return res.status(200).json({ leaderboard });
  } catch (err) {
    console.error('LEADERBOARD ERROR:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
