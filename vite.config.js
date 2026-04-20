import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/cellbioprint-lot-code-manager/", // must match your repo name exactly
});
