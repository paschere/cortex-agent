import { type Server, createServer } from 'node:http';

/**
 * A stand-in for a Colombian government portal, built to be slow and awkward in
 * the ways the real ones are.
 *
 * WHY A FIXTURE AND NOT THE REAL RUNT. Two reasons, and the second is the one
 * that matters. First, hammering a public government site to produce a
 * benchmark is rude and would get the runner's IP blocked. Second, and
 * decisively: a measurement against a live site measures the site. Its latency
 * varies by an order of magnitude between 8am and 3pm, which would swamp the
 * difference the benchmark exists to show and make every run incomparable to
 * every other.
 *
 * So the portal's own latency is FIXED here (`THINK_MS` per page), identical
 * for both sides of the comparison, and it cancels out. What is left is the
 * difference between the two approaches, which is the thing being measured.
 *
 * The shape is copied from the real ones on purpose: three pages, a form with
 * a `name` attribute a designer would never have chosen, a submit button whose
 * label is a verb, a result table. No API, no JSON, no test ids.
 */

/** What the portal takes to answer, per page. Identical for both approaches. */
const THINK_MS = 350;

const PLATES: Record<string, { estado: string; soat: string; rtm: string; marca: string }> = {
  ABC123: { estado: 'ACTIVO', soat: '2027-03-14', rtm: '2026-11-02', marca: 'CHEVROLET' },
  XYZ789: { estado: 'ACTIVO', soat: '2026-09-30', rtm: '2026-08-19', marca: 'RENAULT' },
  QQQ111: { estado: 'INACTIVO', soat: '2025-01-01', rtm: '2024-12-01', marca: 'MAZDA' },
};

const CHROME = (title: string, body: string) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;margin:0">
  <header style="background:#12395c;color:#fff;padding:14px 24px">
    <strong>Registro Único Nacional de Tránsito</strong>
  </header>
  <main style="padding:24px;max-width:720px">${body}</main>
  <footer style="padding:16px 24px;color:#667;font-size:12px">
    Ministerio de Transporte · Consulta ciudadana
  </footer>
</body></html>`;

const HOME = CHROME(
  'RUNT — Consulta ciudadana',
  `<h1>Consulta ciudadana</h1>
   <p>Seleccione el trámite que desea realizar.</p>
   <ul>
     <li><a href="/consulta">Consulta de vehículos por placa</a></li>
     <li><a href="/otro">Consulta de licencias de conducción</a></li>
   </ul>`,
);

const FORM = CHROME(
  'RUNT — Consulta de vehículos',
  `<h1>Consulta de vehículos</h1>
   <form method="POST" action="/resultado">
     <p>
       <label for="txtPlaca">Número de placa</label><br>
       <input id="txtPlaca" name="txtPlaca" type="text" maxlength="6" style="padding:6px">
     </p>
     <p>
       <label for="ddlTipo">Tipo de consulta</label><br>
       <select id="ddlTipo" name="ddlTipo" style="padding:6px">
         <option value="1">Información general</option>
         <option value="2">Historial de traspasos</option>
       </select>
     </p>
     <p><button type="submit" name="btnConsultar">Consultar</button></p>
   </form>`,
);

function resultPage(plate: string): string {
  const found = PLATES[plate.toUpperCase()];
  if (!found) {
    return CHROME(
      'RUNT — Consulta de vehículos',
      `<h1>Consulta de vehículos</h1>
       <div role="alert" style="background:#fdecea;border:1px solid #f5c2c0;padding:12px">
         No se encontró información para la placa consultada.
       </div>
       <p><a href="/consulta">Volver a consultar</a></p>`,
    );
  }
  return CHROME(
    'RUNT — Resultado de la consulta',
    `<h1>Resultado de la consulta</h1>
     <table border="1" cellpadding="6" style="border-collapse:collapse">
       <tr><th align="left">Placa</th><td>${plate.toUpperCase()}</td></tr>
       <tr><th align="left">Estado del vehículo</th><td id="estado">${found.estado}</td></tr>
       <tr><th align="left">Marca</th><td>${found.marca}</td></tr>
       <tr><th align="left">SOAT vigente hasta</th><td>${found.soat}</td></tr>
       <tr><th align="left">RTM vigente hasta</th><td>${found.rtm}</td></tr>
     </table>
     <p><a href="/consulta">Nueva consulta</a></p>`,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Portal {
  url: string;
  close(): Promise<void>;
  /**
   * Rename the submit button, as a portal would after a redesign. Used by the
   * repair half of the benchmark: the flow's stored locator stops matching and
   * everything else about the page stays put.
   */
  redesign(): void;
}

export async function startPortal(): Promise<Portal> {
  let buttonLabel = 'Consultar';

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    await sleep(THINK_MS);

    if (req.method === 'POST' && url.pathname === '/resultado') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(resultPage(body.get('txtPlaca') ?? ''));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === '/consulta') {
      res.end(FORM.replace('>Consultar<', `>${buttonLabel}<`));
      return;
    }
    res.end(HOME);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    redesign() {
      buttonLabel = 'Consultar placa';
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
