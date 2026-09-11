"use client";

import { useEffect, useState } from "react";

/**
 * Transparent at the top of the page; once anything has scrolled it fades to
 * bg-surface/75 with a 20px backdrop blur and a bottom border, over 400ms.
 */
export default function SiteNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    let ticking = false;
    const apply = () => {
      setScrolled(window.scrollY > 0);
      ticking = false;
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(apply);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    apply();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="site-nav" data-is-scrolled={scrolled ? "true" : "false"}>
      <div className="nav-inner">
        <nav className="nav">
          <a className="logo" href="#" aria-label="algoterminal_">algoterminal<span className="logo-accent">_</span></a>
          <div className="nav-links">
            <a href="#">Products</a><a href="#">Get Listed</a><a href="#">Pricing</a>
            <a href="#">Resources</a><a href="#">About</a>
          </div>
          <div className="nav-right"><a className="explorer-btn" href="#" id="explore-button">Go to Explorer</a></div>
        </nav>
      </div>
    </header>
  );
}
