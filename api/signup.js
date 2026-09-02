// api/signup.js
// Replaces the in-memory `db[email] = {...}` creation in doSignup().
// Creates a row in `users` AND a matching row in `user_state`
// (1:1, matching freshState() defaults from the frontend).
//
// Password hashing: uses Node's built-in `crypto.scrypt` — a real,
// slow, salted hash. This is NOT the same as hashPass() in the old
// code (which was reversible base64 — never use that for real auth).
// scrypt is available with zero extra npm installs, which keeps this
// route dependency-free besides the Postgres driver.
//
// Admin signup: if the request includes `adminSecret` and it matches
// process.env.ADMIN_SECRET, the new account is created as role 'admin'
// instead of 'student'. A missing or wrong secret just silently falls
// back to 'student' — no error message reveals whether a guess was
// close, so this can't be probed for the secret's value.
import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';
const sql = neon(process.env.DATABASE_URL);
function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
// Returns "salt:hash" as a single string so it fits in one TEXT column.
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(salt + ':' + derivedKey.toString('hex'));
    });
  });
}
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { name, email: rawEmail, password, password2, adminSecret } = req.body || {};
    const email = (rawEmail || '').trim().toLowerCase();
    const trimmedName = (name || '').trim();
    // Same validation doSignup() already does client-side — repeated here
    // because client-side checks are just UX, never real security. A
    // request could hit this endpoint directly, skipping the form.
    if (!trimmedName) return res.status(400).json({ error: 'Enter your name.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (password2 !== undefined && password !== password2) return res.status(400).json({ error: "Passwords don't match." });
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const wantsAdmin = !!adminSecret && !!process.env.ADMIN_SECRET && adminSecret === process.env.ADMIN_SECRET;
    const role = wantsAdmin ? 'admin' : 'student';

    const passwordHash = await hashPassword(password);
    const [user] = await sql`
      INSERT INTO users (email, name, role, password_hash)
      VALUES (${email}, ${trimmedName}, ${role}, ${passwordHash})
      RETURNING id, email, name, role
    `;
    // Mirrors freshState()'s defaults from the frontend (coins:50, xp:0,
    // xpMax:500, level:1, initials from name, etc). Everything else in
    // user_state already has a matching DB default, so we only need to
    // pass the two that depend on this specific signup.
    const initials = trimmedName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(p => p[0].toUpperCase())
      .join('') || 'ST';
    await sql`
      INSERT INTO user_state (user_id, initials)
      VALUES (${user.id}, ${initials})
    `;
    // The frontend's freshState() also seeds one starter task
    // ("Try Proacta out") with one subtask. Mirrored here so a new
    // account looks the same as it did under the old localStorage flow.
    const [starterTask] = await sql`
      INSERT INTO tasks (user_id, title, due, zone)
      VALUES (${user.id}, 'Try Proacta out', 'today', 'chill')
      RETURNING id
    `;
    await sql`
      INSERT INTO subtasks (task_id, text, done)
      VALUES (${starterTask.id}, 'Add your first real task below', false)
    `;
    return res.status(200).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    });
  } catch (err) {
    console.error('SIGNUP ERROR:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
