// Generates the demo storefront's product and editorial illustrations as static SVG (no binary assets, no licensing).
// Run: node scripts/gen-art.mjs   (output is committed under public/art)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '../public/art');
mkdirSync(out, { recursive: true });

const defs = (id, a, b) => `
  <defs>
    <radialGradient id="bg-${id}" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient>
    <linearGradient id="floor-${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".06"/><stop offset="1" stop-color="#000" stop-opacity=".0"/></linearGradient>
    <filter id="blur-${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="soft-${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
  </defs>`;

const scene = (
  id,
  a,
  b,
  body,
  { w = 800, h = 1000 } = {},
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-hidden="true">
${defs(id, a, b)}
<rect width="${w}" height="${h}" fill="url(#bg-${id})"/>
<rect y="800" width="${w}" height="${h - 800}" fill="url(#floor-${id})"/>
<circle cx="640" cy="200" r="190" fill="#fff" opacity=".28" filter="url(#soft-${id})"/>
${body}
</svg>`;

const shadow = (id, cx, cy, rx) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${rx * 0.12}" fill="#3b2a1e" opacity=".28" filter="url(#blur-${id})"/>`;

const lin = (id, name, c1, c2, horizontal = true) =>
  `<linearGradient id="${name}-${id}" x1="0" y1="0" x2="${horizontal ? 1 : 0}" y2="${horizontal ? 0 : 1}"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`;

const products = {
  mug: () => {
    const id = 'mug';
    return scene(
      id,
      '#f8ece0',
      '#ecd3bd',
      `
      ${shadow(id, 400, 812, 190)}
      <defs>${lin(id, 'body', '#f4efe8', '#d9cdbd')}${lin(id, 'glaze', '#c8683c', '#9c4322', false)}</defs>
      <path d="M520 560 q110 0 110 100 q0 100 -110 100" fill="none" stroke="#cfc2b0" stroke-width="44" stroke-linecap="round"/>
      <path d="M520 560 q110 0 110 100 q0 100 -110 100" fill="none" stroke="#f4efe8" stroke-width="30" stroke-linecap="round" opacity=".7"/>
      <rect x="250" y="470" width="290" height="340" rx="44" fill="url(#body-${id})"/>
      <path d="M250 640 h290 v126 q0 44 -44 44 h-202 q-44 0 -44 -44z" fill="url(#glaze-${id})" opacity=".95"/>
      <path d="M250 640 q145 34 290 0" fill="none" stroke="#fff" stroke-width="3" opacity=".35"/>
      <ellipse cx="395" cy="472" rx="145" ry="28" fill="#e7dccd"/>
      <ellipse cx="395" cy="476" rx="126" ry="20" fill="#5b3a26"/>
      <rect x="282" y="500" width="22" height="240" rx="11" fill="#fff" opacity=".35"/>`,
    );
  },
  tote: () => {
    const id = 'tote';
    return scene(
      id,
      '#eef0e6',
      '#d3d9c3',
      `
      ${shadow(id, 400, 822, 200)}
      <defs>${lin(id, 'cloth', '#efe6d4', '#d8ccb3')}</defs>
      <path d="M300 470 q-20 -190 100 -190 q120 0 100 190" fill="none" stroke="#b9a98a" stroke-width="26" stroke-linecap="round"/>
      <path d="M232 450 h336 l26 360 h-388z" fill="url(#cloth-${id})"/>
      <path d="M232 450 h336" stroke="#c9bb9d" stroke-width="6"/>
      <path d="M248 480 h304" stroke="#bfae8c" stroke-width="3" stroke-dasharray="10 9"/>
      <rect x="326" y="590" width="148" height="104" rx="8" fill="#3f5a48"/>
      <path d="M352 654 q24 -44 48 0 q24 -44 48 0" fill="none" stroke="#e9dfc8" stroke-width="7" stroke-linecap="round"/>
      <path d="M232 450 l-0 0 l26 360" stroke="#fff" stroke-width="3" opacity=".3"/>`,
    );
  },
  candle: () => {
    const id = 'candle';
    return scene(
      id,
      '#f6e9dc',
      '#e3c3a6',
      `
      ${shadow(id, 400, 812, 170)}
      <defs>${lin(id, 'glass', '#6b4a36', '#3d281c', false)}
        <radialGradient id="glow-${id}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffd27a" stop-opacity=".9"/><stop offset="1" stop-color="#ffd27a" stop-opacity="0"/></radialGradient></defs>
      <circle cx="400" cy="420" r="190" fill="url(#glow-${id})"/>
      <rect x="275" y="500" width="250" height="310" rx="34" fill="url(#glass-${id})"/>
      <ellipse cx="400" cy="502" rx="125" ry="22" fill="#f3e5cc"/>
      <ellipse cx="400" cy="506" rx="108" ry="15" fill="#e9d3ab"/>
      <rect x="397" y="452" width="6" height="56" rx="3" fill="#2a1b12"/>
      <path d="M400 356 q46 50 0 100 q-46 -50 0 -100z" fill="#ffb347"/>
      <path d="M400 392 q20 28 0 58 q-20 -30 0 -58z" fill="#fff3c4"/>
      <rect x="300" y="560" width="200" height="120" rx="6" fill="#f6ead7" opacity=".92"/>
      <text x="400" y="612" text-anchor="middle" font-family="Georgia, serif" font-size="30" fill="#5a3b28" letter-spacing="6">EMBER</text>
      <text x="400" y="650" text-anchor="middle" font-family="Georgia, serif" font-size="16" fill="#8a6a52" letter-spacing="4">SOY · CEDAR</text>
      <rect x="290" y="520" width="18" height="270" rx="9" fill="#fff" opacity=".18"/>`,
    );
  },
  vase: () => {
    const id = 'vase';
    return scene(
      id,
      '#e9eef1',
      '#c9d6dc',
      `
      ${shadow(id, 400, 812, 150)}
      <defs>${lin(id, 'ceramic', '#7f9b96', '#4f6b68')}</defs>
      <g stroke="#6b7a55" stroke-width="7" fill="none" stroke-linecap="round">
        <path d="M400 520 q-10 -180 -110 -270"/><path d="M400 520 q20 -220 40 -330"/><path d="M400 520 q60 -150 160 -200"/></g>
      <g fill="#8a9a6a"><ellipse cx="300" cy="280" rx="20" ry="46" transform="rotate(-30 300 280)"/>
        <ellipse cx="438" cy="210" rx="18" ry="44" transform="rotate(8 438 210)"/>
        <ellipse cx="548" cy="330" rx="20" ry="44" transform="rotate(55 548 330)"/></g>
      <circle cx="288" cy="250" r="26" fill="#e8b4a0"/><circle cx="440" cy="186" r="24" fill="#f0d08a"/><circle cx="562" cy="306" r="26" fill="#e8b4a0"/>
      <path d="M350 500 h100 q0 40 70 120 q60 80 -10 160 q-20 30 -110 30 q-90 0 -110 -30 q-70 -80 -10 -160 q70 -80 70 -120z" fill="url(#ceramic-${id})"/>
      <path d="M352 560 q-40 60 -60 120" stroke="#fff" stroke-width="10" stroke-linecap="round" opacity=".25" fill="none"/>
      <ellipse cx="400" cy="500" rx="50" ry="10" fill="#33504d"/>`,
    );
  },
  notebook: () => {
    const id = 'notebook';
    return scene(
      id,
      '#f2eadf',
      '#dccbb4',
      `
      <g transform="rotate(-7 400 620)">
      ${shadow(id, 410, 800, 230)}
      <defs>${lin(id, 'cover', '#2f4a3d', '#203529')}</defs>
      <rect x="220" y="380" width="360" height="430" rx="20" fill="#f5efe3"/>
      <rect x="232" y="392" width="360" height="430" rx="20" fill="#ebe3d3"/>
      <rect x="210" y="368" width="370" height="440" rx="20" fill="url(#cover-${id})"/>
      <rect x="210" y="368" width="34" height="440" rx="16" fill="#000" opacity=".22"/>
      <rect x="540" y="368" width="14" height="440" fill="#c8683c"/>
      <rect x="300" y="500" width="190" height="130" rx="4" fill="none" stroke="#d7c79c" stroke-width="3"/>
      <text x="395" y="560" text-anchor="middle" font-family="Georgia, serif" font-size="34" fill="#d7c79c" letter-spacing="8">NOTES</text>
      <line x1="330" y1="590" x2="460" y2="590" stroke="#d7c79c" stroke-width="2"/></g>`,
    );
  },
  lamp: () => {
    const id = 'lamp';
    return scene(
      id,
      '#f1e6d6',
      '#d9bf9c',
      `
      ${shadow(id, 400, 812, 150)}
      <defs>${lin(id, 'shade', '#f7e9cf', '#e4c997')}<radialGradient id="lg-${id}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffe3a3" stop-opacity=".85"/><stop offset="1" stop-color="#ffe3a3" stop-opacity="0"/></radialGradient></defs>
      <ellipse cx="400" cy="420" rx="300" ry="280" fill="url(#lg-${id})"/>
      <rect x="392" y="470" width="16" height="280" rx="8" fill="#33312d"/>
      <ellipse cx="400" cy="790" rx="120" ry="24" fill="#33312d"/><rect x="280" y="766" width="240" height="24" fill="#33312d"/><ellipse cx="400" cy="766" rx="120" ry="22" fill="#4a4741"/>
      <path d="M290 480 l40 -190 h140 l40 190z" fill="url(#shade-${id})"/>
      <path d="M290 480 q110 30 220 0" fill="none" stroke="#c4a36a" stroke-width="4" opacity=".6"/>
      <path d="M330 290 l-16 190" stroke="#fff" stroke-width="6" opacity=".3"/>`,
    );
  },
  plant: () => {
    const id = 'plant';
    return scene(
      id,
      '#eaf0e3',
      '#c5d4b5',
      `
      ${shadow(id, 400, 812, 170)}
      <defs>${lin(id, 'clay', '#d98458', '#b15a33', false)}${lin(id, 'leaf', '#4f7a4a', '#2f5a35')}</defs>
      <g fill="url(#leaf-${id})">
        <ellipse cx="400" cy="340" rx="44" ry="150" />
        <ellipse cx="290" cy="420" rx="40" ry="130" transform="rotate(-38 290 420)"/>
        <ellipse cx="510" cy="420" rx="40" ry="130" transform="rotate(38 510 420)"/>
        <ellipse cx="230" cy="540" rx="34" ry="110" transform="rotate(-65 230 540)"/>
        <ellipse cx="570" cy="540" rx="34" ry="110" transform="rotate(65 570 540)"/></g>
      <path d="M400 200 v260 M300 340 l70 120 M500 340 l-70 120" stroke="#2f5a35" stroke-width="4" fill="none" opacity=".5"/>
      <path d="M290 590 h220 l-26 220 q-2 12 -14 12 h-140 q-12 0 -14 -12z" fill="url(#clay-${id})"/>
      <rect x="276" y="572" width="248" height="42" rx="12" fill="#c46c40"/>
      <path d="M300 620 l10 180" stroke="#fff" stroke-width="10" opacity=".18" stroke-linecap="round"/>`,
    );
  },
  bottle: () => {
    const id = 'bottle';
    return scene(
      id,
      '#e7eef0',
      '#bccbd0',
      `
      ${shadow(id, 400, 812, 130)}
      <defs>${lin(id, 'steel', '#dde6e8', '#8fa3a8')}${lin(id, 'cap', '#c8683c', '#9c4322')}</defs>
      <rect x="360" y="250" width="80" height="70" rx="14" fill="url(#cap-${id})"/>
      <rect x="348" y="312" width="104" height="40" rx="10" fill="#33413f"/>
      <path d="M352 350 h96 q22 40 22 100 v320 q0 40 -40 40 h-60 q-40 0 -40 -40 v-320 q0 -60 22 -100z" fill="url(#steel-${id})"/>
      <rect x="376" y="420" width="18" height="340" rx="9" fill="#fff" opacity=".5"/>
      <rect x="330" y="560" width="140" height="100" rx="6" fill="#33413f" opacity=".92"/>
      <text x="400" y="622" text-anchor="middle" font-family="Georgia, serif" font-size="30" fill="#e8f0ee" letter-spacing="6">TRAIL</text>`,
    );
  },
  bowl: () => {
    const id = 'bowl';
    return scene(
      id,
      '#f6eee3',
      '#e5d1b7',
      `
      ${shadow(id, 400, 780, 250)}
      <defs>${lin(id, 'bowl', '#f1e7d8', '#cdbda3', false)}${lin(id, 'inside', '#e3d5bf', '#b9a78a', false)}</defs>
      <path d="M170 560 h460 q0 230 -230 230 q-230 0 -230 -230z" fill="url(#bowl-${id})"/>
      <path d="M200 650 q200 50 400 0" stroke="#b7523a" stroke-width="22" fill="none" opacity=".9"/>
      <ellipse cx="400" cy="560" rx="230" ry="46" fill="#ebdfcc"/>
      <ellipse cx="400" cy="566" rx="206" ry="36" fill="url(#inside-${id})"/>
      <g fill="#c8683c"><circle cx="350" cy="560" r="30"/><circle cx="430" cy="548" r="34" fill="#d98458"/><circle cx="470" cy="572" r="28" fill="#b9553a"/></g>
      <path d="M345 540 q8 -20 22 -18" stroke="#3f6a3d" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    );
  },
};

for (const [name, draw] of Object.entries(products))
  writeFileSync(join(out, `${name}.svg`), draw());

// Hero: arches, sun and still life — wide, calm, warm.
writeFileSync(
  join(out, 'hero.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1000" role="img" aria-hidden="true">
  <defs>
    <linearGradient id="h-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7e9d9"/><stop offset="1" stop-color="#ecc9a9"/></linearGradient>
    <linearGradient id="h-a1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c8683c"/><stop offset="1" stop-color="#9c4322"/></linearGradient>
    <linearGradient id="h-a2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e5c79c"/><stop offset="1" stop-color="#cfa56e"/></linearGradient>
    <linearGradient id="h-a3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fa58a"/><stop offset="1" stop-color="#5f7b5d"/></linearGradient>
    <filter id="h-b"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <rect width="1200" height="1000" fill="url(#h-bg)"/>
  <circle cx="860" cy="250" r="120" fill="#fff6e6" opacity=".9"/>
  <path d="M120 900 V470 a190 190 0 0 1 380 0 V900z" fill="url(#h-a3)"/>
  <path d="M430 900 V330 a210 210 0 0 1 420 0 V900z" fill="url(#h-a1)"/>
  <path d="M780 900 V520 a180 180 0 0 1 360 0 V900z" fill="url(#h-a2)"/>
  <rect y="880" width="1200" height="120" fill="#3b2a1e" opacity=".12"/>
  <ellipse cx="640" cy="900" rx="420" ry="26" fill="#3b2a1e" opacity=".25" filter="url(#h-b)"/>
  <g transform="translate(250 700)"><path d="M0 200 h120 q10 -110 -60 -160 q-70 50 -60 160z" fill="#f4efe8"/><path d="M60 40 q-40 -110 -110 -150 M60 40 q10 -140 40 -200 M60 40 q60 -90 130 -110" stroke="#2f4a3d" stroke-width="7" fill="none" stroke-linecap="round"/><circle cx="-56" cy="-112" r="22" fill="#f0d08a"/><circle cx="102" cy="-164" r="24" fill="#e8b4a0"/><circle cx="196" cy="-62" r="22" fill="#f0d08a"/></g>
  <g transform="translate(860 720)"><rect width="180" height="180" rx="22" fill="#3d281c"/><ellipse cx="90" cy="2" rx="90" ry="16" fill="#f3e5cc"/><rect x="87" y="-58" width="6" height="56" rx="3" fill="#2a1b12"/><path d="M90 -120 q40 46 0 92 q-40 -46 0 -92z" fill="#ffb347"/><path d="M90 -88 q16 24 0 50 q-16 -26 0 -50z" fill="#fff3c4"/></g>
  <g transform="translate(560 790)"><path d="M0 110 h190 l-16 -8 q8 -120 -79 -120 q-87 0 -79 120z" fill="#f1e7d8"/><path d="M12 70 q83 22 166 0" stroke="#b7523a" stroke-width="14" fill="none"/></g>
</svg>`,
);

// Editorial (journal) illustration: a window of light over a table.
writeFileSync(
  join(out, 'editorial.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 1000" role="img" aria-hidden="true">
  <defs><linearGradient id="e-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d9e3d3"/><stop offset="1" stop-color="#a9bca4"/></linearGradient>
  <linearGradient id="e-light" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff6dc" stop-opacity=".85"/><stop offset="1" stop-color="#fff6dc" stop-opacity="0"/></linearGradient></defs>
  <rect width="900" height="1000" fill="url(#e-bg)"/>
  <path d="M130 120 h250 v330 h-250z M420 120 h250 v330 h-250z" fill="#f7f0e0" opacity=".9"/>
  <path d="M130 120 L620 880 H260z" fill="url(#e-light)"/>
  <rect y="700" width="900" height="300" fill="#7c5a3f"/><rect y="700" width="900" height="14" fill="#5d422d"/>
  <g transform="translate(180 610)"><rect width="180" height="100" rx="14" fill="#f4efe8"/><path d="M180 26 q56 0 56 34 q0 34 -56 34" fill="none" stroke="#f4efe8" stroke-width="16"/><ellipse cx="90" cy="2" rx="90" ry="14" fill="#5b3a26"/></g>
  <g transform="translate(470 560)"><rect width="250" height="150" rx="8" fill="#2f4a3d"/><rect x="250" y="8" width="6" height="134" fill="#f5efe3"/><rect x="26" y="40" width="140" height="70" fill="none" stroke="#d7c79c" stroke-width="3"/></g>
  <g transform="translate(680 480)"><path d="M0 230 h120 l-16 -100 q-44 -30 -88 0z" fill="#c8683c"/><g fill="#4f7a4a"><ellipse cx="60" cy="60" rx="18" ry="80"/><ellipse cx="14" cy="90" rx="16" ry="62" transform="rotate(-40 14 90)"/><ellipse cx="106" cy="90" rx="16" ry="62" transform="rotate(40 106 90)"/></g></g>
</svg>`,
);
console.log('art written to', out);
