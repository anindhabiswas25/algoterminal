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
          <a className="logo" href="#" aria-label="Token Terminal"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 157 17" width="157" height="18.406896551724138" fill="none"><path fill="currentColor" d="M8.44 13.68v2.37h-3.5a2.36 2.36 0 0 1-2.36-2.35V7.3H0V4.99h2.57V1.66h2.66v3.32h3.2v2.33h-3.2v6.37h3.2ZM9.55 10.76A5.5 5.5 0 0 1 15.2 5a5.5 5.5 0 0 1 5.64 5.76 5.5 5.5 0 0 1-5.64 5.75 5.5 5.5 0 0 1-5.65-5.75Zm8.63 0c0-2-1.28-3.32-2.98-3.32-1.71 0-3 1.32-3 3.32 0 1.99 1.29 3.32 3 3.32 1.7 0 2.98-1.33 2.98-3.32ZM25.36 10.23v5.82h-2.65V0h2.65v9.81L29.66 5h3.5L28.28 10l5.15 6.04h-3.32l-4.76-5.82Z" /><path fill="currentColor" d="M44.25 11.4h-8.32c.29 1.62 1.35 2.55 2.99 2.55 1.17 0 1.86-.44 2.21-1.22h2.88c-.66 2.3-2.59 3.54-5.2 3.54-3.16 0-5.49-2.37-5.49-5.75 0-3.39 2.33-5.76 5.49-5.76s5.5 2.37 5.5 5.76c-.01.3-.03.6-.06.88Zm-8.3-1.88h5.71c-.28-1.55-1.3-2.43-2.85-2.43s-2.57.88-2.86 2.43ZM48.82 16.05h-2.66V4.98h2.66v1.6a3.56 3.56 0 0 1 3.19-1.82c2.35 0 4.12 1.55 4.12 4.67v6.62h-2.66V9.96c0-1.85-.89-2.87-2.33-2.87-1.43 0-2.32 1.02-2.32 2.87v6.1ZM72.18 13.68v2.37h-3.5a2.36 2.36 0 0 1-2.36-2.35V7.3h-2.57V4.99h2.57V1.66h2.66v3.32h3.2v2.33h-3.2v6.37h3.2ZM84.28 11.4h-8.33c.29 1.62 1.35 2.55 3 2.55 1.16 0 1.85-.44 2.2-1.22h2.89c-.67 2.3-2.6 3.54-5.2 3.54-3.17 0-5.5-2.37-5.5-5.75 0-3.39 2.33-5.76 5.5-5.76 3.16 0 5.49 2.37 5.49 5.76 0 .3-.03.6-.05.88Zm-8.3-1.88h5.71c-.28-1.55-1.3-2.43-2.85-2.43-1.56 0-2.58.88-2.86 2.43ZM97.3 16.05h-2.65V4.98h2.66v1.44a3.37 3.37 0 0 1 2.96-1.66c1.5 0 2.77.69 3.41 2.04a3.72 3.72 0 0 1 3.46-2.04c2.23 0 3.9 1.49 3.9 4.45v6.84h-2.66v-6.3c0-1.73-.8-2.66-2.1-2.66-1.31 0-2.1.93-2.1 2.65v6.31h-2.67v-6.3c0-1.73-.8-2.66-2.1-2.66s-2.1.93-2.1 2.65v6.31ZM113.23 1.66c0-.95.71-1.66 1.66-1.66.98 0 1.66.71 1.66 1.66 0 .93-.68 1.66-1.66 1.66-.95 0-1.66-.73-1.66-1.66ZM116.22 4.98h-2.66v11.07h2.66V4.98ZM121.52 16.05h-2.66V4.98h2.66v1.6a3.56 3.56 0 0 1 3.18-1.82c2.35 0 4.12 1.55 4.12 4.67v6.62h-2.65V9.96c0-1.85-.89-2.87-2.33-2.87s-2.32 1.02-2.32 2.87v6.1ZM138.04 14.42c-.71 1.3-2 1.85-3.52 1.85-1.9 0-3.72-.95-3.72-3.18 0-4.76 7.2-2.64 7.2-4.85 0-.86-.89-1.38-2.04-1.38-1.22 0-2.06.65-2.06 1.89h-2.77c0-2.88 2.35-3.99 4.83-3.99 2.44 0 4.7 1 4.7 3.59v7.7h-2.62v-1.63Zm-2.97-.36c1.55 0 2.97-.88 2.97-2.57V11c-1.78.72-4.52.5-4.52 1.92 0 .78.66 1.15 1.55 1.15ZM143.07 16.05V0h2.66v16.05h-2.66ZM91.98 7.55h1.14V4.96h-.88c-1.36 0-2.66.66-3.38 1.81l-.02.03V5H86.2v11.08h2.65v-5.65c0-1.86 1.16-2.88 3.13-2.88h.01Z" /><path fill="#00CF9D" d="M148.14 16.05v-2.37H157v2.37h-8.86Z" /></svg></a>
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
