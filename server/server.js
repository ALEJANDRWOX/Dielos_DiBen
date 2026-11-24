const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { types } = require('pg');
const { query, pool } = require('./db/db');

// Tipos de PostgreSQL convertidos a tipos de JavaScript
types.setTypeParser(1082, (v) => v);             // DATE    -> texto 'YYYY-MM-DD'
types.setTypeParser(1083, (v) => v);             // TIME    -> texto 'HH:MM:SS'
types.setTypeParser(1700, (v) => parseFloat(v)); // NUMERIC -> número
types.setTypeParser(20, (v) => parseInt(v, 10)); // BIGINT  -> número

const app = express();

const CHROME_PATH = process.env.CHROME_PATH;
const TELEFONO_REPARTIDOR = process.env.TELEFONO_REPARTIDOR;

process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Promesa no manejada:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('⚠️ Excepción no capturada:', error);
});

app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'cambia-esto-por-una-clave-larga-y-aleatoria',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', maxAge: 1000 * 60 * 60 * 2 }
}));

app.use(express.static(path.join(__dirname, '..', 'Public')));

// ========================================================
// UTILIDADES
// ========================================================

const MENSAJES_BD = {
    '23514': 'Datos no válidos: revisa que las mermas no superen los hielos extraídos.',
    '23502': 'Faltan datos obligatorios.',
    '23503': 'Referencia inválida.'
};

// Envuelve rutas async: cualquier error responde 500 en vez de dejar la petición colgada
const ruta = (fn) => async (req, res, next) => {
    try {
        await fn(req, res, next);
    } catch (err) {
        console.error(`Error en ${req.method} ${req.originalUrl}:`, err.message);
        if (res.headersSent) return;
        const mensaje = MENSAJES_BD[err.code];
        if (mensaje) return res.status(400).json({ error: mensaje });
        res.status(500).json({ error: 'Error del servidor' });
    }
};

// Fecha de hoy en hora de México (YYYY-MM-DD)
function hoyLocal() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
}

function verificarAdmin(req, res, next) {
    if (req.session && req.session.esAdmin) return next();
    res.status(401).json({ error: 'No autorizado' });
}

// Agrega a cada reporte de chofer su lista de mermas (una sola consulta)
async function adjuntarDetalles(reportes) {
    if (reportes.length === 0) return reportes;
    const ids = reportes.map(r => r.id);
    const { rows } = await query(
        `SELECT * FROM merma_detalle WHERE reporte_id = ANY($1::int[]) ORDER BY numero_merma`,
        [ids]
    );
    const porReporte = new Map();
    for (const d of rows) {
        if (!porReporte.has(d.reporte_id)) porReporte.set(d.reporte_id, []);
        porReporte.get(d.reporte_id).push(d);
    }
    reportes.forEach(r => { r.detalles = porReporte.get(r.id) || []; });
    return reportes;
}

// Crea el usuario admin la primera vez, usando ADMIN_CLAVE del .env
async function crearAdminInicial() {
    const { rows } = await query(`SELECT id FROM admin LIMIT 1`);
    if (rows.length > 0) return;

    const clave = process.env.ADMIN_CLAVE;
    if (!clave) {
        console.error('ADMIN_CLAVE no está definida en .env: no se creó el usuario admin.');
        return;
    }
    const hash = await bcrypt.hash(clave, 12);
    await query(`INSERT INTO admin (usuario, clave_hash) VALUES ($1, $2)`, ['admin', hash]);
    console.log('Usuario admin creado.');
}

// ========================================================
// EMPLEADOS
// ========================================================

app.post('/api/empleados/registro', ruta(async (req, res) => {
    const { numeroEmpleado, turno, nombreCompleto } = req.body;
    if (!numeroEmpleado || !turno || !nombreCompleto) {
        return res.status(400).send('Todos los campos son obligatorios');
    }
    try {
        await query(
            `INSERT INTO empleado (numero_empleado, turno, nombre_completo) VALUES ($1, $2, $3)`,
            [numeroEmpleado, turno, nombreCompleto]
        );
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).send('El número de empleado ya está registrado.');
        }
        throw err;
    }
    res.status(200).send('Empleado registrado con éxito');
}));

app.post('/api/empleados/login', ruta(async (req, res) => {
    const { numeroEmpleado, turno } = req.body;
    const { rows } = await query(
        `SELECT * FROM empleado WHERE numero_empleado = $1 AND turno = $2`,
        [numeroEmpleado, turno]
    );
    if (!rows[0]) {
        return res.status(401).send('Número de empleado o turno incorrectos.');
    }
    res.status(200).json({ success: true, empleado: rows[0] });
}));

// ========================================================
// BOT DE WHATSAPP
// ========================================================
let clienteWa = null;
let ultimoQrDataUrl = null;
let botConectado = false;
const FECHA_ARRANQUE_BOT = { valor: 0 };
const mensajesAtendidos = new Set();

const MINUTOS_INACTIVIDAD = 15;
const MINUTOS_SILENCIO_TRAS_PEDIDO = 5; // Configurado a 5 minutos
const ANTIGUEDAD_MAX_MS = 2 * 60 * 1000;
const FRASES_CANCELAR = ['cancelar', 'no lo quiero', 'ya no continuar', 'ya no quiero'];
const PALABRAS_ACTIVACION = ['hola', 'menu', 'menú', 'pedido', 'encargo', 'hielos', 'hielo'];
const PRECIO_UNITARIO = 50;

// Palabras de activación: el bot solo arranca una encuesta si el mensaje habla de hielo
// (pedir hielo, quiero hielos, ¿hay hielo?, hola buenas tardes tienen hielos, hielos, etc.)
const PATRON_ACTIVACION_BOT = /\bhielos?\b/;
const HORAS_VIGENCIA_PEDIDO_BOT = 24;
const MINUTOS_ESPERA_CONFIRMACION_BOT = 15;
// Teléfonos a los que se les preguntó si quieren un segundo pedido (telefono -> vence en ms)
const confirmaciones_segundo_pedido_bot = new Map();

// Indica si el texto contiene las palabras de activación (sin acentos ni signos)
function detectar_activacion_bot(texto) {
    const limpio = (texto || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9ñ\s]/g, ' ');
    return PATRON_ACTIVACION_BOT.test(limpio);
}

// Indica si el cliente tiene un pedido pendiente hecho dentro de las últimas 24 horas
async function buscar_pedido_pendiente_bot(tel) {
    const { rows } = await query(
        `SELECT 1 FROM pedidos
         WHERE telefono = $1
           AND estado IN ('Nuevo', 'Programado')
           AND fecha_creacion > NOW() - ($2::int * INTERVAL '1 hour')
         LIMIT 1`,
        [tel, HORAS_VIGENCIA_PEDIDO_BOT]
    );
    return rows.length > 0;
}

// Configuración del bot leída desde la base de datos
let configCache = { apertura: 7, cierre: 20, mensaje: '' };

