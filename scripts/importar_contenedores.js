const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const csvPath = path.join(__dirname, 'contenedores.csv');
if (!fs.existsSync(csvPath)) {
    console.error('No se encontró contenedores.csv en esta carpeta.');
    process.exit(1);
}

const db = new sqlite3.Database(path.join(__dirname, 'hielos.db'));
const lineas = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/)
    .filter(l => l.trim() !== '');
if (lineas[0].toLowerCase().includes('codigo')) lineas.shift();

let insertados = 0, existian = 0;

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS contenedor (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT UNIQUE,
        apartado TEXT DEFAULT 'A'
    )`);
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('INSERT OR IGNORE INTO contenedor (codigo, apartado) VALUES (?, ?)');
    for (const linea of lineas) {
        const [codigo, apartado] = linea.split(',').map(s => s.trim());
        if (!codigo) continue;
        stmt.run([codigo, apartado || 'A'], function () {
            if (this.changes > 0) insertados++; else existian++;
        });
    }
    stmt.finalize();
    db.run('COMMIT', (err) => {
        if (err) console.error('Error al confirmar:', err.message);
        console.log(`Insertados: ${insertados} | Ya existían: ${existian}`);
        db.close();
    });
});