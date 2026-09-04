export type MeetingParticipant = {
  id: string;
  name: string;
  speaking: boolean;
  self: boolean;
  presenting?: boolean;
};

const TONES = [
  { text: 'text-primary', chip: 'bg-primary-soft text-primary', bar: 'bg-primary' },
  { text: 'text-emerald', chip: 'bg-emerald-soft text-emerald', bar: 'bg-emerald' },
  { text: 'text-amber', chip: 'bg-amber-soft text-amber', bar: 'bg-amber' },
  { text: 'text-rose', chip: 'bg-rose-soft text-rose', bar: 'bg-rose' },
  { text: 'text-sky', chip: 'bg-sky-soft text-sky', bar: 'bg-sky' },
] as const;

export function speakerTone(name: string): (typeof TONES)[number] {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 33 + name.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length] ?? TONES[0];
}

export function speakerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase();
}
