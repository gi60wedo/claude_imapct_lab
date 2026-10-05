import { PolygonLayer } from '@deck.gl/layers';
import type { Candidate } from '../../../contracts';
import { REJECTED, UNRANKED, rankColor, type RankInfo } from '../rank';

export const CANDIDATES_LAYER_ID = 'candidates';

/** Candidate sites coloured by MarketScore rank; only the colour accessors update on weight changes. */
export const candidatesLayer = (data: Candidate[], ranks: Map<string, RankInfo>, selectedId: string | null) =>
  new PolygonLayer<Candidate>({
    id: CANDIDATES_LAYER_ID,
    data,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 60],
    stroked: true,
    filled: true,
    lineWidthUnits: 'pixels',
    getPolygon: (c) => c.polygon,
    getFillColor: (c) => {
      if (!c.passedFilter) return REJECTED;
      const r = ranks.get(c.id);
      return r ? rankColor(r) : UNRANKED;
    },
    getLineColor: (c) => (c.id === selectedId ? [255, 255, 255, 255] : [15, 23, 42, 180]),
    getLineWidth: (c) => (c.id === selectedId ? 4 : 1),
    updateTriggers: { getFillColor: [ranks], getLineColor: [selectedId], getLineWidth: [selectedId] },
  });
