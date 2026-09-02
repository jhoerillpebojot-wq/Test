// api/admin.js
//
// Admin-only actions for testing/support: adjust a student's coins/XP
// directly, grant or revoke Premium, delete an account, or list every
// account (the admin screen previously rendered from the client-side
// `db` cache, which only ever held whichever accounts had logged in on
// THIS browser — never a real roster, and none of its buttons persisted
// to Postgres at all).
//
// AUTH GAP: adminUserId is trusted from the request body, then checked
// against `role` in the DB. There's no session yet, so this is only as
// safe as the userId being hard to guess/leak. Do not ship this to real
// users without real session auth in front of it.

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

async function requireAdmin(userId) {
  if (!userId) return false;
  const [row] = await sql`SELECT role FROM users WHERE id = ${userId}`;
  return !!row && row.role === 'admin';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, adminUserId } = req.body || {};
    if (!action) return res.status(400).json({ error: 'Missing action' });

    const isAdmin = await requireAdmin(adminUserId);
    if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });

    // ---------------- list every account ----------------
    if (action === 'list') {
      const rows = await sql`
        SELECT u.id, u.name, u.email, u.role,
               us.initials, us.coins, us.xp, us.xp_max AS "xpMax", us.level,
               us.streak, us.lock_in_day AS "lockInDay",
               us.premium_active AS "premiumActive", us.premium_label AS "premiumLabel"
        FROM users u
        JOIN user_state us ON us.user_id = u.id
        ORDER BY u.id ASC
      `;
      const users = rows.map(r => ({ ...r, id: Number(r.id) }));
      const totalCoins = users.reduce((sum, r) => sum + r.coins, 0);
      const premiumCount = users.filter(r => r.premiumActive).length;
      return res.status(200).json({ users, totalCoins, premiumCount });
    }

    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'Missing targetUserId' });

    // ---------------- give coins (delta, can be negative) ----------------
    if (action === 'giveCoins') {
      const amount = Number(req.body.amount);
      if (!Number.isFinite(amount)) return res.status(400).json({ error: 'Invalid amount' });
      const [updated] = await sql`
        UPDATE user_state SET coins = GREATEST(0, coins + ${amount}), updated_at = now()
        WHERE user_id = ${targetUserId}
        RETURNING coins
      `;
      if (!updated) return res.status(404).json({ error: 'Account not found' });
      return res.status(200).json({ coins: updated.coins });
    }

    // ---------------- give XP (handles level-up overflow, same math as grantReward) ----------------
    if (action === 'giveXp') {
      const amount = Number(req.body.amount);
      if (!Number.isFinite(amount)) return res.status(400).json({ error: 'Invalid amount' });
      const [row] = await sql`SELECT xp, xp_max, level FROM user_state WHERE user_id = ${targetUserId}`;
      if (!row) return res.status(404).json({ error: 'Account not found' });
      let newXp = row.xp + amount, newLevel = row.level;
      while (newXp >= row.xp_max) { newXp -= row.xp_max; newLevel += 1; }
      while (newXp < 0 && newLevel > 1) { newLevel -= 1; newXp += row.xp_max; }
      newXp = Math.max(0, newXp);
      const [updated] = await sql`
        UPDATE user_state SET xp = ${newXp}, level = ${newLevel}, updated_at = now()
        WHERE user_id = ${targetUserId}
        RETURNING xp, level, xp_max AS "xpMax"
      `;
      return res.status(200).json(updated);
    }

    // ---------------- set coins to an exact value (e.g. "Max coins" test button) ----------------
    if (action === 'setCoins') {
      const value = Number(req.body.value);
      if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: 'Invalid value' });
      const [updated] = await sql`
        UPDATE user_state SET coins = ${value}, updated_at = now()
        WHERE user_id = ${targetUserId}
        RETURNING coins
      `;
      if (!updated) return res.status(404).json({ error: 'Account not found' });
      return res.status(200).json({ coins: updated.coins });
    }

    // ---------------- grant/revoke premium ----------------
    if (action === 'grantPremium') {
      const [updated] = await sql`
        UPDATE user_state SET premium_active = true, premium_label = 'via admin grant', updated_at = now()
        WHERE user_id = ${targetUserId}
        RETURNING premium_active AS "premiumActive", premium_label AS "premiumLabel"
      `;
      if (!updated) return res.status(404).json({ error: 'Account not found' });
      return res.status(200).json(updated);
    }
    if (action === 'revokePremium') {
      const [updated] = await sql`
        UPDATE user_state SET premium_active = false, premium_label = '', shield_on = false, updated_at = now()
        WHERE user_id = ${targetUserId}
        RETURNING premium_active AS "premiumActive", premium_label AS "premiumLabel"
      `;
      if (!updated) return res.status(404).json({ error: 'Account not found' });
      return res.status(200).json(updated);
    }

    // ---------------- delete account ----------------
    if (action === 'delete') {
      const [target] = await sql`SELECT role FROM users WHERE id = ${targetUserId}`;
      if (!target) return res.status(404).json({ error: 'Account not found' });
      if (target.role === 'admin') return res.status(400).json({ error: "Can't delete an admin account" });

      // No FK cascade assumed — delete dependent rows first, in order.
      // Not wrapped in a transaction (same known gap as tasks.js); a
      // failure mid-way could leave orphaned rows, acceptable for a
      // testing/admin tool but worth revisiting before this is load-bearing.
      const taskRows = await sql`SELECT id FROM tasks WHERE user_id = ${targetUserId}`;
      const taskIds = taskRows.map(t => t.id);
      if (taskIds.length) await sql`DELETE FROM subtasks WHERE task_id = ANY(${taskIds})`;
      await sql`DELETE FROM tasks WHERE user_id = ${targetUserId}`;
      await sql`DELETE FROM events WHERE user_id = ${targetUserId}`;
      await sql`DELETE FROM notes WHERE user_id = ${targetUserId}`;
      await sql`DELETE FROM quest_progress WHERE user_id = ${targetUserId}`;
      await sql`DELETE FROM user_state WHERE user_id = ${targetUserId}`;
      await sql`DELETE FROM users WHERE id = ${targetUserId}`;

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('ADMIN ERROR:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
