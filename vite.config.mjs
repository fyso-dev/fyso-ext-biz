// Standard static page build. React and panel APIs are shared native ES modules.
// Separate browser entry points for Biz overview, project identity and managed workflows.
const src=new URL('./panel-src/',import.meta.url).pathname;
export default {
  root:src,
  base:'/extensions/biz/panel/',
  build:{modulePreload:{polyfill:false},outDir:new URL('./extensions/biz/panel',import.meta.url).pathname,emptyOutDir:true,
    rollupOptions:{input:{main:`${src}index.html`,identity:`${src}identity.html`,workflows:`${src}workflows.html`},
      external:['@fyso/panel','react','react/jsx-runtime','react-i18next'],
      output:{paths:{'@fyso/panel':'/assets/extension-sdk.js',react:'/assets/extension-sdk.js','react/jsx-runtime':'/assets/extension-sdk.js','react-i18next':'/assets/extension-sdk.js'},entryFileNames:'[name].js',assetFileNames:asset=>asset.names.includes('main.css')?'index.css':'[name][extname]'}}},
};