async function cargarConfigBot() {
    const { rows } = await query(
        `SELECT hora_apertura, hora_cierre, mensaje_fuera_horario FROM configuracion_bot WHERE id = 1`
    );
    if (rows[0]) {
        configCache = {
            apertura: parseInt(rows[0].hora_apertura.slice(0, 2), 10),
            cierre: parseInt(rows[0].hora_cierre.slice(0, 2), 10),
            mensaje: rows[0].mensaje_fuera_horario
        };
    }
    return configCache;
}

// Indica si el bot está en horario de servicio. Soporta horarios que cruzan la medianoche.
function enHorarioServicio() {
    const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
    const h = ahora.getHours();
    const ap = configCache.apertura;
    const ci = configCache.cierre;

    // Horario normal (ej. 07:00 a 20:00)
    if (ap < ci) return h >= ap && h < ci;
    // Horario que cruza la medianoche (ej. 19:00 a 06:00)
    return h >= ap || h < ci;
}

async function obtenerEncuesta(tel) {
    const { rows } = await query(`SELECT * FROM encuestas_bot WHERE telefono = $1`, [tel]);
    const f = rows[0];
    if (!f) return null;
    if (Date.now() - Number(f.actualizado_en) > MINUTOS_INACTIVIDAD * 60 * 1000) {
        await query(`DELETE FROM encuestas_bot WHERE telefono = $1`, [tel]);
        return null;
    }
    return f;
}

async function guardarEncuesta(tel, campos) {
    const e = { paso: 1, tipo_hielo: null, cantidad: null, direccion: null, referencia: null, pago: null, ...campos };
    await query(
        `INSERT INTO encuestas_bot (telefono, paso, tipo_hielo, cantidad, direccion, referencia, pago, actualizado_en)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (telefono) DO UPDATE SET
            paso = EXCLUDED.paso,
            tipo_hielo = EXCLUDED.tipo_hielo,
            cantidad = EXCLUDED.cantidad,
            direccion = EXCLUDED.direccion,
            referencia = EXCLUDED.referencia,
            pago = EXCLUDED.pago,
            actualizado_en = EXCLUDED.actualizado_en`,
        [tel, e.paso, e.tipo_hielo, e.cantidad, e.direccion, e.referencia, e.pago, Date.now()]
    );
}

async function haySilencio(tel) {
    const { rows } = await query(`SELECT hasta FROM silencios_bot WHERE telefono = $1`, [tel]);
    const s = rows[0];
    if (!s) return false;
    if (Number(s.hasta) > Date.now()) return true;
    await query(`DELETE FROM silencios_bot WHERE telefono = $1`, [tel]);
    return false;
}

// ---------- Reparto de pedidos a repartidores (en orden de la tabla) ----------
// pedido_id -> { pedido, repartidores: [{id, nombre, telefono}], indice }
const ofertas_pedido_bot = new Map();

// Si el teléfono tiene 10 dígitos se le antepone la lada 52
function normalizar_telefono_repartidor_bot(telefono) {
    const digitos = String(telefono || '').replace(/\D/g, '');
    return digitos.length === 10 ? '52' + digitos : digitos;
}

function construir_mensaje_oferta_bot(pedido) {
    return (
        '✅ *¡Pedido registrado!* ✅\n\n' +
        `🔹 Producto: ${pedido.tipo_hielo}\n🔹 Cantidad: ${pedido.cantidad}\n` +
        `🔹 Dirección: ${pedido.direccion}${pedido.referencia ? ` (${pedido.referencia})` : ''}\n` +
        `🔹 Pago: ${pedido.pago}\n` +
        '🔹 Tu cotización te la va a entregar un agente de ventas.\n\n' +
        `📞 Teléfono del cliente: +${pedido.tel}\n` +
        `🗺️ https://maps.google.com/?q=${encodeURIComponent(pedido.direccion)}\n\n` +
        '🛵 *¿Aceptas el pedido?*\nResponde *sí* para aceptarlo o *no* para rechazarlo.'
    );
}

// Envía la oferta al repartidor que toca; si no se puede, pasa al siguiente
async function enviar_oferta_repartidor_bot(oferta) {
    while (oferta.indice < oferta.repartidores.length) {
        const repartidor = oferta.repartidores[oferta.indice];
        try {
            const id_whatsapp = await clienteWa.getNumberId(normalizar_telefono_repartidor_bot(repartidor.telefono));
            if (!id_whatsapp) {
                console.log(`Repartidor ${repartidor.nombre} no tiene WhatsApp; se pasa al siguiente.`);
                oferta.indice++;
                continue;
            }
            await clienteWa.sendMessage(id_whatsapp._serialized, construir_mensaje_oferta_bot(oferta.pedido));
            console.log(`Pedido ${oferta.pedido.id} ofrecido a ${repartidor.nombre}.`);
            return true;
        } catch (e) {
            console.error(`Error al ofrecer pedido a ${repartidor.nombre}:`, e.message);
            oferta.indice++;
        }
    }
    ofertas_pedido_bot.delete(oferta.pedido.id);
    console.log(`⚠️ Ningún repartidor aceptó el pedido ${oferta.pedido.id}.`);
    return false;
}

async function obtener_numero_remitente_bot(mensaje, tel) {
    try {
        const contacto = await mensaje.getContact();
        if (contacto && contacto.number) return String(contacto.number).replace(/\D/g, '');
    } catch (e) {}
    return tel.replace(/\D/g, '');
}

// Procesa la respuesta (sí/no) de un repartidor a quien se le ofreció un pedido.
// Devuelve true si el mensaje era de ese repartidor y ya quedó atendido.
async function manejar_respuesta_repartidor_bot(mensaje, tel, texto) {
    if (ofertas_pedido_bot.size === 0) return false;

    const ultimos_digitos = (await obtener_numero_remitente_bot(mensaje, tel)).slice(-10);
    const oferta = [...ofertas_pedido_bot.values()].find(o => {
        const repartidor = o.repartidores[o.indice];
        return repartidor && String(repartidor.telefono).replace(/\D/g, '').slice(-10) === ultimos_digitos;
    });
    if (!oferta) return false;

    const norm = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, '').trim();

    if (norm === '1' || /^(si|sii+|acepto|aceptado|ok|va|dale|claro)\b/.test(norm)) {
        ofertas_pedido_bot.delete(oferta.pedido.id);
        await mensaje.reply(
            `✅ *Pedido confirmado.* ¡Gracias!\n\n📍 ${oferta.pedido.direccion}` +
            `${oferta.pedido.referencia ? ` (${oferta.pedido.referencia})` : ''}\n👤 Cliente: ${oferta.pedido.tel}`
        );
        console.log(`Pedido ${oferta.pedido.id} aceptado por ${oferta.repartidores[oferta.indice].nombre}.`);
        return true;
    }

    if (norm === '2' || /^(no|nel|nop|rechazo|rechazar|niego|paso)\b/.test(norm)) {
        console.log(`Pedido ${oferta.pedido.id} rechazado por ${oferta.repartidores[oferta.indice].nombre}.`);
        oferta.indice++;
        // Primero se le ofrece al siguiente; si el reply al repartidor falla, no se pierde el reparto
        const hay_siguiente = await enviar_oferta_repartidor_bot(oferta);
        try {
            await mensaje.reply(hay_siguiente
                ? 'Entendido 👍 Se lo ofreceremos a otro repartidor.'
                : 'Entendido 👍 Pedido rechazado.');
        } catch (e) {
            console.error('No se pudo responder al repartidor:', e.message);
        }
        return true;
    }

    await mensaje.reply('Responde *sí* para aceptar el pedido o *no* para rechazarlo.');
    return true;
}

