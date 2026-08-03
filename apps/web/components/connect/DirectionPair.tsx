import { clsx } from 'clsx';
import { ArrowDownLeft, ArrowRight, ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

/**
 * The two connection pages point in OPPOSITE directions and users kept reading
 * them as duplicates. This strip states the direction on both pages and links
 * across, so the pair is legible from either side.
 */
type Direction = 'outbound' | 'inbound';

interface Card {
  href: string;
  icon: typeof ArrowUpRight;
  title: string;
  body: string;
  cta: string;
}

const CARDS: Record<Direction, Card> = {
  outbound: {
    href: '/integrations',
    icon: ArrowUpRight,
    title: 'Cortex → your systems',
    body: 'What Cortex is connected to: Google Workspace, HubSpot, Workable, the talent pool, payroll — plus any extra MCP server you plug in.',
    cta: 'Integrations',
  },
  inbound: {
    href: '/mcp-tokens',
    icon: ArrowDownLeft,
    title: 'Your AI client → Cortex',
    body: 'The reverse: reach Cortex from Claude, Claude Code, ChatGPT or any MCP client, running with your own permissions.',
    cta: 'Connect Claude',
  },
};

const ORDER: Direction[] = ['outbound', 'inbound'];

function CardBody({ card, active }: { card: Card; active: boolean }) {
  const Icon = card.icon;
  return (
    <>
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'grid h-7 w-7 shrink-0 place-items-center rounded-[9px]',
            active ? 'bg-primary text-white' : 'bg-surface-2 text-ink-faint',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className={clsx('text-[13px] font-bold', active ? 'text-primary-ink' : 'text-ink')}>
          {card.title}
        </span>
        {active ? (
          <span className="ml-auto rounded-pill bg-primary-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
            You are here
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] font-semibold text-primary">
            {card.cta}
            <ArrowRight className="h-3 w-3" />
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-ink-muted">{card.body}</p>
    </>
  );
}

export function DirectionPair({ active }: { active: Direction }) {
  return (
    <div className="mb-5 grid gap-3 sm:grid-cols-2">
      {ORDER.map((dir) => {
        const card = CARDS[dir];
        const isActive = dir === active;
        return isActive ? (
          <div
            key={dir}
            className="rounded-card border border-primary/30 bg-primary-soft/40 p-3.5 shadow-card"
          >
            <CardBody card={card} active />
          </div>
        ) : (
          <Link
            key={dir}
            href={card.href}
            className="rounded-card border border-border bg-surface p-3.5 shadow-card transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-pop"
          >
            <CardBody card={card} active={false} />
          </Link>
        );
      })}
    </div>
  );
}
