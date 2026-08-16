import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from '../app/manifest';

/**
 * QUE SIGA SIENDO INSTALABLE.
 *
 * Todo lo que hace falta para que aparezca el botón de instalar es invisible:
 * un manifiesto, dos iconos de tamaños concretos y un service worker con un
 * manejador de `fetch`. Si mañana alguien renombra un PNG o quita el registro,
 * no falla nada — el botón simplemente deja de salir, y nadie se entera hasta
 * que alguien pregunta por qué ya no se puede instalar.
 *
 * Es la misma forma de fallo que guardan `lib/motion-tokens.test.ts` (una clase
 * de animación que no existe no falla, no hace nada) y `lib/deploy-migrate.test.ts`.
 */

const WEB = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => readFileSync(`${WEB}${rel}`, 'utf8');

describe('la aplicación instalable', () => {
  it('los iconos que declara existen de verdad', () => {
    const faltan = manifest()
      .icons?.map((i) => i.src)
      .filter((src) => !existsSync(`${WEB}public${src}`));
    expect(faltan, 'El manifiesto nombra un icono que no está en public/.').toEqual([]);
  });

  it('trae los dos tamaños que Chrome exige, y uno recortable para Android', () => {
    const icons = manifest().icons ?? [];
    const sizes = icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    // Sin uno `maskable`, Android mete el icono cuadrado dentro de su forma y le
    // corta las esquinas al dibujo.
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('abre en el producto, no en la página de ventas', () => {
    // Quien se instaló la aplicación ya compró: abrirla para leer otra vez de
    // qué va es la peor primera impresión posible.
    expect(manifest().start_url).toBe('/chat');
    expect(manifest().display).toBe('standalone');
  });

  it('el service worker existe y atiende `fetch`', () => {
    // Chrome no ofrece instalar sin un manejador de `fetch`. Es literalmente la
    // única razón por la que ese archivo existe.
    const sw = read('public/sw.js');
    expect(sw).toContain("addEventListener('fetch'");
  });

  it('NO guarda páginas, y eso es la decisión, no un olvido', () => {
    /**
     * Un HTML guardado sobrevive al cierre de sesión: en un computador
     * compartido, el siguiente en abrirlo vería la pantalla del anterior. Y una
     * cifra servida de la caché no se ve distinta de la de ahora, en un producto
     * cuyo valor entero es decir de cuándo es cada dato.
     *
     * Lo único que puede estar en la caché es la página de «sin conexión».
     */
    const sw = read('public/sw.js');
    const guardados = [...sw.matchAll(/cache\.(?:add|put|addAll)\(([^)]*)\)/g)].map((m) => m[1]);
    for (const arg of guardados) {
      expect(arg, `El service worker guarda ${arg}, y sólo puede guardar OFFLINE_URL.`).toContain(
        'OFFLINE_URL',
      );
    }
  });

  it('alguien sin conexión ve una página, no el dinosaurio', () => {
    const page = read('public/sin-conexion.html');
    // Sin hojas ni tipografías externas: es la única página que tiene que
    // dibujarse justo cuando no se puede descargar nada.
    expect(page).not.toMatch(/<link[^>]+rel=["']stylesheet/i);
    expect(page).not.toMatch(/<script[^>]+src=/i);
    expect(page).toContain('lang="es-CO"');
  });

  /**
   * NADA DE ESTO PUEDE ESTAR DETRÁS DEL LOGIN, Y ESTUVO.
   *
   * Recién desplegado, en producción: `GET /manifest.webmanifest` devolvía un
   * 307 a `/login`. El filtro del middleware excluía `_next/static` y
   * `favicon.ico`, y ninguno de los archivos nuevos. Eso deja la aplicación
   * instalable completamente inerte —sin botón, sin service worker, sin icono
   * en iOS— y el único síntoma es un botón que no aparece. Nadie reporta eso.
   *
   * Se comprueba contra lo que el MANIFIESTO declara, no contra una segunda
   * lista escrita a mano: el día que alguien añada un icono, esta prueba falla
   * hasta que también lo deje pasar.
   */
  it('lo que el navegador pide sin sesión no está detrás del login', () => {
    /**
     * Se lee SÓLO la lista, no el archivo entero.
     *
     * La primera versión de esta prueba buscaba en todo `middleware.ts`, y no
     * mordía: el comentario que documenta el fallo nombra `icon-512.png`, así
     * que quitarlo de la lista real seguía «pasando». Una prueba que la
     * documentación del fallo satisface no prueba nada.
     */
    const src = read('middleware.ts');
    const block = src.slice(src.indexOf('matcher: ['));
    // Sin las barras de escape: el matcher es una expresión regular y escribe
    // `icon-192\.png`, que como texto no contiene `icon-192.png`.
    const matcher = block.slice(0, block.indexOf(']')).replaceAll('\\', '');
    const publicos = [
      ...(manifest().icons ?? []).map((i) => i.src),
      '/manifest.webmanifest',
      '/sw.js',
      '/sin-conexion.html',
    ];
    const bloqueados = publicos.filter((p) => !matcher.includes(p.replace(/^\//, '')));
    expect(
      bloqueados,
      'El middleware no deja pasar estos archivos, así que el navegador recibe una ' +
        'redirección a /login en vez del archivo — y la aplicación deja de poder ' +
        'instalarse, sin ningún error visible.',
    ).toEqual([]);
  });

  it('el documento se declara en español', () => {
    // Estaba en `lang="en"` con el producto entero en español: un lector de
    // pantalla lo leía con voz inglesa.
    expect(read('app/layout.tsx')).toContain('lang="es-CO"');
  });
});
