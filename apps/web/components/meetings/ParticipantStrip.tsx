import { type MeetingParticipant, speakerInitials, speakerTone } from './speakers';

export function ParticipantStrip({ people }: { people: MeetingParticipant[] }) {
  if (people.length === 0) {
    return <p className="text-xs text-ink-faint">Todavía no veo a nadie en la sala.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {people.map((p) => {
        const tone = speakerTone(p.name);
        return (
          <li
            key={p.id}
            className={`inline-flex items-center gap-1.5 rounded-pill px-2 py-1 text-xs font-medium ${tone.chip} ${
              p.speaking ? 'ring-2 ring-emerald/50' : ''
            }`}
            title={p.speaking ? `${p.name} está hablando` : p.name}
          >
            <span className="grid h-5 w-5 place-items-center rounded-full bg-surface/70 text-[10px] font-bold">
              {speakerInitials(p.name)}
            </span>
            <span className="max-w-[9rem] truncate">{p.self ? `${p.name} · bot` : p.name}</span>
            {p.speaking ? (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
