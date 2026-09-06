import type { ReadinessStep } from '@/lib/management/readiness';
import { ArrowUpRight, Check, CircleHelp, Mic, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
export function CompanyLaunch({
  name,
  steps,
  isAdmin,
}: { name: string; steps: ReadinessStep[]; isAdmin: boolean }) {
  const ready = steps.filter((s) => s.state === 'ready').length;
  return (
    <section className="company-launch" aria-label="Configurar mi empresa">
      <div className="company-launch__intro">
        <div>
          <h2>Tu empresa, bien entendida.</h2>
          <p>
            Construyamos el encargo de Cortex para {name}. Cada paso se conecta con el trabajo que
            ya tienes.
          </p>
        </div>
        <Link className="company-launch__start" href="/onboarding/entrevista">
          <Mic size={18} /> Contarle cómo trabajamos <ArrowUpRight size={16} />
        </Link>
      </div>
      <div className="company-launch__progress">
        <span>
          {ready} de {steps.length} bases preparadas
        </span>
        <progress aria-label="Bases preparadas" value={ready} max={steps.length} />
        <span>Se comprueba con tus datos</span>
      </div>
      <ol className="company-launch__steps">
        {steps.map((step, index) => (
          <li key={step.id} data-state={step.state}>
            <span className="company-launch__number">
              {step.state === 'ready' ? (
                <Check size={18} />
              ) : step.state === 'unknown' ? (
                <CircleHelp size={18} />
              ) : (
                index + 1
              )}
            </span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.detail}</p>
              <span className="company-launch__status">
                {step.state === 'ready'
                  ? 'Preparado'
                  : step.state === 'unknown'
                    ? 'No se pudo comprobar'
                    : 'Por preparar'}
              </span>
            </div>
            <Link
              href={step.href}
              aria-label={`${step.state === 'ready' ? 'Revisar' : 'Preparar'}: ${step.title}`}
            >
              <ArrowUpRight size={20} />
            </Link>
          </li>
        ))}
      </ol>
      <div className="company-launch__footer">
        <ShieldCheck size={20} />
        <p>
          <strong>Define cómo puede actuar.</strong> Los permisos se revisan por separado. Preparar
          el contexto no autoriza envíos ni pagos.
        </p>
        <Link href={isAdmin ? '/admin/mandates' : '/approvals'}>
          {isAdmin ? 'Revisar autonomía' : 'Ver aprobaciones'}
        </Link>
      </div>
      <nav className="company-launch__links" aria-label="Continuar configuración">
        <Link href="/company">Ficha de empresa</Link>
        <Link href="/integrations">Conectar herramientas</Link>
        <Link href="/kb">Conocimiento permanente</Link>
        <Link href="/schedules">Rutinas activas</Link>
        <Link href="/management">Abrir agenda de gerencia</Link>
      </nav>
    </section>
  );
}
