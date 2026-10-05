import type { PersonaId } from '../../contracts';
import type { ResolvedCaption } from './types';

export const personaTokens: Record<PersonaId, string> = {
  senior: 'border-senior text-senior',
  vendor: 'border-vendor text-vendor',
  commuter: 'border-commuter text-commuter',
  retailer: 'border-retailer text-retailer',
};

const names: Record<PersonaId, string> = {
  senior: 'Oma Helga', vendor: 'Markus', commuter: 'Lukas', retailer: 'Frau Weber',
};

// Discrete utility classes keep fades driven by scene time, without a CSS clock.
const opacityClasses = [
  'opacity-0', 'opacity-10', 'opacity-20', 'opacity-30', 'opacity-40',
  'opacity-50', 'opacity-60', 'opacity-70', 'opacity-80', 'opacity-90', 'opacity-100',
];

export function captionOpacity(opacity: number) {
  return opacityClasses[Math.round(Math.min(1, Math.max(0, opacity)) * 10)];
}

/** Preserve each resolved binding as a separate, auditable DOM element. */
export function CaptionText({ caption }: { caption: ResolvedCaption }) {
  return <>{caption.parts.map((part, index) => part.kind === 'binding'
    ? <span key={index} data-bind={part.path} data-format={part.format}>{part.text}</span>
    : <span key={index}>{part.text}</span>)}</>;
}

export interface PersonaChipProps {
  persona: PersonaId;
  captions: readonly ResolvedCaption[];
}

export function PersonaChip({ persona, captions }: PersonaChipProps) {
  if (!captions.length) return null;
  return (
    <section aria-label={names[persona]} data-persona={persona}
      className={`min-w-0 rounded-xl border-l-4 bg-surface/95 p-4 text-lg shadow-lg ${personaTokens[persona]}`}>
      <h2 className="mb-2 font-semibold">{names[persona]}</h2>
      {captions.map((caption) => (
        <p key={caption.id} data-caption-id={caption.id}
          className={`break-words ${captionOpacity(caption.opacity)} ${caption.slot === 'frictionChip'
            ? 'mt-2 rounded-lg border border-border bg-background/70 p-3 text-foreground'
            : 'text-2xl font-semibold tabular-nums'}`}>
          <CaptionText caption={caption} />
        </p>
      ))}
    </section>
  );
}

export default PersonaChip;
