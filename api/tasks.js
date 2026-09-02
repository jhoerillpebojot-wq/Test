// api/tasks.js
//
// Replaces the localStorage-only logic in addTask(), toggleSub(),
// addSub(), removeSub(), and quickToggle(). All reward math (coins/XP,
// the "rewarded" guard that stops coin-farming, and today's quest
// progress) now happens server-side against Postgres, since the
// browser can no longer be trusted as the source of truth.
//
// NOTE (see chat): userId is trusted from the request body — there's
// no real session/auth yet. Also no multi-statement DB transaction —
// each step below is a separate awaited query. Both are known gaps,
// not final design.

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

async function loadTaskWithOwnerCheck(taskId, userId) {
  const [task] = await sql`SELECT * FROM tasks WHERE id = ${taskId}`;
  if (!task || task.user_id !== userId) return null;
  return task;
}

async function bumpQuestServer(userId, questId, amount, target, today) {
  await sql`
    INSERT INTO quest_progress (user_id, quest_date, quest_id, progress, claimed)
    VALUES (${userId}, ${today}, ${questId}, LEAST(${target}, ${amount}), false)
    ON CONFLICT (user_id, quest_date, quest_id)
    DO UPDATE SET progress = LEAST(${target}, quest_progress.progress + ${amount})
  `;
}

async function grantReward(userId, coins, xp) {
  // xp/level math mirrors addXp() in the frontend: overflow XP rolls
  // into levels, one level per xpMax "loop", using the user's own xpMax.
  const [row] = await sql`
    SELECT xp, xp_max, level, coins FROM user_state WHERE user_id = ${userId}
  `;
  let newXp = row.xp + xp;
  let newLevel = row.level;
  while (newXp >= row.xp_max) {
    newXp -= row.xp_max;
    newLevel += 1;
  }
  const [updated] = await sql`
    UPDATE user_state
    SET coins = coins + ${coins}, xp = ${newXp}, level = ${newLevel}, updated_at = now()
    WHERE user_id = ${userId}
    RETURNING coins, xp, xp_max AS "xpMax", level
  `;
  return updated;
}

async function subtasksFor(taskId) {
  const rows = await sql`
    SELECT id, text AS t, done FROM subtasks WHERE task_id = ${taskId} ORDER BY sort_order ASC, id ASC
  `;
  // Postgres BIGINT ids come back as text strings from the driver — cast
  // to Number so the frontend's === comparisons (openTaskId, etc) work.
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, userId } = req.body || {};
    if (!action || !userId) {
      return res.status(400).json({ error: 'Missing action or userId' });
    }

    // ---------------- create a new task ----------------
    if (action === 'create') {
      const { title, due, zone } = req.body;
      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: 'Give the task a title first' });
      }
      const [task] = await sql`
        INSERT INTO tasks (user_id, title, due, zone)
        VALUES (${userId}, ${title.trim()}, ${due?.trim() || 'no date set'}, ${zone || 'chill'})
        RETURNING id, title, due, zone, rewarded, celebrated
      `;
      await sql`
        INSERT INTO subtasks (task_id, text, done)
        VALUES (${task.id}, 'Get started', false)
      `;
      const subtasks = await subtasksFor(task.id);
      return res.status(200).json({ task: { ...task, id: Number(task.id), subtasks } });
    }

    // Every other action operates on an existing task — load + verify
    // ownership once here so each branch below doesn't repeat it.
    const { taskId } = req.body;
    const task = taskId ? await loadTaskWithOwnerCheck(taskId, userId) : null;
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // ---------------- add a subtask (new step) ----------------
    if (action === 'addSubtask') {
      const { text } = req.body;
      if (!text || !String(text).trim()) return res.status(400).json({ error: 'Step text required' });
      await sql`INSERT INTO subtasks (task_id, text, done) VALUES (${task.id}, ${text.trim()}, false)`;
      // A genuinely new step means this task can earn its completion
      // reward again once every step (including this one) is finished —
      // same rule as the original addSub().
      await sql`UPDATE tasks SET rewarded = false WHERE id = ${task.id}`;
      const subtasks = await subtasksFor(task.id);
      return res.status(200).json({ subtasks, rewarded: false });
    }

    // ---------------- remove a subtask ----------------
    if (action === 'removeSubtask') {
      const { subtaskId } = req.body;
      await sql`DELETE FROM subtasks WHERE id = ${subtaskId} AND task_id = ${task.id}`;
      const subtasks = await subtasksFor(task.id);
      return res.status(200).json({ subtasks });
    }

    // ---------------- toggle one subtask ----------------
    if (action === 'toggleSubtask') {
      const { subtaskId } = req.body;
      await sql`
        UPDATE subtasks SET done = NOT done WHERE id = ${subtaskId} AND task_id = ${task.id}
      `;
      const subtasks = await subtasksFor(task.id);
      const allDone = subtasks.length > 0 && subtasks.every(s => s.done);

      let userState = null, justRewarded = false;
      if (allDone && !task.rewarded) {
        await sql`UPDATE tasks SET rewarded = true WHERE id = ${task.id}`;
        userState = await grantReward(userId, 50, 30);
        await bumpQuestServer(userId, 'completeTask', 1, 1);
        justRewarded = true;
      }
      return res.status(200).json({ subtasks, rewarded: allDone || task.rewarded, justRewarded, userState });
    }

    // ---------------- quick-complete / un-complete all (home screen) ----------------
    if (action === 'quickToggle') {
      const subtasksNow = await subtasksFor(task.id);
      const allDone = subtasksNow.length > 0 && subtasksNow.every(s => s.done);
      const setTo = !allDone;
      await sql`UPDATE subtasks SET done = ${setTo} WHERE task_id = ${task.id}`;

      let userState = null, justRewarded = false;
      if (setTo && !task.rewarded) {
        await sql`UPDATE tasks SET rewarded = true WHERE id = ${task.id}`;
        userState = await grantReward(userId, 20, 15);
        await bumpQuestServer(userId, 'completeTask', 1, 1);
        justRewarded = true;
      }
      const subtasks = await subtasksFor(task.id);
      return res.status(200).json({ subtasks, rewarded: setTo || task.rewarded, justRewarded, userState });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('TASKS ERROR:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
