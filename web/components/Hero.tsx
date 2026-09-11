"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/* ---- slide config: taken 1:1 from the source bundle ---- */
const SLIDES = [
  { word: "understand", image: "bank", accent: "#DD995D", cta: "Learn more about Explorer" },
  { word: "trust", image: "warehouse", accent: "#925BD6", cta: "Learn more about our data pipeline" },
  { word: "explore", image: "mountains", accent: "#61E7BF", cta: "Learn more about Explorer" },
  { word: "act on", image: "construction", accent: "#5291C1", cta: "Learn more about our API" },
] as const;

const DURATION = 6000;
const TICK = 50;
const CIRC = 116.23892818282235;

const IMAGES = ["bank", "warehouse", "mountains", "construction"] as const;

const PAUSE_PATH =
  "M216,48V208a16,16,0,0,1-16,16H160a16,16,0,0,1-16-16V48a16,16,0,0,1,16-16h40A16,16,0,0,1,216,48ZM96,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Z";
const PLAY_PATH =
  "M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27Z";

/** One illustration tile: a coloured plate with the four cross-fading image panes. */
function Tile({
  pos,
  accent,
  image,
  base = "tile",
  extra = "",
}: {
  pos: string;
  accent: string;
  image: string;
  base?: string;
  extra?: string;
}) {
  return (
    <div
      className={`${base} animate-blur-in ${pos}${extra ? ` ${extra}` : ""}`}
      style={{ backgroundColor: accent }}
    >
      {IMAGES.map((img) => (
        <div key={img} className={`pane p-${img}${img === image ? " on" : ""}`} />
      ))}
    </div>
  );
}

/* decorative hex stream on the "trust" card - seeded so SSR and the client agree */
const HEX_STREAM = (() => {
  const hex = "0123456789abcdef";
  let seed = 20240921;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  let out = "";
  for (let i = 0; i < 40; i++) {
    let line = "";
    for (let j = 0; j < 110; j++) line += hex[Math.floor(rnd() * 16)];
    out += line + "\n";
  }
  return out;
})();

/* stacked bars on the "explore" card */
const BAR_DATA = [
  [3, 2, 2], [5, 3, 2], [7, 5, 3], [10, 7, 3], [13, 9, 4],
  [17, 12, 5], [38, 26, 7], [40, 28, 7], [42, 29, 8], [44, 30, 8],
];

function Bars() {
  const totals = BAR_DATA.map((d) => d.reduce((a, b) => a + b, 0));
  const max = Math.max(...totals);
  return (
    <div className="bars">
      {BAR_DATA.map((d, i) => {
        const h = totals[i];
        return (
          <div key={i} className="bar" style={{ height: `${(h / max) * 100}%` }}>
            <i style={{ background: "#f472b6", height: `${(d[2] / h) * 100}%` }} />
            <i style={{ background: "#2563eb", height: `${(d[1] / h) * 100}%` }} />
            <i style={{ background: "#34d399", height: `${(d[0] / h) * 100}%` }} />
          </div>
        );
      })}
    </div>
  );
}

