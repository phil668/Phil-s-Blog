// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";

import sitemap from "@astrojs/sitemap";
import UnoCSS from "unocss/astro";

// https://astro.build/config
export default defineConfig({
  site: "https://moondust.cn",
  integrations: [mdx(), sitemap(), UnoCSS()],
});