async function manejarMensaje(mensaje) {
    const idMensaje = mensaje.id._serialized;
    if (mensajesAtendidos.has(idMensaje)) return;
    mensajesAtendidos.add(idMensaje);
    if (mensajesAtendidos.size > 500) mensajesAtendidos.clear();

    const remitente = mensaje.from;
    if (remitente.includes('@g.us') || remitente === 'status@broadcast') return;
    // Si hay ofertas pendientes, el mensaje del repartidor se revisa más abajo antes de ignorarlo
    if (TELEFONO_REPARTIDOR && remitente === TELEFONO_REPARTIDOR && ofertas_pedido_bot.size === 0) return;

    // Si el bot ignora un mensaje, este log dice por qué
    if (mensaje.timestamp * 1000 < FECHA_ARRANQUE_BOT.valor) {
        console.log('Mensaje ignorado: llegó antes de que el bot arrancara.');
        return;
    }
    if (Date.now() - mensaje.timestamp * 1000 > ANTIGUEDAD_MAX_MS) {
        console.log('Mensaje ignorado: es muy antiguo.');
        return;
    }

    // Quita el sufijo del número (@c.us, @lid o @s.whatsapp.net)
    const tel = remitente.replace(/@(c\.us|lid|s\.whatsapp\.net)$/, '');

    const texto = (mensaje.body || '').trim();

    // Si el mensaje es de un repartidor respondiendo a una oferta de pedido, no sigue el flujo de clientes
    if (await manejar_respuesta_repartidor_bot(mensaje, tel, texto)) return;
    if (TELEFONO_REPARTIDOR && remitente === TELEFONO_REPARTIDOR) return;

    const t = texto.toLowerCase();
    const responder = (txt) => mensaje.reply(txt);
    const hay_activacion = detectar_activacion_bot(texto);

    // Silencio tras un pedido: solo se anula si el cliente usa las palabras de activación
    if (await haySilencio(tel)) {
        if (!hay_activacion) {
            console.log(`Mensaje ignorado: ${tel} tiene silencio activo tras un pedido.`);
            return;
        }
        console.log(`Silencio anulado: ${tel} volvió a usar las palabras de activación.`);
        await query(`DELETE FROM silencios_bot WHERE telefono = $1`, [tel]);
    }

    if (FRASES_CANCELAR.some(f => t.includes(f))) {
        const hay = await obtenerEncuesta(tel);
        await query(`DELETE FROM encuestas_bot WHERE telefono = $1`, [tel]);
        confirmaciones_segundo_pedido_bot.delete(tel);
        if (hay) return responder('Pedido cancelado. Escribe *quiero hielo* cuando quieras volver a pedir.');
        return;
    }

    const enc = await obtenerEncuesta(tel);

    // Respuesta a la pregunta "¿gustas hacer un segundo pedido?"
    const vence_confirmacion = confirmaciones_segundo_pedido_bot.get(tel);
    if (vence_confirmacion && !enc) {
        if (vence_confirmacion < Date.now()) {
            confirmaciones_segundo_pedido_bot.delete(tel);
        } else {
            const norm = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, '').trim();
            if (/^(si|sii+|claro|simon|dale|va|ok|quiero|yes)\b/.test(norm)) {
                confirmaciones_segundo_pedido_bot.delete(tel);
                await guardarEncuesta(tel, { paso: 1 });
                const aviso = enHorarioServicio() ? '' :
                    `🕒 Estamos fuera de horario (${configCache.apertura}:00 a ${configCache.cierre}:00). Tu pedido quedará *programado*.\n\n`;
                return responder(
                    aviso +
                    '🧊 *¡Perfecto! Vamos con tu segundo pedido.* 🧊\n\n' +
                    'Selecciona el *Tipo de Hielo*:\n\n' +
                    '1️⃣ Hielo en Barra\n2️⃣ Hielo en Cubo\n3️⃣ Hielo Molido / Cubero\n\n' +
                    'Responde con el número de tu opción. (Escribe *cancelar* para salir).'
                );
            }
            if (/^(no|nel|nop|nada)\b/.test(norm)) {
                confirmaciones_segundo_pedido_bot.delete(tel);
                return responder('Entendido 👍 Tu pedido pendiente sigue en proceso. Si necesitas algo más, escribe *quiero hielo*.');
            }
            return responder('Tienes un pedido pendiente. ¿Gustas hacer un segundo pedido? Responde *sí* o *no*.');
        }
    }

    // Sin encuesta activa, el bot solo responde si el mensaje trae las palabras de activación
    if (!enc && !hay_activacion) {
        console.log(`Mensaje ignorado: ${tel} no usó palabras de activación.`);
        return;
    }

    // Si ya hizo un pedido en las últimas 24 horas, se le pregunta antes de iniciar otro
    if (!enc && await buscar_pedido_pendiente_bot(tel)) {
        confirmaciones_segundo_pedido_bot.set(tel, Date.now() + MINUTOS_ESPERA_CONFIRMACION_BOT * 60 * 1000);
        return responder('📦 Tienes un pedido pendiente. ¿Gustas hacer un segundo pedido? Responde *sí* o *no*.');
    }

    if (!enc || t === 'hola' || t === 'menu') {
        await guardarEncuesta(tel, { paso: 1 });
        const aviso = enHorarioServicio() ? '' :
            `🕒 Estamos fuera de horario (${configCache.apertura}:00 a ${configCache.cierre}:00). Tu pedido quedará *programado*.\n\n`;
        return responder(
            aviso +
            '🧊 *¡Bienvenido a Hielera DIBEN!* 🧊\n\n' +
            'Selecciona el *Tipo de Hielo*:\n\n' +
            '1️⃣ Hielo en Barra\n2️⃣ Hielo en Cubo\n3️⃣ Hielo Molido / Cubero\n\n' +
            'Responde con el número de tu opción. (Escribe *cancelar* para salir).'
        );
    }

    if (enc.paso === 1) {
        let tipo = null;
        if (texto === '1' || t.includes('barra')) tipo = 'Hielo en Barra';
        else if (texto === '2' || t.includes('cubo')) tipo = 'Hielo en Cubo';
        else if (texto === '3' || t.includes('molido') || t.includes('cubero')) tipo = 'Hielo Molido / Cubero';
        if (!tipo) return responder('⚠️ Opción no válida. Responde con *1*, *2* o *3*.');
        await guardarEncuesta(tel, { ...enc, paso: 2, tipo_hielo: tipo });
        return responder(`Has elegido: *${tipo}*.\n\n📦 ¿Qué cantidad necesitas? Escribe solo el número, por ejemplo *2* (entre 1 y 500).`);
    }

    if (enc.paso === 2) {
        const cant = Number(texto);
        if (!Number.isInteger(cant) || cant < 1 || cant > 500) {
            return responder('⚠️ Escribe solo el número de piezas, por ejemplo *2* (entre 1 y 500).');
        }
        await guardarEncuesta(tel, { ...enc, paso: 3, cantidad: cant });
        return responder('📍 Escribe la dirección completa de entrega (calle, número y colonia):');
    }

    if (enc.paso === 3) {
        if (texto.length < 5) return responder('⚠️ La dirección es muy corta. Detalla calle y colonia.');
        await guardarEncuesta(tel, { ...enc, paso: 4, direccion: texto });
        return responder('🔖 ¿Alguna *referencia*? (casa de color, esquina, etc.)\nSi no hay, escribe *no*.');
    }

    if (enc.paso === 4) {
        const ref = (t === 'no') ? '' : texto;
        await guardarEncuesta(tel, { ...enc, paso: 5, referencia: ref });
        return responder('💳 ¿Método de pago?\n\n1️⃣ Efectivo\n2️⃣ Transferencia');
    }

    if (enc.paso === 5) {
        let pago = null;
        if (texto === '1' || t.includes('efectivo')) pago = 'Efectivo';
        else if (texto === '2' || t.includes('transferencia')) pago = 'Transferencia';
        if (!pago) return responder('⚠️ Responde *1* (Efectivo) o *2* (Transferencia).');

        const total = enc.cantidad * PRECIO_UNITARIO;
        const estado = enHorarioServicio() ? 'Nuevo' : 'Programado';

        const { rows: pedido_creado_bot } = await query(
            `INSERT INTO pedidos (telefono, tipo_hielo, cantidad, direccion, referencia, metodo_pago, monto_total, estado)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [tel, enc.tipo_hielo, enc.cantidad, enc.direccion, enc.referencia, pago, total, estado]
        );
        await query(`DELETE FROM encuestas_bot WHERE telefono = $1`, [tel]);
        await query(
            `INSERT INTO silencios_bot (telefono, hasta) VALUES ($1, $2)
             ON CONFLICT (telefono) DO UPDATE SET hasta = EXCLUDED.hasta`,
            [tel, Date.now() + MINUTOS_SILENCIO_TRAS_PEDIDO * 60 * 1000]
        );

        await responder(
    `✅ *¡Pedido ${estado === 'Programado' ? 'programado' : 'registrado'}!* ✅\n\n` +
    `🔹 Producto: ${enc.tipo_hielo}\n🔹 Cantidad: ${enc.cantidad}\n` +
    `🔹 Dirección: ${enc.direccion}${enc.referencia ? ` (${enc.referencia})` : ''}\n` +
    `🔹 Pago: ${pago}\n` +
    `🔹 Tu cotización te la va a entregar un agente de ventas.\n\n` +
    (pago === 'Transferencia'
        ? '🏦 Te atenderá un agente y en breve te pasaremos el número para transferir, el banco y a nombre de quién.\n\n'
        : '') +
    (estado === 'Programado'
        ? `🕒 Lo enviaremos a partir de las ${configCache.apertura}:00.`
        : '¡Gracias por tu compra!')
);

        // Reparto: se ofrece el pedido al primer repartidor de la tabla; si lo rechaza, pasa al siguiente
        if (estado === 'Nuevo' && clienteWa && botConectado) {
            let repartidores_bot = [];
            try {
                const { rows } = await query(`SELECT id, nombre, telefono FROM repartidores ORDER BY id`);
                repartidores_bot = rows;
            } catch (e) {
                console.error('No se pudo leer la tabla de repartidores:', e.message);
            }

            if (repartidores_bot.length > 0) {
                // Número real del cliente (el id de WhatsApp a veces no es el teléfono)
                const numero_cliente_bot = await obtener_numero_remitente_bot(mensaje, tel);
                const oferta = {
                    pedido: {
                        id: pedido_creado_bot[0].id, tel: numero_cliente_bot,
                        tipo_hielo: enc.tipo_hielo, cantidad: enc.cantidad,
                        direccion: enc.direccion, referencia: enc.referencia, pago
                    },
                    repartidores: repartidores_bot,
                    indice: 0
                };
                ofertas_pedido_bot.set(oferta.pedido.id, oferta);
                await enviar_oferta_repartidor_bot(oferta);
                return;
            }
        }

        // Sin repartidores en la tabla: se usa el aviso de siempre al TELEFONO_REPARTIDOR del .env
        if (estado === 'Nuevo' && TELEFONO_REPARTIDOR && clienteWa && botConectado) {
            const alerta =
                '🚨 *¡NUEVO PEDIDO DE HIELO!* 🚨\n\n' +
                `👤 *Tel. Cliente:* ${tel}\n` +
                `🧊 *Tipo:* ${enc.tipo_hielo} (${enc.cantidad} pzs)\n` +
                `💵 *Pago:* ${pago} ($${total.toFixed(2)})\n` +
                `📍 *Dirección:* ${enc.direccion}${enc.referencia ? `\n🔖 *Ref:* ${enc.referencia}` : ''}\n\n` +
                `🗺️ https://maps.google.com/?q=${encodeURIComponent(enc.direccion)}`;
            try { await clienteWa.sendMessage(TELEFONO_REPARTIDOR, alerta); }
            catch (e) { console.error('Error al enviar alerta:', e.message); }
        }
    }
}

