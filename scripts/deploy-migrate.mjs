#!/usr/bin/env node
/**
 * LAS MIGRACIONES, APLICADAS ANTES DE PUBLICAR EL CÓDIGO QUE LAS NECESITA.
 *
 * ===========================================================================
 * EL DÍA QUE ESTO HIZO FALTA
 * ===========================================================================
 * Vercel publica en cuanto se toca `main`. Las migraciones esperaban a que
 * alguien se acordara de correr `db push` a mano. Entre las dos cosas hay una
 * ventana, y en esa ventana la aplicación está rota — con síntomas que no se
 * parecen NADA a la causa:
 *
 *   «new row for relation "reports" violates check constraint
 *    "reports_kind_check"»           ← faltaba la 0103
 *   «Application error: a server-side exception has occurred.
 *    Digest: 3435760676»             ← faltaba la 0104, y con ella /company
 *
 * Tres pantallas rotas, tres errores distintos, ninguno diciendo «la base va
 * por detrás del código». El dueño se enteró usando el producto.
 *
 * ===========================================================================
 * ANTES DEL BUILD, Y ESO ESTÁ RAZONADO
 * ===========================================================================
 * Si la migración falla, el build no llega a correr, no se publica nada, y
 * producción sigue sirviendo el código viejo contra la base vieja. Esa
 * combinación funciona: es la que estaba funcionando hace un minuto.
 *
 * Si la migración pasa y el build falla después, producción queda con el código
 * VIEJO contra la base NUEVA. Eso también funciona, porque todas las
 * migraciones de este repositorio son aditivas — una columna que nadie lee, una
 * tabla que nadie consulta, un CHECK que admite un valor más. «La base por
 * delante» es la dirección segura del desfase; «el código por delante» es la
 * que rompe pantallas, y es justamente la que esto elimina.
 *
 * ===========================================================================
 * SÓLO EN PRODUCCIÓN, Y ESO ES LO MÁS IMPORTANTE DE ESTE ARCHIVO
 * ===========================================================================
 * Vercel construye TAMBIÉN cada rama y cada pull request. Sin esta guarda, la
 * vista previa de una rama a medio hacer aplicaría sus migraciones a la base de
 * producción — un fallo mucho peor que el que esto viene a arreglar. Por eso lo
 * primero que se mira es `VERCEL_ENV`, y cualquier cosa que no sea
 * `production` se salta sin hacer nada y lo dice.
 */

import { spawnSync } from 'node:child_process';

const log = (...args) => console.log('[migraciones]', ...args);

/**
 * Fuera de Vercel esto no corre — un `pnpm build` en el portátil de alguien no
 * tiene por qué tocar ninguna base. La variable la pone Vercel siempre.
 */
const env = process.env.VERCEL_ENV;
if (!env) {
  log('no estamos en Vercel: no se toca ninguna base.');
  process.exit(0);
}

if (env !== 'production') {
  // Una vista previa NO comparte base con producción en este proyecto, y
  // aunque la compartiera, aplicarle las migraciones de una rama sin revisar
  // sería exactamente el accidente que este archivo existe para no tener.
  log(`entorno "${env}": las vistas previas no aplican migraciones.`);
  process.exit(0);
}

/**
 * Y AQUÍ NO SE SALTA NADA EN SILENCIO.
 *
 * Estamos publicando a producción. Si no hay con qué conectarse a la base, la
 * elección es entre parar el despliegue o publicar código que la base puede no
 * soportar — que es el fallo original. Se para.
 */
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error(
    '[migraciones] FALTA SUPABASE_DB_URL en el entorno de producción.\n' +
      'Sin ella no se puede saber si la base está al día, y publicar a ciegas es\n' +
      'lo que dejó tres pantallas rotas el 14 de agosto de 2026. Añádela en las\n' +
      'variables de entorno del proyecto en Vercel y vuelve a desplegar.',
  );
  process.exit(1);
}

log('aplicando las migraciones pendientes en producción…');

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'supabase',
    'db',
    'push',
    '--workdir',
    'infra',
    // Por URL y no por proyecto enlazado: un build de Vercel no tiene sesión
    // iniciada ni `infra/.temp`, y no debería necesitarla. La URL ya está en el
    // entorno porque la aplicación la usa.
    '--db-url',
    dbUrl,
    // Sin `--include-all` a propósito: aplicar migraciones que quedaron fuera de
    // orden es una decisión que toma una persona mirando, no un build.
  ],
  {
    // La 1.219 del CLI no tiene `--yes`: pregunta «¿aplicar?» y espera. Sin una
    // terminal detrás, esa pregunta es un build colgado hasta que Vercel lo
    // mate por tiempo, y el registro no diría por qué. La respuesta va por la
    // entrada estándar; la salida y los errores siguen yendo al registro del
    // despliegue, que es donde alguien los va a leer.
    stdio: ['pipe', 'inherit', 'inherit'],
    input: 'y\n',
    encoding: 'utf8',
  },
);

if (result.status !== 0) {
  console.error(
    '\n[migraciones] NO SE PUDO APLICAR. El despliegue se detiene aquí a propósito:\n' +
      'producción sigue sirviendo el código anterior contra la base anterior, que es\n' +
      'una combinación que funciona. Arregla la migración y vuelve a desplegar.',
  );
  process.exit(result.status ?? 1);
}

log('base al día.');
