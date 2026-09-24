import { BadRequestException } from '@nestjs/common';

const owner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repo = /^[A-Za-z0-9_.-]{1,100}$/;

export function canonicalGitHubRepository(value: string): string {
  let path = value.trim();
  if (path.startsWith('https://')) {
    let url: URL;
    try { url = new URL(path); } catch { throw new BadRequestException('Invalid GitHub repository'); }
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) {
      throw new BadRequestException('Expected a public github.com repository URL');
    }
    path = url.pathname.slice(1).replace(/\/$/, '');
  }
  const parts = path.split('/');
  if (parts.length !== 2 || !owner.test(parts[0]!) || !repo.test(parts[1]!) || parts[1] === '.' || parts[1] === '..') {
    throw new BadRequestException('Use owner/repo or https://github.com/owner/repo');
  }
  return `https://github.com/${parts[0]!.toLowerCase()}/${parts[1]!.toLowerCase()}`;
}
