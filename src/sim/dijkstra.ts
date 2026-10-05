import { edgeCost, vanCanPass, type CostContext, type Profile } from './cost';
import type { IndexedGraph } from './graph';

export interface ShortestPaths {
  /** Cost from node to the nearest source (for a reverse search: from node to the target set). */
  dist: Float64Array;
  /** Next node towards the sources, -1 at a source or if unreachable. */
  next: Int32Array;
  nextEdge: Int32Array;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() { return this.keys.length; }
  push(key: number, val: number) {
    const k = this.keys, v = this.vals;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.keys, v = this.vals;
    const topK = k[0], topV = v[0];
    const lastK = k.pop()!, lastV = v.pop()!;
    if (k.length > 0) {
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r] < k[l] ? r : l;
        if (k[c] >= lastK) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lastK; v[i] = lastV;
    }
    return [topK, topV];
  }
}

/**
 * Multi-source Dijkstra that answers "cost from every node to the source set".
 * Walking is symmetric. For vans it searches backwards, so one-way streets are respected in the driving direction.
 */
export function shortestPathsTo(g: IndexedGraph, sources: number[], profile: Profile, ctx: CostContext,
                                opts: { maxCost?: number; sourceCost?: number[] } = {}): ShortestPaths {
  const maxCost = opts.maxCost ?? Infinity;
  const dist = new Float64Array(g.n).fill(Infinity);
  const next = new Int32Array(g.n).fill(-1);
  const nextEdge = new Int32Array(g.n).fill(-1);
  const heap = new MinHeap();
  sources.forEach((s, i) => {
    const c0 = opts.sourceCost?.[i] ?? 0;
    if (s < 0 || c0 >= dist[s]) return;
    dist[s] = c0;
    heap.push(c0, s);
  });
  const nodes = g.graph.nodes;
  while (heap.size > 0) {
    const [d, v] = heap.pop();
    if (d > dist[v] || d > maxCost) continue;
    for (let k = g.adjStart[v]; k < g.adjStart[v + 1]; k++) {
      const u = g.adjNode[k];
      // We extend the path backwards: the traveller moves u → v, which follows a → b when v→u does not.
      const travelForward = g.adjForward[k] === 0;
      const c = edgeCost(g.edges[g.adjEdge[k]], g.adjEdge[k], travelForward, profile, ctx);
      if (c === Infinity) continue;
      if (profile === 'van' && !vanCanPass(nodes[u], ctx)) continue;
      const nd = d + c;
      if (nd < dist[u]) {
        dist[u] = nd;
        next[u] = v;
        nextEdge[u] = g.adjEdge[k];
        heap.push(nd, u);
      }
    }
  }
  return { dist, next, nextEdge };
}

/** Node and edge sequence from `start` to the nearest source. Empty if unreachable. */
export function pathFrom(sp: ShortestPaths, start: number): { nodes: number[]; edges: number[] } {
  if (start < 0 || sp.dist[start] === Infinity) return { nodes: [], edges: [] };
  const nodes = [start];
  const edges: number[] = [];
  let v = start;
  while (sp.next[v] >= 0) {
    edges.push(sp.nextEdge[v]);
    v = sp.next[v];
    nodes.push(v);
  }
  return { nodes, edges };
}
