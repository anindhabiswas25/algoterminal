import SiteNav from "@/components/SiteNav";
import NavSpacer from "@/components/NavSpacer";
import Announcement from "@/components/Announcement";
import Hero from "@/components/Hero";
import TrustedBy from "@/components/TrustedBy";
import Platform from "@/components/Platform";
import Fundamentals from "@/components/Fundamentals";
import Testimonials from "@/components/Testimonials";
import Solutions from "@/components/Solutions";
import TalkToTeam from "@/components/TalkToTeam";
import SiteFooter from "@/components/SiteFooter";

export default function Home() {
  return (
    <>
      <SiteNav />
      <NavSpacer />
      <Announcement />
      <Hero />
      <TrustedBy />
      <Platform />
      <Fundamentals />
      <Testimonials />
      <Solutions />
      <TalkToTeam />
      <SiteFooter />
    </>
  );
}
