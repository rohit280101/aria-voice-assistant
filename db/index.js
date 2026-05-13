const { Pool } = require('pg')
require('dotenv').config()

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
})

pool.on('error', (err) => console.error('DB pool error:', err))

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
}