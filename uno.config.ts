import { defineConfig } from "unocss";

export default defineConfig({
  theme: {
    colors: {
      claude: {
        bg: "#F2F0ED",
        paper: "#FFFFFF",
        text: "#38352E",
        muted: "#6B665F",
        accent: "#D97757",
        line: "#E6E1DB",
      },
    },
    fontFamily: {
      serif: ["Merriweather", "Georgia", "serif"],
      sans: ["Inter", "system-ui", "sans-serif"],
    },
  },
});
