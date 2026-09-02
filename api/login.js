// api/login.js
//
// Replaces doLogin()'s in-memory `db[email]` lookup. Verifies the
// password against the scrypt hash created in api/signup.js, then
// returns the user's full state (user_state + tasks + subtasks +
// events + notes + today's quest_progress) in one response so the
// frontend's enterApp()/renderAll() has everything it needs in a
// single fetch, instead of one request per table.

import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';

const sql = neon(process.env.DATABASE_URL);

function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const [salt, hashHex] = (stored || '').split(':');
    if (!salt || !hashHex) return resolve(false); // malformed/legacy hash
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      const stored = Buffer.from(hashHex, 'hex');
      // timingSafeEqual requires equal-length buffers, or it throws —
      // guard that first so a wrong-length hash can't crash the request.
      if (stored.length !== derivedKey.length) return resolve(false);
      resolve(crypto.timingSafeEqual(stored, derivedKey));
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email: rawEmail, password } = req.body || {};
    const email = (rawEmail || '').trim().toLowerCase();
    if (!email || !password) {
      return res.status(400).json({ error: 'Incorrect email or password.' });
    }

    const [user] = await sql`
      SELECT id, email, name, role, password_hash FROM users WHERE email = ${email}
    `;
    // Deliberately vague error (not "no such email" vs "wrong password")
    // so a login attempt can't be used to discover which emails have
    // accounts — same behavior the old doLogin() had.
    if (!user) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const [userState] = await sql`SELECT * FROM user_state WHERE user_id = ${user.id}`;

    const tasks = await sql`
      SELECT * FROM tasks WHERE user_id = ${user.id} ORDER BY sort_order ASC, id DESC
    `;
    const taskIds = tasks.map(t => t.id);
    const subtasks = taskIds.length
      ? await sql`SELECT * FROM subtasks WHERE task_id = ANY(${taskIds}) ORDER BY sort_order ASC, id ASC`
      : [];
    const subtasksByTask = {};
        for (const s of subtasks) {
      (subtasksByTask[s.task_id] = subtasksByTask[s.task_id] || []).push({
        id: s.id, t: s.text, done: s.done
      });
    }
    const tasksOut = tasks.map(t => ({
      id: t.id, title: t.title, due: t.due, zone: t.zone,
      rewarded: t.rewarded, celebrated: t.celebrated,
      subtasks: subtasksByTask[t.id] || []
    }));

    const events = await sql`
      SELECT id, title, event_date AS date, note FROM events
      WHERE user_id = ${user.id} ORDER BY event_date ASC
    `;

    const notes = await sql`
      SELECT id, title, body, updated_at AS "updatedAt" FROM notes
      WHERE user_id = ${user.id} ORDER BY updated_at DESC
    `;

    const today = new Date().toISOString().slice(0, 10);
    const questRows = await sql`
      SELECT quest_id, progress, claimed FROM quest_progress
      WHERE user_id = ${user.id} AND quest_date = ${today}
    `;
    const questProgress = {}, questClaimed = {};
    for (const q of questRows) {
      questProgress[q.quest_id] = q.progress;
      questClaimed[q.quest_id] = q.claimed;
    }

    return res.status(200).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      state: {
        initials: userState.initials,
        coins: userState.coins,
        xp: userState.xp,
        xpMax: userState.xp_max,
        level: userState.level,
        streak: userState.streak,
        lockInDay: userState.lock_in_day,
        lastCheckinDate: userState.last_checkin_date,
        premiumActive: userState.premium_active,
        premiumLabel: userState.premium_label,
        shieldOn: userState.shield_on,
        accentC1: userState.accent_c1,
        accentC2: userState.accent_c2,
        swatchIndex: userState.swatch_index,
        titleBadge: userState.title_badge,
        titleIndex: userState.title_index,
        darkMode: userState.dark_mode,
        quests: { date: today, progress: questProgress, claimed: questClaimed },
        tasks: tasksOut,
        events,
        notes
      }
    });
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
