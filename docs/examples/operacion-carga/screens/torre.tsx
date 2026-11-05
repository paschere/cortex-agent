import { useMemo, useState } from 'react';
import { MapContainer, TileLayer, Circle, Polygon, CircleMarker, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useLocations, useQuery, cortex } from '@cortex/app-sdk';
import { Plane, Users, AlertTriangle, Clock, MapPin, RefreshCw } from 'lucide-react';
import { hoyBogota, minutosHasta, minutosDesde, textoMinutos, texto } from '../lib/tiempo';
import '../lib/tema.css';
import '../lib/torre.css';

/**
 * TORRE DE CONTROL — Operación de carga en El Dorado.
 * Una sola pantalla para el supervisor: el mapa con las zonas y los operarios en vivo,
 * los vuelos de hoy por llegar (ETA y posición), las atenciones abiertas y lo crítico.
 * Todo se lee con el rol de quien mira; nada se escribe desde aquí.
 */

const EL_DORADO: [number, number] = [4.7016, -74.1469];
const CADA = 30_000;

type Geo = { id: string; name: string; lat: number; lng: number; radiusM: number; polygon?: [number, number][] };

export default function Torre() {
  const hoy = hoyBogota();
  const vuelos = useQuery('vuelos', { where: { fecha: hoy }, limit: 200 }, { refreshMs: CADA });
  const enAtencion = useQuery('atenciones', { where: { estado: 'En atención' }, limit: 100 }, { refreshMs: CADA });
  const porAprobar = useQuery('atenciones', { where: { estado: 'Por aprobar' }, limit: 100 }, { refreshMs: CADA });
  const eventos = useQuery('eventos_operacion', { where: { estado: 'Abierto' }, limit: 100 }, { refreshMs: CADA });
  const gente = useLocations({ refreshMs: 15_000 });
  const [zonas, setZonas] = useState<Geo[] | null>(null);
  if (zonas === null) {
    setZonas([]);
    cortex.geofences.list().then((z) => setZonas(z as unknown as Geo[])).catch(() => setZonas([]));
  }

  const proximos = useMemo(() => {
    return vuelos.rows
      .map((r) => {
        const v = r.values;
        const hora = texto(v.hora_estimada_actual) || texto(v.hora_estimada);
        return {
          id: r.id,
          numero: texto(v.numero_vuelo) || r.label,
          aerolinea: texto(v.aerolinea),
          origen: texto(v.origen),
          estado: texto(v.estado),
          posicion: texto(v.posicion),
          hora,
          min: minutosHasta(texto(v.fecha), hora),
          kilos: Number(v.kilos_esperados) || 0,
          atendido: texto(v.atendido_por),
        };
      })
      .sort((a, b) => (a.min ?? 1e9) - (b.min ?? 1e9));
  }, [vuelos.rows]);

  const criticos = eventos.rows.filter((r) => texto(r.values.critico));
  const fueraZona = enAtencion.rows.filter((r) => texto(r.values.fuera_de_zona) === 'Sí');
  const cargando = vuelos.loading && !vuelos.rows.length;

  const refrescar = () => {
    void vuelos.refresh();
    void enAtencion.refresh();
    void porAprobar.refresh();
    void eventos.refresh();
    void gente.refresh();
  };

  return (
    <div className="oc torre">
      <header className="torre-head">
        <div>
          <h1>Torre de control</h1>
          <p>El Dorado · {hoy}</p>
        </div>
        <button className="btn" onClick={refrescar} aria-label="Actualizar">
          <RefreshCw size={16} /> Actualizar
        </button>
      </header>

      <section className="kpis">
        <Kpi icon={<Plane size={18} />} label="Vuelos hoy" value={proximos.length} />
        <Kpi
          icon={<Clock size={18} />}
          label="Llegan en 1 h"
          value={proximos.filter((v) => v.min !== null && v.min >= 0 && v.min <= 60).length}
        />
        <Kpi icon={<Users size={18} />} label="En atención" value={enAtencion.rows.length} />
        <Kpi label="Por aprobar" value={porAprobar.rows.length} tone={porAprobar.rows.length ? 'amber' : undefined} />
        <Kpi
          icon={<AlertTriangle size={18} />}
          label="Críticos abiertos"
          value={criticos.length}
          tone={criticos.length ? 'red' : undefined}
        />
      </section>

      <div className="grid">
        <section className="card mapa">
          <h2>
            <MapPin size={16} /> Operarios y zonas
          </h2>
          <MapContainer center={EL_DORADO} zoom={15} scrollWheelZoom className="map">
            <TileLayer
              attribution="Esri, HERE, Garmin, &copy; OpenStreetMap"
              url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
              maxNativeZoom={16}
            />
            {(zonas ?? []).map((z) =>
              z.polygon?.length ? (
                <Polygon key={z.id} positions={z.polygon} pathOptions={{ color: '#12365f', weight: 2, fillOpacity: 0.08 }}>
                  <Tooltip>{z.name}</Tooltip>
                </Polygon>
              ) : (
                <Circle key={z.id} center={[z.lat, z.lng]} radius={z.radiusM} pathOptions={{ color: '#12365f', weight: 2, fillOpacity: 0.08 }}>
                  <Tooltip>{z.name}</Tooltip>
                </Circle>
              ),
            )}
            {gente.locations.map((p) => (
              <CircleMarker
                key={p.userId}
                center={[p.lat, p.lng]}
                radius={8}
                pathOptions={{
                  color: '#fff',
                  weight: 2,
                  fillColor: (p as { stale?: boolean }).stale ? '#a39b86' : '#2f6b3e',
                  fillOpacity: 1,
                }}
              >
                <Tooltip>
                  {p.name}
                  {(p as { place?: string }).place ? ` · ${(p as { place?: string }).place}` : ''}
                </Tooltip>
              </CircleMarker>
            ))}
          </MapContainer>
          {gente.error && <p className="muted">{gente.error}</p>}
          {!gente.error && !gente.locations.length && (
            <p className="muted">Nadie compartiendo ubicación ahora.</p>
          )}
        </section>

        <section className="card">
          <h2>
            <Plane size={16} /> Vuelos de hoy
          </h2>
          {cargando && <p className="muted">Cargando…</p>}
          {vuelos.error && <p className="error">{vuelos.error}</p>}
          {!cargando && !proximos.length && <p className="muted">No hay vuelos registrados para hoy.</p>}
          <ul className="list">
            {proximos.map((v) => (
              <li
                key={v.id}
                className={v.min !== null && v.min >= 0 && v.min <= 15 ? 'row hot' : 'row'}
              >
                <div className="row-main">
                  <strong>{v.numero}</strong>
                  <span className="muted">
                    {[v.aerolinea, v.origen].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <div className="row-side">
                  <span className="eta">{v.hora || '—'}</span>
                  <span className="muted">{textoMinutos(v.min)}</span>
                </div>
                <div className="tags">
                  {v.estado && <span className="tag">{v.estado}</span>}
                  {v.posicion ? <span className="tag blue">Posición {v.posicion}</span> : <span className="tag amber">Sin posición</span>}
                  {v.kilos > 0 && <span className="tag">{v.kilos.toLocaleString('es-CO')} kg</span>}
                  {v.atendido && <span className="tag green">{v.atendido}</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2>
            <Users size={16} /> Atenciones abiertas
          </h2>
          {!enAtencion.rows.length && !porAprobar.rows.length && <p className="muted">Ninguna abierta.</p>}
          <ul className="list">
            {[...enAtencion.rows, ...porAprobar.rows].map((r) => {
              const v = r.values;
              const desde = minutosDesde(texto(v.hora_inicio));
              return (
                <li key={r.id} className="row">
                  <div className="row-main">
                    <strong>{texto(v.vuelo) || r.label}</strong>
                    <span className="muted">{texto(v.operario)}</span>
                  </div>
                  <div className="row-side">
                    <span className="tag">{texto(v.estado)}</span>
                    {desde !== null && desde >= 0 && <span className="muted">{desde} min</span>}
                  </div>
                  <div className="tags">
                    {texto(v.fuera_de_zona) === 'Sí' && <span className="tag red">Fuera de zona</span>}
                    {texto(v.fuera_de_margen) && <span className="tag amber">{texto(v.fuera_de_margen)}</span>}
                    {texto(v.nota_correccion) && <span className="tag amber">Corrección pedida</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card">
          <h2>
            <AlertTriangle size={16} /> Alertas
          </h2>
          {!criticos.length && !fueraZona.length && <p className="muted">Sin alertas.</p>}
          <ul className="list">
            {criticos.map((r) => (
              <li key={r.id} className="row alert">
                <div className="row-main">
                  <strong>{texto(r.values.tipo)}</strong>
                  <span>{texto(r.values.descripcion)}</span>
                </div>
                <div className="row-side">
                  <span className="muted">{texto(r.values.hora)}</span>
                  <span className="muted">{texto(r.values.operario)}</span>
                </div>
              </li>
            ))}
            {fueraZona.map((r) => (
              <li key={`z-${r.id}`} className="row alert">
                <div className="row-main">
                  <strong>Atención fuera de zona</strong>
                  <span>
                    {texto(r.values.vuelo)} · {texto(r.values.operario)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, tone }: { icon?: React.ReactNode; label: string; value: number; tone?: 'amber' | 'red' }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <span className="kpi-label">
        {icon}
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}
