'use client';

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';

/**
 * EL MAPA DE LEAFLET (sólo en el navegador: se carga con `next/dynamic` y sin
 * SSR desde MapBlock, porque Leaflet toca `window` al importarse).
 *
 * Teselas de OpenStreetMap con su atribución visible (la pide su licencia y la
 * dibuja el control de atribución de Leaflet). Los marcadores son `divIcon` con
 * el color por estado y las iniciales de la persona: no hay imágenes de íconos
 * que el empaquetador tenga que resolver, y el claro/oscuro lo resuelve CSS
 * (views.css, `.cx-map`).
 *
 * No sabe de permisos ni de datos: pinta lo que MapBlock le entrega, que ya
 * vino filtrado por el servidor.
 */

export interface MapPin {
  key: string;
  kind: 'record' | 'person';
  lat: number;
  lng: number;
  /** Color CSS del marcador (un tono del tema). */
  color: string;
  /** Iniciales de la persona; vacío en un registro. */
  initials?: string;
  /** Sin señal reciente: se pinta apagado. */
  dim?: boolean;
  selected?: boolean;
  label: string;
}

/** Bogotá, cuando no hay nada que mostrar todavía. */
const FALLBACK_CENTER: [number, number] = [4.711, -74.0721];

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function iconFor(pin: MapPin): L.DivIcon {
  const size = pin.kind === 'person' ? 34 : 26;
  const ring = pin.selected ? 'cx-pin--selected' : '';
  const dim = pin.dim ? 'cx-pin--dim' : '';
  const html =
    pin.kind === 'person'
      ? `<span class="cx-pin cx-pin--person ${ring} ${dim}" style="background:${pin.color}">${escapeHtml(pin.initials ?? '')}</span>`
      : `<span class="cx-pin cx-pin--record ${ring}" style="background:${pin.color}"></span>`;
  return L.divIcon({
    html,
    className: 'cx-pin-wrap',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function FitTo({ pins, fitKey }: { pins: MapPin[]; fitKey: number }) {
  const map = useMap();
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo se reencuadra cuando la persona lo pide o llegan los primeros puntos
  useEffect(() => {
    if (!pins.length) return;
    if (pins.length === 1) {
      const p = pins[0] as MapPin;
      map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15));
      return;
    }
    map.fitBounds(L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number])), {
      padding: [36, 36],
      maxZoom: 16,
    });
  }, [fitKey, map]);
  return null;
}

/** El mapa se ajusta al contenedor cuando éste cambia de tamaño (celular que gira, panel que se abre). */
function KeepSize() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

function Picker({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

export default function MapCanvas({
  pins,
  fitKey,
  picked,
  picking,
  onSelect,
  onPick,
}: {
  pins: MapPin[];
  /** Cambia cuando hay que reencuadrar («Centrar», los primeros puntos). */
  fitKey: number;
  /** El lugar elegido tocando el mapa (al asignar una tarea). */
  picked: { lat: number; lng: number } | null;
  picking: boolean;
  onSelect: (kind: 'record' | 'person', key: string) => void;
  onPick: (lat: number, lng: number) => void;
}) {
  const icons = useMemo(() => new Map(pins.map((p) => [p.key, iconFor(p)])), [pins]);
  const pickedIcon = useMemo(
    () =>
      L.divIcon({
        html: '<span class="cx-pin cx-pin--record cx-pin--selected" style="background:rgb(var(--primary))"></span>',
        className: 'cx-pin-wrap',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
    [],
  );
  return (
    <MapContainer
      center={FALLBACK_CENTER}
      zoom={11}
      scrollWheelZoom={false}
      className={`cx-map h-full w-full rounded-sm${picking ? ' cx-map--picking' : ''}`}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />
      <KeepSize />
      <FitTo pins={pins} fitKey={fitKey} />
      {picking && <Picker onPick={onPick} />}
      {pins.map((p) => (
        <Marker
          key={p.key}
          position={[p.lat, p.lng]}
          icon={icons.get(p.key) as L.DivIcon}
          title={p.label}
          keyboard
          eventHandlers={{ click: () => onSelect(p.kind, p.key) }}
        />
      ))}
      {picked && (
        <Marker position={[picked.lat, picked.lng]} icon={pickedIcon} interactive={false} />
      )}
    </MapContainer>
  );
}
