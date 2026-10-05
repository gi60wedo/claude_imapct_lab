import { LocalProjection } from './geo';
import type { GraphEdge, SimGraph } from './world';

/** Graph with CSR adjacency and a grid index for snapping points to nodes. Built once per World. */
export class IndexedGraph {
  readonly n: number;
  readonly edges: GraphEdge[];
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** CSR adjacency: for node u, entries adjStart[u]..adjStart[u+1]-1 hold neighbour, edge index, and whether u→v follows a→b. */
  readonly adjStart: Int32Array;
  readonly adjNode: Int32Array;
  readonly adjEdge: Int32Array;
  readonly adjForward: Uint8Array;
  private readonly cell = 50;
  private readonly grid = new Map<number, number[]>();

  constructor(readonly graph: SimGraph, readonly proj: LocalProjection) {
    const { nodes, edges } = graph;
    this.n = nodes.length;
    this.edges = edges;
    this.x = new Float64Array(this.n);
    this.y = new Float64Array(this.n);
    nodes.forEach((p, i) => {
      const [x, y] = proj.toXY(p.lng, p.lat);
      this.x[i] = x;
      this.y[i] = y;
    });

    const degree = new Int32Array(this.n + 1);
    for (const e of edges) { degree[e.a]++; degree[e.b]++; }
    this.adjStart = new Int32Array(this.n + 1);
    for (let i = 0; i < this.n; i++) this.adjStart[i + 1] = this.adjStart[i] + degree[i];
    const fill = this.adjStart.slice(0, this.n);
    this.adjNode = new Int32Array(edges.length * 2);
    this.adjEdge = new Int32Array(edges.length * 2);
    this.adjForward = new Uint8Array(edges.length * 2);
    edges.forEach((e, k) => {
      let i = fill[e.a]++;
      this.adjNode[i] = e.b; this.adjEdge[i] = k; this.adjForward[i] = 1;
      i = fill[e.b]++;
      this.adjNode[i] = e.a; this.adjEdge[i] = k; this.adjForward[i] = 0;
    });

    for (let i = 0; i < this.n; i++) {
      if (degree[i] === 0) continue;
      const key = this.key(Math.floor(this.x[i] / this.cell), Math.floor(this.y[i] / this.cell));
      let bucket = this.grid.get(key);
      if (!bucket) this.grid.set(key, (bucket = []));
      bucket.push(i);
    }
  }

  private key(cx: number, cy: number) { return (cx + 10000) * 20000 + (cy + 10000); }

  /** Nodes within radius metres of (x, y). `accept` filters candidates, e.g. to nodes on walkable edges. */
  nodesWithin(x: number, y: number, radius: number, accept?: (i: number) => boolean): number[] {
    const out: number[] = [];
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (const i of this.grid.get(this.key(cx + dx, cy + dy)) ?? []) {
          if (Math.hypot(this.x[i] - x, this.y[i] - y) <= radius && (!accept || accept(i))) out.push(i);
        }
      }
    }
    return out;
  }

  /** Nearest accepted node, searching outward up to maxM metres. Returns -1 if none. */
  nearest(x: number, y: number, maxM = 400, accept?: (i: number) => boolean): number {
    for (let radius = 60; radius <= maxM * 2; radius *= 2) {
      let best = -1;
      let bestD = Infinity;
      for (const i of this.nodesWithin(x, y, Math.min(radius, maxM), accept)) {
        const d = Math.hypot(this.x[i] - x, this.y[i] - y);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0 || radius >= maxM) return best;
    }
    return -1;
  }

  hasEdge(i: number, accept: (e: GraphEdge) => boolean): boolean {
    for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) if (accept(this.edges[this.adjEdge[k]])) return true;
    return false;
  }
}
