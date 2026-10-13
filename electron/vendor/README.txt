Third-party code shipped inside the app (not in node_modules, which in-app updates never touch).

adblocker.js
  A one-file bundle of @ghostery/adblocker 2.20.1 (Mozilla Public License 2.0) and tldts-experimental 7.4.18
  (MIT), the filter engine behind the browser's ad blocker (electron/adblock.js). Unmodified source:
  https://github.com/ghostery/adblocker and https://github.com/remusao/tldts. License texts are at the end of
  the file. Rebuilt with:

    npm i @ghostery/adblocker-electron@2.20.1 esbuild
    entry.js:  export { FiltersEngine, Request, ENGINE_VERSION } from '@ghostery/adblocker';
               export { parse as parseHost } from 'tldts-experimental';
    npx esbuild entry.js --bundle --platform=node --format=cjs --target=node20 --minify --legal-comments=eof --outfile=adblocker.js

adblocker-preload.js
  @ghostery/adblocker-electron-preload 2.20.1 (MPL-2.0), dist/index.cjs copied as is. It runs in each browser
  page and asks the main process for the CSS and scripts that hide ads.
