import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Scout",
    short_name: "Scout",
    description: "Scout — your Chief of Staff.",
    start_url: "/chat",
    display: "standalone",
    background_color: "#fafaf8",
    theme_color: "#fafaf8",
  };
}
