/**
 * Stacked L1 fee bars for the "Historical onchain metrics" card.
 *
 * The bar heights come from a seeded LCG rather than Math.random so the markup is
 * deterministic — the server and the client produce byte-identical output, which keeps
 * this a Server Component with no hydration mismatch and no client JS.
 */
const COLORS = ["#22c55e", "#4f46e5", "#6d28d9", "#e879f9", "#e7e5e4"];
const BAR_COUNT = 92;
const GRIDLINES = 5;

function buildBars() {
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  return Array.from({ length: BAR_COUNT }, (_, b) => {
    const t = b / BAR_COUNT;
    const segments = [
      58 + t * 10 + (rnd() - 0.5) * 12,
      2 + rnd() * 4,
      4 + rnd() * 8 * (0.4 + t),
      2 + rnd() * 5 * (0.4 + t),
      1 + rnd() * 4,
    ];
    const total = segments.reduce((a, c) => a + c, 0);
    const scale = Math.min(total, 96) / total;
    // stacked top-down so the tallest series (Tron) ends up at the bottom
    return segments.map((h) => h * scale).reverse();
  });
}

const BARS = buildBars();

export default function FeeChart() {
  return (
    <div className="chart-plot">
      {Array.from({ length: GRIDLINES }, (_, i) => (
        <div key={`gl-${i}`} className="gl" style={{ bottom: `${i * 25}%` }} />
      ))}
      {BARS.map((segments, b) => (
        <div key={`bar-${b}`} className="cbar">
          {segments.map((height, k) => (
            <span
              key={`seg-${k}`}
              style={{ height: `${height}%`, background: COLORS[COLORS.length - 1 - k] }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
