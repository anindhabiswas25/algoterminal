import { Fragment } from "react";
import FeeChart from "./FeeChart";

/** The REST API response body. Rendered line by line so the newlines survive JSX,
 *  which would otherwise collapse them and flatten the `white-space: pre` block. */
const JSON_LINES: [string, [string, string][]][] = [
  ["{", []],
  ['  KEY: [', [["j-k", '"data"']]],
  ["    {", []],
  ['      KEY: VAL,', [["j-k", '"timestamp"'], ["j-s", '"2024-10-21T00:00:00.000Z"']]],
  ['      KEY: VAL,', [["j-k", '"project_name"'], ["j-s", '"Base"']]],
  ['      KEY: VAL,', [["j-k", '"project_id"'], ["j-s", '"base"']]],
  ['      KEY: VAL,', [["j-k", '"fees"'], ["j-n", "107315.92"]]],
  ['      KEY: VAL,', [["j-k", '"revenue"'], ["j-n", "107315.92"]]],
  ['      KEY: VAL,', [["j-k", '"earnings"'], ["j-n", "106651.32"]]],
  ['      KEY: VAL,', [["j-k", '"user_dau"'], ["j-n", "1662351"]]],
  ["    },", []],
  ["    {", []],
  ['      KEY: VAL,', [["j-k", '"timestamp"'], ["j-s", '"2024-10-22T00:00:00.000Z"']]],
  ['      KEY: VAL,', [["j-k", '"project_name"'], ["j-s", '"Base"']]],
];

function JsonBody() {
  return (
    <div className="j-p" style={{ whiteSpace: "pre" }}>
      {JSON_LINES.map(([tpl, spans], i) => {
        const parts = tpl.split(/(KEY|VAL)/);
        let n = 0;
        return (
          <Fragment key={i}>
            {parts.map((part, j) => {
              if (part === "KEY" || part === "VAL") {
                const [cls, text] = spans[n++];
                return (
                  <span key={j} className={cls}>
                    {text}
                  </span>
                );
              }
              return part;
            })}
            {i < JSON_LINES.length - 1 ? "\n" : ""}
          </Fragment>
        );
      })}
    </div>
  );
}

