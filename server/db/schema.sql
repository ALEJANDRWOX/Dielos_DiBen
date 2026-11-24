-- ========================================================
-- Archivo: Server/db/schema.sql
-- Ejecutar una sola vez sobre la base hielos_diben
-- ========================================================

CREATE TABLE IF NOT EXISTS empleado (
    id               SERIAL PRIMARY KEY,
    numero_empleado  TEXT UNIQUE NOT NULL,
    turno            TEXT NOT NULL CHECK (turno IN ('TM', 'TD')),
    nombre_completo  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contenedor (
    id       SERIAL PRIMARY KEY,
    codigo   TEXT UNIQUE NOT NULL,
    apartado TEXT NOT NULL DEFAULT 'A'
);

CREATE TABLE IF NOT EXISTS registro (
    id               SERIAL PRIMARY KEY,
    contenedor_id    INTEGER REFERENCES contenedor(id) ON DELETE RESTRICT,
    fecha            DATE NOT NULL,
    hora             TIME NOT NULL,
    hielos_extraidos INTEGER NOT NULL DEFAULT 0 CHECK (hielos_extraidos >= 0),
    mermas           INTEGER NOT NULL DEFAULT 0 CHECK (mermas >= 0),
    empleado_num     TEXT,
    empleado_nombre  TEXT,
    CHECK (mermas <= hielos_extraidos)
);

CREATE TABLE IF NOT EXISTS venta (
    id               SERIAL PRIMARY KEY,
    fecha            DATE NOT NULL,
    estado           TEXT,
    presentacion     TEXT,
    tipo             TEXT,
    medida_kg        TEXT,
    monto            NUMERIC(10,2) NOT NULL DEFAULT 0,
    empleado_num     TEXT,
    empleado_nombre  TEXT
);

CREATE TABLE IF NOT EXISTS reporte_chofer (
    id               SERIAL PRIMARY KEY,
    transportista    TEXT NOT NULL,
    camion           TEXT,
    cantidad_mermas  INTEGER NOT NULL DEFAULT 0,
    fecha            DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS merma_detalle (
    id            SERIAL PRIMARY KEY,
    reporte_id    INTEGER NOT NULL REFERENCES reporte_chofer(id) ON DELETE CASCADE,
    numero_merma  INTEGER NOT NULL,
    causa         TEXT NOT NULL,
    explicacion   TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS admin (
    id          SERIAL PRIMARY KEY,
    usuario     TEXT UNIQUE NOT NULL,
    clave_hash  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pedidos (
    id              SERIAL PRIMARY KEY,
    telefono        TEXT NOT NULL,
    tipo_hielo      TEXT,
    cantidad        INTEGER,
    direccion       TEXT,
    referencia      TEXT,
    metodo_pago     TEXT,
    monto_total     NUMERIC(10,2),
    estado          TEXT NOT NULL DEFAULT 'Nuevo',
    fecha_creacion  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS encuestas_bot (
    telefono        TEXT PRIMARY KEY,
    paso            INTEGER,
    tipo_hielo      TEXT,
    cantidad        INTEGER,
    direccion       TEXT,
    referencia      TEXT,
    pago            TEXT,
    actualizado_en  BIGINT
);

CREATE TABLE IF NOT EXISTS silencios_bot (
    telefono  TEXT PRIMARY KEY,
    hasta     BIGINT
);

-- Índices para las consultas de filtros y métricas por fecha
CREATE INDEX IF NOT EXISTS idx_registro_fecha ON registro(fecha);
CREATE INDEX IF NOT EXISTS idx_venta_fecha ON venta(fecha);
CREATE INDEX IF NOT EXISTS idx_pedidos_fecha ON pedidos(fecha_creacion);

-- Contenedores iniciales (1A-19A, 1B-19B, 1C-19C)
INSERT INTO contenedor (codigo, apartado)
SELECT n || l, l
FROM generate_series(1, 19) AS n
CROSS JOIN (VALUES ('A'), ('B'), ('C')) AS v(l)
ON CONFLICT (codigo) DO NOTHING;