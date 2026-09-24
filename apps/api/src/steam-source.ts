import { BadRequestException } from '@nestjs/common';

export function steamAppId(value: string): number {
  const trimmed = value.trim();
  let identifier = trimmed;
  if (trimmed.startsWith('https://')) {
    let url: URL;
    try { url = new URL(trimmed); } catch { throw new BadRequestException('Invalid Steam product URL'); }
    if (url.origin !== 'https://store.steampowered.com' || url.username || url.password) {
      throw new BadRequestException('Expected a Steam store product URL');
    }
    const match = /^\/app\/([1-9][0-9]*)(?:\/[A-Za-z0-9_-]+)?\/?$/.exec(url.pathname);
    if (!match) throw new BadRequestException('Expected /app/{appid} Steam product URL');
    identifier = match[1]!;
  }
  if (!/^[1-9][0-9]*$/.test(identifier) || Number(identifier) > 4294967295) {
    throw new BadRequestException('Steam App ID must be a positive integer');
  }
  return Number(identifier);
}

export function steamSourceUrl(appId: number): string {
  return `https://store.steampowered.com/app/${appId}/`;
}
