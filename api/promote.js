// api/promote.js
//
// Turns an existing account into an admin, gated entirely by
// ADMIN_SECRET — deliberately NOT gated by "does an admin already
// exist" or by any session, since bootstrapping the first admin has to
// come from somewhere. Anyone who has the secret can promote any email.
// Treat the secret like a password: share it out of band (not in chat
// logs, not committed to the repo), rotate it in Vercel if you think
// it's leaked.

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email: rawEmail, secret } = req.body || {};
    const email = (rawEmail || '').trim().toLowerCase();

    if (!process.env.ADMIN_SECRET) {
      return res.status(500).json({ error: 'Admin promotion is not configured' });
    }
    // Constant-time-ish check isn't critical here (this isn't a login
    // path attackers can brute-force at volume the same way), but a
    // plain !== is fine for a secret this long — timing differences on
    // a string compare aren't a practical leak vector at this scale.
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Invalid secret' });
    }
    if (!email) {
      return res.status(400).json({ error: 'Missing email' });
    }

    const [updated] = await sql`
      UPDATE users SET role = 'admin' WHERE email = ${email}
      RETURNING id, email, name, role
    `;
    if (!updated) {
      return res.status(404).json({ error: 'No account with that email' });
    }

    return res.status(200).json({ user: updated });
  } catch (err) {
    console.error('PROMOTE ERROR:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
