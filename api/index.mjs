// Vercel function: all API and health requests are rewritten to this file (see vercel.json).
// It loads the compiled server (built by `npm run build`), so no TypeScript is compiled here.
export { default } from '../server/dist/vercel.js';
