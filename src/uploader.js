import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { ApiError } from './api.js';
import { log, warn } from './log.js';

const MAX_TRIES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Si la subida en tajadas (con progreso) falla y la de un solo buffer anda, el camino entre
// el agente y el server no la banca: se sigue sin progreso hasta que se reinicie el agente.
let streamDisabled = false;

/** Sube una parte avisando el progreso; si el streaming no anda, cae al PUT de siempre. */
async function putPart(api, url, part, onBytes) {
    if (!streamDisabled) {
        try {
            return await api.putStream(url, part, onBytes);
        } catch (err) {
            if (!(err instanceof ApiError) || err.status !== 0) throw err;
            const res = await api.put(url, part); // si esto también falla, es la red: lo reintenta withRetry
            streamDisabled = true;
            warn(`Streaming upload failed (${err.message}); continuing without progress`);
            onBytes?.(part.length);
            return res;
        }
    }
    const res = await api.put(url, part);
    onBytes?.(part.length);
    return res;
}

export function sha256File(path) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(path)
            .on('data', (chunk) => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/** Reintenta ante red caída / 5xx / 429 con backoff exponencial. Un 4xx no se reintenta. */
export async function withRetry(label, fn) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!(err instanceof ApiError) || !err.retryable || attempt >= MAX_TRIES) throw err;
            const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1));
            warn(`${label}: ${err.message}, retry ${attempt}/${MAX_TRIES - 1} in ${wait / 1000}s`);
            await sleep(wait);
        }
    }
}

/**
 * Sube un archivo a la bandeja: dedupe por sha256, después en partes (< 100 MB cada una
 * por Cloudflare; el tamaño lo decide el server). Se lee una parte por vez (32 MB): nunca el
 * archivo entero en memoria.
 *
 * `onProgress({ phase, sent, total })`: `hash` mientras calcula el sha256 y `upload` con los
 * bytes enviados (para la ventanita de progreso).
 *
 * Devuelve { duplicate, item_id, status, uploaded_by, url }.
 */
export async function uploadFile(api, path, { onProgress } = {}) {
    const filename = basename(path);
    const { size, mtime } = statSync(path);
    onProgress?.({ phase: 'hash', sent: 0, total: size });
    const sha256 = await sha256File(path);

    const { data: check } = await withRetry(`${filename} check`, () => api.post('/slicer-inbox/check', { sha256, size, filename }));
    if (check.exists) {
        return { duplicate: true, item_id: check.item_id, status: check.status, uploaded_by: check.uploaded_by, url: check.url };
    }


    // Un sha que no coincide al completar (el archivo cambió a mitad) se reintenta una vez entero.
    for (let round = 1; round <= 2; round++) {
        const { data: upload } = await withRetry(`${filename} start`, () =>
            api.post('/slicer-inbox/uploads', { filename, size, sha256, source_mtime: mtime.toISOString() }),
        );

        onProgress?.({ phase: 'upload', sent: 0, total: size });
        for (let i = 0; i < upload.chunks; i++) {
            const start = i * upload.chunk_size;
            const part = readPart(path, start, Math.min(size, start + upload.chunk_size) - start);
            const report = (bytes) => onProgress?.({ phase: 'upload', sent: start + bytes, total: size });
            await withRetry(`${filename} chunk ${i + 1}/${upload.chunks}`, () => putPart(api, `/slicer-inbox/uploads/${upload.upload_id}/chunks/${i}`, part, report));
            if (upload.chunks > 1) log(`${filename}: chunk ${i + 1}/${upload.chunks} sent`);
        }

        try {
            const { data } = await withRetry(`${filename} complete`, () => api.post(`/slicer-inbox/uploads/${upload.upload_id}/complete`, {}));
            return { duplicate: data.duplicate, item_id: data.id, status: data.status, uploaded_by: data.uploaded_by, url: data.url };
        } catch (err) {
            if (round === 1 && err instanceof ApiError && err.status === 422 && /sha256/i.test(err.message)) {
                warn(`${filename}: checksum mismatch, uploading again: ${err.message}`);
                continue;
            }
            throw err;
        }
    }

    throw new Error('No se pudo subir el archivo.');
}

/** Lee `length` bytes desde `start` (una parte de la subida). */
function readPart(path, start, length) {
    const fd = openSync(path, 'r');
    try {
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
            const n = readSync(fd, buffer, read, length - read, start + read);
            if (n === 0) break;
            read += n;
        }
        return read === length ? buffer : buffer.subarray(0, read);
    } finally {
        closeSync(fd);
    }
}

/** Consulta el ítem hasta que quede pending/failed (o se agote el tiempo). */
export async function waitForAnalysis(api, itemId, { timeoutMs = 5 * 60_000, everyMs = 3000 } = {}) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            const { data } = await api.get(`/slicer-inbox/items/${itemId}`);
            if (!['received', 'analyzing'].includes(data.status)) return data;
        } catch (err) {
            if (!(err instanceof ApiError) || !err.retryable) throw err;
        }
        await sleep(everyMs);
    }
    return null;
}
