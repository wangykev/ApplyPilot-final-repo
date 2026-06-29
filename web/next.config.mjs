import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This app lives in web/ inside the extension repo, which has its own
  // lockfile. Pin the tracing root to web/ so Next doesn't infer the parent.
  outputFileTracingRoot: __dirname,
  // unpdf ships its own pdf.js build; keep it external to the server bundle so
  // Next doesn't try to statically analyze the worker.
  serverExternalPackages: ["unpdf"],
};

export default nextConfig;
