import { type Server, createServer } from 'node:http';

/**
 * Three errands on one fixture portal, chosen because they break different
 * things.
 *
 * WHY A FIXTURE AND NOT A RECORDING OF A PERSON. The measurement this file
 * exists for -- how many steps of a learned errand run correctly the first time
 * -- needs the SAME errand repeated against the SAME site before and after a
 * change to the engine. A human recording gives one sample of one errand and
 * cannot be replayed with a different extractor. A fixture can be driven by
 * Playwright, screenshotted, and re-driven identically an hour later, which is
 * what turns "this feels better" into a number.
 *
 * The three errands, and what each one is here to break:
 *
 *   acceso      The errand starts AFTER a login. A person teaching it is
 *               already inside, so the recording never shows the login -- and a
 *               replay from a clean browser lands on the login form and fails on
 *               step one. Every page under /panel redirects there without the
 *               session cookie.
 *
 *   formulario  Nine fields, one of them dependent on another (Ciudad is empty
 *               until Departamento is chosen) and two dropdowns. Segmenting this
 *               wrong -- missing a field, or ordering the two selects the wrong
 *               way round -- produces a flow that fails halfway with a
 *               validation error rather than one that fails to find something.
 *
 *   tabla       A search that returns five rows, each with a "Ver detalle" link
 *               that reads identically. The row is told apart by an aria-label
 *               a picture cannot show. This is the case where the model can only
 *               guess and the DOM is the only thing that knows.
 *
 * The portal's own latency is fixed at THINK_MS per page so that a run today is
 * comparable to a run tomorrow.
 */

const THINK_MS = 120;

const SESSION_COOKIE = 'portalsesion';
const GOOD_USER = 'contadora@acme.co';
const GOOD_PASSWORD = 'Clave-De-Prueba-2026';

