import { config } from 'dotenv';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

config({ path: resolve(process.cwd(), '../../.env') });
const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001' },
};
export default nextConfig;
