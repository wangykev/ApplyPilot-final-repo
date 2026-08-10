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
  // A SECOND dev server (e.g. live-testing on :3100 while the UI is being edited on :3000) must not
  // share `.next` with the first — they overwrite each other's build output, which manifests as the
  // running app suddenly failing to hydrate and its chunks 404ing. Unset = the normal `.next`, so the
  // default `npm run dev` is byte-identical; set AP_DIST_DIR to isolate an extra instance:
  //   AP_DIST_DIR=.next-3100 npx next dev -p 3100
  distDir: process.env.AP_DIST_DIR || ".next",
};

export default nextConfig;
