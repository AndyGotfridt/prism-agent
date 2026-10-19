// Spikes 1-3 de docs/PLAN-AGENT-BRIDGE.md §10 contra una impresora Bambu real.
//
//   cd tools/prisma-agent/spikes && bun install
//   PRINTER_IP=192.168.1.50 PRINTER_SERIAL=0309... PRINTER_CODE=12345678 \
//     bun bridge-spike.js mqtt|ftp|camera|all          # con Bun, para ver que anda
//   bun build --compile bridge-spike.js --outfile bridge-spike && ./bridge-spike all   # el que importa
//
// Imprime PASS/FAIL por spike. El access code nunca se loguea.
import { connect as tlsConnect } from 'node:tls';
import mqtt from 'mqtt';
import { Client as FtpClient } from 'basic-ftp';

const { PRINTER_IP: ip, PRINTER_SERIAL: serial, PRINTER_CODE: code } = process.env;
if (!ip || !serial || !code) {
    console.error('Faltan PRINTER_IP, PRINTER_SERIAL y PRINTER_CODE.');
    process.exit(2);
}
const what = process.argv[2] ?? 'all';
const results = [];
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function spikeMqtt() {
    const t0 = Date.now();
    const client = mqtt.connect(`mqtts://${ip}:8883`, { username: 'bblp', password: code, rejectUnauthorized: false, connectTimeout: 10_000, reconnectPeriod: 0, clientId: `spike-${Date.now()}` });
    const seen = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Sin reportes en 20 s')), 20_000);
        client.on('error', (e) => { clearTimeout(timer); reject(e); });
        client.on('connect', () => {
            console.log(`  mqtt conectado en ${Date.now() - t0} ms`);
            client.subscribe(`device/${serial}/report`, (err) => {
                if (err) return reject(err);
                client.publish(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: '1', command: 'pushall', version: 1, push_target: 1 } }));
            });
        });
        let n = 0, bytes = 0, full = 0;
        client.on('message', (_t, payload) => {
            n++; bytes += payload.length;
            const print = JSON.parse(payload.toString()).print;
            if (print?.gcode_state && print?.nozzle_temper !== undefined) full++;
            if (full >= 1 && n >= 3) { clearTimeout(timer); resolve({ n, bytes, full }); }
        });
    });
    client.end(true);
    console.log(`  ${seen.n} mensajes, ${kb(seen.bytes)} en total, ${seen.full} con estado completo`);
}

async function spikeFtp() {
    const c = new FtpClient(15_000);
    try {
        await c.access({ host: ip, port: 990, user: 'bblp', password: code, secure: 'implicit', secureOptions: { rejectUnauthorized: false } });
        const list = await c.list('/');
        console.log(`  FTPS ok, ${list.length} entradas en /: ${list.slice(0, 5).map((f) => f.name).join(', ')}`);
        // Canal de datos con reuso de sesión TLS: bajar el primer archivo chico (<= 64 KB), o listar /cache.
        const file = list.find((f) => f.isFile && f.size > 0 && f.size <= 65_536);
        if (file) {
            const chunks = [];
            const { Writable } = await import('node:stream');
            await c.downloadTo(new Writable({ write(ch, _e, cb) { chunks.push(ch); cb(); } }), file.name);
            console.log(`  RETR ${file.name}: ${kb(Buffer.concat(chunks).length)}`);
        } else {
            console.log('  (no había un archivo chico para probar RETR; el LIST ya usó el canal de datos)');
        }
    } finally {
        c.close();
    }
}

function spikeCamera() {
    return new Promise((resolve, reject) => {
        const auth = Buffer.alloc(80);
        auth.writeUInt32LE(0x40, 0); auth.writeUInt32LE(0x3000, 4);
        auth.write('bblp', 16, 'ascii'); auth.write(code, 48, 'ascii');
        const sock = tlsConnect({ host: ip, port: 6000, rejectUnauthorized: false, timeout: 10_000 }, () => sock.write(auth));
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('Sin frame en 10 s (¿Developer Mode / LAN mode?)')); }, 10_000);
        sock.on('error', (e) => { clearTimeout(timer); reject(e); });
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length < 16) return;
            const size = buf.readUInt32LE(0);
            if (size <= 0 || size > 6_000_000) { clearTimeout(timer); sock.destroy(); return reject(new Error(`Tamaño de frame inverosímil: ${size}`)); }
            if (buf.length < 16 + size) return;
            const jpeg = buf.subarray(16, 16 + size);
            clearTimeout(timer); sock.destroy();
            if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[size - 2] !== 0xff || jpeg[size - 1] !== 0xd9) return reject(new Error('El frame no es un JPEG válido'));
            console.log(`  frame JPEG de ${kb(size)}`);
            resolve();
        });
    });
}

const spikes = { mqtt: ['1. MQTT.js', spikeMqtt], ftp: ['2. FTPS implícito (basic-ftp)', spikeFtp], camera: ['3. Cámara :6000 (node:tls)', spikeCamera] };
for (const key of what === 'all' ? Object.keys(spikes) : [what]) {
    const [title, fn] = spikes[key] ?? [];
    if (!fn) { console.error(`Spike desconocido: ${key}`); process.exit(2); }
    console.log(`\n${title}  [${typeof Bun !== 'undefined' ? 'bun ' + Bun.version : 'node ' + process.version}]`);
    try { await fn(); results.push([title, 'PASS']); console.log('  PASS'); }
    catch (e) { results.push([title, 'FAIL']); console.log(`  FAIL: ${String(e.message).replaceAll(code, '***')}`); }
}
console.log('\nResumen:'); results.forEach(([t, r]) => console.log(`  ${r}  ${t}`));
process.exit(results.some(([, r]) => r === 'FAIL') ? 1 : 0);