export default function Hero() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [widths, setWidths] = useState<number[]>([]);
  const [ready, setReady] = useState(false);

  const ringRef = useRef<SVGCircleElement | null>(null);
  const wordWindowRef = useRef<HTMLDivElement | null>(null);
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const elapsed = useRef(0);

  const { accent, image } = SLIDES[index];

  /* measure each word so the window can animate its width, like the original */
  const measure = useCallback(() => {
    const next = wordRefs.current.map((el) => {
      if (!el) return 0;
      const range = document.createRange();
      range.selectNodeContents(el);
      const ink = range.getBoundingClientRect().width;
      /* +16 of headroom: with -6px tracking the glyphs overhang the inline box,
         and the window is right-anchored, so a tight width shaves the first letter */
      return Math.ceil(Math.max(ink, el.getBoundingClientRect().width)) + 16;
    });
    setWidths((prev) =>
      prev.length === next.length && prev.every((w, i) => w === next[i]) ? prev : next,
    );
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, index]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    /* a ResizeObserver on the words is the only reliable trigger here: the webfont can
       swap in well after load, and a stale measurement shaves the leading glyph */
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
    wordRefs.current.forEach((el) => el && ro?.observe(el));
    document.fonts?.ready.then(() => {
      measure();
      requestAnimationFrame(() => setReady(true));
    });
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [measure]);

  const go = useCallback((n: number) => {
    setIndex((n + SLIDES.length) % SLIDES.length);
    elapsed.current = 0;
    ringRef.current?.setAttribute("stroke-dashoffset", String(CIRC));
  }, []);

  /* the ring is written straight to the DOM: it ticks 20x a second and re-rendering
     the whole hero at that rate would be pure waste */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!playing) return;
      elapsed.current += TICK;
      ringRef.current?.setAttribute(
        "stroke-dashoffset",
        String(CIRC * (1 - elapsed.current / DURATION)),
      );
      if (elapsed.current >= DURATION) {
        elapsed.current = 0;
        setIndex((i) => (i + 1) % SLIDES.length);
        ringRef.current?.setAttribute("stroke-dashoffset", String(CIRC));
      }
    }, TICK);
    return () => window.clearInterval(timer);
  }, [playing]);

  const togglePlaying = useCallback(() => setPlaying((p) => !p), []);

  /* keyboard controls, same as the original: arrows navigate, space toggles */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") go(index - 1);
      else if (e.key === "ArrowRight") go(index + 1);
      else if (e.key === " ") {
        e.preventDefault();
        togglePlaying();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, index, togglePlaying]);

  return (
    <>
      <div className="shell" style={{ position: "relative" }}>
        <div className="pause-wrap">
          <button
            className="pause-btn"
            onClick={togglePlaying}
            aria-label={playing ? "Pause" : "Play"}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
              <path d={playing ? PAUSE_PATH : PLAY_PATH} />
            </svg>
          </button>
          <div className="pause-ring-wrap">
            <svg className="pause-ring" width="100%" height="100%">
              <circle cx="19" cy="19" r="18.5" fill="none" stroke="rgba(255,255,255,.05)" strokeWidth="1" />
              <circle ref={ringRef} cx="19" cy="19" r="18.5" fill="none" stroke="#fff" strokeWidth="1" strokeDasharray="116.23892818282235" strokeDashoffset="116.23892818282235" strokeLinecap="round" />
            </svg>
          </div>
        </div>

        <div className="hero-grid">

          <div className="h-rule full r1"></div>
          <div className="h-rule left-seg"></div>
          <div className="h-rule right-seg"></div>
          <div className="h-rule full r6"></div>
          <div className="v-seg"></div>

          {/* row 1 */}
          <div className="a-blockchain">
            <div className="hero-heading animate-fade-in-up-quick" style={{ animationDelay: "0ms" }}>Blockchain</div>
            <Tile pos="pos-center" accent={accent} image={image} />
          </div>

          {/* row 2 left */}
          <div className="a-data">
            <div style={{ textAlign: "left" }}><div className="hero-heading animate-fade-in-up-quick" style={{ animationDelay: "100ms" }}>data</div></div>
            <div className="tile-wrap">
              <Tile pos="pos-center" accent={accent} image={image} />
            </div>
          </div>

          {/* right tall */}
          <div className="a-section2">
            <Tile pos="pos-topright" accent={accent} image={image} />
          </div>

          {/* left tall */}
          <div className="a-section4">
            <Tile pos="pos-bottomleft" accent={accent} image={image} />
          </div>

          {/* you can */}
          <div className="a-youcan">
            <Tile pos="pos-center" accent={accent} image={image} />
            <div style={{ textAlign: "right" }}><div className="hero-heading animate-fade-in-up-quick" style={{ animationDelay: "200ms" }}>you can</div></div>
          </div>

          {/* changing word */}
          <div className="a-changetext">
            <Tile pos="pos-center" accent={accent} image={image} />
            <div
              ref={wordWindowRef}
              className={`word-window animate-fade-in-up-quick${ready ? " ready" : ""}`}
              style={{ animationDelay: "250ms", width: widths[index] ? `${widths[index]}px` : undefined }}
            >
              <div className="word-track" style={{ top: `${15 - 90 * index}px` }}>
                <div className={`word-slot${index === 0 ? " on" : ""}`}><span className="hero-heading" ref={(el) => { wordRefs.current[0] = el; }}>understand</span></div>
                <div className={`word-slot${index === 1 ? " on" : ""}`}><span className="hero-heading" ref={(el) => { wordRefs.current[1] = el; }}>trust</span></div>
                <div className={`word-slot${index === 2 ? " on" : ""}`}><span className="hero-heading" ref={(el) => { wordRefs.current[2] = el; }}>explore</span></div>
                <div className={`word-slot${index === 3 ? " on" : ""}`}><span className="hero-heading" ref={(el) => { wordRefs.current[3] = el; }}>act on</span></div>
              </div>
            </div>
          </div>

          {/* featured card */}
          <div className="a-section3 animate-fade-in-up-quick" style={{ animationDelay: "150ms" }}>
            <div className="card-outer">
              <div className="card-clip">
                <Tile base="card-backdrop" pos="pos-card" accent={accent} image={image} extra={SLIDES[index].word === "trust" ? "hidden-backdrop" : ""} />

                {/* slide 0: understand -> financial statement */}
                <div className={`card-slide${index === 0 ? " on" : ""}`}>
                  <div className="surface fs-card">
                    <div className="fs-head">
                      <img src="/assets/ethereum.png" alt="Ethereum" />
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        <div className="t-lg">Financial Statement</div>
                        <div className="t-sm sec">Ethereum</div>
                      </div>
                    </div>
                    <div className="hr"></div>
                    <table className="fs">
                      <thead><tr>
                        <th><div>Income statement</div></th><th><div>Jul 2024</div></th>
                        <th><div>Aug 2024</div></th><th><div>Sep 2024</div></th><th><div>Oct 2024</div></th>
                      </tr></thead>
                      <tbody>
                        <tr><td><div>Fees</div></td><td><div className="mono">$94.64m</div></td><td><div className="mono">$62.82m</div></td><td><div className="mono">$62.82m</div></td><td><div className="mono">$103.72m</div></td></tr>
                        <tr><td><div>(Supply-side fees)</div></td><td><div className="mono">$38.30m</div></td><td><div className="mono">$27.96m</div></td><td><div className="mono">$27.96m</div></td><td><div className="mono">$35.51m</div></td></tr>
                        <tr><td><div>Revenue</div></td><td><div className="mono">$56.33m</div></td><td><div className="mono">$34.85m</div></td><td><div className="mono">$34.85m</div></td><td><div className="mono">$68.22m</div></td></tr>
                        <tr><td><div>(Expenses)</div></td><td><div className="mono">$265.95m</div></td><td><div className="mono">$217.14m</div></td><td><div className="mono">$217.14m</div></td><td><div className="mono">$197.39m</div></td></tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* slide 1: trust -> data pipeline */}
                <div className={`card-slide full${index === 1 ? " on" : ""}`}>
                  <div className="tr-card">
                    <div className="hexes mono">{HEX_STREAM}</div>
                    <div className="line" style={{ left: "322px", top: "114px", width: "34px" }}></div>
                    <div className="line" style={{ left: "322px", top: "154px", width: "84px" }}></div>
                    <div className="tr-logo">TT_</div>
                    <div className="pill" style={{ left: "352px", top: "104px" }}>Expenses</div>
                    <div className="pill mono" style={{ left: "441px", top: "104px" }}>Active users</div>
                    <div className="pill" style={{ left: "402px", top: "144px" }}>Revenue</div>
                    <div className="pill mono" style={{ left: "481px", top: "144px" }}>TVL</div>
                  </div>
                </div>

                {/* slide 2: explore -> asset management */}
                <div className={`card-slide${index === 2 ? " on" : ""}`}>
                  <div className="surface am-card">
                    <div className="am-head">
                      <div>
                        <div className="t-lg">Asset management</div>
                        <div className="t-sm sec">Top 5 projects</div>
                      </div>
                      <div className="legend">
                        <span><i className="dot" style={{ background: "#34d399" }}></i>BlackRock (BUIDL)</span>
                        <span><i className="dot" style={{ background: "#1d4ed8" }}></i>Bitwise (ETHW)</span>
                        <span><i className="dot" style={{ background: "#f472b6" }}></i>Ondo (OUSG)</span>
                      </div>
                    </div>
                    <div className="hr"></div>
                    <Bars />
                  </div>
                </div>

                {/* slide 3: act on -> API / spreadsheet */}
                <div className={`card-slide${index === 3 ? " on" : ""}`}>
                  <div className="api-wrap">
                    <div className="codepane mono">
                      <div><span className="k">df</span> = pd.DataFrame(...)</div>
                      <div>fees_by_project = fees...</div>
                      <div>top_projects = fees...</div>
                      <div style={{ marginTop: "14px", color: "#94a3b8" }}>Top 10 Projects by fees</div>
                      <table>
                        <tbody>
                          <tr><td>61</td><td>Ethereum</td></tr>
                          <tr><td>32</td><td>Bitcoin</td></tr>
                          <tr><td>191</td><td>Uniswap</td></tr>
                          <tr><td>188</td><td>Tron</td></tr>
                          <tr><td>126</td><td>OpenSea</td></tr>
                          <tr><td>101</td><td>Lido Finance</td></tr>
                          <tr><td>66</td><td>Filecoin</td></tr>
                          <tr><td>24</td><td>BNB Chain</td></tr>
                        </tbody>
                      </table>
                    </div>
                    <div className="railbar">
                      <span>&#123;x&#125;</span><span>&#128273;</span><span>&#128193;</span><span>&#8646;</span>
                    </div>
                    <div className="sheet">
                      <div className="toolbar mono">
                        <span className="namebox">A1 <span style={{ color: "#9ca3af" }}>&#9662;</span></span>
                        <span style={{ color: "#9ca3af" }}>fx</span>
                        <span>=TT_TIMESERIES("A</span>
                      </div>
                      <div className="grid mono">
                        <div className="hd"></div><div className="hd">A</div><div className="hd">B</div>
                        <div className="hd">1</div><div className="sel" style={{ color: "#1a73e8" }}>=TT_TIMESERIES("AAVE", "fees",</div><div></div>
                        <div className="hd">2</div><div></div><div></div>
                        <div className="hd">3</div><div></div><div></div>
                        <div className="hd">4</div><div></div><div></div>
                        <div className="hd">5</div><div></div><div></div>
                        <div className="hd">6</div><div></div><div></div>
                        <div className="hd">7</div><div></div><div></div>
                        <div className="hd">8</div><div></div><div></div>
                        <div className="hd">9</div><div></div><div></div>
                      </div>
                    </div>
                    <div className="tooltip mono">
                      <div><span className="fn">TT_TIMESERIES(ticker, metricId, startTime, endTime)</span></div>
                      <div style={{ marginTop: "10px", color: "#6b7280", fontSize: "11px" }}>EXAMPLE</div>
                      <div className="fn">TT_TIMESERIES(string|Array&lt;string&gt;, string, string|Date, string|Date)</div>
                      <div style={{ marginTop: "8px", color: "#6b7280", fontSize: "11px" }}>ABOUT</div>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          </div>

        </div>
      </div>

      <div className="shell">
        <div className="hero-content-section">
          <p>Token Terminal transforms raw blockchain data into institutional-grade intelligence. We provide standardized metrics and comparable data across 100+ chains, 1,200+ applications, and 7,000+ tokenized assets.</p>
          <a className="cta" href="#" id="ctaLink">
            <span>{SLIDES[index].cta}</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" /></svg>
          </a>
        </div>
      </div>
    </>
  );
}