// Carpeta donde LocalAuth guarda la sesión (la misma de siempre al correr desde la raíz del proyecto)
const RUTA_SESION_WA = path.join(__dirname, '..', '.wwebjs_auth');
const SEGUNDOS_MAX_SIN_QR = 60;
let errorBot = null;
let inicioArranqueBot = 0;

// Cierra el cliente de WhatsApp y su navegador; opcionalmente borra la sesión guardada
async function detener_cliente_bot(borrarSesion) {
    const c = clienteWa;
    clienteWa = null;
    botConectado = false;
    ultimoQrDataUrl = null;
    inicioArranqueBot = 0;

    if (c) {
        try {
            await Promise.race([c.destroy(), new Promise(r => setTimeout(r, 10000))]);
        } catch (e) {
            console.error('Aviso al destruir cliente:', e.message);
        }
        // Si el navegador quedó abierto, bloquea la sesión y impide generar un QR nuevo
        try {
            const proceso = c.pupBrowser && c.pupBrowser.process();
            if (proceso && !proceso.killed) proceso.kill('SIGKILL');
        } catch (e) {}
    }

    if (borrarSesion) {
        await new Promise(r => setTimeout(r, 1000));
        try {
            fs.rmSync(RUTA_SESION_WA, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        } catch (e) {
            console.error('No se pudo borrar la sesión:', e.message);
        }
    }
}

app.post('/api/bot/iniciar', verificarAdmin, ruta(async (req, res) => {
    if (req.query.reiniciar === '1') {
        console.log('🔄 Reinicio manual del bot de WhatsApp.');
        await detener_cliente_bot(req.query.borrarSesion === '1');
    }

    if (botConectado) return res.json({ conectado: true, qr: null });

    if (clienteWa) {
        const atascado = !ultimoQrDataUrl && inicioArranqueBot &&
            (Date.now() - inicioArranqueBot > SEGUNDOS_MAX_SIN_QR * 1000);
        if (!atascado) return res.json({ conectado: false, qr: ultimoQrDataUrl, error: errorBot });

        console.log(`⚠️ El cliente llevaba más de ${SEGUNDOS_MAX_SIN_QR} s sin QR ni conexión; se reinicia.`);
        await detener_cliente_bot(false);
    }

    errorBot = null;
    inicioArranqueBot = Date.now();

    const instancia = new Client({
        authStrategy: new LocalAuth({ dataPath: RUTA_SESION_WA }),
        puppeteer: {
            headless: true,
            executablePath: CHROME_PATH || undefined,
            protocolTimeout: 120000,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                   '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu']
        }
    });
    clienteWa = instancia;

    instancia.on('qr', async (qr) => {
        console.log('📱 QR generado, listo para escanear');
        try { ultimoQrDataUrl = await qrcode.toDataURL(qr); }
        catch (e) { console.error('Error QR:', e.message); }
    });

    instancia.on('ready', () => {
        console.log('✅ ¡WhatsApp conectado!');
        FECHA_ARRANQUE_BOT.valor = Date.now();
        botConectado = true;
        ultimoQrDataUrl = null;
        inicioArranqueBot = 0;
        errorBot = null;
    });

    instancia.on('auth_failure', async (msg) => {
        console.error('❌ Fallo de autenticación:', msg);
        errorBot = 'Falló la autenticación de WhatsApp. Pulsa "Reiniciar vinculación".';
        if (clienteWa === instancia) await detener_cliente_bot(false);
        else { try { await instancia.destroy(); } catch (e) {} }
    });

    instancia.on('disconnected', async (motivo) => {
        console.log('⚠️ WhatsApp desconectado:', motivo);
        errorBot = 'WhatsApp se desconectó (' + motivo + '). Vuelve a vincular el dispositivo.';
        if (clienteWa === instancia) await detener_cliente_bot(false);
        else { try { await instancia.destroy(); } catch (e) {} }
    });

    instancia.on('message', (m) => {
        manejarMensaje(m).catch(e => console.error('Error manejando mensaje:', e));
    });

    instancia.initialize().catch(async (err) => {
        console.error('❌ Error al iniciar WhatsApp:', err.message);
        errorBot = 'No se pudo iniciar WhatsApp: ' + err.message;
        if (clienteWa === instancia) await detener_cliente_bot(false);
        else { try { await instancia.destroy(); } catch (e) {} }
    });

    res.json({ conectado: false, qr: null, error: null });
}));

