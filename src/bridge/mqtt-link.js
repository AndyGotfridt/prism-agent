import mqtt from 'mqtt';
import { log, warn } from '../log.js';

/**
 * Una impresora Bambu por su broker MQTT de la LAN (:8883, usuario `bblp` + access code,
 * certificado autofirmado). Lo mismo que hace `bambu:listen --lan=ID` en el server: se suscribe a
 * `device/{serial}/report`, pide `pushall` cada tanto y va mergeando los deltas (Bambu manda parciales)
 * en un estado acumulado que el reporter manda al server.
 *
 * El access code vive sólo acá, en memoria: nunca se loguea ni se escribe a disco.
 */
export class MqttLink {
    /**
     * @param {{ id: number, name: string, serial: string, lan_ip: string, access_code: string, pushall_interval?: number }} printer
     * @param {{ onChange?: () => void }} [hooks]
     */
    constructor(printer, { onChange } = {}) {
        this.printer = printer;
        this.onChange = onChange ?? (() => {});
        this.client = null;
        this.pushTimer = null;
        this.state = {}; // merge acumulado del `print` de la impresora
        this.dirty = false;
        this.connected = false;
        this.lastReportAt = null; // ms
        this.error = null;
        this.lastLoggedError = null; // último motivo de «no conecta» ya logueado
        this.wasOffline = false;
        this.waiters = new Set(); // pedidos esperando el ack de la impresora (`request`)
        this.connectedAt = null; // ms
        this.lastPushAt = null; // ms del último pushall publicado
        this.silentLoggedAt = 0;
        this.watchTimer = null;
    }

    /** Diagnóstico temporal (1.1.23): qué pasa con el MQTT de cada impresora. Sacar cuando se entienda el «sin conexión». */
    dbg(msg) {
        log(`[mqtt-debug] «${this.printer.name}» ${msg}`);
    }

    /** Segundos desde el último reporte de la impresora (o desde que conectó, si todavía no mandó ninguno). */
    silentFor() {
        const ref = this.lastReportAt ?? this.connectedAt;

        return ref ? Math.round((Date.now() - ref) / 1000) : null;
    }

    start() {
        const { lan_ip: ip, serial, access_code: code, name } = this.printer;
        this.client = mqtt.connect(`mqtts://${ip}:8883`, {
            username: 'bblp',
            password: code,
            rejectUnauthorized: false, // CN del certificado = serial, no la IP
            connectTimeout: 10_000,
            reconnectPeriod: 5_000,
            keepalive: 60,
            clientId: `prisma-bridge-${serial.slice(-6)}-${Math.random().toString(16).slice(2, 8)}`,
        });

        this.client.on('connect', () => {
            this.connected = true;
            this.error = null;
            this.lastLoggedError = null;
            this.connectedAt = Date.now();
            log(`Puente: conectado a «${name}» (${ip})`);
            this.dbg('connect (sesión MQTT nueva)');
            this.client.subscribe(`device/${serial}/report`, { qos: 0 }, (err) => {
                if (err) this.error = `No se pudo suscribir: ${err.message}`;
            });
            this.pushAll();
            clearInterval(this.pushTimer);
            this.pushTimer = setInterval(() => this.pushAll(), Math.max(10, this.printer.pushall_interval ?? 30) * 1000);
            this.pushTimer.unref?.();
            this.onChange();
        });

        this.client.on('reconnect', () => this.dbg('reconnect (reintentando)'));
        this.client.on('disconnect', (packet) => this.dbg(`disconnect del broker: ${JSON.stringify(packet)}`));
        this.client.on('end', () => this.dbg('end'));

        // Perro guardián de diagnóstico: conectado pero la A1 sin hablar. NO reconecta, sólo avisa (cada 60 s).
        clearInterval(this.watchTimer);
        this.watchTimer = setInterval(() => {
            const silent = this.silentFor();
            if (!this.connected || silent === null || silent < 60 || Date.now() - this.silentLoggedAt < 60_000) return;
            this.silentLoggedAt = Date.now();
            this.dbg(`CONECTADO pero sin reportes hace ${silent} s (último pushall hace ${this.lastPushAt ? Math.round((Date.now() - this.lastPushAt) / 1000) : '—'} s, client.connected=${this.client?.connected})`);
        }, 15_000);
        this.watchTimer.unref?.();

        this.client.on('message', (_topic, payload) => {
            let print;
            try {
                print = JSON.parse(payload.toString()).print;
            } catch {
                return;
            }
            if (!print || typeof print !== 'object') return;
            for (const waiter of this.waiters) waiter(print);
            this.state = { ...this.state, ...print };
            if (this.lastReportAt === null || Date.now() - this.lastReportAt > 60_000) this.dbg(`reporte recibido (command=${print.command ?? '—'}, gcode_state=${print.gcode_state ?? '—'}), antes silencio de ${this.silentFor()} s`);
            this.lastReportAt = Date.now();
            this.dirty = true;
            this.onChange();
        });

        const down = (reason) => {
            if (this.connected) warn(`Puente: se perdió «${name}» (${ip}): ${reason}`);
            if (this.connected) this.dbg(`caída tras ${this.silentFor()} s sin reportes (conectado desde hace ${this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) : '—'} s)`);
            this.connected = false;
            this.error = reason;
            clearInterval(this.pushTimer);
            this.onChange();
        };
        this.client.on('close', () => down(this.error ?? 'conexión cerrada'));
        this.client.on('offline', () => down('sin red'));
        this.client.on('error', (err) => {
            // Un access code mal cargado o la impresora apagada: se reintenta solo cada 5 s.
            this.error = /Not authorized|Bad username/i.test(err.message) ? 'Access code incorrecto' : err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ETIMEDOUT' ? 'Apagada o fuera de la red' : err.message;
            // Reintenta solo cada 5 s, pero sin este aviso el log no decía nunca POR QUÉ una impresora no conectaba (sólo se
            // logueaba perder una conexión ya establecida). Una línea por cambio de motivo, no una cada 5 s.
            if (!this.connected && this.error !== this.lastLoggedError) {
                this.lastLoggedError = this.error;
                warn(`Puente: «${name}» no conecta por MQTT (${ip}:8883): ${this.error}${err.code ? ` [${err.code}]` : ''}`);
            }
        });
    }

