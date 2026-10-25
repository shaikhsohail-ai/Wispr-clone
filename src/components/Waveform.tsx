import { useEffect, useRef } from 'react';

interface Props {
  active: boolean;
  getLevel: () => number;
}

const BARS = 56;

/** Scrolling level meter drawn on a canvas; cheap enough to run on every animation frame. */
export function Waveform({ active, getLevel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<number[]>(new Array<number>(BARS).fill(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let frame = 0;
    let lastTick = 0;

    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      if (active && now - lastTick > 40) {
        lastTick = now;
        historyRef.current.push(getLevel());
        historyRef.current.shift();
      }
      const gap = 3;
      const barWidth = Math.max(2, (width - gap * (BARS - 1)) / BARS);
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, '#8b5cf6');
      gradient.addColorStop(1, '#22d3ee');
      ctx.fillStyle = active ? gradient : 'rgba(148, 163, 184, 0.25)';
      for (let i = 0; i < BARS; i++) {
        const level = active ? historyRef.current[i] : 0;
        const barHeight = Math.max(3, level * (height - 4));
        const x = i * (barWidth + gap);
        const y = (height - barHeight) / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, barWidth / 2);
        ctx.fill();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [active, getLevel]);

  useEffect(() => {
    if (!active) historyRef.current.fill(0);
  }, [active]);

  return <canvas ref={canvasRef} className={`waveform${active ? ' active' : ''}`} aria-hidden="true" />;
}