app.get('/api/bot/estado', verificarAdmin, (req, res) => {
    res.json({
        conectado: botConectado,
        qr: ultimoQrDataUrl,
        iniciando: !!clienteWa && !botConectado,
        error: errorBot
    });
});

app.post('/api/bot/desconectar', verificarAdmin, ruta(async (req, res) => {
    await detener_cliente_bot(req.query.borrarSesion === '1');
    res.json({ success: true });
}));

// ========================================================
// MÉTRICAS
// ========================================================

// El resumen semanal sale de la tabla pedidos. Si un día tiene un ajuste manual
// en resumen_semanal, se muestran las cifras del ajuste en lugar de las calculadas.

const NOMBRES_DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// Lunes de la semana actual en hora de México (YYYY-MM-DD)
function obtener_lunes_semana_util() {
    const [anio, mes, dia] = hoyLocal().split('-').map(Number);
    const f = new Date(Date.UTC(anio, mes - 1, dia));
    f.setUTCDate(f.getUTCDate() - ((f.getUTCDay() + 6) % 7));
    return f.toISOString().slice(0, 10);
}

function validar_fecha_util(fecha) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return false;
    const f = new Date(fecha + 'T00:00:00Z');
    return !isNaN(f.getTime()) && f.toISOString().slice(0, 10) === fecha;
}

function validar_datos_resumen_semanal(cuerpo) {
    const pedidos = (typeof cuerpo.pedidos === 'number' || (typeof cuerpo.pedidos === 'string' && cuerpo.pedidos.trim() !== ''))
        ? Number(cuerpo.pedidos)
        : NaN;
    if (!Number.isInteger(pedidos) || pedidos < 0) return { error: 'Total de pedidos inválido' };
    return { pedidos, total: 0 };
}

app.get('/api/metricas/semana', verificarAdmin, ruta(async (req, res) => {
    const { rows } = await query(`
        SELECT COALESCE(d.fecha, r.fecha) AS fecha,
               r.id AS id,
               COALESCE(r.pedidos, d.pedidos, 0)::int AS pedidos,
               COALESCE(r.total::float, d.total, 0)::float AS total,
               (r.id IS NOT NULL) AS ajustado
        FROM (
            SELECT fecha_creacion::date AS fecha,
                   COUNT(id)::int AS pedidos,
                   COALESCE(SUM(monto_total), 0)::float AS total
            FROM pedidos
            WHERE fecha_creacion::date >= $1::date AND fecha_creacion::date < $1::date + 7
            GROUP BY 1
        ) AS d
        FULL OUTER JOIN (
            SELECT id, fecha, pedidos, total
            FROM resumen_semanal
            WHERE fecha >= $1::date AND fecha < $1::date + 7
        ) AS r ON r.fecha = d.fecha
        ORDER BY 1`, [obtener_lunes_semana_util()]);

    rows.forEach(f => {
        f.dia = NOMBRES_DIAS_SEMANA[new Date(f.fecha + 'T00:00:00Z').getUTCDay()];
    });
    res.json(rows);
}));

// Crea o reemplaza el ajuste manual de un día
app.post('/api/metricas/semana', verificarAdmin, ruta(async (req, res) => {
    const { fecha } = req.body;
    if (!validar_fecha_util(fecha)) return res.status(400).json({ error: 'Fecha inválida' });
    const datos = validar_datos_resumen_semanal(req.body);
    if (datos.error) return res.status(400).json({ error: datos.error });

    const { rows } = await query(
        `INSERT INTO resumen_semanal (fecha, pedidos, total) VALUES ($1, $2, $3)
         ON CONFLICT (fecha) DO UPDATE SET pedidos = EXCLUDED.pedidos, total = EXCLUDED.total
         RETURNING id`,
        [fecha, datos.pedidos, datos.total]
    );
    res.json({ exito: true, id: rows[0].id });
}));

