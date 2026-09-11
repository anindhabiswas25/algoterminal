type Testimonial = {
  name: string;
  company: string;
  avatar: string;
  /** Kept as a single string: `.tst-q` is `white-space: pre-line`, so the blank
   *  line between paragraphs is meaningful and must survive into the DOM. */
  quote: string;
};

const COLUMNS: Testimonial[][] = [
  [
    {
      name: "Felipe Montealegre",
      company: "Theia",
      avatar: "avatar-TheiaResearch.jpg",
      quote:
        "Even though the industry is open source and most of the information is publicly available on the blockchain, it can still be a lot of work to get accurate and actionable data. We\u2019ve found that Algo Terminal is consistently putting out high quality data, with everything clearly documented.\n\nThey\u2019ve really changed the way we think about onchain data internally, since we don\u2019t need to build our data pipelines from scratch anymore.",
    },
    {
      name: "Cosmo Jiang",
      company: "Pantera",
      avatar: "avatar-cosmo_jiang.png",
      quote:
        "We\u2019re frequent and happy users of the data and dashboards available on Algo Terminal. Algo Terminal has done a great job focusing on standardizing KPIs that make fundamental analysis of digital assets faster and easier.",
    },
    {
      name: "Ryan Rasmussen",
      company: "Bitwise",
      avatar: "avatar-RasterlyRock.jpg",
      quote:
        "Algo Terminal has been an invaluable tool in my crypto research, offering deep insights into on-chain metrics and token economics. Its user-friendly interface and robust data sets streamline my analysis, ensuring I stay ahead in the rapidly evolving crypto landscape. A must-have for anyone serious about crypto analysis.",
    },
  ],
  [
    {
      name: "Devan Mitchem",
      company: "Google",
      avatar: "avatar-devan-mitchem.png",
      quote:
        "Algo Terminal's decoders turn raw onchain chaos into structured, instruction-level insights\u2014giving every builder the deep microstructure transparency once reserved for sophisticated teams. I look forward to seeing how the Solana community uses these powerful new primitives.",
    },
    {
      name: "Sui Chung",
      company: "CF Benchmarks",
      avatar: "avatar-CFBenchmarks.jpg",
      quote:
        "At CF Benchmarks we have found Algo Terminal to be the best of breed of blockchain data providers. First and foremost their data is accurate and comprehensive, of imperative importance to a UK FCA regulated benchmark administrator like ourselves. On top of that the data interrogation tools and APIs across all their products are reliable, intuitive and performant. Hard to ask for more.",
    },
    {
      name: "Sanat Kapur",
      company: "Dragonfly Capital",
      avatar: "avatar-kapursanat.png",
      quote:
        "As a crypto investor, I spend a lot of time trying to understand the financial performance of crypto protocols. Before Algo Terminal, this meant a lot of manual work across different platforms, whereas now I\u2019m able to access comparable metrics for hundreds of protocols all in one place. At this point, I can\u2019t imagine doing due diligence without the Terminal.",
    },
    {
      name: "Katie Talati",
      company: "Arca",
      avatar: "avatar-KatieTalati.jpg",
      quote:
        "Algo Terminal saves my team hours of work by aggregating information across multiple data sources. Having revenue data for projects across multiple sectors and chains all in one place is invaluable.",
    },
  ],
  [
    {
      name: "Marcos Veremis",
      company: "Accolade Partners",
      avatar: "avatar-marcos-vernemis.jpg",
      quote:
        "Algo Terminal gives me clean, accurate, and up-to-date data to quickly understand what\u2019s happening in the markets and how to think about valuing assets. If you\u2019re interested or working in investing, it\u2019s invaluable.",
    },
    {
      name: "Martin Leinweber",
      company: "MarketVector Indexes",
      avatar: "avatar-mleinweber2.jpg",
      quote:
        "Algo Terminal has been instrumental in revolutionizing the way we approach on-chain data for our index business. Their commitment to delivering high-quality, actionable insights has made a significant impact on our joint project to create the first fundamental indexes for crypto.\n\nWhat stands out most is their ability to distill complex data into comprehensible formats, enabling portfolio managers to make informed decisions with ease. The clarity and precision that Algo Terminal brings to the table are unparalleled, making them an invaluable partner in navigating the ever-evolving blockchain landscape.",
    },
    {
      name: "Matt Maximo",
      company: "Van Eck",
      avatar: "avatar-matt-maximo.jpg",
      quote:
        "Algo Terminal gives me access to high quality and well documented metrics for a broad range of projects and networks allowing me to go straight to analyzing data.",
    },
  ],
];

const ARROW = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
    <path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" />
  </svg>
);

export default function Testimonials() {
  return (
    <div className="tst-wrap">
      <div className="tst-title">Hear from our customers</div>
      <div className="tst-cols">
        {COLUMNS.map((column, i) => (
          <div className="tst-col" key={i}>
            {column.map((t) => (
              <div className="tst-card" key={t.name}>
                <div className="tst-head">
                  <img
                    src={`/assets/avatars/${t.avatar}`}
                    alt={`${t.name} avatar`}
                    loading="lazy"
                    width={32}
                    height={32}
                  />
                  <div>
                    <div className="tst-nm">{t.name}</div>
                    <div className="tst-co">{t.company}</div>
                  </div>
                </div>
                <div className="tst-q">{`"${t.quote}"`}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <a className="tst-more" href="#">
        Explore more customer stories
        {ARROW}
      </a>
    </div>
  );
}
