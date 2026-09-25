import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';

export function publicPageUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new BadRequestException('Invalid page URL'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search ||
      isIP(host) !== 0 || !host.includes('.') || host.endsWith('.') ||
      /(^|\.)(localhost|local|internal|invalid|test)$/.test(host) ||
      value.length > 2048) {
    throw new BadRequestException('Use a public HTTPS URL without credentials, query or custom port');
  }
  url.hash = '';
  return url.toString();
}