app.put('/api/metricas/semana/:id', verificarAdmin, ruta(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Identificador inválido' });
    const datos = validar_datos_resumen_semanal(req.body);
    if (datos.error) return res.status(400).json({ error: datos.error });

    const r = await query(
        `UPDATE resumen_semanal SET pedidos = $1, total = $2 WHERE id = $3`,
        [datos.pedidos, datos.total, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Ajuste no encontrado' });
    res.json({ exito: true });
}));

// Borra los pedidos de un día y su ajuste manual, en una sola transacción
app.delete('/api/metricas/semana/dia/:fecha', verificarAdmin, ruta(async (req, res) => {
    const { fecha } = req.params;
    if (!validar_fecha_util(fecha)) return res.status(400).json({ error: 'Fecha inválida' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const pedidos = await client.query(`DELETE FROM pedidos WHERE fecha_creacion::date = $1::date`, [fecha]);
        const ajuste = await client.query(`DELETE FROM resumen_semanal WHERE fecha = $1::date`, [fecha]);
        await client.query('COMMIT');

        res.json({
            exito: true,
            pedidos_eliminados: pedidos.rowCount,
            ajustes_eliminados: ajuste.rowCount
        });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

app.get('/api/metricas/mes-actual', verificarAdmin, ruta(async (req, res) => {
    const { rows } = await query(`
        SELECT 'Semana ' || (sem + 1) AS semana,
               SUM(pedidos)::int AS pedidos
        FROM (
            SELECT LEAST(EXTRACT(DAY FROM COALESCE(d.fecha, r.fecha))::int / 7, 3) AS sem,
                   COALESCE(r.pedidos, d.pedidos, 0) AS pedidos
            FROM (
                SELECT fecha_creacion::date AS fecha, COUNT(id)::int AS pedidos
                FROM pedidos
                WHERE date_trunc('month', fecha_creacion) = date_trunc('month', NOW())
                GROUP BY 1
            ) AS d
            FULL OUTER JOIN (
                SELECT fecha, pedidos
                FROM resumen_semanal
                WHERE date_trunc('month', fecha) = date_trunc('month', NOW())
            ) AS r ON r.fecha = d.fecha
        ) AS sub
        GROUP BY sem
        ORDER BY sem`);
    res.json(rows);
}));

// ========================================================
// PEDIDOS (campana de config_whatsapp.html)
// Las rutas "pendientes" van ANTES de las rutas con :id
// ========================================================

app.get('/api/admin/pedidos/pendientes', verificarAdmin, ruta(async (req, res) => {
    const { rows } = await query(`
        SELECT id, telefono, tipo_hielo, cantidad, direccion, referencia, metodo_pago, monto_total, estado,
               to_char(fecha_creacion, 'YYYY-MM-DD HH24:MI') AS fecha_hora
        FROM pedidos
        WHERE estado IN ('Nuevo', 'Programado')
        ORDER BY fecha_creacion DESC`);
    res.json(rows);
}));

app.put('/api/admin/pedidos/:id/atender', verificarAdmin, ruta(async (req, res) => {
    await query(`UPDATE pedidos SET estado = 'Atendido' WHERE id = $1`, [req.params.id]);
    res.json({ exito: true });
}));

app.get('/api/admin/pedidos', verificarAdmin, ruta(async (req, res) => {
    const { rows } = await query(`
        SELECT id, telefono AS empleado_num, 'Cliente WhatsApp' AS empleado_nombre,
               fecha_creacion::date AS fecha, estado, 'Estándar' AS presentacion,
               tipo_hielo AS tipo, cantidad::text || ' pzs' AS medida, monto_total AS monto
        FROM pedidos`);
    res.json(rows);
}));

app.put('/api/admin/pedidos/:id', verificarAdmin, ruta(async (req, res) => {
    const { estado, tipo, monto } = req.body;
    await query(
        `UPDATE pedidos SET estado = $1, tipo_hielo = $2, monto_total = $3 WHERE id = $4`,
        [estado, tipo, monto, req.params.id]
    );
    res.send('Pedido actualizado');
}));

app.delete('/api/admin/pedidos/:id', verificarAdmin, ruta(async (req, res) => {
    await query(`DELETE FROM pedidos WHERE id = $1`, [req.params.id]);
    res.send('Eliminado');
}));

app.get('/api/admin/contenedores', verificarAdmin, ruta(async (req, res) => {
    const { rows } = await query(`SELECT id, codigo, apartado FROM contenedor ORDER BY codigo`);
    res.json(rows);
}));

// ========================================================
// PRODUCCIÓN (registro desde el celular del empleado)
// ========================================================

app.post('/api/produccion', ruta(async (req, res) => {
    const { codigoContenedor, fecha, hora, hielosExtraidos, mermas, empleadoNum, empleadoNombre } = req.body;

    if (!codigoContenedor) {
        return res.status(400).send('Falta el código del contenedor');
    }

    const apartado = codigoContenedor.slice(-1);
    const { rows } = await query(
        `INSERT INTO contenedor (codigo, apartado) VALUES ($1, $2)
         ON CONFLICT (codigo) DO UPDATE SET codigo = EXCLUDED.codigo
         RETURNING id`,
        [codigoContenedor, apartado]
    );

    await query(
        `INSERT INTO registro (contenedor_id, fecha, hora, hielos_extraidos, mermas, empleado_num, empleado_nombre)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [rows[0].id, fecha, hora, hielosExtraidos, mermas, empleadoNum || 'N/A', empleadoNombre || 'Desconocido']
    );
    res.status(200).send('Producción guardada correctamente');
}));

app.get('/api/produccion', verificarAdmin, ruta(async (req, res) => {
    const { fecha } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) {
        return res.status(400).json({ error: 'Fecha inválida' });
    }
    const { rows } = await query(
        `SELECT id, fecha, hora, hielos_extraidos, mermas FROM registro WHERE fecha = $1 ORDER BY hora`,
        [fecha]
    );
    res.json(rows);
}));

app.put('/api/produccion/:id', verificarAdmin, ruta(async (req, res) => {
    const { fecha, hora, hielos_extraidos, mermas } = req.body;
    const hielos = parseInt(hielos_extraidos, 10);
    const merm = parseInt(mermas, 10);

    if (!fecha || !hora || isNaN(hielos) || isNaN(merm) || hielos < 0 || merm < 0 || merm > hielos) {
        return res.status(400).json({ error: 'Datos inválidos' });
    }
    const r = await query(
        `UPDATE registro SET fecha = $1, hora = $2, hielos_extraidos = $3, mermas = $4 WHERE id = $5`,
        [fecha, hora, hielos, merm, req.params.id]
    );
    if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Registro no encontrado' });
    }
    res.json({ exito: true });
}));

// Elimina producción y ventas de un día, en una sola transacción
app.delete('/api/produccion/dia/:fecha', verificarAdmin, ruta(async (req, res) => {
    const { fecha } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return res.status(400).json({ error: 'Fecha inválida' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const prod = await client.query('DELETE FROM registro WHERE fecha = $1', [fecha]);
        const ventas = await client.query('DELETE FROM venta WHERE fecha = $1', [fecha]);
        await client.query('COMMIT');

        res.json({
            exito: true,
            produccion_eliminada: prod.rowCount,
            ventas_eliminadas: ventas.rowCount
        });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// ========================================================
// VENTAS
// ========================================================

app.post('/api/ventas', ruta(async (req, res) => {
    const { fecha, estado, presentacion, tipo, medida, monto, empleadoNum, empleadoNombre } = req.body;
    await query(
        `INSERT INTO venta (fecha, estado, presentacion, tipo, medida_kg, monto, empleado_num, empleado_nombre)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [fecha, estado, presentacion, tipo, medida, monto, empleadoNum || 'N/A', empleadoNombre || 'Desconocido']
    );
    res.status(200).send('Venta guardada correctamente');
}));

// ========================================================
// CHOFERES
// ========================================================

app.post('/api/choferes', ruta(async (req, res) => {
    const { transportista, camion, cantidadMermas, mermasDetalle } = req.body;
    const fechaActual = hoyLocal();

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `INSERT INTO reporte_chofer (transportista, camion, cantidad_mermas, fecha)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [transportista, camion || 'Sin asignar', cantidadMermas, fechaActual]
        );
        const reporteId = rows[0].id;

        for (const m of mermasDetalle || []) {
            await client.query(
                `INSERT INTO merma_detalle (reporte_id, numero_merma, causa, explicacion) VALUES ($1, $2, $3, $4)`,
                [reporteId, m.numero, m.causa, m.explicacion || '']
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    res.status(200).send('Reporte de chofer guardado correctamente');
}));

// ========================================================
// LOGIN Y SESIÓN DE ADMIN
// ========================================================

const limiteLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'Demasiados intentos. Espera 15 minutos.'
});

app.post('/api/admin/login', limiteLogin, ruta(async (req, res) => {
    const { usuario, clave } = req.body;
    if (!usuario || !clave) return res.status(400).json({ error: 'Faltan datos' });

    const { rows } = await query(`SELECT * FROM admin WHERE usuario = $1`, [usuario]);
    const admin = rows[0];
    if (!admin) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    const coincide = await bcrypt.compare(clave, admin.clave_hash);
    if (!coincide) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    // Regenerar primero y marcar la sesión después; si se hace al revés, la sesión se pierde
    req.session.regenerate((err) => {
        if (err) return res.status(500).json({ error: 'Error del servidor' });
        req.session.esAdmin = true;
        res.json({ success: true });
    });
}));

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/admin/sesion', (req, res) => {
    res.json({ activo: !!(req.session && req.session.esAdmin) });
});

// ========================================================
// ADMIN: PRODUCCIÓN, VENTAS, EMPLEADOS Y CHOFERES
// Las rutas "limpiar" van ANTES de las rutas con :id
// ========================================================

app.get('/api/admin/produccion', verificarAdmin, ruta(async (req, res) => {
    const { rows } = await query(`
        SELECT r.id, c.codigo AS contenedor, r.fecha, r.hora, r.hielos_extraidos, r.mermas,
               r.empleado_num, r.empleado_nombre
        FROM registro r
        JOIN contenedor c ON r.contenedor_id = c.id
        ORDER BY r.fecha DESC, r.hora DESC`);
    res.json(rows);
}));

app.put('/api/admin/produccion/:id', verificarAdmin, ruta(async (req, res) => {
    const { fecha, hora, hielosExtraidos, mermas } = req.body;
    await query(
        `UPDATE registro SET fecha = $1, hora = $2, hielos_extraidos = $3, mermas = $4 WHERE id = $5`,
        [fecha, hora, hielosExtraidos, mermas, req.params.id]
    );
    res.status(200).send('Producción actualizada');
}));

app.delete('/api/admin/produccion/limpiar', verificarAdmin, ruta(async (req, res) => {
    await query(`DELETE FROM registro`);
    res.status(200).send('Producción limpiada');
}));

app.delete('/api/admin/produccion/:id', verificarAdmin, ruta(async (req, res) => {
    await query(`DELETE FROM registro WHERE id = $1`, [req.params.id]);
    res.status(200).send('Eliminado');
}));

app.get('/api/admin/ventas', verificarAdmin, ruta(async (req, res) => {
    const { rows } = await query(`SELECT * FROM venta ORDER BY id`);
    res.json(rows);
}));

app.delete('/api/admin/ventas/limpiar', verificarAdmin, ruta(async (req, res) => {
    await query(`DELETE FROM venta`);
    res.status(200).send('Ventas limpiadas');
}));

app.put('/api/admin/ventas/:id', verificarAdmin, ruta(async (req, res) => {
    const { fecha, estado, presentacion, tipo, medida, monto } = req.body;
    await query(
        `UPDATE venta SET fecha = $1, estado = $2, presentacion = $3, tipo = $4, medida_kg = $5, monto = $6
         WHERE id = $7`,
        [fecha, estado, presentacion, tipo, medida, monto, req.params.id]
    );
    res.status(200).send('Venta actualizada');
}));

app.delete('/api/admin/ventas/:id', verificarAdmin, ruta(async (req, res) => {
    await query(`DELETE FROM venta WHERE id = $1`, [req.params.id]);
    res.status(200).send('Eliminado');
}));

app.get('/api/admin/empleados', verificarAdmin, ruta(async (req, res) => {
    const { rows } = await query(`SELECT * FROM empleado ORDER BY id`);
    res.json(rows);
}));

app.delete('/api/admin/empleados/:id', verificarAdmin, ruta(async (req, res) => {
    await query(`DELETE FROM empleado WHERE id = $1`, [req.params.id]);
    res.status(200).send('Empleado eliminado');
}));

app.get('/api/admin/choferes', verificarAdmin, ruta(async (req, res) => {
    const { rows: reportes } = await query(`SELECT * FROM reporte_chofer ORDER BY id`);
    await adjuntarDetalles(reportes);
    res.json(reportes);
}));

app.delete('/api/admin/choferes/limpiar', verificarAdmin, ruta(async (req, res) => {
    // merma_detalle se borra sola por ON DELETE CASCADE
    await query(`DELETE FROM reporte_chofer`);
    res.status(200).send('Choferes limpiados');
}));

app.put('/api/admin/choferes/:id', verificarAdmin, ruta(async (req, res) => {
    const { transportista, camion, cantidadMermas } = req.body;
    await query(
        `UPDATE reporte_chofer SET transportista = $1, camion = $2, cantidad_mermas = $3 WHERE id = $4`,
        [transportista, camion, cantidadMermas, req.params.id]
    );
    res.status(200).send('Reporte actualizado');
}));

app.delete('/api/admin/choferes/:id', verificarAdmin, ruta(async (req, res) => {
    await query(`DELETE FROM reporte_chofer WHERE id = $1`, [req.params.id]);
    res.status(200).send('Eliminado');
}));

// ========================================================
// FILTRO HISTÓRICO (admin-registros.html)
// ========================================================

const TABLAS_FILTRO = {
    ventas: {
        sql: 'SELECT * FROM venta WHERE 1=1',
        columna: 'fecha'
    },
    produccion: {
        sql: `SELECT r.id, c.codigo AS contenedor, r.fecha, r.hora, r.hielos_extraidos, r.mermas,
                     r.empleado_num, r.empleado_nombre
              FROM registro r
              JOIN contenedor c ON r.contenedor_id = c.id
              WHERE 1=1`,
        columna: 'r.fecha'
    },
    choferes: {
        sql: 'SELECT * FROM reporte_chofer WHERE 1=1',
        columna: 'fecha'
    }
};

app.get('/api/admin/filtrar', verificarAdmin, ruta(async (req, res) => {
    const { tipo, anio, mes } = req.query;
    const tabla = TABLAS_FILTRO[tipo];
    if (!tabla) return res.status(400).json({ error: 'Tipo inválido' });

    const params = [];
    let sql = tabla.sql;

    if (anio && anio !== 'todos') {
        params.push(parseInt(anio, 10));
        sql += ` AND EXTRACT(YEAR FROM ${tabla.columna}) = $${params.length}`;
    }
    if (mes && mes !== 'todos') {
        params.push(parseInt(mes, 10));
        sql += ` AND EXTRACT(MONTH FROM ${tabla.columna}) = $${params.length}`;
    }
    sql += ` ORDER BY ${tabla.columna} DESC`;

    const { rows } = await query(sql, params);
    if (tipo === 'choferes') await adjuntarDetalles(rows);
    res.json(rows);
}));

// ========================================================
// REPARTIDORES
// ========================================================

app.get('/api/admin/repartidores', verificarAdmin, ruta(async (req, res) => {
    const { rows } = await query(`SELECT * FROM repartidores ORDER BY id`);
    res.json(rows);
}));

app.post('/api/admin/repartidores', verificarAdmin, ruta(async (req, res) => {
    const { nombre, telefono } = req.body;
    if (!nombre || !telefono) {
        return res.status(400).json({ error: 'Nombre y teléfono son obligatorios' });
    }
    await query(
        `INSERT INTO repartidores (nombre, telefono) VALUES ($1, $2)`,
        [nombre, telefono]
    );
    res.status(200).send('Repartidor registrado con éxito');
}));

app.put('/api/admin/repartidores/:id', verificarAdmin, ruta(async (req, res) => {
    const { nombre, telefono } = req.body;
    await query(
        `UPDATE repartidores SET nombre = $1, telefono = $2 WHERE id = $3`,
        [nombre, telefono, req.params.id]
    );
    res.status(200).send('Repartidor actualizado');
}));

app.delete('/api/admin/repartidores/:id', verificarAdmin, ruta(async (req, res) => {
    await query(`DELETE FROM repartidores WHERE id = $1`, [req.params.id]);
    res.status(200).send('Repartidor eliminado');
}));

app.post('/api/admin/repartidores/probar/:id', verificarAdmin, ruta(async (req, res) => {
    const { rows } = await query(`SELECT telefono FROM repartidores WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Repartidor no encontrado' });

    const numeroRepartidor = rows[0].telefono.replace(/\D/g, '');

    if (!clienteWa || !botConectado) {
        return res.status(400).json({ exito: false, mensaje: 'El bot de WhatsApp no está conectado.' });
    }

    try {
        // WhatsApp resuelve el identificador correcto del número; si no existe, devuelve null
        const idWhatsapp = await clienteWa.getNumberId(numeroRepartidor);
        if (!idWhatsapp) {
            return res.status(400).json({
                exito: false,
                mensaje: 'Ese número no está registrado en WhatsApp. Revisa que incluya la lada 52.'
            });
        }

        await clienteWa.sendMessage(
            idWhatsapp._serialized,
            '🧪 *Prueba de conexión - Hielo DIBEN*\nPor favor responde con un punto (.) o un número para confirmar que recibiste este mensaje.'
        );
        res.json({ exito: true, mensaje: 'Mensaje de prueba enviado con éxito al repartidor.' });
    } catch (e) {
        console.error('Error en la prueba de repartidor:', e);
        res.status(500).json({ exito: false, mensaje: 'No se pudo enviar el mensaje: ' + e.message });
    }
}));

// ========================================================
// CONFIGURACIÓN DEL BOT (horario y mensaje)
// ========================================================

app.get('/api/admin/config-bot', verificarAdmin, ruta(async (req, res) => {
    const { rows } = await query(
        `SELECT hora_apertura, hora_cierre, mensaje_fuera_horario FROM configuracion_bot WHERE id = 1`
    );
    res.json(rows[0] || {});
}));

app.put('/api/admin/config-bot', verificarAdmin, ruta(async (req, res) => {
    const { horaApertura, horaCierre, mensajeFueraHorario } = req.body;

    if (!/^\d{2}:\d{2}$/.test(horaApertura || '') || !/^\d{2}:\d{2}$/.test(horaCierre || '')) {
        return res.status(400).json({ error: 'Las horas deben tener formato HH:MM' });
    }

    // Se permite apertura mayor que cierre: el horario cruza la medianoche (ej. 19:00 a 06:00)
    await query(
        `UPDATE configuracion_bot SET hora_apertura = $1, hora_cierre = $2, mensaje_fuera_horario = $3 WHERE id = 1`,
        [horaApertura, horaCierre, mensajeFueraHorario || '']
    );
    await cargarConfigBot();
    res.json({ exito: true, mensaje: 'Configuración guardada' });
}));

// ========================================================
// ARRANQUE
// ========================================================

const PORT = process.env.PORT || 3000;

// Intenta crear la tabla; si el usuario de la base no tiene permiso, avisa y deja arrancar el servidor
async function crear_tabla_resumen_semanal() {
    let conexion = '';
    try {
        const { rows: info } = await query(`SELECT current_database() AS base, current_user AS usuario`);
        conexion = `base "${info[0].base}", usuario "${info[0].usuario}"`;
        console.log(`🗄️ Conectado a ${conexion}`);

        // Si ya existe no se intenta crear: CREATE TABLE exige permiso sobre el esquema aunque la tabla exista
        const { rows } = await query(`SELECT to_regclass('public.resumen_semanal') AS tabla`);
        if (rows[0].tabla) {
            console.log('✅ Tabla resumen_semanal encontrada.');
            return;
        }

        await query(`
            CREATE TABLE IF NOT EXISTS resumen_semanal (
                id SERIAL PRIMARY KEY,
                fecha DATE NOT NULL UNIQUE,
                pedidos INTEGER NOT NULL CHECK (pedidos >= 0),
                total NUMERIC(12, 2) NOT NULL CHECK (total >= 0)
            )`);
    } catch (err) {
        console.error(
            '⚠️ No se pudo crear la tabla resumen_semanal (' + err.message + ').\n' +
            '   La app está conectada a ' + (conexion || 'una base desconocida') + '.\n' +
            '   Créala EN ESA BASE con un usuario administrador y dale permisos a ese usuario.\n' +
            '   Hasta entonces fallarán Editar y Eliminar del resumen semanal.'
        );
    }
}

async function iniciarTodo() {
    try {
        await crearAdminInicial();
        await crear_tabla_resumen_semanal();
        await cargarConfigBot();
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('❌ ERROR FATAL AL INICIAR EL SERVIDOR:', error);
    }
}

iniciarTodo();