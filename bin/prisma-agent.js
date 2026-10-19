#!/usr/bin/env node
import { main } from '../src/cli.js';
import { error, ownLogFile } from '../src/log.js';

main(process.argv.slice(2)).catch((err) => {
    // Como servicio en Windows no hay stderr redirigido: el error va al log.
    if (ownLogFile()) error(`Fatal: ${err.message}`);
    else console.error(`✖ ${err.message}`);
    process.exit(1);
});
