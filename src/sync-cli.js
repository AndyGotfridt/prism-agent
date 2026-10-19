import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Api, ApiError } from './api.js';
import { getToken } from './keychain.js';
import { COMMAND } from './profile.js';

/**
 * `prisma-agent sync …`: ajustes rápidos de las carpetas a Drive desde la terminal, sin abrir
 * la web. Habla con /api/agent/v1/drive-syncs (el server sigue siendo la fuente de verdad: lo
 * que se cambia acá se ve en Mi perfil y viceversa). El alta de una carpeta nueva se hace en
 * la web, porque necesita explorar Drive.
 */

const SYNC_HELP = `Sincronización Drive:

  ${COMMAND} sync                       Lista las sincronizaciones y su estado
  ${COMMAND} sync scan <id|nombre>      Pide una revisión ahora
  ${COMMAND} sync pause <id|nombre>     Pausa (deja de sincronizar; no borra nada)
  ${COMMAND} sync resume <id|nombre>
  ${COMMAND} sync path <id|nombre> <carpeta>   Cambia la carpeta local (acepta ., ~ y relativas)
  ${COMMAND} sync mirror <id|nombre> on|off    Reflejar borrados a la papelera de Drive
  ${COMMAND} sync rename <id|nombre> <nombre nuevo>
  ${COMMAND} sync confirm <id|nombre>   Confirma los borrados frenados
  ${COMMAND} sync keep <id|nombre>      Mantiene en Drive lo que falta localmente
`;

function localPath(input) {
    if (input === '~') return homedir();
    if (/^~[\\/]/.test(input)) return join(homedir(), input.slice(2));

    return isAbsolute(input) ? input : resolve(process.cwd(), input);
}

function ago(iso) {
    if (!iso) return 'nunca';
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'hace instantes';
    if (min < 60) return `hace ${min} min`;
    if (min < 1440) return `hace ${Math.round(min / 60)} h`;

    return `hace ${Math.round(min / 1440)} d`;
}

function pick(list, ref) {
    if (/^\d+$/.test(ref)) {
        const byId = list.find((s) => s.id === Number(ref));
        if (byId) return byId;
    }
    const matches = list.filter((s) => s.name.toLowerCase() === ref.toLowerCase());
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Hay ${matches.length} sincronizaciones llamadas «${ref}»: usá el id.`);
    const partial = list.filter((s) => s.name.toLowerCase().includes(ref.toLowerCase()));
    if (partial.length === 1) return partial[0];
    throw new Error(`No encontré «${ref}». Corré \`${COMMAND} sync\` para ver la lista.`);
}

export async function syncCommand(args, local) {
    if (!local?.url) throw new Error(`Sin sesión. Corré \`${COMMAND} login\`.`);
    const token = await getToken(local.url);
    if (!token) throw new Error(`No hay token. Corré \`${COMMAND} login\`.`);
    const api = new Api(local.url, token);

    const [action = 'list', ref, ...rest] = args;
    if (['help', '--help', '-h'].includes(action)) {
        console.log(SYNC_HELP);

        return;
    }

    let list;
    try {
        ({ data: { data: list } } = await api.get('/drive-syncs'));
    } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw new Error(`Token inválido o revocado. Corré \`${COMMAND} login\`.`);
        throw err;
    }

    if (action === 'list' || action === 'ls') {
        if (list.length === 0) {
            console.log('No hay carpetas a Drive. Se crean en Mi perfil → Prisma Agent → Sincronización Drive.');

            return;
        }
        for (const s of list) {
            const flags = [s.enabled ? null : 'PAUSADA', s.mirror_deletes ? 'refleja borrados' : 'sólo agrega', s.this_device ? null : `en ${s.device}`].filter(Boolean);
            console.log(`#${s.id}  ${s.name}  ·  ${s.enabled ? s.status_label : 'Pausada'}`);
            console.log(`     ${s.local_path}  →  ${s.drive_path || '(Drive)'}`);
            console.log(`     ${s.files_count} archivos · última revisión ${ago(s.last_finished_at)} · ${flags.join(' · ')}`);
            if (s.blocked_deletions > 0) console.log(`     ⚠ ${s.blocked_deletions} borrados frenados: \`${COMMAND} sync confirm ${s.id}\` o \`${COMMAND} sync keep ${s.id}\``);
            if (s.last_error) console.log(`     ✖ ${s.last_error}`);
        }

        return;
    }

    if (!ref) throw new Error(`Falta cuál: \`${COMMAND} sync ${action} <id|nombre>\`.`);
    const sync = pick(list, ref);
    const base = `/drive-syncs/${sync.id}`;

    switch (action) {
        case 'scan':
            await api.post(`${base}/scan`, {});
            console.log(`✔ «${sync.name}»: revisión pedida (el agente la toma en unos segundos).`);
            break;
        case 'pause':
            await api.request('PATCH', base, { json: { enabled: false } });
            console.log(`✔ «${sync.name}» en pausa.`);
            break;
        case 'resume':
            await api.request('PATCH', base, { json: { enabled: true } });
            console.log(`✔ «${sync.name}» reanudada.`);
            break;
        case 'path': {
            if (rest.length === 0) throw new Error('Falta la carpeta.');
            const path = localPath(rest.join(' '));
            await api.request('PATCH', base, { json: { local_path: path } });
            console.log(`✔ «${sync.name}» ahora sincroniza ${path}.\n  Ojo: lo que ya estaba subido sigue indexado; si la carpeta nueva tiene otro contenido y «refleja borrados», revisá antes de dejarla correr.`);
            break;
        }
        case 'mirror': {
            const v = (rest[0] ?? '').toLowerCase();
            if (!['on', 'off'].includes(v)) throw new Error('Usá `on` u `off`.');
            await api.request('PATCH', base, { json: { mirror_deletes: v === 'on' } });
            console.log(`✔ «${sync.name}»: reflejar borrados ${v === 'on' ? 'activado' : 'desactivado'}.`);
            break;
        }
        case 'rename':
            if (rest.length === 0) throw new Error('Falta el nombre nuevo.');
            await api.request('PATCH', base, { json: { name: rest.join(' ') } });
            console.log(`✔ Renombrada a «${rest.join(' ')}».`);
            break;
        case 'confirm':
            await api.post(`${base}/confirm-deletions`, {});
            console.log(`✔ «${sync.name}»: en la próxima revisión se mandan a la papelera de Drive.`);
            break;
        case 'keep': {
            const { data } = await api.post(`${base}/keep-deleted`, {});
            console.log(`✔ «${sync.name}»: se mantienen en Drive ${data.kept} archivos.`);
            break;
        }
        default:
            console.log(SYNC_HELP);
            process.exit(1);
    }
}