export default function Fundamentals() {
  return (
    <>
    <div className="container-1240">
     <div className="fund-wrap">
      <div style={{ maxWidth: "1240px", margin: "0 auto 48px" }}>
       <div className="fund-title">Onchain fundamentals<br />you can understand</div>
      </div>
      <div className="fund-grid">
       <div className="fund-span2">  <a className="fcard row1 wide" href="#">
        <div className="fcard-head">
          <div className="ficon"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 text-fg-default"><path d="M237.2,151.87v0a47.1,47.1,0,0,0-2.35-5.45L193.26,51.8a7.82,7.82,0,0,0-1.66-2.44,32,32,0,0,0-45.26,0A8,8,0,0,0,144,55V80H112V55a8,8,0,0,0-2.34-5.66,32,32,0,0,0-45.26,0,7.82,7.82,0,0,0-1.66,2.44L21.15,146.4a47.1,47.1,0,0,0-2.35,5.45v0A48,48,0,1,0,112,168V96h32v72a48,48,0,1,0,93.2-16.13ZM76.71,59.75a16,16,0,0,1,19.29-1v73.51a47.9,47.9,0,0,0-46.79-9.92ZM64,200a32,32,0,1,1,32-32A32,32,0,0,1,64,200ZM160,58.74a16,16,0,0,1,19.29,1l27.5,62.58A47.9,47.9,0,0,0,160,132.25ZM192,200a32,32,0,1,1,32-32A32,32,0,0,1,192,200Z" /></svg></div>
          <span className="fkicker">Explorer</span>
          <h4>Historical onchain metrics</h4>
          <p className="fdesc">Track blockchain fees, revenue, and other key metrics over time with interactive charts that let you compare performance across projects and chains.</p>
        </div>
        <div className="fcard-vis"><div className="fmask"><div className="fpanel w800">
      <div style={{ paddingBottom: "8px" }}><h3 className="fpanel-title">Fees for L1 blockchains</h3></div>
      <div className="chart-axis-label">Fees</div>
      <div className="chart-legend"><span className="lg"><i className="sw" style={{ background: "#22c55e" }}></i>Tron</span><span className="lg"><i className="sw" style={{ background: "#4f46e5" }}></i>Solana</span><span className="lg"><i className="sw" style={{ background: "#6d28d9" }}></i>Ethereum</span><span className="lg"><i className="sw" style={{ background: "#e879f9" }}></i>Bitcoin</span><span className="lg"><i className="sw" style={{ background: "#e7e5e4" }}></i>NEAR Protocol</span></div>
      <div className="chart-area">
        <div className="chart-rot">Fees</div>
        <div className="chart-yaxis"><span>$12.5m</span><span>$10m</span><span>$7.5m</span><span>$5m</span><span>$2.5m</span></div>
        <FeeChart />
      </div>
    </div></div></div>
      </a>
    </div>
       <div>  <a className="fcard row1" href="#">
        <div className="fcard-head">
          <div className="ficon"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 text-fg-default"><path d="M237.2,151.87v0a47.1,47.1,0,0,0-2.35-5.45L193.26,51.8a7.82,7.82,0,0,0-1.66-2.44,32,32,0,0,0-45.26,0A8,8,0,0,0,144,55V80H112V55a8,8,0,0,0-2.34-5.66,32,32,0,0,0-45.26,0,7.82,7.82,0,0,0-1.66,2.44L21.15,146.4a47.1,47.1,0,0,0-2.35,5.45v0A48,48,0,1,0,112,168V96h32v72a48,48,0,1,0,93.2-16.13ZM76.71,59.75a16,16,0,0,1,19.29-1v73.51a47.9,47.9,0,0,0-46.79-9.92ZM64,200a32,32,0,1,1,32-32A32,32,0,0,1,64,200ZM160,58.74a16,16,0,0,1,19.29,1l27.5,62.58A47.9,47.9,0,0,0,160,132.25ZM192,200a32,32,0,1,1,32-32A32,32,0,0,1,192,200Z" /></svg></div>
          <span className="fkicker">Explorer</span>
          <h4>Tokenized assets</h4>
          <p className="fdesc">Compare the top-performing tokenized assets with standardized metrics like market cap, trading volume, and price changes to identify market trends.</p>
        </div>
        <div className="fcard-vis"><div className="fmask"><div className="fpanel" style={{ width: "100%", height: "100%", borderTopLeftRadius: "12px" }}>
      <div className="atable">
        <div className="atable-head"><h3 className="fpanel-title">Circulating asset market cap</h3><span className="sub">30d</span></div>
        <div className="arow"><span className="idx">1</span><img className="tok" src="/assets/tokens/tether.png" alt="" /><span className="nm">USDT</span><span className="val">$183.3 B</span><span className="chg up">+0.2%</span></div>
        <div className="arow"><span className="idx">2</span><img className="tok" src="/assets/tokens/circle.png" alt="" /><span className="nm">USDC</span><span className="val">$74.3 B</span><span className="chg up">+3.2%</span></div>
        <div className="arow"><span className="idx">3</span><span className="tok usds">S</span><span className="nm">USDS</span><span className="val">$9.7 B</span><span className="chg up">+1.1%</span></div>
        <div className="arow"><span className="idx">4</span><span className="tok susds">S</span><span className="nm">sUSDS</span><span className="val">$4.4 B</span><span className="chg dn">-0.6%</span></div>
        <div className="arow"><span className="idx">5</span><img className="tok" src="/assets/tokens/ethena.png" alt="" /><span className="nm">USDe</span><span className="val">$3.1 B</span><span className="chg up">+0.9%</span></div>
      </div>
    </div></div></div>
      </a>
    </div>
       <div>  <a className="fcard row2" href="#">
        <div className="fcard-head">
          <div className="ficon"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 text-fg-default"><path d="M237.2,151.87v0a47.1,47.1,0,0,0-2.35-5.45L193.26,51.8a7.82,7.82,0,0,0-1.66-2.44,32,32,0,0,0-45.26,0A8,8,0,0,0,144,55V80H112V55a8,8,0,0,0-2.34-5.66,32,32,0,0,0-45.26,0,7.82,7.82,0,0,0-1.66,2.44L21.15,146.4a47.1,47.1,0,0,0-2.35,5.45v0A48,48,0,1,0,112,168V96h32v72a48,48,0,1,0,93.2-16.13ZM76.71,59.75a16,16,0,0,1,19.29-1v73.51a47.9,47.9,0,0,0-46.79-9.92ZM64,200a32,32,0,1,1,32-32A32,32,0,0,1,64,200ZM160,58.74a16,16,0,0,1,19.29,1l27.5,62.58A47.9,47.9,0,0,0,160,132.25ZM192,200a32,32,0,1,1,32-32A32,32,0,0,1,192,200Z" /></svg></div>
          <span className="fkicker">Explorer</span>
          <h4>Market sectors</h4>
          <p className="fdesc">Visualize how fees and revenue are distributed across market sectors like stablecoins, L1 blockchains, exchanges, and more.</p>
        </div>
        <div className="fcard-vis"><div className="fmask"><div className="fpanel" style={{ width: "100%", height: "100%", borderTopLeftRadius: "12px", display: "flex", flexDirection: "column" }}>
      <div style={{ paddingBottom: "12px" }}><h3 className="fpanel-title">Fees by market sector</h3></div>
      <div className="tmap" style={{ flex: "1" }}><div className="tmap-group" style={{ flex: "2.2" }}>
      <div className="gh"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 shrink-0 text-fg-secondary"><path d="M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z" /></svg>Stablecoin issuers</div>
      <div className="tmap-body">
        <div className="tm" style={{ width: "calc(58% - 2px)", height: "62%", background: "#0f5132" }}><img src="/assets/tokens/tether.png" alt="" /><div className="tnm">Tether</div><div className="tvl">$417.9M (25.9%)</div></div>
        <div className="tm" style={{ width: "calc(42% - 2px)", height: "62%", background: "#146c43" }}><img src="/assets/tokens/circle.png" alt="" /><div className="tnm">Circle</div><div className="tvl">$182.8M (10.9%)</div></div>
        <div className="tm" style={{ width: "calc(50% - 2px)", height: "36%", background: "#198754" }}><img src="/assets/tokens/ethena.png" alt="" /><div className="tnm">Sky</div><div className="tvl"></div></div>
        <div className="tm" style={{ width: "calc(50% - 2px)", height: "36%", background: "#1a9c62" }}><img src="/assets/tokens/makerdao.png" alt="" /><div className="tnm">Ethena</div><div className="tvl"></div></div>
      </div>
    </div><div className="tmap-group" style={{ flex: "1.5" }}>
      <div className="gh"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 shrink-0 text-fg-secondary"><path d="M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z" /></svg>Blockchains (L1)</div>
      <div className="tmap-body">
        <div className="tm" style={{ width: "100%", height: "44%", background: "#1e3a8a" }}><img src="/assets/tokens/tron.png" alt="" /><div className="tnm">Tron</div><div className="tvl">$223.2M (13.3%)</div></div>
        <div className="tm" style={{ width: "100%", height: "26%", background: "#1e40af" }}><img src="/assets/tokens/solana.png" alt="" /><div className="tnm">Solana</div><div className="tvl">$22.3M (1.3%)</div></div>
        <div className="tm" style={{ width: "100%", height: "26%", background: "#2543a6" }}><img src="/assets/tokens/zcash.png" alt="" /><div className="tnm">Zcash</div><div className="tvl">$124.1M (7.7%)</div></div>
      </div>
    </div><div className="tmap-group" style={{ flex: "1.1" }}>
      <div className="gh"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 shrink-0 text-fg-secondary"><path d="M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z" /></svg>Exchanges (DEX)</div>
      <div className="tmap-body">
        <div className="tm" style={{ width: "100%", height: "42%", background: "#78350f" }}><img src="/assets/tokens/pancakeswap.png" alt="" /><div className="tnm">PancakeSwap</div><div className="tvl">$48.9M (3.0%)</div></div>
        <div className="tm" style={{ width: "calc(50% - 2px)", height: "28%", background: "#92400e" }}><img src="/assets/tokens/pumpfun.png" alt="" /><div className="tnm">pump.fun</div><div className="tvl"></div></div>
        <div className="tm" style={{ width: "calc(50% - 2px)", height: "28%", background: "#9a3412" }}><img src="/assets/tokens/uniswap.png" alt="" /><div className="tnm">Uniswap</div><div className="tvl"></div></div>
      </div>
    </div><div className="tmap-group" style={{ flex: "1" }}>
      <div className="gh"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 shrink-0 text-fg-secondary"><path d="M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z" /></svg>Liquid staking</div>
      <div className="tmap-body">
        <div className="tm" style={{ width: "100%", height: "44%", background: "#4c1d95" }}><img src="/assets/tokens/lido.png" alt="" /><div className="tnm">Lido Finance</div><div className="tvl">$78.0M (4.8%)</div></div>
        <div className="tm" style={{ width: "calc(50% - 2px)", height: "26%", background: "#5b21b6" }}><img src="/assets/tokens/jito.png" alt="" /><div className="tnm">Jito</div><div className="tvl"></div></div>
        <div className="tm" style={{ width: "calc(50% - 2px)", height: "26%", background: "#6d28d9" }}><img src="/assets/tokens/etherfi.png" alt="" /><div className="tnm">ether.fi</div><div className="tvl"></div></div>
      </div>
    </div></div>
    </div></div></div>
      </a>
    </div>
       <div>  <a className="fcard row2" href="#">
        <div className="fcard-head">
          <div className="ficon"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 text-fg-default"><path d="M237.2,151.87v0a47.1,47.1,0,0,0-2.35-5.45L193.26,51.8a7.82,7.82,0,0,0-1.66-2.44,32,32,0,0,0-45.26,0A8,8,0,0,0,144,55V80H112V55a8,8,0,0,0-2.34-5.66,32,32,0,0,0-45.26,0,7.82,7.82,0,0,0-1.66,2.44L21.15,146.4a47.1,47.1,0,0,0-2.35,5.45v0A48,48,0,1,0,112,168V96h32v72a48,48,0,1,0,93.2-16.13ZM76.71,59.75a16,16,0,0,1,19.29-1v73.51a47.9,47.9,0,0,0-46.79-9.92ZM64,200a32,32,0,1,1,32-32A32,32,0,0,1,64,200ZM160,58.74a16,16,0,0,1,19.29,1l27.5,62.58A47.9,47.9,0,0,0,160,132.25ZM192,200a32,32,0,1,1,32-32A32,32,0,0,1,192,200Z" /></svg></div>
          <span className="fkicker">Explorer</span>
          <h4>Financial statements</h4>
          <p className="fdesc">Analyze income statements with fees, revenue, expenses, and earnings for blockchain projects using traditional financial reporting formats.</p>
        </div>
        <div className="fcard-vis"><div className="fmask"><div className="fpanel" style={{ width: "100%", height: "100%", borderTopLeftRadius: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingBottom: "14px" }}>
        <div className="fs-eth"><img src="/assets/tokens/ethereum.png" alt="" />Ethereum</div>
        <div style={{ color: "var(--fg-secondary)", fontSize: "14px" }}>Jan 2026</div>
      </div>
      <table className="fstable">
        <tbody>
          <tr className="sec"><td colSpan={3} style={{ paddingTop: "0" }}>Income statement</td></tr>
          <tr className=""><td>Fees</td><td>$312.4M <span className="pos">+4.8%</span></td><td>$298.1M <span className="neg">-2.1%</span></td></tr>
          <tr className=""><td>Revenue</td><td>$312.4M <span className="pos">+4.8%</span></td><td>$298.1M <span className="neg">-2.1%</span></td></tr>
          <tr className=""><td style={{ paddingLeft: "14px" }}>(Expenses)</td><td>$45.2M <span className="pos">+5.6%</span></td><td>$42.8M <span className="pos">+3.6%</span></td></tr>
          <tr className=""><td>Earnings</td><td>$267.2M <span className="pos">+4.7%</span></td><td>$255.3M <span className="neg">-2.5%</span></td></tr>
          <tr className="sec"><td colSpan={3}>Market data</td></tr>
          <tr className=""><td>Price</td><td>$3.4K <span className="pos">+3.7%</span></td><td>$3.3K <span className="pos">+4.5%</span></td></tr>
          <tr className=""><td>Market cap (circulating)</td><td>$411.2B <span className="pos">+3.7%</span></td><td>$396.5B <span className="pos">+4.5%</span></td></tr>
        </tbody>
      </table>
    </div></div></div>
      </a>
    </div>
       <div>  <a className="fcard row2" href="#">
        <div className="fcard-head">
          <div className="ficon"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 text-fg-default"><path d="M248,92.68a15.86,15.86,0,0,0-4.69-11.31L174.63,12.68a16,16,0,0,0-22.63,0L123.57,41.11l-58,21.77A16.06,16.06,0,0,0,55.35,75.23L32.11,214.68A8,8,0,0,0,40,224a8.4,8.4,0,0,0,1.32-.11l139.44-23.24a16,16,0,0,0,12.35-10.17l21.77-58L243.31,104A15.87,15.87,0,0,0,248,92.68Zm-69.87,92.19L63.32,204l47.37-47.37a28,28,0,1,0-11.32-11.32L52,192.7,71.13,77.86,126,57.29,198.7,130ZM112,132a12,12,0,1,1,12,12A12,12,0,0,1,112,132Zm96-15.32L139.31,48l24-24L232,92.68Z" /></svg></div>
          <span className="fkicker">Studio</span>
          <h4>Dive deeper with Queries</h4>
          <p className="fdesc">Write and execute SQL queries against raw blockchain data with AI-powered suggestions and instant results.</p>
        </div>
        <div className="fcard-vis"><div className="fmask"><div className="fpanel" style={{ padding: "0", width: "100%", height: "100%", borderTopLeftRadius: "12px" }}>
     <div className="q-wrap">
      <div className="q-bc">Queries <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" /></svg> <b>Bitcoin active_addresses</b> <svg width="14" height="14" viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16"><path d="M132.4,190.7l50.4,32c6.5,4.1,14.5-2,12.6-9.5l-14.4-57.1a8.7,8.7,0,0,1,2.9-8.8l45-37.5c5.9-4.9,2.9-14.8-4.8-15.3l-58.8-3.8a8.3,8.3,0,0,1-7.3-5.3L136.2,30a8.5,8.5,0,0,0-16,0L98.2,85.4a8.5,8.5,0,0,1-7.3,5.3L32.1,94.5c-7.7.5-10.7,10.4-4.8,15.3l45,37.5a8.7,8.7,0,0,1,2.9,8.8L61.9,208.9c-2.3,9,7.3,16.1,15.1,11.1l48.1-30.6A8,8,0,0,1,132.4,190.7Z" /></svg></div>
      <div className="q-body">
        <div className="q-left">
          <div className="q-tab"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 shrink-0 text-fg-secondary"><path d="M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z" /></svg>Tables</div>
          <div className="q-search"><svg width="13" height="13" viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="18"><circle cx="116" cy="116" r="84" /><line x1="175.4" y1="175.4" x2="224" y2="224" /></svg>Search</div>
          <div className="q-item"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" /></svg><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 shrink-0 text-fg-secondary"><path d="M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z" /></svg>metrics<span className="n">2</span></div>
          <div className="q-item"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" /></svg><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 shrink-0 text-fg-secondary"><path d="M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z" /></svg>primitives<span className="n">2</span></div>
        </div>
        <div className="q-right">
          <div className="q-code">
            <div className="ln">1<br />2<br />3</div>
            <div><span className="q-kw">select</span> *<br /><span className="q-kw">from</span> <span className="q-id">metrics</span><br /><span className="q-kw">where</span> <span className="q-id">data_id</span> = <span className="q-str">'bitcoin'</span></div>
          </div>
          <div className="q-ai"><span className="q-kbd">&#8984;I</span> AI suggestions</div>
          <div className="q-status"><span className="ok">&#10003;</span> Success <span className="ago">21 days ago</span></div>
          <table className="q-res">
            <thead><tr><th>timestamp</th><th>data_id</th><th>value</th></tr></thead>
            <tbody>
              <tr><td>5/1/2012</td><td>bitcoin</td><td>11,443</td></tr>
              <tr><td>5/2/2012</td><td>bitcoin</td><td>11,573</td></tr>
              <tr><td>5/5/2012</td><td>bitcoin</td><td>12,299</td></tr>
            </tbody>
          </table>
        </div>
      </div>
     </div>
    </div></div></div>
      </a>
    </div>
       <div>  <a className="fcard row2" href="#">
        <div className="fcard-head">
          <div className="ficon"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 text-fg-default"><path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM40,112H80v32H40Zm56,0H216v32H96ZM216,64V96H40V64ZM40,160H80v32H40Zm176,32H96V160H216v32Z" /></svg></div>
          <span className="fkicker">Sheets</span>
          <h4>Sheets integration</h4>
          <p className="fdesc">Pull blockchain data directly into Excel and Google Sheets with custom functions for financial statements, metrics, and more.</p>
        </div>
        <div className="fcard-vis"><div className="fmask"><div className="sh">
      <div className="sh-bar">
        <div className="sh-name">A1 <span style={{ color: "var(--fg-secondary)" }}>&#9662;</span></div>
        <div className="sh-fx">&#402;</div>
        <div className="sh-formula">=TT_FINANCIAL_STATEMENT(<span className="s">"ETH"</span>, <span className="s">"qua</span></div>
      </div>
      <table>
        <thead><tr><th style={{ width: "34px" }}></th><th className="colA">A</th><th>B</th><th>C</th><th>D</th></tr></thead>
        <tbody><tr><td className="rn">1</td><td className="selcell">Quarters</td><td>Q1 2026</td><td>Q4 2025</td><td>Q3 20</td></tr><tr><td className="rn">2</td><td>Income State…</td><td></td><td></td><td></td></tr><tr><td className="rn">3</td><td>Fees</td><td>$4,716,702.18</td><td>$76,566,498.…</td><td>$125,</td></tr><tr><td className="rn">4</td><td>Fees_Supply…</td><td>$4,010,677.26</td><td>$48,093,226.…</td><td>$69,0</td></tr><tr><td className="rn">5</td><td>Revenue</td><td>$706,024.92</td><td>$28,473,271.56</td><td>$56,</td></tr><tr><td className="rn">6</td><td>Expenses</td><td>$97,171,161.57</td><td>$765,529,137.…</td><td>$933,</td></tr><tr><td className="rn">7</td><td>Token_Incent…</td><td>$97,171,161.57</td><td>$765,529,137.…</td><td>$933,</td></tr><tr><td className="rn">8</td><td>Earnings</td><td>($96,465,136.…</td><td>($737,055,86…</td><td>($877,</td></tr></tbody>
      </table>
    </div></div></div>
      </a>
    </div>
       <div>  <a className="fcard row2" href="#">
        <div className="fcard-head">
          <div className="ficon"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 text-fg-default"><path d="M69.12,94.15,28.5,128l40.62,33.85a8,8,0,1,1-10.24,12.29l-48-40a8,8,0,0,1,0-12.29l48-40a8,8,0,0,1,10.24,12.3Zm176,27.7-48-40a8,8,0,1,0-10.24,12.3L227.5,128l-40.62,33.85a8,8,0,1,0,10.24,12.29l48-40a8,8,0,0,0,0-12.29ZM162.73,32.48a8,8,0,0,0-10.25,4.79l-64,176a8,8,0,0,0,4.79,10.26A8.14,8.14,0,0,0,96,224a8,8,0,0,0,7.52-5.27l64-176A8,8,0,0,0,162.73,32.48Z" /></svg></div>
          <span className="fkicker">API</span>
          <h4>REST API</h4>
          <p className="fdesc">Access standardized blockchain metrics through a developer-friendly REST API with comprehensive documentation and type definitions.</p>
        </div>
        <div className="fcard-vis"><div className="fmask"><div className="api">
      <div className="api-row">
        <div className="api-get">GET <span style={{ color: "var(--fg-secondary)" }}>&#9662;</span></div>
        <div className="api-url">api.tokenterminal.com/v2/proje</div>
      </div>
      <div className="api-meta"><span className="ok">200 OK</span> &bull; 309 ms &bull; 535.2 KB</div>
      <div className="api-tabs"><span>Pretty <span style={{ color: "var(--fg-secondary)" }}>&#9662;</span></span><span>Headers <span style={{ color: "var(--fg-default)" }}>14</span></span></div>
      <div className="api-code">
        <div className="ln">1<br />2<br />3<br />4<br />5<br />6<br />7<br />8<br />9<br />10<br />11<br />12<br />13<br />14</div>
        <JsonBody />
      </div>
    </div></div></div>
      </a>
    </div>
       <div>  <a className="fcard row2" href="#">
        <div className="fcard-head">
          <div className="ficon"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 text-fg-default"><path d="M128,24C74.17,24,32,48.6,32,80v96c0,31.4,42.17,56,96,56s96-24.6,96-56V80C224,48.6,181.83,24,128,24Zm80,104c0,9.62-7.88,19.43-21.61,26.92C170.93,163.35,150.19,168,128,168s-42.93-4.65-58.39-13.08C55.88,147.43,48,137.62,48,128V111.36c17.06,15,46.23,24.64,80,24.64s62.94-9.68,80-24.64ZM69.61,53.08C85.07,44.65,105.81,40,128,40s42.93,4.65,58.39,13.08C200.12,60.57,208,70.38,208,80s-7.88,19.43-21.61,26.92C170.93,115.35,150.19,120,128,120s-42.93-4.65-58.39-13.08C55.88,99.43,48,89.62,48,80S55.88,60.57,69.61,53.08ZM186.39,202.92C170.93,211.35,150.19,216,128,216s-42.93-4.65-58.39-13.08C55.88,195.43,48,185.62,48,176V159.36c17.06,15,46.23,24.64,80,24.64s62.94-9.68,80-24.64V176C208,185.62,200.12,195.43,186.39,202.92Z" /></svg></div>
          <span className="fkicker">Data Room</span>
          <h4>Access our data warehouse</h4>
          <p className="fdesc">Query raw blockchain data directly in your own data warehouse with schemas for blocks, transactions, and decoded contract events.</p>
        </div>
        <div className="fcard-vis"><div className="fmask"><div className="fpanel" style={{ padding: "0", width: "100%", height: "100%", borderTopLeftRadius: "12px" }}>
     <div className="dr">
      <div className="dr-top"><span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#3f3f46", display: "inline-block" }}></span><span>&#9662;</span><span style={{ color: "var(--border-default)" }}>|</span><span className="dr-chip"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="w-5 h-5 shrink-0 text-fg-secondary"><path d="M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z" /></svg> blocks <span>&#9662;</span></span></div>
      <div className="dr-bc"><span className="lk">blockchain</span> / <span>Datasets</span> / <span className="lk">solana</span> / <span>blocks</span></div>
      <div className="dr-name"><svg width="14" height="14" viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16"><path d="M132.4,190.7l50.4,32c6.5,4.1,14.5-2,12.6-9.5l-14.4-57.1a8.7,8.7,0,0,1,2.9-8.8l45-37.5c5.9-4.9,2.9-14.8-4.8-15.3l-58.8-3.8a8.3,8.3,0,0,1-7.3-5.3L136.2,30a8.5,8.5,0,0,0-16,0L98.2,85.4a8.5,8.5,0,0,1-7.3,5.3L32.1,94.5c-7.7.5-10.7,10.4-4.8,15.3l45,37.5a8.7,8.7,0,0,1,2.9,8.8L61.9,208.9c-2.3,9,7.3,16.1,15.1,11.1l48.1-30.6A8,8,0,0,1,132.4,190.7Z" /></svg> blocks</div>
      <div className="dr-tabs"><span className="on">Schema</span><span>Details</span><span>Preview</span></div>
      <div className="dr-filter"><svg width="13" height="13" viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16"><path d="M42,72H214M74,128H182M110,184h36" /></svg> Filter <span style={{ color: "var(--fg-muted)" }}>Enter property name or value</span></div>
      <table>
        <thead><tr><th><span className="cb"></span> Field name</th><th>Type</th><th>Mode</th></tr></thead>
        <tbody><tr><td><span className="cb"></span> block_slot</td><td className="t">INTEGER</td><td className="t">NULLABLE</td></tr><tr><td><span className="cb"></span> block_hash</td><td className="t">STRING</td><td className="t">NULLABLE</td></tr><tr><td><span className="cb"></span> block_height</td><td className="t">INTEGER</td><td className="t">NULLABLE</td></tr><tr><td><span className="cb"></span> block_timestamp</td><td className="t">TIMESTAMP</td><td className="t">NULLABLE</td></tr><tr><td><span className="cb"></span> parent_slot</td><td className="t">INTEGER</td><td className="t">NULLABLE</td></tr><tr><td><span className="cb"></span> previous_block_hash</td><td className="t">STRING</td><td className="t">NULLABLE</td></tr><tr><td><span className="cb"></span> total_transaction_count</td><td className="t">INTEGER</td><td className="t">NULLABLE</td></tr><tr><td><span className="cb"></span> successful_transaction_count</td><td className="t">INTEGER</td><td className="t">NULLABLE</td></tr></tbody>
      </table>
     </div>
    </div></div></div>
      </a>
    </div>
      </div>
     </div>
    </div>
    </>
  );
}
