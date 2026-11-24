// ========================================================
// Archivo: Server/db/db.js
// Descripción: Conexión única a PostgreSQL
// ========================================================
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
    console.error('Error inesperado en PostgreSQL:', err.message);
});

// Ejecuta una consulta. Usa $1, $2... como parámetros.
async function query(text, params = []) {
    return pool.query(text, params);
}

module.exports = { pool, query };