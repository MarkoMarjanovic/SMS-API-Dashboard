// Vercel serverless entry point: every /api/* request is routed here (see vercel.json).
// The built UI is served by Vercel's CDN from client/dist.
import app from '../server/app.js';

export default app;
