const db = require('../db/index')

async function runExecutionAgent(context) {
  const { operations, readFilter } = context.plan
  const operationsCompleted = []
  const affectedTaskIds = []

  for (const op of operations) {
    if (op.type === 'create') {
      const { title, date, time, priority, category } = op.data
      const today = new Date().toISOString().split('T')[0]
      const result = await db.query(
        `INSERT INTO tasks (title, date, time, priority, category)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [title, date || today, time || null, priority || 'medium', category || null]
      )
      const created = result.rows[0]
      operationsCompleted.push({ type: 'create', task: created })
      affectedTaskIds.push(created.id)

    } else if (op.type === 'update') {
      const { title, date, time, status, priority, category } = op.data
      const setClauses = []
      const values = [op.taskId]
      let idx = 2
      if (title !== null && title !== undefined) { setClauses.push(`title = $${idx++}`); values.push(title) }
      if (date !== null && date !== undefined) { setClauses.push(`date = $${idx++}`); values.push(date) }
      if (time !== null && time !== undefined) { setClauses.push(`time = $${idx++}`); values.push(time) }
      if (status !== null && status !== undefined) { setClauses.push(`status = $${idx++}`); values.push(status) }
      if (priority !== null && priority !== undefined) { setClauses.push(`priority = $${idx++}`); values.push(priority) }
      if (category !== null && category !== undefined) { setClauses.push(`category = $${idx++}`); values.push(category) }

      if (setClauses.length === 0) {
        operationsCompleted.push({ type: 'update', task: null, note: 'no fields to update' })
        continue
      }

      const result = await db.query(
        `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
        values
      )
      const updated = result.rows[0]
      operationsCompleted.push({ type: 'update', task: updated })
      if (updated) affectedTaskIds.push(updated.id)

    } else if (op.type === 'complete') {
      const result = await db.query(
        `UPDATE tasks SET status = 'done' WHERE id = $1 RETURNING *`,
        [op.taskId]
      )
      const completed = result.rows[0]
      operationsCompleted.push({ type: 'complete', task: completed })
      if (completed) affectedTaskIds.push(completed.id)

    } else if (op.type === 'delete') {
      if (op.confirmed !== true) {
        operationsCompleted.push({ type: 'delete', skipped: true, reason: 'awaiting confirmation' })
        continue
      }
      const result = await db.query(
        `DELETE FROM tasks WHERE id = $1 RETURNING *`,
        [op.taskId]
      )
      const deleted = result.rows[0]
      operationsCompleted.push({ type: 'delete', task: deleted })
      if (deleted) affectedTaskIds.push(deleted.id)

    } else if (op.type === 'read') {
      let query = 'SELECT * FROM tasks'
      const conditions = []
      const values = []
      let idx = 1

      if (readFilter) {
        if (readFilter.date) {
          conditions.push(`date = $${idx++}`)
          values.push(readFilter.date)
        }
        if (readFilter.timeOfDay) {
          const timeRanges = {
            morning:   ['06:00', '11:59'],
            afternoon: ['12:00', '16:59'],
            evening:   ['17:00', '20:59'],
            night:     ['21:00', '23:59']
          }
          const range = timeRanges[readFilter.timeOfDay]
          if (range) {
            conditions.push(`time >= $${idx++} AND time <= $${idx++}`)
            values.push(range[0], range[1])
          }
        }
        if (readFilter.status && readFilter.status !== 'all') {
          conditions.push(`status = $${idx++}`)
          values.push(readFilter.status)
        }
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ')
      }
      query += ' ORDER BY date ASC, time ASC NULLS LAST'

      const result = await db.query(query, values)
      operationsCompleted.push({ type: 'read', tasks: result.rows })

    } else if (op.type === 'none') {
      operationsCompleted.push({ type: 'none', note: context.plan.planSummary })
    }
  }

  const allTasks = await db.query(
    'SELECT * FROM tasks ORDER BY date ASC, time ASC NULLS LAST'
  )

  context.result = {
    operationsCompleted,
    updatedTasks: allTasks.rows,
    affectedTaskIds
  }

  return context
}

module.exports = { runExecutionAgent }