const CHROME = (title: string, body: string) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;margin:0;color:#152238}
  header{background:#0f3f6e;color:#fff;padding:14px 24px}
  main{padding:24px;max-width:860px}
  label{display:block;margin-bottom:4px;font-size:14px}
  input,select,textarea{padding:7px;font-size:14px;min-width:280px}
  .campo{margin-bottom:14px}
  table{border-collapse:collapse;margin-top:12px}
  th,td{border:1px solid #b8c4d4;padding:7px 10px;text-align:left;font-size:14px}
  th{background:#eef3f9}
  button{padding:8px 16px;font-size:14px}
  .aviso{background:#fdecea;border:1px solid #f5c2c0;padding:12px;margin-bottom:16px}
</style></head>
<body>
  <header><strong>Portal Único de Servicios · Gobierno en Línea</strong></header>
  <main>${body}</main>
  <footer style="padding:16px 24px;color:#667;font-size:12px">Ventanilla única · Versión 4.2</footer>
</body></html>`;

// ---------------------------------------------------------------------------
// Errand 1 — behind a login
// ---------------------------------------------------------------------------

function loginPage(message: string): string {
  return CHROME(
    'Portal Único — Ingreso',
    `<h1>Ingreso al portal</h1>
     ${message ? `<div class="aviso" role="alert">${message}</div>` : ''}
     <form method="POST" action="/entrar">
       <div class="campo">
         <label for="txtUsuario">Usuario</label>
         <input id="txtUsuario" name="txtUsuario" type="text" autocomplete="username">
       </div>
       <div class="campo">
         <label for="txtClave">Contraseña</label>
         <input id="txtClave" name="txtClave" type="password" autocomplete="current-password">
       </div>
       <button type="submit" name="btnIngresar">Ingresar</button>
     </form>`,
  );
}

const PANEL = CHROME(
  'Portal Único — Panel de servicios',
  `<h1>Panel de servicios</h1>
   <p>Bienvenida, Contadora Acme S.A.S.</p>
   <ul>
     <li><a href="/panel/certificado">Certificado de antecedentes</a></li>
     <li><a href="/panel/paz-y-salvo">Paz y salvo de impuestos</a></li>
   </ul>`,
);

const CERTIFICADO_FORM = CHROME(
  'Portal Único — Certificado de antecedentes',
  `<h1>Certificado de antecedentes</h1>
   <form method="POST" action="/panel/certificado">
     <div class="campo">
       <label for="ddlTipoDoc">Tipo de documento</label>
       <select id="ddlTipoDoc" name="ddlTipoDoc">
         <option value="">Seleccione…</option>
         <option value="CC">Cédula de ciudadanía</option>
         <option value="NIT">NIT</option>
         <option value="CE">Cédula de extranjería</option>
       </select>
     </div>
     <div class="campo">
       <label for="txtDocumento">Número de documento</label>
       <input id="txtDocumento" name="txtDocumento" type="text">
     </div>
     <button type="submit" name="btnGenerar">Generar certificado</button>
   </form>`,
);

/**
 * The answer depends on the document, and that is deliberate.
 *
 * A flow taught from a recording sees ONE answer, and the cheapest locator for
 * "read the state" is the state it happened to say that day. Such a step
 * resolves perfectly on the day it is taught and returns nothing the first time
 * the answer differs -- which is the difference between a procedure and a
 * souvenir, and it is invisible unless the errand is replayed with a different
 * input than the one demonstrated. So the harness always does.
 */
function certificadoResult(documento: string): string {
  const conAntecedentes = /[13579]$/.test(documento.trim());
  return CHROME(
    'Portal Único — Certificado generado',
    `<h1>Certificado generado</h1>
     <table>
       <tr><th>Documento</th><td>${documento}</td></tr>
       <tr><th>Estado</th><td id="estadoCertificado">${conAntecedentes ? 'CON ANTECEDENTES' : 'SIN ANTECEDENTES'}</td></tr>
       <tr><th>Número de certificado</th><td id="numeroCertificado">CA-2026-44817</td></tr>
     </table>
     <p><a href="/panel">Volver al panel</a></p>`,
  );
}

// ---------------------------------------------------------------------------
// Errand 2 — the long form
// ---------------------------------------------------------------------------

const CIUDADES: Record<string, string[]> = {
  Antioquia: ['Medellín', 'Envigado', 'Rionegro'],
  Cundinamarca: ['Bogotá D.C.', 'Chía', 'Zipaquirá'],
  'Valle del Cauca': ['Cali', 'Palmira', 'Buga'],
};

const NOVEDAD_FORM = CHROME(
  'Portal Único — Registro de novedad',
  `<h1>Registro de novedad</h1>
   <p>Todos los campos marcados son obligatorios.</p>
   <form method="POST" action="/novedad">
     <div class="campo"><label for="txtNombre">Nombre completo</label>
       <input id="txtNombre" name="txtNombre" type="text"></div>
     <div class="campo"><label for="txtDocumento">Número de documento</label>
       <input id="txtDocumento" name="txtDocumento" type="text"></div>
     <div class="campo"><label for="txtCorreo">Correo electrónico</label>
       <input id="txtCorreo" name="txtCorreo" type="text"></div>
     <div class="campo"><label for="txtTelefono">Teléfono de contacto</label>
       <input id="txtTelefono" name="txtTelefono" type="text"></div>
     <div class="campo"><label for="ddlDepartamento">Departamento</label>
       <select id="ddlDepartamento" name="ddlDepartamento">
         <option value="">Seleccione…</option>
         <option>Antioquia</option><option>Cundinamarca</option><option>Valle del Cauca</option>
       </select></div>
     <div class="campo"><label for="ddlCiudad">Ciudad</label>
       <select id="ddlCiudad" name="ddlCiudad" disabled>
         <option value="">Elija primero el departamento</option>
       </select></div>
     <div class="campo"><label for="ddlTipoNovedad">Tipo de novedad</label>
       <select id="ddlTipoNovedad" name="ddlTipoNovedad">
         <option value="">Seleccione…</option>
         <option>Cambio de dirección</option>
         <option>Cambio de representante legal</option>
         <option>Cierre de establecimiento</option>
       </select></div>
     <div class="campo"><label for="txtDescripcion">Descripción de la novedad</label>
       <textarea id="txtDescripcion" name="txtDescripcion" rows="3"></textarea></div>
     <div class="campo">
       <label for="chkAutorizo"><input id="chkAutorizo" name="chkAutorizo" type="checkbox">
         Autorizo el tratamiento de mis datos personales</label></div>
     <button type="submit" name="btnRadicar">Radicar novedad</button>
   </form>
   <script>
    // The dependent dropdown: Ciudad stays disabled and empty until a
    // Departamento is chosen. A flow that fills them in the wrong order does not
    // fail to FIND anything -- it fails validation three steps later, which is
    // the failure mode this errand exists to produce.
    const CIUDADES = ${JSON.stringify(CIUDADES)};
    document.getElementById('ddlDepartamento').addEventListener('change', (e) => {
      const ciudad = document.getElementById('ddlCiudad');
      const lista = CIUDADES[e.target.value] || [];
      ciudad.innerHTML = '<option value="">Seleccione…</option>' +
        lista.map((c) => '<option>' + c + '</option>').join('');
      ciudad.disabled = lista.length === 0;
    });
   </script>`,
);

function novedadResult(body: URLSearchParams): string {
  const faltantes: string[] = [];
  for (const [field, label] of [
    ['txtNombre', 'Nombre completo'],
    ['txtDocumento', 'Número de documento'],
    ['txtCorreo', 'Correo electrónico'],
    ['txtTelefono', 'Teléfono de contacto'],
    ['ddlDepartamento', 'Departamento'],
    ['ddlCiudad', 'Ciudad'],
    ['ddlTipoNovedad', 'Tipo de novedad'],
    ['txtDescripcion', 'Descripción de la novedad'],
  ] as const) {
    if (!(body.get(field) ?? '').trim()) faltantes.push(label);
  }
  if (!body.get('chkAutorizo')) faltantes.push('la autorización de tratamiento de datos');

  if (faltantes.length > 0) {
    return CHROME(
      'Portal Único — Registro de novedad',
      `<h1>Registro de novedad</h1>
       <div class="aviso" role="alert">Campos obligatorios sin diligenciar: ${faltantes.join(', ')}.</div>
       <p><a href="/novedad">Volver al formulario</a></p>`,
    );
  }
  return CHROME(
    'Portal Único — Novedad radicada',
    `<h1>Novedad radicada</h1>
     <table>
       <tr><th>Número de radicado</th><td id="numeroRadicado">NV-2026-00742</td></tr>
       <tr><th>Ciudad</th><td>${body.get('ddlCiudad')}</td></tr>
       <tr><th>Estado</th><td id="estadoRadicado">EN TRÁMITE</td></tr>
     </table>`,
  );
}

// ---------------------------------------------------------------------------
// Errand 3 — the results table
// ---------------------------------------------------------------------------

const FACTURAS = [
  { numero: 'F-00298', fecha: '2026-02-11', valor: '$ 2.140.000', estado: 'PAGADA' },
  { numero: 'F-00305', fecha: '2026-03-02', valor: '$ 880.500', estado: 'PAGADA' },
  { numero: 'F-00312', fecha: '2026-03-27', valor: '$ 1.284.500', estado: 'EN MORA' },
  { numero: 'F-00318', fecha: '2026-04-15', valor: '$ 465.000', estado: 'PAGADA' },
  { numero: 'F-00327', fecha: '2026-05-08', valor: '$ 3.010.900', estado: 'PENDIENTE' },
];

const BUSQUEDA_FORM = CHROME(
  'Portal Único — Consulta de facturación',
  `<h1>Consulta de facturación</h1>
   <form method="POST" action="/facturas">
     <div class="campo">
       <label for="txtNit">Número de NIT</label>
       <input id="txtNit" name="txtNit" type="text" placeholder="Sin dígito de verificación">
     </div>
     <button type="submit" name="btnBuscar">Buscar</button>
   </form>`,
);

function facturasResult(nit: string): string {
  if (!/^\d{6,}$/.test(nit.trim())) {
    return CHROME(
      'Portal Único — Consulta de facturación',
      `<h1>Consulta de facturación</h1>
       <div class="aviso" role="alert">No se encontraron facturas para el NIT consultado.</div>
       <p><a href="/facturas">Volver a consultar</a></p>`,
    );
  }
  const rows = FACTURAS.map(
    (f) => `<tr>
       <td>${f.numero}</td><td>${f.fecha}</td><td>${f.valor}</td><td>${f.estado}</td>
       <td><a href="/facturas/${f.numero}" aria-label="Ver detalle de la factura ${f.numero}">Ver detalle</a></td>
     </tr>`,
  ).join('');
  return CHROME(
    'Portal Único — Facturas encontradas',
    `<h1>Facturas encontradas</h1>
     <p>NIT ${nit.trim()} · ${FACTURAS.length} facturas</p>
     <table id="tablaFacturas">
       <thead><tr><th>Factura</th><th>Fecha</th><th>Valor</th><th>Estado</th><th></th></tr></thead>
       <tbody>${rows}</tbody>
     </table>`,
  );
}

function facturaDetail(numero: string): string | null {
  const found = FACTURAS.find((f) => f.numero === numero);
  if (!found) return null;
  return CHROME(
    `Portal Único — Factura ${found.numero}`,
    `<h1>Detalle de la factura ${found.numero}</h1>
     <table>
       <tr><th>Fecha de expedición</th><td>${found.fecha}</td></tr>
       <tr><th>Valor total</th><td id="valorFactura">${found.valor}</td></tr>
       <tr><th>Estado de cartera</th><td id="estadoFactura">${found.estado}</td></tr>
       <tr><th>Días de mora</th><td id="diasMora">${found.estado === 'EN MORA' ? '43' : '0'}</td></tr>
     </table>
     <p><a href="/facturas">Volver a la consulta</a></p>`,
  );
}

// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CasePortal {
  url: string;
  close(): Promise<void>;
}

export async function startCasePortal(): Promise<CasePortal> {
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    await sleep(THINK_MS);

    const cookies = req.headers.cookie ?? '';
    const signedIn = cookies.includes(`${SESSION_COOKIE}=si`);

    const html = (body: string, headers: Record<string, string> = {}) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };

    let body = new URLSearchParams();
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    }

    // --- login -------------------------------------------------------------
    if (path === '/entrar') {
      if (req.method === 'POST') {
        const user = (body.get('txtUsuario') ?? '').trim();
        const pass = body.get('txtClave') ?? '';
        if (user === GOOD_USER && pass === GOOD_PASSWORD) {
          res.writeHead(302, {
            location: '/panel',
            'set-cookie': `${SESSION_COOKIE}=si; Path=/`,
          });
          res.end();
          return;
        }
        html(loginPage('Usuario o contraseña incorrectos.'));
        return;
      }
      html(loginPage(''));
      return;
    }

    // Everything under /panel needs the session. This is the whole point of the
    // first errand: a replay from a clean browser lands here.
    if (path.startsWith('/panel')) {
      if (!signedIn) {
        html(loginPage('Debe iniciar sesión para continuar.'));
        return;
      }
      if (path === '/panel/certificado') {
        if (req.method === 'POST') {
          const documento = (body.get('txtDocumento') ?? '').trim();
          const tipo = body.get('ddlTipoDoc') ?? '';
          if (!documento || !tipo) {
            html(
              CHROME(
                'Portal Único — Certificado de antecedentes',
                `<h1>Certificado de antecedentes</h1>
                 <div class="aviso" role="alert">Debe ingresar el tipo y el número de documento.</div>
                 <p><a href="/panel/certificado">Volver</a></p>`,
              ),
            );
            return;
          }
          html(certificadoResult(documento));
          return;
        }
        html(CERTIFICADO_FORM);
        return;
      }
      html(PANEL);
      return;
    }

    // --- the long form -----------------------------------------------------
    if (path === '/novedad') {
      html(req.method === 'POST' ? novedadResult(body) : NOVEDAD_FORM);
      return;
    }

    // --- the results table -------------------------------------------------
    if (path === '/facturas') {
      html(req.method === 'POST' ? facturasResult(body.get('txtNit') ?? '') : BUSQUEDA_FORM);
      return;
    }
    const detail = /^\/facturas\/(F-\d+)$/.exec(path);
    if (detail?.[1]) {
      const page = facturaDetail(detail[1]);
      if (page) {
        html(page);
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(CHROME('Portal Único — No encontrado', '<h1>Página no encontrada</h1>'));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export const PORTAL_CREDENTIAL = { usuario: GOOD_USER, clave: GOOD_PASSWORD };
