import type { PersonaId, Weights } from '../../contracts';
import { resultKey, useStore } from '../state/store';

const CRITERIA: { key: keyof Weights; label: string }[] = [
  { key: 'accessibility', label: 'Accessibility' },
  { key: 'footfall', label: 'Footfall' },
  { key: 'fairness', label: 'Fairness' },
  { key: 'localBusiness', label: 'Local business' },
  { key: 'walkability', label: 'Walkability' },
];

const PERSONAS: { id: PersonaId; label: string; text: string }[] = [
  { id: 'senior', label: 'Senior', text: 'text-senior' },
  { id: 'vendor', label: 'Vendor', text: 'text-vendor' },
  { id: 'commuter', label: 'Commuter', text: 'text-commuter' },
  { id: 'retailer', label: 'Retailer', text: 'text-retailer' },
];

const fmt = (n: number) => n.toFixed(1);

export default function Compare() {
  const ids = useStore((s) => s.compareIds);
  const results = useStore((s) => s.results);
  const scenario = useStore((s) => s.scenario);
  const candidates = useStore((s) => s.candidates);

  if (ids.length !== 2) return null;
  const cols = ids.map((id) => ({
    id,
    name: candidates.find((c) => c.id === id)?.name ?? id,
    result: results[resultKey(id, scenario)],
  }));

  return (
    <div data-testid="compare" className="w-[420px] rounded-md border border-border bg-surface p-3 text-sm shadow-lg">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th />
            {cols.map((c) => (
              <th key={c.id} className="px-2 pb-2 text-right font-semibold">{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr><td colSpan={3} className="pt-1 text-[11px] uppercase text-muted">Criteria</td></tr>
          {CRITERIA.map((k) => (
            <tr key={k.key} className="border-t border-border">
              <td className="py-1 text-muted">{k.label}</td>
              {cols.map((c) => (
                <td key={c.id} data-testid={`cmp-${c.id}-${k.key}`} className="px-2 py-1 text-right tabular-nums">
                  {c.result ? fmt(c.result.criteria[k.key]) : '–'}
                </td>
              ))}
            </tr>
          ))}
          <tr><td colSpan={3} className="pt-2 text-[11px] uppercase text-muted">Personas</td></tr>
          {PERSONAS.map((p) => (
            <tr key={p.id} className="border-t border-border">
              <td className={`py-1 ${p.text}`}>{p.label}</td>
              {cols.map((c) => (
                <td key={c.id} data-testid={`cmp-${c.id}-${p.id}`} className="px-2 py-1 text-right tabular-nums">
                  {c.result ? fmt(c.result.personas[p.id].score) : '–'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
