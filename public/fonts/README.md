# Fonts

Neue Montreal is a commercial typeface from Pangram Pangram (free for personal
use): https://pangrampangram.com/products/neue-montreal

Download it, convert or export to WOFF2, and drop the files here with these names:

    NeueMontreal-Regular.woff2
    NeueMontreal-Italic.woff2       (optional)
    NeueMontreal-Medium.woff2
    NeueMontreal-Bold.woff2

`src/styles/global.css` declares matching `@font-face` rules. Until the files
exist, the site falls back to the system grotesque stack. The monospace
(typewriter) face is Courier Prime, loaded from Google Fonts in Layout.astro.
Font files are git-ignored so the licence stays with you.
