declare global {
  interface Window { __fps?: number }
}

/** Measure animation frames over the last second. Disabled outside the perf harness. */
export function startFps(): () => void {
  if (new URLSearchParams(location.search).get('perf') !== '1') return () => {};
  const frames: number[] = [];
  const started = performance.now();
  let frame: number;
  const tick = (now: number) => {
    frames.push(now);
    while (frames.length > 1 && frames[1] <= now - 1000) frames.shift();
    if (now - started >= 1000) {
      const elapsed = now - frames[0];
      window.__fps = elapsed > 0 ? (frames.length - 1) * 1000 / elapsed : 0;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    delete window.__fps;
  };
}
