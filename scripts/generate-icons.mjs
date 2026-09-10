import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#0d6464"/><path d="M152 184l104-52 104 52v144l-104 52-104-52z M152 184l104 52 104-52 M256 236v144" fill="none" stroke="#a5e6db" stroke-width="14" stroke-linejoin="round"/><rect x="174" y="232" width="164" height="80" rx="16" fill="#0d6464"/><text x="256" y="288" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="60" fill="white">AHL</text></svg>`;
await mkdir('public/icons',{recursive:true});
for(const [name,size] of [['icon-192',192],['icon-512',512],['maskable-512',512],['apple-touch-icon',180]]) await sharp(Buffer.from(svg)).resize(size,size).png().toFile(`public/icons/${name}.png`);
