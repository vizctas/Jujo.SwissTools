/**
 * Memoria del puente: dispositivos conocidos, perfiles de escucha y capturas.
 *
 * `node:sqlite` viene en Node, así que esto no añade ni una dependencia. El archivo
 * vive junto al puente y sobrevive a los reinicios: la gracia es que un dispositivo
 * emparejado una vez se reconecte solo la próxima vez, sin volver a teclear la IP.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_PATH = join(homedir(), '.jujo-swisstools', 'bridge.db');

export class Store {
  #db;

  constructor(path = DEFAULT_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    // WAL: el sondeo de dispositivos escribe cada pocos segundos mientras la
    // interfaz lee. Sin esto se bloquean entre ellos en Windows.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#migrate();
  }

  #migrate() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        serial       TEXT PRIMARY KEY,
        address      TEXT,
        label        TEXT,
        transport    TEXT NOT NULL DEFAULT 'usb',
        model        TEXT,
        release      TEXT,
        sdk          INTEGER,
        abis         TEXT,
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL,
        auto_connect INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        log_filter TEXT NOT NULL DEFAULT '',
        pattern    TEXT,
        builtin    INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS captures (
        id         TEXT PRIMARY KEY,
        url        TEXT NOT NULL,
        serial     TEXT,
        kind       TEXT,
        status     TEXT NOT NULL,
        path       TEXT,
        size       INTEGER,
        duration   REAL,
        detail     TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS captures_recent ON captures (created_at DESC);
    `);

    const seed = this.#db.prepare(
      'INSERT OR IGNORE INTO profiles (id, name, log_filter, pattern, builtin) VALUES (?, ?, ?, ?, 1)',
    );
    seed.run('any-media', 'Cualquier vídeo (mp4 / m3u8 / mpd)', 'http', null);
    seed.run('xbox', 'Xbox Media (ijkmp)', 'ijkmp_set_data_source', 'url="([^"]+xbox[^"]+)"');
    seed.run('everything', 'Todo el logcat (sin filtro)', '', null);
  }

  /* ----------------------------------------------------------- Dispositivos */

  /**
   * Registra o refresca un dispositivo visto. `address` solo se guarda para los de
   * red: es lo único que permite volver a llamarlos con `adb connect`.
   */
  seen(device) {
    const now = Date.now();
    const address = device.transport === 'tcp' ? device.serial : null;
    this.#db
      .prepare(
        `INSERT INTO devices (serial, address, transport, model, release, sdk, abis, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(serial) DO UPDATE SET
           address   = COALESCE(excluded.address, devices.address),
           transport = excluded.transport,
           model     = COALESCE(excluded.model, devices.model),
           release   = COALESCE(excluded.release, devices.release),
           sdk       = COALESCE(excluded.sdk, devices.sdk),
           abis      = COALESCE(excluded.abis, devices.abis),
           last_seen = excluded.last_seen`,
      )
      .run(
        device.serial,
        address,
        device.transport,
        device.details?.model ?? device.model ?? null,
        device.details?.release ?? null,
        device.details?.sdk ?? null,
        device.details?.abis?.join(',') ?? null,
        now,
        now,
      );
  }

  /** Todos los conocidos, con lo último que se supo de ellos. */
  knownDevices() {
    return this.#db
      .prepare('SELECT * FROM devices ORDER BY last_seen DESC')
      .all()
      .map((row) => ({
        serial: row.serial,
        address: row.address,
        label: row.label,
        transport: row.transport,
        model: row.model,
        release: row.release,
        sdk: row.sdk,
        abis: row.abis ? row.abis.split(',') : [],
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        autoConnect: row.auto_connect === 1,
      }));
  }

  /** Los de red que hay que intentar despertar con `adb connect`. */
  reconnectTargets() {
    return this.#db
      .prepare(
        "SELECT address FROM devices WHERE transport = 'tcp' AND auto_connect = 1 AND address IS NOT NULL",
      )
      .all()
      .map((row) => row.address);
  }

  setAutoConnect(serial, value) {
    this.#db
      .prepare('UPDATE devices SET auto_connect = ? WHERE serial = ?')
      .run(value ? 1 : 0, serial);
  }

  setLabel(serial, label) {
    this.#db.prepare('UPDATE devices SET label = ? WHERE serial = ?').run(label || null, serial);
  }

  forget(serial) {
    this.#db.prepare('DELETE FROM devices WHERE serial = ?').run(serial);
  }

  /* --------------------------------------------------------------- Perfiles */

  profiles() {
    return this.#db
      .prepare('SELECT * FROM profiles ORDER BY builtin DESC, name')
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        logFilter: row.log_filter,
        pattern: row.pattern,
        builtin: row.builtin === 1,
      }));
  }

  saveProfile({ id, name, logFilter = '', pattern = null }) {
    this.#db
      .prepare(
        `INSERT INTO profiles (id, name, log_filter, pattern, builtin) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, log_filter = excluded.log_filter, pattern = excluded.pattern`,
      )
      .run(id, name, logFilter, pattern);
  }

  deleteProfile(id) {
    this.#db.prepare('DELETE FROM profiles WHERE id = ? AND builtin = 0').run(id);
  }

  /* --------------------------------------------------------------- Capturas */

  recordCapture(capture) {
    this.#db
      .prepare(
        `INSERT INTO captures (id, url, serial, kind, status, path, size, duration, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, status = excluded.status, path = excluded.path,
           size = excluded.size, duration = excluded.duration, detail = excluded.detail`,
      )
      .run(
        capture.id,
        capture.url,
        capture.serial ?? null,
        capture.kind ?? null,
        capture.status,
        capture.path ?? null,
        capture.size ?? null,
        capture.duration ?? null,
        capture.detail ?? null,
        capture.createdAt ?? Date.now(),
      );
  }

  captures(limit = 60) {
    return this.#db
      .prepare('SELECT * FROM captures ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        id: row.id,
        url: row.url,
        serial: row.serial,
        kind: row.kind,
        status: row.status,
        path: row.path,
        size: row.size,
        duration: row.duration,
        detail: row.detail,
        createdAt: row.created_at,
      }));
  }

  /** ¿Ya se descargó esta URL con éxito? Evita bajar dos veces lo mismo. */
  captureFor(url) {
    return (
      this.#db
        .prepare("SELECT * FROM captures WHERE url = ? AND status = 'saved' LIMIT 1")
        .get(url) ?? null
    );
  }

  clearCaptures() {
    this.#db.exec('DELETE FROM captures');
  }

  close() {
    this.#db.close();
  }
}
