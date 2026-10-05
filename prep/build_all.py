"""Runs the whole Part A prep pipeline in dependency order. From the repo root: npm run prep"""
import time

import approaches
import candidates
import graph
import imagery
import lod2
import population
import transit

STEPS = [lod2, graph, population, transit, imagery, candidates, approaches]  # each needs the ones before it

if __name__ == "__main__":
    t0 = time.time()
    for step in STEPS:
        t = time.time()
        step.main()
        print(f"  ({time.time() - t:.1f} s)\n")
    print(f"prep done in {time.time() - t0:.0f} s; now run `npm run rank:bake` (npm run prep does both)")