    pushAll() {
        if (!this.client?.connected) return;
        this.lastPushAt = Date.now();
        this.client.publish(
            `device/${this.printer.serial}/request`,
            JSON.stringify({ pushing: { sequence_id: String(Math.floor(Date.now() / 1000)), command: 'pushall', version: 1, push_target: 1 } }),
            { qos: 0 },
        );
    }

    /**
     * Publica un comando en `device/{serial}/request` (el único tópico de escritura, siempre el de ESTA
     * impresora: el server no elige el tópico). Resuelve cuando el broker lo recibió.
     *
     * @param {object} payload
     */
    publish(payload) {
        return new Promise((resolve, reject) => {
            if (!this.client?.connected) return reject(new Error(this.error ? `La impresora no está conectada (${this.error})` : 'La impresora no está conectada'));
            this.client.publish(`device/${this.printer.serial}/request`, JSON.stringify(payload), { qos: 0 }, (err) => (err ? reject(err) : resolve()));
        });
    }

    /**
     * Publica y espera el reporte de la impresora con `print.command === ackCommand` (y el mismo
     * `sequence_id`, si lo trae). Se engancha ANTES de publicar para no perder la respuesta.
     * Resuelve con ese `print`, o con null si no contestó a tiempo (rechazo silencioso).
     *
     * @param {object} payload
     * @param {string} ackCommand
     * @param {string} sequenceId
     * @param {number} timeoutMs
     * @returns {Promise<object | null>}
     */
    async request(payload, ackCommand, sequenceId, timeoutMs) {
        let waiter;
        const reply = new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), timeoutMs);
            waiter = (print) => {
                if (print.command !== ackCommand) return;
                const seq = String(print.sequence_id ?? '');
                if (seq !== '' && seq !== String(sequenceId)) return;
                clearTimeout(timer);
                resolve(print);
            };
            this.waiters.add(waiter);
        });
        try {
            await this.publish(payload);
            return await reply;
        } finally {
            this.waiters.delete(waiter);
        }
    }

    /** Estado acumulado si hay algo nuevo desde el último envío (y lo marca como enviado). */
    takeIfDirty() {
        if (!this.dirty) return null;
        this.dirty = false;

        return this.state;
    }

    /** Para volver a mandarlo si el server no lo recibió. */
    markDirty() {
        this.dirty = true;
    }

    /** ¿Imprimiendo o preparando? Cambia el ritmo de los reportes (2 s contra 10 s). */
    get active() {
        return ['RUNNING', 'PREPARE', 'PAUSE'].includes(String(this.state.gcode_state ?? '').toUpperCase());
    }

    summary() {
        return { id: this.printer.id, connected: this.connected, last_report_at: this.lastReportAt, error: this.connected ? null : this.error };
    }

    stop() {
        clearInterval(this.pushTimer);
        clearInterval(this.watchTimer);
        this.pushTimer = null;
        this.client?.end(true);
        this.client = null;
        this.waiters.clear();
        this.connected = false;
        this.state = {};
    }
}
