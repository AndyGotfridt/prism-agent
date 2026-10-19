import { createSocket } from 'node:dgram';
import { log, warn } from '../log.js';

/**
 * Descubrimiento de impresoras Bambu en la LAN por SSDP (docs/PLAN-AGENT-BRIDGE.md, fase 5). Las Bambu anuncian
 * un NOTIFY a 239.255.255.250 (puertos 1990 y 2021 según el firmware) con el serial en `USN`, la IP en `Location`
 * y `DevModel/DevName.bambu.com`; además se manda un M-SEARCH cada minuto por si alguna está callada. Es sólo
 * escuchar: no toca nada en la red.
 */
const GROUP = '239.255.255.250';
const NOTIFY_PORTS = [1990, 2021];
const SEARCH =
    'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: urn:bambulab-com:device:3dprinter:1\r\n\r\n';

/** Un paquete SSDP → `{ serial, ip, model, name }`, o null si no es de una Bambu. */
export function parseSsdp(text) {
    const h = {};
    for (const line of String(text).split(/\r?\n/).slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const bambu = /bambulab/i.test(`${h.nt ?? ''} ${h.st ?? ''}`) || 'devmodel.bambu.com' in h;
    const serial = (h.usn ?? '').replace(/^uuid:/i, '').split('::')[0].trim().toUpperCase();
    const ip = (h.location ?? '').replace(/^https?:\/\//i, '').split(/[:/]/)[0];
    if (!bambu || !/^[A-Z0-9]{8,24}$/.test(serial) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;

    return { serial, ip, model: h['devmodel.bambu.com'] ?? null, name: h['devname.bambu.com'] ?? null };
}

export class Discovery {
    /** @param {{ onFound?: () => void }} [hooks] */
    constructor({ onFound } = {}) {
        this.onFound = onFound ?? (() => {});
        this.sockets = [];
        this.timer = null;
        this.found = new Map(); // serial → { serial, ip, model, name }
        this.pending = new Set(); // seriales nuevos o con IP distinta, todavía sin informar
    }

    start() {
        if (this.sockets.length) return;
        for (const port of NOTIFY_PORTS) this.listen(port);
        this.search();
        this.timer = setInterval(() => this.search(), 60_000);
        this.timer.unref?.();
    }

    listen(port) {
        const sock = createSocket({ type: 'udp4', reuseAddr: true });
        sock.on('error', (err) => {
            // Sin permiso o con el puerto tomado: no es grave, el resto del puente sigue.
            warn(`Puente: no se pudo escuchar el descubrimiento en el puerto ${port}: ${err.message}`);
            try {
                sock.close();
            } catch {
                // ya cerrado
            }
        });
        sock.on('message', (msg) => this.handle(msg));
        sock.bind(port, () => {
            try {
                sock.addMembership(GROUP);
            } catch (err) {
                warn(`Puente: no se pudo unir al grupo SSDP en ${port}: ${err.message}`);
            }
        });
        this.sockets.push(sock);
    }

    /** M-SEARCH desde un puerto efímero: las respuestas llegan por unicast a este mismo socket. */
    search() {
        const sock = createSocket({ type: 'udp4' });
        sock.on('error', () => sock.close());
        sock.on('message', (msg) => this.handle(msg));
        sock.send(SEARCH, 1990, GROUP, (err) => {
            if (err) sock.close();
        });
        setTimeout(() => {
            try {
                sock.close();
            } catch {
                // ya cerrado
            }
        }, 5_000).unref?.();
    }

    handle(msg) {
        const p = parseSsdp(msg.toString('utf8'));
        if (!p) return;
        const before = this.found.get(p.serial);
        this.found.set(p.serial, p);
        if (!before || before.ip !== p.ip) {
            if (!before) log(`Puente: detectada ${p.name ?? p.serial} en ${p.ip}`);
            this.pending.add(p.serial);
            this.onFound();
        }
    }

    /** Lo nuevo para informar al server; con `all` manda todo lo conocido (refresco cada tanto). */
    take(all = false) {
        const serials = all ? [...this.found.keys()] : [...this.pending];
        this.pending.clear();

        return serials.map((s) => this.found.get(s)).filter(Boolean);
    }

    /** Si el server no lo recibió, se reintenta con el próximo envío. */
    putBack(list) {
        for (const p of list) this.pending.add(p.serial);
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
        for (const s of this.sockets) {
            try {
                s.close();
            } catch {
                // ya cerrado
            }
        }
        this.sockets = [];
        this.found.clear();
        this.pending.clear();
    }
}
